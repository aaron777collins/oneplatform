#!/usr/bin/env bash
# =============================================================================
# send-events.sh — Send sample webhook events to a OnePlatform webhook receiver
#
# Usage:
#   export OP_BASE_URL=https://your-instance.example.com
#   export WEBHOOK_SECRET=whsec_your_shared_secret
#   bash test/send-events.sh
#
# Or send a single event:
#   bash test/send-events.sh test/sample-events/order.created.json
#
# The script computes the HMAC-SHA256 signature for each payload using the
# shared secret and includes it in the X-Webhook-Signature header, exactly
# as a real event source would.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL="${OP_BASE_URL:?Error: OP_BASE_URL environment variable is required}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-whsec_default_change_me_in_production}"
WEBHOOK_PATH="/api/v1/webhooks/external-events"
ENDPOINT="${BASE_URL}${WEBHOOK_PATH}"

# Directory containing this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_DIR="${SCRIPT_DIR}/sample-events"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Compute HMAC-SHA256 signature of a file's contents using the webhook secret.
# Returns the hex-encoded digest prefixed with "sha256=" to match the platform's
# expected format.
compute_signature() {
  local file="$1"
  local digest
  digest=$(openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex < "${file}" 2>/dev/null | awk '{print $NF}')
  echo "sha256=${digest}"
}

# Send a single webhook event and print the result.
send_event() {
  local file="$1"
  local filename
  filename=$(basename "${file}")

  if [[ ! -f "${file}" ]]; then
    echo "  SKIP: File not found: ${file}"
    return 1
  fi

  # Validate that the file contains valid JSON before sending.
  if ! python3 -m json.tool "${file}" > /dev/null 2>&1; then
    echo "  SKIP: Invalid JSON in ${filename}"
    return 1
  fi

  local signature
  signature=$(compute_signature "${file}")

  echo -n "  Sending ${filename}... "

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${ENDPOINT}" \
    -H "Content-Type: application/json" \
    -H "X-Webhook-Signature: ${signature}" \
    -H "X-Webhook-Timestamp: $(date -u +%s)" \
    -H "User-Agent: oneplatform-example/1.0" \
    -d @"${file}" \
    --connect-timeout 10 \
    --max-time 30)

  if [[ "${http_code}" -ge 200 && "${http_code}" -lt 300 ]]; then
    echo "OK (HTTP ${http_code})"
    return 0
  else
    echo "FAILED (HTTP ${http_code})"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "============================================================"
echo "  OnePlatform Webhook Event Sender"
echo "============================================================"
echo ""
echo "  Endpoint: ${ENDPOINT}"
echo "  Secret:   ${WEBHOOK_SECRET:0:10}..."
echo ""

# If a specific file was provided as an argument, send only that file.
if [[ $# -gt 0 ]]; then
  echo "Sending specified event(s):"
  echo ""
  succeeded=0
  failed=0

  for file in "$@"; do
    if send_event "${file}"; then
      succeeded=$((succeeded + 1))
    else
      failed=$((failed + 1))
    fi
  done

  echo ""
  echo "Results: ${succeeded} succeeded, ${failed} failed"
  exit 0
fi

# Otherwise, send all sample events in the sample-events directory.
if [[ ! -d "${SAMPLE_DIR}" ]]; then
  echo "Error: Sample events directory not found: ${SAMPLE_DIR}"
  echo "Expected directory at: test/sample-events/"
  exit 1
fi

# Collect all JSON files and sort them for consistent ordering.
mapfile -t event_files < <(find "${SAMPLE_DIR}" -name "*.json" -type f | sort)

if [[ ${#event_files[@]} -eq 0 ]]; then
  echo "No sample event files found in ${SAMPLE_DIR}"
  exit 1
fi

echo "Sending ${#event_files[@]} sample events:"
echo ""

succeeded=0
failed=0

for file in "${event_files[@]}"; do
  if send_event "${file}"; then
    succeeded=$((succeeded + 1))
  else
    failed=$((failed + 1))
  fi

  # Small delay between events to avoid overwhelming the receiver during testing.
  sleep 0.5
done

echo ""
echo "------------------------------------------------------------"
echo "  Results: ${succeeded} succeeded, ${failed} failed"
echo "  Total:   ${#event_files[@]} events sent"
echo "------------------------------------------------------------"
echo ""

if [[ ${failed} -gt 0 ]]; then
  echo "Some events failed. Check that:"
  echo "  1. OP_BASE_URL points to a running OnePlatform instance"
  echo "  2. The webhook receiver has been created (run: npm run setup)"
  echo "  3. WEBHOOK_SECRET matches the secret used during setup"
  exit 1
fi

echo "All events sent successfully."
echo "Check pipeline runs at: Settings -> Pipelines -> Webhook Event Pipeline -> Runs"
