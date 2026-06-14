import { Hono } from "hono";
import { timingSafeEqual, createHmac } from "node:crypto";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { ForbiddenError } from "@oneplatform/core";
import type { RunService } from "../services/run-service.js";
import type { TriggerRepository } from "../services/trigger-service.js";
import { TriggerSignatureInvalidError } from "../services/errors.js";

// ---------------------------------------------------------------------------
// Internal trigger request schema (design spec §6.1)
// ---------------------------------------------------------------------------

const InternalTriggerSchema = z.object({
  pipelineId: z.string().uuid(),
  tenantId: z.string().uuid(),
  triggeredBy: z.literal("service"),
  callerService: z.string().min(1).max(128),
  callerRequestId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

// Webhook inbound trigger — keyed by slug, authenticated via HMAC-SHA256 on the body
const WebhookTriggerSchema = z.object({
  triggerId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface InternalRouteDeps {
  runService: RunService;
  // triggerRepo is needed to look up the HMAC secret for webhook verification
  triggerRepo: TriggerRepository;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { runService, triggerRepo } = deps;

  // POST /internal/pipeline/trigger
  // Used by: Ingestion Service, App Service (design spec §6.1)
  routes.post("/pipeline/trigger", async (c) => {
    const user = c.var.user;
    if (!user?.isService) {
      throw new ForbiddenError("Service token required.");
    }

    const body = await c.req.json().catch(() => null);
    const parsed = InternalTriggerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body.",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }

    const d = parsed.data;
    const result = await runService.triggerRun(
      d.pipelineId,
      d.tenantId,
      "service",
      d.input ?? {},
      {
        callerService: d.callerService,
        ...(d.callerRequestId !== undefined ? { callerRequestId: d.callerRequestId } : {}),
      },
    );

    return c.json({ data: result }, 202);
  });

  // POST /internal/pipeline/webhook
  // Inbound webhook trigger from the API Gateway (design spec §6.2).
  // The Gateway forwards the raw request body and the X-OnePlatform-Signature header.
  // We re-verify the HMAC here before triggering a run.
  routes.post("/pipeline/webhook", async (c) => {
    const signatureHeader = c.req.header("X-OnePlatform-Signature");
    if (signatureHeader === undefined || signatureHeader === "") {
      return c.json(
        { error: { code: "TRIGGER_SIGNATURE_INVALID", message: "Missing X-OnePlatform-Signature header." } },
        401,
      );
    }

    // Parse metadata query parameters — the Gateway appends triggerId and tenantId
    const parsed = WebhookTriggerSchema.safeParse({
      triggerId: c.req.query("triggerId"),
      tenantId: c.req.query("tenantId"),
    });
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Missing triggerId or tenantId." } },
        400,
      );
    }

    const { triggerId, tenantId } = parsed.data;

    // Read raw body bytes for HMAC computation before any JSON parse
    const rawBodyBuffer = await c.req.arrayBuffer();
    const rawBody = Buffer.from(rawBodyBuffer);

    // Look up trigger to retrieve the stored HMAC secret
    const trigger = await triggerRepo.findById(triggerId);
    if (trigger === null || !trigger.enabled || trigger.tenant_id !== tenantId) {
      // Return 401 rather than 404 to avoid confirming the trigger ID exists
      throw new TriggerSignatureInvalidError(
        "Webhook trigger not found or disabled.",
        { triggerId },
      );
    }

    // Verify HMAC-SHA256 — timingSafeEqual prevents timing side-channels
    const secret = (trigger.config as { secret?: string }).secret ?? "";
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(`sha256=${expected}`, "utf8");
    const receivedBuf = Buffer.from(signatureHeader, "utf8");

    const signaturesMatch =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);

    if (!signaturesMatch) {
      throw new TriggerSignatureInvalidError(
        "Webhook HMAC signature verification failed.",
        { triggerId },
      );
    }

    // Parse the request body as JSON after HMAC passes
    let webhookInput: Record<string, unknown> = {};
    try {
      webhookInput = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      // Non-JSON bodies are accepted — the pipeline receives an empty input
    }

    const result = await runService.triggerRun(
      trigger.pipeline_id,
      tenantId,
      "webhook",
      webhookInput,
      { triggerId, webhookSlug: (trigger.config as { slug?: string }).slug ?? "" },
    );

    return c.json({ data: result }, 202);
  });

  return routes;
}
