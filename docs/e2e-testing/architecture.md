---
title: E2E Testing Architecture
sidebar_position: 2
description: This document describes the end-to-end testing approach used in Meet Without Fear.
created: 2026-03-11
updated: 2026-04-28
status: living
---
# E2E Testing Architecture

This document describes the end-to-end testing approach used in Meet Without Fear.

## Overview

The E2E tests run against a **real backend** with a **real database**, mocking only the LLM (AI responses) and authentication (Clerk). This provides high confidence that the full stack works correctly while maintaining deterministic, reproducible tests.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Playwright Test                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  E2E Headers: x-e2e-user-id, x-e2e-fixture-id, etc.      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Mobile App (Expo Web)                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  E2EAuthProvider: Bypasses Clerk, injects E2E headers    │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Express)                           │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────┐  │
│  │ Auth Bypass    │  │ Real Routes    │  │ Real Database    │  │
│  │ (E2E headers)  │  │ & Business     │  │ (test DB)        │  │
│  └────────────────┘  │ Logic          │  └──────────────────┘  │
│                      └────────────────┘                         │
│  ┌────────────────────────────────────────────────────────────┐│
│  │ LLM Mock: Returns fixture responses instead of Bedrock    ││
│  └────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Real Ably (if configured)                  │
│  Real-time messaging works when ABLY_API_KEY is set             │
│  Falls back to mock tokens if not configured                    │
└─────────────────────────────────────────────────────────────────┘
```

## What's Real vs. Mocked

| Component | Real/Mocked | Notes |
|-----------|-------------|-------|
| Backend Routes | Real | Full Express server runs |
| Database | Real | PostgreSQL test database |
| Business Logic | Real | All services execute |
| Prisma/ORM | Real | Real queries, real transactions |
| Authentication | Mocked | Header bypass replaces Clerk JWT |
| LLM (Bedrock) | Mocked | Fixture responses returned |
| Ably | Real (optional) | Uses mock tokens if no API key |

## LLM Mocking

### Toggle Mechanism

The `MOCK_LLM=true` environment variable controls LLM behavior:

```typescript
// backend/src/lib/bedrock.ts
export async function getModelCompletion(messages, options) {
  if (process.env.MOCK_LLM === 'true') {
    return null; // Triggers fixture fallback in AI Orchestrator
  }
  // ... real Bedrock call
}
```

### Fixture-Based Responses

When `MOCK_LLM=true`, the AI Orchestrator loads responses from TypeScript fixture files:

```typescript
// backend/src/fixtures/user-a-full-journey.ts
import { E2EFixture } from './types';

export const userAFullJourney: E2EFixture = {
  name: 'User A Full Journey',
  description: 'Complete single user journey...',

  seed: {
    users: [
      {
        id: 'user-a',
        email: 'user-a@e2e.test',
        clerkId: 'e2e_clerk_user_a',
        name: 'Alice Test',
      },
    ],
  },

  responses: [
    {
      user: "Hi, I'm having a conflict with my partner",
      ai: `<thinking>
Mode: ONBOARDING
Intensity: 3
FeelHeardCheck: N
</thinking>

Hi there. I'm glad you reached out...`,
    },
    {
      user: "They never listen to me",
      ai: `<thinking>
Mode: EMPATHY
Intensity: 5
FeelHeardCheck: N
</thinking>

That sounds really frustrating...`,
    },
  ],

  operations: {
    'reconciler-analysis': {
      response: { /* reconciler result */ },
    },
    'reconciler-share-suggestion': {
      response: { suggestedContent: '...', reason: '...' },
    },
  },
};
```

### Response Selection

Responses are selected by **turn index**:
- Turn 1 → `responses[0]`
- Turn 2 → `responses[1]`
- etc.

This ensures deterministic, reproducible tests.

### Per-Request Fixture Selection

The fixture ID flows through request context:

1. Test sets `x-e2e-fixture-id` header
2. Backend middleware captures it into AsyncLocalStorage
3. AI Orchestrator calls `getE2EFixtureId()` to retrieve it
4. Fixture loaded and response selected by turn index

This allows different tests to use different fixtures without restarting the server.

## Authentication Bypass

### How It Works

When `E2E_AUTH_BYPASS=true`:

1. **Test creates headers:**
   ```typescript
   const headers = getE2EHeaders('alice@e2e.test', 'user-a', 'user-a-journey');
   // Returns: { 'x-e2e-user-id': 'user-a', 'x-e2e-user-email': 'alice@e2e.test', ... }
   ```

2. **Mobile app injects headers:**
   `E2EAuthProvider` replaces Clerk and configures axios to add E2E headers to all requests

3. **Backend middleware handles bypass:**
   ```typescript
   // If E2E headers present, upsert user and skip Clerk JWT verification
   const user = await handleE2EAuthBypass(req);
   ```

### Mobile E2E Auth Provider

```typescript
// mobile/src/providers/E2EAuthProvider.tsx
export function E2EAuthProvider({ children }) {
  // Reads e2e-user-id, e2e-user-email from URL params
  // Configures API client to inject these as headers
  // Provides mock auth context to the app
}
```

## Test Fixtures

### Structure

Fixtures are TypeScript files in `backend/src/fixtures/` that define:

- **seed**: Users and initial data to create
- **responses**: Array of user/AI exchange pairs (indexed by turn)
- **operations**: Non-streaming AI responses (reconciler, share suggestions)

All fixtures are registered in `backend/src/fixtures/index.ts`:

```typescript
export const fixtureRegistry: Record<string, E2EFixture> = {
  'flat-array-fixture': flatArrayFixture,
  homepage,
  'reconciler-circuit-breaker': reconcilerCircuitBreaker,
  'reconciler-no-gaps': reconcilerNoGaps,
  'reconciler-offer-optional': reconcilerOfferOptional,
  'reconciler-offer-sharing': reconcilerOfferSharing,
  'reconciler-refinement': reconcilerRefinement,
  'stage-3-needs': stage3Needs,
  'stage-4-strategies': stage4Strategies,
  'test-fixture': testFixture,
  'user-a-full-journey': userAFullJourney,
  'user-b-partner-journey': userBPartnerJourney,
};
```

### Fixture Loading

```typescript
// backend/src/lib/e2e-fixtures.ts
export function getFixtureResponseByIndex(fixtureId: string, index: number): string
export function getFixtureOperationResponse(fixtureId: string, operation: string): string
```

Fixtures are compiled TypeScript modules, providing type safety and IDE support.

## State Factory

To avoid navigating through the entire UI flow, tests can create sessions at specific stages:

```typescript
// In test
await new SessionBuilder(request)
  .userA('alice@e2e.test', 'Alice')
  .userB('bob@e2e.test', 'Bob')
  .startingAt('FEEL_HEARD_B')
  .build();
