/**
 * Empathy Reply Classifier Tests
 *
 * Haiku is mocked so no live Bedrock. Focus: the classifier's input
 * structuring, output validation, and fallback behavior.
 */

const getHaikuJsonMock = jest.fn();

jest.mock('../../lib/bedrock', () => ({
  getHaikuJson: (...args: unknown[]) => getHaikuJsonMock(...args),
  BrainActivityCallType: { INTENT_DETECTION: 'INTENT_DETECTION' },
}));

import { classifyEmpathyValidationReply, type EmpathyReplyClassification } from '../empathy-reply-classifier';

const BASE_INPUT = {
  replyText: 'yes, exactly',
  empathyAttempt: 'It sounds like you were scared after the argument.',
  sessionId: 's1',
  turnId: 't1',
};

describe('classifyEmpathyValidationReply', () => {
  beforeEach(() => {
    getHaikuJsonMock.mockReset();
  });

  it('returns accept when Haiku says accept', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'accept', correction: null });
    const result = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result).toEqual({ intent: 'accept', correction: null });
  });

  it('returns revise + correction when Haiku captures a qualifier', async () => {
    getHaikuJsonMock.mockResolvedValue({
      intent: 'revise',
      correction: 'more disappointed than angry',
    });
    const result = await classifyEmpathyValidationReply({
      ...BASE_INPUT,
      replyText: 'Close, but actually I was more disappointed than angry.',
    });
    expect(result.intent).toBe('revise');
    expect(result.correction).toBe('more disappointed than angry');
  });

  it('returns decline when Haiku says decline', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'decline', correction: null });
    const result = await classifyEmpathyValidationReply({
      ...BASE_INPUT,
      replyText: "no, that's not it at all",
    });
    expect(result.intent).toBe('decline');
  });

  it('normalizes whitespace-only correction strings to null', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'revise', correction: '   ' });
    const result = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result.correction).toBeNull();
  });

  it('falls back to revise when Haiku returns null', async () => {
    getHaikuJsonMock.mockResolvedValue(null);
    const result = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result).toEqual({ intent: 'revise', correction: null });
  });

  it('falls back to revise on malformed intent', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'yes', correction: 'foo' });
    const result = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result).toEqual({ intent: 'revise', correction: null });
  });

  it('falls back to revise when Haiku throws', async () => {
    getHaikuJsonMock.mockRejectedValue(new Error('bedrock unavailable'));
    const result = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result).toEqual({ intent: 'revise', correction: null });
  });

  it('includes the empathy attempt and user reply in the prompt', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'accept', correction: null });
    await classifyEmpathyValidationReply({
      ...BASE_INPUT,
      empathyAttempt: 'you felt lonely',
      replyText: 'yeah that tracks',
    });
    const call = getHaikuJsonMock.mock.calls[0][0];
    expect(call.messages[0].content).toContain('you felt lonely');
    expect(call.messages[0].content).toContain('yeah that tracks');
  });

  it('labels the call with empathy-reply-classifier operation for cost attribution', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'accept', correction: null });
    await classifyEmpathyValidationReply(BASE_INPUT);
    const call = getHaikuJsonMock.mock.calls[0][0];
    expect(call.operation).toBe('empathy-reply-classifier');
    expect(call.callType).toBe('INTENT_DETECTION');
    expect(call.sessionId).toBe('s1');
    expect(call.turnId).toBe('t1');
  });

  it('defaults correction to null when Haiku omits the field', async () => {
    getHaikuJsonMock.mockResolvedValue({ intent: 'accept' });
    const result: EmpathyReplyClassification = await classifyEmpathyValidationReply(BASE_INPUT);
    expect(result).toEqual({ intent: 'accept', correction: null });
  });
});
