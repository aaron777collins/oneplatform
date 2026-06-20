#!/usr/bin/env bash
# =============================================================================
# OnePlatform Quick Start — Automated Setup Script
#
# This script creates all resources needed for the quick-start example:
#   1. A Customer entity type in the ontology
#   2. A REST API connector (pointing to jsonplaceholder.typicode.com)
#   3. A CSV file connector (pointing to sample-data/customers.csv)
#   4. A pipeline that imports customers from the REST API
#   5. A dashboard app for viewing the Customer entity
#
# Prerequisites:
#   - The OnePlatform is running (docker compose up -d)
#   - The `op` CLI is installed and on your PATH
#   - You are logged in (op auth login)
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
# =============================================================================

set -euo pipefail

# Move to the directory where this script lives so relative paths work.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

# Print a step header so the user knows what is happening.
step() {
  echo ""
  echo "====================================================="
  echo "  Step $1: $2"
  echo "====================================================="
  echo ""
}

# Print a success message.
ok() {
  echo "  [OK] $1"
}

# Print an info message.
info() {
  echo "  [INFO] $1"
}

# Print an error and exit.
fail() {
  echo "  [ERROR] $1" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

echo ""
echo "OnePlatform Quick Start Setup"
echo "=============================="

# Check that the op CLI is available.
if ! command -v op &> /dev/null; then
  fail "The 'op' CLI is not installed or not on your PATH.
       Install it with: npm install -g @oneplatform/cli
       Then run: op auth login"
fi

# Verify authentication by checking the current user.
info "Checking authentication..."
if ! op auth status &> /dev/null; then
  fail "You are not logged in. Run 'op auth login' first."
fi
ok "Authenticated."

# Verify the platform is reachable.
info "Checking platform health..."
if ! op status &> /dev/null; then
  fail "Cannot reach the platform. Make sure it is running:
       cd docker && docker compose up -d"
fi
ok "Platform is healthy."

# ---------------------------------------------------------------------------
# Step 1: Create the Customer entity type
# ---------------------------------------------------------------------------

step 1 "Create the Customer entity type"

op entity create --from-file configs/entity-customer.json
ok "Customer entity defined."

# ---------------------------------------------------------------------------
# Step 2: Create the REST API connector
# ---------------------------------------------------------------------------

step 2 "Create the REST API connector"

op connector create --from-file configs/connector-rest-api.json
ok "REST API connector created."

# ---------------------------------------------------------------------------
# Step 3: Create the CSV file connector
# ---------------------------------------------------------------------------

step 3 "Create the CSV file connector"

op connector create --from-file configs/connector-csv.json
ok "CSV connector created."

# ---------------------------------------------------------------------------
# Step 4: Create the import pipeline
# ---------------------------------------------------------------------------

step 4 "Create the import pipeline"

op pipeline create --from-file configs/pipeline-import.json
ok "Import pipeline created."

# ---------------------------------------------------------------------------
# Step 5: Create the dashboard app
# ---------------------------------------------------------------------------

step 5 "Create the dashboard app"

op app create --from-file configs/app-dashboard.json
ok "Customer Dashboard deployed."

# ---------------------------------------------------------------------------
# Step 6: Trigger the pipeline
# ---------------------------------------------------------------------------

step 6 "Run the import pipeline"

info "Looking up pipeline ID..."
# List pipelines and find the one we just created.
PIPELINE_ID=$(op pipeline list 2>/dev/null | grep "Import Customers" | awk '{print $1}' || true)

if [ -n "$PIPELINE_ID" ]; then
  info "Triggering pipeline run (ID: $PIPELINE_ID)..."
  op pipeline trigger "$PIPELINE_ID" --wait --poll-timeout 120
  ok "Pipeline run completed."
else
  info "Could not auto-detect pipeline ID. You can trigger it manually:"
  info "  op pipeline list"
  info "  op pipeline trigger <pipeline-id> --wait"
fi

# ---------------------------------------------------------------------------
# Step 7: Verify the data
# ---------------------------------------------------------------------------

step 7 "Verify imported data"

info "Querying Customer entity..."
op data query Customer --limit 5
ok "Data imported successfully."

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "====================================================="
echo "  Setup Complete!"
echo "====================================================="
echo ""
echo "  What was created:"
echo "    - Customer entity type (ontology schema)"
echo "    - Customer API connector (REST API data source)"
echo "    - Customer CSV Import connector (CSV file data source)"
echo "    - Import Customers from API pipeline"
echo "    - Customer Dashboard app"
echo ""
echo "  Next steps:"
echo "    1. Open the platform UI in your browser"
echo "    2. Navigate to Apps > Customer Dashboard"
echo "    3. Browse and search your imported customer records"
echo ""
echo "Open your app:  op app open customer-dashboard"
echo "Import CSV:     op pipeline run import-customers --file sample-data/customers.csv"
echo ""
