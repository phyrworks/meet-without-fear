# Golden-query harness

A differential oracle for the Prisma → hand-written SQL migration (`work-a39h`).
Capture how the system behaves now; assert the replacement behaves identically.

It exists because there is otherwise no safety net: 39 of 81 backend suites mock
Prisma, and before this harness **no test in the repo executed SQL against a real
database**. Only one suite went through Express, and it mocked Prisma too.

## Running it

```bash
# 1. local Postgres must be up (see docs/development/local-setup.md)
# 2. build a fixture template database, once per stage
npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
npx tsx src/testing/golden/cli.ts list

# 3. verify against recorded baselines
npm run test --workspace=backend -- golden

# 4. re-record (never in bulk — see below)
GOLDEN_UPDATE=1 npm run test --workspace=backend -- session-read.golden
```

## How it is put together

| File | Role |
|---|---|
| `db.ts` | Schema-derived introspection, database clone/drop. Uses `pg`, never Prisma. |
| `fixtures.ts` | Seeds a `TargetStage` into a template database; clones per scenario. |
| `snapshot.ts` | Scoped, PK-ordered table snapshots and a row-level diff. |
| `driver.ts` | supertest against the real `app`, with before/after snapshots. |
| `normalize.ts` | Structural id labels; fresh/carried timestamp normalization. |
| `trace.ts` | Parses Postgres's own statement log into a per-step SQL trace. |
| `runner.ts` | Record/verify against `__golden__/*.json`. |

Six decisions carry the design:

**The oracle never queries through Prisma.** If snapshots went through the
implementation under test, a Prisma bug would be invisible — both the recording
and the replay would share it.

**Fixtures are template databases.** `CREATE DATABASE x TEMPLATE y` is
milliseconds and byte-identical. It also sidesteps a real constraint:
`pg_dump --data-only` cannot be restored here, because `InnerWorkSession` and
`InnerWorkMessage` reference each other and no row-insert order satisfies both.

**Fixtures are rebased on restore.** `state-factory` writes
`Invitation.expiresAt = now + 7d` and `auth.ts` gates on `expiresAt > now()`, so
a week-old fixture silently changes meaning. Every restore shifts all timestamps
so the fixture presents at a constant age.

**Timestamps split into fresh and carried.** A stamp written during the run
normalizes to `<ts:fresh>`; a stamp that came from the fixture keeps a full
value-rank. Ranking everything by value tied each rank to how many *distinct*
instants a step contained, and on a write path that count is not stable — see
the third hazard below. The split also states the migration's central risk
outright: a column that should have been written but was not reads as a carried
rank where `<ts:fresh>` was expected.

**Identifiers become structural labels, not placeholders.** `<user:ada>`,
`<message:3>` — derived from each row's natural key. Numbering ids by order of
first appearance would make a swapped-user defect byte-identical, which is a
false pass on exactly the privacy-routing bug this product cannot afford. Any
cuid-shaped token that does not resolve fails the run.

**Each step also records what it asked of Postgres.** HTTP diffing is
structurally blind to cost and to atomicity — two mutations were measured
escaping it entirely (below). A step's trace comes from Postgres's own statement
log, so it needs no code in the application under test and will survive Prisma
being deleted.

## Scenarios

| Scenario | Fixture | Covers |
|---|---|---|
| `session-read` | `FEEL_HEARD_B` | The privacy boundary on reads. `Message.forUserId` is the entire mechanism separating what each partner sees, and the two users see different, overlapping row sets. Scoped to three tables. |
| `empathy-reveal` | `FEEL_HEARD_B` | The write path: Bob drafts and consents, which makes both directions submittable, and the reconciler reveals both attempts from a Serializable transaction *after* the response returns. Whole-database scope. |

A scenario is worth adding when it exercises machinery no existing one does.
`empathy-reveal` was chosen over an easier write because it is the hardest write
in the product to reproduce in SQL by hand — a read-check-write under
Serializable isolation, an `updateMany` with an `increment`, a mutual-reveal
invariant spanning both partners, and fire-and-forget execution.

## Four hazards found by running it, not by reading

