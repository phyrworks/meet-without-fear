---
title: Database Row-Level Security
sidebar_position: 2
description: Current database RLS status and requirements for future enforcement.
slug: /backend/security/rls-policies
---
# Database Row-Level Security

PostgreSQL Row-Level Security (RLS) is not part of the active runtime security
model today. Data isolation is enforced in application code with authenticated
request context, explicit Prisma filters, relationship/session membership
checks, consent checks, and stage retrieval contracts.

## On the target shape (`phoenix/target-shape`, work-k5fk.10.6, work-k5fk.10.7)

The target baseline (`backend/scripts/target-shape/trailer.sql` T7) turns RLS on for real — what
the "Future RLS Requirements" below asked for. Until it reaches `main`, the sections after this one
describe production.

- **Every table** in `public` / `app` has `ENABLE` + `FORCE ROW LEVEL SECURITY`, except Prisma's
  `_prisma_migrations` (granted to nobody). The owner `mwf_migrator` is held to the policies too
  and has none, so by default it reads no row — a default, not a control: as owner it can lift FORCE
  or `SET ROLE mwf_definer`. What holds it is `pg_hba.conf` (deploy step only) and pgaudit (every
  statement logged). Superusers bypass RLS (break-glass only).
- `diag_access` (the bot, `slam_bot_readonly`) — `diag_read`: every row, but SELECT only on id,
  status, kind, stage, count, flag and timestamp columns (T7c). No content, names, emails, keys or
  push tokens (work-k5fk.10.30).
- **Policies target capability roles** (`app_access`, `ai_access`, `worker_access`, `ops_access`,
  `mwf_definer`), never logins. Step 20 refuses a baseline where a capability holds a command on a
  table without a policy covering it, or a policy names PUBLIC / a login.
- `app_access` — the design note §6 predicates on every table (rows 9d–9g, work-k5fk.10.7), written
  `(SELECT app.current_user_id())` (an initplan): own rows (`app_own`), membership through the definer
  `app.is_member`, a partner's rows only as §6 lets a member see them (an attempt once revealed, a
  shared need while unrevoked, choices once `choices_shared`, a check-in once its shared follow-up
  completes, a review once its feedback is sent). No identity bound: no row. The goldens are the proof
  that no request moved. Where the app needs a fact of a row its caller may not see, a content-free
  definer answers (trailer.sql T4): `app.invitation_peek` / `app.invitation_answer` (the invitee before
  joining), `app.attempt_meta` (an unrevealed attempt's author and status, for its subject's share
  offer), `app.result_facts` (the author's current guidance), `app.participant_presence` /
  `app.co_participant_presence` (a co-participant's shared-frame seen instant, and activity only as
  their privacy preference allows — never their mood or read state), `app.session_parties` (the
  parties of the caller's sessions: the name the app calls each by, a tombstone flag, the MAIN
  conversation id — `"user"` and `conversation` are own-row, so no partner's email, last name,
  deletion instant or `next_seq`), `app.actor_name_for` (a push names its actor),
  `app.shares_delivered_to_me`, `app.validated_at`. No definer reads a partner's need label: each
  participant's Stage 4 transition line is written from their own request
  (`services/stage4-transition.ts`). A participant who left keeps reading but writes nothing: every
  session-scoped table carries `app_active_*` RESTRICTIVE policies on `app.is_current_member`
  (review r1 F4), and the identity-bound write definers refuse a leaver too (r2 N1). Own-row tables
  whose session link is optional (reflection, ai_memory, user_memory) stay their owner's: only a new
  link needs present membership (`t_session_link_moves`, r2 N2). `t_proposal_app_moves` holds what a proposal UPDATE may not do (re-assign its
  creator, convert it to an agreement, attribute a removal to someone else). Deviations from §6,
  each in its policy's COMMENT: `empathy_review` also shows the author a review once sent (and is
  written only once the attempt is revealed); `follow_up` shows a partner's INDIVIDUAL entry only once
  it is opted in to sharing.
- `ai_access` — `ai_session`: rows of the session in `app.session_scope` only, and only while the acting
  user (`app.current_user_id()`, bound on the AI connection too) is a participant of it
  (`app.scope_actor_is_member`); with no scope or no such actor, none. `"user"`: that session's
  participants; `brain_activity`: also the acting user's own reflection's sessionless rows, and (open
  FINDING, work-k5fk.10.33) unattributed ones.
- `worker_access` — `worker_session` (scoped) on the Stage 4 closure's tables and on the follow-ups it
  schedules; `worker_all` elsewhere (retention, due follow-ups / reminders, push tokens cross sessions).
