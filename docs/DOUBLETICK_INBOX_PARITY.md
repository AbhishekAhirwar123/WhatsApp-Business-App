# WACRM inbox: DoubleTick parity

Branch `feature/doubletick-inbox`. This document maps every requirement in the
implementation spec to what WACRM now does, where it lives, how it was verified,
and what still depends on something outside the codebase.

## Evidence levels

| Level | Meaning |
|---|---|
| **Observed** | Visible in the reference recording or screenshots, with its behaviour shown. |
| **Observed (UI only)** | A control or tab is visible, but what it does is not demonstrated. Behaviour here is a WACRM design decision. |
| **Extension** | Not in the reference. Required by the spec or needed to make an observed flow safe. |

The reference recording (`DoubleTick - Google Chrome 2026-10-12 17-55-20.mp4`)
was **not available** in this environment. The evidence column is based on the
spec's written timeline and the screenshots shared in the conversation. No
customer names, numbers or messages from the reference are used anywhere.

## Status key

- ✅ Done and verified by automated tests.
- ✅¹ Done, compiles and is wired up, but has not been checked in a browser
  (there is no Supabase backend in the development environment).
- ⚠️ Partial or limited. The limit is stated.
- ⛔ Not available. The reason is a provider or capability limit; the UI shows
  an honest state instead.

## Baseline (before this work)

- Stack, verified from code: Next.js 16 App Router, Supabase (Postgres + RLS +
  Realtime + Storage), Meta WhatsApp Cloud API. One WhatsApp number per
  account. Roles are owner, admin, agent and viewer, through
  `is_account_member()`. Every member can see every conversation.
- Baseline checks: `tsc` clean, 1,032 Vitest tests passing, ESLint 0 errors,
  all 43 migrations applied to a scratch Postgres 18 database, and
  `supabase/ci/verify-schema.sql` passed.
- Gaps found in the end-to-end trace:
  - The 24-hour window was enforced in the UI only.
  - Message statuses could move backwards (`read` overwritten by `delivered`).
  - Outbound sends had no idempotency key, and `messages.sender_id` was never
    written.
  - There was no audit trail for assignment or status changes.
  - Unread was a single counter shared by the whole team, reset by whoever
    opened the chat.
  - The inbox loaded every conversation into the browser and filtered there.
  - There was no scheduler with locking. Delayed automations use a
    conditional update with no lease.
  - Contacts had no opt-in, block or owner fields.
  - Tag names had no uniqueness rule.

## Requirement map

### Layout (spec §2)

