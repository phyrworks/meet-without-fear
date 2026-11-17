#!/usr/bin/env bash
# Entrypoint of the database image (Dockerfile.db; work-k5fk.10.6). Runs as root, before the
# official docker-entrypoint.sh: copies the TLS pair mounted read-only at /etc/mwf-db-tls
# (db-tls.sh) and pg_hba.conf mounted at /etc/mwf-db to a directory of the postgres user —
# PostgreSQL refuses a private key anyone else can read, and must be able to read both whatever
# owner and mode the host's bind mount shows — then hands over unchanged. compose.yaml points
# ssl_cert_file / ssl_key_file / hba_file at the copies. Either missing: refuse to start (pg_hba.conf
# accepts TCP clients over hostssl only).
set -euo pipefail
src=/etc/mwf-db-tls
dst=/var/run/postgresql/tls
if [ "$(id -u)" = 0 ]; then
  [ -r "$src/server.crt" ] && [ -r "$src/server.key" ] \
    || { echo "mwf-db-entrypoint: no TLS pair at $src (run infra/aws/db-tls.sh and mount it)" >&2; exit 1; }
  [ -r /etc/mwf-db/pg_hba.conf ] || { echo "mwf-db-entrypoint: no /etc/mwf-db/pg_hba.conf mounted" >&2; exit 1; }
  install -d -o postgres -g postgres -m 0700 "$dst"
  install -o postgres -g postgres -m 0644 "$src/server.crt" "$dst/server.crt"
  install -o postgres -g postgres -m 0600 "$src/server.key" "$dst/server.key"
  install -o postgres -g postgres -m 0600 /etc/mwf-db/pg_hba.conf "$dst/pg_hba.conf"
fi
exec docker-entrypoint.sh "$@"
