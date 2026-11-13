/**
 * work-2km7: fixtures seed only states the app can reach.
 *
 * The rules come from the controllers, not from the stage docs:
 *   - createSession (controllers/invitations.ts) writes ONE participant, the
 *     inviter (+ MAIN conversation, read state) and a PENDING invitation;
 *   - acceptInvitation (controllers/invitations.ts) — and its E2E twin
 *     acceptPendingInvitationForE2ESession (controllers/session-state.ts) — is
 *     the only writer of the invitee's participant (+ MAIN conversation, read
 *     state): it marks the invitation ACCEPTED with accepted_at and
 *     accepted_by_user_id, moves the session ACTIVE, and gives the inviter
 *     `invitation_sent` (reachInvitationSentOnAccept, work-qmgc). It writes no
 *     milestone, message or content for the invitee;
 *   - confirmInvitationMessage (controllers/sessions.ts) is the only other
 *     writer of `invitation_sent`, and writes `compact_signed` with it;
 *   - saveDraft (controllers/stage2.ts) refuses an empathy draft before the
 *     partner joined.
 */

import { withClient } from '../../golden/db';
import { restoreFixture } from '../../golden/fixtures';
import { isTargetShape } from '../../golden/shape';
import { at } from '../scenario-model';
import type { Scenario } from '../scenario-model';
import { joinedParticipants, reachabilityViolations } from '../reachability';
import { scenarioFor } from '../scenarios';
import { TargetStage } from '../target-stage';

const WITH = { a: 'Ada Lovelace', b: 'Bob Ross' };
const WITHOUT = { a: 'Ada Lovelace' };

