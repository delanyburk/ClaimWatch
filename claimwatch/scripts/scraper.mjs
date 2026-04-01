#!/usr/bin/env node
// scripts/scraper.mjs
// ============================================================
// ClaimWatch Production Scraper
// Pulls active class action settlements from multiple sources.
//
// Usage:
//   node scripts/scraper.mjs           # Normal run
//   node scripts/scraper.mjs --seed    # Seed from hardcoded data
//
// In production this runs on a cron via Vercel Cron Jobs (see vercel.json)
// ============================================================

import { createClient } from '@supabase/supabase-js'
import * as cheerio from 'cheerio'
import { createHash } from 'crypto'

// ── Config ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// ── Dedup key helper ────────────────────────────────────────
function dedupKey(company, caseNumber) {
  const raw = `${company}${caseNumber}`.toLowerCase().replace(/[^a-z0-9]/g, '_')
  return raw.slice(0, 120)
}

// ── Fetch with timeout + retry ───────────────────────────────
async function fetchHtml(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClaimWatch/1.0; +https://claimwatch.app)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (i === retries - 1) throw err
      await new Promise(r => setTimeout(r, 2000 * (i + 1)))
    }
  }
}

// ── Score calculator ────────────────────────────────────────
function computeEaseScore({ proofReq, timeToFile, fieldsCount, needsDocs, needsAccount }) {
  let score = 100
  if (proofReq === 'required') score -= 35
  else if (proofReq === 'optional') score -= 15
  const minutes = parseFloat(String(timeToFile).replace(/[^0-9.]/g, '')) || 5
  score -= Math.min(20, minutes * 2)
  score -= (fieldsCount || 5) * 1.5
  if (needsDocs) score -= 15
  if (needsAccount) score -= 8
  return Math.max(10, Math.min(100, Math.round(score)))
}

function computeWorthScore({ payoutRange, easeScore }) {
  const nums = String(payoutRange).match(/\d+/g) || ['25']
  const avgPayout = nums.reduce((a, b) => a + parseInt(b), 0) / nums.length
  const payoutScore = Math.min(50, Math.log10(avgPayout + 1) * 20)
  return Math.round(payoutScore + easeScore * 0.5)
}

// ── SOURCE 1: TopClassActions.com ───────────────────────────
async function scrapeTopClassActions() {
  console.log('  → Scraping TopClassActions.com…')
  const results = []

  const pages = [
    'https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/',
    'https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/page/2/',
    'https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/page/3/',
  ]

  for (const pageUrl of pages) {
    try {
      const html = await fetchHtml(pageUrl)
      const $ = cheerio.load(html)

      // Each settlement is in an article card
      $('article').each((_, el) => {
        const title = $(el).find('h2, h3').first().text().trim()
        const link  = $(el).find('a').first().attr('href') || ''
        const excerpt = $(el).find('p').first().text().trim()
        const dateText = $(el).find('time, .date').first().text().trim()

        if (!title || !link) return

        // Extract company name from title (usually "Company Name Settlement" or "Company Name Class Action")
        const company = title
          .replace(/class action.*$/i, '')
          .replace(/settlement.*$/i, '')
          .replace(/lawsuit.*$/i, '')
          .trim()
          .slice(0, 60)

        if (company.length < 3) return

        results.push({
          company,
          lawsuit: title.slice(0, 200),
          source_url: link,
          excerpt,
          raw_date: dateText,
          origin: 'topclassactions',
        })
      })

      await new Promise(r => setTimeout(r, 1500)) // polite delay
    } catch (err) {
      console.warn(`    ⚠️  Failed page ${pageUrl}: ${err.message}`)
    }
  }

  console.log(`    Found ${results.length} items from TopClassActions`)
  return results
}

