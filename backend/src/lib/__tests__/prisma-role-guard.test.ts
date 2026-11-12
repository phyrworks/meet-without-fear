/**
 * The runtime role guard (work-k5fk.10.3): pure rules, the adapter wrapper,
 * and who may exempt a process.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  guardAdapterFactory,
  roleGuardViolations,
  RuntimeRoleRefusedError,
  exemptProcessFromRoleGuard,
  resetRoleGuardExemptionForTests,
  type RoleFacts,
} from '../prisma-role-guard';
import type { PgAdapterFactory } from '../prisma-pg';

const clean = (role = 'mwf_app'): RoleFacts => ({
  role,
  superuser: false,
  bypassrls: false,
  privilegedRoles: [],
  owned: [],
});

describe('roleGuardViolations', () => {
  it('accepts a plain least-privilege login', () => {
    expect(roleGuardViolations(clean(), 'app')).toEqual([]);
  });

  it('refuses a superuser, BYPASSRLS, and a login that can SET ROLE to one', () => {
    expect(roleGuardViolations({ ...clean('mwf_user'), superuser: true, bypassrls: true }, 'app')).toEqual([
      'mwf_user is a SUPERUSER',
      'mwf_user has BYPASSRLS',
    ]);
    expect(roleGuardViolations({ ...clean(), privilegedRoles: ['mwf_user'] }, 'app')).toEqual([
      'mwf_app can SET ROLE to superuser/BYPASSRLS role(s): mwf_user',
    ]);
  });

  it('refuses a login that owns (or can SET ROLE to the owner of) any object', () => {
    const facts: RoleFacts = {
      ...clean(),
      owned: [
        { object: 'relation public.session', owner: 'mwf_app', definerFunction: false, ownedBySelf: true },
        { object: 'schema public', owner: 'pg_database_owner', definerFunction: false, ownedBySelf: false },
      ],
    };
    expect(roleGuardViolations(facts, 'app')).toEqual([
      'mwf_app owns objects in public/app: relation public.session (owner mwf_app), schema public (owner pg_database_owner)',
    ]);
  });

  it('tolerates the job login owning app SECURITY DEFINER functions — for the job role only (until row 9a)', () => {
    const definer = { object: 'function app.is_member', owner: 'mwf_job', definerFunction: true, ownedBySelf: true };
    expect(roleGuardViolations({ ...clean('mwf_job'), owned: [definer] }, 'job')).toEqual([]);
    expect(roleGuardViolations({ ...clean('mwf_job'), owned: [definer] }, 'app')).toHaveLength(1);
    // Through membership (not the login itself) is never tolerated.
    expect(roleGuardViolations({ ...clean('mwf_app'), owned: [{ ...definer, ownedBySelf: false }] }, 'job')).toHaveLength(
      1,
    );
    // A non-definer object is never tolerated.
    expect(
      roleGuardViolations({ ...clean('mwf_job'), owned: [{ ...definer, definerFunction: false }] }, 'job'),
    ).toHaveLength(1);
  });

  it('caps the listed objects at five', () => {
    const owned = Array.from({ length: 7 }, (_, i) => ({
      object: `relation public.t${i}`,
      owner: 'x',
      definerFunction: false,
      ownedBySelf: true,
    }));
    expect(roleGuardViolations({ ...clean(), owned }, 'app')[0]).toMatch(/ and 2 more$/);
  });
});

describe('guardAdapterFactory', () => {
  function fakeFactory() {
    const adapter = { dispose: jest.fn() };
    const factory = {
      provider: 'postgres',
      adapterName: 'fake',
      connect: jest.fn().mockResolvedValue(adapter),
      connectToShadowDb: jest.fn(),
    } as unknown as PgAdapterFactory;
    return { adapter, factory };
  }

  afterEach(() => resetRoleGuardExemptionForTests());

  it('hands over the adapter of an accepted login', async () => {
    const { adapter, factory } = fakeFactory();
    const readFacts = jest.fn().mockResolvedValue(clean());
    await expect(guardAdapterFactory(factory, 'app', { readFacts }).connect()).resolves.toBe(adapter);
    expect(readFacts).toHaveBeenCalledTimes(1);
  });

  it('refuses a superuser login before any pooled connection is opened', async () => {
    const { factory } = fakeFactory();
    const readFacts = jest.fn().mockResolvedValue({ ...clean('mwf_user'), superuser: true });
    const err = await guardAdapterFactory(factory, 'app', { readFacts })
      .connect()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeRoleRefusedError);
    expect((err as Error).message).toMatch(/Refusing the app database connection.*mwf_user is a SUPERUSER/);
    expect(factory.connect).not.toHaveBeenCalled();
  });

  it('skips the check for a client exempted with a reason, and requires the reason', async () => {
    const { adapter, factory } = fakeFactory();
    const readFacts = jest.fn().mockResolvedValue({ ...clean('mwf_user'), superuser: true });
    await expect(guardAdapterFactory(factory, 'app', { readFacts, exemption: 'E2E tooling' }).connect()).resolves.toBe(adapter);
    expect(readFacts).not.toHaveBeenCalled();
    expect(() => guardAdapterFactory(factory, 'app', { readFacts, exemption: ' ' })).toThrow(/reason/);
  });

  it('skips the check in a process an operator script exempted', async () => {
    const { adapter, factory } = fakeFactory();
    const readFacts = jest.fn().mockResolvedValue({ ...clean('mwf_user'), superuser: true });
    exemptProcessFromRoleGuard('operator script');
    await expect(guardAdapterFactory(factory, 'app', { readFacts }).connect()).resolves.toBe(adapter);
    expect(() => exemptProcessFromRoleGuard('')).toThrow(/reason/);
  });
});

describe('who may exempt from the guard', () => {
  const SRC = path.resolve(__dirname, '../..');
  const BACKEND = path.resolve(SRC, '..');

  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === 'generated' || e.name === 'node_modules' ? [] : tsFiles(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('only operator scripts exempt a process; only the E2E tooling client exempts a client', () => {
    const files = [...tsFiles(SRC), ...tsFiles(path.join(BACKEND, 'scripts'))].filter(f => !f.includes('__tests__'));
    const processCallers = files
      .filter(f => /exemptProcessFromRoleGuard\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(BACKEND, f))
      .filter(f => f !== 'src/lib/prisma-role-guard.ts');
    for (const f of processCallers) expect(f).toMatch(/^(scripts\/|src\/scripts\/)/);
    const clientExemptions = files
      .filter(f => /roleGuardExemption:/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(BACKEND, f))
      .filter(f => f !== 'src/lib/prisma-role-guard.ts');
    expect(clientExemptions).toEqual(['src/lib/prisma.ts']);
  });
});