| Requirement | Evidence | Implementation (files) | Gap closed | Acceptance check | Status | External dep. |
|---|---|---|---|---|---|---|
| Narrow module icon rail | Observed | `src/components/layout/sidebar.tsx`: collapses to 68px on `/inbox`, labels become tooltips | Full 240px nav on inbox | Build passes; route renders | ✅¹ | – |
| Named-view strip with count badges and management control | Observed (UI only) | `src/components/inbox/view-tabs.tsx`, table `inbox_views`, RPC `inbox_view_counts` | No saved views | SQL test "saved views" (badge = list count; agents can't create shared views) | ✅ | – |
| Filter sidebar with collapsible queue groups, scrolls on its own | Observed | `src/components/inbox/inbox-filters.tsx` | Folder list only | Build; `query.test.ts` | ✅¹ | – |
| Chat list header: search, sort, overflow, New | Observed | `src/components/inbox/conversation-list.tsx` | – | Build | ✅¹ | – |
| Conversation panel: sticky header and composer | Observed | `src/components/inbox/message-thread.tsx` | – | Build | ✅¹ | – |
| Collapsible right panel with Details / Calls / Notes; drawers replace the body without losing the chat or draft | Observed | `src/components/inbox/inbox-right-panel.tsx`, `panel-drawers.tsx`, `notes-tab.tsx` | Single read-only sidebar | Build | ✅¹ | – |
| Narrow / mobile layout | Extension | Filters open as a left sheet below 1280px; details as a right sheet below 1024px; list → thread flow | Filters and details unreachable on mobile | Build | ✅¹ (not visually checked) | – |
| Loading, empty, retryable error, disconnected and permission states | Extension | List skeleton and Retry; thread error and Retry; "Live updates paused" banner; viewer read-only composer | Partial | Build | ✅¹ | – |

**Widths (design estimates at 1920px).** Icon rail 68px, filters 272px,
list 360px, details 340px. The conversation takes the rest.

### Queues, filters, saved views (spec §3)

**State model.** These dimensions are independent of each other (migration
044 header):

| Dimension | Source | Notes |
|---|---|---|
| Lifecycle | `conversations.status`: open, pending, closed | The UI calls closed "Resolved". Inbound reopens it only when `inbox_settings.reopen_on_inbound` is on (default on, which was the previous behaviour). |
| Awaiting reply | `conversations.awaiting_reply_since` | Set by the first customer message after the last successful *agent* message. Cleared when an agent message reaches `sent`, `delivered` or `read`. Bot, flow, automation and AI messages never clear it. A pending (`sending`) row does not clear it. A send that later fails restores it. |
| Unread | `conversation_reads.last_read_at` (per user) compared with `conversations.last_inbound_at` | The cursor only moves forward. The client marks read up to the newest message it actually rendered, so a message that arrives during the mark-read stays unread. The legacy shared `unread_count` is kept for the v1 API and older screens. |
| SLA | Derived: `awaiting_reply_since` + target minutes | Off by default. Uses the first-response target until the first human reply, then the next-response target. Calendar time. |

| Requirement | Evidence | Implementation | Acceptance check | Status |
|---|---|---|---|---|
| All chats and My chats, each with Open, Resolved, Awaiting reply, Unread, All (plus Pending, a WACRM state) | Observed | `inbox_conversation_matches()` in `044_inbox_parity.sql`, using `scope` and `queue` | SQL test "queues, counts, keyset paging, tenant isolation" | ✅ |
| My chats = the signed-in user's assignment | Observed | `scope: mine` → `assigned_agent_id = auth.uid()` | SQL test (`mine:all = 1`) | ✅ |
| Unassigned queue | Observed | `queue: unassigned` | SQL test | ✅ |
| SLA breached queue, capability-gated | Observed (locked in reference) | Shows a lock and "Set up" while SLA is off, with no fabricated counts. Settings → Inbox | SQL test "SLA" (off → 0; on with 2-minute target → breach; assigning or reading doesn't reset it) | ✅ |
| Team member filter (searchable) | Observed | `MemberPicker` in `inbox-filters.tsx` → `assignee` | SQL test "filters compose" | ✅ |
| Multi-select tag filter | Observed | `TagMultiPicker` → `tag_ids` (any of) | SQL test | ✅ |
| Lead-field filter (e.g. Lead Status = Hot) | Extension | `field_id` / `field_value`, case-insensitive | SQL test | ✅ |
| Channels filter | Observed (UI only) | One WhatsApp number per account, so it shows the connected number as the only channel | – | ⚠️ Single channel |
| Date range | Observed (UI only) | **Last activity** (`last_message_at`), from the start of the from-day to the start of the day after the to-day, in the viewer's time zone | `query.test.ts` round-trip | ✅ |
| All chats / Groups switch | Observed (UI only) | Groups shown disabled with an explanation | – | ⛔ See §10 |
| Filter chips with remove and Reset | Observed | Chips row in the list and a sidebar Reset | Build | ✅¹ |
| Server-side filtering, cursor reset on filter change, counts from the same predicate | Spec | `inbox_query` (keyset k1/k2/id), `inbox_counts`, both SECURITY INVOKER under RLS | SQL test (pages concatenate to the full list; counts = list) | ✅ |
| Saved views: name, predicates, order, personal or shared | Observed (UI only) | `inbox_views` with RLS: personal is owner-only, shared needs admin+ | SQL test | ✅ |
| Filters in the URL; refresh and back restore them | Spec | `filtersToParams` / `paramsToFilters` (`q`, `scope`, `member`, `tags`, `field`, `fv`, `from`, `to`, `s`, `sort`, `view`, `c`) | `query.test.ts` | ✅ |
| Keep the selected chat when it leaves the queue, with an explanation | Spec | Blue "no longer matches …" banner; the row stays listed | Build | ✅¹ |
| Drop chats that become inaccessible | Spec | Deep-linked chats load through RLS ("isn't available to you"); a realtime DELETE closes the open chat | Build | ✅¹ |

### Chat list and conversation (spec §4)

| Requirement | Evidence | Implementation | Status |
|---|---|---|---|
| Rows: avatar, name or phone, channel badge, preview, time, unread count, lead/tag chips, delivery/failure tick, awaiting/SLA marker | Observed | `ConversationItem` in `conversation-list.tsx`; latest-message status comes from an embed (`latest_message`) | ✅¹ |
| Stable ordering and cursor pagination with infinite scroll | Spec | `inbox_query` keyset; IntersectionObserver plus a "Load more" fallback | ✅ (SQL) / ✅¹ (UI) |
| Realtime updates without duplicates | Spec | `src/app/(dashboard)/inbox/page.tsx` merges by id, never inserts a row twice, and refreshes counts debounced | ✅¹ |
| Header: identity, assignee picker, resolve/reopen, message search, overflow, details toggle | Observed | `message-thread.tsx` | ✅¹ |
| Call action in the header | Observed | Not rendered. Calling is not integrated (see Calls) | ⛔ |
| Timeline: date separators, delivery state, sender attribution, system events | Observed | `conversation_events` merged into the timeline; bubbles show the agent name or "Bot" | ✅¹ |
| Older messages load in pages; jump-to-message loads the needed segment; new inbound doesn't move the scroll | Spec | Pages of 50; jump loads from the target to the oldest loaded message; "New messages" pill when scrolled up | ✅¹ |
| Drafts per conversation and user | Spec | `message-composer.tsx` `draftKey` = `wacrm:draft:<user>:<conversation>` in localStorage | ✅¹ (this browser only) |
| New conversation: find or create a normalized contact, open the correct chat, provider eligibility respected | Observed | `new-conversation-dialog.tsx`. An existing thread opens directly; a new thread must start with an approved template; the send route find-or-creates the conversation | ✅¹ |

### Assignment and collaborators (spec §5)

| Requirement | Implementation | Acceptance check | Status |
|---|---|---|---|
| Searchable real members; assign to self, reassign, unassign | Assignee popover in the thread header. Viewers can't be assignees | SQL test (a viewer or cross-tenant assignee is rejected) | ✅ |
| Concurrent assignments handled | `assign_conversation(..., p_check_expected => true)` compare-and-set. The UI shows a "just assigned by a teammate" warning | SQL test "stale assignment reports conflict" | ✅ |
| Audit: actor, old and new assignee, time, recorded in the same transaction | Trigger `conversations_log_change` → `conversation_events` (also captures writes from automations, flows and AI handoff, with actor NULL = System) | SQL test | ✅ |
| Readable events ("X assigned conversation to self", "Conversation assigned to Y by X") | `describeEvent()` in `message-thread.tsx` | – | ✅¹ |
| Collaborators: searchable checkboxes, Cancel / Confirm, Confirm disabled when nothing changed | `CollaboratorsDialog` in `inbox-right-panel.tsx`; table `conversation_collaborators` | SQL test (non-members rejected; events logged) | ✅ |
| Assignee, contact owner and collaborators kept separate | `contacts.owner_user_id`, `conversations.assigned_agent_id`, `conversation_collaborators` | – | ✅ |
| Collaborators grant no extra visibility | Every member can already read every chat (existing model). Documented in the migration | – | ✅ |
| Removed or deactivated member | Their chats stay assigned and listed. Reassign or unassign with the picker. Their profile is gone from RLS-visible members, so it shows "a teammate" or "Former member" | – | ⚠️ No automatic reassignment |

### Details, tags, custom fields (spec §6)

| Requirement | Evidence | Implementation | Status |
|---|---|---|---|
| Customer identity and business channel labelled separately | Observed | "Contacted on" shows the connected number from `GET /api/whatsapp/config` | ✅¹ |
| Opt-in status from stored evidence | Observed | `contacts.opt_in_status / source / scope / at / recorded_by / opt_out_at`; "Record" dialog. A customer messaging you does **not** count as opt-in | ✅¹ |
| Opt-out respected in sends, schedules and broadcasts | Spec | `assertContactSendable` (templates refused); broadcast create and resume skip opted-out contacts | ✅ (`send-message.eligibility.test.ts`) |
| Tags dialog: search/create, checkboxes, colours, Apply, Manage (rename, recolour, archive/restore), limit counter | Observed | `src/components/inbox/tags-dialog.tsx`. Limit is `inbox_settings.tag_selection_limit`, default 50 to match the reference's "0/50". This is a WACRM setting, not a provider limit | ✅¹ |
| No duplicate tags (normalized name) | Spec | Unique index `(account_id, lower(btrim(name)))`. **Skipped automatically if duplicates already exist** (see setup doc) | ✅ (SQL test) |
| Custom-field definitions: label, stable key, type, options, order, required, archive | Spec | `custom-fields-manager.tsx`; new columns `field_key`, `sort_order`, `required`, `archived_at` | ✅¹ |
| Searchable single-select dropdowns; "+" picker attaches fields to Details | Observed | `CustomFieldsSection` / `SearchableSelect` in `inbox-right-panel.tsx` | ✅¹ |
| Save feedback and concurrent-edit protection | Spec | Compare-and-set on `contact_custom_values.updated_at`; shows "changed by someone else" and reloads | ✅¹ |
| Neoteric defaults (Lead Status, Lead Source, Sub-Channel) | Observed | "Add suggested fields" button, idempotent by key and name, never touches existing fields. Contact Owner is a built-in member field. Sub-Channel starts as free text because its options weren't established. `bot_trigger` is **not** created: no automation in WACRM reads such a field | ✅¹ |

### Messaging and templates (spec §7)

| Requirement | Implementation | Acceptance check | Status |
|---|---|---|---|
| Free-form sends outside the 24h window refused by the server | `sendMessageToConversation`: `window_closed` (422). Window = last inbound customer message; outbound templates never reopen it. Meta's docs also count an inbound customer *call*; WACRM records no calls, so this check can only be stricter than Meta's, never looser | `send-message.eligibility.test.ts` | ✅ |
| Closed-window banner and template workflow | Existing composer banner plus the template picker | – | ✅¹ |
| Template composer: search, language, preview (header/body/footer/buttons), variables, validation | `template-picker.tsx`: search and language filter added; variable validation already existed | – | ✅¹ |
| Duplicate-send prevention | `client_message_id` outbox: a pending row is written before the Meta call and is unique per conversation. A retry returns the original (`duplicate: true`); an in-flight or failed key returns 409 | Unit tests plus the SQL unique-index test | ✅ |
| Never show "sent" for a failed or unsubmitted message | A Meta failure marks the pending row `failed` with `error_title` | Unit test | ✅ |
| pending / accepted / sent / delivered / read / failed; replays don't regress | `messages_status_guard` trigger: ladder with `failed` terminal and accepted only before delivery | SQL test "status never regresses" | ✅ |
| Webhook replay creates no duplicate | Existing unique `(conversation_id, message_id)`, migration 037 | SQL test | ✅ |
| Uncertain provider responses | Recorded as `failed` with the provider error text. If WhatsApp did deliver, there's no wamid to reconcile; the scheduler marks interrupted sends "uncertain" instead of re-sending | Scheduler test | ⚠️ Exactly-once across the network is not guaranteed (and is not claimed) |
| Provider rules verified against current docs | The window rule, Groups API eligibility and Calling prerequisites were checked against Meta's developer docs (links in the setup doc). No new provider endpoints were added; sending still goes through the existing `meta-api.ts` | – | ✅ |

### Scheduled messages (spec §8)

The drawer and empty state are Observed. Create, edit, cancel and execute are
an **Extension**.

| Requirement | Implementation | Acceptance check | Status |
|---|---|---|---|
| Drawer with "Most recent" sort and empty state | `ScheduledMessagesDrawer` | – | ✅¹ |
| Create / edit / cancel with validation (future time, ≤90 days, template variables, time zone) | `POST /api/inbox/scheduled`, `PATCH|DELETE /api/inbox/scheduled/[id]`, `schedule-validation.ts` | `scheduler.test.ts` | ✅ |
| Durable worker, not browser timers | `GET /api/inbox/cron` (`x-cron-secret`) → `runScheduledMessagesWorker` | – | ✅ |
| Claiming with leases; competing workers don't double-send | `claim_scheduled_messages` (FOR UPDATE SKIP LOCKED + lease); completion only by the lease owner; idempotency key `scheduled:<id>` | SQL test (claimed once; expired lease reclaimed) plus unit tests (reconcile after restart, mark uncertain, stale worker can't overwrite) | ✅ |
| Re-checks at execution time: access, block, opt-out, window | Creator must still be agent+; the send core re-checks the rest | Unit tests | ✅ |
| Stale free-form schedule fails clearly, never swapped for other content | `describeSendFailure('window_closed')` | Unit test | ✅ |
| Cancel race | Cancel only matches `status = 'queued'` (RLS and the route); a claimed row returns 409 | SQL test "cancel race" | ✅ |
| Asia/Kolkata display, stored in UTC | `inbox_settings.timezone`; `timezone.ts` | `timezone.test.ts` | ✅ |
| States: queued, processing, sent, failed, canceled; delivery tracked separately | `scheduled_messages.status`; delivery is on the linked `messages` row | – | ✅ |

### Search, notes, calls (spec §9)

| Requirement | Implementation | Status |
|---|---|---|
| Message search drawer: text, template name, file name; default 3-month window (display default, not retention); paged; highlighting; jump | `MessageSearchDrawer`, `message-search.ts` (quoted, wildcard-escaped filter; highlighting rendered as text nodes). Trigram index `idx_messages_content_trgm`. Scoped to one conversation id under RLS | ✅ (helpers tested) / ✅¹ |
| Notes tab: internal, author and time, edit/delete (own, or admin), history | `notes-tab.tsx`; RLS tightened; `contact_note_revisions` trigger. Notes are never passed to any send path | ✅ (SQL test) |
| Calls tab | Honest capability state, a link to Meta's calling docs for admins, and no call data shown. Calling needs a Cloud API number with the `calls` webhook field, call settings enabled and a 2,000/day messaging limit (per Meta's docs), plus a WACRM integration. None of that exists today | ⛔ Calling not integrated |

