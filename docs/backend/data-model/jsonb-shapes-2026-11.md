---
title: jsonb documents — shapes and validation
sidebar_position: 12
description: Every jsonb column of the target shape, who writes it, its actual shape in the code, and how the database validates it (work-k5fk.8).
---
# jsonb documents — shapes and validation (work-k5fk.8, 2026-11)

The target shape (`schema-target-2026-10.md`) has **10 jsonb columns** in 7 tables (11 until work-k5fk.9 dropped `brain_activity.structured_output`, J1: no writer ever set it). This page
records, for each one, who writes it, the shape the code actually writes (read from the writers,
not the spec), and the validation chosen. The DDL is `backend/scripts/target-shape/tables.sql`
(the "jsonb documents" block — the domains and their CHECK functions — and each table) and `trailer.sql`
(the schema validator, its trigger, step-20 assertions).

## 1. Inventory

| Column | Writer (role) | Shape written today | Validation |
|---|---|---|---|
| `user_preferences.doc` | `services/user-settings.ts` `updatePreferences` (mwf_app: raw `INSERT … ON CONFLICT DO NOTHING` of the defaults, then a Prisma update of the merged doc) | `{ memory: MemoryPreferencesDTO, notifications: NotificationPreferencesDTO, privacy: PrivacyPreferencesDTO }` (`shared/src/dto/auth.ts`), all booleans; older rows may miss members (`withDefaults`) | domain `preferences_json_schema` (object with the three keys), and **trigger** against `user_preferences` v1 |
| `ai_memory.doc` (SUMMARY) | `conversation-summarizer.ts` `updateSessionSummary` (mwf_ai, raw upsert) | `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[], agreedFacts[], userNeeds[], partnerNeeds[], openQuestions[], agreements[], lastUnresolvedThread }` — timestamps ISO strings; the model's fields normalised first (`normalizeSummarizationResult`: a string list from a single string, non-string items dropped, a non-string `emotionalJourney` → `''`, `lastUnresolvedThread` → null; no summary text → nothing stored) | domain `ai_memory_json_schema` (object) + `facts` / key CHECK, and **trigger** against `ai_memory.summary` v1 |
| `ai_memory.doc` (NOTABLE_FACTS) | `partner-session-classifier.ts` (mwf_ai, raw upsert) | `{ facts: [{ id, category, fact }] }` (`id` a uuidv7 from `ensureFactIds`, or the model's id — a numeric one is stringified by `normalizeResult`, an unusable one dropped) | domain `ai_memory_json_schema` (object) + `facts` / key CHECK, and **trigger** against `ai_memory.notable_facts` v1 |
| `ai_memory.doc` (GLOBAL_FACTS) | `global-memory.ts` `consolidateGlobalFacts` (mwf_app, Prisma upsert) | `{ facts: [{ category, fact }], consolidatedAt, sessionCount }` | domain `ai_memory_json_schema` (object) + `facts` / key CHECK, and **trigger** against `ai_memory.global_facts` v1 |
| `feature_state.doc` | `services/feature-state.ts` (mwf_app: raw empty-row INSERT, then a Prisma update) | encrypted envelope `{"$enc": "enc:v1:…"}` of the per-feature zod document (`shared/src/dto/feature-state.ts`); `{}` / the plain document when keyless | domain `feature_state_json_schema` (envelope rule) |
| `follow_up_checkin.payload` | `tending.service.ts` `insertCheckin` (mwf_app, Prisma create after `validateCheckinPayload`, zod) | envelope of `FollowUpCheckinPayload` (`entryOutcomes[]`, `needOutcomes[]`, `adjustments[]`, `partialClosures[]`, `responses[]`, `carriedNotes[]`); column DEFAULT `{}` | domain `checkin_payload_json_schema` (envelope rule) |
| `reflection.summary_doc` | `conversation-summarizer.ts` (inner-thoughts summary; mwf_app, Prisma update) | envelope of `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[] }` | domain `reflection_summary_json_schema` (envelope rule) |
| `proposal_revision.before` | `stage4-capture.service.ts` (mwf_app, Prisma create); `stage4-store.ts` conversion (mwf_worker, raw) | envelope of the proposal fields before the change, or `{ status }` at conversion; often NULL | domain `proposal_snapshot_json_schema` (envelope rule) |
| `proposal_revision.after` | `controllers/stage4.ts` (legacy agreement marks `{ <mark>: true, type, followUpDate }` / `{ <mark>: true, confirmed }`), `stage4-subchat.service.ts` (`{ description, duration, measureOfSuccess }`), `stage4-capture.service.ts` (fields + `capturedFromUserMessage`, `reasonText`), `stage4-store.ts` (`{ agreementId, status }`) | envelope of one of those | domain `proposal_snapshot_json_schema` (envelope rule) |
| `brain_activity.metadata` | `services/brain-service.ts` (mwf_ai, raw), from `lib/bedrock.ts` and `context-retriever.ts` call sites | per call site: `{ maxTokens, toolCount, … }`, `{ error }`, merged `turnTrace` | domain `activity_metadata_json_schema` (the turn-trace.ts whitelist) |
| `brain_activity.input` | `brain-service.ts` `startActivity` (mwf_ai, raw, sealed with `encryptColumnValue`) | envelope of `{ operation, messageCount, systemPromptLength, streaming? }` / `{ textLength }` / a retrieval's `{ searchQueries, referencesDetected, … }` (the owner's follow-up to OD-1, work-k5fk.9) | domain `llm_call_input_json_schema` (envelope rule) |
| `brain_activity.output` | `brain-service.ts` `completeActivity` (mwf_ai, raw, sealed with `encryptColumnValue`) | envelope of `{ text, stopReason }` / `{ streaming, stopReason }` / `{ success }` / a retrieval's matches; never read on the ops path — mwf_ops holds no grant on it (owner decision OD-1, work-k5fk.9) | domain `llm_call_output_json_schema` (envelope rule) |

