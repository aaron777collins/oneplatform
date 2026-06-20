#!/usr/bin/env bash
# --------------------------------------------------------------------------
# create-tenant.sh — Create and configure tenants in OnePlatform
#
# This script reads tenant definitions from configs/tenant-config.json and
# creates each tenant in OnePlatform with its authentication, branding,
# security, and session settings.
#
# Usage:
#   ./scripts/create-tenant.sh [options]
#
# Options:
#   --platform-url URL    OnePlatform base URL (default: http://localhost:8080)
#   --api-key KEY         Platform admin API key (or set OP_API_KEY env var)
#   --config PATH         Path to tenant config file (default: configs/tenant-config.json)
#   --tenant NAME         Create only the named tenant (by slug). Omit to create all.
#   --dry-run             Validate configuration without creating tenants
#   --help                Show this help message
#
# Prerequisites:
#   - op CLI installed (npm install -g @oneplatform/cli)
#   - curl and jq available on PATH
#   - Platform admin API key with admin scope
#   - RBAC roles created (run: op role create --name <role> --permissions <perm,...>)
# --------------------------------------------------------------------------

set -euo pipefail

# --------------------------------------------------------------------------
# Defaults
# --------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM_URL="${OP_PLATFORM_URL:-http://localhost:8080}"
API_KEY="${OP_API_KEY:-}"
CONFIG_FILE="$PROJECT_DIR/configs/tenant-config.json"
TENANT_FILTER=""
DRY_RUN=false

# --------------------------------------------------------------------------
# Color output helpers
# --------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------

usage() {
  head -n 22 "$0" | tail -n +3 | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform-url) PLATFORM_URL="$2"; shift 2 ;;
    --api-key)      API_KEY="$2"; shift 2 ;;
    --config)       CONFIG_FILE="$2"; shift 2 ;;
    --tenant)       TENANT_FILTER="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --help|-h)      usage ;;
    *)              log_error "Unknown option: $1"; usage ;;
  esac
done

# --------------------------------------------------------------------------
# Prerequisite checks
# --------------------------------------------------------------------------

log_info "Checking prerequisites..."

for cmd in curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "'$cmd' is required but not found on PATH."
    exit 1
  fi
done
log_ok "curl and jq are available."

if [[ -z "$API_KEY" ]]; then
  log_error "API key is required. Set OP_API_KEY or pass --api-key."
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  log_error "Config file not found: $CONFIG_FILE"
  exit 1
fi
log_ok "Config file found: $CONFIG_FILE"

# --------------------------------------------------------------------------
# Validate configuration
# --------------------------------------------------------------------------

log_info "Validating tenant configuration..."

TENANT_COUNT=$(jq '.tenants | length' "$CONFIG_FILE")
if [[ "$TENANT_COUNT" -eq 0 ]]; then
  log_error "No tenants defined in $CONFIG_FILE"
  exit 1
fi
log_ok "Found $TENANT_COUNT tenant(s) in configuration."

# --------------------------------------------------------------------------
# Platform connectivity check
# --------------------------------------------------------------------------

log_info "Checking platform connectivity at $PLATFORM_URL..."

HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  "$PLATFORM_URL/api/v1/health" 2>/dev/null || echo "000")

if [[ "$HEALTH_STATUS" == "200" ]]; then
  log_ok "Platform is reachable and healthy."
elif [[ "$HEALTH_STATUS" == "000" ]]; then
  log_error "Cannot reach platform at $PLATFORM_URL. Is it running?"
  if [[ "$DRY_RUN" == "false" ]]; then
    exit 1
  fi
  log_warn "Continuing in dry-run mode despite connectivity failure."
else
  log_warn "Platform returned HTTP $HEALTH_STATUS (expected 200)."
fi

# --------------------------------------------------------------------------
# Process tenants
# --------------------------------------------------------------------------

CREATED=0
SKIPPED=0
FAILED=0

