---
title: Phase 3 — Database Object Catalogue (proposed)
sidebar_position: 6
description: Every database object the Phase 3 security model creates or changes — roles, grants, functions, policies, triggers, constraints — each with the test that proves it works.
created: 2026-08-18
status: proposal
---

# Phase 3 — Database Object Catalogue

The inventory companion to [Phase 3 — Database Security Model](./phase3-security-model.md). That
document carries the argument; this one carries the objects. **Nothing here is applied.**

Every object has a **Verified by** column. An unverifiable policy is a claim, and a claim is not a
security control.

## Evidence markers

Same convention as the design document, and it matters just as much here.

| Marker | Meaning |
|---|---|
| **[V]** | Executed against the throwaway PG16 database `phase3_design_93198` with a real non-superuser role. The exact mechanism was observed working. |
| **[V18]** | Executed against the local PostgreSQL 18.4 container — the production target. |
| **[C]** | Confirmed by reading repository code or introspecting the live schema. |
| **[R]** | Reasoned. **Not executed.** Must be tested before it is built. |

The scratch database modelled `User`, `Relationship`, `RelationshipMember`, `Session` and
`Message` only. A **[V]** on a mechanism (grants bind, triggers fire, policies compose) transfers
to the other 65 tables. A **[V]** on a *predicate* does not — each table's policy needs its own
test.

---

## 1. Tables — RLS status

**71 tables** — 68 today plus the three this design adds: `ReconcilerGuidance` (D8a, W9) and the
envelope-key tables `UserKey` / `SessionKey` (D5, W13). `ENABLE` + `FORCE` on **69**, deliberately
none on **2** (`Need`, `GlobalLibraryItem`); `_prisma_migrations` is outside the 71 and is
`mwf_migrator`-only. A table
with RLS enabled and **no** policy returns zero rows to the app role — deny by default, which is
why enabling everywhere before writing every policy is safe [R].

*(Draft 6 said "`FORCE` on 65, none on 3", counting `_prisma_migrations` inside the total and
`BrainActivity` outside `FORCE`. Both were wrong against §1.3's own query and against §9. The
arithmetic is now: 71 in the inventory, 69 `FORCE`d, 2 exempt, `BrainActivity` inside the 69 with
zero policies and all grants revoked.)*

`FORCE` is on every RLS table without exception. **[V]** Without it a non-superuser owner sees all
rows (5 of 5); with it, zero. `FORCE` is what stops the migration role from silently being the
hole.

### 1.1 Tables deliberately without RLS

| Table | Why | Instead |
|---|---|---|
| `Need` | Global need taxonomy (19 rows, seeded by migration). No user dimension. | `GRANT SELECT` to `mwf_app`; **no `INSERT`/`UPDATE`/`DELETE`** — it is a reference table and the app has no business writing it. |
| `GlobalLibraryItem` | Global suggestion library. No inbound or outbound FKs by design [C]. | `GRANT SELECT` only. |
| `BrainActivity` | **The interesting one.** Holds full LLM prompts — `input`/`output` — and is the most sensitive table in the schema [C, `work-kpkq.8`]. It has *no owning user column* and is written from `bedrock.ts:660`, `ai-orchestrator.ts:234` and `context-retriever.ts:632`, all with `.catch(() => {})` and no identity [C]. | **`REVOKE ALL FROM mwf_app`.** A policy would have to be permissive enough to be useless. `mwf_job` writes it; `mwf_ops` reads it. This is strictly stronger than any policy available. |
| `_prisma_migrations` | Prisma's own bookkeeping. Outside the 71-table inventory (§1.3 excludes it). | `mwf_migrator` only; revoked from `mwf_app`. |

**Verified by:** structural assertion 2 (§7) lists every `public` table lacking
`relrowsecurity AND relforcerowsecurity` and must return exactly these four names.

### 1.2 Policy shape per table — derived, and it closes at 71

The first draft hand-maintained this table. It counted to 73, disagreed with §4 of the design
document (which counted 71), contained an internal 13-vs-14 mismatch, and **omitted
`Relationship` entirely** — the root of every membership check in the design. Review caught all
four.

The classification below is **generated** by the query in §1.3 and verified to sum to 68 [V]; the
three tables this design adds — `ReconcilerGuidance` at W9, `UserKey` and `SessionKey` at W13 — take
it to **71** and are marked **[R]**, since none of them exists yet.

| Shape | n | Tables | `USING` template |
|---|---|---|---|
| **A** — `userId`, no `sessionId` | 20 | `GratitudeEntry`, `GratitudePreferences`, `InnerWorkSession`, `Insight`, `MeditationFavorite`, `MeditationPreferences`, `MeditationSession`, `MeditationStats`, `NeedScore`, `NeedsAssessmentState`, `Person`, `PersonMention`, `PreSessionMessage`, `ReconcilerShareOffer`, `RecurringTheme`, `RelationshipMember`, `SavedMeditation`, `TendingEntryOutcome`, `TendingResponse`, `UserKey`§ | `"userId" = app.current_user_id()` |
| **B** — `userId` **and** `sessionId` | 16 | `ConsentRecord`*, `EmotionalExerciseCompletion`, `EmpathyDraft`, `EmpathyValidation`, `Stage4NeedDeclination`, `Stage4ProposalSelection`, `Stage4SubChat`, `StageProgress`, `StrategyRanking`, `TendingAdjustment`, `TendingBetweenPeriodNote`, `TendingCheckin`, `TendingReminder`, `UserMemory`, `UserVessel`, `ValidationFeedbackDraft` | `"userId" = app.current_user_id()` — the session join adds nothing and costs a subquery |
| **C** — `sessionId`, no `userId` | 17 | `BrainActivity`†, `EmpathyAttempt`*, `InnerWorkMessage`‡, `Invitation`*, `Message`*, `ReconcilerResult`*, `RefinementAttemptCounter`, `SessionKey`§, `SessionTakeaway`‡, `SharedVessel`, `Stage4Closure`, `Stage4NeedCoverage`, `Stage4ProposalRevision`, `StrategyProposal`, `TendingCoordinationCycle`, `TendingEntry`, `TendingNeedOutcome` | inline session membership (§7.9 of the design doc) |
| **D** — hop via `vesselId` / `sharedVesselId` | 8 | `Agreement`, `Boundary`, `CommonGround`, `ConsentedContent`*, `EmotionalReading`, `IdentifiedNeed`, `UserDocument`, `UserEvent` | parent's owner |
| **D2** — hop via another parent key | 4 | `Stage4SubChatMessage` (→`Stage4SubChat`), `StrategyProposalNeed` (→`StrategyProposal`), `TakeawayLink` (→`SessionTakeaway`), `TendingResponsePartialClosure` (→`TendingResponse`) | parent's owner |
| **E** — `relationshipId` | 1 | `Session` | membership on `relationshipId` |
| **F** — no owner column at all | 5 | `Relationship`*, `User`*, `Need`†, `GlobalLibraryItem`†, `ReconcilerGuidance`*§ | see §5.1 / §1.1 |
| | **71** | | |

**§ `ReconcilerGuidance` — new at W9, [R]** (design §4.3, D8a). Draft 7 counted it in the design
summary's "new tables" line and nowhere else; it is a real table and it belongs in the inventory.
Columns `guesserId`, `subjectId`, `resultId`, `areaHint`, `guidanceType`, `promptSeed` — **no
`userId` and no `sessionId`**, so §1.3's classifier cannot place it and it must be **named
explicitly as Shape F, bespoke**. Predicate:
`USING ("guesserId" = app.current_user_id() OR "subjectId" = app.current_user_id())`. FK
`resultId → ReconcilerResult(id) ON DELETE CASCADE` with its index. `mwf_app` gets no `UPDATE` or
`INSERT` grant at all — `mwf_job` writes it (§5.1a).

**§ The two envelope-key tables — new at W13, [R]** (design §8.6). Columns: `id`, the owner key,
`keyId` (KMS key id), `wrappedDek bytea`, `createdAt`, `destroyedAt`. The owner key is
`UserKey."userId"` → `User(id)` and `SessionKey."sessionId"` → `Session(id)`, both
`ON DELETE RESTRICT` — named that way deliberately, so **§1.3's classifier reaches them unmodified**
as Shape A and Shape C rather than needing an explicit entry. Grants: `mwf_app` may `SELECT` its own
row and `INSERT` once and **never `UPDATE`**; `destroyedAt` is written only by `mwf_job` (that write
is the crypto-shred).

`*` bespoke predicate — see §5.1. `†` no RLS or revoked — see §1.1. `‡` **Shape C by column name
but Shape D by meaning:** `InnerWorkMessage.sessionId` and `SessionTakeaway.sessionId` point at
**`InnerWorkSession`**, not `Session` [C]. A single polymorphic `sessionId` policy would be wrong
on exactly the two tables holding solo therapeutic content.

Ten tables carry a bespoke predicate rather than their shape's template: `ReconcilerGuidance`§,
`Message`,
`EmpathyAttempt`, `ConsentedContent`, `ReconcilerResult`, `Invitation`, `ConsentRecord`, `User`,
`Relationship`, and `BrainActivity` (revoked). Three of those — `EmpathyAttempt`,
`ConsentedContent`, `ReconcilerResult` — are bespoke *because the shape template was wider than
the product*, which is the review's central finding. See design doc §4.3.

### 1.3 The coverage assertion

Three hand-maintained lists that disagreed is the antipattern the golden harness README criticises
by name. The lists above are now generated, and the generator runs in CI as an assertion.

```sql
-- Shape classification. Sums to 68 [V], 71 once ReconcilerGuidance (W9) and
-- UserKey/SessionKey (W13) land. The key tables classify unmodified, because they
-- key ownership on "userId" and "sessionId"; ReconcilerGuidance has neither column
-- and must be named explicitly in the F/bespoke arm. Any table this cannot
-- classify, or any RLS-enabled table with no policy for a command it holds a
-- grant on, fails CI.
WITH t AS (
  SELECT c.oid, c.relname AS tbl, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
), cols AS (
  SELECT t.tbl, t.relrowsecurity, t.relforcerowsecurity,
         bool_or(a.attname = 'userId')         AS has_userid,
         bool_or(a.attname = 'sessionId')      AS has_sessionid,
         bool_or(a.attname IN ('vesselId','sharedVesselId')) AS has_vessel,
         bool_or(a.attname = 'relationshipId') AS has_rel
  FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  GROUP BY 1,2,3
)
SELECT CASE
         WHEN has_userid AND has_sessionid THEN 'B'
         WHEN has_userid                   THEN 'A'
         WHEN has_sessionid                THEN 'C'
         WHEN has_vessel                   THEN 'D'
         WHEN has_rel                      THEN 'E'
         ELSE 'F/D2 — must be named explicitly'
       END AS shape,
       count(*), string_agg(tbl, ', ' ORDER BY tbl)
FROM cols GROUP BY 1 ORDER BY 1;
```

---

## 2. Roles and grants

Roles are **cluster-wide**, not per-database. Every `CREATE ROLE` must be idempotent
(`DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`) or Prisma's shadow-database
round-trip will fail [R].

| Role | Connects from | May | May **not** | RLS | Verified by |
|---|---|---|---|---|---|
| `mwf_migrator` | `prisma migrate deploy` (`render.yaml:8`), `DATABASE_URL` | own all tables; all DDL; `CREATE ROLE`; `BYPASSRLS` | — (it is the trust root) | bypasses | assertion 1 must show the **app** is not this role |
| `mwf_app` | every HTTP request, `APP_DATABASE_URL` | `SELECT`/`INSERT`/`DELETE` on RLS tables; `UPDATE` on **listed columns only**; `EXECUTE` on `app.*` | `TRUNCATE` [V]; any DDL [V]; `SET ROLE` [V]; `row_security=off` [V]; `CREATE` in `public` [V]; **read/write `BrainActivity`**; write `Need`/`GlobalLibraryItem`; **hold `BYPASSRLS`, ever — including the W8–W10 interim** (design §9.1(1)) | **subject, FORCEd** | assertions 1, 4, 5 |
| `mwf_job` | retention & tending CLI entrypoints (6) [C] **plus the D6 two-party paths** | `SELECT`/`UPDATE`/`DELETE` on the tables those jobs touch; write `BrainActivity`; write `Message` (the reveal and share-accept paths); write `destroyedAt` on `UserKey`/`SessionKey` | own tables; DDL | **subject, with `USING (true)` policies per table** — see §2.4 | assertion 8, plus the CI bounding check below |

