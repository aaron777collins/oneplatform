#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Multi-Source ETL Pipeline — CLI Setup Script
#
# Creates all resources for the multi-source ETL pipeline using the `op` CLI.
# This is the CLI-equivalent of src/setup.ts for engineers who prefer shell
# scripts over TypeScript.
#
# Prerequisites:
#   - op CLI installed and configured (op auth login)
#   - jq installed for JSON parsing
#   - PostgreSQL and MySQL database proxies accessible
#
# Usage:
#   export OP_BASE_URL=https://your-instance.example.com
#   export OP_API_KEY=op_live_...
#   bash scripts/setup.sh
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${SCRIPT_DIR}/../configs"

# Color helpers (disabled when not in a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' BOLD='' NC=''
fi

info()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

# ---------------------------------------------------------------------------
# Verify prerequisites
# ---------------------------------------------------------------------------

command -v op >/dev/null 2>&1 || fail "op CLI not found. Install it from https://docs.oneplatform.dev/cli"
command -v jq >/dev/null 2>&1 || fail "jq not found. Install it: apt-get install jq / brew install jq"

step "Verifying connection to OnePlatform..."
if ! op status >/dev/null 2>&1; then
  fail "Cannot connect to OnePlatform. Run 'op auth login' or set OP_BASE_URL and OP_API_KEY."
fi
info "Connected to OnePlatform"

# ---------------------------------------------------------------------------
# Step 1: Create PostgreSQL connector
# ---------------------------------------------------------------------------

step "Step 1: Creating PostgreSQL connector (ecommerce.orders)..."

PG_CREDENTIALS_FILE=$(mktemp)
trap 'rm -f "${PG_CREDENTIALS_FILE}"' EXIT
cat > "${PG_CREDENTIALS_FILE}" << 'CREDS'
{
  "connectionString": "postgresql://readonly:****@pg-primary.internal:5432/ecommerce"
}
CREDS

PG_CONNECTOR_ID=$(op connector create \
  --plugin com.oneplatform.connector-postgres \
  --name "Ecommerce PostgreSQL - Orders" \
  --config "${CONFIG_DIR}/postgres-connector.json" \
  --credentials "${PG_CREDENTIALS_FILE}" \
  --sync-mode incremental \
  --enabled \
  --schedule-cron "0 * * * *" \
  --output json 2>/dev/null | jq -r '.id // empty') || true

if [ -z "${PG_CONNECTOR_ID:-}" ]; then
  warn "PostgreSQL connector may already exist. Attempting to find it..."
  PG_CONNECTOR_ID=$(op connector list --plugin com.oneplatform.connector-postgres --output json 2>/dev/null \
    | jq -r '.[] | select(.name == "Ecommerce PostgreSQL - Orders") | .id' | head -1) || true
fi

if [ -z "${PG_CONNECTOR_ID:-}" ]; then
  fail "Could not create or find PostgreSQL connector"
fi
info "PostgreSQL connector ID: ${PG_CONNECTOR_ID}"

# ---------------------------------------------------------------------------
# Step 2: Create MySQL connector
# ---------------------------------------------------------------------------

step "Step 2: Creating MySQL connector (retail_ops.product_catalog)..."

MYSQL_CREDENTIALS_FILE=$(mktemp)
trap 'rm -f "${PG_CREDENTIALS_FILE}" "${MYSQL_CREDENTIALS_FILE}"' EXIT
cat > "${MYSQL_CREDENTIALS_FILE}" << 'CREDS'
{
  "connectionString": "mysql://readonly:****@mysql-primary.internal:3306/retail_ops"
}
CREDS

MYSQL_CONNECTOR_ID=$(op connector create \
  --plugin com.oneplatform.connector-mysql \
  --name "Retail Ops MySQL - Products" \
  --config "${CONFIG_DIR}/mysql-connector.json" \
  --credentials "${MYSQL_CREDENTIALS_FILE}" \
  --sync-mode incremental \
  --enabled \
  --schedule-cron "0 * * * *" \
  --output json 2>/dev/null | jq -r '.id // empty') || true

