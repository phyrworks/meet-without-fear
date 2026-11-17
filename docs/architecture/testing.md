---
title: Testing Patterns
sidebar_position: 9
description: "Analysis Date: 2026-03-11"
created: 2026-03-11
updated: 2026-11-17
status: living
---
# Testing Patterns

**Analysis Date:** 2026-03-11

## Test Framework

**Backend:**
- Runner: Jest 29.7.0
- Preset: `ts-jest` with ESM support
- Config: `backend/jest.config.js`
- Assertion: Jest built-in matchers

**Mobile:**
- Runner: Jest 29.7.0
- Preset: `jest-expo` 54.0.16
- Config: `mobile/jest.config.js` with module name mapping
- Assertion: Jest + `@testing-library/react-native` 13.3.3

**E2E:**
- Runner: Playwright 1.50.0
- Configs:
  - `e2e/playwright.config.ts` - standard single-browser suite (MOCK_LLM, global fixture ID)
  - `e2e/playwright.live-ai.config.ts` - real Bedrock AI run (slow, separate workflow)
  - `e2e/playwright.two-browser.config.ts` - multi-user scenarios. `testMatch: /two-browser-.*\.spec\.ts/`. `MOCK_LLM=true`, no global fixture ID — each browser sets its own via the `X-E2E-Fixture-ID` header.
