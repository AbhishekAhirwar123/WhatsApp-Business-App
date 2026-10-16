-- Behaviour tests for 044_inbox_parity.sql. Run against a THROWAWAY
-- database that has every migration applied (see docs/WACRM_INBOX_SETUP.md
-- "Database tests"). Synthetic data only. Each check raises on failure.
\set ON_ERROR_STOP 1
SET client_min_messages = notice;

-- ── Fixtures (as superuser) ────────────────────────────────────────────
-- Account A: owner Alice (a1), agent Bob (b1). Account Z: owner Zed (z1).
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'alice@test.invalid', '{"full_name":"Alice"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'bob@test.invalid',   '{"full_name":"Bob"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'cara@test.invalid',  '{"full_name":"Cara"}'),
  ('00000000-0000-0000-0000-0000000000f1', 'zed@test.invalid',   '{"full_name":"Zed"}')
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE fx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000a1') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '00000000-0000-0000-0000-0000000000f1') AS acc_z;
GRANT SELECT ON fx TO authenticated;

-- Bob joins A as agent, Cara as viewer.
UPDATE profiles SET account_id = (SELECT acc_a FROM fx), account_role = 'agent'
WHERE user_id = '00000000-0000-0000-0000-0000000000b1';
UPDATE profiles SET account_id = (SELECT acc_a FROM fx), account_role = 'viewer'
WHERE user_id = '00000000-0000-0000-0000-0000000000c1';

INSERT INTO contacts (id, user_id, account_id, phone, name) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '+910000000001', 'Synthetic One'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '+910000000002', 'Synthetic Two'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '+910000000003', 'Synthetic Three'),
  ('10000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-0000000000f1', (SELECT acc_z FROM fx), '+910000000009', 'Other Tenant');

INSERT INTO conversations (id, user_id, account_id, contact_id, last_message_at) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000001', NOW() - interval '10 minutes'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000002', NOW() - interval '20 minutes'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '10000000-0000-0000-0000-000000000003', NOW() - interval '30 minutes'),
  ('20000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-0000000000f1', (SELECT acc_z FROM fx), '10000000-0000-0000-0000-000000000009', NOW());

-- ── 1. Inbound activity + webhook replay dedupe ────────────────────────
INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at)
VALUES ('20000000-0000-0000-0000-000000000001', 'customer', 'text', 'hello', 'wamid.IN1', 'delivered', NOW() - interval '9 minutes');
DO $$
DECLARE c conversations;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = '20000000-0000-0000-0000-000000000001';
  ASSERT c.last_inbound_at IS NOT NULL, 'inbound sets last_inbound_at';
  ASSERT c.awaiting_reply_since = c.last_inbound_at, 'inbound starts awaiting';
  BEGIN
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
    VALUES ('20000000-0000-0000-0000-000000000001', 'customer', 'text', 'hello', 'wamid.IN1', 'delivered');
    RAISE EXCEPTION 'replayed wamid must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 1 inbound activity + replay dedupe';
END $$;

-- ── 2/3. Bot does not satisfy awaiting; human send does; failure restores
INSERT INTO messages (conversation_id, sender_type, content_type, content_text, status)
VALUES ('20000000-0000-0000-0000-000000000001', 'bot', 'text', 'Thanks for reaching out!', 'sent');
DO $$
BEGIN
  ASSERT (SELECT awaiting_reply_since FROM conversations WHERE id = '20000000-0000-0000-0000-000000000001') IS NOT NULL,
    'bot acknowledgement must not clear awaiting';
END $$;

-- Pending (outbox) row does not clear it until the provider accepts.
INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, client_message_id, sender_id)
VALUES ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'agent', 'text', 'On it', 'sending',
        'ui:abc', '00000000-0000-0000-0000-0000000000b1');
DO $$
BEGIN
  ASSERT (SELECT awaiting_reply_since FROM conversations WHERE id = '20000000-0000-0000-0000-000000000001') IS NOT NULL,
    'pending send must not clear awaiting';
  BEGIN
    INSERT INTO messages (conversation_id, sender_type, content_type, content_text, status, client_message_id)
    VALUES ('20000000-0000-0000-0000-000000000001', 'agent', 'text', 'On it', 'sending', 'ui:abc');
    RAISE EXCEPTION 'duplicate client_message_id must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
