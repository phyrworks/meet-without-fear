# AWS API Error Diagnostics

This filename is retained for existing workspace links. Production now runs on AWS Lightsail; Render logs no longer describe the live API.

## From the bot

1. Fetch `https://api.meetwithoutfear.com/health` with a 15-second timeout.
2. Load `shared/diagnostics/check-sentry.md` for captured backend errors in the requested time window.
3. Use `shared/diagnostics/check-db.md` and `check-pipeline-health.md` for persisted conversation health through the read-only tunnel.

The bot has no host shell or Docker access. Report host logs as unavailable; do not use the restricted database tunnel account for commands or expand its privileges. A successful health response alone does not verify authentication or AI completion.

## Operator host logs

From the configured operator machine:

```bash
ssh mwf-api 'sudo docker logs --since 30m --tail 1000 mwf-api-1 2>&1'
```

Look for startup failures, database connectivity errors, HTTP 5xx responses, and Bedrock throttling. Keep output bounded and redact credentials and private conversation content. See `infra/aws/README.md` for full operations guidance.
