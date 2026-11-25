---
title: Realtime Integration
sidebar_position: 12
description: Ably-powered real-time updates for partner status and session events.
slug: /backend/api/realtime
---
# Realtime Integration

Ably-powered real-time updates for partner status and session events.

## Overview

Meet Without Fear uses [Ably](https://ably.com) for real-time communication:
- **Presence**: Know when partner is online/active
- **Pub/Sub**: Instant notifications of partner actions
- **Push**: Expo Push Notifications for offline users

## Architecture

```mermaid
flowchart LR
    UserA[User A Mobile] --> Ably[Ably Channels]
    UserB[User B Mobile] --> Ably
    Backend[Backend] --> Ably
    Ably --> Push[Expo Push]
    Push --> Offline[Offline Users]
```

## Channel Structure

### Session Channel

Each session has a private channel:

```
meetwithoutfear:session:{sessionId}
```

Both participants subscribe to this channel for session-level events. Clients hold `subscribe` only: the server is
the one publisher (work-k5fk.32), so a client cannot forge a session event for its partner.

### Typing Channel

The one channel a client publishes on, and only `typing.start` / `typing.stop` (clients drop any other name
received there):

```
meetwithoutfear:typing:{sessionId}
```

### User Presence Channel

For knowing if partner is actively in the app:

```
meetwithoutfear:session:{sessionId}:presence
```

## Events

### Session Events

Published by backend to session channel:

| Event | Payload | Description |
|-------|---------|-------------|
| `partner.signed_compact` | `{ signedAt }` | Partner signed Curiosity Compact |
| `partner.stage_completed` | `{ stage, completedAt }` | Partner completed a stage |
| `partner.advanced` | `{ toStage }` | Partner advanced to new stage |
| `partner.empathy_shared` | `{ }` | Partner consented to share empathy |
| `partner.needs_shared` | `{ }` | Partner shared their needs |
| `partner.needs_validated` | `{ stage: 3, validatedBy: string, validated: boolean }` | Partner validated the revealed needs lists |
| `session.needs_reveal_ready` | `{ stage: 3, needsRevealReady: true }` | Both partners consented — side-by-side reveal is ready |
| `partner.ranking_submitted` | `{ }` | Partner submitted strategy ranking |
| `agreement.proposed` | `{ agreementId }` | New agreement proposed |
| `agreement.confirmed` | `{ agreementId }` | Agreement confirmed by both |
| `session.paused` | `{ by, reason }` | Session paused |
| `session.resumed` | `{ }` | Session resumed |
| `session.resolved` | `{ }` | Session resolved |

### Presence Events

Ably presence provides automatically:

| Event | Description |
|-------|-------------|
| `enter` | User became active in session |
| `leave` | User left session view |
| `update` | User's state changed |

### Presence Data

When entering presence, include:

```typescript
interface PresenceData {
  userId: string;
  stage: number;
  status: StageStatus;
  lastActive: string;
}
```

## Client Integration

### Connecting to Ably

```typescript
import * as Ably from 'ably';

const ably = new Ably.Realtime({
  authCallback: async (tokenParams, callback) => {
    // Get token from backend
    const response = await fetch('/api/v1/auth/ably-token', {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const tokenRequest = await response.json();
    callback(null, tokenRequest.data);
  }
});
```

### Subscribing to Session

```typescript
const channel = ably.channels.get(`meetwithoutfear:session:${sessionId}`);

channel.subscribe('partner.stage_completed', (message) => {
  const { stage, completedAt } = message.data;
  // Update UI to show partner completed stage
});

channel.subscribe('partner.empathy_shared', () => {
  // Fetch partner's empathy attempt
  fetchPartnerEmpathy();
});
```

### Presence

```typescript
const presenceChannel = ably.channels.get(
  `meetwithoutfear:session:${sessionId}:presence`
);

// Enter presence when viewing session
presenceChannel.presence.enter({
  userId: currentUserId,
  stage: currentStage,
  status: 'IN_PROGRESS'
});

// Listen for partner presence
presenceChannel.presence.subscribe('enter', (member) => {
  if (member.clientId !== currentUserId) {
    setPartnerOnline(true);
  }
});

presenceChannel.presence.subscribe('leave', (member) => {
  if (member.clientId !== currentUserId) {
    setPartnerOnline(false);
  }
});
```

## Backend Publishing

### Publishing Events

```typescript
import * as Ably from 'ably';

const ably = new Ably.Rest(process.env.ABLY_API_KEY);

async function publishPartnerStageCompleted(
  sessionId: string,
  stage: number
) {
  const channel = ably.channels.get(`meetwithoutfear:session:${sessionId}`);
  await channel.publish('partner.stage_completed', {
    stage,
    completedAt: new Date().toISOString()
  });
}
```

### Presence-Based Routing

Before publishing, check if partner is online:

```typescript
async function notifyPartner(sessionId: string, event: string, data: any) {
  const presenceChannel = ably.channels.get(
    `meetwithoutfear:session:${sessionId}:presence`
  );

  const members = await presenceChannel.presence.get();
  const partnerPresent = members.some(m => m.clientId === partnerId);

  if (partnerPresent) {
    // Partner online - publish to Ably
    const channel = ably.channels.get(`meetwithoutfear:session:${sessionId}`);
    await channel.publish(event, data);
  } else {
    // Partner offline - send push notification
    await sendPushNotification(partnerId, event, data);
  }
}
```

## Push Notifications

### When Partner is Offline

Use Expo Push Notifications:

```typescript
import { Expo } from 'expo-server-sdk';

const expo = new Expo();

async function sendPushNotification(
  userId: string,
  event: string,
  data: any
) {
  const user = await getUser(userId);
  if (!user.pushToken) return;

  const message = getPushMessage(event, data);

  await expo.sendPushNotificationsAsync([{
    to: user.pushToken,
    sound: 'default',
    title: message.title,
    body: message.body,
    data: { sessionId: data.sessionId, event }
  }]);
}

function getPushMessage(event: string, data: any) {
  const messages: Record<string, { title: string; body: string }> = {
    'partner.signed_compact': {
      title: 'Partner is ready',
      body: 'They signed the Curiosity Compact. Your turn!'
    },
    'partner.stage_completed': {
      title: 'Partner finished a stage',
      body: 'They completed their work. Check in when ready.'
    },
    'partner.empathy_shared': {
      title: 'Partner shared their empathy attempt',
      body: 'See how they imagine you might be feeling.'
    },
    'agreement.proposed': {
      title: 'New experiment proposed',
      body: 'Review and confirm the agreement.'
    }
  };

  return messages[event] || { title: 'Meet Without Fear', body: 'You have an update' };
}
```

### Storage and rate limits
- Push tokens are stored on `User.pushToken` (optional) and updated on login.
- Nudge/reminder actions must be rate limited (e.g., 1 per 6 hours per partner) and logged.
- If push token is missing, fall back to Ably only; do not error.

## Auth Token Endpoint

Backend endpoint for Ably token requests:

```
GET /api/v1/auth/ably-token
```

### Response

```typescript
interface AblyTokenResponse {
  tokenRequest: {
    keyName: string;
    ttl: number;         // Token TTL in milliseconds
    timestamp: number;
    capability: string;
    clientId: string;
    nonce: string;
    mac: string;
  };
}
```

### Token Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **TTL** | 60 minutes | Long enough for typical session, short enough for security |
| **Refresh threshold** | 5 minutes before expiry | Proactive refresh prevents disruption |
| **Max capability scope** | User's active sessions only | Principle of least privilege |

### Capability

Tokens are scoped to user's sessions:

```typescript
function generateAblyCapability(userId: string, sessionIds: string[]) {
  const capability: Record<string, string[]> = {};

  for (const sessionId of sessionIds) {
    // subscribe only: only the server publishes session events (work-k5fk.32)
    capability[`meetwithoutfear:session:${sessionId}`] = ['subscribe'];
    capability[`meetwithoutfear:presence:${sessionId}`] = ['subscribe', 'presence'];
    // the one channel a client publishes on: typing.start / typing.stop only
    capability[`meetwithoutfear:typing:${sessionId}`] = ['subscribe', 'publish'];
  }

  return capability;
}
```

### Token Lifecycle During Stage 4

Stage 4 requires sustained real-time coordination. Token expiry mid-negotiation could disrupt emotional flow:

```mermaid
sequenceDiagram
    participant App as Mobile App
    participant Ably as Ably Client
    participant Backend as Backend

    Note over App,Backend: Token has 60-min TTL
    App->>Ably: Connected, active in Stage 4

    loop Every 55 minutes
        Ably-->>App: Token nearing expiry (authCallback triggered)
        App->>Backend: GET /auth/ably-token
        Backend-->>App: New token (fresh 60-min TTL)
        Ably->>Ably: Seamless token swap
    end

    Note over App,Ably: User never notices refresh
```

**Key Design:**
- Ably SDK's `authCallback` handles proactive refresh
- Refresh happens ~5 minutes before expiry (configurable via `tokenParams.ttl`)
- Connection is NOT dropped during refresh
- If refresh fails, SDK retries with exponential backoff

## Error Handling

### Connection Recovery

```typescript
ably.connection.on('disconnected', () => {
  setConnectionStatus('reconnecting');
});

ably.connection.on('connected', () => {
  setConnectionStatus('connected');
  // Resync state after reconnection
  refetchSessionState();
});

// Handle suspended state (connection lost for extended period)
ably.connection.on('suspended', () => {
  setConnectionStatus('suspended');
  // Show gentle UI indicator - avoid alarming user during emotional process
});
```

### Stage 4 Recovery Strategy

Stage 4 negotiation requires special handling to prevent emotional disruption:

| Connection State | User Impact | Recovery Action |
|-----------------|-------------|-----------------|
| `disconnected` (< 30s) | Invisible to user | Silent reconnect |
| `disconnected` (30s-2min) | Subtle indicator | "Reconnecting..." toast |
| `suspended` (> 2min) | Full notice | Modal with "Connection lost. Your progress is saved." |
| `failed` | Critical | Show error with refresh prompt |

**Critical Invariant:** Rankings and proposals are persisted server-side immediately. Connection loss never causes data loss.

```typescript
// Stage 4 specific: more aggressive recovery
const STAGE_4_RECOVERY_CONFIG = {
  connectionStateTtl: 120000,    // 2 minutes before suspended
  disconnectedRetryTimeout: 5000, // Retry every 5s when disconnected
  suspendedRetryTimeout: 15000,   // Retry every 15s when suspended
};
```

### Token Refresh Failure Handling

If token refresh fails (e.g., Clerk session expired):

```typescript
ably.connection.on('failed', (stateChange) => {
  if (stateChange.reason?.code === 40142) { // Token error
    // Clerk session may have expired - trigger re-auth
    await clerk.session.touch(); // Attempt session refresh
    ably.connect(); // Retry with fresh Clerk token
  }
});
```

## Related Documentation

- [Architecture: Realtime](../overview/architecture.md#realtime-layer-presence-based-notifications)
- [Session States](../state-machine/index.md)
- [Push Notifications Setup](../../deployment/push-notifications.md)

---

[Back to API Index](./index.md) | [Back to Backend](../index.md)
