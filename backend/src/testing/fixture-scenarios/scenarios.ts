/**
 * Every `TargetStage` as a declarative scenario.
 *
 * Each scenario states who the participants are, which milestones each has
 * reached (and when, as offsets from the scenario clock), and what they wrote.
 * Nothing here knows about `StageProgress`, stage integers or gate JSON — see
 * `current-shape.ts` for that.
 *
 * Offsets and content are the pre-rebuild factory's values verbatim, including
 * its inconsistencies (e.g. in EMPATHY_REVEALED both participants signed the
 * compact at the same instant); goldens are recorded against them.
 */

import {
  at,
  DAY,
  EmpathyContent,
  JourneyPhase,
  MilestoneKey,
  ParticipantScenario,
  Scenario,
  ScenarioMessage,
  ScenarioMessageRole,
  Stamp,
  RepairContent,
  PromptCapture,
  ReflectionContent,
} from './scenario-model';
import { TargetStage } from './target-stage';

export interface ScenarioNames {
  a: string;
  /** Absent: no partner account was supplied. */
  b?: string;
}

const A = 'a';
const B = 'b';

/** The invitation is minted, sent and (when accepted) accepted in one instant. */
const INVITED = at(0, 'invitation');
const EXPIRES = at(7 * DAY, 'invitation');

type Line = [ScenarioMessageRole, string, JourneyPhase];

const lines = (rows: Line[], when: (i: number) => Stamp): ScenarioMessage[] =>
  rows.map(([role, content, phase], i) => ({ role, content, phase, at: when(i) }));

const sec = (n: number) => at(n * 1000);

// ============================================================================
// Shared content
// ============================================================================

export const ADA_EMPATHY_STATEMENT =
  'I understand you might be feeling stressed from work. I want us to support each other better.';

/** Bob's HELD attempt in RECONCILER_SHOWN_B. */
export const BOB_HELD_EMPATHY_STATEMENT =
  'I understand that Riley may feel alone with the household work and want their effort to be noticed.';

const ADA_STORY: string[] = [
  "Hi, I'm having issues with my partner.",
  "I'm glad you reached out. Tell me more about what's happening.",
  'We argue about household chores constantly.',
  'That sounds frustrating. Would you like to invite your partner?',
  'Yes, I sent the invitation.',
  "Great. Let's continue exploring your perspective while we wait.",
  "I feel like I do most of the work and they don't notice.",
  "I hear you. Do you feel like I understand what you've been experiencing?",
  'Yes, I feel heard now.',
  "I'm glad. Now let's build some empathy for your partner's perspective.",
  "I think they're stressed from work too.",
  "That's a thoughtful observation. Here's an empathy statement you could share...",
];

/** Ada's story alternates USER/AI, starting with USER. */
const adaStory = (phases: JourneyPhase[], when: (i: number) => Stamp): ScenarioMessage[] =>
  lines(
    ADA_STORY.map((content, i) => [i % 2 === 0 ? 'USER' : 'AI', content, phases[i]] as Line),
    when,
  );

const ADA_STORY_PHASES: JourneyPhase[] = [
  'onboarding',
  'onboarding',
  'witness',
  'witness',
  'witness',
  'witness',
  'witness',
  'witness',
  'witness',
  'perspective',
  'perspective',
  'perspective',
];

/** Bob's story alternates AI/USER, starting with the AI's welcome. */
const bobStory = (adaName: string): Line[] => [
  ['AI', `Welcome! ${adaName} invited you to work through some challenges together.`, 'onboarding'],
  ['USER', 'Things have been tense lately between us.', 'onboarding'],
  ['AI', "I hear you. Tell me more about what's been happening.", 'witness'],
  ['USER', "I feel like they don't see how much I'm dealing with at work.", 'witness'],
  ['AI', 'That sounds really hard. Can you tell me more?', 'witness'],
  ['USER', "I work so hard and come home exhausted, but there's always more to do.", 'witness'],
  ['AI', 'I understand. How long has this been going on?', 'witness'],
  ['USER', "Months now. I don't know how to get through to them.", 'witness'],
  ['AI', "Do you feel like I understand what you've been going through?", 'witness'],
  ['USER', 'Yes, I feel heard.', 'witness'],
];

