/**
 * Current-shape writer: scenario model → today's tables.
 *
 * Translates a shape-independent `Scenario` into the pre-rebuild schema —
 * `StageProgress` rows with stage integers and `gatesSatisfied` JSON,
 * `Session.status`, `Invitation` flags, and the content tables — through Prisma.
 *
 * Its contract is byte-fidelity with the factory it replaced: the same rows,
 * the same values, the same timestamp lattice, the same clerkId convention,
 * and the same order of writes and clock reads. Order matters even where no
 * value depends on it: ids are `uuidv7()` (insertion-ordered, and snapshots are
 * PK-ordered), and every `@default(now())` stamp is a clock read whose rank the
 * goldens record. So the write sequence below is part of the spec; the comments
 * say which scenario each ordering rule exists for.
 *
 * The milestone ↔ gate-key mapping is `GATE_ENCODING`. It is the encoding
 * *today's fixtures* used, which is not quite the production key table of the
 * migration plan (step 7): the fixtures wrote `empathyExchanged` where the app
 * writes `empathyValidated`, `needsIdentified` for `needs_confirmed`,
 * `compactSignedAt` rather than `signedAt`, and never wrote `invitationSent` or
 * `needsShared`. Acceptance binds the writer to the fixtures' rows.
 *
 * The pure functions (everything above `writeCurrentShape`) have unit tests in
 * `__tests__/current-shape.test.ts`.
 */

import { prisma } from '../../lib/prisma';
import {
  CLOCKS,
  Clock,
  JourneyPhase,
  MilestoneKey,
  ParticipantKey,
  ParticipantScenario,
  Scenario,
  ScenarioMessage,
  Stamp,
} from './scenario-model';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ============================================================================
// Milestone ↔ gate-key encoding
// ============================================================================

/**
 * How each milestone is encoded in today's shape.
 *
 * - `gate`: written into `gatesSatisfied` of the stage-`stage` row as
 *   `{ [key]: true, [key + 'At']: <iso> }` (the `At` companion is omitted for
 *   milestones in `currentShape.untimedGates`).
 * - `completes`: the milestone is stage `stage`'s terminal milestone — the row
 *   is `COMPLETED` at its instant and the next stage starts then. It may also
 *   carry a gate key (stages 0–2) or none (`needs_shared`, `closed`).
 * - `elsewhere`: carried by another row, never by a gate.
 * - `unsupported`: today's fixtures never encoded it; refusing beats dropping.
 */
export type GateEncoding =
  | { kind: 'gate'; stage: number; key: string; completes?: boolean; late?: boolean }
  | { kind: 'completes'; stage: number }
  | { kind: 'elsewhere'; where: string }
  | { kind: 'unsupported' };

export const GATE_ENCODING: Record<MilestoneKey, GateEncoding> = {
  compact_signed: { kind: 'gate', stage: 0, key: 'compactSigned', completes: true },
  invitation_sent: { kind: 'elsewhere', where: 'Invitation.messageConfirmed/messageConfirmedAt' },
  feel_heard: { kind: 'gate', stage: 1, key: 'feelHeardConfirmed', completes: true },
  empathy_submitted: { kind: 'elsewhere', where: 'EmpathyAttempt.sharedAt (+ ConsentRecord, statement message)' },
  empathy_ready: { kind: 'unsupported' },
  empathy_validated: { kind: 'gate', stage: 2, key: 'empathyExchanged', completes: true },
  needs_confirmed: { kind: 'gate', stage: 3, key: 'needsIdentified' },
  needs_validated: { kind: 'gate', stage: 3, key: 'needsValidated' },
  needs_shared: { kind: 'completes', stage: 3 },
  // Recorded after the choices it attests to (an update of the stage-4 row).
  choices_shared: { kind: 'gate', stage: 4, key: 'selectionSubmitted', late: true },
  repair_walkthrough_started: { kind: 'unsupported' },
  closed: { kind: 'completes', stage: 4 },
  paused: { kind: 'unsupported' },
};

const LAST_STAGE = 4;

/** Terminal milestone of each stage, by stage number. */
const TERMINAL: MilestoneKey[] = (() => {
  const t: MilestoneKey[] = [];
  for (const [key, enc] of Object.entries(GATE_ENCODING) as [MilestoneKey, GateEncoding][]) {
    if ((enc.kind === 'gate' && enc.completes) || enc.kind === 'completes') t[enc.stage] = key;
  }
  return t;
})();

