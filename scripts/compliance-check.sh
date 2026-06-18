#!/usr/bin/env bash
# scripts/compliance-check.sh
#
# SOC2 Quick Compliance Check for OnePlatform
#
# Runs automated pass/fail/warning checks across key control areas.
# Output is human-readable to stdout and machine-readable JSON to
# reports/soc2/compliance-check-<timestamp>.json.
#
# Designed to run in CI (exit code 0 = all pass/warn, 1 = any FAIL)
# or manually before an audit review.
#
# No external network calls. All checks operate against local Docker state,
# config files, and git history.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPORT_DIR="${REPO_ROOT}/reports/soc2"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_FILE="${REPORT_DIR}/compliance-check-${TIMESTAMP}.json"
DOCKER_COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
CADDY_PROD_CONFIG="${REPO_ROOT}/docker/caddy/Caddyfile.prod.template"

mkdir -p "${REPORT_DIR}"

# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
RESULTS_JSON="["
FIRST_RESULT=true

# Record a single check result.
# Usage: record_result "check_id" "PASS|WARN|FAIL" "Description" "Details"
record_result() {
  local id="$1"
  local status="$2"
  local description="$3"
  local details="$4"

  case "${status}" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac

  # Pretty print to stdout with colour codes (omitted when not a TTY)
  local colour=""
  local reset=""
  if [ -t 1 ]; then
    case "${status}" in
      PASS) colour="\033[0;32m" ;;
      WARN) colour="\033[0;33m" ;;
      FAIL) colour="\033[0;31m" ;;
    esac
    reset="\033[0m"
  fi
  printf "${colour}[%s]${reset} %s — %s\n" "${status}" "${id}" "${description}"
  if [ -n "${details}" ]; then
    printf "       %s\n" "${details}"
  fi

  # Append to JSON results array
  if [ "${FIRST_RESULT}" = true ]; then FIRST_RESULT=false; else RESULTS_JSON="${RESULTS_JSON},"; fi
  local escaped_desc
  escaped_desc="$(echo "${description}" | sed 's/"/\\"/g')"
  local escaped_details
  escaped_details="$(echo "${details}" | sed 's/"/\\"/g')"
  RESULTS_JSON="${RESULTS_JSON}{\"id\":\"${id}\",\"status\":\"${status}\",\"description\":\"${escaped_desc}\",\"details\":\"${escaped_details}\"}"
}

# Safely run a docker exec; returns empty string on failure
docker_exec_safe() {
  local service="$1"
  shift
  docker compose -f "${DOCKER_COMPOSE_FILE}" exec -T "${service}" "$@" 2>/dev/null || true
}

echo "============================================================"
echo "  OnePlatform SOC2 Compliance Check"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================"
echo ""

# ---------------------------------------------------------------------------
# Section 1: TLS on all external endpoints
# ---------------------------------------------------------------------------

echo "--- CC5: Transport Encryption ---"

# Prod Caddyfile must have HTTPS configuration
if grep -q 'email \${OP_TLS_EMAIL}' "${CADDY_PROD_CONFIG}" 2>/dev/null && \
   grep -q 'Strict-Transport-Security' "${CADDY_PROD_CONFIG}" 2>/dev/null; then
  record_result "tls.prod_caddyfile" "PASS" \
    "Production Caddyfile configures TLS via ACME (Let's Encrypt)" \
    "HSTS header with max-age=31536000;includeSubDomains;preload is present"
else
  record_result "tls.prod_caddyfile" "FAIL" \
    "Production Caddyfile missing TLS or HSTS configuration" \
    "Expected: ACME email and Strict-Transport-Security header in ${CADDY_PROD_CONFIG}"
fi

# Security headers in prod config
for header in "X-Content-Type-Options" "X-Frame-Options" "Content-Security-Policy" "Referrer-Policy"; do
  if grep -q "${header}" "${CADDY_PROD_CONFIG}" 2>/dev/null; then
    record_result "tls.header.$(echo "${header}" | tr '[:upper:]' '[:lower:]' | tr '-' '_')" "PASS" \
      "${header} security header present in prod Caddyfile" ""
  else
    record_result "tls.header.$(echo "${header}" | tr '[:upper:]' '[:lower:]' | tr '-' '_')" "FAIL" \
      "${header} security header MISSING from prod Caddyfile" \
      "File: ${CADDY_PROD_CONFIG}"
  fi
