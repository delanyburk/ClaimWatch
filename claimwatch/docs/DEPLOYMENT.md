# ClaimWatch — Complete Deployment Guide
## From zero to live production in ~45 minutes

---

## WHAT YOU'RE BUILDING

```
┌─────────────────────────────────────────────────────┐
│                    ARCHITECTURE                      │
│                                                     │
│  Users ──► Vercel (frontend)                        │
│                │                                    │
│                ▼                                    │
│         Supabase (auth + DB + filed claims)         │
│                │                                    │
│                ▼                                    │
│         Railway (backend API + scraper)             │
│                │                                    │
│                ▼                                    │
│    TopClassActions, ClassAction.org, FTC,           │
│    SettlementClaims, ClassActionRebates + more      │
└─────────────────────────────────────────────────────┘
```

**Cost:** ~$0–$5/month at low traffic
- Vercel: Free tier (frontend)
- Supabase: Free tier (500MB DB, 50,000 auth users)
- Railway: ~$5/month (backend + scraper cron)

---

## STEP 1 — SUPABASE (Database + Auth + Cloud Storage)

Supabase stores all settlements, user accounts, and filed claims.
It replaces localStorage with real cloud sync across devices.

### 1a. Create Supabase account
1. Go to **https://supabase.com** → click "Start your project"
2. Sign up with GitHub (recommended) or email
3. Click **"New Project"**
4. Fill in:
   - **Name:** `claimwatch`
   - **Database Password:** generate a strong one → **SAVE IT**
   - **Region:** US East (or closest to you)
5. Click **"Create new project"** — wait ~2 minutes for provisioning

### 1b. Run the database schema
1. In your Supabase project, click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Open the file `backend/src/db/schema.sql` from this project
4. Paste the entire contents into the SQL editor
5. Click **"Run"** (green button)
6. You should see: `Success. No rows returned`

### 1c. Get your API keys
1. Go to **Settings → API** in your Supabase sidebar
2. Copy and save these three values:
   ```
   Project URL:      https://xxxxxxxxxxxx.supabase.co
   anon/public key:  eyJhbGciO...  (safe to use in frontend)
   service_role key: eyJhbGciO...  (KEEP SECRET — backend only)
   ```
3. Go to **Settings → Database → Connection string → URI**
4. Copy the URI (replace `[YOUR-PASSWORD]` with the password you saved in step 1a)

### 1d. Enable Auth (so users can log in)
1. Go to **Authentication → Providers** in Supabase sidebar
2. **Email** is already enabled — leave it on
3. Optionally enable **Google OAuth**:
   - Toggle "Google" on
   - You'll need a Google Cloud OAuth client ID (free — see Google Cloud Console)
   - Or just use email for now — it works great

---

## STEP 2 — RAILWAY (Backend API + Scraper)

Railway runs your Node.js server that scrapes sources every 6 hours
and serves the API to your frontend.

### 2a. Create Railway account
1. Go to **https://railway.app** → Sign up with GitHub
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Connect your GitHub account if prompted
5. Select your `claimwatch` repository
   - If you don't have one yet: push the `backend/` folder to a new GitHub repo first

### 2b. Set up the backend service
1. Railway auto-detects Node.js from your `package.json`
2. Go to your service → **"Variables"** tab
3. Click **"Add Variable"** for each of these:

```
DATABASE_URL        = (paste your Supabase connection URI from Step 1c)
SUPABASE_URL        = https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY   = eyJhbGciO...  (anon key from Step 1c)
SUPABASE_SERVICE_ROLE_KEY = eyJhbGciO...  (service role key — SECRET)
ANTHROPIC_API_KEY   = sk-ant-...  (from console.anthropic.com)
ADMIN_SECRET        = (make up a random 32-char string)
NODE_ENV            = production
PORT                = 3001
FRONTEND_URL        = https://your-app.vercel.app  (fill in after Step 3)
```

4. Go to **"Settings"** tab → set **Start Command** to: `node src/index.js`
5. Click **"Deploy"**
6. Wait ~2 minutes → you'll get a URL like `https://claimwatch-backend.railway.app`
7. **Save that URL** — you'll need it for Step 3

### 2c. Trigger the first scrape
1. In Railway, go to your service → **"Shell"** tab
2. Run: `node src/scraper/run.js`
3. Watch the logs — it will scrape all sources and populate your DB
4. After ~5 minutes you should have 50–200+ settlements in the database

---

## STEP 3 — VERCEL (Frontend Hosting)

Vercel hosts your Next.js frontend and deploys automatically on every push.

### 3a. Create Vercel account
1. Go to **https://vercel.com** → Sign up with GitHub (same account)
2. Click **"Add New Project"**
3. Import your GitHub repository
4. Set **Root Directory** to `frontend` (if your repo contains both frontend and backend)
5. Framework: Vercel will auto-detect **Next.js**

### 3b. Add environment variables
In Vercel → your project → **Settings → Environment Variables**, add:

```
NEXT_PUBLIC_SUPABASE_URL      = https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY = eyJhbGciO...  (anon key — safe to expose)
NEXT_PUBLIC_API_URL           = https://claimwatch-backend.railway.app
```

