import type pg from "pg";

// ---------------------------------------------------------------------------
// Retention configuration from environment variables
// ---------------------------------------------------------------------------

function getRetentionDays(key: string, defaultDays: number, aliasKey?: string): number {
  // Check primary key first, then optional alias, then default.
  // The alias lets us support both historical and documented env var names
  // without breaking existing deployments.
  const raw = process.env[key] ?? (aliasKey !== undefined ? process.env[aliasKey] : undefined);
  const parsed = parseInt(raw ?? String(defaultDays), 10);
  return Number.isNaN(parsed) || parsed < 1 ? defaultDays : parsed;
}

// ---------------------------------------------------------------------------
// Helpers for monthly partition naming (no external date-fns dependency)
// ---------------------------------------------------------------------------

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
}

function formatPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `events_${year}_${month}`;
}

// ---------------------------------------------------------------------------
// RetentionService
//
// Manages two scheduled tasks:
//   - Daily retention job (02:00 UTC): deletes rows, drops old partitions,
//     archives expired audit events.
//   - Monthly partition pre-creation (1st of each month, 00:05 UTC): creates
//     partitions for the current and next month so the first event of a new
//     month always has a partition to land in.
// ---------------------------------------------------------------------------

export class RetentionService {
  private retentionTimer: NodeJS.Timeout | null = null;
  private partitionTimer: NodeJS.Timeout | null = null;
  private retentionRunning = false;

  constructor(private readonly db: pg.Pool) {}

  /**
   * Create partitions for the current month and the next month if they don't
   * already exist. Uses CREATE TABLE IF NOT EXISTS so it is safe to call
   * multiple times (idempotent).
   */
  async ensurePartitions(): Promise<void> {
    const now = new Date();
    const months = [startOfMonth(now), startOfMonth(addMonths(now, 1))];

    for (const start of months) {
      const end = addMonths(start, 1);
      const name = formatPartitionName(start);

      // Validate the partition name before interpolating it into DDL.
      // The name is derived from formatPartitionName() which is trusted, but
      // a corrupted date or unexpected locale must never produce arbitrary DDL.
      // The expected format is events_YYYY_MM.
      if (!/^events_\d{4}_\d{2}$/.test(name)) {
        console.error("Skipping partition creation for unexpected partition name", {
          partitionName: name,
        });
        continue;
      }

      await this.db.query(
        `CREATE TABLE IF NOT EXISTS logging.${name}
         PARTITION OF logging.events
         FOR VALUES FROM ($1) TO ($2)`,
        [start.toISOString(), end.toISOString()]
      );

      // Track in registry so the retention job can query it without hitting
      // information_schema in hot paths.
      await this.db.query(
        `INSERT INTO logging.partition_registry
           (partition_name, table_name, period_start, period_end)
         VALUES ($1, 'events', $2, $3)
         ON CONFLICT (partition_name) DO NOTHING`,
        [name, start.toISOString(), end.toISOString()]
      );
    }
  }

