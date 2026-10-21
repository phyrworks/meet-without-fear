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

export type AllowRule = AbsentKeysRule | AddedKeysRule | ValuesSubsetRule | AddedEntriesRule | MayDifferRule;

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
