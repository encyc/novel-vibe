import { expect, test, type Page, type TestInfo } from "@playwright/test";

const project = {
  id: "project-1",
  title: "长夜临渊",
  genre: "东方奇幻",
  synopsis: "失去城主的北境孤城，在漫长极夜中等待一位无名来客。",
  creative_language: "zh-CN",
};

const document = {
  project_id: project.id,
  doc_path: "chapters/001.md",
  doc_type: "chapter-text",
  name: "第一章 雾中的来客",
  status: "draft",
  word_count: 3280,
  updated_at: "2026-06-27T08:00:00.000Z",
};

const session = {
  id: "session-1",
  projectId: project.id,
  title: "人物与雾城",
  isProcessing: false,
  memoryStatus: "healthy",
  messageCount: 0,
  lastMessageAt: "2026-06-27T08:00:00.000Z",
  createdAt: "2026-06-27T08:00:00.000Z",
};

async function mockApp(page: Page, authenticated = true, referralEligible = false) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/me") {
      await route.fulfill(authenticated
        ? { json: { user: { id: "user-1", email: "writer@example.com" } } }
        : { status: 401, json: { error: "Unauthorized" } });
    } else if (path === "/api/profile") {
      await route.fulfill({ json: { id: "user-1", email: "writer@example.com", displayName: "沈砚", locale: "zh-CN" } });
    } else if (path === "/api/projects") {
      await route.fulfill({ json: { projects: url.searchParams.get("status") === "active" ? [project] : [] } });
    } else if (path === `/api/projects/${project.id}/sessions`) {
      await route.fulfill({ json: { items: [session], nextCursor: null, activeSessionId: session.id } });
    } else if (path === `/api/sessions/${session.id}/messages`) {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else if (path === `/api/documents/${project.id}`) {
      await route.fulfill({ json: { documents: [document] } });
    } else if (path === `/api/documents/${project.id}/${document.doc_path}`) {
      await route.fulfill({ json: { path: document.doc_path, hash: "hash-1", content: "# 第一章 雾中的来客\n\n城门在子夜前关闭。沈砚抵达时，最后一盏引路灯刚刚熄灭。" } });
    } else if (path === "/api/models") {
      await route.fulfill({ json: { models: [] } });
    } else if (path === "/api/membership/status") {
      await route.fulfill({ json: { active: false, features: [] } });
    } else if (path === "/api/membership/plans") {
      await route.fulfill({ json: { plans: [] } });
    } else if (path === "/api/credits/summary") {
      await route.fulfill({ json: { balance: 12000, totalGranted: 18000, totalConsumed: 6000, level: 2, levelName: "执笔" } });
    } else if (path === "/api/credits/activity") {
      await route.fulfill({ json: { days: [] } });
    } else if (path === "/api/credits/transactions") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else if (path === "/api/credits/packages") {
      await route.fulfill({ json: { packages: [] } });
    } else if (path === "/api/profile/tokens") {
      await route.fulfill({ json: { tokens: [] } });
    } else if (path === "/api/referrals/me") {
      await route.fulfill({ json: {
        code: "ABCD2345",
        shareUrl: "https://app.example/login?invite=ABCD2345",
        canInvite: referralEligible,
        unavailableReason: referralEligible ? undefined : "campaign_closed",
        campaign: { bindingEndsAt: "2026-09-30T00:00:00Z", rewardDays: 10, maxSlots: 10 },
        counts: { successful: 1, pending: 2, remaining: 7 },
        invitations: [],
        inviteeBinding: null,
        rewards: [],
      } });
    } else if (path === "/api/skills") {
      await route.fulfill({ json: { skills: [] } });
    } else if (path === "/api/community/articles") {
      await route.fulfill({ json: { items: [], nextCursor: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

async function expectNoPageOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}

async function expectTouchTarget(locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

function onlyProject(testInfo: TestInfo, name: string) {
  test.skip(testInfo.project.name !== name, `covered by the ${name} viewport project`);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("novel-vibe:interface-locale", "zh-CN"));
});

test("phone overview, session sheet, and fullscreen Chief Editor", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-standard");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/overview`);
  await expect(page.locator('header[aria-label="移动创作工作台"]')).toBeVisible();
  await expect(page.locator(".workspace-rail")).toBeHidden();
  await expectTouchTarget(page.getByRole("button", { name: "打开导航" }));
  await expectTouchTarget(page.getByRole("button", { name: "展开创作区" }));
  // The conversation is the phone base surface.
  await expect(page.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeFocused();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-overview-390x844.png", { animations: "disabled", fullPage: true });

  const navigationTrigger = page.getByRole("button", { name: "打开导航" });
  await navigationTrigger.click();
  const navigation = page.getByRole("dialog", { name: "会话导航" });
  await expect(navigation).toBeVisible();
  // The base conversation surface is shielded while the sheet owns input.
  await expect(page.locator(".ai-assistant-rail")).toHaveAttribute("inert", "");
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-navigation-390x844.png", { animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(navigationTrigger).toBeFocused();

  // The workbench area opens over the chat with its page switcher.
  const workspaceTrigger = page.getByRole("button", { name: "展开创作区" });
  await workspaceTrigger.click();
  await expect(page.locator(".workbench")).toHaveAttribute("data-context-collapsed", "true");
  await expect(page.getByRole("button", { name: "章节正文" })).toHaveAttribute("aria-pressed", "true");
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-workspace-390x844.png", { animations: "disabled" });
  // Toggled state renames the header control (展开 ↔ 收起), keep a ≥44px target.
  await expectTouchTarget(page.getByRole("button", { name: "收起创作区" }));
});

test("phone manuscript preview and editing controls", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-standard");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/chapters?document=chapters%2F001.md`);
  await expect(page.getByRole("article", { name: "文档预览" })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: "编辑" }).click();
  await expect(page.getByRole("textbox", { name: "文档源码" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeVisible();
  await expect(page.getByRole("button", { name: "更多文档操作" })).toBeVisible();
  await expectTouchTarget(page.getByRole("button", { name: "保存" }));
  await expectTouchTarget(page.getByRole("button", { name: "更多文档操作" }));
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-manuscript-edit-390x844.png", { animations: "disabled" });
});

test("phone login and project collection", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-standard");
  await mockApp(page, false);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "账户登录" })).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-login-390x844.png", { animations: "disabled", fullPage: true });

  await page.unrouteAll({ behavior: "wait" });
  await mockApp(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "项目中心" })).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-projects-390x844.png", { animations: "disabled", fullPage: true });
});

