# OnePlatform SOC2 Trust Service Criteria Mapping

This document maps OnePlatform's implemented controls to the AICPA SOC2 Trust
Service Criteria (2017). Each entry identifies the criterion, describes how
OnePlatform satisfies it, and references the specific code, configuration, or
documentation that constitutes evidence.

Evidence is collected programmatically via `scripts/soc2-evidence.sh` and
verified by `scripts/compliance-check.sh`.

---

## Contents

1. [Security (CC)](#1-security-cc)
2. [Availability (A)](#2-availability-a)
3. [Confidentiality (C)](#3-confidentiality-c)
4. [Processing Integrity (PI)](#4-processing-integrity-pi)
5. [Privacy (P)](#5-privacy-p)
6. [Evidence Collection](#6-evidence-collection)

---

## 1. Security (CC)

### CC1 — Control Environment

**Criterion:** The entity demonstrates a commitment to integrity and ethical
values, and board/management establishes authority and responsibility for
internal controls.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Documented architecture decisions | All architectural decisions recorded as ADRs | `docs/decisions/001-architecture-decisions.md`, `docs/decisions/002-expanded-architecture-decisions.md` |
| Role separation | Distinct database roles per service (principle of least privilege) | `docker/postgres/init.sql`, `services/auth/src/db/migrations/001_initial_schema.sql` |
| Access control policy | RBAC with tenant isolation; no cross-tenant data access | `services/auth/src/services/rbac-service.ts` |
| Change review process | Git-based change tracking with 90-day log in evidence report | `scripts/soc2-evidence.sh` §cc8_change_management |

---

### CC2 — Communication and Information Quality

**Criterion:** The entity communicates information internally and externally to
support the functioning of internal controls, including objectives and
responsibilities.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Structured audit log | Every state-changing action emits an `AuditEvent` to BullMQ `audit` queue, persisted to `logging.audit_events` | `services/logging/src/services/audit-service.ts`, `services/logging/src/db/migrations/001_initial_schema.sql` |
| Audit event schema | Mandatory fields: `actorId`, `actorType`, `tenantId`, `action`, `resourceType`, `resourceId`, `result`, `timestamp`, `traceId` | `services/logging/src/services/audit-service.ts` (Zod schema `AuditEventJobSchema`) |
| Tamper-evident audit trail | Audit table is append-only; `archived` flag set only by retention job after 365-day window; no DELETE granted to service role | `services/logging/src/db/migrations/001_initial_schema.sql` GRANT section |
| Delivery guarantee | BullMQ 5-attempt exponential backoff; job-id deduplication prevents duplicate rows on replay | `services/logging/src/services/audit-service.ts` §startAuditWorker |
| Structured application logs | All services emit JSON log events with `timestamp`, `traceId`, `service`, `level`, `message`, `metadata` | `packages/core/src/logger.ts` |
| Log aggregation | Vector sidecar tails Docker json-file logs, routes to `/var/log/oneplatform/` | `docker/vector/vector.yaml`, `docs/MONITORING.md §4` |
| Audit DLQ monitoring | Failed audit jobs retained in BullMQ failed set (count 100); DLQ depth checked in compliance script | `scripts/compliance-check.sh` §audit.bullmq_dlq_empty |

---

### CC3 — Risk Assessment

**Criterion:** The entity specifies objectives with clarity to allow the
identification and assessment of risks.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Dependency pinning | `pnpm-lock.yaml` pins every transitive dependency to an exact version | `pnpm-lock.yaml` |
| Container image pinning | Infrastructure images pinned to specific tags (e.g., `postgres:16-alpine`, `redis:7-alpine`) | `docker/docker-compose.yml` |
| Dependency audit surface | `scripts/soc2-evidence.sh` counts `package.json` files; `pnpm audit` can be run against the lockfile | Run: `pnpm audit --audit-level moderate` |
| Security documentation | Architecture decisions document threat model for each service boundary | `docs/decisions/002-expanded-architecture-decisions.md` |
| Container hardening | `no-new-privileges`, `cap_drop: ALL`, read-only root filesystem, `tmpfs /tmp` on every service container | `docker/docker-compose.yml` §x-service-common |

---

### CC5 — Control Activities — Encryption and Key Management

**Criterion:** The entity selects and develops control activities, including
technology controls, that contribute to the mitigation of risks.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| TLS termination | Caddy reverse proxy terminates TLS for all external traffic using ACME (Let's Encrypt) automatic certificate provisioning | `docker/caddy/Caddyfile.prod.template` |
| HSTS | `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` on all responses | `docker/caddy/Caddyfile.prod.template` |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Content-Security-Policy`, `Server` header removed | `docker/caddy/Caddyfile.prod.template` |
| Credential encryption | All connector credentials encrypted with AES-256-GCM using `OP_MASTER_KEY` (minimum 32 bytes) | `services/ingestion/src/` |
| Ed25519 service-to-service auth | Each service has a unique Ed25519 key pair generated by `op-init` at first run | `docker/init/init.sh`, `docker/docker-compose.yml` §op-init |
| JWT algorithm | Ed25519 (EdDSA) asymmetric JWT signing available via `OP_JWT_ALGORITHM=EdDSA`; JWKS endpoint for public key distribution | `services/auth/src/services/token-service.ts` §exportPublicKeyAsJwk |
| API key hashing | All API keys hashed with bcrypt (default 12 rounds); only `key_prefix` stored in plaintext for lookup | `services/auth/src/services/api-key-service.ts` |
| Password hashing | User passwords hashed with Argon2id | `services/auth/src/services/password-service.ts` |
| API key scope subsetting | A user cannot create an API key with scopes exceeding their own — prevents privilege escalation | `services/auth/src/services/api-key-service.ts` §create |
| SSRF protection | Docker socket proxy (allowlist-based) prevents service containers from calling the Docker API directly | `docker/docker-compose.yml` §docker-socket-proxy |

---

### CC6 — Logical Access Controls

**Criterion:** The entity implements logical access security measures to protect
against threats from sources outside its system boundaries.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Role-based access control | Five predefined roles (`platform-admin`, `tenant-admin`, `developer`, `editor`, `viewer`) with explicit scope sets; custom roles via DB | `services/auth/src/services/token-service.ts` §PREDEFINED_ROLE_SCOPES |
| Scope system | 21 named scopes; `admin` scope short-circuits to all; JWT encodes scopes at issuance | `services/auth/src/services/token-service.ts` §ALL_SCOPES |
| Entity-level permissions | Per-tenant, per-role, per-entity-type `auth.entity_permissions` table; field-level deny lists; row filters | `services/auth/src/services/rbac-service.ts` |
| Field-level restrictions | Least-restrictive-wins: a field is visible if any role allows it | `services/auth/src/services/rbac-service.ts` §getFieldRestrictions |
| Row-level security | PostgreSQL RLS enabled on `auth.users` | `services/auth/src/db/migrations/001_initial_schema.sql` |
| Tenant isolation | All DB queries scoped by `tenant_id`; JWT encodes `tid` claim | All service repositories |
| Session management | JWT access tokens (15 min TTL default), opaque refresh tokens (7 day TTL), refresh token rotation with family-based replay detection | `services/auth/src/services/token-service.ts` §rotateRefreshToken |
| Token revocation | Per-JTI Redis blocklist for access tokens; per-user revocation for force-logout; API key Redis blocklist with 30-day TTL | `services/auth/src/services/token-service.ts` §revokeAccessToken, `services/auth/src/services/api-key-service.ts` §revoke |
| IP allowlist for API keys | `ip_allowlist` column on `auth.api_keys`; enforcement at validation time | `services/auth/src/services/api-key-service.ts`, migration `003_ip_allowlist.sql` |
| Account lockout | 10 consecutive failed logins triggers 15-minute lockout; `locked_until` and `failed_login_count` on `auth.users` | `services/auth/src/db/migrations/001_initial_schema.sql` |
| OAuth 2.0 support | OAuth PKCE flow for third-party identity providers | `services/auth/src/services/oauth-service.ts` |

---

### CC7 — System Operations — Monitoring and Anomaly Detection

**Criterion:** The entity monitors system components and the operation of those
controls to detect and mitigate threats and vulnerabilities.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Liveness health checks | `/healthz` endpoint on all 9 services; Docker Compose HEALTHCHECK polls every 10s, 5 retries | `docs/MONITORING.md §2` |
| Readiness health checks | `/readyz` endpoint checks downstream dependencies (postgres, redis, minio, queues) | `docs/MONITORING.md §2` |
| Auto-restart | `restart: unless-stopped` on all service containers | `docker/docker-compose.yml` |
| Prometheus alerting | Alert rules for: service health, Redis memory, PgBouncer pool exhaustion, BullMQ DLQ depth, MinIO disk | `docs/MONITORING.md §9`, `docker/prometheus/alerts.yml` (template) |
| Grafana dashboards | Service health, Redis memory, PgBouncer pool depth, MinIO disk, BullMQ queue depth | `docs/MONITORING.md §10` |
| Distributed tracing | `X-Request-ID` / `X-Trace-Id` propagated across all services; OTEL SDK integration optional | `docs/MONITORING.md §11` |
| Redis key eviction monitoring | Alert when Redis evicts keys (auth tokens evicted = silent login failure) | `docs/MONITORING.md §9` §RedisEvictingKeys |
| Container restart alerting | Alert when any service restarts more than twice in 5 minutes | `docs/MONITORING.md §9` §ContainerRestarting |
| Log rotation | Docker json-file driver: 50 MB max per file, 5 files per container | `docker/docker-compose.yml` §logging |

---

### CC8 — Change Management

**Criterion:** The entity authorises, designs, develops or acquires, configures,
documents, tests, approves, and implements changes to infrastructure, data,
software, and procedures to meet its commitments.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Git-based change history | All code changes tracked in git with author, timestamp, and commit message | `scripts/soc2-evidence.sh` §cc8_change_management |
| 90-day commit log | Evidence script collects all commits from the past 90 days into the SOC2 report | `scripts/soc2-evidence.sh` |
| Semantic versioning | Releases tagged with semver; latest tag captured in evidence report | `docker/scripts/release.sh` |
| Schema migration tracking | `schema_migrations` table records applied migrations with timestamps | `services/auth/src/db/migrations/001_initial_schema.sql`, `services/logging/src/db/migrate.ts` |
| Idempotent migrations | All migrations use `IF NOT EXISTS`; safe to re-apply | All `*/src/db/migrations/*.sql` |
| Upgrade documentation | `docs/UPGRADE.md` documents version upgrade procedures | `docs/UPGRADE.md` |
| Deployment guide | `docs/DEPLOYMENT.md` documents configuration, secrets, and startup procedure | `docs/DEPLOYMENT.md` |

---

### CC9 — Risk Mitigation

**Criterion:** The entity identifies, selects, and develops risk mitigation
activities for risks arising from potential business disruptions.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Rate limiting | Per-IP sliding window rate limiter at the gateway; Redis-backed | `services/gateway/src/` |
| Input validation | Zod schemas validate all inbound API requests at every service boundary | All `services/*/src/routes/*.ts` |
| Parameterised queries | All database access uses parameterised queries via `pg` driver; no string concatenation | All `services/*/src/repositories/*.ts` |
| CORS allowlist | `OP_ALLOWED_ORIGINS` restricts cross-origin requests to the configured frontend URL | `docker/docker-compose.yml` env vars |
| Guest session rate limiting | Guest sessions rate-limited by IP via Redis counter | `services/app/src/services/guest-session-service.ts` |
| Dependency vulnerability scanning | `pnpm audit` can be run against the pinned lockfile | Run: `pnpm audit` |
| Capacity planning documentation | `docs/CAPACITY-PLANNING.md` | `docs/CAPACITY-PLANNING.md` |
| High availability guide | `docs/HIGH-AVAILABILITY.md` documents multi-instance deployment | `docs/HIGH-AVAILABILITY.md` |

---

## 2. Availability (A)

### A1 — System Availability

**Criterion:** Current processing capacity and infrastructure are designed to
meet the entity's availability commitments.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Health check endpoints | `/healthz` (liveness) and `/readyz` (readiness) on all 9 services | `docs/MONITORING.md §2` |
| Container auto-restart | `restart: unless-stopped` policy; Docker restarts containers on crash | `docker/docker-compose.yml` |
| Connection pooling | PgBouncer in transaction mode pools PostgreSQL connections; prevents connection exhaustion | `docs/MONITORING.md §6`, `docker/pgbouncer/pgbouncer.ini` |
| Redis persistence | AOF persistence (`appendfsync everysec`) prevents BullMQ job loss across Redis restarts | `docker/redis/redis.conf` |
| Queue retry policy | BullMQ: 5 attempts, exponential backoff (2s initial); DLQ retains last 100 failed jobs | `packages/core/src/queue.ts` |
| Backup and recovery | Documented procedures for PostgreSQL, Redis, MinIO, and secrets backup | `docs/BACKUP.md` |
| High availability guide | Describes multi-replica deployment for stateless services | `docs/HIGH-AVAILABILITY.md` |
| Uptime monitoring | External health probes via Caddy `/healthz`; compatible with UptimeRobot / Pingdom / Blackbox Exporter | `docs/MONITORING.md §2` |
| Graceful shutdown | `stop_grace_period: 45s` on all service containers for in-flight request completion | `docker/docker-compose.yml` |

---

## 3. Confidentiality (C)

### C1 — Confidential Information

**Criterion:** Information designated as confidential is protected as committed
or agreed.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Tenant isolation | Every data record includes `tenant_id`; all queries are scoped by tenant; JWTs encode the `tid` claim | All service repositories |
| Field-level permissions | `auth.entity_permissions.field_restrictions` defines per-role `deny_read` and `deny_write` field lists | `services/auth/src/services/rbac-service.ts` §getFieldRestrictions |
| Row-level permissions | `auth.entity_permissions.row_filter` restricts which rows each role can read | `services/auth/src/services/rbac-service.ts` §getRowFilter |
| Credential encryption | Connector credentials encrypted at rest using AES-256-GCM | `services/ingestion/src/` |
| Secret isolation | All cryptographic secrets live in the `init-data` Docker volume; mounted read-only per service | `docker/docker-compose.yml` §op-init, `docs/BACKUP.md §7` |
| Audit trail for confidential access | Every data access action emits an audit event with `actorId`, `tenantId`, `resourceType`, `resourceId`, `result` | `services/logging/src/services/audit-service.ts` |
| Field-level audit | `logging.field_audit_events` tracks which fields were read or written per audit event | `services/logging/src/services/field-audit-service.ts`, `services/logging/src/db/migrations/002_field_audit.sql` |

---

## 4. Processing Integrity (PI)

### PI1 — System Processing

**Criterion:** System processing is complete, valid, accurate, timely, and
authorised to support the achievement of the entity's objectives.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Schema validation | Zod schemas validate all API inputs before processing | All `services/*/src/routes/*.ts` |
| Idempotent job processing | BullMQ job-id unique constraint on `logging.audit_events.job_id` prevents duplicate processing | `services/logging/src/db/migrations/001_initial_schema.sql` §audit_events_job_id_unique_idx |
| Database transaction integrity | Sensitive multi-step operations (e.g. API key rotation, session token rotation) use explicit transactions with ROLLBACK on error | `services/auth/src/services/api-key-service.ts` §rotate, `services/auth/src/services/token-service.ts` §rotateRefreshToken |
| Atomic key rotation | API key rotation revokes old key and inserts new key in a single database transaction — no window where neither key is valid | `services/auth/src/services/api-key-service.ts` §rotate |
| Parameterised queries | All queries use positional parameters (`$1`, `$2`); no string interpolation in SQL | All `services/*/src/repositories/*.ts` |
| Error propagation | Services fail loudly with specific error messages; no silent swallowing of unexpected errors | `packages/core/src/errors.ts`, all service error handlers |
| Monitoring and anomaly detection | Queue depth, DLQ depth, and service health checks surface processing failures | `docs/MONITORING.md §8-9` |

---

## 5. Privacy (P)

### P1–P8 — Privacy Notice, Choice, Collection, Use, Retention, Disclosure, Quality, Monitoring

**Criterion:** The entity collects, uses, retains, discloses, and disposes of
personal information in conformity with commitments and criteria.

| Control | Implementation | Evidence Location |
|---------|---------------|-------------------|
| Audit trail for personal data access | Actor, resource, action, and result are captured for every API operation | `services/logging/src/services/audit-service.ts` |
| Data subject audit queries | `logging.audit_events` is indexed by `actor_id`, `tenant_id`, and `resource_id` to support data subject access requests | `services/logging/src/db/migrations/001_initial_schema.sql` §audit_events_actor_idx |
| Data retention enforcement | Logging service retention worker archives/drops log partitions after 365 days; `audit_events.archived` flag tracks retention status | `services/logging/src/services/retention-service.ts` |
| Tenant data deletion | `auth.tenants` `ON DELETE CASCADE` propagates deletion to `auth.users` and all tenant-scoped records | `services/auth/src/db/migrations/001_initial_schema.sql` |
| Tenant soft delete | `deleted_at` on `auth.tenants` (migration 002) allows logical deletion before physical removal | `services/auth/src/db/migrations/002_tenant_soft_delete.sql` |
| User email uniqueness per tenant | `UNIQUE (tenant_id, email)` prevents account confusion within a tenant | `services/auth/src/db/migrations/001_initial_schema.sql` |
| Inactive account management | `is_active` flag on `auth.users`; inactive users cannot authenticate | `services/auth/src/services/auth-service.ts` |
| Field-level audit | `logging.field_audit_events` records exactly which fields were accessed, enabling granular data subject access reports | `services/logging/src/services/field-audit-service.ts` |

---

## 6. Evidence Collection

### Automated Evidence Scripts

Two scripts in `scripts/` collect and verify SOC2 evidence:

**`scripts/soc2-evidence.sh`** — Full evidence collection:
- Queries PostgreSQL for user counts, API key stats, session stats, entity permissions, audit event counts
- Reads git log (90 days) for change management evidence
- Inspects running containers for health state, TLS config, and Redis persistence
- Outputs structured JSON to `reports/soc2/soc2-evidence-<timestamp>.json`

**`scripts/compliance-check.sh`** — Automated pass/fail checks:
- 30+ individual checks across TLS, credentials, audit logging, RBAC, backups, and container hardening
- Exits with code 1 if any check FAILs (suitable for CI gating)
- Outputs human-readable results and a JSON report to `reports/soc2/compliance-check-<timestamp>.json`

### Running Evidence Collection

```bash
# Full evidence collection (requires Docker access)
bash scripts/soc2-evidence.sh

# Quick compliance check (suitable for CI)
bash scripts/compliance-check.sh

# View latest report
ls -lt reports/soc2/ | head -5
```

### Evidence File Structure

```
reports/soc2/
  soc2-evidence-<timestamp>.json      — Full evidence collection
  compliance-check-<timestamp>.json   — Pass/fail check results
```

### Audit Report Template

A structured audit report template for human review is available at:
`docs/templates/soc2-audit-report-template.md`

---

## Control Owner Matrix

| Control Area | Primary Owner | Secondary Owner |
|-------------|---------------|-----------------|
| CC6: Logical Access | Engineering (Auth Service) | Security |
| CC5: Encryption | Engineering (Platform/DevOps) | Security |
| CC7: Monitoring | DevOps | Engineering |
| CC8: Change Management | Engineering Lead | DevOps |
| CC2: Audit Logging | Engineering (Logging Service) | Security |
| A1: Availability | DevOps | Engineering |
| C1: Confidentiality | Engineering | Legal/Compliance |
| PI1: Processing Integrity | Engineering | QA |
| P1–P8: Privacy | Legal/Compliance | Engineering |
