# Load Credentials

Load environment variables with a fallback chain. This is a reusable pattern referenced by other commands.

**Do not invoke this command directly** — it documents the standard credential-loading pattern that other commands should follow.

## Fallback chain

For each credential, check in this order:

1. **Environment variable** — already set in the shell
2. **Backend env file** — `backend/.env` (local dev)

## Pattern

```bash
VAR_NAME="${VAR_NAME:-$(grep '^VAR_NAME=' backend/.env 2>/dev/null | cut -d= -f2-)}"
```

## Credential catalog

| Variable | Used by | Description |
|----------|---------|-------------|
| `SENTRY_AUTH_TOKEN` | check-sentry | Sentry API bearer token |
| `MIXPANEL_USERNAME` | check-mixpanel | Mixpanel API username (not yet configured) |
| `MIXPANEL_SECRET` | check-mixpanel | Mixpanel API secret (not yet configured) |

## Error handling

If a required credential is not found after the full fallback chain, tell the user:
> "[VAR_NAME] not found. Set it in your environment or backend/.env"

Do **not** print the credential value. Only confirm presence/absence.

## Security

- **NEVER** print full connection strings or tokens in output
- Credentials loaded via this pattern are for read-only operations by default