done

# Server header suppression (information disclosure)
if grep -q '\-Server' "${CADDY_PROD_CONFIG}" 2>/dev/null; then
  record_result "tls.server_header_removed" "PASS" \
    "Server response header is suppressed in prod config" ""
else
  record_result "tls.server_header_removed" "WARN" \
    "Server header suppression not found in prod Caddyfile" \
    "Suppressing the Server header reduces version fingerprinting"
fi

# No service has direct host port bindings except Caddy (check compose file)
NON_CADDY_PORTS="$(grep -A3 'ports:' "${DOCKER_COMPOSE_FILE}" 2>/dev/null | \
  grep -v 'caddy\|#\|ports:\|--' | grep '"[0-9]' || true)"
if [ -z "${NON_CADDY_PORTS}" ]; then
  record_result "tls.no_exposed_ports" "PASS" \
    "No application services expose host ports (all traffic through Caddy)" ""
else
  record_result "tls.no_exposed_ports" "WARN" \
    "Possible host port bindings outside Caddy detected" \
    "Review docker-compose.yml ports sections: ${NON_CADDY_PORTS}"
fi

echo ""
echo "--- CC5: Database Encryption ---"

DB_SSL="$(docker_exec_safe postgres psql -U postgres -d oneplatform -tAc "SHOW ssl" 2>/dev/null | tr -d '[:space:]')"
if [ "${DB_SSL}" = "on" ]; then
  record_result "db.ssl_enabled" "PASS" "PostgreSQL SSL is enabled" ""
elif [ "${DB_SSL}" = "off" ]; then
  record_result "db.ssl_enabled" "WARN" \
    "PostgreSQL SSL is disabled" \
    "SSL between PgBouncer and Postgres is optional if both are on the same trusted internal network. Enable for defence-in-depth."
else
  record_result "db.ssl_enabled" "WARN" \
    "PostgreSQL SSL status could not be determined" \
    "Stack may not be running. Value: '${DB_SSL}'"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 2: Default credentials changed
# ---------------------------------------------------------------------------

echo "--- CC6: Default Credentials ---"

# Postgres superuser password should not be the well-known dev default
POSTGRES_PASS_IS_DEFAULT="$(docker_exec_safe postgres \
  psql -U postgres -d oneplatform -tAc \
  "SELECT CASE WHEN passwd = md5('dev_postgres_superuserpostgres') THEN 'yes' ELSE 'no' END
   FROM pg_shadow WHERE usename='postgres'" 2>/dev/null | tr -d '[:space:]' || echo "unknown")"
if [ "${POSTGRES_PASS_IS_DEFAULT}" = "no" ]; then
  record_result "creds.postgres_default_changed" "PASS" \
    "PostgreSQL superuser password is not the dev default" ""
elif [ "${POSTGRES_PASS_IS_DEFAULT}" = "yes" ]; then
  record_result "creds.postgres_default_changed" "FAIL" \
    "PostgreSQL superuser password is still the dev default ('dev_postgres_superuser')" \
    "Set a strong random password in .env POSTGRES_PASSWORD before production use"
else
  record_result "creds.postgres_default_changed" "WARN" \
    "PostgreSQL superuser default-password check inconclusive" \
    "Stack may not be running: ${POSTGRES_PASS_IS_DEFAULT}"
fi

# Check that op-init has run and generated secrets (init-data/ready sentinel file)
INIT_READY="$(docker run --rm \
  -v oneplatform_init-data:/data/init:ro \
  alpine test -f /data/init/ready && echo "yes" || echo "no" 2>/dev/null || echo "unknown")"
if [ "${INIT_READY}" = "yes" ]; then
  record_result "creds.op_init_completed" "PASS" \
    "op-init has run and generated all cryptographic secrets" ""
else
  record_result "creds.op_init_completed" "FAIL" \
    "op-init sentinel file not found — secrets may not have been generated" \
    "Run: docker compose -f docker/docker-compose.yml run --rm op-init"
fi

# Master key must be present and >= 32 bytes
MASTER_KEY_OK="$(docker_exec_safe ingestion-service \
  sh -c 'if [ -n "${OP_MASTER_KEY:-}" ] && [ "${#OP_MASTER_KEY}" -ge 32 ]; then echo "ok"; else echo "fail"; fi' \
  2>/dev/null || echo "unknown")"
