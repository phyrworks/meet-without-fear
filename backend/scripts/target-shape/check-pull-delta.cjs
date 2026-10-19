#!/usr/bin/env node
// Check that a `db pull` of a database WITH the sql_ indexes differs from a
// reference schema (schema.prisma, or a pull taken before the sql_ indexes)
// only by the sql_ objects and the effects Prisma 7.10 derives from them.
// Both inputs must already be normalised by normalize-schema.cjs.
//
// Usage: node check-pull-delta.cjs <reference.normalised> <pulled.normalised>
// Prints every unexplained line and exits 1 if there is any.
//
// A removed (reference-only) line is explained when the pulled side has:
//   - the same line plus `@unique(map: "sql_…", where: raw("…"))`; or
//   - the same back-relation field with `[]` flipped to `?` (Prisma infers 1:1
//     from a single-column partial unique); or
//   - the generator's previewFeatures with "partialIndexes" added.
// An added (pull-only) line is explained when it names an sql_ index, or is
// the counterpart of an explained removed line. Nothing else may differ.
'use strict';
const fs = require('fs');

const ref = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const pull = fs.readFileSync(process.argv[3], 'utf8').split('\n');

// Multiset difference, keyed by the enclosing block so equal lines in
// different models do not cancel each other out.
function keyed(lines) {
  const m = new Map();
  let block = '';
  for (const l of lines) {
    if (!l.startsWith('  ')) block = l;
    const k = `${block}\u0000${l}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
const R = keyed(ref);
const P = keyed(pull);
const minus = [];
const plus = [];
for (const [k, n] of R) for (let i = (P.get(k) || 0); i < n; i++) minus.push(k);
for (const [k, n] of P) for (let i = (R.get(k) || 0); i < n; i++) plus.push(k);

const SQL_UNIQUE_ATTR = / @unique\(map: "sql_[a-z0-9_]+", where: raw\("(?:[^"\\]|\\.)*"\)\)/;
const plusSet = new Set(plus);
const usedPlus = new Set();
const unexplained = [];

for (const k of minus) {
  const [block, line] = k.split('\u0000');
  const candidates = [];
  // back-relation []→?
  const rel = line.match(/^( {2}[A-Za-z0-9_]+ [A-Z][A-Za-z0-9_]*)\[\]((?: @relation\("[^"]+"\))?)$/);
  if (rel) candidates.push(`${block}\u0000${rel[1]}?${rel[2]}`);
  // previewFeatures gains partialIndexes
  const pf = line.match(/^( {2}previewFeatures = \[)(.*)\]$/);
  if (pf) candidates.push(`${block}\u0000${pf[1]}${pf[2]}, "partialIndexes"]`);
  let hit = candidates.find((c) => plusSet.has(c) && !usedPlus.has(c));
  if (!hit) {
    // same line plus an sql_ partial-unique attribute
    hit = plus.find((p) => !usedPlus.has(p) && p.split('\u0000')[0] === block &&
      p.split('\u0000')[1].replace(SQL_UNIQUE_ATTR, '') === line);
  }
  if (hit) usedPlus.add(hit);
  else unexplained.push(`- [${block}] ${line.trim()}`);
}
for (const k of plus) {
  if (usedPlus.has(k)) continue;
  const [block, line] = k.split('\u0000');
  if (/"sql_[a-z0-9_]+"/.test(line)) continue;
  unexplained.push(`+ [${block}] ${line.trim()}`);
}

if (unexplained.length) {
  process.stdout.write(unexplained.join('\n') + '\n');
  process.exit(1);
}
