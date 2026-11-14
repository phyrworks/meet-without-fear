#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <Adam|Eve|James|Catherine>" >&2
  exit 2
fi

CHARACTER="$1"
API="${MWF_API_URL:-http://localhost:3000}"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

json_get() {
  node -e "
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const j = JSON.parse(s);
  const path = process.argv[1].split('.');
  let v = j;
  for (const p of path) v = v == null ? undefined : v[p];
  if (v == null) process.exit(3);
  console.log(v);
});
" "$1"
}

json_first() {
  node -e "
let s = '';
process.stdin.on('data', d => s += d);
process.stdin.on('end', () => {
  const j = JSON.parse(s);
  for (const pathText of process.argv.slice(1)) {
    const path = pathText.split('.');
    let v = j;
    for (const p of path) v = v == null ? undefined : v[p];
    if (v != null && v !== '') {
      console.log(v);
      return;
    }
  }
  process.exit(3);
});
" "$@"
}

case "$(lower "$CHARACTER")" in
  adam)
    ASSIGNED_NAME="Adam"; ASSIGNED_EMAIL="adam@e2e.test"
    PARTNER_NAME="Eve"; PARTNER_EMAIL="eve@e2e.test"
    INVITER_NAME="$ASSIGNED_NAME"; INVITER_EMAIL="$ASSIGNED_EMAIL"
    INVITEE_NAME="$PARTNER_NAME"; INVITEE_EMAIL="$PARTNER_EMAIL"
    ;;
  eve)
    ASSIGNED_NAME="Eve"; ASSIGNED_EMAIL="eve@e2e.test"
    PARTNER_NAME="Adam"; PARTNER_EMAIL="adam@e2e.test"
    INVITER_NAME="$PARTNER_NAME"; INVITER_EMAIL="$PARTNER_EMAIL"
    INVITEE_NAME="$ASSIGNED_NAME"; INVITEE_EMAIL="$ASSIGNED_EMAIL"
    ;;
  james)
    ASSIGNED_NAME="James"; ASSIGNED_EMAIL="james@e2e.test"
    PARTNER_NAME="Catherine"; PARTNER_EMAIL="catherine@e2e.test"
    INVITER_NAME="$ASSIGNED_NAME"; INVITER_EMAIL="$ASSIGNED_EMAIL"
    INVITEE_NAME="$PARTNER_NAME"; INVITEE_EMAIL="$PARTNER_EMAIL"
    ;;
  catherine)
    ASSIGNED_NAME="Catherine"; ASSIGNED_EMAIL="catherine@e2e.test"
    PARTNER_NAME="James"; PARTNER_EMAIL="james@e2e.test"
    INVITER_NAME="$PARTNER_NAME"; INVITER_EMAIL="$PARTNER_EMAIL"
    INVITEE_NAME="$ASSIGNED_NAME"; INVITEE_EMAIL="$ASSIGNED_EMAIL"
    ;;
  *)
    echo "Unknown character '$CHARACTER'. Use Adam, Eve, James, or Catherine." >&2
    exit 2
    ;;
esac

if ! curl -fsS "$API/health" >/dev/null; then
  echo "Backend is not available at $API/health. Start backend with E2E_AUTH_BYPASS=true and NODE_ENV=development (or test)." >&2
  exit 10
fi

probe_code="$(curl -sS -o /tmp/mwf-e2e-probe.json -w '%{http_code}' \
  -X POST "$API/api/e2e/seed" \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@e2e.test","name":"Probe"}')"
if [[ "$probe_code" != "201" ]]; then
  echo "E2E seed probe returned HTTP $probe_code. Backend likely lacks E2E_AUTH_BYPASS=true with NODE_ENV=development (or test)." >&2
  cat /tmp/mwf-e2e-probe.json >&2 || true
  exit 11
fi

APP="${MWF_APP_URL:-}"
if [[ -z "$APP" ]]; then
  if curl -fsS http://localhost:8082 >/dev/null 2>&1; then
    APP="http://localhost:8082"
  else
    echo "No E2E MWF web app found on localhost:8082. Start mobile web with:" >&2
    echo "EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL=$API npx expo start --web --port 8082 --no-dev" >&2
    exit 12
  fi
fi

if [[ "$APP" != *":8082"* && -z "${MWF_ALLOW_NON_E2E_WEB:-}" ]]; then
  echo "Refusing to use $APP for gold sessions. Use localhost:8082 with EXPO_PUBLIC_E2E_MODE=true, or set MWF_ALLOW_NON_E2E_WEB=1 explicitly." >&2
  exit 13
fi

seed_user() {
  local email="$1"
  local name="$2"
  curl -sS -X POST "$API/api/e2e/seed" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"name\":\"$name\"}"
}

ASSIGNED_JSON="$(seed_user "$ASSIGNED_EMAIL" "$ASSIGNED_NAME")"
PARTNER_JSON="$(seed_user "$PARTNER_EMAIL" "$PARTNER_NAME")"
ASSIGNED_ID="$(printf '%s' "$ASSIGNED_JSON" | json_get id)"
PARTNER_ID="$(printf '%s' "$PARTNER_JSON" | json_get id)"

if [[ "$INVITER_EMAIL" == "$ASSIGNED_EMAIL" ]]; then
  INVITER_ID="$ASSIGNED_ID"
  INVITEE_ID="$PARTNER_ID"
else
  INVITER_ID="$PARTNER_ID"
  INVITEE_ID="$ASSIGNED_ID"
fi

SESSION_JSON="$(curl -sS -X POST "$API/api/sessions" \
  -H 'Content-Type: application/json' \
  -H "x-e2e-user-id: $INVITER_ID" \
  -H "x-e2e-user-email: $INVITER_EMAIL" \
  -d "{\"inviteName\":\"$INVITEE_NAME\"}")"

SESSION_ID="$(printf '%s' "$SESSION_JSON" | json_first data.session.id session.id id)"
INVITATION_ID="$(printf '%s' "$SESSION_JSON" | json_first data.invitationId invitationId data.invitation.id invitation.id)"

curl -sS -X POST "$API/api/invitations/$INVITATION_ID/accept" \
  -H 'Content-Type: application/json' \
  -H "x-e2e-user-id: $INVITEE_ID" \
  -H "x-e2e-user-email: $INVITEE_EMAIL" >/dev/null

ASSIGNED_URL="$APP/session/$SESSION_ID?e2e-user-id=$ASSIGNED_ID&e2e-user-email=$ASSIGNED_EMAIL"
PARTNER_URL="$APP/session/$SESSION_ID?e2e-user-id=$PARTNER_ID&e2e-user-email=$PARTNER_EMAIL"

cat <<EOF
NOTE=The session is created, but the invitee may remain pending until the inviter confirms/shares the topic in Stage 0. If the partner URL does not enter the session yet, drive the inviter through topic confirmation first.
ASSIGNED_CHARACTER=$ASSIGNED_NAME
ASSIGNED_ID=$ASSIGNED_ID
ASSIGNED_EMAIL=$ASSIGNED_EMAIL
PARTNER_CHARACTER=$PARTNER_NAME
PARTNER_ID=$PARTNER_ID
PARTNER_EMAIL=$PARTNER_EMAIL
SESSION_ID=$SESSION_ID
INVITATION_ID=$INVITATION_ID
APP_URL=$APP
ASSIGNED_URL=$ASSIGNED_URL
PARTNER_URL=$PARTNER_URL
EOF
