/**
 * Golden harness — per-scenario allow-lists for the normalised baselines.
 *
 * A normalised baseline (`__golden__/<scenario>.concept.json`) is not compared
 * byte-for-byte. It is compared by `compareWithAllowList` (runner.ts) as
 * "subset plus named changes": every value in the baseline must be present and
 * equal in the new run, except where a rule in the scenario's allow-list names
 * the change. Anything not named fails.
 *
 * An allow-list describes what the TARGET re-record is permitted to change
 * (plan §4, "Golden harness" row). Against the current shape nothing changes,
 * so every rule is satisfied trivially — no key is added, none goes missing —
 * and the comparison reduces to equality.
 *
 * Paths are dot-separated over the golden JSON (`steps.0.body.data.attempt`).
 * In a pattern, `*` matches exactly one segment (a key or an array index) and
 * `**` matches zero or more.
 */

interface RuleBase {
  /** Path pattern(s) the rule applies at. */
  at: string | string[];
  /**
   * The pattern must match at least one node of the baseline. Set it on every
   * rule whose subject exists in the scenario today: if the path moves (a DTO
   * renamed, a step dropped), the rule would otherwise go vacuous silently and
   * assert nothing.
   */
  mustMatch?: boolean;
  /** Why the target may change this — cite the plan or spec. */
  why: string;
}

/**
 * Keys that must be ABSENT from the new artefact at matching objects. Their
 * baseline values are not compared — the target no longer has them. A key that
 * is still present fails.
 */
export interface AbsentKeysRule extends RuleBase {
  kind: 'absentKeys';
  keys: string[];
}

/**
 * Keys that MAY be added at matching objects. Any added key not listed fails
 * (the "exact list of added keys"); the baseline's own keys must all still be
 * present and equal (the "old ⊆ new").
 */
export interface AddedKeysRule extends RuleBase {
  kind: 'addedKeys';
  keys: string[];
  /**
   * Optional: the added value must be an array whose EVERY entry satisfies
   * this predicate (dot paths → values, as `addedEntries.where`). Without it
   * an added key's value is unasserted.
   */
  each?: Record<string, unknown>;
}

/**
 * ONE baseline entry of a matching array (the one matching `where`) may be
 * replaced by ONE run entry. The comparator enforces completeness: the run
 * entry must EQUAL the baseline entry with the `with` overrides applied (dot
 * paths → values) — every field `with` does not name must be as recorded, so
 * a target that stamps, say, `revealed_at` on a superseded round is rejected.
 * For a row the target represents differently — TS-5 R2: today's resubmit
 * mutates the attempt in place, the target supersedes round 1 and reveals
 * round 2.
 */
export interface ReplacedEntryRule extends RuleBase {
  kind: 'replacedEntry';
  where: Record<string, unknown>;
  with: Record<string, unknown>;
}

/**
 * Values at matching paths are compared as a SET: the values the new run shows
 * across all matches must be a subset of the values the baseline showed. Used
 * where the target narrows an enum (a value may disappear, none may appear).
 */
export interface ValuesSubsetRule extends RuleBase {
  kind: 'valuesSubset';
}

/**
 * ONE entry that MAY be added to a matching array (or keyed map of rows): an
 * entry present only in the new run is permitted when every `where` field
 * (dot paths into the entry; `$key` = its map key) equals the given value.
 * Each rule admits at most one entry per container, so `where` must pin the
 * expected row completely — its structural key and every reference that makes
 * it the right row (audience, lineage, sender). A predicate on `kind` alone
 * admitted a leak into the wrong conversation (TS-4 review probe). Used for
 * rows the target migration inserts (plan §4: delivered EMPATHY_STATEMENT
 * copies).
 */