**`node-postgres` and naive timestamps.** All 144 timestamp columns are
`timestamp without time zone`. `pg` parses OID 1114 using the *process* timezone
while Prisma writes UTC. Computing the fixture rebase in JavaScript produced an
error exactly equal to the local UTC offset — 7 hours on a PDT machine, and
**zero in CI if CI runs UTC**, which is what makes it dangerous. Fixed by doing
the arithmetic in SQL against `now() AT TIME ZONE 'UTC'` and selecting timestamps
as `::text`. Verified identical under `TZ=UTC` and `TZ=Pacific/Chatham` (+12:45).

**Hand-maintained table lists rot.** `backend/snapshots/create-snapshot.ts`
enumerates 41 tables against a 68-model schema — every `Stage4*` and `Tending*`
table is missing. Fixtures cut that way would restore cleanly and silently lack
their defining state. Every list here comes from `information_schema`.

**Two timestamps a millisecond apart have no reliable order.** The first write
scenario failed 3 runs in 5 with a thirteen-line diff describing no behavioural
change. Cause: `ConsentRecord.decidedAt` (app code calling `new Date()`) and
`ConsentRecord.createdAt` (Prisma resolving `@default(now())` client-side) are
two independent JavaScript millisecond stamps about 1ms apart. When they landed
in the same millisecond, two ranks became one and every later rank shifted.
Keying ranks by occurrence site removed the cascade but not the cause — the
*order* of two stamps a millisecond apart is itself random, and the same
exposure exists between any two rows written back-to-back, such as the two
reveal messages 1ms apart. Hence the fresh/carried split: this run's own writes
are unorderable noise, the fixture's lattice is exact. What that gives up is
equality between any two fields — `revealedAt == deliveredAt` is meaningful and
`decidedAt == createdAt` is a coincidence, and at millisecond resolution they
are indistinguishable. "These columns were written by one statement" belongs to
the SQL trace instead, which now exists and sees the transaction envelope
directly.

**`changesAtResponse` is a race whenever writes outlive the response.**
`consentToShare` fires the reconciler without awaiting it, and the same endpoint
was measured returning with its empathy attempt on `READY` in one run and
`REVEALED` in the next. A step now declares `asyncBoundary: true` and the golden
records that the response-time state is a race rather than freezing one sample
of it as a baseline. The field still means what it always did for synchronous
steps.

## Discrimination results

A harness that cannot fail is worthless, so the acceptance criterion is mutation,
not green tests. Each mutation was applied to the **current Prisma code** and the
harness required to go red.

| Mutation | Result | |
|---|---|---|
| Strip the `forUserId` privacy filter | **caught** | diff named both message-read steps |
| Route reads to the partner (`forUserId: { not: user.id }`) | **caught** | 13 → 10 rows, plus content |
| Reverse result ordering | **caught** | `<message:1>` mismatch at position 0 |
| `orderBy: timestamp` → `orderBy: id` | passed | **true pass** — verified 0 of 23 rows change order, because cuid v1 is k-sortable and messages were created in timestamp order |
| Remove the `take` limit | passed | **real blind spot** — see below |

And against the write path (`empathy-reveal`, the Stage 2 mutual reveal):

| Mutation | Result | |
|---|---|---|
| Remove `statusVersion: { increment: 1 }` from the reveal | **caught** | 3 → 2 at four sites, including both HTTP bodies |
| Remove `revealedAt` from the reveal update | **caught** | `<ts:fresh>` → `null`, and `changedFields` shrank 5 → 4 |
| Route the reveal commentary to the guesser instead of the subject | **caught** | `<user:ada>` where `<user:bob>` was expected — and the scenario's own routing assertion *passed*, because each partner still received exactly one message. Only the golden's content-to-recipient pairing saw it. |
| Move the reveal write outside its Serializable transaction | passed | **real blind spot** — same class as the dropped `take` |

Both blind spots are now covered by the SQL trace (below), confirmed by a
separate mutation-gate pass: all five mutations above go red against it, and two
further ones written for that gate — removing a redundant `session.findFirst`,
and turning a `findMany({ id: { in: … } })` into a per-id loop — produced diffs
confined entirely to `trace.*`, with no HTTP body and no row movement at all.

