import { Hono } from "hono";
import { z } from "zod";
import { listImages, removeImage } from "../docker/dockerClient.js";
import { transformImage } from "../transforms/imageTransform.js";
import { toErrorResponse } from "../errors.js";

const imageIdSchema = z
  .string()
  .regex(/^(sha256:)?[a-f0-9]{12,64}$/i, "Invalid image id.");

export function createImageRoutes(): Hono {
  const routes = new Hono();

  // GET /images
  routes.get("/", async (c) => {
    try {
      const raw = await listImages();
      return c.json({ data: raw.map(transformImage) });
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  // DELETE /images/:id
  routes.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!imageIdSchema.safeParse(id).success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "Invalid image id." } },
        400,
      );
    }
    try {
      await removeImage(id);
      return c.body(null, 204);
    } catch (err) {
      const { status, body } = toErrorResponse(err);
      return c.json(body, status as 500);
    }
  });

  return routes;
}
