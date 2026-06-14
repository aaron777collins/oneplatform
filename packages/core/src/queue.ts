import { Queue, Worker, type Processor, type ConnectionOptions } from "bullmq";

// Five attempts with exponential backoff gives ~31s total wait before a job is
// declared failed, which is enough headroom for transient Redis blips without
// holding up the pipeline indefinitely.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 1_000,
  },
};

/**
 * Creates a BullMQ `Queue` with the platform-standard retry policy
 * (5 attempts, exponential backoff starting at 1 s).
 *
 * @param name       - Queue name; must be unique per Redis namespace.
 * @param connection - ioredis connection options or a `Redis` instance.
 */
export function createQueue(name: string, connection: ConnectionOptions): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Creates a BullMQ `Worker` that processes jobs from the named queue.
 *
 * Completed jobs are removed immediately (no retention cost). Failed jobs are
 * kept (up to 100) so the DLQ inspector can examine them without a separate
 * persistence layer.
 *
 * @param queueName  - Must match the queue created by {@link createQueue}.
 * @param processor  - Async function invoked for each job.
 * @param connection - ioredis connection options or a `Redis` instance.
 */
export function createWorker<T = unknown, R = unknown>(
  queueName: string,
  processor: Processor<T, R>,
  connection: ConnectionOptions
): Worker<T, R> {
  return new Worker<T, R>(queueName, processor, {
    connection,
    // Completed jobs are ephemeral — callers pull results synchronously.
    // Failed jobs are retained (up to 100) so the DLQ inspector can examine
    // them without needing a separate persistence layer.
    removeOnComplete: { count: 0 },
    removeOnFail: { count: 100 },
  });
}

/**
 * Returns a dead-letter queue for the given primary queue.
 *
 * Move unrecoverable jobs here manually after exhausting retries so they are
 * isolated from active work and can be replayed or archived independently.
 *
 * The DLQ name is `{primaryQueueName}:dlq`.
 *
 * @param primaryQueueName - The name of the primary queue this DLQ mirrors.
 * @param connection       - ioredis connection options or a `Redis` instance.
 */
export function createDlqQueue(
  primaryQueueName: string,
  connection: ConnectionOptions
): Queue {
  return new Queue(`${primaryQueueName}:dlq`, { connection });
}