if [ -z "${MYSQL_CONNECTOR_ID:-}" ]; then
  warn "MySQL connector may already exist. Attempting to find it..."
  MYSQL_CONNECTOR_ID=$(op connector list --plugin com.oneplatform.connector-mysql --output json 2>/dev/null \
    | jq -r '.[] | select(.name == "Retail Ops MySQL - Products") | .id' | head -1) || true
fi

if [ -z "${MYSQL_CONNECTOR_ID:-}" ]; then
  fail "Could not create or find MySQL connector"
fi
info "MySQL connector ID: ${MYSQL_CONNECTOR_ID}"

# ---------------------------------------------------------------------------
# Step 3: Test both connectors
# ---------------------------------------------------------------------------

step "Step 3: Testing connector connections..."

if op connector test "${PG_CONNECTOR_ID}" 2>/dev/null; then
  info "PostgreSQL connector: connection OK"
else
  warn "PostgreSQL connector: connection test failed (check proxy URL and credentials)"
fi

if op connector test "${MYSQL_CONNECTOR_ID}" 2>/dev/null; then
  info "MySQL connector: connection OK"
else
  warn "MySQL connector: connection test failed (check proxy URL and credentials)"
fi

# ---------------------------------------------------------------------------
# Step 4: Create ontology entity types
# ---------------------------------------------------------------------------

step "Step 4: Creating Order ontology entity..."
op ontology create --file "${CONFIG_DIR}/entity-order.json" 2>/dev/null \
  && info "Order entity created" \
  || warn "Order entity may already exist (skipping)"

step "Step 4b: Creating Product ontology entity..."
op ontology create --file "${CONFIG_DIR}/entity-product.json" 2>/dev/null \
  && info "Product entity created" \
  || warn "Product entity may already exist (skipping)"

# ---------------------------------------------------------------------------
# Step 5: Create mapping rules
#
# Define how source-specific field names map to the unified ontology fields.
# These rules are used by the pipeline's code steps but are also registered
# in the platform for documentation and lineage tracking.
# ---------------------------------------------------------------------------

step "Step 5: Creating field mapping rules..."

# PostgreSQL orders -> Order entity
op mapping create Order \
  --connector "${PG_CONNECTOR_ID}" \
  --source-field "order_id" \
  --target-field "orderId" \
  --transform-type expression \
  --transform "'pg-' + value" 2>/dev/null \
  && info "Mapped order_id -> orderId" \
  || warn "Mapping order_id -> orderId may already exist"

op mapping create Order \
  --connector "${PG_CONNECTOR_ID}" \
  --source-field "customer_id" \
  --target-field "customerId" 2>/dev/null \
  && info "Mapped customer_id -> customerId" \
  || warn "Mapping customer_id -> customerId may already exist"

op mapping create Order \
  --connector "${PG_CONNECTOR_ID}" \
  --source-field "total_amount" \
  --target-field "totalAmount" 2>/dev/null \
  && info "Mapped total_amount -> totalAmount" \
  || warn "Mapping total_amount -> totalAmount may already exist"

op mapping create Order \
  --connector "${PG_CONNECTOR_ID}" \
  --source-field "status" \
  --target-field "status" \
  --transform-type expression \
  --transform "value.toLowerCase()" 2>/dev/null \
  && info "Mapped status -> status (lowercased)" \
  || warn "Mapping status -> status may already exist"

# MySQL products -> Product entity
op mapping create Product \
  --connector "${MYSQL_CONNECTOR_ID}" \
  --source-field "sku" \
  --target-field "sku" 2>/dev/null \
  && info "Mapped sku -> sku" \
  || warn "Mapping sku -> sku may already exist"

op mapping create Product \
  --connector "${MYSQL_CONNECTOR_ID}" \
  --source-field "product_name" \
  --target-field "name" 2>/dev/null \
  && info "Mapped product_name -> name" \
  || warn "Mapping product_name -> name may already exist"

