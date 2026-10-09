# Credential Loading Pattern

Standard fallback chain for loading credentials. Referenced by diagnostics and other utilities.

## Fallback Chain

For each credential, check in order:

1. **Environment variable** — already set in the shell
2. **Bot env file** — `/opt/slam-bot/.env` (EC2 bot instance)
3. **App env file** — `.env` (local dev)

## Pattern

```bash
VAR_NAME="${VAR_NAME:-$(grep VAR_NAME /opt/slam-bot/.env 2>/dev/null | cut -d= -f2-)}"
if [ -z "$VAR_NAME" ]; then
  VAR_NAME="$(grep VAR_NAME .env 2>/dev/null | cut -d= -f2-)"
fi
```

## Credential Catalog

| Variable | Used by | Description |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | check-sentry, health-check, investigate | Sentry API bearer token |
| `READONLY_DATABASE_URL` | check-db, health-check, investigate | AWS PostgreSQL read-only connection through the SSH tunnel |
| `MIXPANEL_USERNAME` | check-mixpanel, daily-strategy | Mixpanel API username |
| `MIXPANEL_SECRET` | check-mixpanel, daily-strategy | Mixpanel API secret |
| `SLACK_BOT_TOKEN` | slack-upload, send-voice-message | Slack bot OAuth token |

## Security Rules

- NEVER print full connection strings or tokens in output
- Only confirm presence/absence of credentials
- `READONLY_DATABASE_URL` uses `slam_bot_readonly` role (SELECT-only)

Production database diagnostics require `READONLY_DATABASE_URL`; never fall back to an administrative or development database. MWF diagnostics do not use Render credentials.