/** A gate entry: a flag (`true`) or a timestamp companion (resolved to ISO on write). */
export type GateEntry = [string, true | Stamp];

export interface StageRow {
  stage: number;
  status: 'IN_PROGRESS' | 'COMPLETED';
  /** Absent: the database default (`now()`). */
  startedAt: Stamp | undefined;
  completedAt: Stamp | undefined;
  gates: GateEntry[];
}

export interface StageProgressPlan {
  rows: StageRow[];
  /** Gates recorded after the session content they attest to (`updateMany`). */
  lateGates: Array<{ stage: number; gates: GateEntry[] }>;
}

/**
 * A participant's milestone set → today's `StageProgress` rows.
 *
 * Stage n is COMPLETED iff its terminal milestone is reached, at that instant;
 * stage n+1 starts then. The first incomplete stage is the IN_PROGRESS row; a
 * participant who has completed every stage has none. Stage 0 starts at the
 * journey's `startedAt`.
 */
export function stageProgressPlan(p: ParticipantScenario, s: Scenario): StageProgressPlan {
  const reached = p.milestones;
  for (const key of Object.keys(reached) as MilestoneKey[]) {
    if (GATE_ENCODING[key].kind === 'unsupported') {
      throw new Error(`Participant "${p.key}": milestone ${key} has no encoding in today's fixture shape`);
    }
  }
  if (!p.journey) {
    const stray = (Object.keys(reached) as MilestoneKey[]).filter(k => GATE_ENCODING[k].kind !== 'elsewhere');
    if (stray.length) throw new Error(`Participant "${p.key}" has not begun but reached ${stray.join(', ')}`);
    return { rows: [], lateGates: [] };
  }

  let completed = 0;
  while (completed <= LAST_STAGE && reached[TERMINAL[completed]]) completed++;
  for (let stage = completed + 1; stage <= LAST_STAGE; stage++) {
    if (reached[TERMINAL[stage]]) {
      throw new Error(
        `Participant "${p.key}": ${TERMINAL[stage]} completes stage ${stage}, but ${TERMINAL[completed]} (stage ${completed}) is not reached`,
      );
    }
  }

  const untimed = new Set(s.currentShape?.untimedGates ?? []);
  const rows: StageRow[] = [];
  const lastRow = Math.min(completed, LAST_STAGE);
  for (let stage = 0; stage <= lastRow; stage++) {
    const isCompleted = stage < completed;
    rows.push({
      stage,
      status: isCompleted ? 'COMPLETED' : 'IN_PROGRESS',
      startedAt: stage === 0 ? p.journey.startedAt : reached[TERMINAL[stage - 1]],
      completedAt: isCompleted ? reached[TERMINAL[stage]] : undefined,
      gates: [],
    });
  }

  const lateGates: StageProgressPlan['lateGates'] = [];
  for (const key of Object.keys(GATE_ENCODING) as MilestoneKey[]) {
    const enc = GATE_ENCODING[key];
    const stamp = reached[key];
    if (!stamp || enc.kind !== 'gate') continue;
    const row = rows.find(r => r.stage === enc.stage);
    if (!row) {
      throw new Error(
        `Participant "${p.key}": ${key} is a stage ${enc.stage} gate, but the participant has not reached stage ${enc.stage}`,
      );
    }
    const entries: GateEntry[] = [[enc.key, true]];
    if (!untimed.has(key)) entries.push([`${enc.key}At`, stamp]);
    if (enc.late) {
      lateGates.push({ stage: enc.stage, gates: [...row.gates, ...entries] });
    } else {
      row.gates.push(...entries);
    }
  }

  // Keys the step-7 table marks derived/dropped: carried as facts, re-derived here.
  const stage4 = rows.find(r => r.stage === LAST_STAGE);
  if (stage4) {
    if (p.ranking) stage4.gates.push(['strategiesRanked', true]);
    const agreement = s.legacyStrategies?.agreement;
    if (agreement) {
      stage4.gates.push(['agreementCreated', true]);
      if (agreement.status === 'AGREED') stage4.gates.push(['agreementConfirmed', true]);
    }
  }

  return { rows, lateGates };
}

export function gatesToJson(gates: GateEntry[], resolve: (s: Stamp) => Date): Record<string, true | string> {
  const out: Record<string, true | string> = {};
  for (const [key, value] of gates) out[key] = value === true ? true : resolve(value).toISOString();
  return out;
}

