#!/usr/bin/env bash
# =============================================================================
# Full Platform Demo — Cleanup Script
#
# Removes all demo data created by the seed script. This script uses the
# OnePlatform REST API directly via curl so it has no Node.js dependencies.
#
# Required environment variables:
#   OP_BASE_URL — e.g. https://localhost
#   OP_API_KEY  — admin-scoped API key
#
# Usage:
#   npm run cleanup
#   # or directly:
#   bash scripts/cleanup.sh
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Load .env if present (simple key=value parser, no eval)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ -f "$ENV_FILE" ]]; then
  echo "Loading configuration from .env..."
  while IFS='=' read -r key value; do
    # Skip blank lines and comments.
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Remove surrounding quotes from value.
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    # Only export if not already set in the environment.
    if [[ -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# Validate required variables
# ---------------------------------------------------------------------------
if [[ -z "${OP_BASE_URL:-}" || -z "${OP_API_KEY:-}" ]]; then
  echo "Error: OP_BASE_URL and OP_API_KEY must be set."
  echo ""
  echo "  export OP_BASE_URL=https://localhost"
  echo "  export OP_API_KEY=op_live_..."
  echo "  bash scripts/cleanup.sh"
  exit 1
fi

BASE_URL="${OP_BASE_URL%/}"  # Strip trailing slash

# ---------------------------------------------------------------------------
# curl wrapper — adds auth headers and handles self-signed certs
# ---------------------------------------------------------------------------
api() {
  local method="$1"
  local path="$2"
  curl -s -k \
    -X "$method" \
    -H "Authorization: Bearer $OP_API_KEY" \
    -H "Content-Type: application/json" \
    "${BASE_URL}${path}"
}

# ---------------------------------------------------------------------------
# Delete helpers — list resources, then delete each by ID
# ---------------------------------------------------------------------------

delete_all_resources() {
  local resource_name="$1"
  local api_path="$2"

  echo ""
  echo "Cleaning up ${resource_name}..."

  local response
  response=$(api GET "${api_path}?limit=100")

  # Extract IDs from the response. The list endpoint returns { data: { items: [...] } }
  # or { items: [...] }. We handle both shapes.
  local ids
  ids=$(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('items', data.get('data', {}).get('items', []))
    for item in items:
        print(item.get('id', ''))
except (json.JSONDecodeError, KeyError, TypeError):
    pass
" 2>/dev/null || true)

  if [[ -z "$ids" ]]; then
    echo "  No ${resource_name} found."
    return
  fi

  local count=0
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    echo "  Deleting ${resource_name}: ${id}"
    api DELETE "${api_path}/${id}" > /dev/null 2>&1 || true
    count=$((count + 1))
  done <<< "$ids"

  echo "  Deleted ${count} ${resource_name}."
}

# ---------------------------------------------------------------------------
# Main cleanup sequence — reverse order of creation
# ---------------------------------------------------------------------------

echo "============================================================"
echo "OnePlatform Full Demo — Cleanup"
echo "============================================================"
echo ""
echo "Target: ${BASE_URL}"
echo ""

# Verify connectivity.
echo "Verifying connection..."
identity=$(api GET "/api/v1/auth/whoami" 2>/dev/null || echo "{}")
email=$(echo "$identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('email','unknown'))" 2>/dev/null || echo "unknown")
echo "  Connected as: ${email}"

# Delete in reverse dependency order:
#   1. Apps (depend on entities)
#   2. Pipelines (depend on connectors and entities)
#   3. Connectors (standalone)
#   4. Entity data records (per entity type)
#   5. Ontology schemas (entity type definitions)
#   6. Users

delete_all_resources "apps" "/api/v1/apps"
delete_all_resources "pipelines" "/api/v1/pipelines"
delete_all_resources "connectors" "/api/v1/connectors"

# Delete entity data — we need to know the entity type names.
echo ""
echo "Cleaning up entity data records..."
for entity_type in Customer Order Product Event; do
  echo "  Checking ${entity_type}..."
  response=$(api GET "/api/v1/data/${entity_type}?limit=100" 2>/dev/null || echo "{}")
  ids=$(echo "$response" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('items', data.get('data', {}).get('items', []))
    for item in items:
        print(item.get('id', ''))
except (json.JSONDecodeError, KeyError, TypeError):
    pass
" 2>/dev/null || true)

  if [[ -z "$ids" ]]; then
    echo "    No ${entity_type} records found."
    continue
  fi

  count=0
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    api DELETE "/api/v1/data/${entity_type}/${id}" > /dev/null 2>&1 || true
    count=$((count + 1))
  done <<< "$ids"
  echo "    Deleted ${count} ${entity_type} records."
done

delete_all_resources "ontology schemas" "/api/v1/ontology"
delete_all_resources "users" "/api/v1/users"

echo ""
echo "============================================================"
echo "Cleanup complete."
echo ""
echo "To re-seed the demo data:"
echo "  npm run seed"
echo "============================================================"
