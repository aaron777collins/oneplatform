import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: true,
    environment: "node",
    exclude: ["integration/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/__tests__/**"],
    },
  },
});
