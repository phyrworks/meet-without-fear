/**
 * The stage shim (TS-9): the ONE place a stage number exists.
 *
 * The target schema has no stage column anywhere (spec D3): progress is the
 * set of `participant_milestone` rows, and the stage vocabulary is data in
 * `milestone` (`ordinal`, `stage_label`). The DTOs in `shared/` still carry
 * the old numbers (`stage`, `StageProgressDTO`, `gatesSatisfied`) until mobile
 * moves to milestone keys, so this module computes them — and nothing else in
 * the backend may.
 *
 * What it reproduces, and from what:
 *   - the CURRENT stage: `v_current_stage.active_stage` (the stage of the next
 *     milestone not yet reached, i.e. the old IN_PROGRESS row's stage);
 *   - the old per-stage rows (`stageRowsFor`): stage n is COMPLETED at its
 *     terminal milestone (compact_signed, feel_heard, empathy_validated,
 *     needs_shared; stage 4 at `closed`), stage n+1 starts then, stage 0 starts
 *     when the participant joined — the inverse of the fixture writer's
 *     `stageProgressPlan`;
 *   - `gatesSatisfied`, DERIVED from the milestones of the row's stage by the
 *     inverse of the plan's step-7 key table. The keys the target dropped
 *     (`feelHeardCheckOffered`, `readyToRank`, `rankingSubmitted`,
 *     `finalEmotionalReading`) are never produced;
 *   - a message's stage (`stageAt`): the owner's stage at the message's
 *     instant — the message table has no stage (spec §1.1 message, "derivable
 *     from participant_milestone").
 *
 * GETTING STARTED FOR AN INVITER (work-qmgc). Stage 0 has two milestones and
 * the inviter usually signs the compact BEFORE crafting the invitation. The old
 * contract kept them IN_PROGRESS in stage 0 until POST /invitation/confirm
 * completed it with `{ compactSigned, invitationSent }`; the mobile invitation
 * follow-up is gated on that stage 0. So stage 0 ends at compact_signed for an
 * invitee, and for a participant who authored an invitation only once
 * invitation_sent exists too (at the later of the two). "Authored an unsent
 * invitation" is not a milestone fact, so the loaders read it
 * (`invitationPending`) and the pure functions take it as a REQUIRED option
 * (`StageOpts`); with both milestones present the later-of rule needs no
 * option. Writers of invitation_sent: POST /invitation/confirm, and accepting
 * the invitation (`reachInvitationSentOnAccept`: an accepted invitation was
 * sent, and the share modal that calls confirm is not shown again once the
 * partner accepted — without it the inviter would stay in stage 0). Pending
 * is keyed on the milestone, not on invitation.status. A participant that
 * authored an invitation but has no invitation_sent is held at stage 0 even
 * with later milestones — no such data exists (no deployed compatibility).
 * For a pending inviter `CurrentStage.stageLabel`/`nextMilestoneKey` are
 * stage 0's (invitation_sent), not the view's.
 *
 * WRITER CONTRACT (what keeps this per-participant reading correct). The
 * shim — like `v_current_stage` — moves a participant on the moment THEIR
 * terminal milestone exists; it does not consult `milestone.scope`. So the
 * writers carry the session rule: a milestone with `scope = 'session'`
 * (compact_signed, empathy_validated, needs_validated, needs_shared,
 * choices_shared, closed — the milestone seed) that GATES a stage is written by
 * the job only once `v_session_readiness.all_reached` holds for the session's
 * precondition, so no participant's stage runs ahead of the session.
 * `compact_signed` is the exception the product keeps: each participant
 * self-asserts it (self_assertable), and stage 1 work (the witness) is
 * per-participant by design — the compact's session scope gates only the
 * session's ACTIVE status (signCompact / app.session_set_status). The
 * empathy/needs/repair writers (TS-10, TS-11) must honour this.
 */

import { prisma, type DbClient } from '../lib/prisma';

/** Terminal milestone of each stage (stage index → key). */
export const TERMINAL_MILESTONE = [
  'compact_signed',
  'feel_heard',
  'empathy_validated',
  'needs_shared',
  'closed',
] as const;

