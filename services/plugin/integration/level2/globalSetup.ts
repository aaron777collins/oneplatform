/**
 * Level 2 globalSetup for the Plugin service.
 *
 * Spawns the compiled dist/index.js on port 13008 and waits for /health/live
 * to return 200. The plugin service uses /health/live (not /healthz) as its
 * liveness probe — that is the correct endpoint to poll here.
 *
 * The plugin service performs a MinIO bucket ensure on startup. For Level 2
 * tests to pass, a reachable MinIO instance must be configured via
 * OP_S3_ENDPOINT (from .env.test or the environment).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const PORT = 13008;
// Plugin uses /health/live, not /healthz.
const HEALTH_URL = `http://localhost:${PORT}/health/live`;
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

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[plugin-l2] ${String(d)}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[plugin-l2] ${String(d)}`));

  proc.on("error", (err) => {
    console.error("[plugin-l2] Failed to spawn process:", err);
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

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Process not listening yet — keep polling.
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`[plugin-l2] Service at ${url} did not become healthy within ${timeoutMs}ms`);
}
