-- 044_inbox_parity.sql
--
-- DoubleTick-style inbox: queues, saved views, accountability, scheduling.
-- Purely ADDITIVE — new tables/columns/functions/triggers plus backfills of
-- the new columns. No existing column is dropped or rewritten. See
-- docs/DOUBLETICK_INBOX_PARITY.md for the state model and
-- docs/WACRM_INBOX_SETUP.md for rollout/rollback.
--
-- State model (each dimension is independent):
--   lifecycle      conversations.status          open | pending | closed (UI: Resolved)
--   awaiting reply conversations.awaiting_reply_since
--                  set by the first customer message after the last
--                  successful *agent* reply; cleared when an agent message
--                  reaches sent/delivered/read. Bot messages (flows,
--                  automations, AI) never clear it; a send that later
--                  fails restores it.
--   unread         per user: conversation_reads.last_read_at vs
--                  conversations.last_inbound_at (the legacy shared
--                  conversations.unread_count is kept for older screens).
--   SLA            derived: awaiting_reply_since + target minutes from
--                  inbox_settings (first-response target until the first
--                  human reply, next-response target after). Calendar time.
--
-- Sections:
--   1  inbox_settings
--   2  conversations / messages columns, indexes, status-regression guard
--   3  activity trigger (last_inbound_at / awaiting_reply_since) + backfill
--   4  conversation_events (audit + timeline system events)
--   5  assign_conversation RPC (conditional update)
--   6  conversation_collaborators
--   7  contacts: opt-in / block / owner
--   8  tags + custom fields + values metadata
--   9  contact_notes edit audit
--  10  conversation_reads / conversation_clears (per user)
--  11  inbox_views (saved views)
--  12  scheduled_messages + claim RPC
--  13  inbox query RPCs (list / counts / view counts)
--  14  realtime publication

-- ============================================================
-- 1. inbox_settings — one row per account (absent row = defaults)
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  reopen_on_inbound BOOLEAN NOT NULL DEFAULT TRUE,
  sla_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sla_first_response_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (sla_first_response_minutes BETWEEN 1 AND 10080),
  sla_next_response_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (sla_next_response_minutes BETWEEN 1 AND 10080),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  tag_selection_limit INTEGER NOT NULL DEFAULT 50
    CHECK (tag_selection_limit BETWEEN 1 AND 500),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID
);

ALTER TABLE inbox_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_settings_select ON inbox_settings;
DROP POLICY IF EXISTS inbox_settings_insert ON inbox_settings;
DROP POLICY IF EXISTS inbox_settings_update ON inbox_settings;
CREATE POLICY inbox_settings_select ON inbox_settings FOR SELECT USING (is_account_member(account_id));
CREATE POLICY inbox_settings_insert ON inbox_settings FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY inbox_settings_update ON inbox_settings FOR UPDATE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 2. conversations / messages columns
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS awaiting_reply_since TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_human_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_human_reply_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversations_account_activity
  ON conversations (account_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_account_assignee
  ON conversations (account_id, assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_account_awaiting
  ON conversations (account_id, awaiting_reply_since)
  WHERE awaiting_reply_since IS NOT NULL;

-- Idempotency key for outbound sends (UI retries, scheduled sends).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_client_id
  ON messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
-- Timeline paging / jump-to-message and the activity backfill below.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC);

-- In-conversation message search: trigram index for ILIKE. pg_trgm may
-- already live in `public` or `extensions`; resolve the opclass at runtime.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $$
DECLARE v_schema TEXT;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
  WHERE o.opcname = 'gin_trgm_ops' LIMIT 1;
  IF v_schema IS NOT NULL THEN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (content_text %I.gin_trgm_ops)',
      v_schema);
  END IF;
END $$;

-- Status ladder guard. Meta status webhooks can arrive out of order and
-- the webhook updates unconditionally; never move a message backwards
-- (read → delivered) and treat `failed` as terminal. A failure report is
-- accepted only before delivery.
CREATE OR REPLACE FUNCTION message_status_rank(p_status TEXT)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'sending' THEN 0 WHEN 'sent' THEN 1
    WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
    ELSE -1 END
$$;

CREATE OR REPLACE FUNCTION guard_message_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'failed'
     OR (NEW.status = 'failed' AND OLD.status IN ('delivered', 'read'))
     OR (NEW.status <> 'failed'
         AND message_status_rank(NEW.status) < message_status_rank(OLD.status)) THEN
    -- Keep the existing state (and its error details) untouched.
    NEW.status := OLD.status;
    NEW.error_code := OLD.error_code;
    NEW.error_title := OLD.error_title;
    NEW.error_details := OLD.error_details;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_status_guard ON messages;