export const SHARE_CONTENT =
  "I feel like I'm running on empty - exhausted from work every day, and then coming home to more tasks. What I really need is for someone to see how hard I'm trying, even when I don't have anything left to give.";

/** `a` guessed about `b` (names); `guesser`/`subject` are their participant keys. */
const reconcilerResult = (a: string, b: string, when: Stamp, guesser = A, subject = B) => ({
  guesser,
  subject,
  at: when,
  alignmentScore: 45,
  alignmentSummary: `${a}'s empathy attempt captures some elements but misses key aspects of ${b}'s experience.`,
  correctlyIdentified: ['stress', 'work pressure'],
  gapSeverity: 'significant',
  gapSummary: `${a} hasn't fully grasped the depth of ${b}'s exhaustion and feeling unseen.`,
  missedFeelings: ['exhaustion', 'feeling unseen', 'overwhelm'],
  misattributions: [],
  mostImportantGap: `${b} feels exhausted and unseen, not just stressed.`,
  recommendedAction: 'OFFER_SHARING',
  rationale: `Sharing specific context would help ${a} understand ${b}'s perspective better.`,
  sharingWouldHelp: true,
  suggestedShareFocus: 'The exhaustion from work and feeling unseen.',
  suggestedShareContent: SHARE_CONTENT,
  suggestedShareReason: `This helps ${a} understand that ${b}'s frustration comes from exhaustion and feeling unseen, not anger or blame.`,
});

const heldEmpathy = (statement: string, status: EmpathyContent['status'], statementInChat = true): EmpathyContent => ({
  statement,
  status,
  consentRecorded: true,
  statementInChat,
});

/**
 * Ada, Stage 2 waiting on Bob (FEEL_HEARD_B / RECONCILER_SHOWN_B / CONTEXT_SHARED_B):
 * started -180s, signed -150s, felt heard -120s, submitted empathy -90s.
 */
const adaWaitingInStage2 = (status: EmpathyContent['status']): ParticipantScenario => ({
  key: A,
  journey: { startedAt: sec(-180) },
  milestones: {
    invitation_sent: INVITED,
    compact_signed: sec(-150),
    feel_heard: sec(-120),
    empathy_submitted: sec(-90),
  },
  messages: adaStory(ADA_STORY_PHASES, i => at(-180000 + i * 5000)),
  empathy: heldEmpathy(ADA_EMPATHY_STATEMENT, status),
});

/** Bob joined at -90s and signed at -60s. */
const bobFeltHeard = (feltHeardAt: Stamp, ada: string, extra: Line[] = []): ParticipantScenario => ({
  key: B,
  journey: { startedAt: sec(-90) },
  milestones: { compact_signed: sec(-60), feel_heard: feltHeardAt },
  messages: lines([...bobStory(ada), ...extra], i => at(-90000 + i * 5000)),
});

// ============================================================================
// Scenarios
// ============================================================================

type Build = (names: Required<ScenarioNames>) => Omit<Scenario, 'name' | 'invitation'> & {
  invitation?: Scenario['invitation'];
};

/** Both partners are in and the invitation is accepted. */
const ACCEPTED = { acceptedAt: INVITED, expiresAt: EXPIRES };

