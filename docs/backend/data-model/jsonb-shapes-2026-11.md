---
title: jsonb documents — shapes and validation
sidebar_position: 12
description: Every jsonb column of the target shape, who writes it, its actual shape in the code, and how the database validates it (work-k5fk.8).
---
# jsonb documents — shapes and validation (work-k5fk.8, 2026-11)

The target shape (`schema-target-2026-10.md`) has **11 jsonb columns** in 7 tables. This page
records, for each one, who writes it, the shape the code actually writes (read from the writers,
not the spec), and the validation chosen. The DDL is `backend/scripts/target-shape/tables.sql`
(the "jsonb documents" block and each table) and `trailer.sql` (validator functions, trigger,
step-20 assertions).

## 1. Inventory

| Column | Writer (role) | Shape written today | Validation |
|---|---|---|---|
| `user_preferences.doc` | `services/user-settings.ts` `updatePreferences` (mwf_app: raw `INSERT … ON CONFLICT DO NOTHING` of the defaults, then a Prisma update of the merged doc) | `{ memory: MemoryPreferencesDTO, notifications: NotificationPreferencesDTO, privacy: PrivacyPreferencesDTO }` (`shared/src/dto/auth.ts`), all booleans; older rows may miss members (`withDefaults`) | typeof + `?&` keys CHECK, and **trigger `t_doc_schema`** against `user_preferences` v1 |
| `ai_memory.doc` (SUMMARY) | `conversation-summarizer.ts` `updateSessionSummary` (mwf_ai, raw upsert) | `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[], agreedFacts[], userNeeds[], partnerNeeds[], openQuestions[], agreements[], lastUnresolvedThread }` — timestamps ISO strings; the model's fields normalised first (`normalizeSummarizationResult`: a string list from a single string, non-string items dropped, a non-string `emotionalJourney` → `''`, `lastUnresolvedThread` → null; no summary text → nothing stored) | typeof + keys CHECK, and **trigger** against `ai_memory.summary` v1 (structure only: string leaves are encrypted) |
| `ai_memory.doc` (NOTABLE_FACTS) | `partner-session-classifier.ts` (mwf_ai, raw upsert) | `{ facts: [{ id, category, fact }] }` (`id` a uuidv7 from `ensureFactIds`, or the model's id — a numeric one is stringified by `normalizeResult`, an unusable one dropped) | typeof + `facts` array CHECK, and **trigger** against `ai_memory.notable_facts` v1 |
| `ai_memory.doc` (GLOBAL_FACTS) | `global-memory.ts` `consolidateGlobalFacts` (mwf_app, Prisma upsert) | `{ facts: [{ category, fact }], consolidatedAt, sessionCount }` | typeof + `facts` array CHECK, and **trigger** against `ai_memory.global_facts` v1 |
| `feature_state.doc` | `services/feature-state.ts` (mwf_app: raw empty-row INSERT, then a Prisma update) | encrypted envelope `{"$enc": "enc:v1:…"}` of the per-feature zod document (`shared/src/dto/feature-state.ts`); `{}` / the plain document when keyless | typeof CHECK + **envelope trigger** |
| `follow_up_checkin.payload` | `tending.service.ts` `insertCheckin` (mwf_app, Prisma create after `validateCheckinPayload`, zod) | envelope of `FollowUpCheckinPayload` (`entryOutcomes[]`, `needOutcomes[]`, `adjustments[]`, `partialClosures[]`, `responses[]`, `carriedNotes[]`); column DEFAULT `{}` | typeof CHECK + **envelope trigger** |
| `reflection.summary_doc` | `conversation-summarizer.ts` (inner-thoughts summary; mwf_app, Prisma update) | envelope of `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[] }` | typeof CHECK + **envelope trigger** |
| `proposal_revision.before` | `stage4-capture.service.ts` (mwf_app, Prisma create); `stage4-store.ts` conversion (mwf_worker, raw) | envelope of the proposal fields before the change, or `{ status }` at conversion; often NULL | typeof CHECK + **envelope trigger** |
| `proposal_revision.after` | `controllers/stage4.ts` (legacy agreement marks `{ <mark>: true, type, followUpDate }` / `{ <mark>: true, confirmed }`), `stage4-subchat.service.ts` (`{ description, duration, measureOfSuccess }`), `stage4-capture.service.ts` (fields + `capturedFromUserMessage`, `reasonText`), `stage4-store.ts` (`{ agreementId, status }`) | envelope of one of those | typeof CHECK + **envelope trigger** |
| `brain_activity.input`, `.output`, `.metadata`, `.structured_output` | `services/brain-service.ts` (mwf_ai, raw), from `lib/bedrock.ts` and `context-retriever.ts` call sites | per call site: input `{ operation, messageCount, systemPromptLength, streaming? }` / `{ textLength }` / retrieval queries; output `{ text, stopReason }` / `{ success }`; metadata `{ maxTokens, toolCount, … }`, `{ error }`, merged `turnTrace` | typeof CHECK only (telemetry) |

Writers in the test suites follow the same shapes (golden `tombstone` and the target tests seed
`ai_memory` and `user_preferences` rows directly; the tombstone seed's GLOBAL_FACTS fact was a bare
string — a shape no writer produces and `factsOf` drops — and is now a `{ category, fact }` object).

## 2. What validates what

- **Every column: `jsonb_typeof` CHECK** (object, or object/array for `brain_activity`). Step 20
  asserts one on every jsonb column.
- **The five `jsonb-envelope` columns** of `SENSITIVE_FIELD_MAP`: the BEFORE INSERT / UPDATE trigger
  `t_jsonb_envelope` (`app.jsonb_envelope_violation`). A document *with* a `"$enc"` key must be
  exactly `{"$enc": <a v1 ciphertext>}` — `"$enc"` the only key, a string, starting `enc:` and
  castable to the `ciphertext` domain. Plaintext in the envelope, a malformed ciphertext, a
  non-string, a plaintext key beside the envelope, and a non-object are refused. A document
  *without* `"$enc"` passes: with no `FIELD_ENCRYPTION_KEY` (keyless dev/test, and production today)
  `sealFieldValue` stores the plain document, the same leniency as the `ciphertext` domain. The
  strict form (`doc ? '$enc'` always) belongs with the strict domain, when `REQUIRE_FIELD_ENCRYPTION`
  becomes mandatory (work-k5fk.11). The plaintext inside is validated by the app (zod) before
  sealing; the database cannot see it.
  **A trigger, not a CHECK** (review L1): a CHECK refusal carries `DETAIL: Failing row contains (…)`,
  which echoes the whole row — the plaintext the rule exists to catch — to the client error and the
  server log. The trigger's message is `<table>.<column> is not a well-formed envelope: <reason>`,
  with no DETAIL. It runs before the column's `jsonb_typeof` CHECK and refuses a non-object itself,
  so that CHECK never echoes a refused document either.
  **Tightening the `ciphertext` domain (work-k5fk.11) does not revalidate existing rows**: a domain's
  CHECK runs on writes (and `ALTER DOMAIN … ADD CONSTRAINT` checks columns of the domain, not text
  inside jsonb), so the envelopes already stored need their own sweep when the strict form lands.
- **The two plaintext app documents** (`user_preferences.doc`, and `ai_memory.doc`'s structure):
  a BEFORE INSERT / UPDATE trigger `t_doc_schema` validates the document against
  `app.json_schema (name, version)`, where the version is the row's `doc_schema_version`
  (`schema_version` domain, default 1) and the name is the table, plus `.<kind>` for `ai_memory`.
  A bad document is refused with `check_violation` and a located message, e.g.
  `ai_memory.doc does not match json_schema ai_memory.notable_facts v1: $.facts[1]: missing required key fact`
  (never a value; key names, which are structure, do appear) and no DETAIL; an unknown version
  with SQLSTATE `MWJ01` (`json_schema user_preferences version 2 does not exist`).
- **SQLSTATEs** (class `MW` is this app's own): `MWJ01` an unknown `json_schema (name, version)`
  (from `app.jsonb_violation`, so from `t_doc_schema` and `app.jsonb_matches`). Not `23503`: Prisma
  reports that as P2003 "Foreign key constraint failed". A refused document is `23514`
  (`check_violation`). The other `MW` codes: `MWA0x` session archive (`app.session_archive`),
  `MWF0x` sign-in (`app.create_user`).
- **`brain_activity.*`** stays at `jsonb_typeof`: telemetry, written only by the job and read only
  by the ops dashboard, whose shape is each call site's and changes with them.

`ai_memory.doc` is leaf-encrypted: with a key every string leaf is a ciphertext, so its schemas
check keys, types, numbers and array shape, and never put an `enum` or a format on a string.

## 3. The validator (owner decision Q11: PL/pgSQL, no extension)

`pg_jsonschema` is not on the RDS extension list; `plv8` is, but it puts a JS runtime in the
database. The validator is a PL/pgSQL subset of JSON Schema:

| Keyword | Meaning |
|---|---|
| `type` | one of, or a list of: `object`, `array`, `string`, `number`, `integer` (a number with no fraction), `boolean`, `null` |
| `required` | keys an object must have |
| `properties` | key → schema, for keys present |
| `additionalProperties` | `false` (no other key), or a schema for every other key; absent means allowed |
| `enum` | the value equals one of these (jsonb equality) |
| `items` | one schema for every element of an array |
| `description`, `$comment` | annotations |

Object keywords apply only to objects and `items` only to arrays, as in JSON Schema.
`app.json_schema_wellformed` is the CHECK on `app.json_schema.schema`: a schema with any other
keyword (`minimum`, `pattern`, `$ref`, `oneOf`, tuple `items`, …) cannot be seeded, so no keyword is
ever silently ignored.

Functions (schema `app`): `jsonb_schema_violation(doc, schema)` (pure; the first violation or NULL),
`jsonb_violation(doc, name, version schema_version)` (looks the schema up; MWJ01 when unknown),
`jsonb_matches(doc, name, version schema_version)` (boolean), `json_schema_wellformed(schema)`,
`jsonb_envelope_violation(doc)`; trigger functions `t_doc_schema()` and `t_jsonb_envelope()`. A
version literal needs a cast (`app.jsonb_matches(d, 'user_preferences', 1::schema_version)`): an
integer does not convert implicitly to a smallint domain.

## 4. The schemas (version 1, seeded in tables.sql)

| Name | Required | Closed? | Notes |
|---|---|---|---|
| `user_preferences` | `memory`, `notifications`, `privacy` | yes, at both levels | every member optional and boolean |
| `ai_memory.summary` | `text`, `messageCount`, `generatedAt` | yes | `messageCount`, `tokenCount` integers; the model's fields (`keyThemes` …, `emotionalJourney`, `lastUnresolvedThread`) admit null — the summarizer now normalises them (work-k5fk.12), so v1 is kept as is rather than tightened to a v2 |
| `ai_memory.notable_facts` | `facts` | yes (a fact object stays open) | a fact needs `category`, `fact` (strings); `id` a string |
| `ai_memory.global_facts` | `facts` | yes (a fact object stays open) | `consolidatedAt` string, `sessionCount` integer |

`app.json_schema` lives in schema `app`, not `public`: the app never reads it (it validates with
zod), so it has no Prisma model and is not one of the 49 tables. It is reference data like
`milestone`: seeded by the baseline, read-only to every runtime role. **SELECT: `app_access`,
`ai_access` and `worker_access`** (the capabilities of `mwf_app`, `mwf_ai` and `mwf_worker`; work-k5fk.10.4/10.5) — the triggers run with
the writer's rights (invoker, as every T5 trigger), so the roles whose writes fire them read the
schemas; a schema restates the published `shared/` contract, so the read is harmless. `ops_access`
and `auth_access` get nothing. The validator functions' EXECUTE (`app.jsonb_violation`,
`app.jsonb_matches`, `app.jsonb_envelope_violation`) goes to the same two capabilities. **A new
writer capability (`ai_access`, `worker_access`, when design note §7 row 9b gives them writes) needs
SELECT on `app.json_schema` and EXECUTE on `app.jsonb_violation` and `app.jsonb_envelope_violation`**,
or its first write of a validated column fails with a permission error from inside the trigger. The
baseline's step 20 (trailer.sql T8, work-k5fk.10.4.1) refuses a migration in which any role may fire
`t_doc_schema` or `t_jsonb_envelope` (INSERT on the table, or UPDATE of a column the trigger names)
without those grants, so the omission fails at deploy, not at the first write.

## 5. Changing a shape

1. Seed `(name, 2)` in tables.sql (never edit a seeded row).
2. Make the writer send `doc_schema_version = 2` (on an upsert: `SET doc_schema_version = EXCLUDED.doc_schema_version` too; `mwf_app` / `mwf_ai` / `mwf_worker` need the column grant for it).
3. Rows at v1 stay valid against v1; a reader that cares reads the version.
