/**
 * work-k5fk.6, against a real target run database: milestone.key and
 * participant_milestone.milestone_key are the milestone_key domain — a
 * lower-case identifier of at most 64 characters.
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { isTargetShape } from '../../testing/golden/shape';
import { openTargetRun, type TargetRun } from './target-roles';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('the milestone_key domain (target)', () => {
  let run: TargetRun;

  beforeAll(async () => {
    run = await openTargetRun('FEEL_HEARD_B', `mkey_${process.pid}`);
  });
  afterAll(async () => {
    await run?.drop();
  });

  /** Insert a milestone with this key: 'ok' or the SQLSTATE it is refused with. */
  async function insertMilestone(key: string, ordinal: number): Promise<string> {
    try {
      await run.sql(`INSERT INTO milestone (key, ordinal, stage_label) VALUES ($1, $2, 'Test')`, [key, ordinal]);
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  it('both key columns are typed milestone_key', async () => {
    const rows = await run.sql<{ col: string; type: string }>(
      `SELECT attrelid::regclass::text || '.' || attname AS col, format_type(atttypid, atttypmod) AS type
       FROM pg_attribute
       WHERE (attrelid, attname) IN (('milestone'::regclass, 'key'), ('participant_milestone'::regclass, 'milestone_key'))
       ORDER BY 1`,
    );
    expect(rows).toEqual([
      { col: 'milestone.key', type: 'milestone_key' },
      { col: 'participant_milestone.milestone_key', type: 'milestone_key' },
    ]);
  });

  it('64 characters pass, 65 are refused (23514)', async () => {
    expect(await insertMilestone('k' + 'x'.repeat(63), 9001)).toBe('ok');
    expect(await insertMilestone('k' + 'x'.repeat(64), 9002)).toBe('23514');
  });

  it('only a lower-case identifier passes (23514)', async () => {
    expect(await insertMilestone('Feel_Heard', 9003)).toBe('23514');
    expect(await insertMilestone('feel-heard', 9004)).toBe('23514');
    expect(await insertMilestone('1st', 9005)).toBe('23514');
    expect(await insertMilestone('', 9006)).toBe('23514');
  });
});
