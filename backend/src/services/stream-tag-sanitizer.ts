/**
 * Stream Tag Sanitizer
 *
 * Pure state machine extracted (behavior-preserving) from the inline
 * three-phase "tag trap" in `sendMessageStream`:
 *
 *   PHASE 1 — thinking trap: buffer until `</thinking>` is found. The model is
 *   supposed to open with `<thinking>`, but occasionally skips straight to the
 *   visible reply; the first non-whitespace prefix decides whether we stay in
 *   the trap or bail out.
 *
 *   PHASE 2 — tag trap: after thinking, buffer to catch hidden semantic tags
 *   (`<draft>`, `<need>`, `<need-action>`, `<needs>`, `<stage4_proposals>`,
 *   `<stage4_walkthrough>`, `<dispatch>`) that typically arrive before the
 *   visible response text.
 *
 *   PHASE 3 — normal streaming: pass text through, but re-buffer whenever an
 *   unclosed hidden tag (or a possible tag prefix) appears late in the stream.
 *
 * The sanitizer returns candidate visible text from `push()`/`flush()`;
 * captured hidden-tag contents are exposed on `captured`. It performs no I/O
 * and never mutates state outside itself — the caller owns emission,
 * accumulation, and any additional defense-in-depth scrubbing.
 *
 * NOTE (Phase 3 of the modernization program): this hidden-tag channel is a
 * compatibility fallback — tool calls are the primary structured-state
 * channel. Once telemetry shows a tag no longer occurs in live traffic, its
 * handling here is removed rather than extended.
 */

export interface SanitizerLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

/** Hidden-tag contents captured during the stream. */
export interface CapturedHiddenTags {
  /** Content of `<thinking>…</thinking>` (or the whole buffer when unterminated). */
  thinking: string;
  /** Content of `<draft>…</draft>`. */
  draft: string;
  /** Content of `<need>…</need>`. */
  need: string;
  /** The full `<need-action …>…</need-action>` (or self-closing) tag markup. */
  needAction: string;
  /** Content of `<needs>…</needs>`. */
  needs: string;
  /** Content of `<stage4_proposals>…</stage4_proposals>`. */
  stage4Proposals: string;
  /** Content of `<stage4_walkthrough>…</stage4_walkthrough>`. */
  stage4Walkthrough: string;
  /** Content of `<dispatch>…</dispatch>`. */
  dispatch: string;
}

const THINKING_BUFFER_WARN_LIMIT = 2000;
const TAG_TRAP_BUFFER_LIMIT = 2000;
const TAG_TRAP_MIN_RESPONSE_CHARS = 50;

/** Matches a possible hidden-tag prefix at the end of a buffer (e.g. "<dra"). */
const PARTIAL_TAG_PATTERN = /<\/?(d|n|s)[a-z0-9_-]*$/i;

function truncateForLog(value: string): string {
  return value.substring(0, 160) + (value.length > 160 ? '...' : '');
}

function stripHiddenTags(text: string): string {
  return text
    .replace(/<draft>[\s\S]*?<\/draft>/gi, '')
    .replace(/<need>[\s\S]*?<\/need>/gi, '')
    .replace(/<need-action\b[^>]*>[\s\S]*?<\/need-action>/gi, '')
    .replace(/<need-action\b[^>]*\/>/gi, '')
    .replace(/<needs>[\s\S]*?<\/needs>/gi, '')
    .replace(/<stage4_proposals>[\s\S]*?<\/stage4_proposals>/gi, '')
    .replace(/<stage4_walkthrough>[\s\S]*?<\/stage4_walkthrough>/gi, '')
    .replace(/<dispatch>[\s\S]*?<\/dispatch>/gi, '');
}

export class StreamTagSanitizer {
  private isInsideThinking = true;
  private sawThinkingOpener = false;
  private isTrappingTags = false;
  private thinkingBuffer = '';
  private tagTrapBuffer = '';

