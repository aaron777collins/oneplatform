import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/level1/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