**`mwf_job` is the residual** (design doc §10, D6). The DB-side audit control works — but **not on
Render**:

```sql
ALTER ROLE mwf_job SET log_statement            = 'all';
ALTER ROLE mwf_job SET log_parameter_max_length = 0;   -- or this logs conflict content
```

**[V]** As superuser: the setting sticks in `pg_roles.rolconfig` and `mwf_job` cannot remove it
(`SET log_statement='none'` → `permission denied`, it is `PGC_SUSET`).
**[V]** As a **non-superuser `CREATEROLE`** role — Render's documented shape — both `ALTER ROLE`
statements fail with `permission denied to set parameter`, even on a role it created itself
(isolated against the `ADMIN OPTION` confound). Render states it grants no superuser, so **this
control is unavailable in production** and the CI allowlist carries the whole weight there. Worth
a support ticket; Render does make server-side changes on request.

**[V] `application_name` is not a control** — `USERSET`, and a role-level default was overwritten
at will in testing. Debugging hint only; never an audit boundary.

### 2.3 Render platform constraints that bear on this design

Researched against Render's full documentation corpus. These are load-bearing, so they are recorded
here rather than assumed.

| Fact | Consequence for this design | Source |
|---|---|---|
| **No superuser access** | **Good news.** The production role is a non-superuser owner, so `FORCE ROW LEVEL SECURITY` genuinely binds it — the one configuration where RLS is enforced against the owner [V]. | `postgresql-pg-repack` |
| `CREATE USER` / `CREATE ROLE` available | The role split (`mwf_migrator`, `mwf_app`, `mwf_job`, `mwf_ops`) is provisionable | `postgresql-credentials` |
| **No custom compiled extensions**; closed supported list; no `$libdir` access | The `PGC_SUSET` identity-GUC mechanism is undeployable → **`mwf_analyst` withdrawn**, T3 unmitigated | `postgresql-extensions` |
| **No `shared_preload_libraries` / `postgresql.conf` / `ALTER SYSTEM`** surface; even `wal_level` needs a support ticket | No server-level tuning; no `auto_explain` | `blueprint-spec`, `postgresql-logical-replication` |
| `log_statement` not exposed; `log_min_duration_statement` pinned at 2s; `auto_explain` not on the extension list | **No statement-level audit trail for `mwf_job` in production.** Also confirms the golden harness's SQL trace is local-only, as its README says | `postgresql-creating-connecting` |
| `pgcrypto` **and** `pgvector` both supported | pgcrypto is available — and still rejected on the merits (design doc §8.2) | `postgresql-extensions` |
| PostgreSQL 18 available and the default; in-place upgrades supported | `work-a39h.1` is unblocked; the PG18-only `NOT NULL … NOT VALID` form is usable | `postgresql-upgrading` |
| Read replicas supported (up to 5) | The only realistic analytics path if T3 ever needs one | `postgresql-read-replicas` |

**Still to run, and worth one support ticket:** the D0 **check** —
`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;` — where `rolsuper` must
be `false` and a `true` `rolbypassrls` confines the Render root credential to the migration step
(design §1 T4). It is no longer a fork: §2.4 chooses branch A regardless. And: whether Render will
set `log_statement` for a named role.
| `mwf_ops` | `/api/brain/*` (12 all-user endpoints, no `req.user`) [C] | **`SELECT` only**, on exactly the tables `routes/brain.ts` reads — which include `Message`, `UserVessel`, `InnerWorkSession`/`InnerWorkMessage` and `EmotionalReading` [C] | any write, anywhere; any table not on that list | **subject, with `SELECT`-only `USING (true)` on the enumerated set** — see §2.4 | assertion: zero non-`SELECT` grants |
| `mwf_analyst` | future BI / LLM-driven queries (T3) | `SELECT` on RLS tables | — see below | **subject** | **[V] — CANNOT BE BUILT AS SPECIFIED** |

**`mwf_analyst` is withdrawn as a specified property.** The first draft said its identity could be
pinned by revoking the ability to set `app.current_user_id`. **[V]** On PG16,
`REVOKE SET ON PARAMETER "app.current_user_id" FROM <role>` is accepted without error,
`pg_parameter_acl` stays **empty**, and the role then set the GUC and read another user's rows.
Postgres tracks parameter ACLs only for parameters it knows; a placeholder GUC in a custom class
is not one. Unverified on PG18 — the container was removed by a concurrent workstream before it
could be retested. **Treat as a spike. Until it resolves, T3 has no database-layer mitigation and
this row states no property.**

`mwf_ops` read-only is worth more than it looks: `backend/src/routes/brain.ts:32-39` **fails open
in non-production when neither `DASHBOARD_API_SECRET` nor `CLERK_SECRET_KEY` is set** [C]. A
`SELECT`-only role caps that blast radius today, before any of the rest of this lands.

### 2.4 D0, decided — branch A: `USING (true)` policies, not `BYPASSRLS`

**Decided 2026-09-04.** `mwf_job` and `mwf_ops` are RLS **subjects** with explicit permissive
policies, not holders of the `BYPASSRLS` attribute. The reason is least privilege, and it holds
whether or not the attribute is available on Render: `BYPASSRLS` is all-or-nothing across all 71
tables and does not appear in the schema, while a permissive policy is per-table, scopable,
enumerable and greppable. **Branch B — grant the attribute — is rejected, not deferred.**

**The same rule covers `mwf_app`'s interim.** It is never granted `BYPASSRLS` either: the W8–W10
window runs on `USING (true)` **placeholder** predicates that W10 replaces tier by tier
(design §9.1(1)). So `rolbypassrls` forks nothing at all — only `mwf_migrator`, the table owner,
would use the attribute, and even there `FORCE` can simply be toggled off instead [V]. The D0
query's live purpose is the `rolsuper` half.

```sql
-- One pair per table the role legitimately reaches. Never FOR ALL on a table
-- the role does not need.
CREATE POLICY "Message_job" ON "Message" FOR ALL TO mwf_job USING (true) WITH CHECK (true);
```

**[V]** The mechanism works: with such a policy a non-`BYPASSRLS` job role sees every row and
writes normally; **[V]** without it, on a `FORCE`d table, it sees **zero rows** and its `UPDATE`
reports success while affecting none. Omission is silent, so the enumeration is load-bearing.

**The `mwf_job` derivation is a union of two sets, and draft 7 named only one of them.**

| Role | Which tables get a `USING (true)` policy | Count |
|---|---|---|
| `mwf_job` | **(a) the D6 allowlist entrypoints** (design §10 D6): `checkAndRevealBothIfReady`, the share-offer accept transaction, `refreshStage4NeedCoverage`, `applyStage4AutoClosureFromSignal`, the six `StageProgress` sites, the six retention/tending CLI entrypoints, the reconciler's own `ReconcilerResult` reads and writes, and the two anonymisation functions of design §7.12a. **∪ (b) every `app.*` `SECURITY DEFINER` function body** — they are owned by `mwf_job`, so `current_user` inside them is `mwf_job` and their reads are subject to `mwf_job`'s policies. `is_member`, `is_co_member`, `session_relationship`, `is_session_member`, `partner_user_id` and `partner_display_name` read **`RelationshipMember`**, **`Session`** and **`User`**; `resolve_user_by_clerk_id` reads `User` and `create_user_for_clerk` **INSERTs** it [C]. **∪ `SELECT` on `UserKey` and `SessionKey`** (it needs the session key to encrypt the `Message` rows it writes at `sharing.ts:1018`, `state.ts:101`/`:514` — design §8.6) and `UPDATE (destroyedAt)` on both | **[R]** — derive when W1a is written; a subset of the 69, not all |
| `mwf_ops` | **`SELECT`-only, on exactly the tables `routes/brain.ts` reads** [C]: `BrainActivity` (13 sites), `Session` (6), **`Message`** (`:257`, `:457`, `:873`, `:981`, `:1240`, `:1378`), **`UserVessel`** (`:895`, `:963`), **`InnerWorkSession`** (`:470`, `:1030`, `:1214`, `:1408`), **`InnerWorkMessage`** (`:477`, `:881`, `:1250`, `:1420`) and **`EmotionalReading`** (`:970`) | **[R]** — re-derive against `brain.ts` at W1a |

**Draft 7 said `mwf_ops` gets "never a vessel table". That was wrong** and is withdrawn: the ops
dashboard reads vessel tables today, and a role that cannot read them is a broken dashboard, not a
tighter one. The honest framing is that `mwf_ops` is `SELECT`-only, enumerated, and **not** a
general reader — and that **under D5 the content columns it reads are ciphertext to it**, since it
holds no DEK. Content views on the dashboard therefore degrade to the developer decrypt script
(W13 prerequisite 5); aggregate and count views are unaffected.

**Omitting (b) is the failure that looks like a policy bug.** Without `USING (true)` for `mwf_job`
on `RelationshipMember`, `Session` and `User`, every helper returns nothing, so every Tier 1
predicate that calls one evaluates false and **W10 fails closed across the whole product** — with
correct-looking DDL and no error anywhere.

Two consequences already recorded elsewhere and repeated here because they bite at W1a: the
`SECURITY DEFINER` functions owned by `mwf_job` see zero rows until their tables have these
policies, so **W1a precedes W4a and W4b** (design §9); and **[V]** permissive policies are
inherited through **role membership**, unlike `BYPASSRLS`, so a single `GRANT mwf_job TO mwf_app`
would collapse the boundary — that is structural assertion 9.

### 2.1 The column-level `UPDATE` grants — T7

**[V] This is the mechanism, not a refinement of it.** RLS cannot stop a re-route because a policy
expression has no access to the OLD row; verified by successfully re-routing a private message
under a correct-looking policy. Column-level `UPDATE` privilege stops it: verified, the same
attempt then failed with `permission denied for table Message`.

```sql
REVOKE UPDATE ON "Message" FROM mwf_app;
GRANT  UPDATE ("content", "extractedNeeds", "extractedEmotions") ON "Message" TO mwf_app;
```

The rule generalises: **`REVOKE UPDATE` then re-grant per column on every table with an
authorization column.** Never grantable to `mwf_app`:

`forUserId`, `senderId`, `sessionId`, `role`, `userId`, `vesselId`, `relationshipId`,
`guesserId`, `subjectId`, `sourceUserId`, `invitedById`, `acceptedByUserId`, `sharedVesselId`,
`consentRecordId`, `proposalId`, `subChatId`, `createdByUserId`, and every primary key.

**Extended in draft 3, and once more after draft 6.** Any column a *read policy* consults is an
authorization column, whatever its name suggests. Four were missed:

| Column | Why it is now on the list |
|---|---|
| `EmpathyAttempt."sourceUserId"` | The `sourceUserId = me` arm of `EmpathyAttempt_select`. **[V]** With it writable, Ada forged an attempt attributed to Bob and Bob read it as his own. |
| `EmpathyAttempt.status` | Half the read predicate after §4.3 — `REVEALED`/`VALIDATED` is what discloses the attempt to the partner. A member who can set it can reveal their partner's attempt to themselves. The reveal runs as `mwf_job` (D6), so `mwf_app` needs no grant; its only path is `app.empathy_set_status` (§3). **[V]** design §4.3, draft 6: 9 writers pass, 8 attacks blocked. The grant itself is assertion 5. |
| `ConsentedContent."sourceUserId"` | The `sourceUserId = me` arm of `ConsentedContent_select_own`. |
| `StrategyProposal."createdByUserId"` | An author column. Not a read-policy arm today, but `session-deletion.ts:165` nulls it on anonymisation — an `mwf_job` path after W4b — and it is exactly the latent case that becomes a defect when a policy is widened. |

