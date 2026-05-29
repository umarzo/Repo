# GOLEX — Complete Buyer Setup Guide
> Read this fully before touching anything. Setup takes ~2–3 hours.
> Every step references the exact file and line number to change.

---

## WHAT YOU RECEIVED

| File | Purpose |
|------|---------|
| `golex.html` | The entire app (~40,000 lines — HTML + CSS + JS) |
| `hq.html` | Admin command center (separate authenticated panel) |
| `cloudflare-worker.js` | Backend API (payments, AI, rate limiting, notifications) |
| `firebase-rules.json` | Firebase Realtime Database security rules |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (offline support) |
| `icons/` | PWA icons folder |

**Architecture overview:**
- Frontend: Static files hosted on Netlify (connected to GitHub)
- Backend: Cloudflare Worker (serverless, handles all sensitive API calls)
- Database: Firebase Realtime Database
- Auth: Firebase Authentication (Email + Google)
- Payments: Stripe (native primary gateway)
- AI Assistant (Nova): Groq API (LLaMA)
- Voice/Video calls: WebRTC + Metered.live TURN servers

---

## PART 1 — ACCOUNTS TO CREATE

Create accounts on all of these before touching any code.
All are free to start except where noted.

1. **Firebase** — console.firebase.google.com
2. **Google Cloud** — console.cloud.google.com (same Google account as Firebase)
3. **Cloudflare** — cloudflare.com (free plan is enough)
4. **Groq** — console.groq.com (free tier available)
5. **Metered.live** — metered.ca (has a free tier)
6. **Stripe** — dashboard.stripe.com (required for payments)
7. **GitHub** — github.com (to host code)
8. **Netlify** — netlify.com (free tier is enough)
9. **Domain registrar** — namecheap.com or cloudflare.com/domains (~$10–15/year)

---

## PART 2 — FIREBASE SETUP

### 2.1 Create the Project
1. Go to console.firebase.google.com
2. Click **Add project**
3. Name it anything (e.g. `golex-app`)
4. Disable Google Analytics (not needed)
5. Click **Create project**

