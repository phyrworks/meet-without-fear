---
title: Type review, November 2026
description: Decision log for the owner's 2026-11-10 DDL review (work-gevt). Covers every text, text[], *_type, *_kind and *_label column of the target shape, the domains, and what is left open.
updated: "2026-11-10"
---
# Type review, November 2026 (work-gevt)

This is the decision log for the owner's review pass 1 of `backend/scripts/target-shape/tables.sql`
(rules of 2026-11-10). It covers branch `phoenix/ddl-idioms`, based on `b64cd5be`.

Every `file:line` is relative to the repo root. Lines are as of `b64cd5be` and may have moved.

**Legend.** `ct` = the `ciphertext` domain. "Encrypted" means the column is in
`SENSITIVE_FIELD_MAP` (`backend/src/lib/prisma-encryption-middleware.ts:178-297`). An encrypted
column stores `enc:v1:…`, so a length CHECK or a closed type would only constrain the ciphertext;
its plaintext limits are listed for information only.

## At a glance

| Change | Columns | Commit |
|---|---|---|
| Unquoted identifiers, inline single-column keys, unnamed constraints | all | (a) style |
| `ts_ms` domain (`timestamptz(3)`) | all 143 timestamp columns | (b) |
| `COMMENT ON` | 47 tables, 49+ enums, the domains, 79 plain + 55 encrypted columns, 13 sql_ indexes | (c), (d), (f) |
| New enums | `guidance_type`, `proposal_revision_reason`, `reminder_cadence`, `wellbeing_feature` | (d) |
| `sha256_hex` domain | `message.content_hash` (was `varchar(64)`) | (d) |
| Length CHECK | `user.email <= 254` | (d) |
| Rename | `invitation.name` → `invitee_name` | (e) |
| `ciphertext` domain / `app.all_ciphertext` CHECK / comment marker | 44 text / 5 text[] / 6 jsonb encrypted columns | (f) |
| Retired | `compare-baseline-ddl.ts` | separate chore commit |

## 1. Plain (not encrypted) text and text[] columns

| Column | What it holds | Evidence | Decision | Why |
|---|---|---|---|---|
| `user.clerk_id` | Clerk user id (`user_…`); `e2e_<id>` in E2E | `backend/src/middleware/auth.ts:234`, `:116-136` | text + comment | External id; Clerk documents no bound |
| `user.email` | Clerk email, `<clerkId>@pending.clerk`, or tombstone `deleted+<id>` | `auth.ts:227,234`; `trailer.sql:430` | text + **CHECK ≤ 254** | Natural bound (RFC 5321 path limit) |
| `user.first_name`, `last_name` | Clerk names, or PATCH /auth/me | `auth.ts:234`; `controllers/auth.ts:109-141`; `shared/src/contracts/auth.ts:39-43` | text | No single bound: zod caps firstName at 50, but a lone `name` (max 100) goes into first_name, and the Clerk path is unvalidated. See Q6 |
| `user.name` | Generated first + last | `tables.sql` | text (generated) + comment | Derived in SQL already |
| `relationship_member.nickname` | Inviter's name for the other person | `controllers/invitations.ts:349,355,370,992` | text + comment | PATCH caps at 100, but createSession's `inviteName` has no max (mobile sends 50+50). See Q6 |
| `participant.display_name` | Snapshot of `user.name` at join | `invitations.ts:415,662` | text + comment | Deliberate copy (§3 below) |
| `message.content_hash` | sha256 hex of the plaintext | `backend/src/utils/content-hash.ts:23-25` | **domain `sha256_hex`** | A fixed format, not a length. NULL passes, which work-fdc1 will need |
| `milestone.key` | 13 seeded keys | `backend/scripts/target-shape/gen/maps.ts:20-34`; `shared/src/dto/milestones.ts:13-27` | text PK (lookup table) | Already a lookup table; `participant_milestone.milestone_key` is an FK to it |
| `milestone.stage_label` | UI label: "Your Story", … | `gen/maps.ts:20-34` | text + comment | Display data owned by the lookup row |
| `participant_milestone.milestone_key` | FK → `milestone.key` | `tables.sql` | kept (FK) | Already the data-driven option |
| `*_key.key_id` | KMS key (KEK) id | §4 | text + comment | No fixed format exists yet |
| `reconciler_guidance.guidance_type` | 3 code constants | `backend/src/services/reconciler/analysis.ts:325-328` | **enum `guidance_type`** | Closed set; the raw INSERT now casts |
| `proposal_revision.reason` | 4 app markers (R47) | `backend/src/services/proposal-revision-reasons.ts:18-27` | **enum `proposal_revision_reason`** | Closed set. Labels are the TS keys (`LEGACY_PROPOSED`, …), and the constants now hold those labels. The fixture's free-text reason became NULL |
| `reminder.cadence` | `ONCE \| WEEKLY \| MONTHLY \| EVERY_COUPLE_MONTHS` | `mobile/src/screens/TendingCheckinScreen.tsx:99-104`; `backend/src/services/tending.service.ts:1581-1600` | **enum `reminder_cadence`** (owner-approved Q2) | A recurrence choice, not an interval. Zod maps case, spacing and the aliases EVERY_TWO_MONTHS / BIMONTHLY. **Unknown values now get a 400**: they used to be stored and treated as one-shot |
| `feature_state.feature` | 4 features | `shared/src/dto/feature-state.ts:23` | **enum `wellbeing_feature`** | Was a CHECK IN list |
| `reflection.theme` | Free LLM text ("a single word or short phrase") | `backend/src/services/stage-prompts.ts:1944-1969` | text + comment ("not a taxonomy") | Open-ended. `v_reflection_theme` groups by the exact string, so spelling variants fragment (Q7) |
| `takeaway.theme` | Optional free LLM text | `backend/src/services/distillation.ts:210` | text + comment | Open-ended |
| `user_device.push_token` | Expo push token | `mobile/src/services/notifications.ts:64` | text + comment | Format is validated at send time (`Expo.isExpoPushToken`); no length bound |
| `brain_activity.turn_id` | Free-form correlation string, many formats | `backend/src/services/stream-turn-context.ts:354`; `backend/src/middleware/request-context.ts:31` | text + comment | Not a uuid; open format |
| `brain_activity.model` | Bedrock / embedding model ids, env-overridable | `backend/src/lib/bedrock.ts:161-171` | text + comment | Open set |