**One deliberate exception.** `ConsentedContent."consentActive"` and `"revokedAt"` **are** granted
to `mwf_app`, because `controllers/consent.ts:224` is an in-request write by the consenting user
[C]. The direction is constrained by the `consent_no_resurrect` trigger (§4) rather than by the
grant — `false` is reachable, `true` is not. That is the right split: the grant says *who* may
touch the column, the trigger says *which way it may move*.

**Verified by:** structural assertion 5, whose column list is extended accordingly, plus new
assertion 7 (§7).

**Verified by:** structural assertion 5 — `information_schema.column_privileges` must return zero
rows for `mwf_app` × `UPDATE` × any name on that list.

### 2.2 Partner-visible `User` columns

A partner must read the other's display name [C]. A row-level policy admitting co-members would
expose `email`, `pushToken`, `globalFacts` and `memoryPreferences` along with it.

```sql
-- Row policy: my own row in full.
CREATE POLICY "User_self" ON "User" FOR SELECT TO mwf_app
  USING (id = app.current_user_id());

-- Partner visibility is COLUMN-scoped, not row-scoped: a second, narrow policy
-- plus a column grant. The policy widens the rows; the grant narrows the columns.
CREATE POLICY "User_covisible" ON "User" FOR SELECT TO mwf_app
  USING (app.shares_relationship_with(id, app.current_user_id()));
REVOKE SELECT ON "User" FROM mwf_app;
GRANT  SELECT (id, name, "firstName", "lastName") ON "User" TO mwf_app;
GRANT  SELECT ("clerkId", email, "pushToken", "globalFacts", "memoryPreferences",
               "notificationPreferences", "privacyPreferences", "biometricEnabled",
               "biometricEnrolledAt", "lastMoodIntensity", "createdAt", "updatedAt")
       ON "User" TO mwf_app;   -- narrowed further by the row policy above
```

**[R] — this composition is not verified.** Two `SELECT` policies OR together, so `User_covisible`
widens rows for *all* granted columns, not just the name ones. Postgres has no per-policy column
scoping. **This does not work as drafted and must be redesigned** — most likely as a
`SECURITY DEFINER` function `app.partner_display_name(text)` returning only the name, with
`User_covisible` dropped entirely. Recorded here rather than quietly fixed, because it is exactly
the kind of thing that looks right in review and is not.

---

## 3. Functions

Every `SECURITY DEFINER` is a privilege-escalation surface. Each is justified individually, each
pins `search_path`, each has `EXECUTE` revoked from `PUBLIC`, each returns a scalar. None takes a
value that becomes SQL.

**Every row states an owner.** That is not bookkeeping: a `SECURITY DEFINER` function runs as its
owner, so ownership *is* the privilege, and getting it wrong fails silently in both directions
(§7 assertion 11). All `SECURITY DEFINER` functions here are owned by **`mwf_job`**, and under
branch A `mwf_job` additionally needs `USING (true)` policies on every table their bodies touch —
otherwise the bodies see zero rows and raise "not found" on every call [V].

| Signature | Owner | Security | Volatility | Justification | Called by | Verified by |
|---|---|---|---|---|---|---|
| `app.empathy_set_status(text, "EmpathyStatus")` | **`mwf_job`** | DEFINER | `VOLATILE` | The only writer of `EmpathyAttempt.status`. Encodes the non-author transition rule that neither a CHECK nor a policy can express. `FOR UPDATE` + status-guarded write for TOCTOU; no-op when unchanged, because callers include retried fire-and-forget paths. | 6 `mwf_app` sites; 3 system writers go direct as `mwf_job` (design §4.3) | **[V]** draft 6: all 9 writers pass, 8 attacks blocked, non-author reachable closure disjoint from the reveal-reachable set |
| `app.anonymize_user_in_session(text, text)` | **`mwf_job`** | DEFINER | `VOLATILE` | Per-session anonymization. **Two authorization arms: `current_user = 'mwf_job'` OR the self-only check**, plus the membership check. The `mwf_job` arm is what the W4b interim calls, because `app.current_user_id()` is NULL until Phase 4 (design §10 D9); the CI allowlist bounds it. `p_display_name` removed: an attacker-controlled string was landing in the partner-visible `ReconcilerResult.subjectName`. | `session-deletion.ts` | **[R]** |
| `app.anonymize_user_account(text)` | **`mwf_job`** | DEFINER | `VOLATILE` | Account-wide. Under D9 it **writes the `User` tombstone and deletes the private-only rows explicitly**, since no `User` cascade fires after §6.3a. Same two authorization arms. Ships at **W4b, in the same migration as the FK rebuild** — never after it, or `account-deletion.ts:160` 500s. | `account-deletion.ts` | **[R]** |
| `app.partner_user_id(p_session_id text)` | **`mwf_job`** | DEFINER | `STABLE` | "Who is my partner" is a fact the caller is entitled to and `RelationshipMember`'s policy hides, producing two silent `if (!partner)` inversions (design §7.11). **Caller-bound — see body below.** | partner-detection sites | **[R]** |
| `app.create_user_for_clerk(p_clerk_id text, p_email text, …)` | **`mwf_job`** | DEFINER | `VOLATILE` | The pre-identity bootstrap. **The most dangerous object in this design** — see below. **After W13 it also mints the user's `UserKey` row** in the same call: `UserKey_insert` is `WITH CHECK ("userId" = app.current_user_id())`, which is unsatisfiable at first auth, so nothing else can create it (design §8.6). | auth middleware only | **[R]** |

**`app.partner_user_id` — bound to the caller, or it is the `session_relationship` oracle again.**
As merely *named* in draft 5 it takes an arbitrary session id and returns the partner's user id,
which is strictly stronger than the oracle already fixed in §3.1. The same rule applies: **return
`NULL` unless the caller is a member.**

```sql
CREATE FUNCTION app.partner_user_id(p_session_id text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$
  SELECT other."userId"
    FROM public."Session" s
    JOIN public."RelationshipMember" me    ON me."relationshipId"    = s."relationshipId"
                                          AND me."userId"            = app.current_user_id()
    JOIN public."RelationshipMember" other ON other."relationshipId" = s."relationshipId"
                                          AND other."userId"        <> app.current_user_id()
   WHERE s.id = p_session_id
   LIMIT 1;   -- NULL when the caller is not a member: no membership join, no row
$$;
ALTER FUNCTION app.partner_user_id(text) OWNER TO mwf_job;
REVOKE EXECUTE ON FUNCTION app.partner_user_id(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.partner_user_id(text) TO mwf_app;
```

The caller's own membership is a join condition rather than a separate guard, so there is no branch
to forget and a non-member gets `NULL` — the same answer as "this session has no partner", which is
what a non-member is entitled to know.

**`app.create_user_for_clerk` — an account-squatting primitive, and it cannot be argument-checked.**
This is the one object with no re-checkable argument, because it runs **before** an identity exists:
`app.current_user_id()` is `NULL` by definition on this path. `User.clerkId` and `User.email` are
both `@unique` [C], so an attacker who can call it freely can pre-create rows on a victim's Clerk
subject or email address and take over the account at first login.

Mitigations, all of which must hold together — **[R], none built:**

1. **`INSERT`-only, never `UPDATE`.** It must not be able to re-point an existing `clerkId` or
   `email` at anything. On conflict it returns the existing id and writes nothing.
2. **`EXECUTE` granted to a dedicated `mwf_auth` role, not to `mwf_app`.** The auth middleware is
   the only legitimate caller, and it is the only code path that runs pre-identity. Granting this
   to `mwf_app` means all 19 `$queryRaw` sites can reach it.
3. **The `clerkId` argument must be a verified Clerk subject.** The database cannot check this — the
   JWT verification is upstream in `middleware/auth.ts` — so the grant boundary in (2) is doing the
   whole job, and that must be stated rather than implied.
4. **Rate-limited upstream**, since (3) leaves an authenticated-but-hostile caller able to iterate.

**This object deserves its own review before it is built.** It is the single place where the
design's "identity comes from a verified JWT" assumption is load-bearing at the database layer, and
the database cannot verify it.

| Signature | Security | Volatility | Justification | Called by | Verified by |
|---|---|---|---|---|---|
| `app.current_user_id() → text` | **INVOKER** | `STABLE PARALLEL SAFE` | Reads a GUC. No privilege needed; `DEFINER` would be gratuitous. | every policy | **[V]** returns the `SET LOCAL` value; NULL when unset; NULL ⇒ zero rows |
| `app.is_member(relationshipId text, userId text) → boolean` | **DEFINER** | `STABLE` | **[V] Required.** Without it, an `EXISTS` against `RelationshipMember` is re-filtered by that table's own policy, so the caller cannot see the *partner's* membership row and a legitimate insert is rejected. Verified: Ada→Bob failed with the plain subquery, succeeded with this. | `Message_insert`, `Invitation_select`, Shape C policies | **[V]** the Ada→Bob / Ada→Eve / Eve→Ada triple |
| `app.session_relationship(sessionId text) → text` | **DEFINER** | `STABLE` | Same reason: `Session` has RLS, and resolving a session's relationship is a prerequisite *to* the membership check. Returns one id, never a row. | as above | **[V]** as part of the same triple |
| `app.is_session_member(sessionId text, userId text) → boolean` | **DEFINER** | `STABLE` | Convenience composition of the two above; exists so 16 Shape C policies share one tested expression rather than 16 hand-written joins. | all Shape C | **[R]** — composition untested |
| `app.shares_relationship_with(a text, b text) → boolean` | **DEFINER** | `STABLE` | Partner co-visibility. **See §2.2 — the policy that uses it is broken as drafted.** | `User_covisible` | **[R] — do not build until §2.2 is redesigned** |
| `app.resolve_user_by_clerk_id(clerkId text) → text` | **DEFINER** | `STABLE` | **The chicken-and-egg case.** `middleware/auth.ts:177` must read `User` *before* an identity exists — determining the id **is** the operation [C]. Returns an id, never a row, and takes only a Clerk subject already cryptographically verified. | auth middleware | **[R]** |
| `app.create_user_for_clerk(...) → text` | **DEFINER** | `VOLATILE` | Same, for first-auth `User` creation (`auth.ts:212`) [C]. **The most dangerous object in this design** — the only one that writes with elevated privilege. Must be `INSERT`-only, must never `UPDATE` an existing row, must be rate-limited upstream. | auth middleware | **[R] — needs its own adversarial review** |
| `app.message_routing_immutable() → trigger` | INVOKER | `VOLATILE` | Trigger body, §4. | trigger only | **[V]** |

### 3.1 Free-arity helpers are a social-graph oracle — pin them to the caller

**[V]** With the helper as first drafted, a user who is a member of **nothing** can probe the
entire relationship graph. Measured: identity `mallory` saw **0** rows in `RelationshipMember`,
then called `is_member('r1','ada')` → **true**, `is_member('r1','bob')` → **true**,
`is_member('r1','zoe')` → **false**.

No content leaks. But **who is in conflict with whom** is close to the most sensitive metadata this
product holds — arguably more damaging than a single message, because it is the fact of the
relationship itself — and every one of the 19 `$queryRaw` sites can reach these functions.

**The fix is arity, not privilege.** Where the answer is about the caller, do not accept a user
argument at all:

