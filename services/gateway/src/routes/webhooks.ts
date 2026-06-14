import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import {
  createWebhookRequest,
  updateWebhookRequest,
  listWebhooksQuery,
  listDeliveriesQuery,
} from "../schemas/index.js";
import type { WebhookService } from "../services/webhook-service.js";
import type { WebhookDeliveryRepository } from "../repositories/webhook-delivery-repository.js";
import type { WebhookRow } from "../repositories/types.js";

export interface WebhookRouteDeps {
  webhookService: WebhookService;
  deliveryRepo: WebhookDeliveryRepository;
}

export function createWebhookRoutes(deps: WebhookRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { webhookService, deliveryRepo } = deps;

  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = createWebhookRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const { webhook, secret } = await webhookService.registerWebhook({
      tenantId: user.tenantId,
      url: parsed.data.url,
      events: parsed.data.events,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.headers ? { headers: parsed.data.headers } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    });

    return c.json({ data: { ...sanitizeWebhook(webhook), secret } }, 201);
  });

  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const query = listWebhooksQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: query.error.flatten() },
      }, 400);
    }

    const webhooks = await webhookService.listWebhooks(user.tenantId, {
      ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      limit: query.data.limit,
    });
    return c.json({ data: webhooks.map(sanitizeWebhook) });
  });

  routes.get("/:webhookId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const webhook = await webhookService.getWebhook(user.tenantId, c.req.param("webhookId"));
    return c.json({ data: sanitizeWebhook(webhook) });
  });

  routes.patch("/:webhookId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = updateWebhookRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    // Verify tenant ownership
    await webhookService.getWebhook(user.tenantId, c.req.param("webhookId"));

    const d = parsed.data;
    const updated = await webhookService.updateWebhook(c.req.param("webhookId"), {
      ...(d.url !== undefined ? { url: d.url } : {}),
      ...(d.events !== undefined ? { events: d.events } : {}),
      // null is passed through explicitly to clear the column; undefined means no-op
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.enabled !== undefined ? { enabled: d.enabled } : {}),
      // null clears custom_headers; undefined leaves them unchanged
      ...(d.headers !== undefined ? { headers: d.headers } : {}),
    });
    return c.json({ data: sanitizeWebhook(updated) });
  });

  routes.delete("/:webhookId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await webhookService.deleteWebhook(user.tenantId, c.req.param("webhookId"));
    return c.json({ data: { deleted: true } });
  });

  routes.get("/:webhookId/deliveries", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await webhookService.getWebhook(user.tenantId, c.req.param("webhookId"));

    const query = listDeliveriesQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: query.error.flatten() },
      }, 400);
    }

    const deliveries = await deliveryRepo.findByWebhookId(
      c.req.param("webhookId"),
      query.data.limit,
    );

    return c.json({ data: deliveries });
  });

  routes.post("/:webhookId/test", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Verify tenant ownership before sending test
    await webhookService.getWebhook(user.tenantId, c.req.param("webhookId"));

    const result = await webhookService.sendTestDelivery(c.req.param("webhookId"));
    return c.json({ data: result });
  });

  return routes;
}

function sanitizeWebhook(row: WebhookRow): Omit<WebhookRow, "secret_hash" | "secret_encrypted"> {
  const { secret_hash, secret_encrypted, ...safe } = row;
  return safe;
}
