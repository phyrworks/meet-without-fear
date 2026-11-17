/**
 * The runtime role guard (work-k5fk.10.3): pure rules, the adapter wrapper,
 * and who may exempt a process.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  guardAdapterFactory,
  roleGuardViolations,
  ALLOWED_MEMBERSHIPS,
  ROLE_GUARD_SQL,
  RuntimeRoleRefusedError,
  exemptProcessFromRoleGuard,
  resetRoleGuardExemptionForTests,
  type RoleFacts,
} from '../prisma-role-guard';
import type { PgAdapterFactory } from '../prisma-pg';

const clean = (role = 'mwf_app'): RoleFacts => ({
  role,
  currentUser: role,
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  replication: false,
  memberships: [],
  adminMemberships: [],
  setRoles: [],
  privilegedRoles: [],
  schemaCreate: [],
  databaseOwner: null,
  databaseCreate: false,
  setReplicationRole: false,
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

  it('refuses a login whose session runs as another role (session_user <> current_user)', () => {
    expect(roleGuardViolations({ ...clean('mwf_user'), currentUser: 'mwf_app' }, 'app')[0]).toMatch(
      /the login mwf_user runs as mwf_app \(session_user <> current_user/,
    );
  });

  it('refuses CREATEROLE, CREATEDB and REPLICATION', () => {
    expect(roleGuardViolations({ ...clean(), createrole: true, createdb: true, replication: true }, 'app')).toEqual([
      'mwf_app has CREATEROLE',
      'mwf_app has CREATEDB',
      'mwf_app has REPLICATION',
    ]);
  });

  it('accepts each client reaching exactly its one capability role (work-k5fk.10.4)', () => {
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access'] }, 'app')).toEqual([]);
    expect(roleGuardViolations({ ...clean('mwf_ai'), memberships: ['ai_access'] }, 'ai')).toEqual([]);
    expect(roleGuardViolations({ ...clean('mwf_worker'), memberships: ['worker_access'] }, 'worker')).toEqual([]);
    expect(roleGuardViolations({ ...clean('mwf_ops'), memberships: ['ops_access'] }, 'ops')).toEqual([]);
    expect(roleGuardViolations({ ...clean('mwf_auth'), memberships: ['auth_access'] }, 'auth')).toEqual([]);
    expect(ALLOWED_MEMBERSHIPS).toEqual({
      app: ['app_access'],
      ai: ['ai_access'],
      worker: ['worker_access'],
      ops: ['ops_access'],
      auth: ['auth_access'],
    });
  });

  it("refuses any other role reached, e.g. another login (production's old mwf_job TO mwf_app), a second capability, a predefined role", () => {
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access', 'mwf_ai'] }, 'app')).toEqual([
      'mwf_app reaches role(s) mwf_ai (directly or through another role; the app login may reach app_access only)',
    ]);
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access', 'worker_access'] }, 'app')).toHaveLength(1);
    expect(roleGuardViolations({ ...clean(), memberships: ['pg_write_all_data'] }, 'app')).toHaveLength(1);
    // Another client's capability is not this client's.
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access'] }, 'ai')).toEqual([
      'mwf_app reaches role(s) app_access (directly or through another role; the ai login may reach ai_access only)',
    ]);
  });

  it('refuses the capability itself being a member of another role (memberships are transitive)', () => {
    // ROLE_GUARD_SQL reports every role reached through pg_has_role(…, 'MEMBER'): app_access in mwf_ai shows as both.
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access', 'mwf_ai'] }, 'app')[0]).toMatch(
      /reaches role\(s\) mwf_ai/,
    );
    expect(ROLE_GUARD_SQL).toMatch(
      /'memberships', ARRAY\(\s*SELECT r\.rolname::text FROM pg_catalog\.pg_roles r\s*WHERE r\.oid <> me\.oid AND pg_catalog\.pg_has_role\(me\.oid, r\.oid, 'MEMBER'\)/,
    );
  });

  it('review 9a F1: refuses a login that can SET ROLE to any role (its capability included)', () => {
    // SET ROLE app_access would make current_user app_access: the triggers keyed on the login (and any
    // future per-login policy) would no longer see mwf_app.
    expect(roleGuardViolations({ ...clean(), memberships: ['app_access'], setRoles: ['app_access'] }, 'app')).toEqual([
      'mwf_app can SET ROLE to app_access (a runtime login holds its capability WITH SET FALSE)',
    ]);
    expect(ROLE_GUARD_SQL).toMatch(
      /'setRoles', ARRAY\(\s*SELECT r\.rolname::text FROM pg_catalog\.pg_roles r\s*WHERE r\.oid <> me\.oid AND pg_catalog\.pg_has_role\(me\.oid, r\.oid, 'SET'\)/,
    );
  });

  it('refuses a capability held WITH ADMIN OPTION', () => {
    expect(
      roleGuardViolations({ ...clean(), memberships: ['app_access'], adminMemberships: ['app_access'] }, 'app'),
    ).toEqual(['mwf_app holds role(s) app_access WITH ADMIN OPTION']);
  });

  it('refuses the database owner, CREATE on the database, and SET on session_replication_role', () => {
    expect(
      roleGuardViolations(
        { ...clean(), databaseOwner: 'mwf_app', databaseCreate: true, setReplicationRole: true },
        'app',
      ),
    ).toEqual([
      'mwf_app owns the database (owner mwf_app)',
      'mwf_app may CREATE in the database',
      'mwf_app may SET session_replication_role (turns triggers off)',
    ]);
  });

  it('refuses CREATE on schema public or app', () => {
    expect(roleGuardViolations({ ...clean(), schemaCreate: ['app', 'public'] }, 'app')).toEqual([
      'mwf_app may CREATE in schema(s) app, public',
    ]);
  });

  it('refuses a login that owns (or can SET ROLE to the owner of) any object', () => {
    const facts: RoleFacts = {
      ...clean(),
      owned: [
        { object: 'relation public.session', owner: 'mwf_app' },
        { object: 'schema public', owner: 'pg_database_owner' },
      ],
    };
    expect(roleGuardViolations(facts, 'app')).toEqual([
      'mwf_app owns objects in public/app: relation public.session (owner mwf_app), schema public (owner pg_database_owner)',
    ]);
  });

  it('refuses any login owning a SECURITY DEFINER function: the row 9a allowance is gone (mwf_definer owns them)', () => {
    const definer = { object: 'function app.is_member', owner: 'mwf_ai' };
    for (const role of ['app', 'ai', 'worker', 'ops', 'auth'] as const) {
      expect(roleGuardViolations({ ...clean('mwf_ai'), owned: [definer] }, role)).toEqual([
        'mwf_ai owns objects in public/app: function app.is_member (owner mwf_ai)',
      ]);
    }
  });

  it('caps the listed objects at five', () => {
    const owned = Array.from({ length: 7 }, (_, i) => ({
      object: `relation public.t${i}`,
      owner: 'x',
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
    await expect(guardAdapterFactory(factory, 'app', { readFacts, exemption: 'E2E tooling' }).connect()).resolves.toBe(
      adapter,
    );
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

  /** Every file (tests included) that names either exemption, outside the guard module itself. */
  function namers(identifier: string): string[] {
    return [...tsFiles(SRC), ...tsFiles(path.join(BACKEND, 'scripts'))]
      .filter(f => new RegExp(`\\b${identifier}\\b`).test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(BACKEND, f))
      .filter(f => f !== 'src/lib/prisma-role-guard.ts' && f !== 'src/lib/__tests__/prisma-role-guard.test.ts')
      .sort();
  }

  // An exact list, not a pattern: adding an exemption anywhere (a new script, a runtime
  // module, a test) fails here until it is added deliberately.
  it('the process exemption is named by exactly the operator scripts', () => {
    expect(namers('exemptProcessFromRoleGuard')).toEqual([
      'scripts/check-duplicate-messages.ts',
      'scripts/check-session-messages.ts',
      'scripts/extract-session-transcripts.ts',
      'scripts/inspect-db.ts',
      'src/scripts/analyze-session.ts',
      'src/scripts/mwf-moment-real.ts',
      'src/scripts/query-facts.ts',
      'src/scripts/reset-db-data.ts',
    ]);
  });

  it('a client exemption is named only by lib/prisma (the E2E tooling client) and two DB tests', () => {
    expect(namers('roleGuardExemption')).toEqual([
      'src/lib/prisma.ts',
      'src/middleware/__tests__/errors.pg.test.ts',
      'src/services/__tests__/encryption-at-rest-repair.target.test.ts',
    ]);
  });
});
