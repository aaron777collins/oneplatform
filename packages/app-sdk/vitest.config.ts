import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    isolate: true,
    setupFiles: [],
    coverage: {
      reporter: ["text", "json"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      thresholds: {
        statements: 90,
        branches: 85,
      },
    },
  },
});
