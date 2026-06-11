import type { Logger } from "@oneplatform/core";
import type { Redis } from "ioredis";
import jsonata from "jsonata";
import type { PipelineRow, PipelineDefinition } from "./pipeline-service.js";
import type { TriggeredBy, RunService } from "./run-service.js";
import type { TriggerRow as RepoTriggerRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

// TriggerRow uses the concrete repo type. config is stored as JSONB
// Record<string,unknown>; the service casts it to TriggerConfig where needed.
export type TriggerRow = RepoTriggerRow;

export type TriggerConfig =
  | EventTriggerConfig
  | WebhookTriggerConfig;

export interface EventTriggerConfig {
  type: "event";
  channel: string;
  eventType?: string;
  filter?: string; // JSONata expression applied to event.data
}

export interface WebhookTriggerConfig {
  type: "webhook";
  slug: string;
  secret: string;
  allowedMethods: string[];
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface TriggerRepository {
  findEnabledByType(triggerType: TriggerRow["trigger_type"]): Promise<TriggerRow[]>;
  findById(id: string): Promise<TriggerRow | null>;
}

// ---------------------------------------------------------------------------
// Inline PipelineRepository interface (only fields needed by TriggerService)
// ---------------------------------------------------------------------------

interface PipelineRepo {
  findById(id: string): Promise<PipelineRow | null>;
}

// ---------------------------------------------------------------------------
// Platform event shape (subset used for matching)
// ---------------------------------------------------------------------------

interface PlatformEvent {
  eventId?: string;
  eventType?: string;
  tenantId: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TriggerService {
  loadTriggers(): Promise<void>;
  stop(): void;
}

export interface TriggerServiceDeps {
  triggerRepo: TriggerRepository;
  pipelineRepo: PipelineRepo;
  runService: RunService;
  redis: Redis;
  // Redis URL is injected so the service does not read process.env directly
  // (W9 — concrete config dependency belongs at the composition root in index.ts)
  redisUrl: string;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Filter evaluation with 100ms timeout (design spec §8.2)
// Fail-open: if the filter expression throws or times out, the trigger fires.
// ---------------------------------------------------------------------------

async function evaluateFilter(
  filterExpr: string,
  eventData: Record<string, unknown>,
): Promise<boolean> {
  try {
    const expr = jsonata(filterExpr);
    const result = await Promise.race([
      expr.evaluate(eventData),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);
    // undefined means timeout — fail-open
    return result === undefined ? true : Boolean(result);
  } catch {
    // Filter evaluation errors are fail-open for event triggers
    return true;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTriggerService(deps: TriggerServiceDeps): TriggerService {
  const { triggerRepo, pipelineRepo, runService, redis, redisUrl, logger } = deps;

  // Active subscription state: channel → subscriber client
  // We use a single dedicated subscriber Redis connection to avoid polluting
  // the main Redis client's pub/sub mode.
  let subscriberClient: Redis | null = null;

  // Channel → list of trigger IDs subscribed on that channel
  const channelTriggerMap = new Map<string, string[]>();

  // All loaded trigger rows indexed by ID
  const triggerMap = new Map<string, TriggerRow>();

  // -------------------------------------------------------------------------
  // handleEvent — dispatched when a subscribed Redis channel fires
  // -------------------------------------------------------------------------

  async function handleEvent(channel: string, message: string): Promise<void> {
    let event: PlatformEvent;
    try {
      event = JSON.parse(message) as PlatformEvent;
    } catch {
      logger.warn("TriggerService: received invalid JSON on channel", { channel });
      return;
    }

    const triggerIds = channelTriggerMap.get(channel) ?? [];

    for (const triggerId of triggerIds) {
      const trigger = triggerMap.get(triggerId);
      if (trigger === undefined || !trigger.enabled) continue;
      if (trigger.trigger_type !== "event") continue;

      // config is stored as JSONB Record<string,unknown>; cast via unknown since
      // the concrete type (EventTriggerConfig) was validated at write time.
      const config = trigger.config as unknown as EventTriggerConfig;

      // Optional exact eventType match
      if (config.eventType !== undefined && event.eventType !== config.eventType) {
        continue;
      }

      // Optional JSONata filter on event.data
      if (config.filter !== undefined) {
        const passes = await evaluateFilter(config.filter, event.data);
        if (!passes) continue;
      }

      // Check pipeline state before triggering
      const pipeline = await pipelineRepo.findById(trigger.pipeline_id);
      if (pipeline === null || !pipeline.is_active) {
        logger.info("Event trigger skipped: pipeline inactive", {
          triggerId,
          pipelineId: trigger.pipeline_id,
        });
        continue;
      }

      // definition is stored as JSONB Record<string,unknown>; cast to PipelineDefinition
      // which was validated at write time.
      const pipelineDefinition = pipeline.definition as unknown as PipelineDefinition;
      // allowConcurrentRuns=false → silently drop if a run is already active
      if (pipelineDefinition.options?.allowConcurrentRuns === false) {
        // The RunService.triggerRun will throw PipelineConcurrentRunError if
        // a run is active; we catch and log it as informational.
      }

      try {
        await runService.triggerRun(
          trigger.pipeline_id,
          trigger.tenant_id,
          "event" as TriggeredBy,
          event.data,
          {
            channel,
            ...(event.eventType !== undefined ? { eventType: event.eventType } : {}),
            ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
          },
        );

        logger.info("Event trigger fired run", {
          triggerId,
          pipelineId: trigger.pipeline_id,
          channel,
        });
      } catch (err) {
        // Concurrent run conflict is expected and should be logged as info, not error
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if (code === "PIPELINE_CONCURRENT_RUN_ACTIVE") {
          logger.info("Event trigger skipped: concurrent run active", {
            triggerId,
            pipelineId: trigger.pipeline_id,
          });
        } else {
          logger.error("Event trigger failed to start run", {
            triggerId,
            pipelineId: trigger.pipeline_id,
            error: message,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // loadTriggers — loads all enabled event triggers and subscribes to channels
  // -------------------------------------------------------------------------

  async function loadTriggers(): Promise<void> {
    // Only event triggers require Redis subscriptions; webhook triggers are
    // handled by the internal route handler (the Gateway forwards inbound calls).
    const eventTriggers = await triggerRepo.findEnabledByType("event");

    if (eventTriggers.length === 0) {
      logger.info("No event triggers configured — skipping Redis subscriber setup.");
      return;
    }

    // Build lookup tables
    for (const trigger of eventTriggers) {
      triggerMap.set(trigger.id, trigger);

      // config is stored as JSONB Record<string,unknown>; cast via unknown.
      const config = trigger.config as unknown as EventTriggerConfig;
      const existing = channelTriggerMap.get(config.channel) ?? [];
      channelTriggerMap.set(config.channel, [...existing, trigger.id]);
    }

    // Create a dedicated subscriber connection — ioredis requires a separate
    // client once subscribe() is called, as the client enters subscriber mode.
    // redisUrl is injected at construction time so this service has no direct
    // dependency on process.env (consistent with the composition root pattern).
    const { createRedisClient } = await import("@oneplatform/core");
    subscriberClient = createRedisClient({ url: redisUrl });

    subscriberClient.on("message", (channel: string, message: string) => {
      void handleEvent(channel, message).catch((err) => {
        logger.error("TriggerService: handleEvent threw", {
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    subscriberClient.on("error", (err) => {
      logger.error("TriggerService: Redis subscriber error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const channels = Array.from(channelTriggerMap.keys());
    if (channels.length > 0) {
      await subscriberClient.subscribe(...channels);
      logger.info("Event trigger subscriptions established", { channels });
    }
  }

  // -------------------------------------------------------------------------
  // stop — unsubscribe and disconnect
  // -------------------------------------------------------------------------

  function stop(): void {
    if (subscriberClient !== null) {
      subscriberClient.disconnect();
      subscriberClient = null;
    }
    channelTriggerMap.clear();
    triggerMap.clear();
    logger.info("TriggerService stopped.");
  }

  return { loadTriggers, stop };
}
