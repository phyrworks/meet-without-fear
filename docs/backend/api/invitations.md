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

### First opener claims (work-k5fk.10.8)

Until someone opens it, the link is the credential: anyone holding it sees the preview. The **first signed-in person other than the inviter to open it** (the app calls `POST /invitations/:id/acknowledge` when the link opens; an accept or decline of an unclaimed invitation claims it too) becomes its invitee — `invitation.claimed_by_user_id` / `claimed_at`, written atomically by `app.invitation_claim`. From then on only the claimer reads its details, accepts or declines it; anyone else gets **403 `FORBIDDEN`** ("This invitation has already been opened by someone else") from `GET`, `acknowledge`, `accept` and `decline`. The database enforces the same: `app.invitation_peek` returns only the claim notice (`withheld`), `app.invitation_answer` refuses ACCEPTED / DECLINED by anyone but the claimer (SQLSTATE `MWI01`), and `accepted_by_user_id` must equal `claimed_by_user_id` (CHECK). The inviter sees who claimed it as `invitation.claimedBy` (`{ id, name, claimedAt }`) in `GET /sessions/:id/invitation` and `GET /sessions/:id/state`.

## Get Invitation Details

Get details about an invitation (can be accessed without auth for preview; auth is optional, and once the invitation is claimed only the claimer and the inviter get past the 403).

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
| `FORBIDDEN` (403) | Someone else claimed it (first opener claims) |
| `RATE_LIMITED` | More than 10 requests per minute from the same IP |

> Expired invitations return a successful 200 response with `status: 'EXPIRED'` rather than an error code — clients should branch on `data.status`.

---

## Acknowledge Invitation

Mark a pending invitation as viewed, and **claim** it: the first signed-in non-inviter to call this becomes the invitee (`app.invitation_claim`; idempotent for them). Creates a notification so the invitee can see the invitation. Requires authentication.

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
| `FORBIDDEN` (403) | Someone else claimed it first |

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
| `FORBIDDEN` (403) | Someone else claimed it first (first opener claims) |

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
| `POST` | `/api/v1/sessions/:id/archive` | Archive a created, invited, resolved or abandoned session, as a current participant (`app.session_archive`: 404 for a non-participant, 403 for one who left, 400 from any other state) |
| `DELETE` | `/api/v1/sessions/:id` | Remove the caller's private data from a session (marks it `ABANDONED`) |
| `PATCH` | `/api/v1/contacts/:userId/nickname` | Set or clear (`{ "nickname": null }`) what the caller calls another user: the caller's own `user_contact` entry, never shown to that user. A cleared entry is authoritative: the partner then shows by their own names, never by an old invite name. 404 unless the two share a session; 400 for the caller's own id (work-k5fk.2; replaces `PATCH /relationships/:relationshipId/nickname`) |
| `GET` | `/api/v1/people` | List the other humans the user shares a session with, named by the caller's nickname for them |

> **Not implemented:** There is no `POST /invitations/:id/resend` endpoint. Invitations can't be resent — if an invitation expires, the inviter creates a new session.

> **One live session per pair of humans** (work-k5fk.2, owner decision Q3): the database enforces it with `live_session_pair`'s key, at the moment the second human joins — `POST /invitations/:id/accept` answers **409 `CONFLICT`** ("You already have a session in progress with this person…") and changes nothing when the invitee already shares a live session with the inviter. The invite-time pre-check: `POST /api/v1/sessions` with a `personId` the caller already shares a live session with returns that session as `existingActiveSession` (200) instead of creating one, and with `forceCreate: true` answers the same 409. A link invitation (`inviteName` only) names nobody yet, so only the accept can refuse it.
>
> **Who added whom:** the inviter is the session's initiator (`participant.added_by_user_id` NULL, one per session); the invitee's participant is added by the inviter. What the inviter calls a link invitee is resolved when the inviter reads it — their own nickname for them, else the invite name of the invitation the invitee accepted; nothing is written into the inviter's rows by the invitee's accept.

---

## Related Documentation

- [Sessions API](./sessions.md) - Session creation
- [New Session Flow](../../wireframes/new-session-flow.md) - UI flow for invitations
- [Stage 0: Onboarding](../../stages/stage-0-onboarding.md) - What happens after acceptance

---

[Back to API Index](./index.md) | [Back to Backend](../index.md)
