import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The CLI binds sockets and writes SQLite files; keep suites sequential.
    fileParallelism: false,
  },
});
