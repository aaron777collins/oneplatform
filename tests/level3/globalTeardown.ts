/**
 * Level 3 E2E globalTeardown — stops all spawned service processes.
 *
 * Vitest calls this module's default export after all test suites complete.
 * The process list is read from globalThis.__e2eProcs that globalSetup stashed.
 *
 * NOTE: This file is present for Vitest config compatibility. The actual teardown
 * logic is co-located in globalSetup.ts as the exported `teardown()` function,
 * which Vitest calls automatically when globalSetup exports both setup and
 * teardown. This file is a no-op stub kept for clarity and future extension.
 */

// globalSetup.ts exports teardown() alongside setup(), so Vitest calls it
// automatically — no additional work needed here. See globalSetup.ts.
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty: teardown is handled by the exported `teardown()`
  // function in globalSetup.ts, which Vitest invokes as part of the same
  // globalSetup module lifecycle.
}
