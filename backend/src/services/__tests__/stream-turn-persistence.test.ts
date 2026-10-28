/**
 * Unit tests for the pure part of `stream-turn-persistence`.
 *
 * TS-12: the Prisma-mock cases of this suite are gone. The Stage 3 gate
 * (resolveStage3GateTurn: canned text only, written by the job, never partner
 * prose) runs on real roles in services/__tests__/stage3-gate.target.test.ts;
 * saving the AI turn and cleaning up a failed one (user message deleted, no AI
 * row, retryable error) in services/__tests__/chat-turn.target.test.ts.
 */

import { isReadyForStage3RevealText } from '../stream-turn-persistence';

describe('isReadyForStage3RevealText', () => {
  it('recognises an affirmative reveal request', () => {
    expect(isReadyForStage3RevealText("I'm ready to see the needs lists")).toBe(true);
    expect(isReadyForStage3RevealText('We are ready for the side by side reveal')).toBe(true);
  });

  it('does not fire on a negated request', () => {
    expect(isReadyForStage3RevealText("I'm not ready to see the lists")).toBe(false);
    expect(isReadyForStage3RevealText("I don't want to show the needs yet")).toBe(false);
  });

  it('does not fire on bare readiness with no reveal object', () => {
    expect(isReadyForStage3RevealText("Yes, I'm ready")).toBe(false);
  });
});
