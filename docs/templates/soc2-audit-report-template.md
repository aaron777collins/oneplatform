# SOC2 Type II Audit Report — OnePlatform

**Audit Period:** [START DATE] to [END DATE]
**Report Date:** [REPORT DATE]
**Prepared By:** [PREPARER NAME / ROLE]
**Reviewed By:** [REVIEWER NAME / ROLE]
**Auditor:** [AUDITOR FIRM NAME]
**Report Version:** [e.g. 1.0 — Draft / Final]

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope and Boundaries](#2-scope-and-boundaries)
3. [Security (CC)](#3-security-cc)
4. [Availability (A)](#4-availability-a)
5. [Confidentiality (C)](#5-confidentiality-c)
6. [Processing Integrity (PI)](#6-processing-integrity-pi)
7. [Privacy (P)](#7-privacy-p)
8. [Exceptions and Findings](#8-exceptions-and-findings)
9. [Evidence Index](#9-evidence-index)
10. [Sign-off](#10-sign-off)

---

## 1. Executive Summary

### Overall Opinion

[ ] Unqualified (no exceptions)
[ ] Qualified (exceptions noted in Section 8)
[ ] Adverse

### Summary of Findings

| Trust Service Criteria | Controls Tested | Exceptions | Opinion |
|------------------------|-----------------|------------|---------|
| CC — Security | | | |
| A — Availability | | | |
| C — Confidentiality | | | |
| PI — Processing Integrity | | | |
| P — Privacy | | | |

### Key Changes Since Last Audit

_List any material changes to the system boundary, controls, or infrastructure
since the previous audit period._

- [ ] No material changes
- [ ] Changes documented below:

[DESCRIBE CHANGES]

---

## 2. Scope and Boundaries

### System Description

OnePlatform is a self-hosted data integration and low-code application platform
delivered as a Docker Compose stack. The in-scope system comprises:

**Application Services (9):**
- gateway-service — API gateway, rate limiting, routing
- auth-service — authentication, RBAC, session management
- ingestion-service — data connector management, credential encryption
- ontology-service — schema management, entity definitions
- pipeline-service — workflow orchestration
- execution-service — sandboxed code execution (isolated-vm, Docker containers)
- app-service — low-code application hosting
- logging-service — audit logging, log aggregation
- plugin-service — third-party plugin management

**Infrastructure:**
- PostgreSQL 16 (primary data store)
- PgBouncer (connection pooler)
- Redis 7 (session cache, BullMQ queue backend)
- MinIO (object storage)
- Caddy (TLS reverse proxy)
- Vector (log aggregation sidecar)

**Trust Service Criteria in Scope:**
- [ ] Security (CC1–CC9)
- [ ] Availability (A1)
- [ ] Confidentiality (C1)
- [ ] Processing Integrity (PI1)
- [ ] Privacy (P1–P8)

### Boundaries

**Included:**
- Docker Compose stack running on [DEPLOYMENT HOST/CLOUD]
- All application services listed above
- PostgreSQL, Redis, MinIO, Caddy, Vector, PgBouncer

**Excluded:**
- Customer data content (audited by customer's own controls)
- Network infrastructure outside the Docker host
- Third-party OAuth providers (Google, GitHub, etc.)
- SMTP relay (external mail provider)
- DNS provider

### Deployment Environment

| Item | Value |
|------|-------|
| Deployment Type | [Self-hosted / Cloud VM / Kubernetes] |
| Host OS | [e.g. Ubuntu 22.04 LTS] |
| Docker Version | [e.g. 24.x] |
| OnePlatform Version | [e.g. 1.4.0] |
| Instance Count | [Single-node / Multi-node HA] |

---

## 3. Security (CC)

### CC1 — Control Environment

**Control Owner:** Engineering Lead

**Control Description:**
Management has established and documented the control environment through
Architecture Decision Records (ADRs), a development process document, and a
reference hierarchy that enforces design-before-implementation.

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC1.1 | Architecture decisions documented and approved | Inspect ADR files in `docs/decisions/` | ADR-001, ADR-002 | [ ] Pass [ ] Fail |
| CC1.2 | Database roles follow least-privilege principle | Inspect GRANT statements in migration SQL | `001_initial_schema.sql` GRANT sections | [ ] Pass [ ] Fail |
| CC1.3 | Development process enforced (design → review → implementation) | Inspect `DEVELOPMENT-PROCESS.md` | `docs/development-process.md` | [ ] Pass [ ] Fail |

**Exceptions:** [NONE / DESCRIBE]

---

### CC2 — Communication and Information Quality

**Control Owner:** Engineering (Logging Service)

**Control Description:**
All state-changing actions emit structured audit events via BullMQ to the
logging service, which persists them to an append-only PostgreSQL table with
365-day retention. Delivery is guaranteed through retry logic and idempotency.

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC2.1 | Audit events written for all create/update/delete/auth operations | Query `logging.audit_events` for sample of operations during audit period; verify coverage | Evidence report §cc2_audit_logging |
| CC2.2 | Audit events contain all required fields (actor, tenant, resource, result) | Inspect schema and sample events | `AuditEventJobSchema` in `audit-service.ts` |
| CC2.3 | Audit table is append-only (no DELETE privilege granted to service role) | Inspect PostgreSQL GRANT statements | Migration `001_initial_schema.sql` GRANT section |
| CC2.4 | BullMQ retry policy ensures no audit event is silently lost | Inspect worker configuration; check DLQ depth | Compliance report §audit.bullmq_dlq_empty |
| CC2.5 | Audit events are retained for ≥ 365 days | Query oldest event in `logging.audit_events`; inspect retention config | Evidence report §cc2_audit_logging.audit_date_range |
| CC2.6 | Log aggregation is operational (Vector sidecar running) | Check Vector container status | Compliance check §cc7_system_operations |

**Evidence collected:**
- Audit event count (30-day): [VALUE FROM EVIDENCE REPORT]
- Audit event count (total): [VALUE FROM EVIDENCE REPORT]
- Earliest audit event date: [VALUE FROM EVIDENCE REPORT]
- BullMQ DLQ depth: [VALUE FROM COMPLIANCE REPORT]

**Exceptions:** [NONE / DESCRIBE]

---

### CC3 — Risk Assessment

**Control Owner:** Engineering / Security

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC3.1 | All dependencies pinned via lockfile | Confirm `pnpm-lock.yaml` is present and committed | Evidence report §cc3_risk_assessment.lockfile_present |
| CC3.2 | Container images pinned to specific tags | Inspect `docker-compose.yml` image references | `docker/docker-compose.yml` |
| CC3.3 | Dependency vulnerability scanning performed | Run `pnpm audit` and attach output | Attach `pnpm-audit-<date>.json` |
| CC3.4 | Container hardening applied | Inspect docker-compose.yml security_opt, cap_drop, read_only | Compliance report §hardening.* |
| CC3.5 | Environment variables documented | Confirm `.env.example` exists and is complete | Evidence report §cc3_risk_assessment.env_documentation_present |

**Exceptions:** [NONE / DESCRIBE]

---

### CC5 — Control Activities — Encryption

**Control Owner:** Engineering (Platform/DevOps)

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC5.1 | TLS enabled on all external endpoints | Inspect Caddyfile; verify ACME config | Evidence report §cc5_encryption.caddy_tls_status |
| CC5.2 | HSTS configured with preload | Inspect `Strict-Transport-Security` header in prod Caddyfile | Compliance report §tls.prod_caddyfile |
| CC5.3 | Security headers present (CSP, XCTO, XFO) | Inspect Caddyfile headers | Compliance report §tls.header.* |
| CC5.4 | Server header suppressed | Inspect Caddyfile `-Server` directive | Compliance report §tls.server_header_removed |
| CC5.5 | AES-256-GCM master key present and ≥ 32 bytes | Check `OP_MASTER_KEY` configuration; do not log key value | Compliance report §creds.master_key_set |
| CC5.6 | User passwords hashed with Argon2id | Inspect `password-service.ts` | `services/auth/src/services/password-service.ts` |
| CC5.7 | API keys hashed with bcrypt (≥ 12 rounds) | Inspect `api-key-service.ts` | `services/auth/src/services/api-key-service.ts` §getBcryptRounds |
| CC5.8 | Ed25519 service keys generated by op-init | Inspect init.sh key generation; verify key files exist | `docker/init/init.sh` |

**Evidence collected:**
- Caddy TLS status: [VALUE FROM EVIDENCE REPORT]
- HSTS present in prod config: [VALUE FROM EVIDENCE REPORT]
- Database SSL: [VALUE FROM EVIDENCE REPORT]
- JWT algorithm: [VALUE FROM EVIDENCE REPORT]

**Exceptions:** [NONE / DESCRIBE]

---

### CC6 — Logical Access Controls

**Control Owner:** Engineering (Auth Service)

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC6.1 | RBAC enforced on all API endpoints | Sample 10 API endpoints; verify authentication middleware present | `services/gateway/src/` middleware |
| CC6.2 | Five predefined roles with documented scope sets | Inspect `PREDEFINED_ROLE_SCOPES` constant | Evidence report §cc6_logical_access.rbac_roles_defined |
| CC6.3 | API key scope subsetting enforced | Review scope subsetting logic in `create()` | `api-key-service.ts` §create |
| CC6.4 | Token replay detection implemented | Inspect refresh token family rotation logic | `token-service.ts` §detectAndHandleReplay |
| CC6.5 | Access token revocation via JTI blocklist | Inspect Redis revocation key pattern | `token-service.ts` §revokeAccessToken |
| CC6.6 | API key revocation via Redis blocklist + DB flag | Inspect revocation logic and TTL | `api-key-service.ts` §revoke |
| CC6.7 | Account lockout after 10 failed logins | Inspect lockout logic in auth service | `services/auth/src/services/auth-service.ts` |
| CC6.8 | Row-level security enabled on auth.users | Inspect PostgreSQL RLS status | Compliance report §rbac.rls_on_users_table |
| CC6.9 | All inactive users cannot authenticate | Inspect `is_active` check in auth service | `services/auth/src/services/auth-service.ts` |
| CC6.10 | No users with platform-admin role except designated admins | Query `auth.users WHERE 'platform-admin' = ANY(roles)` | [ATTACH QUERY RESULT] |

**Evidence collected:**
- Total tenants: [VALUE FROM EVIDENCE REPORT]
- Active API keys: [VALUE FROM EVIDENCE REPORT]
- API keys with expiry: [VALUE FROM EVIDENCE REPORT]
- API keys with IP allowlist: [VALUE FROM EVIDENCE REPORT]
- Revoked API keys (audit period): [VALUE FROM EVIDENCE REPORT]

**Exceptions:** [NONE / DESCRIBE]

---

### CC7 — System Operations

**Control Owner:** DevOps

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC7.1 | All 9 services report healthy during audit period | Inspect Docker health state; review uptime monitoring logs | Evidence report §cc7_system_operations |
| CC7.2 | Prometheus alerting configured | Confirm `docker/prometheus/alerts.yml` exists and covers key signals | Compliance report §cc7_system_operations.prometheus_alerts_configured |
| CC7.3 | Container restart policy set to unless-stopped | Inspect docker-compose.yml | `docker/docker-compose.yml` |
| CC7.4 | Log aggregation operational | Confirm Vector container running | Evidence report §cc7_system_operations.vector_log_aggregation |
| CC7.5 | Graceful shutdown configured | Confirm `stop_grace_period: 45s` in docker-compose.yml | `docker/docker-compose.yml` |

**Evidence collected:**
- Services healthy at time of evidence collection: [VALUE FROM EVIDENCE REPORT]
- Container restart counts: [ATTACH FROM EVIDENCE REPORT]

**Exceptions:** [NONE / DESCRIBE]

---

### CC8 — Change Management

**Control Owner:** Engineering Lead

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC8.1 | All code changes tracked in git with author and timestamp | Inspect git log for audit period | Evidence report §cc8_change_management.recent_commits |
| CC8.2 | Database schema changes tracked via migrations | Inspect `schema_migrations` table | Run: `psql -c "SELECT * FROM auth.schema_migrations ORDER BY applied_at DESC"` |
| CC8.3 | Release tagging convention followed | Inspect git tags | Evidence report §cc8_change_management.latest_release_tag |
| CC8.4 | Idempotent migrations (safe to re-run) | Inspect migration SQL for IF NOT EXISTS | All `*/src/db/migrations/*.sql` |

**Evidence collected:**
- Commits in audit period: [VALUE FROM EVIDENCE REPORT]
- Latest release tag: [VALUE FROM EVIDENCE REPORT]

**Exceptions:** [NONE / DESCRIBE]

---

### CC9 — Risk Mitigation

**Control Owner:** Engineering

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| CC9.1 | Rate limiting active on gateway | Check gateway rate limit config; test with curl | Evidence report §cc9_risk_mitigation |
| CC9.2 | Input validation with Zod on all endpoints | Inspect route handlers for Zod parse calls | Sample 5 routes from any service |
| CC9.3 | Parameterised queries used (no SQL injection) | Inspect repository files | All `services/*/src/repositories/*.ts` |
| CC9.4 | CORS allowlist configured | Inspect `OP_ALLOWED_ORIGINS` env var | Evidence report §cc9_risk_mitigation.cors_policy |
| CC9.5 | SSRF protection via Docker socket proxy | Inspect docker-socket-proxy allowlist | `docker/docker-compose.yml` §docker-socket-proxy |

**Exceptions:** [NONE / DESCRIBE]

---

## 4. Availability (A)

### A1 — System Availability

**Control Owner:** DevOps

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| A1.1 | All services have liveness health checks | Curl `/healthz` on each service | Evidence report §cc7_system_operations.service_health_states |
| A1.2 | Connection pooling prevents database overload | Inspect PgBouncer pool config | `docs/MONITORING.md §6` |
| A1.3 | Redis AOF persistence enabled | Check `appendonly yes` in redis.conf | Compliance report §backup.redis_aof_enabled |
| A1.4 | BullMQ retry policy covers transient failures | Inspect queue configuration | `packages/core/src/queue.ts` |
| A1.5 | Backup procedures documented and tested | Review `docs/BACKUP.md`; confirm last backup date | [ATTACH LAST BACKUP LOG] |
| A1.6 | Recovery procedure tested (RTO/RPO met) | Review DR test log | [ATTACH DR TEST LOG] |

**Uptime during audit period:**
- Target SLA: [e.g. 99.9%]
- Actual uptime: [VALUE — attach uptime monitoring export]
- Incidents during period: [COUNT — attach incident list]

**Exceptions:** [NONE / DESCRIBE]

---

## 5. Confidentiality (C)

### C1 — Confidential Information

**Control Owner:** Engineering

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| C1.1 | Tenant isolation enforced in all queries | Inspect repository queries for tenant_id scope | Sample repositories from 3 services |
| C1.2 | Field-level restrictions enforced | Test API response with viewer role; confirm restricted fields absent | `rbac-service.ts` §getFieldRestrictions |
| C1.3 | Row-level filters applied | Test API response with restricted role | `rbac-service.ts` §getRowFilter |
| C1.4 | Connector credentials encrypted at rest | Inspect ingestion service encryption | `services/ingestion/src/` |
| C1.5 | Field-level audit records access to sensitive fields | Inspect `logging.field_audit_events` | `services/logging/src/services/field-audit-service.ts` |

**Exceptions:** [NONE / DESCRIBE]

---

## 6. Processing Integrity (PI)

### PI1 — System Processing

**Control Owner:** Engineering / QA

| # | Control Activity | Testing Procedure | Evidence Reference | Result |
|---|-----------------|-------------------|-------------------|--------|
| PI1.1 | Input validated with Zod schemas before processing | Inspect route handlers | All `services/*/src/routes/*.ts` |
| PI1.2 | Audit job deduplication via job_id unique constraint | Inspect migration and worker logic | `001_initial_schema.sql` §audit_events_job_id_unique_idx |
| PI1.3 | Multi-step operations use database transactions | Inspect key rotation and token rotation | `api-key-service.ts` §rotate |
| PI1.4 | Parameterised queries prevent data corruption | Inspect repositories | All `services/*/src/repositories/*.ts` |

**Exceptions:** [NONE / DESCRIBE]

---

## 7. Privacy (P)

### P1–P8 — Privacy Program

**Control Owner:** Legal/Compliance + Engineering

| # | Criterion | Control Activity | Evidence Reference | Result |
|---|-----------|-----------------|-------------------|--------|
| P1 | Privacy Notice | Privacy policy accessible at login | [ATTACH POLICY URL] | |
| P2 | Choice and Consent | User consent recorded at registration | `auth.users.metadata` consent fields | |
| P3 | Collection | Data collection limited to stated purposes | Data flow documentation | |
| P4 | Use and Retention | 365-day log retention; tenant soft-delete | Evidence report §cc2_audit_logging, migration `002_tenant_soft_delete.sql` | |
| P5 | Access | Data subject access request procedure | [ATTACH DSAR PROCEDURE] | |
| P6 | Disclosure | Third-party disclosure log | [ATTACH DISCLOSURE LOG] | |
| P7 | Quality | User profile update capability | `services/auth/src/routes/users.ts` | |
| P8 | Monitoring | Privacy incident response procedure | [ATTACH INCIDENT RESPONSE PLAN] | |

**Data Subject Requests during audit period:**
- Requests received: [COUNT]
- Requests fulfilled within SLA: [COUNT]
- Average fulfilment time: [DAYS]

**Exceptions:** [NONE / DESCRIBE]

---

## 8. Exceptions and Findings

### Open Findings

| ID | Severity | Criterion | Finding | Remediation Owner | Target Date | Status |
|----|----------|-----------|---------|-------------------|-------------|--------|
| F-001 | | | | | | |

### Resolved Findings (from previous audit)

| ID | Severity | Finding | Resolution | Closed Date |
|----|----------|---------|------------|-------------|
| | | | | |

---

## 9. Evidence Index

All evidence files should be retained for a minimum of 7 years.

| Evidence ID | Description | File / Query | Collected Date | Retained By |
|-------------|-------------|--------------|----------------|-------------|
| E-001 | SOC2 evidence JSON report | `reports/soc2/soc2-evidence-<timestamp>.json` | [DATE] | |
| E-002 | Compliance check report | `reports/soc2/compliance-check-<timestamp>.json` | [DATE] | |
| E-003 | Git commit log (90 days) | Included in E-001 §cc8_change_management | [DATE] | |
| E-004 | User and API key counts | Included in E-001 §cc6_logical_access | [DATE] | |
| E-005 | Audit event counts and date range | Included in E-001 §cc2_audit_logging | [DATE] | |
| E-006 | Container health states | Included in E-001 §cc7_system_operations | [DATE] | |
| E-007 | pnpm audit output | Attach separately | [DATE] | |
| E-008 | Uptime monitoring export | Attach from monitoring provider | [DATE] | |
| E-009 | Last backup verification log | Attach from backup run | [DATE] | |
| E-010 | Disaster recovery test log | Attach | [DATE] | |
| E-011 | schema_migrations table dump | Query: `SELECT * FROM auth.schema_migrations` | [DATE] | |
| E-012 | platform-admin user list | Query: `SELECT id, email, tenant_id FROM auth.users WHERE 'platform-admin' = ANY(roles)` | [DATE] | |

### Generating Evidence

```bash
# Collect all automated evidence
bash scripts/soc2-evidence.sh

# Run compliance checks
bash scripts/compliance-check.sh

# List generated reports
ls -lt reports/soc2/
```

---

## 10. Sign-off

### Management Assertion

_We, the undersigned, assert that the description of OnePlatform's system and
the suitability of the design of controls are fairly presented as of [DATE],
and that the controls operated effectively throughout the period [START DATE]
to [END DATE]._

| Name | Title | Signature | Date |
|------|-------|-----------|------|
| | | | |
| | | | |

### Auditor Opinion

_[AUDITOR FIRM] has examined the description of OnePlatform's system and the
suitability and operating effectiveness of controls for the period [START DATE]
to [END DATE]._

| Name | Firm | Signature | Date |
|------|------|-----------|------|
| | | | |

---

*This template is based on the AICPA Trust Service Criteria (2017). Adapt
section numbering and control text to match your specific deployment and the
scope agreed with your auditor.*