  readonly captured: CapturedHiddenTags = {
    thinking: '',
    draft: '',
    need: '',
    needAction: '',
    needs: '',
    stage4Proposals: '',
    stage4Walkthrough: '',
    dispatch: '',
  };

  constructor(private readonly logger: SanitizerLogger = {}) {}

  /** True once a real `<thinking>` opener was confirmed. */
  get confirmedThinkingOpener(): boolean {
    return this.sawThinkingOpener;
  }

  /** True while still buffering inside the thinking trap. */
  get insideThinking(): boolean {
    return this.isInsideThinking;
  }

  /**
   * Feed one streamed text delta.
   * Returns candidate visible text to emit now ('' when everything was buffered).
   */
  push(text: string): string {
    // PHASE 1: THINKING TRAP — buffer until </thinking> is found.
    if (this.isInsideThinking) {
      this.thinkingBuffer += text;

      // Decide as soon as we have a non-whitespace prefix: if it cannot become
      // a "<thinking" opener, bail out of the trap so the reply is not
      // swallowed and hidden.
      if (!this.sawThinkingOpener) {
        const trimmedStart = this.thinkingBuffer.replace(/^\s+/, '');
        const opener = '<thinking';
        if (trimmedStart.length > 0) {
          if (trimmedStart.startsWith(opener)) {
            this.sawThinkingOpener = true;
          } else if (!opener.startsWith(trimmedStart.slice(0, opener.length))) {
            // Definitely not a <thinking> opener — treat everything as visible
            // output, but run it through the tag trap so hidden tags are still caught.
            this.logger.warn?.(
              `Response did not open with <thinking>; routing ${this.thinkingBuffer.length} buffered chars as visible response.`,
            );
            this.isInsideThinking = false;
            this.isTrappingTags = true;
            this.tagTrapBuffer = this.thinkingBuffer;
            this.thinkingBuffer = '';
            return '';
          }
          // else: still ambiguous (e.g. "<th") — keep buffering.
        }
      }

      const closingTagIndex = this.thinkingBuffer.indexOf('</thinking>');
      if (closingTagIndex !== -1) {
        this.isInsideThinking = false;
        this.isTrappingTags = true;
        this.captured.thinking = this.thinkingBuffer.substring(0, closingTagIndex);
        this.logger.info?.(`[HIDDEN THINKING]: {length: ${this.captured.thinking.length}}`);
        this.tagTrapBuffer = this.thinkingBuffer.substring(closingTagIndex + '</thinking>'.length);
        this.thinkingBuffer = '';
        // Deliberately do NOT evaluate the tag trap in this same push — the
        // original inline state machine only evaluates on the next delta (or
        // at flush), and chunk emission timing is part of the wire behavior.
        return '';
      }
      // Safety: if the hidden preamble is long, keep waiting for the closing
      // tag. Flushing here can expose chain-of-thought to the user.
      if (this.thinkingBuffer.length > THINKING_BUFFER_WARN_LIMIT) {
        this.logger.warn?.(
          `Thinking buffer exceeded ${THINKING_BUFFER_WARN_LIMIT} chars without closing tag; continuing to trap hidden text`,
        );
      }
      return '';
    }

    // PHASE 2: TAG TRAP — buffer to catch hidden semantic tags before streaming.
    if (this.isTrappingTags) {
      this.tagTrapBuffer += text;
      return this.evaluateTagTrap();
    }

    // PHASE 3: NORMAL STREAMING — with safety buffer for late tags.
    const combined = this.tagTrapBuffer + text;
    const hasUnclosedDispatch = combined.includes('<dispatch>') && !combined.includes('</dispatch>');
    const hasUnclosedDraft = combined.includes('<draft>') && !combined.includes('</draft>');
    const hasUnclosedNeed = combined.includes('<need>') && !combined.includes('</need>');
    const hasUnclosedNeedAction =
      /<need-action\b/i.test(combined) && !/<\/need-action>|<need-action\b[^>]*\/>/i.test(combined);
    const hasUnclosedNeeds = combined.includes('<needs>') && !combined.includes('</needs>');
    const hasUnclosedStage4Proposals =
      combined.includes('<stage4_proposals>') && !combined.includes('</stage4_proposals>');
    const hasUnclosedStage4Walkthrough =
      combined.includes('<stage4_walkthrough>') && !combined.includes('</stage4_walkthrough>');
    const hasPotentialTagStart = PARTIAL_TAG_PATTERN.test(combined);

    if (
      hasUnclosedDispatch ||
      hasUnclosedDraft ||
      hasUnclosedNeed ||
      hasUnclosedNeedAction ||
      hasUnclosedNeeds ||
      hasUnclosedStage4Proposals ||
      hasUnclosedStage4Walkthrough ||
      hasPotentialTagStart
    ) {
      this.tagTrapBuffer = combined;
      return '';
    }

    this.tagTrapBuffer = '';
    return this.extractAndStrip(combined);
  }

