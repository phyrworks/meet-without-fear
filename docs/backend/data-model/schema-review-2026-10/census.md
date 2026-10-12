# Meet Without Fear: schema census

Branch `phoenix/base` at `4e9c033c`. Schema: `backend/prisma/schema.prisma`. Catalog: local PostgreSQL 18.6 at migration 76 (`20261010180736_cuid_to_uuidv7`). The local DB holds fixture-scale data only, so row counts are not reported. All figures come from the scripts in this directory (`schema_parse.py`, `scan.py`, `report.py`, `overrides.py`, `gen_md.py`). The per-column data is in `columns.csv` and the per-model data is in `models.csv`.

## 1. Summary table

Key: **R/W** counts production delegate call sites (`prisma.x.` / `tx.x.` / `(prisma as any).x.` / `prismaAny.x.` / `client.x.`). `+n` is nested reads through a parent's `include`/`select`. **NW** lists columns never written in production; **NR** lists columns never read anywhere. Both are high confidence only. `(table)` means no production code creates rows in the table, so every column in it is unwritten.

| model | cluster | cols | null% | json | arr | FK in/out | prod R(+nested)/W | client | never-written (NW) | never-read (NR) |
|---|---|--:|--:|--:|--:|--:|--:|:-:|---|---|
| User | core | 16 | 69 | 4 | 0 | 39/0 | 38(+34)/20 | Y | - | - |
| Relationship | core | 3 | 0 | 0 | 0 | 2/0 | 2(+49)/3 | N | - | - |
| RelationshipMember | core | 6 | 17 | 0 | 0 | 0/2 | 11(+49)/5 | Y | - | - |
| Session | core | 10 | 40 | 0 | 0 | 31/2 | 90(+7)/28 | Y | - | previousSessionId |
| InnerWorkSession | inner-work | 16 | 69 | 0 | 0 | 3/3 | 31(+9)/13 | Y | - | - |
| InnerWorkMessage | inner-work | 5 | 0 | 0 | 0 | 1/1 | 5(+5)/5 | Y | - | - |
| SessionTakeaway | inner-work | 12 | 25 | 0 | 0 | 2/1 | 12(+6)/5 | Y | - | - |
| TakeawayLink | inner-work | 6 | 17 | 0 | 0 | 0/2 | 5(+0)/3 | Y | - | - |
| StageProgress | core | 10 | 30 | 1 | 0 | 0/2 | 65(+13)/38 | Y | synthesisLastUpdated | isSynthesisDirty, synthesisLastUpdated |
| UserVessel | core | 13 | 62 | 1 | 0 | 5/2 | 30(+4)/14 | Y | - | - |
| UserEvent | core | 6 | 17 | 0 | 1 | 0/1 | 0(+0)/1 | N | (table) | attributedTo |
| EmotionalReading | core | 6 | 17 | 0 | 0 | 0/1 | 4(+0)/2 | Y | - | - |
| IdentifiedNeed | stage3 needs | 11 | 36 | 0 | 1 | 4/2 | 23(+2)/16 | Y | - | - |
| Boundary | other | 5 | 0 | 0 | 0 | 0/1 | 0(+0)/1 | N | (table) | nonNegotiable |
| UserDocument | other | 7 | 0 | 0 | 0 | 0/1 | 0(+0)/1 | N | (table) | - |
| SharedVessel | consent/sharing | 4 | 0 | 0 | 0 | 3/1 | 6(+1)/2 | N | - | - |
| ConsentedContent | consent/sharing | 9 | 33 | 0 | 0 | 0/4 | 1(+0)/3 | Y | originalNeedId | originalNeedId |
| CommonGround | stage3 needs | 7 | 14 | 0 | 0 | 0/1 | 0(+0)/0 | N | (table) | sharedVesselId, confirmedByA, confirmedByB |
| Agreement | stage4 repair | 13 | 46 | 0 | 0 | 1/2 | 6(+3)/3 | Y | completedAt | - |
| ConsentRecord | consent/sharing | 11 | 55 | 1 | 0 | 3/3 | 6(+0)/5 | Y | metadata | requestedByUserId |
| Message | core | 12 | 50 | 0 | 2 | 0/3 | 36(+1)/34 | Y | extractedNeeds, extractedEmotions | extractedNeeds |
| PreSessionMessage | core | 12 | 50 | 0 | 0 | 0/0 | 1(+0)/1 | N | (table) | detectedIntent, emotionalTone, extractedPerson, extractedTopic, associatedAt |
| EmpathyDraft | empathy/reconciler | 8 | 0 | 0 | 0 | 1/2 | 5(+1)/3 | Y | - | - |
| EmpathyAttempt | empathy/reconciler | 14 | 43 | 0 | 0 | 1/4 | 28(+2)/15 | Y | consentRecordId | seenAt |
| EmpathyValidation | empathy/reconciler | 8 | 38 | 0 | 0 | 0/3 | 4(+2)/3 | Y | - | - |
| ReconcilerResult | empathy/reconciler | 27 | 41 | 0 | 3 | 1/1 | 13(+8)/7 | Y | - | suggestedShareContent, suggestedShareReason, wasCircuitBreakerTrip |
| ReconcilerShareOffer | empathy/reconciler | 21 | 57 | 0 | 0 | 0/1 | 15(+4)/12 | Y | seenAt, lastDeliveryNotifiedAt, lastSeenNotifiedAt | seenAt, skippedAt, refinementChatUsed |
| RefinementAttemptCounter | empathy/reconciler | 6 | 0 | 0 | 0 | 0/1 | 1(+0)/1 | N | - | - |
| StrategyProposal | stage4 repair | 19 | 58 | 1 | 1 | 4/4 | 19(+0)/11 | Y | parentProposalId, coverageSummary, consentRecordId | parentProposalId, coverageSummary, capturedFromMessageId |
| StrategyProposalNeed | stage4 repair | 3 | 0 | 0 | 0 | 0/2 | 1(+1)/2 | N | - | - |
| Stage4ProposalSelection | stage4 repair | 8 | 12 | 0 | 0 | 0/3 | 7(+0)/2 | Y | - | - |
| Stage4ProposalRevision | stage4 repair | 10 | 50 | 2 | 0 | 0/1 | 0(+0)/8 | Y | - | - |
| Stage4NeedCoverage | stage4 repair | 10 | 40 | 0 | 1 | 0/1 | 8(+0)/2 | Y | - | - |
| Stage4NeedDeclination | stage4 repair | 5 | 0 | 0 | 0 | 0/1 | 3(+0)/2 | Y | - | - |
| Stage4Closure | stage4 repair | 12 | 42 | 0 | 3 | 0/1 | 11(+0)/2 | Y | - | closedByUserId |
| Stage4SubChat | stage4 repair | 8 | 25 | 0 | 0 | 1/2 | 4(+0)/2 | Y | - | - |
| Stage4SubChatMessage | stage4 repair | 5 | 0 | 0 | 0 | 0/1 | 0(+4)/2 | Y | - | - |
| TendingEntry | tending | 14 | 43 | 0 | 0 | 5/2 | 7(+1)/20 | Y | - | - |
| TendingCheckin | tending | 9 | 44 | 0 | 0 | 6/3 | 2(+1)/1 | Y | - | - |
| TendingCoordinationCycle | tending | 13 | 46 | 0 | 3 | 1/2 | 5(+1)/4 | Y | - | - |
| TendingResponse | tending | 8 | 38 | 0 | 0 | 2/3 | 1(+6)/2 | Y | - | - |
| TendingEntryOutcome | tending | 13 | 54 | 0 | 0+1e | 0/4 | 0(+7)/1 | Y | - | - |
| TendingNeedOutcome | tending | 11 | 45 | 0 | 0 | 0/2 | 0(+3)/1 | Y | - | - |
| TendingReminder | tending | 12 | 33 | 0 | 0 | 0/4 | 1(+5)/3 | Y | - | - |
| TendingAdjustment | tending | 13 | 46 | 0 | 0+1e | 0/4 | 0(+2)/1 | Y | - | - |
| TendingBetweenPeriodNote | tending | 10 | 20 | 0 | 0 | 0/3 | 3(+0)/3 | Y | - | - |
| TendingResponsePartialClosure | tending | 5 | 0 | 0 | 0 | 0/2 | 0(+1)/1 | Y | - | - |
| StrategyRanking | stage4 repair | 5 | 20 | 0 | 1 | 0/2 | 4(+0)/2 | Y | - | - |
| EmotionalExerciseCompletion | core | 7 | 29 | 0 | 0 | 0/2 | 1(+0)/2 | Y | - | - |
| GlobalLibraryItem | stage4 repair | 9 | 22 | 0 | 0 | 0/0 | 1(+0)/1 | N | (table) | contributionConsent |
| Invitation | core | 12 | 42 | 0 | 0 | 0/2 | 14(+3)/8 | Y | - | declineReason |
| UserMemory | people/memory | 10 | 20 | 0 | 0 | 0/2 | 11(+0)/12 | Y | - | - |
| Need | needs-assessment | 6 | 0 | 0 | 0 | 1/0 | 6(+0)/0 | Y | (seed-only) | - |
| NeedScore | needs-assessment | 6 | 17 | 0 | 0 | 0/2 | 2(+0)/2 | Y | - | - |
| NeedsAssessmentState | needs-assessment | 8 | 50 | 0 | 0 | 0/1 | 4(+0)/4 | Y | - | lastCheckInNeedId |
| Person | people/memory | 12 | 17 | 1 | 1 | 1/1 | 12(+0)/7 | Y | - | - |
| PersonMention | people/memory | 8 | 25 | 0 | 0 | 0/1 | 4(+0)/4 | Y | - | - |
| Insight | inner-work | 9 | 11 | 1 | 0 | 0/1 | 3(+0)/1 | Y | (table) | - |
| RecurringTheme | inner-work | 8 | 0 | 0 | 0 | 0/1 | 1(+0)/1 | Y | - | - |
| GratitudeEntry | gratitude | 14 | 64 | 0 | 6 | 0/1 | 7(+0)/2 | Y | linkedConflictId | linkedConflictId |
| GratitudePreferences | gratitude | 8 | 38 | 0 | 1 | 0/1 | 1(+0)/2 | Y | - | - |
| MeditationSession | meditation | 16 | 56 | 0 | 1 | 0/1 | 5(+0)/2 | Y | linkedNeedIds, linkedConflictId | linkedNeedIds, linkedConflictId |
| MeditationStats | meditation | 11 | 18 | 1 | 0 | 0/1 | 3(+0)/2 | Y | - | - |
| MeditationFavorite | meditation | 8 | 12 | 0 | 0 | 0/1 | 2(+0)/3 | Y | - | - |
| MeditationPreferences | meditation | 8 | 12 | 0 | 0 | 0/1 | 1(+0)/2 | Y | - | - |
| SavedMeditation | meditation | 8 | 12 | 0 | 0 | 0/1 | 5(+0)/3 | Y | - | - |
| BrainActivity | brain/telemetry | 18 | 50 | 4 | 0 | 0/2 | 10(+0)/6 | N | - | - |
| ValidationFeedbackDraft | empathy/reconciler | 7 | 0 | 0 | 0 | 0/2 | 0(+0)/1 | N | - | - |
| **total (68)** | | **670** | **35** | **17** | **25+2e** | **118/118** | **607(+235)/381** | | | |