CREATE TRIGGER messages_status_guard
  BEFORE UPDATE OF status ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_status_transition();

-- ============================================================
-- 3. Activity tracking: last inbound + awaiting human reply
-- ============================================================
CREATE OR REPLACE FUNCTION recompute_awaiting_reply(p_conversation_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE conversations c
  SET awaiting_reply_since = (
    SELECT MIN(m.created_at) FROM messages m
    WHERE m.conversation_id = c.id
      AND m.sender_type = 'customer'
      AND m.created_at > COALESCE((
        SELECT MAX(a.created_at) FROM messages a
        WHERE a.conversation_id = c.id
          AND a.sender_type = 'agent'
          AND a.status IN ('sent', 'delivered', 'read')
      ), '-infinity'::timestamptz)
  )
  WHERE c.id = p_conversation_id;
$$;

CREATE OR REPLACE FUNCTION track_conversation_activity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_delivered BOOLEAN := NEW.status IN ('sent', 'delivered', 'read');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sender_type = 'customer' THEN
      UPDATE conversations
      SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, '-infinity'::timestamptz), NEW.created_at),
          awaiting_reply_since = COALESCE(awaiting_reply_since, NEW.created_at)
      WHERE id = NEW.conversation_id;
    ELSIF NEW.sender_type = 'agent' AND v_delivered THEN
      UPDATE conversations
      SET awaiting_reply_since = CASE
            WHEN awaiting_reply_since IS NOT NULL AND awaiting_reply_since <= NEW.created_at
            THEN NULL ELSE awaiting_reply_since END,
          first_human_reply_at = COALESCE(first_human_reply_at, NEW.created_at),
          last_human_reply_at = GREATEST(COALESCE(last_human_reply_at, '-infinity'::timestamptz), NEW.created_at)
      WHERE id = NEW.conversation_id;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE OF status on an agent message.
  IF NEW.sender_type = 'agent' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'sending' AND v_delivered THEN
      UPDATE conversations
      SET awaiting_reply_since = CASE
            WHEN awaiting_reply_since IS NOT NULL AND awaiting_reply_since <= NEW.created_at
            THEN NULL ELSE awaiting_reply_since END,
          first_human_reply_at = COALESCE(first_human_reply_at, NEW.created_at),
          last_human_reply_at = GREATEST(COALESCE(last_human_reply_at, '-infinity'::timestamptz), NEW.created_at)
      WHERE id = NEW.conversation_id;
    ELSIF NEW.status = 'failed' THEN
      PERFORM recompute_awaiting_reply(NEW.conversation_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_track_activity ON messages;
CREATE TRIGGER messages_track_activity
  AFTER INSERT OR UPDATE OF status ON messages
  FOR EACH ROW EXECUTE FUNCTION track_conversation_activity();

-- Backfill from history (idempotent: recomputes from messages).
UPDATE conversations c SET last_inbound_at = s.last_in
FROM (SELECT conversation_id, MAX(created_at) AS last_in
      FROM messages WHERE sender_type = 'customer' GROUP BY conversation_id) s
WHERE s.conversation_id = c.id AND c.last_inbound_at IS NULL;

UPDATE conversations c
SET first_human_reply_at = s.first_out, last_human_reply_at = s.last_out
FROM (SELECT conversation_id, MIN(created_at) AS first_out, MAX(created_at) AS last_out
      FROM messages
      WHERE sender_type = 'agent' AND status IN ('sent', 'delivered', 'read')
      GROUP BY conversation_id) s
WHERE s.conversation_id = c.id AND c.first_human_reply_at IS NULL;

UPDATE conversations c
SET awaiting_reply_since = (
  SELECT MIN(m.created_at) FROM messages m
  WHERE m.conversation_id = c.id AND m.sender_type = 'customer'
    AND m.created_at > COALESCE(c.last_human_reply_at, '-infinity'::timestamptz))
WHERE c.awaiting_reply_since IS NULL AND c.last_inbound_at IS NOT NULL;

UPDATE conversations SET resolved_at = updated_at
WHERE status = 'closed' AND resolved_at IS NULL;

-- ============================================================
-- 4. conversation_events — audit trail + timeline system events
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'assigned', 'unassigned', 'status_changed',
    'collaborator_added', 'collaborator_removed',
    'contact_blocked', 'contact_unblocked'
  )),
  -- NULL actor = system (automation, flow, AI handoff, webhook).
  actor_user_id UUID,
  from_user_id UUID,
  to_user_id UUID,
  from_value TEXT,
  to_value TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation
  ON conversation_events (conversation_id, created_at);

ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_events_select ON conversation_events;
-- Read-only for members; rows are written only by SECURITY DEFINER triggers.
CREATE POLICY conversation_events_select ON conversation_events
  FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION conversations_before_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.version := OLD.version + 1;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.resolved_at := CASE WHEN NEW.status = 'closed' THEN NOW() ELSE NULL END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_version_bump ON conversations;
