#!/usr/bin/env bash
# Bring the local production replica up (docs/deployment/local-replica.md).
# Idempotent: a second run with an unchanged tree changes nothing.
#
#   infra/local/up.sh
#
# Env: MWF_LOCAL_PORT (18180), MWF_LOCAL_DB_PORT (15433), MWF_LOCAL_ABLY_API_KEY
#      (optional; unset = the backend's mock Ably tokens), MWF_LOCAL_REBUILD=1
#      (rebuild the image and web export even when their inputs are unchanged),
#      MWF_LOCAL_APP_IMAGE (run this existing image instead of building one).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$REPO"
mkdir -p "$LOCAL"
chmod 700 "$LOCAL"

step "0. preflight"
command -v podman >/dev/null || die "podman is required"
podman info >/dev/null 2>&1 || die "podman machine is not running (podman machine start)"
need_node20
echo "   podman $(podman --version | awk '{print $3}'), node $(node -v), origin $ORIGIN"

# --- 1. secrets: generated once, development only, never committed ------------------
step "1. env files ($LOCAL, git-ignored)"
umask 077
if [ ! -f "$LOCAL/secrets.env" ]; then
  {
    for v in POSTGRES_PASSWORD APP_DB_PASSWORD READONLY_DB_PASSWORD MIGRATOR_DB_PASSWORD \
             JOB_DB_PASSWORD OPS_DB_PASSWORD AUTH_DB_PASSWORD; do
      printf '%s=%s\n' "$v" "$(openssl rand -hex 18)"
    done
  } >"$LOCAL/secrets.env"
  echo "   generated $LOCAL/secrets.env"
fi
# A development field-encryption key, so the replica encrypts the target
# columns as production will (keyless is a pass-through). Added once; a
# volume built under one key cannot be read with another (reset.sh keeps it).
if ! grep -q '^FIELD_ENCRYPTION_KEY=' "$LOCAL/secrets.env"; then
  printf 'FIELD_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >>"$LOCAL/secrets.env"
  echo "   added FIELD_ENCRYPTION_KEY to $LOCAL/secrets.env"
fi
# shellcheck source=/dev/null
source "$LOCAL/secrets.env"
write_if_changed() {  # $1 = path; content on stdin
  local tmp; tmp="$(mktemp "$LOCAL/.tmp.XXXXXX")"; cat >"$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then rm -f "$tmp"; echo "   unchanged $(basename "$1")"
  else mv "$tmp" "$1"; echo "   wrote $(basename "$1")"; fi
}
# Same keys as production's /etc/mwf/database.env (infra/aws/README.md).
write_if_changed "$LOCAL/database.env" <<EOF
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=mwf
APP_DB_PASSWORD=$APP_DB_PASSWORD
READONLY_DB_PASSWORD=$READONLY_DB_PASSWORD
MIGRATOR_DB_PASSWORD=$MIGRATOR_DB_PASSWORD
JOB_DB_PASSWORD=$JOB_DB_PASSWORD
OPS_DB_PASSWORD=$OPS_DB_PASSWORD
AUTH_DB_PASSWORD=$AUTH_DB_PASSWORD
EOF
# Production's application.env shape: DATABASE_URL is mwf_app, the database
# owner, which also runs migrations (deploy.sh) until work-a39h.11.19 moves
# them to mwf_migrator. Per-role URLs and identity binding as on target-shape.
# GOLDEN_SHAPE=target: the E2E seeder's shape detection reads
# prisma/schema.prisma relative to src/, which does not exist under dist/ in
# the image (filed as a beads issue); the override is the documented one.
{
  cat <<EOF
DATABASE_URL=postgresql://mwf_app:$APP_DB_PASSWORD@db:5432/mwf?connection_limit=12
APP_DATABASE_URL=postgresql://mwf_app:$APP_DB_PASSWORD@db:5432/mwf?connection_limit=12
JOB_DATABASE_URL=postgresql://mwf_job:$JOB_DB_PASSWORD@db:5432/mwf?connection_limit=5
OPS_DATABASE_URL=postgresql://mwf_ops:$OPS_DB_PASSWORD@db:5432/mwf?connection_limit=2
AUTH_DATABASE_URL=postgresql://mwf_auth:$AUTH_DB_PASSWORD@db:5432/mwf?connection_limit=2
DB_IDENTITY_BINDING=on
FIELD_ENCRYPTION_KEY=$FIELD_ENCRYPTION_KEY
E2E_FIXTURE_ID=user-a-full-journey
GOLDEN_SHAPE=target
E2E_APP_BASE_URL=$ORIGIN
TZ=UTC
EOF
  [ -z "${MWF_LOCAL_ABLY_API_KEY:-}" ] || echo "ABLY_API_KEY=$MWF_LOCAL_ABLY_API_KEY"
} | write_if_changed "$LOCAL/application.env"
umask 022

