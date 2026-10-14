import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { ArticleDetailPage } from "./ArticleDetailPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockArticle() {
  vi.spyOn(api, "getCommunityArticle").mockResolvedValue({
    article: {
      id: "a1",
      author: { id: "author-1", nickname: "Alice", avatarUrl: null, isOfficial: false },
      title: "提示词技巧",
      excerpt: null,
      section: "prompt",
      tags: ["提示词", "创作方法"],
      kind: "article",
      isFeatured: false,
      feedbackStatus: null,
      commentsEnabled: true,
      likeCount: 3,
      commentCount: 0,
      bookmarkCount: 1,
      publishedAt: "2026-07-01T00:00:00Z",
      body: "正文",
      status: "published",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    },
  });
  vi.spyOn(api, "listCommunityComments").mockResolvedValue({ comments: [] });
}

describe("ArticleDetailPage", () => {
  it("presents article context and tags before the reading body", async () => {
    mockArticle();
    window.history.replaceState({}, "", "/community/a1");
    render(<AppProviders><Routes>
      <Route path="/community/:articleId" element={<ArticleDetailPage user={null} onSignedOut={vi.fn()} />} />
    </Routes></AppProviders>);

    const info = await screen.findByRole("region", { name: "文章信息" });
    expect(info).toHaveTextContent("创作文章");
    expect(within(info).getByText("提示词")).toBeInTheDocument();
    expect(within(info).getByText("创作方法")).toBeInTheDocument();
  });

  it("uses the current interaction state to unlike an already-liked article", async () => {
    mockArticle();
    vi.spyOn(api, "getCommunityInteractions").mockResolvedValue({
      interactions: { a1: { liked: true, bookmarked: false } },
    });
    const unlike = vi.spyOn(api, "unlikeCommunityArticle").mockResolvedValue(undefined);
    const like = vi.spyOn(api, "likeCommunityArticle").mockResolvedValue(undefined);

    window.history.replaceState({}, "", "/community/a1");
    render(<AppProviders>
      <Routes>
        <Route path="/community/:articleId" element={<ArticleDetailPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />} />
      </Routes>
    </AppProviders>);

    const button = await screen.findByRole("button", { name: /已点赞/ });
    await userEvent.click(button);

    await waitFor(() => expect(unlike).toHaveBeenCalledWith("a1"));
    expect(like).not.toHaveBeenCalled();
  });

  it("opens login reminders for anonymous article interactions", async () => {
    mockArticle();

    window.history.replaceState({}, "", "/community/a1");
    render(<AppProviders>
      <Routes>
        <Route path="/community/:articleId" element={<ArticleDetailPage user={null} onSignedOut={vi.fn()} />} />
      </Routes>
    </AppProviders>);

    await userEvent.click(await screen.findByRole("button", { name: /点赞/ }));
    expect(await screen.findByRole("dialog", { name: "登录后点赞" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: /收藏/ }));
    expect(await screen.findByRole("dialog", { name: "登录后收藏" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await userEvent.click(await screen.findByRole("button", { name: "评论" }));
    expect(await screen.findByRole("dialog", { name: "登录后评论" })).toBeInTheDocument();
  });

  it("hides comments for announcements", async () => {
    vi.spyOn(api, "getCommunityArticle").mockResolvedValue({
      article: {
        id: "n1",
        kind: "announcement",
        author: { id: "admin", nickname: "官方", avatarUrl: null, isOfficial: true },
        title: "版本更新",
        body: "公告正文",
        excerpt: null,
        section: "announcements",
        tags: [],
        status: "published",
        isFeatured: false,
        feedbackStatus: null,
        commentsEnabled: false,
        likeCount: 0,
        commentCount: 0,
        bookmarkCount: 0,
        publishedAt: "2026-07-10T00:00:00Z",
        createdAt: "2026-07-10T00:00:00Z",
        updatedAt: "2026-07-10T00:00:00Z",
      },
    });
    const comments = vi.spyOn(api, "listCommunityComments").mockResolvedValue({ comments: [] });
    window.history.replaceState({}, "", "/community/n1");

    render(<AppProviders><Routes>
      <Route path="/community/:articleId" element={<ArticleDetailPage user={null} onSignedOut={vi.fn()} />} />
    </Routes></AppProviders>);

    expect(await screen.findByRole("heading", { name: "版本更新" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /评论/ })).not.toBeInTheDocument();
    expect(comments).not.toHaveBeenCalled();
  });

  it("shows admin controls to community admins", async () => {
    vi.spyOn(api, "getCommunityArticle").mockResolvedValue({
      article: {
        id: "b1",
        kind: "bug",
        author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "保存失败",
        body: "复现步骤",
        excerpt: null,
        section: "tools",
        tags: [],
        status: "published",
        isFeatured: false,
        feedbackStatus: "open",
        commentsEnabled: true,
        likeCount: 2,
        commentCount: 0,
        bookmarkCount: 0,
        publishedAt: "2026-07-10T00:00:00Z",
        createdAt: "2026-07-10T00:00:00Z",
        updatedAt: "2026-07-10T00:00:00Z",
      },
    });
    vi.spyOn(api, "listCommunityComments").mockResolvedValue({ comments: [] });
    vi.spyOn(api, "getCommunityInteractions").mockResolvedValue({ interactions: {} });
    const updateStatus = vi.spyOn(api, "updateCommunityFeedbackStatus").mockResolvedValue(undefined);
    window.history.replaceState({}, "", "/community/b1");

    render(<AppProviders><Routes>
      <Route path="/community/:articleId" element={<ArticleDetailPage user={{ id: "admin", email: "a@example.com", isCommunityAdmin: true }} onSignedOut={vi.fn()} />} />
    </Routes></AppProviders>);

    expect(await screen.findByRole("button", { name: "设为精华" })).toBeInTheDocument();
    expect(screen.getByLabelText("反馈状态")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("反馈状态"), "fixed");
    expect(updateStatus).toHaveBeenCalledWith("b1", "fixed");
  });

  it("localizes English chrome while preserving article content", async () => {
    mockArticle();
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    window.history.replaceState({}, "", "/community/a1");
    render(<AppProviders><Routes>
      <Route path="/community/:articleId" element={<ArticleDetailPage user={null} onSignedOut={vi.fn()} />} />
    </Routes></AppProviders>);

    const info = await screen.findByRole("region", { name: "Article information" });
    expect(within(info).getByRole("heading", { name: "提示词技巧" })).toBeInTheDocument();
    expect(within(info).getByText("提示词")).toBeInTheDocument();
    expect(screen.getByText("正文")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Like 3/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to community/ })).toHaveAttribute("href", "/community");
  });
});