- `ops_access` — `ops_read`: SELECT on every row of its tables, but only on column lists: exactly the columns the
  Neural Monitor's routes read, and never a ciphertext or jsonb-envelope column (work-k5fk.9, least privilege;
  `app-grants.target.test.ts` pins the lists). So never a conversation line: its grants on
  `message` and `reflection_message` leave out `content` (owner decision OD-1, work-k5fk.9), so the Neural
  Monitor counts turns and shows telemetry, with no transcript panel. `brain_activity.input` and `.output` (a
  call's input, such as a retrieval's search queries, and the model's text) are jsonb envelopes sealed by the AI's
  writer, and `ops_access` holds no grant on either; the telemetry (timings, tokens, cost, status, call type) and
  the metadata stay readable in plain columns. So `metadata` holds telemetry only (review r1, work-k5fk.9): the
  turn trace is sanitized at its writer (`types/turn-trace.ts` `sanitizeTurnTrace`: known step names, template
  results, a dispatch tag's kind, no crisis classification), and an error is stored as its class or code, never its
  message. The database holds the same line: `metadata` is the `activity_metadata_json_schema` domain, which refuses any key
  outside the `turn-trace.ts` whitelist and any value of another type (typed domains, 2026-11-23;
  `jsonb-shapes-2026-11.md` §2). The `/brain/*` responses carry
  telemetry and structure only, never text a user or the AI wrote ("close all", work-k5fk.9): an activity has no
  input or output, the prompt inspector gives tokens, cost, timing and the context window, a
  reflection's title is neither returned nor searched, and the context endpoint (`/brain/sessions/:id/context`)
  returns a `MonitorContext` per participant — stage, milestones, turn count, latest mood intensity and the memory
  intent — read on `mwf_ops` from its granted columns; it never runs the app's decrypting client or the context
  assembler (review r1 F3; `routes/__tests__/brain-auth.test.ts` pins the imports). No memory at all: `ops_access`
  has no grant or policy on `ai_memory` (the owner's follow-up, work-k5fk.9). The live audit stream
  (Ably, `ENABLE_AUDIT_STREAM`) is outside the database and carries telemetry only: `brainService.broadcastUpdate`
  drops input, output and metadata, and `broadcastMessage` drops the message text. `mwf_definer` —
  `definer_all`.
- The database's ACL: PUBLIC has no CONNECT / TEMPORARY; the active capabilities have CONNECT.
- Tests: `retire-mwf-job.target.test.ts` ("row-level security (9c)") and `job-path.target.test.ts`
  pin the scoped reads, the owner reading nothing and the dashboard's reach;
  `rls-cross-user.target.test.ts` holds one cross-user test per table (a wrong user's read or write
  fails in the database); `app-grants.target.test.ts` snapshots every policy.

## Current Status

Migration `20260430000000_remove_unenforced_rls` disables the previously created
RLS policies for:

- `InnerWorkSession`
- `InnerWorkMessage`
- `UserVessel`
- `UserMemory`
- `StageProgress`
- `EmpathyDraft`

The removed policies were created by
`20260311000000_add_row_level_security`, but they were not enforced at runtime:

- Prisma connects using the database owner role, which bypasses RLS unless every
  protected table has `FORCE ROW LEVEL SECURITY`.
- Production code did not set `app.current_user_id` before querying protected
  tables.
- No non-owner application database role was provisioned for normal runtime
  traffic.
- Several sensitive tables were never covered by the original policy set.

Keeping those policies in place gave a false impression that the database was
providing defense in depth. Removing them makes the security boundary explicit.

## Active Isolation Model

The backend relies on application-layer authorization:

- Auth middleware resolves the caller before protected routes run.
- Controllers and services scope Prisma queries with `userId`, `sessionId`, and
  relationship membership checks.
- Consent-sensitive data is read through consent records and shared-content
  state, including `consentActive` and revocation fields.
- Stage-specific access is governed by retrieval contracts and `StageProgress`
  gates before context is assembled for AI prompts.
- Admin and background jobs must keep explicit filters when reading user,
  session, relationship, vessel, message, consent, empathy, and strategy data.

Because this is the sole runtime access-control layer, missing filters in
controllers or services are security defects.

## Future RLS Requirements

RLS should only be reintroduced as an end-to-end project. A partial migration is
not sufficient. A future implementation must include:

- A non-owner application database role for normal runtime traffic.
- `FORCE ROW LEVEL SECURITY` on every protected table, with a separate owner or
  migration role for schema changes.
- Request-scoped transaction helpers that set PostgreSQL locals before every
  protected Prisma query path.
- Policies for all sensitive tables, including message, consent, empathy,
  strategy, memory, vessel, and inner-work data.
- Tests that prove cross-user reads and writes fail at the database layer, not
  only in route handlers.
- Deployment documentation for database roles, grants, connection strings, and
  admin bypass procedures.

Until all of those pieces exist, current documentation should treat RLS as
future hardening rather than an active guarantee.

## Related Documentation

- [Retrieval Contracts](../state-machine/retrieval-contracts.md) - App-layer access rules
- [Prisma Schema](../data-model/prisma-schema.md) - Data model
- [Security Architecture](./index.md) - Current security model

---

[Back to Security](./index.md) | [Back to Backend](../index.md)