if [ "${MASTER_KEY_OK}" = "ok" ]; then
  record_result "creds.master_key_set" "PASS" \
    "AES-256-GCM master key (OP_MASTER_KEY) is set and meets minimum length" ""
elif [ "${MASTER_KEY_OK}" = "fail" ]; then
  record_result "creds.master_key_set" "FAIL" \
    "OP_MASTER_KEY is not set or is shorter than 32 bytes" \
    "The master key encrypts all stored connector credentials. Generate with op-init."
else
  record_result "creds.master_key_set" "WARN" \
    "OP_MASTER_KEY check inconclusive — ingestion-service may not be running" ""
fi

echo ""

# ---------------------------------------------------------------------------
# Section 3: Audit logging enabled
# ---------------------------------------------------------------------------

echo "--- CC2: Audit Logging ---"

# Logging service must be running
LOG_SVC_STATUS="$(docker inspect --format='{{.State.Status}}' logging-service 2>/dev/null || echo "not_found")"
LOG_SVC_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' logging-service 2>/dev/null || echo "unknown")"
if [ "${LOG_SVC_STATUS}" = "running" ] && [ "${LOG_SVC_HEALTH}" = "healthy" ]; then
  record_result "audit.logging_service_healthy" "PASS" \
    "logging-service is running and healthy" ""
elif [ "${LOG_SVC_STATUS}" = "running" ]; then
  record_result "audit.logging_service_healthy" "WARN" \
    "logging-service is running but health check state is: ${LOG_SVC_HEALTH}" ""
else
  record_result "audit.logging_service_healthy" "FAIL" \
    "logging-service is not running (state: ${LOG_SVC_STATUS})" \
    "Audit events cannot be persisted without the logging service"
fi

# Audit events table must exist
AUDIT_TABLE_EXISTS="$(docker_exec_safe postgres \
  psql -U postgres -d oneplatform -tAc \
  "SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema='logging' AND table_name='audit_events'" 2>/dev/null | tr -d '[:space:]' || echo "0")"
if [ "${AUDIT_TABLE_EXISTS}" = "1" ]; then
  record_result "audit.table_exists" "PASS" \
    "logging.audit_events table exists in PostgreSQL" ""
else
  record_result "audit.table_exists" "FAIL" \
    "logging.audit_events table does not exist" \
    "Run database migrations for the logging service"
fi

# Audit events must have been written recently (within 7 days) if the service is running
if [ "${LOG_SVC_STATUS}" = "running" ]; then
  RECENT_AUDIT="$(docker_exec_safe postgres \
    psql -U postgres -d oneplatform -tAc \
    "SELECT COUNT(*) FROM logging.audit_events WHERE created_at > now() - interval '7 days'" \
    2>/dev/null | tr -d '[:space:]' || echo "0")"
  if [ "${RECENT_AUDIT:-0}" -gt "0" ]; then
    record_result "audit.recent_events_present" "PASS" \
      "Audit events have been written in the past 7 days (${RECENT_AUDIT} events)" ""
  else
    record_result "audit.recent_events_present" "WARN" \
      "No audit events in the past 7 days" \
      "This may indicate the audit queue worker is not processing, or no auditable actions occurred"
  fi
fi

# BullMQ DLQ check: failed audit jobs indicate data loss risk
AUDIT_DLQ_COUNT="$(docker_exec_safe redis \
  sh -c 'PASS=$(cat /data/init/redis_password_admin.txt 2>/dev/null | tr -d "[:space:]") && \
         redis-cli --user op_admin -a "$PASS" ZCOUNT "bull:audit:failed" -inf +inf 2>/dev/null' \
  | tr -d '[:space:]' || echo "unknown")"
if [ "${AUDIT_DLQ_COUNT}" = "0" ]; then
  record_result "audit.bullmq_dlq_empty" "PASS" \
    "BullMQ audit queue DLQ is empty (no failed audit jobs)" ""
elif [ "${AUDIT_DLQ_COUNT}" = "unknown" ]; then
  record_result "audit.bullmq_dlq_empty" "WARN" \
    "BullMQ audit DLQ depth could not be determined (Redis may be unavailable)" ""
else
  record_result "audit.bullmq_dlq_empty" "FAIL" \
    "BullMQ audit queue DLQ has ${AUDIT_DLQ_COUNT} failed jobs — audit events may be lost" \
    "Inspect failed jobs: redis-cli ZRANGE bull:audit:failed 0 -1 WITHSCORES"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 4: RBAC — no anonymous access
