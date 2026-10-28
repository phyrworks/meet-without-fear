/**
 * Ruling R40 (TS-12 fix round 1): a brain_activity row is attributed to a
 * participant ONLY when every piece of content in the call's input and output
 * is that participant's alone. A call site opts in with `ownContent: true`;
 * everything else is written with participant_id NULL and its session_id, so
 * the anonymise walk's R17 arm removes it when either participant leaves.
 *
 * This pins the exact set of opted-in call sites: adding `ownContent: true`
 * anywhere else (a reconciler, share-suggestion, empathy or transition call
 * would leak the other participant's text past the walk) fails here and needs
 * a reviewed entry with its reason.
 */

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');

/** file → number of `ownContent: true` sites, with why each is the caller's own content. */
const OWN_CONTENT_SITES: Record<string, { count: number; why: string }> = {
  'services/stream-turn-model.ts': { count: 2, why: "the caller's streamed chat turn" },
  'services/ai-orchestrator.ts': { count: 2, why: "the caller's orchestrated chat turn" },
  'services/background-classifier.ts': { count: 1, why: "classification of the caller's own turn" },
  'services/partner-session-classifier.ts': { count: 1, why: "notable facts from the caller's own turn" },
  'services/memory-detector.ts': { count: 1, why: "memory intent in the caller's own message" },
  'services/memory-validator.ts': { count: 1, why: "validation of the caller's own memory" },
  'services/memory-formatter.ts': { count: 2, why: "formatting of the caller's own memory" },
  'services/people-extractor.ts': { count: 1, why: "people named in the caller's own message" },
  'services/conversation-summarizer.ts': { count: 1, why: "summary of the caller's own MAIN conversation" },
  'services/retrieval-planner.ts': { count: 1, why: "retrieval plan for the caller's own message" },
  'services/context-retriever.ts': { count: 1, why: "references in the caller's own message" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['__tests__', 'generated', 'node_modules'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('R40: brain_activity attribution is opt-in per call site', () => {
  it('only the reviewed own-content call sites attribute their telemetry', () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const n = (fs.readFileSync(file, 'utf8').match(/\bownContent:\s*true\b/g) ?? []).length;
      if (n) found[path.relative(SRC, file)] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(OWN_CONTENT_SITES).map(([f, v]) => [f, v.count])));
  });

  it('the cross-participant call sites never opt in', () => {
    for (const file of ['services/reconciler/analysis.ts', 'services/reconciler/sharing.ts', 'controllers/stage2.ts', 'controllers/reconciler.ts', 'services/dispatch-handler.ts', 'services/empathy-reply-classifier.ts']) {
      expect({ file, attributes: /\bownContent:\s*true\b/.test(fs.readFileSync(path.join(SRC, file), 'utf8')) }).toEqual({ file, attributes: false });
    }
  });
});
