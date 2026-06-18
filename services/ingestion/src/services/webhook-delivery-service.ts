/**
 * WebhookDeliveryService — read-only access to the delivery log.
 *
 * The write path (logging each received delivery) is handled by
 * WebhookDeliveryLogger, which is a thin side-effect wrapper around
 * WebhookDeliveryLogRepository so the hot receive path stays unchanged.
 *
 * This service is the query side: list and detail endpoints used by the UI.
 */
import type { Logger } from "@oneplatform/core";
import { WebhookReceiverNotFoundError } from "./errors.js";
import type { WebhookDeliveryLogRepository } from "../repositories/webhook-delivery-log-repository.js";
import type { WebhookReceiverRepository } from "./webhook-receive-service.js";

// ---------------------------------------------------------------------------
// Max deliveries retained per webhook receiver.
// Cleaning up on insert keeps the table bounded without a background job.
// ---------------------------------------------------------------------------
export const MAX_DELIVERIES_PER_WEBHOOK = 100;

// ---------------------------------------------------------------------------
// Public shapes returned by the query API
// ---------------------------------------------------------------------------

export interface DeliveryLogEntry {
  id: string;
  webhookId: string;
  receivedAt: string; // ISO 8601
  signatureValid: boolean | null;
  statusCode: number;
  processingTimeMs: number | null;
  bodyTruncated: boolean;
}

export interface DeliveryLogDetail extends DeliveryLogEntry {
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  bodyRaw: string | null;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface WebhookDeliveryService {
  listDeliveries(
    tenantId: string,
    webhookId: string,
    options: { cursor?: string; limit: number },
  ): Promise<{
    data: DeliveryLogEntry[];
    pagination: { nextCursor: string | null; total: number };
  }>;

  getDelivery(
    tenantId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<DeliveryLogDetail>;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface WebhookDeliveryServiceDeps {
  deliveryLogRepo: WebhookDeliveryLogRepository;
  receiverRepo: WebhookReceiverRepository;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Shape converters — keep the repository row type internal
// ---------------------------------------------------------------------------

import type { WebhookDeliveryLogRow } from "../repositories/webhook-delivery-log-repository.js";

function toEntry(row: WebhookDeliveryLogRow): DeliveryLogEntry {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    receivedAt: row.received_at.toISOString(),
    signatureValid: row.signature_valid,
    statusCode: row.status_code,
    processingTimeMs: row.processing_time_ms,
    bodyTruncated: row.body_truncated,
  };
}

function toDetail(row: WebhookDeliveryLogRow): DeliveryLogDetail {
  return {
    ...toEntry(row),
    headers: row.headers,
    body: row.body,
    bodyRaw: row.body_raw,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebhookDeliveryService(
  deps: WebhookDeliveryServiceDeps,
): WebhookDeliveryService {
  const { deliveryLogRepo, receiverRepo, logger } = deps;

  async function assertReceiverOwnedByTenant(
    tenantId: string,
    webhookId: string,
  ): Promise<void> {
    const receiver = await receiverRepo.findByTenantAndId(tenantId, webhookId);
    if (receiver === null) {
      throw new WebhookReceiverNotFoundError(
        `Webhook receiver ${webhookId} not found`,
      );
    }
  }

  async function listDeliveries(
    tenantId: string,
    webhookId: string,
    options: { cursor?: string; limit: number },
  ) {
    // Enforce tenant ownership before exposing delivery data.
    await assertReceiverOwnedByTenant(tenantId, webhookId);

    const result = await deliveryLogRepo.listByWebhookId(webhookId, options);

    logger.debug("Webhook delivery log listed", {
      webhookId,
      tenantId,
      count: result.items.length,
    });

    return {
      data: result.items.map(toEntry),
      pagination: { nextCursor: result.nextCursor, total: result.total },
    };
  }

  async function getDelivery(
    tenantId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<DeliveryLogDetail> {
    await assertReceiverOwnedByTenant(tenantId, webhookId);

    const row = await deliveryLogRepo.findById(deliveryId);
    if (row === null || row.webhook_id !== webhookId) {
      throw new WebhookReceiverNotFoundError(
        `Delivery ${deliveryId} not found for webhook ${webhookId}`,
      );
    }

    return toDetail(row);
  }

  return { listDeliveries, getDelivery };
}