  /**
   * End-of-stream flush.
   * Returns any remaining candidate visible text (may be '').
   */
  flush(): string {
    let visible = '';

    if (this.isInsideThinking && this.thinkingBuffer.length > 0) {
      if (this.sawThinkingOpener) {
        // A genuine <thinking> block was opened but never closed. Keep it
        // hidden: avoiding leaked chain-of-thought matters more than salvaging
        // malformed output.
        this.logger.warn?.(
          `Stream ended while still in thinking trap. Buffer has ${this.thinkingBuffer.length} chars. Keeping it hidden.`,
        );
        this.extractAndStrip(this.thinkingBuffer);
        this.captured.thinking = this.thinkingBuffer;
      } else {
        // We never confirmed a <thinking> opener, so the buffered text is the
        // visible reply — flush it rather than dropping the whole turn.
        this.logger.warn?.(
          `Stream ended with no <thinking> opener; flushing ${this.thinkingBuffer.length} buffered chars as visible response.`,
        );
        visible += this.extractAndStrip(this.thinkingBuffer);
      }
      this.thinkingBuffer = '';
      this.isInsideThinking = false;
    }

    if (this.tagTrapBuffer.length > 0) {
      visible += this.extractAndStrip(this.tagTrapBuffer);
      this.tagTrapBuffer = '';
    }

    return visible;
  }

  /** Evaluate the PHASE 2 buffer; exit the trap when safe (or when too large). */
  private evaluateTagTrap(): string {
    const buffer = this.tagTrapBuffer;

    const hasDraftStart = buffer.includes('<draft>');
    const hasDraftEnd = buffer.includes('</draft>');
    const hasNeedStart = buffer.includes('<need>');
    const hasNeedEnd = buffer.includes('</need>');
    const hasNeedActionStart = /<need-action\b/i.test(buffer);
    const hasNeedActionEnd = /<\/need-action>|<need-action\b[^>]*\/>/i.test(buffer);
    const hasNeedsStart = buffer.includes('<needs>');
    const hasNeedsEnd = buffer.includes('</needs>');
    const hasStage4ProposalsStart = buffer.includes('<stage4_proposals>');
    const hasStage4ProposalsEnd = buffer.includes('</stage4_proposals>');
    const hasStage4WalkthroughStart = buffer.includes('<stage4_walkthrough>');
    const hasStage4WalkthroughEnd = buffer.includes('</stage4_walkthrough>');
    const hasDispatchStart = buffer.includes('<dispatch>');
    const hasDispatchEnd = buffer.includes('</dispatch>');
    const hasPotentialTagStart = PARTIAL_TAG_PATTERN.test(buffer);

    const waitingForDraft = hasDraftStart && !hasDraftEnd;
    const waitingForNeed = hasNeedStart && !hasNeedEnd;
    const waitingForNeedAction = hasNeedActionStart && !hasNeedActionEnd;
    const waitingForNeeds = hasNeedsStart && !hasNeedsEnd;
    const waitingForStage4Proposals = hasStage4ProposalsStart && !hasStage4ProposalsEnd;
    const waitingForStage4Walkthrough = hasStage4WalkthroughStart && !hasStage4WalkthroughEnd;
    const waitingForDispatch = hasDispatchStart && !hasDispatchEnd;

    const trimmedStripped = stripHiddenTags(buffer).trim();
    const hasResponseContent = trimmedStripped.length > TAG_TRAP_MIN_RESPONSE_CHARS && !trimmedStripped.startsWith('<');
    const safeToExit =
      !waitingForDraft &&
      !waitingForNeed &&
      !waitingForNeedAction &&
      !waitingForNeeds &&
      !waitingForStage4Proposals &&
      !waitingForStage4Walkthrough &&
      !waitingForDispatch &&
      hasResponseContent &&
      !hasPotentialTagStart;

    if (safeToExit || buffer.length > TAG_TRAP_BUFFER_LIMIT) {
      this.isTrappingTags = false;
      this.tagTrapBuffer = '';
      return this.extractAndStrip(buffer);
    }
    return '';
  }