```sql
-- Self checks take no user argument, so there is nothing to probe with.
CREATE FUNCTION app.is_member(p_relationship_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public   -- non-negotiable: an unpinned search_path
                                         -- on a DEFINER function is a takeover
  AS $$ SELECT EXISTS (SELECT 1 FROM public."RelationshipMember" rm
                       WHERE rm."relationshipId" = p_relationship_id
                         AND rm."userId"         = app.current_user_id()) $$;

-- The ONE case that genuinely needs a second user: Message_insert must confirm
-- that forUserId is a member. Bounded so it can only ever answer about someone
-- who shares a relationship with the caller — a fact the caller already knows.
CREATE FUNCTION app.is_co_member(p_relationship_id text, p_other_user_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT EXISTS (SELECT 1 FROM public."RelationshipMember" me
                       WHERE me."relationshipId" = p_relationship_id
                         AND me."userId" = app.current_user_id())
           AND EXISTS (SELECT 1 FROM public."RelationshipMember" them
                       WHERE them."relationshipId" = p_relationship_id
                         AND them."userId" = p_other_user_id) $$;

REVOKE EXECUTE ON FUNCTION app.is_member(text)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.is_co_member(text, text)     FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app.is_member(text)              TO mwf_app;
GRANT  EXECUTE ON FUNCTION app.is_co_member(text, text)     TO mwf_app;
```

`app.is_co_member` returns `false` — indistinguishably — both when the caller is not a member and
when the other user is not, so a non-member learns nothing. **[R]** The bounded form was not
re-executed; the *unbounded* leak was [V].

The same treatment applies to `app.session_relationship`, which as drafted resolves any session id
to its relationship id for any caller: it should return `NULL` unless the caller is a member.

**And note §7.9 of the design document:** most of these helpers should not exist on read paths at
all. A self check inline in the policy is ~8× faster [V] and is not wrongly double-filtered. The
helpers survive only on `WITH CHECK` clauses that ask about the partner — which is
`app.is_co_member`, and little else.

**Verified by:** structural assertion 6 — every `prosecdef` function in schema `app` must pin
`search_path`, and must not be `EXECUTE`-able by `PUBLIC`. Zero rows.

---

## 4. Triggers

Triggers are harder to reason about than constraints, so each one states why a CHECK could not do
the job. **Three triggers total.** Everything else that could be a CHECK, is one.

| Table | Timing / event | Function | Invariant | Why not a CHECK | Verified by |
|---|---|---|---|---|---|
| `Message` | `BEFORE UPDATE FOR EACH ROW` | `app.message_routing_immutable()` | `forUserId`, `senderId`, `role`, `sessionId` can never change value | **A CHECK cannot see the OLD row.** It constrains a row's state, not a transition. Immutability is a transition property. **[V]** RLS cannot express it either — verified by successfully re-routing a message under a correct-looking policy. | **[V]** re-route rejected; unrelated column update on the same row succeeded |
| `Message` | same trigger, second branch | `app.message_routing_immutable()` | `content` is immutable when `role IN ('AI','SYSTEM')` | Same reason. This is the durable half of `work-kpkq.4`: even a member who can write to a session cannot rewrite what the facilitator said. | **[V]** rewriting an AI message's content rejected; editing one's own `USER` content succeeded |
| `ConsentedContent` | `BEFORE UPDATE FOR EACH ROW` | `app.consent_no_resurrect()` | `consentActive` may go `true → false`, never `false → true`; `sourceUserId` immutable | Transition property again. Consent revocation must be terminal — re-activating revoked content silently re-shares something the user withdrew, which is the worst available bug in a consent system. **Draft 3 adds the `sourceUserId` pin**: it is an arm of `ConsentedContent_select_own`, so it is an authorization column. | **[R] — not built, not tested** |
| `EmpathyAttempt` | `BEFORE UPDATE FOR EACH ROW` | `app.empathy_attempt_immutable()` | `sourceUserId` and `sessionId` immutable; `status` may not move to `REVEALED`/`VALIDATED` except as `mwf_job` | **New in draft 3, and it is the M1 defence in depth.** `sourceUserId` is a read-policy arm and `status` is half the read predicate (§4.3). Column grants are the primary defence; this survives a stray `GRANT ALL`. A CHECK cannot express either — both are transitions. | **[R] — the forgery it prevents is [V]; the trigger is not** |

```sql
CREATE FUNCTION app.message_routing_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- work-kpkq.4, durable half: facilitator speech cannot be rewritten.
  IF OLD.role IN ('AI','SYSTEM') AND NEW.content IS DISTINCT FROM OLD.content THEN
    RAISE EXCEPTION 'facilitator-authored content is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- T7: the routing columns decide who sees the row. A single UPDATE that flips
  -- forUserId moves a private row into the partner's view without creating
  -- anything. Column-level grants are the primary defence; this survives someone
  -- re-running GRANT ALL.
  IF NEW."forUserId" IS DISTINCT FROM OLD."forUserId"
     OR NEW."senderId"  IS DISTINCT FROM OLD."senderId"
     OR NEW.role        IS DISTINCT FROM OLD.role
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" THEN
    RAISE EXCEPTION 'message routing columns are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "Message_routing_immutable"
  BEFORE UPDATE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION app.message_routing_immutable();
```

**One breakage this causes, and it is real.** `session-deletion.ts:95` does
`message.updateMany({ where: { senderId: userId }, data: { senderId: null } })` to anonymize a
departing user [C]. The trigger rejects it. **Under D9 that write goes away entirely** — soft
delete stops nulling `senderId` and takes attribution from the `User` tombstone instead — but the
exemption below is still required, because the anonymisation functions run as `mwf_job`.

**The first draft's recommended handling was wrong** and review caught it: it said the
anonymization should become a `SECURITY DEFINER` function *instead of* a role carve-out. **A
`SECURITY DEFINER` function does not bypass triggers.** It changes `current_user` and the
privileges the body runs with; triggers on the tables it touches still fire. So the function alone
does nothing here.

**Corrected handling — the exemption is required either way:**

```sql
CREATE FUNCTION app.message_routing_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- THE EXEMPTION MUST ENUMERATE EVERY PRINCIPAL THAT CAN REACH THIS LINE,
  -- INCLUDING THE ONES POSTGRES SUPPLIES. Draft 4 named only mwf_job and was
  -- wrong twice over:
  --
  --  * mwf_job -- the anonymization functions, which are SECURITY DEFINER and
  --    OWNED BY mwf_job, so current_user is mwf_job inside them.
  --
  --  * THE TABLE OWNER -- Message.senderId is ON DELETE SET NULL, and the FK's
  --    internal UPDATE fires this trigger as the TABLE OWNER: not the deleting
  --    role, not mwf_job. [V] DELETE FROM "User" produced
  --    'ERROR: senderId immutable (current_user=p5_owner)'. Without this arm,
  --    W4 breaks EVERY User deletion -- and it breaks it the day the trigger
  --    DDL applies, not at W10.
  IF current_user IN ('mwf_job', 'mwf_migrator') THEN
    RETURN NEW;
  END IF;
  ...
END $$;
```

**D9 took the alternative.** Decided 2026-09-04: soft delete, so a `User` row is scrubbed into a
tombstone and **never removed** — and **every** FK to `User` becomes `ON DELETE RESTRICT`, the
three pinned author columns among them (§6.3a; design §10 D9, §3.2 step 3b). A referential action
that can never fire cannot be a hidden writer.

**The other two triggers had the same exposure, and it is now enumerated and resolved.** Draft 5
left this `[R]`; the answer was **both**, and both were `onDelete: SetNull` into a column the
trigger pins:

| Trigger | Pinned column | Was | Now (D9) |
|---|---|---|---|
| `app.empathy_attempt_immutable` | `EmpathyAttempt."sourceUserId"` | `onDelete: SetNull` — `schema.prisma:747` [C]; every `User` delete errors | **`RESTRICT`** — the action never fires |
| `app.consent_no_resurrect` | `ConsentedContent."sourceUserId"` | `onDelete: SetNull` — `schema.prisma:531` [C]; every `User` delete errors | **`RESTRICT`** |
| `app.message_routing_immutable` | `Message."senderId"` | `onDelete: SetNull` — `schema.prisma:649` [C]; **[V]** `ERROR: senderId immutable (current_user=p5_owner)` | **`RESTRICT`** |

**The `current_user IN ('mwf_job', 'mwf_migrator')` arm stays in all three anyway.** It is defence
in depth, and it is still reached: the anonymisation functions are `SECURITY DEFINER` owned by
`mwf_job`, so `mwf_job` is a live principal inside them (design §7.12a). What has gone is the
*hidden* principal — the table owner arriving through an FK — for `User` deletes specifically.

**[C]** The schema has 21 `onDelete: SetNull` foreign keys in total, six of which target `User`
(`schema.prisma:531`, `:649`, `:747`, `:792`, `:959`, `:969`). All six become `RESTRICT`, along
with the 33 `CASCADE` edges to `User` — the uniform rule of §6.3a, so nothing is left to audit
case by case. **[C]** There are **zero `onUpdate` overrides**, so every FK defaults to
`onUpdate: CASCADE` — an update to a referenced key would still fire these triggers as the owner. Primary keys are not updated in this application today, but that is a convention, not a
constraint, so the owner arm covers it either way.

**The general form of the audit:** for each trigger, list every column it pins, then check whether
any foreign key targets that column with a referential action. `pg_constraint.confupdtype` /
`confdeltype` make this mechanical, and it should be a CI query rather than a reading exercise.

A `SECURITY DEFINER` wrapper owned by `mwf_job` is still worth having — it puts the deletion
semantics in one place and makes `current_user` predictable — but it is a complement to the
exemption, not a substitute for it. **[R]** Not executed.

The message **INSERT** path is untouched — triggers here are `BEFORE UPDATE` only, so the hot write
path pays nothing.

---

## 5. RLS policies

`ALL` is never used. Each command gets its own policy so that a permission can be widened for
reads without silently widening writes.

`TO mwf_app` on every policy in this section. `mwf_job` and `mwf_ops` are RLS subjects too (§2.4)
and get their own `TO mwf_job` / `TO mwf_ops` permissive policies, per table, listed there — never
by widening an `mwf_app` policy. Naming the role explicitly means adding a future role does not
silently inherit access.

### 5.1 The bespoke five