// ── SOURCE 2: ClassAction.org ────────────────────────────────
async function scrapeClassActionOrg() {
  console.log('  → Scraping ClassAction.org…')
  const results = []

  const pages = [
    'https://www.classaction.org/news/settlements',
    'https://www.classaction.org/news/settlements?page=2',
    'https://www.classaction.org/news/settlements?page=3',
  ]

  for (const pageUrl of pages) {
    try {
      const html = await fetchHtml(pageUrl)
      const $ = cheerio.load(html)

      $('article, .settlement-card, .news-item').each((_, el) => {
        const title   = $(el).find('h2, h3, h4').first().text().trim()
        const link    = $(el).find('a').first().attr('href') || ''
        const excerpt = $(el).find('p, .excerpt').first().text().trim()

        if (!title || title.length < 10) return

        const company = title
          .replace(/class action.*$/i, '')
          .replace(/settlement.*$/i, '')
          .trim()
          .slice(0, 60)

        const fullLink = link.startsWith('http') ? link : `https://www.classaction.org${link}`

        results.push({
          company,
          lawsuit: title.slice(0, 200),
          source_url: fullLink,
          excerpt,
          origin: 'classaction_org',
        })
      })

      await new Promise(r => setTimeout(r, 1500))
    } catch (err) {
      console.warn(`    ⚠️  Failed page ${pageUrl}: ${err.message}`)
    }
  }

  console.log(`    Found ${results.length} items from ClassAction.org`)
  return results
}

// ── SOURCE 3: AboutLawsuits.com ──────────────────────────────
async function scrapeAboutLawsuits() {
  console.log('  → Scraping AboutLawsuits.com…')
  const results = []
  try {
    const html = await fetchHtml('https://www.aboutlawsuits.com/category/class-action/')
    const $ = cheerio.load(html)
    $('article').each((_, el) => {
      const title   = $(el).find('h2, h3').first().text().trim()
      const link    = $(el).find('a').first().attr('href') || ''
      const excerpt = $(el).find('p').first().text().trim()
      if (!title || title.length < 10) return
      const company = title.replace(/class action.*$/i,'').replace(/settlement.*$/i,'').trim().slice(0,60)
      results.push({ company, lawsuit: title.slice(0,200), source_url: link, excerpt, origin: 'aboutlawsuits' })
    })
  } catch(err) {
    console.warn(`    ⚠️  AboutLawsuits failed: ${err.message}`)
  }
  console.log(`    Found ${results.length} items from AboutLawsuits`)
  return results
}

// ── SOURCE 4: ConsumerAffairs settlements ────────────────────
async function scrapeConsumerAffairs() {
  console.log('  → Scraping ConsumerAffairs.com…')
  const results = []
  try {
    const html = await fetchHtml('https://www.consumeraffairs.com/news/class-action-lawsuits/')
    const $ = cheerio.load(html)
    $('article, .news-card').each((_, el) => {
      const title = $(el).find('h2,h3,h4').first().text().trim()
      const link  = $(el).find('a').first().attr('href') || ''
      const excerpt = $(el).find('p').first().text().trim()
      if (!title || title.length < 10) return
      const company = title.replace(/class action.*$/i,'').replace(/settlement.*$/i,'').trim().slice(0,60)
      const fullLink = link.startsWith('http') ? link : `https://www.consumeraffairs.com${link}`
      results.push({ company, lawsuit: title.slice(0,200), source_url: fullLink, excerpt, origin: 'consumeraffairs' })
    })
  } catch(err) {
    console.warn(`    ⚠️  ConsumerAffairs failed: ${err.message}`)
  }
  console.log(`    Found ${results.length} items from ConsumerAffairs`)
  return results
}