UPDATE messages SET status = 'sent', message_id = 'wamid.OUT1' WHERE id = '30000000-0000-0000-0000-000000000001';
DO $$
DECLARE c conversations;
BEGIN
  SELECT * INTO c FROM conversations WHERE id = '20000000-0000-0000-0000-000000000001';
  ASSERT c.awaiting_reply_since IS NULL, 'accepted human reply clears awaiting';
  ASSERT c.first_human_reply_at IS NOT NULL, 'first human reply recorded';
END $$;

-- Status regression guard: read → delivered is ignored, failed after read ignored.
UPDATE messages SET status = 'read' WHERE id = '30000000-0000-0000-0000-000000000001';
UPDATE messages SET status = 'delivered' WHERE id = '30000000-0000-0000-0000-000000000001';
UPDATE messages SET status = 'failed', error_code = '131026' WHERE id = '30000000-0000-0000-0000-000000000001';
DO $$
BEGIN
  ASSERT (SELECT status FROM messages WHERE id = '30000000-0000-0000-0000-000000000001') = 'read', 'status never regresses';
  ASSERT (SELECT error_code FROM messages WHERE id = '30000000-0000-0000-0000-000000000001') IS NULL, 'ignored failure keeps no error';
END $$;

-- A reply that later fails restores awaiting.
INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at)
VALUES ('20000000-0000-0000-0000-000000000002', 'customer', 'text', 'price?', 'wamid.IN2', 'delivered', NOW() - interval '19 minutes');
INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, message_id, status)
VALUES ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'agent', 'text', 'Sending details', 'wamid.OUT2', 'sent');
DO $$ BEGIN
  ASSERT (SELECT awaiting_reply_since FROM conversations WHERE id = '20000000-0000-0000-0000-000000000002') IS NULL, 'sent clears';
END $$;
UPDATE messages SET status = 'failed' WHERE id = '30000000-0000-0000-0000-000000000002';
DO $$ BEGIN
  ASSERT (SELECT awaiting_reply_since FROM conversations WHERE id = '20000000-0000-0000-0000-000000000002') IS NOT NULL,
    'failed send restores awaiting';
  RAISE NOTICE 'PASS 2/3 awaiting-reply boundary (bot, pending, accepted, failed) + status ladder';
END $$;

-- ── 5. Assignment: conditional update, audit actor, membership ────────
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$
DECLARE r JSONB;
BEGIN
  r := assign_conversation('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1', NULL, TRUE);
  ASSERT (r->>'ok')::boolean, 'self-assign from unassigned succeeds';
  -- Alice saw it unassigned too; her compare-and-set must lose.
  r := assign_conversation('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', NULL, TRUE);
  ASSERT NOT (r->>'ok')::boolean AND (r->>'conflict')::boolean, 'stale assignment reports conflict';
  ASSERT (r->>'assigned_agent_id')::uuid = '00000000-0000-0000-0000-0000000000b1', 'conflict returns current assignee';
  BEGIN
    PERFORM assign_conversation('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1');
    RAISE EXCEPTION 'cross-account assignee must be rejected';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM assign_conversation('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1');
    RAISE EXCEPTION 'viewer cannot be assignee';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM assign_conversation('20000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-0000000000b1');
    RAISE EXCEPTION 'cannot assign another tenant''s conversation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  ASSERT EXISTS (SELECT 1 FROM conversation_events
                 WHERE conversation_id = '20000000-0000-0000-0000-000000000001'
                   AND event_type = 'assigned'
                   AND actor_user_id = '00000000-0000-0000-0000-0000000000b1'
                   AND to_user_id = '00000000-0000-0000-0000-0000000000b1'),
    'assignment event records actor and assignee';
  RAISE NOTICE 'PASS 5 assignment race, membership, audit';
END $$;

-- Viewer cannot assign.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
DO $$ BEGIN
  BEGIN
    PERFORM assign_conversation('20000000-0000-0000-0000-000000000002', NULL);
    RAISE EXCEPTION 'viewer must not assign';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- Collaborators: members only, event logged, tenant isolated.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
