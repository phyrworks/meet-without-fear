/**
 * Target-shape writer: scenario model → the target tables (TS-9).
 *
 * The sibling of `current-shape.ts`. It consumes the same shape-independent
 * `Scenario` and writes participant-centred rows into the target schema
 * (docs/backend/data-model/schema-target-2026-10.md): `participant`, one MAIN
 * `conversation` each, `participant_milestone` instead of stage numbers and
 * gate JSON, `message` with its role/kind split, `empathy_attempt` with an
 * explicit subject, `consent` as an arc, and so on.
 *
 * It writes through `pg`, never Prisma — the target app is the thing under
 * test, and the fixture must not depend on it.
 *
 * ## Its contract: the concept image of the current-shape fixture
 *
 * The normalised baselines (`golden/__golden__/*.concept.json`) were recorded
 * on the current shape through the `old_concept_*` views. For a target run to
 * be comparable, the target fixture must be the SAME state as those views
 * present the current-shape fixture — the same rows, the same instants, the
 * same write order (ids are uuidv7, so insertion order is id order, and every
 * instant is a timestamp rank the goldens record). So where the old shape
 * encoded a fact lossily and the views (and the plan's step-7 mapping) decode
 * it a particular way, this writer writes the decoded value, not the
 * scenario's "truer" one. Every such place is marked FIDELITY below:
 *
 *   - `invitation_sent` reached_at = the participant's journey start (step 7
 *     decodes the R13 `invitationSent` gate @ StageProgress.startedAt), not
 *     the invitation instant;
 *   - stamps the old factory left to `@default(now())` are taken from one
 *     monotonic clock in the old write order (or, for `explicitStamps`
 *     scenarios, the same fixed offsets current-shape.ts uses);
 *   - participant.joined_at = the RelationshipMember instant (one for all
 *     members, as the old nested create wrote it).
 *
 * And where the target can hold a fact the old views leave out, it is written:
 * `empathy_submitted` (TS-7 step 7 derives it from EmpathyAttempt.sharedAt; the
 * TS-4 view does not). The session-read allow-list names it.
 *
 * FIDELITY (TS-10): the user's name. The old factory wrote only `name`
 * (first_name NULL), so the app's display name (`firstName || name`) was the
 * full name — and run-written messages carry it ("Bob Ross's attempt to
 * understand your experience…"). The target's `name` is GENERATED from
 * first/last, so the writer puts the whole name in `first_name` and leaves
 * `last_name` NULL: `name` and the display name both equal the old
 * fixture's. (TS-9 split it, which renamed "Bob Ross" to "Bob" in every
 * message a run writes.) The first/last columns differ from the current-shape
 * concept view (NULL there); the allow-lists name that.
 *
 * What the target cannot hold at all: a message's journey phase (`stage` is
 * dropped; spec §1.1 message, "derivable from participant_milestone"). The
 * DTO stage of a message is computed by the stage shim from its conversation
 * owner's milestones, so fixtures whose phases disagree with their milestone
 * instants read differently — named in the allow-list.
 *
 * Coverage (TS-11: all of the scenario model). The repair stage, marked
 * FIDELITY where it writes the decoded value:
 *   - legacy strategies → proposal (SHARED_PROPOSAL, USER_SUBMITTED, ACTIVE:
 *     the concept view's defaults for a row that had none), needsAddressed →
 *     proposal_need over need_share by label, the rest unresolved_need_labels;
 *     the legacy agreement → agreement + agreement_party + a WILLING
 *     proposal_choice per party (DEVIATION: T-agreement-parties needs them;
 *     spec: proposal_choice absorbs agreedByA/B "as evidence"); a ranking
 *     writes nothing (ruling R25);
 *   - redesigned repair → proposal / proposal_revision / proposal_choice (at
 *     the chooser's choices_shared instant); the fixture's Stage4NeedCoverage
 *     rows have no table (coverage is v_need_coverage) and are not written;
 *   - shared needs of the repair fixtures (currentShape.unconsentedNeedShares):
 *     consent + need_share with the scenario's shared text (DEVIATION: today's
 *     fixture wrote neither; the target's repair stage can address only a
 *     shared need) — the consent stamped at the share instant so no new
 *     timestamp rank appears;
 *   - closure → session_closure + the session RESOLVED.
 */

