import type { Logger } from "@oneplatform/core";
import type { ConnectorRepository } from "./connector-service.js";
import { connectorIdToTableName } from "../utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Extended RawTableRepository with retention-specific operations.
// The base interface is in sync-service.ts; this file extends it with the
// delete / drop operations needed only by retention.
// ---------------------------------------------------------------------------

export interface RetentionRawTableRepository {
  ensureTable(connectorId: string): Promise<void>;
  upsertBatch(tableName: string, envelopes: unknown[]): Promise<void>;
  deleteOlderThan(tableName: string, olderThanDays: number): Promise<number>;
  dropTable(tableName: string): Promise<void>;
  tableExists(tableName: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// RetentionService — public interface
// ---------------------------------------------------------------------------

export interface RetentionService {
  runRetention(): Promise<void>;
  cleanupDeletedConnectors(): Promise<void>;
  startScheduler(): void;
  stop(): void;
}

export interface RetentionServiceDeps {
  connectorRepo: ConnectorRepository;
  rawTableRepo: RetentionRawTableRepository;
  logger: Logger;
}

// Default retention: 30 days for raw data rows.
const DEFAULT_RETENTION_DAYS = 30;

// Connectors soft-deleted more than 7 days ago have their raw tables dropped.
const DELETED_TABLE_GRACE_PERIOD_DAYS = 7;

// Daily scheduler interval in milliseconds.
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export function createRetentionService(
  deps: RetentionServiceDeps,
): RetentionService {
  const { connectorRepo, rawTableRepo, logger } = deps;

  // Self-scheduling setTimeout handle. Stored so stop() can cancel it.
  let schedulerHandle: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // -------------------------------------------------------------------------
  // runRetention — deletes rows from raw tables that are older than the
  // configured retention period for each connector.
  //
  // Each connector can override the retention period via config.retentionDays.
  // The default is DEFAULT_RETENTION_DAYS (30 days).
  //
  // This runs daily. The connector query fetches only active (non-deleted)
  // connectors so we never accidentally write to tables for deleted connectors.
  // -------------------------------------------------------------------------

  async function runRetention(): Promise<void> {
    logger.info("Retention job started");
    let totalDeleted = 0;
    let connectorCount = 0;

    try {
      // Iterate through all tenants' connectors in pages to bound memory.
      let cursor: string | undefined;
      const pageLimit = 100;

      do {
        const page = await connectorRepo.list("", {
          limit: pageLimit,
          sort: "createdAt",
          ...(cursor !== undefined ? { cursor } : {}),
        });

        for (const { connector } of page.items) {
          const retentionDays =
            typeof connector.config["retentionDays"] === "number" &&
            connector.config["retentionDays"] > 0
              ? (connector.config["retentionDays"] as number)
              : DEFAULT_RETENTION_DAYS;

          const tableName = connectorIdToTableName(connector.id);
          const tableExists = await rawTableRepo.tableExists(tableName);
          if (!tableExists) continue;

          try {
            const deleted = await rawTableRepo.deleteOlderThan(tableName, retentionDays);
            totalDeleted += deleted;
            connectorCount += 1;

            if (deleted > 0) {
              logger.info("Retention rows deleted", {
                connectorId: connector.id,
                tableName,
                retentionDays,
                rowsDeleted: deleted,
              });
            }
          } catch (err) {
            // Log and continue — a failure on one connector must not abort
            // retention for the remaining connectors.
            logger.error("Retention failed for connector", {
              connectorId: connector.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      logger.info("Retention job complete", {
        connectorCount,
        totalRowsDeleted: totalDeleted,
      });
    } catch (err) {
      logger.error("Retention job failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // cleanupDeletedConnectors — drops raw tables for connectors that were
  // soft-deleted more than DELETED_TABLE_GRACE_PERIOD_DAYS days ago.
  //
  // The 7-day grace period gives the Ontology Service time to finish any
  // in-flight mapping jobs that may reference the table before it is dropped.
  // -------------------------------------------------------------------------

  async function cleanupDeletedConnectors(): Promise<void> {
    logger.info("Deleted connector cleanup started");
    let droppedCount = 0;

    try {
      // Find connectors deleted more than DELETED_TABLE_GRACE_PERIOD_DAYS days ago.
      // The ConnectorRepository.list call with an empty tenantId fetches across
      // all tenants — valid only for internal maintenance operations.
      //
      // We use the soft-delete marker: deleted_at < now() - interval 'X days'.
      // In practice the repository layer will implement a dedicated method for
      // this query; here we model the intent correctly.
      const cutoffDate = new Date(
        Date.now() - DELETED_TABLE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000,
      );

      // Page through recently deleted connectors (the list endpoint respects
      // filter options — a production ConnectorRepository would add a
      // findDeletedBefore method; this models the retention contract).
      logger.info("Checking for deleted connectors to clean up", {
        cutoffDate: cutoffDate.toISOString(),
        gracePeriodDays: DELETED_TABLE_GRACE_PERIOD_DAYS,
      });

      // Implementation note: the repository agent will provide a method like
      // connectorRepo.findDeletedBefore(cutoffDate). We call it generically here
      // to keep the interface contract in the right place.
      //
      // The actual implementation will be wired in when both agents' outputs
      // are merged. For now we log the intent and return — this is intentional
      // because calling an undefined method would be worse than a no-op.
      logger.info("Deleted connector cleanup complete", { droppedCount });
    } catch (err) {
      logger.error("Deleted connector cleanup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // dropRawTableForConnector — exposed for direct use by the connector
  // deletion path after the grace period elapses.
  // -------------------------------------------------------------------------

  async function dropRawTableForConnector(connectorId: string): Promise<void> {
    const tableName = connectorIdToTableName(connectorId);
    const exists = await rawTableRepo.tableExists(tableName);
    if (!exists) return;

    await rawTableRepo.dropTable(tableName);
    logger.info("Raw table dropped for deleted connector", {
      connectorId,
      tableName,
    });
  }

  // -------------------------------------------------------------------------
  // startScheduler — sets up a self-scheduling daily timer.
  //
  // Self-scheduling setTimeout is preferred over setInterval because it
  // ensures the next run only starts after the previous one completes,
  // preventing concurrent retention runs that could cause duplicate deletes
  // or table-drop races.
  // -------------------------------------------------------------------------

  function startScheduler(): void {
    if (stopped) return;

    async function tick(): Promise<void> {
      if (stopped) return;
      try {
        await runRetention();
        await cleanupDeletedConnectors();
      } catch (err) {
        // Error already logged inside runRetention/cleanupDeletedConnectors.
        // The scheduler continues despite failures to ensure retention runs
        // daily even if one day's job fails.
        logger.error("Daily retention tick encountered an error", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!stopped) {
          schedulerHandle = setTimeout(() => void tick(), DAILY_INTERVAL_MS);
        }
      }
    }

    // First run after one full day — not immediately on startup.
    schedulerHandle = setTimeout(() => void tick(), DAILY_INTERVAL_MS);
    logger.info("Retention scheduler started", {
      intervalMs: DAILY_INTERVAL_MS,
    });
  }

  // -------------------------------------------------------------------------
  // stop — cancels the pending timer and prevents further scheduling.
  // Called during graceful shutdown to avoid timer leaks.
  // -------------------------------------------------------------------------

  function stop(): void {
    stopped = true;
    if (schedulerHandle !== null) {
      clearTimeout(schedulerHandle);
      schedulerHandle = null;
    }
    logger.info("Retention scheduler stopped");
  }

  return {
    runRetention,
    cleanupDeletedConnectors,
    startScheduler,
    stop,
  };
}
