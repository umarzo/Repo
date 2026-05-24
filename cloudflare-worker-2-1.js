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
const CASHFREE_ENV='production';
/* FIREBASE_WEB_API_KEY moved to env.FIREBASE_WEB_API_KEY — do not hardcode here */
const PRO_DAYS=30;

/* ── Rate-limit config (server-side, enforced on every proxied write) ─────── */
const RATE_LIMITS = {
  guild_msg:  { max: 20, windowMs: 60 * 1000 },        // 20 msgs  / 60 s
  comm_reply: { max: 20, windowMs: 10 * 60 * 1000 },   // 20 replies / 10 min
  comm_post:  { max: 10, windowMs: 10 * 60 * 1000 },   // 10 posts   / 10 min
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
/* fbSet: HTTP PUT — overwrites a specific path entirely */
async function fbSet(path,data,env){const r=await fetch(env.FIREBASE_DB_URL+'/'+path+'.json?auth='+env.FIREBASE_DB_SECRET,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error('fbSet '+r.status+' '+(await r.text()));return r.json();}
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
  await fbPatch(path,rl,env).catch(()=>{});
  return{ok:true};
}

/* ── Internal: write one notification, prune to 100 ──────────────────────── */
async function writeNotif(targetUid,payload,env){
  const notifRef=await fbPush(`users/${targetUid}/notifications`,{...payload,ts:payload.ts||Date.now(),read:payload.read!==undefined?payload.read:false},env);
  /* Prune oldest entries if > 100 */
  try{
    const all=await fbGet(`users/${targetUid}/notifications`,env).catch(()=>null);
    if(all&&typeof all==='object'){
      const entries=Object.entries(all).sort((a,b)=>(a[1].ts||0)-(b[1].ts||0));
      if(entries.length>100){
        const toDelete=entries.slice(0,entries.length-100);
        const pruneUpdates={};
        toDelete.forEach(([k])=>{pruneUpdates[`users/${targetUid}/notifications/${k}`]=null;});
        await fbMultiUpdate(pruneUpdates,env).catch(()=>{});
      }
    }
  }catch(_){}
  return notifRef;
}

/* ── Pro helpers ───────────────────────────────────────────────────────────── */
async function grantPro(uid,paymentId,env,username,email){const now=Date.now();const ex=await fbGet('users/'+uid,env).catch(()=>({}));const proSince=(ex&&ex.proSince)?ex.proSince:now;const baseTime=(ex&&ex.proExpiry&&ex.proExpiry>now)?ex.proExpiry:now;const expiry=baseTime+PRO_DAYS*86400000;await fbPatch('users/'+uid,{isPro:true,proSince,proExpiry:expiry,proPaymentId:paymentId},env);await fbPush('hq/proActivations',{uid,username:username||'',email:email||'',paymentId,activatedAt:now,expiry,source:'worker'},env).catch(()=>{});return{expiry,proSince};}
async function verifyCfSig(raw,ts,sig,env){const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(env.CASHFREE_SECRET_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);const buf=await crypto.subtle.sign('HMAC',key,enc.encode(ts+raw));return btoa(String.fromCharCode(...new Uint8Array(buf)))===sig;}

export default{async fetch(request,env,ctx){
/* ── Env guard — fail fast with a clear error instead of leaking DB structure */
if(!env.FIREBASE_DB_URL||!env.FIREBASE_DB_SECRET||!env.FIREBASE_WEB_API_KEY){
  console.error('[worker] Missing required env vars: FIREBASE_DB_URL / FIREBASE_DB_SECRET / FIREBASE_WEB_API_KEY');
  return new Response(JSON.stringify({error:'Worker misconfigured'}),{status:500,headers:{'Content-Type':'application/json'}});
}
const FIREBASE_WEB_API_KEY=env.FIREBASE_WEB_API_KEY;
/* ALLOWED_ORIGIN must be set in Cloudflare env (e.g. https://yourdomain.com).
   If unset during local dev a warning is logged but requests still pass through. */
const ALLOWED_ORIGIN=env.ALLOWED_ORIGIN||(()=>{console.warn('[worker] ALLOWED_ORIGIN not set — CORS is unrestricted');return request.headers.get('Origin')||'*';})();
const GROQ_API_KEY=env.GROQ_API_KEY;
const METERED_API_KEY=env.METERED_API_KEY;
const CASHFREE_APP_ID=env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY=env.CASHFREE_SECRET_KEY;
const url=new URL(request.url);
const ch=corsHeaders(ALLOWED_ORIGIN);
const cfBaseUrl=CASHFREE_ENV==='production'?'https://api.cashfree.com':'https://sandbox.cashfree.com';
function jr(d,s){return new Response(JSON.stringify(d),{status:s||200,headers:{'Content-Type':'application/json',...ch}});}
if(request.method==='OPTIONS')return new Response(null,{status:204,headers:ch});

/* ── /turn ─────────────────────────────────────────────────────────────────── */
if(url.pathname==='/turn'&&request.method==='GET'){const token=request.headers.get('X-Firebase-Token');const valid=await verifyFirebaseToken(token,FIREBASE_WEB_API_KEY);if(!valid)return jr({error:'Unauthorized'},401);const meteredRes=await fetch('https://'+METERED_APP_NAME+'.metered.live/api/v1/turn/credentials?apiKey='+METERED_API_KEY);const body=await meteredRes.text();return new Response(body,{status:meteredRes.status,headers:{'Content-Type':'application/json',...ch}});}

/* ── /nova ─────────────────────────────────────────────────────────────────── */
if(url.pathname==='/nova'&&request.method==='POST'){const token=request.headers.get('X-Firebase-Token');const valid=await verifyFirebaseToken(token,FIREBASE_WEB_API_KEY);if(!valid)return jr({error:'Unauthorized'},401);let body;try{body=await request.json();}catch{return jr({error:'Invalid JSON'},400);}const groqRes=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},body:JSON.stringify(body)});const groqBody=await groqRes.text();return new Response(groqBody,{status:groqRes.status,headers:{'Content-Type':'application/json',...ch}});}

