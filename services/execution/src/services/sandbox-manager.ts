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
  /**
   * Number of warm replacement instances to keep ready in the pool.
   * When the primary reaches its recycle threshold, a warm instance is promoted
   * (blue-green) instead of creating a new one from scratch, eliminating the
   * brief outage while the replacement starts. Pool members connect to their
   * own socket paths derived from the primary socket path with a pool index
   * suffix (e.g. /run/sandbox/op-pool-1.sock).
   * Env: OP_SANDBOX_WARM_POOL_SIZE (default: 2)
   */
  warmPoolSize?: number;
  /**
   * Factory for creating additional UnixSocketClient instances for pool members.
   * If omitted, the warm pool feature is disabled and recycling falls back to
   * the original single-instance behaviour (matches the pre-pool implementation).
   */
  createClient?: () => UnixSocketClient;
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
    warmPoolSize = parseInt(process.env["OP_SANDBOX_WARM_POOL_SIZE"] ?? "2", 10),
    createClient,
    onCrash,
  } = deps;

  // Primary sandbox instance — the one receiving all new execution requests.
  // This reference is replaced during blue-green recycle when a warm pool
  // instance is promoted.
  let primary: SandboxInstance = {
    id: "sandbox-primary-0",
    socketPath,
    client: primaryClient,
    state: "STARTING",
    runCount: 0,
    startedAt: new Date(),
    inflightIds: new Set(),
  };

  // ---------------------------------------------------------------------------
  // Warm pool — array of ready sandbox instances waiting to be promoted.
  //
  // WHY: Without a warm pool, recycling the primary creates a brief window where
  // getPrimary() throws DRAINING_OLD. With the pool, we promote a pre-warmed
  // instance as the new primary before draining the old one (blue-green), so
  // callers always have a healthy instance available during recycle.
  //
  // Pool capacity is warmPoolSize. Each pool member uses a dedicated socket
  // path derived from the primary socket path. If createClient is not provided
  // the pool is disabled and we fall back to the original drain-in-place logic.
  // ---------------------------------------------------------------------------
  const warmPool: SandboxInstance[] = [];
  let poolSequence = 0; // monotonically increasing ID suffix for pool instances

  function derivePoolSocketPath(index: number): string {
    // Replace the last .sock suffix (or append) with a pool-member suffix.
    // e.g. /run/sandbox/op.sock → /run/sandbox/op-pool-1.sock
    return socketPath.replace(/\.sock$/, "") + `-pool-${index}.sock`;
  }

  /** Connects a pool instance and marks it ACTIVE. Silently logs errors. */
  async function connectPoolInstance(instance: SandboxInstance): Promise<void> {
    try {
      await instance.client.connect(instance.socketPath);
      instance.state = "ACTIVE";
      instance.startedAt = new Date();
      logger.info("SandboxManager: warm pool instance ready", {
        instanceId: instance.id,
        socketPath: instance.socketPath,
        poolSize: warmPool.length,
      });
    } catch (err) {
      logger.warn("SandboxManager: warm pool instance failed to connect — will retry", {
        instanceId: instance.id,
        socketPath: instance.socketPath,
        error: err instanceof Error ? err.message : String(err),
      });
      // Remove from pool so it is not handed out in STARTING state
      const idx = warmPool.indexOf(instance);
      if (idx !== -1) warmPool.splice(idx, 1);
    }
  }

  /** Replenishes the warm pool up to warmPoolSize. */
  function replenishPool(): void {
    if (createClient === undefined) return; // Pool feature disabled
    if (isDraining) return; // Do not grow pool during shutdown

    while (warmPool.length < warmPoolSize) {
      poolSequence++;
      const newInstance: SandboxInstance = {
        id: `sandbox-pool-${poolSequence}`,
        socketPath: derivePoolSocketPath(poolSequence),
        client: createClient(),
        state: "STARTING",
        runCount: 0,
        startedAt: new Date(),
        inflightIds: new Set(),
      };
      warmPool.push(newInstance);

      void connectPoolInstance(newInstance);
    }
  }

  let consecutivePingMisses = 0;
  let pingIntervalHandle: ReturnType<typeof setInterval> | null = null;
  let recycleTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let isDraining = false;

  // Maps each in-flight executionId to the SandboxInstance it was dispatched on.
  // This is necessary because `primary` may be swapped to a new instance during a
  // blue-green recycle after recordRun() but before recordCompletion() — without
  // this map, recordCompletion would delete from the new primary instead of the
  // old one, leaving the id stuck in oldPrimary.inflightIds and causing the drain
  // to wait the full grace period and then fire a false onCrash.
  const executionInstanceMap = new Map<string, SandboxInstance>();

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
        // After the primary is healthy, seed the warm pool
        replenishPool();
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
    // Store the handle so stop() can cancel a pending reconnect timer
    reconnectTimeoutHandle = setTimeout(() => {
      if (isDraining) return; // Do not reconnect during shutdown
      primary.client
        .connect(primary.socketPath)
        .then(() => {
          reconnectTimeoutHandle = null;
          logger.info("SandboxManager: reconnected to sandbox socket");
          primary.state = "ACTIVE";
          primary.startedAt = new Date();
          consecutivePingMisses = 0;
          scheduleRecycleTimer();
          replenishPool();
        })
        .catch((err: unknown) => {
          logger.warn("SandboxManager: reconnect attempt failed — retrying in 5s", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!isDraining) scheduleReconnect(5_000);
        });
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Recycle — design spec §9.2
  //
  // Blue-green recycle when warm pool is available:
  //   1. Pop an ACTIVE pool instance to become the new primary.
  //   2. Atomically swap primary references — callers see no gap.
  //   3. Drain the old primary in the background.
  //   4. Replenish the pool with a new instance.
  //
  // Without a warm pool (createClient undefined, or pool empty), falls back
  // to the original drain-in-place behaviour which causes a brief DRAINING_OLD
  // window where getPrimary() throws.
  // ---------------------------------------------------------------------------

  function scheduleRecycleTimer(): void {
    if (recycleTimeoutHandle !== null) {
      clearTimeout(recycleTimeoutHandle);
    }
    // Recycle at the interval mark regardless of run count
    recycleTimeoutHandle = setTimeout(() => {
      void triggerRecycle("time");
    }, recycleIntervalMs);
  }

  async function triggerRecycle(reason: "threshold" | "time" | "crash"): Promise<void> {
    if (isDraining) return; // Already draining

    logger.info("SandboxManager: recycle triggered", {
      reason,
      sandboxId: primary.id,
      runCount: primary.runCount,
      warmPoolSize: warmPool.length,
    });

    // Attempt blue-green promotion from warm pool first.
    const poolCandidate = warmPool.find((inst) => inst.state === "ACTIVE");

    if (poolCandidate !== undefined) {
      // Blue-green: promote pool candidate as the new primary BEFORE draining
      // the old one. This eliminates the DRAINING_OLD gap entirely.
      warmPool.splice(warmPool.indexOf(poolCandidate), 1);

      const oldPrimary = primary;
      // Swap the primary reference atomically (JS is single-threaded in the
      // event loop, so this is safe between await points).
      primary = poolCandidate;
      consecutivePingMisses = 0;
      scheduleRecycleTimer();

      logger.info("SandboxManager: blue-green promotion complete — new primary active", {
        newPrimaryId: primary.id,
        oldPrimaryId: oldPrimary.id,
      });

      // Drain the old primary in the background; do not block the caller.
      void drainAndCloseInstance(oldPrimary, reason);

      // Immediately replenish the pool to maintain desired pool size.
      replenishPool();
      return;
    }

    // No warm pool candidate available — fall back to drain-in-place.
    // This causes a brief DRAINING_OLD window where getPrimary() throws.
    isDraining = true;
    primary.state = "DRAINING_OLD";
    primary.runCount = 0;

    const drainStart = Date.now();
    await waitForInflightDrain(primary, drainStart);

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

    logger.info("SandboxManager: recycle complete (drain-in-place)", { sandboxId: primary.id });
    scheduleRecycleTimer();
    replenishPool();
  }

  /** Drains a retiring sandbox instance and closes its client. */
  async function drainAndCloseInstance(
    instance: SandboxInstance,
    reason: string,
  ): Promise<void> {
    instance.state = "DRAINING_OLD";
    const drainStart = Date.now();

    await waitForInflightDrain(instance, drainStart);

    try {
      await instance.client.drain();
    } catch (err) {
      logger.warn("SandboxManager: drain command failed on retiring instance", {
        instanceId: instance.id,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    instance.client.close();
    logger.info("SandboxManager: retired sandbox instance closed", {
      instanceId: instance.id,
      reason,
    });
  }

  async function waitForInflightDrain(instance: SandboxInstance, startMs: number): Promise<void> {
    return new Promise((resolve) => {
      function check(): void {
        const elapsed = Date.now() - startMs;
        if (instance.inflightIds.size === 0 || elapsed >= drainGracePeriodMs) {
          if (instance.inflightIds.size > 0) {
            logger.warn("SandboxManager: drain grace period expired with in-flight executions", {
              instanceId: instance.id,
              remainingInflight: instance.inflightIds.size,
              killedIds: Array.from(instance.inflightIds),
            });
            // Force-kill remaining — mark them as killed via onCrash notification
            const killedIds = Array.from(instance.inflightIds);
            instance.inflightIds.clear();
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
    // Guard against a race where getPrimary() succeeded (state was ACTIVE) but
    // triggerRecycle() ran between that check and this call (e.g., the recycle
    // timer fired). Adding to inflightIds while a drain is in progress causes
    // waitForInflightDrain to wait for or force-kill this freshly dispatched
    // execution, producing unexpected execution failures.
    if (primary.state === "DRAINING_OLD") {
      throw new ExecutionSandboxUnavailableError(
        "Sandbox transitioned to DRAINING_OLD between getPrimary() and recordRun() — retry the execution.",
      );
    }

    // Capture the instance reference at dispatch time so recordCompletion
    // always removes from the same instance, even if a blue-green swap happens
    // between recordRun() and recordCompletion().
    const dispatchedInstance = primary;
    dispatchedInstance.inflightIds.add(executionId);
    dispatchedInstance.runCount++;
    executionInstanceMap.set(executionId, dispatchedInstance);

    if (dispatchedInstance.runCount >= recycleAfterCount && !isDraining) {
      // Trigger recycle asynchronously — do not block the calling execution
      void triggerRecycle("threshold");
    }
  }

  function recordCompletion(executionId: string): void {
    // Use the map to find the exact instance this execution was dispatched on.
    // Without this, a blue-green swap between recordRun and recordCompletion
    // would cause the delete to target the new primary instead of the old one,
    // leaving the id in oldPrimary.inflightIds and triggering a false onCrash.
    const instance = executionInstanceMap.get(executionId);
    if (instance !== undefined) {
      instance.inflightIds.delete(executionId);
      executionInstanceMap.delete(executionId);
    }
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
    isDraining = true;
    if (pingIntervalHandle !== null) {
      clearInterval(pingIntervalHandle);
      pingIntervalHandle = null;
    }
    if (recycleTimeoutHandle !== null) {
      clearTimeout(recycleTimeoutHandle);
      recycleTimeoutHandle = null;
    }
    if (reconnectTimeoutHandle !== null) {
      clearTimeout(reconnectTimeoutHandle);
      reconnectTimeoutHandle = null;
    }
    primary.client.close();
    // Close all warm pool instances
    for (const inst of warmPool) {
      inst.client.close();
    }
    warmPool.length = 0;
  }

  return { getPrimary, recordRun, recordCompletion, startHealthChecks, stop, handleCrash };
}
