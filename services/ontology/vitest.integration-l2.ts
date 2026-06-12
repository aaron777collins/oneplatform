import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/level2/**/*.test.ts"],
    globalSetup: ["integration/level2/globalSetup.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
