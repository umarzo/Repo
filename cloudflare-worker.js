/* ─── Golex Cloudflare Worker ───────────────────────────────────────────────
   Changelog (current patch):
   ISSUE 1 – Notification write rule
     • Added POST /notify   – writes a single notification to users/$uid/notifications
     • Added POST /notify-bulk – fan-out (comm_new_post) to many users via multi-path update
     Both routes use the DB secret so they bypass Firebase security rules.
     The Firebase rule for users/$uid/notifications/write is now owner-only (auth.uid === $uid),
     which means ALL notification writes from the client must go through these endpoints.

   ISSUE 3 – Server-side rate limiting
     • Added checkAndIncrRateLimit() – reads/writes users/$uid/rateLimits/$action with window counter
     • Added POST /guild-msg   – 20 messages / 60 s per user
     • Added POST /comm-reply  – 20 replies  / 10 min per user  (also writes the reply + notif)
     • Added POST /comm-post   – 10 posts    / 10 min per user  (also writes post, fan-out notifs)
     All three routes validate the Firebase ID token before hitting the rate-limit counter.
   ─────────────────────────────────────────────────────────────────────────── */

const METERED_APP_NAME='golex';
/* Stripe mode is controlled by the keys in Cloudflare env variables.
   Use test keys for test mode and live keys for production mode. */
/* FIREBASE_WEB_API_KEY moved to env.FIREBASE_WEB_API_KEY — do not hardcode here */
const PRO_DAYS=30;

/* ── Rate-limit config (server-side, enforced on every proxied write) ─────── */
const RATE_LIMITS = {
  guild_msg:  { max: 20, windowMs: 60 * 1000 },        // 20 msgs  / 60 s
  comm_reply: { max: 20, windowMs: 10 * 60 * 1000 },   // 20 replies / 10 min
  comm_post:  { max: 10, windowMs: 10 * 60 * 1000 },   // 10 posts   / 10 min
  nova:       { max: 20, windowMs: 60 * 60 * 1000 },   // 20 requests / 1 hr per user
};

/* CORS: allowedOrigin comes from env.ALLOWED_ORIGIN (set in Cloudflare dashboard).
   Only requests from that exact origin are allowed; everything else gets blocked.
   Never reflect the caller's origin — that defeats the protection entirely. */
function corsHeaders(allowedOrigin){return{'Access-Control-Allow-Origin':allowedOrigin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-Firebase-Token','Vary':'Origin'};}

/* ── Firebase token helpers ────────────────────────────────────────────────── */
/* Both helpers now take apiKey explicitly — no module-level constant.          */
async function verifyFirebaseToken(token,apiKey){if(!token)return false;try{const res=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});return res.ok;}catch{return false;}}
async function getUidFromToken(token,apiKey){if(!token)throw new Error('No token');const res=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token})});const d=await res.json();if(!res.ok||!d.users||!d.users[0])throw new Error('Invalid token');return d.users[0].localId;}

