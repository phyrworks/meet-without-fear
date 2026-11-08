---
title: Sessions API
sidebar_position: 2
description: Session creation, listing, and lifecycle management.
slug: /backend/api/sessions
updated: "2026-05-03"
---
# Sessions API

Session creation, listing, and lifecycle management.

## Create Session

Creates a new session and sends an invitation to the partner.

```
POST /api/v1/sessions
```

### Request Body

```typescript
interface CreateSessionRequest {
  // Existing person (returns existing active session if one already exists)
  personId?: string;

  // Or, name-only invite for a brand-new person
  inviteName?: string;

  // Optional context (private to creator, used to seed the AI intro)
  context?: string;

  // Optional link to the Inner Thoughts entry that motivated the session
  innerThoughtsId?: string;
}
```

### Validation Rules

- Must provide `personId` OR `inviteName`
- `personId` cannot be the caller's own user ID — returns `VALIDATION_ERROR` (400)
- If `personId` has an existing `ACTIVE`/`CREATED`/`INVITED` session, that session is returned instead of creating a new one

### Invitation Delivery

The backend returns a shareable `invitationUrl`; the inviter forwards it through whatever channel they prefer (iMessage, email, WhatsApp). The backend itself does **not** send invitation emails or SMS. See [Invitations API](./invitations.md) for the full model.

### Response

```typescript
interface CreateSessionResponse {
  session: SessionSummaryDTO;
  invitationId: string;
  invitationUrl: string;  // Deep link for partner
}
```

### Example

```bash
curl -X POST /api/v1/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "inviteName": "Alex",
    "context": "Discussion about household responsibilities"
  }'
```

### Response

```json
{
  "success": true,
  "data": {
    "session": {
      "id": "sess_abc123",
      "relationshipId": "rel_xyz789",
      "status": "CREATED",
      "createdAt": "2024-01-15T10:30:00Z",
      "partner": {
        "id": "user_pending",
        "name": "Alex"
      },
      "myProgress": {
        "stage": 0,
        "status": "NOT_STARTED",
        "startedAt": null,
        "completedAt": null
      },
      "partnerProgress": {
        "stage": 0,
        "status": "NOT_STARTED",
        "startedAt": null,
        "completedAt": null
      },
      "selfActionNeeded": ["compactSigned"],
      "partnerActionNeeded": ["partnerCompactSigned"]
    },
    "invitationId": "inv_def456",
    "invitationUrl": "meetwithoutfear://invite/inv_def456"
  }
}
```

### Errors

| Code | When |
|------|------|
| `VALIDATION_ERROR` | Missing required fields |
| `NOT_FOUND` | `personId` doesn't exist |

### Session lifecycle

`CREATED → INVITED → ACTIVE → (PAUSED) → ARCHIVED | ABANDONED`. `CREATED` flips to `INVITED` once the inviter confirms the invitation message; `INVITED` flips to `ACTIVE` when the partner accepts. Either participant can pause an active session (`POST /sessions/:id/pause`), which moves it to `PAUSED`; `POST /sessions/:id/resume` returns it to `ACTIVE`.

> **Background AI**: After the inviter confirms the invitation message (`POST /sessions/:id/invitation/confirm`), the HTTP response returns immediately and the backend fires an AI transition message generation + Ably session-event publish asynchronously (fire-and-forget).

---

## List Sessions

Listing the caller's sessions is currently surfaced via **unread count** + per-person **People API** rather than a generic `GET /sessions` endpoint. The `GET /sessions/unread-count` endpoint returns aggregate badge data.

```
GET /api/v1/sessions/unread-count
```

---

## Get Session Details

Get full details for a specific session.

```
GET /api/v1/sessions/:id
```

### Response

```typescript
interface SessionDetailDTO {
  id: string;
  relationshipId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;

  partner: {
    id: string;
    name: string | null;
  };

  myProgress: StageProgressDTO;
  partnerProgress: StageProgressDTO;

  relationship: {
    id: string;
    createdAt: string;
    sessionCount: number;
  };

  currentGates: StageGateDTO[];
  resolvedAt: string | null;

  selfActionNeeded: string[];
  partnerActionNeeded: string[];
}
```

### Errors

| Code | When |
|------|------|
| `UNAUTHORIZED` (401) | No auth token |
| `NOT_FOUND` (404) | Session doesn't exist, or the authenticated user isn't a participant (non-participants see 404, not 403, to avoid disclosing session IDs). The mobile client implements a circuit-breaker on 404: child queries wait for `/sessions/:id` state to resolve, pending-actions polling stops when access is denied, and Ably subscriptions tear down — preventing cascading error bursts. |

