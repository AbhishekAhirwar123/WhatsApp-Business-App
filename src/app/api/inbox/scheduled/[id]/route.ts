import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateScheduleInput } from '@/lib/inbox/schedule-validation'

/**
 * PATCH  /api/inbox/scheduled/:id — edit a still-queued schedule.
 * DELETE /api/inbox/scheduled/:id — cancel a still-queued schedule.
 *
 * Both are conditional on status = 'queued' (RLS + the eq below), so a
 * row the worker already claimed returns 409 instead of silently racing
 * the send. Only the creator or an admin may change it (RLS).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const parsed = validateScheduleInput(body ?? {})
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await supabase
      .from('scheduled_messages')
      .update(parsed.value)
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (!data) {
      return NextResponse.json(
        { error: 'This message is already being sent, was sent, or you cannot edit it.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ scheduled: data })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const { data, error } = await supabase
      .from('scheduled_messages')
      .update({ status: 'canceled' })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (!data) {
      return NextResponse.json(
        { error: 'Too late to cancel — it is already being sent or was sent.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ scheduled: data })
  } catch (error) {
    return toErrorResponse(error)
  }
}