Totals: 670 scalar columns (3 of them `vector(1024)`), 236 nullable. 17 `jsonb`, 25 scalar arrays plus 2 enum arrays, 61 enum-typed columns, 144 `DateTime` columns, **0** `timestamptz` (confirmed: all 144 are `timestamp without time zone`; the only 3 tz columns belong to `_prisma_migrations`). 118 FKs (96 CASCADE, 21 SET NULL, 1 RESTRICT), 118 back-relation (virtual) fields, 106 `@@index`, 28 `@unique`/`@@unique`. Production call sites: 607 reads and 381 writes across 149 files. Tooling call sites (22 files: `backend/scripts/`, `src/scripts/`, `src/testing/state-factory.ts`, and two root one-offs): 40 reads and 149 writes.

## 2. Candidates for "not needed yet"

### 2.1 Zero production call sites

- **CommonGround**: 0 reads, 0 writes, no nested access, no raw SQL. `CommonGroundDTO` exists in `shared/src` but is not populated from this table.

### 2.2 Production code never inserts a row

| model | what production does with it | note |
|---|---|---|
| UserEvent | `deleteMany` only (session-deletion.ts:112) | never created, never read |
| Boundary | `deleteMany` only (session-deletion.ts:115) | still listed in the encryption map (`prisma-encryption-middleware.ts`) |
| UserDocument | `deleteMany` only (session-deletion.ts:116) | still listed in the encryption map |
| PreSessionMessage | `findMany` (context-retriever.ts:311), raw read (context-retriever.ts:343), `deleteMany` (account-deletion.ts:110) | the read path runs against an always-empty table |
| GlobalLibraryItem | `findMany` (stage4.ts:2472) feeding AI suggestion drafts; `updateMany` anonymising `contributedBy` (account-deletion.ts:92) | no migration seeds it, so the curated library is always empty |
| Insight | `findMany`/`findFirst`/`update` (inner-work.ts:1204-1352) | nothing generates insights; the dismiss endpoint updates rows that never exist |
| Need | 6 reads + 4 raw reads | reference table seeded by migration `20260106083657` (ids 1-19). Expected. |

### 2.3 Written, but never read directly (write-only or nested-include-only)

| model | writers | note |
|---|---|---|
| Stage4ProposalRevision | 8 `create` (stage4.ts:1429, stage4-capture.service.ts:644-856, stage4-subchat.service.ts:530) | audit log with no reader. 1 tooling read. |
| ValidationFeedbackDraft | 1 `upsert` (stage2.ts:1494) | the draft is saved but never loaded |
| TendingResponsePartialClosure | 1 `upsert` (tending.service.ts:1400) | read only via nested include (tending.service.ts:1652) |
| TendingEntryOutcome / TendingNeedOutcome / TendingAdjustment | 1 write each (tending.service.ts:1162/1198/1235) | read only via nested include (7/3/2 sites) |
| Stage4SubChatMessage | 2 `create` | read only via nested include (4 sites) |

Related: `RecurringTheme` is written by a single `upsert` at theme-detector.ts:159, and only through `(prisma.recurringTheme as any)`. A plain `prisma.<model>.` grep misses it. Its only reader is knowledge-base.ts:172. `TakeawayLink` is also reached only through `prismaAny` / `(prisma as any)` casts (knowledge-base.ts:306-412, distillation.ts:319).

## 3. Over-specification: never-written and never-read columns (high confidence)

This list excludes tables that production never populates (section 2.2). Every entry was spot-checked by grep across `backend/src`, `shared/src` and `mobile/`.