// ============================================================================
// Session, invitation, messages
// ============================================================================

export function sessionStatus(s: Scenario): 'CREATED' | 'INVITED' | 'ACTIVE' {
  if (s.invitation.acceptedAt) return 'ACTIVE';
  if (s.participants[0]?.milestones.invitation_sent) return 'INVITED';
  return 'CREATED';
}

export interface InvitationFields {
  status: 'ACCEPTED' | 'PENDING';
  createdAt: Stamp;
  acceptedAt: Stamp | undefined;
  expiresAt: Stamp;
  messageConfirmed: boolean;
  messageConfirmedAt: Stamp | undefined;
}

/** The invitation is minted at the `invitation` clock; `invitation_sent` is its confirmed message. */
export function invitationFields(s: Scenario): InvitationFields {
  const sent = s.participants[0]?.milestones.invitation_sent;
  return {
    status: s.invitation.acceptedAt ? 'ACCEPTED' : 'PENDING',
    createdAt: { clock: 'invitation', offsetMs: 0 },
    acceptedAt: s.invitation.acceptedAt,
    expiresAt: s.invitation.expiresAt,
    messageConfirmed: Boolean(sent),
    messageConfirmedAt: sent,
  };
}

const PHASE_STAGE: Record<JourneyPhase, number> = {
  onboarding: 0,
  witness: 1,
  perspective: 2,
  needs: 3,
  repair: 4,
};

export function phaseToStage(phase: JourneyPhase): number {
  return PHASE_STAGE[phase];
}

/** Author of a message in `owner`'s conversation (see `ScenarioMessage.from`). */
export function messageSender(owner: ParticipantKey, m: ScenarioMessage): ParticipantKey | null {
  if (m.from !== undefined) return m.from;
  return m.role === 'USER' ? owner : null;
}

// ============================================================================
// Clocks
// ============================================================================

/** Every stamp in a scenario, wherever it sits. */
function collectStamps(value: unknown, out: Stamp[]): Stamp[] {
  if (Array.isArray(value)) {
    for (const v of value) collectStamps(v, out);
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.clock === 'string' && typeof o.offsetMs === 'number' && Object.keys(o).length === 2) {
      out.push(o as unknown as Stamp);
    } else {
      for (const v of Object.values(o)) collectStamps(v, out);
    }
  }
  return out;
}

/**
 * The clocks a scenario references, in read order. The invitation is always
 * minted, so its clock is always read.
 */
export function referencedClocks(s: Scenario): Clock[] {
  const used = new Set<Clock>(collectStamps(s, []).map(st => st.clock));
  used.add('invitation');
  return CLOCKS.filter(c => used.has(c));
}

export function resolveStamp(stamp: Stamp, instants: Partial<Record<Clock, Date>>): Date {
  const instant = instants[stamp.clock];
  if (!instant) throw new Error(`Clock "${stamp.clock}" has not been read`);
  return new Date(instant.getTime() + stamp.offsetMs);
}

// ============================================================================
// Writer
// ============================================================================

export interface UserRef {
  email: string;
  name: string;
}

export interface WrittenUser {
  id: string;
  email: string;
  name: string | null;
}

export interface CurrentShapeResult {
  session: { id: string; status: string; relationshipId: string };
  users: WrittenUser[];
  invitation: { id: string; status: string };
}

/**
 * Write a scenario into today's tables inside `tx`.
 *
 * `users[i]` is the account for `scenario.participants[i]`.
 */
