#!/usr/bin/env bash
# TLS for the database (hostssl in pg_hba.conf; design note §6, Q17; work-k5fk.10.6).
#
#   infra/aws/db-tls.sh [dir]        (default /etc/mwf/db-tls; run once, as root, on the host)
#
# Creates, only when missing (re-running changes nothing; delete the directory to rotate):
#   ca.crt / ca.key      a private CA, 10 years. ca.key never leaves the host and is needed again
#                        only to re-issue server.crt.
#   server.crt / .key    the server certificate, 825 days, for the names the clients use:
#                        DNS:db (compose service name), DNS:localhost, IP:127.0.0.1.
# The db service mounts the directory read-only (compose.yaml); the image's entrypoint
# (db-entrypoint.sh) copies server.crt / server.key to a directory of its postgres user, mode 0600,
# because PostgreSQL refuses a key that anyone but its owner can read. The API mounts only ca.crt
# and verifies the server with it (sslmode=verify-full&sslrootcert=… in every runtime URL; README
# "application.env").
set -euo pipefail
dir="${1:-/etc/mwf/db-tls}"
umask 077
mkdir -p "$dir"
cd "$dir"
if [ ! -f ca.crt ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout ca.key -out ca.crt \
    -subj '/CN=mwf database CA' -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
  echo "created $dir/ca.crt"
fi
if [ ! -f server.crt ]; then
  openssl req -newkey rsa:3072 -sha256 -nodes -keyout server.key -out server.csr -subj '/CN=db' 2>/dev/null
  printf '%s\n' 'basicConstraints=CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' 'subjectAltName=DNS:db,DNS:localhost,IP:127.0.0.1' >server.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 \
    -extfile server.ext -out server.crt 2>/dev/null
  rm -f server.csr server.ext ca.srl
  echo "created $dir/server.crt"
fi
chmod 0644 ca.crt server.crt
chmod 0600 ca.key server.key
openssl verify -CAfile ca.crt server.crt >/dev/null
echo "ok: $dir (server.crt valid until $(openssl x509 -enddate -noout -in server.crt | cut -d= -f2))"
