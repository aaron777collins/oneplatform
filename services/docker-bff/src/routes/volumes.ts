import { Hono } from "hono";
import { listVolumes } from "../docker/dockerClient.js";
import { transformVolume } from "../transforms/volumeTransform.js";
import { toErrorResponse } from "../errors.js";

export function createVolumeRoutes(): Hono {
  const routes = new Hono();

  // GET /volumes
  routes.get("/", async (c) => {
    try {
      const raw = await listVolumes();
      return c.json({ data: raw.map(transformVolume) });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  return routes;
}