```

### Available Stages

| Stage | Description |
|-------|-------------|
| `CREATED` | Session created, compact not signed |
| `EMPATHY_SHARED_A` | User A completed Stage 1 |
| `FEEL_HEARD_B` | User B felt heard, reconciler ready |
| `RECONCILER_SHOWN_B` | User B felt heard, reconciler returned `OFFER_SHARING` (significant gaps), share-offer row transitioned to `OFFERED` once the subject fetched it |
| `CONTEXT_SHARED_B` | Both users active, context shared |
| `EMPATHY_REVEALED` | Both users shared empathy and validated each other (empathy reveal complete) |
| `NEED_MAPPING_COMPLETE` | Stage 3: Both users identified needs and confirmed common ground |
| `STRATEGIC_REPAIR_COMPLETE` | Stage 4: Strategies collected, ranked, and agreement created |

### Implementation

The State Factory (`backend/src/testing/state-factory.ts`) creates all required data for a given stage atomically, in one Prisma transaction. It has two layers behind it:

- **Scenario model** (`backend/src/testing/fixture-scenarios/scenarios.ts`, types in `scenario-model.ts`): each `TargetStage` is a declarative, schema-independent description — the participants, the milestones each has reached (`compact_signed`, `feel_heard`, `empathy_validated`, `needs_shared`, `choices_shared`, `closed`, …, the keys of the target schema's `milestone` table) with timestamps, and the content they produced (messages, empathy attempt, needs, proposals and choices, reconciler result). No stage numbers or `gatesSatisfied` keys appear in it.
- **Current-shape writer** (`backend/src/testing/fixture-scenarios/current-shape.ts`): translates a scenario into today's tables — `StageProgress` rows, stage integers, `gatesSatisfied` JSON, `Session.status`, `Invitation` flags. Its milestone ↔ gate-key table is `GATE_ENCODING`. It reproduces the pre-rebuild factory's rows exactly (same values, timestamp lattice and write order), which is what keeps the recorded golden suite valid across a fixture rebuild.

To add a stage, add a `TargetStage` member (`fixture-scenarios/target-stage.ts`) and a builder in `scenarios.ts`; the writer needs no change unless the scenario uses content it has never written.

## Ably (Real-Time Messaging)

### When Configured

If `ABLY_API_KEY` is set, tests use **real Ably**:
- Real-time events are published and received
- Tests can verify actual real-time behavior

### When Not Configured

The backend returns mock tokens that allow the client to initialize:

```typescript
// Returns mock token with full capability
{
  keyName: 'mock-key-name',
  capability: JSON.stringify({ '*': ['subscribe', 'publish'] }),
  clientId: user.id,
  // ...
}
```

### Backend Mocking (Unit Tests)

For unit tests (not E2E), there's a Jest mock:

```typescript
// backend/src/services/__mocks__/realtime.ts
export const publishSessionEvent = jest.fn().mockResolvedValue(undefined);
```

## Test Infrastructure

### Playwright Configuration

```typescript
// e2e/playwright.config.ts
export default defineConfig({
  testDir: './tests',
  workers: 1,  // Sequential to avoid DB conflicts
  use: {
    viewport: { width: 375, height: 667 }, // iPhone 12
  },
  webServer: [
    {
      command: 'npm run dev:api',
      port: 3000,
      env: {
        E2E_AUTH_BYPASS: 'true',
        MOCK_LLM: 'true',
      },
    },
    {
      // --no-dev forces a production-mode bundle for deterministic rendering on slow hardware (EC2).
      command: 'cd ../mobile && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=http://localhost:3000 npx expo start --web --port 8082 --no-dev',
      port: 8082,
      timeout: 300000, // 300s for cold production bundle compilation
    },
  ],
});
```

### Global Setup

Before tests run, `global-setup.ts`:
1. Truncates all test tables (with CASCADE)
2. Runs pending migrations

### Test Structure

```typescript
import { cleanupE2EData, getE2EHeaders, SessionBuilder } from '../helpers';