# --- 2. the production image, built from the working tree --------------------------
# The context is exactly what infra/aws/Dockerfile copies (root manifests,
# backend/, shared/, infra/aws/), taken from git's view of the working tree
# (tracked + untracked-but-not-ignored), so no .env or node_modules can enter.
step "2. API image (infra/aws/Dockerfile)"
context_files() {
  git -C "$REPO" ls-files -co --exclude-standard -z -- package.json package-lock.json backend shared infra/aws \
    | while IFS= read -r -d '' f; do [ -f "$REPO/$f" ] && printf '%s\0' "$f"; done
}
SRC_HASH="$(context_files | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-12)"
APP_IMAGE="localhost/mwf-local-api:$SRC_HASH"
if [ -n "${MWF_LOCAL_APP_IMAGE:-}" ]; then
  # An already-built image (e.g. a release image loaded with podman load), the
  # way deploy.sh takes one; nothing is built from the tree.
  podman image exists "$MWF_LOCAL_APP_IMAGE" || die "image $MWF_LOCAL_APP_IMAGE does not exist"
  APP_IMAGE="$MWF_LOCAL_APP_IMAGE"
  echo "   using $APP_IMAGE (MWF_LOCAL_APP_IMAGE; the working tree is NOT built)"
elif [ "${MWF_LOCAL_REBUILD:-0}" != 1 ] && podman image exists "$APP_IMAGE"; then
  echo "   $APP_IMAGE exists (inputs unchanged)"
else
  rm -rf "$LOCAL/build-context"; mkdir -p "$LOCAL/build-context"
  context_files | (cd "$REPO" && tar --null -T - -cf -) | tar -xf - -C "$LOCAL/build-context"
  echo "   context: $(find "$LOCAL/build-context" -type f | wc -l | tr -d ' ') files; building $APP_IMAGE"
  podman build --ignorefile "$LOCAL/build-context/infra/aws/Dockerfile.dockerignore" \
    -f "$LOCAL/build-context/infra/aws/Dockerfile" \
    --label "org.meetwithoutfear.source-hash=$SRC_HASH" \
    --label "org.meetwithoutfear.source-commit=$(git -C "$REPO" rev-parse HEAD)" \
    -t "$APP_IMAGE" "$LOCAL/build-context" >"$LOCAL/build.log" 2>&1 \
    || { tail -40 "$LOCAL/build.log"; die "image build failed (full log: $LOCAL/build.log)"; }
  echo "   built $APP_IMAGE"
fi

# Production pins (images.env.example) for db and caddy; the app image above.
grep -E '^(DB_IMAGE|CADDY_IMAGE)=' "$REPO/infra/aws/images.env.example" >"$LOCAL/release.env.next"
{ echo "APP_IMAGE=$APP_IMAGE"; echo "MWF_LOCAL_PORT=$MWF_LOCAL_PORT"; echo "MWF_LOCAL_DB_PORT=$MWF_LOCAL_DB_PORT"; } >>"$LOCAL/release.env.next"
write_if_changed "$LOCAL/release.env" <"$LOCAL/release.env.next"; rm -f "$LOCAL/release.env.next"

# --- 3. the Expo web export, in E2E mode, against this origin ----------------------
step "3. mobile web export (EXPO_PUBLIC_E2E_MODE=true, EXPO_PUBLIC_API_URL=$ORIGIN)"
WEB_HASH="$( (echo "$ORIGIN"; git -C "$REPO" ls-files -co --exclude-standard -z -- mobile shared package-lock.json \
  | while IFS= read -r -d '' f; do [ -f "$REPO/$f" ] && printf '%s\0' "$f"; done | sort -z | xargs -0 shasum -a 256) \
  | shasum -a 256 | cut -c1-12)"
mkdir -p "$LOCAL/web"
if [ "${MWF_LOCAL_REBUILD:-0}" != 1 ] && [ "$(cat "$LOCAL/web.stamp" 2>/dev/null)" = "$WEB_HASH" ] && [ -f "$LOCAL/web/index.html" ]; then
  echo "   export $WEB_HASH is current"