| model.column | type | written | read | evidence |
|---|---|---|---|---|
| Session.previousSessionId | String? | yes | no | write@backend/src/services/tending.service.ts:1358 |
| StageProgress.isSynthesisDirty | Boolean | default-only | no | no occurrence of the name outside the generated client |
| StageProgress.synthesisLastUpdated | DateTime? | no | no | no occurrence of the name outside the generated client |
| ConsentedContent.originalNeedId | String? | no | no | no occurrence of the name outside the generated client |
| Agreement.completedAt | DateTime? | no | likely | manually verified: only tooling writes it; prop@backend/src/controllers/emotions.ts:252; name in 6 models |
| ConsentRecord.requestedByUserId | String | yes | no | write@backend/src/controllers/stage2.ts:677 |
| ConsentRecord.metadata | Json? | no | n/a | manually verified: both creates (stage2.ts:677, stage3.ts:757) omit it; consent.ts:53 passes it to the client (always null) |
| Message.extractedNeeds | String[] | no | no | manually verified: name appears nowhere in backend/src, shared, mobile |
| Message.extractedEmotions | String[] | no | yes | manually verified: only `extractedEmotions:` writer is GratitudeEntry (gratitude.ts:280); read by reconciler/analysis.ts:249-258 -> always empty; read@backend/src/service |
| EmpathyAttempt.consentRecordId | String? | no | likely | manually verified: read as `?? ''` (stage2.ts:964, empathy-status.ts:222) but never written in prod; prop@backend/src/controllers/stage2.ts:964; name in 3 models |
| EmpathyAttempt.seenAt | DateTime? | yes | no | write@backend/src/controllers/stage2.ts:1148; name in 2 models |
| ReconcilerResult.suggestedShareContent | String? | yes | no | write@backend/src/services/reconciler/sharing.ts:561 |
| ReconcilerResult.suggestedShareReason | String? | yes | no | write@backend/src/services/reconciler/sharing.ts:561 |
| ReconcilerResult.wasCircuitBreakerTrip | Boolean | default-only | no | no occurrence of the name outside the generated client |
| ReconcilerShareOffer.seenAt | DateTime? | no | no | name in 2 models |
| ReconcilerShareOffer.skippedAt | DateTime? | yes | no | write@backend/src/controllers/reconciler.ts:515 |
| ReconcilerShareOffer.refinementChatUsed | Boolean | default-only | no | no occurrence of the name outside the generated client |
| ReconcilerShareOffer.lastDeliveryNotifiedAt | DateTime? | no | yes | manually verified: only appears as `= null` filter in notifications.ts:176 -> filter is always true; read@backend/src/controllers/notifications.ts:170 |
| ReconcilerShareOffer.lastSeenNotifiedAt | DateTime? | no | yes | manually verified: only appears as `= null` filter in notifications.ts:177 -> filter is always true; read@backend/src/controllers/notifications.ts:170 |
| StrategyProposal.parentProposalId | String? | no | no | manually verified: only set to null on an in-memory ProposalRow (stage4-capture.service.ts:742), never in a Prisma payload |
| StrategyProposal.coverageSummary | Json? | no | no | manually verified: only set to null on an in-memory ProposalRow (stage4-capture.service.ts:743) |
| StrategyProposal.capturedFromMessageId | String? | yes | no | write@backend/src/services/stage4-capture.service.ts:715 |
| StrategyProposal.consentRecordId | String? | no | likely | manually verified: only set to null on an in-memory ProposalRow (stage4-capture.service.ts:747); prop@backend/src/controllers/stage2.ts:964; name in 3 models |
| Stage4Closure.closedByUserId | String? | yes | no | write@backend/src/controllers/stage4.ts:1462 |
| Invitation.declineReason | String? | yes | no | write@backend/src/controllers/invitations.ts:842 |
| NeedsAssessmentState.lastCheckInNeedId | Int? | yes | no | write@backend/src/controllers/needs-assessment.ts:420 |
| GratitudeEntry.linkedConflictId | String? | no | no | manually verified: name appears nowhere outside generated client; name in 2 models |
| MeditationSession.linkedNeedIds | Int[] | no | no | manually verified: meditation.ts create/update never set it; all linkedNeedIds reads are GratitudeEntry; name in 2 models |
| MeditationSession.linkedConflictId | String? | no | no | manually verified: name appears nowhere outside generated client; name in 2 models |

Patterns in this list:

- **Dead from birth (never written or read):** `Message.extractedNeeds`, `StageProgress.synthesisLastUpdated`, `ConsentedContent.originalNeedId`, `GratitudeEntry.linkedConflictId`, `MeditationSession.linkedConflictId`, `MeditationSession.linkedNeedIds`, `ReconcilerShareOffer.seenAt`.
- **Read but never written, so the reader always sees null, empty or the default.** These are likely bugs, not just extra columns:
  - `ReconcilerShareOffer.lastDeliveryNotifiedAt` and `lastSeenNotifiedAt`: notifications.ts:176-177 filters `= null` to avoid re-notifying, but nothing sets them, so the filter always passes.
  - `Message.extractedEmotions`: reconciler/analysis.ts:249-258 builds themes from it, but it is always empty.
  - `EmpathyAttempt.consentRecordId`: read as `?? ''` at stage2.ts:964 and empathy-status.ts:222.
  - `ConsentRecord.metadata`: returned to the client at consent.ts:53.
  - `StrategyProposal.parentProposalId`, `coverageSummary`, `consentRecordId`: these are set to `null` only on an in-memory `ProposalRow`.
  - `Agreement.completedAt`: only tooling writes it.
- **Written but never read:** `Session.previousSessionId`, `ConsentRecord.requestedByUserId`, `EmpathyAttempt.seenAt`, `ReconcilerResult.suggestedShareContent`/`suggestedShareReason`, `ReconcilerShareOffer.skippedAt`, `StrategyProposal.capturedFromMessageId`, `Stage4Closure.closedByUserId`, `Invitation.declineReason`, `NeedsAssessmentState.lastCheckInNeedId`. Some of these are audit fields that are reasonable to keep. The rest are speculative.
- **Default-only flags nobody reads:** `StageProgress.isSynthesisDirty`, `ReconcilerResult.wasCircuitBreakerTrip`, `ReconcilerShareOffer.refinementChatUsed`.

Column verdict totals across all 670 columns are below. `default`/`n/a` are the common names that were not assessed.

| written | n | | read | n |
|---|--:|---|---|--:|
| yes | 466 | | yes | 339 |
| default | 112 | | likely | 201 |
| default-only | 14 | | n/a | 83 |
| n/a | 3 | | no | 33 |
| no | 69 | | client-only? | 14 |
| seed-only | 6 | |  |  |

## 4. Array columns (25 scalar + 2 enum)

In `schema.prisma` that is 25 `String[]`/`Int[]` plus 2 `TendingBlockerCategory[]`. The DB reports 27 `ARRAY` columns. Back-relation fields like `members RelationshipMember[]` are virtual and are **not** counted here.

| column | DB type | holds | production writer | reader relies on order? |
|---|---|---|---|---|
| UserEvent.emotions | _text | free-text emotion words | none (table never populated) | n/a |
| IdentifiedNeed.evidence | _text | free-text quotes | stage3.ts:1166, needs.ts:160/232, needs-edit-applier.service.ts:207/275 | no |
| Message.extractedNeeds | _text | free text (intended) | **none** | never read |
| Message.extractedEmotions | _text | free text (intended) | **none** | no; reader puts it in a Set (reconciler/analysis.ts:258) |
| ReconcilerResult.correctlyIdentified | _text | LLM free text | reconciler/analysis.ts:547 | no (joined for prompts) |
| ReconcilerResult.missedFeelings | _text | LLM free text | reconciler/analysis.ts:547 | no (`join`, sharing.ts:509) |
| ReconcilerResult.misattributions | _text | LLM free text | reconciler/analysis.ts:547 | no |
| StrategyProposal.needsAddressed | _text | need **labels** (free text). `StrategyProposalNeed` holds the same link by id. | stage4.ts:1720/2494, stage4-capture.service.ts:675/715/841 | no |
| Stage4NeedCoverage.coveringProposalIds | _uuid | ids → StrategyProposal (no FK) | stage4-coverage.service.ts:243 → `createMany` :251 | no (`some`/`includes`) |
| Stage4Closure.sharedAgreementIds | _uuid | ids → Agreement (no FK) | stage4.ts:1462, stage4-auto-closure.service.ts:163 | no (`includes`, stage4-state.ts:767) |
| Stage4Closure.individualProposalIds | _uuid | ids → StrategyProposal (no FK) | stage4.ts:1462, stage4-auto-closure.service.ts:163 | no (Set, stage4-state.ts:701) |
| Stage4Closure.openNeedIds | _uuid | ids → IdentifiedNeed (no FK) | stage4.ts:1462, stage4-auto-closure.service.ts:163 | no (Set, stage4-state.ts:702) |
| TendingCoordinationCycle.entryIds | _uuid | ids → TendingEntry (no FK) | tending.service.ts:1057 | no. The key builder sorts a copy (tending.service.ts:41). |
| TendingCoordinationCycle.participantUserIds | _uuid | ids → User (no FK) | tending.service.ts:1057 (sorted at :944) | no (`has`, `filter`, `length`) |
| TendingCoordinationCycle.submittedUserIds | _uuid | ids → User (no FK) | tending.service.ts:1057, :1089 (Set-dedupe) | no (`includes`) |
| TendingEntryOutcome.blockerCategories | _TendingBlockerCategory | enum values | tending.service.ts:1162 | no |
| TendingAdjustment.blockerAddressed | _TendingBlockerCategory | enum values | tending.service.ts:1235 | no |
| StrategyRanking.rankedIds | _uuid | ids → StrategyProposal (no FK) | stage4.ts:1861 | **YES**: `slice(0,3)` top-3 (stage4.ts:1987-1988), `[0]` (stage4.ts:2007) |
| Person.aliases | _text | free-text names | people-extractor.ts:338, people.ts:287 (conditional spread) | no |
| GratitudeEntry.extractedPeople | _text | LLM free text | gratitude.ts:271 | no (aggregated, gratitude.ts:418) |
| GratitudeEntry.extractedPlaces | _text | LLM free text | gratitude.ts:271 | no |
| GratitudeEntry.extractedActivities | _text | LLM free text | gratitude.ts:271 | no |
| GratitudeEntry.extractedEmotions | _text | LLM free text | gratitude.ts:271 | no |
| GratitudeEntry.extractedThemes | _text | LLM free text | gratitude.ts:271 | no |
| GratitudeEntry.linkedNeedIds | _int4 | ids → Need.id (no FK) | gratitude.ts:282 | no (counted, gratitude.ts:444) |
| GratitudePreferences.preferredTimes | _text | "HH:MM" strings (zod regex) | spread of `parseResult.data` into upsert, gratitude.ts:569 | no |
| MeditationSession.linkedNeedIds | _int4 | ids → Need.id (intended) | **none** | never read |

