/**
 * Level 2 globalSetup for the Gateway service.
 *
 * Spawns the compiled dist/index.js on port 13000 and waits for /healthz to
 * return 200. The gateway proxies to upstream services — at Level 2, only the
 * gateway process itself is started. Upstream service calls in tests will fail
 * with connection errors unless the corresponding service test ports are also
 * active (Level 3 concern).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const PORT = 13000;
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

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[gateway-l2] ${String(d)}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[gateway-l2] ${String(d)}`));

  proc.on("error", (err) => {
    console.error("[gateway-l2] Failed to spawn process:", err);
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
  throw new Error(
    `[gateway-l2] Service at ${url} did not become healthy within ${timeoutMs}ms`,
  );
}