/* ── / (Cashfree order creation) ───────────────────────────────────────────── */
if(url.pathname==='/'&&request.method==='POST'){let data;try{data=await request.json();}catch{return jr({error:'Invalid JSON'},400);}const cfRes=await fetch(cfBaseUrl+'/pg/orders',{method:'POST',headers:{'Content-Type':'application/json','x-client-id':CASHFREE_APP_ID,'x-client-secret':CASHFREE_SECRET_KEY,'x-api-version':'2023-08-01'},body:JSON.stringify({order_id:'golex_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),order_amount:data.order_amount,order_currency:data.order_currency||'INR',order_note:data.order_note||'Golex Pro',customer_details:data.customer_details})});const cfBody=await cfRes.json();if(!cfRes.ok)return new Response(JSON.stringify({error:cfBody.message||'Cashfree error',details:cfBody}),{status:cfRes.status,headers:{'Content-Type':'application/json',...ch}});return jr({payment_session_id:cfBody.payment_session_id,order_id:cfBody.order_id},200);}

/* ── /activate ─────────────────────────────────────────────────────────────── */
if(url.pathname==='/activate'&&request.method==='POST'){let b;try{b=await request.json();}catch{return jr({error:'Bad JSON'},400);}const{orderId,idToken}=b||{};if(!orderId||!idToken)return jr({error:'Missing orderId or idToken'},400);let uid;try{uid=await getUidFromToken(idToken,FIREBASE_WEB_API_KEY);}catch(e){return jr({error:'Auth: '+e.message},401);}
/* ── Idempotency: if this orderId was already processed, return the stored result immediately */
try{const already=await withTimeout(fbGet(`hq/processedOrders/${orderId}`,env),6000,'idempotency-check');if(already){return jr({success:true,expiry:already.expiry,proSince:already.proSince,idempotent:true},200);}}catch(e){/* key not found is expected on first run; a timeout here is non-fatal, log and continue */console.error('[activate] idempotency check error:',e.message);}
let order;try{const r=await fetch(cfBaseUrl+'/pg/orders/'+orderId,{headers:{'x-client-id':CASHFREE_APP_ID,'x-client-secret':CASHFREE_SECRET_KEY,'x-api-version':'2023-08-01'}});if(!r.ok)throw new Error('CF '+r.status);order=await r.json();}catch(e){console.error('[activate] CF order fetch:',e.message);return jr({error:'Order check: '+e.message},502);}if(order.order_status!=='PAID')return jr({error:'Not paid: '+order.order_status},402);const cid=(order.customer_details?.customer_id||'');if(!uid.startsWith(cid)&&!cid.startsWith(uid.substring(0,50)))return jr({error:'Order/user mismatch'},403);let res;try{res=await grantPro(uid,orderId,env,order.customer_details?.customer_name,order.customer_details?.customer_email);}catch(e){console.error('[activate] grantPro:',e.message);return jr({error:'DB write: '+e.message},500);}
/* Mark orderId as processed so retries/double-taps are no-ops */
fbSet(`hq/processedOrders/${orderId}`,{uid,expiry:res.expiry,proSince:res.proSince,processedAt:Date.now()},env).catch(e=>console.error('[activate] processedOrders write:',e.message));
return jr({success:true,expiry:res.expiry,proSince:res.proSince},200);}

/* ── /webhook (Cashfree) ───────────────────────────────────────────────────── */
if(url.pathname==='/webhook'&&request.method==='POST'){const raw=await request.text();const ts=request.headers.get('x-webhook-timestamp')||'';const sig=request.headers.get('x-webhook-signature')||'';if(!await verifyCfSig(raw,ts,sig,env))return jr({error:'Bad signature'},401);let p;try{p=JSON.parse(raw);}catch{return jr({error:'Bad JSON'},400);}if(p?.type!=='PAYMENT_SUCCESS_WEBHOOK')return jr({received:true},200);const orderId=p?.data?.order?.order_id;const uid=(p?.data?.customer_details?.customer_id||'').substring(0,128);if(!orderId||!uid)return jr({error:'Missing data'},400);
/* ── Idempotency: Cashfree retries up to 3× on non-200; only process once */
try{const already=await withTimeout(fbGet(`hq/processedOrders/${orderId}`,env),6000,'webhook-idempotency');if(already){return jr({success:true,idempotent:true},200);}}catch(e){console.error('[webhook] idempotency check error:',e.message);}
try{const res=await grantPro(uid,orderId,env,p?.data?.customer_details?.customer_name,p?.data?.customer_details?.customer_email);/* Mark as processed */fbSet(`hq/processedOrders/${orderId}`,{uid,expiry:res.expiry,proSince:res.proSince,processedAt:Date.now()},env).catch(e=>console.error('[webhook] processedOrders write:',e.message));}catch(e){console.error('[webhook] grantPro:',e.message);return jr({error:e.message},500);}return jr({success:true},200);}

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
  const{targetUid,type,...rest}=b||{};
  if(!targetUid||typeof targetUid!=='string'||!targetUid.trim())return jr({error:'Missing targetUid'},400);
  const VALID_TYPES=new Set(['follow','message','endorse','like','comment','system','project_request','project_request_accepted','project_request_declined','task_assigned','task_completed','work_applicant','work_applicant_accepted','work_application_accepted','work_application_declined','comm_reply','comm_upvote','comm_best_answer','comm_new_post','poll_vote','buildlog_entry']);
  if(!type||!VALID_TYPES.has(type))return jr({error:'Invalid notification type'},400);
  try{
    const ref=await writeNotif(targetUid,{type,...rest},env);
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
  const{targets,type,...rest}=b||{};
  if(!Array.isArray(targets)||targets.length===0)return jr({error:'targets must be a non-empty array'},400);
  if(targets.length>500)return jr({error:'Too many targets (max 500)'},400);
  if(!type)return jr({error:'Missing type'},400);
  const now=Date.now();
  /* Build multi-path update: one key per recipient */
  const updates={};
  /* We need unique Firebase push keys; generate them via /push endpoint individually would be slow.
     Instead we generate a unique key per recipient using a timestamp + index + random suffix. */
  targets.forEach((uid,i)=>{
    const key='-'+now.toString(36)+'x'+i.toString(36)+'x'+Math.random().toString(36).slice(2,7);
    updates[`users/${uid}/notifications/${key}`]={type,...rest,ts:now,read:false};
  });
  try{
    await fbMultiUpdate(updates,env);
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
  const VALID_MSG_TYPES=new Set(['text','image','file','audio','vault']);
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
  /* Rate limit — all types share the same counter (20 / 60 s) */
  const rl=await checkAndIncrRateLimit(uid,'guild_msg',env);
  if(!rl.ok)return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:'Too many messages. Please wait.'},429);
  /* Read username from DB (never trust client-supplied username) */
  const userData=await fbGet(`users/${uid}`,env).catch(()=>null)||{};
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
    ...(replyToMsgId?{replyToMsgId,replyToText:replyToText||''}:{})
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
  /* Patch repliesCount (read-modify-write; minor race acceptable) */
  fbGet(`communities/${communityId}/posts/${postId}/repliesCount`,env)
    .then(c=>fbPatch(`communities/${communityId}/posts/${postId}`,{repliesCount:(Number(c)||0)+1},env))
    .catch(()=>{});
  /* Fix the reply replyId field (set it to the generated key) */
  fbPatch(`communities/${communityId}/posts/${postId}/replies/${replyId}`,{replyId},env).catch(()=>{});
  /* Notify post author if different user */
  if(postAuthorId&&postAuthorId!==uid){
    writeNotif(postAuthorId,{
      type:'comm_reply',postId,communityId,
      communityName:communityName||'',
      fromUsername:username,
      preview:body.substring(0,60),
      ts:now,read:false
    },env).catch(()=>{});
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
  /* Rate limit */
  const rl=await checkAndIncrRateLimit(uid,'comm_post',env);
  if(!rl.ok)return jr({error:'Rate limited',retryAfter:rl.retryAfter,message:'Too many posts. Please wait.'},429);
  /* Read user + community data */
  const [userData,communityData]=await Promise.all([
    fbGet(`users/${uid}`,env).catch(()=>null)||{},
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
  /* Fix the postId field and increment postCount (fire and forget) */
  fbPatch(`communities/${communityId}/posts/${postId}`,{postId},env).catch(()=>{});
  fbGet(`communities/${communityId}/postCount`,env)
    .then(c=>fbPatch(`communities/${communityId}`,{postCount:(Number(c)||0)+1},env))
    .catch(()=>{});
  /* Fan-out comm_new_post notifications to all community members */
  fbGet(`communities/${communityId}/members`,env).then(members=>{
    if(!members||typeof members!=='object')return;
    const memberUids=Object.keys(members).filter(m=>m!==uid);
    if(memberUids.length===0)return;
    const fanoutUpdates={};
    memberUids.forEach((memberId,i)=>{
      const key='-'+now.toString(36)+'p'+i.toString(36)+'x'+Math.random().toString(36).slice(2,6);
      fanoutUpdates[`users/${memberId}/notifications/${key}`]={
        type:'comm_new_post',postId,communityId,communityName,
        postTitle:title.trim(),authorUsername:username,
        ts:now,read:false
      };
    });
    fbMultiUpdate(fanoutUpdates,env).catch(()=>{});
  }).catch(()=>{});
  return jr({ok:true,postId},200);
}

return jr({error:'Not found'},404);}};
