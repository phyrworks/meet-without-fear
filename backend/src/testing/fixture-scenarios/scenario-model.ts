/**
 * Fixture scenario model — shape-independent, participant-centred.
 *
 * A scenario says *what is true* of a session, not which tables hold it:
 * N participants (two today), each with the milestones they have reached (and
 * when) and the content they produced. No stage numbers and no gate-key JSON
 * appear here — those are how today's schema happens to encode milestones, and
 * they live in the current-shape writer (`current-shape.ts`). A target-shape
 * writer (TS-5) consumes the same scenarios and writes `participant_milestone`
 * rows instead.
 *
 * Milestone keys are the `milestone` lookup of the target schema
 * (docs/backend/data-model/schema-target-2026-10.md, `milestone` table) and the
 * migration plan's step-7 key table.
 *
 * Where today's fixtures carry a gate key the key table marks *derived*
 * (`strategiesRanked`, `agreementCreated`, `agreementConfirmed` here), a
 * scenario carries the underlying fact — a ranking, an agreement — and the
 * current-shape writer derives the key from it.
 *
 * The one section that is *not* shape-independent is `currentShape`: quirks of
 * how the pre-rebuild factory happened to encode facts, kept only so the
 * current-shape writer reproduces today's rows byte for byte (the recorded
 * goldens depend on it). A target-shape writer ignores it.
 */

// ============================================================================
// Milestones
// ============================================================================

/** Journey milestones, in journey order (target `milestone` table keys). */
export const MILESTONE_KEYS = [
  'compact_signed',
  'invitation_sent',
  'feel_heard',
  'empathy_submitted',
  'empathy_ready',
  'empathy_validated',
  'needs_confirmed',
  'needs_validated',
  'needs_shared',
  'choices_shared',
  'repair_walkthrough_started',
  'closed',
  'paused',
] as const;

export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

// ============================================================================
// Time
// ============================================================================

/**
 * The instants a scenario's timestamps hang off.
 *
 * A scenario is a lattice of fixed offsets from a few anchor instants. The
 * anchors are distinct on purpose: today's factory read the clock separately
 * when it confirmed the topic (`session`), minted the invitation
 * (`invitation`), started the scenario's own data (`scenario`) and, for the
 * redesigned repair flow, after the needs data (`late`). Collapsing them onto one
 * instant would merge timestamps that are distinct today and move the
 * goldens' timestamp ranks (golden README, "Two timestamps a millisecond apart
 * have no reliable order"). A writer reads each referenced clock once, in this
 * order; an unreferenced clock is never read.
 */
export const CLOCKS = ['session', 'invitation', 'scenario', 'late'] as const;
export type Clock = (typeof CLOCKS)[number];

export interface Stamp {
  clock: Clock;
  /** Milliseconds after (positive) or before (negative) the clock instant. */
  offsetMs: number;
}

/** A stamp on the scenario clock (default) or a named one. */
export function at(offsetMs = 0, clock: Clock = 'scenario'): Stamp {
  return { clock, offsetMs };
}

export const SECOND = 1000;
export const DAY = 24 * 60 * 60 * SECOND;

// ============================================================================
// Content
// ============================================================================

/** Opaque handle for a participant within one scenario ("a", "b", …). */
export type ParticipantKey = string;

/**
 * Which part of the journey a message belongs to. Named, not numbered: the
 * current-shape writer maps these to today's `Message.stage` integers.
 */
export type JourneyPhase = 'onboarding' | 'witness' | 'perspective' | 'needs' | 'repair';

/**
 * Today's `Message.role` kinds, kept as one union because the current shape stores
 * them in one column. The target splits this into `role` (USER/AI/SYSTEM) plus a
 * `kind` for the event messages; a target-shape writer maps it.
 */
export type ScenarioMessageRole = 'USER' | 'AI' | 'EMPATHY_STATEMENT' | 'EMPATHY_VALIDATION_PROMPT' | 'SHARED_CONTEXT';

/** A message in one participant's private conversation. */
export interface ScenarioMessage {
  role: ScenarioMessageRole;
  content: string;
  phase: JourneyPhase;
  at: Stamp;
  /**
   * Author. Omitted: the conversation's owner for `USER`, nobody (the AI) for
   * every other role. `null`: explicitly nobody.
   */
  from?: ParticipantKey | null;
}

/** A message delivered into a named participant's conversation. */
export interface DeliveredMessage extends ScenarioMessage {
  to: ParticipantKey;
}

export type AttemptStatus = 'HELD' | 'AWAITING_SHARING' | 'REFINING' | 'READY' | 'REVEALED' | 'VALIDATED';

