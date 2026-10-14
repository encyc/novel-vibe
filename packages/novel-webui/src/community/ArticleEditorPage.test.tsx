import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { AppProviders } from "../app/AppProviders";
import { i18n } from "../i18n/config";
import { ArticleEditorPage } from "./ArticleEditorPage";

vi.mock("../api/client", () => ({
  api: {
    createCommunityArticle: vi.fn(),
    updateCommunityArticle: vi.fn(),
    publishCommunityArticle: vi.fn(),
    getCommunityArticle: vi.fn(),
  },
  ApiError: class extends Error {
    public readonly code: string | null;
    public readonly details: unknown;
    constructor(public readonly status: number, public readonly data: unknown) {
      const record = data && typeof data === "object" ? data as Record<string, unknown> : null;
      super(typeof record?.error === "string" ? record.error : `Request failed with ${status}`);
      this.name = "ApiError";
      this.code = typeof record?.error === "string" ? record.error : null;
      this.details = record?.details;
    }
  },
}));

vi.mock("../editor/MarkdownEditor", () => ({
  MarkdownEditor: ({ onChange, value }: { onChange(value: string): void; value: string }) => (
    <textarea aria-label="正文" onChange={(e) => onChange(e.target.value)} value={value} />
  ),
}));

afterEach(cleanup);

describe("ArticleEditorPage content types", () => {
  it("separates body editing from publishing settings", () => {
    render(<AppProviders>
      <ArticleEditorPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />
    </AppProviders>);

    expect(screen.getByRole("region", { name: "正文编辑" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "发布设置" })).toBeInTheDocument();
  });

  it("lets regular users choose articles, bugs, and feature requests", () => {
    render(<AppProviders>
      <ArticleEditorPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />
    </AppProviders>);

    const select = screen.getByLabelText("内容类型");
    expect(select).toHaveTextContent("文章");
    expect(select).toHaveTextContent("Bug 提交");
    expect(select).toHaveTextContent("功能请求");
    expect(select).not.toHaveTextContent("官方公告");
  });

  it("allows community admins to choose official announcements", () => {
    render(<AppProviders>
      <ArticleEditorPage user={{ id: "admin", email: "a@example.com", isCommunityAdmin: true }} onSignedOut={vi.fn()} />
    </AppProviders>);

    expect(screen.getByLabelText("内容类型")).toHaveTextContent("官方公告");
  });

  it("localizes English editor chrome without changing typed content", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    await i18n.changeLanguage("en");
    render(<AppProviders>
      <ArticleEditorPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />
    </AppProviders>);

    const title = screen.getByPlaceholderText("Article title");
    await userEvent.type(title, "中文标题");
    await userEvent.type(screen.getByLabelText("正文"), "中文正文");
    expect(title).toHaveValue("中文标题");
    expect(screen.getByLabelText("正文")).toHaveValue("中文正文");
    expect(screen.getByLabelText("Content type")).toHaveValue("article");
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});

describe("ArticleEditorPage error handling", () => {
  function renderEditor() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ArticleEditorPage user={{ id: "u1", email: "u@example.com" }} onSignedOut={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("shows the nickname-required error with a link to the profile page", async () => {
    vi.mocked(api.createCommunityArticle).mockRejectedValueOnce(
      new ApiError(400, { error: "NICKNAME_REQUIRED", message: "请先设置昵称后再发布内容" }),
    );

    renderEditor();

    await userEvent.type(screen.getByPlaceholderText("文章标题"), "测试标题");
    await userEvent.type(screen.getByLabelText("正文"), "测试正文");
    await userEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("继续前请先设置昵称");
    expect(screen.getByRole("alert")).not.toHaveTextContent("请先设置昵称后再发布内容");
    expect(screen.getByRole("link", { name: /设置昵称/ }))
      .toHaveAttribute("href", `${window.location.origin}/profile`);
  });
});