- Assertion: Playwright built-in matchers
- **Publishing**: `scripts/ec2-bot/scripts/run-and-publish.sh` wraps any Playwright run and publishes results (screenshots, transcript, metadata) to the [Test Dashboard](../e2e-testing/architecture.md#test-run-publishing--dashboard) (Vercel). Trigger via `@slam_paws test <scenario>` in Slack or run the script directly on EC2.

**Run Commands:**
```bash
# Backend (tiers: see "Which tests to run when" below)
npm run test --workspace=backend              # fast project only (no database)
npm run test:all --workspace=backend          # fast + db + every golden
npm run test:watch --workspace=backend        # Watch mode (fast project)
npm run test -- --verbose --workspace=backend # With console output

# Mobile
npm run test --workspace=mobile               # Run all tests
npm run test:watch --workspace=mobile         # Watch mode

# All workspaces
npm run test                                  # All tests (parallel where safe)

# E2E
npm run test:e2e                              # Smoke tier (2 specs)
npm run test:e2e:full                         # Default + two-browser configs
cd e2e && npx playwright test                 # Standard fixtures (mocked AI)
cd e2e && npx playwright test --headed        # With browser visible
cd e2e && npx playwright test --ui            # Playwright UI mode
cd e2e && npx playwright test --config=playwright.live-ai.config.ts # Real AI

# Coverage (not enforced)
npm run test -- --coverage --workspace=backend
```

## Which tests to run when

| Tier | When | Command | Time |
|---|---|---|---|
| **Inner loop** | every edit | `npm test --workspace=backend -- --findRelatedTests <files>`, plus the one `*.target.test.ts` for the area you touched (`npm run test:db --workspace=backend -- <name>`) | seconds |
| **Before a commit** | each commit | `npm run test` (backend `fast` + shared + mobile) and `npm run check` | ~6 s + 5 s + 7 s, warm cache |
| **Pre-merge** | before merging a branch | `npm run test:premerge --workspace=backend` (fast + db + the five pre-merge goldens); `run-baseline.sh` if `backend/scripts/target-shape` or `prisma/` changed; `npm run test:e2e` if the change reaches the UI | ~4.5 min est. (e2e smoke extra) |
| **Nightly / CI** | CI, or by hand overnight | `npm run test:all --workspace=backend` (CI runs this); `npm run test:e2e:full`; the live-AI config by hand | ~35 min est. |

The backend jest projects (`backend/jest.config.js`) are chosen by file name:

- `fast`: everything else. No database; a suite here that connects fails.
- `db`: `*.target.test.ts`, `*.pg.test.ts`, `src/__tests__/db/`. Each suite clones a golden template into its own database, so it runs on 2 workers (`MWF_DB_WORKERS`). Exhaustive sweeps that cannot catch an app regression (the email domain's Unicode sweeps) run only under `MWF_TEST_ALL=1`, which `test:all` sets.
- `golden`: `*.golden.test.ts`, serial (they read the shared container's statement log). `test:golden:premerge` runs the five that hold the read boundary (session-read, empathy-reveal, author-sees-status-only, choices-hidden-until-shared, needs-hidden-until-shared); the other six (the reveal orders, tombstone, declined-offer, unrevealed-attempt, reflection) run only in `test:golden` / `test:all`.

The e2e tiers (`e2e/`):

- `npm run test:e2e`: smoke, `playwright.smoke.config.ts`. `single-user-journey` and `two-browser-stage-4-redesign` (selection privacy) on one server boot. Kept small on purpose: headless Chromium runs track the memory growth that has panicked the development Mac.
- `npm run test:e2e:full`: `playwright.config.ts` then `playwright.two-browser.config.ts`. No spec runs in both.

Rules that keep the fast tiers fast: a schema invariant goes in step 20 (`backend/scripts/target-shape/trailer.sql`), not in jest; a new privacy rule gets one target test of the refusal, not a new golden; one file per behaviour area, not per review finding.

## Test File Organization

**Location (key test files; 47 backend, 42 mobile total):**
- Backend: `src/__tests__/` directory alongside source code
  - `src/__tests__/prisma-schema.test.ts` - Schema validation
  - `src/routes/__tests__/reconciler.test.ts` - Route-specific tests
  - `src/services/__tests__/ai-orchestrator.test.ts` - AI orchestrator tests
  - `src/services/__tests__/context-retriever.test.ts` - Context retrieval tests
  - `src/services/__tests__/crisis-detector.test.ts` - Crisis detection tests
  - `src/services/__tests__/empathy-state-machine.test.ts` - State machine transition tests
  - `src/services/__tests__/input-sanitizer.test.ts` - Input sanitizer tests
  - `src/services/__tests__/reconciler.test.ts` - Reconciler service tests
  - `src/utils/__tests__/circuit-breaker.test.ts` - Circuit breaker pattern tests
  - `src/utils/__tests__/field-encryption.test.ts` - Field encryption tests
  - `src/lib/__tests__/bedrock-streaming.test.ts` - Bedrock streaming tests
- Mobile: `src/**/__tests__/` co-located with source
  - `src/utils/__tests__/chatUIState.test.ts` - Utility function tests
  - `src/components/__tests__/EmotionalBarometer.test.tsx` - Component tests
  - `src/screens/__tests__/PersonDetailScreen.test.tsx` - Screen tests
- E2E: `e2e/tests/` flat with organized subdirectories
  - `e2e/tests/stage-2-empathy/reconciler/*.spec.ts` - Feature paths, with named fixtures driving outcomes: `user-b-partner-journey` (standard gaps detected), `reconciler-no-gaps` (PROCEED action), `reconciler-circuit-breaker` (forces refinement loop until safety circuit trips)
  - `e2e/tests/two-browser-*.spec.ts` - Multi-user flows requiring two browser contexts (see `playwright.two-browser.config.ts`). Includes `two-browser-stage-2.spec.ts` for the current Stage 2 validation/Feedback Coach path, `two-browser-reconciler-offer-sharing-refinement.spec.ts` for OFFER_SHARING plus revision, and `two-browser-circuit-breaker.spec.ts` which verifies the infinite-refinement safety circuit trips on the 4th attempt
  - `e2e/tests/homepage.spec.ts`, `single-user-journey.spec.ts` - Top-level flows
  - `e2e/helpers/stage-flows.ts` - Composite flow helpers with shared fixture messages (reduces test boilerplate)

**Naming:**
- Backend: `*.test.ts` (single-test-per-file preferred)
- Mobile: `*.test.tsx` (components) or `*.test.ts` (utilities)
- E2E: `*.spec.ts` (test.describe pattern)

**Test Match Pattern:**
```javascript
// Backend: jest.config.js
testMatch: ['**/__tests__/**/*.test.ts']

// Mobile: jest.config.js
// Implicitly matches *.test.tsx and *.test.ts files found by Jest

// E2E: playwright.config.ts
testDir: './tests'
testIgnore: /live-ai-.*\.spec\.ts/  // Exclude live-AI tests by default

// E2E: playwright.two-browser.config.ts
testMatch: /two-browser-.*\.spec\.ts/  // Only multi-user specs
```

**E2E timeouts** (configured in configs; higher than unit/integration):
- Default global timeout: 15 minutes per test for AI-heavy flows (`timeout: 900000`) — e.g. Stage 2 needs ~13 AI interactions plus reconciler round-trips.
- Individual `test.setTimeout(...)` calls further tighten or extend inside specs.

## Test Structure

**Backend Unit Test Pattern:**
```typescript
describe('Prisma Schema', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('Schema Type Validation', () => {
    it('exports all expected models', () => {
      expect(prisma.user).toBeDefined();
      expect(prisma.relationship).toBeDefined();
    });

    it('exports SessionStatus enum with correct values', () => {
      expect(SessionStatus.CREATED).toBe('CREATED');
    });
  });

  describe('Enum Alignment with Shared Package', () => {
    it('SessionStatus enum values match shared package', () => {
      expect(SessionStatus.CREATED).toBe(SharedSessionStatus.CREATED);
    });
  });
});
```

**Mobile Component Test Pattern** (`EmotionalBarometer.test.tsx`):
```typescript
import { render, screen, fireEvent } from '@testing-library/react-native';
import { EmotionalBarometer } from '../EmotionalBarometer';

// Mock external dependencies
jest.mock('@react-native-community/slider', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ testID, value, onValueChange }) => (
      <View testID={testID}>
        <Text>{value}</Text>
      </View>
    ),
  };
});

describe('EmotionalBarometer', () => {
  const defaultProps = {
    value: 5,
    onChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows slider with current value', () => {
    render(<EmotionalBarometer {...defaultProps} />);
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('displays the correct intensity label for low values', () => {
    render(<EmotionalBarometer value={2} onChange={jest.fn()} />);
    const calmElements = screen.getAllByText(/Calm/);
    expect(calmElements.length).toBeGreaterThanOrEqual(1);
  });
});
```

**Mobile Screen Test Pattern** (`PersonDetailScreen.test.tsx`):
```typescript
// Create test helpers for data
function createMockPerson(overrides: Partial<PersonData> = {}): PersonData {
  return {
    id: 'person-123',
    name: 'Alex',
    connectedSince: 'Oct 2024',
    ...overrides,
  };
}

// Wrapper for providers
function renderWithProviders(component: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {component}
    </QueryClientProvider>
  );
}

describe('PersonDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders person details with active session', () => {
    renderWithProviders(<PersonDetailScreen personId="person-123" />);
    expect(screen.getByText('Alex')).toBeTruthy();
  });
});
```

**E2E Test Pattern** (`no-gaps-proceed-directly.spec.ts`):
```typescript
import { test, expect, devices, BrowserContext, Page } from '@playwright/test';
import {
  cleanupE2EData,
  getE2EHeaders,
  SessionBuilder,
  navigateToShareFromSession,
} from '../../../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:8082';

test.use(devices['iPhone 12']);

const FIXTURE_ID = 'reconciler-no-gaps';

// Helper to wait for AI response
async function waitForAIResponse(page: Page, textPattern: RegExp, timeout = 15000) {
  await expect(page.getByText(textPattern)).toBeVisible({ timeout });
  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).not.toBeVisible({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
}

// Helper to create user context
async function createUserContext(
  browser: import('@playwright/test').Browser,
  userEmail: string,
  userId: string,
  fixtureId?: string
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...devices['iPhone 12'],
    extraHTTPHeaders: getE2EHeaders(userEmail, userId, fixtureId),
  });
  const page = await context.newPage();
  return { context, page };
}

test.describe('Reconciler: No Gaps Detected → Proceed Directly', () => {
  const userA = { email: 'shantam@e2e.test', name: 'Shantam' };
  const userB = { email: 'darryl@e2e.test', name: 'Darryl' };

  let sessionId: string;
  let userAId: string;
  let userBId: string;
  let userAContext: BrowserContext;
  let userAPage: Page;

  test.beforeEach(async ({ browser, request }) => {
    await cleanupE2EData().catch(() => {});

    const setup = await new SessionBuilder()
      .userA(userA.email, userA.name)
      .userB(userB.email, userB.name)
      .startingAt('EMPATHY_SHARED_A')
      .setup(request);

    sessionId = setup.session.id;
    userAId = setup.userA.id;
    userBId = setup.userB!.id;

    const userASetup = await createUserContext(browser, userA.email, userAId, FIXTURE_ID);
    userAContext = userASetup.context;
    userAPage = userASetup.page;
  });

  test.afterEach(async () => {
    await userAContext?.close();
  });

  test('No share suggestion shown → Both users proceed to empathy reveal', async ({ request }) => {
    await userAPage.goto(`${APP_BASE_URL}`);
    await expect(userAPage.getByText('No gaps')).toBeVisible();
  });
});
```

## Mocking

**Framework:**
- Jest: `jest.mock()` and `jest.fn()`
- React Query: `QueryClient` with `defaultOptions: { queries: { retry: false } }`
- Playwright: No component-level mocks — uses real browser automation. LLM responses are deterministic via `MOCK_LLM=true` + fixture-based responses (see Fixtures below).

**Patterns:**

Backend (minimal mocking - prefer integration):
```typescript
// Mock Prisma only when testing error paths
jest.mock('../lib/prisma', () => ({
  prisma: {
    user: {
      create: jest.fn(),
    },
  },
}));
```

Mobile (more extensive - React Native compatibility):
```typescript
// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
  }),
  Stack: { Screen: () => null },
}));

// Mock external libraries
jest.mock('lucide-react-native', () => ({
  MoreVertical: () => 'MoreVerticalIcon',
  Plus: () => 'PlusIcon',
}));

// Mock custom hooks
const mockUsePerson = jest.fn();
jest.mock('../../hooks/usePerson', () => ({
  usePerson: (personId: string) => mockUsePerson(personId),
}));
```

E2E (no mocks - real browser automation):
```typescript
// Use test fixtures via X-E2E-Fixture-ID header or env var
const context = await browser.newContext({
  extraHTTPHeaders: getE2EHeaders(userEmail, userId, fixtureId),
});

// Fixtures control API response behavior (e.g., 'reconciler-no-gaps' returns PROCEED)
```

**What to Mock:**
- External native modules (React Native specific)
- Navigation and routing (expo-router)
- Third-party UI libraries
- Custom hooks (when testing dependent components in isolation)

**What NOT to Mock:**
- Backend database layer (use real Prisma or test DB)
- React Query itself (test with real QueryClient)
- Business logic utils (test pure functions directly)
- Enums and types

## Fixtures and Factories

**Test Data Builders:**
```typescript
// Backend example from e2e
class SessionBuilder {
  userA(email: string, name: string): this { ... }
  userB(email: string, name: string): this { ... }
  startingAt(stageKey: string): this { ... }
  async setup(request: APIRequestContext): Promise<SetupResult> { ... }
}

// Usage
const setup = await new SessionBuilder()
  .userA('alice@example.com', 'Alice')
  .userB('bob@example.com', 'Bob')
  .startingAt('EMPATHY_SHARED_A')
  .setup(request);
```

**Mobile Inline Factories:**
```typescript
// Helper function to create mock data with defaults
function createMockPerson(overrides: Partial<PersonData> = {}): PersonData {
  return {
    id: 'person-123',
    name: 'Alex',
    initials: 'AL',
    connectedSince: 'Oct 2024',
    activeSession: null,
    ...overrides,
  };
}

// Usage in test
it('shows active session indicator', () => {
  const person = createMockPerson({
    activeSession: { id: 'session-1', stage: Stage.WITNESS },
  });
  render(<PersonCard person={person} />);
  expect(screen.getByText('Active')).toBeTruthy();
});
```

**E2E Fixtures:**
Located in `e2e/helpers/` (directory with index.ts re-export):
- `getE2EHeaders(email, userId, fixtureId?)` - Returns `X-E2E-User-ID` / `X-E2E-User-Email` for auth bypass plus an optional `X-E2E-Fixture-ID` that selects the per-request fixture (required for two-browser runs where each user needs its own fixture)
- `SessionBuilder` - Orchestrates setup via REST API
- `cleanupE2EData()` - Clears DB between tests
- `navigateToShareFromSession()` - Navigates to Share tab

Fixtures configured in `playwright.config.ts`:
```typescript
// Custom fixtures passed to test via REQUEST environment
webServer: webServers(process.env.E2E_FIXTURE_ID || 'default-fixture');

// Each test specifies: FIXTURE_ID = 'reconciler-no-gaps'
// API reads from header: X-E2E-Fixture-ID (controls mocked LLM responses)
```

## Coverage

**Requirements:** Not enforced (no CI gate)

**View Coverage:**
```bash
npm run test -- --coverage --workspace=backend
npm run test -- --coverage --workspace=mobile
```

**Strategy:**
- Critical paths well-tested (schemas, enums, pure functions)
- E2E tests provide end-to-end coverage (real flow validation)
- Unit tests for error handling and edge cases
- Mobile component tests verify UI rendering (functional not pixel-perfect)

## Test Types

**Unit Tests:**
- Scope: Single function or component in isolation
- Approach: Mock dependencies, test pure logic
- Examples:
  - `backend/src/__tests__/prisma-schema.test.ts` - Enum validation
  - `mobile/src/utils/__tests__/chatUIState.test.ts` - State derivation
  - `mobile/src/components/__tests__/EmotionalBarometer.test.tsx` - Component rendering
- Run: `npm run test`

**Integration Tests:**
- Scope: Multiple components/services working together
- Approach: Real databases (test DB), real API calls (backend tests)
- Examples:
  - Backend route tests hitting real Prisma
  - Mobile screens with QueryClientProvider and real hooks
- Run: `npm run test` (same as unit)

**E2E Tests:**
- Scope: Complete user journey through app
- Approach: Real browser automation (Playwright) against a real backend with `MOCK_LLM=true`. AI responses come from fixtures keyed by `X-E2E-Fixture-ID` header or the `E2E_FIXTURE_ID` env var.
- Examples:
  - `e2e/tests/single-user-journey.spec.ts` - Full session flow
  - `e2e/tests/stage-2-empathy/reconciler/*.spec.ts` - Feature-specific flows
  - `e2e/tests/two-browser-stage-2.spec.ts` - Two-user Stage 2 validation path with Feedback Coach coverage
  - `e2e/tests/two-browser-reconciler-offer-sharing-refinement.spec.ts` - Two-user OFFER_SHARING, Activity Drawer, revision, and validation path
  - `e2e/tests/live-ai-full-flow.spec.ts` - Real AI (slow, optional)
- Run: `npm run e2e` (headless) or `npm run e2e:headed`

## Common Patterns

**Async Testing (Backend):**
```typescript
// Jest async/await pattern
describe('Database Operations', () => {
  it('creates user with email', async () => {
    const user = await prisma.user.create({
      data: { email: 'test@example.com' },
    });
    expect(user.id).toBeDefined();
  });

  // Cleanup
  afterAll(async () => {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });
});
```

**Async Testing (Mobile):**
```typescript
// React Query with async operations
it('loads person data on mount', async () => {
  mockUsePerson.mockReturnValue({
    data: createMockPerson(),
    isLoading: false,
  });

  renderWithProviders(<PersonDetailScreen personId="person-123" />);

  // Wait for async query
  await waitFor(() => {
    expect(screen.getByText('Alex')).toBeTruthy();
  });
});
```

**Async Testing (E2E):**
```typescript
// Playwright wait patterns
test('shows AI response after user sends message', async ({ page }) => {
  await page.getByTestId('message-input').fill('Hello');
  await page.getByTestId('send-button').click();

  // Wait for typing indicator to appear then disappear
  const typingIndicator = page.getByTestId('typing-indicator');
  await expect(typingIndicator).toBeVisible();
  await expect(typingIndicator).not.toBeVisible({ timeout: 15000 });

  // Verify response text appears
  await expect(page.getByText(/I understand/)).toBeVisible();
});
```

**Error Testing (Backend):**
```typescript
// Testing error paths
it('throws NotFoundError when session not found', async () => {
  expect(async () => {
    await getSession('nonexistent-id');
  }).rejects.toThrow(NotFoundError);
});

// Testing validation errors
it('throws ValidationError for invalid input', () => {
  expect(() => {
    alignmentSchema.parse({ score: 150 }); // > max of 100
  }).toThrow(ZodError);
});
```

**Error Testing (Mobile):**
```typescript
// Testing error states in components
it('shows error message on mutation failure', async () => {
  const mockError = new Error('Network failed');
  mockMutation.mockRejectedValueOnce(mockError);

  renderWithProviders(<Component />);
  fireEvent.press(screen.getByText('Submit'));

  await waitFor(() => {
    expect(screen.getByText(/Network failed/)).toBeTruthy();
  });
});
```

**Console Output Control (Backend):**
```javascript
// jest.config.js - Silent by default
{
  silent: true,
  // Use --verbose flag to see console output:
  // npm run test -- --verbose --workspace=backend
}

// Setup file patterns in backend/src/__tests__/setup.ts
// Silences expected noise from services:
const silencedLogPatterns = [
  /^\[Realtime\]/,
  /^\[Push\]/,
  /^\[sendMessage[:\]]/,
  /^prisma:/,
];

// Override console methods to filter patterns
console.log = (...args) => {
  const message = args[0]?.toString() || '';
  const shouldSilence = silencedLogPatterns.some(pattern => pattern.test(message));
  if (!shouldSilence) {
    originalConsoleLog.apply(console, args);
  }
};
```

## Test Execution & CI

**Local Development:**
```bash
# Run tests in watch mode while developing
npm run test:watch --workspace=mobile

# Run with output when debugging
npm run test -- --verbose --workspace=backend

# Run single test file
npm run test -- src/__tests__/prisma-schema.test.ts --workspace=backend

# Run tests matching pattern
npm run test -- -t "SessionStatus" --workspace=backend
```

**Verification Before Commit:**
```bash
# Type check all workspaces
npm run check

# Run all tests across workspaces
npm run test

# Run E2E tests (optional, slow)
npm run e2e
```

**CI Pipeline:**
- `.github/workflows/ci.yml` runs on pushes to `main` and `phoenix/target-shape` and on PRs into `main` or `phoenix/**` (a feature branch is CI'd through its PR; a docs-only push skips the code jobs), as two parallel jobs, both with `TZ=UTC`:
  - `checks`: `npm run check` (type-check only; eslint is not clean yet, work-k5fk.10.20), then the shared and mobile jest suites (no database);
  - `backend` (the target-shape gate): a `mwf-postgres` container from production's PG 18 image pin, built as a developer's is (`docs/development/local-setup.md`: superuser `mwf_user`, `infra/aws/roles.sql` with the `mwf_*_dev` passwords and the D0 check asserted, a `podman` → `docker` shim so the scripts and the golden trace reader work unchanged), `run-baseline.sh ts7_ci_gate --as-migrator`, `mwf_target_test` owned by and deployed as `mwf_migrator`, one golden template per committed manifest (`golden/cli.ts build <stage>`; the rebuilt manifests must equal the committed ones with seeded ids and `builtAt` masked), then `npm run test:all` in backend (all three jest projects) with `DATABASE_URL` (superuser) and `APP_`/`JOB_`/`AUTH_DATABASE_URL` (role logins) on `mwf_target_test`, `GOLDEN_DATABASE_URL`, and `NODE_OPTIONS=--max-old-space-size=8192`.
  - `CI Result` is the single gate job for branch protection.
- A separate `python-eval` CI job runs when eval files change (`scripts/mwf_*.py`, `eval/gold-scenarios.json`, `eval/icm/**`, `eval/moments/**`, etc.): runs `py_compile` syntax checks across all gold-loop scripts and executes `scripts/test_mwf_moment_eval.py`
- E2E tests run on merge to main (slower, separate job)
- Live AI tests optional (manual trigger)

---

*Testing analysis: 2026-03-11*