### Conversation menu (spec §10)

| Action | Evidence | Decision and implementation | Status |
|---|---|---|---|
| Add to broadcast channel | Observed (UI only) | "Add to broadcast group": adds the contact to a tag/group, which is what WACRM broadcasts target. This is audience membership, not a sending channel and not a WhatsApp group | ✅¹ |
| Clear chat | Observed (UI only) | **Hidden for you only** (`conversation_clears`), with confirmation and Undo. Shared history, audit and provider data untouched. Full deletion stays a separate admin-only "Delete for everyone" bulk action | ✅ (SQL test) |
| Block | Observed (UI only) | **Local CRM block** (`contacts.blocked_*`): confirmation and reason, logged as an event, unblock available. Enforced in the send core, scheduler, automations, flows and broadcasts. Inbound messages are still received. Not a WhatsApp-level block | ✅ (unit and SQL tests) |
| View recent bot runs | Observed (UI only) | `BotRunsDrawer`: `flow_runs` + `flow_run_events` for the conversation or contact, `automation_logs` for the contact. Errors are sanitized. Nothing is fabricated | ✅¹ |
| Groups switch | Observed (UI only) | Disabled with an explanation. Meta's Groups API exists, but per its docs it is limited to **Official Business Accounts**. WACRM has no group integration, and this account's OBA status was not verified | ⛔ Needs OBA plus an integration project |
| Bulk actions (select chats) | Extension, not shown in the reference | Mark as done, mark read (per user), reopen, add tags/groups, assign/unassign (audited RPC), delete for everyone (admin) | ✅¹ |