  /**
   * Extract hidden-tag contents from a buffer into `captured`, then return the
   * buffer with all hidden tags stripped. (Mirrors the original
   * `processTagTrapBuffer` — no trim, to preserve word spacing across chunks.)
   */
  private extractAndStrip(buffer: string): string {
    const draftMatch = buffer.match(/<draft>([\s\S]*?)<\/draft>/i);
    if (draftMatch) {
      this.captured.draft = draftMatch[1].trim();
      this.logger.info?.(`[HIDDEN DRAFT]: {length: ${this.captured.draft.length}}`);
    }

    const needMatch = buffer.match(/<need>([\s\S]*?)<\/need>/i);
    if (needMatch) {
      this.captured.need = needMatch[1].trim();
      this.logger.info?.(`[HIDDEN NEED]: ${truncateForLog(this.captured.need)}`);
    }

    const needActionMatch = buffer.match(/<need-action\b[^>]*>[\s\S]*?<\/need-action>|<need-action\b[^>]*\/>/i);
    if (needActionMatch) {
      this.captured.needAction = needActionMatch[0].trim();
      this.logger.info?.(`[HIDDEN NEED ACTION]: ${truncateForLog(this.captured.needAction)}`);
    }

    const needsMatch = buffer.match(/<needs>([\s\S]*?)<\/needs>/i);
    if (needsMatch) {
      this.captured.needs = needsMatch[1].trim();
      this.logger.info?.(`[HIDDEN NEEDS]: {length: ${this.captured.needs.length}}`);
    }

    const stage4ProposalsMatch = buffer.match(/<stage4_proposals>([\s\S]*?)<\/stage4_proposals>/i);
    if (stage4ProposalsMatch) {
      this.captured.stage4Proposals = stage4ProposalsMatch[1].trim();
      this.logger.info?.(`[HIDDEN STAGE 4 PROPOSALS]: {length: ${this.captured.stage4Proposals.length}}`);
    }

    const stage4WalkthroughMatch = buffer.match(/<stage4_walkthrough>([\s\S]*?)<\/stage4_walkthrough>/i);
    if (stage4WalkthroughMatch) {
      this.captured.stage4Walkthrough = stage4WalkthroughMatch[1].trim();
      this.logger.info?.(`[HIDDEN STAGE 4 WALKTHROUGH]: ${truncateForLog(this.captured.stage4Walkthrough)}`);
    }

    const dispatchMatch = buffer.match(/<dispatch>([\s\S]*?)<\/dispatch>/i);
    if (dispatchMatch) {
      this.captured.dispatch = dispatchMatch[1].trim();
      this.logger.info?.(`[DISPATCH TAG]: {length: ${this.captured.dispatch.length}}`);
    }

    return stripHiddenTags(buffer);
  }
}