### 2.2 Enable Realtime Database
1. Left sidebar → **Build** → **Realtime Database**
2. Click **Create Database**
3. Choose region: **United States (us-central1)** — best global latency
4. Start in **locked mode** (you'll paste the real rules next)
5. Copy your database URL — looks like:
   `https://YOUR-PROJECT-default-rtdb.firebaseio.com`
   **Save this. You'll need it later.**

### 2.3 Deploy Security Rules
1. In Realtime Database → **Rules** tab
2. Delete everything in the editor
3. Open `firebase-rules.json` — copy the entire contents
4. Paste it into the rules editor
5. Click **Publish**

### 2.4 Enable Authentication
1. Left sidebar → **Build** → **Authentication**
2. Click **Get started**
3. **Sign-in method** tab → Enable **Email/Password**
4. Also enable **Google** sign-in:
   - Click Google → Enable → enter your support email → Save

### 2.5 Get Your Firebase Config
1. Left sidebar → **Project Settings** (gear icon)
2. Scroll down to **Your apps** section
3. Click the **</>** (web) icon to register a web app
4. App nickname: `golex-web` → click **Register app**
5. You'll see a config object like this — **copy all values:**
```
apiKey: "AIza..."
authDomain: "your-project.firebaseapp.com"
databaseURL: "https://your-project-default-rtdb.firebaseio.com"
projectId: "your-project"
storageBucket: "your-project.firebasestorage.app"
messagingSenderId: "123456789"
appId: "1:123456789:web:abc123"
```

### 2.6 Get Firebase Database Secret
This is what allows the Cloudflare Worker to bypass security rules.
1. **Project Settings** → **Service accounts** tab
2. Scroll down to **Database secrets**
3. Click **Show** next to the secret → Copy it
4. **Keep this secret. Never put it in frontend code.**

### 2.7 Set Up App Check (reCaptcha v3)
**First, get a reCaptcha v3 site key:**
1. Go to google.com/recaptcha/admin
2. Click **+** (Create)
3. Label: `golex`
4. Type: **reCAPTCHA v3**
5. Add your domain (e.g. `yourdomain.com`) + `localhost` for testing
6. Accept terms → Submit
7. Copy the **Site Key** (the Secret Key goes nowhere — reCaptcha handles it)

**Now register in Firebase:**
1. Firebase console → **App Check**
2. Click **Get started** → select your web app
3. Provider: **reCAPTCHA v3**
4. Paste your Site Key → Save

### 2.8 Set Up Admin Access
After you complete setup and sign in to the app for the first time:
1. Firebase console → **Realtime Database** → **Data** tab
2. Click the **+** button at the root
3. Key: `admins`
4. Inside admins, add: Key = **your Firebase UID**, Value = `true`

To find your Firebase UID: sign into the app → Firebase console →
Authentication → Users → copy your UID from the table.

---

## PART 3 — GOOGLE ONE TAP SETUP

### 3.1 Create OAuth Client ID
1. Go to console.cloud.google.com
2. Select your Firebase project from the top dropdown
3. Left menu → **APIs & Services** → **Credentials**
4. Click **+ Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Name: `golex-onetap`
7. Authorized JavaScript origins — add:
   - `https://yourdomain.com`
   - `http://localhost` (for testing)
8. Click **Create**
9. Copy the **Client ID** — looks like `123456789-abc.apps.googleusercontent.com`
   **Save this.**

---

## PART 4 — GROQ API SETUP

1. Go to console.groq.com → sign up
2. Left sidebar → **API Keys**
3. Click **Create API Key**
4. Name it `golex-nova`
5. Copy the key — starts with `gsk_`
   **Save this. It's shown only once.**

---

## PART 5 — METERED.LIVE SETUP (WebRTC TURN Servers)

1. Go to metered.ca → sign up
2. Dashboard → **Apps** → **Create App**
3. Name your app (e.g. `golex`) — **remember this name exactly**
4. Go to **API Keys** → copy your API key
   **Save both the app name and API key.**

---

## PART 6 — STRIPE SETUP (Payments)

**Stripe is now the native, primary payment architecture for Golex.**
Use Stripe Checkout + recurring subscription billing for global multi-currency processing.

### 6.1 Create Product + Recurring Price
1. Go to dashboard.stripe.com → create/sign in to your Stripe account
2. Use **Test mode** first (toggle at top right)
3. Left sidebar → **Product catalog** → **Add product**
4. Product name: `Golex Pro`
5. Pricing model: **Recurring**
6. Amount: `4.99`
7. Billing period: **Monthly**
8. Currency: choose your default (recommended: `USD`)
9. Save product and copy the generated **Price ID** (starts with `price_`)

### 6.2 Get API Keys
1. Stripe dashboard → **Developers** → **API keys**
2. Copy:
   - **Publishable key** (`pk_test_...` / `pk_live_...`)
   - **Secret key** (`sk_test_...` / `sk_live_...`)
3. Keep secret key private (Worker env only).

### 6.3 Set Up Stripe Webhook Endpoint
1. Stripe dashboard → **Developers** → **Webhooks** → **Add endpoint**
2. Endpoint URL: `https://YOUR-WORKER-URL/webhook`
3. Select these events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Save endpoint
5. Open the endpoint details page → copy **Signing secret** (`whsec_...`)

---

## PART 7 — CLOUDFLARE WORKER SETUP

### 7.1 Deploy the Worker
1. Go to cloudflare.com → sign up / log in
2. Left sidebar → **Workers & Pages**
3. Click **Create** → **Create Worker**
4. Name it anything (e.g. `golex-worker`)
5. Click **Deploy** (ignore the default code for now)
6. Click **Edit code**
7. Delete everything in the editor
8. Open `cloudflare-worker.js` — copy the entire contents
9. Paste into the editor

**One code change in the worker:**
- Line 18: `const METERED_APP_NAME='golex';`
- If your Metered app name is different from `golex`, change it here.
- If you named it `golex` in Metered, leave it as is.

10. Click **Deploy**
11. Copy your Worker URL — looks like:
    `https://golex-worker.YOUR-NAME.workers.dev/`
    **Save this.**

### 7.2 Set Environment Variables
This is critical. The Worker reads all secrets from env vars — never hardcoded.

1. Worker dashboard → **Settings** → **Variables**
2. Under **Environment Variables** → click **Add variable** for each:

| Variable Name | Value | Notes |
|--------------|-------|-------|
| `FIREBASE_DB_URL` | `https://YOUR-PROJECT-default-rtdb.firebaseio.com` | From Part 2.2 |
| `FIREBASE_DB_SECRET` | your database secret | From Part 2.6 |
| `FIREBASE_WEB_API_KEY` | your Firebase apiKey | From Part 2.5 |
| `ALLOWED_ORIGIN` | `https://yourdomain.com` | Your exact domain, no trailing slash |
| `GROQ_API_KEY` | `gsk_...` | From Part 4 |
| `METERED_API_KEY` | your Metered API key | From Part 5 |
| `STRIPE_SECRET_KEY` | `sk_test_...` (or `sk_live_...`) | From Part 6.2 |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From Part 6.3 |
| `STRIPE_PRICE_ID` | `price_...` | Monthly Golex Pro price from Part 6.1 |
| `STRIPE_DEFAULT_CURRENCY` | `usd` (or your ISO code) | Used when price ID is not set |

3. Mark `FIREBASE_DB_SECRET`, `GROQ_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` as **Encrypt** (checkbox)
4. Click **Save and deploy**

### 7.3 Go Back and Finish Stripe Webhook
Now that you have your Worker URL:
- Return to Part 6 webhook setup
- Set the URL to: `https://YOUR-WORKER-URL/webhook`

---

## PART 8 — CODE CHANGES (EXACT LINES)

Open `golex.html` in any text editor. Make these changes:

### 8.1 Firebase Config (Line ~19094)
Find this line:
```
const FIREBASE_CONFIG = { apiKey: "AIzaSyCAqrHPZxtvIlMrF6O3AIeWPRWdG-mkKKI", authDomain: "golex-51625.firebaseapp.com", ...
```
Replace the entire FIREBASE_CONFIG object with your new Firebase config from Part 2.5.

### 8.2 reCaptcha App Check Site Key (Line ~19170)
Find:
```
const _appCheckSiteKey = '6LcQCcYsAAAAAALDGXMbTKlSQJMjM-lIl0lOVTfp';
```
Replace the value with your new reCaptcha v3 site key from Part 2.7.

### 8.3 Google One Tap Client ID (Line ~20127)
Find:
```
const GIS_CLIENT_ID = '526349915922-avvoi7ki2mil8e2snk7ve5lkfeg90v44.apps.googleusercontent.com';
```
Replace with your new OAuth Client ID from Part 3.1.

### 8.4 Cloudflare Worker URL (Line ~37452)
Find:
```
WORKER_URL: 'https://muddy-sun-1035.umarzo1001.workers.dev/',
```
Replace with your new Worker URL from Part 7.1.
**Keep the trailing slash.**

### 8.5 Stripe Keys in Frontend Pro Config (Line ~37453)
Find:
```
STRIPE_PUBLISHABLE_KEY: 'pk_test_REPLACE_ME',
```
- Replace with your Stripe publishable key (`pk_test_...` for testing, `pk_live_...` for production)
- Keep `AMOUNT_CENTS: 499` as default, or adjust to match your Stripe dashboard pricing

### 8.6 Stripe Key/Variable Mapping (exact ownership handoff checklist)
Update these exact locations after takeover:

| Location | Variable | Replace with |
|---|---|---|
| `golex.html` (`GOLEX_PRO` object) | `STRIPE_PUBLISHABLE_KEY` | Your Stripe publishable key (`pk_test_...` / `pk_live_...`) |
| Cloudflare Worker env | `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_test_...` / `sk_live_...`) |
| Cloudflare Worker env | `STRIPE_WEBHOOK_SECRET` | Your Stripe endpoint signing secret (`whsec_...`) |
| Cloudflare Worker env | `STRIPE_PRICE_ID` | Your monthly recurring Stripe price ID (`price_...`) |
| Cloudflare Worker env | `STRIPE_DEFAULT_CURRENCY` | Your default 3-letter currency code (`usd`, `eur`, etc.) |
| Cloudflare Worker env | `ALLOWED_ORIGIN` | Your production domain (used in Stripe success/cancel URLs) |

