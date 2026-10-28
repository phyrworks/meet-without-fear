/**
 * Shape-independent helpers of the scenario writers: what a scenario's session
 * status, invitation fields, message authors and clocks are, and the result a
 * writer returns.
 *
 * TS-13 (ruling R42): these lived in the current-shape writer
 * (`current-shape.ts`), which wrote the pre-rebuild Prisma models and was
 * removed from phoenix/target-shape (phoenix/base keeps it). The target-shape
 * writer (`target-shape.ts`) consumes them unchanged; the code is moved
 * verbatim, only `CurrentShapeResult` is renamed `WrittenScenario`.
 */

import { CLOCKS, Clock, ParticipantKey, Scenario, ScenarioMessage, Stamp } from './scenario-model';

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
// Result
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

export interface WrittenScenario {
  session: { id: string; status: string; relationshipId: string };
  users: WrittenUser[];
  invitation: { id: string; status: string };
}
