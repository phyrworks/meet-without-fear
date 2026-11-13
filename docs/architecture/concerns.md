---
title: Codebase Concerns
sidebar_position: 3
description: "Analysis Date: 2026-03-11"
created: 2026-03-11
updated: 2026-03-11
status: living
---
# Codebase Concerns

**Analysis Date:** 2026-03-11

## Tech Debt

**Large, Monolithic Components (Partially Resolved):**
- Issue: Multiple components exceed 1500+ lines of code, making them difficult to maintain and test
- Files:
  - `mobile/src/screens/UnifiedSessionScreen.tsx` (2722 lines, reduced from 3096 — extracted `session/SessionAboveInputPanel.tsx`, `session/SessionOverlays.tsx`, `session/SessionDrawers.tsx`)
  - `backend/src/controllers/stage2.ts` (2268 lines)
  - ~~`backend/src/services/reconciler.ts` (2320 lines)~~ — **Resolved**: refactored into `reconciler/` directory with `state.ts` (544), `analysis.ts` (610), `sharing.ts` (1173), `circuit-breaker.ts` (102)
  - ~~`mobile/src/hooks/useUnifiedSession.ts` (1218 lines)~~ — **Resolved**: reduced to 711 lines by extracting `useEmpathyActions.ts`, `useNeedsActions.ts`, `useStrategyActions.ts`, `useSessionEventHandler.ts`
- Impact: Reduced but stage2.ts controller still large
- Remaining: `stage2.ts` controller is the last major monolith

**Legacy/Deprecated Code Still Active (Partially Resolved):**
- Issue: Deprecated endpoints and old patterns coexist with new ones, creating confusion and maintenance burden
- Files:
  - `backend/src/controllers/messages.ts` (105) - `sendMessage` endpoint marked DEPRECATED with fire-and-forget pattern still in use
  - ~~`backend/src/services/stage-prompts-legacy.ts` (1899 lines)~~ — **Resolved**: deleted, only `stage-prompts.ts` remains
  - Multiple deprecated test routes in `backend/src/routes/__tests__/messages.test.ts`
- Impact: Reduced — only the deprecated sendMessage endpoint remains
- Fix approach: Schedule removal of deprecated sendMessage endpoint after ensuring all clients migrated to `/messages/stream`.

**Unused/Partially Implemented Features:**
- Issue: Features stubbed out or marked for future implementation
- Files/Examples:
  - `mobile/app/(auth)/person/[id].tsx` (52) - Remove person is wired to UI but API call not implemented (just navigates back)
  - `mobile/app/(auth)/inner-thoughts/index.tsx` (225) - Linking partner sessions disabled (`isLinked = false; // TODO: item.linkedPartnerSessionId`)
  - `backend/src/controllers/stage4.ts` (862) - TODO: Call AI service to generate strategy suggestions
- Impact: Users may believe features work when they don't; incomplete business logic
- Fix approach: Either implement these features or remove UI elements that reference them. Create explicit GitHub issues for deferred work.

---

## Known Issues & Fragile Areas

