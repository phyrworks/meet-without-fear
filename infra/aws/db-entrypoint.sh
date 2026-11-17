#!/usr/bin/env bash
# Entrypoint of the database image (Dockerfile.db; work-k5fk.10.6). Runs as root, before the
# official docker-entrypoint.sh: copies the TLS pair mounted read-only at /etc/mwf-db-tls
# (db-tls.sh) to a directory only the postgres user can read — PostgreSQL refuses a private key
# anyone else can read, whatever owner the host's bind mount shows — then hands over unchanged.
# compose.yaml points ssl_cert_file / ssl_key_file at the copies. No TLS pair mounted: refuse to
# start, since pg_hba.conf accepts TCP clients over hostssl only.
set -euo pipefail
src=/etc/mwf-db-tls
dst=/var/run/postgresql/tls
if [ "$(id -u)" = 0 ]; then
  [ -r "$src/server.crt" ] && [ -r "$src/server.key" ] \
    || { echo "mwf-db-entrypoint: no TLS pair at $src (run infra/aws/db-tls.sh and mount it)" >&2; exit 1; }
  install -d -o postgres -g postgres -m 0700 "$dst"
  install -o postgres -g postgres -m 0644 "$src/server.crt" "$dst/server.crt"
  install -o postgres -g postgres -m 0600 "$src/server.key" "$dst/server.key"
fi
exec docker-entrypoint.sh "$@"
