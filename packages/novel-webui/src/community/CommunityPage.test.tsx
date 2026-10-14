import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { CommunityPage } from "./CommunityPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockApi() {
  vi.spyOn(api, "getCommunitySections").mockResolvedValue({
    sections: [
      { value: "prompt", label: "提示词技巧" },
      { value: "tools", label: "工具分享" },
    ],
  });
  vi.spyOn(api, "listCommunityArticles").mockResolvedValue({
    items: [
      {
        id: "a1",
        author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "如何写好提示词",
        excerpt: "本文介绍...",
        section: "prompt",
        tags: ["ai-writing"],
        kind: "article",
        isFeatured: false,
        feedbackStatus: null,
        commentsEnabled: true,
        likeCount: 5,
        commentCount: 2,
        bookmarkCount: 1,
        publishedAt: "2026-07-01T00:00:00Z",
      },
    ],
    nextCursor: null,
  });
}

describe("CommunityPage", () => {
  it("renders the article feed with topic tags", async () => {
    mockApi();
    window.history.replaceState({}, "", "/community");
    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    const article = await screen.findByRole("listitem");
    expect(within(article).getByText("如何写好提示词")).toBeInTheDocument();
    expect(within(article).getByText("Alice")).toBeInTheDocument();
    expect(within(article).getByText("ai-writing")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "编辑部快捷入口" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("changes feed sorting and distinguishes search with no matches", async () => {
    const list = vi.spyOn(api, "listCommunityArticles").mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    await user.selectOptions(await screen.findByLabelText("内容排序"), "latest");
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "latest" })));

    await user.type(screen.getByRole("searchbox", { name: "搜索标题和标签" }), "不存在的内容");
    expect(await screen.findByText("没有找到匹配的内容")).toBeInTheDocument();
    expect(screen.queryByText(/发布第一篇/)).not.toBeInTheDocument();
  });

  it("shows empty state when no articles", async () => {
    vi.spyOn(api, "getCommunitySections").mockResolvedValue({ sections: [] });
    vi.spyOn(api, "listCommunityArticles").mockResolvedValue({ items: [], nextCursor: null });

    window.history.replaceState({}, "", "/community");
    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    await waitFor(() => {
      expect(screen.getByText(/还没有内容/)).toBeInTheDocument();
    });
  });

  it("does not show the empty state when loading fails", async () => {
    vi.spyOn(api, "listCommunityArticles").mockRejectedValue(new Error("offline"));

    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    expect(await screen.findByText("加载失败", {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
    expect(screen.queryByText(/还没有内容/)).not.toBeInTheDocument();
  });

  it("opens a login reminder when an anonymous user tries to write", async () => {
    mockApi();
    window.history.replaceState({}, "", "/community");
    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    await userEvent.click(await screen.findByRole("button", { name: /写文章/ }));

    const dialog = await screen.findByRole("dialog", { name: "登录后发布文章" });
    expect(within(dialog).getByText("登录后可以发布文章、保存草稿，并在社区中管理自己的内容。")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "去登录" }))
      .toHaveAttribute("href", `${window.location.origin}/login`);
  });

  it("shows a single writing action instead of repeating it in the hero", async () => {
    mockApi();
    window.history.replaceState({}, "", "/community");
    render(<AppProviders><CommunityPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} /></AppProviders>);

    expect(await screen.findAllByRole("link", { name: /写文章|发布内容/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "发布内容" })).not.toBeInTheDocument();
  });

  it("shows four primary community tabs and queries by kind", async () => {
    const list = vi.spyOn(api, "listCommunityArticles").mockResolvedValue({ items: [], nextCursor: null });

    render(<AppProviders><CommunityPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} /></AppProviders>);

    expect(await screen.findByRole("tab", { name: "文章" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "功能请求" }));

    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "feature_request",
      sort: "ranked",
    })));
  });

  it("renders feature requests with vote wording", async () => {
    vi.spyOn(api, "listCommunityArticles").mockResolvedValue({
      items: [{
        id: "r1",
        kind: "feature_request",
        author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "支持导出 EPUB",
        excerpt: null,
        section: "tools",
        tags: ["工具工作流"],
        isFeatured: false,
        feedbackStatus: "open",
        commentsEnabled: true,
        likeCount: 5,
        commentCount: 2,
        bookmarkCount: 0,
        publishedAt: "2026-07-10T00:00:00Z",
      }],
      nextCursor: null,
    });

    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);
    await userEvent.click(await screen.findByRole("tab", { name: "功能请求" }));

    expect(await screen.findByText("投票 5")).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
  });

  it("localizes English controls while preserving Chinese community content and routes", async () => {
    mockApi();
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    render(<AppProviders><CommunityPage user={null} onSignedOut={vi.fn()} /></AppProviders>);

    expect(await screen.findByRole("tab", { name: "Article" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Latest" })).toBeInTheDocument();
    const article = await screen.findByRole("listitem");
    expect(within(article).getByText("如何写好提示词")).toBeInTheDocument();
    expect(within(article).getByText("本文介绍...")).toBeInTheDocument();
    expect(within(article).getByText("ai-writing")).toBeInTheDocument();
    expect(within(article).getByText("Jul 1, 2026")).toBeInTheDocument();
    expect(article).toHaveAttribute("href", "/community/a1");
  });
});