Both escaped mutations changed no row and no response byte. Removing
`take: limit + 1` fetches every row and the controller slices to the same page,
so `hasMore` computes identically; moving the `updateMany` out of its
transaction writes the same rows in the same order. What changes in the first is
how many rows Postgres read, and in the second the transaction envelope and the
TOCTOU race it exists to prevent. That is the whole class of query-efficiency
and atomicity regression — an N+1, a lost `LIMIT`, a join replaced by a loop, a
silently downgraded isolation level — and **HTTP-level diffing cannot see any of
it**.

Repeatability: 5 consecutive runs across 3 timezones, all byte-identical, plus 7
consecutive green runs of both scenarios after the fresh/carried change. The
trace added 48 recorded runs for the variance measurement below, then 5
consecutive verify runs plus `TZ=UTC` and `TZ=Pacific/Chatham`.

## The SQL trace (`trace.ts`)

Every step records what it asked of Postgres, read back from Postgres's own log.
No application code is involved, which is the point: it has to keep working
after Prisma is gone.

**How the capture works.** `ALTER DATABASE <runDb> SET log_statement='all'`, plus
auto_explain loaded through `session_preload_libraries` for `Actual Rows` per
plan node. Both are per-database, need no server restart, apply only to
connections opened afterwards, and die with `DROP DATABASE`. The log is read
back with `podman logs`. One setting cannot be per-database — `log_line_prefix`
is `PGC_SIGHUP` — so it is set once server-wide and left; see
`docs/development/local-setup.md`.

`pg_stat_statements` was ruled out and should not be revisited.
`shared_preload_libraries` is empty on this container and the setting is
postmaster-context, so it needs a restart of an always-on service; `LOAD` and
`CREATE EXTENSION` both *succeed* and then every function errors, which is a
trap that looks like it works. It is also structurally weaker: an aggregate keyed
by normalized query text has no ordering, no backend identity and no transaction
grouping, so it cannot answer "did these two statements run in one transaction".

**What a step records.** Statement and transaction counts, kinds, relations
touched, rows read per relation, plan node types, and — grouped by virtual
transaction id — the transaction envelope with its isolation level. Identical
transactions are grouped with an occurrence count, so a redundant query removed
reads as `occurrences: 13 -> 12` rather than shifting a hundred array positions.

**What it never records: SQL text, bind values, durations, costs, pids, vxids.**
The privacy half is not theoretical. `log_parameter_max_length=0` suppresses
`DETAIL: parameters:` and `auto_explain.log_parameter_max_length=0` suppresses
`Query Parameters:` — the second was found only by capturing and reading the
output, because setting the first alone still emitted
`Query Parameters: $1 = 'nope'`. And even with both at 0, Postgres inlines bind
values into plan quals: a real capture produced
`Filter: ("forUserId" = 'u1'::text)`. So the rule is not "filter the text", it is
that a traced statement has no text-shaped field at all — kind, protocol,
relations, counts and node types, with nowhere for a value to land. The parser
also discards `DETAIL: parameters:` records outright, as a second layer.

### What it makes visible

| | recorded |
|---|---|
| dropped `take: limit + 1` | `messages page of 5` reads `Message: 6`; unpaginated reads 13. `topRows` moves with it, and the `Limit` node disappears — three independent signals for one mutation. |
| reveal moved out of its `$transaction` | `consent as bob` records exactly one shape with `isolation: SERIALIZABLE`, `statementCount: 5`, `BEGIN / SET_TX / SELECT EmpathyAttempt / UPDATE EmpathyAttempt / COMMIT`. Moving the write out splits it into two vxid groups and drops the isolation level. |

"Has a `BEGIN`" is **not** a discriminator — Prisma wraps a bare `updateMany` in
its own implicit BEGIN/COMMIT, so the mutated code still has one. Grouping is
always by vxid.

### Four things measurement forced

**The harness must mute its own connections.** `empathy-reveal` snapshots the
whole database (~68 SELECTs) and `settle()` polls up to 50 times per step, so an
unmuted harness emits thousands of statements. Measured with capture on:
journald rate-limited (`Suppressed 35097 messages`), 3000 statements arrived as
1562, and the end marker was lost. Filtering by `application_name` afterwards
does not help — the journald budget is spent before anything is filtered. So
`withClient` self-mutes immediately after connect.

