/**
 * ClaimWatch Production Scraper
 * Pulls from 6+ real sources and normalizes into the DB schema
 */

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

// ─── SOURCE DEFINITIONS ───────────────────────────────────────
const SOURCES = [
  {
    name: 'TopClassActions',
    url: 'https://topclassactions.com/lawsuit-settlements/open-class-action-settlements/',
    type: 'cheerio',
    parser: parseTopClassActions,
    rateLimit: 3000,
  },
  {
    name: 'ClassAction.org',
    url: 'https://www.classaction.org/settlements',
    type: 'cheerio',
    parser: parseClassActionOrg,
    rateLimit: 3000,
  },
  {
    name: 'SettlementClaims',
    url: 'https://www.settlementclaims.com/',
    type: 'cheerio',
    parser: parseSettlementClaims,
    rateLimit: 3000,
  },
  {
    name: 'ConsumerClassActions',
    url: 'https://consumerclassactions.com/settlements/',
    type: 'cheerio',
    parser: parseGenericSettlementPage,
    rateLimit: 3000,
  },
  {
    name: 'FTC_Refunds',
    url: 'https://www.ftc.gov/enforcement/refunds',
    type: 'cheerio',
    parser: parseFTCRefunds,
    rateLimit: 5000,
  },
  {
    name: 'ClassActionRebates',
    url: 'https://classactionrebates.com/',
    type: 'cheerio',
    parser: parseGenericSettlementPage,
    rateLimit: 3000,
  },
];

