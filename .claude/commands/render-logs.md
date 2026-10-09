# AWS API Logs — Meet Without Fear

The `/render-logs` command name is retained for compatibility. Production now runs on AWS Lightsail; Render logs no longer describe the live API.

## Fetch logs

On the configured operator machine, use the existing SSH alias:

```bash
ssh mwf-api 'sudo docker logs --since 30m --tail 1000 mwf-api-1 2>&1'
```

`$ARGUMENTS` may narrow the time window, line count, or text filter. Treat arguments as data; do not interpolate arbitrary text into shell commands. Keep output bounded and redact credentials and private conversation content before reporting.

If operator SSH is unavailable, use `/check-sentry` for captured errors and the public health endpoint:

```bash
curl --fail --silent --show-error --max-time 15 https://api.meetwithoutfear.com/health
```

The bot's database tunnel account does not permit shell commands or Docker access. Do not use it to fetch host logs or expand its privileges. State that host logs are unavailable when reporting from the bot.

## Report

Summarize the time range, startup failures, database connectivity errors, HTTP 5xx responses, and Bedrock throttling. Group repeated errors and omit sensitive payloads. A successful health response alone does not verify authenticated requests or AI responses.

See `infra/aws/README.md` for service, backup, and deployment diagnostics.