// ── AI ENRICHMENT ────────────────────────────────────────────
// For each scraped item, use Anthropic to extract structured data
async function enrichWithAI(rawItems) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
  if (!ANTHROPIC_KEY) {
    console.warn('  ⚠️  No ANTHROPIC_API_KEY — skipping AI enrichment, using defaults')
    return rawItems.map(item => ({
      ...item,
      proof_req: 'optional',
      difficulty: 'medium',
      ease_score: 70,
      worth_score: 65,
      time_to_file: '10 min',
      fields_count: 6,
      needs_docs: false,
      needs_account: false,
      total_amount: 'TBD',
      payout_range: 'Varies',
      estimated_payout: 'Varies',
      eligibility: item.excerpt || 'See official settlement website for eligibility details.',
      explanation: item.excerpt || item.lawsuit,
      qualify_when: 'Visit the official settlement website to check your eligibility.',
      proof_explain: 'Check the official settlement website for current proof requirements.',
      steps: ['Visit the official settlement website', 'Follow the claim filing instructions', 'Submit your claim before the deadline'],
      required_info: ['Personal information as requested on the claim form'],
      payment_methods: ['Check', 'PayPal'],
      timeline: ['Check the official website for current deadline and timeline information'],
      deadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      claim_url: item.source_url || '#',
      category: 'other',
      is_active: true,
    }))
  }

  const enriched = []
  // Process in batches of 5 to respect rate limits
  for (let i = 0; i < rawItems.length; i += 5) {
    const batch = rawItems.slice(i, i + 5)
    await Promise.all(batch.map(async (item) => {
      try {
        const prompt = `You are a legal data extraction assistant. Given information about a class action lawsuit settlement, extract structured data.

Title: ${item.lawsuit}
Company: ${item.company}
Excerpt: ${item.excerpt || 'Not available'}
Source: ${item.source_url}

Return ONLY valid JSON (no markdown, no explanation):
{
  "total_amount": "settlement fund total e.g. $50 million",
  "payout_range": "individual payout range e.g. $25 – $200",
  "estimated_payout": "likely payout for a basic claim e.g. $25",
  "deadline": "ISO 8601 datetime string for filing deadline, or null if unknown",
  "category": "one of: data_breach, privacy, false_advertising, product_defect, financial, subscription, other",
  "proof_req": "none, optional, or required",
  "difficulty": "easy, medium, or hard",
  "time_to_file": "estimated time e.g. 5 min",
  "fields_count": 5,
  "needs_docs": false,
  "needs_account": false,
  "claim_url": "direct URL to claim filing page if known, else source URL",
  "eligibility": "one sentence who qualifies",
  "explanation": "2-3 sentence plain English explanation of the lawsuit",
  "qualify_when": "plain English eligibility check",
  "proof_explain": "what proof is needed if any",
  "steps": ["step 1", "step 2", "step 3"],
  "required_info": ["info item 1", "info item 2"],
  "payment_methods": ["PayPal", "Check"],
  "timeline": ["file by date", "review period", "payment estimate"]
}`

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', // Fast + cheap for bulk enrichment
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }],
          }),
        })

        const data = await res.json()
        const text = data.content?.[0]?.text || '{}'
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())

        const ease = computeEaseScore({
          proofReq: parsed.proof_req,
          timeToFile: parsed.time_to_file,
          fieldsCount: parsed.fields_count,
          needsDocs: parsed.needs_docs,
          needsAccount: parsed.needs_account,
        })

        enriched.push({
          ...item,
          ...parsed,
          ease_score: ease,
          worth_score: computeWorthScore({ payoutRange: parsed.payout_range, easeScore: ease }),
          is_active: true,
          deadline: parsed.deadline || new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
        })
      } catch (err) {
        console.warn(`    ⚠️  AI enrichment failed for "${item.company}": ${err.message}`)
        // Add with safe defaults
        enriched.push({
          ...item,
          proof_req: 'optional', difficulty: 'medium', ease_score: 65, worth_score: 60,
          time_to_file: '10 min', fields_count: 6, needs_docs: false, needs_account: false,
          total_amount: 'TBD', payout_range: 'Varies', estimated_payout: 'Varies',
          eligibility: item.excerpt || 'See settlement website for eligibility.',
          explanation: item.excerpt || item.lawsuit,
          qualify_when: 'Visit the official settlement website to check eligibility.',
          proof_explain: 'Check the official settlement website for proof requirements.',
          steps: ['Visit the official settlement website', 'Follow the filing instructions', 'Submit before the deadline'],
          required_info: ['Personal information as requested'],
          payment_methods: ['Check', 'PayPal'],
          timeline: ['Check the official website for current deadline information'],
          deadline: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
          claim_url: item.source_url || '#',
          category: 'other', is_active: true,
        })
      }
    }))
    await new Promise(r => setTimeout(r, 1000)) // Rate limit pause
  }
  return enriched
}

