import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { AuthenticatedApp } from "../app/AuthenticatedApp";
import { i18n } from "../i18n/config";
import type { ChatSession, SessionMessage } from "../types";
import { COMPACT_QUERY, MOBILE_QUERY } from "../workbench/useViewportMode";

vi.mock("../editor/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="文档源码" />,
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(api, "listProjects").mockResolvedValue([
    { id: "project-1", title: "长夜临渊", genre: "玄幻", creative_language: "zh-CN" },
  ]);
  vi.spyOn(api, "listDocuments").mockResolvedValue([]);
  vi.spyOn(api, "listSessions").mockResolvedValue({
    items: [session()], nextCursor: null, activeSessionId: "session-1",
  });
  vi.spyOn(api, "listSessionMessages").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, "openSession").mockResolvedValue(session());
  vi.spyOn(api, "createSession").mockResolvedValue(session());
  vi.spyOn(api, "listModels").mockResolvedValue([
    { id: "opencode:glm-5", name: "GLM 5", provider: "opencode", model: "glm-5", inputRate: 70000, outputRate: 224000 },
    { id: "opencode:kimi-k2.6", name: "Kimi K2.6", provider: "opencode", model: "kimi-k2.6" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1", projectId: "project-1", title: "人物讨论", isProcessing: false,
    memoryStatus: "healthy", messageCount: 0, lastMessageAt: "2026-06-29T08:00:00.000Z",
    createdAt: "2026-06-28T08:00:00.000Z", ...patch,
  };
}

function renderRail(path = "/projects/project-1/overview", messages: SessionMessage[] = []) {
  vi.mocked(api.listSessionMessages).mockResolvedValue({ items: messages, nextCursor: null });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[path]}>
          <AuthenticatedApp
            user={{ id: "user-1", email: "u@example.com" }}
            onSignedOut={vi.fn()}
          />
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

describe("AiAssistantRail", () => {
  it("stays a permanent base surface on phones and still focuses the composer", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      addEventListener: vi.fn(),
      matches: query === MOBILE_QUERY || query === COMPACT_QUERY,
      media: query,
      removeEventListener: vi.fn(),
    })));
    renderRail();

    const assistant = await screen.findByRole("complementary", { name: "AI 总编" });
    expect(assistant).toHaveAttribute("data-presentation", "fullscreen");
    expect(within(assistant).queryByRole("separator")).not.toBeInTheDocument();
    expect(within(assistant).queryByRole("button", { name: "扩展 AI 总编" })).not.toBeInTheDocument();
    expect(within(assistant).queryByRole("button", { name: "关闭 AI 总编" })).not.toBeInTheDocument();
    const composer = await within(assistant).findByRole("textbox", { name: "给 AI 总编的消息" });
    await waitFor(() => expect(composer).toHaveFocus());
  });

  it("renders the wide-viewport presentation without legacy rail controls", async () => {
    renderRail();

    const assistant = await screen.findByRole("complementary", { name: "AI 总编" });
    expect(assistant).toHaveAttribute("data-presentation", "primary");
    expect(within(assistant).queryByRole("separator", { name: "调整 AI 总编宽度" })).not.toBeInTheDocument();
    expect(within(assistant).queryByRole("button", { name: "扩展 AI 总编" })).not.toBeInTheDocument();
  });

  it("uses the localized assistant identity as its fixed header", async () => {
    await i18n.changeLanguage("en");
    const defaultSession = session({
      title: "新会话",
      titleIsCustom: false,
      messageCount: 0,
    });
    vi.mocked(api.listSessions).mockResolvedValue({
      items: [defaultSession], nextCursor: null, activeSessionId: defaultSession.id,
    });
    vi.mocked(api.openSession).mockResolvedValue(defaultSession);
    renderRail();

    // Session titles live in the sessions rail now; the chat column keeps a
    // fixed, localized identity.
    const assistant = await screen.findByRole("complementary", { name: "AI Chief Editor" });
    expect(within(assistant).getByText("AI Chief Editor")).toBeInTheDocument();
    expect(within(assistant).queryByText("New session")).not.toBeInTheDocument();
  });

  it("keeps the conversation title out of the chat header", async () => {
    const customSession = session({ title: "人物讨论", titleIsCustom: true });
    vi.mocked(api.listSessions).mockResolvedValue({
      items: [customSession], nextCursor: null, activeSessionId: customSession.id,
    });
    vi.mocked(api.openSession).mockResolvedValue(customSession);
    renderRail();

    const assistant = await screen.findByRole("complementary", { name: "AI 总编" });
    expect(within(assistant).getByText("AI 总编")).toBeInTheDocument();
    expect(within(assistant).queryByText("人物讨论")).not.toBeInTheDocument();
  });

  it("keeps project chat available after workspace-module navigation", async () => {
    const user = userEvent.setup();
    renderRail("/projects/project-1/chapters");

    const input = await screen.findByRole("textbox", { name: "给 AI 总编的消息" });
    expect(screen.getByRole("complementary", { name: "AI 总编" })).toHaveAttribute("data-testid", "assistant-slot");
    expect(screen.getByRole("complementary", { name: "AI 总编" })).toHaveAttribute("data-motion", "rail-transition");
    expect(input).toBeEnabled();

    // Module switcher now lives in the panel tab strip; switching modules
    // must not remount the chat column or its composer state.
    await user.click(await screen.findByRole("button", { name: "角色档案", hidden: true }));

    expect(screen.getByRole("textbox", { name: "给 AI 总编的消息" })).toBe(input);
  });

  it("shows and sends the active document path without its content", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listDocuments").mockResolvedValue([{
      project_id: "project-1",
      doc_path: "text/chapter-001.md",
      doc_type: "chapter-text",
      name: "第一章",
    }]);
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 不应发送的本地正文",
      hash: "hash-1",
      path: "text/chapter-001.md",
    });
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderRail("/projects/project-1/chapters?document=text%2Fchapter-001.md");

    expect((await screen.findAllByText("text/chapter-001.md")).length).toBeGreaterThan(0);
    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "继续讨论");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        message: "继续讨论",
        activeDocumentPath: "text/chapter-001.md",
        sessionId: "session-1",
      }),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(window.localStorage.getItem("novel-vibe:chat-session:project-1")).toBeNull();
    expect(JSON.stringify(stream.mock.calls[0]?.[0])).not.toContain("不应发送的本地正文");
  });

  it("shows degraded project memory without exposing internal events", async () => {
    vi.mocked(api.listSessions).mockResolvedValue({
      items: [session({ memoryStatus: "degraded" })], nextCursor: null, activeSessionId: "session-1",
    });
    renderRail();

    expect(await screen.findByText("项目记忆暂不可用")).toBeInTheDocument();
  });

  it("offers retry for an interrupted persisted reply", async () => {
    const user = userEvent.setup();
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderRail("/projects/project-1/overview", [{
      id: "user-1", turnId: "turn-1", role: "user", text: "继续人物线",
      status: "complete", createdAt: "2026-06-29T08:00:00.000Z",
    }, {
      id: "assistant-1", turnId: "turn-1", role: "assistant", text: "连接中断",
      status: "interrupted", createdAt: "2026-06-29T08:00:01.000Z",
    }]);

    await user.click(await screen.findByRole("button", { name: "重试：继续人物线" }));
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      message: "继续人物线",
      sessionId: "session-1",
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("passes the selected model to the chat stream and persists it", async () => {
    const user = userEvent.setup();
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderRail();

    await user.click(await screen.findByRole("button", { name: "选择 AI 模型" }));
    await user.click(await screen.findByRole("option", { name: "GLM 5" }));

    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: "opencode",
      model: "glm-5",
      sessionId: "session-1",
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(window.localStorage.getItem("novel-vibe:assistant-model")).toBe("opencode:glm-5");
  });
});
