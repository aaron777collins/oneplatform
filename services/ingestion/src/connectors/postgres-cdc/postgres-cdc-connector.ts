/**
 * PostgreSQL CDC connector — built-in, NOT an isolated-vm plugin.
 *
 * Uses PostgreSQL logical replication with the pgoutput plugin to stream
 * WAL (Write-Ahead Log) changes as CdcEvent values. Requires:
 *   - wal_level = logical in postgresql.conf
 *   - A named publication created in advance: CREATE PUBLICATION <name> FOR TABLE ...
 *   - The connecting user granted REPLICATION privilege
 *
 * Connection lifecycle:
 *   connect()         — validates config, confirms replication slot exists
 *                       (creates one with pgoutput if absent)
 *   startCdcStream()  — opens the replication connection, returns AsyncIterable
 *   stopCdcStream()   — signals the generator to finish, closes the connection
 *   disconnect()      — releases the non-replication control connection
 *
 * Position tracking:
 *   The LSN of the last committed batch is persisted by CdcIngestionService.
 *   On restart, CdcOptions.startPosition carries the last confirmed LSN so
 *   no events are lost and duplicates are bounded to the last uncommitted batch.
 *
 * Feedback loop:
 *   PostgreSQL requires periodic standby status updates to advance the
 *   confirmed_flush_lsn on the replication slot. Without feedback the slot
 *   retains WAL indefinitely, causing disk exhaustion. We send feedback after
 *   each committed batch and on a 10-second keepalive interval.
 */

import pg from "pg";
import type { PluginContext } from "@oneplatform/plugin-sdk";
import type { CdcEvent, CdcOptions, ReplicationSlotInfo, CdcConnector } from "@oneplatform/plugin-sdk";
import type { ConnectorHandle, BatchResult } from "@oneplatform/plugin-sdk";
import type { ConnectorMetadata } from "@oneplatform/plugin-sdk";
import type { PostgresCdcConfig, CachedRelation } from "./types.js";
import { decodePgOutputMessage, pgTimestampToIso } from "./pgoutput-decoder.js";
import { formatLsn, parseLsn, maxLsn } from "./lsn.js";

// Feedback interval to avoid WAL accumulation while the stream is running but
// no events are being committed. 10 seconds is well within PostgreSQL's default
// wal_sender_timeout (60 seconds).
const FEEDBACK_INTERVAL_MS = 10_000;

// Keepalive message type byte from the pgoutput replication protocol.
const KEEPALIVE_BYTE = 107; // 'k'
const XLOG_DATA_BYTE = 119; // 'w'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a row object from TupleData, using the cached relation's column names.
 * Unchanged TOAST columns are omitted from the result rather than carrying a
 * misleading null, because their original values are unavailable.
 */
function tupleToRecord(
  tuple: { columns: Array<{ type: string; value: string | null }> },
  relation: CachedRelation,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (let i = 0; i < tuple.columns.length; i++) {
    const col = tuple.columns[i];
    const relCol = relation.columns[i];
    if (col === undefined || relCol === undefined) continue;
    if (col.type === "unchanged-toast") continue; // value not available in WAL
    record[relCol.name] = col.value; // values arrive as text; caller casts if needed
  }
  return record;
}

/**
 * Validate and coerce the connector config record into a typed PostgresCdcConfig.
 * Throws with a human-readable message listing the first missing/invalid field.
 */