---

## Session state, timeline, and progress

The frontend doesn't reconstruct session state from `GET /sessions/:id` alone. Use these companion endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET`  | `/api/v1/sessions/:id/state` | Consolidated session + stage + gate state. Response includes a `milestones` object with timestamps: `feelHeardConfirmedAt`, `witnessStartedAt` (Stage 1 entry time), and others. Messages are paginated — up to 500 returned with a `hasMore` flag for older history. |
| `GET`  | `/api/v1/sessions/:id/timeline` | Ordered ChatItem timeline (messages + indicators) |
| `GET`  | `/api/v1/sessions/:id/progress` | Per-user `StageProgress` + gate satisfaction |
| `POST` | `/api/v1/sessions/:id/stages/advance` | Advance the caller's stage when all gates for the current stage are satisfied |
| `POST` | `/api/v1/sessions/:id/resolve` | Resolve session. Requires at least one `AGREED` agreement exists in the shared vessel; returns `VALIDATION_ERROR` otherwise |
| `POST` | `/api/v1/sessions/:id/viewed` | Mark the session as viewed (clears unread flags) |
| `POST` | `/api/v1/sessions/:id/shared-context-viewed` | Body `{ messageId }`: the caller's chat showed this received shared frame ("Context from X" / "Feedback from X"). Only a `SHARED_CONTEXT` / `VALIDATION_FEEDBACK` message in the caller's own conversation sent by someone else is accepted (else `404`; a non-id `messageId` is `400`). Advances the caller's viewed instant (never backwards; a frame already covered writes nothing, `advanced: false`), which makes the sender's line "✓ Seen" and clears the caller's `hasUnviewedSharedContext` and unviewed `context_received` actions. Returns `{ success, advanced, lastViewedSharedContextAt }`. Replaces `/share-tab-viewed` (work-2doq). See [reconciler-flow](../reconciler-flow.md) "Delivered → Seen". |
| `GET`  | `/api/v1/sessions/:id/invitation` | Get the current draft invitation message (inviter only) |
| `PUT`  | `/api/v1/sessions/:id/invitation/message` | Replace the draft invitation message |
| `POST` | `/api/v1/sessions/:id/invitation/confirm` | Confirm the invitation message; requires a finalized topic frame and transitions session `CREATED → INVITED` |
| `POST` | `/api/v1/sessions/:id/topic-frame/generate` | AI-generate and store a proposed neutral 3-5 word topic frame from user 1's Stage 0 invitation draft (creator only) |
| `POST` | `/api/v1/sessions/:id/topic-frame/confirm` | Confirm the proposed frame or steer the AI toward a revised frame; persists `Session.topicFrameConfirmedAt` (creator only) |
| `GET`  | `/api/v1/sessions/:id/inner-thoughts` | Fetch the linked Inner Thoughts entry (if any) |

> **Stage gates** (code: `STAGE_GATES`): Stage 0 requires `compactSigned`; Stage 1 requires `feelHeardConfirmed`; later stages have their own gate keys. `/progress` surfaces which gates the caller and the partner still need to satisfy.

### Pause / Resume

```
POST /api/v1/sessions/:id/pause
POST /api/v1/sessions/:id/resume
```

Either participant can pause an `ACTIVE` session (e.g., for a cooling-off period). The session moves to `PAUSED` status and the partner receives a real-time `session.paused` event. All state is preserved. `POST /sessions/:id/resume` returns the session to `ACTIVE` and emits a `session.resumed` event.

**Pause response:**
```typescript
interface PauseResponse {
  paused: boolean;
  pausedAt: string; // ISO timestamp
  status: "PAUSED";
}
```

**Resume response:**
```typescript
interface ResumeResponse {
  resumed: boolean;
  resumedAt: string; // ISO timestamp
  status: "ACTIVE";
}
```

Errors: `SESSION_NOT_ACTIVE` (400) if session is not `ACTIVE` when pausing; `VALIDATION_ERROR` (400) if session is not `PAUSED` when resuming.

---

## Related Documentation

- [User Journey](../../overview/user-journey.md) - High-level session flow
- [Session Status States](../../wireframes/session-dashboard.md) - UI states for sessions
- [Invitations API](./invitations.md) - Partner invitation flow

---

[Back to API Index](./index.md) | [Back to Backend](../index.md)