Breakdown: 10 hold id lists (8 `uuid[]` + 2 `int[]`), 13 hold free text, 1 holds "HH:MM" strings and 2 hold enums. Two of the free-text arrays are never written. Only `StrategyRanking.rankedIds` depends on element order.

## 5. JSON columns (17 `jsonb`)

| column | production writer | TS type written | shape stable? |
|---|---|---|---|
| User.memoryPreferences | controllers/auth.ts:446 | `MemoryPreferencesDTO` | **typed**: shared/src/dto/auth.ts:175. The read side casts back. |
| User.notificationPreferences | controllers/auth.ts:558 | `NotificationPreferencesDTO` | **typed**: shared auth.ts:59 |
| User.privacyPreferences | controllers/auth.ts:623 | `PrivacyPreferencesDTO` | **typed**: shared auth.ts:100 |
| User.globalFacts | services/global-memory.ts:215 | `GlobalFacts {facts: CategorizedFact[], consolidatedAt, sessionCount}` (backend-local, global-memory.ts:28) | ad hoc and backend-only. **The schema comment says it is an array `[{category, fact}]`; the code writes an object.** Encrypted by the middleware. |
| StageProgress.gatesSatisfied | ~15 sites: messages.ts:286/335/889, stage2.ts:1235/1417, stage3.ts:586/749/939, stage4.ts:379/409/501, sessions.ts:697/893 | inline object literals, different per stage | **ad hoc**. `shared/src/dto/stage.ts:36` defines `GateSatisfactionDTO = Stage0..4Gates`, but no writer uses it. shared-context.ts:14 redeclares local `Stage0Gates`/`Stage1Gates`, session-state.ts:404 casts to `CompactGates`, and the shared session-state DTO types it `unknown`. |
| UserVessel.notableFacts | services/partner-session-classifier.ts:583 | `CategorizedFactWithId[] \| CategorizedFact[]` (backend-local) | ad hoc, union of two shapes. Encrypted. |
| ConsentRecord.metadata | **none** | - | never written, but sent to the client (consent.ts:53) |
| StrategyProposal.coverageSummary | **none** | - | never written or read |
| Stage4ProposalRevision.before | stage4-capture.service.ts:644/695 (`proposalSnapshot()`: `Prisma.JsonObject`, :609), stage4.ts:1429 (`{status}`), :749 (`JsonNull`) | shape varies by `action` | ad hoc and never read |
| Stage4ProposalRevision.after | same sites; stage4.ts:1429 writes `{agreementId, status}` | shape varies by `action` | ad hoc and never read |
| Person.needsConnections | **none** (`@default("{}")`) | - | read as `Record<string, number>` (people.ts:193), so it is always `{}` |
| Insight.data | **none** (table never populated) | - | the reader casts to `InsightDataDTO` (shared cross-feature.ts:79) |
| MeditationStats.favoriteFocusAreas | controllers/meditation.ts:242 | `Record<string, number>` | ad hoc (shape documented only in a schema comment) |
| BrainActivity.input | services/brain-service.ts:40 | `any` | ad hoc; data-retention.ts:44 sets it to `DbNull` |
| BrainActivity.output | services/brain-service.ts:89 | `any` | ad hoc |
| BrainActivity.metadata | brain-service.ts:40/89/117, ai-orchestrator.ts:828 | `any` | ad hoc |
| BrainActivity.structuredOutput | brain-service.ts:89 | `any` | ad hoc ("typed output for dashboard components", but typed `any`) |

Of the 17, **3 are stable and typed by shared DTOs** (all User preferences). **10 are ad hoc** and **4 are never written** (`ConsentRecord.metadata`, `StrategyProposal.coverageSummary`, `Person.needsConnections`, `Insight.data`). Two more columns hold JSON in `text`: `UserVessel.conversationSummary` (conversation-summarizer.ts:376) and `InnerWorkSession.conversationSummary` (:766), both written with `JSON.stringify({...summary, ...})`.

## 6. Free-text String columns acting as enums

| column | values written in production code | where the value set is defined | note |
|---|---|---|---|
| ReconcilerResult.recommendedAction | `PROCEED`, `OFFER_OPTIONAL`, `OFFER_SHARING` | TS union at reconciler/analysis.ts:420 (cast on read) | written from LLM output (analysis.ts:547) with no runtime check |
| ReconcilerResult.gapSeverity | `none`, `minor`, `moderate`, `significant` | TS union at analysis.ts:413, state.ts:640 (casts) | lowercase, unlike every other enum-ish value |
| Stage4NeedCoverage.coverageStatus | `COVERED`, `PARTIAL`, `OPEN` | `Stage4CoverageStatus`, defined **twice** (stage4-coverage.service.ts:4 and shared strategy.ts:199) |  |
| Stage4ProposalRevision.action | `CREATED`, `REVISED`, `REMOVED`, `RESTORED`, `CONVERTED`, `CAPTURE_SKIPPED`, `subchat_refined` | nowhere (inline literals) | mixed case: `subchat_refined` (stage4-subchat.service.ts:535) |
| TendingResponse.status | `CHECKIN` (tending.service.ts:1134/1147) + `args.status: string` (:591) | `TendingResponseStatus` = CHECKIN, WORKED, PARTLY, DID_NOT_WORK, DID_NOT_TRY, OTHER (shared strategy.ts:366) | service accepts `string` |
| TendingReminder.status | `SCHEDULED` (default), `DELIVERED` | `TendingReminderStatus` = SCHEDULED, DELIVERED, CANCELLED (shared strategy.ts:443) | `CANCELLED` is never written |
| RelationshipMember.role | `member` (default only) | - | constant column |
| InnerWorkSession.linkedTrigger | `suggestion_start` (invitations.ts:514, messages.ts:836, session-state.ts:190) | schema comment lists `empathy_wait`, `voluntary`, `witness_wait` | **comment is stale**: none of the documented values are written |
| UserDocument.type | none (table never populated) | schema comment |  |
| PreSessionMessage.emotionalTone / detectedIntent | none (table never populated) | schema comment |  |
| GlobalLibraryItem.category | none (table never populated) | schema comment | still filtered on (`@@index([category])`) |
| ReconcilerResult.guidanceType | LLM free text (analysis.ts, `abstractGuidance.guidanceType`) | comment: e.g. `explore_deeper_feelings` | open vocabulary |
| Person.relationship | LLM free text (people-extractor.ts:221) | comment: friend/partner/family/coworker | open vocabulary |
| MeditationSession.focusArea, MeditationFavorite.focusArea | client-supplied; fallback `general` | - | aggregated into `MeditationStats.favoriteFocusAreas` keys |
| MeditationSession.backgroundSound, MeditationPreferences.backgroundSound | client-supplied; default `silence` | comment: rain/bowls/silence |  |
| RefinementAttemptCounter.direction | `` `${guesserId}->${subjectId}` `` | - | two ids packed into one string, used in a `@@unique` |
| BrainActivity.model | model id strings | - | open vocabulary; reasonable as text |

Prose columns (`Invitation.declineReason`, `StrategyProposal.removalReason`, `TendingAdjustment.reason`/`revisedScope`, `Stage4ProposalRevision.reason`) are real free text and are not included above.

## 7. Enums (51)