## 2. Encrypted columns (55): ciphertext, not a closed type

Per the audit, every column in the map holds ciphertext, so none can become an enum, an interval,
an FK or a length-checked column. Each one has a COMMENT starting `encrypted (<key class>):` that
says what the plaintext is.

| Kind | Columns | Typed as |
|---|---|---|
| text (44) | `session.topic_frame`; `message.content`; `draft.content`; `mood_reading.context`; `invitation.invitee_name`, `decline_reason`; `empathy_attempt.content`; `empathy_review.feedback`; `reconciler_result.alignment_summary`, `gap_summary`, `most_important_gap`, `rationale`, `suggested_share_focus`, `suggested_share_content`, `suggested_share_reason`; `reconciler_guidance.area_hint`, `prompt_seed`; `context_share_offer.offer_message`, `suggested_content`, `suggested_reason`, `shared_content`; `need.label`; `need_share.shared_text`; `need_disposition.note`; `proposal.description`, `duration`, `measure_of_success`, `removal_reason`; `proposal_choice.note`; `agreement.description`, `duration`, `measure_of_success`; `session_closure.summary`; `follow_up.summary`; `follow_up_checkin.reflection_summary`; `follow_up_note.content`; `reflection.title`, `summary`, `context_snapshot`; `reflection_message.content`; `takeaway.content`; `user_memory.content`, `suggested_text`; `reminder.note` | `ciphertext` |
| text[] (5) | `reconciler_result.correctly_identified`, `missed_feelings`, `misattributions`; `need.evidence`; `proposal.unresolved_need_labels` | text[] + `CHECK (app.all_ciphertext(col))` |
| jsonb (6) | `ai_memory.doc` (leaves); `proposal_revision.before`, `after`; `follow_up_checkin.payload`; `reflection.summary_doc`; `feature_state.doc` (envelopes) | jsonb + COMMENT marker |

The audit counted 47 / 5 / 5. The map has 44 text, 5 text[] and 6 jsonb (`proposal_revision`
has two envelope columns). `encryption-at-rest-schema.target.test.ts` checks the catalog against
the map in both directions, so the count cannot drift.

Owner-named columns that turned out to be encrypted:

| Column | Plaintext | Would a closed type fit, without encryption? |
|---|---|---|
| `proposal.unresolved_need_labels` | Need labels the AI or user gave that matched no `need_share`; fuzzy-matched, free text (`backend/src/services/stage4-store.ts:454-505`) | No: open text |
| `missed_feelings`, `misattributions`, `correctly_identified` | Free-text LLM lists (`stage-prompts.ts:2146-2240`) | No |
| `reconciler_guidance.area_hint`, `prompt_seed` | Code constants: 6 and 3 phrases (`analysis.ts:302-338`) | **Yes**: both could be enums like `guidance_type`, if R46 is reversed for them (Q4) |
| `need.label` | The need *statement* in the user's words (`backend/src/services/needs.ts:227-234`), not a taxonomy; the spec's "universal needs taxonomy" is stale | No; `need.category` is the enum |

## 3. invitation.name and other derived data

