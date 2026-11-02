---
title: Invitations API
sidebar_position: 3
description: Invitation acceptance and management for session partners.
slug: /backend/api/invitations
---
# Invitations API

Invitation acceptance and management for session partners.

## Delivery Model

The backend **does not send invitations itself**. `POST /api/v1/sessions` (see [Sessions API](./sessions.md)) creates the session + invitation records and returns a shareable invitation URL; the inviting user shares that link over their own channels (iMessage, WhatsApp, email, etc.). `createSession` accepts `personId`, `inviteName`, `context`, and an optional `innerThoughtsId` — not `inviteEmail` / `invitePhone`. Resend is used for some transactional emails elsewhere (not outbound invitations), and Twilio is not currently integrated.

Invitations are valid for **7 days** from creation; after that the `GET /invitations/:id` endpoint returns `status: 'EXPIRED'`.

## Get Invitation Details

Get details about an invitation (can be accessed without auth for preview).

```
GET /api/v1/invitations/:id
```

### Response

```typescript
interface InvitationDTO {
  id: string;
  invitedBy: {
    name: string | null;
  };
  name: string | null;
  status: InvitationStatus;  // PENDING, ACCEPTED, DECLINED, EXPIRED
  createdAt: string;
  expiresAt: string;
  session: {
    id: string;
    status: string;
  };
}
```

### Example Response

```json
{
  "success": true,
  "data": {
    "invitation": {
      "id": "inv_def456",
      "invitedBy": {
        "name": "Jordan"
      },
      "name": "Alex",
      "status": "PENDING",
      "createdAt": "2024-01-15T10:30:00Z",
      "expiresAt": "2024-01-22T10:30:00Z",
      "session": {
        "id": "sess_abc123",
        "status": "INVITED"
      }
    }
  }
}
```

### Rate Limit

Rate limited to 10 requests per minute per IP. Returns `RATE_LIMITED` on breach.

### Errors

| Code | When |
|------|------|
| `NOT_FOUND` | Invitation doesn't exist |
| `RATE_LIMITED` | More than 10 requests per minute from the same IP |

> Expired invitations return a successful 200 response with `status: 'EXPIRED'` rather than an error code — clients should branch on `data.status`.

---

## Acknowledge Invitation

Mark a pending invitation as viewed. Creates a notification so the invitee can see the invitation. Requires authentication.

```
POST /api/v1/invitations/:id/acknowledge
```

### Response

```typescript
interface AcknowledgeInvitationResponse {
  acknowledged: boolean;
  reason?: string;  // 'expired' or status name if not acknowledged
  invitation: {
    id: string;
    status: InvitationStatus;
    invitedBy: {
      id: string;
      name: string | null;
    };
    session?: {
      id: string;
      status: string;
    };
    expiresAt?: string;
  };
}
```

### Errors

| Code | When |
|------|------|
| `VALIDATION_ERROR` (400) | User is the inviter (cannot acknowledge own invitation) |
| `NOT_FOUND` | Invitation doesn't exist |

---

## Accept Invitation

Accept an invitation and join the session. Requires authentication.

```
POST /api/v1/invitations/:id/accept
```

### Authentication

- If user is already registered, use existing auth token
- If new user, must complete registration first (invitation ID is preserved)

### Response

```typescript
interface AcceptInvitationResponse {
  session: SessionSummaryDTO;
}
```

### Side Effects

1. Session transitions out of `INVITED` toward `ACTIVE` (sessions are `CREATED` at session creation, move to `INVITED` once the inviter confirms the invitation message, then `ACTIVE` on accept).
2. Inviter receives push notification + Ably realtime event on their user channel.
3. The accepter's `StageProgress` row for Stage 0 is created here. The inviter's `StageProgress` row was already created when the session was originally created.
4. `SharedVessel` was already created at session creation; no new vessel is created on accept.
5. The accepting user's `UserVessel` is created here.
6. The inviter reaches the `invitation_sent` milestone (job connection, at the accept instant; a no-op if `POST /sessions/:id/invitation/confirm` already wrote it). An accepted invitation was necessarily sent, and the app's share modal — the only caller of confirm — is not shown again once the partner accepted, so without this the inviter would stay in stage 0 (`backend/src/services/milestone-writer.ts` `reachInvitationSentOnAccept`; the E2E auto-accept on `GET /sessions/:id/state` does the same). A later confirm is a no-op.

### Example

```bash
curl -X POST /api/v1/invitations/inv_def456/accept \
  -H "Authorization: Bearer <token>"
```

### Response

```json
{
  "success": true,
  "data": {
    "session": {
      "id": "sess_abc123",
      "status": "ACTIVE",
      "partner": {
        "id": "user_123",
        "name": "Jordan"
      },
      "myProgress": {
        "stage": 0,
        "status": "IN_PROGRESS",
        "startedAt": "2024-01-16T14:00:00Z",
        "completedAt": null
      },
      "partnerProgress": {
        "stage": 0,
        "status": "IN_PROGRESS",
        "startedAt": "2024-01-15T10:30:00Z",
        "completedAt": null
      },
      "selfActionNeeded": ["compactSigned"],
      "partnerActionNeeded": ["partnerCompactSigned"]
    }
  }
}
```

### Errors

| Code | When |
|------|------|
| `NOT_FOUND` | Invitation doesn't exist |
| `VALIDATION_ERROR` (400) | Invitation has expired, has already been accepted/declined, or the caller is the inviter trying to accept their own invitation |

---

## Decline Invitation

Decline an invitation.

```
POST /api/v1/invitations/:id/decline
```

### Request Body

```typescript
interface DeclineInvitationRequest {
  reason?: string;  // Optional feedback
}
```

### Response

```typescript
interface DeclineInvitationResponse {
  declined: boolean;
  declinedAt: string;
}
```

### Side Effects

- Session status changes to `ABANDONED`
- Inviter receives notification
- Invitation cannot be re-accepted

---

## Related session/person endpoints

These invitation-adjacent endpoints live in the same route file:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/v1/sessions/:id/archive` | Archive a resolved or abandoned session |
| `DELETE` | `/api/v1/sessions/:id` | Remove the caller's private data from a session (marks it `ABANDONED`) |
| `PATCH` | `/api/v1/relationships/:relationshipId/nickname` | Update the partner's nickname on the caller's side |
| `GET` | `/api/v1/people` | List all people the user has established relationships with |

> **Not implemented:** There is no `POST /invitations/:id/resend` endpoint. Invitations can't be resent — if an invitation expires, the inviter creates a new session.

> **Duplicate-session guard:** `POST /api/v1/sessions` checks for an existing active session with the same person and returns that session instead of creating a new one.

---

## Related Documentation

- [Sessions API](./sessions.md) - Session creation
- [New Session Flow](../../wireframes/new-session-flow.md) - UI flow for invitations
- [Stage 0: Onboarding](../../stages/stage-0-onboarding.md) - What happens after acceptance

---

[Back to API Index](./index.md) | [Back to Backend](../index.md)
