/**
 * Webhook Connector — receives inbound webhook payloads as a data source.
 *
 * Unlike pull-based connectors (REST, database), this connector is a RECEIVER.
 * External services push data by POSTing to the platform's webhook ingestion
 * endpoint. The platform stores those payloads in a staging area (via
 * cache.set). When a sync job runs, fetchBatch drains from that staging area.
 *
 * Staging key convention (written by the ingestion service):
 *   webhook:pending:{connectorInstanceId}:{payloadId}
 *
 * Pagination index (written by fetchBatch to track which IDs remain):
 *   webhook:index:{connectorInstanceId}
 *
 * The cursor passed between fetchBatch calls is a sentinel: null means no more
 * payloads remain (or first run), and "continue" means more payloads exist and
 * the caller should invoke fetchBatch again. Because processed IDs are eagerly
 * removed from the index within each batch, a payload-ID cursor cannot be used
 * for resumption — always start from index 0 of the remaining entries.
 */

import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  DataRecord,
  PluginContext,
} from "@oneplatform/plugin-sdk";
import {
  PluginConfigError,
  PluginAuthError,
  PluginDataError,
} from "@oneplatform/plugin-sdk";

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MB

/** Validated config extracted from the raw plugin config object. */
interface WebhookConfig {
  webhookPath: string;
  signatureHeader: string | undefined;
  signatureAlgorithm: "sha256" | "sha1";
  idField: string | undefined;
  batchSize: number;
  maxPayloadBytes: number;
}

/**
 * A single webhook payload as stored in the platform staging cache.
 * The ingestion service writes entries in this shape when it receives a POST.
 */
export interface WebhookPayload {
  /** Platform-assigned stable ID for this webhook delivery. */
  id: string;

  /** ISO 8601 timestamp when the ingestion service received the webhook. */
  receivedAt: string;

  /**
   * Raw webhook body as received by the ingestion service.
   * Stored as a string so HMAC verification runs on the exact bytes the
   * sender signed — parsing before verification would invalidate HMAC checks.
   */
  rawBody: string;

  /**
   * All HTTP headers from the incoming webhook request, stored verbatim.
   * Used to extract the signature header during verification.
   */
  headers: Record<string, string>;
}