CREATE TRIGGER conversations_version_bump
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_before_update();

CREATE OR REPLACE FUNCTION log_conversation_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NOT NULL THEN
      INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, to_user_id)
      VALUES (NEW.account_id, NEW.id, 'assigned', v_actor, NEW.assigned_agent_id);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, from_user_id, to_user_id)
    VALUES (NEW.account_id, NEW.id,
            CASE WHEN NEW.assigned_agent_id IS NULL THEN 'unassigned' ELSE 'assigned' END,
            v_actor, OLD.assigned_agent_id, NEW.assigned_agent_id);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, 'status_changed', v_actor, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_log_change ON conversations;
CREATE TRIGGER conversations_log_change
  AFTER INSERT OR UPDATE OF assigned_agent_id, status ON conversations
  FOR EACH ROW EXECUTE FUNCTION log_conversation_change();

-- ============================================================
-- 5. assign_conversation — validated, conditional assignment
-- ============================================================
-- p_check_expected=true makes it a compare-and-set: the update only
-- applies if the current assignee still equals p_expected_assignee, so
-- two agents grabbing the same chat can't silently overwrite each other.
CREATE OR REPLACE FUNCTION assign_conversation(
  p_conversation_id UUID,
  p_assignee UUID,
  p_expected_assignee UUID DEFAULT NULL,
  p_check_expected BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account UUID;
  v_current UUID;
  v_updated INTEGER;
BEGIN
  SELECT account_id, assigned_agent_id INTO v_account, v_current
  FROM conversations WHERE id = p_conversation_id;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'agent') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = p_assignee AND p.account_id = v_account
      AND p.account_role IN ('owner', 'admin', 'agent')
  ) THEN
    RAISE EXCEPTION 'assignee is not an active agent of this account' USING ERRCODE = '22023';
  END IF;

  UPDATE conversations
  SET assigned_agent_id = p_assignee, updated_at = NOW()
  WHERE id = p_conversation_id
    AND (NOT p_check_expected OR assigned_agent_id IS NOT DISTINCT FROM p_expected_assignee);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    SELECT assigned_agent_id INTO v_current FROM conversations WHERE id = p_conversation_id;
    RETURN jsonb_build_object('ok', FALSE, 'conflict', TRUE, 'assigned_agent_id', v_current);
  END IF;
  RETURN jsonb_build_object('ok', TRUE, 'assigned_agent_id', p_assignee);
END;
$$;
REVOKE ALL ON FUNCTION assign_conversation(UUID, UUID, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_conversation(UUID, UUID, UUID, BOOLEAN) TO authenticated, service_role;

-- ============================================================
-- 6. conversation_collaborators
-- ============================================================
-- Collaborators are an accountability list (who else is following the
-- chat). Every account member can already read every conversation, so
-- adding one grants no additional visibility.
CREATE TABLE IF NOT EXISTS conversation_collaborators (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  added_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_collaborators_user
  ON conversation_collaborators (user_id);

CREATE OR REPLACE FUNCTION is_member_of(p_user UUID, p_account UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles WHERE user_id = p_user AND account_id = p_account)
$$;

ALTER TABLE conversation_collaborators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_collaborators_select ON conversation_collaborators;
DROP POLICY IF EXISTS conversation_collaborators_insert ON conversation_collaborators;
DROP POLICY IF EXISTS conversation_collaborators_delete ON conversation_collaborators;
CREATE POLICY conversation_collaborators_select ON conversation_collaborators
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY conversation_collaborators_insert ON conversation_collaborators
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND is_member_of(user_id, account_id)
    AND EXISTS (SELECT 1 FROM conversations c
                WHERE c.id = conversation_id AND c.account_id = conversation_collaborators.account_id)
  );
CREATE POLICY conversation_collaborators_delete ON conversation_collaborators
  FOR DELETE USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION log_collaborator_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, to_user_id)
    VALUES (NEW.account_id, NEW.conversation_id, 'collaborator_added', auth.uid(), NEW.user_id);
    RETURN NEW;
  END IF;
  INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, from_user_id)
  VALUES (OLD.account_id, OLD.conversation_id, 'collaborator_removed', auth.uid(), OLD.user_id);
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS conversation_collaborators_log ON conversation_collaborators;
CREATE TRIGGER conversation_collaborators_log
  AFTER INSERT OR DELETE ON conversation_collaborators
  FOR EACH ROW EXECUTE FUNCTION log_collaborator_change();

