# WACRM inbox: setup, migration and rollout

This covers what has to happen to run the inbox work on branch
`feature/doubletick-inbox`. Nothing here has been applied to any live
Supabase project, and nothing has been deployed.

## 1. Order of operations

**The database migration has to go first.** The new code reads columns and
functions that migration 044 creates. These parts fail if the code is deployed
before the migration:

- the inbox list, counts and saved views
- sending, which now writes `sender_id` and `client_message_id`
- automations and flows, which now select `blocked_at`

Steps:

1. Back up the database. In the Supabase dashboard: Database → Backups, or use
   `pg_dump`.
2. Run migration 043 if it hasn't been run yet (it repairs doubled `+91 91`
   phone numbers).
3. Run migration 044.
4. Deploy the application code.
5. Configure the cron job (section 3).
6. Optional: as an admin, go to Settings → Inbox to turn on SLA, and Contacts →
   Custom fields → "Add suggested fields".

## 2. Database migrations

Both files are additive. They don't drop or rewrite existing columns, and the
only data they write is backfills of the new columns from existing messages.

| File | What it does |
|---|---|
| `supabase/migrations/043_fix_doubled_india_country_code.sql` | Data fix: `+91 91…` becomes `+91…` when the corrected number doesn't already exist in the account |
| `supabase/migrations/044_inbox_parity.sql` | Inbox schema, RLS, functions, triggers and backfills (see the file header) |

How to apply, using whichever fits your access:

- **Supabase CLI**, linked to the project: `supabase db push`
- **Dashboard**: SQL Editor → paste the file contents → Run. Run 043 before 044.

### 2a. Tag name uniqueness may be skipped

Migration 044 creates a case-insensitive unique index on tag names. If the
account already has duplicate names (for example `garden city` and `Garden
City`), the index is **skipped** with a NOTICE and the rest of the migration
still applies. To find duplicates:

```sql
SELECT account_id, lower(btrim(name)) AS name_key, array_agg(id) AS tag_ids
FROM tags GROUP BY 1, 2 HAVING count(*) > 1;
```

To fix them:

1. Move contacts from the extra tags onto the one you keep: `UPDATE
   contact_tags SET tag_id = '<keep>' WHERE tag_id = '<extra>'`. Delete any
   duplicate pairs that conflict first.
2. Delete the extra tags.
3. Re-run the `DO $$ … idx_tags_account_name_ci … $$` block from section 8 of
   the migration.

### 2b. Behaviour changes to be aware of

- **Notes.** Agents can now edit or delete only their own notes. Admins can
  edit or delete anyone's. Every edit and delete keeps the previous text in
  `contact_note_revisions`.
- **Message statuses.** They can no longer move backwards (for example `read`
  back to `delivered`). `failed` is final once recorded.
- **Free-form sends outside the 24-hour window** are refused by the server
  with HTTP 422 (`window_closed`). Before this they reached Meta and failed
  there. This applies to the public v1 API as well.
- **Blocked contacts.** Contacts blocked in the CRM, and template sends to
  opted-out contacts, are refused everywhere: the composer, the v1 API,
  scheduled messages, broadcasts, automations and flows.

### 2c. Rollback

- **Application.** Redeploy the previous commit. Keep migration 044 in place;
  the old code ignores the new columns and tables. One exception: the old code
  will again write `unread_count` resets, and those don't affect the new
  per-user cursors.
- **Database.** Every 044 object is new, so it can be dropped. Drop the
  triggers first: `messages_status_guard`, `messages_track_activity`,
  `conversations_version_bump`, `conversations_log_change`,
  `conversation_collaborators_log`, `contacts_log_block`,
  `contact_custom_values_touch`, `contact_notes_audit_update`,
  `contact_notes_audit_delete`, `scheduled_messages_guard`. Then the
  functions, the new tables and the new columns.
- **Restore the original note policies.** They are in migration 017, lines
  407–410.
- **Not reversible.** Migration 043's phone-number corrections. Restore those
  from the backup if needed.

## 3. Workers and cron

Scheduled messages are sent by a worker endpoint. Call it every minute:

