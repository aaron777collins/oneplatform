import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import { validateWebhookUrl } from "../utils/ssrf-guard.js";
import type { BillingWebhookConfigRepository } from "../repositories/usage-event-repository.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const upsertBillingWebhookConfigRequest = z.object({
  url: z.string().url("url must be a valid URL"),
  provider: z.enum(["stripe", "custom"]).default("custom"),
  apiCallThreshold: z.number().int().positive().optional().nullable(),
  rowsIngestedThreshold: z.number().int().positive().optional().nullable(),
  storageBytesThreshold: z.number().int().positive().optional().nullable(),
  enabled: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface BillingRouteDeps {
  billingWebhookConfigRepo: BillingWebhookConfigRepository;
}

export function createBillingRoutes(deps: BillingRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { billingWebhookConfigRepo } = deps;

  // -------------------------------------------------------------------------
  // POST /api/v1/billing/webhook-config
  // Creates or replaces the billing webhook configuration for the tenant.
  // -------------------------------------------------------------------------

  routes.post("/webhook-config", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = upsertBillingWebhookConfigRequest.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    // Validate the webhook URL for SSRF before persisting it.
    // This blocks private IP ranges, loopback, and internal service hostnames.
    await validateWebhookUrl(parsed.data.url);

    const config = await billingWebhookConfigRepo.upsert({
      tenant_id: user.tenantId,
      url: parsed.data.url,
      provider: parsed.data.provider,
      api_call_threshold: parsed.data.apiCallThreshold ?? null,
      rows_ingested_threshold: parsed.data.rowsIngestedThreshold ?? null,
      storage_bytes_threshold: parsed.data.storageBytesThreshold ?? null,
      enabled: parsed.data.enabled,
    });

    return c.json({ data: sanitizeBillingConfig(config) }, 200);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/billing/webhook-config
  // Returns the current billing webhook configuration for the tenant.
  // -------------------------------------------------------------------------

  routes.get("/webhook-config", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const config = await billingWebhookConfigRepo.findByTenantId(user.tenantId);
    if (config === null) {
      return c.json({ data: null });
    }

    return c.json({ data: sanitizeBillingConfig(config) });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/billing/webhook-config
  // Removes the billing webhook configuration for the tenant.
  // -------------------------------------------------------------------------

  routes.delete("/webhook-config", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await billingWebhookConfigRepo.delete(user.tenantId);
    return c.json({ data: { deleted: true } });
  });

  return routes;
}

// Strip the encrypted secret from API responses — callers configure a secret
// but never need to read it back. Exposing even the ciphertext is unnecessary.
function sanitizeBillingConfig(
  config: Awaited<ReturnType<BillingWebhookConfigRepository["findByTenantId"]>>,
) {
  if (config === null) return null;
  const { secret_encrypted: _secret, ...safe } = config;
  return {
    ...safe,
    // Expose threshold fields using camelCase for API consistency
    apiCallThreshold: config.api_call_threshold !== null ? Number(config.api_call_threshold) : null,
    rowsIngestedThreshold: config.rows_ingested_threshold !== null ? Number(config.rows_ingested_threshold) : null,
    storageBytesThreshold: config.storage_bytes_threshold !== null ? Number(config.storage_bytes_threshold) : null,
  };
}