INSERT INTO conversation_collaborators (conversation_id, user_id, account_id, added_by)
VALUES ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), auth.uid());
DO $$ BEGIN
  BEGIN
    INSERT INTO conversation_collaborators (conversation_id, user_id, account_id)
    VALUES ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000f1', (SELECT acc_a FROM fx));
    RAISE EXCEPTION 'non-member collaborator must be rejected';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM conversation_collaborators
  WHERE conversation_id = '20000000-0000-0000-0000-000000000001' AND user_id = '00000000-0000-0000-0000-0000000000a1';
  ASSERT (SELECT COUNT(*) FROM conversation_events WHERE conversation_id = '20000000-0000-0000-0000-000000000001'
          AND event_type IN ('collaborator_added', 'collaborator_removed')) = 2, 'collaborator events logged';
  RAISE NOTICE 'PASS 5b collaborators';
END $$;

-- ── 4/12. Queues, counts, pagination, tenant isolation ────────────────
DO $$
DECLARE
  page1 UUID[]; page2 UUID[]; all_ids UUID[]; counts JSONB; last RECORD;
BEGIN
  SELECT array_agg(conversation_id ORDER BY sort_k1, sort_k2, conversation_id) INTO all_ids
  FROM inbox_query('{"queue":"all"}', 'newest', 50);
  ASSERT array_length(all_ids, 1) = 3, 'only own-tenant conversations listed (got ' || array_length(all_ids, 1) || ')';
  ASSERT all_ids[1] = '20000000-0000-0000-0000-000000000001', 'newest first';

  SELECT array_agg(conversation_id ORDER BY sort_k1, sort_k2, conversation_id) INTO page1
  FROM inbox_query('{"queue":"all"}', 'newest', 2);
  SELECT * INTO last FROM inbox_query('{"queue":"all"}', 'newest', 2) ORDER BY sort_k1 DESC, sort_k2 DESC, conversation_id DESC LIMIT 1;
  SELECT array_agg(conversation_id) INTO page2
  FROM inbox_query('{"queue":"all"}', 'newest', 2, last.sort_k1, last.sort_k2, last.conversation_id);
  ASSERT page1 || page2 = all_ids, 'keyset pages concatenate to the full list';

  counts := inbox_counts('{}');
  ASSERT (counts->>'all:all')::int = 3, 'all count';
  ASSERT (counts->>'all:awaiting')::int = (SELECT COUNT(*) FROM inbox_query('{"queue":"awaiting"}', 'newest', 200)), 'awaiting count = list';
  ASSERT (counts->>'mine:all')::int = 1, 'mine = Bob''s one assignment';
  ASSERT (counts->>'all:unassigned')::int = 2, 'unassigned count';
  ASSERT (counts->>'all:sla_breached')::int = 0, 'SLA disabled → no breach counts';
  ASSERT NOT EXISTS (SELECT 1 FROM inbox_query('{"queue":"all"}', 'newest', 50)
                     WHERE conversation_id = '20000000-0000-0000-0000-000000000009'),
    'other tenant never listed';
  ASSERT (SELECT COUNT(*) FROM conversations WHERE id = '20000000-0000-0000-0000-000000000009') = 0,
    'RLS hides other tenant rows';
  RAISE NOTICE 'PASS 4/12 queues, counts, keyset paging, tenant isolation';
END $$;

-- Waiting-longest puts the oldest unanswered customer first.
DO $$
DECLARE first_id UUID;
BEGIN
  SELECT conversation_id INTO first_id FROM inbox_query('{"queue":"all"}', 'waiting_longest', 1);
  ASSERT first_id = '20000000-0000-0000-0000-000000000002', 'waiting longest first';
END $$;

-- Per-user unread: Bob reads; Alice still sees it unread; cursor never rewinds.
DO $$
DECLARE t TIMESTAMPTZ;
BEGIN
  ASSERT (SELECT my_unread_count FROM inbox_query('{"queue":"unread"}', 'newest', 50)
          WHERE conversation_id = '20000000-0000-0000-0000-000000000002') = 1, 'unread before read';
  t := mark_conversation_read('20000000-0000-0000-0000-000000000002', NOW());
  ASSERT NOT EXISTS (SELECT 1 FROM inbox_query('{"queue":"unread"}', 'newest', 50)
                     WHERE conversation_id = '20000000-0000-0000-0000-000000000002'), 'read removes from Unread';
  ASSERT mark_conversation_read('20000000-0000-0000-0000-000000000002', NOW() - interval '1 day') = t, 'cursor never rewinds';
END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM inbox_query('{"queue":"unread"}', 'newest', 50)
                 WHERE conversation_id = '20000000-0000-0000-0000-000000000002'), 'other agent''s unread unaffected';
  RAISE NOTICE 'PASS per-user unread';