```
GET https://<your-app>/api/inbox/cron
Header: x-cron-secret: <value of AUTOMATION_CRON_SECRET>
```

- It uses the same secret as the existing `/api/automations/cron` and
  `/api/flows/cron`. Point the same scheduler (Docker cron, an external
  pinger, or Vercel Cron) at all three.
- It's safe to call concurrently or more often than every minute: rows are
  claimed with `FOR UPDATE SKIP LOCKED` and a 120-second lease, and every send
  carries the idempotency key `scheduled:<id>`.
- If the cron isn't configured, scheduled messages stay "queued" and nothing
  is sent.

## 4. Environment variables (names only)

There are no new variables. These existing ones are used by this work:

| Name | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser client (RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | Webhook and cron workers (server only) |
| `AUTOMATION_CRON_SECRET` | Authenticating `/api/inbox/cron` |
| `ENCRYPTION_KEY` | Decrypting the stored WhatsApp access token |
| `META_APP_SECRET` | Webhook signature verification |

## 5. Provider capabilities (Meta WhatsApp Cloud API)

Checked against Meta's developer documentation on 12 October 2026. Check again
before relying on them.

- **24-hour customer service window.** Free-form messages are allowed only
  within 24 hours of the customer's last message **or call**. Outside that,
  only approved templates can be sent.
  [Service messages](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/) ·
  [Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
- **Calling.** Not integrated. It needs:
  - a Cloud API number with the `calls` webhook field
  - call settings enabled on the number
  - the messaging-limit prerequisite Meta states (business-initiated calling
    is restricted in some countries)
  - an integration project in WACRM

  [Cloud API Calling](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) ·
  [Call settings](https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/call-settings)
- **Groups.** Not integrated. Per Meta's docs this requires an **Official
  Business Account** and comes with group-size and per-number limits.
  [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) ·
  [Group messaging](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/)
- **Webhooks.** Unchanged.
  [Set up webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/)

## 6. Local development and tests

```bash
npm ci
npm run typecheck && npm run lint && npm test
```

### Database tests

These need a **throwaway** Postgres 15 or newer. The script drops and
recreates the `wacrm_test` database, so never point it at a real project.

```bash
# One-time: a scratch cluster on port 54329 (any empty directory)
initdb -D /tmp/wacrm-pg -U postgres -A trust
pg_ctl -D /tmp/wacrm-pg -o "-p 54329" start

# Apply all migrations + run the behaviour tests
PSQL=psql bash supabase/tests/run-local.sh supabase/tests/044_inbox_parity.test.sql
```

- `supabase/tests/local-supabase-stub.sql` provides minimal `auth`, `storage`
  and role stubs.
- pgvector isn't required; the runner swaps it out for the AI-knowledge
  migration only.
- The tests use synthetic data only and never call Meta.

## 7. Staging checklist (not verified in the build environment)

Automated checks pass: typecheck, lint, unit tests, SQL behaviour tests and
the production build. Nothing has been checked in a browser yet, because the
build environment has no Supabase backend. On staging, check:

1. **Inbox layout.** At 1920px, then at about 1280px, about 1024px and phone
   width:
   - the icon rail, view tabs and filter column appear (the filter column
     becomes a drawer on narrower screens)
   - the list, thread and details panel all fit with no horizontal scroll
2. **Queues.** Open, Resolved, Awaiting, Unread and Unassigned counts match the
   lists, including after loading more pages.
3. **Assignment.** Assign a chat as agent A while agent B has the same chat
   open. B's assignment should show the "just assigned by a teammate" warning,
   and the timeline should show the event.
4. **Customer window.** Send free text in an expired chat; the server should
   refuse it. A template should send.
5. **Scheduled messages.** Schedule a template 2 minutes ahead with the cron
   running. It should go to sent, show in the chat and show in the drawer.
6. **Block.** Block a contact. Composer, schedule, broadcast and automation
   sends should all be refused, and the contact's inbound messages should
   still arrive.
7. **Notes.** Agent A can't edit agent B's note. History shows edits.
8. **Search.** Search for a word in an older message, then click the result.
   The thread should load that segment and highlight the message.