### 8.7 Domain References (Lines ~21–36)
Find and replace all occurrences of `axikora.me` with `yourdomain.com`:
- Line 21: canonical URL
- Line 22: og:url
- Line 23: og:image
- Line 27: twitter:image
- Line 36: manifest URL

---

Now open `hq.html` in your text editor:

### 8.8 Firebase Config in HQ (Lines ~1839–1848)
Find:
```javascript
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCAqrHPZxtvIlMrF6O3AIeWPRWdG-mkKKI",
  authDomain: "golex-51625.firebaseapp.com",
  ...
```
Replace the entire FIREBASE_CONFIG with your new Firebase config from Part 2.5.

### 8.9 Admin UID in HQ (Lines ~1882–1884)
Find:
```javascript
const HARDCODED_ADMIN_UIDS = [
  "KTxJLIgjLcNx1pD1daq2sdveOc13"
];
```
Replace `"KTxJLIgjLcNx1pD1daq2sdveOc13"` with **your own Firebase UID**.
(Sign into the app first, then get your UID from Firebase console → Authentication → Users)

---

Now open `manifest.json`:

### 8.10 Update manifest.json
Replace all occurrences of `axikora.me` with your domain.
Update `start_url` and `scope` to match your deployment URL.

---

## PART 9 — GITHUB + NETLIFY DEPLOYMENT

