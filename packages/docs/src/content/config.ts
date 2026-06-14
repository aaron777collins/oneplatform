// Legacy Astro content collection configuration (used with legacy.collections: true).
// Defines the "docs" collection used by @astrojs/starlight.
import { defineCollection } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ schema: docsSchema() }),
};
