/**
 * Seed every TargetStage, with and without a partner account, into ONE
 * database at the CURRENT (pre-target) shape, through the current-shape state
 * factory of a phoenix/base checkout.
 *
 * Driven by run-target-migration.sh; not meant to be run by hand:
 *
 *   BASE_BACKEND=<checkout of phoenix/base>/backend DATABASE_URL=<ts7_* db> \
 *     npx tsx backend/scripts/target-shape/seed-current-shape.ts
 *
 * The factory and its Prisma client are loaded from BASE_BACKEND (the target
 * branch's client describes the target tables, which this database does not
 * have yet). Every seed gets its own two users (`a.<stage>.<variant>@e2e.test`,
 * `b.<stage>@e2e.test`) and its own relationship, so the 26 sessions are
 * independent and A-Q3 (one live session per relationship) holds by
 * construction. Prints one JSON line per seed: stage, variant, session id,
 * user ids.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const base = process.env.BASE_BACKEND;
if (!base) throw new Error('BASE_BACKEND is not set');
const db = process.env.DATABASE_URL ?? '';
if (!/\/ts7_[a-z0-9_]+(\?.*)?$/.test(db)) throw new Error(`refusing DATABASE_URL outside ts7_*: ${db}`);

const { stateFactory, TargetStage } = require(`${base}/src/testing/state-factory`);
const { prisma } = require(`${base}/src/lib/prisma`);

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

async function main(): Promise<void> {
  for (const variant of ['b', 'nob'] as const) {
    for (const stage of STAGES) {
      const tag = stage.toLowerCase().replace(/_/g, '-');
      const r = await stateFactory.createSessionAtStage({
        userA: { email: `a.${tag}.${variant}@e2e.test`, name: 'Ada Lovelace' },
        userB: variant === 'b' ? { email: `b.${tag}@e2e.test`, name: 'Bob Ross' } : undefined,
        targetStage: TargetStage[stage],
      });
      process.stdout.write(
        JSON.stringify({ stage, variant, sessionId: r.session.id, userA: r.userA.id, userB: r.userB?.id ?? null }) + '\n',
      );
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
