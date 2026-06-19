import type { Logger } from "@oneplatform/core";
import { ExecutionSandboxUnavailableError } from "./errors.js";
import type { UnixSocketClient } from "./unix-socket-client.js";

// ---------------------------------------------------------------------------
// SandboxManager — lifecycle management for op-sandbox-vm
// Design spec §9: recycling, drain, warm pool, crash recovery
// ---------------------------------------------------------------------------

export type SandboxState =
  | "STARTING"        // waiting for the socket to come up after a restart
  | "ACTIVE"          // healthy, accepting executions
  | "DRAINING_OLD";   // recycle in progress; old sandbox finishing in-flight work

export interface SandboxInstance {
  readonly id: string;
  readonly socketPath: string;
  readonly client: UnixSocketClient;
  state: SandboxState;
  runCount: number;
  startedAt: Date;
  /** Execution IDs currently in-flight on this sandbox instance */
  inflightIds: Set<string>;
}

export interface SandboxManager {
  /** Current primary sandbox. Throws ExecutionSandboxUnavailableError if none healthy. */
  getPrimary(): SandboxInstance;
  /** Increment run counter. Triggers recycle when threshold is reached. */
  recordRun(executionId: string): void;
  /** Called when an execution completes (success, error, or timeout). */
  recordCompletion(executionId: string): void;
  /** Start periodic ping health checks. */
  startHealthChecks(): void;
  /** Stop health checks and release resources. */
  stop(): void;
  /** Mark all in-flight executions as killed after a crash. Returns the affected IDs. */
  handleCrash(): string[];
}

export interface SandboxManagerDeps {
  primaryClient: UnixSocketClient;
  logger: Logger;
  /** Socket path shared with op-sandbox-vm (mounted from sandbox-socket volume) */
  socketPath?: string;
  /** Recycle after this many executions. Env: OP_SANDBOX_RECYCLE_COUNT */
  recycleAfterCount?: number;
  /** Recycle after this many ms regardless of count. Env: OP_SANDBOX_RECYCLE_INTERVAL_MS */
  recycleIntervalMs?: number;
  /** Grace period for drain before force-kill. Env: OP_SANDBOX_RECYCLE_GRACE_MS */
  drainGracePeriodMs?: number;
  /** Number of warm replacement containers to maintain. Env: OP_SANDBOX_WARM_POOL_SIZE */
  warmPoolSize?: number;
  /** Callback invoked when crash is detected; used by ExecutionService to fan out SSE errors */
  onCrash?: (killedExecutionIds: string[]) => void;
}

// Consecutive ping misses before declaring sandbox dead
const PING_MISS_THRESHOLD = 3;
const PING_INTERVAL_MS = 10_000;

