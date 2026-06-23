/**
 * Docker BFF Sidecar — entry point.
 *
 * A single-purpose internal microservice that bridges HTTP API calls to the
 * Docker daemon (via the Unix socket or a TCP DOCKER_HOST). It exposes a small,
 * fixed set of endpoints — it is NOT a general Docker API proxy.
 *
 * Security:
 *  - Every request (except /healthz) must carry a valid X-Service-Token.
 *  - The service is internal-only; the App Service BFF Docker Proxy is its sole
 *    intended caller.
 *
 * The service starts even when no Docker socket is mounted — Docker operations
 * then return 503, but /healthz stays up so orchestrators can schedule it.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getDocker } from "./docker/dockerClient.js";
import { serviceAuth } from "./middleware/serviceAuth.js";
import { createContainerRoutes } from "./routes/containers.js";
import { createImageRoutes } from "./routes/images.js";
import { createNetworkRoutes } from "./routes/networks.js";
import { createVolumeRoutes } from "./routes/volumes.js";

const PORT = Number(process.env["PORT"] ?? "3010");

export function createDockerBffApp(): Hono {
  const app = new Hono();

  // Liveness/readiness — public so orchestrators don't need the service token.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness includes a Docker daemon ping so operators can see whether the
  // socket is actually reachable. A missing socket is reported but does not
  // fail liveness.
  app.get("/readyz", async (c) => {
    try {
      await getDocker().ping();
      return c.json({ status: "ok", docker: "reachable" });
    } catch {
      return c.json({ status: "degraded", docker: "unreachable" }, 503);
    }
  });

  // All Docker routes require the service token.
  app.use("/containers/*", serviceAuth);
  app.use("/containers", serviceAuth);
  app.use("/images/*", serviceAuth);
  app.use("/images", serviceAuth);
  app.use("/networks", serviceAuth);
  app.use("/volumes", serviceAuth);

  app.route("/containers", createContainerRoutes());
  app.route("/images", createImageRoutes());
  app.route("/networks", createNetworkRoutes());
  app.route("/volumes", createVolumeRoutes());

  return app;
}

// Only start the server when run directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const app = createDockerBffApp();
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        service: "docker-bff-service",
        message: `Docker BFF sidecar listening on :${info.port}`,
        ts: new Date().toISOString(),
      }),
    );
  });
}
