import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/src/e2e/**", "vendor/managed-runtime-policy/**"],
  },
});

