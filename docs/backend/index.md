---
title: Backend Documentation
sidebar_position: 1
description: Backend-specific documentation for the Express + Prisma API server.
created: 2026-03-11
updated: 2026-05-18
status: living
---
# Backend Documentation

Backend-specific documentation for the Express + Prisma API server.

## Documents

- [Prompting Architecture](prompting-architecture.md) -- How prompts are constructed, model stratification, memory retrieval, decision layers
- [Prompt Caching](prompt-caching.md) -- Bedrock caching strategy, cache_control placement, cost optimization
- [Reconciler Flow](reconciler-flow.md) -- Stage 2 empathy exchange, asymmetric reconciler, share suggestions, Feedback Coach validation feedback, circuit breaker

## See Also

- [Architecture: Backend Overview](../architecture/backend-overview.md) -- Higher-level system architecture
- [Backend: API](api/index.md), [Prompts](prompts/index.md), [Data Model](data-model/index.md), [Security](security/index.md), [State Machine](state-machine/index.md)
- `.planning/BACKEND_ARCHITECTURE_PROPOSAL.md` -- Original Stage 2B design doc (design document; the prompt path itself is implemented in `stage-prompts.ts` as case 21 / `buildStage2BPrompt`)


## Historical MVP plans

---
slug: /backend
sidebar_position: 6
---

# Backend Architecture

Technical documentation for the Meet Without Fear backend - a **stateful, stage-gated, privacy-partitioned facilitation engine**.

## Core Principle

> Meet Without Fear is NOT a chatbot. It is a Process Guardian that enforces stage-scoped memory contracts.

## Non-Negotiable Architectural Rules

These rules are constitutional and must never be compromised:

| Rule | Rationale |
|------|-----------|
| Partner raw data is never retrieved | Privacy is absolute between vessels |
| Consent is transactional, revocable, and enforced at query time | Trust requires real-time consent checking |
| Vector search is never used to recall agreements or decisions | Trust-affecting data must be deterministic |
| The large model never decides what to retrieve or share | AI receives pre-assembled context only |
| AI Synthesis objects may influence retrieval planning but may never be injected directly into generation context | Prevents hallucination and privacy leakage |

## Technology Stack

- **Runtime**: Node.js with Express
- **ORM**: Prisma with application-layer access-control filters.
- **Database**: PostgreSQL 18 with pgvector on AWS Lightsail; the production vector extension is installed. PostgreSQL RLS is not active runtime protection.
- **Realtime**: Ably (pub/sub + presence detection for immediate partner notifications)
- **Push**: Expo Push Notifications (for offline users)
- **AI Models**: AWS Bedrock (Haiku for mechanics, Sonnet for facilitation)
- **Auth**: Clerk (JWT validation, account deletion handoff)
- **Email**: Resend (transactional; not outbound invitation delivery)
- **Voice**: AssemblyAI Universal Streaming (real-time transcription via `realtime-transcription.ts`; WebSocket upgrade is unauthenticated — auth uses a first-message pattern: the client sends `{ type: "auth", token: "<clerk-jwt>" }` as the first WebSocket message; connections that omit or fail auth are closed with code 1008 after a 5-second timeout)
- **Infrastructure**: AWS Lightsail (Caddy, API and private PostgreSQL containers); see [the AWS runbook](../../infra/aws/README.md)

## Dual-Layer Data Strategy

```
Binary decisions (Consent, Stage Gates, Agreements) → SQL (deterministic)
Nuanced decisions (Emotional similarity, Episodic recall) → Vectors (semantic)
```

## Documentation Sections

### [Overview](./overview/index.md)
Architecture, mental model, and turn lifecycle

### [Data Model](./data-model/index.md)
Prisma schema, vessel implementations, memory objects

### [State Machine](./state-machine/index.md)
Session states, stage gates, retrieval contracts

### [AI Prompts](./prompts/index.md)
Model stratification, prompt templates for each stage, transformation prompts

### Mechanisms
- **Emotional Barometer** — implemented. `context-assembler.ts` builds the emotional thread, computes trends (escalating / stable), and flags 3+ point shifts from `EmotionalReading` data.
- **Mirror Intervention** — implemented as the `MIRROR` branch inside Stage 2 prompts (`stage-prompts.ts`); acknowledges hurt when a user slips into blame and redirects toward curiosity.
- **Consensual Bridge** — implemented end-to-end via the Consent API and `EmpathyAttempt` flow; see [Consent API](api/consent.md) and [Stage 2 API](api/stage-2.md).

### [API](./api/index.md)
REST endpoints for session management, stage progression, and consent flows

### [Security](./security/index.md)
Application-layer access control, consent enforcement, and RLS status

### [Testing](./testing/index.md)
Unit, integration, and E2E testing strategy

### [Glossary](./glossary.md)
Canonical definitions for all Meet Without Fear backend terminology

## Key Design Principles

| Principle | Implementation |
|-----------|----------------|
| Memory is typed, scoped, gated | Not conversation history - structured objects with access rules |
| Vector search is support tool | Never authority for trust-affecting decisions |
| Small model (Haiku) for mechanics | Stage classification, intent detection, retrieval planning, session distillation / takeaway extraction, memory formatting + validation, attacking-language detection and rewriting suggestions |
| Large model receives pre-assembled context | Does not decide what to retrieve |
| AI Synthesis is regenerable | Persist inputs, regenerate synthesis |
| Stage-scoped retrieval contracts | Hard rules on what each stage can access |

## Related Documentation

- [Privacy Model](../privacy/index.md) - Vessel architecture concepts
- [Stages](../stages/index.md) - User-facing stage documentation
- [Mechanisms](../mechanisms/index.md) - Mechanism behavior documentation
