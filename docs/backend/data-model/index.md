---
title: Data Model
sidebar_position: 2
description: Database design implementing the Vessel Architecture with PostgreSQL and pgvector.
slug: /backend/data-model
---
# Data Model

Database design implementing the [Vessel Architecture](../../privacy/vessel-model.md) with PostgreSQL and pgvector.

## Documents

### [Product Journey and Data Flow](./database-redesign-user-flow.md)
Two private AI conversations, consented sharing, and asynchronous reconciler results: the product journey and visibility boundaries for database and API redesign.

### [Prisma Schema](./prisma-schema.md)
Complete database schema: stage/session tables, consent semantics, Inner Work subsystem, Fact-Ledger memory architecture, Reconciler models, and Needs / People catalogs.

## Quick Reference: Vessel tables

The Vessel Architecture is realized in two Prisma tables plus a synthesis-state concept:

| Concept | Table(s) | Storage Strategy | Access Pattern |
|---------|----------|-----------------|----------------|
| User Vessel | `UserVessel` (+ `notableFacts`, message/session embeddings) | SQL + pgvector | User + AI only |
| Shared Vessel | `SharedVessel` (linked 1:1 to `Session`) | SQL | Both users + AI |
| AI Synthesis | `StageProgress.isSynthesisDirty` / `synthesisLastUpdated` + regenerated on demand | Ephemeral (no dedicated table) | AI only |

`Session.topicFrame` stores the AI-generated Stage 0 invite topic anchor, and `Session.topicFrameConfirmedAt` marks when the inviter finalized that anchor before sharing the invite.

## Related subsystems

The full Prisma schema also covers subsystems that aren't strictly part of the vessel model but share the same database:

- **Inner Work**: `InnerWorkSession`, `InnerWorkMessage`, `MeditationSession`, `MeditationStats`, `MeditationFavorite`, `GratitudeEntry`.
- **Fact-Ledger / memory**: `User.globalFacts`, `UserVessel.notableFacts`, session-level embeddings, `UserMemory` for cross-session AI context.
- **Reconciler + Stage 2 feedback**: `ReconcilerResult`, `ReconcilerShareOffer` (alignment scores, gap summaries, share-suggestion state), plus `ValidationFeedbackDraft` for Feedback Coach drafts before validation feedback is sent.
- **Privacy preferences**: stored as a JSON field on the `User` model (`privacyPreferences`). Shape is `PrivacyPreferencesDTO` (`showActivityStatus`, `allowSessionInvites`, `analyticsOptOut`). The `analyticsOptOut` field was added in the analytics opt-out fix — existing rows default to `false` (opted-in) via `DEFAULT_PRIVACY_PREFERENCES`.
- **Needs + people catalogs**: `Need` (19 core human needs), `NeedScore`, `Person`, `PersonMention`.

## Dual-Layer Data Strategy

```mermaid
flowchart TB
    subgraph "Binary Decisions - SQL"
        CONSENT[Consent records]
        GATES[Stage gates]
        AGREEMENTS[Agreements]
        STATE[Session state]
    end

    subgraph "Nuanced Decisions - Vectors"
        SIMILAR[Similar past moments]
        EMOTION[Emotional patterns]
        NEED[Need clustering]
    end
```

[Back to Backend](../index.md)
