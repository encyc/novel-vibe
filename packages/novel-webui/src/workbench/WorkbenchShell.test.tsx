import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { AuthenticatedApp } from "../app/AuthenticatedApp";
import { i18n } from "../i18n/config";
import type { ChatSession, DocumentIndex, Project, SessionMessage } from "../types";
import { COMPACT_QUERY, MOBILE_QUERY } from "./useViewportMode";

afterEach(cleanup);

const currentSession: ChatSession = {
  id: "session-1", projectId: "project-1", title: "人物讨论", isProcessing: false,
  memoryStatus: "healthy", messageCount: 2, lastMessageAt: "2026-06-29T08:00:00.000Z",
  createdAt: "2026-06-28T08:00:00.000Z",
};

function renderWorkbench(
  path = "/projects/project-1/overview",
  onSignedOut = vi.fn(),
  sessions: ChatSession[] = [currentSession],
  messages: SessionMessage[] = [],
  project: Project = { id: "project-1", title: "长夜临渊", genre: "玄幻", synopsis: "一座失去城主的北境孤城", lifecycle_status: "active", creative_language: "zh-CN" },
  documents: DocumentIndex[] = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listProjects").mockResolvedValue([
    project,
  ]);
  vi.spyOn(api, "listDocuments").mockResolvedValue(documents);
  vi.spyOn(api, "listSessions").mockResolvedValue({ items: sessions, nextCursor: null, activeSessionId: sessions[0]?.id ?? null });
  vi.spyOn(api, "listSessionMessages").mockResolvedValue({ items: messages, nextCursor: null });
  vi.spyOn(api, "openSession").mockImplementation(async (sessionId) => sessions.find((item) => item.id === sessionId)!);
  vi.spyOn(api, "createSession").mockResolvedValue(currentSession);
  vi.spyOn(api, "renameSession").mockResolvedValue(currentSession);
  vi.spyOn(api, "deleteSession").mockResolvedValue();
  vi.spyOn(api, "listModels").mockResolvedValue([]);

  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[path]}>
          <AuthenticatedApp
            user={{ id: "user-1", email: "u@example.com" }}
            onSignedOut={onSignedOut}
          />
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

