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

- `application.env`: exact production integration settings; `DATABASE_URL` uses non-superuser `mwf_app` at `db:5432/mwf`, with `connection_limit=12`. Preserve encryption keys and production Bedrock settings. No local development settings.
- `database.env`: `POSTGRES_USER=postgres`, random `POSTGRES_PASSWORD`, `POSTGRES_DB=mwf`, random `APP_DB_PASSWORD`, random `READONLY_DB_PASSWORD`.
- `release.env`: pinned `DB_IMAGE`, `CADDY_IMAGE` from `images.env.example`, and immutable `APP_IMAGE`.
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

## Back up and restore

```sh
sudo /opt/mwf/backup.sh nightly
sudo /opt/mwf/backup.sh preserved  # before migration or maintenance
sudo systemctl list-timers mwf-backup.timer
```

Backups are custom-format `pg_dump` files, checked for readability, SHA-256 checksummed, and uploaded with timestamp, source release and migration metadata. Successful upload of every file precedes the last-success record. Nightly retention is 7 days; preserved/final Render backups 30 days; old object versions also expire. The timer runs around 10:00 UTC, catches missed runs and uses a lock. `ops-health.sh` fails at 26 hours without success. Temporary files are cleaned on exit. Check backup-service failures in the journal.

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

`/var/lib/mwf/previous-image` records the old app image. Before reusing it, check schema compatibility. Failed migrations/readiness leave the deployment failed; do not blindly restore an older database or automatically down-migrate. An app rollback does not undo schema changes. Before AWS receives writes, Render can be resumed with its original DNS record. First reset its frozen role setting using an operator connection: `SET default_transaction_read_only=off; ALTER ROLE be_heard_db_user RESET default_transaction_read_only;`. After AWS receives writes, freeze writes and move the latest data back before routing to Render, or repair AWS in place.

Pin and review image upgrades, back up first, rehearse restore, and schedule major PostgreSQL upgrades/reboots deliberately. Database and certificate volumes have stable names and are never removed by deployment. Never use `docker compose down -v`. Reboot verification must show healthy containers, unchanged data and active timers. Keep disk space under review; release artifacts expire after 30 days in S3, and current/previous images must remain available locally.

See `docs/deployment/aws-migration-status.md` for measured results, resource IDs, current release, DNS cutover and retirement status.
