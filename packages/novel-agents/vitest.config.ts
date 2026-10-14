import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/**/*.test.ts", "auth/**/*.test.ts", "billing/**/*.test.ts", "commands/**/*.test.ts", "continuity/**/*.test.ts", "document-version/**/*.test.ts", "interactions/**/*.test.ts", "lib/**/*.test.ts", "lint/**/*.test.ts", "context/**/*.test.ts", "model-runtime/**/*.test.ts", "project/**/*.test.ts", "referral/**/*.test.ts", "registration/**/*.test.ts", "scheduler/**/*.test.ts", "session/**/*.test.ts", "tools/**/*.test.ts", "schemas/**/*.test.ts", "skills/**/*.test.ts", "community/**/*.test.ts", "*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["auth/**/*.ts", "billing/**/*.ts", "commands/**/*.ts", "continuity/**/*.ts", "document-version/**/*.ts", "interactions/**/*.ts", "lib/**/*.ts", "lint/**/*.ts", "context/**/*.ts", "model-runtime/**/*.ts", "project/**/*.ts", "referral/**/*.ts", "registration/**/*.ts", "scheduler/**/*.ts", "session/**/*.ts", "tools/**/*.ts", "schemas/**/*.ts", "skills/**/*.ts", "community/**/*.ts", "*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/node_modules/**",
        "vitest.config.ts", // config file
      ],
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
