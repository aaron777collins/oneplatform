import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  listContainers,
  getContainer,
  getContainerLogs,
  getContainerStats,
  containerAction,
} from "../docker/dockerClient.js";
import {
  transformContainerListItem,
  transformContainerInspect,
  transformStats,
} from "../transforms/containerTransform.js";
import { toErrorResponse } from "../errors.js";
import type { ContainerStatus } from "../types.js";

// Container IDs are hex strings 12-64 chars (short or full form). Validating
// this prevents path-traversal style inputs from reaching the Docker daemon.
const containerIdSchema = z
  .string()
  .regex(/^[a-f0-9]{12,64}$/i, "Invalid container id.");

const listQuerySchema = z.object({
  status: z
    .enum(["running", "exited", "paused", "created", "all"])
    .optional()
    .default("all"),
  name: z.string().optional(),
});

const actionBodySchema = z
  .object({ timeoutSeconds: z.number().int().min(0).max(300).optional() })
  .optional();

export function createContainerRoutes(): Hono {
  const routes = new Hono();

  // GET /containers
  routes.get("/", async (c) => {
    try {
      const parsed = listQuerySchema.safeParse(c.req.query());
      if (!parsed.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
          400,
        );
      }
      const { status, name } = parsed.data;

      const raw = await listContainers(true);
      let data = raw.map(transformContainerListItem);

      if (status !== "all") {
        data = data.filter((d) => d.status === (status as ContainerStatus));
      }
      if (name !== undefined && name !== "") {
        const needle = name.toLowerCase();
        data = data.filter((d) => d.name.toLowerCase().includes(needle));
      }

      return c.json({ data });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  // GET /containers/:id
  routes.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!containerIdSchema.safeParse(id).success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid container id." } },
        400,
      );
    }
    try {
      const info = await getContainer(id);
      return c.json({ data: transformContainerInspect(info) });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  // GET /containers/:id/logs
  // Returns a one-shot SSE stream: emits the tail of historical logs as `log`
  // events, then a `done` event. (Live-follow streaming is a future
  // enhancement; the BFF proxy supports SSE passthrough regardless.)
  routes.get("/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!containerIdSchema.safeParse(id).success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid container id." } },
        400,
      );
    }

    const tail = Number(c.req.query("tail") ?? "100");
    const sinceRaw = c.req.query("since");
    const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;

    let text: string;
    try {
      text = await getContainerLogs(id, {
        tail: Number.isNaN(tail) ? 100 : tail,
        ...(since !== undefined && !Number.isNaN(since) ? { since } : {}),
      });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }

    return streamSSE(c, async (stream) => {
      const lines = text.split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        const { ts, content } = splitTimestamp(line);
        await stream.writeSSE({
          event: "log",
          data: JSON.stringify({ stream: "stdout", line: content, ts }),
        });
      }
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ reason: "end_of_history" }),
      });
    });
  });

  // GET /containers/:id/stats — one-shot stats snapshot as a `stats` SSE event.
  routes.get("/:id/stats", async (c) => {
    const id = c.req.param("id");
    if (!containerIdSchema.safeParse(id).success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid container id." } },
        400,
      );
    }

    let stats;
    try {
      const raw = await getContainerStats(id);
      stats = transformStats(raw);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "stats", data: JSON.stringify(stats) });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ reason: "snapshot" }),
      });
    });
  });

  // POST /containers/:id/start|stop|restart
  for (const action of ["start", "stop", "restart"] as const) {
    routes.post(`/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      if (!containerIdSchema.safeParse(id).success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: "Invalid container id." } },
          400,
        );
      }
      const body = await c.req.json().catch(() => undefined);
      const parsed = actionBodySchema.safeParse(body);
      const timeoutSeconds = parsed.success ? parsed.data?.timeoutSeconds : undefined;

      try {
        await containerAction(
          id,
          action,
          timeoutSeconds !== undefined ? { timeoutSeconds } : {},
        );
        return c.body(null, 204);
      } catch (err) {
        const { status, body: errBody } = toErrorResponse(err);
        return c.json(errBody, status as 500);
      }
    });
  }

  // DELETE /containers/:id
  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!containerIdSchema.safeParse(id).success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid container id." } },
        400,
      );
    }
    const force = c.req.query("force") === "true";
    try {
      await containerAction(id, "remove", { force });
      return c.body(null, 204);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  return routes;
}

// Docker timestamps prefix each line when `timestamps:true`, e.g.
// "2026-06-22T10:00:00.000000000Z message". Split them apart for clean SSE.
function splitTimestamp(line: string): { ts: string; content: string } {
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx > 0) {
    const maybeTs = line.slice(0, spaceIdx);
    if (/^\d{4}-\d{2}-\d{2}T/.test(maybeTs)) {
      return { ts: maybeTs, content: line.slice(spaceIdx + 1) };
    }
  }
  return { ts: new Date().toISOString(), content: line };
}
