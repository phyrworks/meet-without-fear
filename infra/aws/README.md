# AWS API operations

One Ubuntu 24.04 Lightsail `small_3_0` server in `us-west-2` runs Caddy, Express and PostgreSQL 18 with pgvector. The API hostname remains `api.meetwithoutfear.com`. The attached static IPv4 and server cost $12/month; S3 storage/requests are additional. No managed database, load balancer, NAT gateway or paid snapshots are used.

## Provision

Use the operator's AWS profile (`AWS_PROFILE=jason`), never copy it to the server. Start with `terraform init` using local state, `terraform.tfvars.example`, and a public SSH key. Inspect `terraform plan -out=.local/provision.tfplan`, then apply the saved plan. The state and backup buckets enforce TLS, encryption, versioning and public-access blocks. Immediately migrate local state:

```sh
cd infra/aws
printf 'terraform { backend "s3" {} }\n' > backend.tf
# Fill backend.hcl from terraform output -raw state_bucket:
# bucket = "..."
# key = "production/terraform.tfstate"
# region = "us-west-2"
# encrypt = true
# use_lockfile = true
AWS_PROFILE=jason terraform init -migrate-state -backend-config=backend.hcl
AWS_PROFILE=jason terraform plan
```

The generated `backend.tf`, `backend.hcl`, state, plans, tfvars, credentials and dumps are ignored. Never commit them. Protect initial local state with `umask 077`. The provider lockfile is committed. Instance, static IP and buckets have `prevent_destroy`: replacing the server requires an intentional edit and a verified restore plan. Terraform does not back up the database volume.

Lightsail prepends a `/bin/sh` wrapper to user data; Terraform explicitly invokes Bash. Bootstrap changes are applied manually on existing hosts (`ignore_changes = [user_data]`) and must not trigger database-destroying instance replacement.

`bootstrap.sh` installs Docker, AWS CLI, unattended security updates, bounded logs and 2 GB swap. Automatic reboots are disabled. Copy this directory's runtime files into root-owned `/opt/mwf` (exclude `.local`, Terraform state/config and `.terraform`). Create root-only `/etc/mwf` files:

- `application.env`: exact production integration settings and the runtime role URLs, never the migrator's. Every URL is at `db:5432/mwf` and ends in `sslmode=verify-full&sslrootcert=/etc/mwf-db-tls/ca.crt` (work-k5fk.10.6: `pg_hba.conf` accepts TCP clients over `hostssl` only, and the API verifies the server against the CA `db-tls.sh` made; compose mounts it there). `DATABASE_URL` and `APP_DATABASE_URL` are `mwf_app` with `connection_limit=12`; `AUTH_DATABASE_URL` = `mwf_auth` with `connection_limit=12`, the app pool's size: every Clerk-signed request resolves its user on that pool (`app.resolve_user`), and the API's startup check opens it. Since work-k5fk.10.5 it also needs `AI_DATABASE_URL` (`mwf_ai`) and `WORKER_DATABASE_URL` (`mwf_worker`), which never fall back to `DATABASE_URL`, and `DB_IDENTITY_BINDING=on`: the API refuses to start without any of them. Preserve encryption keys and production Bedrock settings. No local development settings.
- `migrator.env` (work-k5fk.10.6): one line, `MIGRATOR_DATABASE_URL=postgresql://mwf_migrator:<MIGRATOR_DB_PASSWORD>@db:5432/mwf?sslmode=require&sslcert=/etc/mwf-db-tls/ca.crt&sslaccept=strict` (Prisma's schema engine: encrypted, chain and host name checked against the CA). Only `deploy.sh` reads it, for the migration container; `pg_hba.conf` admits `mwf_migrator` from that container's address only.
- `db-tls/`: the database's CA and server certificate, from `sudo /opt/mwf/db-tls.sh` (once; delete the directory to rotate). `ca.key` stays here; the API mounts only `ca.crt`.
- `database.env`: `POSTGRES_USER=postgres`, random `POSTGRES_PASSWORD`, `POSTGRES_DB=mwf`, random `APP_DB_PASSWORD`, random `READONLY_DB_PASSWORD`, and random `MIGRATOR_DB_PASSWORD`, `AI_DB_PASSWORD`, `WORKER_DB_PASSWORD`, `OPS_DB_PASSWORD`, `AUTH_DB_PASSWORD` for the Phase 3 logins (`init-db.sh` creates them with the NOLOGIN capability roles and `mwf_definer` (work-k5fk.10.4) on a fresh cluster; an existing cluster gets them from `roles.sql`, run by the operator over the SSH tunnel as `postgres` before the first release containing migration `phase3_app_schema_helpers`; that run also retires `mwf_job` / `job_access` (work-k5fk.10.5) and stops, naming the database, while either still owns an object or holds a privilege in another database).
- `release.env`: pinned `DB_BASE_IMAGE`, `CADDY_IMAGE` from `images.env.example`, immutable `APP_IMAGE`, and `DB_IMAGE`, which `sudo /opt/mwf/build-db-image.sh` writes: `mwf-db:<hash>`, the base plus pgaudit and the TLS entrypoint (`Dockerfile.db`, `db-entrypoint.sh`). Re-run it after changing `DB_BASE_IMAGE`; the database moves to a new image only on `compose up -d db` (a restart).
- `operations.env`: `BACKUP_BUCKET` and `AWS_DEFAULT_REGION=us-west-2`.
- `backup.credentials`: AWS credentials-file format for Terraform's backup user (PutObject on nightly/preserved only).
- `release.credentials`: credentials for the release reader (GetObject on releases, PutObject on release status only).

Create IAM access keys outside Terraform, stream them securely into these files, and never log them. Back up `/etc/mwf` and the operator SSH key separately into the private bucket's `configuration/` prefix using operator credentials. Runtime users cannot read that prefix. Configuration backup must be refreshed after any secret rotation.

## Deploy

GitHub `AWS Deploy` preserves the backend/shared/lockfile change policy and also watches `infra/aws`. Set repository variables `AWS_DEPLOY_ROLE_ARN` and `AWS_BACKUP_BUCKET`. OIDC trust is limited to the repository and allowed refs. No persistent AWS or administrator SSH key goes into GitHub. `AWS_INITIAL_RELEASE` was used during migration to pin builds to the actual Render commit. Normal deployment omits that variable and builds the selected main commit. OIDC trust and automatic triggers are limited to main.

CI builds linux/amd64 on its runner, runs a dependency/startup smoke check, uploads a uniquely named compressed image and a checksum-verified runtime bundle, then publishes the desired manifest. Runtime scripts and proxy/Compose configuration are installed atomically from a fixed file list; database credentials and pinned DB image settings remain operator-controlled. A root systemd timer on the host retrieves it through narrowly scoped read credentials, validates its checksum and image name, backs up, stops API writes, runs Prisma migrations, starts the image, verifies HTTP **and database readiness**, and reports success to S3. CI fails if the host reports failure or times out. A failed release is not retried endlessly; publish a new release ID to retry after repair. `/etc/mwf/deploy-paused` pauses application of releases.

The first release uses the live Render source plus one explicit build-time adapter in `prepare-source.py`: `TRUST_PROXY` is honored by Express, set to the fixed Caddy address only. Both the source SHA and infrastructure SHA are recorded in the image labels and manifest. Future releases use the same adapter until this setting moves into the app source.

```sh
sudo /opt/mwf/ops-health.sh
sudo journalctl -u mwf-release.service -n 100 --no-pager
sudo docker compose --env-file /etc/mwf/release.env -f /opt/mwf/compose.yaml logs --tail 100 api
```

Only ports 80/443 are public; SSH is restricted to operator CIDRs. PostgreSQL and the pre-DNS proxy listener bind host loopback. Use SSH forwarding for administration:

```sh
ssh -i /path/to/operator-key -L 15432:127.0.0.1:5432 -L 18080:127.0.0.1:8080 ubuntu@STATIC_IP
```

The bot uses `slam_bot_readonly` over its own restricted SSH tunnel (`bot-db-tunnel.service`). The server account `mwf-tunnel` has no shell and can forward only to loopback port 5432. Recreate the account, authorized key and SSH Match configuration from the protected configuration backup on recovery. Dashboard users connect through the existing API hostname. Update the operator CIDR with Terraform when the operator IP changes.

## Cutover to the target shape: ownership, TLS, per-role access, pgaudit (work-k5fk.10.6)

Design note §6 / §7 row 9c (owner decisions Q8, Q17). One maintenance window, the API stopped, with
the target-shape release in hand. Until it is done, `deploy.sh`'s role-guard preflight refuses any
target-shape image (the database is `mwf_app`'s) and the old release keeps running. Nothing here
runs automatically; rehearse it on the local replica first (`docs/deployment/local-replica.md`).

1. Install the new runtime files into `/opt/mwf` (the release bundle carries them; `release-poll.sh`
   installs them, or copy them by hand): `compose.yaml`, `pg_hba.conf`, `ownership.sql`, `db-tls.sh`,
   `Dockerfile.db`, `db-entrypoint.sh`, `build-db-image.sh`, `deploy.sh`.
2. `sudo touch /etc/mwf/deploy-paused`, then `sudo /opt/mwf/backup.sh preserved`.
3. `sudo /opt/mwf/db-tls.sh` and `sudo /opt/mwf/build-db-image.sh` (writes `DB_IMAGE`).
4. Write `/etc/mwf/migrator.env` (mode 0600) and rewrite `application.env`'s URLs with the TLS
   suffix (above). Add `DB_BASE_IMAGE` to `release.env` from `images.env.example`.
5. Over the SSH tunnel as `postgres`: `roles.sql` (as before), then the cutover proper,
   `drop-old-objects.sql` (plan §6).
6. Recreate the stack on the new networks and image: `compose down` (**never** `-v`), then
   `compose up -d db` and wait for healthy. The `database` and `admin` networks now have pinned
   subnets, which Docker applies only to a new network. Check
   `compose exec -T db psql -U postgres -d mwf -Atc "SHOW ssl; SHOW shared_preload_libraries"`
   (`on`, `pgaudit`). Then `compose exec -T db psql -X -v ON_ERROR_STOP=1 -U postgres -d mwf -f - < /opt/mwf/ownership.sql`:
   `mwf_migrator` owns the database and schema `public`, PUBLIC loses CONNECT / TEMPORARY, the
   capabilities get CONNECT, `slam_bot_readonly` keeps its own, pgaudit's extension and the
   per-role `pgaudit.log`. It is idempotent; it refuses (changing nothing) without pgaudit loaded.
7. `sudo rm /etc/mwf/deploy-paused` and deploy the target-shape release (`deploy.sh` runs the
   preflight over TLS, migrates as `mwf_migrator` from 172.29.1.4, starts the API).
8. Verify: `ops-health.sh`; the bot tunnel still answers (`prod-query.py 'SELECT 1'`); a plain-text
   connection is refused (`psql "sslmode=disable host=127.0.0.1 port=15432 user=postgres"` through
   the tunnel: `no pg_hba.conf entry … no encryption`); `compose logs db | grep AUDIT` shows the
   migration's statements as `mwf_migrator` and none of `mwf_app`'s.

What the bot sees afterwards (owner decision 2026-11-17, work-k5fk.10.30): `slam_bot_readonly` is a
member of the capability `diag_access` only (`roles.sql`); `ownership.sql` withdraws its old direct
CONNECT, USAGE, table SELECTs and default ACLs. It reads every row, but only the id, status, kind,
stage, count, flag and timestamp columns (trailer T7c), and `_prisma_migrations`' bookkeeping columns:
no content, names, emails, keys or push tokens (`bot-workspaces/shared/diagnostics/check-db.md`).

## Back up and restore

```sh
sudo /opt/mwf/backup.sh nightly
sudo /opt/mwf/backup.sh preserved  # before migration or maintenance
sudo systemctl list-timers mwf-backup.timer
```

Backups are custom-format `pg_dump` files with owners and ACLs (work-k5fk.10.6: the target shape's grants, definer ownership and row-level policies are schema; `restore.sh` replays them as the superuser into a database owned by `mwf_migrator`, data loaded with triggers off, then runs `ownership.sql`; it refuses a target-shape archive without ACLs and needs every role of `roles.sql` on the cluster first; an old-shape archive restores as before, owned by `mwf_app`), checked for readability, SHA-256 checksummed, and uploaded with timestamp, source release and migration metadata. Successful upload of every file precedes the last-success record. Nightly retention is 7 days; preserved/final Render backups 30 days; old object versions also expire. The timer runs around 10:00 UTC, catches missed runs and uses a lock. `ops-health.sh` fails at 26 hours without success. Temporary files are cleaned on exit. Check backup-service failures in the journal.

Use operator AWS credentials to download `database.dump`, `SHA256SUMS`, and `metadata.json` from one prefix, then securely copy them to the host. The host's backup credential intentionally cannot download backups.

```sh
sudo /opt/mwf/restore.sh /secure/path/database.dump restore_rehearsal
```

Compare `fingerprint.sql` output on source and target (counts and content hashes for every public table), inspect migration checksums, extensions, foreign keys, and representative application reads. Drop the disposable database only after checks pass. Listing an archive is not a restore drill.

Replacing the production database is explicitly guarded and requires stopped API writes:

```sh
sudo touch /etc/mwf/deploy-paused
sudo docker compose --env-file /etc/mwf/release.env -f /opt/mwf/compose.yaml stop api
sudo /opt/mwf/restore.sh /secure/path/database.dump mwf replace-production
# Select compatible image; start and verify it before removing deploy-paused.
```

For full server loss: provision a replacement (deliberately address `prevent_destroy`), run bootstrap, restore root-only configuration using operator S3 access, install runtime files and pinned images, initialize DB roles, import a verified backup, and verify through an SSH tunnel. Reassign the original static IP with Terraform only after the replacement passes. Restore Caddy state or let Caddy reissue its certificate once the IP is assigned. Install timers with `install-services.sh`. Recovery loses changes after the latest backup; no automatic failover or PITR is provided.

## Rollback and updates

`/var/lib/mwf/previous-image` records the old app image. Before reusing it, check schema compatibility.

**Role-guard preflight (work-k5fk.10.3).** `deploy.sh` first runs the image's `role-guard-preflight.js`
(`docker run` on network `mwf_database` with `/etc/mwf/application.env`, before any backup, stop or
migration). It checks every runtime role URL and refuses a superuser, BYPASSRLS, CREATEROLE/CREATEDB/
REPLICATION login, a member of any role, the database owner, CREATE on the database or on schema
`public`/`app`, SET on `session_replication_role`, or ownership of any object — then the deploy stops
and the previous release keeps running. A database still owned by `mwf_app` is refused until the cutover above; that is intended. Rolling back:
- to an image **with** the preflight: it runs as for any deploy;
- to an image that **predates** the guard (no `dist/backend/src/lib/prisma-role-guard.js`): `deploy.sh`
  warns and skips the preflight — that image has no startup role check, so it cannot crash-loop on
  its role, and refusing it would block every rollback past this release;
- to an image with the guard but no preflight script: refused (a broken build, not a rollback);
- to an image with neither the guard nor `dist/backend/src/server.js`: refused (unknown layout);
- if docker cannot run the image to look (any exit but 0/1 from `test -f`): the deploy aborts.
There is no switch to skip the preflight for a guarded image. Failed migrations/readiness leave the deployment failed; do not blindly restore an older database or automatically down-migrate. An app rollback does not undo schema changes. Before AWS receives writes, Render can be resumed with its original DNS record. First reset its frozen role setting using an operator connection: `SET default_transaction_read_only=off; ALTER ROLE be_heard_db_user RESET default_transaction_read_only;`. After AWS receives writes, freeze writes and move the latest data back before routing to Render, or repair AWS in place.

### PostgreSQL major upgrade: the email domain's Unicode tables

The `email` domain (`"user".email`, work-k5fk.5) is built on PostgreSQL's own Unicode tables: `lower(… COLLATE pg_unicode_fast)`, `unicode_assigned()` and `IS NFC NORMALIZED` are immutable, and the builtin provider's Unicode version (`SELECT unicode_version();`, 16.0 on PostgreSQL 18) changes only with the major version — not with an OS or ICU update. A major upgrade (`pg_upgrade`, a new major image, a restore into a newer major) therefore requires:

1. Re-derive the `email_no_format` code-point list in `backend/scripts/target-shape/tables.sql` for the new Unicode version (Cf ∪ Default_Ignorable_Code_Point); `email-domain.target.test.ts` compares it with JavaScript's `\p{Cf}` / `\p{Default_Ignorable_Code_Point}` over every code point the server considers assigned and fails until it matches. This holds only when Node's Unicode version is at least the server's: check `node -p process.versions.unicode` against `SELECT unicode_version()` first, and upgrade Node if it is older, or the test passes with the list stale.
2. Nothing for existing rows: a code point not assigned in the old version was refused then (`email_assigned`), so every stored address was built only from characters both versions know, and their case mapping and normalization are stable (Unicode stability policy).
3. Re-run the exhaustive tests in `email-domain.target.test.ts` (case mapping = JavaScript, the format ranges, base letter × combining mark) against the upgraded server, and `canonicalEmail` (`shared/src/utils/email.ts`) against the Node version in use.

Pin and review image upgrades, back up first, rehearse restore, and schedule major PostgreSQL upgrades/reboots deliberately. Database and certificate volumes have stable names and are never removed by deployment. Never use `docker compose down -v`. Reboot verification must show healthy containers, unchanged data and active timers. Keep disk space under review; release artifacts expire after 30 days in S3, and current/previous images must remain available locally.

See `docs/deployment/aws-migration-status.md` for measured results, resource IDs, current release, DNS cutover and retirement status.
