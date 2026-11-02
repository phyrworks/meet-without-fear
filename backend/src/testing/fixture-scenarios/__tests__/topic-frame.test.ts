/**
 * work-9klf: a fixture session that is at or past `invitation_sent` carries
 * the confirmed topic frame, as the real app's does.
 *
 * In the app the topic frame is confirmed BEFORE the invitation is sent:
 * `confirmTopicFrame` (controllers/topic-frame.ts) stamps
 * session.topic_frame_confirmed_at and invitation.message_confirmed_at with
 * one `now` and moves the session to INVITED; `confirmInvitationMessage`
 * (controllers/sessions.ts) refuses without a confirmed frame and only then
 * reaches `invitation_sent`; `acceptInvitation` (controllers/invitations.ts)
 * refuses an invitation whose session has no confirmed frame. The fixture
 * therefore writes the frame for every scenario whose inviter reached
 * `invitation_sent`, confirmed at the invitation's message_confirmed_at.
 *
 * The database half needs built target templates:
 *   npx tsx src/testing/golden/cli.ts build EMPATHY_SHARED_A   (etc.)
 */

import { invitationFields } from '../scenario-helpers';
import { scenarioFor } from '../scenarios';
import { TargetStage } from '../target-stage';
import { withClient } from '../../golden/db';
import { restoreFixture } from '../../golden/fixtures';
import { isTargetShape } from '../../golden/shape';

const NAMES = [
  { a: 'Ada Lovelace', b: 'Bob Ross' },
  { a: 'Ada Lovelace' }, // no partner account
];

describe('scenario model — the topic frame (work-9klf)', () => {
  for (const names of NAMES) {
    const label = names.b ? 'with a partner' : 'without a partner';

    it(`every scenario past invitation_sent has a topic frame confirmed at the invitation's message instant (${label})`, () => {
      for (const stage of Object.values(TargetStage)) {
        const s = scenarioFor(stage, names);
        const sent = s.participants[0]?.milestones.invitation_sent;
        if (!sent) continue;
        expect({ stage, frame: typeof s.topic?.frame }).toEqual({ stage, frame: 'string' });
        expect({ stage, frame: s.topic!.frame.trim().length > 0 }).toEqual({ stage, frame: true });
        expect({ stage, confirmedAt: s.topic!.confirmedAt }).toEqual({
          stage,
          confirmedAt: invitationFields(s).messageConfirmedAt,
        });
      }
    });
  }

  it('a session that was never sent has no topic frame (CREATED)', () => {
    expect(scenarioFor(TargetStage.CREATED, NAMES[0]).topic).toBeUndefined();
  });
});

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('target writer — the invitation is acceptable at EMPATHY_SHARED_A (work-9klf)', () => {
  const BASE_URL =
    process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

  it("writes the session INVITED with its topic frame confirmed at the invitation's message instant", async () => {
    const fx = await restoreFixture({
      baseUrl: BASE_URL,
      stage: 'EMPATHY_SHARED_A',
      runId: `9klf_topic_${process.pid}`,
    });
    try {
      const rows = await withClient(
        fx.target,
        async c =>
          (
            await c.query(
              `SELECT s.status::text AS status, s.topic_frame IS NOT NULL AS has_frame,
                      s.topic_frame_confirmed_at IS NOT NULL AS confirmed,
                      s.topic_frame_confirmed_at = i.message_confirmed_at AS same_instant,
                      i.status::text AS invitation_status
               FROM session s JOIN invitation i ON i.session_id = s.id`,
            )
          ).rows,
        fx.database,
      );
      expect(rows).toEqual([
        { status: 'INVITED', has_frame: true, confirmed: true, same_instant: true, invitation_status: 'PENDING' },
      ]);
    } finally {
      await fx.drop();
    }
  });

  /** Bob accepts the seeded invitation; `prepare` runs on the run database first. */
  const acceptAsBob = async (stage: string, runId: string, prepare?: string) => {
    const { createHarness } = await import('../../golden/driver');
    const harness = await createHarness({ baseUrl: BASE_URL, stage, runId: `9klf_${runId}_${process.pid}` });
    try {
      if (prepare) await withClient(harness.fixture.target, c => c.query(prepare), harness.fixture.database);
      const invitationId = harness.fixture.manifest.seeded.invitationId;
      const step = await harness.step({
        label: 'accept as bob',
        actor: harness.actors.userB!,
        tables: [],
        call: agent => agent.post(`/api/invitations/${invitationId}/accept`).send({}),
      });
      const rows = await withClient(
        harness.fixture.target,
        async c =>
          (
            await c.query(
              `SELECT s.status::text AS session, i.status::text AS invitation,
                      (SELECT count(*)::int FROM participant p WHERE p.session_id = s.id) AS participants
               FROM session s JOIN invitation i ON i.session_id = s.id`,
            )
          ).rows,
        harness.fixture.database,
      );
      return { status: step.status, body: step.body as { error?: { message?: string } } | undefined, rows };
    } finally {
      await harness.teardown();
    }
  };

  // The writer attaches a not-yet-joined invitee as a participant (EMPATHY_SHARED_A's
  // held attempt needs one as its subject), which the app never does: accept then
  // collides on participant (session_id, user_id). Removing that row restores the
  // state the app would hold; the readiness check is then all that stood between
  // the seeded state and an accepted invitation.
  it('the partner can accept a sent invitation (INVITATION_READY, invitee not pre-attached)', async () => {
    const r = await acceptAsBob(
      'INVITATION_READY',
      'accept_ready',
      `DELETE FROM participant WHERE user_id = (SELECT id FROM "user" WHERE email = 'bob@e2e.test')`,
    );
    expect({ status: r.status, rows: r.rows }).toEqual({
      status: 200,
      rows: [{ session: 'ACTIVE', invitation: 'ACCEPTED', participants: 2 }],
    });
  });

  it('accept at EMPATHY_SHARED_A is no longer refused as not ready (the topic frame is there)', async () => {
    const r = await acceptAsBob('EMPATHY_SHARED_A', 'accept_esa');
    expect(r.body?.error?.message).not.toBe('Invitation is not ready to accept');
  });
});