export const LAST_STAGE = 4;

export interface MilestoneReached {
  key: string;
  reachedAt: Date;
}

export interface CurrentStage {
  participantId: string;
  /** The furthest milestone reached (by ordinal), if any. */
  milestoneKey: string | null;
  ordinal: number | null;
  stageLabel: string | null;
  nextMilestoneKey: string | null;
  /** The DTO stage number: the stage the participant is working in. */
  stage: number;
  /** See `ParticipantStageState.invitationPending`. */
  invitationPending: boolean;
}

export type ShimStageStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface ShimStageRow {
  stage: number;
  status: ShimStageStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  gatesSatisfied: Record<string, unknown>;
}

export interface ParticipantStageState {
  participantId: string;
  current: CurrentStage;
  /** The participant authored an invitation not yet sent (no invitation_sent): stage 0 is not over. */
  invitationPending: boolean;
  milestones: MilestoneReached[];
  rows: ShimStageRow[];
}

/**
 * Required, never defaulted: `{}` silently meaning "not pending" let a reader
 * that forgot the option tag a crafting inviter's turns stage 1 (work-qmgc
 * review). A caller that knows the participant cannot be a pending inviter
 * passes `{ invitationPending: false }` and says why.
 */
export interface StageOpts {
  /** See `ParticipantStageState.invitationPending`. */
  invitationPending: boolean;
}

// ----------------------------------------------------------------------------
// Pure part
// ----------------------------------------------------------------------------

function reachedAt(milestones: MilestoneReached[], key: string): Date | null {
  return milestones.find(m => m.key === key)?.reachedAt ?? null;
}

/**
 * The instant a stage was completed, or null. Stage 0 (Getting Started) ends
 * at compact_signed, but not while the participant's own invitation is unsent,
 * and at the later of compact_signed and invitation_sent once both exist.
 */
export function stageCompletedAt(stage: number, milestones: MilestoneReached[], opts: StageOpts): Date | null {
  const terminal = reachedAt(milestones, TERMINAL_MILESTONE[stage]);
  if (stage !== 0 || !terminal) return terminal;
  if (opts.invitationPending) return null;
  const sent = reachedAt(milestones, 'invitation_sent');
  return sent && sent > terminal ? sent : terminal;
}

/** The DTO stage from `v_current_stage.active_stage`, held at 0 while the participant's invitation is unsent. */
export function activeStage(viewActiveStage: number, opts: StageOpts): number {
  return opts.invitationPending ? 0 : Math.min(viewActiveStage, LAST_STAGE);
}

/**
 * The gate keys a stage's row carried, derived from the milestones of that
 * stage (inverse of the step-7 key table; plan §3). Timestamps are ISO strings,
 * as the old JSON held them.
 */
export function gatesFor(stage: number, milestones: MilestoneReached[]): Record<string, unknown> {
  const gates: Record<string, unknown> = {};
  const put = (key: string, gate: string, withAt: string | null): void => {
    const at = reachedAt(milestones, key);
    if (!at) return;
    gates[gate] = true;
    if (withAt) gates[withAt] = at.toISOString();
  };
  switch (stage) {
    case 0:
      put('compact_signed', 'compactSigned', 'signedAt');
      put('invitation_sent', 'invitationSent', null);
      break;
    case 1:
      put('feel_heard', 'feelHeardConfirmed', 'feelHeardConfirmedAt');
      break;
    case 2:
      put('empathy_validated', 'empathyValidated', 'empathyValidatedAt');
      break;
    case 3:
      put('needs_confirmed', 'needsConfirmed', 'needsConfirmedAt');
      put('needs_validated', 'needsValidated', 'needsValidatedAt');
      put('needs_shared', 'needsShared', 'needsSharedAt');
      break;
    case 4:
      put('choices_shared', 'selectionSubmitted', 'selectionSubmittedAt');
      break;
  }
  return gates;
}

/**
 * The old StageProgress rows of one participant: stages 0..current, every one
 * before `current` COMPLETED (at its terminal milestone when reached), the
 * current one IN_PROGRESS — or COMPLETED when it is the last stage and
 * `closed` is reached.
 */