| Table | Policy | Cmd | `USING` | `WITH CHECK` | Attack stopped | Verified by |
|---|---|---|---|---|---|---|
| `Message` | `Message_select` | SELECT | `"forUserId" = app.current_user_id() OR "senderId" = app.current_user_id()` | — | **T1.** A read that forgets its `forUserId` arm returns the caller's rows, not the session's. The `senderId` arm is required, not a concession: `reconciler.ts:901` counts rows the caller *sent* to the partner and branches on the count [C]. | **[V]** Ada 3 rows, Bob 3 (different), outsider 0, no-identity 0 |
| `Message` | `Message_insert` | INSERT | — | `app.is_member(app.session_relationship("sessionId"), app.current_user_id()) AND app.is_member(app.session_relationship("sessionId"), "forUserId")` | Writing into a session you are not in; addressing a message to someone outside the relationship. | **[V]** Ada→Bob ok; Ada→Eve rejected; Eve→Ada rejected |
| `Message` | `Message_update` | UPDATE | `"forUserId" = app.current_user_id() OR "senderId" = app.current_user_id()` | same | Editing another user's row. **Does NOT stop T7** [V] — that needs §2.1 and §4. | **[V]** update on an invisible row is a no-op |
| `Message` | `Message_delete` | DELETE | `"forUserId" = app.current_user_id()` | — | Deleting the partner's rows. Narrower than SELECT deliberately: you may see what you sent, you may not unsend it. | **[R]** |
| `User` | `User_self` | SELECT | `id = app.current_user_id()` | — | Enumerating the user table. | **[V]** analogous policy verified |
| `User` | `User_covisible` | SELECT | `app.shares_relationship_with(id, app.current_user_id())` | — | — | **[R] BROKEN AS DRAFTED** — see §2.2 |
| `Invitation` | `Invitation_select` | SELECT | `"invitedById" = app.current_user_id() OR "acceptedByUserId" = app.current_user_id() OR app.is_member(app.session_relationship("sessionId"), app.current_user_id())` | — | **`work-kpkq.2`.** Today any authenticated non-inviter passes `requireSessionAccess` permanently on a session with an `ACCEPTED` invitation, and `sessionId`s come from a public endpoint [C]. The `acceptedByUserId` arm is what lets the fallback be deleted rather than patched. | **[R]** — needs the new column and a backfill |
| `ConsentRecord` | `ConsentRecord_select` | SELECT | `"userId" = app.current_user_id() OR "requestedByUserId" = app.current_user_id()` | — | Reading consent decisions you were neither party to. Two user columns; both arms required. `sessionId` is nullable [C] so a session-join policy would have to branch — this shape avoids it. | **[R]** |
| `Relationship` | `Relationship_select` | SELECT | `EXISTS (SELECT 1 FROM "RelationshipMember" rm WHERE rm."relationshipId" = "Relationship".id AND rm."userId" = app.current_user_id())` | — | **The table the first draft omitted entirely.** No `userId`, no `sessionId`; reached only through `RelationshipMember`, and it is the root of every membership check in the design. Inline: a self check. | **[R]** |
| `EmpathyAttempt` | `EmpathyAttempt_select` | SELECT | `"sourceUserId" = app.current_user_id() OR (status IN ('REVEALED','VALIDATED') AND <inline session membership>)` | — | **Predicate fidelity, design doc §4.3.** `empathy-status.ts:234` gates the partner's view on exactly these two statuses [C]. The Shape C template would expose the partner's empathy text in `HELD`, `ANALYZING`, `AWAITING_SHARING`, `REFINING` and `READY` — five states where the product hides it, and the mutual-reveal design is the product. | **[R]** |
| `ConsentedContent` | `ConsentedContent_select` | SELECT | `"consentActive" AND <inline hop via SharedVessel to session membership>` | — | **Predicate fidelity.** `shared-context.ts:253` filters `consentActive: true`, `consent.ts:224` clears it on revocation, `retrieval-planner.ts:65` types it `z.literal(true)` [C]. Without this arm, revoked content stays readable at the database layer — and **Revocability is a named guarantee of the vessel model**. | **[R]** |
| `ConsentedContent` | `ConsentedContent_select_own` | SELECT | `"sourceUserId" = app.current_user_id()` | — | The author can still see what they withdrew, or the "review what you have shared" screen breaks on revoke. **Judgement call** — confirm against `consent.ts:167`, which reads `consentActive` rather than filtering on it. | **[R]** |
| `ReconcilerResult` | `ReconcilerResult_select` | SELECT | `"subjectId" = app.current_user_id()` | — | **Predicate fidelity, and the one case a row policy cannot express.** The schema itself marks `areaHint`/`guidanceType`/`promptSeed` as *"Abstract guidance … no specific partner content"*, and `empathy-status.ts:89` selects exactly those three for the guesser [C]. `guesserId = me` would additionally hand over `missedFeelings`, `misattributions`, `mostImportantGap`, `gapSummary`, `alignmentSummary`, `suggestedShareContent` — all derived from the **subject's** private Stage 1 material. Postgres has no per-policy column scoping, so the guesser arm is dropped here and moved to `ReconcilerGuidance` (D8a). **Depends on the new FKs (§6).** | **[R]** |
| `ReconcilerGuidance` | `ReconcilerGuidance_select` | SELECT | `"guesserId" = app.current_user_id() OR "subjectId" = app.current_user_id()` | — | New table under D8a option (a): exactly the three columns the schema labels *"no specific partner content"*, split out so the guesser can read guidance without reading the analysis. `alignmentSummary`, `correctlyIdentified` and `rationale` **stay on `ReconcilerResult`** — see design doc §4.3 for the classification. If the owner picks (b), this row becomes `app.refinement_hint(sessionId)` in §3. | **[R]** |

### 5.1a Write policies for the bespoke tables — the M1 fix

Draft 2 gave these tables a `SELECT` policy only and let §5.2's generic templates supply the write
side. **[V]** That combination was exploitable: the generic Shape C `WITH CHECK` tests session
membership and never pins the author column, so Ada inserted an `EmpathyAttempt` with
`sourceUserId = 'u_bob'` and Bob read it through his own `sourceUserId = me` arm.

| Table | Cmd | `WITH CHECK` | Verified by |
|---|---|---|---|
| `EmpathyAttempt` | INSERT | `"sourceUserId" = app.current_user_id() AND <inline session membership>` | **[V]** forge-as-partner rejected; own write accepted |
| `EmpathyAttempt` | UPDATE | same in `USING` and `WITH CHECK`; `sourceUserId`/`status` not column-granted (§2.1) | **[R]** |
| `EmpathyAttempt` | DELETE | `"sourceUserId" = app.current_user_id()` | **[R]** |
| `ConsentedContent` | INSERT | `"sourceUserId" = app.current_user_id() AND <hop to session membership>` | **[R]** |
| `ConsentedContent` | UPDATE | `"sourceUserId" = app.current_user_id()`; only `consentActive`/`revokedAt` granted, direction pinned by trigger (§4) | **[R]** |
| `ConsentedContent` | DELETE | **none, and no grant.** Consent history is `RESTRICT`-protected; revocation is an update, not a delete. | **[R]** |
| `ReconcilerResult` | INSERT/UPDATE/DELETE | **none, and no grant to `mwf_app`.** Written only by the reconciler, which runs as `mwf_job` (D6). No user-facing path creates an analysis of their own empathy gap. | **[R]** |
| `ReconcilerShareOffer` | INSERT | **none for `mwf_app`** — created by the reconciler | **[R]** |
| `ReconcilerShareOffer` | UPDATE | `"userId" = app.current_user_id()` — the offer holder accepts or declines; `userId` and `resultId` not column-granted | **[R]** |
| `ReconcilerGuidance` | all | **none, and no grant.** `mwf_job` writes it. | **[R]** |
| `Message` | INSERT | already author-pinned via `app.is_co_member` + the authorship CHECK + the immutability trigger — the treatment the other four should have had from the start | **[V]** |

**The rule, stated once so it is checkable:** for every table, the set of columns a `SELECT` policy
reads must be a subset of the columns pinned by its `WITH CHECK` or excluded from its `UPDATE`
grants. Structural assertion 7 (§7) enforces it mechanically so this class of defect cannot recur.

### 5.2 Templates — four commands, every table

The first draft gave four commands for Shapes A and B and `_select` only for the rest, leaving
~34 tables readable and unwritable. **[V]** That state is not safe-by-default: `INSERT` errors
loudly, but `UPDATE` and `DELETE` return **zero rows with no error**. Silent write loss on
`Session`, `EmpathyAttempt`, `StrategyProposal`, every Stage 4 table, `ConsentedContent`,
`IdentifiedNeed` and `Boundary`.

Every RLS-enabled table therefore ships all four commands in the same migration that enables RLS
on it — or ships fewer and has the corresponding grant revoked, so the failure is loud.

```sql
-- ===================================================================== A / B
-- Direct userId (35 tables). Inline; no helper. Measured 3.5-3.9 ms on 100k rows. [V]
CREATE POLICY "<T>_select" ON "<T>" FOR SELECT TO mwf_app
  USING ("userId" = app.current_user_id());
CREATE POLICY "<T>_insert" ON "<T>" FOR INSERT TO mwf_app
  WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY "<T>_update" ON "<T>" FOR UPDATE TO mwf_app
  USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY "<T>_delete" ON "<T>" FOR DELETE TO mwf_app
  USING ("userId" = app.current_user_id());

-- ========================================================================= C
-- Session membership (16 tables). Both partners read: correct for genuinely
-- shared state, and WRONG for Message, EmpathyAttempt, Invitation and
-- ReconcilerResult -- which is why those four are bespoke (§5.1).
--
-- INLINE, not a helper. Measured 24 ms inline vs 196 ms via a SECURITY DEFINER
-- helper on 100k rows [V]: the planner hoists the EXISTS into a hashed SubPlan
-- evaluated once, but cannot inline the function, so it calls it per row.
-- Correctness verified too: both members saw all rows, an outsider saw zero [V].
-- Safe because this is a SELF check -- the caller reads their own membership row,
-- which RelationshipMember's own policy already shows them.
CREATE POLICY "<T>_select" ON "<T>" FOR SELECT TO mwf_app
  USING (EXISTS (SELECT 1 FROM "Session" s
                 JOIN "RelationshipMember" rm ON rm."relationshipId" = s."relationshipId"
                 WHERE s.id = "<T>"."sessionId" AND rm."userId" = app.current_user_id()));
CREATE POLICY "<T>_insert" ON "<T>" FOR INSERT TO mwf_app
  WITH CHECK (EXISTS (SELECT 1 FROM "Session" s
                      JOIN "RelationshipMember" rm ON rm."relationshipId" = s."relationshipId"
                      WHERE s.id = "<T>"."sessionId" AND rm."userId" = app.current_user_id()));
-- _update and _delete: same expression in both USING and WITH CHECK.

-- ==================================================================== D / D2
-- One hop to the parent's owner (12 tables). Inline for the same reason.
CREATE POLICY "<T>_select" ON "<T>" FOR SELECT TO mwf_app
  USING (EXISTS (SELECT 1 FROM "UserVessel" uv
                 WHERE uv.id = "<T>"."vesselId"
                   AND uv."userId" = app.current_user_id()));
-- _insert / _update / _delete: same expression.

-- ================================================= UserKey / SessionKey (W13)
-- Two commands, not four, and the missing two are revoked so the failure is
-- loud rather than a silent zero-row UPDATE. mwf_app may read its own wrapped
-- DEK and create one; it may never rewrite or delete one. destroyedAt -- the
-- crypto-shred of design 8.6 -- is written only by mwf_job, through its own
-- USING (true) policy (2.4). [R]
CREATE POLICY "UserKey_select" ON "UserKey" FOR SELECT TO mwf_app
  USING ("userId" = app.current_user_id());
CREATE POLICY "UserKey_insert" ON "UserKey" FOR INSERT TO mwf_app
  WITH CHECK ("userId" = app.current_user_id());
REVOKE UPDATE, DELETE ON "UserKey" FROM mwf_app;
-- SessionKey: the Shape C session-membership expression, same two commands,
-- same revokes.
--
-- mwf_job needs BOTH keys, and it reads them through its own permissive policies
-- (2.4), not through the mwf_app ones above: it writes Message for both partners
-- (sharing.ts:1018, state.ts:101/:514) and under the writer-principal rule of
-- design 8.6 every mwf_job write is session-keyed, so it must resolve the
-- SessionKey row. It also holds UPDATE (destroyedAt) -- the crypto-shred -- on
-- both tables, which no other role has on any column.
CREATE POLICY "UserKey_job"    ON "UserKey"    FOR ALL TO mwf_job USING (true) WITH CHECK (true);
CREATE POLICY "SessionKey_job" ON "SessionKey" FOR ALL TO mwf_job USING (true) WITH CHECK (true);
```

**The write policies are not a formality.** They are where the partner-scoped tables get their
real constraints: on Shape C, `_insert` and `_update` are what stop a member writing rows into a
session they left, and on `ConsentedContent` the `_update` policy is what makes revocation
one-way in company with the `consent_no_resurrect` trigger.

**Verified by:** a per-shape parameterised SQL test — seed two users and an outsider, then for
every table in the shape assert the full matrix: owner reads own / partner reads per shape /
outsider reads none, **and** owner writes own / outsider write rejected / cross-user write
rejected. `UPDATE` assertions must check **rows affected**, not absence of error [V].

---

## 6. Constraints

`NOT VALID` on every added constraint. It binds new writes immediately and defers the full-table
scan; `VALIDATE` runs in a separate migration once the data is known clean. **Every one needs a
`SELECT count(*) WHERE NOT (<predicate>)` against production data before the migration is written.**
The local dev database has 4 `Message` rows [C] — it proves nothing.

