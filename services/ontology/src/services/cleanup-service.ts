import type pg from "pg";
import type { Redis } from "ioredis";
import type { Logger } from "@oneplatform/core";
import type { ShadowRegistryRepository } from "../repositories/shadow-registry-repository.js";
import { quotePgIdentifier } from "../utils/pg-identifier.js";

export interface CleanupServiceDeps {
  db: pg.Pool;
  redis: Redis;
  logger: Logger;
  shadowRegistryRepo: ShadowRegistryRepository;
}

export interface CleanupService {
  runCleanup(): Promise<{ tier1: number; tier2: number; tier3: number }>;
  startBackgroundJob(intervalMs?: number): void;
  stopBackgroundJob(): void;
}

const LOCK_KEY = "ontology:cleanup:lock";
const LOCK_TTL = 3600; // 1 hour
const DEFAULT_INTERVAL = 60 * 60 * 1000; // 1 hour

export function createCleanupService(deps: CleanupServiceDeps): CleanupService {
  const { db, redis, logger, shadowRegistryRepo } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    async runCleanup() {
      // Acquire distributed lock
      const lockId = `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const acquired = await redis.set(LOCK_KEY, lockId, "EX", LOCK_TTL, "NX");
      if (!acquired) {
        logger.debug("Cleanup lock held by another replica, skipping.");
        return { tier1: 0, tier2: 0, tier3: 0 };
      }

      let tier1 = 0;
      let tier2 = 0;
      let tier3 = 0;

      try {
        // Tier 1: Registered, valid orphans (24 hours old)
        const orphans = await shadowRegistryRepo.findActiveOrphans(24);
        for (const orphan of orphans) {
          const fullTable = `${quotePgIdentifier(orphan.schema_name)}.${quotePgIdentifier(orphan.table_name)}`;
          try {
            // Verify table exists
            const exists = await db.query(
              `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
              [orphan.schema_name, orphan.table_name],
            );
            if (exists.rowCount === 0) {
              await shadowRegistryRepo.updateStatus(orphan.id, "corrupt");
              tier2++;
              continue;
            }

            // Verify row count
            const countResult = await db.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM ${fullTable}`,
            );
            const liveCount = parseInt(countResult.rows[0]!["count"], 10);
            if (liveCount !== orphan.row_count) {
              logger.warn(`Shadow table ${orphan.table_name} row count mismatch: expected ${orphan.row_count}, got ${liveCount}`);
              await shadowRegistryRepo.updateStatus(orphan.id, "corrupt");
              tier2++;
              continue;
            }

            await db.query(`DROP TABLE ${fullTable} CASCADE`);
            await shadowRegistryRepo.updateStatus(orphan.id, "dropped");
            tier1++;
            logger.info(`Cleaned up shadow table ${orphan.table_name}`);
          } catch (err) {
            logger.error(`Failed to clean up shadow table ${orphan.table_name}: ${String(err)}`);
            await shadowRegistryRepo.updateStatus(orphan.id, "corrupt");
            tier2++;
          }
        }

        // Tier 3: Unregistered shadow tables (48 hours old)
        const unregistered = await shadowRegistryRepo.findUnregisteredShadowTables(48);
        for (const table of unregistered) {
          const fullTable = `${quotePgIdentifier(table["table_schema"])}.${quotePgIdentifier(table["table_name"])}`;
          try {
            await db.query(`DROP TABLE ${fullTable} CASCADE`);
            tier3++;
            logger.info(`Cleaned up unregistered shadow table ${table["table_name"]}`);
          } catch (err) {
            logger.error(`Failed to clean up unregistered shadow table ${table["table_name"]}: ${String(err)}`);
          }
        }

        logger.info(`Shadow table cleanup: tier1=${tier1}, tier2=${tier2}, tier3=${tier3}`);
      } finally {
        // Release lock (only if we still hold it)
        const currentLock = await redis.get(LOCK_KEY);
        if (currentLock === lockId) {
          await redis.del(LOCK_KEY);
        }
      }

      return { tier1, tier2, tier3 };
    },

    startBackgroundJob(intervalMs = DEFAULT_INTERVAL) {
      if (timer) return;
      timer = setInterval(() => {
        this.runCleanup().catch((err) => {
          logger.error(`Background cleanup failed: ${String(err)}`);
        });
      }, intervalMs);
      logger.info(`Shadow table cleanup job started (interval: ${intervalMs}ms)`);
    },

    stopBackgroundJob() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        logger.info("Shadow table cleanup job stopped");
      }
    },
  };
}
