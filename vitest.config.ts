import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // WhatsApp QA retired by the owner; retain other transport cases.
    testNamePattern: /^(?!.*whatsapp)/i,
    environment: "node",
    exclude: ["**/*[Ww]hats[Aa]pp*/**", "**/*[Ww]hats[Aa]pp*.{test,spec}.*", ...configDefaults.exclude, "**/src/e2e/**", "vendor/managed-runtime-policy/**"],
  },
});

