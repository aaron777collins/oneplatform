import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError, ValidationError } from "@oneplatform/core";
import type { MeteringService, UsagePeriod } from "../services/metering-service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const usageSummaryQuery = z.object({
  period: z.enum(["hourly", "daily", "monthly"]).default("monthly"),
});

const usageHistoryQuery = z.object({
  from: z.string().datetime({ message: "from must be an ISO 8601 datetime string" }),
  to: z.string().datetime({ message: "to must be an ISO 8601 datetime string" }),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface UsageRouteDeps {
  meteringService: MeteringService;
}

export function createUsageRoutes(deps: UsageRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { meteringService } = deps;

  // -------------------------------------------------------------------------
  // GET /api/v1/usage/summary?period=monthly
  // Returns aggregated usage for the current period.
  // -------------------------------------------------------------------------

  routes.get("/summary", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const parsed = usageSummaryQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const summary = await meteringService.getUsageSummary(
      user.tenantId,
      parsed.data.period as UsagePeriod,
    );

    return c.json({ data: summary });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/usage/history?from=...&to=...
  // Returns raw usage events within the specified window.
  // -------------------------------------------------------------------------

  routes.get("/history", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const parsed = usageHistoryQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid query parameters.", details: parsed.error.flatten() } },
        400,
      );
    }

    const from = new Date(parsed.data.from);
    const to = new Date(parsed.data.to);

    if (from >= to) {
      throw new ValidationError("'from' must be earlier than 'to'.");
    }

    // Cap the query window at 366 days to prevent unbounded scans.
    const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
      throw new ValidationError("Query window cannot exceed 366 days.");
    }

    const events = await meteringService.getUsageByTenant(user.tenantId, from, to);

    return c.json({ data: events });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/usage/export
  // Returns all usage events for the current calendar month as CSV.
  // -------------------------------------------------------------------------

  routes.get("/export", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Default export window: start of current month to now.
    const now = new Date();
    const monthStart = new Date(now);
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const events = await meteringService.getUsageByTenant(user.tenantId, monthStart, now);

    const header = "tenant_id,type,value,metadata,timestamp\n";
    const rows = events.map((ev) => {
      const meta = ev.metadata !== undefined ? JSON.stringify(ev.metadata).replace(/"/g, '""') : "";
      return `"${escapeCsvField(ev.tenantId)}","${escapeCsvField(ev.type)}",${ev.value},"${meta}","${ev.timestamp}"`;
    });

    return new Response(header + rows.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="usage-${user.tenantId}-${now.toISOString().slice(0, 10)}.csv"`,
      },
    });
  });

  return routes;
}

// Escape a CSV field value: double embedded double-quotes and prefix formula
// injection characters (=, +, -, @) with a single quote to prevent spreadsheet
// applications from interpreting field content as formulas.
function escapeCsvField(value: string): string {
  const escaped = value.replace(/"/g, '""');
  if (/^[=+\-@]/.test(escaped)) {
    return `'${escaped}`;
  }
  return escaped;
}