function parseConfig(config: Record<string, unknown>): PostgresCdcConfig {
  const required = ["host", "database", "user", "password", "slotName", "publicationName"] as const;
  for (const key of required) {
    if (typeof config[key] !== "string" || config[key] === "") {
      throw new Error(
        `PostgreSQL CDC connector: required config field "${key}" is missing or empty.`,
      );
    }
  }

  const port =
    typeof config["port"] === "number"
      ? config["port"]
      : typeof config["port"] === "string"
        ? parseInt(config["port"], 10)
        : 5432;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PostgreSQL CDC connector: config field "port" must be an integer between 1 and 65535.`,
    );
  }

  return {
    host: config["host"] as string,
    port,
    database: config["database"] as string,
    user: config["user"] as string,
    password: config["password"] as string,
    slotName: config["slotName"] as string,
    publicationName: config["publicationName"] as string,
    connectTimeoutMs:
      typeof config["connectTimeoutMs"] === "number"
        ? config["connectTimeoutMs"]
        : 10_000,
  };
}

// ---------------------------------------------------------------------------
// PostgresCdcConnector implementation
// ---------------------------------------------------------------------------

export class PostgresCdcConnector implements CdcConnector {
  readonly supportsRealtime = true as const;

  // Control connection used for slot management and slot info queries.
  // Separate from the replication connection so DDL and queries can run
  // concurrently with the WAL stream.
  private controlClient: pg.Client | null = null;

  // The active config, set by connect() and cleared by disconnect().
  private activeConfig: PostgresCdcConfig | null = null;

  // AbortController that signals the streaming generator to stop.
  private stopController: AbortController | null = null;

  // ---------------------------------------------------------------------------
  // Connector interface
  // ---------------------------------------------------------------------------

  metadata(): ConnectorMetadata {
    return {
      type: "connector",
      id: "oneplatform.postgres-cdc",
      name: "PostgreSQL CDC",
      description:
        "Streams row-level changes from a PostgreSQL database via logical replication " +
        "(WAL, pgoutput plugin). Requires wal_level=logical and a named publication.",
      version: "1.0.0",
      author: "OnePlatform",
      category: "database",
      configSchema: {
        type: "object",
        required: ["host", "database", "user", "password", "slotName", "publicationName"],
        properties: {
          host:            { type: "string", description: "PostgreSQL hostname or IP" },
          port:            { type: "integer", default: 5432, description: "PostgreSQL port" },
          database:        { type: "string", description: "Database name" },
          user:            { type: "string", description: "Replication user" },
          password:        { type: "string", format: "password", description: "Password" },
          slotName:        { type: "string", description: "Logical replication slot name" },
          publicationName: { type: "string", description: "Publication name" },
          connectTimeoutMs: { type: "integer", default: 10000, description: "Connection timeout (ms)" },
        },
      },
      outputSchema: {
        type: "object",
        description: "Raw row data from WAL change events",
      },
      supportsIncremental: true,
      supportsRealtime: true,
    };
  }

  async connect(
    config: Record<string, unknown>,
    _context: PluginContext,
  ): Promise<ConnectorHandle> {
    const parsed = parseConfig(config);
    this.activeConfig = parsed;

    // Open control connection (non-replication mode) for slot management.
    const client = new pg.Client({
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: parsed.user,
      password: parsed.password,
      connectionTimeoutMillis: parsed.connectTimeoutMs,
    });

    await client.connect();
    this.controlClient = client;

    // Ensure the replication slot exists with pgoutput. Using IF NOT EXISTS
    // means this is idempotent — safe to call on every connect().
    await client.query(
      `SELECT pg_create_logical_replication_slot($1, 'pgoutput') WHERE NOT EXISTS (
         SELECT 1 FROM pg_replication_slots WHERE slot_name = $1
       )`,
      [parsed.slotName],
    );

    return {
      connectionId: `postgres-cdc:${parsed.host}:${parsed.database}:${parsed.slotName}`,
      metadata: {
        host: parsed.host,
        database: parsed.database,
        slotName: parsed.slotName,
        publicationName: parsed.publicationName,
      },
    };
  }

  async fetchBatch(
    _handle: ConnectorHandle,
    _cursor: string | null,
    _context: PluginContext,
  ): Promise<BatchResult> {
    // CDC connectors stream events continuously via startCdcStream() rather
    // than polling via fetchBatch(). This stub satisfies the Connector interface
    // so the connector can be registered; callers should use startCdcStream().
    return {
      records: [],
      nextCursor: null,
      hasMore: false,
      fetchedAt: new Date().toISOString(),
    };
  }

  async disconnect(_handle: ConnectorHandle, _context: PluginContext): Promise<void> {
    if (this.controlClient !== null) {
      await this.controlClient.end().catch(() => {
        // end() may fail if the connection is already closed; swallow silently.
      });
      this.controlClient = null;
    }
    this.activeConfig = null;
  }

  // ---------------------------------------------------------------------------
  // CdcConnector interface
  // ---------------------------------------------------------------------------

  /**
   * Open the WAL stream and return an AsyncIterable of CdcEvent values.
   *
   * Internally this function:
   *   1. Creates a new pg.Client in replication mode
   *   2. Issues START_REPLICATION with the pgoutput plugin
   *   3. Decodes each XLogData message into CdcEvent values
   *   4. Sends periodic standby status updates (feedback) to prevent WAL build-up
   *   5. Stops when stopCdcStream() is called (via AbortController)
   */
  startCdcStream(
    _context: PluginContext,
    options: CdcOptions,
  ): AsyncIterable<CdcEvent> {
    if (this.activeConfig === null) {
      throw new Error(
        "PostgresCdcConnector.startCdcStream() called before connect(). " +
        "Call connect() first to establish a control connection.",
      );
    }

    const config = this.activeConfig;
    const abort = new AbortController();
    this.stopController = abort;

    // Tables filter: build a Set for O(1) lookup. An empty array means no filter.
    const tableFilter = new Set(options.tables);

    async function* streamGenerator(): AsyncIterable<CdcEvent> {
      // Relations cache: maps relationId -> column schema, populated from
      // Relation messages that precede the first DML on each table.
      const relations = new Map<number, CachedRelation>();

      // The confirmed-flush LSN we report back to PostgreSQL. Initialized to
      // startPosition if provided, otherwise 0/0 (stream from current tip).
      let confirmedLsn = options.startPosition ?? "0/0";

      // Open a separate replication-mode connection. The standard pg.Client
      // accepts { replication: "database" } which enables the replication
      // sub-protocol on the same TCP connection rather than the query protocol.
      // pg's TypeScript types do not include the `replication` option, so we
      // pass the config as `any` to bypass the type-level restriction — this is
      // a documented pg feature, just not in the @types/pg declarations.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replClientConfig: any = {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        connectionTimeoutMillis: config.connectTimeoutMs,
        replication: "database",
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replClient = new pg.Client(replClientConfig as any);

      try {
        await replClient.connect();

        // Build the START_REPLICATION command. Options are passed as key=value
        // pairs inside the plugin options parentheses.
        const startLsn = options.startPosition ?? "0/0";
        const pubList = `proto_version '1', publication_names '${config.publicationName}'`;
        await replClient.query(
          `START_REPLICATION SLOT "${config.slotName}" LOGICAL ${startLsn} (${pubList})`,
        );

        // The pg driver surfaces replication messages via the 'copyData' event.
        // We bridge them into an async generator using a shared queue + resolver.
        type QueueEntry = Buffer | Error | null; // null = end-of-stream
        const queue: QueueEntry[] = [];
        let resolver: (() => void) | null = null;

        function enqueue(entry: QueueEntry): void {
          queue.push(entry);
          if (resolver !== null) {
            resolver();
            resolver = null;
          }
        }

        // 'copyData' is a replication-protocol event not in @types/pg's standard
        // EventEmitter declarations — cast through `any` to subscribe to it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (replClient as any).on("copyData", ({ chunk }: { chunk: Buffer }) => {
          enqueue(chunk);
        });

        replClient.on("error", (err: Error) => {
          enqueue(err);
        });

        replClient.on("end", () => {
          enqueue(null);
        });

        abort.signal.addEventListener("abort", () => {
          enqueue(null);
        });

        // Periodic feedback timer — sends keepalives so the slot doesn't stall.
        let feedbackTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
          sendStandbyStatusUpdate(replClient, confirmedLsn, confirmedLsn, confirmedLsn, false)
            .catch(() => { /* connection may have closed; ignore */ });
        }, FEEDBACK_INTERVAL_MS);

        try {
          // Track current transaction state for grouping events by commit LSN.
          let currentCommitTime: string | null = null;
          let currentLsn: string | null = null;

          main: while (!abort.signal.aborted) {
            // Wait for the next message in the queue.
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                resolver = resolve;
              });
            }

            const entry = queue.shift();
            if (entry === null || entry === undefined) break main; // end-of-stream or abort
            if (entry instanceof Error) throw entry;

            const buf = entry as Buffer;
            const messageType = buf[0];

            if (messageType === KEEPALIVE_BYTE) {
              // Primary keepalive: byte 0='k', bytes 1-8=walEnd, bytes 9-16=sendTime, byte 17=replyRequired
              const replyRequired = buf[17] === 1;
              if (replyRequired) {
                await sendStandbyStatusUpdate(replClient, confirmedLsn, confirmedLsn, confirmedLsn, false);
              }
              continue;
            }

            if (messageType !== XLOG_DATA_BYTE) continue;

            // XLogData layout: byte 0='w', bytes 1-8=walStart, bytes 9-16=walEnd, bytes 17-24=sendTime
            // then the actual pgoutput message starting at byte 25.
            const walStartHigh = buf.readUInt32BE(1);
            const walStartLow = buf.readUInt32BE(5);
            const msgLsn = `${walStartHigh.toString(16).toUpperCase().padStart(8, "0")}/${walStartLow.toString(16).toUpperCase().padStart(8, "0")}`;

            const msgBuf = buf.subarray(25);
            const decoded = decodePgOutputMessage(msgBuf);
            if (decoded === null) continue;

            switch (decoded.type) {
              case "relation": {
                // Cache the relation schema so we can resolve column names for
                // subsequent INSERT/UPDATE/DELETE messages on this table.
                relations.set(decoded.relationId, {
                  schema: decoded.schema,
                  name: decoded.name,
                  qualifiedName: `${decoded.schema}.${decoded.name}`,
                  columns: decoded.columns,
                });
                break;
              }

              case "begin": {
                currentLsn = msgLsn;
                currentCommitTime = pgTimestampToIso(decoded.commitTime);
                break;
              }

              case "commit": {
                // Advance confirmed LSN after each complete transaction.
                // The CdcIngestionService tracks this per-batch for durability;
                // here we advance it in memory to send accurate feedback messages.
                confirmedLsn = maxLsn(confirmedLsn, decoded.endLsn);
                await sendStandbyStatusUpdate(replClient, confirmedLsn, confirmedLsn, confirmedLsn, false);
                currentCommitTime = null;
                currentLsn = null;
                break;
              }

              case "insert": {
                const relation = relations.get(decoded.relationId);
                if (relation === undefined) break; // relation not yet seen; skip
                if (tableFilter.size > 0 && !tableFilter.has(relation.qualifiedName)) break;

                const afterRecord = tupleToRecord(decoded.new, relation);
                yield {
                  type: "insert",
                  table: relation.qualifiedName,
                  timestamp: currentCommitTime ?? new Date().toISOString(),
                  lsn: currentLsn ?? msgLsn,
                  after: afterRecord,
                };
                break;
              }

              case "update": {
                const relation = relations.get(decoded.relationId);
                if (relation === undefined) break;
                if (tableFilter.size > 0 && !tableFilter.has(relation.qualifiedName)) break;

                const afterRecord = tupleToRecord(decoded.new, relation);

                // exactOptionalPropertyTypes: only spread optional keys when defined
                // to avoid assigning `undefined` to an optional-but-required property.
                if (decoded.old !== undefined) {
                  yield {
                    type: "update",
                    table: relation.qualifiedName,
                    timestamp: currentCommitTime ?? new Date().toISOString(),
                    lsn: currentLsn ?? msgLsn,
                    before: tupleToRecord(decoded.old, relation),
                    after: afterRecord,
                  };
                } else {
                  yield {
                    type: "update",
                    table: relation.qualifiedName,
                    timestamp: currentCommitTime ?? new Date().toISOString(),
                    lsn: currentLsn ?? msgLsn,
                    after: afterRecord,
                  };
                }
                break;
              }

              case "delete": {
                const relation = relations.get(decoded.relationId);
                if (relation === undefined) break;
                if (tableFilter.size > 0 && !tableFilter.has(relation.qualifiedName)) break;

                // old is present when replica identity = FULL; key when = DEFAULT.
                const tupleSource = decoded.old ?? decoded.key;

                // exactOptionalPropertyTypes: only spread `before` when available.
                if (tupleSource !== undefined) {
                  yield {
                    type: "delete",
                    table: relation.qualifiedName,
                    timestamp: currentCommitTime ?? new Date().toISOString(),
                    lsn: currentLsn ?? msgLsn,
                    before: tupleToRecord(tupleSource, relation),
                  };
                } else {
                  yield {
                    type: "delete",
                    table: relation.qualifiedName,
                    timestamp: currentCommitTime ?? new Date().toISOString(),
                    lsn: currentLsn ?? msgLsn,
                  };
                }
                break;
              }

              default:
                break;
            }
          }
        } finally {
          if (feedbackTimer !== null) {
            clearInterval(feedbackTimer);
            feedbackTimer = null;
          }
        }
      } finally {
        await replClient.end().catch(() => { /* already closed */ });
      }
    }

    return streamGenerator();
  }

  async stopCdcStream(): Promise<void> {
    if (this.stopController !== null) {
      this.stopController.abort();
      this.stopController = null;
    }
  }

  async getReplicationSlotInfo(): Promise<ReplicationSlotInfo> {
    if (this.controlClient === null || this.activeConfig === null) {
      throw new Error(
        "getReplicationSlotInfo() called before connect(). Call connect() first.",
      );
    }

    const result = await this.controlClient.query<{
      slot_name: string;
      confirmed_flush_lsn: string;
      active: boolean;
    }>(
      `SELECT slot_name,
              confirmed_flush_lsn::text,
              active
         FROM pg_replication_slots
        WHERE slot_name = $1`,
      [this.activeConfig.slotName],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `Replication slot "${this.activeConfig.slotName}" not found in pg_replication_slots.`,
      );
    }

    // Lag in bytes: difference between current WAL tip and confirmed flush LSN.
    const lagResult = await this.controlClient.query<{ lag_bytes: string }>(
      `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn) AS lag_bytes`,
      [row.confirmed_flush_lsn],
    );

    const lagBytes = parseInt(lagResult.rows[0]?.["lag_bytes"] ?? "0", 10);

    return {
      slotName: row.slot_name,
      confirmedFlushLsn: row.confirmed_flush_lsn,
      lagBytes: isNaN(lagBytes) ? 0 : lagBytes,
      active: row.active,
    };
  }
}

// ---------------------------------------------------------------------------
// Standby status update helper
//
// Sends a primary feedback message to the WAL sender so PostgreSQL can advance
// the slot's confirmed_flush_lsn and reclaim WAL disk space.
//
// Format (per protocol docs):
//   byte 0:    'd' (CopyData)
//   byte 1:    'r' (StandbyStatusUpdate)
//   bytes 2-9: write LSN (big-endian int64)
//   bytes 10-17: flush LSN
//   bytes 18-25: apply LSN
//   bytes 26-33: client clock (microseconds since PG epoch, big-endian int64)
//   byte 34:   0 = no immediate reply requested
// ---------------------------------------------------------------------------

async function sendStandbyStatusUpdate(
  client: pg.Client,
  writeLsn: string,
  flushLsn: string,
  applyLsn: string,
  replyRequested: boolean,
): Promise<void> {
  const buf = Buffer.allocUnsafe(34);

  buf.write("r", 0, "utf8"); // message type

  function writeLsnToBuffer(lsn: string, offset: number): void {
    const lsnBig = parseLsn(lsn === "0/0" ? "00000000/00000000" : lsn);
    buf.writeBigUInt64BE(lsnBig, offset);
  }

  writeLsnToBuffer(writeLsn, 1);
  writeLsnToBuffer(flushLsn, 9);
  writeLsnToBuffer(applyLsn, 17);

  // Client clock: microseconds since 2000-01-01 (PostgreSQL epoch)
  const nowMicros = BigInt(Date.now()) * 1000n - BigInt(Date.UTC(2000, 0, 1)) * 1000n;
  buf.writeBigInt64BE(nowMicros, 25);

  buf.writeUInt8(replyRequested ? 1 : 0, 33);

  // The pg driver's copyData method sends CopyData protocol messages directly.
  await new Promise<void>((resolve, reject) => {
    (client as unknown as { connection: { sendCopyFromChunk: (buf: Buffer) => void } })
      .connection.sendCopyFromChunk(buf);
    // sendCopyFromChunk is synchronous; resolve immediately.
    resolve();
  });
}

// Unused variable suppression — parseLsn is imported for lsnBig computation
void formatLsn; // used indirectly via lsn.ts; referenced here to avoid dead-code warning
