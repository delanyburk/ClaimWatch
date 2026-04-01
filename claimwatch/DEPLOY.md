# ClaimWatch — Complete Deployment Guide
## Supabase + GitHub + Vercel

---

## What You're Building

```
Browser  →  Vercel (Next.js)  →  Supabase (PostgreSQL)
                ↓
         Vercel Cron (every 6h)
                ↓
         Scraper → TopClassActions, ClassAction.org,
                   AboutLawsuits, ConsumerAffairs
                ↓
         Anthropic API (AI enrichment)
                ↓
         Supabase (upsert new settlements)
```

**Result:** A live web app at `your-app.vercel.app` that:
- Shows ALL active US class action settlements (auto-updated every 6 hours)
- Stores filed claims in Supabase (persists across devices/sessions)
- Automatically hides expired settlements
- Can scale to hundreds of settlements as data grows

---

## STEP 1 — Set Up Supabase Database

### 1.1 Create the Schema

1. Go to **supabase.com** → your project
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `supabase/migrations/001_schema.sql`
5. Paste it into the editor and click **Run**
6. You should see: `Success. No rows returned`

### 1.2 Seed the Initial Data

1. In SQL Editor, click **New Query** again
2. Copy the entire contents of `supabase/migrations/002_seed.sql`
3. Paste and click **Run**
4. You should see: `Success. 15 rows affected`

### 1.3 Get Your API Keys

