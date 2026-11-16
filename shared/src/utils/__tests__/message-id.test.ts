import { formatMessageId, parseMessageId } from '../message-id';
import { uuidv7 } from '../uuid-v7';

describe('message id (work-k5fk.4)', () => {
  const conv = uuidv7();

  it('formats "<conversationId>:<seq>" and parses it back', () => {
    expect(formatMessageId(conv, 3)).toBe(`${conv}:3`);
    expect(parseMessageId(formatMessageId(conv, 3))).toEqual({ conversationId: conv, seq: 3 });
    expect(parseMessageId(formatMessageId(conv, 2147483647))).toEqual({ conversationId: conv, seq: 2147483647 });
  });

  it.each([
    [undefined],
    [42],
    [conv],
    [`${conv}:0`],
    [`${conv}:01`],
    [`${conv}:-1`],
    [`${conv}:1.5`],
    [`${conv}:2147483648`],
    [`${conv}:1:2`],
    [`context-shared-${conv}:1`],
    ['01900000-0000-4000-8000-000000000000:1'],
  ])('refuses %p', v => {
    expect(parseMessageId(v)).toBeNull();
  });
});
