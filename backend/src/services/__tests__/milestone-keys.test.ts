/**
 * shared's MILESTONE_KEYS is the one definition of the milestone key type
 * (work-keq6). It must equal the `milestone` reference table's seed in the
 * target baseline migration, in ordinal order.
 *
 * work-k5fk.6: the seed is written in tables.sql, straight after the milestone
 * table (not generated into a section of its own), one commented row per
 * milestone, and its self_assertable rows are the keys milestone-writer lets a
 * participant record (SELF_ASSERTABLE_MILESTONES).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { MILESTONE_KEYS } from '@meet-without-fear/shared';
import { SELF_ASSERTABLE_MILESTONES } from '../milestone-writer';

const BACKEND = join(__dirname, '../../..');
const MIGRATION = readFileSync(
  join(BACKEND, 'prisma/migrations/20261026120000_target_shape_baseline/migration.sql'),
  'utf8',
);
const TABLES = readFileSync(join(BACKEND, 'scripts/target-shape/tables.sql'), 'utf8');

/** The text of the first `INSERT INTO milestone (…) VALUES …;` in `sql`. */
function seedText(sql: string): string {
  const seed = sql.slice(sql.indexOf('INSERT INTO milestone ('));
  return seed.slice(0, seed.indexOf(';') + 1);
}

/** The rows of that INSERT. */
function seedRows(sql: string) {
  return [
    ...seedText(sql).matchAll(/\('([a-z_]+)', (\d+), '([^']*)', '(participant|session)', (true|false)\)/g),
  ].map(r => ({ key: r[1], ordinal: Number(r[2]), selfAssertable: r[5] === 'true' }));
}

describe('MILESTONE_KEYS', () => {
  it('equals the milestone seed of the target baseline migration, by ordinal', () => {
    const rows = seedRows(MIGRATION);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.sort((a, b) => a.ordinal - b.ordinal).map(r => r.key)).toEqual([...MILESTONE_KEYS]);
  });
});

describe('the milestone seed (work-k5fk.6)', () => {
  it('is in tables.sql between the milestone table and participant_milestone', () => {
    const table = TABLES.indexOf('CREATE TABLE milestone (');
    const seed = TABLES.indexOf('INSERT INTO milestone (');
    const next = TABLES.indexOf('CREATE TABLE participant_milestone (');
    expect(table).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(table);
    expect(next).toBeGreaterThan(seed);
  });

  it('is the migration’s only milestone INSERT, and has every MILESTONE_KEYS row', () => {
    expect(MIGRATION.split('INSERT INTO milestone (').length - 1).toBe(1);
    expect(
      seedRows(TABLES)
        .map(r => r.key)
        .sort(),
    ).toEqual([...MILESTONE_KEYS].sort());
  });

  it('carries a comment on every row', () => {
    const from = TABLES.indexOf('INSERT INTO milestone (');
    const lines = TABLES.slice(from, TABLES.indexOf('\n', from + seedText(TABLES).length))
      .split('\n')
      .filter(l => /^\s*\('/.test(l));
    expect(lines).toHaveLength(MILESTONE_KEYS.length);
    for (const l of lines) expect(l).toMatch(/--\s*\S/);
  });

  it('marks exactly the keys a participant may record themselves as self_assertable', () => {
    const own = seedRows(TABLES)
      .filter(r => r.selfAssertable)
      .map(r => r.key)
      .sort();
    expect(own).toEqual([...SELF_ASSERTABLE_MILESTONES].sort());
  });

  it('types milestone.key and participant_milestone.milestone_key as the milestone_key domain', () => {
    expect(TABLES).toMatch(/CREATE DOMAIN milestone_key AS text/);
    expect(TABLES).toMatch(/CREATE TABLE milestone \(\n {4}key milestone_key NOT NULL PRIMARY KEY,/);
    expect(TABLES).toMatch(/\n {4}milestone_key milestone_key NOT NULL REFERENCES milestone ON DELETE RESTRICT,/);
  });
});
