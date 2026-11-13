#!/usr/bin/env bash
# Deploy a verified image already loaded by release-poll.sh or an operator.
set -euo pipefail
# shellcheck source=/dev/null
source /opt/mwf/common.sh
image=${1:?Usage: deploy.sh mwf-api:release-id manifest.json}
manifest=${2:?Manifest file required}
[[ "$image" =~ ^mwf-api:[a-zA-Z0-9_.-]+$ ]] || exit 2
exec 9>/var/lib/mwf/deploy.lock
flock -n 9 || { echo 'Deployment already running' >&2; exit 1; }
previous=$(jq -r ' .image // empty' /var/lib/mwf/current-release.json 2>/dev/null || true)
# Role-guard preflight (work-k5fk.10.3), with the NEW image and before anything changes: every
# runtime role URL in application.env must be a least-privilege login that owns nothing and is a
# member of no role, or the new API would refuse to start after the migration. On the current
# production database it FAILS until the design note §7 row 9c cutover (mwf_app owns the database
# and is a member of mwf_job): the old release keeps running. There is no switch to skip it.
# The image runs directly on the internal database network only (compose project "mwf" ->
# network mwf_database; the db service answers as "db" there), NOT `compose run api`: the api
# service pins 172.29.0.3 on the edge network, which the running API already holds.
preflight=dist/backend/src/scripts/role-guard-preflight.js
guard=dist/backend/src/lib/prisma-role-guard.js
in_image() { docker run --rm --network none --entrypoint test "$image" -f "/app/backend/$1"; }
if in_image "$preflight"; then
  if ! docker run --rm --network mwf_database --env-file /etc/mwf/application.env "$image" node "$preflight"; then
    echo 'Role-guard preflight REFUSED a runtime login: not migrating, previous release left running (see above).' >&2
    exit 1
  fi
elif in_image "$guard"; then
  # A guarded API without its preflight is a broken build, not a rollback: refuse it.
  echo "Image $image has the role guard but no $preflight: refusing to deploy it." >&2
  exit 1
else
  # A rollback to an image that PREDATES the guard (work-k5fk.10.3): it has neither the preflight
  # nor a startup check, so it cannot crash-loop on its role, and refusing it would block every
  # rollback past this release. Deploy it, loudly.
  echo "WARNING: $image predates the role guard (no $guard): no preflight run; it starts without a role check." >&2
fi
# Back up before touching migrations, and stop writes while migrating.
if compose exec -T db psql -U postgres -d mwf -tAc 'SELECT to_regclass('\''public."_prisma_migrations"'\'') IS NOT NULL' | grep -q t; then
  /opt/mwf/backup.sh preserved
fi
compose stop api
sed "s|^APP_IMAGE=.*|APP_IMAGE=$image|" /etc/mwf/release.env > /etc/mwf/release.env.next
mv /etc/mwf/release.env.next /etc/mwf/release.env
# Keep failed deployments stopped. Never automatically reverse migrations.
compose run --rm --no-deps api node /app/node_modules/prisma/build/index.js migrate deploy --schema=/app/backend/prisma/schema.prisma
compose up -d --no-deps api
for _attempt in $(seq 1 40); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q api)")
  [ "$status" != healthy ] || break
  sleep 3
done
[ "$status" = healthy ] || { echo 'API readiness failed; inspect logs and schema before rollback' >&2; exit 1; }
compose up -d --no-deps --force-recreate caddy
curl --fail --silent --show-error --retry 15 --retry-all-errors --retry-delay 1 --max-time 5 --retry-max-time 30 http://127.0.0.1:8080/health >/dev/null
printf '%s\n' "$previous" > /var/lib/mwf/previous-image
cp "$manifest" /var/lib/mwf/current-release.json
# Keep only this and the last verified app image. Never prune database volumes.
while IFS= read -r candidate; do
  [ "$candidate" = "$image" ] || [ "$candidate" = "$previous" ] || docker image rm "$candidate" || true
done < <(docker image ls --filter 'reference=mwf-api:*' --format '{{.Repository}}:{{.Tag}}')
printf 'Deployed %s\n' "$image"