-- ============================================================
-- 7. contacts: opt-in evidence, local block, contact owner
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opt_in_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS opt_in_source TEXT,
  ADD COLUMN IF NOT EXISTS opt_in_scope TEXT,
  ADD COLUMN IF NOT EXISTS opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_in_recorded_by UUID,
  ADD COLUMN IF NOT EXISTS opt_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_by UUID,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_opt_in_status_check') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_opt_in_status_check
      CHECK (opt_in_status IN ('unknown', 'opted_in', 'opted_out'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION log_contact_block_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (NEW.blocked_at IS NULL) IS DISTINCT FROM (OLD.blocked_at IS NULL) THEN
    INSERT INTO conversation_events (account_id, conversation_id, event_type, actor_user_id, metadata)
    SELECT c.account_id, c.id,
           CASE WHEN NEW.blocked_at IS NULL THEN 'contact_unblocked' ELSE 'contact_blocked' END,
           auth.uid(),
           jsonb_build_object('reason', NEW.blocked_reason)
    FROM conversations c WHERE c.contact_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contacts_log_block ON contacts;
CREATE TRIGGER contacts_log_block
  AFTER UPDATE OF blocked_at ON contacts
  FOR EACH ROW EXECUTE FUNCTION log_contact_block_change();

-- ============================================================
-- 8. Tags / custom fields metadata
-- ============================================================
ALTER TABLE tags ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Case-insensitive unique tag names per account. Existing duplicate names
-- would make the index fail, so it is only created when none exist; the
-- setup doc explains how to merge duplicates and re-run this block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tags GROUP BY account_id, lower(btrim(name)) HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_account_name_ci
      ON tags (account_id, lower(btrim(name)));
  ELSE
    RAISE NOTICE 'idx_tags_account_name_ci skipped: duplicate tag names exist';
  END IF;
END $$;

ALTER TABLE custom_fields
  ADD COLUMN IF NOT EXISTS field_key TEXT,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_fields_account_key
  ON custom_fields (account_id, field_key) WHERE field_key IS NOT NULL;

ALTER TABLE contact_custom_values
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_by UUID;

CREATE OR REPLACE FUNCTION touch_contact_custom_value()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contact_custom_values_touch ON contact_custom_values;
CREATE TRIGGER contact_custom_values_touch
  BEFORE INSERT OR UPDATE ON contact_custom_values
  FOR EACH ROW EXECUTE FUNCTION touch_contact_custom_value();

-- ============================================================
-- 9. contact_notes: edit tracking + revision history
-- ============================================================
ALTER TABLE contact_notes
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by UUID;

CREATE TABLE IF NOT EXISTS contact_note_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edited', 'deleted')),
  previous_text TEXT NOT NULL,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_note_revisions_note ON contact_note_revisions (note_id, created_at);
ALTER TABLE contact_note_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_note_revisions_select ON contact_note_revisions;
CREATE POLICY contact_note_revisions_select ON contact_note_revisions
  FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION audit_contact_note()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.note_text IS DISTINCT FROM OLD.note_text THEN
      INSERT INTO contact_note_revisions (note_id, account_id, contact_id, action, previous_text, actor_user_id)
      VALUES (OLD.id, OLD.account_id, OLD.contact_id, 'edited', OLD.note_text, auth.uid());
      NEW.updated_at := NOW();
      NEW.updated_by := auth.uid();
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO contact_note_revisions (note_id, account_id, contact_id, action, previous_text, actor_user_id)
  VALUES (OLD.id, OLD.account_id, OLD.contact_id, 'deleted', OLD.note_text, auth.uid());
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS contact_notes_audit_update ON contact_notes;
CREATE TRIGGER contact_notes_audit_update
  BEFORE UPDATE ON contact_notes
  FOR EACH ROW EXECUTE FUNCTION audit_contact_note();
DROP TRIGGER IF EXISTS contact_notes_audit_delete ON contact_notes;
CREATE TRIGGER contact_notes_audit_delete
  AFTER DELETE ON contact_notes
  FOR EACH ROW EXECUTE FUNCTION audit_contact_note();

-- Notes: authors edit/delete their own; admins+ may moderate any.
DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE USING (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'agent') AND user_id = auth.uid())
);
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE USING (
  is_account_member(account_id, 'admin')
  OR (is_account_member(account_id, 'agent') AND user_id = auth.uid())
);

