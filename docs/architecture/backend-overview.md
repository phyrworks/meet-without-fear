---
title: Architecture
sidebar_position: 2
description: "Analysis Date: 2026-03-11"
created: 2026-03-11
updated: 2026-05-18
status: living
---
# Architecture

**Analysis Date:** 2026-03-11

## Pattern Overview

**Overall:** Monorepo with layered API backend, cache-first React Native mobile app, and shared contracts

**Key Characteristics:**
- Monorepo structure (`backend/`, `mobile/`, `shared/`, `docs-site/`, `website/`, `e2e/`) managed by npm workspaces
- **Shared single source of truth:** All types, DTOs, and contracts defined in `shared/` package, imported by both backend and mobile
- **Cache-first state management:** Mobile uses React Query with optimistic updates as the SSOT (Single Source of Truth); local state is derived from cache
- **Realtime-first:** Ably channels broadcast session events; mobile subscriptions keep cache synchronized
- **Stage-driven logic:** Entire user journey divided into 5 stages (0-4), each with specific UI, prompts, and validation gates
- **AI-orchestrated:** Backend routes user messages through intent detection → context retrieval → LLM processing → stage-specific prompts

## Layers

**API Backend (Express + Prisma):**
- Purpose: REST API serving mobile client; message routing; session management; AI orchestration
- Location: `backend/src/`
- Contains: Route handlers, controllers, services, middleware, database logic, LLM integrations
- Depends on: Prisma ORM, Bedrock LLM, Ably realtime, shared DTOs/contracts
- Used by: Mobile client via HTTP; Ably realtime subscriptions

**Mobile Frontend (React Native + Expo):**
- Purpose: User-facing chat interface; session management UI; inner work tools; invitations
- Location: `mobile/src/`
- Contains: Screens, components, hooks, services, contexts, theme, providers
- Depends on: React Query (cache management), Ably (realtime), shared DTOs/contracts, Clerk authentication
- Used by: End users; references backend APIs

**Shared Package (DTOs + Contracts):**
- Purpose: Single source of truth for types; prevents duplication; ensures backend/mobile alignment
- Location: `shared/src/`
- Contains: `dto/` (data transfer objects), `contracts/` (API endpoint schemas), validation utilities
- Depends on: Zod (validation), TypeScript
- Used by: Backend routes, Mobile hooks, API clients

## Data Flow

**Session Creation & Invitation:**

1. User A creates session via mobile → `POST /sessions` → Backend creates Session row + Invitation row
2. Backend publishes `session-created` event to Ably `ai-audit-stream` channel via `publishSessionCreated` (for monitoring dashboard)
3. Mobile's `useRealtime` hook receives event → invalidates sessionKeys cache → UI refreshes
4. User A drafts the invitation in Stage 0; the backend saves the draft from stream metadata.
5. Mobile calls `/sessions/{id}/topic-frame/generate` and `/sessions/{id}/topic-frame/confirm`; the backend stores `Session.topicFrame` and `topicFrameConfirmedAt`.
6. `/sessions/{id}/invitation/confirm` requires the finalized topic frame before the session moves `CREATED → INVITED`.
7. User B receives invite link, sees limited invitation info (name, inviter name, session status) via `GET /invitations/{id}`, then accepts via `POST /invitations/{id}/accept`.
8. Backend creates Invitation acceptance record; publishes `session.joined` event.
9. Both users' `sessionKeys.state` cache updates; chat UI becomes available.

**Message Flow (Chat & AI):**

1. User sends message → Mobile optimistically adds to `messageKeys.list` cache
2. Mobile: `POST /sessions/{id}/messages/stream` (SSE streaming endpoint)
3. Backend streams chunks:
   - `chunk` events (partial AI response text)
   - `metadata` event (emotional intensity, turn summary, memory snapshots)
   - `text_complete` (final text assembled)
   - `complete` (request finished)
