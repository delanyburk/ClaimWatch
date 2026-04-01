// src/app/api/claims/route.js
import { getServiceClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/claims?browser_id=xxx  → returns all filed claims for this browser
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const browserId = searchParams.get('browser_id')

  if (!browserId) {
    return NextResponse.json({ error: 'browser_id required' }, { status: 400 })
  }

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('filed_claims')
      .select(`
        *,
        settlements (
          id, company, domain, lawsuit, payout_range, estimated_payout,
          claim_url, deadline, total_amount
        )
      `)
      .eq('browser_id', browserId)
      .order('filed_at', { ascending: false })

    if (error) throw error
    return NextResponse.json({ claims: data })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// POST /api/claims → file a new claim
export async function POST(request) {
  const body = await request.json()
  const { browser_id, settlement_id, type } = body

  if (!browser_id || !settlement_id) {
    return NextResponse.json({ error: 'browser_id and settlement_id required' }, { status: 400 })
  }

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('filed_claims')
      .upsert({
        browser_id,
        settlement_id,
        status: type === 'new' ? 'filed' : 'pending',
      }, { onConflict: 'settlement_id,browser_id' })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ claim: data })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// PATCH /api/claims → mark as paid
export async function PATCH(request) {
  const body = await request.json()
  const { browser_id, settlement_id, status, paid_amount } = body

  if (!browser_id || !settlement_id) {
    return NextResponse.json({ error: 'browser_id and settlement_id required' }, { status: 400 })
  }

  try {
    const supabase = getServiceClient()
    const { data, error } = await supabase
      .from('filed_claims')
      .update({ status: status || 'paid', paid_amount: paid_amount || null })
      .eq('browser_id', browser_id)
      .eq('settlement_id', settlement_id)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ claim: data })
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
