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
| `ai_memory.doc` (SUMMARY) | `conversation-summarizer.ts` `updateSessionSummary` (mwf_job, raw upsert) | `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[], agreedFacts[], userNeeds[], partnerNeeds[], openQuestions[], agreements[], lastUnresolvedThread }` — timestamps ISO strings; the model's fields stored unnormalised | typeof + keys CHECK, and **trigger** against `ai_memory.summary` v1 (structure only: string leaves are encrypted) |
| `ai_memory.doc` (NOTABLE_FACTS) | `partner-session-classifier.ts` (mwf_job, raw upsert) | `{ facts: [{ id, category, fact }] }` (`id` a uuidv7 from `ensureFactIds`; the legacy path spreads the model's fact object) | typeof + `facts` array CHECK, and **trigger** against `ai_memory.notable_facts` v1 |
| `ai_memory.doc` (GLOBAL_FACTS) | `global-memory.ts` `consolidateGlobalFacts` (mwf_app, Prisma upsert) | `{ facts: [{ category, fact }], consolidatedAt, sessionCount }` | typeof + `facts` array CHECK, and **trigger** against `ai_memory.global_facts` v1 |
| `feature_state.doc` | `services/feature-state.ts` (mwf_app: raw empty-row INSERT, then a Prisma update) | encrypted envelope `{"$enc": "enc:v1:…"}` of the per-feature zod document (`shared/src/dto/feature-state.ts`); `{}` / the plain document when keyless | typeof CHECK + **envelope CHECK** |
| `follow_up_checkin.payload` | `tending.service.ts` `insertCheckin` (mwf_app, Prisma create after `validateCheckinPayload`, zod) | envelope of `FollowUpCheckinPayload` (`entryOutcomes[]`, `needOutcomes[]`, `adjustments[]`, `partialClosures[]`, `responses[]`, `carriedNotes[]`); column DEFAULT `{}` | typeof CHECK + **envelope CHECK** |
| `reflection.summary_doc` | `conversation-summarizer.ts` (inner-thoughts summary; mwf_app, Prisma update) | envelope of `{ text, messageCount, oldestMessageAt, newestMessageAt, tokenCount, generatedAt, keyThemes[], emotionalJourney, unresolvedTopics[] }` | typeof CHECK + **envelope CHECK** |
| `proposal_revision.before` | `stage4-capture.service.ts` (mwf_app, Prisma create); `stage4-store.ts` conversion (mwf_job, raw) | envelope of the proposal fields before the change, or `{ status }` at conversion; often NULL | typeof CHECK + **envelope CHECK** |
| `proposal_revision.after` | `controllers/stage4.ts` (legacy agreement marks `{ <mark>: true, type, followUpDate }` / `{ <mark>: true, confirmed }`), `stage4-subchat.service.ts` (`{ description, duration, measureOfSuccess }`), `stage4-capture.service.ts` (fields + `capturedFromUserMessage`, `reasonText`), `stage4-store.ts` (`{ agreementId, status }`) | envelope of one of those | typeof CHECK + **envelope CHECK** |
| `brain_activity.input`, `.output`, `.metadata`, `.structured_output` | `services/brain-service.ts` (mwf_job, raw), from `lib/bedrock.ts` and `context-retriever.ts` call sites | per call site: input `{ operation, messageCount, systemPromptLength, streaming? }` / `{ textLength }` / retrieval queries; output `{ text, stopReason }` / `{ success }`; metadata `{ maxTokens, toolCount, … }`, `{ error }`, merged `turnTrace` | typeof CHECK only (telemetry) |

Writers in the test suites follow the same shapes (golden `tombstone` and the target tests seed
`ai_memory` and `user_preferences` rows directly; the tombstone seed's GLOBAL_FACTS fact was a bare
string — a shape no writer produces and `factsOf` drops — and is now a `{ category, fact }` object).

## 2. What validates what

- **Every column: `jsonb_typeof` CHECK** (object, or object/array for `brain_activity`). Step 20
  asserts one on every jsonb column.
- **The five `jsonb-envelope` columns** of `SENSITIVE_FIELD_MAP`: `CHECK (app.jsonb_envelope_ok(col))`.
  A document *with* a `"$enc"` key must be exactly `{"$enc": <a v1 ciphertext>}` — `"$enc"` the only
  key, a string, starting `enc:` and castable to the `ciphertext` domain. Plaintext in the envelope,
  a malformed ciphertext, a non-string, or a plaintext key beside the envelope are refused. A
  document *without* `"$enc"` passes: with no `FIELD_ENCRYPTION_KEY` (keyless dev/test, and
  production today) `sealFieldValue` stores the plain document, the same leniency as the
  `ciphertext` domain. The strict form (`doc ? '$enc'` always) belongs with the strict domain, when
  `REQUIRE_FIELD_ENCRYPTION` becomes mandatory. The plaintext inside is validated by the app (zod)
  before sealing; the database cannot see it.
- **The two plaintext app documents** (`user_preferences.doc`, and `ai_memory.doc`'s structure):
  a BEFORE INSERT / UPDATE trigger `t_doc_schema` validates the document against
  `app.json_schema (name, version)`, where the version is the row's `doc_schema_version`
  (`schema_version` domain, default 1) and the name is the table, plus `.<kind>` for `ai_memory`.
  A bad document is refused with `check_violation` and a located message, e.g.
  `ai_memory.doc does not match json_schema ai_memory.notable_facts v1: $.facts[1]: missing required key fact`
  (never a value); an unknown version with `foreign_key_violation`
  (`json_schema user_preferences version 2 does not exist`).
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
`jsonb_violation(doc, name, version)` (looks the schema up), `jsonb_matches(doc, name, version)`
(boolean), `json_schema_wellformed(schema)`, `jsonb_envelope_ok(doc)`; trigger function `t_doc_schema()`.

## 4. The schemas (version 1, seeded in tables.sql)

| Name | Required | Closed? | Notes |
|---|---|---|---|
| `user_preferences` | `memory`, `notifications`, `privacy` | yes, at both levels | every member optional and boolean |
| `ai_memory.summary` | `text`, `messageCount`, `generatedAt` | yes | `messageCount`, `tokenCount` integers; the model's fields (`keyThemes` …, `emotionalJourney`, `lastUnresolvedThread`) admit null because the summarizer stores the model's output as is |
| `ai_memory.notable_facts` | `facts` | yes (a fact object stays open) | a fact needs `category`, `fact` (strings); `id` a string |
| `ai_memory.global_facts` | `facts` | yes (a fact object stays open) | `consolidatedAt` string, `sessionCount` integer |

`app.json_schema` lives in schema `app`, not `public`: the app never reads it (it validates with
zod), so it has no Prisma model and is not one of the 49 tables. It is reference data like
`milestone`: seeded by the baseline, read-only to every runtime role. **SELECT: `mwf_app` and
`mwf_job`** — the triggers run with the writer's rights (invoker, as every T5 trigger), so the roles
whose writes fire them read the schemas; a schema restates the published `shared/` contract, so the
read is harmless. `mwf_ops` and `mwf_auth` get nothing.

## 5. Changing a shape

1. Seed `(name, 2)` in tables.sql (never edit a seeded row).
2. Make the writer send `doc_schema_version = 2` (on an upsert: `SET doc_schema_version = EXCLUDED.doc_schema_version` too; `mwf_app` / `mwf_job` need the column grant for it).
3. Rows at v1 stay valid against v1; a reader that cares reads the version.
