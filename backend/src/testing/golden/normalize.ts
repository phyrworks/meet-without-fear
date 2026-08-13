/**
 * Golden harness — normalization.
 *
 * This is the part that decides whether the harness is an oracle or decoration.
 *
 * Two rules, both chosen to avoid *false passes* rather than to reduce noise:
 *
 * 1. **Identifiers resolve to structural labels, never to first-appearance
 *    placeholders.** Numbering ids by order of appearance means a defect that
 *    swaps two users produces byte-identical output — a false pass on precisely
 *    the privacy-routing bug this product cannot afford. Labels are derived from
 *    each row's natural key instead, so a swap reads as
 *    `<user:ada>` where `<user:bob>` was expected.
 *
 * 2. **Any cuid-shaped token that does not resolve fails the run.** Silently
 *    normalizing an unknown id would hide exactly the rows a regression
 *    introduced.
 *
 * Timestamps become ranks within a payload, preserving ties, so ordering is
 * asserted while wall-clock values are not.
 */

import { DbTarget, withClient } from './db';
import type { FixtureManifest } from './fixtures';

/**
 * cuid v1: 'c' followed by 24 base36 chars.
 *
 * The boundary is `(?<![a-z0-9])` rather than `\b`, because `_` is a word
 * character: `auth.ts` builds `clerkId = \`e2e_${userId}\``, and `\bc[a-z0-9]{24}\b`
 * does not match inside `e2e_c…`. That let a raw fixture id ride through any
 * payload exposing clerkId without being labelled OR flagged unresolved —
 * a hole straight through the tripwire.
 */
const CUID_RE = /(?<![a-z0-9])c[a-z0-9]{24}(?![a-z0-9])/g;
/** `2026-08-12 23:52:14.936` or ISO-8601. */
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

export interface LabelMap {
  /** id -> structural label */
  labels: Map<string, string>;
}

/**
 * Build id -> label mappings from the fixture's own contents.
 *
 * Everything resolvable gets a name that means something to a human reading a
 * diff, and that is stable across runs because it derives from data, not order.
 */
export async function buildLabelMap(target: DbTarget, database: string, manifest: FixtureManifest): Promise<LabelMap> {
  const labels = new Map<string, string>();

  const nameOf = (email: string): string => email.split('@')[0];
  labels.set(manifest.seeded.userA.id, `<user:${nameOf(manifest.seeded.userA.email)}>`);
  if (manifest.seeded.userB) {
    labels.set(manifest.seeded.userB.id, `<user:${nameOf(manifest.seeded.userB.email)}>`);
  }
  labels.set(manifest.seeded.sessionId, '<session:main>');
  labels.set(manifest.seeded.relationshipId, '<relationship:main>');
  labels.set(manifest.seeded.invitationId, '<invitation:main>');

  await withClient(
    target,
    async c => {
      // Messages: rank by timestamp then id, so the label survives reordering of
      // the *result set* while still changing if the underlying data changes.
      const msgs = await c.query<{ id: string; rank: string }>(
        `SELECT id, row_number() OVER (ORDER BY timestamp, id)::text AS rank FROM "Message"`,
      );
      for (const m of msgs.rows) labels.set(m.id, `<message:${m.rank}>`);

      const progress = await c.query<{ id: string; userId: string; stage: number }>(
        `SELECT id, "userId", stage FROM "StageProgress"`,
      );
      for (const p of progress.rows) {
        const who = labels.get(p.userId) ?? `user(${p.userId.slice(-4)})`;
        labels.set(p.id, `<progress:${who.replace(/[<>]|user:/g, '')}/stage${p.stage}>`);
      }

      const attempts = await c.query<{ id: string; sourceUserId: string | null }>(
        `SELECT id, "sourceUserId" FROM "EmpathyAttempt"`,
      );
      for (const a of attempts.rows) {
        const who = a.sourceUserId ? (labels.get(a.sourceUserId) ?? a.sourceUserId) : 'null';
        labels.set(a.id, `<empathyAttempt:${who.replace(/[<>]|user:/g, '')}>`);
      }

      const vessels = await c.query<{ id: string; userId: string }>(`SELECT id, "userId" FROM "UserVessel"`);
      for (const v of vessels.rows) {
        const who = labels.get(v.userId) ?? v.userId;
        labels.set(v.id, `<vessel:${who.replace(/[<>]|user:/g, '')}>`);
      }
    },
    database,
  );

  return { labels };
}

