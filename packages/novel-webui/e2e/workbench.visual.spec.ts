import { expect, test, type Page } from "@playwright/test";
import { documentDiff, documentVersion, documents, mockWorkspace } from "./fixtures";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`desktop workbench ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const pageErrors: string[] = [];
    const networkErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => networkErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
    page.on("response", (response) => {
      if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewportSize(viewport);
    await mockWorkspace(page);
    await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");
    expect(pageErrors).toEqual([]);
    expect(networkErrors).toEqual([]);
    await expect(page.locator("#root")).not.toBeEmpty();

    const sessionsRail = page.getByRole("complementary", { name: "总编会话" });
    const assistant = page.getByLabel("AI 总编", { exact: true });
    const workspace = page.locator(".workspace-main");
    await expect(sessionsRail).toBeVisible();
    await expect(assistant).toBeVisible();
    await expect(workspace).toBeVisible();
    // The workspace area opens the page switcher; review stays one click away.
    await expect(page.getByRole("button", { name: "章节正文" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("article", { name: "文档预览" })).toContainText("雾中的来客");

    const fitsViewport = await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth);
    expect(fitsViewport).toBe(true);

    const before = await workspace.boundingBox();
    await expect(page).toHaveScreenshot(`workbench-${viewport.width}x${viewport.height}.png`, {
      animations: "disabled",
      fullPage: true,
    });

    // Chat-first collapse: folding the workspace pages hands the row to chat.
    await page.getByTestId("assistant-slot").getByRole("button", { name: "收起创作区" }).click();
    expect(before).not.toBeNull();
    await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0).toBeLessThan(10);

    await page.getByTestId("assistant-slot").getByRole("button", { name: "展开创作区" }).click();
    await expect.poll(async () => (await workspace.boundingBox())?.width ?? 0).toBeGreaterThan(before!.width - 20);
    const after = await workspace.boundingBox();
    expect(after).not.toBeNull();

    const railBox = await sessionsRail.boundingBox();
    expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(after!.x);
    expect(after!.x + after!.width).toBeLessThanOrEqual(viewport.width);
  });
}

test("document changes save only on explicit command", async ({ page }) => {
  const documentPuts = await mockWorkspace(page);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");
  await page.getByRole("button", { name: "编辑" }).click();
  const editor = page.getByRole("textbox", { name: "文档源码" });
  await expect(editor).toBeVisible();

  await editor.fill("# 第一章\n\n本地草稿");
  await page.getByRole("button", { name: "预览" }).click();
  expect(documentPuts).toHaveLength(0);
  await page.getByRole("button", { name: "编辑" }).click();
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  expect(documentPuts).toEqual([{
    content: "# 第一章\n\n本地草稿",
    base_hash: "hash-initial",
  }]);
});

test("document conflict keeps both versions without automatic overwrite", async ({ page }) => {
  const documentPuts = await mockWorkspace(page, true);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");
  await page.getByRole("button", { name: "编辑" }).click();
  const editor = page.getByRole("textbox", { name: "文档源码" });
  await editor.fill("# 第一章 本地版本");
  await page.getByRole("button", { name: "保存" }).click();

  await expect(page.getByRole("heading", { name: "文档已在其他位置更新" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "本地草稿" })).toHaveValue("# 第一章 本地版本");
  await expect(page.getByRole("textbox", { name: "远端版本" })).toHaveValue("# 第一章 远端版本\n\n远端已经更新。");
  expect(documentPuts).toHaveLength(1);

  await page.getByRole("button", { name: "保留本地草稿" }).click();
  await expect(editor).toContainText("# 第一章 本地版本");
  expect(documentPuts).toHaveLength(1);
});

test("phone workbench presents one temporary panel at a time", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");

  // The conversation is the base surface; only one overlay opens over it.
  await expect(page.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭临时面板" })).toHaveCount(0);

  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.getByRole("dialog", { name: "会话导航" })).toBeVisible();
  await expect(page.locator(".ai-assistant-rail")).toHaveAttribute("inert", "");
  await expect(page).toHaveScreenshot("workbench-mobile-context-390x844.png", { animations: "disabled" });

  await page.keyboard.press("Escape");
  await expect(page.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeVisible();
  await page.getByRole("button", { name: "展开创作区" }).click();  // phone: only the mobile header has it
  await expect(page.locator(".workbench")).toHaveAttribute("data-context-collapsed", "true");
  await expect(page.getByRole("button", { name: "审查" })).toBeVisible();
  await expect(page).toHaveScreenshot("workbench-mobile-workspace-390x844.png", { animations: "disabled" });
});

test("document change card opens the review page diff", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockWorkspace(page, false, true);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");

  await expect(page.getByText("1 篇文档已修改")).toBeVisible();
  await page.getByRole("button", { name: "在文档中查看 chapters/001.md 第 7 版" }).click();

  // The card lands on the review page, not a routed document swap.
  await expect(page.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "改动审查" })).toBeVisible();
  const reader = page.getByRole("region", { name: "修改对比" });
  await expect(reader).toBeVisible();
  await expect(reader.getByText("1 / 3")).toBeVisible();
  await reader.getByRole("button", { name: "下一处修改" }).click();
  await expect(reader.getByText("2 / 3")).toBeVisible();
  await reader.getByRole("button", { name: "展开文档属性" }).click();
  await expect(reader.getByText(/draft.*confirmed/)).toBeVisible();
  await expect(page).toHaveScreenshot("workbench-document-diff-1440x900.png", { animations: "disabled", fullPage: true });

  // Closing the diff returns to the turn-grouped change list.
  await reader.getByRole("button", { name: "关闭修改对比" }).click();
  await expect(page.getByRole("heading", { name: "改动审查" })).toBeVisible();

  // The manuscript page stayed mounted behind the review tab.
  await page.getByRole("button", { name: "章节正文" }).click();
  await expect(page.getByRole("article", { name: "文档预览" })).toBeVisible();
});

test("phone version history discloses into a full-screen diff", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, false, true);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");

  const historyAside = page.getByRole("complementary", { name: "版本历史" });
  const historyToggle = historyAside.getByRole("button", { name: "显示版本历史" });
  await expect(historyToggle).toBeVisible();
  // The conversation's change card shares the version label; scope to history.
  await expect(historyAside.getByRole("button", { name: /第 7 版/ })).not.toBeVisible();
  await historyToggle.click();
  await historyAside.getByRole("button", { name: /第 7 版/ }).click();
  await expect(page.getByRole("region", { name: "修改对比" })).toBeVisible();
  await expect(page).toHaveScreenshot("workbench-document-diff-mobile-390x844.png", { animations: "disabled" });
});

test("dark and reduced-motion preferences remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => window.localStorage.setItem("novel-vibe-theme", "dark"));
  await mockWorkspace(page);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("article", { name: "文档预览" })).toBeVisible();
  await expect(page.locator(".workspace-main")).toHaveCSS("animation-name", "none");
  await expect(page).toHaveScreenshot("workbench-dark-reduced-motion-1440x900.png", { animations: "disabled" });
});

test("document diff supports dark and reduced-motion preferences", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => window.localStorage.setItem("novel-vibe-theme", "dark"));
  await mockWorkspace(page, false, true);
  await page.goto("/projects/project-1/chapters?document=chapters%2F001.md&version=version-1");

  const reader = page.getByRole("region", { name: "修改对比" });
  await expect(reader).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expect(page).toHaveScreenshot("workbench-document-diff-dark-reduced-motion-1440x900.png", { animations: "disabled", fullPage: true });
});
