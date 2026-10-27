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
 * Coverage: everything the scenario model carries except the repair stage
 * (`legacyStrategies`, `repair`, `choices`, `ranking`, `closure`) — those
 * throw rather than write a partial state. Covered stages include CREATED,
 * INVITATION_READY, EMPATHY_SHARED_A, FEEL_HEARD_B, RECONCILER_SHOWN_B,
 * CONTEXT_SHARED_B, EMPATHY_REVEALED, NEED_MAPPING_COMPLETE, NEEDS_CONFIRMED and
 * INNER_WORK_LINKED_A.
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

/** Scenario features this writer refuses (target tables exist; no scenario in scope needs them yet). */
export function unsupportedFeatures(s: Scenario): string[] {
  const out: string[] = [];
  if (s.legacyStrategies) out.push('legacyStrategies');
  if (s.repair) out.push('repair');
  if (s.closure) out.push('closure');
  for (const p of s.participants) {
    if (p.choices?.length) out.push(`participant ${p.key}: choices`);
    if (p.ranking) out.push(`participant ${p.key}: ranking`);
  }
  return out;
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
  for (const [i, p] of scenario.participants.entries()) {
    const me = pid(p.key);

    // Stage-0 startedAt: the journey start, or (journey with no instant) a
    // clock read where the old factory wrote the row.
    const journeyStart = p.journey ? (p.journey.startedAt ? t(p.journey.startedAt) : auto()) : undefined;
    for (const m of milestoneRows(p, t, journeyStart)) {
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
          await db.query(
            `INSERT INTO consent (participant_id, requested_by_participant_id, need_id, decision, decided_at, created_at, updated_at)
             VALUES ($1, $1, $2, 'GRANTED', $3, $4, $4)`,
            [me, row.rows[0].id, t(sharedAt), auto()],
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

  readClock('late');

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
