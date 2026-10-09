#!/usr/bin/env bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=readonly_password="$READONLY_DB_PASSWORD" <<'SQL'
CREATE ROLE mwf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE slam_bot_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'readonly_password';
ALTER DATABASE mwf OWNER TO mwf_app;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO mwf_app;
GRANT CONNECT ON DATABASE mwf TO slam_bot_readonly;
GRANT USAGE ON SCHEMA public TO slam_bot_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE mwf_app IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;
SQL
