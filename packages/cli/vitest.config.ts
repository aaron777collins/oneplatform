import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/__tests__/**"],
    },
  },
});