-- ============================================================
-- 10. Per-user read cursors and "clear chat" markers
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_reads_own ON conversation_reads;
CREATE POLICY conversation_reads_own ON conversation_reads
  FOR ALL USING (user_id = auth.uid() AND is_account_member(account_id))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));

-- Advance (never rewind) the caller's read cursor. The client passes the
-- created_at of the newest message it actually rendered, so an inbound
-- message racing the mark-read stays unread.
CREATE OR REPLACE FUNCTION mark_conversation_read(p_conversation_id UUID, p_read_through TIMESTAMPTZ)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_account UUID;
  v_result TIMESTAMPTZ;
BEGIN
  SELECT account_id INTO v_account FROM conversations WHERE id = p_conversation_id;
  IF v_account IS NULL OR NOT is_account_member(v_account) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  INSERT INTO conversation_reads (conversation_id, user_id, account_id, last_read_at)
  VALUES (p_conversation_id, auth.uid(), v_account, LEAST(p_read_through, NOW()))
  ON CONFLICT (conversation_id, user_id) DO UPDATE
    SET last_read_at = GREATEST(conversation_reads.last_read_at, EXCLUDED.last_read_at),
        updated_at = NOW()
  RETURNING last_read_at INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION mark_conversation_read(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_conversation_read(UUID, TIMESTAMPTZ) TO authenticated;

-- "Clear chat" = hide history before a point, for the calling user only.
-- Shared records, audit and provider data are untouched; delete the row
-- to undo.
CREATE TABLE IF NOT EXISTS conversation_clears (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cleared_before TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE conversation_clears ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_clears_own ON conversation_clears;
CREATE POLICY conversation_clears_own ON conversation_clears
  FOR ALL USING (user_id = auth.uid() AND is_account_member(account_id))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));

-- ============================================================
-- 11. inbox_views — saved views (top tab strip)
-- ============================================================
-- filters JSONB uses the same keys as inbox_query's p_filters.
-- owner_user_id NULL = shared with the whole account (admin+ to manage).
CREATE TABLE IF NOT EXISTS inbox_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id UUID,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbox_views_account ON inbox_views (account_id, position);