### 6.1 CHECK constraints

| Table | Name | Predicate | Invariant | Verified by |
|---|---|---|---|---|
| `Message` | `Message_ai_authorship_ck` | `role NOT IN ('AI','SYSTEM') OR "senderId" IS NULL` | **`work-kpkq.4`, persistence half.** A human-authored row can never claim to be the facilitator. **One-directional on purpose:** `senderId IS NULL` does *not* imply AI. Under D9 no *new* row enters that state — `session-deletion.ts:95` stops nulling `senderId` and the FK becomes `RESTRICT` — but rows anonymized before the migration remain [C], so the biconditional would reject history. | **[V]** forged insert rejected; genuine AI and genuine USER inserts accepted |
| `ConsentRecord` | `ConsentRecord_decision_dated_ck` | `(decision IS NULL) = ("decidedAt" IS NULL)` | A consent decision is dated or it is not a decision. Undated decisions make revocation ordering undefined. | **[R]** |
| `ConsentedContent` | `ConsentedContent_revocation_ck` | `"revokedAt" IS NULL OR "revokedAt" >= "consentedAt"` | Consent cannot be revoked before it was given. | **[R]** |
| `ConsentedContent` | `ConsentedContent_inactive_dated_ck` | `"consentActive" OR "revokedAt" IS NOT NULL` | Inactive content records *when* it was withdrawn. Otherwise "why is this hidden" has no answer. | **[R]** |
| `ReconcilerResult` | `ReconcilerResult_distinct_parties_ck` | `"guesserId" <> "subjectId"` | You cannot have an empathy gap with yourself. Catches parameter-swap bugs in the reconciler's two-direction plumbing. | **[R]** |
| `Invitation` | `Invitation_accepted_bound_ck` | `status <> 'ACCEPTED' OR "acceptedByUserId" IS NOT NULL` | An accepted invitation names its acceptor. **This is the constraint that makes `work-kpkq.2` structurally impossible** rather than merely fixed. | **[R]** |
| `RelationshipMember` | `RelationshipMember_role_ck` | `role IN ('member','owner')` | `role` is free `text DEFAULT 'member'` beside 51 real enums [C]. Any future policy branching on it would be branching on an authorization primitive with no domain. Constrain it before something depends on it. | **[R]** — confirm the actual distinct set first |

**Privacy caveat — measured, and it changes the sequencing.** **[V]** A CHECK violation emits
`DETAIL: Failing row contains (…, MY PARTNER HIT ME IN 2019)` — the whole row — to the log and the
client. Four configurations measured:

| Role | RLS active for it? | `DETAIL` |
|---|---|---|
| app role under enforcement | yes | **suppressed** |
| role holding `BYPASSRLS` | no | **full row content** |
| superuser | no | **full row content** |
| app role, row it cannot see | yes | suppressed — RLS error fires before the CHECK |

Suppression is keyed to **RLS being active for the role**, not to per-row visibility. W3 precedes
W8, so for the whole W3→W8 window there is no RLS on these tables and `mwf_app` is not an RLS-active
role: CHECK constraints added at W3 would leak conflict narratives into logs and API errors for that
period, on a live product. **[V]** From W8 the `USING (true)` placeholders make `mwf_app` RLS-active and suppression **does**
engage — verified on PG16: `FORCE` plus a `USING (true)` policy for a non-owner role suppresses the
`DETAIL: Failing row` line. Good to know, but it does not fix W3, which is five steps earlier.

**W3 therefore has a hard prerequisite:** strip `PostgresError.detail` in the API error handler and
review `log_min_error_statement` **before** the first CHECK constraint ships. The first draft
listed W3 as independent and treated the error-path fix as an aside; both were wrong.

### 6.2 NOT NULL changes

**[V18]** `ALTER TABLE t ADD CONSTRAINT c NOT NULL col NOT VALID` works on PostgreSQL 18.4 — new
NULL inserts blocked immediately, existing NULLs tolerated, `VALIDATE` correctly fails until
backfilled. **[V]** The same statement on PG16 is a **syntax error**. This is the hard dependency
on `work-a39h.1`.

| Table.column | From | To | Prerequisite | Verified by |
|---|---|---|---|---|
| `Message.forUserId` | `text NULL` | `text NOT NULL` | Backfill `forUserId = senderId` where both were null-eligible; **delete or resolve rows where both are NULL** — those are unaddressable under the new policy | **[V18]** mechanism; **[R]** this data |

**No longer blocked on D9.** Soft delete (design §10 D9) keeps `forUserId NOT NULL` — the delete
rule becomes `RESTRICT`, not `SET NULL`, so nothing forces the column nullable. The only remaining
gates are PG18 and a soaked W6a.

No other column changes nullability in this pass. `Message.senderId` stays nullable — historic
anonymized rows depend on it [C], even though D9 stops producing new ones.

**New column:** `User.deletedAt timestamptz NULL` — the tombstone marker (design §10 D9). Nullable
by construction. `User.email` stays `NOT NULL` and `@unique`; the tombstone satisfies both with a
synthetic `deleted+<User.id>@invalid` value. **[R]**

### 6.3 Foreign keys added

**Eleven added, 39 changed.** Of the added, five are the authorization-bearing subset of the nine
unenforced `NOT NULL` relations, one is new with its column, one comes with `ReconcilerGuidance`
(W9) and two with the W13 key tables. The 39 *changed* rules are §6.3a — every existing FK to `User`
becomes `ON DELETE RESTRICT`, rebuilt at W4b.

| Table.column | References | On delete | Why it carries authorization meaning | Verified by |
|---|---|---|---|---|
| `Message.forUserId` | `User(id)` | **RESTRICT** | **The privacy boundary.** An RLS policy arm pointing at nothing is a row no one can read and nothing removes. `RESTRICT`, not `CASCADE`, under D9: the `User` row becomes a tombstone and is never removed, so `RESTRICT` states the truth and turns any future hard delete into a loud error rather than a silent cascade through the boundary. | **[V]** FK created and enforced on the model schema; orphan insert rejected. **[R]** the `RESTRICT` rule |
| `ReconcilerResult.guesserId` | `User(id)` | **RESTRICT** | An RLS policy arm. Also carries a denormalized name copy scrubbed in app code *because* the DB cannot [C]. | **[R]** orphan count unmeasured |
| `ReconcilerResult.subjectId` | `User(id)` | **RESTRICT** | Ditto. | **[R]** |
| `ReconcilerShareOffer.userId` | `User(id)` | **RESTRICT** | Sole owner column; the whole RLS policy. | **[R]** |
| `Stage4NeedDeclination.userId` | `User(id)` | **RESTRICT** | Sole owner column. | **[R]** |
| `PreSessionMessage.userId` | `User(id)` | **RESTRICT** | Sole owner column, on an FK island [C]. Removal is `app.anonymize_user_account`'s explicit job (§6.3a), as it already is at `account-deletion.ts:110`. | **[R]** |
| `Stage4ProposalRevision.sessionId` | `Session(id)` | CASCADE | A Shape C policy join target. | **[R]** |
| `Invitation.acceptedByUserId` | `User(id)` | **RESTRICT** | New column; `work-kpkq.2`. Deleting the invitee must not erase the invitation history — and under D9 there is no delete to erase it, so `RESTRICT` rather than `SET NULL`, for uniformity with the other `User` edges. The policy arm stops matching anyway, because a tombstone can never be `app.current_user_id()`. | **[R]** |
| `UserKey.userId` | `User(id)` | **RESTRICT** | W13. Key destruction is an explicit `destroyedAt` write by `mwf_job`, never a referential action. | **[R]** |
| `ReconcilerGuidance.resultId` | `ReconcilerResult(id)` | CASCADE | W9, D8a. The split table has no independent existence — it is three columns lifted off its parent, so it goes when the parent goes. Not a `User` edge, so §6.3a's rule does not apply. | **[R]** |
| `SessionKey.sessionId` | `Session(id)` | **CASCADE** | W13. Sessions are hard-deleted by the retention job (`session-retention.ts:84` [C]) and their content cascades with them; the key goes with the content. | **[R]** |

### 6.3a Every existing FK to `User` changes delete rule — the uniform rule

**Every foreign key that references `"User"(id)` is `ON DELETE RESTRICT`. No exceptions**
(design §10 D9). A `User` row is never hard-deleted under soft delete, so every referential action
on it is dead code, and a dead referential action is the hidden-writer class of §4. Uniformity
means there is nothing to audit case by case; **structural assertion 12** (§7) checks it.

**When: W4b, not W5.** The rebuild ships in the **same migration as the tombstone path**, because
`account-deletion.ts:160` calls `prisma.user.delete` until then and `RESTRICT` would break it
product-wide the day it lands (design §10 D9). W5 keeps the *new* FKs; W7 keeps `forUserId`.

**[C]** 39 foreign keys reference `User` in `schema.prisma` today. All 39 are rebuilt as
`RESTRICT`. Line numbers are `backend/prisma/schema.prisma`.

**Six are `onDelete: SetNull`** — the three trigger-pinned ones first, since they are the §4 case:

| Table.column | Line | From |
|---|---|---|
| `Message.senderId` **(trigger-pinned)** | `:649` | SET NULL |
| `EmpathyAttempt.sourceUserId` **(trigger-pinned)** | `:747` | SET NULL |
| `ConsentedContent.sourceUserId` **(trigger-pinned)** | `:531` | SET NULL |
| `EmpathyValidation.userId` | `:792` | SET NULL |
| `StrategyProposal.createdByUserId` | `:959` | SET NULL |
| `StrategyProposal.removedByUserId` | `:969` | SET NULL |

**Thirty-three are `onDelete: Cascade`:**

| Table.column | Line | Table.column | Line |
|---|---|---|---|
| `RelationshipMember.userId` | `:108` | `Insight.userId` | `:1727` |
| `InnerWorkSession.userId` | `:204` | `RecurringTheme.userId` | `:1753` |
| `StageProgress.userId` | `:332` | `GratitudeEntry.userId` | `:1772` |
| `UserVessel.userId` | `:364` | `GratitudePreferences.userId` | `:1802` |
| `ConsentRecord.userId` | `:603` | `MeditationSession.userId` | `:1818` |
| `ConsentRecord.requestedByUserId` | `:609` | `MeditationStats.userId` | `:1857` |
| `EmpathyDraft.userId` | `:728` | `MeditationFavorite.userId` | `:1875` |
| `Stage4ProposalSelection.userId` | `:1119` | `MeditationPreferences.userId` | `:1890` |
| `Stage4SubChat.userId` | `:1206` | `SavedMeditation.userId` | `:1903` |
| `TendingCheckin.userId` | `:1265` | `ValidationFeedbackDraft.userId` | `:1998` |
| `TendingCoordinationCycle.createdByUserId` | `:1291` | `TendingReminder.userId` | `:1385` |
| `TendingResponse.userId` | `:1315` | `TendingAdjustment.userId` | `:1409` |
| `TendingEntryOutcome.userId` | `:1341` | `TendingBetweenPeriodNote.userId` | `:1430` |
| `StrategyRanking.userId` | `:1479` | `EmotionalExerciseCompletion.userId` | `:1495` |
| `Invitation.invitedById` | `:1549` | `UserMemory.userId` | `:1599` |
| `NeedScore.userId` | `:1642` | `NeedsAssessmentState.userId` | `:1657` |
| `Person.userId` | `:1674` | | |

**`RelationshipMember.userId` is on that list deliberately.** D9 retains the membership row so the
partner's predicates still see two members, and `RESTRICT` is what stops a future cascade removing
it silently.