/** Minimal shape written by fetchBatch to track unprocessed payload IDs. */
interface PendingIndex {
  /** Ordered list of payload IDs waiting to be processed. Oldest first. */
  ids: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// Cache key helpers — centralised to prevent typos across methods
// ────────────────────────────────────────────────────────────────────────────

function pendingPayloadKey(instanceId: string, payloadId: string): string {
  return `webhook:pending:${instanceId}:${payloadId}`;
}

function pendingIndexKey(instanceId: string): string {
  return `webhook:index:${instanceId}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Config validation
// ────────────────────────────────────────────────────────────────────────────

const VALID_ALGORITHMS = new Set<string>(["sha256", "sha1"]);
const WEBHOOK_PATH_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

function parseConfig(raw: Record<string, unknown>): WebhookConfig {
  const { webhookPath, signatureHeader, signatureAlgorithm, idField, batchSize } = raw;

  if (typeof webhookPath !== "string" || webhookPath.length === 0) {
    throw new PluginConfigError(
      "webhookPath is required and must be a non-empty string",
      "webhookPath",
    );
  }

  if (!WEBHOOK_PATH_PATTERN.test(webhookPath)) {
    throw new PluginConfigError(
      `webhookPath "${webhookPath}" contains invalid characters. Use lowercase letters, digits, hyphens, and underscores only.`,
      "webhookPath",
    );
  }

  if (signatureHeader !== undefined && typeof signatureHeader !== "string") {
    throw new PluginConfigError(
      "signatureHeader must be a string when provided",
      "signatureHeader",
    );
  }

  const resolvedAlgorithm: "sha256" | "sha1" = (() => {
    if (signatureAlgorithm === undefined) return "sha256";
    if (typeof signatureAlgorithm !== "string" || !VALID_ALGORITHMS.has(signatureAlgorithm)) {
      throw new PluginConfigError(
        `signatureAlgorithm must be "sha256" or "sha1", got "${String(signatureAlgorithm)}"`,
        "signatureAlgorithm",
      );
    }
    return signatureAlgorithm as "sha256" | "sha1";
  })();

  if (idField !== undefined && typeof idField !== "string") {
    throw new PluginConfigError("idField must be a string when provided", "idField");
  }

  const resolvedBatchSize: number = (() => {
    if (batchSize === undefined) return 100;
    if (typeof batchSize !== "number" || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new PluginConfigError(
        `batchSize must be an integer between 1 and 1000, got ${String(batchSize)}`,
        "batchSize",
      );
    }
    return batchSize;
  })();

  const rawMaxPayloadBytes = raw["maxPayloadBytes"];
  const resolvedMaxPayloadBytes =
    typeof rawMaxPayloadBytes === "number" && rawMaxPayloadBytes > 0
      ? Math.floor(rawMaxPayloadBytes)
      : MAX_PAYLOAD_BYTES;

  return {
    webhookPath,
    signatureHeader: typeof signatureHeader === "string" ? signatureHeader : undefined,
    signatureAlgorithm: resolvedAlgorithm,
    idField: typeof idField === "string" ? idField : undefined,
    batchSize: resolvedBatchSize,
    maxPayloadBytes: resolvedMaxPayloadBytes,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HMAC signature verification using the Web Crypto API
//
// Plugins run inside isolated-vm (V8) which exposes the WHATWG Web Crypto API
// (`crypto.subtle`). We use that rather than the Node.js `crypto` module because:
//   1. isolated-vm does not expose Node builtins.
//   2. Web Crypto is standards-based and available in the sandbox.
//
// Signature format: the ingestion service and senders use:
//   sha256 → HMAC-SHA256, hex-encoded (e.g., GitHub's X-Hub-Signature-256)
//   sha1   → HMAC-SHA1,   hex-encoded (e.g., legacy GitHub X-Hub-Signature)
// ────────────────────────────────────────────────────────────────────────────

type SupportedAlgorithm = "sha256" | "sha1";

// Algorithm descriptors for crypto.subtle.importKey / sign.
// Typed as a plain object so we don't depend on DOM lib typings (the sandbox
// exposes Web Crypto but plugins target es2022, not dom).
interface HmacAlgorithmParams {
  name: "HMAC";
  hash: { name: string };
}

const WEB_CRYPTO_ALGO: Record<SupportedAlgorithm, HmacAlgorithmParams> = {
  sha256: { name: "HMAC", hash: { name: "SHA-256" } },
  sha1: { name: "HMAC", hash: { name: "SHA-1" } },
};

/**
 * Compute the HMAC of `body` using `secret` and the given algorithm.
 * Returns the lowercase hex-encoded digest — the format used by GitHub,
 * Stripe, Shopify, and most other webhook senders.
 */
async function computeHmac(
  secret: string,
  body: string,
  algorithm: SupportedAlgorithm,
): Promise<string> {
  const algoParams = WEB_CRYPTO_ALGO[algorithm];
  const keyMaterial = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey("raw", keyMaterial, algoParams, false, ["sign"]);

  const bodyBytes = new TextEncoder().encode(body);
  const signatureBuffer = await crypto.subtle.sign(algoParams, key, bodyBytes);

  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time byte comparison to prevent timing attacks.
 * Standard string equality short-circuits on the first differing character,
 * leaking timing information about how many leading bytes matched.
 * XOR-folding all bytes across the full length of the longer string prevents
 * early-exit on length mismatch, which could otherwise reveal whether a
 * malformed prefix caused a length divergence rather than a content mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Verify that the payload's HMAC signature matches the expected value.
 * Throws PluginAuthError if verification fails — the caller should skip
 * this payload and log the failure rather than halting the entire batch.
 */
async function verifySignature(
  payload: WebhookPayload,
  signatureHeader: string,
  algorithm: SupportedAlgorithm,
  secret: string,
): Promise<void> {
  // Header names from the ingestion service are lowercased on storage.
  const normalizedHeader = signatureHeader.toLowerCase();
  const receivedSignature = payload.headers[normalizedHeader];

  if (receivedSignature === undefined) {
    throw new PluginAuthError(
      `Webhook payload ${payload.id} is missing signature header "${signatureHeader}"`,
      { payloadId: payload.id, expectedHeader: signatureHeader },
    );
  }

  // Some senders prefix the signature with the algorithm name (e.g., "sha256=abc123").
  // Normalize to lowercase and trim before stripping the prefix so that
  // case variations (e.g., "SHA256=") and surrounding whitespace do not cause
  // a length mismatch that leaks information via the timing-safe comparison.
  const normalizedSignature = receivedSignature.toLowerCase().trim();
  const prefix = `${algorithm}=`;
  const rawSignature = normalizedSignature.startsWith(prefix)
    ? normalizedSignature.slice(prefix.length)
    : normalizedSignature;

  const expectedSignature = await computeHmac(secret, payload.rawBody, algorithm);

  if (!timingSafeEqual(rawSignature, expectedSignature)) {
    throw new PluginAuthError(
      `Webhook payload ${payload.id} failed HMAC signature verification`,
      { payloadId: payload.id, algorithm },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ID field extraction
//
// The idField config supports dot-notation paths into nested JSON objects
// (e.g., "event.id" extracts payload.event.id). Payloads are strings —
// we parse them once per record and extract the field.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the sourceId from a parsed JSON payload using a dot-notation path.
 * Returns undefined if the path does not exist or produces a non-primitive value.
 */
function extractIdFromPayload(
  parsed: Record<string, unknown>,
  idField: string,
): string | undefined {
  const segments = idField.split(".");
  let current: unknown = parsed;

  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  if (current === null || current === undefined) return undefined;
  if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
    return String(current);
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Payload → DataRecord mapping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Convert a staged WebhookPayload into a DataRecord.
 *
 * The raw body is parsed once. If idField is configured, the specified field
 * provides the sourceId. Otherwise, the platform-assigned payload ID is used —
 * this guarantees every delivery becomes a distinct record even when the sending
 * service does not include a stable event ID.
 */
function mapPayloadToRecord(
  payload: WebhookPayload,
  idField: string | undefined,
): DataRecord {
  let parsedBody: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(payload.rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Non-object JSON (arrays, primitives) — wrap in an envelope so it's still
      // accessible as a structured record rather than being discarded.
      parsedBody = { _payload: parsed };
    } else {
      parsedBody = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — store the raw string so downstream transforms can inspect it.
    // PluginDataError would halt the batch; wrapping preserves it for DLQ analysis.
    parsedBody = { _rawBody: payload.rawBody };
  }

  const sourceId = idField !== undefined
    ? (extractIdFromPayload(parsedBody, idField) ?? payload.id)
    : payload.id;

  return {
    sourceId,
    data: {
      ...parsedBody,
      _webhookPayloadId: payload.id,
      _webhookReceivedAt: payload.receivedAt,
    },
    metadata: {
      createdAt: payload.receivedAt,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ConnectorHandle metadata shape
// ────────────────────────────────────────────────────────────────────────────

interface WebhookHandleMetadata {
  webhookPath: string;
  signatureVerificationEnabled: boolean;
  signatureHeader: string | undefined;
  signatureAlgorithm: "sha256" | "sha1";
  idField: string | undefined;
  batchSize: number;
  maxPayloadBytes: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Connector implementation
// ────────────────────────────────────────────────────────────────────────────

const CONNECTOR_METADATA: ConnectorMetadata = {
  type: "connector",
  id: "com.oneplatform.connector-webhook",
  name: "Webhook",
  description:
    "Receives inbound webhook payloads from external services and ingests them as data records. Supports HMAC-SHA256 and HMAC-SHA1 signature verification.",
  version: "1.0.0",
  author: "OnePlatform",
  category: "api",
  configSchema: {
    type: "object",
    required: ["webhookPath"],
    properties: {
      webhookPath: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        pattern: "^[a-z0-9][a-z0-9-_]*$",
        title: "Webhook Path",
        description: "Path segment for this webhook endpoint.",
      },
      signatureHeader: {
        type: "string",
        title: "Signature Header",
        description: "HTTP header containing the HMAC signature.",
      },
      signatureAlgorithm: {
        type: "string",
        enum: ["sha256", "sha1"],
        default: "sha256",
        title: "Signature Algorithm",
      },
      idField: {
        type: "string",
        title: "ID Field",
        description: "Dot-notation path to the field used as sourceId.",
      },
      batchSize: {
        type: "number",
        minimum: 1,
        maximum: 1000,
        default: 100,
        title: "Batch Size",
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      _webhookPayloadId: { type: "string" },
      _webhookReceivedAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  supportsIncremental: false,
  // Webhooks are push-based: the external system calls us, so events arrive in
  // real time. Real-time pipeline mode could be supported by routing incoming
  // webhook payloads directly into a live pipeline run instead of queuing them.
  // Set supportsRealtime: true once the Execution Service live-ingest path is
  // wired up to the webhook ingestion endpoint.
  supportsRealtime: false,
  tags: ["webhook", "api", "events", "ingestion", "http"],
};

const webhookConnector: Connector = {
  metadata(): ConnectorMetadata {
    return CONNECTOR_METADATA;
  },

  /**
   * Validate configuration and verify that the signature secret (when required)
   * is accessible. The actual webhook endpoint does not need a network probe —
   * connectivity is validated by the ingestion service when it processes the
   * first inbound payload.
   */
  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const parsed = parseConfig(config);
    const { instanceId } = context.tenant;

    // When signatureHeader is configured, the secret must also be present.
    // Fail loudly here rather than silently skipping verification at fetch time.
    let signatureVerificationEnabled = false;

    if (parsed.signatureHeader !== undefined) {
      const availableCredentials = await context.credentials.list();
      if (!availableCredentials.includes("signatureSecret")) {
        throw new PluginConfigError(
          "signatureHeader is configured but no signatureSecret credential is bound to this plugin instance. " +
          "Bind the HMAC secret as the \"signatureSecret\" credential or remove signatureHeader from the config.",
          "signatureHeader",
        );
      }
      signatureVerificationEnabled = true;
    }

    const handleMetadata: WebhookHandleMetadata = {
      webhookPath: parsed.webhookPath,
      signatureVerificationEnabled,
      signatureHeader: parsed.signatureHeader,
      signatureAlgorithm: parsed.signatureAlgorithm,
      idField: parsed.idField,
      batchSize: parsed.batchSize,
      maxPayloadBytes: parsed.maxPayloadBytes,
    };

    context.logger.info("Webhook connector connected", {
      webhookPath: parsed.webhookPath,
      signatureVerificationEnabled,
      instanceId,
    });

    return {
      connectionId: `webhook:${instanceId}:${parsed.webhookPath}`,
      metadata: handleMetadata as unknown as Record<string, unknown>,
    };
  },

  /**
   * Drain queued webhook payloads from the platform's staging cache.
   *
   * Staging model:
   *   - The ingestion service writes each inbound payload to:
   *       cache.set(`webhook:pending:{instanceId}:{payloadId}`, payload)
   *   - It also maintains a sorted index of unprocessed IDs:
   *       cache.set(`webhook:index:{instanceId}`, { ids: [...] })
   *   - fetchBatch reads IDs after the cursor, processes up to batchSize,
   *     and removes consumed IDs from the index.
   *
   * Cursor semantics:
   *   null       → first run or no more payloads remain
   *   "continue" → more payloads remain; call again to drain the next batch
   *
   * Because fetchBatch eagerly removes processed IDs from the index after each
   * batch, the next call always starts from index 0 of the pruned list. A
   * payload-ID cursor cannot work here (the ID is removed before the next call),
   * so the cursor is a sentinel that only signals whether more data exists.
   */
  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const { instanceId } = context.tenant;
    const handleMeta = handle.metadata as unknown as WebhookHandleMetadata;
    const { signatureVerificationEnabled, signatureAlgorithm, idField, batchSize, maxPayloadBytes } = handleMeta;
    const effectiveMaxPayloadBytes = maxPayloadBytes ?? MAX_PAYLOAD_BYTES;

    const span = context.tracing.startSpan("webhook.fetchBatch");
    span.setAttribute("cursor", cursor ?? "null");
    span.setAttribute("batchSize", batchSize);

    try {
      // Read the ordered index of pending payload IDs.
      const index = await context.cache.get<PendingIndex>(pendingIndexKey(instanceId));
      const allIds = index?.ids ?? [];

      if (allIds.length === 0) {
        context.logger.debug("Webhook staging queue is empty", { instanceId });
        return {
          records: [],
          nextCursor: null,
          hasMore: false,
          fetchedAt: new Date().toISOString(),
        };
      }

      // Always start from index 0 of the current (already-pruned) index.
      // Processed IDs are removed from the index at the end of each batch, so
      // the next call sees only unprocessed entries starting at position 0.
      const startIndex = 0;

      const pageIds = allIds.slice(startIndex, startIndex + batchSize);

      if (pageIds.length === 0) {
        return {
          records: [],
          nextCursor: null,
          hasMore: false,
          fetchedAt: new Date().toISOString(),
        };
      }

      // Retrieve secret once per batch, not once per payload, to avoid repeated
      // credential store round-trips.
      let secret: string | undefined;
      if (signatureVerificationEnabled) {
        secret = await context.credentials.get("signatureSecret");
      }

      const records: DataRecord[] = [];
      const processedIds: string[] = [];

      for (const payloadId of pageIds) {
        const payload = await context.cache.get<WebhookPayload>(
          pendingPayloadKey(instanceId, payloadId),
        );

        if (payload === null) {
          // Payload TTL-expired or was manually removed. Skip gracefully — removing
          // it from the index prevents repeated lookups for a gone entry.
          context.logger.warn("Webhook payload not found in cache (possible TTL expiry)", {
            instanceId,
            payloadId,
          });
          processedIds.push(payloadId);
          continue;
        }

        if (payload.rawBody.length > effectiveMaxPayloadBytes) {
          context.logger.warn("Webhook payload exceeds maximum size — skipping", {
            instanceId,
            payloadId,
            size: payload.rawBody.length,
            maxPayloadBytes: effectiveMaxPayloadBytes,
          });
          processedIds.push(payloadId);
          continue;
        }

        if (signatureVerificationEnabled && secret !== undefined && handleMeta.signatureHeader !== undefined) {
          try {
            await verifySignature(payload, handleMeta.signatureHeader, signatureAlgorithm, secret);
          } catch (err) {
            if (err instanceof PluginAuthError) {
              context.logger.warn("Webhook payload failed signature verification — skipping", {
                instanceId,
                payloadId,
                error: err.message,
              });
              // Still mark as processed to prevent infinite re-inspection of an
              // unauthenticated payload. The warn log creates an audit trail.
              processedIds.push(payloadId);
              continue;
            }
            throw err;
          }
        }

        try {
          const record = mapPayloadToRecord(payload, idField);
          records.push(record);
          processedIds.push(payloadId);
        } catch (err) {
          context.logger.warn("Failed to map webhook payload — skipping", {
            instanceId,
            payloadId,
            error: String(err),
          });
          processedIds.push(payloadId);
          continue;
        }
      }

      // Remove processed IDs from the index and their individual cache entries.
      // Compute remainingIds unconditionally so that hasMore and estimatedTotal
      // reflect the true post-batch state even when all records in the page were
      // skipped (failed HMAC or TTL-expired). Without this, hasMore could be true
      // while nextCursor is null (violating the BatchResult contract) whenever every
      // record in a page is skipped but more IDs remain beyond the page window.
      const processedSet = new Set(processedIds);
      const remainingIds = allIds.filter((id) => !processedSet.has(id));

      if (processedIds.length > 0) {
        await context.cache.set<PendingIndex>(pendingIndexKey(instanceId), { ids: remainingIds });
        await Promise.all(processedIds.map((id) => context.cache.delete(pendingPayloadKey(instanceId, id))));
      }

      // hasMore is true iff there are IDs left to process after this batch.
      // Using remainingIds.length (post-processing) rather than the raw page-window
      // arithmetic ensures nextCursor is always non-null when hasMore is true,
      // satisfying the BatchResult invariant documented in connector.ts line 40.
      const hasMore = remainingIds.length > 0;
      // Use a sentinel cursor rather than a payload ID. Since processed IDs are
      // removed from the index within fetchBatch, a payload-ID cursor would always
      // resolve to indexOf==-1 on the next call. The sentinel "continue" signals
      // to the caller that more data exists without encoding a resumable position.
      const nextCursor = hasMore ? "continue" : null;

      span.setAttribute("recordCount", records.length);
      span.setAttribute("hasMore", hasMore);

      context.logger.info("Webhook fetchBatch complete", {
        instanceId,
        processed: processedIds.length,
        records: records.length,
        hasMore,
      });

      return {
        records,
        nextCursor,
        hasMore,
        fetchedAt: new Date().toISOString(),
        // Use remainingIds.length so the UI shows the count of payloads still
        // waiting, not the stale snapshot count from before this batch ran.
        estimatedTotal: remainingIds.length,
      };
    } finally {
      span.end();
    }
  },

  /**
   * No persistent connections to close. The webhook receiver is HTTP-stateless —
   * each inbound request is handled independently by the ingestion service.
   */
  async disconnect(_handle: ConnectorHandle, context: PluginContext): Promise<void> {
    context.logger.debug("Webhook connector disconnected (no-op)");
  },
};

export { webhookConnector };
export default webhookConnector;