export function stageRowsFor(
  current: number,
  milestones: MilestoneReached[],
  joinedAt: Date | null,
  opts: StageOpts,
): ShimStageRow[] {
  const rows: ShimStageRow[] = [];
  for (let stage = 0; stage <= current; stage++) {
    const terminal = stageCompletedAt(stage, milestones, opts);
    const completed = stage < current || (stage === LAST_STAGE && terminal !== null);
    rows.push({
      stage,
      status: completed ? 'COMPLETED' : 'IN_PROGRESS',
      startedAt: stage === 0 ? joinedAt : stageCompletedAt(stage - 1, milestones, opts),
      completedAt: completed ? terminal : null,
      gatesSatisfied: gatesFor(stage, milestones),
    });
  }
  return rows;
}

/** The participant's stage at an instant: terminal milestones reached by then. */
export function stageAt(milestones: MilestoneReached[], at: Date, opts: StageOpts): number {
  let stage = 0;
  while (stage < LAST_STAGE) {
    const done = stageCompletedAt(stage, milestones, opts);
    if (!done || done > at) break;
    stage++;
  }
  return stage;
}

/**
 * The single row the old code picked as "the partner's latest progress":
 * `ORDER BY completedAt DESC (NULLS FIRST), startedAt DESC` — an unfinished
 * row wins over every finished one.
 */
export function latestStageRow(rows: ShimStageRow[]): ShimStageRow | null {
  const sorted = [...rows].sort((a, b) => {
    const ac = a.completedAt?.getTime() ?? Infinity;
    const bc = b.completedAt?.getTime() ?? Infinity;
    if (ac !== bc) return bc - ac;
    return (b.startedAt?.getTime() ?? -Infinity) - (a.startedAt?.getTime() ?? -Infinity);
  });
  return sorted[0] ?? null;
}

// ----------------------------------------------------------------------------
// Database part
// ----------------------------------------------------------------------------

/** `v_current_stage` for these participants. */
export async function loadCurrentStages(
  participantIds: string[],
  client: DbClient = prisma,
): Promise<Map<string, CurrentStage>> {
  if (participantIds.length === 0) return new Map();
  const rows = await client.$queryRaw<
    Array<{
      participant_id: string;
      milestone_key: string | null;
      ordinal: number | null;
      stage_label: string | null;
      next_milestone_key: string | null;
      active_stage: number;
      invitation_pending: boolean;
    }>
  >`SELECT v.participant_id, v.milestone_key, v.ordinal, v.active_stage, x.invitation_pending,
      -- A pending inviter's next milestone is invitation_sent, in stage 0's label — not the view's
      -- (feel_heard, "Your Story"), so the fields agree with the stage activeStage reports.
      CASE WHEN x.invitation_pending THEN s.stage_label ELSE v.stage_label END AS stage_label,
      CASE WHEN x.invitation_pending THEN s.key ELSE v.next_milestone_key END AS next_milestone_key
    FROM v_current_stage v
    CROSS JOIN LATERAL (SELECT
      (EXISTS (SELECT 1 FROM invitation i WHERE i.invited_by_participant_id = v.participant_id)
        AND NOT EXISTS (SELECT 1 FROM participant_milestone pm
                        WHERE pm.participant_id = v.participant_id AND pm.milestone_key = 'invitation_sent'))
        AS invitation_pending) x
    LEFT JOIN milestone s ON s.key = 'invitation_sent'
    WHERE v.participant_id = ANY(${participantIds}::uuid[])`;
  return new Map(
    rows.map(r => [
      r.participant_id,
      {
        participantId: r.participant_id,
        milestoneKey: r.milestone_key,
        ordinal: r.ordinal === null ? null : Number(r.ordinal),
        stageLabel: r.stage_label,
        nextMilestoneKey: r.next_milestone_key,
        stage: activeStage(Number(r.active_stage), { invitationPending: r.invitation_pending }),
        invitationPending: r.invitation_pending,
      },
    ]),
  );
}

/**
 * The participants (of these) who authored an invitation not yet sent — the
 * `invitationPending` option, for callers that read `loadMilestones` alone.
 */