const BUILDERS: Record<TargetStage, Build> = {
  [TargetStage.CREATED]: () => ({
    participants: [
      { key: A, journey: {}, milestones: {} },
      { key: B, milestones: {} },
    ],
  }),

  [TargetStage.INVITATION_READY]: () => ({
    topic: { frame: 'How we repair after a tense dinner conversation', confirmedAt: at(0, 'session') },
    participants: [
      { key: A, journey: {}, milestones: { invitation_sent: INVITED } },
      { key: B, milestones: {} },
    ],
  }),

  // Bob has not accepted yet: attached to the relationship, no progress.
  [TargetStage.EMPATHY_SHARED_A]: () => ({
    participants: [
      {
        key: A,
        journey: { startedAt: sec(-120) },
        milestones: {
          invitation_sent: INVITED,
          compact_signed: sec(-60),
          feel_heard: sec(-30),
          empathy_submitted: at(0),
        },
        messages: adaStory(
          ADA_STORY.map((_, i) => (i < 4 ? 'onboarding' : 'witness')),
          i => at(-(ADA_STORY.length - i) * 5000),
        ),
        empathy: heldEmpathy(ADA_EMPATHY_STATEMENT, 'HELD'),
      },
      { key: B, milestones: {} },
    ],
  }),

  // Reconciler not yet run: the test drives it.
  [TargetStage.FEEL_HEARD_B]: ({ a }) => ({
    invitation: ACCEPTED,
    participants: [adaWaitingInStage2('HELD'), bobFeltHeard(at(0), a)],
  }),

  // Reconciler ran (-5s) with significant gaps; the share offer is OFFERED to Bob.
  [TargetStage.RECONCILER_SHOWN_B]: ({ a, b }) => {
    const bob = bobFeltHeard(sec(-30), a);
    bob.milestones.empathy_submitted = sec(-30);
    // Bob's own attempt keeps the mobile share-offer fetch gate open, which only
    // requests pending offers once the user has submitted empathy.
    bob.empathy = heldEmpathy(BOB_HELD_EMPATHY_STATEMENT, 'HELD', false);
    return {
      invitation: ACCEPTED,
      participants: [adaWaitingInStage2('AWAITING_SHARING'), bob],
      reconciliation: {
        result: reconcilerResult(a, b, sec(-5)),
        shareOffer: { status: 'OFFERED', suggestedContent: SHARE_CONTENT },
      },
    };
  },

  // Bob accepted the suggestion and shared context (now); Ada can refine.
  [TargetStage.CONTEXT_SHARED_B]: ({ a, b }) => ({
    invitation: ACCEPTED,
    participants: [
      adaWaitingInStage2('REFINING'),
      bobFeltHeard(sec(-30), a, [['AI', `Good. Now let's work on understanding ${a}'s perspective.`, 'perspective']]),
    ],
    reconciliation: {
      result: reconcilerResult(a, b, sec(-10)),
      shareOffer: {
        status: 'ACCEPTED',
        suggestedContent: SHARE_CONTENT,
        shared: { content: SHARE_CONTENT, at: at(0) },
        deliveredAt: at(0),
      },
      // intro (oldest) → SHARED_CONTEXT → reflection (newest), 100ms apart for Ada;
      // Bob sees what he shared, then the acknowledgement 1ms later.
      messages: [
        {
          to: A,
          role: 'AI',
          content: `${b} hasn't seen your empathy statement yet because the reconciler suggested they share more. This is what they shared:`,
          phase: 'perspective',
          at: at(-200),
        },
        { to: A, from: B, role: 'SHARED_CONTEXT', content: SHARE_CONTENT, phase: 'perspective', at: at(-100) },
        {
          to: A,
          role: 'AI',
          content: `How does this land for you? Take a moment to reflect on what ${b} shared. Does this give you any new insight into what they might be experiencing?`,
          phase: 'perspective',
          at: at(0),
        },
        { to: B, from: B, role: 'SHARED_CONTEXT', content: SHARE_CONTENT, phase: 'perspective', at: at(0) },
        {
          to: B,
          role: 'AI',
          content: `You shared this to help ${a} understand. They'll see it soon.`,
          phase: 'perspective',
          at: at(1),
        },
      ],
    },
  }),

  // Both attempts revealed (-50s) and validated; Stage 2 complete now.
  [TargetStage.EMPATHY_REVEALED]: () => {
    const revealed = (statement: string, validatedBy: string, validatedAt: Stamp): EmpathyContent => ({
      statement,
      status: 'VALIDATED',
      revealedAt: sec(-50),
      deliveredAt: sec(-50),
      consentRecorded: true,
      statementInChat: true,
      validatedBy: { participant: validatedBy, at: validatedAt },
    });
    const signedAndHeard = { compact_signed: sec(-180), feel_heard: sec(-150), empathy_validated: at(0) };
    return {
      invitation: ACCEPTED,
      participants: [
        {
          key: A,
          journey: { startedAt: sec(-200) },
          milestones: { invitation_sent: INVITED, ...signedAndHeard, empathy_submitted: sec(-120) },
          empathy: revealed(
            "I understand you're feeling overwhelmed with work and home responsibilities. You need to feel seen and appreciated for all your efforts.",
            B,
            sec(-30),
          ),
        },
        {
          key: B,
          journey: { startedAt: sec(-200) },
          milestones: { ...signedAndHeard, empathy_submitted: sec(-90) },
          empathy: revealed(
            "I hear that you're frustrated about household chores and feeling like you carry more of the burden. You want appreciation and partnership.",
            A,
            sec(-60),
          ),
        },
      ],
    };
  },

  [TargetStage.NEED_MAPPING_COMPLETE]: () => needMappingComplete(),

  // The whole journey complete under the legacy ranking flow; the agreement is confirmed now.
  //
  // Stage 4 ends at `choices_shared` (OD5, plan step 7: a COMPLETED stage-4 row
  // decodes as `choices_shared`). There is no session closure, so nobody has
  // reached `closed`; the current-shape writer encodes the legacy completion
  // (ranking + agreement) as the COMPLETED stage-4 row.
  [TargetStage.STRATEGIC_REPAIR_COMPLETE]: () => {
    const journey: Partial<Record<MilestoneKey, Stamp>> = {
      compact_signed: sec(-350),
      feel_heard: sec(-320),
      empathy_validated: sec(-300),
      needs_confirmed: sec(-240),
      needs_validated: sec(-180),
      needs_shared: sec(-150),
      choices_shared: at(0),
    };
    return {
      invitation: ACCEPTED,
      currentShape: {
        untimedGates: ['compact_signed', 'feel_heard', 'empathy_validated', 'needs_confirmed', 'needs_validated'],
        batchNeeds: true,
      },
      participants: [
        {
          key: A,
          journey: { startedAt: sec(-400) },
          milestones: { invitation_sent: INVITED, ...journey },
          needs: ADA_NEEDS,
          ranking: { proposals: ['checkin', 'appreciation', 'decompress'], submittedAt: sec(-90) },
        },
        {
          key: B,
          journey: { startedAt: sec(-400) },
          milestones: { ...journey },
          needs: BOB_NEEDS,
          ranking: { proposals: ['appreciation', 'checkin', 'decompress'], submittedAt: sec(-90) },
        },
      ],
      legacyStrategies: {
        strategies: [
          {
            key: 'checkin',
            by: A,
            description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
            needsAddressed: ['Appreciation', 'Partnership'],
            duration: 'ongoing',
            at: sec(-120),
          },
          {
            key: 'appreciation',
            by: B,
            description: 'Express appreciation for at least one thing your partner did each day',
            needsAddressed: ['Recognition'],
            duration: 'ongoing',
            at: sec(-120),
          },
          {
            key: 'decompress',
            by: A,
            description: 'Take 10 minutes to decompress when arriving home before discussing responsibilities',
            needsAddressed: ['Emotional safety'],
            duration: 'ongoing',
            at: sec(-120),
          },
        ],
        agreement: {
          proposal: 'checkin',
          description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
          type: 'COMMITMENT',
          status: 'AGREED',
          agreedBy: [A, B],
          agreedAt: at(0),
          followUpAt: at(14 * DAY),
        },
      },
    };
  },

  [TargetStage.STAGE4_REDESIGN_INVENTORY]: () => repairRedesign({}),

  [TargetStage.STAGE4_REDESIGN_SHARED_SELECTIONS]: () =>
    repairRedesign({
      [A]: [
        { proposal: 'checkin', decision: 'WILLING' },
        { proposal: 'pause', decision: 'NOT_WILLING' },
        { proposal: 'individual', decision: 'WILLING' },
      ],
      [B]: [
        { proposal: 'checkin', decision: 'WILLING' },
        { proposal: 'pause', decision: 'NOT_WILLING' },
      ],
    }),

  [TargetStage.STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS]: () =>
    repairRedesign({
      [A]: [
        { proposal: 'checkin', decision: 'WILLING' },
        { proposal: 'pause', decision: 'NOT_WILLING' },
        { proposal: 'individual', decision: 'WILLING' },
      ],
      [B]: [
        { proposal: 'checkin', decision: 'NOT_WILLING' },
        { proposal: 'pause', decision: 'WILLING' },
      ],
    }),

  [TargetStage.STAGE4_REDESIGN_PARTNER_INACTIVE]: () =>
    repairRedesign({ [A]: [{ proposal: 'checkin', decision: 'WILLING' }] }),

  // FEEL_HEARD_B, plus Ada's reflection linked to the session and the prompts
  // captured for her reflection turn and for Bob's last session turn.
  [TargetStage.INNER_WORK_LINKED_A]: ({ a }) => {
    const ada = adaWaitingInStage2('HELD');
    ada.reflections = [adaReflection(sec(-100))];
    ada.promptCaptures = [adaReflectionCapture(sec(-95))];
    const bob = bobFeltHeard(at(0), a);
    bob.promptCaptures = [bobSessionCapture(bob, at(-1))];
    return { invitation: ACCEPTED, participants: [ada, bob] };
  },

  // Stage 3 for both: needs confirmed, nothing shared or validated yet.
  [TargetStage.NEEDS_CONFIRMED]: () => {
    const s = needMappingComplete();
    for (const p of s.participants) {
      delete p.milestones.needs_validated;
      delete p.milestones.needs_shared;
    }
    return s;
  },

  [TargetStage.TOMBSTONE_READY]: ({ a, b }) => tombstoneReady(a, b),
};