**Stage Transition Cache Update Pattern (Critical):**
- Issue: Mobile app uses Cache-First architecture where mutations must manually update `sessionKeys.state` cache with new stage. Failing to do this causes stage-specific panels to not display (e.g., empathy panel won't show if `myProgress.stage` cache is stale).
- Files:
  - `mobile/src/hooks/useStages.ts` - Stage mutations
  - `mobile/src/hooks/useChatUIState.ts` - Derives panel visibility from stage cache
  - `CLAUDE.md` line 30: Already documented as fixed in `useConfirmFeelHeard`
- Symptoms: User completes action that should advance to new stage, but no UI updates appear
- Workaround: Refresh/reload to re-fetch fresh stage from server
- Risk: This pattern is not type-safe; easy to miss cache update when adding new stage mutations
- Fix approach: Consider creating a wrapper mutation hook that enforces cache update pattern, or use React Query's `onSuccess` with `invalidateQueries` to auto-refresh

**Reconciler Race Conditions (Partially Resolved):**
- Issue: Reconciler service previously had manual retry logic to handle database visibility issues
- Files: `backend/src/services/reconciler/state.ts` - `checkAndRevealBothIfReady()` now uses serializable transactions to prevent race conditions on mutual reveal
- Progress: Modular refactor introduced explicit state machine (`empathy-state-machine.ts`) and serializable transactions for critical paths
- Remaining: Some retry logic may still exist in share suggestion generation flow (`reconciler/sharing.ts`)

**Reconciliation State Machine Complexity (Partially Resolved):**
- Issue: Reconciler manages complex state transitions (HELD → AWAITING_SHARING → REFINING → REVEALED) with multiple database tables (ReconcilerResult, ReconcilerShareOffer, EmpathyStatus)
- Files: `backend/src/services/reconciler/` (modular directory), `backend/src/services/empathy-state-machine.ts`, `backend/src/controllers/stage2.ts`
- Progress: Formal state machine implemented in `empathy-state-machine.ts` with explicit transition table, `canTransition()`, and `validEventsFor()` — prevents invalid state changes. Loop prevention formalized in `reconciler/circuit-breaker.ts` (max 3 attempts per direction)
- Remaining: State machine is custom (not using XState); adding new reconciliation features still requires careful consideration

**Type-Safety Gaps in useStages.ts:**
- Issue: `useStages.ts` has `@typescript-eslint/no-explicit-any` escapes and circular dependency runtime guards
- Files: `mobile/src/hooks/useStages.ts`
- Impact: Type errors may go undetected; runtime guards indicate architectural fragility
- Risk: Refactoring may introduce silent regressions
- Fix approach: Replace `any` escapes with proper generics; resolve circular dependencies at the module level

**Console Logging Explosion (Resolved):**
- ~~Issue: 85+ console.log/warn/error statements in `reconciler.ts` alone~~
- **Resolved**: All `console.*()` calls across the backend replaced with Winston structured logger (`backend/src/lib/logger.ts`). Logger provides log levels, JSON output in production, request context injection, and Sentry transport for errors.

**State Management Explosion in useStages.ts (Partially Resolved):**
- Issue: 29 direct `queryClient.setQueryData()` calls with no type-safe wrapper
- Files: `mobile/src/hooks/useStages.ts`
- Progress: Typed cache helpers created in `mobile/src/hooks/cacheHelpers.ts` — `typedSetQueryData()` and `typedGetQueryData()` provide compile-time key-to-value-type enforcement. New extracted hooks (`useEmpathyActions.ts`, `useNeedsActions.ts`, `useStrategyActions.ts`) use these helpers.
- Remaining: `useStages.ts` itself still has direct `setQueryData` calls that could be migrated to the typed helpers

**Circuit Breaker Pattern (Rewritten):**
- The circuit breaker utility (`backend/src/utils/circuit-breaker.ts`) has been completely rewritten with a full 3-state pattern (CLOSED → OPEN → HALF_OPEN)
- Three service-level instances: `bedrockCircuitBreaker`, `embeddingCircuitBreaker`, `ablyCircuitBreaker`
- Configuration: failureThreshold (5), cooldownMs (30s), timeoutMs (20s)
- Methods: `execute()`, `executeWithFallback()`, `recordSuccess()`, `recordFailure()`, `getStats()`
- Impact: E2E test runs can still take 8-12 minutes when hitting LLM timeouts
- Risk: E2E tests may fail intermittently based on LLM service health
- Mitigation: Circuit breaker provides fallback values; fast-fail when OPEN state prevents cascading failures

---

## Performance Bottlenecks

**Large AI Service Calls Block User Response:**
- Issue: Some services use `withTimeout` with circuit breakers but still perform expensive operations in user request path
- Files:
  - `backend/src/services/memory-detector.ts` (203) - Slow Haiku calls wrapped but still in response path
  - `backend/src/services/partner-session-classifier.ts` (519) - Circuit breaker prevents blocking but still called per request
  - `backend/src/services/background-classifier.ts` (254) - Non-blocking pattern used
- Recommendations: Continue using fire-and-forget pattern for optional enrichment; ensure all blocking calls have reasonable timeouts (<5s)

**N+1 Query Risk in Reconciler:**
- Issue: Reconciler builds context by fetching user messages, themes, empathy statements separately. If session has many messages, could cause multiple database round-trips
- Files: `backend/src/services/reconciler/analysis.ts` - `getWitnessingContent`, `extractThemes`, `analyzeEmpathyGap`
- Risk: Higher latency with larger sessions
- Mitigation: Prisma relations are properly defined; queries use includes/selects when needed
- Recommendation: Monitor slow query logs; consider pagination if sessions grow beyond 1000 messages

---

## Test Coverage Gaps

**Critical Services Lack Unit Tests:**
- Issue: Major backend services have no dedicated test files
- Tested services (14): ai, context-assembler, dispatch-handler, memory-detector, memory-intent, memory-validator, partner-session-classifier, people-extractor, push, realtime, reconciler-offer-optional, semantic-router-integration, stage-prompts, stage-tools
- Newly added tests:
  - `backend/src/services/__tests__/ai-orchestrator.test.ts`
  - `backend/src/services/__tests__/context-retriever.test.ts`
  - `backend/src/services/__tests__/crisis-detector.test.ts`
  - `backend/src/services/__tests__/empathy-state-machine.test.ts`
  - `backend/src/services/__tests__/input-sanitizer.test.ts`
  - `backend/src/services/__tests__/reconciler.test.ts`
  - `backend/src/utils/__tests__/circuit-breaker.test.ts`
  - `backend/src/utils/__tests__/field-encryption.test.ts`
  - `backend/src/lib/__tests__/bedrock-streaming.test.ts`
- Still untested (high-impact):
  - `backend/src/services/embedding.ts` (16.4KB) - Vector embedding service
  - `backend/src/services/conversation-summarizer.ts` (22.5KB) - Session summarization
  - `backend/src/services/needs.ts` (session needs logic)
- Impact: Core services now have test coverage; remaining gaps are lower priority
- Fix approach: Continue adding tests for embedding, summarizer, and needs services

**Mobile E2E Test Brittleness:**
- Issue: Live AI E2E test (`e2e/tests/live-ai-full-flow.spec.ts`) depends on external service health (partner-session-classifier circuit breaker adds 20s timeout per response per MEMORY.md)
- Files: `e2e/tests/live-ai-full-flow.spec.ts`
- Impact: Test may timeout intermittently; hard to debug flakiness
- Workaround: MOCK_LLM=true for faster local tests
- Recommendation: Continue with mocked tests for CI; reserve live AI test for scheduled deep validation runs

**No Tests for Person Deletion/Linking:**
- Issue: Incomplete features (`mobile/app/(auth)/person/[id].tsx` remove, inner thoughts linking) have no test coverage because they're not fully implemented
- Fix approach: Implement features and add tests, or remove incomplete UI elements

---

## Scaling & Capacity Concerns

**Session Message Growth:**
- Issue: UnifiedSessionScreen fetches messages with infinite scroll (`hasMoreMessages` flag, `fetchMoreMessages` callback)
- Files: `mobile/src/screens/UnifiedSessionScreen.tsx`, `mobile/src/hooks/useMessages.ts`
- Current design: Good (pagination support built in)
- Concern: Large sessions (1000+ messages) may slow down:
  - Reconciler context assembly (fetches all user messages to build context)
  - Mobile UI rendering (infinite scroll list)
- Mitigation: Message list uses pagination; reconciler uses message window, not full history
- Recommendation: Monitor session sizes; consider caching reconciler context if sessions exceed 2000 messages

**Realtime Connection Scalability:**
- Issue: Each session maintains Ably connection for real-time updates (`mobile/src/hooks/useRealtime.ts`, `backend/src/services/realtime.ts`)
- Current design: One connection per mobile session, fire-and-forget updates to partner
- Concern: Multiple concurrent sessions × many users = significant Ably bandwidth
- Mitigation: Production Ably plan is presumed to support expected user base
- Recommendation: Monitor Ably metrics; set up alerts for connection errors or message backlog

---

## Security Considerations

**Both Partners' Empathy Status Broadcast on the Shared Session Channel (Not Resolved):**
- Issue: Three publishers send **both** partners' full empathy status over the session-scoped Ably channel, which both participants subscribe to. Each device therefore receives the *other* user's private Stage 2 content.
- Files:
  - `backend/src/controllers/sessions.ts` (1124) — `partner.session_viewed`
  - `backend/src/controllers/sessions.ts` (1192) — `partner.share_tab_viewed`
  - `backend/src/controllers/stage2.ts` (242) — `empathy.status_updated`
  - All three publish the result of `buildEmpathyExchangeStatusForBothUsers()` (`backend/src/services/empathy-status.ts:276`), a `{ [userId]: EmpathyExchangeStatusResponse }` map, as the `empathyStatuses` field.
- Exposed per partner (`shared/src/dto/empathy.ts:240`): `myAttempt` (their empathy attempt content, *before* the reconciler reveals it), `sharedContext.content`, `mySharedContext.content`, `refinementHint` (coaching on how their attempt fell short), and `myReconcilerResult.gapSummary`.
- Risk: This inverts the core Stage 2 privacy model, in which an empathy attempt stays private until the reconciler judges it ready and the subject consents. The data is published unconditionally as soon as either partner opens the session or the Share tab.
- Why current mitigation is insufficient: the mobile client self-selects its own entry by key (`mobile/src/screens/UnifiedSessionScreen.tsx:866`, `:878`, `:1084`), but that is a *display* filter, not a confidentiality boundary — the partner's content has already reached a device that should never have received it, where it is visible in memory, network inspectors, and Ably debug tooling. `excludeUserId` does not help: it is passed at both `sessions.ts` sites but only suppresses the *actor's* own echo, not the partner who is the subject of the data.
- Fix approach: publish only the recipient's own status per recipient, using the `forUserId` + single `empathyStatus` shape that `empathy.status_updated` already uses at its other two publishers (`stage2.ts:1247`, `services/reconciler/state.ts:336`). The mobile addressing filter (`isRealtimePayloadAddressedToCurrentUser`) already drops payloads not addressed to the current user, and `forUserId` is now typed as a string on all addressed events (`shared/src/contracts/realtime.ts`), so the client side largely exists. Then retire the `empathyStatuses` field and its three self-select reads. This preserves the round-trip saving the map was introduced for — each user still gets their status pushed, just only their own.
- Note: this is a behavior change, so it was deliberately left out of the behavior-preserving chat-modernization program that identified it (2026-07-22).

**E2E Auth Bypass (Not Resolved):**
- Issue: E2E auth bypass (`E2E_AUTH_BYPASS=true` environment variable) is built into production auth middleware
- Status: the bypass logic (`handleE2EAuthBypass()`) lives inline in `backend/src/middleware/auth.ts`; there is no separate `e2e-auth.ts` module. Production auth middleware therefore still contains E2E bypass code, guarded as below.
- Remaining mitigation: every bypass gate (auth middleware, `/api/e2e/*` handlers, CORS, rate-limit skips, session-state, realtime) goes through `isE2EBypassEnabled()` in `backend/src/lib/e2e-bypass.ts`: on only when `E2E_AUTH_BYPASS=true` **and** `NODE_ENV` is exactly `test` or `development` (an allow-list; unset or misspelt is off). `server.ts` refuses to start when the flag is set with any other `NODE_ENV` (work-jv9y review).

**No Input Validation on Controller Parameters:**
- Issue: Controllers receive route parameters directly without schema validation; request bodies validated but route params may not be
- Files: Multiple controllers, e.g., `backend/src/controllers/stage2.ts` uses `req.params.id` without explicit zod/joi schema check
- Risk: Edge cases (missing IDs, malformed UUIDs) may cause unexpected database errors instead of clean 400 response
- Mitigation: Prisma handles invalid IDs gracefully; authorization checks verify user owns resource
- Recommendation: Add middleware to validate route params against schema (e.g., `is-valid-cuid()`)

---

## Fragile Areas Requiring Careful Modification

**Mobile Cache-First Architecture:**
- Files: `mobile/src/hooks/queryKeys.ts`, `mobile/src/hooks/useStages.ts`, `mobile/src/hooks/useSessions.ts`
- Fragility: Query key mismatches cause writes to cache keys nobody reads from; stage updates must be coordinated between multiple hooks
- Safe modification:
  1. Always check `queryKeys.ts` definitions before creating new cache writes
  2. Test mutation + cache update with React Query DevTools
  3. Verify UI updates by checking `useChatUIState` derives correct visibility
  4. Test reload/refresh to ensure derived UI state matches server truth

**Reconciler Empathy Status Machine:**
- Files: `backend/src/services/reconciler/` (modular directory), `backend/src/services/empathy-state-machine.ts`, `backend/src/controllers/stage2.ts`, `backend/src/services/empathy-status.ts`
- Fragility: Multiple tables track related state; cascading deletes may orphan records
- Safe modification:
  1. Use `empathy-state-machine.ts` transition table to validate state changes — `canTransition()` prevents invalid transitions
  2. Check both ReconcilerResult and EmpathyStatus when changing empathy state
  3. Run reconciler tests (`services/__tests__/reconciler.test.ts`, `services/__tests__/empathy-state-machine.test.ts`) after changes
  4. Reconciler circuit breaker (`reconciler/circuit-breaker.ts`) limits refinement loops to max 3 per direction

**Stage Prompts System:**
- Files: `backend/src/services/stage-prompts.ts` (legacy file deleted)
- Fragility: Stage-specific instructions embedded in prompt templates; changes affect AI behavior globally
- Safe modification:
  1. Make prompt changes in stage-prompts.ts (the only prompts file now)
  2. Test with prompt-test scripts before committing
  3. Run live AI E2E test to validate AI still understands stage intent
  4. Document any new prompt tags in comments (e.g., `<thinking>`, `<draft>`)

---

## Missing or Unclear Documentation

**Cache Key Pattern Not Type-Safe:**
- Issue: Query keys defined as string arrays in `queryKeys.ts`; no enforcement that keys used in `useQuery` match keys used in `setQueryData`
- Files: `mobile/src/hooks/queryKeys.ts`, all stage hooks
- Impact: Silent cache misses when keys don't match exactly
- Fix approach: Consider migrating to typed query key factory pattern (e.g., QueryClient `@tanstack/solid-query` style)

**AI Orchestrator Request Routing Logic Undocumented:**
- Issue: `routeModel()` and `scoreAmbiguity()` in `backend/src/services/model-router.ts` decide which model (Haiku/Sonnet/Claude) handles a request; logic not well documented
- Impact: Hard to understand why certain requests route to certain models
- Recommendation: Add docstring explaining routing decision logic; document model cost/latency tradeoffs

**Model Router Has Undocumented Magic Numbers:**
- Issue: `scoreAmbiguity()` uses hardcoded weights (0.2, 0.15) and `routeModel()` uses a threshold of `>= 4` to decide Sonnet vs Haiku, with additive scoring (+4 for mediate, +3 for high-intensity, etc.) — none of these values are documented or justified
- Files: `backend/src/services/model-router.ts` (25-78)
- Impact: Impossible to tune routing behavior without understanding the scoring model; magic numbers make cost/quality tradeoffs opaque
- Fix approach: Add docstring explaining scoring rationale; consider extracting thresholds to named constants

**Scattered TODOs Across Critical Paths:**
- Issue: Incomplete implementations marked with TODO comments in production code
- Files:
  - `backend/src/controllers/people.ts` (128) — `TODO: sum all counts` for frequent sort
  - `backend/src/services/context-assembler.ts` (427) — `TODO: Extract from UserVessel` (themes always empty array)
  - `mobile/src/screens/UnifiedSessionScreen.tsx` (686) — `TODO: Show error toast or UI indicator`
- Impact: Missing functionality silently degrades behavior (e.g., empty themes array in context assembly)
- Fix approach: Triage TODOs — implement or create tracked issues; remove stale ones

**Reconciler Logging (Resolved):**
- ~~Issue: `reconciler.ts` contains 85 console.log/warn/error calls with no structured format~~
- **Resolved**: All logging migrated to Winston structured logger. Reconciler modules (`reconciler/state.ts`, `reconciler/analysis.ts`, `reconciler/sharing.ts`) use `logger.info/warn/error` with automatic request context injection (turnId, sessionId, userId).

**Query Key Type-Safety Gap:**
- Issue: Query keys in `queryKeys.ts` are string arrays (`['sessions', id, 'state'] as const`). Nothing prevents a `setQueryData` call from using a key that differs by one segment from what `useQuery` reads — these mismatches cause silent cache misses
- Files: `mobile/src/hooks/queryKeys.ts`, all hooks using `queryClient.setQueryData()`
- Impact: Bugs from key mismatches are invisible at compile time and hard to detect at runtime
- Fix approach: Consider typed query key factory pattern or wrapper functions that enforce key/value type consistency

**Reconciler Test Coverage (Resolved):**
- ~~Issue: `reconciler.ts` (2320 lines) had zero direct unit or integration tests~~
- **Resolved**: Reconciler refactored into modular `reconciler/` directory and now has direct test coverage via `backend/src/services/__tests__/reconciler.test.ts`. Empathy state machine transitions tested in `backend/src/services/__tests__/empathy-state-machine.test.ts`. Route-level tests also updated in `backend/src/routes/__tests__/reconciler.test.ts`.

---

## Dependencies at Risk

**Bedrock/Claude API Dependence:**
- Risk: Entire AI system depends on AWS Bedrock for Claude models
- Mitigation: Circuit breakers prevent total failure; fallbacks return safe responses
- Recommendation: Monitor Bedrock health; have contingency plan if service is unavailable (e.g., maintenance mode)

**Expo/React Native Ecosystem:**
- Risk: Mobile app built on Expo; platform relies on rapid Expo/RN updates for iOS/Android compatibility
- Mitigation: Expo handles most compatibility concerns
- Recommendation: Keep Expo SDK and RN versions current; test on real devices during major upgrades

---

## Deferred Work / Known Limitations

**Person Removal Not Wired:**
- Status: UI exists but no backend implementation
- Impact: Users can open remove dialog but action is no-op
- Issue: `mobile/app/(auth)/person/[id].tsx` (52)

**Inner Thoughts Linking Not Complete:**
- Status: Schema supports linking inner work sessions to partner sessions; mobile UI prepared but feature disabled
- Impact: Intended feature to reflect during partner sessions not available
- Issue: `mobile/app/(auth)/inner-thoughts/index.tsx` (225)

**Strategy Suggestion Generation Missing:**
- Status: UI prepares for AI-generated strategy suggestions; AI call not hooked up
- Impact: Users see strategy UI but suggestions are hardcoded/empty
- Issue: `backend/src/controllers/stage4.ts` (862)

**Bell Sound for Typing Indicator Not Implemented:**
- Status: Code comments indicate intent but no audio asset loaded
- Issue: `mobile/src/hooks/useSpeech.ts` (471)

---

## Database & Migration Concerns

**Database Transaction Usage (Partially Resolved):**
- Issue: Multi-step operations historically lacked explicit transactions
- Progress: Transactions now used in critical reconciler paths — `reconciler/state.ts` uses serializable transactions in `checkAndRevealBothIfReady()` to prevent race conditions on mutual reveal
- Remaining: Some non-critical multi-step operations still lack explicit transactions
- Files: `backend/src/services/reconciler/state.ts`
- Mitigation: Cascading deletes defined in Prisma schema handle cleanup

**Migration Files Not Audited:**
- Issue: Prisma migrations exist but no review of migration safety/rollback procedures
- Impact: Uncertain if old migrations can rollback cleanly
- Recommendation: Document migration testing procedure; keep backup before production migrations

---

*Concerns audit: 2026-03-11*