| enum | members | schema vs DB |
|---|--:|---|
| SessionType | 2 | same |
| SessionStatus | 8 | same |
| InnerWorkStatus | 3 | same |
| TakeawaySource | 2 | same |
| TakeawayType | 3 | same |
| TakeawayLinkType | 2 | same |
| StageStatus | 4 | same |
| Attribution | 4 | same |
| NeedCategory | 6 | same |
| AgreementType | 4 | same |
| AgreementStatus | 5 | same |
| ConsentContentType | 7 | same |
| ConsentDecision | 3 | same |
| MessageRole | 9 | ORDER DIFFERS |
| EmpathyStatus | 8 | ORDER DIFFERS |
| SharedContentDeliveryStatus | 3 | same |
| ReconcilerShareStatus | 7 | ORDER DIFFERS |
| StrategySource | 3 | same |
| Stage4ProposalKind | 2 | same |
| Stage4ProposalStatus | 4 | same |
| Stage4SelectionDecision | 2 | same |
| Stage4ClosureKind | 2 | same |
| Stage4ClosureReason | 4 | same |
| TendingEntryType | 3 | ORDER DIFFERS |
| TendingEntryStatus | 6 | same |
| TendingEntryScope | 2 | same |
| TendingFollowThroughStatus | 4 | same |
| TendingHelpfulnessStatus | 4 | same |
| TendingBlockerCategory | 9 | same |
| TendingNeedResolutionStatus | 5 | same |
| TendingNextAction | 6 | same |
| TendingReminderScope | 2 | same |
| TendingCoordinationStatus | 4 | same |
| Stage4SubChatAnchor | 3 | same |
| Stage4SubChatStatus | 2 | same |
| ContinueChoice | 5 | same |
| PartialClosureResolution | 2 | same |
| ExerciseType | 4 | same |
| GlobalLibrarySource | 2 | same |
| InvitationStatus | 4 | same |
| MemoryCategory | 6 | same |
| MemoryStatus | 3 | ORDER DIFFERS |
| MemorySource | 3 | same |
| NeedsCategory | 5 | same |
| MentionSourceType | 4 | same |
| InsightType | 3 | same |
| MeditationType | 2 | same |
| FavoriteType | 2 | same |
| BrainActivityCallType | 19 | same |
| ActivityType | 4 | same |
| ActivityStatus | 3 | same |

**The 5 order mismatches** are confirmed. Members are identical but `pg_enum.enumsortorder` differs from declaration order. That changes `ORDER BY` on the enum column and any `<`/`>` comparison:

- `MessageRole`: schema `USER, AI, SYSTEM, EMPATHY_STATEMENT, EMPATHY_REVEAL_INTRO, SHARED_CONTEXT, VALIDATION_FEEDBACK, SHARE_SUGGESTION, EMPATHY_VALIDATION_PROMPT` vs DB `USER, AI, SYSTEM, EMPATHY_STATEMENT, EMPATHY_REVEAL_INTRO, EMPATHY_VALIDATION_PROMPT, SHARED_CONTEXT, SHARE_SUGGESTION, VALIDATION_FEEDBACK`
- `EmpathyStatus`: schema `HELD, ANALYZING, AWAITING_SHARING, REFINING, NEEDS_WORK, READY, REVEALED, VALIDATED` vs DB `HELD, ANALYZING, NEEDS_WORK, REVEALED, VALIDATED, AWAITING_SHARING, REFINING, READY`
- `ReconcilerShareStatus`: schema `PENDING, OFFERED, ACCEPTED, DECLINED, EXPIRED, NOT_OFFERED, SKIPPED` vs DB `NOT_OFFERED, OFFERED, ACCEPTED, DECLINED, SKIPPED, PENDING, EXPIRED`
- `TendingEntryType`: schema `SCHEDULED_SHARED_AGREEMENT_CHECKIN, SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN, USER_INITIATED_REENTRY` vs DB `SCHEDULED_SHARED_AGREEMENT_CHECKIN, USER_INITIATED_REENTRY, SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN`
- `MemoryStatus`: schema `ACTIVE, PENDING, REJECTED` vs DB `ACTIVE, REJECTED, PENDING`

## 8. Denormalised copies

| column | copy of | production writer | kept in sync? |
|---|---|---|---|
| User.name | `firstName + lastName` (schema comment says "computed") | middleware/auth.ts:220/233, routes/e2e.ts:195 | written on auth sync; no recompute on name edit was found |
| ReconcilerResult.guesserName / subjectName | User.name of guesserId/subjectId (both unconstrained text ids) | reconciler/analysis.ts:547 | scrubbed to `[Deleted User]` by account-deletion.ts:100-104 and session-deletion.ts:192-196 |
| Invitation.name | invitee display name | invitations.ts:460 | snapshot |
| RelationshipMember.nickname | invitee/partner display name, per member | invitations.ts:417 | snapshot |
| Stage4NeedCoverage.needLabel | IdentifiedNeed.need (via text `needId`) | stage4-coverage.service.ts:243 | snapshot |
| TendingNeedOutcome.needLabel | IdentifiedNeed.need | tending.service.ts:1198 | snapshot |
| StrategyProposal.needsAddressed[] | labels of the needs linked in `StrategyProposalNeed` | stage4.ts:1720/2494, stage4-capture.service.ts | two representations of one relation |
| Stage4ProposalRevision.sessionId | StrategyProposal.sessionId via proposalId | every revision create | redundant path, no FK |
| Person.mentionCount{InnerThoughts,Gratitude,Needs,Conflict}, lastMentioned | COUNT/MAX over PersonMention by sourceType | people-extractor.ts:221/274/338 | incremented in app code |
| MeditationStats.* (totalSessions, guided/unguidedCount, totalMinutes, streaks, lastSessionDate, favoriteFocusAreas) | aggregates of MeditationSession | meditation.ts:242 (`increment`) | computed on save; no recompute path |
| RecurringTheme.sessionCount | count of sessions with the theme | theme-detector.ts:159 | incremented |
| EmpathyAttempt.revisionCount | count of revisions | stage2.ts:2068 (`revisionCount + 1`) | read-modify-write, not `increment` |
| MeditationFavorite.focusArea / durationMinutes / script | MeditationSession fields | meditation.ts:515/759 | snapshot by design (`EXACT` vs template) |
| Agreement.description | StrategyProposal.description | stage4.ts:1402 | snapshot at conversion |
| InnerWorkSession.contextSummarySnapshot | partner-session context at link time | invitations.ts:516 | snapshot by design |
| UserVessel / InnerWorkSession.conversationSummary | rolling summary of Message / InnerWorkMessage rows | conversation-summarizer.ts:376/766 | cached, JSON in text |
| Stage4Closure.{sharedAgreementIds, individualProposalIds, openNeedIds} | rows of Agreement / StrategyProposal / Stage4NeedCoverage at closure | stage4.ts:1462 | snapshot |
| TendingCoordinationCycle.coordinationKey | `sessionId:` + sorted entryIds | tending.service.ts:41/1057 | derived; partial unique index |

## 9. Id-shaped columns with no FK (for reference)

The uuid migration rewrote the values in 26 unconstrained id columns but **left them as `text`**, while their FK siblings became `uuid`. Examples: `Message.forUserId`, `ReconcilerResult.guesserId/subjectId`, `ReconcilerShareOffer.userId`, `PreSessionMessage.userId/associatedSessionId`, `Stage4ProposalRevision.sessionId/actorUserId/messageId`, `Stage4NeedCoverage.needId/sourceUserId`, `Stage4NeedDeclination.userId/needId`, `Stage4Closure.closedByUserId`, `TendingEntry.ownerUserId`, `TendingNeedOutcome.needId/sourceUserId`, `PersonMention.userId/sourceId`, `StrategyProposal.parentProposalId/capturedFromMessageId`, `Stage4SubChat.anchorId`, `GlobalLibraryItem.contributedBy`, `SavedMeditation.conversationId`, `GratitudeEntry/MeditationSession.linkedConflictId`, `BrainActivity.turnId`. Comparing one of these with a uuid column means a `uuid = text` comparison, which needs a cast in raw SQL.

## 10. Tables missing `createdAt` / `updatedAt`

**No `updatedAt` (45/68):** RelationshipMember, InnerWorkMessage, TakeawayLink, StageProgress, UserEvent, EmotionalReading, IdentifiedNeed, Boundary, ConsentedContent, CommonGround, Agreement, ConsentRecord, Message, PreSessionMessage, EmpathyAttempt, EmpathyValidation, ReconcilerResult, StrategyProposalNeed, Stage4ProposalRevision, Stage4NeedDeclination, Stage4Closure, Stage4SubChat, Stage4SubChatMessage, TendingCheckin, TendingResponse, TendingEntryOutcome, TendingNeedOutcome, TendingAdjustment, TendingResponsePartialClosure, StrategyRanking, EmotionalExerciseCompletion, Invitation, Need, NeedScore, NeedsAssessmentState, Person, PersonMention, Insight, GratitudeEntry, GratitudePreferences, MeditationSession, MeditationStats, MeditationFavorite, MeditationPreferences, BrainActivity.