**Plan shape had to be pinned with `plan_cache_mode='force_custom_plan'`.**
Prisma issues *named* prepared statements, and Postgres switches a named
statement from a custom to a generic plan on its sixth execution. Prisma's
`findMany` emits `… WHERE "id" IN ($1) OFFSET $2` with `$2 = 0`; a custom plan
knows the offset is zero and elides the `Limit` node, a generic plan cannot.
Which pooled connection serves a request decides which side of the sixth
execution it lands on, so the same query recorded `["Limit","Index Scan"]` in one
run and `["Index Scan"]` in the next — six runs produced four distinct traces for
one step, with identical rows read either way. Forcing custom plans removes the
coin flip at its source instead of banding the artefact away, which is what keeps
"the `Limit` node disappeared" usable as a real signal.

**Connection attribution had to be dropped, and it was the plan.** `<conn:N>` by
order of first appearance was measured unstable on every step where the pool
opened more than one connection (4 distinct results in 6 runs on `session state`,
6 in 6 on `consent as bob`); the identical data with the label removed was stable
6/6 everywhere. Which pool slot served a transaction is scheduling, not
behaviour. The *count* of distinct connections is still recorded. The vxid
grouping — the part that answers "did these run together" — is kept in full.

**A quantity is asserted exactly, or refused outright. Never fitted to a range.**
48 recorded runs of both scenarios say what moves, and it is two things, both on
`consent as bob`, where the request and the fire-and-forget reveal overlap:

| | distribution over 48 runs |
|---|---|
| `connections` | 4 ×45, 3 ×3 — **and 5 once, off-sample** |
| `rowsRead.Message` (rollup) | 34 ×46, 35 ×2 |
| one `Message`-only `Index Scan` | 0 rows ×46, 1 row ×2 |

Everything else was identical 48/48: statement count (139), transaction count
(129), kinds, isolation, every plan node type, and every other relation on that
step — `EmpathyAttempt` 23, `RelationshipMember` 35, `Relationship` 21, `Session`
21, `User` 19, `StageProgress` 8, `UserVessel` 6, `EmpathyDraft` 2, and three
zeroes. All 6 steps of `session-read` and the other 7 of `empathy-reveal` were
stable 48/48 with nothing declared at all.

Both moving quantities are **refused**, not ranged, and the history is the
argument. An interim version declared `connections: [3, 4]` from the first 18
runs. The mutation gate then produced `5` on a clean, unmutated tree — a value 48
runs never showed — and `connections` also moved under two unrelated mutations,
so it cannot separate "the pool scheduled differently" from "a regression added a
query". A range that fails on a clean tree trains a reader to dismiss exactly the
failures this harness exists to raise, and a reader who dismisses them eventually
re-records the golden to make the red go away.

`rowsRead.Message` looked far tighter — 46 of 48 at one value, moving by a single
row — but it is the same kind of claim. The raced statement is a `findMany` with
no `LIMIT`, so nothing bounds it at one row, and the reveal inserts *two* Message
rows in separate autocommit transactions. `34-35` was a property of the sample
exactly as `3-4` was, so it went too.

`EmpathyAttempt` is the control that shows the line is real and not superstition:
the reveal writes it too, but only with `UPDATE`, so its read counts cannot move
with timing and they stayed at 23 across all 48 runs. **INSERT/DELETE moves row
counts; UPDATE cannot.** That is the rule for deciding what a step with
background work can still assert.

So the scenario declares `traceUnasserted` for `connections` and `Message` on that
one step, and nothing else anywhere is coarsened. `connections` stays exact on
every synchronous step, where it has never moved. `topRows` is suppressed only
where the unasserted scan *is* the plan root — validated against 30 captures, the
statement that flips is a bare `Index Scan`, while five `Limit -> Index Scan
Backward` statements over the same relation are stable at 0 and keep their exact
`topRows`, so a `Limit` that stopped limiting is visible even on the relation this
step cannot count.

