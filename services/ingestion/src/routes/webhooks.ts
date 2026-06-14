import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";
import type { WebhookReceiveService } from "../services/index.js";
import type { WebhookManagementService } from "../services/webhook-management-service.js";
import {
  createWebhookReceiverRequest,
  patchWebhookReceiverRequest,
  rotateWebhookSecretRequest,
  listWebhookReceiversQuery,
} from "../schemas/index.js";

export interface WebhookRouteDeps {
  webhookManagementService: WebhookManagementService;
  webhookReceiveService: WebhookReceiveService;
  masterKey: Buffer;
}

export function createWebhookRoutes(deps: WebhookRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { webhookManagementService, webhookReceiveService, masterKey } = deps;

  // --- Public receive endpoint (no auth — HMAC verified by service) ---
  // Registered BEFORE parameterized management routes to avoid route shadowing.

  routes.post("/inbound/:id/receive", async (c) => {
    // Anti-enumeration: always return 200 OK regardless of outcome.
    // An attacker probing for valid receiver IDs must not be able to distinguish
    // "receiver not found", "HMAC mismatch", or "processing error" from success.
    try {
      const rawBody = Buffer.from(await c.req.arrayBuffer());
      const receiverId = c.req.param("id");

      const signatureHeader = c.req.header("X-Webhook-Signature")
        ?? c.req.header("x-hub-signature-256")
        ?? c.req.header("x-signature");

      await webhookReceiveService.receiveEvent(receiverId, rawBody, signatureHeader);
    } catch {
      // Intentionally swallowed — errors are logged inside the service.
      // The caller receives { ok: true } regardless so receiver IDs cannot
      // be enumerated by timing or status code differences.
    }
    return c.json({ ok: true }, 200);
  });

  // --- Management routes (authenticated) ---

  routes.post("/inbound", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = createWebhookReceiverRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const d = parsed.data;
    const { receiver, secret } = await webhookManagementService.createReceiver(
      user.tenantId,
      user.userId,
      {
        name: d.name,
        ...(d.description ? { description: d.description } : {}),
        ...(d.connectorId ? { connectorId: d.connectorId } : {}),
        hmacAlgorithm: d.hmacAlgorithm,
        headerName: d.headerName,
      },
      masterKey,
    );

    return c.json({ data: { ...receiver, secret } }, 201);
  });

  routes.get("/inbound", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const raw = c.req.query();
    const parsed = listWebhookReceiversQuery.safeParse(raw);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() },
      }, 400);
    }

    const q = parsed.data;
    const result = await webhookManagementService.listReceivers(user.tenantId, {
      ...(q.cursor ? { cursor: q.cursor } : {}),
      limit: q.limit,
    });

    return c.json(result);
  });

  routes.get("/inbound/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const receiver = await webhookManagementService.getReceiver(user.tenantId, c.req.param("id"));
    return c.json({ data: receiver });
  });

  routes.patch("/inbound/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = patchWebhookReceiverRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    const d = parsed.data;
    const updates: Record<string, unknown> = {};

    if (d.name !== undefined) updates["name"] = d.name;
    if (d.hmacAlgorithm !== undefined) updates["hmacAlgorithm"] = d.hmacAlgorithm;
    if (d.headerName !== undefined) updates["headerName"] = d.headerName;
    if (d.isEnabled !== undefined) updates["isEnabled"] = d.isEnabled;
    // null is a valid value here — it explicitly clears description / connectorId.
    if (d.description !== undefined) updates["description"] = d.description;
    if (d.connectorId !== undefined) updates["connectorId"] = d.connectorId;

    const receiver = await webhookManagementService.updateReceiver(
      user.tenantId,
      c.req.param("id"),
      updates as Parameters<WebhookManagementService["updateReceiver"]>[2],
    );

    return c.json({ data: receiver });
  });

  routes.delete("/inbound/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    await webhookManagementService.deleteReceiver(user.tenantId, c.req.param("id"));
    return c.body(null, 204);
  });

  routes.post("/inbound/:id/rotate-secret", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const body = await c.req.json();
    const parsed = rotateWebhookSecretRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() },
      }, 400);
    }

    // Verify tenant ownership
    await webhookManagementService.getReceiver(user.tenantId, c.req.param("id"));

    const result = await webhookManagementService.rotateSecret(
      user.tenantId,
      c.req.param("id"),
      parsed.data.currentSecret,
      masterKey,
    );

    return c.json({ data: result });
  });

  return routes;
}