Writers in the test suites follow the same shapes (golden `tombstone` and the target tests seed
`ai_memory` and `user_preferences` rows directly; the tombstone seed's GLOBAL_FACTS fact was a bare
string — a shape no writer produces and `factsOf` drops — and is now a `{ category, fact }` object).

## 2. What validates what

- **Every column is typed by a domain named for its contract** (typed domains, owner 2026-11-23), never
  plain `jsonb` — step 20 refuses one, and every such domain refuses a non-object. Each `COMMENT ON
  DOMAIN` names the app contract (zod schema / TS type and file). Directly over `jsonb`: Prisma reads a
  domain over a domain as `Unsupported("<base>")` (`prisma db pull`, verified 2026-11-23), so there is no
  shared `jsonb_envelope` base domain; the shared part is the function.
- **The seven `jsonb-envelope` columns** of `SENSITIVE_FIELD_MAP` (`brain_activity.input` and `.output` since
  work-k5fk.9): one domain per contract — `feature_state_json_schema`, `checkin_payload_json_schema`, `proposal_snapshot_json_schema`
  (`proposal_revision.before` and `.after`), `reflection_summary_json_schema`, `llm_call_input_json_schema`, `llm_call_output_json_schema` —
  each with the constraint `jsonb_envelope CHECK (app.jsonb_envelope_violation(VALUE) IS NULL)`. A document
  *with* a `"$enc"` key must be
  exactly `{"$enc": <a v1 ciphertext>}` — `"$enc"` the only key, a string, starting `enc:` and
  castable to the `ciphertext` domain. Plaintext in the envelope, a malformed ciphertext, a
  non-string, a plaintext key beside the envelope, and a non-object are refused. A document
  *without* `"$enc"` passes: with no `FIELD_ENCRYPTION_KEY` (keyless dev/test, and production today)
  `sealFieldValue` stores the plain document, the same leniency as the `ciphertext` domain. The
  strict form (`doc ? '$enc'` always) belongs with the strict domain, when `REQUIRE_FIELD_ENCRYPTION`
  becomes mandatory (work-k5fk.11) — a change to the one function. The plaintext inside is validated
  by the app (zod) before sealing; the database cannot see it.
  **A domain CHECK, not a table CHECK** (review L1): a table CHECK refusal carries `DETAIL: Failing row
  contains (…)`, which echoes the whole row — the plaintext the rule exists to catch — to the client
  error and the server log. A domain CHECK refusal is `value for domain feature_state_json_schema violates check
  constraint "jsonb_envelope"` (SQLSTATE 23514) with no DETAIL: it names the contract and the rule, not
  the column or the reason (`SELECT app.jsonb_envelope_violation(doc)` gives the reason). It replaced the
  work-k5fk.8 `t_jsonb_envelope` trigger, which reported `<table>.<column> … : <reason>`.
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
  `MWE01` a second VALIDATION_FEEDBACK for the same source attempt (`app.deliver_message`; work-k5fk.10.29),
  `MWF0x` sign-in (`app.create_user`), `MWI01` an invitation claimed by someone else
  (`app.invitation_claim`, `app.invitation_answer`), `MWS01` no seat left for another human
  (the `t_human_limit` triggers on participant and invitation; work-k5fk.10.38).