4. Mobile: `useStreamingMessage` hook processes stream:
   - `handleChunk()` updates cache incrementally
   - `handleMetadata()` updates emotional state, memory, brain state
   - Both cache AND React state updated (defense in depth)
5. Mobile: On stream error, `onError` callback rolls back cache to previousData
6. Mobile: On stream success, `onSuccess` invalidates queries to fetch fresh from server
7. Ably channel receives `message.created` event (published by backend); all partners see update

**Stage Progression:**

1. User completes stage requirements (e.g., both signed compact in Stage 0)
2. Mobile: `POST /sessions/{id}/stages/{stage}/confirm` (stage-specific mutation)
3. Backend: Validates gate requirements; updates `SessionProgress.myProgress.stage` in DB
4. Backend: Publishes stage event (e.g., `partner.advanced`) to Ably
5. Mobile: `useStages` mutation's `onMutate` immediately updates `sessionKeys.state` cache with new stage
6. Mobile: Panel visibility computed by `computeChatUIState()` from `myProgress.stage` value → ensures UI shows correct stage immediately

**Realtime Synchronization:**

1. Session event published to Ably channel: `meetwithoutfear:session:${sessionId}` (see `shared/src/dto/realtime.ts` REALTIME_CHANNELS)
2. Mobile subscribes via `useRealtime()` hook → attaches listeners to channel
3. Mobile receives event → calls handler (e.g., `handlePartnerAdvanced`)
4. Handler invalidates relevant query keys → React Query refetches → cache updates → components rerender
5. Fallback: If cache miss, local React state can be set as backup (defined in `useChatUIState`)

**State Management Philosophy:**

- **Cache is SSOT:** All UI state derives from React Query cache (`sessionKeys.state`, `messageKeys.list`, `stageKeys.progress`, etc.)
- **Optimistic Updates:** Mutations update cache in `onMutate` before API call completes
- **Rollback on Error:** If API fails, `onError` restores previous cache value
- **Typing Indicator:** Not a boolean flag; derived from last message role (`isWaitingForAI = lastMessage?.role === 'user'`)
- **Timeline Indicators:** Derived from cached timestamps (e.g., `invitation?.messageConfirmedAt`)

## Key Abstractions

**Stage Abstraction:**
- Purpose: Encapsulates all logic for a conversation stage (0=ONBOARDING, 1=WITNESS, 2=PERSPECTIVE_STRETCH, 3=NEED_MAPPING, 4=STRATEGIC_REPAIR)
- Examples: `backend/src/services/stage-prompts.ts`, `backend/src/services/needs-prompts.ts` (Stage 3-4 prompt generation: needs check-in, baseline assessment, common ground, strategy generation, strategy ranking), `mobile/src/hooks/useStages.ts`
- Pattern: Each stage has UI (screen component), controllers (route handlers), services (business logic), mutations (cache updates), validation gates. Stage 2 also includes Feedback Coach draft/refine endpoints and targeted `VALIDATION_FEEDBACK` messages for the "Not quite yet" validation path.

**Service Orchestrator (AI Flow):**
- Purpose: Routes user messages through intent detection → context assembly → LLM prompt building → response generation
- Examples: `backend/src/services/ai-orchestrator.ts`, `backend/src/services/chat-router/`
- Pattern: Message enters → Intent detector classifies purpose → Context retriever gathers session history + memory → Prompt formatter injects stage-specific instructions → Bedrock LLM generates → Response published to Ably

**Realtime Event System:**
- Purpose: Pub/sub for session events (partner actions, AI responses, stage transitions)
- Examples: `backend/src/services/realtime.ts`, `mobile/src/lib/ably.ts`
- Pattern: Backend publishes to Ably channel; Mobile subscribes; Event handlers update React Query cache

**Context Assembler:**
- Purpose: Builds complete context for LLM given a user message and stage
- Examples: `backend/src/services/context-assembler.ts`, `backend/src/services/context-retriever.ts`
- Pattern: Retrieves conversation history, user memory, partner facts, emotional timeline, stage-specific data → formats into prompt context → LLM processes

