import { defineConfig } from "vitest/config";

// Integration tests for the usage-analytics access boundaries run against the
// real database. They seed and clean up their own namespaced fixtures, so they
// must run serially in a single process to avoid cross-test interference.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
