/**
 * ClaimWatch API Server
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const { Pool }    = require('pg');
const logger      = require('./utils/logger');
const { runScraper } = require('./scraper/scraper');

const app = express();
const db  = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ─── ROUTES: SETTLEMENTS ──────────────────────────────────────

// GET /api/settlements — list all active, with filtering + sorting
app.get('/api/settlements', async (req, res) => {
  try {
    const {
      sort = 'ease_score',
      order = 'desc',
      category,
      proof_req,
      difficulty,
      ending_soon,
      search,
      limit = 100,
      offset = 0,
    } = req.query;

    const allowed_sorts = ['ease_score', 'deadline', 'worth_score', 'date_added', 'estimated_payout'];
    const sortCol = allowed_sorts.includes(sort) ? sort : 'ease_score';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    let conditions = ['is_active = true', 'deadline > NOW()'];
    const params = [];
    let p = 1;

    if (category)    { conditions.push(`category = $${p++}`);   params.push(category); }
    if (proof_req)   { conditions.push(`proof_req = $${p++}`);  params.push(proof_req); }
    if (difficulty)  { conditions.push(`difficulty = $${p++}`); params.push(difficulty); }
    if (ending_soon === 'true') {
      conditions.push(`deadline <= NOW() + INTERVAL '30 days'`);
    }
    if (search) {
      conditions.push(`(company ILIKE $${p} OR lawsuit ILIKE $${p} OR eligibility ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    const where = conditions.join(' AND ');

    const { rows } = await db.query(`
      SELECT *, EXTRACT(EPOCH FROM (deadline - NOW()))/86400 AS days_left
      FROM settlements
      WHERE ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${p++} OFFSET $${p++}
    `, [...params, Math.min(parseInt(limit), 200), parseInt(offset)]);

    const countResult = await db.query(
      `SELECT COUNT(*) FROM settlements WHERE ${where}`,
      params
    );

    res.json({
      settlements: rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/settlements/:id
app.get('/api/settlements/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM settlements WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── ROUTES: FILED CLAIMS (requires Supabase JWT) ────────────
// These are handled directly by Supabase RLS — the frontend calls
// Supabase directly. These endpoints are optional backup routes.

app.get('/api/my-claims', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT fc.*, s.company, s.lawsuit, s.estimated_payout, s.deadline, s.domain
      FROM filed_claims fc
      JOIN settlements s ON fc.settlement_id = s.id
      WHERE fc.user_id = $1
      ORDER BY fc.filed_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/my-claims', requireAuth, async (req, res) => {
  const { settlement_id } = req.body;
  if (!settlement_id) return res.status(400).json({ error: 'settlement_id required' });
  try {
    const { rows } = await db.query(`
      INSERT INTO filed_claims (user_id, settlement_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, settlement_id) DO NOTHING
      RETURNING *
    `, [req.user.id, settlement_id]);
    res.json(rows[0] || { message: 'Already filed' });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.patch('/api/my-claims/:id', requireAuth, async (req, res) => {
  const { status, payout_amount } = req.body;
  try {
    const { rows } = await db.query(`
      UPDATE filed_claims
      SET status = COALESCE($1, status), payout_amount = COALESCE($2, payout_amount)
      WHERE id = $3 AND user_id = $4
      RETURNING *
    `, [status, payout_amount, req.params.id, req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── ROUTES: STATS ────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [total, byCategory, zeroProof, endingSoon] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM settlements WHERE is_active=true AND deadline>NOW()`),
      db.query(`SELECT category, COUNT(*) FROM settlements WHERE is_active=true AND deadline>NOW() GROUP BY category`),
      db.query(`SELECT COUNT(*) FROM settlements WHERE is_active=true AND deadline>NOW() AND proof_req='none'`),
      db.query(`SELECT COUNT(*) FROM settlements WHERE is_active=true AND deadline BETWEEN NOW() AND NOW()+INTERVAL '30 days'`),
    ]);
    res.json({
      total: parseInt(total.rows[0].count),
      zero_proof: parseInt(zeroProof.rows[0].count),
      ending_soon: parseInt(endingSoon.rows[0].count),
      by_category: byCategory.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── ROUTES: SCRAPE TRIGGER (admin only) ──────────────────────
app.post('/api/admin/scrape', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Scrape started' });
  runScraper(db).catch(e => logger.error(e));
});

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────
async function requireAuth(req, res, next) {
  // Verify Supabase JWT
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Auth error' });
  }
}

// ─── CRON: SCRAPE EVERY 6 HOURS ───────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  logger.info('⏰ Cron: starting scheduled scrape');
  try {
    await runScraper(db);
  } catch (e) {
    logger.error('Cron scrape failed:', e.message);
  }
});

// ─── CRON: DEACTIVATE EXPIRED SETTLEMENTS (daily) ─────────────
cron.schedule('0 2 * * *', async () => {
  await db.query(`
    UPDATE settlements SET is_active = false
    WHERE deadline < NOW() AND is_active = true
  `);
  logger.info('✅ Expired settlements deactivated');
});

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`🚀 ClaimWatch API running on port ${PORT}`);
  // Run initial scrape on startup if DB is empty
  db.query('SELECT COUNT(*) FROM settlements').then(r => {
    if (parseInt(r.rows[0].count) < 5) {
      logger.info('DB empty — running initial scrape');
      runScraper(db).catch(console.error);
    }
  }).catch(() => {});
});

module.exports = app;
