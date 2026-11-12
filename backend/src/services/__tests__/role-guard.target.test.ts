/**
 * work-k5fk.10.3, against a real target run database (a clone of the
 * FEEL_HEARD_B fixture, owned by mwf_migrator): a runtime Prisma client
 * refuses a superuser login (mwf_user) and the owner (mwf_migrator), and
 * accepts the least-privilege logins (mwf_app; mwf_job with its temporary
 * definer-function allowance).
 *
 * Requires the target shape and a built target fixture:
 *   npx tsx src/testing/golden/cli.ts build FEEL_HEARD_B
 */
import { appUrlFor, jobUrlFor } from '../../testing/golden/driver';
import { restoreFixture, type RestoredFixture } from '../../testing/golden/fixtures';
import { isTargetShape } from '../../testing/golden/shape';
import { migratorTarget } from '../../testing/golden/target-baseline';
import { toDbUrl } from '../../testing/golden/db';
import { BASE_URL } from './target-roles';
import { createPrismaClient } from '../../lib/prisma';
import { RuntimeRoleRefusedError } from '../../lib/prisma-role-guard';

const describeTarget = isTargetShape() ? describe : describe.skip;
jest.setTimeout(120_000);

describeTarget('runtime role guard (target)', () => {
  let fx: RestoredFixture;

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `guard_${process.pid}` });
  });
  afterAll(async () => {
    await fx?.drop();
  });

  async function firstQuery(url: string, role: 'app' | 'job' = 'app'): Promise<unknown> {
    const client = createPrismaClient({ url, role });
    try {
      return await client.$queryRaw`SELECT current_user::text AS who`;
    } catch (e) {
      return e;
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  }

  it('refuses the superuser (mwf_user): SUPERUSER and BYPASSRLS', async () => {
    const r = await firstQuery(fx.url);
    expect(r).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((r as Error).message).toMatch(/is a SUPERUSER/);
    expect((r as Error).message).toMatch(/has BYPASSRLS/);
  });

  it('refuses the owner (mwf_migrator): it owns the tables, and can SET ROLE mwf_job', async () => {
    const r = await firstQuery(toDbUrl({ ...migratorTarget(fx.target), database: fx.database }), 'job');
    expect(r).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((r as Error).message).toMatch(/mwf_migrator owns objects in public\/app: .*\(owner mwf_migrator\)/);
  });

  it('accepts mwf_app', async () => {
    expect(await firstQuery(appUrlFor(fx.target, fx.database))).toEqual([{ who: 'mwf_app' }]);
  });

  it('accepts mwf_job as the job (it owns only the app definer functions), and refuses it as the app', async () => {
    expect(await firstQuery(jobUrlFor(fx.target, fx.database), 'job')).toEqual([{ who: 'mwf_job' }]);
    const asApp = await firstQuery(jobUrlFor(fx.target, fx.database), 'app');
    expect(asApp).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((asApp as Error).message).toMatch(/function app\./);
  });
});
