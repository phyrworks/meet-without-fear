/**
 * Unit tests for the pure stream tag-sanitizer state machine.
 *
 * These mirror the behavior of the previously-inline tag trap in
 * sendMessageStream — including chunk-timing semantics (what is emitted on
 * which push), which is part of the wire behavior.
 */

import { StreamTagSanitizer } from '../stream-tag-sanitizer';

const LONG_VISIBLE = 'This is a long enough visible response to satisfy the fifty character minimum for trap exit.';

describe('StreamTagSanitizer', () => {
  describe('thinking trap (phase 1)', () => {
    it('hides a normal thinking block and emits the visible text that follows', () => {
      const s = new StreamTagSanitizer();
      expect(s.push('<thinking>Mode: WITNESS</thinking>\n')).toBe('');
      const out = s.push(LONG_VISIBLE);
      // The newline that followed </thinking> is passed through — the caller's
      // first-chunk trimStart handles it (parity with the inline machine).
      expect(out).toBe(`\n${LONG_VISIBLE}`);
      // Faithful quirk: the captured thinking retains the opener because the
      // original buffered it before confirming the tag.
      expect(s.captured.thinking).toBe('<thinking>Mode: WITNESS');
    });

    it('defers emission to the next push when thinking and text arrive in one chunk', () => {
      const s = new StreamTagSanitizer();
      // Same-chunk remainder is buffered, not emitted (chunk timing parity
      // with the original inline machine).
      expect(s.push(`<thinking>t</thinking>\n${LONG_VISIBLE}`)).toBe('');
      const next = s.push(' More.');
      expect(next).toContain(LONG_VISIBLE);
      expect(next).toContain(' More.');
    });

    it('flush() emits buffered visible text when the stream ends right after thinking', () => {
      const s = new StreamTagSanitizer();
      s.push(`<thinking>t</thinking>\nShort reply.`);
      expect(s.flush()).toContain('Short reply.');
    });

    it('bails out when the response does not open with <thinking>', () => {
      const warn = jest.fn();
      const s = new StreamTagSanitizer({ warn });
      expect(s.push('I hear you - ')).toBe(''); // routed into tag trap
      const out = s.push(LONG_VISIBLE);
      expect(out).toBe(`I hear you - ${LONG_VISIBLE}`);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not open with <thinking>'));
      expect(s.captured.thinking).toBe('');
    });

    it('keeps buffering while the prefix is still an ambiguous <thinking opener', () => {
      const s = new StreamTagSanitizer();
      expect(s.push('<th')).toBe('');
      expect(s.push('inking>hidden</thinking>')).toBe('');
      expect(s.push(LONG_VISIBLE)).toBe(LONG_VISIBLE);
      expect(s.captured.thinking).toBe('<thinking>hidden');
    });

    it('bail-out text that starts with "<" is held by the tag trap until flush', () => {
      // Faithful quirk: after the no-thinking bail-out, the tag trap requires
      // stripped content that does NOT start with "<" before exiting, so a
      // reply that opens with a non-semantic angle bracket stays buffered
      // until flush.
      const s = new StreamTagSanitizer();
      expect(s.push('<three little words ')).toBe('');
      expect(s.push(LONG_VISIBLE)).toBe('');
      expect(s.flush()).toBe(`<three little words ${LONG_VISIBLE}`);
    });

    it('keeps an unterminated thinking block hidden at flush when the opener was confirmed', () => {
      const warn = jest.fn();
      const s = new StreamTagSanitizer({ warn });
      s.push('<thinking>secret reasoning that never closes');
      s.push(' and keeps going');
      expect(s.flush()).toBe('');
      expect(s.captured.thinking).toBe('<thinking>secret reasoning that never closes and keeps going');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Keeping it hidden'));
    });

    it('flushes an ambiguous never-resolved prefix as visible text', () => {
      const s = new StreamTagSanitizer();
      s.push('<th');
      expect(s.flush()).toBe('<th');
    });
  });

  describe('tag trap (phase 2)', () => {
    it('captures a draft without leaking it', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      s.push('<draft>I imagine you felt dismissed.</draft>');
      const out = s.push(LONG_VISIBLE);
      expect(out).not.toContain('dismissed');
      expect(out).toContain(LONG_VISIBLE);
      expect(s.captured.draft).toBe('I imagine you felt dismissed.');
    });

    it('holds the trap while a tag is split across pushes', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      expect(s.push('Okay. <dra')).toBe('');
      expect(s.push('ft>hidden</dr')).toBe('');
      const out = s.push(`aft> ${LONG_VISIBLE}`);
      expect(out).not.toContain('hidden');
      expect(out).toContain(LONG_VISIBLE);
      expect(s.captured.draft).toBe('hidden');
    });

    it('captures a self-closing need-action tag', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      s.push('<need-action type="lock" needId="n1"/>');
      const out = s.push(LONG_VISIBLE);
      expect(out).not.toContain('need-action');
      expect(s.captured.needAction).toBe('<need-action type="lock" needId="n1"/>');
    });

    it('captures multiple hidden tags from the same preamble', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      s.push('<need>{"need":"x"}</need><needs>[1]</needs><dispatch>go</dispatch>');
      const out = s.push(LONG_VISIBLE);
      expect(out).toContain(LONG_VISIBLE);
      expect(s.captured.need).toBe('{"need":"x"}');
      expect(s.captured.needs).toBe('[1]');
      expect(s.captured.dispatch).toBe('go');
    });

    it('exits the trap on the safety limit even while a tag is unclosed', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      s.push('<draft>' + 'x'.repeat(2100));
      // Next push exceeds the limit → trap exits, unclosed draft stripped by
      // nothing (no closing tag), so text passes through raw.
      const out = s.push('tail');
      expect(out.length).toBeGreaterThan(0);
    });

    it('a dispatch-only stream stays buffered until flush', () => {
      const s = new StreamTagSanitizer();
      s.push('<thinking>t</thinking>\n');
      expect(s.push('<dispatch>generate_invitation</dispatch>')).toBe('');
      // Only the whitespace remainder of the preamble survives the strip.
      expect(s.flush().trim()).toBe('');
      expect(s.captured.dispatch).toBe('generate_invitation');
    });
  });

  describe('normal streaming (phase 3)', () => {
    function drainPreamble(s: StreamTagSanitizer): void {
      s.push('<thinking>t</thinking>\n');
      s.push(LONG_VISIBLE);
    }

    it('passes plain text straight through', () => {
      const s = new StreamTagSanitizer();
      drainPreamble(s);
      expect(s.push(' and more words')).toBe(' and more words');
    });

    it('buffers a late unclosed dispatch tag and strips it once closed', () => {
      const s = new StreamTagSanitizer();
      drainPreamble(s);
      expect(s.push(' Done now. <dispatch>send')).toBe('');
      expect(s.push('_invite</dispatch> Bye.')).toBe(' Done now.  Bye.');
      expect(s.captured.dispatch).toBe('send_invite');
    });

    it('buffers a possible tag prefix at the end of a chunk', () => {
      const s = new StreamTagSanitizer();
      drainPreamble(s);
      expect(s.push(' call me <d')).toBe('');
      // Resolves to plain text → emitted with the held prefix.
      expect(s.push('ear> friend')).toBe(' call me <dear> friend');
    });

    it('flush() drains a held phase-3 buffer', () => {
      const s = new StreamTagSanitizer();
      drainPreamble(s);
      s.push(' trailing <n');
      expect(s.flush()).toBe(' trailing <n');
    });
  });
});
