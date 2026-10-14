import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api/client";
import { AppProviders } from "./app/AppProviders";
import { i18n } from "./i18n/config";
import { referralNoticeStorageKey } from "./referral/referral-notice-storage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
  vi.spyOn(api, "getProfile").mockResolvedValue({
    id: "user-1",
    email: "u@example.com",
    displayName: "灵器用户",
    avatarUrl: null,
    locale: "zh-CN",
  });
  vi.spyOn(api, "getReferralDashboard").mockResolvedValue({
    code: "ABCD2345",
    shareUrl: "https://app.example/login?invite=ABCD2345",
    canInvite: false,
    campaign: null,
    counts: { successful: 0, pending: 0, remaining: 0 },
    invitations: [],
    inviteeBinding: null,
    rewards: [],
  });
});

function renderApp(path = "/") {
  window.history.replaceState({}, "", path);
  return render(
    <AppProviders>
      <App />
    </AppProviders>,
  );
}

describe("App", () => {
  it("shows login when unauthenticated", async () => {
    vi.spyOn(api, "me").mockResolvedValue(null);

    renderApp();

    expect(await screen.findByRole("heading", { name: "灵器 AI" })).toBeInTheDocument();
    expect(screen.getByText("长篇创作工作台")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入工作台" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "卷首" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "账户登录" })).toBeInTheDocument();
    expect(screen.getByText("故事，从静处生长")).toBeInTheDocument();
  });

  it("renders English login chrome from the anonymous interface locale", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    vi.spyOn(api, "me").mockResolvedValue(null);

    renderApp();

    expect(await screen.findByRole("heading", { name: "Lingqi AI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Interface language" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  });

  it("allows anonymous users to browse the community", async () => {
    vi.spyOn(api, "me").mockResolvedValue(null);
    vi.spyOn(api, "getCommunitySections").mockResolvedValue({ sections: [] });
    vi.spyOn(api, "listCommunityArticles").mockResolvedValue({
      items: [{
        id: "a1",
        author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "公开社区文章",
        excerpt: "任何人都能阅读",
        section: "prompt",
        tags: [],
        kind: "article",
        isFeatured: false,
        feedbackStatus: null,
        commentsEnabled: true,
        likeCount: 1,
        commentCount: 0,
        bookmarkCount: 0,
        publishedAt: "2026-07-09T00:00:00Z",
      }],
      nextCursor: null,
    });

    renderApp("/community");

    expect(await screen.findByRole("heading", { name: "公开社区文章" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "账户登录" })).not.toBeInTheDocument();
  });

  it("shows the Project Center when authenticated", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.mocked(api.getProfile).mockResolvedValue({
      id: "user-1", email: "u@example.com", displayName: "Alice", avatarUrl: null, locale: "en",
    });
    vi.spyOn(api, "listProjects").mockResolvedValue([
      { id: "project-1", title: "长夜临渊", genre: "玄幻", creative_language: "zh-CN" },
    ]);
    vi.spyOn(api, "listDocuments").mockResolvedValue([]);

    renderApp();

    await waitFor(() => expect(screen.getByText("u@example.com")).toBeInTheDocument());
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("heading", { name: "Project center" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("shows the referral notice after restoring an authenticated session", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://app.example/login?invite=ABCD2345",
      canInvite: true,
      campaign: { bindingEndsAt: "2026-09-01T00:00:00.000Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      inviteeBinding: null,
      rewards: [],
    });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    localStorage.removeItem(referralNoticeStorageKey("user-1"));

    renderApp();

    expect(await screen.findByRole("dialog", { name: "邀请好友，双方得会员" })).toBeInTheDocument();
  });

  it("shows the referral notice after a fresh login", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "me")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "user-1", email: "u@example.com" });
    vi.spyOn(api, "login").mockResolvedValue();
    vi.mocked(api.getReferralDashboard).mockResolvedValue({
      code: "ABCD2345",
      shareUrl: "https://app.example/login?invite=ABCD2345",
      canInvite: true,
      campaign: { bindingEndsAt: "2026-09-01T00:00:00.000Z", rewardDays: 10, maxSlots: 10 },
      counts: { successful: 0, pending: 0, remaining: 10 },
      invitations: [],
      inviteeBinding: null,
      rewards: [],
    });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);

    renderApp();
    await user.type(await screen.findByLabelText("邮箱"), "u@example.com");
    await user.type(screen.getByLabelText("密码"), "secret");
    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(await screen.findByRole("dialog", { name: "邀请好友，双方得会员" })).toBeInTheDocument();
  });

  it("creates the first project and navigates to its overview", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listDocuments").mockResolvedValue([]);
    vi.spyOn(api, "createProject").mockResolvedValue({ id: "new-project", title: "新书", creative_language: "zh-CN" });

    renderApp();

    await user.click(await screen.findByRole("button", { name: "新建项目" }));
    await user.type(await screen.findByLabelText("项目标题"), "新书");
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(window.location.pathname).toBe("/projects/new-project/overview"));
  });

  it("opens an archived Project from a direct route", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "getProject").mockResolvedValue({
      id: "archived-project",
      title: "封存之书",
      lifecycle_status: "archived",
      creative_language: "zh-CN",
    });
    vi.spyOn(api, "listDocuments").mockResolvedValue([]);
    vi.spyOn(api, "listSessions").mockResolvedValue({ items: [], nextCursor: null, activeSessionId: null });

    renderApp("/projects/archived-project/overview");

    // The overview brief is gone: /overview redirects into the first module.
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/projects/archived-project/chapters");
  });

  it("opens the Profile dashboard with a section index", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.mocked(api.getProfile).mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "墨白", avatarUrl: null, locale: "zh-CN" });
    vi.spyOn(api, "getCreditSummary").mockResolvedValue({ balance: 100, totalGranted: 150, totalConsumed: 50, level: 0, levelName: "新用户" });
    vi.spyOn(api, "getCreditActivity").mockResolvedValue([]);
    vi.spyOn(api, "listCreditTransactions").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "listCreditPackages").mockResolvedValue([]);
    vi.spyOn(api, "getMembershipPlans").mockResolvedValue([{ id: "p1", slug: "monthly", name: "月卡会员", priceCents: 990, durationDays: 30, bonusCredits: 100, features: ["unlimited_projects", "export"] }]);
    vi.spyOn(api, "getMembershipStatus").mockResolvedValue({ active: false, planName: null, expiresAt: null, features: [] });
    vi.spyOn(api, "listApiTokens").mockResolvedValue([]);

    renderApp("/profile");

    expect(await screen.findByRole("heading", { name: "账户与 Credit" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "作者身份" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "个人中心导航" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "个人资料" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "界面偏好" }));

    expect(screen.getByRole("region", { name: "界面偏好" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "界面语言" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["界面偏好"]);
  });

  it("confirms a Z-Pay return using out_trade_no", async () => {
    vi.spyOn(api, "me").mockResolvedValue({ id: "user-1", email: "u@example.com" });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.mocked(api.getProfile).mockResolvedValue({ id: "user-1", email: "u@example.com", displayName: "墨白", avatarUrl: null, locale: "zh-CN" });
    vi.spyOn(api, "getCreditSummary").mockResolvedValue({ balance: 100, totalGranted: 150, totalConsumed: 50, level: 0, levelName: "新用户" });
    vi.spyOn(api, "getCreditActivity").mockResolvedValue([]);
    vi.spyOn(api, "listCreditTransactions").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "listCreditPackages").mockResolvedValue([]);
    vi.spyOn(api, "getMembershipPlans").mockResolvedValue([{ id: "p1", slug: "monthly", name: "月卡会员", priceCents: 990, durationDays: 30, bonusCredits: 100, features: ["unlimited_projects", "export"] }]);
    vi.spyOn(api, "getMembershipStatus").mockResolvedValue({ active: false, planName: null, expiresAt: null, features: [] });
    vi.spyOn(api, "listApiTokens").mockResolvedValue([]);
    const purchase = vi.spyOn(api, "getCreditPurchase").mockResolvedValue({ orderNo: "NOVEL123", status: "completed" });
    renderApp("/profile?out_trade_no=NOVEL123");
    expect(await screen.findByText("充值已到账。")).toBeInTheDocument();
    expect(purchase).toHaveBeenCalledWith("NOVEL123");
  });

  it("enters the project center without the login gate when the BFF reports local mode", async () => {
    vi.spyOn(api, "getMode").mockResolvedValue({ localMode: true });
    vi.spyOn(api, "me").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "local@novel-vibe.local.invalid",
    });
    vi.mocked(api.getProfile).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      email: "local@novel-vibe.local.invalid",
      displayName: "本地作者",
      avatarUrl: null,
      locale: "en",
    });
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "listDocuments").mockResolvedValue([]);

    renderApp();

    expect(await screen.findByRole("heading", { name: "Project center" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "账户登录" })).not.toBeInTheDocument();
    // Hosted-only surfaces stay out of a local install.
    expect(api.getReferralDashboard).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "社区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "会员权益" })).not.toBeInTheDocument();
  });

  it("still enters the app when the local identity cannot be read", async () => {
    vi.spyOn(api, "getMode").mockResolvedValue({ localMode: true });
    vi.spyOn(api, "me").mockRejectedValue(new Error("bff unavailable"));
    vi.mocked(api.getProfile).mockRejectedValue(new Error("bff unavailable"));
    vi.spyOn(api, "listProjects").mockResolvedValue([]);

    renderApp();

    // The minimal local identity keeps the shell usable instead of falling back
    // to the login screen.
    expect(await screen.findByText("local@novel-vibe.local.invalid")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "账户登录" })).not.toBeInTheDocument();
  });
});
