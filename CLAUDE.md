# Meet Without Fear Development

## Development Practices

### Test-Driven Development

- Write tests first, then implementation
- Run `npm run test` in the relevant workspace before considering work complete
- Run `npm run check` to verify types before committing
- Backend tests run in silent mode by default; use `--verbose` flag to see console output when debugging

### Code Organization

- **Shared types in `shared/`** - All DTOs, contracts, and cross-workspace types
- **Small, testable functions** - Each function does one thing
- **Logic separate from views** - Mobile: hooks/services for logic, components for UI

### Verification Before Completion

Always run before considering a task done:

```bash
npm run check   # Type checking across all workspaces
npm run test    # Tests across all workspaces
```

### Git Workflow

- Commit and push often (small, focused commits)
- Each commit should pass check and test

### Database Migrations

- **Never use `prisma db push`** - Always create proper migrations
- Use `npx prisma migrate dev --name <description>` to create migrations

### Database Queries

To run ad-hoc Prisma queries, create a temp file in `backend/src/` that imports from `./lib/prisma` and run with `npx ts-node`.

## Documentation

### Doc Routing Table

All routes below point at living docs under `docs/` (topical layout). When working on a task, consult the relevant doc first, then cross-reference with the code.

| Task Area | Primary Doc | Secondary |
|-----------|-------------|-----------|
| **Product concept / philosophy** | `docs/product/concept.md` | `docs/product/product-philosophy.md`, `docs/product/user-journey.md` |
| **Conversation stages (0–4)** | `docs/product/stages/index.md` | `docs/product/stages/stage-<n>-*.md` |
| **Product mechanisms** | `docs/product/mechanisms/index.md` | `docs/product/mechanisms/<mechanism>.md` |
| **Inner-work features** | `docs/product/inner-work/index.md` | `docs/product/inner-work/<feature>.md` |
| **Privacy / Vessel model** | `docs/product/privacy/index.md` | `docs/product/privacy/vessel-model.md` |
| **Backend architecture** | `docs/architecture/backend-overview.md` | `docs/architecture/structure.md`, `docs/backend/overview/architecture.md` |
| **Backend API (by stage / feature)** | `docs/backend/api/index.md` | `docs/backend/api/stage-<n>.md`, etc. |
| **Backend prompting / AI** | `docs/backend/prompting-architecture.md` | `docs/backend/prompts/index.md`, `docs/backend/prompt-caching.md` |
| **Reconciler / empathy** | `docs/backend/reconciler-flow.md` | `docs/diagrams/reconciler-paths.md` |
| **Database / Prisma schema** | `docs/backend/data-model/prisma-schema.md` | `backend/prisma/schema.prisma` |
| **Backend security / RLS** | `docs/backend/security/index.md` | `docs/backend/security/rls-policies.md` |
| **Backend state machine** | `docs/backend/state-machine/index.md` | `docs/backend/state-machine/retrieval-contracts.md` |
| **Mobile architecture** | `docs/architecture/structure.md` | |
| **Mobile wireframes** | `docs/mobile/wireframes/index.md` | `docs/mobile/wireframes/<screen>.md` |
| **Testing** | `docs/architecture/testing.md` | `docs/e2e-testing/architecture.md` |
| **Integrations (Ably, Clerk, Bedrock)** | `docs/architecture/integrations.md` | |
| **Code conventions** | `docs/architecture/conventions.md` | |
| **Tech stack** | `docs/architecture/stack.md` | |
| **Deployment** | `docs/deployment/index.md` | `infra/aws/README.md`, `docs/deployment/environment-variables.md` |
| **Infrastructure (slam-bot, EC2, Vercel)** | `docs/infrastructure/index.md` | |
| **Known concerns / tech debt** | `docs/architecture/concerns.md` | |
| **Historical plans/specs** | `docs/archive/index.md` | |

**Fallback**: If no route matches, check `docs/index.md` or search the codebase.

**Cross-doc consistency**: `docs/canonical-facts.json` lists values that appear across multiple docs (service IDs, model IDs, stage names, etc.). When changing any of those, update the JSON and all referencing docs together.

**Doc-code mapping**: `docs/code-to-docs-mapping.json` maps code path globs to the docs that describe them. The `docs-impact` GitHub Action uses this to flag PRs that change mapped code without updating the doc.

### Documentation Rules

- **Living docs** (`docs/` except `archive/`): Always reflect current state. Update when code changes.
- **Archive docs** (`docs/archive/`): Read-only. Never update.
- **Planning docs** (`.planning/`): Working / aspirational documents. May be stale; not authoritative for current code state. Do not list as primary docs here — promote to `docs/` when the work lands.

## State Management Architecture

The mobile app uses **Cache-First** (Single Source of Truth) via React Query.

### Rules

1. **If it's on screen, it's in cache** — Never use `useState`/`useRef` to bridge user actions to server responses. Derive UI state from cache.
2. **Optimistic updates via `onMutate`** — Write expected results to cache immediately, rollback in `onError`.
3. **Indicators are data** — Timeline indicators derived from timestamps in cache via `deriveIndicators()` in `chatListSelector.ts`.
4. **Typing indicator derived from last message role** — `role === USER` means waiting for AI, not a boolean flag.
5. **Query keys centralized** in `mobile/src/hooks/queryKeys.ts`. All hooks import from there.
6. **Never `invalidateQueries` on a key with optimistic updates in-flight** — Use `setQueryData` instead.
7. **Ably event handlers use `setQueryData`** to merge updates, not `invalidateQueries` (prevents refetch races).
