import { cleanVisibleAIText } from '../visible-text';

describe('cleanVisibleAIText', () => {
  it('removes leading markdown separators, emphasis, and quote wrappers', () => {
    expect(cleanVisibleAIText('"--- **When you are ready, we will shift.**"')).toBe(
      'When you are ready, we will shift.',
    );
  });

  it('removes escaped full-string quote wrappers', () => {
    expect(cleanVisibleAIText('\\"I need emotional presence from Adam.\\"')).toBe(
      'I need emotional presence from Adam.',
    );
  });

  it('preserves intentional inline quotes and emphasis', () => {
    expect(cleanVisibleAIText('I said "I need room" and I feel **really** stuck.')).toBe(
      'I said "I need room" and I feel **really** stuck.',
    );
  });

  it('removes full-string emphasis wrappers', () => {
    expect(cleanVisibleAIText('**I need room to be scared**')).toBe('I need room to be scared');
  });

  it('preserves boundary whitespace when cleaning streamed chunks', () => {
    expect(cleanVisibleAIText(' talk ', { preserveBoundaryWhitespace: true })).toBe(' talk ');
    expect(cleanVisibleAIText(' ', { preserveBoundaryWhitespace: true })).toBe(' ');
  });
});
