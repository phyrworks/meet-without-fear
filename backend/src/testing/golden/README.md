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
| `normalize.ts` | Structural id labels and timestamp ranks. |
| `runner.ts` | Record/verify against `__golden__/*.json`. |

Four decisions carry the design:

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

**Identifiers become structural labels, not placeholders.** `<user:ada>`,
`<message:3>` — derived from each row's natural key. Numbering ids by order of
first appearance would make a swapped-user defect byte-identical, which is a
false pass on exactly the privacy-routing bug this product cannot afford. Any
cuid-shaped token that does not resolve fails the run.

## Two hazards found by running it, not by reading

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

Repeatability: 5 consecutive runs across 3 timezones, all byte-identical.

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

## Conventions

- **Never bulk-regenerate goldens.** Every accepted change needs a written
  reason. A harness whose baselines are refreshed on failure always passes.
- **A mutation that escapes gets explained, not waved away.** Two escaped here;
  one was a genuine no-op and one was a real gap. Both are recorded above.
- Scenarios declare their table scope, keeping unrelated background writes out of
  the diff.