// ─── SCRAPER HEADERS ──────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; ClaimWatchBot/1.0; +https://claimwatch.app/bot)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ─── HASH HELPER (dedup) ──────────────────────────────────────
function makeScrapeHash(company, lawsuit, deadline) {
  return crypto
    .createHash('sha256')
    .update(`${company}|${lawsuit}|${deadline}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── EASE SCORE CALCULATOR ────────────────────────────────────
function calcEaseScore({ proofReq, timeToFile, fieldsCount, needsDocs, needsAccountLookup }) {
  let score = 100;
  if (proofReq === 'required') score -= 35;
  else if (proofReq === 'optional') score -= 15;

  const mins = parseInt(timeToFile) || 5;
  if (mins <= 2)  score -= 0;
  else if (mins <= 5)  score -= 5;
  else if (mins <= 10) score -= 10;
  else score -= 20;

  if (needsDocs) score -= 15;
  if (needsAccountLookup) score -= 5;
  if (fieldsCount > 8) score -= 10;

  return Math.max(10, Math.min(100, score));
}

// ─── WORTH SCORE CALCULATOR ───────────────────────────────────
function calcWorthScore(estimatedPayout, easeScore) {
  const amount = parseInt((estimatedPayout || '').replace(/\D.*$/, '').replace('$', '')) || 0;
  let payoutScore = 0;
  if (amount >= 500)  payoutScore = 100;
  else if (amount >= 100) payoutScore = 70;
  else if (amount >= 50)  payoutScore = 50;
  else if (amount >= 25)  payoutScore = 35;
  else payoutScore = 20;

  return Math.round((payoutScore * 0.6) + (easeScore * 0.4));
}

// ─── PARSER: TopClassActions.com ─────────────────────────────
async function parseTopClassActions(html) {
  const $ = cheerio.load(html);
  const settlements = [];

  // They list settlements in article cards
  $('article, .settlement-item, .entry').each((i, el) => {
    try {
      const $el = $(el);
      const title = $el.find('h2, h3, .entry-title').first().text().trim();
      const excerpt = $el.find('.entry-summary, .excerpt, p').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const dateText = $el.find('.entry-date, time, .date').first().text().trim();

      if (!title || title.length < 10) return;

      // Extract company from title (usually "CompanyName Class Action Settlement")
      const companyMatch = title.match(/^([^:]+?)\s+(?:Class Action|Settlement|Lawsuit)/i);
      const company = companyMatch ? companyMatch[1].trim() : title.split(' ').slice(0, 2).join(' ');

      // Try to extract deadline from excerpt
      const deadlineMatch = excerpt.match(/deadline[:\s]+([A-Za-z]+ \d+,?\s*\d{4})/i);
      const deadline = deadlineMatch
        ? new Date(deadlineMatch[1])
        : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // default 90 days

      if (isNaN(deadline.getTime()) || deadline < new Date()) return;

      // Extract payout from excerpt
      const payoutMatch = excerpt.match(/\$[\d,]+(?:\s*(?:–|-)\s*\$[\d,]+)?/);
      const payout = payoutMatch ? payoutMatch[0] : 'Varies';

      settlements.push({
        company,
        lawsuit: title,
        category: inferCategory(title + ' ' + excerpt),
        deadline: deadline.toISOString(),
        estimatedPayout: payout,
        payoutRange: payout,
        totalAmount: 'See website',
        proofReq: inferProofReq(excerpt),
        explanation: excerpt.slice(0, 300),
        eligibility: extractEligibility(excerpt),
        claimUrl: link || '',
        source_url: link || '',
        source_name: 'TopClassActions',
      });
    } catch (e) {
      // skip malformed entries
    }
  });

  return settlements;
}

// ─── PARSER: ClassAction.org ──────────────────────────────────
async function parseClassActionOrg(html) {
  const $ = cheerio.load(html);
  const settlements = [];

  $('.settlement-card, .case-card, article, .listing-item').each((i, el) => {
    try {
      const $el = $(el);
      const title   = $el.find('h2, h3, .title').first().text().trim();
      const company = $el.find('.company, .defendant').first().text().trim() || title.split(' vs')[0].trim();
      const amount  = $el.find('.amount, .settlement-amount').first().text().trim();
      const date    = $el.find('.deadline, .date, time').first().text().trim();
      const link    = $el.find('a').first().attr('href');
      const desc    = $el.find('p, .description').first().text().trim();

      if (!title) return;

      const deadline = date ? new Date(date) : new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
      if (isNaN(deadline.getTime()) || deadline < new Date()) return;

      settlements.push({
        company: company || title.split(' ')[0],
        lawsuit: title,
        category: inferCategory(title + ' ' + desc),
        deadline: deadline.toISOString(),
        estimatedPayout: amount || 'Varies',
        payoutRange: amount || 'Varies',
        totalAmount: 'See website',
        proofReq: inferProofReq(desc),
        explanation: desc.slice(0, 300),
        eligibility: extractEligibility(desc),
        claimUrl: link || '',
        source_url: link || '',
        source_name: 'ClassAction.org',
      });
    } catch (e) {}
  });

  return settlements;
}

// ─── PARSER: SettlementClaims ─────────────────────────────────
async function parseSettlementClaims(html) {
  const $ = cheerio.load(html);
  const settlements = [];

  $('article, .post, .settlement').each((i, el) => {
    try {
      const $el = $(el);
      const title = $el.find('h2, h3').first().text().trim();
      const desc  = $el.find('p').first().text().trim();
      const link  = $el.find('a').first().attr('href');

      if (!title) return;

      const deadlineMatch = (title + desc).match(/(?:by|before|deadline)[:\s]+([A-Za-z]+ \d+,?\s*\d{4})/i);
      const deadline = deadlineMatch
        ? new Date(deadlineMatch[1])
        : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

      if (deadline < new Date()) return;

      const payoutMatch = (title + desc).match(/\$[\d,]+/);

      settlements.push({
        company: title.split(/\s+(?:class|settlement|lawsuit)/i)[0].trim(),
        lawsuit: title,
        category: inferCategory(title + ' ' + desc),
        deadline: deadline.toISOString(),
        estimatedPayout: payoutMatch ? payoutMatch[0] : 'Varies',
        payoutRange: payoutMatch ? payoutMatch[0] : 'Varies',
        totalAmount: 'See website',
        proofReq: inferProofReq(desc),
        explanation: desc.slice(0, 300),
        eligibility: extractEligibility(desc),
        claimUrl: link || '',
        source_url: link || '',
        source_name: 'SettlementClaims',
      });
    } catch (e) {}
  });

  return settlements;
}

// ─── PARSER: FTC Refunds Page ─────────────────────────────────
async function parseFTCRefunds(html) {
  const $ = cheerio.load(html);
  const settlements = [];

  $('table tr, .refund-item, article').each((i, el) => {
    try {
      const $el = $(el);
      const cells = $el.find('td');
      if (cells.length < 2) return;

      const company  = $(cells[0]).text().trim();
      const details  = $(cells[1]).text().trim();
      const link     = $el.find('a').first().attr('href');

      if (!company || company.length < 2) return;

      const deadlineMatch = details.match(/([A-Za-z]+ \d+,?\s*\d{4})/);
      const deadline = deadlineMatch
        ? new Date(deadlineMatch[1])
        : new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);

      if (deadline < new Date()) return;

      settlements.push({
        company,
        lawsuit: `${company} FTC Refund Program`,
        category: 'financial',
        deadline: deadline.toISOString(),
        estimatedPayout: 'Varies',
        payoutRange: 'Varies',
        totalAmount: 'See FTC website',
        proofReq: 'optional',
        explanation: details.slice(0, 300),
        eligibility: `Customers of ${company} who were affected by the FTC enforcement action.`,
        claimUrl: link || 'https://www.ftc.gov/enforcement/refunds',
        source_url: 'https://www.ftc.gov/enforcement/refunds',
        source_name: 'FTC',
      });
    } catch (e) {}
  });

  return settlements;
}

// ─── GENERIC PARSER fallback ──────────────────────────────────
async function parseGenericSettlementPage(html) {
  const $ = cheerio.load(html);
  const settlements = [];

  $('article, .post, .item, .card, li.settlement').each((i, el) => {
    try {
      const $el  = $(el);
      const title = $el.find('h2, h3, h4, .title').first().text().trim();
      const desc  = $el.find('p, .description, .excerpt').first().text().trim();
      const link  = $el.find('a').first().attr('href');

      if (!title || title.length < 5) return;

      const deadlineMatch = (title + desc).match(/(?:deadline|by|before|submit by)[:\s]+([A-Za-z]+ \d+,?\s*\d{4})/i);
      const deadline = deadlineMatch
        ? new Date(deadlineMatch[1])
        : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

      if (isNaN(deadline.getTime()) || deadline < new Date()) return;

      const payoutMatch = (title + desc).match(/\$[\d,]+(?:\s*(?:–|-)\s*\$[\d,]+)?/);

      settlements.push({
        company: title.split(/\s+(?:class|vs|settlement|lawsuit)/i)[0].slice(0, 50).trim(),
        lawsuit: title.slice(0, 200),
        category: inferCategory(title + ' ' + desc),
        deadline: deadline.toISOString(),
        estimatedPayout: payoutMatch ? payoutMatch[0] : 'Varies',
        payoutRange: payoutMatch ? payoutMatch[0] : 'Varies',
        totalAmount: 'See website',
        proofReq: inferProofReq(desc),
        explanation: desc.slice(0, 400),
        eligibility: extractEligibility(desc),
        claimUrl: link || '',
        source_url: link || '',
        source_name: 'Web',
      });
    } catch (e) {}
  });

  return settlements;
}

// ─── AI ENRICHMENT (fills in gaps via Claude) ─────────────────
async function enrichWithAI(rawSettlements) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const enriched = [];

  for (const s of rawSettlements) {
    // Only enrich if we have a real URL to fetch more info from
    if (!s.claimUrl || s.explanation.length > 200) {
      enriched.push(finalizeSettlement(s));
      continue;
    }

    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        system: `You are a legal data extractor. Given settlement info, return ONLY valid JSON (no markdown) matching this schema:
{
  "proofReq": "none|optional|required",
  "difficulty": "easy|medium|hard",
  "timeToFile": "X min",
  "steps": ["step1","step2"],
  "requiredInfo": ["info1","info2"],
  "paymentMethods": ["PayPal","Check"],
  "timeline": ["step1","step2","step3"],
  "eligibility": "plain English who qualifies",
  "proofExplain": "what proof is needed"
}`,
        messages: [{
          role: 'user',
          content: `Extract structured data from this settlement:\nCompany: ${s.company}\nLawsuit: ${s.lawsuit}\nDescription: ${s.explanation}\nURL: ${s.claimUrl}`
        }]
      });

      const raw = message.content[0].text.replace(/```json|```/g, '').trim();
      const extra = JSON.parse(raw);
      enriched.push(finalizeSettlement({ ...s, ...extra }));
    } catch (e) {
      enriched.push(finalizeSettlement(s));
    }

    // Rate limit AI calls
    await sleep(500);
  }

  return enriched;
}

// ─── FINALIZE: compute scores, defaults ───────────────────────
function finalizeSettlement(s) {
  const proofReq = s.proofReq || 'optional';
  const timeToFile = s.timeToFile || '5 min';
  const fieldsCount = s.requiredInfo?.length || 5;
  const needsDocs = proofReq === 'required';
  const needsAccountLookup = (s.eligibility || '').toLowerCase().includes('account');

  const easeScore = calcEaseScore({ proofReq, timeToFile, fieldsCount, needsDocs, needsAccountLookup });
  const worthScore = calcWorthScore(s.estimatedPayout, easeScore);

  let difficulty = 'medium';
  if (easeScore >= 85) difficulty = 'easy';
  else if (easeScore <= 60) difficulty = 'hard';

  return {
    company: s.company || 'Unknown',
    domain: extractDomain(s.claimUrl || s.source_url || ''),
    category: s.category || 'other',
    lawsuit: s.lawsuit || '',
    case_number: s.case_number || null,
    administrator: s.administrator || null,
    total_amount: s.totalAmount || 'See website',
    payout_range: s.payoutRange || s.estimatedPayout || 'Varies',
    estimated_payout: s.estimatedPayout || 'Varies',
    deadline: s.deadline,
    proof_req: proofReq,
    ease_score: easeScore,
    difficulty,
    time_to_file: timeToFile,
    worth_score: worthScore,
    claim_url: s.claimUrl || '',
    eligibility: s.eligibility || '',
    payment_methods: s.paymentMethods || ['Check'],
    explanation: s.explanation || '',
    qualify_when: s.qualify_when || s.eligibility || '',
    proof_explain: s.proofExplain || s.proof_explain || '',
    steps: s.steps || [],
    required_info: s.requiredInfo || s.required_info || [],
    timeline: s.timeline || [],
    source_url: s.source_url || '',
    source_name: s.source_name || 'Web',
    is_verified: false,
    is_active: true,
    scrape_hash: makeScrapeHash(s.company, s.lawsuit, s.deadline),
  };
}

// ─── HELPERS ──────────────────────────────────────────────────
function inferCategory(text) {
  const t = text.toLowerCase();
  if (/data breach|hack|breach|cyberattack|personal data|ssn|social security/.test(t)) return 'data_breach';
  if (/privacy|tracking|biometric|facial recognition|voice|pixel|cookie/.test(t)) return 'privacy';
  if (/false advertis|mislead|deceptive|labeling|oversize|ingredient/.test(t)) return 'false_advertising';
  if (/defect|recall|malfunction|battery|throttl|product/.test(t)) return 'product_defect';
  if (/fee|overcharg|bank|credit|loan|interest|subscription|billing/.test(t)) return 'financial';
  return 'other';
}

function inferProofReq(text) {
  const t = (text || '').toLowerCase();
  if (/no proof|no receipt|no documentation|without proof|not required/.test(t)) return 'none';
  if (/proof required|must provide|documentation required|upload/.test(t)) return 'required';
  return 'optional';
}

function extractEligibility(text) {
  const sentences = (text || '').split(/[.!?]/).filter(s => s.length > 20);
  const eligSentence = sentences.find(s =>
    /who|qualif|eligible|resident|customer|purchased|used|bought|owned/.test(s.toLowerCase())
  );
  return eligSentence?.trim() || text.slice(0, 150);
}

function extractDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace('www.', '');
  } catch { return ''; }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── MAIN RUN ─────────────────────────────────────────────────
async function runScraper(db) {
  const logger = require('../utils/logger');
  const results = { new: 0, updated: 0, errors: 0 };

  logger.info('🔍 Starting scrape run...');

  for (const source of SOURCES) {
    try {
      logger.info(`Scraping: ${source.name}`);

      const res = await axios.get(source.url, {
        headers: HEADERS,
        timeout: 15000,
      });

      const raw = await source.parser(res.data);
      logger.info(`  → ${raw.length} raw settlements from ${source.name}`);

      // Enrich with AI (in batches to avoid rate limits)
      const enriched = await enrichWithAI(raw.slice(0, 20)); // cap per source

      // Upsert into DB
      for (const s of enriched) {
        if (!s.scrape_hash || !s.company || !s.deadline) continue;

        try {
          const existing = await db.query(
            'SELECT id FROM settlements WHERE scrape_hash = $1',
            [s.scrape_hash]
          );

          if (existing.rows.length === 0) {
            await db.query(`
              INSERT INTO settlements (
                company, domain, category, lawsuit, case_number, administrator,
                total_amount, payout_range, estimated_payout, deadline, proof_req,
                ease_score, difficulty, time_to_file, worth_score, claim_url,
                eligibility, payment_methods, explanation, qualify_when, proof_explain,
                steps, required_info, timeline, source_url, source_name,
                is_verified, is_active, scrape_hash
              ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
              )
            `, [
              s.company, s.domain, s.category, s.lawsuit, s.case_number, s.administrator,
              s.total_amount, s.payout_range, s.estimated_payout, s.deadline, s.proof_req,
              s.ease_score, s.difficulty, s.time_to_file, s.worth_score, s.claim_url,
              s.eligibility, s.payment_methods, s.explanation, s.qualify_when, s.proof_explain,
              s.steps, s.required_info, s.timeline, s.source_url, s.source_name,
              s.is_verified, s.is_active, s.scrape_hash,
            ]);
            results.new++;
          } else {
            // Update deadline and activity status
            await db.query(`
              UPDATE settlements
              SET deadline = $1, is_active = $2, date_updated = NOW()
              WHERE scrape_hash = $3
            `, [s.deadline, new Date(s.deadline) > new Date(), s.scrape_hash]);
            results.updated++;
          }
        } catch (e) {
          logger.error(`DB insert error: ${e.message}`);
          results.errors++;
        }
      }

      await sleep(source.rateLimit);
    } catch (e) {
      logger.error(`Failed to scrape ${source.name}: ${e.message}`);
      results.errors++;
    }
  }

  // Deactivate expired
  await db.query(`
    UPDATE settlements SET is_active = false, date_updated = NOW()
    WHERE deadline < NOW() AND is_active = true
  `);

  logger.info(`✅ Scrape complete: +${results.new} new, ${results.updated} updated, ${results.errors} errors`);
  return results;
}

module.exports = { runScraper };
