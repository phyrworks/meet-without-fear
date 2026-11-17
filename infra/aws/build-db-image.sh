#!/usr/bin/env bash
# Build the database image (Dockerfile.db: pinned pgvector base + pgaudit + the TLS entrypoint;
# work-k5fk.10.6) and point DB_IMAGE at it.
#
#   infra/aws/build-db-image.sh [release.env]     (default /etc/mwf/release.env; as root on the host)
#
# Reads DB_BASE_IMAGE (the digest-pinned base, images.env.example) from release.env, builds
# mwf-db:<hash of the base, Dockerfile.db and db-entrypoint.sh> when that tag is missing, and
# writes DB_IMAGE=<that tag> back into release.env. Re-running with nothing changed builds nothing
# and rewrites nothing. The running database moves to the new image only on
# `docker compose up -d db` (a restart: plan it like any database restart).
# Env: MWF_CONTAINER_ENGINE (docker; the local replica passes podman).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${1:-/etc/mwf/release.env}"
engine="${MWF_CONTAINER_ENGINE:-docker}"
base="$(sed -n 's/^DB_BASE_IMAGE=//p' "$env_file" | tail -1)"
[[ "$base" == *@sha256:* ]] || { echo "build-db-image: DB_BASE_IMAGE in $env_file must be digest-pinned (images.env.example)" >&2; exit 1; }
sum() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
hash="$( (printf '%s\n' "$base"; cat "$here/Dockerfile.db" "$here/db-entrypoint.sh") | sum | cut -c1-12)"
tag="mwf-db:$hash"
if "$engine" image inspect "$tag" >/dev/null 2>&1; then
  echo "build-db-image: $tag exists"
else
  ctx="$(mktemp -d)"
  trap 'rm -rf "$ctx"' EXIT
  cp "$here/Dockerfile.db" "$here/db-entrypoint.sh" "$ctx/"
  "$engine" build --build-arg "DB_BASE_IMAGE=$base" -f "$ctx/Dockerfile.db" -t "$tag" "$ctx"
  echo "build-db-image: built $tag"
fi
# The engine may report the tag with a registry prefix (podman: localhost/); compose resolves both.
if ! grep -qx "DB_IMAGE=$tag" "$env_file"; then
  tmp="$(mktemp "$env_file.XXXXXX")"
  { grep -v '^DB_IMAGE=' "$env_file" || true; echo "DB_IMAGE=$tag"; } >"$tmp"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || chmod 0600 "$tmp"
  mv "$tmp" "$env_file"
  echo "build-db-image: DB_IMAGE=$tag in $env_file"
fi