/**
 * A participant's empathy attempt about their partner. It was submitted at the
 * participant's `empathy_submitted` milestone, which is required.
 */
export interface EmpathyContent {
  statement: string;
  status: AttemptStatus;
  revealedAt?: Stamp;
  /** Delivered to the partner at this instant. */
  deliveredAt?: Stamp;
  /** The participant's consent to share the draft is on record. */
  consentRecorded: boolean;
  /** The statement also appears in the author's own chat history. */
  statementInChat: boolean;
  /** The partner validated the attempt; the author's chat shows it. */
  validatedBy?: { participant: ParticipantKey; at: Stamp };
}

export type NeedCategoryName = 'SAFETY' | 'CONNECTION' | 'AUTONOMY' | 'RECOGNITION' | 'MEANING' | 'FAIRNESS';

/** A need identified for this participant (at their `needs_confirmed` milestone). */
export interface NeedContent {
  need: string;
  category: NeedCategoryName;
  aiConfidence: number;
  confirmed: boolean;
  /** What the participant said that the need was drawn from (`IdentifiedNeed.evidence`; default none). */
  evidence?: string[];
  /**
   * The participant shared this need (target `need_share`) at their
   * `needs_shared` milestone. `text` is the target's `shared_text`; today's
   * shape has nowhere to hold it (production's needs share writes only a
   * GRANTED IDENTIFIED_NEED consent — `stage3.ts` consentToShareNeeds — and no
   * ConsentedContent), so the current-shape writer records only the consent.
   */
  shared?: { text: string };
}

/**
 * A participant's Inner Work reflection (target `reflection`,
 * `reflection_message`): private to its author, never referenced by anything
 * that crosses between participants (spec §7, D2).
 */
export interface ReflectionContent {
  title: string;
  theme?: string;
  summary?: string;
  /** Linked to the scenario's session (today's `linkedPartnerSessionId`). */
  linkedToSession?: boolean;
  at: Stamp;
  messages: Array<{ role: 'USER' | 'AI'; content: string; at: Stamp }>;
}

/**
 * A captured LLM call (target `brain_activity`): the prompt built for one of
 * the participant's turns, in the session (`scope: 'session'`) or in one of
 * their reflections (`scope: { reflection: index }`). Production writes these
 * from `lib/bedrock.ts`; under MOCK_LLM nothing is captured, so a scenario
 * that needs a capture states it as content.
 */
export interface PromptCapture {
  scope: 'session' | { reflection: number };
  callType: 'ORCHESTRATED_RESPONSE' | 'WITNESSING_RESPONSE' | 'RECONCILER_ANALYSIS';
  at: Stamp;
  /** The prompt as captured (`BrainActivity.input`). */
  input: { systemPrompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> };
  /** The response text (`BrainActivity.output`). */
  output: string;
}

/** A participant's private choice on a repair proposal (redesigned flow) (at `choices_shared`). */
export interface ProposalChoice {
  proposal: string;
  decision: 'WILLING' | 'NOT_WILLING';
}

/** Legacy repair-flow ranking (`StrategyRanking`, dropped in the target). */
export interface LegacyRanking {
  proposals: string[];
  submittedAt: Stamp;
}

export interface ParticipantScenario {
  key: ParticipantKey;
  /**
   * The participant's journey began at this instant. Absent: the participant
   * is attached to the session but has not begun (no progress at all).
   * `startedAt` absent: began "now" (the database default).
   */
  journey?: { startedAt?: Stamp };
  milestones: Partial<Record<MilestoneKey, Stamp>>;
  /** Private conversation history, oldest first. */
  messages?: ScenarioMessage[];
  empathy?: EmpathyContent;
  needs?: NeedContent[];
  choices?: ProposalChoice[];
  ranking?: LegacyRanking;
  /** Inner Work reflections, oldest first. */
  reflections?: ReflectionContent[];
  /** LLM calls captured for this participant's turns, oldest first. */
  promptCaptures?: PromptCapture[];
}

export interface ReconcilerResultContent {
  guesser: ParticipantKey;
  subject: ParticipantKey;
  at: Stamp;
  alignmentScore: number;
  alignmentSummary: string;
  correctlyIdentified: string[];
  gapSeverity: string;
  gapSummary: string;
  missedFeelings: string[];
  misattributions: string[];
  mostImportantGap: string;
  recommendedAction: string;
  rationale: string;
  sharingWouldHelp: boolean;
  suggestedShareFocus: string;
  suggestedShareContent: string;
  suggestedShareReason: string;
}

