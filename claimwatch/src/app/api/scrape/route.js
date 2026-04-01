// src/app/api/scrape/route.js
// Called by Vercel Cron every 6 hours
// Protected by CRON_SECRET so only Vercel can trigger it

import { NextResponse } from 'next/server'

export async function GET(request) {
  // Verify this is called by Vercel Cron (not a random user)
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Dynamically import and run the scraper logic
    // (avoids bundling the heavy cheerio/node-cron into the main app)
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)

    const { stdout, stderr } = await exec('node', ['scripts/scraper.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
      },
      timeout: 5 * 60 * 1000, // 5 minute timeout
    })

    console.log('[Cron] Scraper stdout:', stdout)
    if (stderr) console.error('[Cron] Scraper stderr:', stderr)

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      output: stdout.slice(-500), // Last 500 chars
    })
  } catch (err) {
    console.error('[Cron] Scraper failed:', err)
    return NextResponse.json({
      success: false,
      error: err.message,
    }, { status: 500 })
  }
}