ALTER TABLE inbox_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbox_views_select ON inbox_views;
DROP POLICY IF EXISTS inbox_views_insert ON inbox_views;
DROP POLICY IF EXISTS inbox_views_update ON inbox_views;
DROP POLICY IF EXISTS inbox_views_delete ON inbox_views;
CREATE POLICY inbox_views_select ON inbox_views FOR SELECT USING (
  is_account_member(account_id) AND (owner_user_id IS NULL OR owner_user_id = auth.uid())
);
CREATE POLICY inbox_views_insert ON inbox_views FOR INSERT WITH CHECK (
  (owner_user_id = auth.uid() AND is_account_member(account_id))
  OR (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
);
CREATE POLICY inbox_views_update ON inbox_views FOR UPDATE USING (
  (owner_user_id = auth.uid() AND is_account_member(account_id))
  OR (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
);
CREATE POLICY inbox_views_delete ON inbox_views FOR DELETE USING (
  (owner_user_id = auth.uid() AND is_account_member(account_id))
  OR (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
);

-- ============================================================
-- 12. scheduled_messages — durable queue drained by /api/inbox/cron
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'template')),
  content_text TEXT,
  template_name TEXT,
  template_language TEXT,
  template_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  error TEXT,
  canceled_by UUID,
  canceled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scheduled_messages_content_check CHECK (
    (message_type = 'text' AND content_text IS NOT NULL AND length(btrim(content_text)) > 0)
    OR (message_type = 'template' AND template_name IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages (scheduled_for) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_conversation
  ON scheduled_messages (conversation_id, created_at DESC);

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_messages_select ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_insert ON scheduled_messages;
DROP POLICY IF EXISTS scheduled_messages_update ON scheduled_messages;
CREATE POLICY scheduled_messages_select ON scheduled_messages
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY scheduled_messages_insert ON scheduled_messages
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent') AND created_by = auth.uid() AND status = 'queued'
    AND EXISTS (SELECT 1 FROM conversations c
                WHERE c.id = conversation_id AND c.account_id = scheduled_messages.account_id
                  AND c.contact_id = scheduled_messages.contact_id)
  );
-- Members edit/cancel only while queued (the guard trigger below also
-- pins the account/conversation and blocks state changes other than cancel).
CREATE POLICY scheduled_messages_update ON scheduled_messages
  FOR UPDATE USING (
    is_account_member(account_id, 'agent') AND status = 'queued'
    AND (created_by = auth.uid() OR is_account_member(account_id, 'admin'))
  ) WITH CHECK (
    is_account_member(account_id, 'agent') AND status IN ('queued', 'canceled')
  );

CREATE OR REPLACE FUNCTION guard_scheduled_message_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  -- The worker (service role, no JWT) owns status transitions.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.account_id <> OLD.account_id OR NEW.conversation_id <> OLD.conversation_id
     OR NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'scheduled message ownership cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('queued', 'canceled') THEN
    RAISE EXCEPTION 'only the scheduler can change this state' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'canceled' THEN
    NEW.canceled_by := auth.uid();
    NEW.canceled_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scheduled_messages_guard ON scheduled_messages;
CREATE TRIGGER scheduled_messages_guard
  BEFORE UPDATE ON scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION guard_scheduled_message_update();

-- Claim due rows (and rows whose worker lease expired). SKIP LOCKED means
-- competing workers never claim the same row in the same instant; the
-- lease makes a crashed worker's rows reclaimable, and the outbound
-- idempotency key (client_message_id = 'scheduled:<id>') stops a reclaim
-- from sending twice.
CREATE OR REPLACE FUNCTION claim_scheduled_messages(
  p_worker TEXT, p_limit INTEGER DEFAULT 20, p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF scheduled_messages
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH due AS (
    SELECT id FROM scheduled_messages
    WHERE (status = 'queued' AND scheduled_for <= NOW())
       OR (status = 'processing' AND locked_until < NOW())
    ORDER BY scheduled_for
    LIMIT GREATEST(1, LEAST(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE scheduled_messages s
  SET status = 'processing', locked_by = p_worker,
      locked_until = NOW() + make_interval(secs => p_lease_seconds),
      attempts = s.attempts + 1, updated_at = NOW()
  FROM due WHERE s.id = due.id
  RETURNING s.*;
$$;
REVOKE ALL ON FUNCTION claim_scheduled_messages(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_scheduled_messages(TEXT, INTEGER, INTEGER) TO service_role;

-- ============================================================
-- 13. Inbox query RPCs — one predicate for lists, counts and views
-- ============================================================
-- p_filters keys (all optional):
--   queue      open|pending|closed|awaiting|unread|all|unassigned|sla_breached
--   scope      all|mine          (mine = assigned to the caller)
--   assignee   uuid              (team member filter)
--   tag_ids    uuid[]            (contact has ANY of them)
--   field_id / field_value       (contact custom value, case-insensitive)
--   date_from / date_to          (last activity, ISO timestamps, [from, to))
--   search     text              (name, phone, last message preview)
-- Runs as the caller (SECURITY INVOKER) so RLS scopes it exactly like a
-- plain conversations select — counts can never exceed what the list shows.
CREATE OR REPLACE FUNCTION inbox_conversation_matches(
  c conversations, f JSONB, p_uid UUID, p_last_read TIMESTAMPTZ, s inbox_settings
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT
    (CASE COALESCE(f->>'queue', 'all')
      WHEN 'open' THEN c.status = 'open'
      WHEN 'pending' THEN c.status = 'pending'
      WHEN 'closed' THEN c.status = 'closed'
      WHEN 'awaiting' THEN c.awaiting_reply_since IS NOT NULL AND c.status <> 'closed'
      WHEN 'unread' THEN c.last_inbound_at IS NOT NULL
                     AND c.last_inbound_at > COALESCE(p_last_read, '-infinity'::timestamptz)
      WHEN 'unassigned' THEN c.assigned_agent_id IS NULL AND c.status <> 'closed'
      WHEN 'sla_breached' THEN COALESCE(s.sla_enabled, FALSE)
        AND c.awaiting_reply_since IS NOT NULL AND c.status <> 'closed'
        AND c.awaiting_reply_since + make_interval(mins => CASE
              WHEN c.first_human_reply_at IS NULL THEN s.sla_first_response_minutes
              ELSE s.sla_next_response_minutes END) < NOW()
      ELSE TRUE END)
    AND (COALESCE(f->>'scope', 'all') <> 'mine' OR c.assigned_agent_id = p_uid)
    AND (NULLIF(f->>'assignee', '') IS NULL OR c.assigned_agent_id = (f->>'assignee')::uuid)
    AND (
      jsonb_typeof(f->'tag_ids') IS DISTINCT FROM 'array'
      OR jsonb_array_length(f->'tag_ids') = 0
      OR EXISTS (
        SELECT 1 FROM contact_tags ct
        WHERE ct.contact_id = c.contact_id
          AND ct.tag_id IN (SELECT (jsonb_array_elements_text(f->'tag_ids'))::uuid)
      )
    )
    AND (
      NULLIF(f->>'field_id', '') IS NULL OR NULLIF(btrim(f->>'field_value'), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM contact_custom_values v
        WHERE v.contact_id = c.contact_id
          AND v.custom_field_id = (f->>'field_id')::uuid
          AND lower(btrim(v.value)) = lower(btrim(f->>'field_value'))
      )
    )
    AND (NULLIF(f->>'date_from', '') IS NULL
         OR COALESCE(c.last_message_at, c.created_at) >= (f->>'date_from')::timestamptz)
    AND (NULLIF(f->>'date_to', '') IS NULL
         OR COALESCE(c.last_message_at, c.created_at) < (f->>'date_to')::timestamptz)
    AND (
      NULLIF(btrim(f->>'search'), '') IS NULL
      OR c.last_message_text ILIKE '%' || btrim(f->>'search') || '%'
      OR EXISTS (
        SELECT 1 FROM contacts ct
        WHERE ct.id = c.contact_id
          AND (ct.name ILIKE '%' || btrim(f->>'search') || '%'
               OR ct.phone ILIKE '%' || btrim(f->>'search') || '%')
      )
    )
$$;

-- Effective settings for the caller's account (defaults when no row).
CREATE OR REPLACE FUNCTION inbox_effective_settings(p_account UUID)
RETURNS inbox_settings LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT s FROM inbox_settings s WHERE s.account_id = p_account),
    ROW(p_account, TRUE, FALSE, 15, 30, 'Asia/Kolkata', 50, NOW(), NULL)::inbox_settings
  )
$$;

-- Keyset-paginated list. Sort keys are normalised so both orders use the
-- same ascending (k1, k2, id) cursor:
--   newest           k1 = 0,                  k2 = -epoch(last activity)
--   waiting_longest  k1 = 0 awaiting / 1 not, k2 = epoch(awaiting since) or -epoch(activity)
CREATE OR REPLACE FUNCTION inbox_query(
  p_filters JSONB DEFAULT '{}'::jsonb,
  p_sort TEXT DEFAULT 'newest',
  p_limit INTEGER DEFAULT 50,
  p_cursor_k1 INTEGER DEFAULT NULL,
  p_cursor_k2 DOUBLE PRECISION DEFAULT NULL,
  p_cursor_id UUID DEFAULT NULL
) RETURNS TABLE (
  conversation_id UUID,
  sort_k1 INTEGER,
  sort_k2 DOUBLE PRECISION,
  my_last_read_at TIMESTAMPTZ,
  my_unread_count INTEGER,
  sla_due_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT auth.uid() AS uid,
           (SELECT account_id FROM profiles WHERE user_id = auth.uid()) AS account_id
  ),
  st AS (SELECT inbox_effective_settings((SELECT account_id FROM me)) AS s),
  base AS (
    -- Keep the whole row as one composite value so the shared predicate
    -- can take it directly, independent of column order.
    SELECT c AS conv, c.id, r.last_read_at
    FROM conversations c
    LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = (SELECT uid FROM me)
    WHERE c.account_id = (SELECT account_id FROM me)
  ),
  keyed AS (
    SELECT b.conv, b.id, b.last_read_at,
      CASE WHEN p_sort = 'waiting_longest' AND (b.conv).awaiting_reply_since IS NULL THEN 1 ELSE 0 END AS k1,
      CASE
        WHEN p_sort = 'waiting_longest' AND (b.conv).awaiting_reply_since IS NOT NULL
          THEN EXTRACT(EPOCH FROM (b.conv).awaiting_reply_since)::double precision
        ELSE -EXTRACT(EPOCH FROM COALESCE((b.conv).last_message_at, (b.conv).created_at))::double precision
      END AS k2
    FROM base b
    WHERE inbox_conversation_matches(b.conv, p_filters, (SELECT uid FROM me), b.last_read_at, (SELECT s FROM st))
  )
  SELECT k.id, k.k1, k.k2, k.last_read_at,
    (SELECT COUNT(*)::int FROM messages m
     WHERE m.conversation_id = k.id AND m.sender_type = 'customer'
       AND m.created_at > COALESCE(k.last_read_at, '-infinity'::timestamptz)),
    CASE WHEN (SELECT (s).sla_enabled FROM st) AND (k.conv).awaiting_reply_since IS NOT NULL
              AND (k.conv).status <> 'closed'
      THEN (k.conv).awaiting_reply_since + make_interval(mins => CASE
        WHEN (k.conv).first_human_reply_at IS NULL THEN (SELECT (s).sla_first_response_minutes FROM st)
        ELSE (SELECT (s).sla_next_response_minutes FROM st) END)
    END
  FROM keyed k
  WHERE p_cursor_id IS NULL OR (k.k1, k.k2, k.id) > (p_cursor_k1, p_cursor_k2, p_cursor_id)
  ORDER BY k.k1, k.k2, k.id
  LIMIT GREATEST(1, LEAST(p_limit, 200))
$$;

-- Counts for every queue (under both scopes) with the non-queue filters
-- applied — the badges in the filter sidebar.
CREATE OR REPLACE FUNCTION inbox_counts(p_filters JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_account UUID;
  v_settings inbox_settings;
  v_result JSONB := '{}'::jsonb;
  v_queue TEXT;
  v_scope TEXT;
  v_count INTEGER;
  v_f JSONB;
BEGIN
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_uid;
  IF v_account IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  v_settings := inbox_effective_settings(v_account);
  FOREACH v_scope IN ARRAY ARRAY['all', 'mine'] LOOP
    FOREACH v_queue IN ARRAY ARRAY['open', 'pending', 'closed', 'awaiting', 'unread', 'all', 'unassigned', 'sla_breached'] LOOP
      IF v_scope = 'mine' AND v_queue = 'unassigned' THEN CONTINUE; END IF;
      v_f := (COALESCE(p_filters, '{}'::jsonb) - 'queue' - 'scope')
             || jsonb_build_object('queue', v_queue, 'scope', v_scope);
      SELECT COUNT(*) INTO v_count
      FROM conversations c
      LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = v_uid
      WHERE c.account_id = v_account
        AND inbox_conversation_matches(c, v_f, v_uid, r.last_read_at, v_settings);
      v_result := v_result || jsonb_build_object(v_scope || ':' || v_queue, v_count);
    END LOOP;
  END LOOP;
  RETURN v_result || jsonb_build_object('sla_enabled', v_settings.sla_enabled);
END;
$$;

-- Badge counts for the caller's saved views.
CREATE OR REPLACE FUNCTION inbox_view_counts()
RETURNS TABLE (view_id UUID, total INTEGER)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_account UUID;
  v_settings inbox_settings;
  v RECORD;
BEGIN
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_uid;
  IF v_account IS NULL THEN RETURN; END IF;
  v_settings := inbox_effective_settings(v_account);
  FOR v IN SELECT iv.id, iv.filters FROM inbox_views iv
           WHERE iv.account_id = v_account
             AND (iv.owner_user_id IS NULL OR iv.owner_user_id = v_uid)
  LOOP
    view_id := v.id;
    SELECT COUNT(*)::int INTO total
    FROM conversations c
    LEFT JOIN conversation_reads r ON r.conversation_id = c.id AND r.user_id = v_uid
    WHERE c.account_id = v_account
      AND inbox_conversation_matches(c, v.filters, v_uid, r.last_read_at, v_settings);
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION inbox_query(JSONB, TEXT, INTEGER, INTEGER, DOUBLE PRECISION, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_counts(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_view_counts() TO authenticated;

-- ============================================================
-- 14. Realtime
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_events') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE conversation_events;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                   WHERE pubname = 'supabase_realtime' AND tablename = 'scheduled_messages') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE scheduled_messages;
    END IF;
  END IF;
END $$;