// ============================================================================
// TS-5 content: Inner Work, prompt captures, shared needs
// ============================================================================

/**
 * Ada's private reflection. Every string here is a privacy probe: none of it
 * may ever reach Bob (golden R1, spec §7 "a prompt built for participant X
 * contains only X's private material").
 */
export const ADA_REFLECTION = {
  title: 'Keeping score like my mother did',
  theme: 'inherited resentment about rest',
  summary: 'Ada traced her scorekeeping about chores to watching her mother never rest, and is afraid of repeating it.',
  userLine: 'I keep a silent tally of every dish because my mother never sat down once in thirty years.',
  aiLine: 'It sounds like the tally protects you from becoming her, and it also keeps you braced for unfairness.',
};

function adaReflection(when: Stamp): ReflectionContent {
  return {
    title: ADA_REFLECTION.title,
    theme: ADA_REFLECTION.theme,
    summary: ADA_REFLECTION.summary,
    linkedToSession: true,
    at: when,
    messages: [
      { role: 'USER', content: ADA_REFLECTION.userLine, at: { ...when, offsetMs: when.offsetMs + 1000 } },
      { role: 'AI', content: ADA_REFLECTION.aiLine, at: { ...when, offsetMs: when.offsetMs + 2000 } },
    ],
  };
}

