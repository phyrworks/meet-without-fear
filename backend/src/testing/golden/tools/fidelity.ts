/**
 * Fixture byte-fidelity check: does a change to the state-factory write the
 * same rows as before?
 *
 *   npx tsx src/testing/golden/tools/fidelity.ts run --old-ref phoenix/base
 *
 * Seeds every TargetStage (with and without a partner account) twice — once
 * with the state-factory at `--old-ref`, once with the working tree's — into
 * throwaway databases, dumps each normalized, and prints one line per stage per
 * variant: `IDENTICAL`, or the `table.column xN` values that differ. Exit code 1
 * on any difference.
 *
 * Why it can be exact: the seeding child runs with a **pinned clock** —
 * `Date.now()` and `new Date()` advance exactly 1ms per call from
 * 2026-01-01T00:00:00Z, and `Math.random` is seeded. Every stamp, including
 * Prisma's `@default(now())`/`@updatedAt`, is then a pure function of the
 * order of clock reads, so two factories that issue the same writes in the same
 * order dump byte-identically down to the millisecond. With a real clock those
 * defaults jitter between any two builds, old vs old included. Two pinned runs
 * of one factory are identical; that is the control.
 *
 * The normalized dump (`normdump.ts`) covers every public table except
 * `_prisma_migrations`, rows in PK order (uuidv7 = insertion order); every uuid
 * becomes `<id:N>` by first appearance, so a row-order change shows; the seeded
 * `User.clerkId` becomes `<clerkId>`; timestamps become ms offsets from
 * `max(Session.createdAt)`.
 *
 * Databases are named `mwf_fid_*` and dropped afterwards; the golden fixture
 * templates (`mwf_fx_*`) are never touched. The old factory is extracted with
 * `git archive <ref> backend/src/testing` into a temporary sibling directory
 * (`backend/src/.fidelity-old/`) so its `../lib/prisma` import resolves to the
 * working tree's client; it is removed on exit. This compares factories against
 * one schema — it is not a tool for comparing across a migration.
 *
 * Subcommands:
 *   run --old-ref <ref> [--out <dir>] [--keep]   seed old + new, compare, clean up
 *   seed <tag> [--factory <module>] [--no-b] [--out <dir>]
 *   compare <dirA> <dirB>
 */

import 'dotenv/config';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDatabase, databaseExists, dropDatabase, cloneDatabase, parseDbUrl, toDbUrl, DbTarget } from '../db';
import { normalizedDump } from './normdump';

const BACKEND = path.resolve(__dirname, '../../../..');
const REPO = path.resolve(BACKEND, '..');
const OLD_DIR = path.join(BACKEND, 'src', '.fidelity-old');
const EMPTY_DB = 'mwf_fid_empty';

const STAGES = [
  'CREATED',
  'INVITATION_READY',
  'EMPATHY_SHARED_A',
  'FEEL_HEARD_B',
  'RECONCILER_SHOWN_B',
  'CONTEXT_SHARED_B',
  'EMPATHY_REVEALED',
  'NEED_MAPPING_COMPLETE',
  'STRATEGIC_REPAIR_COMPLETE',
  'STAGE4_REDESIGN_INVENTORY',
  'STAGE4_REDESIGN_SHARED_SELECTIONS',
  'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS',
  'STAGE4_REDESIGN_PARTNER_INACTIVE',
];

/** Runs inside the seeding child: pin the clock before anything loads Prisma. */
const CHILD = `
  const RealDate = Date;
  let t = RealDate.UTC(2026, 0, 1);
  class PinnedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(t++); else super(...a); }
    static now() { return t++; }
  }
  globalThis.Date = PinnedDate;
  let seed = 1;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const { stateFactory, TargetStage } = require(process.env.FID_FACTORY);
  const { prisma } = require('./src/lib/prisma');
  (async () => {
    const userB = process.env.FID_NO_B ? undefined : { email: 'bob@e2e.test', name: 'Bob Ross' };
    await stateFactory.createSessionAtStage({
      userA: { email: 'ada@e2e.test', name: 'Ada Lovelace' },
      userB,
      targetStage: TargetStage[process.env.FID_STAGE],
    });
    await prisma.$disconnect();
    process.stdout.write('__SEEDED__');
  })().catch((e) => { console.error(e); process.exit(1); });
`;

function target(): DbTarget {
  const url = process.env.GOLDEN_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or GOLDEN_DATABASE_URL) first.');
  return parseDbUrl(url);
}

async function ensureEmptyTemplate(t: DbTarget): Promise<void> {
  if (await databaseExists(t, EMPTY_DB)) return;
  await createDatabase(t, EMPTY_DB);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: toDbUrl({ ...t, database: EMPTY_DB }) },
    stdio: 'pipe',
  });
}

