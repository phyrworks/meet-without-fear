/**
 * TS-13 fix round 2 (ruling R47): `proposal_revision.reason` holds only the app
 * markers of services/proposal-revision-reasons.ts — never user- or
 * model-derived text, which belongs in the encrypted `after`/`before` envelope.
 *
 * Every writer in src/ (not tests, not the fixture writers in src/testing) is
 * checked from source:
 *   - a Prisma `proposalRevision.create/createMany/upsert/update` whose data sets
 *     `reason` must set it to `null` or `PROPOSAL_REVISION_REASONS.<KEY>` (or a
 *     const aliasing one: LEGACY_PROPOSED / LEGACY_CONFIRMED in controllers/stage4.ts);
 *   - a raw `INSERT INTO proposal_revision` must bind the reason through
 *     `proposalRevisionReason(…)`, which throws on anything outside the set.
 */

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { PROPOSAL_REVISION_REASONS, proposalRevisionReason } from '../../services/proposal-revision-reasons';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['__tests__', '__mocks__', 'generated', 'testing'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        out.push({ rel: path.relative(SRC, p), text: fs.readFileSync(p, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

/** Names bound to a marker: `const X = PROPOSAL_REVISION_REASONS.KEY`. */
function markerAliases(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      /^PROPOSAL_REVISION_REASONS\.[A-Z_]+$/.test(n.initializer.getText())
    )
      names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

const isMarker = (e: ts.Expression, aliases: Set<string>): boolean =>
  e.kind === ts.SyntaxKind.NullKeyword ||
  /^PROPOSAL_REVISION_REASONS\.[A-Z_]+$/.test(e.getText()) ||
  (ts.isIdentifier(e) && aliases.has(e.text));

interface Finding {
  where: string;
  reason: string;
}

function modelWriters(file: string, text: string): { count: number; bad: Finding[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
  const aliases = markerAliases(sf);
  const bad: Finding[] = [];
  let count = 0;
  const datas = (arg: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression[] =>
    arg.properties.flatMap(p => {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) return [];
      if (!['data', 'create', 'update'].includes(p.name.text)) return [];
      const v = p.initializer;
      if (ts.isObjectLiteralExpression(v)) return [v];
      if (ts.isArrayLiteralExpression(v)) return v.elements.filter(ts.isObjectLiteralExpression);
      return [];
    });
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ['create', 'createMany', 'upsert', 'update', 'updateMany'].includes(n.expression.name.text) &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === 'proposalRevision'
    ) {
      count++;
      const arg = n.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const d of datas(arg)) {
          for (const p of d.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'reason' && !isMarker(p.initializer, aliases))
              bad.push({ where: `${file}:${sf.getLineAndCharacterOfPosition(p.getStart()).line + 1}`, reason: p.initializer.getText() });
            if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'reason')
              bad.push({ where: `${file}:${sf.getLineAndCharacterOfPosition(p.getStart()).line + 1}`, reason: 'reason (shorthand)' });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { count, bad };
}

/** The `reason` bind of every raw INSERT INTO proposal_revision: the expression in the VALUES position of `reason`. */
function rawWriters(file: string, text: string): { count: number; bad: Finding[] } {
  const bad: Finding[] = [];
  let count = 0;
  const re = /INSERT INTO proposal_revision\s*\(([^)]*)\)\s*VALUES\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    count++;
    const cols = m[1].split(',').map(c => c.trim());
    const k = cols.indexOf('reason');
    if (k < 0) continue;
    // split the VALUES tuple on top-level commas, respecting ${…} and parentheses
    let i = m.index + m[0].length;
    let depth = 0;
    let cur = '';
    const vals: string[] = [];
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '{') depth++;
      if (c === '}') depth--;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (c === ',' && depth === 0) {
        vals.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    vals.push(cur.trim());
    const v = vals[k] ?? '';
    if (!/^\$\{proposalRevisionReason\(/.test(v))
      bad.push({ where: `${file}:${text.slice(0, m.index).split('\n').length}`, reason: v });
  }
  return { count, bad };
}

describe('proposal_revision.reason holds only app markers (R47)', () => {
  const files = sourceFiles();

  it('every Prisma writer sets reason to null or a PROPOSAL_REVISION_REASONS member', () => {
    const results = files.map(f => modelWriters(f.rel, f.text));
    expect(results.reduce((n, r) => n + r.count, 0)).toBeGreaterThanOrEqual(4);
    expect(results.flatMap(r => r.bad)).toEqual([]);
  });

  it('every raw writer binds the reason through proposalRevisionReason()', () => {
    const results = files.map(f => rawWriters(f.rel, f.text));
    expect(results.reduce((n, r) => n + r.count, 0)).toBeGreaterThanOrEqual(1);
    expect(results.flatMap(r => r.bad)).toEqual([]);
  });

  it('proposalRevisionReason accepts the markers and null, and refuses free text', () => {
    for (const v of Object.values(PROPOSAL_REVISION_REASONS)) expect(proposalRevisionReason(v)).toBe(v);
    expect(proposalRevisionReason(null)).toBeNull();
    expect(() => proposalRevisionReason('please drop the spreadsheet idea')).toThrow(/not an app marker/);
  });

  it('the checker flags free text (self-test)', () => {
    const bad = modelWriters(
      'x.ts',
      `prisma.proposalRevision.create({ data: { proposalId, action: 'REMOVED', reason: operation.reason } });`,
    ).bad;
    expect(bad).toEqual([{ where: 'x.ts:1', reason: 'operation.reason' }]);
    expect(
      rawWriters('y.ts', 'INSERT INTO proposal_revision (proposal_id, reason) VALUES (${id}::uuid, ${args.reason})').bad,
    ).toHaveLength(1);
  });
});
