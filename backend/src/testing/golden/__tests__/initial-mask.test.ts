/**
 * work-9klf: `fixtureMask` on the normalised baseline's restored state
 * (`initial.…` paths), and the topic-frame rules that use it.
 */

import { TARGET_TOPIC_FRAME_INITIAL_RULES, TARGET_TOPIC_FRAME_RULES } from '../allow-lists/common';
import { isInitialMask } from '../allow-lists/compare';
import type { StepResult } from '../driver';
import { maskConceptInitial, maskTargetSteps } from '../runner';
import { isTargetShape } from '../shape';

const target = isTargetShape() ? it : it.skip;

describe('fixtureMask on the restored state (work-9klf)', () => {
  it('tells restored-state masks from step masks', () => {
    expect(TARGET_TOPIC_FRAME_INITIAL_RULES.map(isInitialMask)).toEqual([true, false]);
    expect(TARGET_TOPIC_FRAME_RULES.map(isInitialMask)).toEqual([false, false]);
  });

  target('masks the session row before normalisation, on a copy, and only a snapshot timestamp', () => {
    const tables = {
      session: [{ id: 's', topic_frame: 'x', topic_frame_confirmed_at: '2026-11-02 18:56:21.675' }],
    };
    expect(maskConceptInitial(tables, TARGET_TOPIC_FRAME_INITIAL_RULES)).toEqual({
      tables: { session: [{ id: 's', topic_frame: 'x', topic_frame_confirmed_at: null }] },
      problems: [],
    });
    expect(tables.session[0].topic_frame_confirmed_at).toBe('2026-11-02 18:56:21.675');

    const iso = maskConceptInitial(
      { session: [{ id: 's', topic_frame_confirmed_at: '2026-11-02T18:56:21.675Z' }] },
      TARGET_TOPIC_FRAME_INITIAL_RULES,
    );
    expect(iso.problems).toEqual([
      'fixtureMask @ initial.session.0.topic_frame_confirmed_at: expected sqlTimestamp, got "2026-11-02T18:56:21.675Z"',
      // a refused value is not masked, so the mask also matched nothing
      'fixtureMask @ initial.session.*.topic_frame_confirmed_at matched nothing in the restored state',
    ]);
    expect(maskConceptInitial({ session: [] }, TARGET_TOPIC_FRAME_INITIAL_RULES).problems).toEqual([
      'fixtureMask @ initial.session.*.topic_frame_confirmed_at matched nothing in the restored state',
    ]);
  });

  target('step masking ignores restored-state masks (they cannot "match nothing" there)', () => {
    const steps = [
      { body: { data: { invitation: { topicFrameConfirmedAt: '2026-11-02T18:56:21.675Z' } } } },
    ] as unknown as StepResult[];
    const r = maskTargetSteps(steps, [...TARGET_TOPIC_FRAME_RULES, ...TARGET_TOPIC_FRAME_INITIAL_RULES]);
    expect(r.problems).toEqual([]);
    expect((r.steps[0].body as { data: { invitation: unknown } }).data.invitation).toEqual({
      topicFrameConfirmedAt: null,
    });
  });
});
