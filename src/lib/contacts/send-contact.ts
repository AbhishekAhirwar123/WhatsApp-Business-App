import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingSchemaError } from '@/lib/db/schema-compat'

export interface SendContactRow {
  id: string
  phone: string | null
  wa_user_id: string | null
  blocked_at?: string | null
}

/**
 * Load the fields a bot/automation send needs, account-scoped. Includes
 * `blocked_at` (migration 044) so CRM blocks are honoured; on a database
 * that hasn't been migrated yet it retries without that column so sends
 * keep working (nobody can be blocked before the column exists).
 */
export async function selectContactForSend(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ data: SendContactRow | null; error: { message: string } | null }> {
  const withBlock = await db
    .from('contacts')
    .select('id, phone, wa_user_id, blocked_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!withBlock.error || !isMissingSchemaError(withBlock.error)) {
    return withBlock as { data: SendContactRow | null; error: { message: string } | null }
  }
  return (await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()) as { data: SendContactRow | null; error: { message: string } | null }
}