**The consequence to plan for:** dropping 33 `CASCADE` edges means `account-deletion.ts:116-160`
deletes nothing by cascade any more, so `app.anonymize_user_account` must delete the private-only
rows **explicitly**. From what cascades today [C]: `UserVessel` (and through it `UserEvent`,
`EmotionalReading`, `IdentifiedNeed`, `Boundary`, `UserDocument`), `InnerWorkSession` (and through
it `InnerWorkMessage`, `SessionTakeaway`), `EmpathyDraft`, `ValidationFeedbackDraft`,
`StageProgress`, `StrategyRanking`, `EmotionalExerciseCompletion`, `ConsentRecord`,
`Stage4ProposalSelection`, `Stage4SubChat` (and `Stage4SubChatMessage`), `UserMemory`, `NeedScore`,
`NeedsAssessmentState`, `Person`, `Insight`, `RecurringTheme`, `GratitudeEntry`,
`GratitudePreferences`, `MeditationSession`, `MeditationStats`, `MeditationFavorite`,
`MeditationPreferences`, `SavedMeditation`, and the per-user `Tending*` tables. **Retained rather
than deleted:** `RelationshipMember`, `Invitation`, `StrategyProposal`, and every delivered row.
**[R]** — the delete-versus-retain split is a product judgement per table and needs one pass before
W4b.

**Deliberately not added:** `PersonMention.userId` (moderate weight, deferred),
`Stage4NeedDeclination.needId` (integrity only), `PersonMention.sourceId` and
`ConsentRecord.targetId` (genuinely polymorphic, un-FK-able by design), and the 10 array-of-IDs
columns (`work-kpkq.15`).

### 6.4 Indexes added

Only the ones this design requires. The 25 pre-existing unindexed FKs are **out of scope**
(`work-kpkq.15`) — but an FK without a supporting index forces a sequential scan and holds locks on
every parent delete, so each *new* FK ships with its index. That is completion, not scope creep.

| Index | Purpose |
|---|---|
| `"Invitation_acceptedByUserId_idx"` | supports the new FK and the `Invitation_select` policy arm |
| `"ReconcilerResult_guesserId_idx"`, `"ReconcilerResult_subjectId_idx"` | support the new FKs and both policy arms |
| `"ReconcilerShareOffer_userId_idx"`, `"Stage4NeedDeclination_userId_idx"`, `"PreSessionMessage_userId_idx"` | new FKs + Shape A policies |
| `"Stage4ProposalRevision_sessionId_idx"` | new FK + Shape C policy |
| `"ReconcilerGuidance_resultId_idx"` | new FK on the D8a split table; also the join back to `ReconcilerResult`. **[R]** |
| `"UserKey_userId_idx"`, `"SessionKey_sessionId_idx"` | new FKs + the Shape A / Shape C policies on the two W13 key tables. **[R]** |

`Message` already has `@@index([forUserId])` and `@@index([senderId])` [C], which is exactly what
`Message_select`'s two arms need. **[V]** With 50,005 rows a policy-filtered paged read planned as
`Limit → Index Scan`, with the membership check hoisted into a hashed SubPlan evaluated once —
because `app.current_user_id()` is `STABLE`. **[R]** Not production-shaped data; re-measure.

---

## 7. Structural assertions

Six queries. Each must return **zero rows**. They run in CI against every environment and they are
the cheapest control in this design — assertion 1 alone would have caught the entire 2026-03 RLS
failure on the day it shipped.

| # | Asserts | Query | Catches |
|---|---|---|---|
| 1 | the app role neither is superuser nor bypasses RLS | `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user` | **[V]** the exact 2026-03 failure; also "someone pointed the app at `DATABASE_URL`" |
| 2 | every non-exempt table has RLS **and** `FORCE` | `pg_class` where `NOT (relrowsecurity AND relforcerowsecurity)`, excluding the four in §1.1 | a new table added without a policy; **[V]** `FORCE` omitted |
| 3 | no RLS table lacks a policy | `pg_class` ⟕ `pg_policy` | a table left in permanent deny (loud, but should be deliberate) |
| 4 | `mwf_app` holds no `TRUNCATE` | `information_schema.role_table_grants` | **[V]** `TRUNCATE` ignores RLS entirely |
| 5 | no authorization column is `UPDATE`-grantable to `mwf_app` | `information_schema.column_privileges` | **[V]** T7 re-routing |
| 6 | every `app.*` `SECURITY DEFINER` pins `search_path` and is not `PUBLIC`-executable | `pg_proc` where `prosecdef` | search-path takeover on the most privileged objects here |
| **7** | **every column a `SELECT` policy reads is write-controlled on *both* the INSERT and the UPDATE side** — see §7.1 for the SQL | `pg_depend` policy→column refs, joined against `polwithcheck` per command and against `information_schema.column_privileges` | **[V] M1** — fires on the vulnerable config, silent on the fixed one |
| **8** | `mwf_job` carries non-removable audit logging | `SELECT rolconfig FROM pg_roles WHERE rolname='mwf_job'` must contain `log_statement=all` **and** `log_parameter_max_length=0` | **[V]** an RLS-bypassing role whose statements are not logged; and logging that captures bind values |
| **9** | **`mwf_app` is a member of no role** | `SELECT roleid::regrole FROM pg_auth_members WHERE member = 'mwf_app'::regrole` | **[V] total boundary collapse from one grant.** Permissive policies are inherited through role membership where `BYPASSRLS` is not: `GRANT mwf_job TO mwf_app` took an **outsider identity** from 1 row to 2 of 2. Branch A (§2.4) is built on permissive policies, so this grant is the shortcut somebody will reach for. |
| **10** | every table `mwf_job` holds a command grant on has a policy for that command | `role_table_grants` ⟕ `pg_policy` for `mwf_job` | a table added by a later migration is silently uncovered — the retention sweep then deletes nothing and logs success |
| **11** | every `app.*` `SECURITY DEFINER` function has the expected owner | `SELECT proname, proowner::regrole FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.prosecdef` compared against a declared manifest | **[V] the draft-5 class.** An owner-owned transition function under `FORCE` raises `no such attempt` on every call; a job-owned one under branch A is equally inert. Ownership is the security property and nothing else checks it. |
| **12** | **no FK referencing `User` has a delete rule other than `RESTRICT`** | `SELECT conrelid::regclass, conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND confrelid = '"User"'::regclass AND confdeltype <> 'r'` | the D9 uniform rule (§6.3a). 39 existing FKs are rebuilt; a later migration that adds a `User` FK with Prisma's default `CASCADE` reintroduces a hidden writer and a delete path through the privacy boundary. **[R]** |

Assertion 7 is the important addition. Assertions 1–6 check that objects *exist and are shaped
right*; 7 checks a **relationship between two object classes**, which is where both of draft 2's
new defects lived. A design that only asserts per-object properties will keep producing M1s.

### 7.1 Assertion 7 — the actual SQL

Draft 3 specified this in prose, said the SQL was in the design document's §11.2, and **the SQL was
never written**. Worse, the prose rule was wrong in both directions: *"pinned by `WITH CHECK` **or**
absent from UPDATE grants"* is satisfied by "not UPDATE-granted" while the M1 hole is on the
**INSERT** side, so implemented literally it **green-lights the exact defect it was added for** —
review confirmed this by running it. And it fires on the sanctioned `ConsentedContent.consentActive`
exception, which is permanent CI red.

Respecified **per-command and conjunctive**, with a registry for the two legitimate exception kinds.

**Draft 4's version was wrong three ways, all confirmed by execution, and it passed an M1.** The
fixes are inline below and each was re-tested:

1. **The `pg_depend` join attributed columns to the policy's table rather than the referenced one**,
   producing entries like `Session.userId` — a column `Session` does not have. Fixed with
   `AND d.refobjid = p.polrelid`.
2. **The pin test was `chk LIKE '%'||col||'%'`, so any *mention* counted.**
   `WITH CHECK ("sourceUserId" IS NOT NULL AND <membership>)` passed the assertion while the M1
   forge succeeded. Replaced with an equality-shape test requiring the column to be equated to the
   caller identity.
3. **The "zero rows on the fixed config" claim was false** — the view returned `EmpathyAttempt.status`
   and four more, because the waivers the fixed config actually needs were never registered.

**[V] Re-tested in four configurations after the fix:**

| Configuration | Expected | Result |
|---|---|---|
| Vulnerable (`WITH CHECK (<membership only>)`) | fires | `ea.sourceUserId` ✓ |
| **The evasion** (`WITH CHECK ("sourceUserId" IS NOT NULL AND …)`) | **fires** | `ea.sourceUserId` ✓ — draft 4 passed this |
| Correctly pinned, waivers registered | zero rows | zero rows ✓ |
| Attribution check: any reported column its table lacks? | none | none ✓ |

```sql
-- Exceptions are data, not code, and each carries a written reason. A column may
-- need a waiver on one side, the other, or both -- the first cut of this table
-- allowed only one kind per column and could not express ConsentedContent.consentActive,
-- which is author-derived on INSERT and trigger-pinned on UPDATE.
CREATE TABLE app.write_control_exception (
  table_name          text NOT NULL,
  column_name         text NOT NULL,
  waive_insert_reason text NULL CHECK (length(waive_insert_reason) >= 20),
  waive_update_reason text NULL CHECK (length(waive_update_reason) >= 20),
  CHECK (coalesce(waive_insert_reason, waive_update_reason) IS NOT NULL),
  PRIMARY KEY (table_name, column_name)
);

CREATE VIEW app.assertion_7 AS
-- Column references come from pg_depend, not from parsing policy text: a policy
-- expression records a dependency on every column it reads, so this cannot miss one.
WITH pol AS (
  SELECT p.polrelid, p.polcmd, c.relname AS tbl, a.attname AS col,
         p.polwithcheck IS NOT NULL                          AS has_check,
         coalesce(pg_get_expr(p.polwithcheck, p.polrelid),'') AS chk
  FROM pg_policy p
  JOIN pg_depend d  ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
                   AND d.refobjid = p.polrelid   -- FIX 1: this table's own columns only
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
  JOIN pg_class c   ON c.oid = p.polrelid
),
sel  AS (SELECT DISTINCT tbl, col, polrelid FROM pol WHERE polcmd IN ('r','*')),
-- FIX 2: equality-shape, not substring. The column must be EQUATED to the caller
-- identity. "col IS NOT NULL" and bare mentions no longer count as a pin -- that
-- evasion passed draft 4's assertion while the M1 forge succeeded.
ipin AS (SELECT DISTINCT polrelid, col FROM pol WHERE polcmd IN ('a','*')
          AND chk ~ ('"'||col||'"[[:space:]]*=[[:space:]]*(app\.)?current_user_id\(\)')),
upin AS (SELECT DISTINCT polrelid, col FROM pol WHERE polcmd IN ('w','*')
          AND chk ~ ('"'||col||'"[[:space:]]*=[[:space:]]*(app\.)?current_user_id\(\)')),
gr   AS (SELECT table_name tbl, column_name col FROM information_schema.column_privileges
          WHERE grantee = 'mwf_app' AND privilege_type = 'UPDATE'),
ig   AS (SELECT table_name tbl FROM information_schema.role_table_grants
          WHERE grantee = 'mwf_app' AND privilege_type = 'INSERT')
SELECT s.tbl, s.col, v.violation
FROM sel s
CROSS JOIN LATERAL (VALUES (
  CASE
    -- INSERT side: the column must be constrained when the row is created,
    -- unless mwf_app cannot INSERT at all, or a waiver explains why the row's
    -- pinned author column already makes this column safe.
    WHEN NOT ( EXISTS (SELECT 1 FROM ipin i WHERE i.polrelid = s.polrelid AND i.col = s.col)
            OR NOT EXISTS (SELECT 1 FROM ig WHERE ig.tbl = s.tbl)
            OR EXISTS (SELECT 1 FROM app.write_control_exception e
                        WHERE e.table_name = s.tbl AND e.column_name = s.col
                          AND e.waive_insert_reason IS NOT NULL) )
      THEN 'INSERT: read-policy column not pinned by the INSERT WITH CHECK'
    -- UPDATE side: not grantable, or pinned by the UPDATE WITH CHECK, or
    -- direction-pinned by a trigger with a written reason.
    WHEN NOT ( NOT EXISTS (SELECT 1 FROM gr WHERE gr.tbl = s.tbl AND gr.col = s.col)
            OR EXISTS (SELECT 1 FROM upin u WHERE u.polrelid = s.polrelid AND u.col = s.col)
            OR EXISTS (SELECT 1 FROM app.write_control_exception e
                        WHERE e.table_name = s.tbl AND e.column_name = s.col
                          AND e.waive_update_reason IS NOT NULL) )
      THEN 'UPDATE: read-policy column is UPDATE-granted but not pinned'
  END)) AS v(violation)
WHERE v.violation IS NOT NULL;
```

