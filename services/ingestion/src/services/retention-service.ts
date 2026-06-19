import type { Logger } from "@oneplatform/core";
import type { ConnectorRepository } from "./connector-service.js";
import type { ConnectorRow } from "../repositories/types.js";
import { connectorIdToTableName } from "../utils/data-envelope.js";

// ---------------------------------------------------------------------------
// Extended RawTableRepository with retention-specific operations.
// The base interface is in sync-service.ts; this file extends it with the
// delete / drop operations needed only by retention.
// ---------------------------------------------------------------------------

export interface RetentionRawTableRepository {
  ensureTable(connectorId: string): Promise<void>;
  upsertBatch(tableName: string, envelopes: unknown[]): Promise<void>;
  /**
   * Delete rows older than the given cutoff.
   * Accepts either a number of days (retention-service path) or a Date
   * (sync-service path). The concrete repository handles both forms.
   */
  deleteOlderThan(tableName: string, olderThan: Date | number): Promise<number>;
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
        // Pass "*" for cross-tenant iteration — the repository contract treats
        // both "" and "*" as "all tenants", but "*" is the explicit sentinel
        // documented in ConnectorRepository.list() and avoids any ambiguity
        // about an accidental empty-string tenant filter.
        const page = await connectorRepo.list("*", {
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
  // soft-deleted more than DELETED_TABLE_GRACE_PERIOD_DAYS days ago, then
  // hard-deletes the connector row.
  //
  // The 7-day grace period gives the Ontology Service time to finish any
  // in-flight mapping jobs that may reference the table before it is dropped.
  //
  // Each connector is processed independently so a failure on one does not
  // abort cleanup for the remaining connectors.
  // -------------------------------------------------------------------------

  async function cleanupDeletedConnectors(): Promise<void> {
    logger.info("Deleted connector cleanup started");
    let droppedCount = 0;

    try {
      const cutoffDate = new Date(
        Date.now() - DELETED_TABLE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000,
      );

      logger.info("Checking for deleted connectors to clean up", {
        cutoffDate: cutoffDate.toISOString(),
        gracePeriodDays: DELETED_TABLE_GRACE_PERIOD_DAYS,
      });

      const deletedConnectors: ConnectorRow[] = await connectorRepo.findDeletedBefore(cutoffDate);

      for (const connector of deletedConnectors) {
        try {
          const tableName = connectorIdToTableName(connector.id);
          const tableExists = await rawTableRepo.tableExists(tableName);

          if (tableExists) {
            await rawTableRepo.dropTable(tableName);
            logger.info("Raw table dropped for deleted connector", {
              connectorId: connector.id,
              tableName,
              deletedAt: connector.deleted_at?.toISOString(),
            });
          }

          // Hard-delete the connector row after the table is gone. This keeps
          // the DB clean and removes the FK anchor that foreign tables rely on.
          await connectorRepo.hardDelete(connector.id);
          droppedCount += 1;

          logger.info("Deleted connector hard-deleted", {
            connectorId: connector.id,
            tenantId: connector.tenant_id,
          });
        } catch (err) {
          // Log and continue — a single connector failure must not abort the
          // cleanup of other connectors.
          logger.error("Failed to clean up deleted connector", {
            connectorId: connector.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

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
