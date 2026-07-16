import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";

export function createDlqRoutes(): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  // GET /api/v1/dlq
  // Returns failed BullMQ jobs. Currently returns empty list with correct
  // pagination shape — charts and tables handle this as "DLQ is empty" state.
  // TODO(OP-2001): Wire up BullMQ Redis introspection to return real failed jobs.
  routes.get("/", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    return c.json({
      data: [],
      pagination: {
        total: 0,
        limit: 50,
        offset: 0,
        nextCursor: null,
      },
    });
  });

  // POST /api/v1/dlq/:jobId/replay
  routes.post("/:jobId/replay", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const jobId = c.req.param("jobId");
    // TODO(OP-2001): Look up job in BullMQ failed set and re-queue it.
    return c.json({ data: { jobId, status: "requeued" } }, 202);
  });

  // DELETE /api/v1/dlq/:jobId
  routes.delete("/:jobId", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    const jobId = c.req.param("jobId");
    // TODO(OP-2001): Remove job from BullMQ failed set.
    return c.json({ data: { jobId, status: "discarded" } });
  });

  // POST /api/v1/dlq/bulk-replay
  routes.post("/bulk-replay", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // TODO(OP-2001): Re-queue all failed jobs for the given queueName (or all queues).
    return c.json({ data: { requeued: 0 } }, 202);
  });

  // DELETE /api/v1/dlq/bulk
  routes.delete("/bulk", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // TODO(OP-2001): Remove all failed jobs for the given queueName (or all queues).
    return c.json({ data: { discarded: 0 } });
  });

  return routes;
}
