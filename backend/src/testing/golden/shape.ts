/**
 * Golden harness — which database shape is in use (TS-9).
 *
 * The harness and the fixture factory run against whichever schema the branch
 * carries: the current (pre-rebuild) shape on phoenix/base, the target shape on
 * phoenix/target-shape. The shape is read from `prisma/schema.prisma` — the
 * schema the generated client and the app under test were built from — so a
 * run can never pair target-shape code with current-shape fixtures.
 *
 * `GOLDEN_SHAPE=current|target` overrides it (for tooling only).
 *
 * The two shapes never share a database name: target fixtures are
 * `mwf_tfx_<stage>`, target runs `mwf_trun_<id>`, and their manifests live in
 * `__fixtures__/target/`, so building one never clobbers the other's templates
 * on the same machine.
 */

import * as fs from 'fs';
import * as path from 'path';

export type Shape = 'current' | 'target';

let detected: Shape | null = null;

export function schemaShape(): Shape {
  const forced = process.env.GOLDEN_SHAPE;
  if (forced === 'current' || forced === 'target') return forced;
  if (forced) throw new Error(`GOLDEN_SHAPE must be "current" or "target", got "${forced}"`);
  if (!detected) {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
    detected = /@@map\("participant"\)/.test(schema) ? 'target' : 'current';
  }
  return detected;
}

export const isTargetShape = (): boolean => schemaShape() === 'target';
