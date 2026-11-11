/**
 * work-fdc1: the once-only facilitator lines dedupe on a closed key, not on a
 * digest of the content.
 *
 *   - catalog: message has no content_hash and no sha256_hex domain is left;
 *     dedupe_key is the message_dedupe_key enum, whose labels are exactly
 *     MESSAGE_DEDUPE_KEYS; sql_message_once is a partial unique index on
 *     (conversation_id, dedupe_key); a CHECK refuses a key on a human's line;
 *   - a USER turn (createParticipantMessage) leaves
 *     dedupe_key NULL;
 *   - createFacilitatorMessageOnce writes one row per (conversation, key), on
 *     a repeat and on two concurrent calls, and the job connection that writes
 *     it cannot read the key back;
 *   - T-message-immutable refuses an UPDATE of dedupe_key; inside an
 *     interactive transaction a duplicate is null and the transaction goes on;
 *   - Stage 4's hand-off bridge (POST /stage4/share-selections, Ada first,
 *     Bob not shared): one bridge row however often, or concurrently, Ada shares.
 *
 * STAGE4_REDESIGN_INVENTORY clone, app as mwf_app with identity binding, job as mwf_job.
 * Requires: npx tsx src/testing/golden/cli.ts build STAGE4_REDESIGN_INVENTORY
 */