| Column | What it is | Decision |
|---|---|---|
| `invitation.name` → **`invitee_name`** | The inviter's name for the invitee: POST /sessions `inviteName`, or the member's nickname / the person's last `display_name` (`invitations.ts:274,302-325,421-428`). The invitee has no `user` row yet, so it is **not a copy of `user.name`**. Encrypted (session). Readers: `messages.ts:291,578`, `sessions.ts:510,622`, `stream-turn-context.ts:359-369` (before the join), and `stage2.ts:499-508` `reopenPartnerName` (the last fallback after `partner.displayName`; feeds GET draft's stale-opener text and the 9309 Edit-first opener) | **Kept, renamed** (Prisma `inviteeName`; the API field stays `name`), with a COMMENT |
| `participant.display_name` | Snapshot of `user.name` at join, never re-synced (PATCH /auth/me does not update it). Two creators leave it NULL (`session-state.ts:103-106`, `tending.service.ts:1514`) | Kept: deliberate, because co-participants may not read `user`, and the tombstone NULLs it. **Q5** |
| `need_share.participant_id`, `session_id` | Copies of the need's owner and session | Kept: trigger-checked (`t_need_share_owner`) |
| `need_share.category` | Copy of `need.category` at share time | Kept: the partner may not read `need`. Not trigger-checked |
| `reconciler_result.subject_participant_id` | Copy of the attempt's subject | Kept: trigger-checked (`t_result_live_attempt`) |
| `context_share_offer.subject_participant_id` | Copy of the attempt's subject | Kept. **No trigger or composite FK**; held only by writer discipline (`sharing.ts:303-310`). **Q8** |
| `reconciler_guidance.author_/subject_participant_id` | Policy copies | Kept. No trigger. **Q8** |
| `agreement.session_id` | Copy of `proposal.session_id` | Kept: `t_agreement_parties` uses it. No check. **Q8** |
| `agreement.description/duration/measure_of_success` | Snapshot of the proposal at conversion | Kept: snapshot by design |
| `invitation.invitee_name` vs `relationship_member.nickname` | Both come from `inviteName` | Kept: different lifetimes (pre-join vs per relationship) |

Nothing was clear-cut enough to remove. The debatable items are Q5 and Q8.

## 4. key_id and wrapped_dek (session_key, participant_key, user_key)

| Column | Meaning (COMMENT) | Type | Evidence |
|---|---|---|---|
| `key_id` | The id of the KMS key (the KEK) that wrapped this row's DEK: the same `<keyId>` the planned `enc:v2:<keyId>:…` prefix will carry | text, unsized | `docs/backend/data-model/phase3-security-model.md:2186-2189` says only "the KMS key id": no format (id, alias or ARN) is fixed, so a size would be invented |
| `wrapped_dek` | The AES-256 DEK, encrypted (wrapped) by that KEK; never stored unwrapped | bytea | `phase3-security-model.md:2178-2180` |
| `destroyed_at` | The crypto-shred tombstone | ts_ms | `trailer.sql:394,433` |

These tables are **unused today**: they are designed for W13, and no code writes a key row. Only
the shred half exists (the anonymize functions set `destroyed_at`). Tests write placeholder values
(`'ts12-user-key'`, `'\x00'`). `key_id` is a reference to an external KMS key, not to a row, so it
gets no FK. Once W13 fixes the format (e.g. a KMS key ARN, ≤ 2048), a domain or CHECK can follow.

## 5. Durations and intervals

| Column | Holds | Decision |
|---|---|---|
| `proposal.duration` | Free text "how long" from the AI or user ("3 days", "10 minutes, once this week": `backend/src/controllers/stage4.ts:124-134`; tool schema `backend/src/services/stage-tools.ts:103`). Nothing parses it. Encrypted | ct + COMMENT "free text, NOT a true interval". If W-something ever needs structured durations, the AI tool schema would have to emit one first |
| `agreement.duration` | Copy of `proposal.duration` at conversion (`stage4-store.ts:550-556`) | ct + same COMMENT |
| `reminder.cadence` | A recurrence choice | enum `reminder_cadence` (§1) |
| `brain_activity.duration_ms` | Call latency, integer milliseconds | **Kept integer** (owner, Q1 interim). See Q1 |

**Q1 evidence: what Prisma 7.10 does with an `interval` column** (probe against PG 18.6 with
`@prisma/adapter-pg`, 2026-11-10; the probe was thrown away after the run):