export interface NormalizeResult<T> {
  value: T;
  /** cuid-shaped tokens with no structural label. Non-empty means the run fails. */
  unresolved: string[];
}

/**
 * Normalize a payload: ids to labels, timestamps to ranks.
 *
 * Timestamp ranks are computed over the whole payload so that ordering between
 * fields is preserved and ties stay ties — a change that collapses two distinct
 * timestamps into one, or reorders them, shows up.
 */
export function normalize<T>(value: T, map: LabelMap): NormalizeResult<T> {
  const unresolved = new Set<string>();

  // Pass 1: collect timestamps so ranks can be assigned globally.
  const stamps = new Set<string>();
  collectStrings(value, s => {
    for (const m of s.matchAll(TIMESTAMP_RE)) stamps.add(normalizeStampText(m[0]));
  });
  const ordered = [...stamps].sort();
  const rankOf = new Map<string, number>();
  ordered.forEach((s, i) => rankOf.set(s, i + 1));

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return normalizeString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      // Keys are normalized too. A response shaped `{ [userId]: ... }` would
      // otherwise carry raw ids that are neither labelled nor flagged, so a
      // leak keyed by an unknown id went undetected entirely.
      for (const k of Object.keys(v as object).sort()) {
        out[normalizeString(k)] = walk((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };

  const normalizeString = (s: string): string => {
    let out = s.replace(TIMESTAMP_RE, m => {
      const rank = rankOf.get(normalizeStampText(m));
      return rank ? `<ts:${rank}>` : '<ts:?>';
    });
    out = out.replace(CUID_RE, m => {
      const label = map.labels.get(m);
      if (label) return label;
      unresolved.add(m);
      return `<UNRESOLVED_ID:${m}>`;
    });
    return out;
  };

  return { value: walk(value) as T, unresolved: [...unresolved] };
}

function normalizeStampText(s: string): string {
  // `2026-08-12 23:52:14.936` and `2026-08-12T23:52:14.936Z` are the same instant
  // in this schema's UTC-naive convention; compare them on one basis.
  const base = s
    .replace('T', ' ')
    .replace('Z', '')
    .replace(/\+00:?00$/, '')
    .trim();
  // Postgres ::text renders `12:00:00` while JSON bodies render `12:00:00.000`.
  // Without padding, one instant becomes two stamps with two ranks, so "ties
  // stay ties" silently stops being true wherever both forms co-occur.
  const m = base.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?$/);
  if (!m) return base;
  return `${m[1]}.${(m[2] ?? '').padEnd(6, '0').slice(0, 6)}`;
}

function collectStrings(v: unknown, fn: (s: string) => void): void {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.forEach(x => collectStrings(x, fn));
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v as object)) {
      fn(k);
      collectStrings((v as Record<string, unknown>)[k], fn);
    }
  }
}

/**
 * Relational assertions about timestamps that rank-normalization cannot express.
 *
 * `updatedAt` is the one that matters: it has no database default (23 columns,
 * all `@updatedAt`), so Prisma writes it client-side on every update. The
 * migration must hand-write it in every UPDATE across 85 files and will miss
 * some — and a missed one leaves the *previous* value, which is still a valid
 * timestamp and still gets a rank. Comparing `updatedAt` to `createdAt` and to
 * its own prior value is what makes that visible.
 */
export function timestampFacts(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): Record<string, string> {
  const facts: Record<string, string> = {};
  const createdAt = after.createdAt;
  const updatedAt = after.updatedAt;

  if (typeof updatedAt === 'string') {
    facts['updatedAt==createdAt'] = String(updatedAt === createdAt);
    if (before && typeof before.updatedAt === 'string') {
      facts['updatedAt.bumped'] = String(before.updatedAt !== updatedAt);
    }
  }
  return facts;
}