export async function writeCurrentShape(tx: Tx, scenario: Scenario, users: UserRef[]): Promise<CurrentShapeResult> {
  if (users.length !== scenario.participants.length) {
    throw new Error(
      `Scenario ${scenario.name} has ${scenario.participants.length} participants but ${users.length} users`,
    );
  }
  const clocks = new Set(referencedClocks(scenario));
  const instants: Partial<Record<Clock, Date>> = {};
  const readClock = (c: Clock) => {
    if (clocks.has(c)) instants[c] = new Date();
  };
  const t = (s: Stamp) => resolveStamp(s, instants);
  const tOpt = (s: Stamp | undefined) => (s ? t(s) : undefined);

  // --- Users: upsert by email; clerkId minted as `e2e_<ms>_<random>` -----------
  const userRows: WrittenUser[] = [];
  for (const u of users) {
    userRows.push(
      await tx.user.upsert({
        where: { email: u.email },
        update: { name: u.name },
        create: {
          email: u.email,
          name: u.name,
          clerkId: `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          lastMoodIntensity: 7,
        },
      }),
    );
  }
  const idOf = new Map<ParticipantKey, string>(scenario.participants.map((p, i) => [p.key, userRows[i].id]));
  const userId = (key: ParticipantKey) => {
    const id = idOf.get(key);
    if (!id) throw new Error(`Scenario ${scenario.name}: unknown participant "${key}"`);
    return id;
  };

  // --- Relationship: each member's nickname is what they call the other ------
  // Two-person rule from the old factory: the inviter's nickname for the
  // invitee is the invitee's name (null when there is no invitee yet); every
  // other member calls the inviter by the inviter's name.
  const members = users.map((u, i) => ({
    userId: userRows[i].id,
    nickname: i === 0 ? users[1]?.name || null : users[0].name,
  }));
  const relationship = await tx.relationship.create({ data: { members: { create: members } } });

  // --- Session -----------------------------------------------------------------
  readClock('session');
  const session = await tx.session.create({
    data: {
      relationshipId: relationship.id,
      status: sessionStatus(scenario),
      ...(scenario.topic
        ? { topicFrame: scenario.topic.frame, topicFrameConfirmedAt: t(scenario.topic.confirmedAt) }
        : {}),
    },
  });
  const sessionId = session.id;

  // --- Invitation (one instant for all of its own stamps) ---------------------
  readClock('invitation');
  const inv = invitationFields(scenario);
  const invitation = await tx.invitation.create({
    data: {
      sessionId,
      invitedById: userRows[0].id,
      createdAt: t(inv.createdAt),
      acceptedAt: inv.acceptedAt ? t(inv.acceptedAt) : null,
      name: users[1]?.name || 'Partner',
      status: inv.status,
      expiresAt: t(inv.expiresAt),
      messageConfirmed: inv.messageConfirmed,
      messageConfirmedAt: inv.messageConfirmedAt ? t(inv.messageConfirmedAt) : null,
    },
  });

  // --- Vessels -----------------------------------------------------------------
  const sharedVessel = await tx.sharedVessel.create({ data: { sessionId } });
  const vessels: Array<{ id: string } | undefined> = [];
  for (const row of userRows) {
    vessels.push(await tx.userVessel.create({ data: { sessionId, userId: row.id } }));
  }

  readClock('scenario');

  const writeMessage = (forKey: ParticipantKey, m: ScenarioMessage) => {
    const from = messageSender(forKey, m);
    return tx.message.create({
      data: {
        sessionId,
        senderId: from === null ? null : userId(from),
        forUserId: userId(forKey),
        role: m.role,
        content: m.content,
        stage: phaseToStage(m.phase),
        timestamp: t(m.at),
      },
    });
  };

  const needRows = (i: number) => {
    const p = scenario.participants[i];
    const vessel = vessels[i];
    if (!vessel) throw new Error(`No vessel for participant "${p.key}"`);
    const confirmedAt = p.milestones.needs_confirmed;
    if (!confirmedAt) throw new Error(`Participant "${p.key}" has needs but no needs_confirmed milestone`);
    return (p.needs ?? []).map(n => ({
      vesselId: vessel.id,
      need: n.need,
      category: n.category,
      evidence: [],
      aiConfidence: n.aiConfidence,
      confirmed: n.confirmed,
      createdAt: t(confirmedAt),
    }));
  };

  // --- Per participant: progress, conversation, empathy, needs ----------------
  const plans = scenario.participants.map(p => stageProgressPlan(p, scenario));
  for (const [i, p] of scenario.participants.entries()) {
    const uid = userRows[i].id;

    for (const row of plans[i].rows) {
      await tx.stageProgress.create({
        data: {
          sessionId,
          userId: uid,
          stage: row.stage,
          status: row.status,
          startedAt: tOpt(row.startedAt),
          completedAt: tOpt(row.completedAt),
          gatesSatisfied: gatesToJson(row.gates, t),
        },
      });
    }

    for (const m of p.messages ?? []) await writeMessage(p.key, m);

    if (p.empathy) {
      const e = p.empathy;
      const submittedAt = p.milestones.empathy_submitted;
      if (!submittedAt)
        throw new Error(`Participant "${p.key}" has an empathy attempt but no empathy_submitted milestone`);
      const draft = await tx.empathyDraft.create({
        data: { sessionId, userId: uid, content: e.statement, readyToShare: true },
      });
      await tx.empathyAttempt.create({
        data: {
          sessionId,
          draftId: draft.id,
          sourceUserId: uid,
          content: draft.content,
          status: e.status,
          sharedAt: t(submittedAt),
          ...(e.revealedAt ? { revealedAt: t(e.revealedAt) } : {}),
          ...(e.deliveredAt ? { deliveryStatus: 'DELIVERED' as const, deliveredAt: t(e.deliveredAt) } : {}),
        },
      });
      if (e.consentRecorded) {
        await tx.consentRecord.create({
          data: {
            userId: uid,
            sessionId,
            targetType: 'EMPATHY_DRAFT',
            targetId: draft.id,
            requestedByUserId: uid,
            decision: 'GRANTED',
            decidedAt: t(submittedAt),
          },
        });
      }
      if (e.statementInChat) {
        await writeMessage(p.key, {
          role: 'EMPATHY_STATEMENT',
          content: draft.content,
          phase: 'perspective',
          at: submittedAt,
          from: p.key,
        });
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

    if (p.needs?.length && !scenario.currentShape?.batchNeeds) {
      await tx.identifiedNeed.createMany({ data: needRows(i) });
    }
  }

  if (scenario.currentShape?.batchNeeds) {
    const data = scenario.participants.flatMap((p, i) => (p.needs?.length ? needRows(i) : []));
    if (data.length) await tx.identifiedNeed.createMany({ data });
  }

  // --- Reconciliation ----------------------------------------------------------
  if (scenario.reconciliation) {
    const { result: r, shareOffer: offer, messages } = scenario.reconciliation;
    const result = await tx.reconcilerResult.create({
      data: {
        sessionId,
        guesserId: userId(r.guesser),
        guesserName: users[scenario.participants.findIndex(p => p.key === r.guesser)].name,
        subjectId: userId(r.subject),
        subjectName: users[scenario.participants.findIndex(p => p.key === r.subject)].name,
        alignmentScore: r.alignmentScore,
        alignmentSummary: r.alignmentSummary,
        correctlyIdentified: r.correctlyIdentified,
        gapSeverity: r.gapSeverity,
        gapSummary: r.gapSummary,
        missedFeelings: r.missedFeelings,
        misattributions: r.misattributions,
        mostImportantGap: r.mostImportantGap,
        recommendedAction: r.recommendedAction,
        rationale: r.rationale,
        sharingWouldHelp: r.sharingWouldHelp,
        suggestedShareFocus: r.suggestedShareFocus,
        suggestedShareContent: r.suggestedShareContent,
        suggestedShareReason: r.suggestedShareReason,
        createdAt: t(r.at),
      },
    });
    await tx.reconcilerShareOffer.create({
      data: {
        resultId: result.id,
        userId: userId(r.subject),
        status: offer.status,
        suggestedContent: offer.suggestedContent,
        suggestedReason: result.suggestedShareReason,
        ...(offer.shared ? { sharedContent: offer.shared.content, sharedAt: t(offer.shared.at) } : {}),
        ...(offer.deliveredAt ? { deliveryStatus: 'DELIVERED' as const, deliveredAt: t(offer.deliveredAt) } : {}),
      },
    });
    for (const m of messages ?? []) await writeMessage(m.to, m);
  }

  // --- Legacy Stage 4: strategies, rankings, agreement --------------------------
  if (scenario.legacyStrategies) {
    const { strategies, agreement } = scenario.legacyStrategies;
    const strategyIds = new Map<string, string>();
    for (const st of strategies) {
      const row = await tx.strategyProposal.create({
        data: {
          sessionId,
          createdByUserId: userId(st.by),
          description: st.description,
          needsAddressed: st.needsAddressed,
          duration: st.duration,
          createdAt: t(st.at),
        },
      });
      strategyIds.set(st.key, row.id);
    }
    const strategyId = (key: string) => {
      const id = strategyIds.get(key);
      if (!id) throw new Error(`Scenario ${scenario.name}: unknown strategy "${key}"`);
      return id;
    };
    const rankings = scenario.participants.flatMap((p, i) =>
      p.ranking
        ? [
            {
              sessionId,
              userId: userRows[i].id,
              rankedIds: p.ranking.proposals.map(strategyId),
              submittedAt: t(p.ranking.submittedAt),
            },
          ]
        : [],
    );
    if (rankings.length) await tx.strategyRanking.createMany({ data: rankings });
    if (agreement) {
      const [first, second] = scenario.participants;
      await tx.agreement.create({
        data: {
          sharedVesselId: sharedVessel.id,
          description: agreement.description,
          type: agreement.type,
          proposalId: strategyId(agreement.proposal),
          followUpDate: t(agreement.followUpAt),
          status: agreement.status,
          agreedByA: Boolean(first && agreement.agreedBy.includes(first.key)),
          agreedByB: Boolean(second && agreement.agreedBy.includes(second.key)),
          agreedAt: t(agreement.agreedAt),
        },
      });
    }
  }

  // --- Redesigned Stage 4: proposals, revisions, coverage, choices --------------
  readClock('late');
  if (scenario.stage4) {
    const { proposals, revisions, coverage } = scenario.stage4;
    const proposalIds = new Map<string, string>();
    for (const pr of proposals) {
      const row = await tx.strategyProposal.create({
        data: {
          sessionId,
          createdByUserId: userId(pr.by),
          description: pr.description,
          needsAddressed: pr.needsAddressed,
          duration: pr.duration,
          measureOfSuccess: pr.measureOfSuccess,
          kind: pr.kind,
          status: pr.removed ? 'REMOVED' : 'ACTIVE',
          ...(pr.removed
            ? { removedAt: t(pr.removed.at), removedByUserId: userId(pr.removed.by), removalReason: pr.removed.reason }
            : {}),
          coverageSummary: pr.coverageSummary,
        },
      });
      proposalIds.set(pr.key, row.id);
    }
    const proposalId = (key: string) => {
      const id = proposalIds.get(key);
      if (!id) throw new Error(`Scenario ${scenario.name}: unknown proposal "${key}"`);
      return id;
    };
    await tx.stage4ProposalRevision.createMany({
      data: revisions.map(r => ({
        proposalId: proposalId(r.proposal),
        sessionId,
        actorUserId: userId(r.actor),
        action: r.action,
        ...(r.before ? { before: r.before } : {}),
        after: r.after,
        reason: r.reason,
      })),
    });
    await tx.stage4NeedCoverage.createMany({
      data: coverage.map(c => ({
        sessionId,
        needLabel: c.needLabel,
        sourceUserId: userId(c.source),
        coverageStatus: c.coverageStatus,
        coveringProposalIds: c.coveringProposals.map(proposalId),
        note: c.note,
      })),
    });

    // Choices are written proposal-major (each proposal, then each participant's
    // choice on it) — the order today's fixtures inserted them.
    const choices = proposals.flatMap(pr =>
      scenario.participants.flatMap((p, i) =>
        (p.choices ?? [])
          .filter(c => c.proposal === pr.key)
          .map(c => {
            const sharedAt = p.milestones.choices_shared;
            if (!sharedAt) throw new Error(`Participant "${p.key}" has choices but no choices_shared milestone`);
            return {
              proposalId: proposalId(pr.key),
              userId: userRows[i].id,
              decision: c.decision,
              sessionId,
              selectedAt: t(sharedAt),
            };
          }),
      ),
    );
    if (choices.length) {
      await tx.stage4ProposalSelection.createMany({ data: choices });
    }
  }

  // --- Late gates (choices_shared): one update per distinct gate set -----------
  const lateGroups = new Map<string, { stage: number; gates: Record<string, true | string>; userIds: string[] }>();
  for (const [i, plan] of plans.entries()) {
    for (const late of plan.lateGates) {
      const gates = gatesToJson(late.gates, t);
      const groupKey = JSON.stringify([late.stage, gates]);
      const group = lateGroups.get(groupKey) ?? { stage: late.stage, gates, userIds: [] };
      group.userIds.push(userRows[i].id);
      lateGroups.set(groupKey, group);
    }
  }
  for (const group of lateGroups.values()) {
    await tx.stageProgress.updateMany({
      where: { sessionId, userId: { in: group.userIds }, stage: group.stage },
      data: { gatesSatisfied: group.gates },
    });
  }

  return {
    session: { id: session.id, status: session.status, relationshipId: session.relationshipId },
    users: userRows,
    invitation: { id: invitation.id, status: invitation.status },
  };
}