export async function loadInvitationPending(participantIds: string[], client: DbClient = prisma): Promise<Set<string>> {
  if (participantIds.length === 0) return new Set();
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT i.invited_by_participant_id AS id FROM invitation i
    WHERE i.invited_by_participant_id = ANY(${participantIds}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM participant_milestone pm
                      WHERE pm.participant_id = i.invited_by_participant_id AND pm.milestone_key = 'invitation_sent')`;
  return new Set(rows.map(r => r.id));
}

/** Milestones reached, per participant, oldest first. */
export async function loadMilestones(
  participantIds: string[],
  client: DbClient = prisma,
): Promise<Map<string, MilestoneReached[]>> {
  const out = new Map<string, MilestoneReached[]>(participantIds.map(id => [id, []]));
  if (participantIds.length === 0) return out;
  const rows = await client.participantMilestone.findMany({
    where: { participantId: { in: participantIds } },
    orderBy: [{ reachedAt: 'asc' }, { milestoneKey: 'asc' }],
    select: { participantId: true, milestoneKey: true, reachedAt: true },
  });
  for (const r of rows) out.get(r.participantId)?.push({ key: r.milestoneKey, reachedAt: r.reachedAt });
  return out;
}

/** Everything the DTO shim needs about each participant's progress. */
export async function loadStageStates(
  participants: Array<{ id: string; joinedAt: Date | null }>,
  /** The connection to read with (the ops dashboard passes mwf_ops; default the app's). */
  client: DbClient = prisma,
): Promise<Map<string, ParticipantStageState>> {
  const ids = participants.map(p => p.id);
  const [currents, milestones] = await Promise.all([loadCurrentStages(ids, client), loadMilestones(ids, client)]);
  const out = new Map<string, ParticipantStageState>();
  for (const p of participants) {
    const current = currents.get(p.id) ?? {
      participantId: p.id,
      milestoneKey: null,
      ordinal: null,
      stageLabel: null,
      nextMilestoneKey: null,
      stage: 0,
      invitationPending: false,
    };
    const reached = milestones.get(p.id) ?? [];
    const opts = { invitationPending: current.invitationPending };
    out.set(p.id, {
      participantId: p.id,
      current,
      invitationPending: current.invitationPending,
      milestones: reached,
      rows: stageRowsFor(current.stage, reached, p.joinedAt, opts),
    });
  }
  return out;
}

/** The current row (the DTO's `myProgress`), never undefined: stage 0 at worst. */
export function currentRow(state: ParticipantStageState): ShimStageRow {
  return state.rows[state.rows.length - 1] ?? stageRowsFor(0, [], null, { invitationPending: false })[0];
}

export interface ProgressDTOShape {
  stage: number;
  status: 'NOT_STARTED' | ShimStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  gatesSatisfied?: Record<string, unknown> | null;
}

/**
 * The DTO progress of a participant (`StageProgressDTO` / the session view's
 * `myProgress`). A present participant who has reached nothing is IN_PROGRESS
 * in stage 0 from the instant they joined — the old shape created that
 * stage-0 row on join/accept (mobile copy on UnifiedSessionScreen depends on
 * it). Only a participant that does not exist (no partner yet) is
 * NOT_STARTED.
 */
export function progressDTO(state: ParticipantStageState | undefined, opts: { gates: boolean }): ProgressDTOShape {
  if (!state) {
    // The old default object carried `gatesSatisfied: null` whichever side used it.
    return { stage: 0, status: 'NOT_STARTED', startedAt: null, completedAt: null, gatesSatisfied: null };
  }
  const row = currentRow(state);
  return {
    stage: row.stage,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    ...(opts.gates ? { gatesSatisfied: row.gatesSatisfied } : {}),
  };
}

/** One stage's row, if the participant has reached that stage. */
export function rowForStage(state: ParticipantStageState | undefined, stage: number): ShimStageRow | undefined {
  return state?.rows.find(r => r.stage === stage);
}

/**
 * Stage of the conversation owner at each message's instant — the DTO
 * `stage` of a message.
 */
export function messageStage(ownerMilestones: MilestoneReached[], createdAt: Date, opts: StageOpts): number {
  return stageAt(ownerMilestones, createdAt, opts);
}
