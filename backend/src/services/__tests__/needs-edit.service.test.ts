/**
 * Stage 3 need edits: the pure universality check.
 *
 * TS-12: the Prisma-mock cases of this suite are gone. The interpreter preview,
 * the transactional update/add/remove, refine/delete/lock and the after-share
 * refusal run on the target `need` table in
 * services/__tests__/needs-edit.target.test.ts.
 */

import { validateNeedIsUniversal } from '../needs';

describe('validateNeedIsUniversal', () => {
  it('flags obvious strategy-shaped or partner-directed needs', () => {
    expect(validateNeedIsUniversal('I need him to stop leaving dishes everywhere.')).toEqual(expect.objectContaining({ ok: false }));
    expect(validateNeedIsUniversal('I need time to decompress after work.')).toEqual({ ok: true });
    expect(validateNeedIsUniversal('I need more care and reliability around our shared space.')).toEqual({ ok: true });
  });
});