export interface ShareOfferContent {
  status: 'OFFERED' | 'ACCEPTED';
  suggestedContent: string;
  /** The subject shared this, at this instant. */
  shared?: { content: string; at: Stamp };
  /** Delivered to the guesser at this instant. */
  deliveredAt?: Stamp;
}

export interface ReconciliationContent {
  result: ReconcilerResultContent;
  /** Offered to the result's subject. */
  shareOffer: ShareOfferContent;
  /** Messages the share produced, in write order. */
  messages?: DeliveredMessage[];
}

/** Legacy repair-flow strategy (`StrategyProposal` without kind/status). */
export interface LegacyStrategy {
  key: string;
  by: ParticipantKey;
  description: string;
  needsAddressed: string[];
  duration: string;
  at: Stamp;
}

export interface LegacyAgreement {
  proposal: string;
  description: string;
  type: 'COMMITMENT';
  status: 'AGREED';
  agreedBy: ParticipantKey[];
  agreedAt: Stamp;
  followUpAt: Stamp;
}

export interface RepairProposal {
  key: string;
  by: ParticipantKey;
  description: string;
  needsAddressed: string[];
  duration: string;
  measureOfSuccess: string;
  kind: 'SHARED_PROPOSAL' | 'INDIVIDUAL_COMMITMENT';
  coverageSummary: Record<string, string>;
  removed?: { by: ParticipantKey; at: Stamp; reason: string };
}

export interface ProposalRevision {
  proposal: string;
  actor: ParticipantKey;
  action: 'CREATED' | 'REMOVED';
  before?: Record<string, string>;
  after: Record<string, string>;
  reason: string;
}

export interface NeedCoverage {
  needLabel: string;
  source: ParticipantKey;
  coverageStatus: 'COVERED' | 'PARTIAL' | 'OPEN';
  coveringProposals: string[];
  note: string;
}

export interface RepairContent {
  proposals: RepairProposal[];
  revisions: ProposalRevision[];
  coverage: NeedCoverage[];
}

/**
 * How the repair stage ended (target `session_closure`). A participant reaches
 * `closed` only in a scenario that carries one (OD5), and only after
 * `choices_shared`.
 */
export interface SessionClosureContent {
  kind: 'SHARED_AGREEMENT' | 'NO_SHARED_AGREEMENT';
  reason: 'MUTUAL_SELECTION' | 'NO_OVERLAP' | 'BOUNDARY_HONORED' | 'USER_STOPPED';
  summary: string;
  /** Who closed it; null = auto-closure. */
  closedBy: ParticipantKey | null;
  at: Stamp;
  checkInAt?: Stamp;
}

export interface Scenario {
  name: string;
  /** In invitation order: the first participant invited the rest. */
  participants: ParticipantScenario[];
  topic?: { frame: string; confirmedAt: Stamp };
  invitation: {
    /** The invitee accepted at this instant (the session is then active). */
    acceptedAt?: Stamp;
    expiresAt: Stamp;
  };
  reconciliation?: ReconciliationContent;
  legacyStrategies?: { strategies: LegacyStrategy[]; agreement?: LegacyAgreement };
  repair?: RepairContent;
  /** The repair stage ended (session_closure); participants may then reach `closed`. */
  closure?: SessionClosureContent;
  /** Encoding quirks of the pre-rebuild factory; see the module comment. */
  currentShape?: CurrentShapeQuirks;
}

export interface CurrentShapeQuirks {
  /**
   * Milestones whose gate key was written without its `…At` companion. Some
   * of today's fixtures stamp gates (`compactSignedAt`), some do not.
   */
  untimedGates?: MilestoneKey[];
  /**
   * Write every participant's needs in one batch after all participants'
   * progress, instead of inside each participant's block (today's
   * STRATEGIC_REPAIR_COMPLETE write order).
   */
  batchNeeds?: boolean;
  /**
   * TS-5 stages only: write every timestamp explicitly, as a fixed offset from
   * one clock read — no `@default(now())` / `@updatedAt`, no co-written rows in
   * one millisecond — so a fixture rebuild cannot move its goldens (see the
   * current-shape writer). The 13 pre-TS-5 stages leave it off: their rows must
   * stay byte-identical to what their goldens were recorded against.
   */
  explicitStamps?: boolean;
  /**
   * TS-11: the pre-rebuild factory reached `needs_shared` for these scenarios
   * WITHOUT writing the share consents production writes (the repair-stage
   * fixtures: their needs carry the target's `shared` text, but today's rows
   * hold no consent for them). The current-shape writer therefore records no
   * share consent here, so its rows — and their concept image — stay as they
   * were; the target writer ignores this, like every quirk, and writes the
   * consent and the `need_share` row the target's repair stage needs.
   */
  unconsentedNeedShares?: boolean;
}