**UI State Computation (Cache Derivation):**
- Purpose: Pure functions that compute complete UI state from cache values; eliminates scattered useEffect chains
- Examples: `mobile/src/utils/chatUIState.ts`, `mobile/src/hooks/useChatUIState.ts`
- Pattern: Inputs = cache values (stage, invitation status, empathy draft, etc.); Output = exact panel to show, input visibility, banner text, etc.

## Entry Points

**Backend API Server:**
- Location: `backend/src/app.ts` (middleware + route mounting) and `backend/src/server.ts` (HTTP + WebSocket listener)
- Triggers: `npm run dev:api` in development; PORT=3000 (default) in production
- Responsibilities: Initializes Express app with middleware; mounts all route modules under both `/api` and `/api/v1` (dual-prefix for compatibility); attaches the `/realtime` WebSocket for real-time transcription via `attachRealtimeWebSocket(server)` (requires Clerk JWT via `?token=` query parameter on upgrade); handles errors consistently; graceful shutdown on SIGTERM/SIGINT (closes HTTP server, disconnects Prisma, flushes Sentry, force-exits after 10 s timeout)
- Compression: the compression middleware is explicitly disabled for `/messages/stream` paths to prevent SSE buffering
- **Scanner Filter:** `backend/src/middleware/scanner-filter.ts` sits early in the middleware chain (before logging) and silently returns a plain 404 for known vulnerability-scanner paths (`.php`, `.asp`, `.aspx`, `.jsp`, `.cgi` extensions; `/wp-admin`, `/wp-login`, `/phpmyadmin`, etc.). This keeps application logs clean of automated probe noise without incurring any logging overhead.

**Mobile App Entry:**
- Location: `mobile/app/_layout.tsx` (Expo Router file-based routing)
- Triggers: `npm run dev:mobile` or `expo start`
- Responsibilities: Root context providers (Auth, Query, Toast); tab navigator; auth flow

**Session Route Hub (Backend):**
- Location: `backend/src/routes/index.ts`
- Triggers: Server startup; mounts all feature routes (chat, invitations, stages, etc.)
- Responsibilities: Centralizes route mounting; documents mount order and dependencies

**Chat Unified Screen (Mobile):**
- Location: `mobile/src/screens/UnifiedSessionScreen.tsx` (with Stage 2 drawers/modals extracted into components such as `AccuracyFeedbackDrawer`, `ViewEmpathyStatementDrawer`, and `GuidedDraftChatModal`)
- Triggers: User taps session in home screen
- Responsibilities: Main chat interface; orchestrates hooks via `useUnifiedSession` (which delegates to `useEmpathyActions`, `useNeedsActions`, `useStrategyActions`, `useSessionEventHandler`); renders chat UI and stage panels

## Additional Backend Services

**AI & Messaging:**
- Stage 2B / INFORMED_EMPATHY (internal stage id 21; the persisted `StageProgress.stage` is an `Int` that stays at 2 — 21 is only used in-memory for routing)
- Initial message generation: `POST /sessions/:id/messages/initial` generates the first AI message for a session
- Dispatch handler system: Routes AI micro-tags to specific backend actions
- Background classifier: `partner-session-classifier.ts` runs fire-and-forget after each AI response

**Memory & Context:**
- Memory intent system: Determines retrieval strategy per-message
- Embedding and cross-session retrieval: Vector search across sessions using Titan embeddings
- Conversation summarization: Rolling summaries for long conversations (>30 messages)

**Communication:**
- Notifications and badge system: `GET /sessions/:id/pending-actions` and `GET /notifications/badge-count`
- Inner work system: Needs assessment, meditation, gratitude journaling

**E2E Testing:**
- E2E testing helpers at `POST /api/e2e/*` (cleanup, seed, trigger-reconciler) — only registered when `NODE_ENV !== 'production'`
- Fixture-based mock LLM responses

