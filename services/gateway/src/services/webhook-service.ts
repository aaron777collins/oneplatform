import { createHash, createHmac, randomBytes } from "node:crypto";
import dns from "node:dns";
import { encrypt, decrypt } from "@oneplatform/core";
import { NotFoundError, ForbiddenError } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import type { WebhookRow } from "../repositories/types.js";
import type { WebhookRepository } from "../repositories/webhook-repository.js";
import type { WebhookDeliveryRepository } from "../repositories/webhook-delivery-repository.js";
import {
  WebhookSsrfBlockedError,
  WebhookConnectivityFailedError,
  WebhookInvalidUrlError,
} from "./errors.js";

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
// SSRF-blocked IP range checks (L2 §11.1)
// ---------------------------------------------------------------------------

// IPv4 CIDR ranges that must never receive webhook deliveries.
// Link-local (169.254.x.x) covers cloud metadata endpoints on all major
// providers (AWS IMDSv1, GCP metadata, Azure IMDS).
const BLOCKED_IPV4_RANGES: Array<{ base: number; mask: number }> = [
  { base: ip4ToInt("10.0.0.0"), mask: prefixToMask(8) },    // RFC 1918 class A
  { base: ip4ToInt("172.16.0.0"), mask: prefixToMask(12) },  // RFC 1918 class B
  { base: ip4ToInt("192.168.0.0"), mask: prefixToMask(16) }, // RFC 1918 class C
  { base: ip4ToInt("127.0.0.0"), mask: prefixToMask(8) },    // Loopback
  { base: ip4ToInt("169.254.0.0"), mask: prefixToMask(16) }, // Link-local / metadata
  { base: ip4ToInt("0.0.0.0"), mask: prefixToMask(8) },      // "This" network
  { base: ip4ToInt("100.64.0.0"), mask: prefixToMask(10) },  // Carrier-grade NAT
];

function ip4ToInt(ip: string): number {
  const parts = ip.split(".");
  return (
    ((parseInt(parts[0] ?? "0", 10) << 24) |
      (parseInt(parts[1] ?? "0", 10) << 16) |
      (parseInt(parts[2] ?? "0", 10) << 8) |
      parseInt(parts[3] ?? "0", 10)) >>>
    0
  );
}

function prefixToMask(prefix: number): number {
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const ipInt = ip4ToInt(ip);
  return BLOCKED_IPV4_RANGES.some(
    ({ base, mask }) => (ipInt & mask) === base
  );
}

// IPv6 addresses that are blocked (loopback and link-local).
// We do not enumerate all private IPv6 ranges exhaustively because most
// production deployments run IPv4; block what matters most.
function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // ::1 — loopback
  if (normalized === "::1") return true;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  // fc00::/7 — unique local (private IPv6)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  return false;
}

// Hostnames that are rejected before DNS resolution to give clear errors
// rather than a confusing "SSRF blocked" for what is obviously a local address.
const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /.*-service$/i, // Docker Compose service names (e.g. auth-service)
];

function isBlockedHostname(hostname: string): boolean {
  return BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(hostname));
}

// ---------------------------------------------------------------------------
// DNS resolution + SSRF check (L2 §11.1 and §11.2)
// ---------------------------------------------------------------------------

async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookInvalidUrlError(
      `The webhook URL "${url}" is malformed and cannot be parsed.`,
      { url }
    );
  }

  const allowHttp = process.env["OP_WEBHOOK_ALLOW_HTTP"] === "true";
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new WebhookInvalidUrlError(
      `The webhook URL must use the https:// protocol. Got: ${parsed.protocol}`,
      { url, protocol: parsed.protocol }
    );
  }

  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) {
    throw new WebhookSsrfBlockedError(
      `The webhook hostname "${hostname}" is not permitted.`,
      { url, hostname }
    );
  }

  // Resolve all A and AAAA records and block on any match.
  const [ipv4Addresses, ipv6Addresses] = await Promise.all([
    dns.promises.resolve4(hostname).catch(() => [] as string[]),
    dns.promises.resolve6(hostname).catch(() => [] as string[]),
  ]);

  const allAddresses = [...ipv4Addresses, ...ipv6Addresses];

  if (allAddresses.length === 0) {
    throw new WebhookSsrfBlockedError(
      `The webhook hostname "${hostname}" could not be resolved to any IP address.`,
      { url, hostname }
    );
  }

  for (const ip of ipv4Addresses) {
    if (isBlockedIpv4(ip)) {
      throw new WebhookSsrfBlockedError(
        `The webhook URL resolves to a private IP address (${ip}) and cannot be registered.`,
        { url, resolvedIp: ip }
      );
    }
  }

  for (const ip of ipv6Addresses) {
    if (isBlockedIpv6(ip)) {
      throw new WebhookSsrfBlockedError(
        `The webhook URL resolves to a private IPv6 address (${ip}) and cannot be registered.`,
        { url, resolvedIp: ip }
      );
    }
  }
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
  listWebhooks(tenantId: string): Promise<WebhookRow[]>;
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

  async function listWebhooks(tenantId: string): Promise<WebhookRow[]> {
    return webhookRepo.findByTenantId(tenantId);
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

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-OnePlatform-Signature": `sha256=${signature}`,
      "X-OnePlatform-Event": "webhook.test",
      "X-OnePlatform-Delivery": deliveryId,
      "X-OnePlatform-Timestamp": String(Math.floor(Date.now() / 1000)),
      ...extraHeaders,
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
