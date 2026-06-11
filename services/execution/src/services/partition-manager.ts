import type { Pool } from "pg";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// PartitionManager — manages monthly table partitions for execution tables
// Design spec §3 (database schema) / §15.3 retention cleanup
//
// Creates partitions for the current month and 2 future months at startup,
// then runs a daily check at 03:00 UTC. Drops old partitions beyond the
// retention window without table scans — this is the primary value of
// range partitioning for high-volume execution records.
// ---------------------------------------------------------------------------

export interface PartitionManager {
  ensureCurrentPartitions(): Promise<void>;
  cleanupOldPartitions(retentionDays: number): Promise<void>;
  stop(): void;
}

export interface PartitionManagerDeps {
  pool: Pool;
  logger: Logger;
}

// Tables that use the same monthly partition boundaries (co-partitioned)
const PARTITIONED_TABLES = ["execution.executions", "execution.execution_logs"] as const;

// Partition range column per table — must match the CREATE TABLE definition
const PARTITION_COLUMN: Record<string, string> = {
  "execution.executions": "started_at",
  "execution.execution_logs": "execution_date",
};

export function createPartitionManager(deps: PartitionManagerDeps): PartitionManager {
  const { pool, logger } = deps;
  let dailyHandle: ReturnType<typeof setTimeout> | null = null;

  // ---------------------------------------------------------------------------
  // Partition naming — "executions_2026_06" for June 2026
  // ---------------------------------------------------------------------------

  function partitionSuffix(year: number, month: number): string {
    const mm = String(month).padStart(2, "0");
    return `${year}_${mm}`;
  }

  function partitionName(table: string, year: number, month: number): string {
    // Convert "execution.executions" → "executions_2026_06"
    const base = table.split(".")[1] ?? table;
    return `${base}_${partitionSuffix(year, month)}`;
  }

  // First day of a given month (UTC)
  function monthStart(year: number, month: number): string {
    const mm = String(month).padStart(2, "0");
    return `${year}-${mm}-01`;
  }

  // First day of the NEXT month (partition end boundary is exclusive)
  function nextMonthStart(year: number, month: number): string {
    if (month === 12) {
      return `${year + 1}-01-01`;
    }
    return monthStart(year, month + 1);
  }

  // ---------------------------------------------------------------------------
  // ensureCurrentPartitions — idempotent, creates up to 3 monthly partitions
  // ---------------------------------------------------------------------------

  async function ensureCurrentPartitions(): Promise<void> {
    const now = new Date();
    const client = await pool.connect();

    try {
      for (let offset = 0; offset <= 2; offset++) {
        const date = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        const year = date.getFullYear();
        const month = date.getMonth() + 1; // JS months are 0-based

        for (const table of PARTITIONED_TABLES) {
          const pName = partitionName(table, year, month);
          const from = monthStart(year, month);
          const to = nextMonthStart(year, month);

          // CREATE TABLE IF NOT EXISTS ... PARTITION OF ... handles idempotency
          await client.query(`
            CREATE TABLE IF NOT EXISTS execution.${pName}
            PARTITION OF ${table}
            FOR VALUES FROM ('${from}') TO ('${to}')
          `);

          logger.debug("PartitionManager: partition ensured", { table, partition: pName, from, to });
        }
      }

      logger.info("PartitionManager: current partitions ensured", {
        monthsAhead: 2,
        tables: PARTITIONED_TABLES,
      });
    } catch (err) {
      logger.error("PartitionManager: failed to ensure partitions", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // cleanupOldPartitions — drops partitions older than retentionDays
  // ---------------------------------------------------------------------------

  async function cleanupOldPartitions(retentionDays: number): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    // We drop entire months — the cutoff month boundary is aligned to the
    // start of the month containing the cutoff date.
    const cutoffYear = cutoff.getFullYear();
    const cutoffMonth = cutoff.getMonth() + 1;

    const client = await pool.connect();
    try {
      // Query existing partitions from information_schema
      const result = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'execution'
          AND table_type = 'BASE TABLE'
          AND (table_name LIKE 'executions\\_%' OR table_name LIKE 'execution\\_logs\\_%')
        ORDER BY table_name
      `);

      for (const row of result.rows) {
        const name = row["table_name"];
        // Extract year and month from suffix: e.g. "executions_2026_01" → 2026, 1
        const match = /^(?:executions|execution_logs)_(\d{4})_(\d{2})$/.exec(name);
        if (match === null) continue;

        const year = parseInt(match[1] ?? "0", 10);
        const month = parseInt(match[2] ?? "0", 10);

        // Drop if the partition's ENTIRE month is before the cutoff month
        const isBeforeCutoff =
          year < cutoffYear || (year === cutoffYear && month < cutoffMonth);

        if (isBeforeCutoff) {
          await client.query(`DROP TABLE IF EXISTS execution.${name}`);
          logger.info("PartitionManager: dropped old partition", { partition: name, cutoffDays: retentionDays });
        }
      }
    } catch (err) {
      logger.error("PartitionManager: cleanup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Daily scheduler — runs at 03:00 UTC each day
  // ---------------------------------------------------------------------------

  function scheduleDailyCheck(retentionDays: number): void {
    const now = new Date();
    const nextRun = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3, 0, 0, 0),
    );
    const delayMs = nextRun.getTime() - now.getTime();

    dailyHandle = setTimeout(() => {
      void (async () => {
        await ensureCurrentPartitions().catch((err) => {
          logger.error("PartitionManager: daily partition ensure failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        await cleanupOldPartitions(retentionDays).catch((err) => {
          logger.error("PartitionManager: daily cleanup failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        // Reschedule for the next day
        scheduleDailyCheck(retentionDays);
      })();
    }, delayMs);
  }

  function stop(): void {
    if (dailyHandle !== null) {
      clearTimeout(dailyHandle);
      dailyHandle = null;
    }
  }

  // Start the daily scheduler with the configured retention days.
  // This side-effect is triggered by the caller (index.ts) passing retentionDays
  // via ensureCurrentPartitions → scheduleDailyCheck. We expose a separate
  // startDailyScheduler entry so index.ts can call it explicitly.
  const partitionManager: PartitionManager & { startDailyScheduler(retentionDays: number): void } = {
    ensureCurrentPartitions,
    cleanupOldPartitions,
    stop,
    startDailyScheduler(retentionDays: number): void {
      scheduleDailyCheck(retentionDays);
    },
  };

  return partitionManager;
}
