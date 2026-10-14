import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  projects: [
    { name: "", testIgnore: /mobile\.visual\.spec\.ts/ },
    { name: "mobile-small", testMatch: /mobile\.visual\.spec\.ts/, use: { viewport: { width: 320, height: 568 } } },
    { name: "mobile-standard", testMatch: /mobile\.visual\.spec\.ts/, use: { viewport: { width: 390, height: 844 } } },
    { name: "mobile-large", testMatch: /mobile\.visual\.spec\.ts/, use: { viewport: { width: 430, height: 932 } } },
    { name: "mobile-landscape", testMatch: /mobile\.visual\.spec\.ts/, use: { hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } } },
    { name: "tablet", testMatch: /mobile\.visual\.spec\.ts/, use: { viewport: { width: 768, height: 1024 } } },
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    channel: "chrome",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5173",
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
});
