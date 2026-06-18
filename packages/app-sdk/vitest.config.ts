import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    isolate: true,
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      reporter: ["text", "json"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test-setup.ts"],
      thresholds: {
        statements: 90,
        branches: 85,
      },
    },
  },
});
