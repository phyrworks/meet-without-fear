/**
 * ESLint rule `no-prisma-any` (TS-12; plan §5 Reflection, review F4.3).
 *
 * The Prisma client is the typed boundary to the database: a cast that throws
 * its type away lets code query models and columns that do not exist (the 21
 * `prismaAny` / `(prisma as any)` casts that hid the reflection cluster's
 * stale model names until the target schema landed). This rule fails on:
 *
 *   - any identifier named `prismaAny` (the alias pattern);
 *   - `prisma as any`, and an `as any` cast of anything reached from `prisma`
 *     (`prisma.foo as any`, `(prisma.foo.findMany as any)(…)`), also through the
 *     job client (`getJobPrisma()`, `jobPrisma`) and a transaction client `tx`;
 *   - `as unknown as PrismaClient` (and `as unknown as Prisma.TransactionClient`):
 *     the double cast that forges a client type.
 *
 * Wired in through `--rulesdir eslint-rules` in `npm run lint`.
 */

'use strict';

const CLIENT_NAMES = new Set(['prisma', 'jobPrisma', 'opsPrisma', 'tx']);

/** Does this expression start at a Prisma client (identifier or getJobPrisma() call)? */
function rootedAtClient(node) {
  let n = node;
  for (;;) {
    if (!n) return false;
    switch (n.type) {
      case 'Identifier':
        return CLIENT_NAMES.has(n.name);
      case 'MemberExpression':
        n = n.object;
        break;
      case 'CallExpression':
        if (n.callee.type === 'Identifier' && /^get(Job|Ops)Prisma$/.test(n.callee.name)) return true;
        n = n.callee;
        break;
      case 'TSNonNullExpression':
      case 'ChainExpression':
        n = n.expression;
        break;
      default:
        return false;
    }
  }
}

function isClientTypeName(typeNode) {
  if (!typeNode || typeNode.type !== 'TSTypeReference') return false;
  const name = typeNode.typeName;
  if (name.type === 'Identifier') return name.name === 'PrismaClient' || name.name === 'DbClient';
  if (name.type === 'TSQualifiedName') return name.right.name === 'TransactionClient' || name.right.name === 'PrismaClient';
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'disallow casting the Prisma client (or anything reached from it) to any, and forging a client type' },
    schema: [],
    messages: {
      alias: '`prismaAny` hides the Prisma client’s types; use the typed client.',
      anyCast: 'Do not cast the Prisma client (or a delegate reached from it) to `any`; use the generated types.',
      forged: '`as unknown as {{type}}` forges a client type; type the parameter as `DbClient` instead.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === 'prismaAny') context.report({ node, messageId: 'alias' });
      },
      TSAsExpression(node) {
        if (node.typeAnnotation.type === 'TSAnyKeyword' && rootedAtClient(node.expression)) {
          context.report({ node, messageId: 'anyCast' });
          return;
        }
        if (
          isClientTypeName(node.typeAnnotation) &&
          node.expression.type === 'TSAsExpression' &&
          node.expression.typeAnnotation.type === 'TSUnknownKeyword'
        ) {
          context.report({ node, messageId: 'forged', data: { type: context.getSourceCode().getText(node.typeAnnotation) } });
        }
      },
    };
  },
};