Of these, **27 are updated in place by production code** (count of update/upsert sites in parentheses): RelationshipMember (3), StageProgress (33), IdentifiedNeed (8), ConsentedContent (2), Agreement (1), ConsentRecord (2), Message (1), EmpathyAttempt (14), EmpathyValidation (3), ReconcilerResult (6), StrategyProposalNeed (1), Stage4NeedDeclination (1), Stage4SubChat (1), TendingResponse (2), TendingEntryOutcome (1), TendingResponsePartialClosure (1), StrategyRanking (1), Invitation (6), NeedsAssessmentState (3), Person (4), PersonMention (1), Insight (1), GratitudePreferences (1), MeditationSession (1), MeditationStats (1), MeditationPreferences (1), BrainActivity (4). For these tables the last-modified time is not recorded.

**No `createdAt` (25/68):** RelationshipMember, InnerWorkMessage, StageProgress, UserEvent, EmotionalReading, ConsentedContent, CommonGround, Agreement, Message, PreSessionMessage, EmpathyAttempt, EmpathyValidation, Stage4ProposalSelection, Stage4NeedDeclination, TendingResponse, StrategyRanking, EmotionalExerciseCompletion, Need, NeedsAssessmentState, Person, GratitudePreferences, MeditationSession, MeditationStats, MeditationFavorite, MeditationPreferences. Most use a domain timestamp instead (`timestamp`, `joinedAt`, `startedAt`, `submittedAt`, `consentedAt`...). **Need, GratitudePreferences and MeditationPreferences have no timestamp column at all.**

Missing both (24): RelationshipMember, InnerWorkMessage, StageProgress, UserEvent, EmotionalReading, ConsentedContent, CommonGround, Agreement, Message, PreSessionMessage, EmpathyAttempt, EmpathyValidation, Stage4NeedDeclination, TendingResponse, StrategyRanking, EmotionalExerciseCompletion, Need, NeedsAssessmentState, Person, GratitudePreferences, MeditationSession, MeditationStats, MeditationFavorite, MeditationPreferences.

## 11. Per-model structural detail

