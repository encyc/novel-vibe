import { test, type Page } from "@playwright/test";
import { mockWorkspace } from "./fixtures";

async function mockSecondary(page: Page) {
  await mockWorkspace(page, false, true);
  const known = new Set([
    "/api/membership/plans", "/api/membership/status", "/api/membership/entitlements",
    "/api/skills", "/api/skill-drafts", "/api/models",
  ]);
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const json: Record<string, unknown> = (() => {
      switch (url.pathname) {
        case "/api/membership/status":
          return { active: true, features: ["premium_models"], expiresAt: "2026-09-30T00:00:00Z" };
        case "/api/membership/plans":
          return { plans: [{ id: "plan-1", slug: "monthly", name: "月卡会员", priceCents: 3900, durationDays: 30, bonusCredits: 500, features: ["premium_models"] }] };
        case "/api/membership/entitlements":
          return { catalog: [
            { key: "workspace_projects", category: "workspace", sortOrder: 1 },
            { key: "premium_models", category: "models", sortOrder: 10 },
          ], premiumModels: [] };
        default:
          return { models: [], skills: [], drafts: [], nextCursor: null };
      }
    })();
    if (!known.has(url.pathname)) return route.fallback();
    await route.fulfill({ json });
  });
}

test("batch34 shots", async ({ page }) => {
  // mobile: workspace with bottom tab bar
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");
  await page.getByRole("article", { name: "文档预览" }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/webui-final/m1-workspace.png" });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("dialog", { name: "会话导航" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/webui-final/m2-sheet.png" });
  await page.keyboard.press("Escape");

  // membership with real-ish data
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockSecondary(page);
  await page.goto("/membership");
  await page.waitForTimeout(900);
  await page.screenshot({ path: "/tmp/webui-final/d1-membership.png", fullPage: true });

  // membership empty plan variant
  await page.route("**/api/membership/plans", (route) => route.fulfill({ json: { plans: [] } }));
  await page.goto("/membership");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/webui-final/d2-membership-empty.png", fullPage: true });

  // skills role grid
  await mockWorkspace(page);
  await page.goto("/skills");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/webui-final/d3-skills.png", fullPage: true });
});
