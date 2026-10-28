/**
 * TS-13 fix round 1 (I3): no Prisma model-API query filters an encrypted
 * column by value.
 *
 * Encrypted columns hold random-IV ciphertext once FIELD_ENCRYPTION_KEY is set,
 * so `where: { content: x }`, `{ contains }`, `{ startsWith }`, `{ in }`, … can
 * never match — the query silently returns nothing (the R45 bug class:
 * memories.ts approveMemory, then confirmMemory). Null checks (`null`,
 * `{ not: null }`) stay valid.
 *
 * This parses every non-test source file with the TypeScript compiler and
 * checks:
 *   - the `where` object literal of every delegate call
 *     (`<client>.<model>.<findMany|findFirst|count|updateMany|…>({ where })`),
 *   - object literals declared as `Prisma.<Model>WhereInput`, and property
 *     assignments to such a variable (`where.OR = […]`),
 * following AND / OR / NOT and relation filters (`some` / `every` / `none` /
 * `is` / `isNot`) into the related model, with the relations of the generated
 * client's runtime data model. A `where` that is not a literal (a variable of
 * another type) is not resolved.
 *
 * ALLOWED lists the sites that filter an encrypted column on purpose, each with
 * why; anything else fails.
 */

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { PrismaClient } from '../../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma-pg';
import { SENSITIVE_FIELD_MAP, relationIndexOf } from '../prisma-encryption-middleware';

const SRC = path.resolve(__dirname, '../..');

const dataModel = (
  new PrismaClient({ adapter: createPrismaPgAdapter('postgresql://nobody@127.0.0.1:1/none') }) as unknown as {
    _runtimeDataModel: { models: Record<string, { fields: Array<{ name: string; kind: string; type: string }> }> };
  }
)._runtimeDataModel;
const relations = relationIndexOf(dataModel);
const MODEL_OF_DELEGATE = new Map(Object.keys(dataModel.models).map(m => [m[0].toLowerCase() + m.slice(1), m]));
const OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Filters on an encrypted column that are deliberate: `file: model.field` → why. */
const ALLOWED: Record<string, string> = {
  'routes/brain.ts: Reflection.title':
    'the ops dashboard title search arm, applied only while no key is set (titleSearch, ruling R45)',
  'scripts/mwf-moment-real.ts: Session.topicFrame': 'dev script, keyless databases only (documented, R45)',
  'scripts/analyze-session.ts: Message.content': 'dev script, keyless databases only (documented, R45)',
  'fix-empty-messages.ts: Message.content': 'dev script, keyless databases only (documented, R45)',
};

interface Hit {
  site: string;
  line: number;
  filter: string;
}

const encrypted = (model: string, field: string) => Boolean(SENSITIVE_FIELD_MAP[model]?.fields[field]);

const propName = (p: ts.ObjectLiteralElementLike): string | null =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
  (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
    ? p.name.text
    : null;

/** Is this value a pure null check (`null`, `{ not: null }`)? */
function nullCheck(v: ts.Expression): boolean {
  if (v.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isObjectLiteralExpression(v) && v.properties.length === 1) {
    const p = v.properties[0];
    return ts.isPropertyAssignment(p) && propName(p) === 'not' && p.initializer.kind === ts.SyntaxKind.NullKeyword;
  }
  return false;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** Every object literal a where-valued expression can produce (arrays, spreads, conditionals). */
function objectsOf(e: ts.Expression): ts.ObjectLiteralExpression[] {
  e = unwrap(e);
  if (ts.isObjectLiteralExpression(e)) return [e];
  if (ts.isArrayLiteralExpression(e))
    return e.elements.flatMap(x => objectsOf(ts.isSpreadElement(x) ? x.expression : x));
  if (ts.isConditionalExpression(e)) return [...objectsOf(e.whenTrue), ...objectsOf(e.whenFalse)];
  return [];
}

function checkWhere(obj: ts.ObjectLiteralExpression, model: string, report: (field: string, n: ts.Node) => void): void {
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      for (const o of objectsOf(p.expression)) checkWhere(o, model, report);
      continue;
    }
    const name = propName(p);
    if (!name) continue;
    const value = ts.isPropertyAssignment(p) ? p.initializer : (p as ts.ShorthandPropertyAssignment).name;
    if (name === 'AND' || name === 'OR' || name === 'NOT') {
      for (const o of objectsOf(value)) checkWhere(o, model, report);
    } else if (encrypted(model, name)) {
      if (!nullCheck(unwrap(value))) report(`${model}.${name}`, p);
    } else if (relations[model]?.[name]) {
      const target = relations[model][name];
      for (const o of objectsOf(value)) {
        const nested = o.properties.filter(q => ['some', 'every', 'none', 'is', 'isNot'].includes(propName(q) ?? ''));
        if (nested.length) {
          for (const q of nested)
            if (ts.isPropertyAssignment(q)) for (const n of objectsOf(q.initializer)) checkWhere(n, target, report);
        } else checkWhere(o, target, report);
      }
    }
  }
}

