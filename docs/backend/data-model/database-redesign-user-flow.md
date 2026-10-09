---
title: "Product Journey and Data Flow"
sidebar_position: 3
description: How two people move through a session with private AI guides, consented sharing, and asynchronous reconciler results.
status: living
---

# Product Journey and Data Flow

This is a product map for the database and API redesign: what each person does, what data that creates, and who can see it when. **One session contains two private AI conversations and a few deliberate sharing points.** A and B can work at different speeds; they wait for each other only at the shared milestones below.

## The journey at a glance

```mermaid
flowchart TD
    Setup["0 · Getting Started<br/>A frames the topic and invites B<br/>Each accepts the Curiosity Compact"]
    Story["1 · Your Story<br/>Each privately chats with their AI<br/>and confirms 'I feel heard'"]
    Empathy["2 · Walking in Their Shoes<br/>Each drafts and submits empathy about the other<br/>Reconciler checks each direction when inputs are ready"]
    Reveal["Both empathy statements ready<br/>Reveal together, then review and give feedback"]
    Needs["3 · What Matters Most<br/>Each privately develops and shares their needs<br/>Reveal both lists when both have shared"]
    Repair["4 · What Comes Next<br/>Review proposals for both people's needs<br/>Privately choose willingness, then share selections"]
    Outcome["Close with shared agreements,<br/>individual commitments, or needs left open"]
    Followup["Return for follow-up / Tending<br/>Check in on the actual outcome"]

    Setup --> Story --> Empathy --> Reveal
    Reveal -->|Both finish validation or refinement| Needs
    Needs --> Repair --> Outcome --> Followup
```

A can start telling their story before B accepts the invitation. Each person enters empathy after confirming they feel heard, even if the other is still telling their story. Needs begin after both empathy directions finish validation; repair begins after both need lists are shared.

## Two private conversations, shared milestones

Each person repeats the same loop: **send a chat → receive AI guidance → review a draft or prompt → choose a CTA**. A CTA is an explicit action such as “I feel heard,” “Share,” “Revise,” or “Not quite yet.” Drafting something in chat does not by itself consent to sharing it.

The AI columns below represent each person's private experience. The session column represents the product's coordination of progress and approved content.

```mermaid
sequenceDiagram
    actor A as User A
    participant GuideA as A's private AI guide
    participant Session as Session milestones and sharing
    participant GuideB as B's private AI guide
    actor B as User B

    par A works privately
        A->>GuideA: Send chat about my experience
        GuideA-->>A: Reply, ask a question, or offer a draft / CTA
    and B works privately, at their own pace
        B->>GuideB: Send chat about my experience
        GuideB-->>B: Reply, ask a question, or offer a draft / CTA
    end

    A->>Session: Confirm a milestone or explicitly share reviewed content
    Session-->>A: Show my new progress or waiting state
    opt B has a relevant update
        Session-->>B: Notify B of progress or a new action to take
    end

    Note over A,B: Reconciler results can arrive later, without another chat message
    Session-->>B: Private suggestion to share context, if needed
    B->>Session: Approve the exact context to share, or decline
    opt B shares context
        Session-->>A: Show B's approved context with AI guidance
        A->>GuideA: Reflect and revise my empathy draft
    end

    Note over Session: At a mutual reveal, both sides must be ready
    Session-->>A: Show B's approved content and the next CTA
    Session-->>B: Show A's approved content and the next CTA
```

An AI response can stream or arrive later. Partner actions and background results can add a message, display a card, change a waiting state, or enable a CTA without the user sending anything else. If the user is away, a notification can bring them back; reopening the session shows the current permitted content even if an update was missed. These are product expectations; request timing and delivery transport are implementation choices.

## When the reconciler acts, and who sees its result

The reconciler compares **A's submitted understanding of B** with **B's private account of their experience**. It can use private material internally without exposing that material to the other person. Its analysis is not a shared chat transcript.

The diagram shows A trying to understand B. The same process runs separately with the roles reversed.

