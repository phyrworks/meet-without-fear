# Phase 3 — Database Security Model: the design in one page

This is the *what* and the *why*, stripped of revision history and argument. For evidence and
alternatives, follow the `→ model §n` / `→ cat §n` pointers into
[`phase3-security-model.md`](./phase3-security-model.md) and
[`phase3-security-catalogue.md`](./phase3-security-catalogue.md). As-is picture:
[`erd-current.md`](./erd-current.md). Code pointers are `backend/src/…` unless noted.

**Status.** Architecture approved after five adversarial passes; the four open decisions were
**approved 2026-09-04** — branch A, soft delete, launch encrypted with per-vessel envelope keys,
vectors encrypted (§9). Nothing applied. Awaiting the D0 check query before W1.

---

## 0. The shape of it

```
request ──► mwf_app connects (non-owner)
            BEGIN; SET LOCAL app.current_user_id = <User.id from verified JWT>;
                     │
                     ▼
            RLS policies (68 tables, FORCEd)      ← who may SEE / INSERT / UPDATE / DELETE which rows
            column-level UPDATE grants            ← which columns may change at all
            BEFORE UPDATE triggers (3)            ← which transitions are legal
            SECURITY DEFINER functions (owned by mwf_job)
                                                  ← the few writes RLS cannot express
            CHECK constraints (7), FKs (+10, 39 re-ruled), NOT NULL (+1)
```

Today the database has **zero** of every row above the last one: no non-owner role, no RLS, no
column grants, no triggers, no CHECKs (`erd-current.md` §3, §5). The backend is the only control.

---

## 1. Identity: how "who is asking" reaches a query

| | Now | Proposed | Why | Where |
|---|---|---|---|---|
| Connection role | one role, table owner, superuser locally | app connects as **`mwf_app`**, a non-owner with `FORCE` RLS applied | RLS never binds the owner without `FORCE`; the previous RLS attempt was inert for exactly this reason | `lib/prisma.ts` (singleton) · `render.yaml:8` · → model §2.4 |
| Per-request identity | none; every query is anonymous to Postgres | `SET LOCAL app.current_user_id` as the **first statement after `BEGIN`** | fail-closed: unset ⇒ every policy compares to NULL ⇒ zero rows. Plain `SET` leaks across pooled connections (measured) | → model §2.1–2.2 |
| Who sets it | — | the Phase 4 `pg` data layer (D1-c). Prisma cannot: ~700 bare calls hit arbitrary pooled connections | no hook exists to run `SET LOCAL` before a given Prisma query | → model §2.3 |
| Interim | — | policies ship **enabled** with `USING (true)` **placeholder** predicates, replaced per tier when Phase 4 lands. `mwf_app` never holds `BYPASSRLS` | same least-privilege reason as D0: per table, visible in `pg_policies`, revertible per tier | → model §9.1 |

**Roles** (→ cat §2): `mwf_migrator` (owner, runs migrations) · `mwf_app` (HTTP, RLS subject) ·
`mwf_job` (retention/tending + the two-party reveal paths; `USING (true)` on the tables it touches) ·
`mwf_ops` (`/api/brain/*`, `SELECT` only; `USING (true)` on reporting tables, never vessel tables) ·
`mwf_auth` (first-login user creation only). `mwf_analyst` **withdrawn** — a
placeholder GUC cannot be locked to a role on PG16 or PG18, and the fix (a C extension) can't run on Render.

**D0 check.** **Branch A unconditionally**, on least privilege: `BYPASSRLS` is all-or-nothing
across 70 tables and invisible in the schema, while per-table `USING (true)` policies are strictly
less privilege, scopable and greppable. Branch B — grant the attribute — is rejected, not deferred,
and the same rule covers `mwf_app`'s interim (row 4 above). **Nothing forks on `rolbypassrls`.**
The query stays as a **check**: `rolsuper` must be **false**, or `FORCE` does not bind the owner and
T4 is wrong; and a **true** `rolbypassrls` means the Render root credential bypasses RLS and must
live only in the migration step. → model §1 T4, §9 W1a.

