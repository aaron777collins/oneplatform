import { Worker, Queue } from "bullmq";
import { z } from "zod";
import type { AuditEventRepository } from "../repositories/index.js";

// ---------------------------------------------------------------------------
// BullMQ job schema — mirrors AuditEvent from @oneplatform/core/logger.ts.
// Jobs that fail validation are moved to the DLQ immediately; retrying would
// produce the same failure (producer bug, not a transient infrastructure issue).
// ---------------------------------------------------------------------------

const AuditEventJobSchema = z.object({
  timestamp: z.string().datetime(),
  traceId: z.string().default(""),
  actorId: z.string().min(1).max(255),
  actorType: z.enum(["user", "service", "system"]),
  tenantId: z.string().min(1).max(255),
  action: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(255),
  resourceId: z.string().min(1).max(255),
  result: z.enum(["success", "failure"]),
  metadata: z.record(z.unknown()).default({}),
});

function getWorkerConcurrency(): number {
  return parseInt(process.env["OP_AUDIT_WORKER_CONCURRENCY"] ?? "5", 10);
}

export class AuditService {
  constructor(private readonly repo: AuditEventRepository) {}

  /**
   * Start the BullMQ worker that consumes the `audit` queue.
   *
   * We pass the Redis connection as `{ url: redisUrl }` (RedisOptions) rather
   * than a Redis instance to avoid ioredis version mismatch between the logging
   * service's local ioredis@5.11.1 and the workspace root bullmq@5/ioredis@5.10.1.
   * BullMQ creates its own managed connection from the URL.
   *
   * Worker concurrency is intentionally low (default 5) to avoid overwhelming
   * the Postgres connection pool with concurrent INSERTs. The DLQ absorbs jobs
   * that exhaust all retries so no audit event is silently discarded.
   */
  startAuditWorker(redisUrl: string): Worker {
    const concurrency = getWorkerConcurrency();
    const connection = { url: redisUrl };

    // Set retry defaults on the Queue so that jobs added by any producer
    // inherit exponential backoff. 5 attempts gives ~62 s of total backoff
    // before the job lands in the failed DLQ set.
    const queue = new Queue("audit", {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
      },
    });
    // The queue instance is created only to register default job options;
    // close it immediately so it does not hold a Redis connection open.
    queue.close().catch(() => {});

    const worker = new Worker<unknown>(
      "audit",
      async (job) => {
        const parsed = AuditEventJobSchema.safeParse(job.data);

        if (!parsed.success) {
          // Schema failures are producer bugs — throw immediately so BullMQ
          // moves the job to the failed set after exhausting its retry budget.
          // Retrying would produce the same failure, so this is a DLQ fast-path.
          console.error("Audit job failed schema validation", {
            jobId: job.id,
            issues: parsed.error.issues.length,
          });
          throw new Error(
            `Audit event schema validation failed: ${parsed.error.message}`
          );
        }

        const event = parsed.data;

        await this.repo.insert({
          traceId: event.traceId,
          actorId: event.actorId,
          actorType: event.actorType,
          tenantId: event.tenantId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          result: event.result,
          metadata: event.metadata,
          createdAt: new Date(event.timestamp),
          jobId: job.id ?? null,
        });
      },
      {
        // RedisOptions with url avoids the ioredis instance type mismatch
        connection: { url: redisUrl },
        concurrency,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 100 },
      }
    );

    worker.on("failed", (job, err) => {
      console.error("Audit worker job failed", {
        jobId: job?.id,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    return worker;
  }
}