describe("WorkbenchShell", () => {
  // Desktop chrome now has both a header toggle and gutter handles for the
  // same panels; scope queries to the region each test means to exercise.
  const headerButton = (name: string) =>
    within(document.querySelector(".assistant-header") as HTMLElement).getByRole("button", { name });
  const sidebarGutterButton = (name: string) =>
    within(document.querySelector('.app-frame-gutter[data-for="sidebar"]') as HTMLElement).getByRole("button", { name });

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the conversation as the inert-shielded base under compact overlays", async () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === COMPACT_QUERY,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    })));
    const user = userEvent.setup();
    renderWorkbench();

    await screen.findByRole("textbox", { name: "给 AI 总编的消息" });
    const assistant = screen.getByLabelText("AI 总编");
    expect(assistant).toBeInTheDocument();
    expect(assistant).toHaveAttribute("data-presentation", "primary");

    await user.click(screen.getByRole("button", { name: "展开上下文栏" }));
    expect(screen.getByRole("button", { name: "关闭临时面板" })).toBeInTheDocument();
    expect(assistant).toHaveAttribute("inert");

    // Opening the workspace detail closes the navigation drawer and keeps the
    // base surface shielded while any overlay is up.
    await user.click(screen.getByRole("button", { name: "展开创作区" }));
    expect(screen.getByRole("main")).toHaveAttribute("data-context-collapsed", "true");
    expect(screen.getByRole("main")).toHaveAttribute("data-detail-collapsed", "false");
    expect(assistant).toHaveAttribute("inert");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "关闭临时面板" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-detail-collapsed", "true");
    expect(screen.getByRole("main")).not.toHaveAttribute("data-overlay-open");
  });

  it("lands collapsed on the workspace area and reopens it when content is opened", async () => {
    const user = userEvent.setup();
    const script: DocumentIndex = {
      project_id: "project-1",
      doc_path: "scripts/ch-001.md",
      doc_type: "director-script",
      name: "第一章导演剧本",
      status: "draft",
    };
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 第一章导演剧本",
      hash: "hash-ds",
      path: script.doc_path,
    });
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [], undefined, [script]);

    await screen.findByRole("button", { name: "新建会话" });
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("data-detail-collapsed", "true");

    // The workbench area reveals itself from the header toggle and lands on
    // the preferred module (here: the only populated one, 导演剧本).
    await user.click(headerButton("展开创作区"));
    expect(await screen.findByRole("heading", { name: "导演剧本" })).toBeInTheDocument();
    expect(main).toHaveAttribute("data-detail-collapsed", "false");
    expect(screen.getByRole("button", { name: "导演剧本" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the workspace view tab in the URL", async () => {
    const user = userEvent.setup();
    renderWorkbench("/projects/project-1/chapters");
    await screen.findByRole("heading", { name: "章节正文" });
    expect(screen.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "false");

    // Switching tabs is a URL change (?view=review), not hidden state.
    await user.click(screen.getByRole("button", { name: "审查" }));
    expect(await screen.findByRole("heading", { name: "改动审查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "true");

    // A module switch drops the view param and returns to the manuscript.
    await user.click(screen.getByRole("button", { name: "章节正文" }));
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "false");

    // Deep links boot straight onto the requested view.
    cleanup();
    renderWorkbench("/projects/project-1/chapters?view=review");
    expect(await screen.findByRole("heading", { name: "改动审查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "审查" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the phone header with a session-only navigation sheet on mobile", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === MOBILE_QUERY || query === COMPACT_QUERY,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    renderWorkbench();

    expect(await screen.findByRole("banner", { name: "移动创作工作台" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "创作模块" })).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-viewport", "mobile");

    const navigationTrigger = screen.getByRole("button", { name: "打开导航" });
    await user.click(navigationTrigger);
    const sheet = screen.getByRole("dialog", { name: "会话导航" });
    expect(sheet).toBeInTheDocument();
    // Modules are no longer in the sheet — the sheet is the session list.
    expect(within(sheet).getByRole("button", { name: "选择会话：人物讨论" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "章节正文" })).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "选择会话：人物讨论" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "会话导航" })).not.toBeInTheDocument());
    expect(navigationTrigger).toHaveFocus();
  });

  it("collapses the desktop rail into the 56px icon track via the gutter handle", async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await screen.findByRole("heading", { name: "章节正文" });
    expect(screen.getByRole("complementary", { name: "总编会话" })).toBeInTheDocument();
    expect(screen.getByText("u@example.com")).toBeInTheDocument();

    await user.click(sidebarGutterButton("收起上下文栏"));
    expect(document.querySelector('.session-rail[data-compact="true"]')).not.toBeNull();

    await user.click(sidebarGutterButton("展开上下文栏"));
    expect(document.querySelector('.session-rail[data-compact="true"]')).toBeNull();
    expect(screen.getByText("u@example.com")).toBeInTheDocument();
  });

  it("routes into a populated module when the workspace is opened from the overview", async () => {
    const user = userEvent.setup();
    const chapter: DocumentIndex = {
      project_id: "project-1",
      doc_path: "chapters/001.md",
      doc_type: "chapter-text",
      name: "第一章",
      status: "draft",
    };
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 第一章",
      hash: "hash-1",
      path: chapter.doc_path,
    });
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [], undefined, [chapter]);

    await screen.findByRole("heading", { name: "章节正文" });
    expect(screen.getByRole("main")).toHaveAttribute("data-detail-collapsed", "true");

    // The brief is not a workbench: opening the area jumps straight into real
    // work (first module with documents) instead of stopping at the overview.
    await user.click(headerButton("展开创作区"));
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("data-detail-collapsed", "false");
  });

  it("remembers the last worked module over the populated-module fallback", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("novel-vibe:last-module:project-1", "chapters");
    const documents: DocumentIndex[] = [
      { project_id: "project-1", doc_path: "outline/vol-1.md", doc_type: "volume", name: "卷一", status: "draft" },
      { project_id: "project-1", doc_path: "chapters/001.md", doc_type: "chapter-text", name: "第一章", status: "draft" },
    ];
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 第一章",
      hash: "hash-1",
      path: documents[1].doc_path,
    });
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [], undefined, documents);

    await screen.findByRole("heading", { name: "章节正文" });
    await user.click(headerButton("展开创作区"));

    // The fallback would pick 故事大纲 (config order); memory must win.
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
  });

  it("lands chat-first with the module rail and no overview brief", async () => {
    renderWorkbench();

    await screen.findByRole("button", { name: "新建会话" });
    expect(screen.getByRole("main")).toHaveAttribute("data-motion", "workbench-reveal");
    expect(screen.queryByRole("region", { name: "创作简报" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "项目工作台" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "创作区" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "社区" }))
      .toHaveAttribute("href", `${window.location.origin}/community`);
    // better-sidebar rail: creative modules + review as peers (mounted with the
    // pane, even while it is collapsed).
    expect(document.body.textContent).toContain("审查");
  });

  it("translates workbench chrome without translating document names or changing routes", async () => {
    await i18n.changeLanguage("en");
    const document: DocumentIndex = {
      project_id: "project-1",
      doc_path: "worldview/old-city.md",
      doc_type: "worldview",
      name: "旧城设定",
      status: "draft",
    };
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 旧城设定\n\n城墙仍保留着旧王朝的纹章。",
      hash: "hash-world",
      path: document.doc_path,
    });

    renderWorkbench("/projects/project-1/world", vi.fn(), [currentSession], [], undefined, [document]);

    expect(await screen.findByRole("heading", { name: "World" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "旧城设定" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "World" })).toHaveAttribute("aria-pressed", "true");
  });

  it("exposes project settings and skill management from the rail footer", async () => {
    renderWorkbench();
    await screen.findByRole("heading", { name: "章节正文" });

    expect(screen.getByRole("button", { name: "项目设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skill 管理" })).toBeInTheDocument();
  });

  it("opens the project settings and skills pages from the rail footer", async () => {
    const user = userEvent.setup();
    renderWorkbench("/projects/project-1/chapters", vi.fn(), [currentSession], [], undefined, [
      { project_id: "project-1", doc_path: "chapters/001.md", doc_type: "chapter-text", name: "第一章", status: "draft" },
    ]);
    await screen.findByRole("heading", { name: "章节正文" });

    // Static child routes used to be hijacked by the overview redirect and
    // bounced back to the preferred module.
    await user.click(screen.getByRole("button", { name: "项目设置" }));
    expect(await screen.findByRole("heading", { name: "项目设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "基本信息" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skill 管理" }));
    expect(await screen.findByRole("heading", { name: "Skill 管理" })).toBeInTheDocument();
    // The workbench keeps functioning: heading back to a module still works.
    await user.click(screen.getByRole("button", { name: "章节正文" }));
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
  });

  it("navigates between modules through the page chips without remounting the assistant slot", async () => {
    const user = userEvent.setup();
    renderWorkbench("/projects/project-1/chapters");
    const assistant = await screen.findByTestId("assistant-slot");

    await user.click(await screen.findByRole("button", { name: "导演剧本" }));

    expect(screen.getByRole("heading", { name: "导演剧本" })).toBeInTheDocument();
    expect(screen.getByTestId("assistant-slot")).toBe(assistant);
    expect(screen.getByRole("main")).toHaveAttribute("data-detail-collapsed", "false");
  });

  it("keeps the chapter composer stable across module switches both ways", async () => {
    const user = userEvent.setup();
    renderWorkbench("/projects/project-1/scripts");
    const assistant = await screen.findByTestId("assistant-slot");

    await user.click(await screen.findByRole("button", { name: "章节正文" }));

    expect(screen.getByRole("heading", { name: "章节正文" })).toBeInTheDocument();
    expect(screen.getByTestId("assistant-slot")).toBe(assistant);
  });

  it("opens a rolling story summary in the continuity workspace from the overview", async () => {
    const user = userEvent.setup();
    const storySummary: DocumentIndex = {
      project_id: "project-1",
      doc_path: "summary/story-so-far.md",
      doc_type: "story-summary",
      name: "故事至今",
      status: "draft",
    };
    vi.spyOn(api, "readDocument").mockResolvedValue({
      content: "# 故事至今\n\n陆尘在废墟中醒来。",
      hash: "hash-summary",
      path: storySummary.doc_path,
    });
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [], undefined, [storySummary]);

    await user.click(await screen.findByRole("button", { name: "连续性档案" }));

    expect(await screen.findByRole("banner", { name: "连续性档案工作区" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "故事至今" })).toBeInTheDocument();
  });

  it("signs out through the BFF before clearing the user", async () => {
    const user = userEvent.setup();
    const onSignedOut = vi.fn();
    vi.spyOn(api, "logout").mockResolvedValue();
    renderWorkbench("/projects/project-1/overview", onSignedOut);

    await user.click(await screen.findByRole("button", { name: "退出登录" }));

    expect(api.logout).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("restores persisted session messages without a local storage session id", async () => {
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [{
      id: "message-1", turnId: "turn-1", role: "user", text: "人物动机是什么？",
      status: "complete", createdAt: "2026-06-29T08:00:00.000Z",
    }, {
      id: "message-2", turnId: "turn-1", role: "assistant", text: "核心动机是守城。",
      status: "complete", createdAt: "2026-06-29T08:00:01.000Z",
    }]);

    expect(await screen.findByText("人物动机是什么？")).toBeInTheDocument();
    expect(screen.getByText("核心动机是守城。")).toBeInTheDocument();
    expect(window.localStorage.getItem("novel-vibe:chat-session:project-1")).toBeNull();
  });

  it("switches sessions without changing the document route", async () => {
    const user = userEvent.setup();
    const second = { ...currentSession, id: "session-2", title: "世界观讨论" };
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession, second]);

    await user.click(await screen.findByRole("button", { name: "选择会话：世界观讨论" }));

    expect(api.openSession).toHaveBeenCalledWith("session-2");
    expect(screen.getByRole("heading", { name: "章节正文" })).toBeInTheDocument();
  });

  it("creates exactly one session when a project has none", async () => {
    renderWorkbench("/projects/project-1/overview", vi.fn(), []);

    expect((await screen.findAllByText("人物讨论")).length).toBeGreaterThan(0);
    expect(api.createSession).toHaveBeenCalledOnce();
  });

  it("keeps archived Projects readable while disabling creation and chat", async () => {
    renderWorkbench("/projects/project-1/overview", vi.fn(), [currentSession], [], {
      id: "project-1", title: "封存之书", lifecycle_status: "archived", creative_language: "zh-CN",
    });

    expect(await screen.findByText(/只读模式/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "新建会话" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "新建会话" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeDisabled();
    // 封存之书 only names the project record now — the overview brief is gone.
    expect(await screen.findByRole("heading", { name: "章节正文" })).toBeInTheDocument();
  });
});
