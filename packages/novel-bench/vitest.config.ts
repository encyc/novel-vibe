import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/node_modules/**", "vitest.config.ts"],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 75,
        lines: 70,
      },
    },
    testTimeout: 10_000,
  },
});
