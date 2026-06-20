#!/usr/bin/env bash
# --------------------------------------------------------------------------
# setup-oidc.sh — Configure an OIDC provider (Keycloak) for OnePlatform
#
# This script registers an OIDC authentication provider with OnePlatform
# using the configuration in configs/oidc-provider.json. It validates
# prerequisites, tests connectivity to the Keycloak issuer, and registers
# the provider with the Auth Service.
#
# Usage:
#   ./scripts/setup-oidc.sh [options]
#
# Options:
#   --platform-url URL      OnePlatform base URL (default: http://localhost:8080)
#   --api-key KEY           Platform admin API key (or set OP_API_KEY env var)
#   --tenant-id ID          Target tenant ID (or set OP_TENANT_ID env var)
#   --config PATH           Path to OIDC config file (default: configs/oidc-provider.json)
#   --client-secret SECRET  Keycloak client secret (or set KEYCLOAK_CLIENT_SECRET env var)
#   --dry-run               Validate configuration without registering the provider
#   --help                  Show this help message
#
# Prerequisites:
#   - op CLI installed (npm install -g @oneplatform/cli)
#   - curl and jq available on PATH
#   - Platform admin API key with admin scope
#   - Keycloak realm configured with the correct client and role mappings
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
CONFIG_FILE="$PROJECT_DIR/configs/oidc-provider.json"
CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-}"
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
    --platform-url)  PLATFORM_URL="$2"; shift 2 ;;
    --api-key)       API_KEY="$2"; shift 2 ;;
    --tenant-id)     TENANT_ID="$2"; shift 2 ;;
    --config)        CONFIG_FILE="$2"; shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=true; shift ;;
    --help|-h)       usage ;;
    *)               log_error "Unknown option: $1"; usage ;;
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

log_info "Parsing OIDC provider configuration..."

ISSUER_URL=$(jq -r '.config.issuerUrl' "$CONFIG_FILE")
CLIENT_ID=$(jq -r '.config.clientId' "$CONFIG_FILE")
PROVIDER_ID=$(jq -r '.providerId' "$CONFIG_FILE")
DISPLAY_NAME=$(jq -r '.displayName' "$CONFIG_FILE")
SCOPES=$(jq -r '.config.scopes | join(" ")' "$CONFIG_FILE")

if [[ -z "$ISSUER_URL" || "$ISSUER_URL" == "null" ]]; then
  log_error "issuerUrl is missing from the configuration."
  exit 1
fi

if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "null" ]]; then
  log_error "clientId is missing from the configuration."
  exit 1
fi

if [[ -z "$CLIENT_SECRET" ]]; then
  log_error "Client secret is required. Set KEYCLOAK_CLIENT_SECRET or pass --client-secret."
  exit 1
fi

log_ok "Provider ID:   $PROVIDER_ID"
log_ok "Display name:  $DISPLAY_NAME"
log_ok "Issuer URL:    $ISSUER_URL"
log_ok "Client ID:     $CLIENT_ID"
log_ok "Scopes:        $SCOPES"

# --------------------------------------------------------------------------
# Test OIDC discovery endpoint connectivity
# --------------------------------------------------------------------------

DISCOVERY_URL="${ISSUER_URL%/}/.well-known/openid-configuration"
log_info "Testing OIDC discovery endpoint: $DISCOVERY_URL"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$DISCOVERY_URL" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" == "200" ]]; then
  log_ok "OIDC discovery endpoint is reachable (HTTP $HTTP_STATUS)."

  # Validate required fields in the discovery document
  DISCOVERY_DOC=$(curl -s --max-time 10 "$DISCOVERY_URL")
  DISCOVERED_ISSUER=$(echo "$DISCOVERY_DOC" | jq -r '.issuer // empty')
  TOKEN_ENDPOINT=$(echo "$DISCOVERY_DOC" | jq -r '.token_endpoint // empty')
  JWKS_URI=$(echo "$DISCOVERY_DOC" | jq -r '.jwks_uri // empty')

  if [[ -z "$DISCOVERED_ISSUER" ]]; then
    log_error "Discovery document is missing the 'issuer' field."
    exit 1
  fi

  # Normalize trailing slashes for comparison
  NORM_CONFIGURED="${ISSUER_URL%/}"
  NORM_DISCOVERED="${DISCOVERED_ISSUER%/}"
  if [[ "$NORM_CONFIGURED" != "$NORM_DISCOVERED" ]]; then
    log_error "Issuer mismatch: configured '$ISSUER_URL' but discovery reports '$DISCOVERED_ISSUER'."
    log_error "This may indicate a misconfigured issuerUrl."
    exit 1
  fi
  log_ok "Issuer URL matches discovery document."

  if [[ -z "$TOKEN_ENDPOINT" ]]; then
    log_warn "Discovery document is missing 'token_endpoint'. Authentication will fail."
  fi

  if [[ -z "$JWKS_URI" ]]; then
    log_warn "Discovery document is missing 'jwks_uri'. Token validation will fail."
  fi

