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
| `runner.ts` | Record/verify against `__golden__/*.json`. |

Five decisions carry the design:

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
the statement-log oracle instead.

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

The escaped mutation is worth stating plainly: moving the `updateMany` out of
the transaction writes identical rows, so the settled snapshot, both HTTP bodies
and every assertion here are unchanged. What differs is the transaction envelope
and the TOCTOU race it exists to prevent — visible only to the statement-log
oracle (`work-a39h.7`). Until that exists, this harness is an oracle for
**behaviour**, not for **cost** and not for **atomicity**.

Repeatability: 5 consecutive runs across 3 timezones, all byte-identical, plus 7
consecutive green runs of both scenarios after the fresh/carried change.

### The blind spot the mutations exposed

Removing `take: limit + 1` does not change any HTTP response. The controller
already does `messages.slice(0, limit)`, so dropping the database limit fetches
all rows and slices to the same page; `hasMore` computes identically. Only the
number of rows read from Postgres changes.

That is the whole class of query-efficiency regression — an N+1, a lost `LIMIT`,
a join replaced by a loop — and **HTTP-level diffing cannot see any of it**. On a
long session it is a production incident that every assertion here would pass.

The fix is the second oracle in the plan: compare PostgreSQL's own statement log
per step (counts in bands, transaction envelope, backend PID identity), which is
implementation-independent and needs no code in either implementation. Tracked as
part of `work-a39h.2`; it is not built yet, and until it is, this harness is an
oracle for **behaviour** and not for **cost**.

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

## Conventions

- **Never bulk-regenerate goldens.** Every accepted change needs a written
  reason. A harness whose baselines are refreshed on failure always passes.
- **A mutation that escapes gets explained, not waved away.** Two escaped here;
  one was a genuine no-op and one was a real gap. Both are recorded above.
- Scenarios declare their table scope, keeping unrelated background writes out of
  the diff.
