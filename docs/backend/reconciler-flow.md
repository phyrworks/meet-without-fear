---
title: "Stage 2: Perspective Stretch - Empathy Exchange Flow"
sidebar_position: 6
description: This document describes the empathy exchange flow in Stage 2, including the reconciler system that analyzes empathy accuracy and manages the sharing of addit...
created: 2026-03-11
updated: 2026-05-12
status: living
---
# Stage 2: Perspective Stretch - Empathy Exchange Flow

This document describes the empathy exchange flow in Stage 2, including the reconciler system that analyzes empathy accuracy and manages the sharing of additional context.

## Overview

In Stage 2, both users work to imagine each other's perspective. Each user:
1. Chats with AI to develop their attempt to imagine their partner's experience
2. Creates an empathy statement expressing that attempt
3. Shares the statement with their partner
4. Receives validation feedback on their empathy attempt

The **Reconciler** analyzes how well each person's attempt resonated with the other and may suggest sharing additional context to help bridge gaps.

## On the target schema (TS-10, phoenix/target-shape)

The flow below is unchanged in product terms; the data layer under it is the target schema
(`docs/backend/data-model/schema-target-2026-10.md` §1.2–1.3):

- **Rounds.** An attempt is immutable: a resubmission is `app.empathy_set_status(round n,
  'SUPERSEDED', content)`, which inserts round n+1 (HELD). There is no ANALYZING or NEEDS_WORK
  status; the consent response still reports ANALYZING as a display status once both directions
  are submitted. The circuit breaker counts rounds.