// ── UPSERT to Supabase ───────────────────────────────────────
async function upsertSettlements(settlements, logId) {
  let added = 0, updated = 0

  for (const s of settlements) {
    const key = dedupKey(s.company, s.case_number || s.lawsuit)

    const row = {
      company:          s.company,
      domain:           s.domain || null,
      lawsuit:          s.lawsuit,
      case_number:      s.case_number || null,
      administrator:    s.administrator || null,
      total_amount:     s.total_amount || 'TBD',
      payout_range:     s.payout_range || 'Varies',
      estimated_payout: s.estimated_payout || 'Varies',
      deadline:         s.deadline,
      category:         s.category || 'other',
      proof_req:        s.proof_req || 'optional',
      difficulty:       s.difficulty || 'medium',
      ease_score:       s.ease_score || 65,
      worth_score:      s.worth_score || 60,
      time_to_file:     s.time_to_file || '10 min',
      fields_count:     s.fields_count || 6,
      needs_docs:       s.needs_docs || false,
      needs_account:    s.needs_account || false,
      claim_url:        s.claim_url || s.source_url || '#',
      eligibility:      s.eligibility || '',
      explanation:      s.explanation || '',
      qualify_when:     s.qualify_when || '',
      proof_explain:    s.proof_explain || '',
      steps:            JSON.stringify(s.steps || []),
      required_info:    JSON.stringify(s.required_info || []),
      payment_methods:  JSON.stringify(s.payment_methods || []),
      timeline:         JSON.stringify(s.timeline || []),
      source_url:       s.source_url || null,
      is_active:        true,
      last_verified:    new Date().toISOString(),
      dedup_key:        key,
    }

    const { error, data } = await supabase
      .from('settlements')
      .upsert(row, { onConflict: 'dedup_key', ignoreDuplicates: false })
      .select('id, created_at, updated_at')
      .single()

    if (error) {
      console.warn(`    ⚠️  Upsert failed for "${s.company}": ${error.message}`)
    } else {
      const isNew = data.created_at === data.updated_at
      if (isNew) added++; else updated++
    }
  }

  // Update scrape log
  if (logId) {
    await supabase.from('scrape_log').update({
      settlements_found: settlements.length,
      settlements_added: added,
      settlements_updated: updated,
      finished_at: new Date().toISOString(),
      status: 'success',
    }).eq('id', logId)
  }

  return { added, updated }
}

// ── Expire stale settlements ─────────────────────────────────
async function expireStale() {
  const { error } = await supabase
    .from('settlements')
    .update({ is_active: false })
    .lt('deadline', new Date().toISOString())
  if (error) console.warn('  ⚠️  Failed to expire stale settlements:', error.message)
  else console.log('  ✓  Expired past-deadline settlements')
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  const isSeed = process.argv.includes('--seed')
  console.log(`\n🔍 ClaimWatch Scraper — ${new Date().toISOString()}`)
  console.log(isSeed ? '   Mode: SEED (skipping live scrape)' : '   Mode: LIVE SCRAPE')

  // Start scrape log entry
  const { data: logRow } = await supabase
    .from('scrape_log')
    .insert({ source: isSeed ? 'seed' : 'multi-source', status: 'running' })
    .select('id')
    .single()
  const logId = logRow?.id

  try {
    let allItems = []

    if (!isSeed) {
      // Run all scrapers in parallel
      console.log('\n📡 Fetching from sources…')
      const [tca, cao, al, ca] = await Promise.allSettled([
        scrapeTopClassActions(),
        scrapeClassActionOrg(),
        scrapeAboutLawsuits(),
        scrapeConsumerAffairs(),
      ])
      allItems = [
        ...(tca.status === 'fulfilled' ? tca.value : []),
        ...(cao.status === 'fulfilled' ? cao.value : []),
        ...(al.status  === 'fulfilled' ? al.value  : []),
        ...(ca.status  === 'fulfilled' ? ca.value  : []),
      ]

      // Deduplicate by company name similarity
      const seen = new Set()
      allItems = allItems.filter(item => {
        const key = item.company.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`\n📊 Total unique items: ${allItems.length}`)
      console.log('\n🤖 Enriching with AI…')
      allItems = await enrichWithAI(allItems)
    }

    // Filter: must have a future deadline and a claim URL
    const valid = allItems.filter(s => {
      if (!s.deadline) return false
      if (new Date(s.deadline) <= new Date()) return false
      if (!s.claim_url || s.claim_url === '#') return false
      return true
    })

    console.log(`\n💾 Upserting ${valid.length} valid settlements to Supabase…`)
    const { added, updated } = await upsertSettlements(valid, logId)
    console.log(`   ✓ Added: ${added}, Updated: ${updated}`)

    // Clean up expired ones
    await expireStale()

    console.log('\n✅ Scrape complete!\n')
  } catch (err) {
    console.error('\n❌ Scraper failed:', err)
    if (logId) {
      await supabase.from('scrape_log').update({
        status: 'error',
        error_message: err.message,
        finished_at: new Date().toISOString(),
      }).eq('id', logId)
    }
    process.exit(1)
  }
}

main()