### 3c. Deploy
1. Click **"Deploy"**
2. Vercel builds and deploys in ~2 minutes
3. You get a URL like `https://claimwatch.vercel.app`
4. Go back to Railway → update `FRONTEND_URL` with this URL
5. Also go to Supabase → **Authentication → URL Configuration**:
   - **Site URL:** `https://claimwatch.vercel.app`
   - **Redirect URLs:** add `https://claimwatch.vercel.app/**`

---

## STEP 4 — CONNECT THE FRONTEND HTML TO SUPABASE

In your `settlement-tracker.html` (the standalone version), replace the
localStorage calls with Supabase calls. Add this to the `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
  const SUPABASE_URL  = 'https://xxxxxxxxxxxx.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciO...';
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
</script>
```

Then replace the `localStorage` save/load with:

```javascript
// LOAD claims from Supabase (call on app start)
async function loadClaims() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data } = await supabase
    .from('filed_claims')
    .select('*, settlements(*)')
    .eq('user_id', user.id);
  return data || [];
}

// SAVE a new claim to Supabase
async function saveClaim(settlementId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await supabase.from('filed_claims').upsert({
    user_id: user.id,
    settlement_id: settlementId,
    status: 'filed'
  }, { onConflict: 'user_id,settlement_id' });
}

// MARK paid
async function markPaid(claimId, payoutAmount) {
  await supabase.from('filed_claims').update({
    status: 'paid',
    payout_amount: payoutAmount
  }).eq('id', claimId);
}
```

---

## STEP 5 — CUSTOM DOMAIN (Optional but Professional)

### 5a. Buy a domain
- **Namecheap** (~$10/year): namecheap.com
- **Cloudflare** (~$10/year): cloudflare.com/products/registrar (cheapest, no markup)
- Suggested names: `claimwatch.app`, `claimtracker.io`, `settlementfinder.com`

### 5b. Point domain to Vercel
1. In Vercel → your project → **Settings → Domains**
2. Add your custom domain
3. Vercel shows you DNS records to add (usually a CNAME)
4. Go to your domain registrar → DNS settings → add those records
5. Wait 5–30 minutes for propagation
6. HTTPS is automatic (free via Let's Encrypt)

---

## STEP 6 — KEEPING THE SCRAPER RUNNING

The backend auto-scrapes every 6 hours via cron (built into `src/index.js`).

### Sources it pulls from:
| Source | URL | Type |
|--------|-----|------|
| TopClassActions | topclassactions.com | Settlement aggregator |
| ClassAction.org | classaction.org | Legal news + settlements |
| SettlementClaims | settlementclaims.com | Consumer settlements |
| ConsumerClassActions | consumerclassactions.com | Class action tracker |
| FTC Refunds | ftc.gov/enforcement/refunds | Government enforcement |
| ClassActionRebates | classactionrebates.com | Easy settlements focus |

### To add more sources later:
1. Open `backend/src/scraper/scraper.js`
2. Add a new entry to the `SOURCES` array with a URL and parser function
3. Redeploy to Railway (auto-deploys on GitHub push)

### Manual scrape trigger:
```bash
curl -X POST https://your-backend.railway.app/api/admin/scrape \
  -H "x-admin-key: YOUR_ADMIN_SECRET"
```

### Check scrape status:
The `scrape_log` table in Supabase tracks every run — check it in the
Supabase Table Editor to see how many settlements were found each time.

---

## STEP 7 — MONITORING

### Check your live API:
```
https://your-backend.railway.app/api/stats
→ shows total settlements, categories, ending soon count

https://your-backend.railway.app/api/settlements?limit=10
→ shows 10 active settlements from your DB
```

### Supabase Table Editor:
- Go to Supabase → **Table Editor**
- You can see all settlements, filed claims, and users
- Manually edit or verify any settlement

### Railway Logs:
- Railway → your service → **"Logs"** tab
- Shows real-time scraper output and API requests

---

## QUICK REFERENCE — ALL YOUR URLS

| Service | URL | What it is |
|---------|-----|------------|
| Frontend | https://claimwatch.vercel.app | Your app (users see this) |
| Backend API | https://claimwatch.railway.app | REST API |
| Supabase | https://app.supabase.com | Database dashboard |
| API Stats | /api/stats | Live settlement count |
| API Settlements | /api/settlements | Full settlement list |

---

## TROUBLESHOOTING

**"No settlements showing" after deploy:**
→ Trigger a manual scrape via Railway shell: `node src/scraper/run.js`

**"Auth not working":**
→ Check Supabase → Authentication → URL Configuration has your Vercel URL

**"CORS error" in browser:**
→ Set `FRONTEND_URL` in Railway to your exact Vercel URL (with https://)

**"Database connection failed":**
→ Double-check `DATABASE_URL` in Railway includes your actual Supabase password

**Scraper finding 0 results:**
→ Some sites may have updated their HTML — check Railway logs for parser errors
→ You can manually add settlements via Supabase Table Editor

---

## TOTAL TIME ESTIMATE

| Step | Time |
|------|------|
| Supabase setup + schema | 10 min |
| Railway backend deploy | 10 min |
| Vercel frontend deploy | 5 min |
| Connect everything + test | 10 min |
| Custom domain (optional) | 10 min |
| **Total** | **~45 min** |
