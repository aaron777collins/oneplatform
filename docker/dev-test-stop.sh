#!/usr/bin/env bash
#
# dev-test-stop.sh — stop the isolated OnePlatform dev-test stack.
#
# By default this stops and removes the containers but PRESERVES the named
# volumes (so your data, generated secrets, and registered users survive a
# restart). Pass --clean (or -v) to also delete the op-dev-test-* volumes and
# start completely fresh next time.
#
# Usage:
#   ./dev-test-stop.sh           # stop containers, keep data
#   ./dev-test-stop.sh --clean   # stop containers AND delete all data volumes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.dev-test.yml"
PROJECT="op-dev-test"

cd "${REPO_ROOT}"

CLEAN=0
for arg in "$@"; do
  case "${arg}" in
    --clean|-v) CLEAN=1 ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      echo "Usage: $0 [--clean|-v]" >&2
      exit 1
      ;;
  esac
done

if [ "${CLEAN}" -eq 1 ]; then
  echo "==> Stopping dev-test stack and REMOVING all op-dev-test volumes (data will be lost)..."
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT}" down --volumes --remove-orphans
  echo "==> Dev-test stack stopped and volumes removed."
else
  echo "==> Stopping dev-test stack (volumes preserved)..."
  docker compose -f "${COMPOSE_FILE}" -p "${PROJECT}" down --remove-orphans
  echo "==> Dev-test stack stopped. Data volumes preserved."
  echo "    Re-run ./docker/dev-test-start.sh to resume, or pass --clean to wipe data."
fi
