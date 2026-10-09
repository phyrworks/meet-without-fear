# AWS migration status — 2026-09-07

Status: **Complete. AWS serves the normal HTTPS hostname, web and TestFlight acceptance passed, deployment from main succeeded, and this project’s Render resources are retired.**

## Resources

- AWS account: `679575633563`; region: `us-west-2`.
- Lightsail instance: `mwf-api`, Ubuntu 24.04, `small_3_0` (2 GB RAM, 60 GB disk).
- Static IP: `54.189.24.241`, allocation `mwf-api-ip`.
- API hostname: `api.meetwithoutfear.com`.
- S3 state: `s3://mwf-api-tfstate-679575633563-us-west-2/production/terraform.tfstate` (versioned, encrypted, locked).
- S3 backups: `s3://mwf-api-backups-679575633563-us-west-2/`.
- Final Render backup: `preserved/final-render-20260908T003808Z/` (30-day retention).
- Configuration backups: `configuration/20260908-initial.tar.gz` (operator recovery key) and `configuration/20260908-completed-host.tar.gz` (current protected host files, runtime, restricted tunnel configuration).
- GitHub deploy role: `arn:aws:iam::679575633563:role/mwf-api-github-deploy`.
- Runtime AWS identities: preserved production `be-heard-user` for Bedrock; separate `mwf-api-backup-writer` and `mwf-api-release-reader` for scoped S3 access.
- Initial source release: `2f18b0f2d0e51524de70a00531cd52b1c8a475b1`, with the explicit proxy-trust build adapter.
- Current source/infrastructure commit: `1c65fb5ee583654654395d7a27edc0ba8cc31ded`, merged in [PR #698](https://github.com/shantamg/meet-without-fear/pull/698).
- Verified deployment from main: [run 34176430166](https://github.com/shantamg/meet-without-fear/actions/runs/34176430166), release `1c65fb5ee583-34176430166-1`, host status **healthy** at 2026-09-08 01:26:06 UTC. The backend/shared/dependency source is unchanged from the accepted initial release.
- Post-deployment database backup: `preserved/20260908T012726Z-cad4a1d7-f4ef-4a9a-b367-3d713fb352dd/` (30-day retention); dump, checksum and metadata verified in S3. Configuration backup refreshed after deployment.
- Database image: PostgreSQL **18.6**, pgvector **0.8.1**, digest pinned in `infra/aws/images.env.example`. Render was PostgreSQL 18.3. The first old versioned pgvector tag contained PostgreSQL 18.2; it was replaced during rehearsal with the patched PostgreSQL 18.6 image before final import.
- Recurring infrastructure estimate: **$12/month Lightsail plus S3 storage/requests**, approximately $12–13 at current data/deployment volume. Bedrock and other integrations remain separate.

## Verified

- Terraform created only the agreed resources. State was migrated to protected S3; follow-up plans showed no unexplained drift.
- Secrets excluded from Git, Terraform inputs/state, source archives and image layers. Production integration settings came from Render, not development `.env` files.
- PostgreSQL application role is non-superuser. Recreated readonly role has SELECT access and fails CREATE. Administrative credentials remain separate.
- All **69 public tables** matched source/target row counts and deterministic content hashes, including all **74 Prisma migration records**, after the final copy. Source fingerprints before/after the final dump also matched. Baseline: **9 users and 1,042 messages**.
- During final copy, Render deployment triggers were disabled, the API was suspended, and the old database role defaulted to read-only; application connections were gone before cutover. After web/native acceptance and deployment from main succeeded, the old resources were deleted (details below).
- Real Clerk sign-in and authenticated API reads succeeded for the operator’s Shantam account. Unauthorized requests and production E2E bypass headers returned 401.
- An unshared rehearsal session received a real AI response: **48 SSE chunks**, first event **182 ms**, completion about **11 seconds**. Both user message and AI reply were readable afterward. This rehearsal-only session was removed by the final database copy.
- Real Ably session events were received through an API-issued scoped token. WebSocket upgrade succeeded and invalid authentication closed with policy code 1008. Voice transcription itself was already unconfigured in the source production environment (no AssemblyAI key); no new voice integration was introduced.
- Nightly S3 backup downloaded with operator credentials and restored into a disposable DB. Every table hash matched. Database restore command took **4 seconds**; this measures import/validation only, not full server rebuild time. Rehearsal source restore and final production import each took about 2 seconds.
- Nightly timer has missed-run recovery, overlap locking, 7-day retention, checksum and upload verification, and a last-success record. Preserved backups retain 30 days.
- Reboot recovered all containers and timers with unchanged table hashes. Post-reboot use: approximately **618 MB host RAM**, no swap use, **10 GB of 58 GB disk** used. Container memory limits and bounded logs are configured.
- PostgreSQL binds **127.0.0.1:5432 only**; API has no published port. SSH allows only the operator IP and bot IP. Bot uses a separate no-shell account restricted to forwarding PostgreSQL; CI uses OIDC/S3 and has no SSH key.
- Bot readonly configuration now uses its persistent SSH tunnel. Operator production access uses `infra/aws/prod-query.py` and protected `~/.config/mwf/production.json`; development DATABASE_URL remains unchanged.

## Cutover acceptance and completion

1. User saved Namecheap A `54.189.24.241`; authoritative DNS, Cloudflare and Google DNS agree. No conflicting AAAA. HTTPS certificate is valid (Let’s Encrypt, expires 2026-12-06).
2. Normal-hostname authenticated API/AI/SSE/Ably tests passed, and both user and AI messages remained visible in the web client after reload. The user installed the refreshed TestFlight app and confirmed successful sign-in and access to past conversations on 2026-09-07. Native-client acceptance passed.
3. All required CI checks passed at `70880d55`. The user explicitly authorized administrator merge; PR #698 merged at 2026-09-08 01:22:29 UTC without changing branch protection. Its AWS deployment succeeded, and the host manifest matches the merged commit. Final Terraform plan: **no changes**.
4. Render retirement completed at **2026-09-08 01:28:05 UTC** (September 7, 18:28 PDT). Each DELETE returned 204 and subsequent GET returned 404:
   - API `meet-without-fear-api`: `srv-d58bj73uibrs73akacd0`.
   - Database `be-heard-db`: `dpg-d58660shg0os73bkkpmg-a`.
   - App-only environment group `be-heard-api-env`: `evg-d58bivruibrs73aka8qg`; no other services used it.
5. Unrelated Render resources were checked before and after retirement and remain unchanged: `scheduler4` (`srv-d7jd8t0sfn5c73bkjr4g`), `scheduler4-db` (`dpg-d7jd8k0sfn5c73bkjmvg-a`), and `scheduler4-db-pre-import` (`dpg-d9tpldh42hec738ra2b0-a`).
6. Removed GitHub `RENDER_DEPLOY_HOOK`, the obsolete local MWF production URL/Render key, temporary migration credential/dump copies, and the bot’s migration-only env backup. Shared Render credentials needed by other projects were not revoked. The temporary acceptance browser session was revoked; the user’s mobile session was preserved.
7. Post-retirement HTTPS health returned 200; unauthenticated API access returned 401 after deployment; the readonly tunnel still queried all 9 users. API/database containers and backup/release timers remain healthy. The bot has automatically pulled the AWS diagnostic updates from main.

No email or push-notification test was sent to another recipient.

## Recovery

Use [the AWS runbook](../../infra/aws/README.md). The old Render service and database no longer exist; recovery now uses the protected S3 database/configuration backups and reproducible AWS infrastructure. The runbook’s pre-cutover Render rollback option is historical and no longer available. App rollback does not reverse database migrations. Preserve the final Render backup for its full 30-day retention. Nightly backups retain 7 days; full server recovery loses changes after the latest backup and has no automatic failover.