elif [[ "$HTTP_STATUS" == "000" ]]; then
  log_warn "Cannot reach OIDC discovery endpoint. Network error or timeout."
  log_warn "The provider will be registered but may fail at first login."
else
  log_warn "OIDC discovery endpoint returned HTTP $HTTP_STATUS."
  log_warn "Expected HTTP 200. The provider may not work correctly."
fi

# --------------------------------------------------------------------------
# Validate role mapping
# --------------------------------------------------------------------------

log_info "Validating role mapping..."

ROLE_CLAIM_PATH=$(jq -r '.config.roleClaimPath // empty' "$CONFIG_FILE")
ROLE_MAPPING_COUNT=$(jq '.config.roleMapping | length' "$CONFIG_FILE")

if [[ -n "$ROLE_CLAIM_PATH" ]]; then
  log_ok "Role claim path: $ROLE_CLAIM_PATH"
  log_ok "Role mappings configured: $ROLE_MAPPING_COUNT"

  # Show the mapping table
  echo ""
  echo "  IdP Role              -> Platform Role"
  echo "  ----------------------   ----------------------"
  jq -r '.config.roleMapping | to_entries[] | "  \(.key)  ->  \(.value)"' "$CONFIG_FILE"
  echo ""
else
  log_warn "No roleClaimPath configured. Users will not be assigned roles from the IdP."
  log_warn "You will need to assign roles manually via the platform UI or API."
fi

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

log_info "Registering OIDC provider with OnePlatform..."

# Build the registration payload
REGISTRATION_PAYLOAD=$(jq -n \
  --arg providerId "$PROVIDER_ID" \
  --arg displayName "$DISPLAY_NAME" \
  --arg tenantId "$TENANT_ID" \
  --arg clientSecret "$CLIENT_SECRET" \
  --slurpfile config "$CONFIG_FILE" \
  '{
    providerId: $providerId,
    providerType: "oidc",
    displayName: $displayName,
    enabled: true,
    tenantId: $tenantId,
    config: $config[0].config,
    credentials: {
      clientSecret: $clientSecret
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
  log_ok "OIDC provider registered successfully."
  echo ""
  echo "  Provider ID:    $PROVIDER_ID"
  echo "  Display Name:   $DISPLAY_NAME"
  echo "  Tenant ID:      $TENANT_ID"
  echo "  Status:         Enabled"
  echo ""
  log_info "Users can now log in via: $PLATFORM_URL/auth/oauth/authorize?tenantId=$TENANT_ID"
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
    log_ok "OIDC provider updated successfully."
  else
    UPDATE_BODY=$(echo "$UPDATE_RESPONSE" | head -n -1)
    log_error "Failed to update provider (HTTP $UPDATE_CODE):"
    echo "$UPDATE_BODY" | jq . 2>/dev/null || echo "$UPDATE_BODY"
    exit 1
  fi
else
  log_error "Failed to register OIDC provider (HTTP $HTTP_CODE):"
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
log_ok "OIDC setup complete."
echo ""
echo "  Next steps:"
echo "    1. Verify Keycloak realm and client configuration (see configs/oidc-provider.json keycloakSetup section)"
echo "    2. Create a test user in Keycloak with the required roles"
echo "    3. Test login: op auth login --provider $PROVIDER_ID --tenant $TENANT_ID"
echo "    4. Verify role mapping: op auth whoami"
echo ""
