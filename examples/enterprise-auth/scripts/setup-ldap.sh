#!/usr/bin/env bash
# --------------------------------------------------------------------------
# setup-ldap.sh — Configure an LDAP/Active Directory provider for OnePlatform
#
# This script registers an LDAP authentication provider with OnePlatform
# using the configuration in configs/ldap-provider.json. It validates
# prerequisites, tests LDAP connectivity, and registers the provider
# with the Auth Service.
#
# Usage:
#   ./scripts/setup-ldap.sh [options]
#
# Options:
#   --platform-url URL      OnePlatform base URL (default: http://localhost:8080)
#   --api-key KEY           Platform admin API key (or set OP_API_KEY env var)
#   --tenant-id ID          Target tenant ID (or set OP_TENANT_ID env var)
#   --config PATH           Path to LDAP config file (default: configs/ldap-provider.json)
#   --bind-password PASS    LDAP bind password (or set LDAP_BIND_PASSWORD env var)
#   --skip-connectivity     Skip the LDAP connectivity test
#   --dry-run               Validate configuration without registering the provider
#   --help                  Show this help message
#
# Prerequisites:
#   - op CLI installed (npm install -g @oneplatform/cli)
#   - curl and jq available on PATH
#   - ldapsearch available on PATH (from ldap-utils / openldap-clients)
#   - Platform admin API key with admin scope
#   - Active Directory configured with the required OUs and groups
# --------------------------------------------------------------------------

set -euo pipefail

# --------------------------------------------------------------------------
# Defaults
# --------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM_URL="${OP_PLATFORM_URL:-http://localhost:8080}"
API_KEY="${OP_API_KEY:-}"
TENANT_ID="${OP_TENANT_ID:-}"
CONFIG_FILE="$PROJECT_DIR/configs/ldap-provider.json"
BIND_PASSWORD="${LDAP_BIND_PASSWORD:-}"
SKIP_CONNECTIVITY=false
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
  head -n 26 "$0" | tail -n +3 | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform-url)      PLATFORM_URL="$2"; shift 2 ;;
    --api-key)           API_KEY="$2"; shift 2 ;;
    --tenant-id)         TENANT_ID="$2"; shift 2 ;;
    --config)            CONFIG_FILE="$2"; shift 2 ;;
    --bind-password)     BIND_PASSWORD="$2"; shift 2 ;;
    --skip-connectivity) SKIP_CONNECTIVITY=true; shift ;;
    --dry-run)           DRY_RUN=true; shift ;;
    --help|-h)           usage ;;
    *)                   log_error "Unknown option: $1"; usage ;;
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

if [[ "$SKIP_CONNECTIVITY" == "false" ]] && ! command -v ldapsearch &>/dev/null; then
  log_warn "'ldapsearch' is not installed. Install ldap-utils (Debian/Ubuntu) or openldap-clients (RHEL/CentOS)."
  log_warn "Skipping LDAP connectivity test. Pass --skip-connectivity to suppress this warning."
  SKIP_CONNECTIVITY=true
fi

if [[ -z "$API_KEY" ]]; then
  log_error "API key is required. Set OP_API_KEY or pass --api-key."
  exit 1
fi

if [[ -z "$TENANT_ID" ]]; then
  log_error "Tenant ID is required. Set OP_TENANT_ID or pass --tenant-id."
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  log_error "Config file not found: $CONFIG_FILE"
  exit 1
fi
log_ok "Config file found: $CONFIG_FILE"

# --------------------------------------------------------------------------
# Parse and validate configuration
# --------------------------------------------------------------------------

log_info "Parsing LDAP provider configuration..."

LDAP_URL=$(jq -r '.config.url' "$CONFIG_FILE")
BASE_DN=$(jq -r '.config.baseDN' "$CONFIG_FILE")
BIND_DN=$(jq -r '.config.bindDN' "$CONFIG_FILE")
PROVIDER_ID=$(jq -r '.providerId' "$CONFIG_FILE")
DISPLAY_NAME=$(jq -r '.displayName' "$CONFIG_FILE")
USER_SEARCH_BASE=$(jq -r '.config.userSearchBase' "$CONFIG_FILE")
USER_SEARCH_FILTER=$(jq -r '.config.userSearchFilter' "$CONFIG_FILE")
USE_TLS=$(jq -r '.config.useTLS // true' "$CONFIG_FILE")

