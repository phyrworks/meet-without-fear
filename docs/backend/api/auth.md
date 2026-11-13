---
title: Authentication API
sidebar_position: 13
description: Authentication via Clerk with backend user provisioning and Ably token management.
slug: /backend/api/auth
created: 2026-03-11
updated: 2026-05-18
status: living
---
# Authentication API

Authentication via Clerk with backend user provisioning and Ably token management.

## Overview

Meet Without Fear uses **Clerk** for authentication and token issuance. Expo app integrates Clerk for signup/login/social; backend uses Clerk middleware to validate tokens. No custom password or refresh-token handling in the backend.

### Clerk-based flow (MVP)
1) **Mobile (Expo)**: Wrap the app root with `<ClerkProvider publishableKey={...}>`. Use Clerk hooks (`useAuth`, `useUser`) to sign in/up and obtain session tokens:
```tsx
const { getToken } = useAuth();
const token = await getToken({ template: 'backend' }); // send as Bearer token
```
2) **Backend (Express)**: Add `clerkMiddleware()` at the top-level router to validate incoming `Authorization: Bearer <Clerk JWT>`:
```ts
import { clerkMiddleware, requireAuth } from '@clerk/express';
app.use(clerkMiddleware());
app.use('/api/v1', requireAuth(), apiRouter);
```
3) **User provisioning**: The auth middleware (`backend/src/middleware/auth.ts`) looks up the local `User` row by Clerk user ID on every authenticated request (fast path, no Clerk API call). On the first request for an unseen Clerk ID it fetches the Clerk user and creates the row, with a P2002 fallback for concurrent-create races. Controllers downstream of the middleware (including `GET /auth/me`) assume the User row already exists and only read from it. First-login rules (work-jv9y), enforced regardless of Clerk dashboard settings:
   - The row's email is the Clerk user's **primary** address (`primaryEmailAddressId`), and only if its `verification.status` is exactly `verified`. It is stored trimmed and lowercased; `User.email` is unique ignoring case and surrounding whitespace (index `User_email_normalized_key` on `lower(btrim(email, E' \t\n\r\f'))`, migration `user_email_case_insensitive_unique`), so rows written before the fix with their original case or padding still collide, and the holder lookup uses the same expression. Otherwise the request is refused with **403 `EMAIL_NOT_VERIFIED`** and no row is created (there is no placeholder email).
   - A P2002 is resolved only by re-reading **by Clerk ID** (the same identity's concurrent request won). If the email instead belongs to a row bound to a different Clerk ID, or to no Clerk ID, the request is refused with **409 `ACCOUNT_LINK_CONFLICT`**, the row is not touched, and a `warn` log `auth.identity_conflict` records `existingUserId`, `incomingClerkUserId` and `existingClerkUserId` (no email or name). If the holder vanished between the failed create and the lookup, the create is retried once; a second collision is refused the same way (409, `existingUserId: null` in the log), so no raw constraint error reaches the client. Re-linking such an account (e.g. a returning user who recreated their Clerk account) is a manual support action (runbook: work-e6z9). Owner decisions: the 409 revealing that the address has an account is acceptable (the caller has proven ownership of it), and `auth.identity_conflict` stays at `warn` (not Sentry).
4) **Token characteristics**: Tokens are Clerk session JWTs; no backend refresh endpoint is needed. Expiration/rotation is managed by Clerk.

The only backend-issued tokens are for Ably (`/auth/ably-token`) which require a valid Clerk session token on the request.

## Register / Login

Handled entirely by Clerk in the mobile app. The backend does **not** implement `/auth/register` or `/auth/login`. Use Clerk’s SDK UI/components or custom flows in Expo; send Clerk session tokens to the backend.

For invitation acceptance, the app should pass `invitationId` to Clerk’s sign-up flow, then call `/sessions/:id/compact/sign` after auth.

## Logout

Handled by Clerk SDK on the client (ends session + clears tokens). No backend endpoint required.

## Get Current User

Get the authenticated user's profile.

```
GET /api/v1/auth/me
```

### Response

```typescript
interface GetMeResponse {
  user: UserDTO;
  activeSessions: number;
  pushNotificationsEnabled: boolean;
}
```