export interface AddedEntriesRule extends RuleBase {
  kind: 'addedEntries';
  where: Record<string, unknown>;
  /**
   * The comparator enforces completeness: the admitted entry must be EXACTLY
   * the object `where` spells out (dot paths expanded) — a field `where` does
   * not name cannot ride in. Use it when every field of the row is known
   * (TS-5 R2's round-2 attempt). `$key` is not allowed with `exact`.
   */
  exact?: boolean;
}

/**
 * The value at matching paths MAY differ from the baseline's (the key must
 * still be present). For a value the target computes from a different source
 * by design — e.g. a partner's need text, which becomes `need_share.shared_text`
 * instead of the private label (TS-5, R4). Pair it with a scenario assertion
 * that pins what the new value must (not) be; this rule only stops the
 * comparator demanding equality.
 */
export interface MayDifferRule extends RuleBase {
  kind: 'mayDiffer';
}

/**
 * Keys that MAY be missing from the new artefact at matching objects (when
 * present they are compared as usual). Unlike `absentKeys`, it holds on the
 * current shape too — for a key whose disappearance on the target is expected
 * but asserted elsewhere (TS-5 R5: `unrepresentable`, whose absence the
 * scenario's own rule check requires).
 */
export interface MayBeAbsentRule extends RuleBase {
  kind: 'mayBeAbsent';
  keys: string[];
}

/**
 * Arrays at matching paths whose consecutive entries tie on the RAW value of
 * `key` (a dot path into the entry — the endpoint's only sort key; the same
 * millisecond, not the same normalised `<ts:…>`) may return the tied entries in
 * any order. The runner records each step's genuine tie ranges
 * (`rawTieRanges` → `tiedRanges`) and, before comparing the byte-level or the
 * normalised golden, puts every range either side recorded into canonical
 * order on both (`alignTies`); the rest stays positional. Not a target-only
 * change. Give each use a reason.
 */
export interface TiedOrderRule extends RuleBase {
  kind: 'tiedOrder';
  key: string;
}

/**
 * TARGET SHAPE ONLY (TS-9). A value the target fixture cannot be made to hold
 * the way the current-shape fixture held it, at a place where the difference
 * would also move every later timestamp RANK of the step (a new instant
 * renumbers all `<ts:N>` after it, so `mayDiffer` on the one key cannot
 * contain it). The runner checks the run's RAW value against `expect` and,
 * if it holds, substitutes `baseline` before normalisation; if it does not
 * hold, the step fails. Never applied on the current shape. Give the
 * fixture fact and pair it with a scenario assertion of the real value.
 *
 *   expect 'isoTimestamp' — the raw value is an ISO-8601 instant.
 */
export interface FixtureMaskRule extends RuleBase {
  kind: 'fixtureMask';
  expect: 'isoTimestamp';
  /** What the baseline holds at this path (substituted into the run). */
  baseline: unknown;
}

/**
 * TARGET SHAPE ONLY (TS-9 fix round 1). A byte-level step's SQL `trace`
 * recorded on the current shape, compared on the target through a relation
 * rename map instead of byte-for-byte (relation names and plans are
 * shape-bound; the README's contract fields are not):
 *   - the run's trace is complete;
 *   - protocol: every DATA statement is `extended` (bind parameters — the
 *     SQL-injection tripwire); transaction-control statements (BEGIN, COMMIT,
 *     ROLLBACK, SET_TX) may be `simple` — the identity-binding wrapper sends
 *     them without parameters, and they carry no values;
 *   - isolation: the set of explicit isolation levels is unchanged;
 *   - relations: every relation the run touches is the image of one the
 *     baseline touched (`relationMap`) or is named in `addedRelations` with
 *     its reason;
 *   - rowsRead: for steps whose label starts with `steps`, the run reads
 *     exactly as many rows of the mapped relation as the baseline did of
 *     `relation` (the same concept read the same way).
 */
export interface TraceMappedRule extends RuleBase {
  kind: 'traceMapped';
  relationMap: Record<string, string[]>;
  addedRelations: Record<string, string>;
  sameRowsRead: Array<{ steps: string; relation: string; as: string }>;
}