/** The prompt captured for Ada's reflection turn: her own private material, legitimately. */
function adaReflectionCapture(when: Stamp): PromptCapture {
  return {
    scope: { reflection: 0 },
    callType: 'WITNESSING_RESPONSE',
    at: when,
    input: {
      systemPrompt: `You are Ada's private reflection guide. Reflection theme: ${ADA_REFLECTION.theme}.`,
      messages: [{ role: 'user', content: ADA_REFLECTION.userLine }],
    },
    output: ADA_REFLECTION.aiLine,
  };
}

/** The prompt captured for a participant's last session turn: their own conversation only. */
function bobSessionCapture(p: ParticipantScenario, when: Stamp): PromptCapture {
  const msgs = p.messages ?? [];
  return {
    scope: 'session',
    callType: 'ORCHESTRATED_RESPONSE',
    at: when,
    input: {
      systemPrompt: 'You are a calm facilitator witnessing Bob in his private conversation. Stage: witness.',
      messages: msgs.map(m => ({ role: m.role === 'USER' ? ('user' as const) : ('assistant' as const), content: m.content })),
    },
    output: msgs[msgs.length - 1]?.content ?? '',
  };
}

/** Text each partner's shared needs carry in the target (`need_share.shared_text`). */
const shareNeeds = (needs: typeof ADA_NEEDS, texts: string[]) =>
  needs.map((n, i) => ({ ...n, shared: { text: texts[i] } }));

/**
 * Golden R5's starting state: the legacy journey finished (STRATEGIC_REPAIR_COMPLETE's
 * shape, timed gates), with both attempts revealed and validated, Ada's shared
 * context delivered into Bob's conversation, both partners' needs shared, private
 * chat for both, Ada's reflection, and prompt captures for Ada's session and
 * reflection turns and Bob's session turn. The session is still ACTIVE.
 */