**Deprecated:**
- `POST /sessions/:id/messages` — returns 410 GONE. All messaging uses `POST /sessions/:id/messages/stream` (SSE streaming endpoint).

## Error Handling

**Strategy:** Centralized error classes with standardized HTTP responses

**Patterns:**

- **Backend:** `AppError` base class with subclasses (`UnauthorizedError`, `ValidationError`, `NotFoundError`, etc.) → caught by `errorHandler` middleware → returns standardized `ApiResponse<never>` with error code + message + details
- **Zod Validation:** Automatically caught by `errorHandler`, converts `ZodError` to `VALIDATION_ERROR` with field-level details
- **Mobile Mutations:** `onMutate` saves previous state, `onError` restores it, `onSuccess` invalidates to refetch fresh data
- **Async Handler Wrapper:** `asyncHandler()` catches async route errors and passes to Express error handler
- **Request Context:** `AsyncLocalStorage` captures `turnId` (LLM turn identifier) for error logging + debugging

## Cross-Cutting Concerns

**Logging:**
- Backend: Winston structured logger (`backend/src/lib/logger.ts`) with JSON output in production, pretty-print in development; automatically injects request context (turnId, sessionId, userId, requestId); PII fields stripped via `beforeSend` hook before transmission
- **4xx vs 5xx split:** Client errors (4xx) are logged at `warn` level and do NOT trigger Sentry; only server errors (5xx) and unhandled async errors are logged at `error` level and forwarded to Sentry. This keeps Sentry focused on true server failures rather than client mistakes.
- Mobile: Handled by error tracking provider (Sentry integration possible); development console logs

**Validation:**
- Backend: Zod schemas on request payloads; custom validators in services (gate checks, consent validation)
- Mobile: Zod schemas in shared contracts; React Hook Form for UI validation

**Authentication:**
- Backend: Clerk JWT in `Authorization: Bearer` header; middleware extracts + verifies with `verifyToken()` (from @clerk/express). When `E2E_AUTH_BYPASS=true` **and** `NODE_ENV` is exactly `test` or `development` (`isE2EBypassEnabled()`, `backend/src/lib/e2e-bypass.ts`; an allow-list), the middleware also accepts `x-e2e-user-id` and `x-e2e-user-email` headers and resolves them to a DB user instead of a Clerk session. A startup assertion in `server.ts` prevents the server from starting if `E2E_AUTH_BYPASS=true` is set with any other `NODE_ENV` (including unset), so the Playwright configs and `scripts/mwf_gold_loop.py` start the API with `NODE_ENV=development`.
- Mobile: Clerk Expo SDK manages tokens; `useAuth()` hook provides `token` for API calls; E2E mode sends the `x-e2e-user-id` / `x-e2e-user-email` headers described above instead of a Clerk token.

**Rate Limiting:**
- Implemented via `backend/src/middleware/rate-limit.ts` with four tiers:
  - `streamingRateLimit`: 10 req/min (LLM-backed streaming endpoints)
  - `invitationLookupRateLimit`: 10 req/min per IP (public invitation lookup — unauthenticated)
  - `empathyRateLimit`: 20 req/min (reconciler endpoints)
  - `authRateLimit`: 30 req/min (auth token endpoints)
- Global fallback: 100 req/min; skipped during E2E tests (non-production only)

**AI Safety Gates:**
- Backend: Three service-level circuit breakers (`bedrockCircuitBreaker`, `embeddingCircuitBreaker`, `ablyCircuitBreaker`) with states CLOSED/OPEN/HALF_OPEN prevent cascading failures; stage validators check user progress before AI prompts; crisis detector (`backend/src/services/crisis-detector.ts`) provides pattern-based safety net for suicide/self-harm, domestic violence, imminent danger, and child abuse; input sanitizer (`backend/src/services/input-sanitizer.ts`) wraps user input in XML delimiters to defend against prompt injection
- Mobile: UI gates prevent advancing stages until requirements met (compact signed, invitation confirmed, etc.)

---

*Architecture analysis: 2026-03-11*