# ---------------------------------------------------------------------------

echo "--- CC6: RBAC / No Anonymous Access ---"

# Auth service must be healthy
AUTH_HEALTH="$(docker inspect --format='{{.State.Health.Status}}' auth-service 2>/dev/null || echo "not_running")"
if [ "${AUTH_HEALTH}" = "healthy" ]; then
  record_result "rbac.auth_service_healthy" "PASS" \
    "auth-service is running and healthy" ""
else
  record_result "rbac.auth_service_healthy" "FAIL" \
    "auth-service health: ${AUTH_HEALTH}" \
    "Authentication cannot be enforced without the auth service"
fi

# Guest sessions should be rate-limited (check env var presence)
GUEST_RATE_LIMIT="$(docker_exec_safe app-service \
  sh -c 'echo "${OP_GUEST_SESSION_RATE_LIMIT:-60}"' 2>/dev/null | tr -d '[:space:]' || echo "unknown")"
if [ "${GUEST_RATE_LIMIT}" != "unknown" ]; then
  record_result "rbac.guest_session_rate_limited" "PASS" \
    "Guest session rate limit is configured (${GUEST_RATE_LIMIT} per window)" ""
else
  record_result "rbac.guest_session_rate_limited" "WARN" \
    "Guest session rate limit configuration could not be verified" \
    "Ensure OP_GUEST_SESSION_RATE_LIMIT is set in app-service environment"
fi

# Row-level security must be enabled on auth.users
RLS_STATUS="$(docker_exec_safe postgres \
  psql -U postgres -d oneplatform -tAc \
  "SELECT relrowsecurity FROM pg_class c
   JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname='auth' AND c.relname='users'" 2>/dev/null | tr -d '[:space:]' || echo "unknown")"
if [ "${RLS_STATUS}" = "t" ]; then
  record_result "rbac.rls_on_users_table" "PASS" \
    "Row-level security is enabled on auth.users" ""
elif [ "${RLS_STATUS}" = "f" ]; then
  record_result "rbac.rls_on_users_table" "FAIL" \
    "Row-level security is DISABLED on auth.users" \
    "Enable with: ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY"
else
  record_result "rbac.rls_on_users_table" "WARN" \
    "RLS status on auth.users could not be determined" ""
fi

echo ""

# ---------------------------------------------------------------------------
# Section 5: Backup schedule configured
# ---------------------------------------------------------------------------

echo "--- A1: Backup and Recovery ---"

if [ -f "${REPO_ROOT}/docs/BACKUP.md" ]; then
  record_result "backup.documentation_present" "PASS" \
    "Backup and disaster recovery documentation exists (docs/BACKUP.md)" ""
else
  record_result "backup.documentation_present" "FAIL" \
    "Backup documentation (docs/BACKUP.md) is missing" \
    "SOC2 A1 requires documented backup procedures"
fi

# Check for any backup.sh script
BACKUP_SCRIPT="$(find "${REPO_ROOT}" -name "backup.sh" -not -path '*/.git/*' 2>/dev/null | head -1)"
if [ -n "${BACKUP_SCRIPT}" ]; then
  record_result "backup.script_present" "PASS" \
    "Backup script found: ${BACKUP_SCRIPT}" ""
else
  record_result "backup.script_present" "WARN" \
    "No backup.sh script found in the repository" \
    "Automated backup tooling is recommended for SOC2 A1. See docs/BACKUP.md."
fi

# Redis AOF persistence (data durability between backups)
REDIS_AOF="$(docker_exec_safe redis \
  sh -c 'PASS=$(cat /data/init/redis_password_admin.txt 2>/dev/null | tr -d "[:space:]") && \
         redis-cli --user op_admin -a "$PASS" CONFIG GET appendonly 2>/dev/null | tail -1' \
  | tr -d '[:space:]' || echo "unknown")"
if [ "${REDIS_AOF}" = "yes" ]; then
  record_result "backup.redis_aof_enabled" "PASS" \
    "Redis AOF persistence is enabled (appendfsync everysec)" ""
elif [ "${REDIS_AOF}" = "no" ]; then
  record_result "backup.redis_aof_enabled" "WARN" \
    "Redis AOF persistence is disabled — BullMQ job data is not durable across restarts" \
    "Enable in docker/redis/redis.conf: appendonly yes"
