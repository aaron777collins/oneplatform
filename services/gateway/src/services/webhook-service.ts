import { createHash, createHmac, randomBytes } from "node:crypto";
import { encrypt, decrypt } from "@oneplatform/core";
import { NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import type { WebhookRow } from "../repositories/types.js";
import type { WebhookRepository } from "../repositories/webhook-repository.js";
import type { WebhookDeliveryRepository } from "../repositories/webhook-delivery-repository.js";
import { WebhookConnectivityFailedError } from "./errors.js";
// SSRF validation is centralised in ssrf-guard.ts — import from there rather
// than duplicating the blocked-range logic in this file.
import { validateWebhookUrl } from "../utils/ssrf-guard.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

// RegisterWebhookInput includes tenantId because the route passes the whole
// context object in one call (matches webhooks.ts route handler).
export interface RegisterWebhookInput {
  tenantId: string;
  url: string;
  events: string[];
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}

// Kept for internal use and delivery worker
export interface CreateWebhookInput {
  url: string;
  events: string[];
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  // null clears the field; undefined leaves it unchanged
  description?: string | null;
  enabled?: boolean;
  headers?: Record<string, string> | null;
}

export interface TestWebhookResult {
  deliveryId: string;
  statusCode: number | null;
  latencyMs: number;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Secret generation and hashing
// ---------------------------------------------------------------------------

const SECRET_BYTES = 32;

function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

// We use SHA-256 rather than bcrypt for the secret_hash column because:
// 1. The webhook secret is not a user password — it never grants account access.
// 2. bcrypt is unavailable in gateway dependencies; adding it only for an
//    informational "verify your secret" feature is not worth the binary weight.
// 3. The secret is 32 bytes of CSPRNG entropy — SHA-256 is unbreakable at
//    that entropy level even without a salt.
//
// The spec mentions bcrypt for the hash column but the delivery worker uses
// secret_encrypted (AES-256-GCM via core's encrypt()) for actual HMAC signing,
// so the hash column's security model is informational only.
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// ---------------------------------------------------------------------------
// Connectivity check (L2 §11.1 step 5)
// ---------------------------------------------------------------------------

const CONNECTIVITY_TIMEOUT_MS = 5_000;

async function checkConnectivity(url: string): Promise<void> {
  let response: Response;
  let statusCode: number | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);

    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, eventType: "webhook.registered" }),
        signal: controller.signal,
        // Disable redirect-following: a redirect could point at an internal
        // IP that was not present at registration time, bypassing SSRF checks.
        redirect: "error",
      });
      statusCode = response.status;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throw new WebhookConnectivityFailedError(
      `The webhook URL did not respond within ${CONNECTIVITY_TIMEOUT_MS / 1000} seconds. Ensure your endpoint is reachable and returns 2xx.`,
      {
        url,
        cause: err instanceof Error ? err.message : String(err),
      }
    );
  }

  if (!response.ok) {
    throw new WebhookConnectivityFailedError(
      `The webhook URL returned HTTP ${statusCode}. Ensure your endpoint is reachable and returns 2xx.`,
      { url, statusCode }
    );
  }
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface WebhookServiceDeps {
  webhookRepo: WebhookRepository;
  deliveryRepo: WebhookDeliveryRepository;
  masterKey: Buffer;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// WebhookService
// ---------------------------------------------------------------------------

export interface WebhookService {
  // registerWebhook — name expected by the webhooks route handler
  registerWebhook(input: RegisterWebhookInput): Promise<{ webhook: WebhookRow; secret: string }>;
  listWebhooks(tenantId: string, options?: { cursor?: string; limit?: number }): Promise<WebhookRow[]>;
  getWebhook(tenantId: string, id: string): Promise<WebhookRow>;
  // updateWebhook(id, data) — route pre-validates ownership before calling service
  updateWebhook(id: string, data: UpdateWebhookInput): Promise<WebhookRow>;
  deleteWebhook(tenantId: string, id: string): Promise<void>;
  // sendTestDelivery — name expected by the webhooks route handler
  sendTestDelivery(id: string): Promise<TestWebhookResult>;
  computeHmac(secret: string, body: string): string;
}

export function createWebhookService(deps: WebhookServiceDeps): WebhookService {
  const { webhookRepo, deliveryRepo, masterKey, logger } = deps;

  // -------------------------------------------------------------------------
  // registerWebhook
  // -------------------------------------------------------------------------

  async function registerWebhook(
    input: RegisterWebhookInput
  ): Promise<{ webhook: WebhookRow; secret: string }> {
    const { tenantId } = input;

    // 1. SSRF + protocol validation with DNS resolution check
    await validateWebhookUrl(input.url);

    // 2. Connectivity check — ensures the endpoint is responsive before we
    //    store the webhook and start attempting deliveries
    await checkConnectivity(input.url);

    // 3. Generate and protect the secret
    const rawSecret = generateSecret();
    const secretHash = hashSecret(rawSecret);
    const secretEncrypted = await encrypt(rawSecret, masterKey);

    // 4. Persist
    const webhook = await webhookRepo.create({
      tenant_id: tenantId,
      url: input.url,
      events: input.events,
      secret_hash: secretHash,
      secret_encrypted: secretEncrypted,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.headers !== undefined ? { custom_headers: input.headers } : {}),
    });

    logger.info("Webhook registered", {
      webhookId: webhook.id,
      tenantId,
      url: input.url,
      events: input.events,
    });

    // Return the raw secret once — it is never stored in plaintext and cannot
    // be recovered after this response is sent.
    return { webhook, secret: rawSecret };
  }

  // -------------------------------------------------------------------------
  // listWebhooks
  // -------------------------------------------------------------------------

  async function listWebhooks(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<WebhookRow[]> {
    return webhookRepo.findByTenantId(tenantId, options);
  }

  // -------------------------------------------------------------------------
  // getWebhook
  // -------------------------------------------------------------------------

  async function getWebhook(tenantId: string, id: string): Promise<WebhookRow> {
    const webhook = await webhookRepo.findById(id);
    if (webhook === null) {
      throw new NotFoundError(`Webhook ${id} not found.`);
    }
    // Tenant isolation: a webhook must belong to the requesting tenant
    if (webhook.tenant_id !== tenantId) {
      throw new ForbiddenError(`You do not have access to webhook ${id}.`);
    }
    return webhook;
  }

  // -------------------------------------------------------------------------
  // updateWebhook — route pre-validates ownership, so only id is needed
  // -------------------------------------------------------------------------

  async function updateWebhook(
    id: string,
    data: UpdateWebhookInput
  ): Promise<WebhookRow> {
    // If the URL is changing, re-validate SSRF and connectivity.
    // We fetch the existing record to compare — if the URL is unchanged we
    // skip the expensive connectivity probe.
    if (data.url !== undefined) {
      const existing = await webhookRepo.findById(id);
      if (existing !== null && data.url !== existing.url) {
        await validateWebhookUrl(data.url);
        await checkConnectivity(data.url);
      }
    }

    const updated = await webhookRepo.update(id, {
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.events !== undefined ? { events: data.events } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.headers !== undefined ? { custom_headers: data.headers } : {}),
    });

    if (updated === null) {
      throw new NotFoundError(`Webhook ${id} not found after update.`);
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // deleteWebhook
  // -------------------------------------------------------------------------

  async function deleteWebhook(tenantId: string, id: string): Promise<void> {
    // Verify ownership before deleting — prevents cross-tenant deletions
    await getWebhook(tenantId, id);

    const deleted = await webhookRepo.delete(id);
    if (!deleted) {
      throw new NotFoundError(`Webhook ${id} not found.`);
    }

    logger.info("Webhook deleted", { webhookId: id, tenantId });
  }

  // -------------------------------------------------------------------------
  // sendTestDelivery — synchronous single-attempt delivery with no retry
  // The route pre-validates ownership, so only id is required here.
  // -------------------------------------------------------------------------

  async function sendTestDelivery(id: string): Promise<TestWebhookResult> {
    const webhook = await webhookRepo.findById(id);
    if (webhook === null) {
      throw new NotFoundError(`Webhook ${id} not found.`);
    }

    // Re-validate SSRF target before sending (DNS rebinding prevention)
    await validateWebhookUrl(webhook.url);

    // Decrypt the stored secret to compute the HMAC signature
    const rawSecret = await decrypt(webhook.secret_encrypted, masterKey);

    const deliveryId = randomBytes(16).toString("hex");
    const testEvent = {
      eventId: deliveryId,
      eventType: "webhook.test",
      eventVersion: "1.0",
      tenantId: webhook.tenant_id,
      timestamp: new Date().toISOString(),
      actor: { type: "user" as const, id: "system" },
      data: { test: true },
    };

    const body = JSON.stringify(testEvent);
    const signature = computeHmac(rawSecret, body);

    const extraHeaders: Record<string, string> = {};
    if (webhook.custom_headers !== null) {
      Object.assign(extraHeaders, webhook.custom_headers);
    }

    // extraHeaders spreads first so platform signature headers always win —
    // a caller-supplied custom header must never be able to forge or suppress
    // the HMAC signature, delivery ID, or timestamp.
    const headers: Record<string, string> = {
      ...extraHeaders,
      "Content-Type": "application/json",
      "X-OnePlatform-Signature": `sha256=${signature}`,
      "X-OnePlatform-Event": "webhook.test",
      "X-OnePlatform-Delivery": deliveryId,
      "X-OnePlatform-Timestamp": String(Math.floor(Date.now() / 1000)),
    };

    const startMs = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let errorMsg: string | undefined;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(webhook.url, {
          method: "POST",
          body,
          headers,
          signal: controller.signal,
          // Disable redirect-following: a redirect target may resolve to an
          // internal IP after registration (DNS rebinding), bypassing SSRF guards.
          redirect: "error",
        });
        statusCode = response.status;
        responseBody = (await response.text()).slice(0, 1024);

        if (!response.ok) {
          errorMsg = `HTTP ${statusCode}`;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - startMs;
    const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

    // Log the test delivery asynchronously — a test failure must not block
    // the API response, and a delivery log write failure must not propagate.
    setImmediate(() => {
      deliveryRepo
        .create({
          webhook_id: id,
          tenant_id: webhook.tenant_id,
          event_id: deliveryId,
          event_type: "webhook.test",
          delivery_id: deliveryId,
          attempt: 1,
          ...(statusCode !== null ? { status_code: statusCode } : {}),
          ...(responseBody !== null ? { response_body: responseBody } : {}),
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
          duration_ms: latencyMs,
          responded_at: new Date(),
        })
        .catch((writeErr: unknown) => {
          logger.warn("Failed to log test webhook delivery", {
            webhookId: id,
            deliveryId,
            error:
              writeErr instanceof Error ? writeErr.message : String(writeErr),
          });
        });
    });

    return {
      deliveryId,
      statusCode,
      latencyMs,
      success,
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // computeHmac — HMAC-SHA256 over the raw request body string
  // -------------------------------------------------------------------------

  function computeHmac(secret: string, body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  return {
    registerWebhook,
    listWebhooks,
    getWebhook,
    updateWebhook,
    deleteWebhook,
    sendTestDelivery,
    computeHmac,
  };
}