import type { ClientBase } from 'pg';
import { contentHash } from '../../utils/content-hash';
import {
  invitationFields,
  messageSender,
  referencedClocks,
  resolveStamp,
  sessionStatus,
  type CurrentShapeResult,
  type UserRef,
  type WrittenUser,
} from './current-shape';
import {
  CLOCKS,
  Clock,
  MilestoneKey,
  ParticipantKey,
  Scenario,
  ScenarioMessage,
  ScenarioMessageRole,
  Stamp,
} from './scenario-model';

export type TargetShapeResult = CurrentShapeResult;

/**
 * Scenario features this writer refuses. Since TS-11 it covers the repair
 * stage (legacy strategies + agreement, redesigned proposals/revisions/
 * choices, closure); a ranking writes nothing (ruling R25) and is accepted.
 */
export function unsupportedFeatures(s: Scenario): string[] {
  void s;
  return [];
}

/** Old role → target (role, kind): event roles become a kind; role USER when a participant sent it (spec §3). */
export function roleAndKind(role: ScenarioMessageRole, hasSender: boolean): { role: 'USER' | 'AI'; kind: string } {
  if (role === 'USER' || role === 'AI') return { role, kind: 'CHAT' };
  return { role: hasSender ? 'USER' : 'AI', kind: role };
}

/** `Ada Lovelace` → first `Ada`, last `Lovelace` (the target's `name` is generated from them). */
export function splitName(name: string): { first: string | null; last: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') || null };
}

/**
 * A participant's milestones as the target stores them (participant_milestone),
 * with the FIDELITY instants described in the module header.
 */
export function milestoneRows(
  p: Scenario['participants'][number],
  t: (s: Stamp) => Date,
  journeyStart: Date | undefined,
): Array<{ key: MilestoneKey; reachedAt: Date }> {
  const out: Array<{ key: MilestoneKey; reachedAt: Date }> = [];
  for (const [key, stamp] of Object.entries(p.milestones) as Array<[MilestoneKey, Stamp]>) {
    if (!stamp) continue;
    if (key === 'invitation_sent') {
      // FIDELITY: step 7 decodes the R13 gate at the stage-0 row's startedAt.
      if (!journeyStart) throw new Error(`Participant "${p.key}" sent the invitation but has no journey`);
      out.push({ key, reachedAt: journeyStart });
      continue;
    }
    out.push({ key, reachedAt: t(stamp) });
  }
  return out;
}

/**
 * The reveal instant of an attempt. The target CHECKs `status IN
 * ('REVEALED','VALIDATED') → revealed_at IS NOT NULL`; some pre-rebuild
 * scenarios (NEED_MAPPING_COMPLETE, NEEDS_CONFIRMED) carry VALIDATED attempts
 * with no reveal instant, which the target cannot hold. FIDELITY DEVIATION:
 * those take the validation instant (else the submission instant) — a
 * new instant for those fixtures' concept goldens (no TS-9 golden uses them).
 */
export function revealedAtFor(
  e: { status: string; revealedAt?: Stamp; validatedBy?: { at: Stamp } },
  t: (s: Stamp) => Date,
  submittedAt?: Stamp,
): Date | null {
  if (e.revealedAt) return t(e.revealedAt);
  if (e.status !== 'REVEALED' && e.status !== 'VALIDATED') return null;
  if (e.validatedBy) return t(e.validatedBy.at);
  if (submittedAt) return t(submittedAt);
  throw new Error(`An attempt ${e.status} needs a reveal instant`);
}

const q = {
  user: `INSERT INTO "user" (email, clerk_id, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (email) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
         RETURNING id, email, name`,
};

/**
 * Write a scenario into the target tables. `users[i]` is the account for
 * `scenario.participants[i]`. Runs in the caller's transaction.
 */