if [[ -z "$LDAP_URL" || "$LDAP_URL" == "null" ]]; then
  log_error "LDAP URL is missing from the configuration."
  exit 1
fi

if [[ -z "$BASE_DN" || "$BASE_DN" == "null" ]]; then
  log_error "baseDN is missing from the configuration."
  exit 1
fi

if [[ -z "$BIND_DN" || "$BIND_DN" == "null" ]]; then
  log_error "bindDN is missing from the configuration."
  exit 1
fi

if [[ -z "$BIND_PASSWORD" ]]; then
  log_error "Bind password is required. Set LDAP_BIND_PASSWORD or pass --bind-password."
  exit 1
fi

log_ok "Provider ID:       $PROVIDER_ID"
log_ok "Display name:      $DISPLAY_NAME"
log_ok "LDAP URL:          $LDAP_URL"
log_ok "Base DN:           $BASE_DN"
log_ok "Bind DN:           $BIND_DN"
log_ok "User search base:  $USER_SEARCH_BASE"
log_ok "TLS enabled:       $USE_TLS"

# --------------------------------------------------------------------------
# Validate TLS settings
# --------------------------------------------------------------------------

if [[ "$LDAP_URL" == ldap://* && "$USE_TLS" == "false" ]]; then
  log_warn "LDAP URL uses unencrypted ldap:// and TLS is disabled."
  log_warn "This is NOT recommended for production. Use ldaps:// (port 636) instead."
fi

if [[ "$LDAP_URL" == ldaps://* ]]; then
  log_ok "LDAP connection uses TLS (ldaps://)."
fi

# --------------------------------------------------------------------------
# Test LDAP connectivity
# --------------------------------------------------------------------------

if [[ "$SKIP_CONNECTIVITY" == "false" ]]; then
  log_info "Testing LDAP connectivity..."

  # Extract host and port from the LDAP URL
  LDAP_HOST=$(echo "$LDAP_URL" | sed -E 's|ldaps?://([^:/]+).*|\1|')
  LDAP_PORT=$(echo "$LDAP_URL" | sed -E 's|ldaps?://[^:]+:([0-9]+).*|\1|')

  if [[ -z "$LDAP_PORT" || "$LDAP_PORT" == "$LDAP_URL" ]]; then
    if [[ "$LDAP_URL" == ldaps://* ]]; then
      LDAP_PORT=636
    else
      LDAP_PORT=389
    fi
  fi

  # Test bind operation with ldapsearch
  LDAP_SEARCH_ARGS=(-x -H "$LDAP_URL" -D "$BIND_DN" -w "$BIND_PASSWORD" -b "$BASE_DN" -s base "(objectClass=*)" dn)

  if ldapsearch "${LDAP_SEARCH_ARGS[@]}" &>/dev/null; then
    log_ok "LDAP bind successful. Service account can authenticate."
  else
    LDAP_EXIT=$?
    log_error "LDAP bind failed (exit code $LDAP_EXIT)."
    log_error "Possible causes:"
    log_error "  - Incorrect bind DN or password"
    log_error "  - LDAP server is unreachable at $LDAP_HOST:$LDAP_PORT"
    log_error "  - TLS certificate validation failed (check CA trust store)"
    log_error "  - The service account is disabled or locked out"

    if [[ "$DRY_RUN" == "true" ]]; then
      log_warn "Continuing in dry-run mode despite connectivity failure."
    else
      exit 1
    fi
  fi

  # Test user search
  TEST_SEARCH_FILTER="(&(objectClass=user)(sAMAccountName=*))"
  SEARCH_RESULT=$(ldapsearch -x -H "$LDAP_URL" -D "$BIND_DN" -w "$BIND_PASSWORD" \
    -b "$USER_SEARCH_BASE,$BASE_DN" -s sub "$TEST_SEARCH_FILTER" dn \
    -z 5 2>/dev/null | grep -c "^dn:" || echo "0")

  if [[ "$SEARCH_RESULT" -gt 0 ]]; then
    log_ok "User search returned $SEARCH_RESULT results (limited to 5). Directory is populated."
  else
    log_warn "User search returned 0 results. Verify that users exist in $USER_SEARCH_BASE,$BASE_DN"
  fi
else
  log_info "Skipping LDAP connectivity test (--skip-connectivity)."
fi

# --------------------------------------------------------------------------
# Validate group mapping
# --------------------------------------------------------------------------

log_info "Validating group mapping..."

GROUP_MAPPING_COUNT=$(jq '.config.groupMapping | length' "$CONFIG_FILE")
log_ok "Group mappings configured: $GROUP_MAPPING_COUNT"

echo ""
echo "  AD Group                     -> Platform Role"
echo "  ----------------------------    ----------------------"
jq -r '.config.groupMapping | to_entries[] | "  \(.key)  ->  \(.value)"' "$CONFIG_FILE"
echo ""

# --------------------------------------------------------------------------
# Dry run exit
# --------------------------------------------------------------------------

if [[ "$DRY_RUN" == "true" ]]; then
  log_info "Dry run complete. No changes were made."
  exit 0
fi

# --------------------------------------------------------------------------
# Register the provider with OnePlatform
# --------------------------------------------------------------------------

log_info "Registering LDAP provider with OnePlatform..."

REGISTRATION_PAYLOAD=$(jq -n \
  --arg providerId "$PROVIDER_ID" \
  --arg displayName "$DISPLAY_NAME" \
  --arg tenantId "$TENANT_ID" \
  --arg bindPassword "$BIND_PASSWORD" \
  --slurpfile config "$CONFIG_FILE" \
  '{
    providerId: $providerId,
    providerType: "ldap",
    displayName: $displayName,
    enabled: true,
    tenantId: $tenantId,
    config: $config[0].config,
    credentials: {
      ldap_bind_password: $bindPassword
    }
  }')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$REGISTRATION_PAYLOAD" \
  "$PLATFORM_URL/api/v1/auth/providers" \
  2>/dev/null)

HTTP_BODY=$(echo "$RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n 1)

if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "200" ]]; then
  log_ok "LDAP provider registered successfully."
  echo ""
  echo "  Provider ID:    $PROVIDER_ID"
  echo "  Display Name:   $DISPLAY_NAME"
  echo "  Tenant ID:      $TENANT_ID"
  echo "  Status:         Enabled"
  echo ""
elif [[ "$HTTP_CODE" == "409" ]]; then
  log_warn "Provider '$PROVIDER_ID' already exists. Updating configuration..."

  UPDATE_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$REGISTRATION_PAYLOAD" \
    "$PLATFORM_URL/api/v1/auth/providers/$PROVIDER_ID" \
    2>/dev/null)

  UPDATE_CODE=$(echo "$UPDATE_RESPONSE" | tail -n 1)

  if [[ "$UPDATE_CODE" == "200" ]]; then
    log_ok "LDAP provider updated successfully."
  else
    UPDATE_BODY=$(echo "$UPDATE_RESPONSE" | head -n -1)
    log_error "Failed to update provider (HTTP $UPDATE_CODE):"
    echo "$UPDATE_BODY" | jq . 2>/dev/null || echo "$UPDATE_BODY"
    exit 1
  fi
else
  log_error "Failed to register LDAP provider (HTTP $HTTP_CODE):"
  echo "$HTTP_BODY" | jq . 2>/dev/null || echo "$HTTP_BODY"
  exit 1
fi

# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------

log_info "Verifying provider registration..."

VERIFY_RESPONSE=$(curl -s \
  -H "Authorization: Bearer $API_KEY" \
  "$PLATFORM_URL/api/v1/auth/providers/$PROVIDER_ID" \
  2>/dev/null)

VERIFY_STATUS=$(echo "$VERIFY_RESPONSE" | jq -r '.enabled // false')
if [[ "$VERIFY_STATUS" == "true" ]]; then
  log_ok "Provider is registered and enabled."
else
  log_warn "Provider was registered but may not be enabled. Check the platform UI."
fi

echo ""
log_ok "LDAP setup complete."
echo ""
echo "  Next steps:"
echo "    1. Verify the Active Directory groups exist and users are members"
echo "    2. Test LDAP login via the platform UI at: $PLATFORM_URL/auth/login?tenantId=$TENANT_ID"
echo "       Or with an API key: op auth login --platform $PLATFORM_URL --key <api-key>"
echo "    3. Verify role mapping: op auth whoami"
echo "    4. If using multiple tenants, run this script again with a different --tenant-id"
echo ""
