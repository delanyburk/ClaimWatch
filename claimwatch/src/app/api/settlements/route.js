// src/app/api/settlements/route.js
import { getServiceClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export const revalidate = 300 // Cache for 5 minutes

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const category  = searchParams.get('category')
  const proofReq  = searchParams.get('proof_req')
  const sortBy    = searchParams.get('sort') || 'ease_score'
  const search    = searchParams.get('search')
  const endingSoon = searchParams.get('ending_soon') === 'true'

  try {
    const supabase = getServiceClient()
    let query = supabase.from('active_settlements').select('*')

    if (category && category !== 'all')  query = query.eq('category', category)
    if (proofReq && proofReq !== 'all')  query = query.eq('proof_req', proofReq)
    if (endingSoon) query = query.lt('deadline', new Date(Date.now() + 30*24*60*60*1000).toISOString())

    if (search) {
      query = query.or(`company.ilike.%${search}%,lawsuit.ilike.%${search}%,eligibility.ilike.%${search}%`)
    }

    const sortMap = {
      ease_score: { col: 'ease_score',  asc: false },
      deadline:   { col: 'deadline',    asc: true  },
      payout:     { col: 'worth_score', asc: false },
      worth_score:{ col: 'worth_score', asc: false },
      date_added: { col: 'date_added',  asc: false },
    }
    const sort = sortMap[sortBy] || sortMap.ease_score
    query = query.order(sort.col, { ascending: sort.asc }).limit(200)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ settlements: data, count: data.length })
  } catch (err) {
    console.error('[API /settlements]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