function tombstoneReady(a: string, b: string): ReturnType<Build> {
  const journey: Partial<Record<MilestoneKey, Stamp>> = {
    compact_signed: sec(-350),
    feel_heard: sec(-320),
    empathy_validated: sec(-300),
    needs_confirmed: sec(-240),
    needs_validated: sec(-180),
    needs_shared: sec(-150),
    choices_shared: at(0),
  };
  const revealed = (statement: string, validatedBy: string, validatedAt: Stamp): EmpathyContent => ({
    statement,
    status: 'VALIDATED',
    revealedAt: sec(-305),
    deliveredAt: sec(-305),
    consentRecorded: true,
    statementInChat: true,
    validatedBy: { participant: validatedBy, at: validatedAt },
  });
  const ada: ParticipantScenario = {
    key: A,
    journey: { startedAt: sec(-400) },
    milestones: { invitation_sent: INVITED, ...journey, empathy_submitted: sec(-315) },
    messages: lines(
      [
        ['USER', 'I am tired of being the only one who notices the laundry.', 'witness'],
        ['AI', 'That sounds lonely. What do you wish your partner noticed?', 'witness'],
        ['USER', 'That I am exhausted too, and I never get to say so.', 'witness'],
      ],
      i => at(-390000 + i * 5000),
    ),
    empathy: revealed(TOMBSTONE_TEXT.adaEmpathy, B, sec(-302)),
    needs: shareNeeds(ADA_NEEDS, TOMBSTONE_TEXT.adaNeedShares),
    ranking: { proposals: ['checkin', 'appreciation'], submittedAt: sec(-90) },
    reflections: [adaReflection(sec(-380))],
  };
  ada.promptCaptures = [
    {
      scope: 'session',
      callType: 'ORCHESTRATED_RESPONSE',
      at: sec(-375),
      input: {
        systemPrompt: 'You are a calm facilitator witnessing Ada in her private conversation. Stage: witness.',
        messages: (ada.messages ?? []).map(m => ({
          role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
          content: m.content,
        })),
      },
      output: 'I hear how tired you are.',
    },
    adaReflectionCapture(sec(-370)),
  ];
  const bob: ParticipantScenario = {
    key: B,
    journey: { startedAt: sec(-400) },
    milestones: { ...journey, empathy_submitted: sec(-312) },
    messages: lines(
      [
        ['USER', 'Work has been brutal and I come home with nothing left.', 'witness'],
        ['AI', 'Coming home empty sounds hard. What happens next?', 'witness'],
      ],
      i => at(-388000 + i * 5000),
    ),
    empathy: revealed(TOMBSTONE_TEXT.bobEmpathy, A, sec(-303)),
    needs: shareNeeds(BOB_NEEDS, TOMBSTONE_TEXT.bobNeedShares),
    ranking: { proposals: ['appreciation', 'checkin'], submittedAt: sec(-90) },
  };
  bob.promptCaptures = [bobSessionCapture(bob, sec(-360))];
  return {
    invitation: ACCEPTED,
    participants: [ada, bob],
    // Bob's guess about Ada had gaps; Ada shared context, delivered to Bob.
    reconciliation: {
      result: reconcilerResult(b, a, sec(-311), B, A),
      shareOffer: {
        status: 'ACCEPTED',
        suggestedContent: TOMBSTONE_TEXT.adaSharedContext,
        shared: { content: TOMBSTONE_TEXT.adaSharedContext, at: sec(-310) },
        deliveredAt: sec(-310),
      },
      messages: [
        { to: B, from: A, role: 'SHARED_CONTEXT', content: TOMBSTONE_TEXT.adaSharedContext, phase: 'perspective', at: sec(-310) },
        { to: A, from: A, role: 'SHARED_CONTEXT', content: TOMBSTONE_TEXT.adaSharedContext, phase: 'perspective', at: sec(-310) },
      ],
    },
    legacyStrategies: {
      strategies: [
        {
          key: 'checkin',
          by: A,
          description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
          needsAddressed: ['Appreciation', 'Partnership'],
          duration: 'ongoing',
          at: sec(-120),
        },
        {
          key: 'appreciation',
          by: B,
          description: 'Express appreciation for at least one thing your partner did each day',
          needsAddressed: ['Recognition'],
          duration: 'ongoing',
          at: sec(-120),
        },
      ],
      agreement: {
        proposal: 'checkin',
        description: 'Weekly check-in on Sundays to discuss upcoming week and divide tasks',
        type: 'COMMITMENT',
        status: 'AGREED',
        agreedBy: [A, B],
        agreedAt: at(0),
        followUpAt: at(14 * DAY),
      },
    },
  };
}

