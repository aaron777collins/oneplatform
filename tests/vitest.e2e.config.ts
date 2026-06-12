/**
 * Vitest configuration for Level 3 full-stack E2E tests.
 *
 * Key decisions:
 *   - globalSetup starts all service processes once before any test runs.
 *   - pool: "forks" isolates each test file in a separate process so that
 *     env-var mutations and module-level state cannot leak between files.
 *   - sequence.sequential: true prevents port-contention from concurrent
 *     cross-service flows hitting the same shared service instances.
 *   - testTimeout: 60_000 gives services time to respond under cold-start JIT.
 *
 * Run with: pnpm test:e2e
 * Prerequisites: docker compose -f docker/docker-compose.test.yml up -d
 *                pnpm turbo run build
 */

import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Minimal .env.test parser — avoids adding a dotenv dependency.
//
// Handles the subset of .env syntax used in .env.test:
//   KEY=value        (bare assignment)
//   # comment        (ignored)
//   empty lines      (ignored)
// ---------------------------------------------------------------------------

function parseEnvFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    // .env.test is optional — if absent, rely on the calling shell's environment
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and blank lines
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key !== "") {
      result[key] = value;
    }
  }
  return result;
}

// Load test-infrastructure env vars so both globalSetup (which spawns services)
// and test forks (which make HTTP calls and open DB connections) see them.
const testEnv = parseEnvFile(resolve(import.meta.dirname, "../.env.test"));

export default defineConfig({
  test: {
    // Only pick up files inside tests/level3/ (relative to this config's location)
    include: ["level3/**/*.test.ts"],

    // globalSetup starts all services before any test runs.
    // teardown() is exported from the same module and is called automatically.
    globalSetup: ["level3/globalSetup.ts"],

    environment: "node",

    // 60 seconds per test — E2E flows involve real HTTP round-trips and DB I/O
    testTimeout: 60_000,

    // Separate process per test file prevents env-var pollution between suites
    pool: "forks",

    // Sequential execution: all Level 3 tests share the same service instances
    // on fixed ports — concurrent cross-service calls could interleave and produce
    // false failures. concurrent: false is the vitest 1.x API for sequential order.
    sequence: {
      concurrent: false,
    },

    // Inject .env.test values into every test fork so tests can read
    // OP_DATABASE_URL, OP_REDIS_URL, etc. without shelling out.
    env: testEnv,
  },
});