---

## 2. Row-level security — 68 of 70 tables

| | Now | Proposed | Why | Where |
|---|---|---|---|---|
| Coverage | 0 policies | `ENABLE` + `FORCE` on 68 tables; **four policies per table** (SELECT/INSERT/UPDATE/DELETE), never `ALL`, always `TO mwf_app` | a table with a SELECT policy and no UPDATE policy returns `UPDATE 0` **silently** — partial coverage is silent write loss, not safety | → cat §5.2 |
| Inventory | — | classified **from `pg_catalog`** into shapes; CI asserts it still sums to 70 | three hand-kept lists disagreed and lost `Relationship` | → cat §1.2–1.3 |
| Predicates | — | inline `EXISTS` for self-checks; helper functions only where the check is about the *partner* | helper is 8× slower (can't be inlined); inline subquery on a partner row is silently double-filtered by that table's own policy | → model §7.9, §3.3 |
| Exempt | — | `Need`, `GlobalLibraryItem` (global reference, `SELECT` only). `BrainActivity`: RLS on, **no policies, all `mwf_app` grants revoked** | full LLM prompts, no owning user; written from paths with no identity | → cat §1.1 |

**Shape templates** (→ cat §1.2): A `userId` (20, incl. `UserKey`) · B `userId`+`sessionId` (16,
same predicate) · C `sessionId` only (17, incl. `SessionKey`; session membership) · D/D2 hop to
parent owner (12) · E `Session` via `relationshipId` · F no owner column (4, bespoke).

**Nine bespoke tables** — where the template would be *wider than the product* (→ model §4.3, cat §5.1):

| Table | Read predicate | Why not the template |
|---|---|---|
| `Message` | `forUserId = me OR senderId = me` | both partners are members; membership ≠ audience |
| `EmpathyAttempt` | `sourceUserId = me OR (member AND status IN ('REVEALED','VALIDATED'))` | app hides it in 5 other statuses — `empathy-status.ts:234` |
| `ConsentedContent` | `consentActive AND <member via SharedVessel>`; author sees own regardless | revocation must mean something — `consent.ts:224` |
| `ReconcilerResult` | `subjectId = me` **only** | guesser arm can't be column-scoped; gap detail is the subject's private material |
| `ReconcilerGuidance` *(new)* | `guesserId = me OR subjectId = me` | the 3 schema-labelled "no partner content" columns, split out (D8a) |
| `Invitation` | inviter OR **`acceptedByUserId` = me** OR member | invitee isn't a member yet when the row exists |
| `ConsentRecord` | `userId = me OR requestedByUserId = me` | two parties, nullable `sessionId` |
| `User` | own row; partner's **name only** via `app.partner_display_name()` | a co-member row policy would leak `email`, `pushToken`, `globalFacts` |
| `Relationship` | `EXISTS my RelationshipMember row` | root of every membership check; no owner column |

**Write side rule** (→ cat §5.1a): *a read policy that trusts a column requires a write policy that
pins it.* Every bespoke table gets author-pinned `WITH CHECK`; CI assertion 7 checks the pairing.

---

## 3. The `forUserId` boundary — the privacy column

| | Now | Proposed | Why | Where |
|---|---|---|---|---|
| Type | `text NULL`, no FK, never client-supplied | `NOT NULL` + `FK → User` | it is the column deciding which partner sees a row; today nothing enforces it | `prisma/schema.prisma` Message · → model §3 |
| NULL rows | `USER`-role messages from the send path | backfill `forUserId = senderId`; then `NOT NULL … NOT VALID` (**PG18 only**) | `IS NULL` means "my own typed message" — say so in the schema | `stream-turn-admission.ts:159` · → model §3.1–3.2 |
| Delete rule | — | `ON DELETE RESTRICT` | **D9 is soft delete**: the `User` row is scrubbed into a tombstone and never removed, so no referential action on it can ever fire. `NOT NULL` stands | → model §10 D9 |

---

## 4. Column grants + triggers — what RLS cannot see

RLS policies never see the OLD row, so they cannot stop a member flipping `forUserId` on their own
row to the partner (verified). → model §1 T7.

| | Now | Proposed | Why | Where |
|---|---|---|---|---|
| `UPDATE` privilege | table-wide | `REVOKE UPDATE`, re-grant **per column**; authorization columns never grantable (`forUserId`, `senderId`, `userId`, `sessionId`, `role`, `sourceUserId`, `status` on EmpathyAttempt, `guesserId`/`subjectId`, all PKs …) | stops re-routing at the privilege layer | → cat §2.1 |
| `Message` trigger | none | `BEFORE UPDATE`: routing columns immutable; `AI`/`SYSTEM` content immutable | durable half of `work-kpkq.4` (forged facilitator speech); survives a stray `GRANT ALL` | → cat §4 |
| `ConsentedContent` trigger | none | `consentActive` may go `true→false` only; `sourceUserId` immutable | revocation must be terminal | → cat §4 |
| `EmpathyAttempt` trigger | none | `sourceUserId`/`sessionId` immutable; disclosing statuses only via `mwf_job` | defence in depth behind the grants | → cat §4 |
| Exemption arm | — | `current_user IN ('mwf_job','mwf_migrator')` in all three | kept as defence in depth — the anonymisation functions are `SECURITY DEFINER` owned by `mwf_job`. The FK-fires-as-owner hazard is **gone**: every FK to `User` becomes `RESTRICT` and a `User` row is never hard-deleted | `schema.prisma:531,649,747` · → cat §4, §6.3a |

---

## 5. Functions — the writes RLS cannot express

All `SECURITY DEFINER` functions: owned by `mwf_job`, `search_path` pinned, `EXECUTE` revoked from
`PUBLIC`, scalar return, **bound to the caller's identity** (no free user arguments — a free-arity
`is_member(rel, user)` was a who-is-in-conflict-with-whom oracle). → cat §3, §3.1.