```ts
model AsString      { id Int @id  d String                    @@map("iv_string") }
model AsUnsupported { id Int @id  d Unsupported("interval")?  @@map("iv_unsupported") }

prisma.asString.findUnique({ where: { id: 1 } })
// ERROR Failed to deserialize column of type 'interval'
prisma.asString.create({ data: { id: 2, d: '2 hours' } })
// ERROR: the row IS written ('02:00:00'), but deserializing RETURNING fails
prisma.asString.update({ where: { id: 1 }, data: { d: 'P1DT2H' } })
// ERROR: row written as '1 day 02:00:00'; the read-back fails
prisma.asUnsupported.findUnique({ where: { id: 1 } })   // {"id":1}: d is not in the client at all
prisma.$queryRaw`SELECT d::text AS d FROM iv_unsupported` // [{"d":"1 mon 2 days"}]
prisma.$queryRaw`SELECT d FROM iv_unsupported`          // ERROR Failed to deserialize …
prisma.$executeRaw`UPDATE … SET d = ${'5 minutes'}::interval` // 1
// node-pg directly: {"days":3,"hours":4,"minutes":5,"seconds":6} (a PostgresInterval object)
```

So a `String` mapping writes but **cannot read**. Every read, `RETURNING` included, fails. The
only workable mapping is `Unsupported("interval")`, which removes the field from the Prisma client:
every read and write of it becomes raw SQL with `::text` / `::interval` casts. For `duration_ms`
that means about 106 references (brain routes, turn traces, the status dashboard's API data).
Integer ms is already a typed duration with its unit in the name.

## 6. Constraint and index names kept

| Name | Referenced by | Kept because |
|---|---|---|
| `chk_consent_requester` | `backend/src/services/__tests__/consent-arc.target.test.ts:154` (`toThrow(/chk_consent_requester/)`) | A test asserts the name in the error. Comment in tables.sql |
| `sql_*` (13 indexes) | `check-schema.sh` `SPEC_SQL_NAMES` / `check_sql_names` (spec §5 ⊆ file ⊆ db pull); schema.prisma comments; code comments | The gate checks them by name. Header comment in sql-only.sql |

Everything else is unnamed. The defaults for PK, FK, UNIQUE and indexes equal the old Prisma names,
so the catalog is unchanged: commit (a)'s `pg_dump` diff showed only CHECK names.

The CHECKs take PostgreSQL defaults (`<table>_<col>_check`, numbered on collision);
`uuid7_version` became `uuid7_check`.

Dropped although something mentioned them; each mention was updated:

| Name | Mention | Why not kept |
|---|---|---|
| `chk_draft_one_arc` | Code comment, `empathy-store.ts:555` | Prose only; now says "the exclusive-arc CHECK" |
| `chk_draft_reopened_empathy` | `schema-target-2026-10.md` §1.1 draft row | Prose only |
| `uuid7_version` | `schema-target-2026-10.md` §3 | Prose only |
| `chk_need_confidence`, `user_email_key`, … | `compare-baseline-ddl.ts` | Tool retired. It was a one-shot proof against 99abd51f, already failing at b64cd5be, and stays in git history; the `pg_dump --schema-only` catalog diff replaced it |

## 7. Open questions for the owner

| # | Question | Recommendation |
|---|---|---|
| Q1 | `brain_activity.duration_ms`: INTERVAL, given §5? | Keep integer ms: a String mapping cannot read an interval, and Unsupported turns every use into raw SQL |
| Q2 | Doc-only references to a constraint name: is updating the prose (as done) enough, or should a doc mention keep a name? | Prose updated; names dropped |
| Q3 | `ciphertext` refuses plaintext starting with `enc:` that is not an envelope. In keyless dev/test only, a user who types `enc:v1:a:b:c` gets a domain error, where the app with a key would encrypt it | Accept: dev/test only |
| Q4 | `reconciler_guidance.area_hint` / `prompt_seed` are code constants (6 / 3 phrases) but encrypted by R46. Un-encrypt them and make them enums? | Enum them. They carry no user content by construction |
| Q5 | `participant.display_name`: a snapshot that goes stale on a profile rename. Two creators leave it NULL, and `v_co_participant` does not fall back to `user.name` the way `v_participant` does | Decide whether a rename should propagate; fix the NULL writers |
| Q6 | Name lengths: the backend `inviteName` schema has no max (the shared contract says 100; mobile sends up to 101). firstName is 50 in zod but 100 through the lone-`name` path, and unbounded from Clerk | Align the backend zod with the shared contracts, then add `≤ 100` CHECKs on `first_name`, `last_name`, `nickname`, `display_name` |
| Q7 | `reflection.theme` is free text but grouped by exact string. A taxonomy (enum or lookup table) would need the prompt to emit one | Leave as is until the product wants themes |
| Q8 | `context_share_offer.subject_participant_id`, `reconciler_guidance.*_participant_id` and `agreement.session_id` are copies with no trigger | Add composite FKs or triggers like `t_result_live_attempt`, or drop the copies where RLS allows |
| Q9 | `need_disposition.note` has no writer | Drop it, or wire it |
| Q10 | The spec says "3-5 word" `topic_frame`; the prompt says ≤ 20 words | Spec text is stale; fixing it is a doc change |
