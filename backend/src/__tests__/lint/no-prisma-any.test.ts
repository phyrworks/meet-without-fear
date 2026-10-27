/**
 * TS-12: the `no-prisma-any` ESLint rule (backend/eslint-rules/no-prisma-any.js),
 * run through ESLint's own RuleTester with the TypeScript parser `npm run lint` uses.
 */

import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../../eslint-rules/no-prisma-any.js');

const tester = new RuleTester({
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
} as never);

// RuleTester declares its own describe/it blocks (one test per case).
describe('no-prisma-any: accepts typed client use, other casts, and a DbClient parameter', () => {
  {
    tester.run('no-prisma-any', rule, {
      valid: [
        'const r = await prisma.reflection.findMany({ where: { userId } });',
        'const x = (value as any).foo;',
        'const n = count as unknown as number;',
        'function f(client: DbClient) { return client.takeaway.findMany(); }',
        'const c = withEncryption(base) as PrismaClient;',
        'await prisma.$transaction(async (tx) => markAttemptDelivery(id, "DELIVERED", at, tx));',
      ],
      invalid: [],
    });
  }
});

describe('no-prisma-any: rejects the alias, every any-cast rooted at a client, and the forged client type', () => {
  {
    tester.run('no-prisma-any', rule, {
      valid: [],
      invalid: [
        { code: 'const prismaAny = prisma as any;', errors: [{ messageId: 'alias' }, { messageId: 'anyCast' }] },
        { code: 'await prismaAny.takeawayLink.findMany();', errors: [{ messageId: 'alias' }] },
        { code: 'await (prisma as any).innerWorkSession.findFirst();', errors: [{ messageId: 'anyCast' }] },
        { code: 'await (prisma.innerWorkSession.findMany as any)({});', errors: [{ messageId: 'anyCast' }] },
        { code: 'await (prisma.recurringTheme as any).upsert({});', errors: [{ messageId: 'anyCast' }] },
        { code: 'await (getJobPrisma().brainActivity as any).create({});', errors: [{ messageId: 'anyCast' }] },
        { code: 'await (tx as any).message.create({});', errors: [{ messageId: 'anyCast' }] },
        { code: 'const c = tx as unknown as PrismaClient;', errors: [{ messageId: 'forged' }] },
        { code: 'const c = x as unknown as Prisma.TransactionClient;', errors: [{ messageId: 'forged' }] },
      ],
    });
  }
});
