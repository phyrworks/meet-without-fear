---
title: Environment Variables
sidebar_position: 3
description: All required environment variables for Meet Without Fear services.
slug: /deployment/environment-variables
created: 2026-03-11
updated: 2026-05-25
status: living
---
# Environment Variables

All required environment variables for Meet Without Fear services.

## Backend API

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Container port (Compose sets to 3000) | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | Access token signing secret | (generated) |
| `JWT_REFRESH_SECRET` | Refresh token signing secret | (generated) |
| `ABLY_API_KEY` | Ably API key for realtime | `xxxxx.yyyyy:zzzzz` |
| `AWS_ACCESS_KEY_ID` | AWS credentials for Bedrock | `AKIA...` |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for Bedrock | (secret) |
| `AWS_REGION` | AWS region for Bedrock | `us-west-2` |
| `FIELD_ENCRYPTION_KEY` | 32-byte base64 key for AES-256-GCM field encryption. When unset, sensitive fields are stored as plaintext and the server logs a warning (intentional during the test phase). Generate with `openssl rand -base64 32` | (optional pre-launch; required before public launch) |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `REQUIRE_FIELD_ENCRYPTION` | Set to `true` to make a missing `FIELD_ENCRYPTION_KEY` a fatal startup error. Re-enable before public launch. | `false` |
| `REDIS_URL` | Redis connection string | (none - in-memory fallback) |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | `60000` |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |
| `EXPO_ACCESS_TOKEN` | Expo access token used by the backend when Expo push security is enabled. | (optional unless Expo push security is enabled) |
| `OPENAI_API_KEY` | OpenAI key for TTS (`/api/tts` → `tts-1` / `tts-1-hd`). Without it, TTS returns 500 and meditation/gratitude/chat read-aloud features are broken. | (none) |
| `APP_LATEST_BUILD_NUMBER_IOS` / `APP_LATEST_BUILD_NUMBER_ANDROID` | Latest native mobile build number for optional update prompts. Falls back to `APP_LATEST_BUILD_NUMBER`. | `40` |
| `APP_MIN_BUILD_NUMBER_IOS` / `APP_MIN_BUILD_NUMBER_ANDROID` | Minimum supported native mobile build number for required update prompts. Falls back to `APP_MIN_BUILD_NUMBER`. | (none) |
| `APP_DOWNLOAD_URL_IOS` / `APP_DOWNLOAD_URL_ANDROID` | Platform-specific update link opened by the native app. Falls back to `APP_DOWNLOAD_URL`, then `https://meetwithoutfear.com/download`. | `https://meetwithoutfear.com/download` |
| `APP_LATEST_VERSION` | Human-readable app version returned by `/api/version/check`. | `0.0.1` |
| `APP_UPDATE_MESSAGE` | Optional override for the update modal body. | Auto-generated |

## JWT Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `JWT_ACCESS_EXPIRY` | Access token TTL | `15m` |
| `JWT_REFRESH_EXPIRY` | Refresh token TTL | `30d` |
| `JWT_ISSUER` | Token issuer claim | `meetwithoutfear` |

## AWS Bedrock Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | Bedrock region | `us-west-2` |
| `BEDROCK_MODEL_LARGE` | Large model ID | `anthropic.claude-3-5-sonnet-20241022-v2:0` |
| `BEDROCK_MODEL_SMALL` | Small model ID | `anthropic.claude-3-5-haiku-20241022-v1:0` |
| `BEDROCK_MAX_TOKENS` | Default max tokens | `1000` |
| `BEDROCK_TEMPERATURE` | Default temperature | `0.7` |

## Ably Configuration

| Variable | Description |
|----------|-------------|
| `ABLY_API_KEY` | Full API key with publish/subscribe capability |

Get your API key from [Ably Dashboard](https://ably.com/dashboard).

## Database Configuration

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Pooled connection string (for app) |
| `TRUST_PROXY` | Exact proxy address (`172.29.0.2`); other clients cannot supply trusted forwarding headers |

### Connection String Format

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

## Development vs Production

### Development (.env.local)

```bash
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/meetwithoutfear_dev

JWT_SECRET=dev-secret-not-for-production
JWT_REFRESH_SECRET=dev-refresh-secret

# Use local Redis or skip
REDIS_URL=redis://localhost:6379

# Ably sandbox key
ABLY_API_KEY=your-sandbox-key

# AWS credentials (use IAM role in prod)
AWS_ACCESS_KEY_ID=your-dev-key
AWS_SECRET_ACCESS_KEY=your-dev-secret
AWS_REGION=us-west-2

LOG_LEVEL=debug
```

### Production (AWS Lightsail)

Store the preserved production integrations in root-only `/etc/mwf/application.env`.
Compose fixes `NODE_ENV=production`, `PORT=3000`, and disables `E2E_AUTH_BYPASS`
and `MOCK_LLM`. `DATABASE_URL` uses `mwf_app@db:5432/mwf` with a bounded
connection pool. Keep administration credentials in `/etc/mwf/database.env`.
No integration secret belongs in Terraform state, GitHub variables or an image.

See [the AWS runbook](../../infra/aws/README.md) for secret delivery, backups,
rotation, deployment and operator SSH tunnels. The actual Prisma schema uses
`DATABASE_URL` for both application access and migration execution.

## Secrets Management

### Never commit secrets

```bash
# .gitignore
.env
.env.local
.env.*.local
```

### Rotate secrets regularly

1. Generate new secret
2. Update the protected host configuration and its private configuration backup
3. Deploy new version
4. Invalidate old tokens (if applicable)

### AWS IAM Policy

Minimum required permissions for Bedrock:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-sonnet-*",
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-haiku-*"
      ]
    }
  ]
}
```

## Validation

Validate environment on startup:

```typescript
// src/config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.string().transform(Number).default('3000'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ABLY_API_KEY: z.string(),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  AWS_REGION: z.string().default('us-west-2'),
});

export const env = envSchema.parse(process.env);
```

## Related Documentation

- [AWS runbook](../../infra/aws/README.md)
- [Security](../backend/security/index.md)

---

[Back to Deployment](./index.md)