describe('fixture reachability (work-2km7)', () => {
  for (const names of [WITH, WITHOUT]) {
    const label = names === WITH ? 'with a partner' : 'without a partner';
    it(`every scenario is a state the app can reach (${label})`, () => {
      for (const stage of Object.values(TargetStage)) {
        expect({ stage, violations: reachabilityViolations(scenarioFor(stage, names)) }).toEqual({
          stage,
          violations: [],
        });
      }
    });
  }

  it('pre-accept scenarios have only the inviter joined; the invitee has no progress', () => {
    for (const stage of [TargetStage.CREATED, TargetStage.INVITATION_READY]) {
      const s = scenarioFor(stage, WITH);
      expect({ stage, accepted: s.invitation.acceptedAt }).toEqual({ stage, accepted: undefined });
      expect({ stage, joined: joinedParticipants(s).map(p => p.key) }).toEqual({ stage, joined: ['a'] });
      expect({ stage, invitee: s.participants[1] }).toEqual({ stage, invitee: { key: 'b', milestones: {} } });
    }
  });

  it('INVITATION_READY: the inviter confirmed the invitation (compact_signed with invitation_sent)', () => {
    const ada = scenarioFor(TargetStage.INVITATION_READY, WITH).participants[0];
    expect(Object.keys(ada.milestones).sort()).toEqual(['compact_signed', 'invitation_sent']);
    expect(ada.milestones.compact_signed).toEqual(ada.milestones.invitation_sent);
  });

  it('EMPATHY_SHARED_A is post-accept: both joined, the invitation accepted, the invitee at no milestone', () => {
    const s = scenarioFor(TargetStage.EMPATHY_SHARED_A, WITH);
    expect(s.invitation.acceptedAt).toBeDefined();
    expect(joinedParticipants(s).map(p => p.key)).toEqual(['a', 'b']);
    expect(s.participants[0].milestones.invitation_sent).toBeDefined();
    expect(s.participants[1]).toEqual({ key: 'b', milestones: {} });
  });

  it('the no-partner fallback is a sent, unaccepted invitation (nobody can have accepted it)', () => {
    for (const stage of [TargetStage.EMPATHY_SHARED_A, TargetStage.FEEL_HEARD_B, TargetStage.TOMBSTONE_READY]) {
      const s = scenarioFor(stage, WITHOUT);
      expect({ stage, accepted: s.invitation.acceptedAt, n: s.participants.length }).toEqual({
        stage,
        accepted: undefined,
        n: 1,
      });
      expect(Object.keys(s.participants[0].milestones).sort()).toEqual(['compact_signed', 'invitation_sent']);
      expect(s.participants[0].journey).toBeDefined();
    }
  });

  describe('the guard names each unreachable state', () => {
    const base = (): Scenario => ({
      name: 'PROBE',
      topic: { frame: 'x', confirmedAt: at(0, 'invitation') },
      invitation: { expiresAt: at(1, 'invitation') },
      participants: [
        { key: 'a', journey: {}, milestones: { compact_signed: at(0), invitation_sent: at(0) } },
        { key: 'b', milestones: {} },
      ],
    });

    it('accepts a sent, pending invitation with a not-yet-joined invitee', () => {
      expect(reachabilityViolations(base())).toEqual([]);
    });

    it('an invitee with progress before the invitation was accepted', () => {
      const s = base();
      s.participants[1] = { key: 'b', journey: {}, milestones: { compact_signed: at(0) } };
      expect(reachabilityViolations(s)).toEqual([
        'participant "b" has progress or content but has not joined (the invitation is not ACCEPTED)',
      ]);
    });

    it('content that names a not-yet-joined invitee', () => {
      const s = base();
      s.participants[0].milestones.empathy_submitted = at(0);
      s.participants[0].empathy = {
        statement: 'x',
        status: 'HELD',
        consentRecorded: true,
        statementInChat: false,
      };
      expect(reachabilityViolations(s)).toEqual([
        'participant "a" has an empathy attempt but nobody else has joined (saveDraft refuses it)',
      ]);
      const t = base();
      t.participants[0].messages = [
        { role: 'SHARED_CONTEXT', content: 'x', phase: 'perspective', at: at(0), from: 'b' },
      ];
      expect(reachabilityViolations(t)).toEqual(['participant "b" is named by content but has not joined']);
    });

    it('an accepted invitation with nobody to have accepted it', () => {
      const s = base();
      s.participants = [s.participants[0]];
      s.invitation.acceptedAt = at(0, 'invitation');
      expect(reachabilityViolations(s)).toEqual([
        'the invitation is ACCEPTED but there is no invitee to have accepted it',
      ]);
    });

    it('an accepted invitation whose inviter lacks invitation_sent (accept writes it)', () => {
      const s = base();
      s.invitation.acceptedAt = at(0, 'invitation');
      delete s.participants[0].milestones.invitation_sent;
      expect(reachabilityViolations(s)).toContain(
        'the invitation is ACCEPTED but the inviter has no invitation_sent (acceptInvitation writes it)',
      );
    });

    it('a pending sent invitation without compact_signed (only the confirm writes invitation_sent then)', () => {
      const s = base();
      delete s.participants[0].milestones.compact_signed;
      expect(reachabilityViolations(s)).toEqual([
        'the inviter reached invitation_sent on a PENDING invitation without compact_signed (confirmInvitationMessage writes both)',
      ]);
    });
  });
});

