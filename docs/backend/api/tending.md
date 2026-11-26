---
title: "Tending API"
sidebar_position: 12
description: Post-resolution check-in and re-entry endpoints for follow-through on Stage 4 agreements.
slug: /backend/api/tending
created: 2026-05-06
updated: 2026-05-14
status: living
---
# Tending API

Post-resolution check-in and re-entry endpoints. Tending surfaces after a session reaches `RESOLVED` status to help both partners follow through on the agreements and commitments made during Stage 4.

## Overview

Three Tending entry types exist:

- **Scheduled shared check-ins** (`SCHEDULED_SHARED_AGREEMENT_CHECKIN`) — created automatically for shared agreements when `Stage4Closure` is recorded. Visible to both session members. The cron script `backend/src/scripts/open-due-tending-entries.ts` opens them when their scheduled time arrives.
- **Scheduled individual check-ins** (`SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN`) — created for each user's individual commitments with `scope = INDIVIDUAL`. Only the owning user sees these by default; they can opt in to share with their partner via `POST tending/:entryId/share`. The same cron script opens these when their scheduled time arrives.
- **Passive re-entry** (`USER_INITIATED_REENTRY`) — created on demand when a user returns to a resolved session. Context is assembled from the Stage 4 closure summary, agreements, open needs, and individual commitments.

### Entry status lifecycle

```
SCHEDULED → (cron opens when due) → OPEN → PARTIAL (one partner responds) → COMPLETED (both respond)
                                          ↓
                                      CANCELLED / EXPIRED
```

---

## List Tending Entries

```
GET /api/v1/sessions/:id/tending
```

Returns all Tending entries for the session, enriched with response counts and the caller's own response (if any).

### Response

```typescript
interface ListTendingEntriesResponse {
  entries: TendingEntryDTO[];
}

interface TendingEntryDTO {
  id: string;
  type: TendingEntryType;
  status: TendingEntryStatus;
  scope: TendingEntryScope;       // SHARED | INDIVIDUAL
  ownerUserId: string | null;     // Set for INDIVIDUAL entries; null for SHARED
  optedInShared: boolean;         // INDIVIDUAL entry owner has shared with partner
  scheduledFor: string | null;    // ISO 8601; null for re-entry
  openedAt: string | null;
  completedAt: string | null;
  summary: string | null;         // Context assembled at creation time
  myResponse: TendingResponseDTO | null;
  responseCount: number;          // How many partners have responded
  createdAt: string;
  updatedAt: string;
}

enum TendingEntryScope {
  SHARED     = 'SHARED',
  INDIVIDUAL = 'INDIVIDUAL',
}

interface TendingResponseDTO {
  id: string;
  tendingEntryId: string;
  userId: string;
  status: string;                         // e.g. "WORKED", "PARTLY", "DID_NOT_WORK"
  reflection: string | null;
  continueChoice: ContinueChoice | null;  // Five structured forward paths
  submittedAt: string;
}

enum ContinueChoice {
  ANOTHER_ROUND   = 'ANOTHER_ROUND',   // Reset Stage 4 to inventory building
  EXTEND          = 'EXTEND',          // Keep entries SCHEDULED with new follow-up date (28 days)
  NEW_PROCESS     = 'NEW_PROCESS',     // Create a fresh Session linked via previousSessionId, with the caller's invitation for the partner; both start at Stage 0
  PARTIAL_CLOSURE = 'PARTIAL_CLOSURE', // Resolve some entries, continue others (per-TendingEntry granularity)
  FULL_CLOSURE    = 'FULL_CLOSURE',    // Mark all entries COMPLETED, move session to RESOLVED
}

enum TendingEntryType {
  SCHEDULED_SHARED_AGREEMENT_CHECKIN      = 'SCHEDULED_SHARED_AGREEMENT_CHECKIN',
  SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN = 'SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN',
  USER_INITIATED_REENTRY                  = 'USER_INITIATED_REENTRY',
}

enum TendingEntryStatus {
  SCHEDULED = 'SCHEDULED',
  OPEN      = 'OPEN',
  PARTIAL   = 'PARTIAL',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXPIRED   = 'EXPIRED',
}
```

---

## Submit Tending Response

Record the caller's response to an open Tending entry. One response per entry/user (upsert on repeat submission).

```
POST /api/v1/sessions/:id/tending/:entryId/responses
```

### Request Body

```typescript
interface SubmitTendingResponseRequest {
  status: string;                    // Required; max 80 chars. e.g. "WORKED", "PARTLY", "DID_NOT_WORK"
  reflection?: string;               // Optional; max 2000 chars
  continueChoice?: ContinueChoice;   // Optional; one of the five ContinueChoice enum values
}
```

### Response