for i in $(seq 0 $((TENANT_COUNT - 1))); do
  TENANT_NAME=$(jq -r ".tenants[$i].name" "$CONFIG_FILE")
  TENANT_SLUG=$(jq -r ".tenants[$i].slug" "$CONFIG_FILE")

  # Apply filter if specified
  if [[ -n "$TENANT_FILTER" && "$TENANT_SLUG" != "$TENANT_FILTER" ]]; then
    continue
  fi

  echo ""
  log_info "Processing tenant: $TENANT_NAME ($TENANT_SLUG)"

  # Validate required fields
  if [[ -z "$TENANT_NAME" || "$TENANT_NAME" == "null" ]]; then
    log_error "  Tenant at index $i is missing a name."
    FAILED=$((FAILED + 1))
    continue
  fi

  if [[ -z "$TENANT_SLUG" || "$TENANT_SLUG" == "null" ]]; then
    log_error "  Tenant at index $i is missing a slug."
    FAILED=$((FAILED + 1))
    continue
  fi

  # Extract tenant settings
  AUTH_PROVIDERS=$(jq -r ".tenants[$i].settings.authProviders // [] | join(\", \")" "$CONFIG_FILE")
  DEFAULT_AUTH=$(jq -r ".tenants[$i].settings.defaultAuthProvider // \"none\"" "$CONFIG_FILE")
  MFA_REQUIRED=$(jq -r ".tenants[$i].settings.security.mfaRequired // false" "$CONFIG_FILE")
  SESSION_TTL=$(jq -r ".tenants[$i].settings.session.accessTokenTtlSeconds // 900" "$CONFIG_FILE")
  MAX_SESSIONS=$(jq -r ".tenants[$i].settings.session.maxConcurrentSessions // 5" "$CONFIG_FILE")

  echo "  Name:               $TENANT_NAME"
  echo "  Slug:               $TENANT_SLUG"
  echo "  Auth providers:     $AUTH_PROVIDERS"
  echo "  Default provider:   $DEFAULT_AUTH"
  echo "  MFA required:       $MFA_REQUIRED"
  echo "  Access token TTL:   ${SESSION_TTL}s"
  echo "  Max sessions:       $MAX_SESSIONS"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "  Dry run -- skipping creation."
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Build the tenant creation payload
  TENANT_PAYLOAD=$(jq ".tenants[$i]" "$CONFIG_FILE")

  # Merge default settings for any fields not specified
  DEFAULT_SETTINGS=$(jq '.defaultTenantSettings // {}' "$CONFIG_FILE")
  TENANT_PAYLOAD=$(echo "$TENANT_PAYLOAD" | jq --argjson defaults "$DEFAULT_SETTINGS" \
    '.settings = ($defaults * .settings)')

  # Create the tenant
  RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$TENANT_PAYLOAD" \
    "$PLATFORM_URL/api/v1/tenants" \
    2>/dev/null)

  HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
  HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

  if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "200" ]]; then
    TENANT_ID=$(echo "$HTTP_BODY" | jq -r '.id // .tenantId // "unknown"')
    log_ok "  Tenant created: $TENANT_NAME (ID: $TENANT_ID)"
    CREATED=$((CREATED + 1))
  elif [[ "$HTTP_CODE" == "409" ]]; then
    log_warn "  Tenant '$TENANT_SLUG' already exists. Updating settings..."

    UPDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X PATCH \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"settings\": $(echo "$TENANT_PAYLOAD" | jq '.settings')}" \
      "$PLATFORM_URL/api/v1/tenants/$TENANT_SLUG" \
      2>/dev/null)

    UPDATE_CODE=$(echo "$UPDATE_RESPONSE" | tail -n 1)

    if [[ "$UPDATE_CODE" == "200" ]]; then
      log_ok "  Tenant settings updated."
      CREATED=$((CREATED + 1))
    else
      UPDATE_BODY=$(echo "$UPDATE_RESPONSE" | head -n -1)
      log_error "  Failed to update tenant (HTTP $UPDATE_CODE):"
      echo "    $UPDATE_BODY" | jq . 2>/dev/null || echo "    $UPDATE_BODY"
      FAILED=$((FAILED + 1))
    fi
  else
    log_error "  Failed to create tenant (HTTP $HTTP_CODE):"
    echo "    $HTTP_BODY" | jq . 2>/dev/null || echo "    $HTTP_BODY"
    FAILED=$((FAILED + 1))
  fi
done

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

echo ""
echo "  ========================================"
echo "  Tenant Setup Summary"
echo "  ========================================"
echo "  Created/Updated:  $CREATED"
echo "  Skipped:          $SKIPPED"
echo "  Failed:           $FAILED"
echo "  ========================================"
echo ""

if [[ "$FAILED" -gt 0 ]]; then
  log_error "Some tenants failed. Review the errors above."
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  log_info "Dry run complete. No changes were made."
else
  log_ok "All tenants created successfully."
  echo ""
  echo "  Next steps:"
  echo "    1. Set up auth providers for each tenant:"
  echo "       ./scripts/setup-oidc.sh --tenant-id <slug>"
  echo "       ./scripts/setup-ldap.sh --tenant-id <slug>"
  echo "    2. Create API keys for service accounts:"
  echo "       op auth generate-key --name 'CI Pipeline' --scopes 'pipelines:manage,data:read' --expires 2027-01-01"
  echo "       (See configs/api-keys.json for the keys you need to create)"
  echo "    3. Configure audit and security settings via the platform admin UI or REST API:"
  echo "       POST $PLATFORM_URL/api/v1/admin/audit-policy"
  echo "       (See configs/audit-policy.json for the policy definition)"
  echo ""
fi
