#!/usr/bin/env bash
# run-and-publish.sh — run a Playwright e2e scenario and publish the result to
# the test-dashboard.
#
# Usage:
#   run-and-publish.sh <scenario> [--config <path>] [--trigger-source slack|cron|manual]
#                                  [--triggered-by <id>] [--starting-snapshot-id <id>]
#                                  [--final-stage <0..4>] [--notes <text>]
#
# Examples:
#   run-and-publish.sh two-browser-stage-2 --trigger-source cron
#   run-and-publish.sh single-user-journey --trigger-source slack --triggered-by U123 \
#       --notes "From Slack request"
#
# Env vars expected (typically set in the bot's systemd / .bashrc):
#   TEST_DASHBOARD_API_URL    e.g. https://mwf-test-dashboard.vercel.app
#   BOT_WRITER_TOKEN          shared secret for x-bot-token header
#   BLOB_READ_WRITE_TOKEN     Vercel Blob token (for screenshot uploads)
#
# Behaviour:
#   1. Decide which playwright config matches the scenario name.
#   2. Run the spec with our custom dashboard reporter.
#   3. Read the reporter's JSON summary.
#   4. Hand the artifacts off to write-test-result.ts which uploads screenshots
#      to Blob and PATCHes the run row.
#   5. Exit 0 on green Playwright run, non-zero on failure (after publishing).

set -uo pipefail

# Load bot env (TEST_DASHBOARD_API_URL, BOT_WRITER_TOKEN, BLOB_READ_WRITE_TOKEN
# typically live here on the EC2 box). Operator-set env vars win.
BOT_ENV_FILE="${BOT_ENV_FILE:-/opt/slam-bot/.env}"
if [ -f "$BOT_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$BOT_ENV_FILE"
  set +a
fi

# ── Args ─────────────────────────────────────────────────────────────────────
if [ "$#" -lt 1 ]; then
  cat >&2 <<EOF
Usage: $0 <scenario> [flags]

Required:
  <scenario>                 spec file basename without .spec.ts
                             (e.g. two-browser-stage-2, single-user-journey)

Optional:
  --config <path>            playwright config path; auto-detected by default
  --trigger-source <s>       slack | cron | manual | web (default: manual)
  --triggered-by <id>        slack user id, email, or "cron"
  --starting-snapshot-id <id> dashboard snapshot id to record
  --final-stage <0..4>       overrides reporter's stage parsing
  --notes <text>             free-form note saved on the run row
EOF
  exit 2
fi

SCENARIO="$1"
shift

CONFIG=""
TRIGGER_SOURCE="manual"
TRIGGERED_BY=""
STARTING_SNAPSHOT_ID=""
FINAL_STAGE=""
NOTES=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)               CONFIG="$2"; shift 2 ;;
    --trigger-source)       TRIGGER_SOURCE="$2"; shift 2 ;;
    --triggered-by)         TRIGGERED_BY="$2"; shift 2 ;;
    --starting-snapshot-id) STARTING_SNAPSHOT_ID="$2"; shift 2 ;;
    --final-stage)          FINAL_STAGE="$2"; shift 2 ;;
    --notes)                NOTES="$2"; shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2
      ;;
  esac
done

# ── Env ──────────────────────────────────────────────────────────────────────
: "${TEST_DASHBOARD_API_URL:?TEST_DASHBOARD_API_URL must be set}"
: "${BOT_WRITER_TOKEN:?BOT_WRITER_TOKEN must be set}"
: "${BLOB_READ_WRITE_TOKEN:=}"   # screenshots only; non-fatal if missing

# Resolve symlinks before walking up — on EC2 this script is invoked via
# /opt/slam-bot/scripts/run-and-publish.sh which symlinks to the repo.
SCRIPT_REAL="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_REAL")/../../.." && pwd)"
E2E_DIR="$REPO_ROOT/e2e"
RESULTS_DIR="$E2E_DIR/test-results"
SUMMARY_FILE="$RESULTS_DIR/dashboard-summary.json"

if [ ! -d "$E2E_DIR" ]; then
  echo "[run-and-publish] cannot find e2e dir at $E2E_DIR" >&2
  exit 1
fi

# Auto-pick the config based on scenario prefix if the caller didn't.
if [ -z "$CONFIG" ]; then
  case "$SCENARIO" in
    two-browser-*)
      CONFIG="$E2E_DIR/playwright.two-browser.config.ts"
      ;;
    live-ai-*)
      CONFIG="$E2E_DIR/playwright.live-ai.config.ts"
      ;;
    *)
      CONFIG="$E2E_DIR/playwright.config.ts"
      ;;
  esac
