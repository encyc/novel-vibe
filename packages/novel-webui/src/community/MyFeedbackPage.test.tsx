import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { MyFeedbackPage } from "./MyFeedbackPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MyFeedbackPage", () => {
  it("lists the current user's bug and feature request statuses", async () => {
    vi.spyOn(api, "listMyCommunityFeedback").mockResolvedValue({
      items: [{
        id: "r1",
        kind: "feature_request",
        author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "支持 EPUB",
        excerpt: null,
        section: "tools",
        tags: [],
        isFeatured: false,
        feedbackStatus: "planned",
        commentsEnabled: true,
        likeCount: 7,
        commentCount: 1,
        bookmarkCount: 0,
        publishedAt: "2026-07-10T00:00:00Z",
      }],
    });

    render(<AppProviders>
      <MyFeedbackPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />
    </AppProviders>);

    expect(await screen.findByText("支持 EPUB")).toBeInTheDocument();
    expect(screen.getByText("已规划")).toBeInTheDocument();
    expect(screen.getByText("投票 7")).toBeInTheDocument();
  });

  it("localizes English feedback status without translating the title", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    vi.spyOn(api, "listMyCommunityFeedback").mockResolvedValue({
      items: [{
        id: "r1", kind: "feature_request", author: { id: "u1", nickname: "Alice", avatarUrl: null, isOfficial: false },
        title: "支持 EPUB", excerpt: null, section: "tools", tags: [], isFeatured: false, feedbackStatus: "planned",
        commentsEnabled: true, likeCount: 7, commentCount: 1, bookmarkCount: 0, publishedAt: "2026-07-10T00:00:00Z",
      }],
    });
    render(<AppProviders><MyFeedbackPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} /></AppProviders>);
    expect(await screen.findByText("支持 EPUB")).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByText("Vote 7")).toBeInTheDocument();
  });
});
