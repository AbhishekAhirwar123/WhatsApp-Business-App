import { randomUUID, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runScheduledMessagesWorker } from '@/lib/inbox/scheduler'

/**
 * Drain due scheduled inbox messages. Hit on a schedule (external pinger,
 * Vercel Cron, docker cron — see docs/WACRM_INBOX_SETUP.md), every minute
 * is typical. Same shared secret as the automations/flows crons:
 * `x-cron-secret` must equal `AUTOMATION_CRON_SECRET`.
 *
 * Safe to run concurrently: rows are claimed with SKIP LOCKED + a lease
 * and every send carries an idempotency key (lib/inbox/scheduler.ts).
 */
export const maxDuration = 60

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const outcomes = await runScheduledMessagesWorker(
      supabaseAdmin(),
      `cron-${randomUUID()}`,
    )
    return NextResponse.json({
      processed: outcomes.length,
      sent: outcomes.filter((o) => o.result === 'sent').length,
      failed: outcomes.filter((o) => o.result === 'failed').length,
    })
  } catch (error) {
    console.error('[inbox cron] worker failed:', error)
    return NextResponse.json({ error: 'worker failed' }, { status: 500 })
  }
}