Two earlier versions are recorded here because the corrections are the point. The
first discarded the whole `rowsRead` map on any `asyncBoundary` step — far coarser
than the evidence, on the only step carrying a write path. The second replaced
that with fitted ranges, which failed on a clean tree. What survives both is the
narrowing, not the fitting.

**An empty or truncated window fails loudly.** Same lesson as `settled`, one
layer down: a rate-limited window is a *smaller* trace, which is
indistinguishable from the code having got cheaper. Each step is delimited by
sentinel statements on a dedicated unmuted connection rather than by wall clock,
because the container's clock is the podman VM's and drifts against the host's.
A missing sentinel, a duplicated one, a `Suppressed N messages` notice inside the
window, or zero statements from the app all set `complete: false`, and both
scenarios assert on it. Every wait is bounded (10 reads, 400ms apart).

## Known gaps — read this before trusting a green run

An adversarial review found eleven attack paths. Five were fixed (see the commit
"close five false-pass paths"). These remain open, and a green run does **not**
mean they are covered:

- **Negative authorization cannot currently fail.** `handleE2EAuthBypass`
  *creates* an unknown `x-e2e-user-id` rather than rejecting it, so a scenario
  asserting "an outsider gets 403" would mint that outsider and record whatever
  they can see as the expected result. Any such scenario needs a strict bypass
  mode first. (Related: `requireSessionAccess`'s invitation fallback grants
  access to any authenticated non-inviter on a session with an ACCEPTED
  invitation — tracked separately as `work-kpkq.2`.)
- **One write scenario, not a covered write path.** `empathy-reveal` closes the
  "no writes at all" gap — it exercises `describeChange`, `timestampFacts`, the
  settle machinery and the async boundary, and it passes a four-mutation gate.
  But it is one path. The 23 client-written `@updatedAt` columns are covered
  only where this scenario happens to touch them (`User`, `EmpathyDraft`), and
  every other write in the product — Stage 3 needs, Stage 4 proposals, inner
  work, tending — has none.
- **Out-of-scope writes are invisible *except* in `empathy-reveal`,** which
  declares whole-database scope derived from `information_schema`. That is the
  pattern the scoped scenario should move to; it immediately showed that the E2E
  auth bypass writes `User.clerkId` and `User.updatedAt` on every request,
  including GETs, which the scoped read scenario could not see.
- ~~**jsonb timestamps are not rebased.**~~ Closed by `rebaseJsonTimestamps` —
  ISO-8601 values inside the 17 `Json` columns now shift with the 144 timestamp
  columns. Parsing *these* in JavaScript is safe, unlike the naive columns,
  because they carry an explicit `Z`.
- **The fixture drift check compares table names only.** An added column, a
  changed default, or a new enum value passes it.
- **SSE `data:` is parsed one line per event.** Multi-line `data:` is legal and
  would be silently dropped at both record and verify.
- **Response headers and external side effects are never compared.** A migration
  that drops an Ably publish or a push notification while writing the same rows
  passes everything here.
- **The SQL trace is podman-shaped and local-only.** `LogReader` is an interface
  so CI can swap the source, but only `podmanLogReader` exists, and capture needs
  a superuser. A scenario that does not opt in records no trace at all, and
  nothing fails if a future scenario forgets to.
- **A trace cannot attribute a statement to a call site.** It has no SQL text by
  design, so `SELECT on Message reading 6 rows` is as specific as it gets. When
  two call sites issue structurally identical queries, the trace cannot tell you
  which one regressed — only that one more or one fewer happened.
- **The one step with background writes cannot assert `Message` row counts or its
  connection count.** A cost regression confined to reads of `Message` during the
  reveal would pass. `consent as bob` is the only such step today, and it is also
  the one carrying the Serializable envelope this oracle most wants to watch. Its
  other eleven relations are still asserted exactly.

## Conventions

- **Never bulk-regenerate goldens.** Every accepted change needs a written
  reason. A harness whose baselines are refreshed on failure always passes.
- **A mutation that escapes gets explained, not waved away.** Two escaped here;
  one was a genuine no-op and one was a real gap. Both are recorded above.
- Scenarios declare their table scope, keeping unrelated background writes out of
  the diff.
