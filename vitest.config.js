import { defineConfig, configDefaults } from "vitest/config";
export default defineConfig({
    test: {
        // WhatsApp QA retired by the owner; retain other transport cases.
        testNamePattern: /^(?!.*whatsapp)/i,
        exclude: [...configDefaults.exclude, "**/*[Ww]hats[Aa]pp*/**", "**/*[Ww]hats[Aa]pp*.{test,spec}.*"],
        environment: "node",
    },
});