fi

if [ ! -f "$CONFIG" ]; then
  echo "[run-and-publish] config not found at $CONFIG" >&2
  exit 1
fi

# ── Capture timing the operator can rely on ──────────────────────────────────
STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
CODE_SHA=$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")

echo "[run-and-publish] scenario=$SCENARIO config=$(basename "$CONFIG") trigger=$TRIGGER_SOURCE"

# ── Run Playwright with the dashboard reporter ───────────────────────────────
# We append our reporter to whatever the config already specifies. Playwright
# accepts repeated --reporter flags but the existing reporters in config are
# preserved — there's no override unless we pass `--reporter=...` (singular).
# Using PLAYWRIGHT_REPORTER env var instead would replace; we use a thin
# wrapper config approach: set DASHBOARD_SCENARIO, run the spec, the reporter
# already configured in playwright.config will pick it up.
export DASHBOARD_SCENARIO="$SCENARIO"

# The grep filter matches the spec file basename. -g would do the same.
PLAYWRIGHT_EXIT=0
(
  cd "$E2E_DIR"
  npx playwright test \
    --config="$CONFIG" \
    --reporter="$E2E_DIR/reporters/test-dashboard-reporter.ts" \
    --grep="$SCENARIO" \
    || true
)
PLAYWRIGHT_EXIT=$?

FINISHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ── Read the summary the reporter dropped ────────────────────────────────────
if [ ! -f "$SUMMARY_FILE" ]; then
  echo "[run-and-publish] no dashboard-summary.json — reporter didn't run? exit=$PLAYWRIGHT_EXIT" >&2
  # Still publish a minimal error row so the dashboard reflects the failure.
  cat > "$SUMMARY_FILE" <<JSON
{
  "scenario": "$SCENARIO",
  "status": "error",
  "started_at": "$STARTED_AT",
  "finished_at": "$FINISHED_AT",
  "duration_ms": 0,
  "final_stage": null,
  "error_message": "playwright reporter did not run; exit=$PLAYWRIGHT_EXIT",
  "failed_assertion": null,
  "failed_test_file": null,
  "failed_test_line": null,
  "console_logs": "",
  "page_errors": "",
  "spec_stdout": "",
  "screenshot_dir": "$RESULTS_DIR/dashboard-screenshots",
  "test_count": 0,
  "pass_count": 0,
  "fail_count": 0
}
JSON
fi

STATUS=$(jq -r '.status' "$SUMMARY_FILE")
SCREENSHOT_DIR=$(jq -r '.screenshot_dir' "$SUMMARY_FILE")
ERROR_MESSAGE=$(jq -r '.error_message // empty' "$SUMMARY_FILE")
FAILED_ASSERTION=$(jq -r '.failed_assertion // empty' "$SUMMARY_FILE")
FAILED_FILE=$(jq -r '.failed_test_file // empty' "$SUMMARY_FILE")
FAILED_LINE=$(jq -r '.failed_test_line // empty' "$SUMMARY_FILE")
REPORTER_FINAL_STAGE=$(jq -r '.final_stage // empty' "$SUMMARY_FILE")

# CLI override wins over the reporter's parse.
if [ -z "$FINAL_STAGE" ]; then
  FINAL_STAGE="$REPORTER_FINAL_STAGE"
fi

# Use the reporter's recorded times for accuracy (it records when each test
# actually ran, not when the wrapper booted).
REAL_STARTED_AT=$(jq -r '.started_at' "$SUMMARY_FILE")
REAL_FINISHED_AT=$(jq -r '.finished_at' "$SUMMARY_FILE")
REAL_DURATION_MS=$(jq -r '.duration_ms' "$SUMMARY_FILE")

# ── Build the writer invocation ──────────────────────────────────────────────
CMD=(
  npx tsx "$REPO_ROOT/scripts/ec2-bot/scripts/write-test-result.ts"
  --scenario "$SCENARIO"
  --status "$STATUS"
  --started-at "$REAL_STARTED_AT"
  --finished-at "$REAL_FINISHED_AT"
  --duration-ms "$REAL_DURATION_MS"
  --code-sha "$CODE_SHA"
  --trigger-source "$TRIGGER_SOURCE"
)

