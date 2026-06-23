import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    isolate: true,
    environment: "node",
    // Several tests exercise real bcrypt hashing at 12 rounds (register, API key
    // creation, bootstrap). When the full monorepo runs ~29 suites in parallel,
    // CPU contention pushes those CPU-bound hashes past Vitest's 5s default and
    // causes flaky timeouts. Raise the per-test timeout to give the hashing
    // headroom under load without masking genuine hangs.
    testTimeout: 30000,
    exclude: ["dist/**", "integration/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/__tests__/**"],
    },
  },
});
