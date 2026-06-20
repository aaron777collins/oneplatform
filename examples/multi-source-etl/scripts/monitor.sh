#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Multi-Source ETL Pipeline — Monitoring Script
#
# Checks the health of both connectors, pipeline run status, data quality
# statistics, and recent entity counts. Designed to be run manually or on
# a schedule (e.g. from cron or CI/CD) to verify the ETL pipeline is healthy.
#
# Prerequisites:
#   - op CLI installed and configured (op auth login)
#   - jq installed for JSON parsing
#
# Usage:
#   bash scripts/monitor.sh              # One-shot health check
#   bash scripts/monitor.sh --watch      # Repeat every 30 seconds
# ---------------------------------------------------------------------------

set -euo pipefail

# Color helpers (disabled when not in a terminal)
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' RED='' BOLD='' DIM='' NC=''
fi

WATCH_MODE=false
WATCH_INTERVAL=30

for arg in "$@"; do
  case "$arg" in
    --watch) WATCH_MODE=true ;;
    --interval=*) WATCH_INTERVAL="${arg#*=}" ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

status_color() {
  local status="$1"
  case "$status" in
    healthy|completed|success|active) echo -e "${GREEN}${status}${NC}" ;;
    degraded|running|queued|paused)   echo -e "${YELLOW}${status}${NC}" ;;
    unhealthy|failed|error|cancelled) echo -e "${RED}${status}${NC}" ;;
    *) echo "$status" ;;
  esac
}

divider() {
  echo -e "${DIM}$(printf '%.0s-' {1..60})${NC}"
}

# ---------------------------------------------------------------------------
# Main monitoring check
# ---------------------------------------------------------------------------

