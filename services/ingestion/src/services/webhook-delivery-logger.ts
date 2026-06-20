/**
 * WebhookDeliveryLogger — side-effect layer that records each inbound
 * webhook delivery to ingestion.webhook_delivery_log.
 *
 * It wraps the raw receive handler: the original WebhookReceiveService
 * is never modified, keeping the hot HMAC path clean.
 *
 * Errors in the logger are always swallowed so a storage failure never
 * causes a 5xx back to the sending system.
 */
import type { Logger } from "@oneplatform/core";
import type { WebhookDeliveryLogRepository } from "../repositories/webhook-delivery-log-repository.js";
import type { WebhookReceiveService, ReceiveEventResult } from "./webhook-receive-service.js";
import { MAX_DELIVERIES_PER_WEBHOOK } from "./webhook-delivery-service.js";

// Maximum body size stored in the database (64 KiB).
// Payloads larger than this are truncated before being written.
const MAX_BODY_BYTES = 64 * 1024;

export interface WebhookDeliveryLoggerDeps {
  deliveryLogRepo: WebhookDeliveryLogRepository;
  logger: Logger;
}

/**
 * Wraps an existing WebhookReceiveService so every call to receiveEvent
 * automatically persists a delivery log entry after the core handler runs.
 */
export function createWebhookDeliveryLogger(
  inner: WebhookReceiveService,
  deps: WebhookDeliveryLoggerDeps,
): WebhookReceiveService {
  const { deliveryLogRepo, logger } = deps;

  async function receiveEvent(
    receiverId: string,
    rawBody: Buffer,
    incomingHeaders: Record<string, string>,
  ): Promise<ReceiveEventResult> {
    const startMs = Date.now();

    const result = await inner.receiveEvent(receiverId, rawBody, incomingHeaders);

    const processingTimeMs = Date.now() - startMs;

    // Derive signature_valid from whether an eventId was produced.
    // The service only sets eventId when HMAC verification passed and the
    // event was staged successfully. When no eventId is set we use null
    // (unknown) because the event may have been dropped for reasons other
    // than HMAC failure (receiver not found, receiver disabled, etc.).
    const signatureValid: boolean | null =
      result.eventId !== undefined ? true : null;

    // Truncate body before storage.
    const bodyBytes = rawBody.length > MAX_BODY_BYTES ? rawBody.subarray(0, MAX_BODY_BYTES) : rawBody;
    const bodyTruncated = rawBody.length > MAX_BODY_BYTES;

    let parsedBody: Record<string, unknown> | null = null;
    let bodyRaw: string | null = null;

    try {
      parsedBody = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
    } catch {
      // Non-JSON — store as text so the inspector can still display it.
      bodyRaw = bodyBytes.toString("utf8");
    }

    // Persist asynchronously so any storage failure never blocks the response.
    void (async () => {
      try {
        await deliveryLogRepo.insert({
          webhook_id: receiverId,
          headers: incomingHeaders ?? {},
          body: parsedBody,
          body_raw: bodyRaw,
          body_truncated: bodyTruncated,
          signature_valid: signatureValid,
          status_code: 200,
          processing_time_ms: processingTimeMs,
        });

        // Prune excess rows fire-and-forget after a successful insert.
        deliveryLogRepo.pruneExcess(receiverId, MAX_DELIVERIES_PER_WEBHOOK).catch(
          (err: unknown) => {
            logger.warn("Failed to prune webhook delivery log", {
              webhookId: receiverId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
      } catch (err: unknown) {
        // Delivery log failures must never surface as 5xx to the sender.
        logger.warn("Failed to write webhook delivery log entry", {
          webhookId: receiverId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return result;
  }

  return {
    receiveEvent,
    invalidateCache: inner.invalidateCache.bind(inner),
  };
}