[ -n "$TRIGGERED_BY" ]            && CMD+=(--triggered-by "$TRIGGERED_BY")
[ -n "$STARTING_SNAPSHOT_ID" ]    && CMD+=(--starting-snapshot-id "$STARTING_SNAPSHOT_ID")
[ -n "$FINAL_STAGE" ]             && CMD+=(--final-stage "$FINAL_STAGE")
[ -n "$ERROR_MESSAGE" ]           && CMD+=(--error-message "$ERROR_MESSAGE")
[ -n "$FAILED_ASSERTION" ]        && CMD+=(--failed-assertion "$FAILED_ASSERTION")
[ -n "$FAILED_FILE" ]             && CMD+=(--failed-test-file "$FAILED_FILE")
[ -n "$FAILED_LINE" ]             && CMD+=(--failed-test-line "$FAILED_LINE")

# Only attach screenshots dir if it has content.
if [ -d "$SCREENSHOT_DIR" ] && [ -n "$(ls -A "$SCREENSHOT_DIR" 2>/dev/null)" ]; then
  CMD+=(--screenshots-dir "$SCREENSHOT_DIR")
fi

# ── Console artifact: spec stdout (test runner progress logs) ────────────────
CONSOLE_FILE="$RESULTS_DIR/dashboard-console.txt"
jq -r '.spec_stdout // ""' "$SUMMARY_FILE" > "$CONSOLE_FILE"
if [ -s "$CONSOLE_FILE" ]; then
  CMD+=(--console-file "$CONSOLE_FILE")
fi

# ── Transcript artifact: AI conversation messages from the backend DB ────────
# Query Messages created during the test window. The test DB is fresh per run
# (Playwright's globalSetup truncates), so any rows post-STARTED_AT are ours.
TRANSCRIPT_FILE="$RESULTS_DIR/dashboard-transcript.txt"
> "$TRANSCRIPT_FILE"

# Source e2e/.env.test for the test DATABASE_URL. NOTE: on the target-shape branch this is
# mwf_target_e2e, which must exist on the bot host (run-baseline.sh --dev creates it), and the
# query below still uses the pre-target-shape "Message"/"User" names, so the transcript is empty
# there until it is ported to message/user. On failure it only warns.
TEST_ENV_FILE="$E2E_DIR/.env.test"
TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://mwf_user:mwf_password@localhost:5432/meet_without_fear_test}"
if [ -f "$TEST_ENV_FILE" ]; then
  TEST_DATABASE_URL=$(grep '^DATABASE_URL=' "$TEST_ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || echo "$TEST_DATABASE_URL")
fi

if command -v psql >/dev/null 2>&1; then
  # Format: [Speaker] content
  # Speaker: user.name if senderId set, else role (USER/AI/SYSTEM/...).
  # Use \n between rows in the SELECT itself to avoid shell-side line joining.
  psql "$TEST_DATABASE_URL" -tA -F$'\x1f' -c "
    SELECT
      COALESCE(
        '[' || u.name || ']',
        '[' || m.role::text || ']'
      ),
      m.content
    FROM \"Message\" m
    LEFT JOIN \"User\" u ON u.id = m.\"senderId\"
    WHERE m.\"timestamp\" >= '$REAL_STARTED_AT'::timestamptz
    ORDER BY m.\"timestamp\" ASC;
  " 2>/dev/null | awk -F$'\x1f' 'NF==2 { print $1 " " $2 }' > "$TRANSCRIPT_FILE" || {
    echo "[run-and-publish] WARN: failed to query Messages from $TEST_DATABASE_URL — transcript will be empty"
  }
fi

if [ -s "$TRANSCRIPT_FILE" ]; then
  TRANSCRIPT_LINES=$(wc -l < "$TRANSCRIPT_FILE" | tr -d ' ')
  echo "[run-and-publish] transcript: $TRANSCRIPT_LINES message(s) from Message table"
  CMD+=(--transcript-file "$TRANSCRIPT_FILE")
else
  echo "[run-and-publish] transcript: no messages found in test DB (test may have failed before any messages were created)"
fi

echo "[run-and-publish] publishing run (status=$STATUS, scenario=$SCENARIO)"
"${CMD[@]}"
WRITER_EXIT=$?

# Notes go in via a separate PATCH only if the writer accepted them — for now,
# write-test-result.ts doesn't ship a --notes flag, so we leave notes for a
# follow-up. (Tracked in the PR description.)
[ -n "$NOTES" ] && echo "[run-and-publish] note: --notes provided but not yet wired ($NOTES)"

# Exit non-zero if either the test failed or the writer failed. Cron will see
# this and the operator can grep logs.
if [ "$STATUS" != "pass" ] || [ "$WRITER_EXIT" -ne 0 ]; then
  exit 1
fi
exit 0