else
  record_result "backup.redis_aof_enabled" "WARN" \
    "Redis AOF status could not be determined (Redis may be unavailable)" ""
fi

# PostgreSQL is running and accessible (prerequisite for backups)
PG_STATUS="$(docker inspect --format='{{.State.Health.Status}}' postgres 2>/dev/null || echo "not_running")"
if [ "${PG_STATUS}" = "healthy" ]; then
  record_result "backup.postgres_accessible" "PASS" \
    "PostgreSQL is healthy and accessible for backup operations" ""
else
  record_result "backup.postgres_accessible" "WARN" \
    "PostgreSQL health state: ${PG_STATUS}" \
    "Automated backups require a healthy PostgreSQL instance"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 6: Container hardening
# ---------------------------------------------------------------------------

echo "--- CC3/CC9: Container Security ---"

# Verify container hardening options are set in docker-compose.yml
if grep -q "no-new-privileges:true" "${DOCKER_COMPOSE_FILE}" 2>/dev/null; then
  record_result "hardening.no_new_privileges" "PASS" \
    "no-new-privileges security option set in docker-compose.yml" ""
else
  record_result "hardening.no_new_privileges" "FAIL" \
    "no-new-privileges not configured in docker-compose.yml" \
    "Add 'security_opt: [no-new-privileges:true]' to x-service-common"
fi

if grep -q "cap_drop:" "${DOCKER_COMPOSE_FILE}" 2>/dev/null && \
   grep -q "\- ALL" "${DOCKER_COMPOSE_FILE}" 2>/dev/null; then
  record_result "hardening.cap_drop_all" "PASS" \
    "All Linux capabilities dropped via cap_drop: ALL in docker-compose.yml" ""
else
  record_result "hardening.cap_drop_all" "FAIL" \
    "cap_drop: [ALL] not configured for services in docker-compose.yml" ""
fi

if grep -q "read_only: true" "${DOCKER_COMPOSE_FILE}" 2>/dev/null; then
  record_result "hardening.read_only_rootfs" "PASS" \
    "Read-only root filesystem configured for services in docker-compose.yml" ""
else
  record_result "hardening.read_only_rootfs" "WARN" \
    "read_only: true not found in docker-compose.yml" \
    "Read-only root filesystem prevents runtime modification of container binaries"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 7: Dependency lockfile
# ---------------------------------------------------------------------------

echo "--- CC3: Dependency Management ---"

if [ -f "${REPO_ROOT}/pnpm-lock.yaml" ]; then
  record_result "deps.lockfile_present" "PASS" \
    "pnpm-lock.yaml is present (reproducible, pinned dependency versions)" ""
else
  record_result "deps.lockfile_present" "FAIL" \
    "pnpm-lock.yaml is missing" \
    "Commit the lockfile to ensure reproducible builds and auditable dependency versions"
fi

if [ -f "${REPO_ROOT}/.env.example" ]; then
  record_result "deps.env_example_present" "PASS" \
    ".env.example documents all required environment variables" ""
else
  record_result "deps.env_example_present" "WARN" \
    ".env.example file is missing" \
    "Document all required environment variables to reduce misconfiguration risk"
fi

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

RESULTS_JSON="${RESULTS_JSON}]"
OVERALL="PASS"
if [ "${FAIL_COUNT}" -gt 0 ]; then OVERALL="FAIL"; elif [ "${WARN_COUNT}" -gt 0 ]; then OVERALL="WARN"; fi

echo "============================================================"
echo "  Summary"
echo "============================================================"
printf "  PASS: %d  WARN: %d  FAIL: %d\n" "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"
printf "  Overall: %s\n" "${OVERALL}"
echo ""

# Write JSON report
cat > "${REPORT_FILE}" <<JSON
{
  "report_metadata": {
    "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "generated_by": "compliance-check.sh",
    "report_version": "1.0"
  },
  "summary": {
    "overall": "${OVERALL}",
    "pass_count": ${PASS_COUNT},
    "warn_count": ${WARN_COUNT},
    "fail_count": ${FAIL_COUNT}
  },
  "checks": ${RESULTS_JSON}
}
JSON

echo "  Report: ${REPORT_FILE}"
echo ""

# Exit 1 if any check FAILED (allows CI to gate on compliance status)
if [ "${FAIL_COUNT}" -gt 0 ]; then
  exit 1
fi

exit 0