  /**
   * Run the full retention policy:
   *  1. Delete debug rows older than OP_RETENTION_DEBUG_DAYS (default 7)
   *  2. Delete info rows older than OP_RETENTION_INFO_DAYS (default 30)
   *  3. Drop partitions entirely outside OP_RETENTION_ERROR_DAYS (default 90)
   *  4. Hard-delete archived audit events past OP_RETENTION_AUDIT_DAYS (default 365)
   *
   * Partition drops are metadata-only operations in Postgres — instantaneous
   * regardless of row count. This is the primary reason for time-partitioning.
   */
  async runRetention(): Promise<void> {
    if (this.retentionRunning) {
      throw new Error("Retention job is already running");
    }
    this.retentionRunning = true;

    const debugDays = getRetentionDays("OP_RETENTION_DEBUG_DAYS", 7);
    const infoDays = getRetentionDays("OP_RETENTION_INFO_DAYS", 30);
    const errorDays = getRetentionDays("OP_RETENTION_ERROR_DAYS", 90);
    // OP_AUDIT_RETENTION_DAYS is the documented name (PA-013).
    // OP_RETENTION_AUDIT_DAYS is the legacy alias kept for backward compatibility.
    const auditDays = getRetentionDays("OP_AUDIT_RETENTION_DAYS", 365, "OP_RETENTION_AUDIT_DAYS");

    try {
      // 1. Row-level delete for debug (monthly partitions span all levels; we
      //    can't drop a partition that still contains recent warn/error rows).
      await this.db.query(
        `DELETE FROM logging.events
         WHERE level = 'debug'
           AND created_at < now() - ($1 || ' days')::interval`,
        [String(debugDays)]
      );

      // 2. Row-level delete for info
      await this.db.query(
        `DELETE FROM logging.events
         WHERE level = 'info'
           AND created_at < now() - ($1 || ' days')::interval`,
        [String(infoDays)]
      );

      // 3. Drop partitions where the entire period is outside the 90-day window.
      //    Dropping a partition is instant (DDL metadata operation).
      const oldPartitions = await this.db.query<{ partition_name: string }>(
        `SELECT partition_name FROM logging.partition_registry
         WHERE table_name = 'events'
           AND dropped_at IS NULL
           AND period_end < now() - ($1 || ' days')::interval`,
        [String(errorDays)]
      );

      for (const row of oldPartitions.rows) {
        const partitionName = row["partition_name"];

        // Validate the partition name before interpolating it into DDL.
        // The registry is trusted but a corrupted row must never produce
        // an arbitrary DDL injection. The expected format is events_YYYY_MM.
        if (!/^events_\d{4}_\d{2}$/.test(partitionName)) {
          console.error("Skipping drop for unexpected partition name", {
            partitionName,
          });
          continue;
        }

        await this.db.query(
          `DROP TABLE IF EXISTS logging.${partitionName}`
        );
        await this.db.query(
          `UPDATE logging.partition_registry
           SET dropped_at = now()
           WHERE partition_name = $1`,
          [partitionName]
        );
        console.info("Dropped partition", { partition: partitionName });
      }

      // 4. Hard-delete audit events that have passed the minimum retention window.
      //    The archived flag is never set here — the L2 design clarifies that
      //    hard-delete happens after 365 days, regardless of the archived flag.
      await this.db.query(
        `DELETE FROM logging.audit_events
         WHERE created_at < now() - ($1 || ' days')::interval`,
        [String(auditDays)]
      );

      console.info("Retention job completed", {
        debugDays,
        infoDays,
        errorDays,
        auditDays,
        droppedPartitions: oldPartitions.rows.length,
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("Retention job failed", { error: error.message });
      throw error;
    } finally {
      this.retentionRunning = false;
    }
  }

  /**
   * Schedule the retention job to run daily at 02:00 UTC.
   * Uses a self-rescheduling setTimeout rather than node-cron to avoid an
   * additional dependency.
   */
  startRetentionScheduler(): void {
    const scheduleNext = (): void => {
      const msUntilNext = msUntilNextUtcHour(2);
      this.retentionTimer = setTimeout(() => {
        // scheduleNext() is called inside the completion callback so the next
        // timer is only set after the current run finishes (or errors). Calling
        // it immediately after the promise would start the next timer before
        // the job completes, risking overlap when the job runs long.
        this.runRetention()
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error("Scheduled retention job failed", { error: error.message });
          })
          .then(() => {
            scheduleNext();
          })
          .catch(() => {
            // scheduleNext itself does not throw, but .then chains must be caught
            // to satisfy the no-floating-promises lint rule.
          });
      }, msUntilNext);
    };

    scheduleNext();
    console.info("Retention scheduler started (daily at 02:00 UTC)");
  }

  /**
   * Schedule partition pre-creation on the 1st of each month at 00:05 UTC.
   */
  startPartitionScheduler(): void {
    const scheduleNext = (): void => {
      const msUntilNext = msUntilFirstOfMonthAt0005Utc();
      this.partitionTimer = setTimeout(() => {
        // Same reasoning as startRetentionScheduler: schedule the next run
        // only after the current one completes to avoid overlap.
        this.ensurePartitions()
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error("Partition pre-creation failed", { error: error.message });
          })
          .then(() => {
            scheduleNext();
          })
          .catch(() => {});
      }, msUntilNext);
    };

    scheduleNext();
    console.info("Partition scheduler started (monthly on 1st at 00:05 UTC)");
  }

  stop(): void {
    if (this.retentionTimer !== null) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.partitionTimer !== null) {
      clearTimeout(this.partitionTimer);
      this.partitionTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Schedule math helpers
// ---------------------------------------------------------------------------

/**
 * Returns milliseconds until the next occurrence of `hour:00:00 UTC`.
 * If the current time is already past the target hour today, schedules for
 * the same hour tomorrow.
 */
function msUntilNextUtcHour(hour: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      0,
      0,
      0
    )
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Returns milliseconds until 00:05:00 UTC on the first day of the next month.
 */
function msUntilFirstOfMonthAt0005Utc(): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5, 0, 0)
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCFullYear(next.getUTCFullYear(), next.getUTCMonth() + 1, 1);
  }
  return next.getTime() - now.getTime();
}