/** Seed every stage with `factory` under the pinned clock; write `<out>/<STAGE>.norm`. */
async function seed(opts: { tag: string; factory: string; noB: boolean; out: string }): Promise<void> {
  const t = target();
  await ensureEmptyTemplate(t);
  fs.mkdirSync(opts.out, { recursive: true });
  for (const stage of STAGES) {
    const db = `mwf_fid_${opts.tag}_${stage}`.toLowerCase().slice(0, 63);
    await cloneDatabase(t, EMPTY_DB, db);
    try {
      const r = spawnSync('npx', ['tsx', '-e', CHILD], {
        cwd: BACKEND,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: toDbUrl({ ...t, database: db }),
          NODE_ENV: 'test',
          FID_FACTORY: opts.factory,
          FID_STAGE: stage,
          FID_NO_B: opts.noB ? '1' : '',
        },
      });
      if (r.status !== 0 || !r.stdout.includes('__SEEDED__')) {
        throw new Error(`Seeding ${stage} with ${opts.factory} failed:\n${r.stderr.slice(-2000)}`);
      }
      fs.writeFileSync(path.join(opts.out, `${stage}.norm`), await normalizedDump(t, db));
    } finally {
      await dropDatabase(t, db);
    }
  }
}

/** Line-aligned, field-level diff of two normalized dumps. */
export function diffDumps(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  if (la.length !== lb.length) return `LINE COUNT DIFFERS ${la.length} vs ${lb.length}`;
  let table = '';
  const out: Record<string, number> = {};
  for (let i = 0; i < la.length; i++) {
    if (la[i].startsWith('## ')) {
      if (la[i] !== lb[i]) return `TABLE/ROWCOUNT DIFFERS: ${la[i]} | ${lb[i]}`;
      table = la[i].slice(3).split(' ')[0];
      continue;
    }
    if (la[i] === lb[i]) continue;
    const x = JSON.parse(la[i]) as Record<string, unknown>;
    const y = JSON.parse(lb[i]) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out[`${table}.${k}`] = (out[`${table}.${k}`] ?? 0) + 1;
    }
  }
  const keys = Object.keys(out).sort();
  return keys.length ? keys.map(k => `${k} x${out[k]}`).join(', ') : 'IDENTICAL';
}

function compare(dirA: string, dirB: string, label: string): boolean {
  let same = true;
  for (const stage of STAGES) {
    const result = diffDumps(
      fs.readFileSync(path.join(dirA, `${stage}.norm`), 'utf8'),
      fs.readFileSync(path.join(dirB, `${stage}.norm`), 'utf8'),
    );
    if (result !== 'IDENTICAL') same = false;
    process.stdout.write(`${label.padEnd(10)} ${stage.padEnd(38)} ${result}\n`);
  }
  return same;
}

function extractOld(ref: string): string {
  fs.rmSync(OLD_DIR, { recursive: true, force: true });
  fs.mkdirSync(OLD_DIR, { recursive: true });
  const tar = execFileSync('git', ['archive', ref, 'backend/src/testing'], { cwd: REPO, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '--strip-components=3', '-C', OLD_DIR], { input: tar });
  return './src/.fidelity-old/state-factory';
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const out = flag(args, '--out') ?? path.join(os.tmpdir(), 'mwf-fidelity');
  const NEW = './src/testing/state-factory';

  if (cmd === 'run') {
    const ref = flag(args, '--old-ref');
    if (!ref) throw new Error('run needs --old-ref <git ref>');
    const t = target();
    let ok = true;
    try {
      const old = extractOld(ref);
      for (const noB of [false, true]) {
        const v = noB ? 'no-b' : 'with-b';
        await seed({ tag: `old_${noB ? 'n' : 'b'}`, factory: old, noB, out: path.join(out, `old-${v}`) });
        await seed({ tag: `new_${noB ? 'n' : 'b'}`, factory: NEW, noB, out: path.join(out, `new-${v}`) });
        ok = compare(path.join(out, `old-${v}`), path.join(out, `new-${v}`), v) && ok;
      }
    } finally {
      fs.rmSync(OLD_DIR, { recursive: true, force: true });
      if (!args.includes('--keep')) await dropDatabase(t, EMPTY_DB);
    }
    process.stdout.write(`\n${ok ? 'IDENTICAL' : 'DIFFERENT'} — dumps in ${out}\n`);
    if (!ok) process.exitCode = 1;
  } else if (cmd === 'seed') {
    const tag = args[0];
    if (!tag || tag.startsWith('--')) throw new Error('seed needs a <tag>');
    await seed({
      tag,
      factory: flag(args, '--factory') ?? NEW,
      noB: args.includes('--no-b'),
      out: path.join(out, tag),
    });
    process.stdout.write(`seeded ${STAGES.length} stages -> ${path.join(out, tag)}\n`);
  } else if (cmd === 'compare') {
    if (!compare(args[0], args[1], 'compare')) process.exitCode = 1;
  } else {
    process.stdout.write(
      'Commands: run --old-ref <ref> [--out dir] [--keep] | seed <tag> [--factory m] [--no-b] | compare <dirA> <dirB>\n',
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e: Error) => {
    process.stderr.write(`\nFAILED: ${e.message}\n`);
    process.exit(1);
  });
}
