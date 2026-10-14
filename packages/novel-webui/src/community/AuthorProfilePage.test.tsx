import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { AuthorProfilePage } from "./AuthorProfilePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthorProfilePage", () => {
  it("uses the current follow state before toggling", async () => {
    vi.spyOn(api, "getCommunityAuthorProfile").mockResolvedValue({
      profile: {
        userId: "author-1",
        nickname: "Alice",
        avatarUrl: null,
        isOfficial: false,
        bio: null,
        articleCount: 1,
        followerCount: 2,
      },
    });
    vi.spyOn(api, "listCommunityArticlesByAuthor").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, "getCommunityFollowingState").mockResolvedValue({ following: true });
    const unfollow = vi.spyOn(api, "unfollowUser").mockResolvedValue(undefined);
    const follow = vi.spyOn(api, "followUser").mockResolvedValue(undefined);

    window.history.replaceState({}, "", "/community/author/author-1");
    render(<AppProviders>
      <Routes>
        <Route path="/community/author/:userId" element={<AuthorProfilePage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />} />
      </Routes>
    </AppProviders>);

    const button = await screen.findByRole("button", { name: "取消关注" });
    await userEvent.click(button);

    await waitFor(() => expect(unfollow).toHaveBeenCalledWith("author-1"));
    expect(follow).not.toHaveBeenCalled();
  });

  it("localizes English stats while preserving author data", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    vi.spyOn(api, "getCommunityAuthorProfile").mockResolvedValue({
      profile: { userId: "author-1", nickname: "中文笔名", avatarUrl: null, isOfficial: false, bio: "中文简介", articleCount: 1, followerCount: 2 },
    });
    vi.spyOn(api, "listCommunityArticlesByAuthor").mockResolvedValue({
      items: [{
        id: "article-1",
        kind: "article",
        author: { id: "author-1", nickname: "中文笔名", avatarUrl: null, isOfficial: false },
        title: "中文文章",
        excerpt: "中文摘要",
        section: "tools",
        tags: [],
        isFeatured: false,
        feedbackStatus: null,
        commentsEnabled: true,
        likeCount: 1234,
        commentCount: 5678,
        bookmarkCount: 0,
        publishedAt: "2026-07-10T00:00:00Z",
      }],
      nextCursor: null,
    });
    window.history.replaceState({}, "", "/community/author/author-1");
    render(<AppProviders><Routes>
      <Route path="/community/author/:userId" element={<AuthorProfilePage user={null} onSignedOut={vi.fn()} />} />
    </Routes></AppProviders>);

    expect(await screen.findByRole("heading", { name: "中文笔名" })).toBeInTheDocument();
    expect(screen.getByText("中文简介")).toBeInTheDocument();
    expect(screen.getByText("Articles 1")).toBeInTheDocument();
    expect(screen.getByText("Followers 2")).toBeInTheDocument();
    expect(screen.getByText("👍 1,234")).toBeInTheDocument();
    expect(screen.getByText("💬 5,678")).toBeInTheDocument();
  });
});
