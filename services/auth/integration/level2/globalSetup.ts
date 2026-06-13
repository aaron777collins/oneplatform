/**
 * Level 2 globalSetup for the Auth service.
 *
 * Spawns the compiled dist/index.js on port 13001 and waits for /healthz to
 * return 200 before handing control to the test suite. SIGTERM is sent in
 * teardown, and we wait for the child process to exit so no zombie process
 * lingers after the suite finishes.
 *
 * Why dist/index.js: runMigrations() resolves the migrations directory via
 * import.meta.url pointing at the compiled .js file (B5 in the design doc).
 * Tests must run `pnpm build` in this service before running Level 2.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { waitForHealthy } from "../../../../tests/helpers/wait-for-ready.js";

const PORT = 13001;
const HEALTH_URL = `http://localhost:${PORT}/healthz`;
const HEALTH_TIMEOUT_MS = 30_000;

let proc: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const entryPoint = resolve(import.meta.dirname, "../../dist/index.js");

  proc = spawn("node", [entryPoint], {
    env: {
      // Inherit all OP_* vars already loaded into the globalSetup process env
      // by the vitest config (dotenv). Then override the port explicitly.
      ...process.env,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[auth-l2] ${String(d)}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[auth-l2] ${String(d)}`));

  // Surface child process crash as a clear error rather than a timeout.
  proc.on("error", (err) => {
    console.error("[auth-l2] Failed to spawn process:", err);
  });

  await waitForHealthy(HEALTH_URL, HEALTH_TIMEOUT_MS);
}

export async function teardown(): Promise<void> {
  if (proc !== null) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => proc!.on("close", resolve));
    proc = null;
  }
}

