#!/usr/bin/env bash
set -euo pipefail
# Local replica only (infra/local/compose.yaml mounts it AFTER infra/aws/init-db.sh, as
# 20-mwf-owner.sh; runs once, on a fresh volume). work-k5fk.10.3: the target shape's ownership —
# design note §6 layer 1, the state production reaches at §7 row 9c — so the replica runs the
# role-guarded API: mwf_migrator owns the database and schema public (and so every object the
# migration creates, deployed as it), and no runtime login is a member of any role.
# infra/aws/init-db.sh stays as production has it until the row 9c cutover.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER DATABASE mwf OWNER TO mwf_migrator;
ALTER SCHEMA public OWNER TO mwf_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- init-db.sh's interim GRANT mwf_job TO mwf_app (production until row 9c): no runtime login is a
-- member of any role (lib/prisma-role-guard.ts refuses one).
REVOKE mwf_job FROM mwf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mwf_migrator IN SCHEMA public GRANT SELECT ON TABLES TO slam_bot_readonly;
SQL