| model | PK | null/cols | enum cols | free-text status cols | ts (tz) | uniq | @@index | back-rels | onDelete | tooling R/W | raw SQL prod/tool | client evidence |
|---|---|--:|--:|---|--:|--:|--:|--:|---|--:|--:|---|
| User | String/uuid uuidv7() | 11/16 | 0 | - | 3 (0) | 2 | 0 | 39 | - | 0/6 | 2/0 | types:UserDTO,UserMemoryDTO cols 7/12 |
| Relationship | String/uuid uuidv7() | 0/3 | 0 | - | 2 (0) | 0 | 0 | 2 | - | 0/4 | 2/0 | only id/timestamps; ids travel inside session DTOs | cols 0/0 |
| RelationshipMember | String/uuid uuidv7() | 1/6 | 0 | role | 1 (0) | 1 | 1 | 0 | Cascade | 1/0 | 4/0 | cols 1/2 |
| Session | String/uuid uuidv7() | 4/10 | 2 | - | 4 (0) | 0 | 4 | 31 | Cascade SetNull | 4/3 | 2/0 | types:SessionDetailDTO,SessionMilestonesDTO,SessionStatus,SessionSummaryDTO cols 2/3 |
| InnerWorkSession | String/uuid uuidv7() | 11/16 | 1 | - | 3 (0) | 0 | 4 | 3 | Cascade SetNull | 1/0 | 3/0 | types:InnerWorkSessionDetailDTO,InnerWorkSessionSummaryDTO cols 6/6 |
| InnerWorkMessage | String/uuid uuidv7() | 0/5 | 1 | - | 1 (0) | 0 | 1 | 1 | Cascade | 0/0 | 0/0 | types:InnerWorkMessageDTO cols 0/0 |
| SessionTakeaway | String/uuid uuidv7() | 3/12 | 2 | - | 3 (0) | 0 | 1 | 2 | Cascade | 0/0 | 5/0 | cols 2/3 |
| TakeawayLink | String/uuid uuidv7() | 1/6 | 1 | - | 1 (0) | 1 | 2 | 0 | Cascade | 0/0 | 0/0 | types:TakeawayLinkDTO,TakeawayLinkType cols 2/2 |
| StageProgress | String/uuid uuidv7() | 3/10 | 1 | - | 3 (0) | 1 | 2 | 0 | Cascade | 5/53 | 0/0 | types:StageProgressDTO,StageProgressDetailDTO cols 1/3 |
| UserVessel | String/uuid uuidv7() | 8/13 | 0 | - | 6 (0) | 1 | 2 | 5 | Cascade | 5/5 | 3/0 | cols 3/6 |
| UserEvent | String/uuid uuidv7() | 1/6 | 1 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | shared UserEventType/UserEventData are realtime events, unrelated; table never read | type |
| EmotionalReading | String/uuid uuidv7() | 1/6 | 0 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/3 | 0/0 | types:EmotionalReadingDTO cols 1/1 |
| IdentifiedNeed | String/uuid uuidv7() | 4/11 | 1 | - | 3 (0) | 0 | 4 | 4 | Cascade SetNull | 0/3 | 0/0 | types:IdentifiedNeedDTO cols 6/6 |
| Boundary | String/uuid uuidv7() | 0/5 | 0 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | never read | cols 0/1 |
| UserDocument | String/uuid uuidv7() | 0/7 | 0 | type | 2 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | never read | cols 0/0 |
| SharedVessel | String/uuid uuidv7() | 0/4 | 0 | - | 2 (0) | 1 | 0 | 3 | Cascade | 2/1 | 0/0 | internal container, id only | cols 0/0 |
| ConsentedContent | String/uuid uuidv7() | 3/9 | 0 | - | 2 (0) | 1 | 2 | 0 | Cascade SetNull default | 0/0 | 0/0 | types:ConsentedContentDTO cols 3/4 |
| CommonGround | String/uuid uuidv7() | 1/7 | 1 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | CommonGroundDTO exists in shared but the table is never written or read | types:CommonGrou |
| Agreement | String/uuid uuidv7() | 6/13 | 2 | - | 3 (0) | 0 | 1 | 1 | Cascade SetNull | 1/1 | 0/0 | types:AgreementDTO,AgreementStatus,AgreementType cols 2/4 |
| ConsentRecord | String/uuid uuidv7() | 6/11 | 2 | - | 3 (0) | 0 | 1 | 3 | Cascade | 0/7 | 0/0 | types:ConsentRecordDTO cols 1/3 |
| Message | String/uuid uuidv7() | 6/12 | 1 | - | 1 (0) | 0 | 6 | 0 | Cascade SetNull | 8/27 | 0/0 | types:MessageDTO cols 3/5 |
| PreSessionMessage | String/uuid uuidv7() | 6/12 | 1 | - | 3 (0) | 0 | 3 | 0 | - | 0/0 | 1/0 | never written | cols 0/6 |
| EmpathyDraft | String/uuid uuidv7() | 0/8 | 0 | - | 2 (0) | 1 | 0 | 1 | Cascade | 1/9 | 0/0 | types:EmpathyDraftDTO cols 1/1 |
| EmpathyAttempt | String/uuid uuidv7() | 6/14 | 2 | - | 4 (0) | 1 | 0 | 1 | Cascade SetNull | 1/9 | 0/0 | types:EmpathyAttemptDTO cols 4/4 |
| EmpathyValidation | String/uuid uuidv7() | 3/8 | 0 | - | 1 (0) | 1 | 0 | 0 | Cascade SetNull | 0/0 | 0/0 | cols 5/5 |
| ReconcilerResult | String/uuid uuidv7() | 11/27 | 0 | recommendedAction guidanceType suggestedShareReason | 2 (0) | 0 | 3 | 1 | Cascade | 2/2 | 0/0 | types:ReconcilerResult,ReconcilerResultSummary cols 16/23 |
| ReconcilerShareOffer | String/uuid uuidv7() | 12/21 | 2 | suggestedReason | 9 (0) | 1 | 1 | 0 | Cascade | 0/2 | 0/0 | cols 4/10 |
| RefinementAttemptCounter | String/uuid uuidv7() | 0/6 | 0 | - | 2 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | circuit-breaker internal | cols 1/2 |
| StrategyProposal | String/uuid uuidv7() | 11/19 | 3 | removalReason | 3 (0) | 0 | 3 | 4 | Cascade SetNull | 2/8 | 0/0 | StrategyDTO / ProposalCardDTO (shared/src/dto/strategy.ts:49,215) | cols 1/7 |
| StrategyProposalNeed | composite @@id([proposalId, needId]) | 0/3 | 0 | - | 1 (0) | 0 | 1 | 0 | Cascade | 2/0 | 0/0 | junction; surfaced indirectly as proposal needs | cols 0/0 |
| Stage4ProposalSelection | String/uuid uuidv7() | 1/8 | 1 | - | 2 (0) | 1 | 1 | 0 | Cascade | 0/2 | 0/0 | cols 1/1 |
| Stage4ProposalRevision | String/uuid uuidv7() | 5/10 | 0 | action reason | 1 (0) | 0 | 2 | 0 | Cascade | 0/1 | 0/0 | cols 4/5 |
| Stage4NeedCoverage | String/uuid uuidv7() | 4/10 | 0 | coverageStatus | 2 (0) | 0 | 1 | 0 | Cascade | 1/1 | 0/0 | cols 1/2 |
| Stage4NeedDeclination | String/uuid uuidv7() | 0/5 | 0 | - | 1 (0) | 1 | 1 | 0 | Cascade | 0/0 | 0/0 | drives proposal inventory state (stage4.ts:942) — indirect | cols 0/0 |
| Stage4Closure | String/uuid uuidv7() | 5/12 | 2 | - | 3 (0) | 1 | 0 | 0 | Cascade | 1/0 | 0/0 | closure fields surface via stage4-state -> ProposalInventoryDTO | cols 2/6 |
| Stage4SubChat | String/uuid uuidv7() | 2/8 | 2 | - | 2 (0) | 0 | 2 | 1 | Cascade | 0/0 | 0/0 | types:Stage4SubChatDTO,Stage4SubChatMessageDTO,Stage4SubChatStatus cols 2/2 |
| Stage4SubChatMessage | String/uuid uuidv7() | 0/5 | 1 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | types:Stage4SubChatMessageDTO cols 0/1 |
| TendingEntry | String/uuid uuidv7() | 6/14 | 3 | - | 5 (0) | 0 | 4 | 5 | Cascade | 0/0 | 0/0 | types:TendingEntryDTO,TendingEntryOutcomeDTO,TendingEntryStatus,TendingEntryType cols 5/5 |
| TendingCheckin | String/uuid uuidv7() | 4/9 | 2 | - | 2 (0) | 0 | 3 | 6 | Cascade SetNull | 0/0 | 0/0 | types:TendingCheckinDTO cols 2/2 |
| TendingCoordinationCycle | String/uuid uuidv7() | 6/13 | 1 | - | 4 (0) | 0 | 3 | 1 | Cascade | 0/0 | 0/0 | types:TendingCoordinationCycleDTO cols 5/6 |
| TendingResponse | String/uuid uuidv7() | 3/8 | 1 | status | 1 (0) | 1 | 1 | 2 | Cascade SetNull | 0/0 | 0/0 | types:TendingResponseDTO,TendingResponseStatus cols 1/1 |
| TendingEntryOutcome | String/uuid uuidv7() | 7/13 | 3 | - | 1 (0) | 1 | 2 | 0 | Cascade SetNull | 0/0 | 0/0 | types:TendingEntryOutcomeDTO cols 8/8 |
| TendingNeedOutcome | String/uuid uuidv7() | 5/11 | 2 | - | 1 (0) | 0 | 3 | 0 | Cascade | 0/0 | 0/0 | types:TendingNeedOutcomeDTO cols 2/2 |
| TendingReminder | String/uuid uuidv7() | 4/12 | 1 | status | 3 (0) | 0 | 4 | 0 | Cascade SetNull | 0/0 | 0/0 | types:TendingReminderDTO,TendingReminderStatus cols 2/2 |
| TendingAdjustment | String/uuid uuidv7() | 6/13 | 2 | revisedScope reason | 1 (0) | 0 | 4 | 0 | Cascade | 0/0 | 0/0 | types:TendingAdjustmentDTO cols 6/6 |
| TendingBetweenPeriodNote | String/uuid uuidv7() | 2/10 | 0 | - | 3 (0) | 0 | 2 | 0 | Cascade SetNull | 0/0 | 0/0 | types:TendingBetweenPeriodNoteDTO cols 4/4 |
| TendingResponsePartialClosure | String/uuid uuidv7() | 0/5 | 1 | - | 1 (0) | 1 | 1 | 0 | Cascade | 0/0 | 0/0 | partialClosure map in strategy.ts:585 (nested read tending.service.ts:1652) | cols 0/2 |
| StrategyRanking | String/uuid uuidv7() | 1/5 | 0 | - | 1 (0) | 1 | 0 | 0 | Cascade | 0/1 | 0/0 | types:StrategyRanking cols 1/1 |
| EmotionalExerciseCompletion | String/uuid uuidv7() | 2/7 | 1 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | cols 2/2 |
| GlobalLibraryItem | String/uuid uuidv7() | 2/9 | 1 | category | 3 (0) | 0 | 2 | 0 | - | 0/0 | 0/0 | read only to seed AI suggestion drafts; table is never populated | cols 0/2 |
| Invitation | String/uuid uuidv7() | 5/12 | 1 | declineReason | 5 (0) | 0 | 2 | 0 | Cascade | 0/1 | 0/0 | types:InvitationDTO,InvitationStatus cols 3/5 |
| UserMemory | String/uuid uuidv7() | 2/10 | 3 | - | 2 (0) | 0 | 2 | 0 | Cascade | 1/0 | 0/0 | types:UserMemoryDTO cols 1/1 |
| Need | Int/int4 | 0/6 | 1 | - | 0 (0) | 1 | 0 | 1 | - | 0/0 | 4/0 | types:NeedDTO,NeedScoreDTO,NeedWithScoreDTO,NeedsAssessmentStateDTO cols 2/2 |
| NeedScore | String/uuid uuidv7() | 1/6 | 0 | - | 1 (0) | 0 | 2 | 0 | Cascade | 0/0 | 7/0 | types:NeedScoreDTO cols 2/2 |
| NeedsAssessmentState | String/uuid uuidv7() | 4/8 | 0 | - | 3 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | types:NeedsAssessmentStateDTO cols 5/6 |
| Person | String/uuid uuidv7() | 2/12 | 0 | - | 2 (0) | 1 | 1 | 1 | Cascade | 0/0 | 0/0 | types:PersonDTO,PersonDetailDTO,PersonMentionDTO,PersonSummaryDTO cols 5/9 |
| PersonMention | String/uuid uuidv7() | 2/8 | 1 | - | 1 (0) | 0 | 2 | 0 | Cascade | 0/0 | 0/0 | types:PersonMentionDTO cols 3/3 |
| Insight | String/uuid uuidv7() | 1/9 | 1 | - | 2 (0) | 0 | 2 | 0 | Cascade | 0/0 | 0/0 | types:InsightDTO,InsightDataDTO,InsightType cols 3/3 |
| RecurringTheme | String/uuid uuidv7() | 0/8 | 0 | - | 3 (0) | 1 | 1 | 0 | Cascade | 0/0 | 0/0 | types:RecurringThemeDTO cols 3/3 |
| GratitudeEntry | String/uuid uuidv7() | 9/14 | 0 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | types:GratitudeEntryDTO cols 2/7 |
| GratitudePreferences | String/uuid uuidv7() | 3/8 | 0 | - | 0 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | types:GratitudePreferencesDTO cols 6/6 |
| MeditationSession | String/uuid uuidv7() | 9/16 | 2 | - | 2 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | types:MeditationSessionDTO,MeditationSessionSummaryDTO cols 5/5 |
| MeditationStats | String/uuid uuidv7() | 2/11 | 0 | - | 2 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | types:MeditationStatsDTO cols 9/9 |
| MeditationFavorite | String/uuid uuidv7() | 1/8 | 1 | - | 1 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | types:MeditationFavoriteDTO cols 1/1 |
| MeditationPreferences | String/uuid uuidv7() | 1/8 | 0 | - | 0 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | types:MeditationPreferencesDTO cols 5/5 |
| SavedMeditation | String/uuid uuidv7() | 1/8 | 0 | - | 2 (0) | 0 | 1 | 0 | Cascade | 0/0 | 0/0 | types:SavedMeditationDTO,SavedMeditationSummaryDTO cols 2/2 |
| BrainActivity | String/uuid uuidv7() | 9/18 | 3 | - | 2 (0) | 0 | 5 | 0 | Cascade | 2/0 | 0/0 | admin/brain dashboard routes only (routes/brain.ts), no shared DTO | cols 0/12 |
| ValidationFeedbackDraft | String/uuid uuidv7() | 0/7 | 0 | - | 2 (0) | 1 | 0 | 0 | Cascade | 0/0 | 0/0 | written only; never read back | cols 0/0 |