```mermaid
flowchart TD
    Submitted["A submits an empathy statement about B<br/>A sees it as submitted; B cannot read it yet"]
    Inputs{"Has B confirmed<br/>'I feel heard'?"}
    WaitStory["A sees a waiting state<br/>B continues privately with B's AI"]
    Compare["Reconciler compares A's statement<br/>with B's private account"]
    Helpful{"Would extra context help?"}
    Offer["B privately receives a suggestion<br/>to share specific context with A"]
    Choice{"B's choice"}
    Context["A receives only B's approved context<br/>plus an AI reflection / next-step prompt"]
    Revise["A reflects with A's AI<br/>and resubmits revised empathy"]
    Ready["A's attempt is ready for reveal<br/>A sees readiness or waiting guidance"]
    Both{"Is B's attempt about A<br/>also ready?"}
    WaitOther["Wait for the other direction<br/>Neither statement is revealed early"]
    Reveal["Reveal together<br/>A reads B's statement about A<br/>B reads A's statement about B"]

    Submitted --> Inputs
    Inputs -->|Not yet| WaitStory
    WaitStory -. B confirms later .-> Compare
    Inputs -->|Yes| Compare
    Compare -. Result arrives .-> Helpful
    Helpful -->|No| Ready
    Helpful -->|Yes| Offer --> Choice
    Choice -->|Decline| Ready
    Choice -->|Share as written or after editing| Context
    Context --> Revise --> Compare
    Context -->|A accepts remaining difference| Ready
    Ready --> Both
    Both -->|Not yet| WaitOther
    WaitOther -. Other direction becomes ready .-> Reveal
    Both -->|Yes| Reveal
```

**After reveal:** each person reviews the statement about themselves. They can confirm it feels accurate or privately work with the Feedback Coach and explicitly send feedback to the statement's author. The author receives that feedback with AI guidance, then revises and resubmits for review or accepts the remaining difference. Both directions must finish this step before Stage 3. A reconciler readiness result does not mean the other person has validated the statement.

## What becomes visible, and when

“Private” below means hidden from the other participant; the relevant AI processing can still use that material within its permitted scope.

| Data or action | Who owns it / what it relates to | What the other person sees, and when |
|---|---|---|
| Invitation and confirmed topic frame | Inviter and session | Invitee sees the invitation details needed to decide whether to join; the framing conversation stays private. |
| Chat, AI replies, and working drafts | One participant's private conversation in this session | Private throughout, including after a stage ends. Only explicitly approved content crosses a sharing boundary. |
| Progress and readiness | One participant's progress in this session | Relevant joined, waiting, ready, or next-step status, subject to activity-visibility preferences; no private transcript. |
| Submitted empathy | One author, about the other participant | Held until both directional attempts are ready; both statements become visible together. Submission consent and actual reveal are distinct moments. |
| Reconciler analysis and share suggestion | A specific empathy attempt and direction | Internal analysis stays internal. The person being understood sees their own sharing suggestion; the author gets appropriate status or guidance. |
| Extra context | Person being understood → empathy author | Only the exact context approved by its owner, after they choose to share. Declining does not disclose the suggested text. |
| Validation feedback | Reviewer → author of a specific empathy attempt | Private while coached or drafted; delivered to the author after explicit send. |
| Needs | Each participant's own need list | Private during exploration and review. After both explicitly share, both lists appear side by side and Stage 4 opens. |
| Repair proposals | Proposal source (A, B, or AI), associated needs, and intended participants | Shared proposals can be reviewed during repair; private chat ideas are not automatically shared proposals. Individual commitments retain their owner. |
| Willingness selections | One participant's decision about a specific proposal | Partner choices stay hidden until both share selections. A shared agreement requires both people's willingness to that proposal. |
| Closure and follow-up | Session outcome, related agreements / commitments, and their participants | Show the actual outcome and applicable check-ins. Private follow-up belongs to the person opting in; no agreement is also a valid outcome. |

During repair, each person walks through their own and their partner's needs, reviews or refines proposals, and records willingness. They can leave a need open. Before closure, someone waiting on the partner can withdraw their selections to revise them. Closing without a shared agreement must preserve individual choices without creating an obligation for an absent or unwilling partner.

At any stage, a person can pause for emotional regulation and return to the same meaningful point in their journey.

## Relationships the redesign needs to preserve

- **Session and participant:** shared session membership does not grant access to the other person's private conversation. Progress belongs to each participant, while reveal milestones belong to the session.
- **Owner, subject, and recipient:** A can author empathy about B, B can share context back to A, and B can give feedback on A's attempt. These roles reverse for the other direction.
- **Draft, consent, and reveal:** retain which content was approved and when it became visible. A later private edit must not silently change what the partner was shown.
- **Result and source:** a reconciler result, sharing suggestion, or feedback response belongs to the relevant attempt and revision. A late result must not overwrite a newer decision or reopen completed work.
- **Proposal, choice, and outcome:** connect proposals to needs, choices to the participant making them, and agreements or individual commitments to the people who accepted them.
- **Recipient and current view:** a notification or asynchronous update exposes only what its recipient may see. Reopening the session must recover the same state without relying on having received every notification.

This map describes the intended product journey, not a fresh end-to-end validation of every path. Stage 4 and Tending remain evolving areas. Implementation detail lives in the [reconciler flow](../reconciler-flow.md) and [stage API documentation](../api/stages.md).
