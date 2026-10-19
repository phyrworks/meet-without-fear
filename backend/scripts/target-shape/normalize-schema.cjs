#!/usr/bin/env node
// Normalise a Prisma schema for the TS-6 db-pull comparison (check-schema.sh).
//
// Usage: node normalize-schema.cjs <schema.prisma>   → normalised text on stdout
//
// Ignored, because none of it changes the database or the generated client's
// semantics:
//   - comment lines (`//`, `///`) and blank lines;
//   - runs of whitespace OUTSIDE string literals (column alignment). Whitespace
//     inside strings — e.g. a dbgenerated() expression — is kept byte for byte;
//   - the order of top-level blocks, and of the keys inside the generator and
//     datasource blocks (`db pull` rewrites the generator's key order). Enum
//     member order is kept — it is the Postgres enum's order;
//   - the order of relation fields and of block attributes (`@@…`) inside a
//     block. Scalar fields keep their order: it is the column order;
//   - an explicit onDelete that equals Prisma's default for the relation
//     (`Restrict` on a required relation, `SetNull` on an optional one).
//     schema.prisma states every onDelete explicitly (spec §5); `db pull` omits
//     the defaulted ones. Step (b), the empty migrate diff, independently proves
//     the FK actions in the database match.
// Everything else — types, native types, defaults, maps, uniques, indexes,
// relation names, fields/references, non-default referential actions — is
// compared exactly.
'use strict';
const fs = require('fs');

function collapseOutsideStrings(line) {
  let out = '';
  let inStr = false;
  let prevSpace = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += line[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; prevSpace = false; out += c; continue; }
    if (c === ' ' || c === '\t') {
      if (!prevSpace) out += ' ';
      prevSpace = true;
      continue;
    }
    prevSpace = false;
    out += c;
  }
  return out.trim();
}

const src = fs.readFileSync(process.argv[2], 'utf8');
const blocks = [];
let current = null;
for (const raw of src.split('\n')) {
  const line = collapseOutsideStrings(raw);
  if (line === '' || line.startsWith('//')) continue;
  if (current === null) {
    if (!line.endsWith('{')) throw new Error(`unexpected top-level line: ${line}`);
    current = { header: line, kind: line.split(' ')[0], body: [] };
    continue;
  }
  if (line === '}') { blocks.push(current); current = null; continue; }
  current.body.push(line);
}
if (current !== null) throw new Error(`unterminated block: ${current.header}`);

const models = new Set(blocks.filter((b) => b.kind === 'model').map((b) => b.header.split(' ')[1]));

function canonicalRelation(line) {
  const [, type] = line.split(' ');
  if (!line.includes('@relation(') || !line.includes('fields:')) return line;
  const optional = type.endsWith('?');
  const dflt = optional ? 'SetNull' : 'Restrict';
  return line.replace(`, onDelete: ${dflt}`, '');
}

for (const b of blocks) {
  if (b.kind === 'generator' || b.kind === 'datasource') { b.body.sort(); continue; }
  if (b.kind !== 'model') continue;
  const scalars = [];
  const relations = [];
  const attrs = [];
  for (const l of b.body) {
    if (l.startsWith('@@')) { attrs.push(l); continue; }
    const base = (l.split(' ')[1] || '').replace(/[?]|\[\]/g, '');
    if (models.has(base)) relations.push(canonicalRelation(l));
    else scalars.push(l);
  }
  relations.sort();
  attrs.sort();
  b.body = [...scalars, ...relations, ...attrs];
}

blocks.sort((a, b) => (a.header < b.header ? -1 : a.header > b.header ? 1 : 0));
process.stdout.write(
  blocks.map((b) => [b.header, ...b.body.map((l) => '  ' + l), '}'].join('\n')).join('\n\n') + '\n',
);
