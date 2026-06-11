import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: true,
    environment: "node",
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/__tests__/**"],
    },
  },
});
