/**
 * Print which target baseline the harness builds templates from
 * (`../target-baseline.ts`): the in-tree migration, the TS-7c branch, or the
 * composed fallback.
 *
 *   npx tsx src/testing/golden/tools/baseline-source.ts
 */
import { targetBaselineSql } from '../target-baseline';

process.stdout.write(`${targetBaselineSql().source}\n`);
