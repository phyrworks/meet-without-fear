/**
 * shared's MILESTONE_KEYS is the one definition of the milestone key type
 * (work-keq6). It must equal the `milestone` reference table's seed in the
 * target baseline migration, in ordinal order.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { MILESTONE_KEYS } from '@meet-without-fear/shared';

describe('MILESTONE_KEYS', () => {
  it('equals the milestone seed of the target baseline migration, by ordinal', () => {
    const sql = readFileSync(
      join(__dirname, '../../../prisma/migrations/20261026120000_target_shape_baseline/migration.sql'),
      'utf8',
    );
    const seed = sql.slice(sql.indexOf('INSERT INTO milestone ('));
    const rows = [...seed.slice(0, seed.indexOf(';')).matchAll(/\('([a-z_]+)', (\d+),/g)].map(r => ({
      key: r[1],
      ordinal: Number(r[2]),
    }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.sort((a, b) => a.ordinal - b.ordinal).map(r => r.key)).toEqual([...MILESTONE_KEYS]);
  });
});
