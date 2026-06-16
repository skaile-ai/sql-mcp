import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Networked live tests require Docker (testcontainers); run them via `bun run test:integration`.
    exclude: process.env.RUN_DB_INTEGRATION
      ? ["**/node_modules/**"]
      : ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
  },
});