test("phone standalone creation, community, and Skills pages", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-standard");
  await mockApp(page);

  await page.goto("/projects");
  await page.getByRole("button", { name: "新建项目" }).click();
  await expect(page.getByRole("form", { name: "新建项目" })).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-project-create-390x844.png", { animations: "disabled" });

  await page.goto("/community");
  await expect(page.locator(".community-page")).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-community-390x844.png", { animations: "disabled", fullPage: true });

  await page.goto("/community/write");
  await expect(page.getByRole("region", { name: "正文编辑" })).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-community-editor-390x844.png", { animations: "disabled", fullPage: true });

  await page.goto("/skills");
  await expect(page.locator(".skills-page")).toBeVisible();
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-skills-390x844.png", { animations: "disabled", fullPage: true });
});

test("phone profile replaces the index with one section selector", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-standard");
  await mockApp(page, true, true);
  await page.addInitScript(() => window.localStorage.setItem(
    "novel-vibe:referral-notice-dismissed:user-1",
    "2026-09-30T00:00:00Z",
  ));
  await page.goto("/profile?section=referral");

  await expect(page.locator(".profile-page")).toBeVisible();
  await expect(page.locator(".profile-desktop-navigation")).toBeHidden();
  await expect(page.getByRole("combobox", { name: "选择个人中心栏目" })).toHaveValue("referral");
  await expect(page.getByText("邀请活动：双方 +10 天")).toBeVisible();
  await expect(page.getByRole("heading", { name: "邀请好友，双方得会员" })).toBeVisible();
  await expect(page.locator(".profile-ledger-main > .profile-section")).toHaveCount(1);
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot("mobile-profile-390x844.png", { animations: "disabled", fullPage: true });
});

test("small phone keeps primary manuscript controls in bounds", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-small");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/chapters?document=chapters%2F001.md`);
  await expect(page.getByRole("button", { name: "编辑" })).toBeVisible();
  await expectNoPageOverflow(page);
});

test("large phone navigation sheet stays within the viewport", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-large");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/overview`);
  await page.getByRole("button", { name: "打开导航" }).click();
  const box = await page.getByRole("dialog", { name: "会话导航" }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(430);
  await expectNoPageOverflow(page);
});

test("landscape phone keeps the assistant composer reachable", async ({ page }, testInfo) => {
  onlyProject(testInfo, "mobile-landscape");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/overview`);
  // The conversation is the base surface on phones, landscape included.
  await expect(page.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeInViewport();
  await expectNoPageOverflow(page);
});

test("tablet retains overlay navigation and compact temporary panels", async ({ page }, testInfo) => {
  onlyProject(testInfo, "tablet");
  await mockApp(page);
  await page.goto(`/projects/${project.id}/overview`);
  await expect(page.locator(".workspace-rail")).toBeHidden();
  await expect(page.locator(".session-rail")).not.toBeInViewport();
  const toggle = page.getByRole("button", { name: "展开上下文栏" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator(".session-rail")).toBeVisible();
  await expectNoPageOverflow(page);
});