| Function | Purpose | Replaces / called from |
|---|---|---|
| `app.current_user_id()` (INVOKER) | reads the GUC; NULL when unset | every policy |
| `app.is_member(rel)`, `app.is_co_member(rel, other)`, `app.session_relationship(session)` | membership checks that must see the partner's row | `Message_insert`, `Invitation_select` |
| `app.partner_user_id(session)` | "who is my partner" — NULL unless caller is a member | `session-deletion.ts:40`, `account-deletion.ts:77` (both break under RLS otherwise) |
| `app.empathy_set_status(id, status)` | **the only writer of `EmpathyAttempt.status`**; rule: *a non-author may never move a row into a disclosing state*; locked (`FOR UPDATE`), idempotent | 6 in-request writers in `stage2.ts` (`:768,:1147,:1161,:1396,:2066`) + `reconciler.ts:960`; 3 system writers go to `mwf_job` (`state.ts:91,:325`, `stage2.ts:148/:211`) |
| `app.anonymize_user_in_session(session, user)`, `app.anonymize_user_account(user)` | under D9 they **scrub PII into the `User` tombstone and hard-delete the leaver's private-only rows**; they no longer null author columns on delivered rows. Still privileged, because scrubbing removes ownership and every `WITH CHECK (col = me)` rejects that by construction; self-only check inside | `session-deletion.ts:95,:147,:153,:183,:192` · `account-deletion.ts` |
| `app.resolve_user_by_clerk_id`, `app.create_user_for_clerk` | pre-identity bootstrap; the latter is `INSERT`-only and granted to **`mwf_auth`** only | `middleware/auth.ts:177,:212` |
| `app.partner_display_name(user)` | partner's name without the rest of `User` | replaces the broken co-visible policy |

---

## 6. Constraints and keys

**CHECK (7)** → cat §6.1 — none exist today:

| Constraint | Invariant | Fixes |
|---|---|---|
| `Message`: `role NOT IN ('AI','SYSTEM') OR senderId IS NULL` | humans can't author as the facilitator. One-directional: `senderId IS NULL` ≠ AI (anonymised rows) | `work-kpkq.4` |
| `ConsentRecord`: `(decision IS NULL) = (decidedAt IS NULL)` | decisions are dated | audit |
| `ConsentedContent`: `revokedAt >= consentedAt`; `consentActive OR revokedAt IS NOT NULL` | revocation ordering and attribution | audit |
| `ReconcilerResult`: `guesserId <> subjectId` | parameter-swap guard | reconciler |
| `Invitation`: `status <> 'ACCEPTED' OR acceptedAt IS NOT NULL` | acceptance is recorded. Under D9 `acceptedByUserId` is `RESTRICT` and never nulled, so the split is now belt-and-braces rather than forced | `work-kpkq.2` |
| `RelationshipMember`: `role IN ('member','owner')` | free text is an authz primitive with no domain | latent |

**Prerequisite:** the API error handler must strip `PostgresError.detail` first — a CHECK
violation echoes the **whole row** to client and log for any role that isn't RLS-bound, which is
`mwf_app` until enforcement. → model §5.2.

**FKs: +10, and 39 rules changed** → cat §6.3, §6.3a. Added: `Message.forUserId` ·
`ReconcilerResult.guesserId/subjectId` · `ReconcilerShareOffer.userId` ·
`Stage4NeedDeclination.userId` · `PreSessionMessage.userId` · `Invitation.acceptedByUserId` (new
column) · `UserKey.userId` — all `RESTRICT`; plus `Stage4ProposalRevision.sessionId` (`CASCADE`) and
`SessionKey.sessionId` (`CASCADE` — sessions are hard-deleted by retention and their content goes with them). Each ships with its index. Why: an RLS arm pointing at a
deleted user is a row nobody can read and nothing removes.

**The uniform rule** (→ model §10 D9): *every FK referencing `"User"(id)` is `ON DELETE RESTRICT` —
no exceptions.* A `User` row is never hard-deleted, so every referential action on it is dead code
and a hidden writer. **[C]** 39 existing FKs are rebuilt — 33 `CASCADE`, 6 `SET NULL`; cat §6.3a
lists each, structural assertion 12 enforces it. Consequence: `account-deletion.ts` cascades
nothing any more, so `app.anonymize_user_account` deletes the private-only rows explicitly.

**New column:** `Invitation.acceptedByUserId` + `acceptedAt`. Makes `work-kpkq.2` (any
authenticated non-inviter gets session access via the invitation fallback) structurally impossible;
the fallback in `middleware/auth.ts:317` is then deleted. → model §6.2.

