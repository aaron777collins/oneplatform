import { Hono } from "hono";
import { listNetworks } from "../docker/dockerClient.js";
import { transformNetwork } from "../transforms/networkTransform.js";
import { toErrorResponse } from "../errors.js";

export function createNetworkRoutes(): Hono {
  const routes = new Hono();

  // GET /networks
  routes.get("/", async (c) => {
    try {
      const raw = await listNetworks();
      return c.json({ data: raw.map(transformNetwork) });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  return routes;
}
