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
 * 2. **Any id-shaped token (uuid, or legacy cuid) that does not resolve fails
 *    the run.** Silently
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
import { CONCEPT_VIEWS } from './concept-views';

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

/**
 * Every primary key is a database-minted UUIDv7 since `cuid_to_uuidv7`. Any
 * version is matched, not just 7: an id the app minted itself (v4 from
 * `crypto.randomUUID()`) is still an id and must resolve or fail. CUID_RE stays
 * as a tripwire for a cuid surviving anywhere.
 *
 * Same boundary reasoning as CUID_RE: `e2e_${userId}` puts `_` directly before
 * the id, so the lookbehind excludes only alphanumerics. `-` must stay allowed
 * too: the mobile chat list builds ids like `context-shared-${messageId}`.
 */
const UUID_RE = /(?<![0-9a-zA-Z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-zA-Z])/g;

/**
 * The *other* clerkId format, and the second volatile-identifier tripwire.
 *
 * There are two, and the distinction matters because the comment above is about
 * the first and is easy to mistake for covering both:
 *
 *   `auth.ts:91`          `e2e_${userId}`                    — contains a cuid,
 *                                                              normalised by
 *                                                              CUID_RE, which is
 *                                                              exactly what the
 *                                                              `(?<![a-z0-9])`
 *                                                              boundary is for.
 *   `current-shape.ts` (writeCurrentShape) `e2e_${Date.now()}_${random}`     — contains no cuid
 *                                                              at all.
 *
 * Both appear in one `User` row change in `empathy-reveal`: the seeded value on
 * the `before` side and the bypass-rewritten one on the `after` side. The second
 * form used to ride into the goldens raw, so rebuilding a fixture produced a red
 * suite with no relation to the code under test — measured at exactly four
 * changed values on a rebuild, all of them this.
 *
 * The seeded values are labelled from the manifest (see `buildLabelMap`); this
 * pattern is the backstop that fails the run if one ever appears unlabelled.
 * There is no general solution — a volatile identifier of arbitrary shape cannot
 * be detected — so each known shape is enumerated as it is found.
 */
const SEEDED_CLERKID_RE = /(?<![a-z0-9_])e2e_\d{10,}_[a-z0-9]{4,}(?![a-z0-9])/g;

/** `2026-08-12 23:52:14.936` or ISO-8601. */
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