**[V] Tested in three configurations**, which is the only reason to trust it:

| Configuration | Expected | Result |
|---|---|---|
| Draft-2 vulnerable config, with the M1 forge confirmed working | **fires** | `EmpathyAttempt.sourceUserId → INSERT: not pinned` ✓ (the review's `OR` version returned zero rows here) |
| Sanctioned exception `ConsentedContent.consentActive`, both waivers registered | silent | silent ✓ — no permanent CI red |
| Draft-3 fixed config, exceptions registered | zero rows | zero rows ✓ |

**Four blind spots, stated because an assertion nobody understands the limits of is the next M1:**

1. **Function ownership is not asserted anywhere.** The draft-5 failure class is effective-principal
   confusion, and nothing in this catalogue checks who owns a `SECURITY DEFINER` function. Assertion
   11 below closes it.
2. **A column protected only by a `SECURITY DEFINER` helper records no `pg_depend` entry**, so it is
   invisible to a source this section otherwise describes as exhaustive. `EmpathyAttempt.status` is
   the live example: its real protection is `app.empathy_set_status`, not a policy, and the
   assertion sees only the waiver.
3. The regex is a *shape* test on generated expression text. It is far stronger than the substring
   test it replaces, but it recognises one idiom; a semantically equivalent pin written differently
   (say `app.current_user_id() = "col"`) would be reported as a violation and need a waiver.
4. The registry is hand-maintained. `length(reason) >= 20` forces a sentence, not a rubber stamp —
   it cannot force a *true* sentence.

Full SQL is in [§11.2 of the design document](./phase3-security-model.md#112-structural-assertions--the-cheap-high-value-layer).

---

## 8. Golden-harness coverage

`backend/src/testing/golden/` is where "user A cannot read user B's rows" becomes executable rather
than asserted. **It cannot do that today** — its README states that negative-authorization
scenarios cannot fail, because `handleE2EAuthBypass` *mints* an unknown `x-e2e-user-id` rather than
rejecting it [C]. Every claim in this catalogue is a negative-authorization claim, so this gap must
close first.

**Prerequisites**, in order:

1. `E2E_AUTH_BYPASS=strict` — resolve `x-e2e-user-id` against existing `User` rows, return **401**
   if absent. `state-factory` keeps permissive mode for seeding.
2. `eve` in the fixture: a real `User` with **no** `RelationshipMember` row in Ada and Bob's
   relationship. Strict mode authenticates her; RLS denies her. That gap is the test.
3. The app under test connects as `mwf_app`; the harness snapshots as superuser. **Two connection
   strings, and the harness must assert they differ** — otherwise the day someone points the app at
   the superuser URL, every negative test passes for the wrong reason.
4. **The privacy scenario must declare whole-database scope.** `empathy-reveal` already derives its
   scope from `information_schema` — *"Nothing hand-maintained: a table added by a migration is in
   scope the day it exists"* [C, `empathy-reveal.golden.test.ts:62-64`] — while `session-read` is
   scoped to three tables. A policy failure on a table outside a scoped scenario is invisible to
   that scenario, so the new negative-authorization scenario follows `empathy-reveal`'s pattern,
   not `session-read`'s.

   *A correction to the review on this point:* the harness itself does **not** snapshot 41 of 68
   tables. The 41-table list is `backend/snapshots/create-snapshot.ts`, a separate legacy file the
   harness README explicitly criticises as rot [C]; the harness derives its lists from
   `information_schema`. The action is the same, the diagnosis is not.

**Mutation gate.** A harness that cannot fail is worthless — the harness's own standard. Each
mutation applied to real code; the harness must go red.

| Mutation | Caught by | Status |
|---|---|---|
| `ALTER TABLE "Message" DISABLE ROW LEVEL SECURITY` | Eve/Bob row counts | **[R]** |
| `ALTER ROLE mwf_app BYPASSRLS` | structural assertion 1 | **[R]** |
| `DROP POLICY "Message_select"` (RLS still on) | everyone sees 0 — fail closed | **[R]** |
| `USING (true)` on `Message_select` | Eve sees Ada's rows | **[R]** |
| Drop the `senderId = me` arm | `reconciler.ts:901` branch flips [C] | **[R]** |
| `GRANT UPDATE ("forUserId")` to `mwf_app` | the T7 re-route succeeds | **[V]** the attack; **[R]** the harness catching it |
| `DROP CONSTRAINT "Message_ai_authorship_ck"` | forged AI insert persists | **[V]** the attack; **[R]** the harness |
| `DROP TRIGGER "Message_routing_immutable"` | facilitator content becomes editable | **[V]** the attack; **[R]** the harness |
| Point the app at the superuser URL | structural assertion 1 | **[R]** |

The last one is the one a normal test suite would never catch, and it is the exact shape of the
2026-03 failure.

**Expected churn.** Enabling RLS moves `planNodes` on essentially every traced statement, because
the policy qual joins the plan. Per the harness's own convention — never bulk-regenerate, every
accepted change needs a written reason — the RLS PR re-records deliberately, and the written reason
is the design document.

---

## 9. Summary

| Object class | Count | Verified | Reasoned only |
|---|---|---|---|
| Roles | **4** | 1 mechanism [V] | 3 — **`mwf_analyst` withdrawn as undeployable on Render**, see §2 / §2.3 |
| Tables, total | **71** | 68 generated and asserted [V]; +3 **[R]** | `ReconcilerGuidance` (W9) — counted for the first time in draft 7.1 — plus `UserKey`, `SessionKey` (W13). §1.2 |
| — with RLS enabled + `FORCE` | 69 | mechanism [V] | per-table predicates |
| — without RLS | 2 (`Need`, `GlobalLibraryItem`) | — | rationale only |
| — RLS on, zero policies, grants revoked | 1 (`BrainActivity`, inside the 69) | — | rationale only |
| Functions | **12** | **6 [V]** | 6 — **all `SECURITY DEFINER` owners declared, with the owner's own table grants** (§3). Anonymization functions: **two** (`_in_session`, `_account`); the design doc and this catalogue now agree. |
| Structural assertions | **12** | 5 [V] | 7 — 9 and 11 for the effective-principal class; **12 for the D9 uniform `RESTRICT` rule** (§6.3a) |
| Triggers | **4** | 2 [V] | 2 — exemptions must key on the **job role's name**, not on `BYPASSRLS` [V] |
| CHECK constraints | 7 | 1 [V] | 6 |
| NOT NULL changes | 1 (`Message.forUserId`; the new `User.deletedAt` is nullable) | mechanism [V18] | **unblocked — D9 is soft delete, so `NOT NULL` stands** |
| Foreign keys | **11 added, 39 changed** | 1 [V] | the rest — the added eleventh is `ReconcilerGuidance.resultId`. D9's uniform rule: **every** FK referencing `User` is `ON DELETE RESTRICT`, 33 from `CASCADE` and 6 from `SET NULL` [C] (§6.3a), rebuilt at **W4b**, enforced by assertion 12 |
| Indexes | 10 | — | 10 |
| Policies | **~271** = 4 commands × 66 ordinary tables + 2 commands × the 2 key tables (`SELECT`, `INSERT` only) + `BrainActivity` (0) = 69 RLS tables, plus 3 extra arms — and separately the per-table `USING (true)` policies for `mwf_job`/`mwf_ops` (§2.4) | 5 [V] | the rest |

The policy count is now derived from the table count rather than asserted: the first draft's
"~180 (4 cmds × 45 tables)" reconciled with neither 65 nor 68, because it silently assumed ~21
tables would get `_select` only — which §5.2 now shows is unsafe.

**Five objects are wrong, unsafe, or unbuilt as drafted.** Marked rather than quietly corrected:

- `User_covisible` + column grants (§2.2) — **does not achieve column-scoped partner visibility.**
  Postgres has no per-policy column scoping. Superseded in the design summary by
  `app.partner_display_name()`, a `SECURITY DEFINER` name lookup; the §2.2, §3
  (`shares_relationship_with`) and §5 entries still show the superseded draft and are rewritten
  with the DDL.
- `app.create_user_for_clerk` (§3) — the only `SECURITY DEFINER` function that writes. Needs its
  own adversarial review before it is built.
- `mwf_analyst` (§2, §2.3) — **withdrawn.** `REVOKE SET ON PARAMETER` is a no-op on PG16 and PG18
  [V]; the working alternative (`PGC_SUSET` via a C extension) cannot be installed on Render *and*
  could not be granted even if it were. T3 has no in-database mitigation on Render.
- `ALTER ROLE mwf_job SET log_statement` (§2) — **works locally, fails on Render** [V]. `SUSET`
  parameters need superuser and Render grants none. The `mwf_job` residual is unauditable in
  production without a Render support ticket.
- **The two anonymization functions and `app.partner_user_id` are specified, not built** — and
  the draft-5 lesson is that a specified privileged object is where the next defect lives. Each
  needs the "who is `current_user` on this line" audit before it ships.

**Closed by the owner's decisions of 2026-09-04:**

- `Message.forUserId` **`NOT NULL` and FK** (§6.2, §6.3) — **D9 is soft delete**, so the `User` row
  is never removed, the FK is `ON DELETE RESTRICT`, and `NOT NULL` stands. All 39 existing `User`
  FKs move to `RESTRICT` with it (§6.3a), which removes the §4 hidden-writer case entirely and
  hands the private-only deletes to `app.anonymize_user_account`.
- The **role table's branch-dependence on D0** (§2) — **branch A, unconditionally** (§2.4).
  `mwf_job` and `mwf_ops` are RLS subjects with per-table `USING (true)` policies, and `mwf_app`
  never holds `BYPASSRLS` even in the W8–W10 interim. Nothing in the design forks on
  `rolbypassrls`; the query survives for its `rolsuper` half.

**New and unbuilt, from the same decisions:** `UserKey` and `SessionKey` (§1.2, §6.3, design §8.6)
— **[R]** in every respect. They key ownership on `userId` / `sessionId` precisely so §1.3's
classifier reaches them as Shape A and Shape C without a special case.

**Closed since draft 5**, for the record: `Message_routing_immutable` vs `session-deletion.ts:95`
— all three triggers carry the `current_user IN ('mwf_job', 'mwf_migrator')` arm (§4) ·
`StrategyProposal.createdByUserId` — now on the never-`UPDATE`-grantable list (§2.1) · the
`READY` widening — replaced by the two-set transition function, re-verified against all nine
writers (design §4.3, draft 6) · the referential-action audit of `consent_no_resurrect` and
`empathy_attempt_immutable` — enumerated, both `onDelete: SetNull` into a pinned column, both
exempted (§4).

---

## Related

- [Phase 3 — Database Security Model](./phase3-security-model.md) — threat model, decisions, breakage, sequencing, target-state ERDs
- [ERD — Current State (As-Is)](./erd-current.md) — the "before" picture
- [Database Schema Audit](./schema-audit.md) — the ground truth
- Issues: `work-a39h.3`, `work-kpkq.2`, `work-kpkq.4`, `work-kpkq.8`, `work-kpkq.15`
