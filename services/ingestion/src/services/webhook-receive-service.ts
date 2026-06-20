import { createHmac, timingSafeEqual } from "node:crypto";
import { Queue } from "bullmq";
import type { Logger } from "@oneplatform/core";
import type { CredentialService } from "./credential-service.js";
import { WebhookReceiverNotFoundError } from "./errors.js";
import {
  normalizeToEnvelope,
  connectorIdToTableName,
} from "../utils/data-envelope.js";
import type { RawTableRepository } from "./sync-service.js";

// ---------------------------------------------------------------------------
// Repository row shape — mirrors the concrete types.ts WebhookReceiverRow.
// bigint columns come back as strings from the pg driver.
// ---------------------------------------------------------------------------

export interface WebhookReceiverRow {
  id: string;
  tenant_id: string;
  connector_id: string | null;
  name: string;
  description: string | null;
  path_suffix: string;
  secret_hash: string;
  hmac_algorithm: "sha256" | "sha512";
  header_name: string;
  is_enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  last_received_at: Date | null;
  events_received: string; // bigint as string from pg driver
}

export interface CreateWebhookReceiverData {
  tenant_id: string;
  connector_id?: string;
  name: string;
  description?: string;
  path_suffix: string;
  secret_hash: string;
  hmac_algorithm?: "sha256" | "sha512";
  header_name?: string;
  is_enabled?: boolean;
  created_by: string;
}

export interface UpdateWebhookReceiverData {
  name?: string;
  description?: string | null;
  connector_id?: string | null;
  hmac_algorithm?: "sha256" | "sha512";
  header_name?: string;
  is_enabled?: boolean;
  secret_hash?: string;
}

// ---------------------------------------------------------------------------
// Repository interface — matches the concrete WebhookReceiverRepository class.
// ---------------------------------------------------------------------------

export interface WebhookReceiverRepository {
  findById(id: string): Promise<WebhookReceiverRow | null>;
  findByTenantId(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<WebhookReceiverRow[]>;
  findByPathSuffix(pathSuffix: string): Promise<WebhookReceiverRow | null>;
  countByTenantId(tenantId: string): Promise<number>;
  create(data: CreateWebhookReceiverData): Promise<WebhookReceiverRow>;
  update(id: string, data: UpdateWebhookReceiverData): Promise<WebhookReceiverRow | null>;
  softDelete(id: string): Promise<boolean>;
  incrementEventsReceived(id: string): Promise<void>;
  // Tenant-scoped lookup by primary key. Used by the management service to
  // enforce tenant isolation on read/update/delete operations.
  findByTenantAndId(tenantId: string, id: string): Promise<WebhookReceiverRow | null>;
  // Paginated list with total count. Used by the management service for the
  // list endpoint.
  listByTenantId(
    tenantId: string,
    options: { cursor?: string; limit: number },
  ): Promise<{ items: WebhookReceiverRow[]; nextCursor: string | null; total: number }>;
}

// ---------------------------------------------------------------------------
// Simple LRU cache for webhook receiver config.
// Avoids a Postgres read on every inbound event while keeping stale config
// bounded to the TTL so rotation/disablement propagates within 30 seconds.
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: WebhookReceiverRow;
  expiresAt: number;
}