import { isTargetShape } from '../../testing/golden/shape';
import { MESSAGE_DEDUPE_KEYS } from '../message-store';
import { adaAndBob, httpAs, openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(180_000);

describeTarget('once-only facilitator lines: a closed dedupe key, no content digest (work-fdc1)', () => {
  let run: TargetRun;
  let ids: Awaited<ReturnType<typeof adaAndBob>>;
  let http: Awaited<ReturnType<typeof httpAs>>;
  let store: typeof import('../message-store');
  let ctx: typeof import('../../lib/request-context');
  let conv: { ada: string; bob: string };
  const ada = () => ({ id: ids.adaUser, email: 'ada@e2e.test' });
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    ctx.runWithContext({ turnId: 't', requestId: 'r', startTime: Date.now(), userId }, async () => await fn());
  const keyed = (conversationId: string, key: string) =>
    run
      .sql<{ n: number }>(`SELECT count(*)::int AS n FROM message WHERE conversation_id = $1 AND dedupe_key = $2`, [
        conversationId,
        key,
      ])
      .then(r => r[0].n);

  beforeAll(async () => {
    run = await openTargetRun('STAGE4_REDESIGN_INVENTORY', `fdc1_once_${process.pid}`);
    ids = await adaAndBob(run);
    http = await httpAs();
    store = await import('../message-store');
    ctx = await import('../../lib/request-context');
    const cs = await run.sql<{ participant_id: string; id: string }>(
      `SELECT participant_id, id FROM conversation WHERE kind = 'MAIN' AND participant_id = ANY($1::uuid[])`,
      [[ids.ada, ids.bob]],
    );
    conv = {
      ada: cs.find(c => c.participant_id === ids.ada)!.id,
      bob: cs.find(c => c.participant_id === ids.bob)!.id,
    };
  });
  afterAll(async () => {
    if (run) await run.drop();
  });

  it('catalog: no content_hash, no sha256_hex; dedupe_key is the closed enum; sql_message_once is partial unique', async () => {
    const cols = await run.sql<{ c: string; t: string }>(
      `SELECT a.attname AS c, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
        WHERE a.attrelid = 'public.message'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    );
    expect(cols.map(c => c.c)).not.toContain('content_hash');
    expect(cols.find(c => c.c === 'dedupe_key')?.t).toBe('message_dedupe_key');
    expect(await run.sql(`SELECT 1 FROM pg_type WHERE typname = 'sha256_hex'`)).toEqual([]);
    // No column anywhere in the schema is named for a digest.
    expect(
      await run.sql(
        `SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace s ON s.oid = c.relnamespace
         WHERE s.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
           AND a.attname ~ '(^|_)(hash|digest|sha[0-9]*|md5)(_|$)'`,
      ),
    ).toEqual([]);
    const labels = await run.sql<{ l: string }>(
      `SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = 'message_dedupe_key'::regtype ORDER BY enumsortorder`,
    );
    expect(labels.map(l => l.l)).toEqual([...MESSAGE_DEDUPE_KEYS]);
    const [idx] = await run.sql<{ def: string; uniq: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisunique AS uniq FROM pg_index i
        WHERE i.indexrelid = 'public.sql_message_once'::regclass`,
    );
    expect(idx.uniq).toBe(true);
    // createFacilitatorMessageOnce's ON CONFLICT DO NOTHING names no target (mwf_job cannot
    // SELECT dedupe_key), so every unique index of message is an arbiter: it must stay
    // exactly the primary key and sql_message_once, or another conflict would be swallowed.
    const uniques = await run.sql<{ name: string }>(
      `SELECT i.indexrelid::regclass::text AS name FROM pg_index i
        WHERE i.indrelid = 'public.message'::regclass AND i.indisunique ORDER BY 1`,
    );
    expect(uniques.map(u => u.name)).toEqual(['message_pkey', 'sql_message_once']);
    expect(idx.def).toMatch(/ON public\.message USING btree \(conversation_id, dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)/);
  });

  it('the CHECK refuses a dedupe key on a human line', async () => {
    await expect(
      run.sql(
        `INSERT INTO message (conversation_id, sender_participant_id, role, content, dedupe_key)
         VALUES ($1, $2, 'USER', 'PROBE_FDC1_USER_KEY', 'STAGE4_HANDOFF_BRIDGE')`,
        [conv.ada, ids.ada],
      ),
    ).rejects.toThrow(/violates check constraint/);
  });

  it('a USER turn carries no dedupe key', async () => {
    const own = await asUser(ids.adaUser, () =>
      store.createParticipantMessage({ conversationId: conv.ada, participantId: ids.ada, content: 'PROBE_FDC1_TURN' }),
    );
    const [row] = await run.sql<{ dedupe_key: string | null }>(`SELECT dedupe_key FROM message WHERE id = $1`, [own.id]);
    expect(row).toEqual({ dedupe_key: null });
  });

  it('createFacilitatorMessageOnce: one row per (conversation, key), on a repeat and on concurrent calls', async () => {
    const first = await store.createFacilitatorMessageOnce({
      conversationId: conv.bob,
      dedupeKey: 'STAGE2_VALIDATED_WAIT',
      content: 'PROBE_FDC1_ONCE',
    });
    expect(first).toMatchObject({ role: 'AI', kind: 'CHAT', content: 'PROBE_FDC1_ONCE' });
    const again = await store.createFacilitatorMessageOnce({
      conversationId: conv.bob,
      dedupeKey: 'STAGE2_VALIDATED_WAIT',
      content: 'PROBE_FDC1_ONCE (different text, same key)',
    });
    expect(again).toBeNull();
    expect(await keyed(conv.bob, 'STAGE2_VALIDATED_WAIT')).toBe(1);

    // Concurrent: a fresh key in another conversation, five writers at once.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.createFacilitatorMessageOnce({
          conversationId: conv.ada,
          dedupeKey: 'STAGE2_VALIDATED_WAIT',
          content: 'PROBE_FDC1_RACE',
        }),
      ),
    );
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect(await keyed(conv.ada, 'STAGE2_VALIDATED_WAIT')).toBe(1);
    // The same key is independent per conversation, and per key.
    expect(await keyed(conv.bob, 'STAGE4_HANDOFF_BRIDGE')).toBe(0);
  });

  it('T-message-immutable refuses an UPDATE of dedupe_key (clearing it would allow a second line)', async () => {
    const [{ id }] = await run.sql<{ id: string }>(
      `SELECT id FROM message WHERE conversation_id = $1 AND dedupe_key = 'STAGE2_VALIDATED_WAIT'`,
      [conv.bob],
    );
    await expect(run.sql(`UPDATE message SET dedupe_key = NULL WHERE id = $1`, [id])).rejects.toThrow(
      /message routing is immutable/,
    );
    await expect(
      run.sql(`UPDATE message SET dedupe_key = 'STAGE4_HANDOFF_BRIDGE' WHERE id = $1`, [id]),
    ).rejects.toThrow(/message routing is immutable/);
    expect(await keyed(conv.bob, 'STAGE2_VALIDATED_WAIT')).toBe(1);
  });

  it('inside an interactive transaction a duplicate returns null and the transaction goes on', async () => {
    const { getJobPrisma } = await import('../../lib/prisma');
    const out = await getJobPrisma().$transaction(async tx => {
      const dup = await store.createFacilitatorMessageOnce({
        conversationId: conv.bob,
        dedupeKey: 'STAGE2_VALIDATED_WAIT',
        content: 'PROBE_FDC1_TX_DUP',
        client: tx,
      });
      // A later statement in the same transaction still runs (no 25P02).
      const fresh = await store.createFacilitatorMessageOnce({
        conversationId: conv.bob,
        dedupeKey: 'STAGE4_HANDOFF_BRIDGE',
        content: 'PROBE_FDC1_TX_FRESH',
        client: tx,
      });
      return { dup, fresh };
    });
    expect(out.dup).toBeNull();
    expect(out.fresh).toMatchObject({ content: 'PROBE_FDC1_TX_FRESH' });
    expect(await keyed(conv.bob, 'STAGE4_HANDOFF_BRIDGE')).toBe(1);
    expect(await keyed(conv.bob, 'STAGE2_VALIDATED_WAIT')).toBe(1);
  });

  it('the job connection may write a dedupe key but not read it', async () => {
    await expect(
      run.as('mwf_job', null, `SELECT dedupe_key FROM message WHERE conversation_id = $1`, [conv.ada]),
    ).rejects.toThrow(/permission denied/);
  });

  it("Stage 4 hand-off bridge: Ada's first share writes it once; a repeat and two concurrent shares add nothing", async () => {
    const sid = ids.session;
    const proposals = await run.sql<{ id: string }>(
      `SELECT id FROM proposal WHERE kind = 'SHARED_PROPOSAL' AND status = 'ACTIVE'`,
    );
    const needs = await run.sql<{ id: string }>(`SELECT n.id FROM need n JOIN need_share s ON s.need_id = n.id`);
    for (const p of proposals) {
      expect(
        (await http(ada(), 'post', `/sessions/${sid}/stage4/proposals/${p.id}/selection`, { decision: 'NOT_WILLING' }))
          .status,
      ).toBe(200);
    }
    for (const n of needs) {
      expect((await http(ada(), 'post', `/sessions/${sid}/stage4/needs/${n.id}/decline`, {})).status).toBe(200);
    }
    // Bob has not shared: the bridge goes into Ada's conversation.
    expect(await run.sql(`SELECT 1 FROM participant_milestone WHERE milestone_key = 'choices_shared'`)).toEqual([]);
    expect(await keyed(conv.ada, 'STAGE4_HANDOFF_BRIDGE')).toBe(0);

    const share = () => http(ada(), 'post', `/sessions/${sid}/stage4/share-selections`, {});
    expect((await share()).status).toBe(200);
    expect(await keyed(conv.ada, 'STAGE4_HANDOFF_BRIDGE')).toBe(1);
    const [bridge] = await run.sql<{ role: string; kind: string; sender: string | null }>(
      `SELECT role::text AS role, kind::text AS kind, sender_participant_id AS sender FROM message
        WHERE conversation_id = $1 AND dedupe_key = 'STAGE4_HANDOFF_BRIDGE'`,
      [conv.ada],
    );
    expect(bridge).toEqual({ role: 'AI', kind: 'CHAT', sender: null });

    expect((await share()).status).toBe(200);
    const both = await Promise.all([share(), share()]);
    expect(both.map(r => r.status)).toEqual([200, 200]);
    expect(await keyed(conv.ada, 'STAGE4_HANDOFF_BRIDGE')).toBe(1);
    // Bob's conversation keeps just the transaction test's row: Ada's shares write only into hers.
    expect(await keyed(conv.bob, 'STAGE4_HANDOFF_BRIDGE')).toBe(1);
  });
});
