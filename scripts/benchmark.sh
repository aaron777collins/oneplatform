#!/usr/bin/env bash
# benchmark.sh — OnePlatform performance benchmark runner
#
# Usage:
#   ./scripts/benchmark.sh [OPTIONS]
#
# Options:
#   --suite <name>      Run only the named suite: ingestion | pipeline | api
#   --save-baseline     Save results as the new baseline for future comparisons
#   --compare           Compare against the baseline; exits 1 if regressions found
#   --help              Show this message
#
# Examples:
#   Run all suites:
#     ./scripts/benchmark.sh
#
#   Run ingestion suite only and save as new baseline:
#     ./scripts/benchmark.sh --suite ingestion --save-baseline
#
#   Run all suites and compare against baseline (CI mode):
#     ./scripts/benchmark.sh --compare
#
# Prerequisites:
#   Node.js >= 22, pnpm (run 'pnpm install' at the repository root)
#
# Output:
#   - Human-readable summary to stdout
#   - Markdown table to stdout (parseable by CI log formatters)
#   - Baseline JSON written to tests/benchmarks/results/baseline.json
#     when --save-baseline is passed
#
# Implementation note:
#   Uses vitest's TypeScript pipeline to avoid esbuild binary version conflicts
#   in the pnpm workspace.  Benchmark flags are communicated via environment
#   variables (BENCH_SUITE, BENCH_SAVE_BASELINE, BENCH_COMPARE) rather than
#   CLI args because vitest does not forward extra positional args to test files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "${REPO_ROOT}/package.json" ]]; then
  echo "ERROR: could not locate package.json in ${REPO_ROOT}" >&2
  exit 1
fi

VITEST="${REPO_ROOT}/node_modules/.bin/vitest"
if [[ ! -x "${VITEST}" ]]; then
  echo "ERROR: vitest not found at ${VITEST}. Run 'pnpm install' first." >&2
  exit 1
fi

BENCH_CONFIG="${REPO_ROOT}/tests/vitest.bench.config.ts"
if [[ ! -f "${BENCH_CONFIG}" ]]; then
  echo "ERROR: benchmark vitest config not found at ${BENCH_CONFIG}" >&2
  exit 1
fi

# Parse benchmark-specific flags and translate to environment variables.
BENCH_SUITE=""
BENCH_SAVE_BASELINE="0"
BENCH_COMPARE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --suite)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --suite requires an argument (ingestion | pipeline | api)" >&2
        exit 1
      fi
      BENCH_SUITE="$2"
      shift 2
      ;;
    --save-baseline)
      BENCH_SAVE_BASELINE="1"
      shift
      ;;
    --compare)
      BENCH_COMPARE="1"
      shift
      ;;
    --help)
      grep '^#' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option '$1'. Use --help for usage." >&2
      exit 1
      ;;
  esac
done

echo "OnePlatform Benchmark Suite"
echo "==============================="
echo "Repository: ${REPO_ROOT}"
echo "Node:       $(node --version)"
echo "Date:       $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
[[ -n "${BENCH_SUITE}" ]] && echo "Suite:      ${BENCH_SUITE}"
[[ "${BENCH_SAVE_BASELINE}" == "1" ]] && echo "Mode:       save-baseline"
[[ "${BENCH_COMPARE}" == "1" ]] && echo "Mode:       compare"
echo ""

export BENCH_SUITE
export BENCH_SAVE_BASELINE
export BENCH_COMPARE

exec "${VITEST}" run \
  --config "${BENCH_CONFIG}" \
  --reporter verbose \
  "run-all"