/**
 * The database half (built target templates: CREATED, INVITATION_READY,
 * EMPATHY_SHARED_A). The post-accept shape is not written down here — it is
 * taken from a real accept (POST /api/invitations/:id/accept) on
 * INVITATION_READY and compared with what EMPATHY_SHARED_A seeds.
 */
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('fixture reachability on the target templates (work-2km7)', () => {
  const BASE_URL =
    process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

  /** What accept decides, per user: membership, participant, its conversations and read state, milestones. */
  const SHAPE = `
    SELECT u.email,
           (SELECT count(*)::int FROM relationship_member rm WHERE rm.user_id = u.id) AS member,
           (SELECT count(*)::int FROM participant p WHERE p.user_id = u.id) AS participant,
           (SELECT p.display_name FROM participant p WHERE p.user_id = u.id) AS display_name,
           (SELECT count(*)::int FROM conversation c JOIN participant p ON p.id = c.participant_id
             WHERE p.user_id = u.id AND c.kind = 'MAIN' AND c.status = 'ACTIVE') AS main,
           (SELECT count(*)::int FROM conversation_read_state r JOIN participant p ON p.id = r.participant_id
             WHERE p.user_id = u.id) AS read_state,
           (SELECT coalesce(array_agg(pm.milestone_key::text ORDER BY pm.milestone_key), '{}')
              FROM participant_milestone pm JOIN participant p ON p.id = pm.participant_id WHERE p.user_id = u.id) AS milestones,
           (SELECT count(*)::int FROM message m JOIN conversation c ON c.id = m.conversation_id
              JOIN participant p ON p.id = c.participant_id WHERE p.user_id = u.id) AS messages
    FROM "user" u ORDER BY u.email`;
  const SESSION = `
    SELECT s.status::text AS session, i.status::text AS invitation, i.accepted_at IS NOT NULL AS accepted_at,
           ub.email AS accepted_by, i.accepted_at >= i.message_confirmed_at AS accepted_after_sent
    FROM session s JOIN invitation i ON i.session_id = s.id LEFT JOIN "user" ub ON ub.id = i.accepted_by_user_id`;

  const shapeOf = async (stage: string, runId: string, accept: boolean) => {
    const { createHarness } = await import('../../golden/driver');
    const harness = await createHarness({ baseUrl: BASE_URL, stage, runId: `2km7_${runId}_${process.pid}` });
    try {
      if (accept) {
        const step = await harness.step({
          label: 'accept as bob',
          actor: harness.actors.userB!,
          tables: [],
          call: agent => agent.post(`/api/invitations/${harness.fixture.manifest.seeded.invitationId}/accept`).send({}),
        });
        expect(step.status).toBe(200);
      }
      const q = async (sql: string) =>
        withClient(harness.fixture.target, async c => (await c.query(sql)).rows, harness.fixture.database);
      return { users: await q(SHAPE), session: await q(SESSION) };
    } finally {
      await harness.teardown();
    }
  };

  it('pre-accept templates (CREATED, INVITATION_READY): the invitee is a relationship member, not a participant', async () => {
    for (const stage of ['CREATED', 'INVITATION_READY']) {
      const fx = await restoreFixture({
        baseUrl: BASE_URL,
        stage,
        runId: `2km7_pre_${stage.toLowerCase()}_${process.pid}`,
      });
      try {
        const rows = await withClient(fx.target, async c => (await c.query(SHAPE)).rows, fx.database);
        expect({ stage, bob: rows.find(r => r.email === 'bob@e2e.test') }).toEqual({
          stage,
          bob: {
            email: 'bob@e2e.test',
            member: 1,
            participant: 0,
            display_name: null,
            main: 0,
            read_state: 0,
            milestones: [],
            messages: 0,
          },
        });
        expect({ stage, ada: rows.find(r => r.email === 'ada@e2e.test')?.milestones }).toEqual({
          stage,
          ada: stage === 'CREATED' ? [] : ['compact_signed', 'invitation_sent'],
        });
      } finally {
        await fx.drop();
      }
    }
  });

  it('EMPATHY_SHARED_A seeds exactly what a real accept leaves for the invitee, the invitation and the session', async () => {
    const real = await shapeOf('INVITATION_READY', 'real', true);
    const seeded = await shapeOf('EMPATHY_SHARED_A', 'seeded', false);
    const bob = (r: typeof real) => r.users.find(u => u.email === 'bob@e2e.test');
    expect(seeded.session).toEqual(real.session);
    expect(real.session).toEqual([
      {
        session: 'ACTIVE',
        invitation: 'ACCEPTED',
        accepted_at: true,
        accepted_by: 'bob@e2e.test',
        accepted_after_sent: true,
      },
    ]);
    expect(bob(seeded)).toEqual(bob(real));
    // The inviter has invitation_sent either way (the accept writes it if the confirm did not).
    for (const r of [real, seeded]) {
      expect(r.users.find(u => u.email === 'ada@e2e.test')?.milestones).toContain('invitation_sent');
    }
  });
});
