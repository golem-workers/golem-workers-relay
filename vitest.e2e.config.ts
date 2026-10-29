import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // WhatsApp QA retired by the owner; retain other transport cases.
    testNamePattern: /^(?!.*whatsapp)/i,
    environment: "node",
    include: ["src/e2e/**/*.e2e.test.ts"],
    exclude: ["**/*[Ww]hats[Aa]pp*/**", "**/*[Ww]hats[Aa]pp*.{test,spec}.*", "**/node_modules/**", "**/dist/**", "**/.git/**"],
    // Avoid running multiple docker-compose projects in parallel.
    maxWorkers: 1,
  },
});