### SLA and accountability (spec §11)

Off by default; admins enable it in Settings → Inbox (a 2-minute target can be
set; nothing is imposed on production).

- The first-response and next-response targets are separate.
- Only a successful agent message stops the timer. Bot messages, reads, tags
  and assignment changes do not (covered by the SQL test).
- Business hours are **not** applied. This is calendar time, stated in the UI.
- The due time is computed in SQL for both the list (`sla_due_at`) and the
  counts, so they agree.

### Data, access, realtime (spec §12)

- **Additive only.** `supabase/migrations/044_inbox_parity.sql` adds tables,
  columns, functions, triggers and indexes. The only data changes are backfills
  of the *new* columns from existing messages.
- **RLS on every new table.** List, count, search and view-count RPCs are
  SECURITY INVOKER, so they see exactly what the user's own RLS allows.
  Privileged RPCs (`assign_conversation`, `mark_conversation_read`,
  `claim_scheduled_messages`) check membership themselves. Claiming is granted
  to `service_role` only.
- **Cross-tenant access is denied.** Covered by the SQL tests: list, count and
  assignment across accounts.
- **Indexes.** Activity, assignee, awaiting, the outbound idempotency key,
  message (conversation, created_at), trigram content, due schedules, events,
  views and collaborators.
- **Realtime.** `conversation_events` and `scheduled_messages` are added to the
  publication. The inbox reconciles by id, resyncs on reconnect or when the tab
  becomes visible again, and drops subscriptions per conversation.

