/**
 * The `old_concept_*` views: the declaration of both concept SQL files and the
 * column sets the target-shape views must share with the recorded baselines.
 *
 * TS-13 (ruling R42): the FEEL_HEARD_B describe that pinned the current-shape
 * views (`concept-views/current-shape.sql`) against a current-shape clone was
 * removed with the current-shape writer; phoenix/base keeps it. The recorded
 * baselines stay the oracle (R39), and `current-shape.sql` is still read below
 * (the target file keeps only checks the current file has).
 *
 * Requires a running local Postgres and a built target fixture.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CONCEPT_NAMES,
  CONCEPT_VIEWS,
  CURRENT_SHAPE_SQL,
  TARGET_SHAPE_SQL,
  applyConceptViews,
  viewName,
  viewsDefinedIn,
} from '../concept-views';
import { withClient } from '../db';
import { restoreFixture, RestoredFixture } from '../fixtures';
import { isTargetShape } from '../shape';

const BASE_URL =
  process.env.GOLDEN_DATABASE_URL || 'postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear';

jest.setTimeout(120_000);

describe('concept views — declaration', () => {
  it('current-shape.sql creates exactly the declared concept views (plus concept_check_* views)', () => {
    const defined = viewsDefinedIn(fs.readFileSync(CURRENT_SHAPE_SQL, 'utf8'));
    expect(defined.filter(v => !v.startsWith('concept_check_'))).toEqual(CONCEPT_NAMES.map(viewName).sort());
  });

  it('target-shape.sql creates exactly the same concept views (TS-9)', () => {
    const defined = viewsDefinedIn(fs.readFileSync(TARGET_SHAPE_SQL, 'utf8'));
    expect(defined.filter(v => !v.startsWith('concept_check_'))).toEqual(CONCEPT_NAMES.map(viewName).sort());
    // Every check it keeps is one current-shape.sql has too.
    const currentChecks = viewsDefinedIn(fs.readFileSync(CURRENT_SHAPE_SQL, 'utf8')).filter(v =>
      v.startsWith('concept_check_'),
    );
    for (const v of defined.filter(x => x.startsWith('concept_check_'))) expect(currentChecks).toContain(v);
  });
});

/**
 * TS-9: the column-set contract between the two files, checked on the target.
 * The column set of each current-shape view is read from what the recorded
 * normalised baselines hold (every row of `initial` and every changed row is
 * a full view row); the target view must have exactly those columns.
 */
(isTargetShape() ? describe : describe.skip)('concept views — target-shape.sql column sets (target)', () => {
  let fx: RestoredFixture;

  beforeAll(async () => {
    fx = await restoreFixture({ baseUrl: BASE_URL, stage: 'FEEL_HEARD_B', runId: `concept_cols_${process.pid}` });
    await applyConceptViews(fx.target, fx.database);
  });
  afterAll(async () => {
    if (fx) await fx.drop();
  });

  it('every view has the column set the current-shape baselines recorded', async () => {
    const recorded = new Map<string, Set<string>>();
    const dir = path.join(__dirname, '..', '__golden__');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.concept.json'))) {
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        initial: Record<string, Record<string, Record<string, unknown>>>;
        steps: Array<{
          changes?: Array<{ view: string; before?: Record<string, unknown>; after?: Record<string, unknown> }>;
        }>;
      };
      const add = (concept: string, row: Record<string, unknown> | undefined) => {
        if (!row) return;
        const cols = Object.keys(row).sort().join(',');
        const seen = recorded.get(concept) ?? new Set<string>();
        seen.add(cols);
        recorded.set(concept, seen);
      };
      for (const [concept, rows] of Object.entries(g.initial)) for (const r of Object.values(rows)) add(concept, r);
      for (const st of g.steps) for (const c of st.changes ?? []) add(c.view, c.after ?? c.before);
    }
    const cols = await withClient(
      fx.target,
      async c =>
        (
          await c.query<{ table_name: string; cols: string }>(
            `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'old_concept_%'
             GROUP BY table_name`,
          )
        ).rows,
      fx.database,
    );
    const target = new Map(cols.map(r => [r.table_name.replace(/^old_concept_/, ''), r.cols]));
    expect([...target.keys()].sort()).toEqual(Object.keys(CONCEPT_VIEWS).sort());
    let compared = 0;
    for (const [concept, sets] of recorded) {
      expect({ concept, sets: [...sets] }).toEqual({ concept, sets: [target.get(concept)] });
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });
});