END $$;

-- SLA: enable with a 2-minute target → the stale awaiting chat breaches.
INSERT INTO inbox_settings (account_id, sla_enabled, sla_first_response_minutes, sla_next_response_minutes)
VALUES ((SELECT acc_a FROM fx), TRUE, 2, 2);
DO $$ BEGIN
  ASSERT (inbox_counts('{}')->>'all:sla_breached')::int = 1, 'one breached (conversation 2)';
  ASSERT (SELECT sla_due_at FROM inbox_query('{"queue":"sla_breached"}', 'newest', 5)
          WHERE conversation_id = '20000000-0000-0000-0000-000000000002') < NOW(), 'due time in the past';
  RAISE NOTICE 'PASS 11 SLA';
END $$;
-- Assigning / reading does not reset the SLA timer.
SELECT assign_conversation('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1');
SELECT mark_conversation_read('20000000-0000-0000-0000-000000000002', NOW());
DO $$ BEGIN
  ASSERT (inbox_counts('{}')->>'all:sla_breached')::int = 1, 'assign + read do not reset SLA';
END $$;

-- Tags + custom field filters compose server-side.
RESET ROLE;
INSERT INTO tags (id, user_id, account_id, name, color)
VALUES ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'Top Deals', '#22c55e');
INSERT INTO contact_tags (contact_id, tag_id) VALUES ('10000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001');
INSERT INTO custom_fields (id, user_id, account_id, field_name, field_type, field_options)
VALUES ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), 'Lead Status', 'select', '{"options":["Hot - 60 Days"]}');
INSERT INTO contact_custom_values (contact_id, custom_field_id, value)
VALUES ('10000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', 'Hot - 60 Days');
DO $$ BEGIN
  BEGIN
    INSERT INTO tags (user_id, account_id, name, color)
    VALUES ('00000000-0000-0000-0000-0000000000a1', (SELECT acc_a FROM fx), '  top deals ', '#000000');
    RAISE EXCEPTION 'case-insensitive duplicate tag must be rejected';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;
SET ROLE authenticated;
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM inbox_query('{"tag_ids":["40000000-0000-0000-0000-000000000001"]}', 'newest', 50)) = 1, 'tag filter';
  ASSERT (SELECT COUNT(*) FROM inbox_query(
    '{"field_id":"50000000-0000-0000-0000-000000000001","field_value":"hot - 60 days"}', 'newest', 50)) = 1, 'custom field filter (case-insensitive)';
  ASSERT (SELECT COUNT(*) FROM inbox_query(
    '{"tag_ids":["40000000-0000-0000-0000-000000000001"],"assignee":"00000000-0000-0000-0000-0000000000b1"}', 'newest', 50)) = 0, 'filters AND together';
  ASSERT (SELECT COUNT(*) FROM inbox_query('{"search":"synthetic two"}', 'newest', 50)) = 1, 'search by contact name';
  RAISE NOTICE 'PASS filters compose';
END $$;

-- Saved views: personal vs shared, counts match predicates.
INSERT INTO inbox_views (account_id, owner_user_id, name, filters, created_by)
VALUES ((SELECT acc_a FROM fx), auth.uid(), 'Top Deals', '{"tag_ids":["40000000-0000-0000-0000-000000000001"]}', auth.uid());
INSERT INTO inbox_views (account_id, owner_user_id, name, filters, created_by)
VALUES ((SELECT acc_a FROM fx), NULL, 'Shared: Awaiting', '{"queue":"awaiting"}', auth.uid());
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM inbox_views) = 1, 'Bob sees only the shared view';
  ASSERT (SELECT total FROM inbox_view_counts() LIMIT 1) = (SELECT COUNT(*) FROM inbox_query('{"queue":"awaiting"}', 'newest', 200)),
    'view badge = list count';
  BEGIN
    INSERT INTO inbox_views (account_id, owner_user_id, name, created_by)
    VALUES ((SELECT acc_a FROM fx), NULL, 'Agent shared', auth.uid());
    RAISE EXCEPTION 'agent must not create shared views';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS saved views';
END $$;

