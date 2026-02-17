import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/e2e/**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    // Avoid running multiple docker-compose projects in parallel.
    maxWorkers: 1,
  },
});