/** `Prisma.<Model>WhereInput` → model. */
function whereInputModel(t: ts.TypeNode | undefined): string | null {
  if (!t || !ts.isTypeReferenceNode(t)) return null;
  const n = t.typeName.getText();
  const m = /^(?:Prisma\.)?([A-Z]\w*)WhereInput$/.exec(n);
  return m && dataModel.models[m[1]] ? m[1] : null;
}

function scanFile(file: string, src: string): Hit[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2020, true);
  const hits: Hit[] = [];
  const typed = new Map<string, string>(); // variable → model of its WhereInput type
  const report = (field: string, n: ts.Node) =>
    hits.push({
      site: `${file}: ${field}`,
      line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
      filter: n.getText().slice(0, 120),
    });
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && OPS.has(n.expression.name.text)) {
      const delegate = n.expression.expression;
      const model = ts.isPropertyAccessExpression(delegate) ? MODEL_OF_DELEGATE.get(delegate.name.text) : undefined;
      const arg = n.arguments[0] && unwrap(n.arguments[0]);
      if (model && arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (propName(p) === 'where' && ts.isPropertyAssignment(p))
            for (const o of objectsOf(p.initializer)) checkWhere(o, model, report);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const model = whereInputModel(n.type);
      if (model) {
        typed.set(n.name.text, model);
        if (n.initializer) for (const o of objectsOf(n.initializer)) checkWhere(o, model, report);
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      typed.has(n.left.expression.text)
    ) {
      const model = typed.get(n.left.expression.text)!;
      const key = n.left.name.text;
      // treat `where.key = value` as `{ key: value }`
      const synthetic = ts.factory.createObjectLiteralExpression([ts.factory.createPropertyAssignment(key, n.right)]);
      checkWhere(synthetic, model, (field, _node) =>
        hits.push({
          site: `${file}: ${field}`,
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          filter: n.getText().slice(0, 120),
        }),
      );
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

function scanTree(): Hit[] {
  const out: Hit[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', '__mocks__', 'generated'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
        out.push(...scanFile(path.relative(SRC, p), fs.readFileSync(p, 'utf8')));
      }
    }
  };
  walk(SRC);
  return out;
}

describe('no Prisma model-API query filters an encrypted column by value', () => {
  const hits = scanTree();

  it('every value filter on an encrypted column is an allowed, documented site', () => {
    expect(hits.filter(h => !ALLOWED[h.site])).toEqual([]);
  });

  it('every allowed site still exists (the list does not rot)', () => {
    const found = new Set(hits.map(h => h.site));
    expect(Object.keys(ALLOWED).filter(s => !found.has(s))).toEqual([]);
  });

  describe('the guard itself', () => {
    const scan = (code: string) => scanFile('x.ts', code).map(h => h.site);

    it('flags equality, contains and startsWith through a delegate, AND/OR, a relation and a WhereInput variable', () => {
      expect(scan(`prisma.userMemory.findFirst({ where: { userId, content: text } })`)).toEqual([
        'x.ts: UserMemory.content',
      ]);
      expect(scan(`tx.need.findMany({ where: { OR: [{ label: { contains: q } }] } })`)).toEqual(['x.ts: Need.label']);
      expect(
        scan(`db().conversation.findMany({ where: { messages: { some: { content: { startsWith: 'x' } } } } })`),
      ).toEqual(['x.ts: Message.content']);
      expect(scan(`const w: Prisma.ReflectionWhereInput = {}; w.OR = [{ title: { contains: s } }];`)).toEqual([
        'x.ts: Reflection.title',
      ]);
    });

    it('passes null checks and unencrypted fields', () => {
      expect(scan(`prisma.session.findMany({ where: { topicFrame: { not: null }, status: 'ACTIVE' } })`)).toEqual([]);
      expect(scan(`prisma.contextShareOffer.findFirst({ where: { sharedContent: null, resultId } })`)).toEqual([]);
      expect(scan(`prisma.userMemory.findMany({ where: { userId, sessionId: null, status: 'ACTIVE' } })`)).toEqual([]);
    });
  });
});
