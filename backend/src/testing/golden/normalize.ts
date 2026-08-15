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
 * Timestamps become ranks within a payload, so ordering is asserted while
 * wall-clock values are not. Ranks are keyed by (value, occurrence site) — see
 * `normalize` for why equality across two different sites is deliberately not
 * asserted.
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

      // Drafts before consents: a consent is labelled by what it consents *to*,
      // and the target is usually a draft.
      const drafts = await c.query<{ id: string; userId: string }>(
        `SELECT id, "userId" FROM "EmpathyDraft"`,
      );
      for (const d of drafts.rows) {
        const who = labels.get(d.userId) ?? d.userId;
        labels.set(d.id, `<empathyDraft:${who.replace(/[<>]|user:/g, '')}>`);
      }

      // A consent's natural key is who granted it, over what kind of content, for
      // which target. The rank is only a fallback for an unlabelled target, and it
      // is scoped *within* that natural key — never a first-appearance number,
      // which would make a consent recorded against the wrong target or by the
      // wrong user byte-identical to a correct one.
      const consents = await c.query<{ id: string; userId: string; targetType: string; targetId: string | null }>(
        `SELECT id, "userId", "targetType"::text AS "targetType", "targetId" FROM "ConsentRecord"
         ORDER BY "userId", "targetType", "decidedAt" NULLS LAST, "createdAt", id`,
      );
      const consentRank = new Map<string, number>();
      for (const r of consents.rows) {
        const who = labels.get(r.userId) ?? r.userId;
        const group = `${who}/${r.targetType}`;
        const n = (consentRank.get(group) ?? 0) + 1;
        consentRank.set(group, n);
        // An unlabelled target must not put a raw cuid inside a label: labels are
        // substituted for ids in a single pass and are never rescanned, so it
        // would ride into the golden unnormalized and differ every run.
        const targetLabel = r.targetId ? labels.get(r.targetId) : null;
        const target = targetLabel ? targetLabel.replace(/[<>]/g, '') : `#${n}`;
        labels.set(r.id, `<consent:${who.replace(/[<>]|user:/g, '')}/${r.targetType}/${target}>`);
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
 * The interval this run was observing — everything it wrote falls inside it.
 *
 * `from` is when the fixture finished restoring, not when the step began: a
 * value written by step 1 and read back in step 5 is still this run's own
 * output, and ranking it against the fixture would reintroduce exactly the
 * millisecond-ordering noise the split exists to remove.
 *
 * `to` is bounded rather than open-ended because the fixture contains
 * future-dated values — `Invitation.expiresAt` is seeded at `now + 7d` — and
 * those are carried data, not something this run produced.
 */
export interface FreshWindow {
  from: string;
  to: string;
}

/**
 * Normalize a payload: ids to labels, timestamps to ranks — except for the
 * timestamps this run wrote itself, which become `<ts:fresh>`.
 *
 * The fresh/carried split is forced by measurement, not taste. Ranking every
 * stamp by value made each rank a function of how many *distinct* instants a
 * step contained, and on a write path that count is not stable:
 * `ConsentRecord.decidedAt` (app code calling `new Date()`) and
 * `ConsentRecord.createdAt` (Prisma resolving `@default(now())` client-side) are
 * two independent JavaScript timestamps about a millisecond apart, so they
 * sometimes land in the same millisecond and sometimes do not. When they
 * collided, two ranks became one and every later rank shifted — a thirteen-line
 * diff describing no behavioural change at all. Measured at 3 failures in 5 runs.
 * Keying ranks by occurrence site fixed the cascade but not the cause: the
 * *order* of two stamps a millisecond apart is itself random. The same exposure
 * exists between any two rows written back-to-back, such as the two reveal
 * messages 1ms apart.
 *
 * So: stamps inside the run's own execution window are unorderable noise and are
 * flattened to `<ts:fresh>`; stamps outside it come from the fixture, whose
 * lattice the rebase preserves exactly, and keep full value-ranks with ties
 * intact.
 *
 * This is not only a determinism fix — it makes the assertion that matters most
 * to the migration *explicit*. A column that should have been written but was
 * not now reads `<ts:5>` (a carried value) where `<ts:fresh>` is expected, which
 * is precisely the hand-written-UPDATE-forgot-`updatedAt` failure across 23
 * `@updatedAt` columns.
 *
 * What it gives up: ordering *between* two stamps written in the same run, and
 * equality between any two fields. Neither is observable at millisecond
 * resolution. Response ordering is still asserted through `<message:N>` labels
 * and array positions, and "these columns were written by one statement" belongs
 * to the statement-log oracle (`work-a39h.7`), which sees the transaction
 * envelope directly.
 */
export function normalize<T>(value: T, map: LabelMap, window?: FreshWindow): NormalizeResult<T> {
  const unresolved = new Set<string>();

  const isFresh = (stamp: string): boolean =>
    !!window && stamp >= normalizeStampText(window.from) && stamp <= normalizeStampText(window.to);

  // Pass 1: rank the carried stamps. Fresh ones are deliberately excluded, so a
  // run that writes an extra row cannot renumber the fixture's instants.
  const stamps = new Set<string>();
  collectStrings(value, s => {
    for (const m of s.matchAll(TIMESTAMP_RE)) {
      const stamp = normalizeStampText(m[0]);
      if (!isFresh(stamp)) stamps.add(stamp);
    }
  });
  const rankOf = new Map<string, number>();
  [...stamps].sort().forEach((s, i) => rankOf.set(s, i + 1));

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
      const stamp = normalizeStampText(m);
      if (isFresh(stamp)) return '<ts:fresh>';
      const rank = rankOf.get(stamp);
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