/**
 * TARGET SHAPE ONLY (TS-10, ruling R32). A byte-level step's row `changes`
 * (and `changesAtResponse`) recorded on the current shape, compared on the
 * target through a TABLE rename map — the analogue of `traceMapped`. Byte
 * changes are keyed by physical table and column names, which are
 * shape-bound; the row VALUES are asserted by the concept comparison of the
 * same step (the shape-independent oracle, with its own pinned rules), so
 * this rule checks the shape of the write only:
 *   - every (table, change kind) the run writes is the image of a (table,
 *     kind) the baseline wrote at that step (`tableMap`), or is named in
 *     `addedTables` at that exact step with its count and reason;
 *   - for a baseline table whose mapping is 1:1 at that step (one target
 *     table, not the image of any other table the baseline step wrote), the
 *     run's row count per (target
 *     table, kind) equals the baseline's plus the added count named for it
 *     at that step;
 *   - every (table, kind) the baseline wrote at the step has an image the run
 *     wrote (a write that disappeared is a violation).
 * `asyncBoundary` markers (a string) must be equal on both sides.
 */
export interface ChangesMappedRule extends RuleBase {
  kind: 'changesMapped';
  tableMap: Record<string, string[]>;
  addedTables: Array<{ step: number; table: string; kind: 'added' | 'changed' | 'removed'; count: number; why: string }>;
}

/**
 * TARGET SHAPE ONLY (TS-10, ruling R31). A read owned by a cluster not yet
 * rewritten on this branch (TS-11 needs/repair/follow-up, TS-12 reflection/
 * wellbeing) answers 500 on the target until that cluster lands. For each
 * listed read (`read` = the read's name in `privacy.ts` SESSION_READS /
 * USER_READS; every step whose label is `<phase>: <read> as <email>`), the
 * run's `status` must be 500 and its body the error envelope; status and
 * body are then not compared (`changes` still are). A listed read that
 * answers anything but 500 FAILS (a stale entry — delete it when the cluster
 * lands). Only reads in `PENDING_CLUSTER_READS` may be listed, with that
 * owner: a TS-10 read can never be excused.
 */
export interface PendingClusterRule extends RuleBase {
  kind: 'pendingCluster';
  reads: Array<{ read: string; owner: 'TS-11' | 'TS-12' }>;
}

/** The reads a `pendingCluster` entry may name, with their owning task (ruling R31). */
export const PENDING_CLUSTER_READS: Readonly<Record<string, 'TS-11' | 'TS-12'>> = {
  needs: 'TS-11',
  'needs comparison': 'TS-11',
  stage4: 'TS-11',
  strategies: 'TS-11',
  agreements: 'TS-11',
  tending: 'TS-11',
  'tending history': 'TS-11',
  emotions: 'TS-12',
  'inner thoughts': 'TS-12',
  'inner thoughts list': 'TS-12',
  'inner work list': 'TS-12',
  'knowledge base recent': 'TS-12',
  'knowledge base themes': 'TS-12',
};

export type AllowRule =
  | ChangesMappedRule
  | PendingClusterRule
  | TraceMappedRule
  | FixtureMaskRule
  | AbsentKeysRule
  | AddedKeysRule
  | ValuesSubsetRule
  | AddedEntriesRule
  | MayDifferRule
  | MayBeAbsentRule
  | ReplacedEntryRule
  | TiedOrderRule;

export interface AllowList {
  scenario: string;
  rules: AllowRule[];
  /**
   * Assertions the plan requires that the CURRENT shape cannot exercise (the
   * behaviour does not exist yet — e.g. rounds). Documentation for the target
   * re-record, which must add the steps and assertions named here; the
   * comparator does not read it (TS-5 brief: "do not fake it … encode the
   * target expectation in the allow-list").
   */
  targetOnly?: Array<{ assertion: string; why: string }>;
}