Raw SQL (production): `NeedScore`/`Need` (gratitude.ts:151/620, meditation.ts:433/588, needs-assessment.ts:169/188, cross-feature-context.ts:139), `PreSessionMessage` (context-retriever.ts:343), and the vector writes and searches in embedding.ts. Those cover `UserVessel` (:202 write, :238/:676 read), `InnerWorkSession` (:355 write, :525/:600), `SessionTakeaway` (:475 write, :525/:588/:600), and `Session`/`Relationship`/`RelationshipMember`/`User` as join partners in :238/:676. Tooling raw SQL: `reset-db-data.ts` truncates by catalog name.

## 12. Existing audit: what is still true at migration 76

Sources: `docs/backend/data-model/schema-audit.md` (2026-08-12, 74 migrations) and `erd-current.md` (2026-08-18). Re-checked against the local catalog.

| finding | status at migration 76 |
|---|---|
| 68 tables + `_prisma_migrations` | still true |
| 669 columns (434 NOT NULL / 235 nullable) | **670 (434 / 236)**: +`Message.contentHash varchar` (migration `20260905043257_message_content_hash`) |
| 51 enums | still true; 5 declaration-order mismatches (section 7), which the audits do not mention |
| 203 indexes / 98 unique | 203 / **97** unique |
| 118 FKs (96 CASCADE / 21 SET NULL / 1 RESTRICT on `ConsentedContent.consentRecordId`) | still true |
| 25 FKs without a supporting index | still true (25) |
| 41 unenforced relation-shaped columns; 9 mandatory; 10 id arrays | still true; the arrays are now `uuid[]` (8) + `int[]` (2) |
| "No UUIDs anywhere", cuid v1 text PKs, no DB-side PK default | **superseded**: 66 PKs are `uuid DEFAULT uuidv7()`, 191 uuid/uuid[] columns. `StrategyProposalNeed` has a composite PK; `Need.id` is still a bare `int` with no default (the "trap" stands). |
| E2E bypass accepts non-cuid ids | superseded per the audit note (uuid required) |
| Islands: `GlobalLibraryItem`, `PreSessionMessage` | still true, and both are never populated (section 2.2) |
| `Message.forUserId` text, no FK ("unindexed" was a slip, per ERD 1.3) | still true: `text`, no FK, indexed. The uuid migration rewrote its values but kept the type `text`. |
| 0 RLS / policies / triggers / CHECK / views / sequences | still true (all 0) |
| 144 naive timestamps; only `_prisma_migrations` has timestamptz | still true |
| 17 jsonb; `gatesSatisfied` untyped blob | still true; detailed in section 5 |
| 2 JSON-in-text summaries | still true |
| 6 (audit) / 9 (ERD) free-text status columns | still true; section 6 adds `InnerWorkSession.linkedTrigger` and the value sets |
| No ANN index on 3 vector columns | still true (0 hnsw/ivfflat) |
| `extensions = [vector]` commented out | still true (schema.prisma:14) |
| Encryption map covers 9 models | still true. 2 of the 9 (`Boundary`, `UserDocument`) are tables production never writes. |
| 76 rows in `_prisma_migrations` | confirmed |
| `Message.contentHash` landed | confirmed: written by the encryption middleware `hashedFields`, read by utils/message-dedupe.ts |

The audits did not report these:

- the write-only, never-populated and never-read tables (section 2)
- the never-written columns, including the two broken notification dedupe filters (section 3)
- the enum order drift (section 7)
- the stale schema comments on `User.globalFacts` and `InnerWorkSession.linkedTrigger`

## 13. Method and blind spots

- **Schema:** a line parser over `schema.prisma`. A field is a column if its type is a Prisma scalar, `Unsupported(...)` or an enum. A field typed as another model is a relation: with `fields:` it is an FK out; without it, it is a **back-relation** (virtual, not a column). `String[]`/`Int[]` are real arrays; `Model[]` is never an array column. Commented-out fields (the 4 `// embedding`) are ignored. Nullability, types, FKs, indexes and enum order come from `information_schema`/`pg_catalog`. The 670 parsed columns match the 670 DB columns exactly.
- **Production code** is `backend/src/**/*.ts` minus `__tests__`, `__mocks__`, `*.test.ts`, `src/testing/`, `src/fixtures/`, `src/scripts/`, `src/generated/` and the two root one-offs (`fix-empty-messages.ts`, `temp-get-sessions.ts`): 149 files. `src/routes/e2e.ts` and `src/routes/brain.ts` count as production. **Tooling** is `backend/scripts/*.ts`, `src/scripts/*.ts`, `src/testing/state-factory.ts` and the two one-offs: 22 files. Note that `src/scripts/open-due-tending-entries.ts` and `sweep-session-retention.ts` look like scheduled jobs; they were classed as tooling as instructed.
- **Call sites:** a regex for `<delegate>.<camelModel>.<method>(`, where delegate is `prisma|tx|prismaAny|client|db`, `(prisma as any)` or `(prisma.x as any)`. Transactions are always named `tx` (31 `$transaction(async (tx`). Reads are `find*|count|aggregate|groupBy`; writes are `create*|update*|upsert|delete*`. Cross-check: a plain grep found 979 sites, the scanner 988 (the difference is the cast forms). **Missed:** delegates passed as values (`findMessageByContent(prisma.message, …)` at stage2.ts:1297 and stage4.ts:1034, 2 Message reads) and any delegate stored in a variable.
- **Column WRITE (high confidence):** each call's argument object is parsed by a tolerant JS object-literal parser. Keys in `data`/`create`/`update` (including nested relation `create`/`createMany`/`upsert` and `connect`/`disconnect` mapped to FK columns) count for that model. Raw SQL `INSERT (...)`/`SET col =` counts for the named table. The encryption middleware writes `Message.contentHash`. Payloads that are variables or spreads (`data: rows`, `...parseResult.data`) are recorded as *unresolved* and then fall back to a global `col:` / `{ col }` / `.col =` search, discounting keys already tied to another model. About 40 such cases were then **hand-checked and recorded in `overrides.py`**; the CSV note says "manually verified" for those.
- **Column READ:** high confidence when the column appears as a key in a tied `where`/`select`/`orderBy`/`cursor`/`distinct`/`by`/aggregate, or in raw SQL. Medium or low (`likely`) when `.col`/`?.col`/`'col'` appears anywhere in production code: medium if the name is unique to one model, low if several models share it. `client-only?` means the name appears only in `mobile/` or `shared/`. That catches whole-row results serialised straight to the client (`res.json(row)`), which the backend scan cannot see.
- **Common names** (`id, status, content, userId, sessionId, createdAt, updatedAt, metadata`): negatives are reported as "common name, not assessed". Positives are reported only when tied to the model.
- **"Never written / never read" (high)** requires no tied evidence *and* no token occurrence of the name in production code (plus `shared/` and `mobile/` for reads). Every high-confidence negative in section 3 was grepped by hand. For tables with no create path, every column is marked never-written.
- **Reaches client:** a model counts if `shared/src` declares a type named after it (`<Model>DTO`, …) or declares at least 2 (or a third) of its model-unique, non-common column names as properties. 16 verdicts were set by hand (`REACH` in `overrides.py`) where name matching misled. For example, `UserEventType` is a realtime event, not the `UserEvent` table.
- **Clusters** were assigned by reading names and section comments; they are judgement calls.
- **Not covered:** dynamic access (`prisma[name]`), reads through `include` with no `select` (every column of the included model is fetched but not attributed), column use inside mobile/web except as a fallback signal, and values written by DB defaults on fixtures.