run_check() {
  local timestamp
  timestamp=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
  echo ""
  echo -e "${BOLD}Multi-Source ETL Pipeline — Health Report${NC}"
  echo -e "${DIM}${timestamp}${NC}"
  divider

  # --- Platform health ---
  echo -e "\n${BOLD}1. Platform Health${NC}"
  if op status 2>/dev/null; then
    echo ""
  else
    echo -e "  ${RED}Cannot reach OnePlatform. Check OP_BASE_URL and credentials.${NC}"
    return 1
  fi

  # --- Connector health ---
  echo -e "${BOLD}2. Connector Status${NC}"
  divider

  PG_CONNECTOR=$(op connector list --plugin com.oneplatform.connector-postgres --output json 2>/dev/null \
    | jq -r 'map(select(.name | contains("Ecommerce PostgreSQL"))) | .[0] // empty' 2>/dev/null) || true

  if [ -n "${PG_CONNECTOR:-}" ]; then
    PG_ID=$(echo "$PG_CONNECTOR" | jq -r '.id')
    PG_STATUS=$(echo "$PG_CONNECTOR" | jq -r '.status')
    PG_LAST_RUN=$(echo "$PG_CONNECTOR" | jq -r '.lastRunAt // "never"')
    echo -e "  PostgreSQL (ecommerce.orders)"
    echo -e "    ID:       ${PG_ID}"
    echo -e "    Status:   $(status_color "$PG_STATUS")"
    echo -e "    Last Run: ${PG_LAST_RUN}"

    # Test connectivity
    if op connector test "${PG_ID}" >/dev/null 2>&1; then
      echo -e "    Connection: ${GREEN}OK${NC}"
    else
      echo -e "    Connection: ${RED}FAILED${NC}"
    fi
  else
    echo -e "  PostgreSQL connector: ${RED}NOT FOUND${NC}"
    echo "    Run 'bash scripts/setup.sh' to create it."
  fi

  echo ""

  MYSQL_CONNECTOR=$(op connector list --plugin com.oneplatform.connector-mysql --output json 2>/dev/null \
    | jq -r 'map(select(.name | contains("Retail Ops MySQL"))) | .[0] // empty' 2>/dev/null) || true

  if [ -n "${MYSQL_CONNECTOR:-}" ]; then
    MYSQL_ID=$(echo "$MYSQL_CONNECTOR" | jq -r '.id')
    MYSQL_STATUS=$(echo "$MYSQL_CONNECTOR" | jq -r '.status')
    MYSQL_LAST_RUN=$(echo "$MYSQL_CONNECTOR" | jq -r '.lastRunAt // "never"')
    echo -e "  MySQL (retail_ops.product_catalog)"
    echo -e "    ID:       ${MYSQL_ID}"
    echo -e "    Status:   $(status_color "$MYSQL_STATUS")"
    echo -e "    Last Run: ${MYSQL_LAST_RUN}"

    if op connector test "${MYSQL_ID}" >/dev/null 2>&1; then
      echo -e "    Connection: ${GREEN}OK${NC}"
    else
      echo -e "    Connection: ${RED}FAILED${NC}"
    fi
  else
    echo -e "  MySQL connector: ${RED}NOT FOUND${NC}"
    echo "    Run 'bash scripts/setup.sh' to create it."
  fi

  # --- Pipeline status ---
  echo ""
  echo -e "${BOLD}3. Pipeline Status${NC}"
  divider

  PIPELINE=$(op pipeline list --output json 2>/dev/null \
    | jq -r 'map(select(.name == "Multi-Source ETL Pipeline")) | .[0] // empty' 2>/dev/null) || true

  if [ -n "${PIPELINE:-}" ]; then
    PIPELINE_ID=$(echo "$PIPELINE" | jq -r '.id')
    PIPELINE_STATUS=$(echo "$PIPELINE" | jq -r '.status')
    PIPELINE_LAST_RUN=$(echo "$PIPELINE" | jq -r '.lastRunAt // "never"')
    PIPELINE_LAST_STATUS=$(echo "$PIPELINE" | jq -r '.lastRunStatus // "none"')

    echo -e "  Pipeline:        Multi-Source ETL Pipeline"
    echo -e "  ID:              ${PIPELINE_ID}"
    echo -e "  Status:          $(status_color "$PIPELINE_STATUS")"
    echo -e "  Last Run:        ${PIPELINE_LAST_RUN}"
    echo -e "  Last Run Status: $(status_color "$PIPELINE_LAST_STATUS")"

    # Show recent runs
    echo ""
    echo -e "  ${BOLD}Recent Runs (last 5):${NC}"
    RUNS=$(op pipeline runs "${PIPELINE_ID}" --limit 5 --output json 2>/dev/null) || true

    if [ -n "${RUNS:-}" ]; then
      echo "$RUNS" | jq -r '.[] | "    \(.id)  \(.status | if . == "completed" then "OK" elif . == "failed" then "FAIL" else . end)  \(.startedAt // "pending")  \(.durationMs // 0)ms"' 2>/dev/null || true
    else
      echo "    No runs found."
    fi
  else
    echo -e "  Pipeline: ${RED}NOT FOUND${NC}"
    echo "    Run 'bash scripts/setup.sh' to create it."
  fi

  # --- Data quality ---
  echo ""
  echo -e "${BOLD}4. Data Quality Summary${NC}"
  divider

  # Query Order entity count
  ORDER_COUNT=$(op data query Order --limit 1 --output json 2>/dev/null \
    | jq -r '.total // .data | length // 0' 2>/dev/null) || ORDER_COUNT="?"
  echo -e "  Order records:   ${ORDER_COUNT}"

  # Query Product entity count
  PRODUCT_COUNT=$(op data query Product --limit 1 --output json 2>/dev/null \
    | jq -r '.total // .data | length // 0' 2>/dev/null) || PRODUCT_COUNT="?"
  echo -e "  Product records: ${PRODUCT_COUNT}"

  # Check for orders from each source
  echo ""
  echo -e "  ${BOLD}Orders by source:${NC}"
  PG_ORDERS=$(op data query Order --filter 'source eq "postgres-ecommerce"' --limit 1 --output json 2>/dev/null \
    | jq -r '.total // 0' 2>/dev/null) || PG_ORDERS="?"
  echo -e "    postgres-ecommerce: ${PG_ORDERS}"

  # Check for products from each source
  echo -e "  ${BOLD}Products by source:${NC}"
  MYSQL_PRODUCTS=$(op data query Product --filter 'source eq "mysql-retail"' --limit 1 --output json 2>/dev/null \
    | jq -r '.total // 0' 2>/dev/null) || MYSQL_PRODUCTS="?"
  echo -e "    mysql-retail:       ${MYSQL_PRODUCTS}"

  # --- Schedule status ---
  echo ""
  echo -e "${BOLD}5. Schedule Status${NC}"
  divider

  if [ -n "${PIPELINE_ID:-}" ]; then
    SCHEDULES=$(op schedule list --pipeline "${PIPELINE_ID}" --output json 2>/dev/null) || true
    if [ -n "${SCHEDULES:-}" ] && [ "$SCHEDULES" != "[]" ]; then
      echo "$SCHEDULES" | jq -r '.[] | "  \(.name // "unnamed")  cron: \(.cron)  status: \(.status)  next: \(.nextRunAt // "unknown")"' 2>/dev/null || true
    else
      echo "  No schedules configured for this pipeline."
      echo "  Create one: op schedule create --pipeline ${PIPELINE_ID} --cron '0 * * * *' --name 'Hourly ETL Sync'"
    fi
  fi

  # --- Recent logs (errors only) ---
  echo ""
  echo -e "${BOLD}6. Recent Errors (last 10)${NC}"
  divider

  RECENT_ERRORS=$(op logs query --service pipeline --level error --limit 10 --output json 2>/dev/null) || true
  if [ -n "${RECENT_ERRORS:-}" ] && [ "$RECENT_ERRORS" != "[]" ]; then
    echo "$RECENT_ERRORS" | jq -r '.[] | "  [\(.timestamp)] \(.message)"' 2>/dev/null | head -10 || true
  else
    echo -e "  ${GREEN}No recent errors.${NC}"
  fi

  divider
  echo ""
}

# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

if [ "$WATCH_MODE" = true ]; then
  echo "Monitoring every ${WATCH_INTERVAL}s (Ctrl+C to stop)..."
  while true; do
    clear
    run_check || true
    sleep "$WATCH_INTERVAL"
  done
else
  run_check
fi