/** TOMBSTONE_READY's distinctive content (golden R5 asserts where each survives). */
export const TOMBSTONE_TEXT = {
  adaEmpathy: 'I think you come home hollowed out and the chores feel like a verdict on you.',
  bobEmpathy: 'I think you feel invisible when you are the only one tracking the house.',
  adaSharedContext: 'What I need you to know is that I am exhausted too, and I stopped saying it because it never seemed to count.',
  adaNeedShares: ['Ada wants her effort to be noticed out loud.', 'Ada wants the house to feel like a joint project.'],
  bobNeedShares: ['Bob wants to be understood before being asked for more.', 'Bob wants practical help on hard work days.'],
};

const need = (n: string, category: 'RECOGNITION' | 'FAIRNESS' | 'CONNECTION') => ({
  need: n,
  category,
  aiConfidence: 0.95,
  confirmed: true,
});
const ADA_NEEDS = [need('Appreciation', 'RECOGNITION'), need('Partnership', 'FAIRNESS')];
const BOB_NEEDS = [need('Understanding', 'CONNECTION'), need('Support', 'CONNECTION')];

/** Stages 0–3 complete for both (Stage 3 now); both in Stage 4. */
function needMappingComplete(): ReturnType<Build> {
  const milestones: Partial<Record<MilestoneKey, Stamp>> = {
    compact_signed: sec(-300),
    feel_heard: sec(-240),
    empathy_validated: sec(-120),
    needs_confirmed: sec(-60),
    needs_validated: sec(-30),
    needs_shared: at(0),
  };
  const attempt = (statement: string): EmpathyContent => ({
    statement,
    status: 'VALIDATED',
    consentRecorded: false,
    statementInChat: false,
  });
  return {
    invitation: ACCEPTED,
    currentShape: { untimedGates: ['compact_signed', 'feel_heard', 'empathy_validated'] },
    participants: [
      {
        key: A,
        journey: { startedAt: sec(-350) },
        milestones: { invitation_sent: INVITED, ...milestones, empathy_submitted: sec(-180) },
        empathy: attempt("I understand you're feeling overwhelmed with work and home responsibilities."),
        needs: ADA_NEEDS,
      },
      {
        key: B,
        journey: { startedAt: sec(-350) },
        milestones: { ...milestones, empathy_submitted: sec(-150) },
        empathy: attempt(
          "I hear that you're frustrated about household chores and feeling like you carry more of the burden.",
        ),
        needs: BOB_NEEDS,
      },
    ],
  };
}

const REPAIR_REVISION_REASON = 'E2E redesigned Stage 4 fixture';

