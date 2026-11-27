import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test che aprono un vero PGlite (in memoria o su disco): lenti, uno alla volta.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    globalSetup: ["tests/db/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
