#!/usr/bin/env bash
# --------------------------------------------------------------------------
# cleanup.sh — Remove all demo data from OnePlatform
#
# This script removes all resources created by the seed script, in reverse
# dependency order:
#   1. Apps
#   2. Pipelines
#   3. Entity types (ontology)
#   4. Connectors
#   5. Users
#   6. Tenants
#
# Usage:
#   ./scripts/cleanup.sh [options]
#
# Options:
#   --platform-url URL    OnePlatform base URL (default from .env or https://localhost)
#   --api-key KEY         Admin API key (default from .env or OP_API_KEY)
#   --confirm             Skip the confirmation prompt
#   --help                Show this help message
#
# Prerequisites:
#   - curl and jq available on PATH
#   - Admin API key with full scopes
# --------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load .env if present
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$PROJECT_DIR/.env"
  set +a
fi

PLATFORM_URL="${OP_BASE_URL:-https://localhost}"
API_KEY="${OP_API_KEY:-}"
CONFIRM=false

# --------------------------------------------------------------------------
# Color output helpers
# --------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------

usage() {
  head -n 20 "$0" | tail -n +3 | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform-url) PLATFORM_URL="$2"; shift 2 ;;
    --api-key)      API_KEY="$2"; shift 2 ;;
    --confirm)      CONFIRM=true; shift ;;
    --help|-h)      usage ;;
    *)              log_error "Unknown option: $1"; usage ;;
  esac
done

# --------------------------------------------------------------------------
# Prerequisite checks
# --------------------------------------------------------------------------

for cmd in curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "'$cmd' is required but not found on PATH."
    exit 1
  fi
done

if [[ -z "$API_KEY" ]]; then
  log_error "API key is required. Set OP_API_KEY in .env or pass --api-key."
  exit 1
fi

# --------------------------------------------------------------------------
# Confirmation
# --------------------------------------------------------------------------

if [[ "$CONFIRM" != "true" ]]; then
  echo ""
  echo -e "${YELLOW}WARNING: This will delete ALL demo data from ${PLATFORM_URL}${NC}"
  echo ""
  echo "  Resources to be deleted:"
  echo "    - All apps created by the seed script"
  echo "    - All pipelines created by the seed script"
  echo "    - All entity types created by the seed script"
  echo "    - All connectors created by the seed script"
  echo "    - All users created by the seed script"
  echo "    - Both demo tenants (Acme Corp, Widget Co)"
  echo ""
  read -r -p "  Type 'yes' to confirm: " response
  if [[ "$response" != "yes" ]]; then
    log_info "Cleanup cancelled."
    exit 0
  fi
fi

# --------------------------------------------------------------------------
# Helper: delete a resource by API path
# --------------------------------------------------------------------------

delete_resource() {
  local resource_type="$1"
  local resource_id="$2"
  local api_path="$3"

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X DELETE \
    -H "Authorization: Bearer $API_KEY" \
    "$PLATFORM_URL$api_path" \
    2>/dev/null)

  local http_code
  http_code=$(echo "$response" | tail -n 1)

  if [[ "$http_code" == "200" || "$http_code" == "204" ]]; then
    log_ok "Deleted $resource_type: $resource_id"
  elif [[ "$http_code" == "404" ]]; then
    log_warn "$resource_type not found: $resource_id (already deleted?)"
  else
    local body
    body=$(echo "$response" | head -n -1)
    log_error "Failed to delete $resource_type $resource_id (HTTP $http_code): $body"
  fi
}

# --------------------------------------------------------------------------
# Cleanup in reverse dependency order
# --------------------------------------------------------------------------

echo ""
log_info "Starting cleanup..."

# 1. Delete apps
log_info "Deleting apps..."
for app_id in app_executive_dashboard app_inventory_manager app_sales_dashboard; do
  delete_resource "app" "$app_id" "/api/v1/apps/$app_id"
done

# 2. Delete pipelines
log_info "Deleting pipelines..."
for pipeline_id in pipeline_crm_sync pipeline_order_etl pipeline_product_refresh pipeline_ticket_triage pipeline_shopify_sync pipeline_order_processing pipeline_analytics_agg; do
  delete_resource "pipeline" "$pipeline_id" "/api/v1/pipelines/$pipeline_id"
done

# 3. Delete entity types
log_info "Deleting entity types..."
for tenant_id in tenant_acme_001 tenant_widget_002; do
  # Read entities from seed file to get the names per tenant
  entities=$(jq -r --arg tid "$tenant_id" '.[] | select(.tenantId == $tid) | .name' "$PROJECT_DIR/seed/entities.json" 2>/dev/null || true)
  for entity_name in $entities; do
    delete_resource "entity type" "$entity_name ($tenant_id)" "/api/v1/ontologies/$tenant_id/entities/$entity_name"
  done
done

# 4. Delete connectors
log_info "Deleting connectors..."
for connector_id in connector_salesforce_acme connector_postgres_warehouse connector_support_api connector_shopify_widget connector_ga4_widget; do
  delete_resource "connector" "$connector_id" "/api/v1/connectors/$connector_id"
done

# 5. Delete users
log_info "Deleting users..."
users=$(jq -r '.[].email' "$PROJECT_DIR/seed/users.json" 2>/dev/null || true)
for email in $users; do
  delete_resource "user" "$email" "/api/v1/users/by-email/$email"
done

# 6. Delete tenants
log_info "Deleting tenants..."
for tenant_id in tenant_acme_001 tenant_widget_002; do
  delete_resource "tenant" "$tenant_id" "/api/v1/tenants/$tenant_id"
done

echo ""
log_ok "Cleanup complete."
echo ""