export function createSandboxManager(deps: SandboxManagerDeps): SandboxManager {
  const {
    primaryClient,
    logger,
    socketPath = "/run/sandbox/op.sock",
    recycleAfterCount = parseInt(process.env["OP_SANDBOX_RECYCLE_COUNT"] ?? "1000", 10),
    recycleIntervalMs = parseInt(process.env["OP_SANDBOX_RECYCLE_INTERVAL_MS"] ?? "3600000", 10),
    drainGracePeriodMs = parseInt(process.env["OP_SANDBOX_RECYCLE_GRACE_MS"] ?? "60000", 10),
    onCrash,
  } = deps;

  // Primary sandbox instance — the one receiving all new execution requests
  const primary: SandboxInstance = {
    id: "sandbox-primary-0",
    socketPath,
    client: primaryClient,
    state: "STARTING",
    runCount: 0,
    startedAt: new Date(),
    inflightIds: new Set(),
  };

  let consecutivePingMisses = 0;
  let pingIntervalHandle: ReturnType<typeof setInterval> | null = null;
  let recycleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;

  // ---------------------------------------------------------------------------
  // Health check — design spec §7.5
  // ---------------------------------------------------------------------------

  async function performPing(): Promise<void> {
    try {
      await primary.client.ping();
      consecutivePingMisses = 0;

      if (primary.state === "STARTING") {
        primary.state = "ACTIVE";
        primary.startedAt = new Date();
        logger.info("SandboxManager: sandbox became healthy", { sandboxId: primary.id });
        scheduleRecycleTimer();
      }
    } catch (err) {
      consecutivePingMisses++;
      logger.warn("SandboxManager: ping miss", {
        sandboxId: primary.id,
        consecutiveMisses: consecutivePingMisses,
        error: err instanceof Error ? err.message : String(err),
      });

      if (consecutivePingMisses >= PING_MISS_THRESHOLD) {
        logger.error("SandboxManager: sandbox unreachable — triggering crash recovery", {
          sandboxId: primary.id,
          missThreshold: PING_MISS_THRESHOLD,
        });
        triggerCrashRecovery();
      }
    }
  }

  function triggerCrashRecovery(): void {
    consecutivePingMisses = 0;
    primary.state = "STARTING";

    const killedIds = Array.from(primary.inflightIds);
    primary.inflightIds.clear();

    logger.error("SandboxManager: crash recovery initiated", {
      sandboxId: primary.id,
      killedExecutionCount: killedIds.length,
    });

    if (onCrash !== undefined) {
      onCrash(killedIds);
    }

    // Reset counters for when Docker restarts the container
    primary.runCount = 0;

    // Attempt reconnect — the Docker restart policy will bring the sandbox back;
    // we reconnect once it is listening again.
    scheduleReconnect(0);
  }

  function scheduleReconnect(delayMs: number): void {
    setTimeout(() => {
      primary.client
        .connect(primary.socketPath)
        .then(() => {
          logger.info("SandboxManager: reconnected to sandbox socket");
          primary.state = "ACTIVE";
          primary.startedAt = new Date();
          consecutivePingMisses = 0;
          scheduleRecycleTimer();
        })
        .catch((err: unknown) => {
          logger.warn("SandboxManager: reconnect attempt failed — retrying in 5s", {
            error: err instanceof Error ? err.message : String(err),
          });
          scheduleReconnect(5_000);
        });
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Recycle — design spec §9.2
  // ---------------------------------------------------------------------------

  function scheduleRecycleTimer(): void {
    if (recycleTimeoutHandle !== null) {
      clearTimeout(recycleTimeoutHandle);
    }
    // Recycle at the 1-hour mark regardless of run count
    recycleTimeoutHandle = setTimeout(() => {
      triggerRecycle("time");
    }, recycleIntervalMs);
  }

  async function triggerRecycle(reason: "threshold" | "time" | "crash"): Promise<void> {
    if (isDraining) return; // Already draining
    isDraining = true;

    logger.info("SandboxManager: recycle triggered", {
      reason,
      sandboxId: primary.id,
      runCount: primary.runCount,
    });

    primary.state = "DRAINING_OLD";
    primary.runCount = 0;

    // Wait for in-flight executions to finish up to the grace period.
    // For connector-run executions with long timeouts, the spec says we extend
    // the grace period to max(inflight_timeout + 5000, drainGracePeriodMs).
    // Since we do not have access to per-execution timeouts here we use the
    // configured grace period as the upper bound.
    const drainStart = Date.now();

    await waitForInflightDrain(drainStart);

    // Signal the sandbox to complete its own cleanup
    try {
      await primary.client.drain();
    } catch (err) {
      logger.warn("SandboxManager: drain command failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    primary.state = "ACTIVE";
    primary.startedAt = new Date();
    isDraining = false;

    logger.info("SandboxManager: recycle complete", { sandboxId: primary.id });
    scheduleRecycleTimer();
  }

  async function waitForInflightDrain(startMs: number): Promise<void> {
    return new Promise((resolve) => {
      function check(): void {
        const elapsed = Date.now() - startMs;
        if (primary.inflightIds.size === 0 || elapsed >= drainGracePeriodMs) {
          if (primary.inflightIds.size > 0) {
            logger.warn("SandboxManager: drain grace period expired with in-flight executions", {
              remainingInflight: primary.inflightIds.size,
              killedIds: Array.from(primary.inflightIds),
            });
            // Force-kill remaining — mark them as killed via onCrash notification
            const killedIds = Array.from(primary.inflightIds);
            primary.inflightIds.clear();
            if (onCrash !== undefined) {
              onCrash(killedIds);
            }
          }
          resolve();
        } else {
          setTimeout(check, 500);
        }
      }
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function getPrimary(): SandboxInstance {
    if (primary.state === "STARTING") {
      throw new ExecutionSandboxUnavailableError(
        "Sandbox is starting up or reconnecting — no healthy instance available.",
      );
    }
    if (primary.state === "DRAINING_OLD") {
      throw new ExecutionSandboxUnavailableError(
        "Sandbox is draining for recycle — no healthy instance available. Retry shortly.",
      );
    }
    return primary;
  }

  function recordRun(executionId: string): void {
    primary.inflightIds.add(executionId);
    primary.runCount++;

    if (primary.runCount >= recycleAfterCount && !isDraining) {
      // Trigger recycle asynchronously — do not block the calling execution
      void triggerRecycle("threshold");
    }
  }

  function recordCompletion(executionId: string): void {
    primary.inflightIds.delete(executionId);
  }

  function handleCrash(): string[] {
    const killed = Array.from(primary.inflightIds);
    primary.inflightIds.clear();
    triggerCrashRecovery();
    return killed;
  }

  function startHealthChecks(): void {
    if (pingIntervalHandle !== null) return;
    pingIntervalHandle = setInterval(() => {
      void performPing();
    }, PING_INTERVAL_MS);

    // Initial ping immediately
    void performPing();
  }

  function stop(): void {
    if (pingIntervalHandle !== null) {
      clearInterval(pingIntervalHandle);
      pingIntervalHandle = null;
    }
    if (recycleTimeoutHandle !== null) {
      clearTimeout(recycleTimeoutHandle);
      recycleTimeoutHandle = null;
    }
    primary.client.close();
  }

  return { getPrimary, recordRun, recordCompletion, startHealthChecks, stop, handleCrash };
}
