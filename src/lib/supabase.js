// src/lib/supabase.js
// Shared Supabase client — works in both browser and server components

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables. Check your .env.local file.')
}

// Browser client (used in React components)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Service role client (used in API routes / scraper — never expose to browser)
export function getServiceClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  return createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })
}

// ── Settlement queries ──────────────────────────────────────

export async function getActiveSettlements({ sortBy = 'ease_score', category, proofReq } = {}) {
  let query = supabase
    .from('active_settlements')   // uses the view (filters expired automatically)
    .select('*')

  if (category && category !== 'all') {
    query = query.eq('category', category)
  }
  if (proofReq && proofReq !== 'all') {
    query = query.eq('proof_req', proofReq)
  }

  const sortMap = {
    ease_score:  { col: 'ease_score',  asc: false },
    deadline:    { col: 'deadline',    asc: true  },
    total_payout:{ col: 'worth_score', asc: false },
    worth_score: { col: 'worth_score', asc: false },
    date_added:  { col: 'date_added',  asc: false },
  }
  const sort = sortMap[sortBy] || sortMap.ease_score
  query = query.order(sort.col, { ascending: sort.asc })

  const { data, error } = await query
  if (error) throw error
  return data
}

export async function getSettlementById(id) {
  const { data, error } = await supabase
    .from('settlements')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

// ── Filed claims (anonymous, using browser_id) ─────────────

export async function getFiledClaims(browserId) {
  const { data, error } = await supabase
    .from('filed_claims')
    .select(`*, settlements(company, lawsuit, payout_range, estimated_payout, domain)`)
    .eq('browser_id', browserId)
    .order('filed_at', { ascending: false })
  if (error) throw error
  return data
}

export async function fileClaim(browserId, settlementId, type = 'new') {
  const { data, error } = await supabase
    .from('filed_claims')
    .upsert({
      browser_id: browserId,
      settlement_id: settlementId,
      status: type === 'new' ? 'filed' : 'pending',
    }, { onConflict: 'settlement_id,browser_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function markClaimPaid(browserId, settlementId, paidAmount = null) {
  const { data, error } = await supabase
    .from('filed_claims')
    .update({ status: 'paid', paid_amount: paidAmount })
    .eq('browser_id', browserId)
    .eq('settlement_id', settlementId)
    .select()
    .single()
  if (error) throw error
  return data
}
