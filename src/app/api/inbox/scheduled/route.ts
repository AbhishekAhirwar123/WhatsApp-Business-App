import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { validateScheduleInput } from '@/lib/inbox/schedule-validation'

/**
 * POST /api/inbox/scheduled — schedule a message in a conversation.
 * Body: { conversation_id, message_type, content_text? | template_name,
 *         template_language?, template_params?, scheduled_for, timezone? }
 *
 * Eligibility (24h window, block, opt-out) is re-checked by the worker at
 * send time; here we validate shape, time and that a free-form message
 * isn't scheduled to a contact that can't receive anything.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.conversation_id !== 'string') {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    const parsed = validateScheduleInput(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data: conv } = await supabase
      .from('conversations')
      .select('id, contact_id, contact:contacts(blocked_at, opt_in_status)')
      .eq('id', body.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as
      | { blocked_at?: string | null; opt_in_status?: string | null }
      | null
    if (contact?.blocked_at) {
      return NextResponse.json({ error: 'This contact is blocked in the CRM.' }, { status: 403 })
    }
    if (parsed.value.message_type === 'template' && contact?.opt_in_status === 'opted_out') {
      return NextResponse.json(
        { error: 'This contact opted out of business-initiated messages.' },
        { status: 403 },
      )
    }

    const { data, error } = await supabase
      .from('scheduled_messages')
      .insert({
        ...parsed.value,
        account_id: accountId,
        conversation_id: conv.id,
        contact_id: conv.contact_id,
        created_by: userId,
      })
      .select('*')
      .single()
    if (error) {
      return NextResponse.json({ error: `Could not schedule: ${error.message}` }, { status: 400 })
    }
    return NextResponse.json({ scheduled: data })
  } catch (error) {
    return toErrorResponse(error)
  }
}