else
  rm -rf "$LOCAL/web.next"
  ( cd "$REPO/mobile" && EXPO_PUBLIC_E2E_MODE=true EXPO_PUBLIC_API_URL="$ORIGIN" CI=1 \
      npx expo export --platform web --clear --output-dir "$LOCAL/web.next" ) >"$LOCAL/web-export.log" 2>&1 \
    || { tail -40 "$LOCAL/web-export.log"; die "expo export failed (full log: $LOCAL/web-export.log)"; }
  grep -rqF "$ORIGIN" "$LOCAL/web.next" || die "the export does not contain $ORIGIN"
  # rsync into the bind-mounted directory: Caddy's mount keeps its inode.
  rsync -a --delete "$LOCAL/web.next/" "$LOCAL/web/"
  rm -rf "$LOCAL/web.next"
  echo "$WEB_HASH" >"$LOCAL/web.stamp"
  echo "   exported $WEB_HASH ($(find "$LOCAL/web" -type f | wc -l | tr -d ' ') files)"
fi

# --- 4. database ---------------------------------------------------------------------
step "4. db (Postgres 18 + pgvector; init-db.sh on a fresh volume)"
compose up -d db
wait_healthy db 40 || die "db did not become healthy"
echo "   db healthy; roles: $(psql_db -Atc "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'mwf\_%' OR rolname = 'slam_bot_readonly'")"

# --- 5. migrations, the way deploy.sh runs them -------------------------------------
step "5. migrations (deploy.sh: stop api, one-off api container runs prisma migrate deploy)"
api_id="$(service_id api)"
running_image=""
[ -z "$api_id" ] || running_image="$(podman inspect --format '{{.ImageName}}' "$api_id")"
api_state="$(health_of api)"
expected="$(podman run --rm --network none --entrypoint ls "$APP_IMAGE" /app/backend/prisma/migrations | grep -v '\.toml$' | sort | tr '\n' ' ')"
applied=""
if [ "$(psql_db -Atc "SELECT to_regclass('public._prisma_migrations') IS NOT NULL")" = t ]; then
  applied="$(psql_db -Atc "SELECT coalesce(string_agg(migration_name, ' ' ORDER BY migration_name), '') FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")"
fi
if [ "$running_image" = "$APP_IMAGE" ] && [ "$api_state" = healthy ] && [ "$applied " = "$expected" ]; then
  echo "   api already runs $APP_IMAGE and every migration is applied: nothing to do"
else
  [ -z "$api_id" ] || compose stop api
  if ! compose run --rm --no-deps -T api node /app/node_modules/prisma/build/index.js migrate deploy \
      --schema=/app/backend/prisma/schema.prisma >"$LOCAL/migrate.log" 2>&1; then
    sed 's/^/   /' "$LOCAL/migrate.log"; die "migrate deploy failed (api left stopped, as deploy.sh does)"
  fi
  grep -vE '^\s*$' "$LOCAL/migrate.log" | sed 's/^/   /'
  # Not --force-recreate: compose recreates only when the image or env changed.
  compose up -d --no-deps api
fi
wait_healthy api 40 || { compose logs --tail 60 api; die "API readiness failed (healthcheck.cjs)"; }
echo "   api healthy ($APP_IMAGE)"

# --- 6. caddy --------------------------------------------------------------------------
step "6. caddy (one origin: web export + /api /health /realtime)"
CADDY_HASH="$(shasum -a 256 "$HERE/Caddyfile" | cut -c1-12)"
if [ -n "$(service_id caddy)" ] && [ "$(cat "$LOCAL/caddy.stamp" 2>/dev/null)" != "$CADDY_HASH" ]; then
  compose up -d --no-deps --force-recreate caddy
else
  compose up -d --no-deps caddy
fi
echo "$CADDY_HASH" >"$LOCAL/caddy.stamp"
curl --fail --silent --show-error --retry 15 --retry-all-errors --retry-delay 1 --max-time 5 --retry-max-time 30 \
  "$ORIGIN/health" >/dev/null || die "$ORIGIN/health failed"
curl --fail --silent --max-time 5 "$ORIGIN/" | grep -q '<div id="root"' || die "$ORIGIN/ does not serve the web export"

step "up: $ORIGIN (web + API), db on 127.0.0.1:$MWF_LOCAL_DB_PORT"
compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
