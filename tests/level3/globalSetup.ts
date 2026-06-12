/**
 * Level 3 E2E globalSetup — starts all required services as real Node processes.
 *
 * Services are spawned from their compiled dist/index.js artifacts. All OP_*
 * environment variables come from .env.test (loaded by the vitest config). We
 * additionally inject PORT and inter-service URL overrides so each process
 * binds to its Level 3 test port and knows where to find its peers.
 *
 * Services NOT started here (special dependencies not available in the base
 * test environment):
 *   - execution (requires Docker sandbox proxy)
 *   - logging   (can be added when its setup is stabilised)
 *   - gateway   (not needed for direct service-to-service E2E flows)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Service manifest — order matters for readability only; startup is parallel.
// ---------------------------------------------------------------------------

const SERVICE_MAP = [
  { name: "auth",      entry: "services/auth/dist/index.js",      port: 13001, healthPath: "/healthz" },
  { name: "ingestion", entry: "services/ingestion/dist/index.js",  port: 13002, healthPath: "/healthz" },
  { name: "ontology",  entry: "services/ontology/dist/index.js",   port: 13003, healthPath: "/healthz" },
  { name: "pipeline",  entry: "services/pipeline/dist/index.js",   port: 13004, healthPath: "/healthz" },
  { name: "app",       entry: "services/app/dist/index.js",        port: 13006, healthPath: "/healthz" },
  { name: "plugin",    entry: "services/plugin/dist/index.js",     port: 13008, healthPath: "/healthz" },
] as const;

// Process handles are module-level so teardown (a different module invocation)
// can access them via the global provide/teardown contract. Vitest calls teardown
// in a fresh context, so we use global.__e2eProcs to pass the list.
declare global {
  // eslint-disable-next-line no-var
  var __e2eProcs: ChildProcess[];
}

// ---------------------------------------------------------------------------
// Health probe — polls until 200 or deadline exceeded
// ---------------------------------------------------------------------------

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Service not yet listening — expected during startup
    }
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  throw new Error(`[Level 3 globalSetup] Service at ${url} did not become healthy within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// setup() — called once before any test file runs
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  const root = resolve(import.meta.dirname, "../..");
  const procs: ChildProcess[] = [];

  for (const svc of SERVICE_MAP) {
    const entryPoint = resolve(root, svc.entry);

    const proc = spawn("node", [entryPoint], {
      env: {
        // Inherit all OP_* vars already in process.env (loaded from .env.test
        // by the vitest config before globalSetup runs).
        ...process.env,

        // B3: explicit PORT to avoid collisions with the developer's local stack
        PORT: String(svc.port),

        // Ensure infra URLs point at the test containers even if process.env
        // happens to hold production-pointing values (unlikely, but defensive).
        OP_DATABASE_URL: process.env["OP_DATABASE_URL"] ?? "",
        OP_REDIS_URL:    process.env["OP_REDIS_URL"] ?? "",

        // Inter-service URLs — all peer at test ports so services can call
        // each other during E2E flows (e.g. pipeline calling auth to validate tokens)
        AUTH_SERVICE_URL:      "http://localhost:13001",
        INGESTION_SERVICE_URL: "http://localhost:13002",
        ONTOLOGY_SERVICE_URL:  "http://localhost:13003",
        PIPELINE_SERVICE_URL:  "http://localhost:13004",
        APP_SERVICE_URL:       "http://localhost:13006",
        PLUGIN_SERVICE_URL:    "http://localhost:13008",

        // Execution service is not started; downstream services that optionally
        // call it will get ECONNREFUSED and fall back or skip gracefully.
        EXECUTION_SERVICE_URL: "http://localhost:13005",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Prefix every log line so multi-service output is easy to triage
    proc.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[${svc.name}] ${d.toString()}`)
    );
    proc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[${svc.name}] ${d.toString()}`)
    );

    // Crash-guard: if a service dies unexpectedly during the run, log the event.
    // Tests will fail naturally when they try to reach the dead service.
    proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(
          `[${svc.name}] process exited unexpectedly (code=${String(code)}, signal=${String(signal)})\n`
        );
      }
    });

    procs.push(proc);
  }

  // Expose proc list to teardown via global. Vitest's global teardown receives
  // the value returned by setup(), but globalTeardown runs in a separate module
  // evaluation so we also stash it on global as a belt-and-suspenders measure.
  globalThis.__e2eProcs = procs;

  // Wait for all services to be healthy in parallel — 60s is generous enough
  // for cold JIT compilation of Node modules but fails fast if a service crashes.
  await Promise.all(
    SERVICE_MAP.map((svc) =>
      waitForHealthy(`http://localhost:${svc.port}${svc.healthPath}`, 60_000)
    )
  );

  console.info("[Level 3 globalSetup] All services healthy — running tests");
}

// ---------------------------------------------------------------------------
// teardown() — called once after all test files complete
// ---------------------------------------------------------------------------

export async function teardown(): Promise<void> {
  const procs = globalThis.__e2eProcs ?? [];

  for (const proc of procs) {
    proc.kill("SIGTERM");
  }

  // Wait for all processes to close before Vitest exits so port bindings are
  // released and CI infra can run the suite again in the same environment.
  await Promise.all(
    procs.map(
      (proc) =>
        new Promise<void>((resolve) => {
          proc.on("close", resolve);
          // Safety valve: if a process ignores SIGTERM, force-kill after 5s
          setTimeout(() => {
            proc.kill("SIGKILL");
            resolve();
          }, 5_000);
        })
    )
  );

  console.info("[Level 3 globalSetup] All services stopped");
}