**New tables (3):** `ReconcilerGuidance` (`areaHint`, `guidanceType`, `promptSeed`) split from
`ReconcilerResult` — fixes two of the three live leaks in `work-kpkq.16`; the third
(`GET /reconciler/summary`, LLM synthesis of both partners' text) is a code fix (→ model §4.3). And
the two envelope-key tables `UserKey` (`userId`) / `SessionKey` (`sessionId`), each with `keyId`,
`wrappedDek`, `createdAt`, `destroyedAt` — **[R]**, → model §8.6, cat §1.2. Owner columns are named
so the shape classifier reaches them as A and C. They take the table count from 68 to 70.

---

## 7. What the application must change

Database-first still leaves these on the backend. Nothing here is optional.

| Change | Where | When |
|---|---|---|
| Set `forUserId` on every `Message.create` (5 sites) + CI guard | `stream-turn-admission.ts:159`, `scripts/mwf-moment-real.ts` ×4 | **W6a — before W7 or sending 500s** |
| Strip `PostgresError.detail` from API errors | error middleware | before first CHECK (W3) |
| Split `DATABASE_URL` → `APP_DATABASE_URL`, `JOB_DATABASE_URL`, `OPS_…`, `AUTH_…` | `lib/prisma.ts`, `render.yaml`, `routes/brain.ts` | W0/W1 |
| Two-party paths run as `mwf_job`: reveal, share-accept, 6 both-partner `StageProgress` writes, 3 status writers | `state.ts:393`, `sharing.ts:1005`, `stage2.ts:1721–1753`, `stage3.ts:981–994`, `sessions.ts:474`, `stage4.ts:1476,2326`, `stage4-auto-closure.service.ts:182` | W4a / W10 |
| 9 status writers → `app.empathy_set_status` / `mwf_job` | see §5 | W4a |
| Account deletion → **`User` tombstone** (scrub name/email/clerkId/pushToken/globalFacts/biometric/preferences, set `deletedAt`) + destroy the wrapped DEK; **explicit** deletes of the private-only rows, since no `User` cascade fires any more; session anonymisation stops nulling `senderId`; partner lookup → `app.partner_user_id` | `session-deletion.ts:95`, `account-deletion.ts:116-160` | W4b |
| Delete the invitation fallback in `requireSessionAccess` | `middleware/auth.ts:317` | W6 |
| `ReconcilerGuidance` split: 4 read sites repoint, 1 deleted, summary endpoint reworked | `stage2.ts:1903`, `empathy-status.ts:89,171`, `stream-turn-context.ts:517`, `state.ts:619` | W9 / `work-kpkq.16` |
| Per-request identity (`BEGIN; SET LOCAL …`) | Phase 4 `pg` layer | **W10 — enforcement cannot precede this** |
| `decrypt()` must **throw**, not return `''`; envelope `enc:v2:<keyId>`; `REQUIRE_FIELD_ENCRYPTION=true` mandatory — the keyless-in-production path is retired | `utils/field-encryption.ts:113`, `server.ts:64` | **W13, in Phase 3** |
| Vectors: `enc:v2` blobs under the owner's key; drop the `vector(1024)` columns and the `<=>` SQL; cosine similarity in memory | `services/embedding.ts` | W13 |
| The other four W13 prerequisites: extend `SENSITIVE_FIELD_MAP` past its 9 models (start with `BrainActivity.input/output`, and give `BrainActivity` a short retention regardless) · hash column for the two content-equality dedupe probes · prompt debugging via a developer script reading **through the application**, never a DB browser · resumable re-encryption/backfill job | `utils/field-encryption.ts`, `stage2.ts:1293`, `stage4.ts:1030`, new script + job | W13 |
| Audit 19 `$queryRaw`/`$executeRaw` sites | `services/embedding.ts` (9) et al. | W10 |

---

## 8. Rollout order (→ model §9)

| Step | What | Gate |
|---|---|---|
| **W0** | run the **D0 check** (`SELECT rolsuper, rolbypassrls …`) on Render; split connection URLs | — |
| W1 (+W1a) | roles, grants, column `UPDATE` grants; `USING (true)` for job/ops (branch A) | **D0 check returned `rolsuper=false`** |
| W2 | `app.*` helpers | W1 |
| W3 | CHECKs | **error-path fix first** |
| W4 / W4a / W4b | triggers; transition function; anonymisation functions | W3, W1a |
| W5, W6, W6a | FKs + indexes; `Invitation.acceptedByUserId`; `forUserId` write-path fix; **all 39 `User` FKs → `RESTRICT`** | — |
| W7 | `forUserId` backfill → NOT NULL → FK (`RESTRICT`) | **PG18, W6a soaked** |
| W8, W9 | enable+force RLS on all 70; Tier 1–4 policies as `USING (true)` placeholders | W2, W7 |
| W10 | enforcement **per tier** (`USING (true)` placeholders → real predicates), with shadow-mode row-count comparison as an outage detector | **Phase 4 identity** |
| W13 | encryption: envelope keys (`UserKey`/`SessionKey`), field-map extension, encrypted vectors | its six prerequisites in §7 |

~80% (W0–W9, W13) lands against the current Prisma backend. Only W10–W12 need Phase 4. W13 is
inside that 80%: D5 put encryption in Phase 3, not after it.

---

## 9. Decisions (→ model §10.0)

**Decided 2026-09-04** — the four open items, one query and three product calls:

| | Question | Decision |
|---|---|---|
| **D0** | `BYPASSRLS`, or per-table `USING (true)` policies? | **Branch A, unconditionally** — least privilege, for `mwf_job`, `mwf_ops` and `mwf_app`'s interim alike. The query runs as a **check**: `rolsuper` must be false; a true `rolbypassrls` confines the root credential to the migration step. Blocks W1 |
| **D9** | Deleting a user: delete the messages their partner sent them, or keep and unlink? | **Soft delete.** The `User` row becomes a tombstone; the leaver's private-only data hard-deletes; delivered content stays, attributed via the tombstone. `forUserId NOT NULL` stands, and **every** `User` FK becomes `RESTRICT` |
| **D5** | Launch encrypted? | **Yes, in Phase 3** — envelope encryption, KEK in AWS KMS, per-user and per-session DEKs. Six prerequisites (§7) gate W13 |
| **D8** | Embeddings, which survive column encryption as a searchable side channel | **Encrypt the vectors**; cosine similarity moves into the application. No index exists to lose and every search is already single-user-scoped |

Engineering calls, unchanged:

| | Question | Decision |
|---|---|---|
| D1 | identity under a pool | `pg` per-request client in Phase 4; spike `@prisma/adapter-pg` first (½ day) |
| D2 | role count | 4 (+`mwf_auth`) |
| D3 | RLS scope | all enabled, policies in tiers, four commands per table |
| D4 | pgcrypto vs app-side | app-side envelope — pgcrypto's key appears in plans and its index writes plaintext to disk |
| D6 | two-party paths | run as `mwf_job` (required — as `mwf_app` the reveal sees 1 of 2 attempts and never fires) |
| D7 | 404 vs 403 | accept 404, delete the existence probe |
| D8a | `ReconcilerResult` | split out `ReconcilerGuidance` |
| D10 | analyst impersonation on Render | accept; operational controls only |

---

## 10. Deliberately not in this phase (→ model §13)

Junction tables for the 10 array-of-ID columns · 25 pre-existing unindexed FKs · `timestamptz`
migration (144 columns) · `uuidv7` · `Need.id` sequence · the 5 non-security free-text status
columns. All `work-kpkq.15`. (HNSW is no longer listed — D8 removes the `vector` columns.)

## 11. Known residuals

- `mwf_job` bypasses RLS and **cannot be audited on Render** (`log_statement` needs superuser); the CI allowlist of entrypoints carries the whole weight.
- Nothing automated catches a policy that is *too wide*; shadow mode only catches *too narrow*. The safety net is the fixture-based visibility matrix in the golden harness (→ model §11.3), which first needs a strict E2E-bypass mode (`work-a39h.8`).
- `app.create_user_for_clerk` runs pre-identity against two `@unique` columns; the grant boundary is the only control. Needs its own review before it is built.
- Tombstoned users keep their `RelationshipMember` row, so membership predicates still see two members. **[R] — confirm nothing assumes a member row implies a live account.** `account-deletion.ts` cascades those rows away today; `RESTRICT` stops that.
- AI replies addressed to a tombstone stay in the database readable by nobody — no identity can ever be a tombstone id. A `mwf_job` retention job may purge them later.
- Erasure is satisfied by scrubbing identifiers and the person's own private material, plus crypto-shredding their DEK; **retained delivered content needs a sentence in the privacy policy.** The wrapped DEK is in backups taken before the destroy, so the shred is absolute only once those age out (→ model §8.6).
- Three design "failure classes" recur across drafts and are the audit checklist for implementation: read-narrowing without write-pinning · pins that stop the product · **effective-principal confusion** (who is `current_user` on this line, including the principals Postgres supplies).