op mapping create Product \
  --connector "${MYSQL_CONNECTOR_ID}" \
  --source-field "retail_price" \
  --target-field "unitPrice" 2>/dev/null \
  && info "Mapped retail_price -> unitPrice" \
  || warn "Mapping retail_price -> unitPrice may already exist"

op mapping create Product \
  --connector "${MYSQL_CONNECTOR_ID}" \
  --source-field "category_name" \
  --target-field "category" 2>/dev/null \
  && info "Mapped category_name -> category" \
  || warn "Mapping category_name -> category may already exist"

# ---------------------------------------------------------------------------
# Step 6: Create the ETL pipeline
#
# The pipeline YAML definition references the connector IDs we just created.
# We use sed to replace the placeholder tokens before submitting.
# ---------------------------------------------------------------------------

step "Step 6: Creating the ETL pipeline..."

PIPELINE_FILE=$(mktemp --suffix=.json)
trap 'rm -f "${PG_CREDENTIALS_FILE}" "${MYSQL_CREDENTIALS_FILE}" "${PIPELINE_FILE}"' EXIT

sed \
  -e "s/{{POSTGRES_CONNECTOR_ID}}/${PG_CONNECTOR_ID}/g" \
  -e "s/{{MYSQL_CONNECTOR_ID}}/${MYSQL_CONNECTOR_ID}/g" \
  "${CONFIG_DIR}/etl-pipeline.json" > "${PIPELINE_FILE}"

PIPELINE_ID=$(op pipeline create --file "${PIPELINE_FILE}" --output json 2>/dev/null \
  | jq -r '.id // empty') || true

if [ -z "${PIPELINE_ID:-}" ]; then
  warn "Pipeline may already exist. Attempting to find it..."
  PIPELINE_ID=$(op pipeline list --output json 2>/dev/null \
    | jq -r '.[] | select(.name == "Multi-Source ETL Pipeline") | .id' | head -1) || true
fi

if [ -z "${PIPELINE_ID:-}" ]; then
  fail "Could not create or find the ETL pipeline"
fi
info "Pipeline ID: ${PIPELINE_ID}"

# ---------------------------------------------------------------------------
# Step 7: Create the cron schedule
# ---------------------------------------------------------------------------

step "Step 7: Creating hourly cron schedule..."

op schedule create \
  --pipeline "${PIPELINE_ID}" \
  --cron "0 * * * *" \
  --name "Hourly ETL Sync" \
  --timezone UTC 2>/dev/null \
  && info "Hourly schedule created" \
  || warn "Schedule may already exist (skipping)"

# ---------------------------------------------------------------------------
# Step 8: Trigger an immediate run
# ---------------------------------------------------------------------------

step "Step 8: Triggering immediate pipeline run..."

RUN_ID=$(op pipeline trigger "${PIPELINE_ID}" 2>/dev/null) || true

if [ -n "${RUN_ID:-}" ]; then
  info "Run enqueued: ${RUN_ID}"
  echo ""
  echo "Track progress:"
  echo "  op pipeline run-logs ${RUN_ID} --follow"
  echo "  op pipeline run-status ${RUN_ID}"
else
  warn "Could not trigger pipeline run. Trigger manually:"
  echo "  op pipeline trigger ${PIPELINE_ID}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo -e "${BOLD}Setup complete.${NC}"
echo ""
echo "Resources created:"
echo "  PostgreSQL Connector:  ${PG_CONNECTOR_ID}"
echo "  MySQL Connector:       ${MYSQL_CONNECTOR_ID}"
echo "  Order Entity:          Order"
echo "  Product Entity:        Product"
echo "  Pipeline:              ${PIPELINE_ID}"
echo ""
echo "Monitoring commands:"
echo "  op status                              # Platform health"
echo "  op connector list                      # All connectors"
echo "  op pipeline runs ${PIPELINE_ID}        # Pipeline run history"
echo "  op data query Order --limit 10         # Query merged orders"
echo "  op data query Product --limit 10       # Query merged products"
echo "  bash scripts/monitor.sh                # Full monitoring dashboard"