export async function writeTargetShape(db: ClientBase, scenario: Scenario, users: UserRef[]): Promise<TargetShapeResult> {
  const unsupported = unsupportedFeatures(scenario);
  if (unsupported.length) {
    throw new Error(`Scenario ${scenario.name}: the target writer does not cover ${unsupported.join(', ')} yet`);
  }
  if (users.length !== scenario.participants.length) {
    throw new Error(`Scenario ${scenario.name} has ${scenario.participants.length} participants but ${users.length} users`);
  }

  // --- Clocks and auto stamps (FIDELITY: current-shape.ts's order) -----------
  const clocks = new Set(referencedClocks(scenario));
  const instants: Partial<Record<Clock, Date>> = {};
  const explicit = scenario.currentShape?.explicitStamps === true;
  const base = new Date();
  const CLOCK_OFFSET_MS: Record<Clock, number> = { session: 0, invitation: 10, scenario: 20, late: 30 };
  // Real-clock mode: one monotonic cursor, 1ms per read, so two reads never
  // share a millisecond (the old factory's reads could, by luck).
  let cursor = base.getTime();
  const tick = (): Date => new Date(++cursor);
  let autoN = 0;
  const auto = (): Date => (explicit ? new Date(base.getTime() - 60_000 + autoN++) : tick());
  const readClock = (c: Clock): void => {
    if (!clocks.has(c)) return;
    instants[c] = explicit ? new Date(base.getTime() + CLOCK_OFFSET_MS[c]) : tick();
  };
  void CLOCKS;
  const t = (s: Stamp): Date => resolveStamp(s, instants);
  const tOpt = (s: Stamp | undefined): Date | null => (s ? t(s) : null);

  // --- Users -------------------------------------------------------------------
  const userRows: WrittenUser[] = [];
  for (const u of users) {
    // FIDELITY (header): the whole name as first_name, so name = display name = the old fixture's.
    const first = u.name.trim() || null;
    const last = null;
    const clerk = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const r = await db.query<{ id: string; email: string; name: string | null }>(q.user, [
      u.email,
      clerk,
      first,
      last,
      auto(),
    ]);
    userRows.push(r.rows[0]);
  }

  // --- Relationship and members ---------------------------------------------------
  const relAt = auto();
  const rel = await db.query<{ id: string }>(
    `INSERT INTO relationship (created_at, updated_at) VALUES ($1, $1) RETURNING id`,
    [relAt],
  );
  const relationshipId = rel.rows[0].id;
  const joinedAt = explicit ? null : auto(); // one instant for the nested create
  const memberJoined: Date[] = [];
  for (const [i, u] of users.entries()) {
    const at = joinedAt ?? auto();
    memberJoined.push(at);
    await db.query(
      `INSERT INTO relationship_member (relationship_id, user_id, nickname, joined_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [relationshipId, userRows[i].id, i === 0 ? users[1]?.name || null : users[0].name, at],
    );
    void u;
  }

  // --- Session -------------------------------------------------------------------
  readClock('session');
  const sessionAt = auto();
  const session = await db.query<{ id: string; status: string }>(
    `INSERT INTO session (relationship_id, status, topic_frame, topic_frame_confirmed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, status::text AS status`,
    [relationshipId, sessionStatus(scenario), scenario.topic?.frame ?? null, scenario.topic ? t(scenario.topic.confirmedAt) : null, sessionAt],
  );
  const sessionId = session.rows[0].id;

  // --- Participants and their MAIN conversations ----------------------------------
  const participantOf = new Map<ParticipantKey, string>();
  const conversationOf = new Map<ParticipantKey, string>();
  for (const [i, p] of scenario.participants.entries()) {
    const at = memberJoined[i];
    const r = await db.query<{ id: string }>(
      `INSERT INTO participant (session_id, user_id, kind, display_name, joined_at, created_at, updated_at)
       VALUES ($1, $2, 'human', $3, $4, $4, $4) RETURNING id`,
      [sessionId, userRows[i].id, users[i].name, at],
    );
    participantOf.set(p.key, r.rows[0].id);
    const c = await db.query<{ id: string }>(
      `INSERT INTO conversation (participant_id, kind, status, created_at, updated_at)
       VALUES ($1, 'MAIN', 'ACTIVE', $2, $2) RETURNING id`,
      [r.rows[0].id, at],
    );
    conversationOf.set(p.key, c.rows[0].id);
  }
  const pid = (key: ParticipantKey): string => {
    const id = participantOf.get(key);
    if (!id) throw new Error(`Scenario ${scenario.name}: unknown participant "${key}"`);
    return id;
  };
  const otherOf = (key: ParticipantKey): string | null => {
    const others = scenario.participants.filter(p => p.key !== key);
    return others.length === 1 ? pid(others[0].key) : null;
  };

  // --- Invitation --------------------------------------------------------------------
  readClock('invitation');
  const inv = invitationFields(scenario);
  const invitee = scenario.participants.length > 1 ? userRows[1].id : null;
  const invitation = await db.query<{ id: string; status: string }>(
    `INSERT INTO invitation (session_id, invited_by_participant_id, accepted_by_user_id, name, status,
                             message_confirmed_at, expires_at, accepted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id, status::text AS status`,
    [
      sessionId,
      pid(scenario.participants[0].key),
      inv.status === 'ACCEPTED' ? invitee : null,
      users[1]?.name || 'Partner',
      inv.status,
      inv.messageConfirmed && inv.messageConfirmedAt ? t(inv.messageConfirmedAt) : null,
      t(inv.expiresAt),
      tOpt(inv.acceptedAt),
      t(inv.createdAt),
    ],
  );

  // FIDELITY: the old factory created the shared vessel and one vessel per
  // participant here (auto stamps), before the scenario clock. A vessel's
  // read-state columns are the target's conversation_read_state (one per
  // participant; the old view's updated_at is the vessel's).
  auto();
  for (const p of scenario.participants) {
    const at = auto();
    await db.query(
      `INSERT INTO conversation_read_state (participant_id, created_at, updated_at) VALUES ($1, $2, $2)`,
      [pid(p.key), at],
    );
  }

  readClock('scenario');

  const writeMessage = async (forKey: ParticipantKey, m: ScenarioMessage, sourceAttemptId: string | null = null) => {
    const from = messageSender(forKey, m);
    const { role, kind } = roleAndKind(m.role, from !== null);
    const conversationId = conversationOf.get(forKey);
    if (!conversationId) throw new Error(`No conversation for participant "${forKey}"`);
    await db.query(
      `INSERT INTO message (conversation_id, sender_participant_id, role, kind, content, content_hash, source_attempt_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [conversationId, from === null ? null : pid(from), role, kind, m.content, contentHash(m.content), sourceAttemptId, t(m.at)],
    );
  };

  const attemptOf = new Map<ParticipantKey, string>();
  const lateMilestones: Array<{ p: Scenario['participants'][number]; me: string; journeyStart: Date | undefined }> = [];
  /** The shared needs written (need_share ids = need ids), with their owners' labels, for proposal_need label matching. */
  const sharedNeeds: Array<{ id: string; label: string }> = [];
  for (const [i, p] of scenario.participants.entries()) {
    const me = pid(p.key);

    // Stage-0 startedAt: the journey start, or (journey with no instant) a
    // clock read where the old factory wrote the row.
    const journeyStart = p.journey ? (p.journey.startedAt ? t(p.journey.startedAt) : auto()) : undefined;
    // Milestones on the `late` clock (choices_shared of the redesigned repair
    // flow) are written once that clock is read, after the repair content —
    // as current-shape.ts records them (its "late gates").
    const early = { ...p, milestones: Object.fromEntries(Object.entries(p.milestones).filter(([, st]) => st?.clock !== 'late')) };
    lateMilestones.push({ p, me, journeyStart });
    for (const m of milestoneRows(early, t, journeyStart)) {
      await db.query(
        `INSERT INTO participant_milestone (participant_id, milestone_key, reached_at, created_at) VALUES ($1, $2, $3, $3)`,
        [me, m.key, m.reachedAt],
      );
    }

    for (const m of p.messages ?? []) await writeMessage(p.key, m);

    if (p.empathy) {
      const e = p.empathy;
      const submittedAt = p.milestones.empathy_submitted;
      if (!submittedAt) throw new Error(`Participant "${p.key}" has an empathy attempt but no empathy_submitted milestone`);
      const subject = otherOf(p.key);
      if (!subject) throw new Error(`Participant "${p.key}": an empathy attempt needs exactly one other participant`);
      const draftAt = auto();
      await db.query(
        `INSERT INTO draft (participant_id, kind, about_participant_id, content, ready_to_share, version, created_at, updated_at)
         VALUES ($1, 'EMPATHY', $2, $3, true, 1, $4, $4)`,
        [me, subject, e.statement, draftAt],
      );
      const attemptAt = auto();
      const a = await db.query<{ id: string }>(
        `INSERT INTO empathy_attempt (author_participant_id, subject_participant_id, round, content, status, status_version,
                                      submitted_at, revealed_at, delivery_status, delivered_at, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $4, 0, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [
          me,
          subject,
          e.statement,
          e.status,
          t(submittedAt),
          revealedAtFor(e, t, submittedAt),
          e.deliveredAt ? 'DELIVERED' : 'PENDING',
          tOpt(e.deliveredAt),
          attemptAt,
        ],
      );
      attemptOf.set(p.key, a.rows[0].id);
      if (e.consentRecorded) {
        await db.query(
          `INSERT INTO consent (participant_id, requested_by_participant_id, empathy_attempt_id, decision, decided_at, created_at, updated_at)
           VALUES ($1, $1, $2, 'GRANTED', $3, $4, $4)`,
          [me, a.rows[0].id, t(submittedAt), auto()],
        );
      }
      if (e.statementInChat) {
        await writeMessage(
          p.key,
          { role: 'EMPATHY_STATEMENT', content: e.statement, phase: 'perspective', at: submittedAt, from: p.key },
          a.rows[0].id,
        );
      }
      if (e.validatedBy) {
        await writeMessage(p.key, {
          role: 'EMPATHY_VALIDATION_PROMPT',
          content: 'VALIDATED',
          phase: 'perspective',
          at: e.validatedBy.at,
          from: e.validatedBy.participant,
        });
      }
    }

    if (p.needs?.length) {
      const confirmedAt = p.milestones.needs_confirmed;
      if (!confirmedAt) throw new Error(`Participant "${p.key}" has needs but no needs_confirmed milestone`);
      const sharedAt = p.milestones.needs_shared;
      for (const [k, n] of p.needs.entries()) {
        const created = explicit ? new Date(t(confirmedAt).getTime() + k) : t(confirmedAt);
        const row = await db.query<{ id: string }>(
          `INSERT INTO need (participant_id, label, category, evidence, ai_confidence, confirmed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
          [me, n.need, n.category, n.evidence ?? [], n.aiConfidence, n.confirmed ? created : null, created],
        );
        if (n.shared) {
          if (!sharedAt) throw new Error(`Participant "${p.key}" shares needs but has no needs_shared milestone`);
          sharedNeeds.push({ id: row.rows[0].id, label: n.need });
          // FIDELITY (TS-11): the repair fixtures had no consent row today
          // (unconsentedNeedShares), so a fresh auto stamp would be a NEW
          // instant renumbering every later timestamp rank of their concept
          // image; the consent is stamped at the share instant instead.
          await db.query(
            `INSERT INTO consent (participant_id, requested_by_participant_id, need_id, decision, decided_at, created_at, updated_at)
             VALUES ($1, $1, $2, 'GRANTED', $3, $4, $4)`,
            [me, row.rows[0].id, t(sharedAt), scenario.currentShape?.unconsentedNeedShares ? t(sharedAt) : auto()],
          );
          await db.query(
            `INSERT INTO need_share (need_id, participant_id, session_id, category, shared_text, shared_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
            [row.rows[0].id, me, sessionId, n.category, n.shared.text, t(sharedAt)],
          );
        }
      }
    }
    void i;
  }

  // --- Reconciliation ------------------------------------------------------------------
  if (scenario.reconciliation) {
    const { result: r, shareOffer: offer, messages } = scenario.reconciliation;
    const attemptId = attemptOf.get(r.guesser);
    if (!attemptId) throw new Error(`Scenario ${scenario.name}: the reconciler result's guesser has no attempt`);
    const result = await db.query<{ id: string }>(
      `INSERT INTO reconciler_result (attempt_id, subject_participant_id, iteration, alignment_score, alignment_summary,
         gap_summary, gap_severity, correctly_identified, missed_feelings, misattributions, most_important_gap,
         recommended_action, rationale, sharing_would_help, suggested_share_focus, suggested_share_content,
         suggested_share_reason, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5, upper($6)::gap_severity, $7, $8, $9, $10, upper($11)::recommender_action, $12, $13, $14, $15, $16, $17, $17)
       RETURNING id`,
      [
        attemptId,
        pid(r.subject),
        r.alignmentScore,
        r.alignmentSummary,
        r.gapSummary,
        r.gapSeverity,
        r.correctlyIdentified,
        r.missedFeelings,
        r.misattributions,
        r.mostImportantGap,
        r.recommendedAction,
        r.rationale,
        r.sharingWouldHelp,
        r.suggestedShareFocus,
        r.suggestedShareContent,
        r.suggestedShareReason,
        t(r.at),
      ],
    );
    const offerAt = auto();
    await db.query(
      `INSERT INTO context_share_offer (attempt_id, result_id, subject_participant_id, iteration, status, suggested_content,
         suggested_reason, shared_content, shared_at, delivery_status, delivered_at, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [
        attemptId,
        result.rows[0].id,
        pid(r.subject),
        offer.status,
        offer.suggestedContent,
        r.suggestedShareReason,
        offer.shared?.content ?? null,
        offer.shared ? t(offer.shared.at) : null,
        offer.deliveredAt ? 'DELIVERED' : 'PENDING',
        tOpt(offer.deliveredAt),
        offerAt,
      ],
    );
    for (const m of messages ?? []) await writeMessage(m.to, m);
  }

  // --- Legacy Stage 4: strategies, agreement (TS-11) -----------------------------
  // StrategyProposal → proposal (kind SHARED_PROPOSAL, source the model's
  // default USER_SUBMITTED, status ACTIVE — FIDELITY: the old row had no
  // status/kind and the concept view projects the defaults), its
  // needsAddressed labels → proposal_need over the session's need_share rows
  // (label match, case-insensitive, as old_concept_proposal_need) and the
  // labels nothing matches → unresolved_need_labels. A ranking writes NOTHING
  // (ruling R25: ranking is not in the product). The agreement → agreement +
  // agreement_party for agreedBy; T-agreement-parties requires every party
  // WILLING, so the agreed proposal gets a WILLING proposal_choice per party
  // at agreedAt (spec §1.4 proposal_choice absorbs "Agreement.agreedByA/agreedByB
  // (as evidence)") — FIDELITY DEVIATION: the current-shape concept view shows
  // no choice for the legacy flow.
  const proposalIdOf = new Map<string, string>();
  /** Labels → the shared needs they name (case-insensitive label match), and the labels nothing matches. */
  const matchNeeds = (labels: string[]): { ids: string[]; unresolved: string[] } => {
    const ids: string[] = [];
    const unresolved: string[] = [];
    for (const label of labels) {
      const hit = sharedNeeds.filter(n => n.label.toLowerCase() === label.toLowerCase());
      if (!hit.length) unresolved.push(label);
      for (const n of hit) if (!ids.includes(n.id)) ids.push(n.id);
    }
    return { ids, unresolved };
  };
  const linkNeeds = async (proposalId: string, ids: string[], at: Date): Promise<void> => {
    for (const id of ids) {
      await db.query(`INSERT INTO proposal_need (proposal_id, need_id, created_at) VALUES ($1, $2, $3)`, [proposalId, id, at]);
    }
  };
  if (scenario.legacyStrategies) {
    const { strategies, agreement } = scenario.legacyStrategies;
    for (const st of strategies) {
      const createdAt = t(st.at);
      const updatedAt = auto();
      const linked = matchNeeds(st.needsAddressed);
      const row = await db.query<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_participant_id, description, duration, unresolved_need_labels, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [sessionId, pid(st.by), st.description, st.duration, linked.unresolved, createdAt, updatedAt],
      );
      proposalIdOf.set(st.key, row.rows[0].id);
      await linkNeeds(row.rows[0].id, linked.ids, createdAt);
    }
    if (agreement) {
      const proposalId = proposalIdOf.get(agreement.proposal);
      if (!proposalId) throw new Error(`Scenario ${scenario.name}: unknown strategy "${agreement.proposal}"`);
      const agreedAt = t(agreement.agreedAt);
      for (const key of agreement.agreedBy) {
        await db.query(
          `INSERT INTO proposal_choice (proposal_id, participant_id, decision, created_at, updated_at)
           VALUES ($1, $2, 'WILLING', $3, $3)`,
          [proposalId, pid(key), agreedAt],
        );
      }
      const a = await db.query<{ id: string }>(
        `INSERT INTO agreement (session_id, proposal_id, type, status, description, follow_up_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
        [sessionId, proposalId, agreement.type, agreement.status, agreement.description, t(agreement.followUpAt), agreedAt],
      );
      for (const key of agreement.agreedBy) {
        await db.query(
          `INSERT INTO agreement_party (agreement_id, participant_id, agreed_at, created_at) VALUES ($1, $2, $3, $3)`,
          [a.rows[0].id, pid(key), agreedAt],
        );
      }
    }
  }

  readClock('late');

  // --- Redesigned Stage 4: proposals, revisions, choices (TS-11) ------------------
  // The concept image of current-shape.ts's repair block. Its
  // Stage4NeedCoverage rows have no table (coverage is v_need_coverage,
  // computed) and are not written; needsAddressed labels become proposal_need
  // rows over need_share (as above). Revisions → proposal_revision (actor,
  // action, before/after, reason; no message id). Choices proposal-major, at
  // the chooser's choices_shared instant (created_at ← selectedAt, as the
  // concept view projects it; updated_at an auto stamp as the old @updatedAt).
  if (scenario.repair) {
    const { proposals, revisions } = scenario.repair;
    for (const pr of proposals) {
      const at = auto();
      const linked = matchNeeds(pr.needsAddressed);
      const row = await db.query<{ id: string }>(
        `INSERT INTO proposal (session_id, created_by_participant_id, kind, status, description, duration, measure_of_success,
                               removed_at, removed_by_participant_id, removal_reason, unresolved_need_labels, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12) RETURNING id`,
        [
          sessionId,
          pid(pr.by),
          pr.kind,
          pr.removed ? 'REMOVED' : 'ACTIVE',
          pr.description,
          pr.duration,
          pr.measureOfSuccess,
          pr.removed ? t(pr.removed.at) : null,
          pr.removed ? pid(pr.removed.by) : null,
          pr.removed?.reason ?? null,
          linked.unresolved,
          at,
        ],
      );
      proposalIdOf.set(pr.key, row.rows[0].id);
      await linkNeeds(row.rows[0].id, linked.ids, at);
    }
    const proposalId = (key: string): string => {
      const id = proposalIdOf.get(key);
      if (!id) throw new Error(`Scenario ${scenario.name}: unknown proposal "${key}"`);
      return id;
    };
    for (const r of revisions) {
      await db.query(
        `INSERT INTO proposal_revision (proposal_id, actor_participant_id, action, before, after, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [proposalId(r.proposal), pid(r.actor), r.action, r.before ? JSON.stringify(r.before) : null, JSON.stringify(r.after), r.reason, auto()],
      );
    }
    for (const pr of proposals) {
      for (const p of scenario.participants) {
        for (const c of (p.choices ?? []).filter(c => c.proposal === pr.key)) {
          const sharedAt = p.milestones.choices_shared;
          if (!sharedAt) throw new Error(`Participant "${p.key}" has choices but no choices_shared milestone`);
          await db.query(
            `INSERT INTO proposal_choice (proposal_id, participant_id, decision, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
            [proposalId(pr.key), pid(p.key), c.decision, t(sharedAt), auto()],
          );
        }
      }
    }
  }

  for (const { p, me, journeyStart } of lateMilestones) {
    const late = { ...p, milestones: Object.fromEntries(Object.entries(p.milestones).filter(([, st]) => st?.clock === 'late')) };
    for (const m of milestoneRows(late, t, journeyStart)) {
      await db.query(
        `INSERT INTO participant_milestone (participant_id, milestone_key, reached_at, created_at) VALUES ($1, $2, $3, $3)`,
        [me, m.key, m.reachedAt],
      );
    }
  }

  // --- Closure (OD5): session_closure, then the session RESOLVED ------------------
  // The three id arrays are v_session_closure_items (computed).
  if (scenario.closure) {
    const c = scenario.closure;
    await db.query(
      `INSERT INTO session_closure (session_id, kind, reason, summary, closed_by_participant_id, check_in_at, closed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, c.kind, c.reason, c.summary, c.closedBy === null ? null : pid(c.closedBy), tOpt(c.checkInAt), t(c.at), auto()],
    );
    await db.query(`UPDATE session SET status = 'RESOLVED', resolved_at = $2, updated_at = $3 WHERE id = $1`, [
      sessionId,
      t(c.at),
      auto(),
    ]);
  }

  // --- Inner Work and prompt captures -------------------------------------------------
  for (const [i, p] of scenario.participants.entries()) {
    const reflectionIds: string[] = [];
    for (const r of p.reflections ?? []) {
      // FIDELITY: the old view's linked_at is the linking row's updatedAt.
      const updatedAt = auto();
      const row = await db.query<{ id: string }>(
        `INSERT INTO reflection (user_id, title, theme, summary, linked_session_id, linked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          userRows[i].id,
          r.title,
          r.theme ?? null,
          r.summary ?? null,
          r.linkedToSession ? sessionId : null,
          r.linkedToSession ? updatedAt : null,
          t(r.at),
          updatedAt,
        ],
      );
      reflectionIds.push(row.rows[0].id);
      for (const m of r.messages) {
        await db.query(
          `INSERT INTO reflection_message (reflection_id, role, content, created_at) VALUES ($1, $2, $3, $4)`,
          [row.rows[0].id, m.role, m.content, t(m.at)],
        );
      }
    }
    for (const [k, c] of (p.promptCaptures ?? []).entries()) {
      const reflectionId = c.scope === 'session' ? null : reflectionIds[c.scope.reflection];
      if (c.scope !== 'session' && !reflectionId) {
        throw new Error(`Participant "${p.key}": prompt capture ${k} names a missing reflection`);
      }
      await db.query(
        `INSERT INTO brain_activity (session_id, reflection_id, participant_id, turn_id, activity_type, call_type, model,
                                     input, output, status, created_at, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, 'LLM_CALL', $5, 'claude-sonnet', $6, $7, 'COMPLETED', $8, $8, $8)`,
        [
          reflectionId ? null : sessionId,
          reflectionId,
          null,
          `${reflectionId ?? sessionId}-${userRows[i].id}-turn-${k + 1}`,
          c.callType,
          JSON.stringify(c.input),
          JSON.stringify({ text: c.output }),
          t(c.at),
        ],
      );
    }
  }

  return {
    session: { id: sessionId, status: session.rows[0].status, relationshipId },
    users: userRows,
    invitation: { id: invitation.rows[0].id, status: invitation.rows[0].status },
  };
}