```typescript
interface SubmitTendingResponseResponse {
  entry: TendingEntryDTO;     // Updated entry with new response counts + myResponse
}
```

### Side Effects

- Entry status advances to `PARTIAL` after the first response, `COMPLETED` when all session members have responded.
- On the transition to `COMPLETED`, a session event is published to notify the partner.

### Preconditions

- Entry must be in `OPEN` or `PARTIAL` status (not `SCHEDULED`, `COMPLETED`, `CANCELLED`, or `EXPIRED`).
- Caller must be a member of the session.

---

## Initiate Passive Re-entry

Create a new `USER_INITIATED_REENTRY` entry for a resolved session. Assembles context from the Stage 4 closure record, agreements, open needs, and individual commitments.

```
POST /api/v1/sessions/:id/tending/reentry
```

### Request Body

```typescript
interface CreateTendingReentryRequest {
  intent?: string;    // Optional; max 1000 chars. Caller's stated reason for re-entry
}
```

### Response

Returns `201 Created`.

```typescript
interface CreateTendingReentryResponse {
  entry: TendingEntryDTO;
}
```

### Preconditions

- Session must be `RESOLVED`.
- Caller must be a session member.

---

## Structured Three-Orientation Check-in

The primary unified endpoint for tending responses. Handles all open entries in one atomic transaction with structured three-part input.

```
POST /api/v1/sessions/:id/tending/checkin
```

### Request Body

```typescript
interface SubmitTendingCheckinRequest {
  orientations: {
    whatWorked: {
      reflection: string;                          // max 2000 chars
      perEntryNotes?: Record<string, string>;      // entryId → note
    };
    whereMoreSupport: {
      reflection: string;                          // max 2000 chars
      perEntryNotes?: Record<string, string>;
    };
    whatComesNext: {
      continueChoice: ContinueChoice;
      partialClosure?: Record<string, PartialClosureResolution>;  // entryId → resolution (PARTIAL_CLOSURE path only)
    };
  };
}

enum PartialClosureResolution {
  RESOLVED   = 'RESOLVED',
  CONTINUING = 'CONTINUING',
}
```

### Response

```typescript
interface SubmitTendingCheckinResponse {
  entries: TendingEntryDTO[];
  newSessionId?: string;            // Populated when continueChoice = NEW_PROCESS
  continueChoice: ContinueChoice;
  nextScheduledFor?: string | null; // ISO 8601; populated when continueChoice = EXTEND
}
```

### Behavior by ContinueChoice

| Choice | Effect |
|--------|--------|
| `ANOTHER_ROUND` | Clears Stage 4 closure, selections, and need coverage — resets to inventory building |
| `EXTEND` | Keeps all entries SCHEDULED with a new follow-up date (28 days from now) |
| `NEW_PROCESS` | Resolves the session and creates a new one linked via `previousSessionId`: the caller's seat, and a PENDING invitation named for the partner, which the caller shares from the new session's Stage 0 (the partner is seated by accepting it, as for any session; work-k5fk.34). Both begin at Stage 0 |
| `PARTIAL_CLOSURE` | Resolves entries marked RESOLVED; entries marked CONTINUING stay SCHEDULED |
| `FULL_CLOSURE` | All entries → COMPLETED; session → RESOLVED |

---

## Share / Unshare an Individual Entry

Allows the owner of an `INDIVIDUAL`-scope entry to share or unshare it with their partner.

```
POST /api/v1/sessions/:id/tending/:entryId/share
POST /api/v1/sessions/:id/tending/:entryId/unshare
```

### Preconditions

- Entry must have `scope = INDIVIDUAL`.
- Caller must be the entry owner (`ownerUserId`).

### Response

Returns the updated `TendingEntryDTO`.

---

## Scheduled Entry Opening (Cron)

The script `backend/src/scripts/open-due-tending-entries.ts` is run by cron. It:

1. Queries all `SCHEDULED` entries whose `scheduledFor` is in the past.
2. Sets their status to `OPEN`.
3. Publishes a session event so both partners are notified.

This script has no HTTP endpoint — it is invoked directly by the scheduler.

---

## Data Model

See [Prisma Schema: Tending](../data-model/prisma-schema.md#tending) for the full `TendingEntry` and `TendingResponse` model definitions.

---

## Error Codes

| Code | HTTP | Condition |
|------|------|-----------|
| `NOT_FOUND` | 404 | Session or entry not found |
| `VALIDATION_ERROR` | 400 | Entry is not in a state that accepts responses (e.g. SCHEDULED) |
| `UNAUTHORIZED` | 401 | Missing auth |
| `FORBIDDEN` | 403 | Caller is not a session member; or caller is not the owner of an INDIVIDUAL entry |

---

[Back to API Index](./index.md) | [Back to Stage 4](./stage-4.md)