const REPAIR_CONTENT: RepairContent = {
  proposals: [
    {
      key: 'checkin',
      by: A,
      description: 'Try a Sunday evening planning check-in for the next two weeks',
      needsAddressed: ['Partnership', 'Support'],
      duration: 'Two weeks',
      measureOfSuccess: 'Both people know the week plan before Monday',
      kind: 'SHARED_PROPOSAL',
      coverageSummary: { fixture: 'shared-agreement-with-tending' },
    },
    {
      key: 'pause',
      by: B,
      description: 'Use a pause phrase when either person starts to shut down',
      needsAddressed: ['Understanding'],
      duration: 'One month',
      measureOfSuccess: 'Hard conversations can pause without either person feeling abandoned',
      kind: 'SHARED_PROPOSAL',
      coverageSummary: { fixture: 'alternate-shared-proposal' },
    },
    {
      key: 'individual',
      by: A,
      description: 'I will name when I am overloaded before I disappear',
      needsAddressed: ['Appreciation'],
      duration: 'This week',
      measureOfSuccess: 'Stress is named before withdrawal',
      kind: 'INDIVIDUAL_COMMITMENT',
      coverageSummary: { fixture: 'individual-only-commitment' },
    },
    {
      key: 'spreadsheet',
      by: B,
      description: 'Track every chore in a shared spreadsheet every night',
      needsAddressed: ['Partnership'],
      duration: 'One week',
      measureOfSuccess: 'Every chore is logged',
      kind: 'SHARED_PROPOSAL',
      coverageSummary: { fixture: 'removed-proposal' },
      removed: { by: B, at: at(0, 'late'), reason: 'Partner said this felt too controlling' },
    },
  ],
  revisions: [
    {
      proposal: 'checkin',
      actor: A,
      action: 'CREATED',
      after: { description: 'Try a Sunday evening planning check-in for the next two weeks' },
      reason: REPAIR_REVISION_REASON,
    },
    {
      proposal: 'pause',
      actor: B,
      action: 'CREATED',
      after: { description: 'Use a pause phrase when either person starts to shut down' },
      reason: REPAIR_REVISION_REASON,
    },
    {
      proposal: 'individual',
      actor: A,
      action: 'CREATED',
      after: { description: 'I will name when I am overloaded before I disappear' },
      reason: REPAIR_REVISION_REASON,
    },
    {
      proposal: 'spreadsheet',
      actor: B,
      action: 'REMOVED',
      before: { status: 'ACTIVE' },
      after: { status: 'REMOVED' },
      reason: REPAIR_REVISION_REASON,
    },
  ],
  coverage: [
    {
      needLabel: 'Partnership',
      source: A,
      coverageStatus: 'COVERED',
      coveringProposals: ['checkin'],
      note: 'Sunday planning check-in directly covers partnership.',
    },
    {
      needLabel: 'Support',
      source: B,
      coverageStatus: 'PARTIAL',
      coveringProposals: ['checkin', 'pause'],
      note: 'Support is partly covered but may need more specificity.',
    },
    {
      needLabel: 'Appreciation',
      source: A,
      coverageStatus: 'OPEN',
      coveringProposals: [],
      note: 'No active shared proposal directly covers appreciation yet.',
    },
  ],
};

/**
 * Redesigned Stage 4 on top of NEED_MAPPING_COMPLETE. Its content is stamped on
 * the `late` clock (read after the Stage 3 data), as are the participants' choices.
 */
function repairRedesign(choices: Record<string, ParticipantScenario['choices']>): ReturnType<Build> {
  const s = needMappingComplete();
  for (const p of s.participants) {
    const mine = choices[p.key];
    if (mine?.length) {
      p.choices = mine;
      p.milestones.choices_shared = at(0, 'late');
    }
  }
  return { ...s, repair: REPAIR_CONTENT };
}

/**
 * Two-participant scenarios when no partner account was supplied. The old
 * factory still marked the session ACTIVE and the invitation ACCEPTED, but wrote
 * no journey for anyone.
 */
const PARTNER_REQUIRED = new Set<TargetStage>([
  TargetStage.FEEL_HEARD_B,
  TargetStage.RECONCILER_SHOWN_B,
  TargetStage.CONTEXT_SHARED_B,
  TargetStage.EMPATHY_REVEALED,
  TargetStage.NEED_MAPPING_COMPLETE,
  TargetStage.STRATEGIC_REPAIR_COMPLETE,
  TargetStage.STAGE4_REDESIGN_INVENTORY,
  TargetStage.STAGE4_REDESIGN_SHARED_SELECTIONS,
  TargetStage.STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS,
  TargetStage.STAGE4_REDESIGN_PARTNER_INACTIVE,
  TargetStage.INNER_WORK_LINKED_A,
  TargetStage.NEEDS_CONFIRMED,
  TargetStage.TOMBSTONE_READY,
]);

export function scenarioFor(stage: TargetStage, names: ScenarioNames): Scenario {
  const build = BUILDERS[stage];
  if (!build) throw new Error(`Unknown target stage: ${stage}`);

  if (names.b === undefined && PARTNER_REQUIRED.has(stage)) {
    return {
      name: stage,
      invitation: ACCEPTED,
      participants: [{ key: A, milestones: { invitation_sent: INVITED } }],
    };
  }

  const built = build({ a: names.a, b: names.b ?? '' });
  const participants = names.b === undefined ? built.participants.filter(p => p.key !== B) : built.participants;
  return {
    ...built,
    name: stage,
    invitation: built.invitation ?? { expiresAt: EXPIRES },
    participants,
  };
}