class LruCache {
  private readonly map = new Map<string, CacheEntry>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(capacity: number, ttlMs: number) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  get(key: string): WebhookReceiverRow | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end to mark as recently used.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: WebhookReceiverRow): void {
    if (this.map.size >= this.capacity) {
      // Evict the least-recently-used entry (first in insertion order).
      const oldest = this.map.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this.map.delete(oldest.value);
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.map.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Receive result
// ---------------------------------------------------------------------------

export interface ReceiveEventResult {
  received: true;
  eventId?: string;
}

// ---------------------------------------------------------------------------
// WebhookReceiveService — public interface
// ---------------------------------------------------------------------------

export interface WebhookReceiveService {
  receiveEvent(
    receiverId: string,
    rawBody: Buffer,
    // All request headers (excluding blocked ones such as Authorization/Cookie).
    // The service extracts the signature using the receiver's configured headerName
    // so custom header names set via the management API are honoured.
    incomingHeaders: Record<string, string>,
  ): Promise<ReceiveEventResult>;
  invalidateCache(receiverId: string): void;
}

export interface WebhookReceiveServiceDeps {
  receiverRepo: WebhookReceiverRepository;
  rawTableRepo: RawTableRepository;
  credentialService: CredentialService;
  masterKey: Buffer;
  logger: Logger;
  /** Redis URL for BullMQ queues. Falls back to OP_REDIS_URL env var. */
  redisUrl?: string;
}

const CACHE_CAPACITY = 1_000;
const CACHE_TTL_MS = 30_000;
const DEFAULT_REDIS_URL = process.env["OP_REDIS_URL"] ?? "redis://localhost:6379";

export function createWebhookReceiveService(
  deps: WebhookReceiveServiceDeps,
): WebhookReceiveService {
  const { receiverRepo, rawTableRepo, credentialService, masterKey, logger } = deps;

  // Derive BullMQ Redis URL from the injected dependency, falling back to the
  // module-level default.
  const redisUrl = deps.redisUrl ?? DEFAULT_REDIS_URL;

  // Per-service LRU cache with 30-second TTL so rotation/disablement
  // propagates quickly without hitting the DB on every event.
  const cache = new LruCache(CACHE_CAPACITY, CACHE_TTL_MS);

  // TODO(#PLAT-???): No Worker consumes "ontology:map" yet — jobs accumulate in Redis
  // until the ontology service implements a consumer. Retry config matches the platform
  // standard so jobs are not silently discarded on enqueue failures.
  const ontologyQueue = new Queue("ontology:map", {
    connection: { lazyConnect: true, url: redisUrl },
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
  });

  // -------------------------------------------------------------------------
  // receiveEvent — the hot path called for every inbound webhook POST.
  //
  // Security invariant: this function ALWAYS returns 200 OK regardless of
  // whether the receiver exists or the HMAC matches. Returning 4xx/5xx on
  // unknown IDs or invalid signatures would allow attackers to enumerate valid
  // receiver IDs or distinguish valid-but-wrong-HMAC from invalid-ID responses.
  // -------------------------------------------------------------------------

  async function receiveEvent(
    receiverId: string,
    rawBody: Buffer,
    incomingHeaders: Record<string, string>,
  ): Promise<ReceiveEventResult> {
    // Step 1: Look up receiver config — cache first to avoid DB round-trip.
    let receiver = cache.get(receiverId);
    if (receiver === undefined) {
      const fromDb = await receiverRepo.findById(receiverId);
      if (fromDb === null) {
        // Log but do NOT reveal this in the response.
        logger.warn("Webhook receiver not found", {
          webhookId: receiverId,
          code: "WEBHOOK_RECEIVER_NOT_FOUND",
        });
        return { received: true };
      }
      cache.set(receiverId, fromDb);
      receiver = fromDb;
    }

    // Step 2: Silently drop events for disabled/deleted receivers.
    if (!receiver.is_enabled || receiver.deleted_at !== null) {
      logger.info("Webhook event dropped — receiver disabled", {
        webhookId: receiverId,
      });
      return { received: true };
    }

    // Step 3: Fetch the raw HMAC signing secret from the credential vault.
    // The secret is stored AES-256-GCM encrypted using the receiver ID as
    // the connector namespace (field_name = 'webhook_secret').
    const signingSecret = await credentialService
      .getDecryptedCredential(receiverId, "webhook_secret", masterKey)
      .catch((err) => {
        logger.error("Failed to decrypt webhook signing secret", {
          webhookId: receiverId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

    if (signingSecret === null) {
      // The decryption error was already logged above. We additionally log
      // at WARN here so the event drop is visible as an audit trail entry
      // separate from the underlying crypto failure — ops can filter on
      // WEBHOOK_CREDENTIAL_FAILURE to detect credential misconfiguration.
      logger.warn("Webhook event dropped due to credential failure", {
        webhookId: receiverId,
        code: "WEBHOOK_CREDENTIAL_FAILURE",
        reason: "signing_secret_unavailable",
      });
      return { received: true };
    }

    // Step 4: HMAC verification.
    // Extract the signature using the receiver's configured header name so that
    // custom headerName values set via the management API are honoured. Headers
    // are matched case-insensitively to handle sender variations.
    const configuredHeaderLower = receiver.header_name.toLowerCase();
    const rawSignature = incomingHeaders[configuredHeaderLower]
      ?? incomingHeaders[receiver.header_name]
      ?? "";
    const prefixPattern = /^sha(?:256|512)=/i;
    const incomingHex = rawSignature.replace(prefixPattern, "").toLowerCase();

    const expectedHmac = createHmac(receiver.hmac_algorithm, signingSecret)
      .update(rawBody)
      .digest("hex");

    // Validate that the incoming signature is a well-formed hex string before
    // decoding. Buffer.from(str, 'hex') silently ignores non-hex characters,
    // so 'abcdzz' (6 chars) decodes to only 2 bytes. An attacker could craft a
    // hex string with the correct length (matching expectedHmac.length) but with
    // invalid trailing hex characters that get ignored during decode, causing the
    // length check below to pass while the decoded buffer is shorter than expected.
    const isValidHex = /^[0-9a-f]*$/.test(incomingHex);

    // timingSafeEqual requires same-length buffers. If the incoming value is
    // wrong length, the comparison still runs against a dummy buffer to prevent
    // timing differences that could leak "wrong length" information to an attacker.
    const expectedBuf = Buffer.from(expectedHmac, "hex");
    const incomingBuf = Buffer.alloc(expectedBuf.length);
    Buffer.from(incomingHex, "hex").copy(incomingBuf);

    const hmacValid =
      isValidHex &&
      timingSafeEqual(expectedBuf, incomingBuf) &&
      incomingHex.length === expectedHmac.length;

    if (!hmacValid) {
      // Security audit event — never exposed in the HTTP response.
      logger.warn("Webhook HMAC verification failed", {
        webhookId: receiverId,
        code: "WEBHOOK_HMAC_FAILED",
      });
      return { received: true };
    }

    // Step 5: Parse body and normalise to DataEnvelope.
    let parsedData: Record<string, unknown>;
    try {
      parsedData = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      // Non-JSON body: wrap the raw bytes as a base64 field.
      parsedData = { _raw: rawBody.toString("base64") };
    }

    const sourceId = extractSourceId(parsedData, receiverId);
    const eventId = crypto.randomUUID();
    const connectorId = receiver.connector_id ?? receiverId;

    const envelope = normalizeToEnvelope(
      { sourceId, data: parsedData },
      {
        connectorId,
        connectorName: receiver.name,
        batchId: eventId,
        tenantId: receiver.tenant_id,
        syncMode: "full",
        cursor: null,
      },
    );

    // Step 6: Ensure the raw table exists and write the record.
    const tableName = connectorIdToTableName(connectorId);
    await rawTableRepo.createRawTable(connectorId);
    await rawTableRepo.insertBatch(connectorId, [envelope]);

    // Step 7: Enqueue ontology:map job for this single-record batch.
    await ontologyQueue.add("map", {
      connectorId,
      batchId: eventId,
      tenantId: receiver.tenant_id,
      batchSeqNum: 0,
    });

    // Step 8: Update receiver stats (fire-and-forget — a stats write failure
    // must never cause a 5xx response to the sending system).
    receiverRepo.incrementEventsReceived(receiverId).catch((err: unknown) => {
      logger.warn("Failed to increment webhook events_received counter", {
        webhookId: receiverId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info("Webhook event received and staged", {
      webhookId: receiverId,
      eventId,
      connectorId,
    });

    return { received: true, eventId };
  }

  // -------------------------------------------------------------------------
  // invalidateCache — called by the management API after PATCH/DELETE so
  // the next receive call fetches fresh config from the database.
  // -------------------------------------------------------------------------

  function invalidateCache(receiverId: string): void {
    cache.invalidate(receiverId);
  }

  return { receiveEvent, invalidateCache };
}

// ---------------------------------------------------------------------------
// extractSourceId — attempts to find a stable identity field in the webhook
// payload. Falls back to the receiver ID + timestamp to ensure uniqueness.
// ---------------------------------------------------------------------------

const COMMON_ID_FIELDS = ["id", "event_id", "eventId", "uuid", "guid", "key"];

function extractSourceId(
  data: Record<string, unknown>,
  receiverId: string,
): string {
  for (const field of COMMON_ID_FIELDS) {
    const value = data[field];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return `${receiverId}:${Date.now()}`;
}