`GET /auth/me`:
- Trusts the Clerk middleware for auth context and the middleware-provisioned local user row.
- Returns the current user profile plus `activeSessions` (count of sessions in `ACTIVE`, `WAITING`, or `PAUSED` state) and `pushNotificationsEnabled` (true iff a non-null `pushToken` is stored).

---

## Update Profile

Update user profile information.

```
PATCH /api/v1/auth/me
```

### Request Body

```typescript
interface UpdateProfileRequest {
  name?: string;       // deprecated single-field form
  firstName?: string;
  lastName?: string;
}
```

### Response

```typescript
interface UpdateProfileResponse {
  user: UserDTO;
}
```

---

## Update Push Token

Register device for push notifications.

```
POST /api/v1/auth/push-token
```

### Request Body

```typescript
interface UpdatePushTokenRequest {
  pushToken: string;  // Expo push token
  platform: 'ios' | 'android';
}
```

### Response

```typescript
interface UpdatePushTokenResponse {
  registered: boolean;
}
```

---

## Ably Token

Get an Ably token for real-time connections.

```
GET /api/v1/auth/ably-token
```

### Response

```typescript
interface AblyTokenResponse {
  tokenRequest: {
    keyName: string;
    ttl: number;
    timestamp: number;
    capability: string;
    clientId: string;
    nonce: string;
    mac: string;
  };
}
```

### Capability Scoping

Token capability always includes a private notification channel for the user. Session channels are added for each session the user participates in with status `CREATED`, `INVITED`, `ACTIVE`, `WAITING`, or `PAUSED` (so partners can subscribe before the session is accepted):

```json
{
  "meetwithoutfear:user:<userId>": ["subscribe"],
  "meetwithoutfear:session:sess_abc123": ["subscribe", "publish"],
  "meetwithoutfear:session:sess_abc123:presence": ["presence"]
}
```

Users with no relevant sessions still receive a valid token scoped to just the user notification channel.

---

## Other `/auth` endpoints

Not fully documented above; see `backend/src/routes/auth.ts` for the complete list:

- `DELETE /api/v1/auth/push-token` — unregister device for push notifications.
- `PATCH /api/v1/auth/biometric` — update biometric preference (iOS Touch ID / Face ID opt-in stored server-side for cross-device consistency). When enabling, the server stamps `biometricEnrolledAt = new Date()`; when disabling, it clears it to `null`.
- `PATCH /api/v1/auth/me/mood` — set the user's default mood intensity.
- `GET` / `PUT /api/v1/auth/me/memory-preferences` — read / replace the memory-detection preferences (retention and surfacing toggles).
- `GET` / `PATCH /api/v1/auth/me/notification-preferences` — read / partially update push-notification categories.
- `GET` / `PATCH /api/v1/auth/me/privacy-preferences` — read / partially update privacy preferences. The response shape is `PrivacyPreferencesDTO`:

  ```typescript
  interface PrivacyPreferencesDTO {
    showActivityStatus: boolean;     // show online/activity status to partner
    allowSessionInvites: boolean;    // allow others to start invited sessions
    analyticsOptOut: boolean;        // opt out of anonymous Mixpanel analytics
  }
  ```

  `PATCH` accepts any subset of these fields; unset fields are merged from the current value. `analyticsOptOut: true` causes the mobile `MixpanelInitializer` to immediately suppress all analytics calls (track, identify, alias, setUserProperties) for that session.

- `DELETE /api/v1/auth/me` — account deletion. Abandons active sessions, anonymizes historical messages/empathy records, and queues Clerk account deletion.

---

## Security Considerations

### Rate Limiting

Rate limiting for authentication endpoints (login, register, password reset) is handled by **Clerk**. The backend only rate-limits its own endpoints:

| Endpoint | Limit |
|----------|-------|
| `/auth/ably-token` | 10 per minute per user |
| `/auth/me` | 30 per minute per user |
| `/auth/push-token` | 5 per minute per user |

### Token Storage (Mobile)

Clerk manages session tokens automatically. For best security:

- Use Clerk's secure token storage (handles platform-specific secure storage)
- Access tokens are managed in memory by Clerk SDK
- Never manually store tokens in AsyncStorage
- Ably tokens can be stored in memory (short-lived, ~60 min TTL)

---

## Related Documentation

- [Realtime Integration](./realtime.md) - Ably token usage
- [Sessions API](./sessions.md) - Authenticated session access

---

[Back to API Index](./index.md) | [Back to Backend](../index.md)