### 9.1 Create GitHub Repository
1. Go to github.com → **New repository**
2. Name: `golex` (or anything)
3. Private repository (recommended)
4. Click **Create repository**

### 9.2 Upload Files to GitHub
Upload these files to the repository root:
```
golex.html        ← rename to index.html (see note below)
hq.html
manifest.json
sw.js
icons/            ← upload the entire folder
_redirects        ← create this new file (see below)
```

**Rename golex.html to index.html** so Netlify serves it at your root domain.
If you want it accessible at `/golex`, keep the name as `golex.html` and
update `_redirects` accordingly.

**Create a `_redirects` file** in the root with this content:
```
/*    /index.html   200
```
This ensures the PWA loads correctly on all routes.

### 9.3 Connect Netlify
1. Go to netlify.com → sign up / log in
2. Click **Add new site** → **Import an existing project**
3. Connect to GitHub → select your repository
4. Build settings: leave everything blank (it's static HTML)
5. Click **Deploy site**
6. Your site will be live at a random Netlify URL (e.g. `random-name.netlify.app`)

---

## PART 10 — DOMAIN SETUP

### 10.1 Buy a Domain
Go to namecheap.com or cloudflare.com/domains and buy your domain.
Pick something short and relevant to what you're building.

### 10.2 Connect Domain to Netlify
1. Netlify dashboard → **Domain management**
2. Click **Add custom domain**
3. Enter your domain → Verify → Add domain
4. Netlify will show you nameserver addresses
5. Go to your domain registrar → update nameservers to Netlify's
6. Wait 10–30 minutes for DNS to propagate
7. Netlify will automatically issue a free SSL certificate

### 10.3 Update ALLOWED_ORIGIN in Cloudflare Worker
Once your domain is live:
1. Cloudflare Worker → **Settings** → **Variables**
2. Update `ALLOWED_ORIGIN` to your exact domain:
   `https://yourdomain.com`
   (no trailing slash, exact match)
3. Save and deploy

---

## PART 11 — FIRST-TIME SETUP AFTER DEPLOYMENT

Do these steps in order after your site is live:

1. **Open your site** → complete the sign-up flow with your own email
2. **Get your UID:**
   - Firebase console → Authentication → Users → copy your UID
3. **Set yourself as admin in Firebase:**
   - Realtime Database → Data → click **+** at root
   - Add: `admins` → `{your-uid}` → `true`
4. **Update hq.html admin UID** (Part 8.8) with your UID → redeploy
5. **Open HQ panel** at `yourdomain.com/hq.html`
6. Sign in with the same account
7. Verify all panels load: Overview, Users, Posts, Communities, etc.

---

## PART 12 — TESTING CHECKLIST

Go through each item. Don't launch until all pass.

**Auth:**
- [ ] Email sign up works
- [ ] Email sign in works
- [ ] Google sign in works
- [ ] Email verification email arrives
- [ ] Password reset email arrives

**Core App:**
- [ ] Profile setup completes (all 6 steps)
- [ ] Directory shows users
- [ ] Collab matches load
- [ ] Feed loads and posts appear
- [ ] Stories work

**Messaging:**
- [ ] Chat opens between two users
- [ ] Text message sends and receives
- [ ] Voice note records and sends
- [ ] File send works

**Calls (WebRTC):**
- [ ] Voice call connects between two devices
- [ ] Video call connects
- [ ] Call ends cleanly
- [ ] If calls fail → check Worker /turn endpoint and Metered API key

**Communities:**
- [ ] Create community works
- [ ] Post to community works
- [ ] Reply to post works
- [ ] Notifications arrive for replies

**Guilds & Rooms:**
- [ ] Guild chat sends messages
- [ ] Guild rate limiting works (try sending 21 messages fast)
- [ ] Room creation works

**Nova AI:**
- [ ] Nova button opens
- [ ] Nova responds
- [ ] Rate limit triggers after 20 requests in 1 hour

**Payments:**
- [ ] Pro upgrade button shows
- [ ] Stripe Checkout opens
- [ ] Webhook events arrive in Stripe endpoint logs
- [ ] (Test in Stripe test mode first before going live)
- [ ] Pro badge appears after payment
- [ ] Pro expires after 30 days

**HQ Admin:**
- [ ] HQ login works (with admin account only)
- [ ] Ban a test user → banned user cannot post
- [ ] Mute a test user → muted user cannot send messages
- [ ] Manual Pro grant works
- [ ] Announcements broadcast works

---

## PART 13 — IMPORTANT SECURITY NOTES

- **Never share** your `FIREBASE_DB_SECRET`, `STRIPE_SECRET_KEY`, or `STRIPE_WEBHOOK_SECRET` with anyone
- **Never commit** these secrets to GitHub — they live only in Cloudflare Worker env vars
- **The Worker is your security layer** — all payment and notification writes go through it
- **Only your admin UID** can access HQ — keep this account's password strong
- **Stripe webhook** must point to your Worker `/webhook` — if it points nowhere, subscription renewals/cancellations and backup Pro grants won't sync correctly
- **ALLOWED_ORIGIN in the Worker** must exactly match your domain — this blocks any other website from calling your Worker with a stolen user token

---

## PART 14 — QUICK REFERENCE: ALL THINGS TO CHANGE

Summary of every value you must replace in the code:

| Location | What to find | What to replace with |
|----------|-------------|---------------------|
| `golex.html` line ~19094 | Old Firebase config | Your new Firebase config |
| `golex.html` line ~19170 | Old reCaptcha site key | Your reCaptcha v3 site key |
| `golex.html` line ~20127 | Old Google One Tap Client ID | Your OAuth Client ID |
| `golex.html` line ~37452 | Old Worker URL | Your Cloudflare Worker URL |
| `golex.html` line ~37453 | `STRIPE_PUBLISHABLE_KEY` placeholder | Your Stripe publishable key |
| `golex.html` lines ~21–36 | `axikora.me` | Your domain |
| `hq.html` lines ~1839–1848 | Old Firebase config | Your new Firebase config |
| `hq.html` line ~1883 | Old admin UID | Your Firebase UID |
| `cloudflare-worker.js` line 18 | `golex` (Metered app name) | Your Metered app name |
| `manifest.json` | `axikora.me` | Your domain |
| Cloudflare Worker env | All 10 variables | Your own keys (see Part 7.2) |

---

## NEED HELP?

If something doesn't work, check in this order:
1. **Cloudflare Worker logs** — Workers dashboard → your worker → **Logs** tab → real-time errors show here
2. **Firebase console** → Authentication → check if users are being created
3. **Browser console** (F12) → look for red errors
4. **Firebase rules** — if reads/writes fail, the rules tab shows a simulator

The most common setup mistakes are:
- Forgetting the trailing slash on `WORKER_URL`
- `ALLOWED_ORIGIN` not matching the exact domain (http vs https, trailing slash)
- Not deploying updated Firebase rules
- Stripe webhook not pointed at the Worker

---

*Guide prepared specifically for the Golex codebase. Every line reference corresponds to the exact source files provided.*
