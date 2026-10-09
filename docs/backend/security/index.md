---
title: Security Architecture
sidebar_position: 1
description: Security implementation for Meet Without Fear, focusing on privacy isolation and consent enforcement.
slug: /backend/security
---
# Security Architecture

Security implementation for Meet Without Fear, focusing on privacy isolation and consent enforcement.

## Documentation

### [Database Row-Level Security](./rls-policies.md)
Current PostgreSQL RLS status and requirements for future enforcement. RLS is not active runtime protection today.

### Access Control
API-level authorization and role-based access (user vs admin vs AI acting-on-behalf)

### Encryption
AWS Lightsail disks and S3 backups use encryption at rest. Public API traffic uses HTTPS; operator and bot database traffic uses SSH tunnels. API-to-PostgreSQL traffic stays on a private Docker network on the same host, without database TLS. Field-level AES-256-GCM encryption for sensitive PII fields (message content, conversation summaries, notable facts, etc.) via Prisma client extension — see `backend/src/lib/prisma-encryption-middleware.ts`.

### Audit Logging
Consent decisions and retrieval attempts recorded for review

## Core Security Principles

| Principle | Implementation |
|-----------|----------------|
| Privacy by default | UserVessel data isolated by app-layer user/session filters |
| Consent at query time | Every SharedVessel query checks `consentActive` |
| Defense in depth | Auth middleware + app-layer authorization + consent/retrieval contracts |
| Audit everything | All consent decisions logged |
| Minimal privilege | AI receives only stage-appropriate context |

## MVP Decisions

- **Stage enforcement source of truth**: App-layer retrieval contracts + StageProgress gates.
- **Consent scope**: All consent records are tied to a session + targetId + targetType; revocation must cascade to SharedVessel content (set `consentActive=false`) and mark dependent outputs stale.
- **Admin access**: Only for global library curation; no access to user vessels. Admin queries must keep explicit user/session/relationship filters.
- **Encryption**: HTTPS at the API edge, SSH for remote database access, and AWS disk/S3 encryption at rest. Local API-to-database traffic stays on the host Docker network without TLS. Hash push tokens and avoid storing secrets in user rows. Application-level field encryption (AES-256-GCM) auto-encrypts sensitive fields on write and auto-decrypts on read. `FIELD_ENCRYPTION_KEY` is optional during the pre-launch test phase — when unset, sensitive fields are stored as plaintext and the server logs a warning. Set `REQUIRE_FIELD_ENCRYPTION=true` (alongside the key) to re-enable fail-fast enforcement before public launch. In dev/test the key is always optional and values pass through unchanged.
- **Audit log**: Log every `/consent/decide`, `/consent/revoke`, and retrieval contract rejection.

---

[Back to Backend](../index.md)