## Verification run

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 95 files, 1,069 tests passing (was 1,032) |
| `npx eslint .` | 0 errors (39 warnings, mostly in files that already had them) |
| `next build` (CI placeholder env) | success |
| `supabase/tests/run-local.sh supabase/tests/044_inbox_parity.test.sql` on scratch Postgres 18 | all 44 migrations applied, `verify-schema` passed, 14 behaviour groups passed |
| Browser / visual check | **Not done.** No Supabase backend or credentials in this environment, so authenticated pages can't load. Needs a staging pass (see the setup doc checklist) |

## Spec validation list (§13): coverage

| # | Flow | Covered by |
|---|---|---|
| 1 | Inbound creates or updates one conversation; replay creates nothing | SQL test 1; existing webhook route tests |
| 2 | Closed chat plus inbound follows the reopen policy; unread, open and awaiting stay distinct | `reopen.test.ts` (policy); SQL tests (independent dimensions) |
| 3 | Human reply clears awaiting only on successful send; bot and failed don't | SQL test 2/3 |
| 4 | Queues, filters, saved-view badges agree across pages | SQL tests 4/12, "filters compose", "saved views" |
| 5 | Assignment race and audit; collaborator removal | SQL tests 5, 5b |
| 6 | Tags and fields persist, permissions, no duplicates | SQL tag-uniqueness test; RLS (admin+ for tags and fields). UI save paths not browser-tested |
| 7 | Free-form outside window rejected; templates allowed; retried sends reconcile | `send-message.eligibility.test.ts` |
| 8 | Scheduled send survives restart; competing workers; cancel race; expired eligibility | SQL tests 8, 8b; `scheduler.test.ts` |
| 9 | Search finds text, template and file; restricted users can't search other tenants | `message-search.test.ts`; RLS. **No live database search test** |
| 10 | Notes internal; block enforced in UI and workers; clear chat keeps shared records | SQL tests 10, 10b; unit tests |
| 11 | SLA rules | SQL test 11 |
| 12 | Cross-tenant list, count and search denied | SQL test 4/12 |
| 13 | Desktop and mobile layouts | **Not verified visually** |