test.beforeEach(async ({ request }) => {
  await cleanupE2EData(request);
});

test('user journey', async ({ page, request }) => {
  // Set fixture for this test
  await page.setExtraHTTPHeaders(getE2EHeaders(email, userId, 'user-a-journey'));

  // Create session at specific stage
  const session = await new SessionBuilder(request)
    .withUserA(email, 'Alice')
    .atStage('CREATED')
    .build();

  // Navigate and interact
  await page.goto(`/session/${session.id}?e2e-user-id=${userId}&e2e-user-email=${email}`);

  // Assertions...
});
```

## E2E Helper Routes

Enabled only when `E2E_AUTH_BYPASS=true`:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/e2e/cleanup` | Delete all `@e2e.test` users and related data |
| `POST /api/e2e/seed` | Create a test user |
| `POST /api/e2e/seed-session` | Create session at specific stage |
| `POST /api/e2e/trigger-reconciler` | Manually trigger reconciler for a session |

## Key Design Decisions

### Why Real Backend + Mocked LLM?

- **High confidence**: Tests exercise real routes, real database, real business logic
- **Deterministic**: Fixture responses ensure consistent behavior
- **Fast**: No LLM latency (responses return immediately)
- **No credentials needed**: Tests work without AWS/Bedrock access

### Why Per-Request Fixture Selection?

- Different tests can use different fixtures
- No server restart between tests
- Parallel test runs possible (with separate fixtures)

### Why State Factory?

- Avoids lengthy UI navigation to reach specific states
- Tests can focus on the behavior being tested
- Faster test execution

### Why Sequential Test Execution?

- Avoids database conflicts between tests
- Simpler cleanup/setup patterns
- More reliable than parallel with shared DB

## File Locations

| File | Purpose |
|------|---------|
| `e2e/playwright.config.ts` | Playwright configuration |
| `e2e/playwright.live-ai.config.ts` | Playwright config for live AI tests (real LLM, no mocking) |
| `e2e/global-setup.ts` | Pre-test database cleanup |
| `e2e/helpers/` | Test utilities (SessionBuilder, headers) |
| `e2e/reporters/test-dashboard-reporter.ts` | Custom Playwright reporter; writes `dashboard-summary.json` for publishing |
| `backend/src/fixtures/` | TypeScript fixture definitions |
| `backend/src/fixtures/index.ts` | Fixture registry |
| `backend/src/fixtures/types.ts` | Fixture type definitions |
| `backend/src/lib/e2e-fixtures.ts` | Fixture loading logic |
| `backend/src/lib/bedrock.ts` | LLM mock toggle |
| `backend/src/routes/e2e.ts` | E2E helper endpoints |
| `backend/src/testing/state-factory.ts` | Session stage creation (public surface) |
| `backend/src/testing/fixture-scenarios/` | Stage scenarios (milestones + content) and the current-shape writer |
| `mobile/src/providers/E2EAuthProvider.tsx` | Mobile auth bypass |

## Test Run Publishing & Dashboard

The **MWF Test Dashboard** (`tools/test-dashboard/`) is a Vercel-deployed React UI for browsing Playwright test runs, screenshots, and snapshots. It replaces Slack screenshot threads as the primary browse surface.

### Publishing pipeline (`run-and-publish.sh`)

`scripts/ec2-bot/scripts/run-and-publish.sh` wraps a Playwright run and publishes results:

