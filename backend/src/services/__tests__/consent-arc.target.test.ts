/**
 * TS-10 real-role tests: the consent arc and the share-offer decline.
 *
 * RECONCILER_SHOWN_B clone; the app logs in as `mwf_app` with identity binding
 * on, the job as `mwf_job` (harness `appLogin: 'mwf_app'`).
 *
 *   - T-consent-owner: a consent whose arc names someone else's target (or a
 *     missing one) is refused with ONE fixed message carrying no ids;
 *   - T-consent-transitions: NULL → GRANTED | DENIED, GRANTED → REVOKED, and
 *     nothing else; a consent is never created revoked; share-offer and review
 *     consents have no requester (CHECK);
 *   - the endpoints read and decide only the caller's own rows;
 *   - the subject's decline changes nothing the author can read except the
 *     direction's status (spec §7; golden R7 at unit level).
 */

import { createHarness, type Harness } from '../../testing/golden/driver';
import { withClient } from '../../testing/golden/db';
import { isTargetShape } from '../../testing/golden/shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';
const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

const FIXED = 'consent target is not yours';

describeTarget('the consent arc and the share-offer decline (mwf_app + mwf_job, identity binding on)', () => {
  let harness: Harness;
  let ada: { participantId: string; userId: string };
  let bob: { participantId: string; userId: string };
  let adaAttempt: string;
  let bobAttempt: string;
  let offerId: string;

  const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
    withClient(harness.fixture.target, async c => (await c.query<T>(sql, params)).rows, harness.fixture.database);
  /** A statement on the APP connection (mwf_app) under `userId`'s identity. */
  const asApp = async <T = unknown>(userId: string, sql: string, ...params: unknown[]): Promise<T[]> => {
    const { prisma } = await import('../../lib/prisma');
    const { runWithContext } = await import('../../lib/request-context');
    return runWithContext(
      { turnId: 't', requestId: 'r', startTime: Date.now(), userId },
      async () => (await prisma.$queryRawUnsafe(sql, ...params)) as T[],
    );
  };
  const step = (
    actor: Harness['actors']['userA'],
    label: string,
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) =>
    harness.step({
      label,
      actor,
      tables: [],
      asyncBoundary: method === 'post',
      call: agent => (method === 'get' ? agent.get(`/api/v1${path}`) : agent.post(`/api/v1${path}`).send(body ?? {})),
    });

  beforeAll(async () => {
    harness = await createHarness({
      baseUrl: BASE_URL,
      stage: 'RECONCILER_SHOWN_B',
      runId: `ts10_consent_${process.pid}`,
      appLogin: 'mwf_app',
    });
    const parts = await rows<{ id: string; user_id: string; email: string }>(
      `SELECT p.id, p.user_id, u.email FROM participant p JOIN "user" u ON u.id = p.user_id`,
    );
    const pick = (email: string) => {
      const p = parts.find(x => x.email === email)!;
      return { participantId: p.id, userId: p.user_id };
    };
    ada = pick('ada@e2e.test');
    bob = pick('bob@e2e.test');
    const a = await rows<{ id: string; author: string }>(
      `SELECT id, author_participant_id AS author FROM empathy_attempt`,
    );
    adaAttempt = a.find(x => x.author === ada.participantId)!.id;
    bobAttempt = a.find(x => x.author === bob.participantId)!.id;
    offerId = (await rows<{ id: string }>(`SELECT id FROM context_share_offer`))[0].id;
  });
  afterAll(async () => {
    if (harness) await harness.teardown();
  });

  // --- T-consent-owner ------------------------------------------------------------

  it('a consent naming a foreign target is refused with the one fixed message, no ids', async () => {
    const tries: Array<[string, string]> = [
      // Ada consenting over Bob's attempt and Bob's share offer.
      ['empathy_attempt_id', bobAttempt],
      ['share_offer_id', offerId],
      // A target that does not exist reads the same.
      ['empathy_attempt_id', '01990000-0000-7000-8000-000000000000'],
    ];
    for (const [col, id] of tries) {
      const err = await asApp(
        ada.userId,
        `INSERT INTO consent (participant_id, ${col}) VALUES ($1::uuid, $2::uuid)`,
        ada.participantId,
        id,
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      const message = String(err!.message);
      expect(message).toContain(FIXED);
      expect(message).not.toContain(id);
      expect(message).not.toContain(ada.participantId);
    }
  });

  it('decision moves only NULL → GRANTED | DENIED and GRANTED → REVOKED', async () => {
    const [c] = await asApp<{ id: string }>(
      ada.userId,
      `INSERT INTO consent (participant_id, requested_by_participant_id, empathy_attempt_id) VALUES ($1::uuid, $1::uuid, $2::uuid) RETURNING id`,
      ada.participantId,
      adaAttempt,
    );
    const move = (set: string) => asApp(ada.userId, `UPDATE consent SET ${set} WHERE id = $1::uuid`, c.id);
    await expect(move(`decision = 'REVOKED', revoked_at = now()`)).rejects.toThrow(/not permitted/);
    await move(`decision = 'GRANTED', decided_at = now()`);
    await expect(move(`decision = 'DENIED'`)).rejects.toThrow(/not permitted/);
    await expect(move(`decision = 'REVOKED'`)).rejects.toThrow(
      /revocation keeps decided_at and records revoked_at|check/,
    );
    await move(`decision = 'REVOKED', revoked_at = now()`);
    await expect(move(`decision = 'GRANTED', revoked_at = NULL`)).rejects.toThrow(/not permitted/);
    await expect(
      asApp(
        ada.userId,
        `INSERT INTO consent (participant_id, empathy_attempt_id, decision, decided_at, revoked_at) VALUES ($1::uuid, $2::uuid, 'REVOKED', now(), now())`,
        ada.participantId,
        adaAttempt,
      ),
    ).rejects.toThrow(/not created revoked/);
    // target_kind is generated: it cannot be written.
    await expect(move(`target_kind = 'NEED'`)).rejects.toThrow(/can only be updated to DEFAULT/);
  });

  it('a share-offer consent has no requester', async () => {
    await expect(
      asApp(
        bob.userId,
        `INSERT INTO consent (participant_id, requested_by_participant_id, share_offer_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        bob.participantId,
        ada.participantId,
        offerId,
      ),
    ).rejects.toThrow(/chk_consent_requester/);
  });

  // --- the endpoints read and decide only the caller's own rows -----------------

  it("pending and history list the caller's own rows; deciding or revoking another's is not found", async () => {
    const [mine] = await asApp<{ id: string }>(
      bob.userId,
      `INSERT INTO consent (participant_id, requested_by_participant_id, empathy_attempt_id) VALUES ($1::uuid, $1::uuid, $2::uuid) RETURNING id`,
      bob.participantId,
      bobAttempt,
    );
    const sid = harness.sessionId;
    const adaPending = await step(harness.actors.userA, 'ada pending', 'get', `/sessions/${sid}/consent/pending`);
    expect(JSON.stringify(adaPending.body)).not.toContain(mine.id);
    const bobPending = await step(harness.actors.userB!, 'bob pending', 'get', `/sessions/${sid}/consent/pending`);
    expect(
      (bobPending.body as { data: { pendingRequests: Array<{ id: string; contentType: string; targetId: string }> } })
        .data.pendingRequests,
    ).toEqual([expect.objectContaining({ id: mine.id, contentType: 'EMPATHY_DRAFT', targetId: bobAttempt })]);

    const foreign = await step(harness.actors.userA, 'ada decides bob’s', 'post', `/sessions/${sid}/consent/decide`, {
      consentRequestId: mine.id,
      decision: 'GRANTED',
    });
    expect(foreign.status).toBe(404);
    const decided = await step(harness.actors.userB!, 'bob decides', 'post', `/sessions/${sid}/consent/decide`, {
      consentRequestId: mine.id,
      decision: 'GRANTED',
    });
    expect(
      (decided.body as { data: { consentRecord: { decision: string; contentType: string } } }).data.consentRecord,
    ).toMatchObject({
      decision: 'GRANTED',
      contentType: 'EMPATHY_DRAFT',
    });
    expect(
      (
        await step(harness.actors.userA, 'ada revokes bob’s', 'post', `/sessions/${sid}/consent/revoke`, {
          consentRecordId: mine.id,
        })
      ).status,
    ).toBe(404);
    const revoked = await step(harness.actors.userB!, 'bob revokes', 'post', `/sessions/${sid}/consent/revoke`, {
      consentRecordId: mine.id,
    });
    expect(revoked.status).toBe(200);
    expect(
      await rows(
        `SELECT decision::text AS decision, decided_at IS NOT NULL AS decided, revoked_at IS NOT NULL AS revoked FROM consent WHERE id = $1`,
        [mine.id],
      ),
    ).toEqual([{ decision: 'REVOKED', decided: true, revoked: true }]);

    const history = await step(harness.actors.userA, 'ada history', 'get', `/sessions/${sid}/consent/history`);
    const records = (history.body as { data: { records: Array<{ id: string }> } }).data.records;
    const adaOwn = await rows<{ id: string }>(`SELECT id FROM consent WHERE participant_id = $1`, [ada.participantId]);
    expect(records.map(r => r.id).sort()).toEqual(adaOwn.map(r => r.id).sort());
  });

  // --- the share-offer decline -------------------------------------------------------

  it("the subject's decline changes nothing the author can read except the direction's status", async () => {
    const sid = harness.sessionId;
    const reads: Array<[string, string]> = [
      ['empathy status', `/sessions/${sid}/empathy/status`],
      ['partner empathy', `/sessions/${sid}/empathy/partner`],
      ['messages', `/sessions/${sid}/messages`],
      ['reconciler status', `/sessions/${sid}/reconciler/status`],
      ['share offer', `/sessions/${sid}/reconciler/share-offer`],
      ['share suggestion', `/sessions/${sid}/empathy/share-suggestion`],
      ['pending consent', `/sessions/${sid}/consent/pending`],
      ['consent history', `/sessions/${sid}/consent/history`],
      ['pending actions', `/sessions/${sid}/pending-actions`],
      ['badge count', `/notifications/badge-count`],
    ];
    const readAll = async (phase: string) => {
      const out: Record<string, unknown> = {};
      for (const [name, path] of reads) {
        const s = await step(harness.actors.userA, `${phase}: ${name}`, 'get', path);
        expect(s.status).toBe(200);
        out[name] = s.body;
      }
      return out;
    };
    const before = await readAll('before');
    const decline = await step(
      harness.actors.userB!,
      'bob declines',
      'post',
      `/sessions/${sid}/reconciler/share-offer/respond`,
      {
        action: 'decline',
      },
    );
    expect(decline.status).toBe(200);
    const after = await readAll('after');

    const diff = (a: unknown, b: unknown, p: string[] = [], out: string[] = []): string[] => {
      if (JSON.stringify(a) === JSON.stringify(b)) return out;
      const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
      if (obj(a) && obj(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], [...p, k], out);
        return out;
      }
      out.push(p.join('.'));
      return out;
    };
    const changed = reads.flatMap(([name]) => diff(before[name], after[name]).map(path => `${name} @ ${path}`));
    expect(changed.sort()).toEqual(['empathy status @ data.awaitingSharing', 'empathy status @ data.myAttempt.status']);

    // The decision row: the subject's, naming the offer, with no requester.
    expect(
      await rows(
        `SELECT participant_id AS who, requested_by_participant_id AS requester, decision::text AS decision, target_kind::text AS kind
         FROM consent WHERE share_offer_id = $1`,
        [offerId],
      ),
    ).toEqual([{ who: bob.participantId, requester: null, decision: 'DENIED', kind: 'SHARE_OFFER' }]);
    expect(await rows(`SELECT status::text AS status FROM context_share_offer WHERE id = $1`, [offerId])).toEqual([
      { status: 'DECLINED' },
    ]);
    expect(await rows(`SELECT status::text AS status FROM empathy_attempt WHERE id = $1`, [adaAttempt])).toEqual([
      { status: 'READY' },
    ]);
  });
});