- **The plaintext documents' domains** hold only what a domain can see: `preferences_json_schema` (an object with
  `memory`, `notifications`, `privacy`) and `ai_memory_json_schema` (an object). The versioned schema stays in the
  `t_doc_schema` trigger: a domain CHECK cannot see `doc_schema_version` or `kind`, and must not read a
  table (`pg_dump` restores data after the domain, in no promised order). `ai_memory`'s kind-dependent key
  CHECKs stay on the table.
- **`brain_activity.metadata`** is an `activity_metadata_json_schema`: telemetry, written only by the AI and read in plain
  by the ops dashboard, so its CHECK (`app.activity_metadata_violation`) is the DB-side mirror of the privacy
  whitelist in `types/turn-trace.ts` — the keys `maxTokens`, `toolCount`, `queryCount`,
  `cacheReadInputTokens`, `cacheWriteInputTokens` (numbers), `toolInvocations` (`[{ name }]`, a name an
  identifier), `contextSizes` (the four token counts), `turnTrace` (`sanitizeTurnTrace`'s shape: step types and
  statuses their closed sets, the model alias an identifier) and `error` (an error class, an identifier); any
  other key, a value of another type, or a non-object is refused (`activity_metadata_whitelist`). The old
  CHECK's `'array'` arm came from the legacy column and had no writer. A key added in `turn-trace.ts` must be
  added to the function too (its comment says so). `input` and `output` are envelopes (above): a retrieval's
  queries and the model's text are content (owner decision OD-1 and its follow-up).

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
`jsonb_envelope_violation(doc)` and `activity_metadata_violation(doc)` (domain CHECKs, in tables.sql); trigger
function `t_doc_schema()`. A
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
`app.jsonb_matches`) goes to the same two capabilities; `app.jsonb_envelope_violation` to `app_access`,
`worker_access` and `ai_access`, and `app.activity_metadata_violation` to `ai_access` and `worker_access`
— exactly the writers. **A domain CHECK runs with the writer's rights too, and also on an INSERT that leaves
the column to its default or NULL**, so a role that may INSERT into a table with such a column, or UPDATE
it, needs EXECUTE on the function, or its write fails with `permission denied for function …`. **A new
writer capability needs SELECT on `app.json_schema` and EXECUTE on `app.jsonb_violation`** (to fire
`t_doc_schema`) and EXECUTE on each domain CHECK's function. The baseline's step 20 (trailer.sql T8,
work-k5fk.10.4.1) refuses a migration in which any role may fire `t_doc_schema`, or write a column whose
domain CHECK calls a function (found through `pg_depend`), without those grants, so the omission fails at
deploy, not at the first write.

## 5. Changing a shape

1. Seed `(name, 2)` in tables.sql (never edit a seeded row).
2. Make the writer send `doc_schema_version = 2` (on an upsert: `SET doc_schema_version = EXCLUDED.doc_schema_version` too; `mwf_app` / `mwf_ai` / `mwf_worker` need the column grant for it).
3. Rows at v1 stay valid against v1; a reader that cares reads the version.

## 6. The one exception to the narrow-jsonb rule: `follow_up_checkin.payload`

The step-10 sweep (work-k5fk.9) applied the rule "a jsonb column is a document the database never looks
inside". Every column above keeps to it except `follow_up_checkin.payload`. The app filters and joins on
ids inside it (`tending.service.ts`: `entryOutcomes[].followUpId`, `needOutcomes`, `partialClosures`), and
a co-participant reads it. Normalising it means four to six child tables and a rewrite of the tending
service, so it stays an encrypted envelope for now (orchestrator decision OD-3, 2026-11-18). Its
normalisation is bead work-k5fk.27.