1. Selects the right config based on scenario prefix (`two-browser-*`, `live-ai-*`, or default)
2. Appends `e2e/reporters/test-dashboard-reporter.ts` to capture a `dashboard-summary.json`
3. Calls `scripts/ec2-bot/scripts/write-test-result.ts` to upload screenshots to Vercel Blob and PATCH the run row in Vercel Postgres

Artifacts written per run:
- `e2e/test-results/dashboard-summary.json` — source of truth for the writer
- `e2e/test-results/dashboard-screenshots/*.png` — screenshots renamed in step order
- `e2e/test-results/dashboard-transcript.txt` — AI conversation transcript

### Slack trigger (`@slam_paws test`)

Any Slack channel where the bot is present accepts:

```
@slam_paws test single-user-journey
@slam_paws test two-browser-stage-2
@slam_paws test stage-3-4-complete from-snapshot:01HK1234
```

- Bot reacts 👀 and posts a thread reply immediately
- `run-and-publish.sh` runs in the background (non-blocking; multiple in-flight OK)
- On completion: reaction swaps to ✅ (pass) or ❌ (fail) and a dashboard URL is posted

Scenario names must match `[a-z0-9][a-z0-9-]*` (shell-safety guard).

### On-demand only

Test-dashboard runs are triggered on-demand (Slack or SSH) — there is no scheduled cron. See `scripts/ec2-bot/crontab.txt` for the comment explaining the tradeoff.

### Required env vars (EC2 bot)

| Var | Purpose |
|-----|---------|
| `TEST_DASHBOARD_API_URL` | e.g. `https://mwf-test-dashboard.vercel.app` |
| `BOT_WRITER_TOKEN` | Bot write token for the dashboard API |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token for screenshot uploads |

### Dashboard architecture

- **Frontend**: React 19 + Vite + react-router-dom v7, deployed to Vercel
- **API**: `tools/test-dashboard/api/*.ts` — Vercel serverless functions
- **Storage**: Vercel Postgres (run/snapshot metadata) + Vercel Blob (screenshots)
- **Realtime**: Ably channel `test-runs:updates` for live progress

## Two-Browser Testing

Two-browser tests simulate both users simultaneously in separate browser contexts:

**Configuration:** `e2e/playwright.two-browser.config.ts`
- Timeout: 900 seconds per test. Single-browser reconciler specs typically override the default via `test.setTimeout(300_000)` (5 min) because they chain many AI calls through the reconciler.
- Uses real Ably for real-time event verification between browsers
- `TwoBrowserHarness` manages two browser contexts with separate auth headers

**E2E Helper Endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `POST /api/e2e/cleanup` | Delete all `@e2e.test` users and their related data (sessions, vessels, consent records, etc.) |
| `POST /api/e2e/seed` | Create a test user |
| `POST /api/e2e/seed-session` | Create session at specific stage |
| `POST /api/e2e/trigger-reconciler` | Manually trigger reconciler for a session |

**Additional Test Helpers** (defined in `e2e/helpers/test-utils.ts`):
- `handleMoodCheck(page)` — handles the mood check prompt if it appears
- `signCompact(page)` — helper to sign compact agreement
- `confirmFeelHeard(page)` — helper to confirm feel-heard
- `waitForAIResponse(page, textPattern, timeout?)` — polls the chat for an AI response matching a regex pattern (default timeout 15s). There is no `waitForAnyAIResponse` helper; tests that want to wait for "any" response pass a broad pattern like `/.+/`.
- `sendAndWaitForPanel()` — sends message and waits for panel to appear

**Stage Flow Helpers** (defined in `e2e/helpers/stage-flows.ts`):
- Composite flow helpers to reduce test boilerplate across E2E tests
- Shared fixture messages: `USER_A_STAGE1_MESSAGES`, `USER_A_STAGE2_MESSAGES`, etc.
- Helper functions: `completeStage0ForBothUsers()`, `completeUserAWitnessing()`, `shareEmpathy()`
- Used by two-browser tests and reconciler tests to avoid duplicating setup code

**Stage 2 validation coverage:**
- `two-browser-stage-2.spec.ts` exercises the current multi-user Stage 2 exchange, including the "Not quite yet" validation branch and Feedback Coach handoff.
- `two-browser-reconciler-offer-sharing-refinement.spec.ts` covers the asymmetric reconciler `OFFER_SHARING` path, the Activity Drawer/share-topic flow, context delivery to the guesser, revision, and final validation screenshots.
- `e2e/helpers/test-utils.ts` treats the Activity Drawer as the canonical share surface; older `/share` navigation is no longer part of the current app flow.

**Fixture Operations Registry:**
Each fixture can define `operations` for non-streaming AI responses (reconciler analysis, share suggestions). The registry maps operation names to fixture response objects.
