/**
 * Review services IW-1 (work-k5fk.34): only the reflection a session was STARTED from is its "From Inner Thoughts"
 * origin. A reflection opened from inside the session is linked to it as context, but it is not the origin: no
 * origin card for it (GET /sessions/:id/state sourceInnerThoughts). Base told them apart by
 * linkedTrigger 'suggestion_start'; the target has no trigger, so the origin is the linked reflection written before
 * the session existed. Over HTTP as mwf_app.
 *
 * Requires: npx tsx src/testing/golden/cli.ts build CREATED
 */

import { isTargetShape } from '../../testing/golden/shape';
import { adaAndInvitee, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('the session’s origin reflection (review services IW-1)', () => {
  let run: TargetRun;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let ada: { id: string; email: string };
  let session: string;

  beforeAll(async () => {
    run = await openTargetRun('CREATED', `b3_origin_${process.pid}`);
    const ids = await adaAndInvitee(run);
    ada = { id: ids.adaUser, email: 'ada@e2e.test' };
    session = ids.session;
    http = await httpAs();
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  const origin = async (sessionId: string) => {
    const res = await http(ada, 'get', `/sessions/${sessionId}/state`);
    expect(res.status).toBe(200);
    return res.body.data.session.sourceInnerThoughts;
  };

  it('a reflection opened from inside the session is no origin card', async () => {
    const res = await http(ada, 'post', '/inner-thoughts', {
      title: 'PROBE_MID_SESSION venting',
      linkedPartnerSessionId: session,
    });
    expect(res.status).toBeLessThan(300);
    expect(await origin(session)).toBeNull();
  });

  it('the reflection a session was started from is its origin card', async () => {
    const reflection = await http(ada, 'post', '/inner-thoughts', { title: 'PROBE_ORIGIN before the session' });
    expect(reflection.status).toBeLessThan(300);
    const reflectionId: string = reflection.body.data.session.id;
    const created = await http(ada, 'post', '/sessions', { inviteName: 'Zoe', innerThoughtsId: reflectionId });
    expect(created.status).toBe(201);
    expect(await origin(created.body.data.session.id)).toMatchObject({ id: reflectionId });
  });
});
