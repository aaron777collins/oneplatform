/**
 * Level 2 globalSetup for the Ontology service.
 *
 * Spawns the compiled dist/index.js on port 13003 and waits for /healthz to
 * return 200. The ontology service's background cleanup job runs in the spawned
 * process — that is intentional for Level 2 tests.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { waitForHealthy } from "../../../../tests/helpers/wait-for-ready.js";

const PORT = 13003;
const HEALTH_URL = `http://localhost:${PORT}/healthz`;
const HEALTH_TIMEOUT_MS = 30_000;

let proc: ChildProcess | null = null;

export async function setup(): Promise<void> {
  const entryPoint = resolve(import.meta.dirname, "../../dist/index.js");

  proc = spawn("node", [entryPoint], {
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[ontology-l2] ${String(d)}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[ontology-l2] ${String(d)}`));

  proc.on("error", (err) => {
    console.error("[ontology-l2] Failed to spawn process:", err);
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