- **Every status move** goes through `app.empathy_set_status` — the author's and subject's own
  moves on the app connection under their identity, the reconciler's moves and the reveal on the
  job connection (`mwf_job`, the only principal the function lets reveal; the function owns the
  gate and writes the subject's `EMPATHY_STATEMENT` copy). Reconciler moves are guarded by the
  attempt's `status_version`, so a late analysis never overwrites a newer decision.
- **Who sees what.** The waiting state comes from `v_empathy_direction_status`; a subject reads an
  attempt only once revealed. A `reconciler_result` is its subject's only — the author sees the
  direction's status and the abstract `reconciler_guidance`, never the analysis or the existence
  of an offer (`myReconcilerResult` is null; reconciler/status and /run return only the caller's
  subject-side analyses). The summary is built per participant from their own results (R24).
- **The offer** (`context_share_offer`) is the subject's: inserted by the job; answered by the
  subject with a `consent` row naming it (no requester); the shared text is delivered by the job
  as `SHARED_CONTEXT` in the author's conversation. The pending-actions read writes
  `delivery_notified_at` / `seen_notified_at`, so a delivery is counted once.

Code: `backend/src/services/empathy-store.ts` (the rules), `services/reconciler/*`,
`controllers/{stage2,reconciler,consent,notifications}.ts`.

## Empathy Attempt States

```mermaid
stateDiagram-v2
    [*] --> HELD: User shares empathy statement

    HELD --> READY: Reconciler finds minor/no gaps (direct)
    HELD --> AWAITING_SHARING: Reconciler finds significant gaps (direct)

    AWAITING_SHARING --> REFINING: Subject shares context
    REFINING --> READY: Guesser revises empathy (re-analyzed, circuit breaker forces READY)
    REFINING --> AWAITING_SHARING: Guesser revises empathy (re-analyzed, gaps still found)

    AWAITING_SHARING --> READY: Subject declines to share

    READY --> REVEALED: Both directions are READY (mutual reveal)

    REVEALED --> VALIDATED: Subject validates empathy as accurate
    REVEALED --> REFINING: Subject sends Feedback Coach validation feedback (VALIDATION_FEEDBACK_SENT)
    REFINING --> VALIDATED: Guesser accepts remaining difference (skip-refinement)

    note right of HELD
        The ANALYZING state exists in empathy-state-machine.ts
        but is never triggered by the reconciler code.
        The reconciler transitions directly from HELD
        to READY or AWAITING_SHARING.
    end note

    note right of REVEALED
        NEEDS_WORK is marked as legacy in Prisma schema.
        Validation feedback uses the VALIDATION_FEEDBACK_SENT
        event, REFINING status, and a targeted
        VALIDATION_FEEDBACK chat message.
    end note

    VALIDATED --> [*]
```

> **Mutual Reveal**: Empathy statements are only revealed when BOTH users have completed Stage 2 and had their empathy analyzed. The `READY` status means "reconciler complete, waiting for partner to also finish Stage 2".

> **Quality Commentary at Reveal**: At mutual reveal time, `checkAndRevealBothIfReady()` also creates an AI quality message for each subject (the person reviewing their partner's empathy attempt). The message is tailored to the `gapSeverity` from the latest non-superseded `ReconcilerResult` for that direction (guesser → subject): moderate/significant gaps generate a message noting the attempt may not fully capture everything and encouraging feedback; no/minor gaps generate a simpler "ready to review" prompt. This runs as a best-effort side effect — errors are logged as warnings and do not block the reveal.

## Share Offer States

The `ReconcilerShareOffer` tracks the suggestion lifecycle:

```mermaid
stateDiagram-v2
    [*] --> NOT_OFFERED: No offer made (legacy/default)
    [*] --> PENDING: Reconciler creates offer

    PENDING --> OFFERED: User fetches offer (GET /reconciler/share-offer)
    PENDING --> OFFERED: User responds before fetching
    PENDING --> ACCEPTED: User accepts (from drawer without GET)
    PENDING --> EXPIRED: Offer times out

    OFFERED --> ACCEPTED: User accepts suggestion
    OFFERED --> DECLINED: User declines to share
    OFFERED --> EXPIRED: Offer times out
    OFFERED --> SKIPPED: System skips (legacy edge case)

    ACCEPTED --> [*]: Context shared with partner
    DECLINED --> [*]: Empathy revealed without context
    EXPIRED --> [*]
    SKIPPED --> [*]
    NOT_OFFERED --> [*]
```

## Reconciler Flow

The reconciler runs when one user confirms "feel heard" (completing Stage 1) and their partner has an empathy attempt in `HELD` status.

> **Implementation Note:** The reconciler has been refactored into a modular `backend/src/services/reconciler/` directory:
> - `state.ts` — Empathy status transitions, reveal logic. Contains `runReconcilerForDirection()` (asymmetric) and `checkAndRevealBothIfReady()` (serializable transaction for mutual reveal).
> - `analysis.ts` — Core AI gap analysis (`analyzeEmpathyGap()`), theme extraction, witnessing content retrieval. It also loads the subject's `notableFacts` from UserVessel and a scoped Stage 2 subject hot buffer so later subject-owned shifts (for example, denial → confession) can update stale Stage 1 factual framing while preserving Stage 1 as the emotional anchor.
> - `sharing.ts` — Share suggestion generation, refinement, and response handling.
> - `circuit-breaker.ts` — Attempt counting to prevent infinite refinement loops (max 3 per direction).
> - `index.ts` — Barrel re-exports.
>
> Status transitions are formally validated by `backend/src/services/empathy-state-machine.ts` which enforces a strict transition table.
>
> **Message de-duplication:** `markEmpathyReady()` in `state.ts` checks whether the alignment message it would post is identical to the last AI message the Guesser already saw. If so, it updates the empathy status without creating a redundant chat line — preventing duplicate messages during multi-cycle refinement runs. The guard ignores targeted `VALIDATION_FEEDBACK` messages so partner feedback is not mistaken for an AI alignment message.
>
> **Redundant share-suggestion guard (API endpoint):** `generateShareOffer()` in `sharing.ts` calls `hasContextAlreadyBeenShared()` before generating a suggestion. If context was already shared in that direction, it returns `null`, and the API responds with `hasSuggestion: false` — preventing the Guesser from seeing a repeated offer message.
>
> **Reconciler processing guard:** `triggerReconcilerAndUpdateStatuses()` in `stage2.ts` independently calls `hasContextAlreadyBeenShared()`. If context was already shared, it calls `markResultHandledAlreadyShared()` and sets the guesser's status directly to `READY`, bypassing the `AWAITING_SHARING` step.

### Reconciler Decision Tree

```mermaid
flowchart TB
    subgraph Trigger["Trigger: Subject confirms 'feel heard'"]
        A["Subject clicks 'I feel heard'"]
    end

    A --> B{Partner has HELD<br/>empathy attempt?}
    B -->|No| C[No action needed]
    B -->|Yes| D[Run Reconciler Analysis]

    D --> E{Analyze gaps using<br/>witnessing + notableFacts<br/>+ Stage 2 subject hot buffer}

    E --> F{Gap Severity?}

    F -->|None/Minor + PROCEED| G[Mark as READY]
    F -->|Moderate + OFFER_OPTIONAL| G
    F -->|Significant + OFFER_SHARING| H[Create Share Suggestion]

    G --> I["Guesser sees:<br/>'Partner is considering<br/>your perspective'"]
    G --> J[Update status to READY]
    J --> CHECK{Both directions<br/>READY?}
    CHECK -->|Yes| REVEAL[Reveal both empathy<br/>statements simultaneously]
    CHECK -->|No| WAIT[Wait for partner to<br/>complete Stage 2]

    H --> K[Subject sees:<br/>Share Suggestion Panel]
    H --> L[Update status to AWAITING_SHARING]

    subgraph SubjectChoice["Subject's Choice"]
        K --> M{Accept suggestion?}
        M -->|Accept| N[Share context with guesser]
        M -->|Refine| O[Chat to revise suggestion]
        M -->|Decline| P[Skip sharing]
    end

    N --> Q[Guesser's empathy<br/>status → REFINING]
    O --> N
    P --> J

    Q --> R[Guesser revises<br/>empathy statement]
    R --> D
```

### Reconciler Actions by Gap Severity

| Gap Severity | Recommended Action | Effect on Guesser | Effect on Subject |
|--------------|-------------------|-------------------|-------------------|
| None | `PROCEED` | Status → READY (waiting for mutual reveal) | Continues with their empathy |
| Minor | `PROCEED` | Status → READY (waiting for mutual reveal) | Continues with their empathy |
| Moderate | `OFFER_OPTIONAL` | If AI returned a `suggestedShareFocus` → Status `AWAITING_SHARING` (Sharer gets a share prompt). If no `suggestedShareFocus` → treated as `PROCEED` (US-8 rule) and Status → `READY`. | Sees share suggestion panel when `AWAITING_SHARING`, otherwise continues |
| Significant | `OFFER_SHARING` | Status → `AWAITING_SHARING` | Sees share suggestion panel |

> **Note**: When both directions are in `READY` status, both empathy statements are revealed simultaneously. Neither user sees their partner's empathy until both have completed Stage 2.

> **UI Note:** The guesser sees a UX status message when their empathy status reaches READY
> (not at REVEALED as the earlier state diagram might suggest). The READY → REVEALED transition
> happens automatically when both directions are READY.

### Share Suggestion Generation Flow

```mermaid
sequenceDiagram
    participant Rec as Reconciler
    participant AI as AI (Sonnet)
    participant DB as Database
    participant Ably as Realtime

    Rec->>AI: Generate share suggestion<br/>(gap analysis + witnessing content)
    AI-->>Rec: { suggestedContent, reason }

    Rec->>DB: Find ReconcilerResult<br/>(retry up to 3x)

    alt Result found
        Rec->>DB: Update ReconcilerResult<br/>(suggestedShareContent, suggestedShareReason)
        Rec->>DB: Upsert ReconcilerShareOffer<br/>(status: PENDING, suggestedContent)
        Rec->>Ably: Publish empathy.share_suggestion
    else Result NOT found
        Note over Rec: CRITICAL: Suggestion lost!<br/>User won't see panel
    end
```

> **Implementation:** Share suggestion generation is handled by `reconciler/sharing.ts` which contains
> `generateShareSuggestion()`, `respondToShareSuggestion()`, `generatePostShareContinuation()`, and
> `generateContextReceivedReflection()`. The module includes delivery status tracking and fallback messages for AI failures.

## User Experience: Both Users' Perspective

### User A (Guesser) Flow

```mermaid
sequenceDiagram
    participant A as User A (Guesser)
    participant AI as AI Assistant
    participant System as Backend
    participant B as User B (Subject)

    Note over A,B: Stage 1 Complete - Both felt heard

    A->>AI: Chat about B's perspective
    Note over AI: Loads current empathy draft (if any) as editing context
    AI->>A: Guides empathy development / refines existing draft
    AI->>A: Proposes empathy statement

    A->>System: Share empathy statement
    System->>System: Create EmpathyAttempt (HELD)

    Note over A: Waiting for B to feel heard...

    B->>System: Confirms "I feel heard"
    System->>System: Run Reconciler for A→B

    alt Minor/No Gaps (PROCEED/OFFER_OPTIONAL)
        System->>A: "B is now considering your perspective"
        System->>System: Update status to READY
    else Significant Gaps (OFFER_SHARING)
        System->>B: Share suggestion panel appears
        alt B shares context
            B->>System: Shares additional context
            System->>A: Context notification + status → REFINING
            A->>AI: Chat to revise understanding
            AI->>A: Updated empathy statement
            A->>System: Resubmit revised empathy
        else B declines
            B->>System: Declines to share
            System->>System: Reveal current empathy
        end
    end

    System->>B: Show A's empathy statement
    B->>System: Validate (validated: true/false, optional feedback)

    alt Validated as accurate
        System->>System: Status → VALIDATED
    else Validated as inaccurate
        System->>System: Status stays REVEALED (no status change)
        Note over System: NEEDS_WORK exists in schema for legacy<br/>compatibility but is never set by current code
    end
```

### Validation Flow (After Empathy Revealed)

```mermaid
sequenceDiagram
    participant Sub as Subject (Validator)
    participant UI as Validation Panel
    participant API as Backend
    participant Guesser as Guesser

    Note over Sub: Partner's empathy is REVEALED

    Sub->>UI: Opens validation panel
    UI->>Sub: Shows partner's empathy statement

    Sub->>UI: Chooses Accurate or Not quite yet

    alt Accurate
        UI->>API: POST /empathy/validate<br/>{ validated: true }
        API->>API: Status -> VALIDATED
        API->>Sub: Success response
        Note over Sub,Guesser: Both can proceed to Stage 3
    else Not quite yet
        Sub->>UI: Adds rough notes about what feels off
        UI->>API: POST /empathy/validation-feedback/draft
        API-->>UI: Feedback Coach draft
        Sub->>UI: Refines/approves coach message
        UI->>API: POST /empathy/validation-feedback/refine<br/>(optional iterations)
        UI->>API: POST /empathy/validate<br/>{ validated: false, feedback }
        API->>API: Status -> REFINING
        API->>API: Create AI framing message (role AI, forUserId=guesser)
        API->>API: Create feedback card (role VALIDATION_FEEDBACK, +100ms offset)
        API->>Guesser: empathy.status_updated<br/>with validationFeedback
    end
```

### Refinement Flow (When Validation Feedback Is Sent)

```mermaid
sequenceDiagram
    participant G as Guesser
    participant AI as AI Assistant
    participant API as Backend
    participant Sub as Subject

    Note over G: Empathy status is REFINING after targeted feedback

    G->>API: GET /empathy/status
    API-->>G: validationFeedback and refinementHint

    G->>AI: Chat to refine understanding
    AI->>G: Guidance based on validation feedback and gap analysis

    G->>AI: Draft revised empathy
    AI->>G: Proposes updated statement

    G->>API: POST /empathy/resubmit<br/>{ newContent }

    API->>API: Update EmpathyAttempt content
    API->>API: Re-run reconciler

    alt Still significant gaps
        API->>Sub: Share suggestion panel (if not declined before)
        Note over G: Wait for subject response
    else No significant gaps
        API->>API: Status → REVEALED
        API->>Sub: Show revised empathy for validation
    end

    alt Guesser accepts remaining difference
        G->>API: POST /empathy/skip-refinement<br/>{ willingToAccept: true }
        API->>API: Record accepted difference and unblock Stage 2 gate
    end
```

## UI State Machine

The chat input visibility and above-input panels are controlled by the waiting status:

```mermaid
stateDiagram-v2
    [*] --> Active: User enters Stage 2

    Active --> WitnessPending: Partner in Stage 1
    WitnessPending --> Active: Partner completes Stage 1

    Active --> PartnerConsidering: Reconciler finds minor/no gaps
    Active --> AwaitingContextShare: Reconciler finds significant gaps

    PartnerConsidering --> Active: Partner shares empathy

    AwaitingContextShare --> Active: User responds to share offer

    Active --> EmpathyPending: User consented, waiting for partner
    EmpathyPending --> PartnerSharedEmpathy: Partner shares
    PartnerSharedEmpathy --> Active: Show validation UI

    Active --> PartnerValidatingEmpathy: User validated, awaiting partner validation
    PartnerValidatingEmpathy --> Active: Partner validates

    Active --> PartnerRevisingEmpathy: User sent feedback, partner revising
    PartnerRevisingEmpathy --> Active: Partner resubmits

    state Active {
        [*] --> Chatting
        Chatting --> ViewingEmpathy: Tap "View your empathy attempt"
        ViewingEmpathy --> Chatting: Close drawer
        ViewingEmpathy --> Sharing: Tap "Share"
        Sharing --> Chatting: Confirmed
    }
```

## Input Visibility Rules

| Waiting Status | Hide Input? | Show Banner? | Show Inner Thoughts? |
|---------------|-------------|--------------|---------------------|
| `null` | No | No | Depends on stage |
| `witness-pending` | Yes | Yes | Yes |
| `empathy-pending` | Yes | Yes | Yes |
| `partner-considering-perspective` | Yes | Yes | Yes |
| `partner-validating-empathy` | Yes | Yes | Yes |
| `partner-revising-empathy` | Yes | Yes | Yes |
| `reconciler-analyzing` | Yes | Yes (with spinner) | Yes | <!-- Note: This UI state exists but the ANALYZING empathy status is never set by current code -->
| `awaiting-context-share` | No | Yes | No |
| `refining-empathy` | No | No | No |

## Panel Priority

Only one panel shows at a time, in this priority order:

1. **Compact Agreement Bar** - During onboarding
2. **Invitation Panel** - After signing, before sending invite
3. **Feel Heard Panel** - Stage 1 completion
4. **Share Suggestion Panel** - Subject must respond to share suggestion
5. **Accuracy Feedback Panel** - Partner's empathy available for validation
6. **Empathy Statement Panel** - User's empathy ready to review
7. **Waiting Banner** - Any waiting status

## Realtime Events

| Event | Trigger | Cache Invalidation | UI Update |
|-------|---------|-------------------|-----------|
| `empathy.status_updated` (status=`AWAITING_SHARING`) | Reconciler offers a share prompt (Moderate+focus or Significant gap) | `shareOffer`, `empathyStatus` | Show share suggestion panel (message: "&lt;name&gt; is considering a suggestion to share more") |
| `empathy.context_shared` | Subject shares additional context | `empathyStatus`, `shareOffer`, `messages` | Guesser sees shared context |
| `empathy.revealed` | Empathy revealed (mutual reveal — both directions READY) | `empathyStatus`, `partnerEmpathy` | Subject can validate; also triggers an AI quality commentary message for each subject based on `gapSeverity` of the corresponding reconciler result |
| `partner.stage_completed` | Partner completes a stage; Stage 2 validation emits this only for `validated=true` | `empathyStatus`, `progress` | Update waiting status |
| `partner.session_viewed` | Partner views session | `empathyStatus` (delivery status) | Update delivery indicator |
| `empathy.validated` | Partner validates empathy | `empathyStatus` | Show validation result |
| `empathy.status_updated` (status=`REFINING`) | Subject sends Feedback Coach validation feedback | `empathyStatus`, `messages` | Guesser sees targeted feedback and revision UI |

## Data Models

### EmpathyAttempt

```typescript
{
  id: string;
  sessionId: string;
  sourceUserId: string;       // The guesser
  draftId: string | null;     // FK to EmpathyDraft (the source draft)
  consentRecordId: string | null; // FK to ConsentRecord (consent to share)
  content: string;            // The empathy statement
  status: 'HELD' | 'ANALYZING' | 'AWAITING_SHARING' | 'REFINING' |
          'READY' | 'REVEALED' | 'VALIDATED' | 'NEEDS_WORK';
  // READY = reconciler complete, waiting for partner to also complete Stage 2
  // ANALYZING exists in empathy-state-machine.ts but is never set by the reconciler code
  // NEEDS_WORK exists for legacy compatibility but is never set by current code
  statusVersion: number;      // Incremented on every status change for event ordering
  sharedAt: Date;             // When initially shared
  revealedAt: Date | null;    // When revealed to subject (after mutual reveal)
  revisionCount: number;      // Number of times empathy was revised
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'SEEN';
  deliveredAt: Date | null;
  seenAt: Date | null;
}
```

### ReconcilerResult

```typescript
{
  id: string;
  sessionId: string;
  guesserId: string;
  subjectId: string;
  guesserName: string;
  subjectName: string;

  // Alignment Analysis
  alignmentScore: number;       // 0-100
  alignmentSummary: string;     // Text summary of alignment
  correctlyIdentified: string[]; // Feelings/needs correctly identified

  // Gap Analysis
  gapSeverity: 'none' | 'minor' | 'moderate' | 'significant';
  gapSummary: string;
  missedFeelings: string[];     // Feelings/needs that were missed
  misattributions: string[];    // Incorrect assumptions made
  mostImportantGap: string | null;

  // Recommendation
  recommendedAction: 'PROCEED' | 'OFFER_OPTIONAL' | 'OFFER_SHARING';
  rationale: string;
  sharingWouldHelp: boolean;
  suggestedShareFocus: string | null;

  // Abstract guidance for refinement (no specific partner content)
  areaHint: string | null;      // e.g., "work and effort"
  guidanceType: string | null;  // e.g., "explore_deeper_feelings"
  promptSeed: string | null;    // e.g., "what might be underneath"

  // Suggestion for subject to share (generated when gaps are significant)
  suggestedShareContent: string | null;   // From generateShareSuggestion
  suggestedShareReason: string | null;

  // Reconciler loop tracking
  iteration: number;              // Which iteration produced this result (1 = first run)
  wasCircuitBreakerTrip: boolean; // Whether circuit breaker forced READY
  supersededAt: Date | null;      // When superseded by a newer analysis
}
```

### ReconcilerShareOffer

```typescript
{
  id: string;
  resultId: string;           // FK to ReconcilerResult
  userId: string;             // The subject who can share
  status: 'PENDING' | 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'NOT_OFFERED' | 'SKIPPED';
  // NOT_OFFERED = legacy, no offer was made
  // EXPIRED = offer expired (timeout)
  // SKIPPED = legacy, user skipped without responding
  suggestedContent: string | null;        // AI-generated suggestion
  suggestedReason: string | null;
  offerMessage: string | null;            // AI-generated message shown to user
  refinedContent: string | null;          // User's edited version of suggestion
  sharedContent: string | null;           // Final content that was shared
  deliveryStatus: 'PENDING' | 'DELIVERED' | 'SEEN';
  deliveredAt: Date | null;
  seenAt: Date | null;
  createdAt: Date;
  sharedAt: Date | null;
  declinedAt: Date | null;
  skippedAt: Date | null;

  // Reconciler loop tracking
  iteration: number;                      // Which iteration this offer belongs to
  refinementChatUsed: boolean;            // Whether refinement chat was used before responding

  // Notification tracking
  lastDeliveryNotifiedAt: Date | null;    // Last notified about delivery status change
  lastSeenNotifiedAt: Date | null;        // Last notified about seen status change
}
```

### EmpathyValidation

```typescript
{
  id: string;
  attemptId: string;          // FK to EmpathyAttempt
  sessionId: string;
  userId: string;             // The validator (subject)
  validated: boolean;         // Overall validation (true/false, no rating scale)
  feedback: string | null;    // Feedback Coach-approved text when validated=false
  feedbackShared: boolean;    // validated=false shares feedback with guesser
  validatedAt: Date;
}
```

### ValidationFeedbackDraft

```typescript
{
  id: string;
  sessionId: string;
  userId: string;             // The validator drafting feedback
  attemptId: string | null;   // Partner attempt being validated
  content: string;            // Current draft / coach output
  readyToShare: boolean;
  version: number;
}
```

## Known Edge Cases

### Case 1: Race Condition on Reveal
If both users share empathy at nearly the same time, both reconcilers run. Need to handle:
- Both returning PROCEED → both reveal immediately
- One returning OFFER_SHARING → only one gets share suggestion

### Case 2: Refresh During Share Suggestion
If user refreshes while share suggestion is pending:
- Frontend fetches `GET /api/v1/sessions/:id/reconciler/share-offer`
- If status is `PENDING`, it becomes `OFFERED`
- Panel should reappear with suggestion

### Case 3: Validation Before Reconciler Completes
If user tries to validate partner's empathy before reconciler finishes:
- Frontend should wait for `empathy.revealed` event
- Or poll `empathyStatus` until attempt is in `REVEALED` status

### Case 4: Feedback Coach Draft Without Final Send
Saving or refining `/empathy/validation-feedback/*` drafts does not notify the partner. The partner only receives a targeted `VALIDATION_FEEDBACK` chat message when the validator submits `/empathy/validate` with `validated=false` and final feedback text.

### Case 5: Share Suggestion Without suggestedContent
**Issue discovered during debugging**: If `generateShareSuggestion` fails to find the `ReconcilerResult` (race condition), the `suggestedContent` will be null. The fix includes:
- Retry logic (3 attempts with 100ms delay) in `generateShareSuggestion`
- Frontend fallback to display `offerMessage` if `suggestedContent` is missing

### Case 6: User Responds Before Fetching Share Offer
If user accepts/declines before the GET endpoint marks offer as `OFFERED`:
- `respondToShareSuggestion` accepts both `PENDING` and `OFFERED` status, and supports three actions: `accept`, `decline`, and `refine` (re-runs suggestion generation with `refinedContent` feedback from the user)
- After the circuit-breaker trips, the Guesser's alignment message uses neutral waiting language ("You've shared your perspective… [Partner] is also reflecting on your perspective — once they're done, you'll both see what each other shared") instead of the normal "quite accurate" feedback, to avoid overclaiming accuracy when refinement was exhausted or context was already shared
- Marks as `OFFERED` before processing for proper audit trail
- **Idempotent retries**: If a duplicate request arrives after the offer is already `ACCEPTED` or `DECLINED`, the handler returns the prior outcome with `guesserUpdated: false` so the partner is not double-notified. Callers should check `guesserUpdated` before dispatching partner notifications.

## Debugging Tips

### Analyze Session State
Use the diagnostic script to get a complete view of a session:
```bash
cd backend
npx ts-node src/scripts/analyze-session.ts <sessionId>
```

This shows:
- Participant info
- Stage progress for each user
- Empathy drafts and attempts
- Reconciler results and share offers
- Chronological timeline of all events
- Potential issues detected

### Check Reconciler Logs
Look for these key log messages (now using Winston structured logger — search JSON logs in production):
- `Running asymmetric reconciliation` - Start of analysis (in `reconciler/state.ts`)
- `AI analysis complete` (in `reconciler/analysis.ts`) — AI analysis done; fields: `alignmentScore`, `gapSeverity`, `action`
- `Reconciler outcome` (in `reconciler/state.ts`) — state transition committed; fields: `severity`, `action`, `empathyStatus`
- `Share suggestion generated` - Suggestion created (in `reconciler/sharing.ts`)
- `Could not find reconcilerResult` - Race condition error (in `reconciler/sharing.ts`)

### Frontend Cache Issues
If UI doesn't update after Ably events:
- Check that `empathy.revealed` handler invalidates `empathyStatus`
- Verify `shareOffer` query is invalidated after `empathy.status_updated` (status=`AWAITING_SHARING`)
- Use React Query DevTools to inspect cache state
