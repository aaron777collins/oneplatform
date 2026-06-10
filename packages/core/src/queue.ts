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

export function createQueue(name: string, connection: ConnectionOptions): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

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

// Returns a dead-letter queue for the given primary queue.  Callers move
// unrecoverable jobs here manually after exhausting retries so they are
// isolated from active work and can be replayed or archived independently.
export function createDlqQueue(
  primaryQueueName: string,
  connection: ConnectionOptions
): Queue {
  return new Queue(`${primaryQueueName}:dlq`, { connection });
}
