/**
 * The guards on ops-readable brain_activity.metadata (work-k5fk.9, reviews r1 F1/F2 and r2 R2-1..R2-3): what a
 * stored trace, error and activity metadata may hold. The probes are the reviewers'.
 */
import { errorClass, sanitizeActivityMetadata, sanitizeTurnTrace, type TurnTrace } from '../turn-trace';

const trace = (steps: unknown[]): TurnTrace =>
  ({ totalDurationMs: 1, modelUsed: 'sonnet', usedMock: false, steps }) as unknown as TurnTrace;
const step = (name: unknown, result: unknown) => ({
  name,
  type: 'decision',
  startMs: 0,
  durationMs: 1,
  result,
  status: 'success',
});

describe('sanitizeTurnTrace', () => {
  it('keeps code-built results and redacts free text in every enum slot (R2-1)', () => {
    const { trace: out } = sanitizeTurnTrace(
      trace([
        step('Memory Intent', 'emotional_validation (minimal)'),
        step('Memory Intent', 'she_says_her_husband_hit_her (yes)'),
        step('Model Routing', 'model=sonnet, score=0.4'),
        step('Model Routing', 'model=she-hit-me:last.night, score=1'),
        step('LLM Call', 'error: RateLimitError'),
        step('LLM Call', 'error: Shehitmelastnight'),
        step('Surfacing Policy', 'shouldSurface=false, style=silent'),
        step('Surfacing Policy', 'shouldSurface=false, style=she_said'),
      ]),
    );
    expect(out.steps.map(s => s.result)).toEqual([
      'emotional_validation (minimal)',
      '[redacted]',
      'model=sonnet, score=0.4',
      '[redacted]',
      'error: RateLimitError',
      '[redacted]',
      'shouldSurface=false, style=silent',
      '[redacted]',
    ]);
  });

  it('a prototype key or a null step neither throws nor drops the other steps (R2-3)', () => {
    const { trace: out, redacted } = sanitizeTurnTrace(
      trace([step('toString', 'x'), null, 'str', step('constructor', 'y'), step('Context Assembly', '3 turns')]),
    );
    expect(out.steps.map(s => [s.name, s.result])).toEqual([
      ['Unknown step', '[redacted]'],
      ['Unknown step', '[redacted]'],
      ['Context Assembly', '3 turns'],
    ]);
    expect(redacted).toBe(4);
  });
});

describe('errorClass (R2-1)', () => {
  it('returns a known code or class, else other — never text from the thrown value', () => {
    expect(errorClass(new Error('secret'))).toBe('Error');
    expect(errorClass(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorClass({ code: 'she said hit me' })).toBe('other');
    expect(errorClass({ name: 'Error: secret message about husband hitting' })).toBe('other');
    expect(errorClass('a string')).toBe('other');
  });
});

describe('sanitizeActivityMetadata (R2-2)', () => {
  it('keeps numbers, declared tool names and context sizes; drops everything else', () => {
    const { metadata, dropped } = sanitizeActivityMetadata({
      maxTokens: 1024,
      cacheReadInputTokens: 10,
      toolInvocations: [{ name: 'update_session_state' }, { name: 'she_said_it' }],
      contextSizes: { pinnedTokens: 1, summaryTokens: 2, recentTokens: 3, ragTokens: 'x' },
      note: 'free text',
      maxTokensText: 'x',
    });
    expect(metadata).toEqual({
      maxTokens: 1024,
      cacheReadInputTokens: 10,
      toolInvocations: [{ name: 'update_session_state' }, { name: 'other' }],
      contextSizes: { pinnedTokens: 1, summaryTokens: 2, recentTokens: 3, ragTokens: 0 },
    });
    expect(dropped).toBe(2);
  });
});
