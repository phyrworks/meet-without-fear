---
title: Previous Render Deployment
sidebar_position: 2
description: Historical Render migration reference.
slug: /deployment/render-config
---
# Previous Render deployment

The AWS migration completed on 2026-09-07. This project’s Render API, PostgreSQL database, and app-only environment group have been deleted.
Use [the AWS deployment runbook](../../infra/aws/README.md) and
[recorded migration status](aws-migration-status.md) for the current system.

Historical resources: `meet-without-fear-api` (`srv-d58bj73uibrs73akacd0`) and
`be-heard-db` (`dpg-d58660shg0os73bkkpmg-a`), both in Oregon. Configuration came
from the `be-heard-api-env` environment group. Secrets are preserved separately;
never retrieve credentials from this document. The old Render resources cannot
be resumed; recovery uses protected AWS backups.

The [migration plan](aws-migration-plan.md) records the original architecture,
cutover sequence, retention and rollback boundaries. Resource retirement is
recorded separately in the migration status document.