/* ── Firebase REST helpers (all use DB secret → bypass rules) ──────────────── */
async function fbGet(path,env){const r=await fetch(env.FIREBASE_DB_URL+'/'+path+'.json?auth='+env.FIREBASE_DB_SECRET);if(!r.ok)throw new Error('fbGet '+r.status);return r.json();}
async function fbPatch(path,data,env){const r=await fetch(env.FIREBASE_DB_URL+'/'+path+'.json?auth='+env.FIREBASE_DB_SECRET,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error('fbPatch '+r.status+' '+(await r.text()));return r.json();}
async function fbPush(path,data,env){const r=await fetch(env.FIREBASE_DB_URL+'/'+path+'.json?auth='+env.FIREBASE_DB_SECRET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error('fbPush '+r.status);return r.json();}
/* fbMultiUpdate: PATCH at root — writes multiple paths atomically */
async function fbMultiUpdate(updates,env){const r=await fetch(env.FIREBASE_DB_URL+'/.json?auth='+env.FIREBASE_DB_SECRET,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});if(!r.ok)throw new Error('fbMultiUpdate '+r.status+' '+(await r.text()));return r.json();}

/* ── Timeout guard — wraps any promise; rejects after ms ───────────────────── */
const withTimeout=(promise,ms=8000,label='FB call')=>
  Promise.race([promise,new Promise((_,r)=>setTimeout(()=>r(new Error(`${label} timed out after ${ms}ms`)),ms))]);

/* ── Rate-limit helper ─────────────────────────────────────────────────────── *
   Reads users/$uid/rateLimits/$action → { count, windowStart }
   If window has expired, resets counter.
   Returns { ok: true } or { ok: false, retryAfter: ms }.
   Non-critical counter: a tiny race window is acceptable for spam prevention. */
async function checkAndIncrRateLimit(uid,action,env){
  const cfg=RATE_LIMITS[action];
  if(!cfg)return{ok:true};
  const path=`users/${uid}/rateLimits/${action}`;
  const now=Date.now();
  let rl=await fbGet(path,env).catch(()=>null)||{count:0,windowStart:now};
  if(now-rl.windowStart>cfg.windowMs){rl={count:0,windowStart:now};}
  if(rl.count>=cfg.max){
    const retryAfter=cfg.windowMs-(now-rl.windowStart);
    return{ok:false,retryAfter};
  }
  rl.count++;
  await fbPatch(path,rl,env).catch(e=>console.error('[rateLimit] counter write for',action,':',e.message));
  return{ok:true};
}

/* ── Ban / mute guard — used by every write route ─────────────────────────
   Fetches hq/bans/$uid and hq/mutes/$uid in parallel.
   Returns { blocked:true, reason:'banned'|'muted' } or { blocked:false }.
   Workers use DB secret so these reads bypass the HQ admin-only read rule. */
async function checkBanMute(uid,env){
  const [ban,mute]=await Promise.all([
    fbGet(`hq/bans/${uid}`,env).catch(()=>null),
    fbGet(`hq/mutes/${uid}`,env).catch(()=>null)
  ]);
  if(ban)return{blocked:true,reason:'banned'};
  if(mute)return{blocked:true,reason:'muted'};
  return{blocked:false};
}

/* ── Internal: write one notification, prune to 100 ──────────────────────── */
async function writeNotif(targetUid,payload,env,ctx){
  const notifRef=await fbPush(`users/${targetUid}/notifications`,{...payload,ts:payload.ts||Date.now(),read:payload.read!==undefined?payload.read:false},env);
  /* Pruning — uses shallow=true to get only keys (no data download) to count,
     then limitToFirst to fetch only the oldest excess entries for deletion.
     This avoids downloading the entire notification list on every write.
     Wrapped in ctx.waitUntil so it isn't killed when the response is returned. */
  const pruneP=writeNotif._pruneOnly(targetUid,env).catch(e=>console.error('[writeNotif] prune:',e.message));
  if(ctx&&ctx.waitUntil)ctx.waitUntil(pruneP);
  return notifRef;
}
/* Standalone pruning — used by both writeNotif and /notify-bulk */
writeNotif._pruneOnly=async function(targetUid,env){
  try{
    const shallowUrl=`${env.FIREBASE_DB_URL}/users/${targetUid}/notifications.json?auth=${env.FIREBASE_DB_SECRET}&shallow=true`;
    const kr=await fetch(shallowUrl);
    if(!kr.ok)return;
    const keyMap=await kr.json();
    if(!keyMap||typeof keyMap!=='object')return;
    const total=Object.keys(keyMap).length;
    if(total<=100)return;
    const excess=total-100;
    const orderedUrl=`${env.FIREBASE_DB_URL}/users/${targetUid}/notifications.json?auth=${env.FIREBASE_DB_SECRET}&orderBy=%22ts%22&limitToFirst=${excess}`;
    const or=await fetch(orderedUrl);
    if(!or.ok)return;
    const oldest=await or.json();
    if(!oldest||typeof oldest!=='object')return;
    const pruneUpdates={};
    Object.keys(oldest).forEach(k=>{pruneUpdates[`users/${targetUid}/notifications/${k}`]=null;});
    await fbMultiUpdate(pruneUpdates,env).catch(e=>console.error('[writeNotif._pruneOnly]',e.message));
  }catch(e){console.error('[writeNotif._pruneOnly]',e.message);}
};

/* ── Module-level constants (created once per isolate, not per request) ────── */
const VALID_NOTIF_TYPES=new Set(['follow','message','endorse','like','comment','system','project_request','project_request_accepted','project_request_declined','task_assigned','task_completed','work_applicant','work_applicant_accepted','work_application_accepted','work_application_declined','comm_reply','comm_upvote','comm_best_answer','comm_new_post','poll_vote','buildlog_entry']);
const VALID_MSG_TYPES=new Set(['text','image','file','audio','vault']);

/* ── Pro helpers ───────────────────────────────────────────────────────────── */
async function grantPro(uid,paymentId,env){const now=Date.now();const ex=await fbGet('users/'+uid,env).catch(()=>({}));const proSince=(ex&&ex.proSince)?ex.proSince:now;const baseTime=(ex&&ex.proExpiry&&ex.proExpiry>now)?ex.proExpiry:now;const expiry=baseTime+PRO_DAYS*86400000;await fbPatch('users/'+uid,{isPro:true,proSince,proExpiry:expiry,proPaymentId:paymentId},env);
/* Store minimal PII: only uid and paymentId. Resolve username/email from users/$uid
   if needed later — never log PII in the audit trail. */
await fbPush('hq/proActivations',{uid,paymentId,activatedAt:now,expiry,source:'worker'},env).catch(e=>console.error('[grantPro] proActivations push:',e.message));return{expiry,proSince};}
async function hmacSha256Hex(secret,payload){const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(secret||''),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sigBuf=await crypto.subtle.sign('HMAC',key,enc.encode(payload));return Array.from(new Uint8Array(sigBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');}
function safeEq(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=(a.charCodeAt(i)^b.charCodeAt(i));return diff===0;}
async function verifyStripeSig(raw,sigHeader,env){if(!sigHeader||!env.STRIPE_WEBHOOK_SECRET)return false;const parts=sigHeader.split(',').map(s=>s.trim());let ts='';const v1=[];for(const p of parts){const i=p.indexOf('=');if(i===-1)continue;const k=p.slice(0,i),v=p.slice(i+1);if(k==='t')ts=v;else if(k==='v1')v1.push(v.toLowerCase());}if(!ts||!v1.length)return false;const age=Math.abs(Math.floor(Date.now()/1000)-Number(ts));if(!Number.isFinite(age)||age>300)return false;const expected=(await hmacSha256Hex(env.STRIPE_WEBHOOK_SECRET,`${ts}.${raw}`)).toLowerCase();return v1.some(sig=>safeEq(sig,expected));}
async function stripeRequest(path,method,formBody,env){const opts={method,headers:{'Authorization':'Bearer '+env.STRIPE_SECRET_KEY}};if(formBody&&method!=='GET'){opts.headers['Content-Type']='application/x-www-form-urlencoded';opts.body=new URLSearchParams(formBody).toString();}const res=await fetch('https://api.stripe.com/v1'+path,opts);const text=await res.text();let json;try{json=JSON.parse(text);}catch{json={raw:text};}return{ok:res.ok,status:res.status,body:json};}
async function stripeGetSubscription(subId,env){if(!subId)return null;const r=await stripeRequest('/subscriptions/'+encodeURIComponent(subId),'GET',null,env);return r.ok?r.body:null;}

export default{async fetch(request,env,ctx){
/* ── Env guard — fail fast with a clear error instead of leaking DB structure */
if(!env.FIREBASE_DB_URL||!env.FIREBASE_DB_SECRET||!env.FIREBASE_WEB_API_KEY){
  console.error('[worker] Missing required env vars: FIREBASE_DB_URL / FIREBASE_DB_SECRET / FIREBASE_WEB_API_KEY');
  return new Response(JSON.stringify({error:'Worker misconfigured'}),{status:500,headers:{'Content-Type':'application/json'}});
}
const FIREBASE_WEB_API_KEY=env.FIREBASE_WEB_API_KEY;
/* ALLOWED_ORIGIN must be set in Cloudflare env (e.g. https://yourdomain.com).
   Hard-fail if unset: reflecting the caller's Origin or using '*' allows any
   malicious website to call the API with the user's credentials. */
if(!env.ALLOWED_ORIGIN){
  console.error('[worker] ALLOWED_ORIGIN env var is not set — refusing all requests to prevent open CORS.');
  return new Response(JSON.stringify({error:'Worker misconfigured: ALLOWED_ORIGIN not set'}),{status:500,headers:{'Content-Type':'application/json'}});
}
const ALLOWED_ORIGIN=env.ALLOWED_ORIGIN;
const GROQ_API_KEY=env.GROQ_API_KEY;
const METERED_API_KEY=env.METERED_API_KEY;
const url=new URL(request.url);
const ch=corsHeaders(ALLOWED_ORIGIN);
function jr(d,s){return new Response(JSON.stringify(d),{status:s||200,headers:{'Content-Type':'application/json',...ch}});}
if(request.method==='OPTIONS')return new Response(null,{status:204,headers:ch});

/* ── /turn ─────────────────────────────────────────────────────────────────── */
if(url.pathname==='/turn'&&request.method==='GET'){const token=request.headers.get('X-Firebase-Token');const valid=await verifyFirebaseToken(token,FIREBASE_WEB_API_KEY);if(!valid)return jr({error:'Unauthorized'},401);const meteredRes=await fetch('https://'+METERED_APP_NAME+'.metered.live/api/v1/turn/credentials?apiKey='+METERED_API_KEY);const body=await meteredRes.text();return new Response(body,{status:meteredRes.status,headers:{'Content-Type':'application/json',...ch}});}

/* ── /nova ─────────────────────────────────────────────────────────────────── */
if(url.pathname==='/nova'&&request.method==='POST'){const token=request.headers.get('X-Firebase-Token');let uid;try{uid=await getUidFromToken(token,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Unauthorized'},401);}const rl=await checkAndIncrRateLimit(uid,'nova',env);if(!rl.ok){const waitMins=Math.ceil(rl.retryAfter/60000);return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:`Nova limit reached (20/hr). Try again in ${waitMins} minute${waitMins===1?'':'s'}.`},429);}let body;try{body=await request.json();}catch{return jr({error:'Invalid JSON'},400);}const groqRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},body:JSON.stringify(body)});const groqBody=await groqRes.text();return new Response(groqBody,{status:groqRes.status,headers:{'Content-Type':'application/json',...ch}});}

/* ── / (Stripe checkout session creation) ──────────────────────────────────── */
if(url.pathname==='/'&&request.method==='POST'){
if(!env.STRIPE_SECRET_KEY)return jr({error:'Worker misconfigured: STRIPE_SECRET_KEY not set'},500);
let data;try{data=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
const customer=data.customer_details||{};
const uid=((customer.customer_id||'')+'').substring(0,128);
if(!uid)return jr({error:'Missing customer_details.customer_id'},400);
const amountCents=Math.max(50,Math.round(Number(data.amount_cents||data.order_amount||499)));
const currency=((data.currency||data.order_currency||env.STRIPE_DEFAULT_CURRENCY||'usd')+'').toLowerCase();
const successUrl=(data.success_url||`${ALLOWED_ORIGIN}/?proSuccess=1&session_id={CHECKOUT_SESSION_ID}`).toString();
const cancelUrl=(data.cancel_url||`${ALLOWED_ORIGIN}/?proCanceled=1`).toString();
const body={'mode':'subscription','success_url':successUrl,'cancel_url':cancelUrl,'client_reference_id':uid,'metadata[uid]':uid,'subscription_data[metadata][uid]':uid,'line_items[0][quantity]':'1'};
if(customer.customer_email)body['customer_email']=(customer.customer_email+'').substring(0,320);
if(env.STRIPE_PRICE_ID){body['line_items[0][price]']=env.STRIPE_PRICE_ID;}
else{body['line_items[0][price_data][currency]']=currency;body['line_items[0][price_data][unit_amount]']=String(amountCents);body['line_items[0][price_data][recurring][interval]']='month';body['line_items[0][price_data][product_data][name]']=((data.order_note||'Golex Pro Monthly')+'').substring(0,120);}
const stripeRes=await stripeRequest('/checkout/sessions','POST',body,env);
if(!stripeRes.ok)return jr({error:stripeRes.body?.error?.message||'Stripe session creation failed',details:stripeRes.body},stripeRes.status||502);
return jr({session_id:stripeRes.body.id,checkout_url:stripeRes.body.url,order_id:stripeRes.body.id},200);}

/* ── /activate ─────────────────────────────────────────────────────────────── */
if(url.pathname==='/activate'&&request.method==='POST'){let b;try{b=await request.json();}catch{return jr({error:'Bad JSON'},400);}const{sessionId,idToken}=b||{};if(!sessionId||!idToken)return jr({error:'Missing sessionId or idToken'},400);let uid;try{uid=await getUidFromToken(idToken,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}
/* ── Idempotency: if this sessionId was already processed, return the stored result immediately */
try{const already=await withTimeout(fbGet(`hq/processedOrders/${sessionId}`,env),6000,'idempotency-check');if(already){return jr({success:true,expiry:already.expiry,proSince:already.proSince,idempotent:true},200);}}catch(e){console.error('[activate] idempotency check error:',e.message);}
const s=await stripeRequest('/checkout/sessions/'+encodeURIComponent(sessionId)+'?expand[]=subscription','GET',null,env);
if(!s.ok){console.error('[activate] Stripe session fetch:',s.body);return jr({error:'Session check failed'},502);}
const session=s.body;
if(session.status!=='complete')return jr({error:'Checkout incomplete: '+session.status},402);
if(session.payment_status!=='paid'&&session.payment_status!=='no_payment_required')return jr({error:'Payment not settled: '+session.payment_status},402);
const sid=((session.metadata&&session.metadata.uid)||session.client_reference_id||(session.subscription&&session.subscription.metadata&&session.subscription.metadata.uid)||'').substring(0,128);
if(!sid||sid!==uid)return jr({error:'Session/user mismatch'},403);
const paymentId=(session.subscription&&session.subscription.id)||session.payment_intent||session.id;
let res;try{res=await grantPro(uid,paymentId,env);}catch(e){console.error('[activate] grantPro:',e.message);return jr({error:'DB write: '+e.message},500);}
/* Mark sessionId as processed — use fbPatch (PATCH/merge) not fbSet (PUT/overwrite)
   to avoid a concurrent webhook write racing and erasing fields.
   Wrapped in ctx.waitUntil so the idempotency marker is guaranteed to land
   before the worker isolate is torn down (double-charge guard). */
ctx.waitUntil(fbPatch(`hq/processedOrders/${sessionId}`,{uid,expiry:res.expiry,proSince:res.proSince,processedAt:Date.now(),gateway:'stripe'},env).catch(e=>console.error('[activate] processedOrders write:',e.message)));
return jr({success:true,expiry:res.expiry,proSince:res.proSince},200);}

/* ── /webhook (Stripe) ─────────────────────────────────────────────────────── */
if(url.pathname==='/webhook'&&request.method==='POST'){
if(!env.STRIPE_WEBHOOK_SECRET)return jr({error:'Worker misconfigured: STRIPE_WEBHOOK_SECRET not set'},500);
const raw=await request.text();
const sig=request.headers.get('stripe-signature')||'';
if(!await verifyStripeSig(raw,sig,env))return jr({error:'Bad signature'},401);
let evt;try{evt=JSON.parse(raw);}catch{return jr({error:'Bad JSON'},400);}
const type=evt&&evt.type;
if(type==='checkout.session.completed'){
const session=evt.data&&evt.data.object;
const sessionId=session&&session.id;
const uid=((session&&session.metadata&&session.metadata.uid)||session.client_reference_id||'').substring(0,128);
if(!sessionId||!uid)return jr({received:true,skip:'missing-data'},200);
if(session.payment_status!=='paid'&&session.payment_status!=='no_payment_required')return jr({received:true,skip:'unpaid'},200);
try{const already=await withTimeout(fbGet(`hq/processedOrders/${sessionId}`,env),6000,'webhook-idempotency');if(already)return jr({success:true,idempotent:true},200);}catch(e){console.error('[webhook] idempotency check error:',e.message);}
try{const paymentId=session.subscription||session.payment_intent||session.id;const res=await grantPro(uid,paymentId,env);ctx.waitUntil(fbPatch(`hq/processedOrders/${sessionId}`,{uid,expiry:res.expiry,proSince:res.proSince,processedAt:Date.now(),gateway:'stripe',eventId:evt.id},env).catch(e=>console.error('[webhook] processedOrders write:',e.message)));}catch(e){console.error('[webhook] grantPro:',e.message);return jr({error:e.message},500);}
return jr({success:true},200);
}
if(type==='invoice.payment_succeeded'){
const invoice=evt.data&&evt.data.object;
if(invoice&&invoice.billing_reason==='subscription_cycle'&&invoice.subscription){
const invoiceId=invoice.id||evt.id;
try{const already=await withTimeout(fbGet(`hq/processedOrders/${invoiceId}`,env),6000,'invoice-idempotency');if(already)return jr({success:true,idempotent:true},200);}catch(e){console.error('[webhook] invoice idempotency check:',e.message);}
const sub=await stripeGetSubscription(invoice.subscription,env);
const uid=((sub&&sub.metadata&&sub.metadata.uid)||'').substring(0,128);
if(uid){try{const res=await grantPro(uid,invoice.subscription,env);ctx.waitUntil(fbPatch(`hq/processedOrders/${invoiceId}`,{uid,expiry:res.expiry,proSince:res.proSince,processedAt:Date.now(),gateway:'stripe',eventId:evt.id,invoice:true},env).catch(e=>console.error('[webhook] invoice marker write:',e.message)));}catch(e){console.error('[webhook] invoice grantPro:',e.message);return jr({error:e.message},500);}}
}
return jr({received:true},200);
}
if(type==='customer.subscription.updated'||type==='customer.subscription.deleted'){
const sub=evt.data&&evt.data.object;
const uid=((sub&&sub.metadata&&sub.metadata.uid)||'').substring(0,128);
if(uid){const periodEnd=((sub.current_period_end||0)*1000)||Date.now();const now=Date.now();const patch={proExpiry:periodEnd};if(sub.status==='canceled'&&periodEnd<=now)patch.isPro=false;await fbPatch('users/'+uid,patch,env).catch(e=>console.error('[webhook] subscription status patch:',e.message));await fbPush('hq/proActivations',{uid,paymentId:sub.id||'stripe-sub',activatedAt:now,expiry:periodEnd,source:type,cancelAtPeriodEnd:!!sub.cancel_at_period_end,status:sub.status||''},env).catch(e=>console.error('[webhook] subscription log push:',e.message));}
return jr({received:true},200);
}
return jr({received:true},200);}

/* ── /expire ───────────────────────────────────────────────────────────────── */
if(url.pathname==='/expire'&&request.method==='POST'){const token=request.headers.get('X-Firebase-Token');let uid;try{uid=await getUidFromToken(token,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}let userData;try{userData=await fbGet('users/'+uid,env);}catch(e){console.error('[expire] DB read:',e.message);return jr({error:'DB read: '+e.message},502);}if(!userData||!userData.isPro)return jr({status:'not_pro'},200);if(!userData.proExpiry||userData.proExpiry>Date.now())return jr({status:'still_active',expiry:userData.proExpiry},200);try{await fbPatch('users/'+uid,{isPro:false},env);}catch(e){console.error('[expire] DB write:',e.message);return jr({error:'DB write: '+e.message},500);}await fbPush('hq/proExpirations',{uid,expiredAt:Date.now(),wasExpiry:userData.proExpiry},env).catch(e=>console.error('[expire] proExpirations push:',e.message));return jr({status:'expired'},200);}

/* ═══════════════════════════════════════════════════════════════════════════
   ISSUE 1 FIX — Notification write routes
   All notification writes from the client now go through these endpoints.
   Uses DB secret → bypasses Firebase rules → safe even with owner-only rule.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── POST /notify — write a single notification to one user ────────────────
   Body: { targetUid, type, text?, title?, ts?, read?, ...extraFields }
   Requires: X-Firebase-Token header (sender must be authenticated)
   Validates: targetUid is a non-empty string, type is a known enum value.     */
if(url.pathname==='/notify'&&request.method==='POST'){
  const token=request.headers.get('X-Firebase-Token');
  if(!await verifyFirebaseToken(token,FIREBASE_WEB_API_KEY))return jr({error:'Unauthorized'},401);
  let b;try{b=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
  /* Explicit destructure — never spread unknown ...rest into the database.
     Only known, validated fields are written. A malicious client cannot inject
     arbitrary keys (oversized arrays, nested objects) that corrupt the DB. */
  const{targetUid,type,title,text,postId,communityId,communityName,fromUsername,preview,replyId,taskId,projectId,adId}=b||{};
  if(!targetUid||typeof targetUid!=='string'||!targetUid.trim())return jr({error:'Missing targetUid'},400);
  const VALID_TYPES=VALID_NOTIF_TYPES;
  if(!type||!VALID_TYPES.has(type))return jr({error:'Invalid notification type'},400);
  /* Validate string field lengths */
  if(title&&typeof title==='string'&&title.length>200)return jr({error:'title too long'},400);
  if(text&&typeof text==='string'&&text.length>500)return jr({error:'text too long'},400);
  if(preview&&typeof preview==='string'&&preview.length>200)return jr({error:'preview too long'},400);
  if(fromUsername&&typeof fromUsername==='string'&&fromUsername.length>60)return jr({error:'fromUsername too long'},400);
  /* Build the payload with only allowed fields */
  const payload={type};
  if(title)payload.title=String(title).slice(0,200);
  if(text)payload.text=String(text).slice(0,500);
  if(postId)payload.postId=String(postId).slice(0,128);
  if(communityId)payload.communityId=String(communityId).slice(0,128);
  if(communityName)payload.communityName=String(communityName).slice(0,80);
  if(fromUsername)payload.fromUsername=String(fromUsername).slice(0,60);
  if(preview)payload.preview=String(preview).slice(0,200);
  if(replyId)payload.replyId=String(replyId).slice(0,128);
  if(taskId)payload.taskId=String(taskId).slice(0,128);
  if(projectId)payload.projectId=String(projectId).slice(0,128);
  if(adId)payload.adId=String(adId).slice(0,128);
  try{
    const ref=await writeNotif(targetUid,payload,env,ctx);
    return jr({ok:true,name:ref.name},200);
  }catch(e){return jr({error:'DB write: '+e.message},500);}
}

/* ── POST /notify-bulk — fan-out a notification to many users ─────────────
   Body: { targets: [uid, ...], type, ...sharedFields }
   Used by comm_new_post fan-out (new post in a community).
   Writes all notifications in a single multi-path PATCH for efficiency.        */
if(url.pathname==='/notify-bulk'&&request.method==='POST'){
  const token=request.headers.get('X-Firebase-Token');
  if(!await verifyFirebaseToken(token,FIREBASE_WEB_API_KEY))return jr({error:'Unauthorized'},401);
  let b;try{b=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
  /* Explicit destructure — never spread unknown ...rest into the database (same
     vulnerability fixed in /notify). Only known, validated fields are written. */
  const{targets,type,title,text,postId,communityId,communityName,fromUsername,preview,replyId,taskId,projectId,adId}=b||{};
  if(!Array.isArray(targets)||targets.length===0)return jr({error:'targets must be a non-empty array'},400);
  if(targets.length>500)return jr({error:'Too many targets (max 500)'},400);
  if(!type||!VALID_NOTIF_TYPES.has(type))return jr({error:'Invalid notification type'},400);
  /* Validate string field lengths (mirrors /notify) */
  if(title&&typeof title==='string'&&title.length>200)return jr({error:'title too long'},400);
  if(text&&typeof text==='string'&&text.length>500)return jr({error:'text too long'},400);
  if(preview&&typeof preview==='string'&&preview.length>200)return jr({error:'preview too long'},400);
  if(fromUsername&&typeof fromUsername==='string'&&fromUsername.length>60)return jr({error:'fromUsername too long'},400);
  /* Build sanitised payload with only allowed fields */
  const sharedPayload={type};
  if(title)sharedPayload.title=String(title).slice(0,200);
  if(text)sharedPayload.text=String(text).slice(0,500);
  if(postId)sharedPayload.postId=String(postId).slice(0,128);
  if(communityId)sharedPayload.communityId=String(communityId).slice(0,128);
  if(communityName)sharedPayload.communityName=String(communityName).slice(0,80);
  if(fromUsername)sharedPayload.fromUsername=String(fromUsername).slice(0,60);
  if(preview)sharedPayload.preview=String(preview).slice(0,200);
  if(replyId)sharedPayload.replyId=String(replyId).slice(0,128);
  if(taskId)sharedPayload.taskId=String(taskId).slice(0,128);
  if(projectId)sharedPayload.projectId=String(projectId).slice(0,128);
  if(adId)sharedPayload.adId=String(adId).slice(0,128);
  const now=Date.now();
  /* Build multi-path update: one key per recipient.
     Use crypto.randomUUID() for cryptographically secure keys — Math.random()
     is not CSPRNG and can collide across concurrent worker isolates. */
  const updates={};
  targets.forEach(uid=>{
    /* UUID stripped of hyphens gives 32 hex chars — embed timestamp for sortability */
    const key='-'+now.toString(36)+'x'+crypto.randomUUID().replace(/-/g,'').slice(0,12);
    updates[`users/${uid}/notifications/${key}`]={...sharedPayload,ts:now,read:false};
  });
  try{
    await fbMultiUpdate(updates,env);
    /* Kick off async pruning for all recipients in parallel — sequential awaiting
       500 targets × 2 HTTP calls each would blow the CF CPU time limit.
       Wrapped in ctx.waitUntil so the worker isn't frozen before pruning finishes. */
    ctx.waitUntil(Promise.all(
      targets.map(uid=>writeNotif._pruneOnly(uid,env).catch(e=>console.error('[notify-bulk] prune:',uid,e.message)))
    ));
    return jr({ok:true,count:targets.length},200);
  }catch(e){return jr({error:'DB write: '+e.message},500);}
}

/* ═══════════════════════════════════════════════════════════════════════════
   ISSUE 3 FIX — Server-side rate-limited write routes
   Each route: 1) validates token  2) checks rate limit  3) writes to Firebase
   Rate counters live at users/$uid/rateLimits/$action = {count, windowStart}
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── POST /guild-msg — rate-limited guild message send ────────────────────
   Limit: 20 messages per 60 s per user.
   Accepts all message types: text, image, file, audio.
   Body (text):  { guildId, type:'text',  text, skill, avatarUrl?, replyToMsgId?, replyToText? }
   Body (image): { guildId, type:'image', dataUrl, skill, avatarUrl? }
   Body (file):  { guildId, type:'file',  dataUrl, fileName, fileSize, skill, avatarUrl? }
   Body (audio): { guildId, type:'audio', dataUrl, duration, skill, avatarUrl? }
   Username is always read from DB — client-supplied value is ignored.              */
if(url.pathname==='/guild-msg'&&request.method==='POST'){
  const token=request.headers.get('X-Firebase-Token');
  let uid;try{uid=await getUidFromToken(token,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}
  let b;try{b=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
  const{guildId,type,text,dataUrl,fileName,fileSize,duration,skill,avatarUrl,replyToMsgId,replyToText}=b||{};
  if(!guildId)return jr({error:'Missing guildId'},400);
  /* Validate by type */
  const msgType=type||'text';
  if(!VALID_MSG_TYPES.has(msgType))return jr({error:'Invalid message type'},400);
  if(msgType==='text'){
    if(!text||typeof text!=='string'||!text.trim())return jr({error:'Missing or empty text'},400);
    if(text.length>2000)return jr({error:'Message too long (max 2000 chars)'},400);
  }else if(msgType==='vault'){
    /* vault: carries vaultData (AES-encrypted JSON string), no dataUrl */
    if(!b.vaultData||typeof b.vaultData!=='string')return jr({error:'Missing vaultData for vault message'},400);
    if(b.vaultData.length>4*1024*1024)return jr({error:'Vault payload too large (max 4 MB)'},400);
  }else{
    if(!dataUrl||typeof dataUrl!=='string')return jr({error:'Missing dataUrl for media message'},400);
    /* dataUrl size guard: base64-encoded 8 MB ≈ 10.9 MB string; reject anything over 12 MB */
    if(dataUrl.length>12*1024*1024)return jr({error:'Media too large'},400);
  }
  /* Batch: user profile + ban + mute — all needed before any write */
  const [userData,banEntry,muteEntry]=await Promise.all([
    fbGet(`users/${uid}`,env).catch(()=>null)||{},
    fbGet(`hq/bans/${uid}`,env).catch(()=>null),
    fbGet(`hq/mutes/${uid}`,env).catch(()=>null)
  ]);
  /* Authorization: ban / mute */
  if(banEntry)return jr({error:'Your account has been banned'},403);
  if(muteEntry)return jr({error:'Your account has been muted — you cannot send messages'},403);
  /* Authorization: user may only post to the guild that matches their own skill.
     Guild IDs are derived as guild_${skill.toLowerCase().replace(/[^a-z0-9]/g,'_')}.
     Without this check a user who guesses another guild's ID bypasses the client gate. */
  const userSkill=(userData&&userData.skill)||'';
  if(!userSkill)return jr({error:'User skill not set — cannot determine guild'},403);
  const expectedGuildId='guild_'+userSkill.toLowerCase().replace(/[^a-z0-9]/g,'_');
  if(guildId!==expectedGuildId)return jr({error:'You may only post in your own skill guild'},403);
  /* Rate limit — all types share the same counter (20 / 60 s) */
  const rl=await checkAndIncrRateLimit(uid,'guild_msg',env);
  if(!rl.ok)return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:'Too many messages. Please wait.'},429);
  /* TTL by type (ms) */
  const TTL={text:24*60*60*1000,image:6*60*60*1000,file:3*60*60*1000,audio:12*60*60*1000,vault:48*60*60*1000};
  const now=Date.now();
  const msgData={
    type:msgType,
    senderId:uid,
    username:userData.username||'anonymous',
    skill:skill||userData.skill||'Explorer',
    avatarUrl:avatarUrl||userData.pfpUrl||'',
    clientTs:now,createdAt:now,timestamp:now,
    ttlMs:TTL[msgType]||TTL.text,
    ...(msgType==='text'?{text:text.trim()}:msgType==='vault'?{text:'Secure File',vaultData:b.vaultData,fileName:b.fileName||'',fileSize:b.fileSize||''}:{text:'',dataUrl}),
    ...(msgType==='file'&&fileName?{fileName,fileSize:fileSize||0}:{}),
    ...(msgType==='audio'&&duration!=null?{duration}:{}),
    ...(replyToMsgId?{replyToMsgId,replyToText:replyToText?String(replyToText).slice(0,200):''}:{})
  };
  try{
    const r=await fbPush(`guilds/${guildId}/messages`,msgData,env);
    return jr({ok:true,key:r.name},200);
  }catch(e){return jr({error:'DB write: '+e.message},500);}
}

/* ── POST /comm-reply — rate-limited community reply ──────────────────────
   Limit: 20 replies per 10 min per user.
   Body: { communityId, postId, body, parentReplyId?, postAuthorId, communityName }
   The Worker writes the reply, increments repliesCount, and (if applicable)
   pushes a comm_reply notification to the post author.                         */
if(url.pathname==='/comm-reply'&&request.method==='POST'){
  const token=request.headers.get('X-Firebase-Token');
  let uid;try{uid=await getUidFromToken(token,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}
  let b;try{b=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
  const{communityId,postId,body,parentReplyId,postAuthorId,communityName}=b||{};
  if(!communityId||!postId||!body||typeof body!=='string'||!body.trim())return jr({error:'Missing required fields'},400);
  if(body.length>800)return jr({error:'Reply too long (max 800 chars)'},400);
  /* Authorization: ban / mute / membership — batched to a single round-trip */
  const [banEntry,muteEntry,memberEntry]=await Promise.all([
    fbGet(`hq/bans/${uid}`,env).catch(()=>null),
    fbGet(`hq/mutes/${uid}`,env).catch(()=>null),
    fbGet(`communities/${communityId}/members/${uid}`,env).catch(()=>null)
  ]);
  if(banEntry)return jr({error:'Your account has been banned'},403);
  if(muteEntry)return jr({error:'Your account has been muted — you cannot post replies'},403);
  if(!memberEntry)return jr({error:'You are not a member of this community'},403);
  /* Rate limit */
  const rl=await checkAndIncrRateLimit(uid,'comm_reply',env);
  if(!rl.ok)return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:'Too many replies. Please wait.'},429);
  /* Read user data from DB */
  const userData=await fbGet(`users/${uid}`,env).catch(()=>null)||{};
  const username=userData.username||'Anonymous';
  const authorPfp=userData.pfpUrl||null;
  const now=Date.now();
  /* Push reply */
  let replyRef;
  try{
    replyRef=await fbPush(`communities/${communityId}/posts/${postId}/replies`,{
      body:body.trim(),imageUrl:null,
      parentReplyId:parentReplyId||null,
      authorId:uid,authorUsername:username,authorPfp,
      upvotes:0,downvotes:0,netScore:0,likesCount:0,
      isBestAnswer:false,createdAt:now,userVotes:{},userLikes:{}
    },env);
  }catch(e){return jr({error:'Reply write failed: '+e.message},500);}
  const replyId=replyRef.name;
  /* Patch repliesCount (read-modify-write; minor race acceptable for a counter) */
  /* Fix the reply replyId field (set it to the generated key) */
  ctx.waitUntil(Promise.all([
    fbGet(`communities/${communityId}/posts/${postId}/repliesCount`,env)
      .then(c=>fbPatch(`communities/${communityId}/posts/${postId}`,{repliesCount:(Number(c)||0)+1},env))
      .catch(e=>console.error('[comm-reply] repliesCount update:',e.message)),
    fbPatch(`communities/${communityId}/posts/${postId}/replies/${replyId}`,{replyId},env)
      .catch(e=>console.error('[comm-reply] replyId patch:',e.message))
  ]));
  /* Notify post author if different user */
  if(postAuthorId&&postAuthorId!==uid){
    ctx.waitUntil(writeNotif(postAuthorId,{
      type:'comm_reply',postId,communityId,
      communityName:communityName||'',
      fromUsername:username,
      preview:body.substring(0,60),
      ts:now,read:false
    },env,ctx).catch(e=>console.error('[comm-reply] notify postAuthor:',e.message)));
  }
  return jr({ok:true,replyId},200);
}

/* ── POST /comm-post — rate-limited community post + fan-out notifications ─
   Limit: 10 posts per 10 min per user.
   Body: { communityId, title, body, type, imageUrl?, tags?, pollOptions? }
   The Worker: reads community data → writes post → increments postCount
               → reads members → fan-out comm_new_post notifications.           */
if(url.pathname==='/comm-post'&&request.method==='POST'){
  const token=request.headers.get('X-Firebase-Token');
  let uid;try{uid=await getUidFromToken(token,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}
  let b;try{b=await request.json();}catch{return jr({error:'Invalid JSON'},400);}
  const{communityId,title,body,type,imageUrl,tags,pollOptions}=b||{};
  if(!communityId||!title||typeof title!=='string'||title.trim().length<3)return jr({error:'Missing or invalid fields (communityId, title min 3 chars)'},400);
  if(!type)return jr({error:'Missing post type'},400);
  if(type==='poll'&&(!Array.isArray(pollOptions)||pollOptions.filter(o=>o.trim()).length<2))return jr({error:'Poll needs at least 2 options'},400);
  /* Authorization: ban / mute / membership — batched before the rate-limit counter
     so banned/non-member users never consume a rate-limit slot */
  const [banEntry,muteEntry,memberEntry]=await Promise.all([
    fbGet(`hq/bans/${uid}`,env).catch(()=>null),
    fbGet(`hq/mutes/${uid}`,env).catch(()=>null),
    fbGet(`communities/${communityId}/members/${uid}`,env).catch(()=>null)
  ]);
  if(banEntry)return jr({error:'Your account has been banned'},403);
  if(muteEntry)return jr({error:'Your account has been muted — you cannot create posts'},403);
  if(!memberEntry)return jr({error:'You are not a member of this community'},403);
  /* Rate limit */
  const rl=await checkAndIncrRateLimit(uid,'comm_post',env);
  if(!rl.ok)return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:'Too many posts. Please wait.'},429);
  /* Read user + community data */
  const [userData,communityData]=await Promise.all([
    fbGet(`users/${uid}`,env).catch(()=>({})),
    fbGet(`communities/${communityId}`,env).catch(()=>({name:''}))
  ]);
  const username=(userData&&userData.username)||'Anonymous';
  const authorPfp=(userData&&userData.pfpUrl)||null;
  const communityName=(communityData&&communityData.name)||'';
  const now=Date.now();
  const pollData=type==='poll'?{
    pollOptions:pollOptions.filter(o=>o.trim()).slice(0,5),
    pollVotes:{},
    pollVoteCounts:Array(pollOptions.filter(o=>o.trim()).slice(0,5).length).fill(0)
  }:{};
  /* Push post */
  let postRef;
  try{
    postRef=await fbPush(`communities/${communityId}/posts`,{
      communityId,communityName,
      title:title.trim(),body:body||'',
      type,imageUrl:type==='poll'?null:(imageUrl||null),
      authorId:uid,authorUsername:username,authorPfp,
      upvotes:0,downvotes:0,netScore:0,likesCount:0,
      repliesCount:0,isBestAnswered:false,
      tags:Array.isArray(tags)?tags:[],
      createdAt:now,userVotes:{},userLikes:{},
      ...pollData
    },env);
  }catch(e){return jr({error:'Post write failed: '+e.message},500);}
  const postId=postRef.name;
  /* Fix the postId field and increment postCount (wrapped in ctx.waitUntil — keeps
     the execution context alive after the response is sent) */
  ctx.waitUntil(Promise.all([
    fbPatch(`communities/${communityId}/posts/${postId}`,{postId},env)
      .catch(e=>console.error('[comm-post] postId patch:',e.message)),
    fbGet(`communities/${communityId}/postCount`,env)
      .then(c=>fbPatch(`communities/${communityId}`,{postCount:(Number(c)||0)+1},env))
      .catch(e=>console.error('[comm-post] postCount update:',e.message))
  ]));
  /* Fan-out comm_new_post notifications to all community members.
     NOTE: fetching the full members node is O(members) — for large communities
     consider a lightweight membersIndex that stores only UIDs (not full objects).
     Use crypto.randomUUID() for keys — Math.random() is not CSPRNG and collides. */
  ctx.waitUntil(
    fbGet(`communities/${communityId}/members`,env).then(members=>{
      if(!members||typeof members!=='object')return;
      const memberUids=Object.keys(members).filter(m=>m!==uid);
      if(memberUids.length===0)return;
      const fanoutUpdates={};
      memberUids.forEach(memberId=>{
        const key='-'+now.toString(36)+'x'+crypto.randomUUID().replace(/-/g,'').slice(0,12);
        fanoutUpdates[`users/${memberId}/notifications/${key}`]={
          type:'comm_new_post',postId,communityId,communityName,
          postTitle:title.trim(),authorUsername:username,
          ts:now,read:false
        };
      });
      return fbMultiUpdate(fanoutUpdates,env);
    }).catch(e=>console.error('[comm-post] fan-out:',e.message))
  );
  return jr({ok:true,postId},200);
}

return jr({error:'Not found'},404);}};
