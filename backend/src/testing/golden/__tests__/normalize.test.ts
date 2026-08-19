/**
 * Unit tests for identifier normalization.
 *
 * These exist because of a specific defect: rebuilding the `FEEL_HEARD_B`
 * fixture turned the `empathy-reveal` golden red for reasons that had nothing to
 * do with the code under test. Measured on a real rebuild, **exactly four values
 * changed across both goldens and all four were `User.clerkId`** — every cuid,
 * every timestamp rank and every trace field was byte-identical, which is the
 * structural-label design working everywhere except on the one identifier it did
 * not recognise.
 *
 * A mysterious red whose obvious cure is re-recording is the most dangerous
 * failure this harness can have, so both clerkId formats are pinned here.
 */

import { normalize, LabelMap } from '../normalize';

/** Two users, plus the seeded clerkId of one of them. */
function labelMap(extra: Record<string, string> = {}): LabelMap {
  return {
    labels: new Map<string, string>([
      ['claaaaaaaaaaaaaaaaaaaaaaa', '<user:ada>'],
      ['cbbbbbbbbbbbbbbbbbbbbbbbb', '<user:bob>'],
      ...Object.entries(extra),
    ]),
  };
}

describe('clerkId normalization — the two formats', () => {
  // `middleware/auth.ts:91` builds `e2e_${userId}` from a cuid. This is the case
  // the `(?<![a-z0-9])` boundary on CUID_RE exists for: `\b` would not match
  // inside `e2e_c…` because `_` is a word character. A review suggested this
  // case does not occur and the boundary guards nothing — it does occur, on
  // every request through the E2E bypass, and it is visible in the recorded
  // golden as `"clerkId": "e2e_<user:bob>"`.
  it('normalizes the auth-bypass format, which embeds a cuid', () => {
    const r = normalize({ clerkId: 'e2e_cbbbbbbbbbbbbbbbbbbbbbbbb' }, labelMap());
    expect(r.value).toEqual({ clerkId: 'e2e_<user:bob>' });
    expect(r.unresolved).toEqual([]);
  });

  // `state-factory.ts:150` builds `e2e_${Date.now()}_${random}`, which contains
  // no cuid at all, so CUID_RE cannot see it. This is the format that leaked.
  it('normalizes the seeded format from its owner, when the label map knows it', () => {
    const map = labelMap({ e2e_1787097373886_xa944v: '<clerkId:bob>' });
    const r = normalize({ clerkId: 'e2e_1787097373886_xa944v' }, map);
    expect(r.value).toEqual({ clerkId: '<clerkId:bob>' });
    expect(r.unresolved).toEqual([]);
  });

  it('fails the run on a seeded clerkId nobody labelled', () => {
    // The backstop. Before it existed the raw value rode into the golden and
    // every fixture rebuild produced an unexplained diff.
    const r = normalize({ clerkId: 'e2e_1787097373886_xa944v' }, labelMap());
    expect(r.unresolved).toEqual(['e2e_1787097373886_xa944v']);
    expect(r.value).toEqual({ clerkId: '<UNRESOLVED_ID:e2e_1787097373886_xa944v>' });
  });

  it('keeps the two formats apart in one row change, as the golden has them', () => {
    // Both appear in a single `User` diff: the seeded value on `before`, the
    // bypass rewrite on `after`.
    const map = labelMap({ e2e_1787097373886_xa944v: '<clerkId:bob>' });
    const r = normalize(
      { before: { clerkId: 'e2e_1787097373886_xa944v' }, after: { clerkId: 'e2e_cbbbbbbbbbbbbbbbbbbbbbbbb' } },
      map,
    );
    expect(r.value).toEqual({ before: { clerkId: '<clerkId:bob>' }, after: { clerkId: 'e2e_<user:bob>' } });
    expect(r.unresolved).toEqual([]);
  });

  it('does not claim an unrelated e2e_-prefixed identifier', () => {
    // Other fixtures use fixed literals like `e2e_clerk_user_b`, which are
    // deterministic and must pass through untouched rather than being flagged.
    const r = normalize({ a: 'e2e_clerk_user_b', b: 'e2e_moment-stage1-adam-x1' }, labelMap());
    expect(r.value).toEqual({ a: 'e2e_clerk_user_b', b: 'e2e_moment-stage1-adam-x1' });
    expect(r.unresolved).toEqual([]);
  });
});