/** A string that is exactly an ISO calendar date. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
export async function buildLabelMap(
  target: DbTarget,
  database: string,
  manifest: FixtureManifest,
  /** Seeded `User.clerkId` values, captured at restore — see `RestoredFixture`. */
  seededClerkIds: Array<{ userId: string; clerkId: string }> = [],
): Promise<LabelMap> {
  const labels = new Map<string, string>();

  const nameOf = (email: string): string => email.split('@')[0];
  labels.set(manifest.seeded.userA.id, `<user:${nameOf(manifest.seeded.userA.email)}>`);
  if (manifest.seeded.userB) {
    labels.set(manifest.seeded.userB.id, `<user:${nameOf(manifest.seeded.userB.email)}>`);
  }

  // `User.clerkId` as seeded is `e2e_${Date.now()}_${random}` — a per-build
  // identifier with no id in it, so nothing else here recognises it. Labelled
  // from its owner, the same natural-key derivation everything else uses, so a
  // clerkId that ends up on the wrong user still reads as a mismatch rather than
  // collapsing to a shared placeholder.
  for (const { userId, clerkId } of seededClerkIds) {
    const who = labels.get(userId) ?? `user(${userId.slice(-4)})`;
    labels.set(clerkId, `<clerkId:${who.replace(/[<>]|user:/g, '')}>`);
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
      const drafts = await c.query<{ id: string; userId: string }>(`SELECT id, "userId" FROM "EmpathyDraft"`);
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
        // An unlabelled target must not put a raw id inside a label: labels are
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

      // TS-5: the tables the privacy scenarios' bodies and changes name. Each
      // is ranked by time then id within its natural owner — never globally
      // by first appearance (module comment, rule 1).
      const bare = (id: string | null): string =>
        id ? (labels.get(id) ?? `?${id}`).replace(/[<>]|user:|session:/g, '') : 'none';
      const rankWithin = async (
        sql: string,
        name: string,
        owner: (r: Record<string, string | null>) => string,
      ): Promise<void> => {
        const r = await c.query<Record<string, string | null>>(sql);
        const n = new Map<string, number>();
        for (const row of r.rows) {
          const o = owner(row);
          n.set(o, (n.get(o) ?? 0) + 1);
          labels.set(String(row.id), `<${name}:${o}#${n.get(o)}>`);
        }
      };
      await rankWithin(
        `SELECT id, "userId" FROM "InnerWorkSession" ORDER BY "createdAt", id`,
        'innerWork',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT id, "sessionId" FROM "InnerWorkMessage" ORDER BY "sessionId", timestamp, id`,
        'innerWorkMessage',
        r => bare(r.sessionId),
      );
      await rankWithin(
        `SELECT id, coalesce("innerWorkSessionId", "sessionId") AS owner FROM "BrainActivity" ORDER BY "createdAt", id`,
        'brainActivity',
        r => bare(r.owner),
      );
      await rankWithin(
        `SELECT id, "guesserId", "subjectId" FROM "ReconcilerResult" ORDER BY "createdAt", id`,
        'reconcilerResult',
        r => `${bare(r.guesserId)}→${bare(r.subjectId)}`,
      );
      await rankWithin(
        `SELECT id, "userId" FROM "ReconcilerShareOffer" ORDER BY "createdAt", id`,
        'shareOffer',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT n.id, uv."userId" FROM "IdentifiedNeed" n JOIN "UserVessel" uv ON uv.id = n."vesselId"
         ORDER BY n."createdAt", n.id`,
        'need',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT id, "sessionId" FROM "StrategyProposal" ORDER BY "createdAt", id`,
        'proposal',
        r => bare(r.sessionId),
      );
      // Agreement has no createdAt; its uuidv7 id is insertion-ordered.
      await rankWithin(`SELECT id FROM "Agreement" ORDER BY id`, 'agreement', () => 'main');
      await rankWithin(`SELECT id, "sessionId" FROM "SharedVessel"`, 'sharedVessel', r => bare(r.sessionId));
      await rankWithin(`SELECT id, "sessionId" FROM "Stage4Closure"`, 'closure', r => bare(r.sessionId));
      await rankWithin(
        `SELECT id, "sessionId" FROM "TendingEntry" ORDER BY "createdAt", id`,
        'tendingEntry',
        r => bare(r.sessionId),
      );
      await rankWithin(
        `SELECT id, direction FROM "RefinementAttemptCounter" ORDER BY "createdAt", id`,
        'refinementCounter',
        r => String(r.direction).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, m => bare(m)),
      );
      await rankWithin(
        `SELECT id, "userId" FROM "ValidationFeedbackDraft" ORDER BY "createdAt", id`,
        'feedbackDraft',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT id, "userId" FROM "EmpathyValidation" ORDER BY "validatedAt" NULLS LAST, id`,
        'validation',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT id, "userId" FROM "Stage4ProposalSelection" ORDER BY "selectedAt", id`,
        'selection',
        r => bare(r.userId),
      );
      await rankWithin(
        `SELECT id, "sourceUserId" FROM "ConsentedContent" ORDER BY "consentedAt", id`,
        'consentedContent',
        r => bare(r.sourceUserId),
      );
      await rankWithin(
        `SELECT id, "sourceUserId" FROM "Stage4NeedCoverage" ORDER BY "createdAt", id`,
        'needCoverage',
        r => bare(r.sourceUserId),
      );
      await rankWithin(`SELECT id, "userId" FROM "RelationshipMember" ORDER BY id`, 'member', r => bare(r.userId));
      await rankWithin(`SELECT id, "userId" FROM "StrategyRanking" ORDER BY id`, 'ranking', r => bare(r.userId));
      await rankWithin(
        `SELECT id, "userId" FROM "Stage4NeedDeclination" ORDER BY "declinedAt", id`,
        'declination',
        r => bare(r.userId),
      );
    },
    database,
  );

  return { labels };
}

/**
 * Fill `map` with `fallback`'s labels for ids `map` does not know (rows the
 * run deleted, labelled from the fixture template). Returns every collision —
 * a fallback label some OTHER id already carries in `map` — and adds none of
 * them: ranks are computed per database, so when a run deletes some of an
 * owner's rows the survivors re-rank and a deleted row's template rank can
 * equal a survivor's new one. Two ids under one label would read as one row.
 */
export function mergeFallbackLabels(map: LabelMap, fallback: LabelMap): string[] {
  const used = new Map<string, string>();
  for (const [id, label] of map.labels) used.set(label, id);
  const collisions: string[] = [];
  for (const [id, label] of fallback.labels) {
    if (map.labels.has(id)) continue;
    const owner = used.get(label);
    if (owner !== undefined && owner !== id) {
      collisions.push(`${label}: ${id} (fixture) and ${owner} (run)`);
      continue;
    }
    map.labels.set(id, label);
    used.set(label, id);
  }
  return collisions;
}

export interface NormalizeResult<T> {
  value: T;
  /** id-shaped tokens with no structural label. Non-empty means the run fails. */
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
    // A bare calendar date (`2026-10-31`) is wall-clock-relative too — Stage
    // 4's `defaultCheckInDate` is today (UTC) + 10 days — but TIMESTAMP_RE
    // needs a time. Found when a golden recorded on 2026-10-21 went red after
    // UTC midnight (TS-5 fix round 2). Within a run window it becomes its day
    // offset from the window's start date: `<date:today+10d>`.
    if (window && DATE_ONLY_RE.test(s)) {
      const days = Math.round((Date.parse(`${s}T00:00:00Z`) - Date.parse(`${window.from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
      return `<date:today${days >= 0 ? '+' : ''}${days}d>`;
    }
    let out = s.replace(TIMESTAMP_RE, m => {
      const stamp = normalizeStampText(m);
      if (isFresh(stamp)) return '<ts:fresh>';
      const rank = rankOf.get(stamp);
      return rank ? `<ts:${rank}>` : '<ts:?>';
    });
    const resolve = (m: string): string => {
      const label = map.labels.get(m);
      if (label) return label;
      unresolved.add(m);
      return `<UNRESOLVED_ID:${m}>`;
    };
    // Before the id patterns: a seeded clerkId contains no id, so they never
    // overlap, but running it first keeps the whole token as the unit.
    out = out.replace(SEEDED_CLERKID_RE, resolve);
    out = out.replace(UUID_RE, resolve);
    out = out.replace(CUID_RE, resolve);
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

// ============================================================================
// Concept-view rename map
// ============================================================================
//
// The normalised baselines (`__golden__/<scenario>.concept.json`) are read
// through the `old_concept_*` views (`concept-views/`), which present today's
// tables in the target schema's vocabulary. Their ids must survive the rebuild,
// and three kinds of key have no id at all in today's shape — a participant, a
// conversation and a milestone are natural keys the views derive an id from.
// So the concept label map is built from the *view rows* alone, never from an
// old table: the same function labels a run against the target-shape views.
//
// The two rules above are kept, not relaxed: every label derives from the row's
// natural key (who, in which session, about whom, which round), and an id with
// no label is left alone so `normalize` reports it unresolved and the run fails.
// A row whose natural key does not resolve — a participant of a user the
// fixture does not know, a message with no conversation — gets no label.

/** Row values as they come out of a concept snapshot (raw, pre-normalisation). */
type ConceptRow = Record<string, unknown>;

export interface ConceptLabelInput {
  /** Shape-independent ids: the target keeps session/relationship/invitation/user ids. */
  manifest: {
    sessionId: string;
    relationshipId: string;
    invitationId: string;
    users: Array<{ id: string; email: string }>;
  };
  seededClerkIds: Array<{ userId: string; clerkId: string }>;
  /**
   * Concept view rows by concept name, merged across every snapshot of the run
   * (so a row deleted mid-run still has the label it had when it existed).
   */
  rows: Partial<Record<string, ConceptRow[]>>;
}

/**
 * Label constructors for the target's new concept keys — the rename map.
 * `who` is a user's bare label (`ada`), `session` a session's (`main`).
 */
export const CONCEPT_LABEL = {
  participant: (who: string, session: string): string => `<participant:${who}@${session}>`,
  conversation: (participant: string, kind: string): string => `<conversation:${participant}/${kind}>`,
  milestone: (participant: string, key: string): string => `<milestone:${participant}/${key}>`,
};

/** `<participant:ada@main>` → `ada@main`; `<user:ada>` → `ada`. */
function bare(label: string): string {
  return label.replace(/^<[a-zA-Z]+:/, '').replace(/>$/, '');
}

/** `<empathyAttempt:ada→bob@main#1>` → `empathyAttempt:ada→bob@main#1` (for nesting). */
function inner(label: string): string {
  return label.replace(/^</, '').replace(/>$/, '');
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Sort by the given fields (as strings), then by id — data, never arrival order. */
function sortedBy(rows: ConceptRow[], fields: string[]): ConceptRow[] {
  return [...rows].sort((a, b) => {
    for (const f of [...fields, 'id']) {
      const x = str(a[f]);
      const y = str(b[f]);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}

/** Group rows by a key function, dropping rows whose key is null. */
function groupBy(rows: ConceptRow[], key: (r: ConceptRow) => string | null): Map<string, ConceptRow[]> {
  const m = new Map<string, ConceptRow[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

export function buildConceptLabelMap(input: ConceptLabelInput): LabelMap {
  const labels = new Map<string, string>();
  const rows = (name: string): ConceptRow[] => input.rows[name] ?? [];
  const label = (id: unknown): string | null =>
    id === null || id === undefined ? null : (labels.get(String(id)) ?? null);

  // Shape-independent ids, labelled as the byte-level map labels them.
  const nameOf = (email: string): string => email.split('@')[0];
  for (const u of input.manifest.users) labels.set(u.id, `<user:${nameOf(u.email)}>`);
  for (const { userId, clerkId } of input.seededClerkIds) {
    const who = labels.get(userId);
    if (who) labels.set(clerkId, `<clerkId:${bare(who)}>`);
  }
  labels.set(input.manifest.sessionId, '<session:main>');
  labels.set(input.manifest.relationshipId, '<relationship:main>');
  labels.set(input.manifest.invitationId, '<invitation:main>');

  // participant: (user, session).
  for (const p of rows('participant')) {
    const who = label(p.user_id);
    const session = label(p.session_id);
    if (who && session) labels.set(String(p.id), CONCEPT_LABEL.participant(bare(who), bare(session)));
  }

  // conversation: MAIN is unique per participant; sub-chats rank by id (kept
  // from Stage4SubChat, time-ordered) within their participant.
  for (const [pid, convs] of groupBy(rows('conversation'), r => label(r.participant_id))) {
    let sub = 0;
    for (const c of sortedBy(convs, ['kind'])) {
      const kind = str(c.kind);
      labels.set(String(c.id), CONCEPT_LABEL.conversation(bare(pid), kind === 'MAIN' ? 'MAIN' : `${kind}#${++sub}`));
    }
  }

  // message: ranked within (conversation, kind, sender) by time then id. CHAT
  // ranks within the conversation; a delivered kind also carries its sender,
  // so the copy the target inserts into a subject's conversation (plan §3 step
  // 9) renumbers nothing that already existed. The audience is in the label, so
  // a message routed to the wrong conversation reads as a different message.
  const convPart = (convLabel: string): string => bare(convLabel).replace(/\/MAIN$/, '');
  const messageGroup = (m: ConceptRow): string | null => {
    const conv = label(m.conversation_id);
    if (!conv) return null;
    const kind = str(m.kind);
    if (kind === 'CHAT') return convPart(conv);
    const sender = label(m.sender_participant_id);
    const from = sender ? bare(sender).split('@')[0] : 'ai';
    return `${convPart(conv)}/${kind}:${from}`;
  };
  for (const [group, msgs] of groupBy(rows('message'), messageGroup)) {
    sortedBy(msgs, ['created_at']).forEach((m, i) => labels.set(String(m.id), `<message:${group}#${i + 1}>`));
  }

  // empathy_attempt: direction and round. Both ends must resolve: an attempt
  // with no subject is the unrevealed-to-whom state the target forbids, and a
  // placeholder label would fail open.
  for (const a of rows('empathy_attempt')) {
    const author = label(a.author_participant_id);
    const subject = label(a.subject_participant_id);
    if (!author || !subject) continue;
    const [who, session] = bare(author).split('@');
    const about = bare(subject).split('@')[0];
    labels.set(String(a.id), `<empathyAttempt:${who}→${about}@${session}#${str(a.round)}>`);
  }

  // Rows named after their parent, plus a natural suffix; a collision (two
  // rows with one natural key) is numbered within that key only.
  const fromParent = (concept: string, kind: string, parentCol: string, suffix: (r: ConceptRow) => string): void => {
    for (const [parent, group] of groupBy(rows(concept), r => label(r[parentCol]))) {
      const seen = new Map<string, number>();
      for (const r of sortedBy(group, [])) {
        const base = `${bare(parent)}${suffix(r)}`;
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        labels.set(String(r.id), `<${kind}:${base}${n > 1 ? `#${n}` : ''}>`);
      }
    }
  };
  // Rows ranked within their parent by a natural order.
  const ranked = (concept: string, kind: string, parentCol: string, order: string[]): void => {
    for (const [parent, group] of groupBy(rows(concept), r => label(r[parentCol]))) {
      sortedBy(group, order).forEach((r, i) => labels.set(String(r.id), `<${kind}:${bare(parent)}#${i + 1}>`));
    }
  };

  fromParent('draft', 'draft', 'participant_id', r => `/${str(r.kind)}`);
  ranked('need', 'need', 'participant_id', ['created_at']);
  ranked('proposal', 'proposal', 'session_id', ['created_at']);
  fromParent('agreement', 'agreement', 'proposal_id', () => '');
  fromParent('reconciler_result', 'reconcilerResult', 'attempt_id', r => `/i${str(r.iteration)}`);
  fromParent('context_share_offer', 'shareOffer', 'attempt_id', r => `/i${str(r.iteration)}`);
  fromParent('empathy_review', 'review', 'attempt_id', () => '');
  ranked('reflection', 'reflection', 'user_id', ['created_at']);
  ranked('reflection_message', 'reflectionMessage', 'reflection_id', ['created_at']);
  ranked('takeaway', 'takeaway', 'reflection_id', ['position']);

  // brain_activity (TS-5): ranked by time within the reflection it belongs to,
  // else its session — `<brainActivity:session:main#2>`,
  // `<brainActivity:reflection:ada#1#1>`. Labels above must exist first.
  for (const [parent, group] of groupBy(rows('brain_activity'), r => label(r.reflection_id) ?? label(r.session_id))) {
    sortedBy(group, ['created_at']).forEach((r, i) =>
      labels.set(String(r.id), `<brainActivity:${inner(parent)}#${i + 1}>`),
    );
  }

  // consent: who decided, over what kind, about which target. A consent whose
  // arc names nothing labelled is ranked within (who, kind) — never globally,
  // which would make a consent against the wrong target byte-identical.
  const ARC = ['need_id', 'empathy_attempt_id', 'proposal_id', 'share_offer_id', 'review_id'];
  for (const [group, consents] of groupBy(rows('consent'), r => {
    const who = label(r.participant_id);
    return who ? `${bare(who)}/${str(r.target_kind) || 'NONE'}` : null;
  })) {
    sortedBy(consents, ['decided_at', 'created_at']).forEach((r, i) => {
      const target = ARC.map(col => label(r[col])).find(Boolean);
      labels.set(String(r.id), `<consent:${group}/${target ? inner(target) : `#${i + 1}`}>`);
    });
  }

  return { labels };
}

/** Composite-key concepts whose row key has its own name in the rename map. */
const ROW_KEY_NAME: Record<string, string> = { participant_milestone: 'milestone' };

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * The structural key of a concept row, from its NORMALISED identity columns.
 *
 * Single-column identities are already labels (`<participant:ada@main>`).
 * Composite ones are rendered from their labelled parts: a milestone is
 * `<milestone:ada@main/feel_heard>`; other junctions are
 * `<proposalChoice:proposal:main#1/participant:bob@main>`.
 */
export function conceptRowKey(concept: string, row: Record<string, unknown>, identity?: string[]): string {
  const declared = (CONCEPT_VIEWS as Record<string, { identity: readonly string[] }>)[concept];
  const cols = identity ?? (declared ? [...declared.identity] : ['id']);
  if (concept === 'participant_milestone') {
    return CONCEPT_LABEL.milestone(bare(str(row.participant_id)), str(row.milestone_key));
  }
  if (cols.length === 1) return str(row[cols[0]]);
  const parts = cols.map(c => {
    const v = str(row[c]);
    return v.startsWith('<') ? inner(v) : v;
  });
  return `<${ROW_KEY_NAME[concept] ?? camel(concept)}:${parts.join('/')}>`;
}