1. In your Supabase project → **Settings** → **API**
2. Copy these three values (you'll need them in Step 3):

```
Project URL:        https://xxxxxxxxxxxx.supabase.co
anon (public) key:  eyJ...  (long JWT token)
service_role key:   eyJ...  (different long JWT — keep secret!)
```

⚠️  The `service_role` key bypasses Row Level Security.
    NEVER put it in client-side code or commit it to GitHub.

---

## STEP 2 — Push to GitHub

### 2.1 Create a New Repository

1. Go to **github.com** → **New repository**
2. Name it `claimwatch` (or whatever you like)
3. Set to **Private** (recommended — your .env keys won't be in it anyway)
4. Do NOT initialize with README (you already have files)
5. Click **Create repository**

### 2.2 Initialize and Push

Open your terminal and run these commands from inside the `claimwatch/` folder:

```bash
# Navigate to the project folder
cd /path/to/claimwatch

# Install dependencies first (to make sure everything works)
npm install

# Initialize git
git init
git add .
git commit -m "Initial commit — ClaimWatch v3.0"

# Connect to your GitHub repo (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/claimwatch.git
git branch -M main
git push -u origin main
```

You should see all your files appear in GitHub.

---

## STEP 3 — Deploy to Vercel

### 3.1 Connect GitHub to Vercel

1. Go to **vercel.com** → **Add New Project**
2. Click **Import Git Repository**
3. Select your `claimwatch` repository
4. Framework preset: **Next.js** (should auto-detect)
5. Root directory: leave as `/` (default)
6. Click **Configure Project** before deploying

### 3.2 Add Environment Variables

In the Vercel project settings, add these environment variables:

| Variable Name | Value | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxx.supabase.co` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` (anon key) | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` (service role) | Supabase → Settings → API |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | console.anthropic.com → API Keys |
| `CRON_SECRET` | any random string e.g. `claimwatch-cron-2026-xyz` | make one up |

Click **Deploy**.

### 3.3 Wait for Build

Vercel will build and deploy in ~2 minutes. You'll get a URL like:
`https://claimwatch-abc123.vercel.app`

Visit it — your app is live! ✅

---

## STEP 4 — Run the Scraper for the First Time

The cron job runs automatically every 6 hours, but run it manually now
to pull in fresh settlements beyond the 15 seeded ones.

### Option A: From your terminal (easiest)

```bash
# Make sure you're in the claimwatch/ folder with .env.local set up
cp .env.local.example .env.local
# Edit .env.local and fill in your actual keys

# Run the scraper
npm run scrape
```

You'll see output like:
```
🔍 ClaimWatch Scraper — 2026-03-30T...
   Mode: LIVE SCRAPE

📡 Fetching from sources…
  → Scraping TopClassActions.com…
    Found 42 items from TopClassActions
  → Scraping ClassAction.org…
    Found 38 items from ClassAction.org
  ...

🤖 Enriching with AI…

💾 Upserting 67 valid settlements to Supabase…
   ✓ Added: 52, Updated: 0

✅ Scrape complete!
```

### Option B: Trigger via Vercel Cron endpoint

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://your-app.vercel.app/api/scrape
```

---

## STEP 5 — Verify Everything Works

### Check the database

In Supabase → **Table Editor** → `settlements`:
- You should see 15+ rows (seeded) plus whatever the scraper added
- All should have `is_active = true` and future `deadline` values

In Supabase → **Table Editor** → `filed_claims`:
- Starts empty — rows appear as users file claims on the website

### Test the API

```bash
# Should return your settlements as JSON
curl https://your-app.vercel.app/api/settlements

# Filter by category
curl "https://your-app.vercel.app/api/settlements?category=data_breach"

# Search
curl "https://your-app.vercel.app/api/settlements?search=tiktok"
```

### Test filed claims persistence

1. Open the app in your browser
2. File a claim on any settlement
3. Open a **new incognito window** (different browser)
4. Filed claims won't appear — this is correct (different browser_id)
5. Close and reopen the **same browser** → your filed claims are still there ✅

> **Note on browser_id:** Currently claims are tracked per browser using
> localStorage. If you want claims to sync across devices (phone + laptop),
> the next step would be adding Supabase Auth (email/password or Google login).
> Ask and I can add that feature.

---

## STEP 6 — Set Up Automatic Scraping

The `vercel.json` file already configures a cron job to run every 6 hours.
Vercel runs this automatically in production — no action needed.

To change the frequency, edit `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/scrape",
    "schedule": "0 */6 * * *"
  }]
}
```

Common schedules:
- `"0 */6 * * *"` = every 6 hours (recommended)
- `"0 */12 * * *"` = every 12 hours
- `"0 8 * * *"` = once daily at 8am UTC

---

## Future Improvements (When You're Ready)

### Add User Accounts (sync claims across devices)
```bash
# In Supabase: Authentication → Providers → Enable Email
# Then update the app to use supabase.auth.signUp() / signIn()
```

### Add More Scraping Sources
Edit `scripts/scraper.mjs` and add a new function following the pattern
of `scrapeTopClassActions()`. Good sources to add:
- `law360.com/classaction`
- `reuters.com/legal/class-action`
- `courthouse-news.com`
- PACER (federal court system — requires account)

### Add Push Notifications
Use Vercel + Supabase Edge Functions to email users when:
- A new settlement matches their interests
- A deadline is 7 days away
- Their claim status changes

### Add Settlement Verification
Before the scraper upserts, add a verification step that:
1. Checks the claim URL is reachable
2. Confirms the settlement is court-approved
3. Flags any that require payment (scam filter)

---

## Troubleshooting

**Build fails on Vercel:**
- Check all 5 env variables are set correctly
- Make sure you didn't commit `.env.local` (it should be in `.gitignore`)

**Settlements not showing:**
- Go to Supabase → Table Editor → `settlements` → confirm rows exist
- Check that `is_active = true` and `deadline > NOW()`
- Try the API directly: `/api/settlements`

**Scraper finds 0 results:**
- The source websites may have changed their HTML structure
- Check the scraper output for warnings
- The AI enrichment still works even if scraping finds 0 (it uses fallback defaults)

**Filed claims not persisting:**
- Open browser DevTools → Application → Local Storage
- Check that `cwBrowserId` key exists
- If localStorage is blocked (some corporate browsers), claims won't persist

---

## Cost Estimate (Monthly)

| Service | Free Tier | Cost if exceeded |
|---|---|---|
| Vercel | 100GB bandwidth, unlimited deploys | $20/mo (Pro) |
| Supabase | 500MB DB, 2GB bandwidth | $25/mo (Pro) |
| Anthropic API | Pay per use | ~$2–5/mo at 6hr scrape intervals |

**Total at scale:** ~$0–$30/month depending on traffic.
For a personal tool, you'll likely never exceed the free tiers.