-- ── 10. Notes: own edits only, audited ────────────────────────────────
INSERT INTO contact_notes (id, contact_id, account_id, user_id, note_text)
VALUES ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), auth.uid(), 'Bob''s note');
UPDATE contact_notes SET note_text = 'Bob''s note (edited)' WHERE id = '60000000-0000-0000-0000-000000000001';
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
-- Alice is owner (admin+) → may moderate. Make her a plain agent first to test the restriction.
RESET ROLE;
UPDATE profiles SET account_role = 'agent' WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
SET ROLE authenticated;
DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE contact_notes SET note_text = 'hijack' WHERE id = '60000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'agents cannot edit others'' notes';
END $$;
RESET ROLE;
UPDATE profiles SET account_role = 'owner' WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
DO $$ BEGIN
  ASSERT (SELECT COUNT(*) FROM contact_note_revisions WHERE note_id = '60000000-0000-0000-0000-000000000001' AND action = 'edited') = 1,
    'edit kept previous text';
  RAISE NOTICE 'PASS 10 notes';
END $$;

-- ── 8. Scheduler: SKIP LOCKED claim, lease, guards ─────────────────────
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
INSERT INTO scheduled_messages (id, account_id, conversation_id, contact_id, created_by, message_type, content_text, scheduled_for)
VALUES ('70000000-0000-0000-0000-000000000001', (SELECT acc_a FROM fx), '20000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', auth.uid(), 'text', 'Follow-up', NOW() - interval '1 minute'),
       ('70000000-0000-0000-0000-000000000002', (SELECT acc_a FROM fx), '20000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001', auth.uid(), 'text', 'Later', NOW() + interval '1 day');
DO $$ BEGIN
  BEGIN
    UPDATE scheduled_messages SET status = 'sent' WHERE id = '70000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'members cannot mark a schedule sent';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM claim_scheduled_messages('w1', 10, 60);
    RAISE EXCEPTION 'members cannot claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
DECLARE a INTEGER; b INTEGER;
BEGIN
  SELECT COUNT(*) INTO a FROM claim_scheduled_messages('worker-a', 10, 60);
  SELECT COUNT(*) INTO b FROM claim_scheduled_messages('worker-b', 10, 60);
  ASSERT a = 1 AND b = 0, 'due row claimed exactly once (a=' || a || ', b=' || b || ')';
  -- Simulate a crashed worker: expired lease is reclaimable.
  UPDATE scheduled_messages SET locked_until = NOW() - interval '1 second' WHERE id = '70000000-0000-0000-0000-000000000001';
  SELECT COUNT(*) INTO b FROM claim_scheduled_messages('worker-b', 10, 60);
  ASSERT b = 1, 'expired lease reclaimed';
  ASSERT (SELECT attempts FROM scheduled_messages WHERE id = '70000000-0000-0000-0000-000000000001') = 2, 'attempts counted';
  RAISE NOTICE 'PASS 8 scheduler claim/lease';
END $$;
-- Cancel race: a processing row can't be canceled by a member (RLS: queued only).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE scheduled_messages SET status = 'canceled' WHERE id = '70000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'processing schedule cannot be canceled';
  UPDATE scheduled_messages SET status = 'canceled' WHERE id = '70000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 1, 'queued schedule cancels';
  ASSERT (SELECT canceled_by FROM scheduled_messages WHERE id = '70000000-0000-0000-0000-000000000002') = auth.uid(), 'canceler recorded';
  RAISE NOTICE 'PASS 8b cancel race';
END $$;

-- ── Block events + clear-chat isolation ────────────────────────────────
UPDATE contacts SET blocked_at = NOW(), blocked_by = auth.uid(), blocked_reason = 'spam'
WHERE id = '10000000-0000-0000-0000-000000000002';
INSERT INTO conversation_clears (conversation_id, user_id, account_id, cleared_before)
VALUES ('20000000-0000-0000-0000-000000000002', auth.uid(), (SELECT acc_a FROM fx), NOW());
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM conversation_events WHERE conversation_id = '20000000-0000-0000-0000-000000000002'
                 AND event_type = 'contact_blocked'), 'block logged';
  ASSERT (SELECT COUNT(*) FROM conversation_clears) = 0, 'clear chat is per user';
  ASSERT (SELECT COUNT(*) FROM messages WHERE conversation_id = '20000000-0000-0000-0000-000000000002') = 2,
    'clear chat keeps shared history';
  RAISE NOTICE 'PASS 10b block audit + per-user clear';
END $$;

RESET ROLE;
SELECT 'PASS all 044 checks' AS result;
