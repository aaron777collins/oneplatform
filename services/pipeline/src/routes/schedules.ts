import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import type { ScheduleService } from "../services/schedule-service.js";

// ---------------------------------------------------------------------------
// Zod schemas (design spec §5.1)
// ---------------------------------------------------------------------------

const UUIDSchema = z.string().uuid();

const CreateScheduleSchema = z.object({
  pipelineId: UUIDSchema,
  cronExpr: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).default("UTC"),
  enabled: z.boolean().default(true),
  inputTemplate: z.record(z.unknown()).default({}),
});

const PatchScheduleSchema = z.object({
  cronExpr: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  inputTemplate: z.record(z.unknown()).optional(),
});

const ListSchedulesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Route dependencies
// ---------------------------------------------------------------------------

export interface ScheduleRouteDeps {
  scheduleService: ScheduleService;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createScheduleRoutes(
  deps: ScheduleRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { scheduleService } = deps;

  // GET /api/v1/schedules
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const parsed = ListSchedulesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const q = parsed.data;
    const result = await scheduleService.listSchedules(user.tenantId, {
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit,
    });

    return c.json(result);
  });

  // POST /api/v1/schedules
  routes.post("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CreateScheduleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const d = parsed.data;
    const schedule = await scheduleService.createSchedule(user.tenantId, {
      pipelineId: d.pipelineId,
      cronExpr: d.cronExpr,
      timezone: d.timezone,
      enabled: d.enabled,
      inputTemplate: d.inputTemplate,
    });

    return c.json({ data: schedule }, 201);
  });

  // GET /api/v1/schedules/:id
  routes.get("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const schedule = await scheduleService.getSchedule(user.tenantId, c.req.param("id"));
    return c.json({ data: schedule });
  });

  // PATCH /api/v1/schedules/:id
  routes.patch("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = PatchScheduleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid request body.", details: parsed.error.flatten() } },
        400,
      );
    }

    const d = parsed.data;
    const updates: Parameters<ScheduleService["updateSchedule"]>[2] = {};
    if (d.cronExpr !== undefined) updates.cronExpr = d.cronExpr;
    if (d.timezone !== undefined) updates.timezone = d.timezone;
    if (d.enabled !== undefined) updates.enabled = d.enabled;
    if (d.inputTemplate !== undefined) updates.inputTemplate = d.inputTemplate;

    const schedule = await scheduleService.updateSchedule(
      user.tenantId,
      c.req.param("id"),
      updates,
    );

    return c.json({ data: schedule });
  });

  // DELETE /api/v1/schedules/:id
  routes.delete("/:id", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
    }

    await scheduleService.deleteSchedule(user.tenantId, c.req.param("id"));
    return c.body(null, 204);
  });

  return routes;
}
