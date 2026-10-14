import { QueryClient, QueryClientProvider, useQuery, type InfiniteData } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { api, ChatStreamInterruptedError } from "../api/client";
import { i18n } from "../i18n/config";
import { sessionMessagesQueryKey } from "../session/useProjectSessions";
import type { ChatSession, CursorPage, Project, SessionMessage } from "../types";
import { ChatPanel } from "./ChatPanel";

afterEach(cleanup);

const project: Project = { id: "project-1", title: "长夜临渊", creative_language: "zh-CN" };
const session: ChatSession = {
  id: "session-1",
  projectId: project.id,
  title: "人物讨论",
  isProcessing: false,
  memoryStatus: "healthy",
  messageCount: 0,
  lastMessageAt: "2026-06-30T00:00:00.000Z",
  createdAt: "2026-06-30T00:00:00.000Z",
};

type MessagePages = InfiniteData<CursorPage<SessionMessage>, string>;

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}{location.search}</output>;
}

function Harness() {
  const query = useQuery<MessagePages>({
    queryKey: sessionMessagesQueryKey(session.id),
    queryFn: async () => ({ pages: [{ items: [], nextCursor: null }], pageParams: [""] }),
    enabled: false,
    initialData: { pages: [{ items: [], nextCursor: null }], pageParams: [""] },
  });
  const messages = [...query.data.pages].reverse().flatMap((page) => page.items);
  return (
    <ChatPanel
      activeDocumentPath={null}
      currentSession={session}
      hasOlderMessages={false}
      loadingOlderMessages={false}
      messages={messages}
      onLoadOlderMessages={vi.fn()}
      project={project}
    />
  );
}

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<MemoryRouter><QueryClientProvider client={client}><Harness /><LocationProbe /></QueryClientProvider></MemoryRouter>) };
}

describe("ChatPanel trace integration", () => {
  it("localizes assistant chrome without translating messages or tool content", async () => {
    await i18n.changeLanguage("en");
    const client = new QueryClient();
    const messages: SessionMessage[] = [{
      id: "user-1",
      turnId: "turn-1",
      role: "user",
      text: "请保留这一句",
      status: "complete",
      createdAt: "2026-07-01T00:00:00.000Z",
    }, {
      id: "assistant-1",
      turnId: "turn-1",
      role: "assistant",
      text: "处理完成",
      status: "complete",
      createdAt: "2026-07-01T00:00:01.000Z",
      trace: {
        version: 1,
        status: "succeeded",
        steps: [{
          type: "tool",
          id: "tool:read-1",
          agentId: "chief_editor",
          toolName: "read_doc",
          args: { path: "characters/主角.md" },
          result: "已读取 characters/主角.md",
          status: "succeeded",
        }],
      },
    }];

    render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={messages} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);

    expect(screen.getByPlaceholderText("Message the Chief Editor")).toBeInTheDocument();
    expect(screen.getByText("请保留这一句")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Expand Agent activity" }));
    expect(screen.getByText("已读取 characters/主角.md")).toBeInTheDocument();
    expect(screen.getByText("处理完成")).toBeInTheDocument();
  });

  it("renders conversation entries visibly", () => {
    const client = new QueryClient();
    const message: SessionMessage = {
      id: "reply-1", turnId: "turn-1", role: "assistant", text: "慢慢写。", status: "complete", createdAt: "2026-07-01T00:00:00.000Z",
    };
    render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={[message]} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);

    expect(screen.getByText("慢慢写。")).toBeVisible();
  });

  it("renders a historical interaction under its assistant message and submits a typed response", async () => {
    await i18n.changeLanguage("zh-CN");
    const user = userEvent.setup();
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: "turn-2", assistantMessageId: "reply-2" });
    const client = new QueryClient();
    const message: SessionMessage = {
      id: "reply-1", turnId: "turn-1", role: "assistant", text: "请选择下一步。", status: "complete", createdAt: "2026-07-01T00:00:00.000Z",
      interactions: [{
        id: "interaction-1", assistantMessageId: "reply-1", status: "pending",
        request: {
          schemaVersion: 1, id: "interaction-1", title: "选择基调",
          fields: [{ id: "tone", type: "radio", label: "基调", required: true, options: [{ value: "warm", label: "温暖" }] }],
          references: [], allowFreeAnswer: true,
        },
      }],
    };
    render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={[message]} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);
    await user.click(screen.getByRole("radio", { name: "温暖" }));
    await user.type(screen.getByRole("textbox", { name: "补充回答（可选）" }), "少一点煽情");
    await user.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      interactionResponse: expect.objectContaining({ interactionId: "interaction-1", freeAnswer: "少一点煽情" }),
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("pins the latest durable run plan immediately before the composer", () => {
    const client = new QueryClient();
    const message: SessionMessage = {
      id: "reply-1", turnId: "turn-1", role: "assistant", text: "正在处理。", status: "complete", createdAt: "2026-07-01T00:00:00.000Z",
      trace: { version: 1, status: "succeeded", steps: [{ type: "run_plan", id: "run-plan:p1", plan: {
        schemaVersion: 1, id: "p1", title: "起草本章", items: [{ id: "draft", title: "起草场景", status: "in_progress" }],
      } }] },
    };
    const { container } = render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={[message]} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);
    const plan = screen.getByRole("region", { name: "起草本章" });
    const composer = container.querySelector(".assistant-composer")!;
    expect(plan.compareDocumentPosition(composer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("discovers and sends the official skill creator command", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderHarness();
    const composer = screen.getByRole("textbox", { name: "给 AI 总编的消息" });
    await user.type(composer, "/");
    expect(screen.getByRole("listbox", { name: "可用命令" })).toHaveAttribute("data-motion", "drawer-reveal");
    expect(screen.getByRole("option", { name: "/skill-creator 创建一个新的 Skill" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "/skill-creator 创建一个新的 Skill" }));
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      command: "skill-creator", message: "",
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("discovers and sends the official /lingqi command", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderHarness();
    const composer = screen.getByRole("textbox", { name: "给 AI 总编的消息" });
    await user.type(composer, "/lin");
    expect(screen.getByRole("option", { name: "/lingqi 查看或编辑 LINGQI 创作指南" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "/lingqi 查看或编辑 LINGQI 创作指南" }));
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      command: "lingqi", message: "",
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("forwards /lingqi <args> as the message payload for the command", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockResolvedValue({ turnId: null, assistantMessageId: null });
    renderHarness();
    const composer = screen.getByRole("textbox", { name: "给 AI 总编的消息" });
    // Typing the command inline with an argument — no menu selection.
    await user.type(composer, "/lingqi 按主流仙侠爽文风格创建");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledWith(expect.objectContaining({
      command: "lingqi", message: "按主流仙侠爽文风格创建",
    }), expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("stops the active server turn before aborting the local stream", async () => {
    await i18n.changeLanguage("zh-CN");
    const user = userEvent.setup();
    let streamSignal: AbortSignal | undefined;
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, _onEvent, options) => {
      streamSignal = options?.signal;
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      throw new Error("unreachable");
    });
    vi.spyOn(api, "interruptSession").mockResolvedValue({ interrupted: true });
    renderHarness();

    const composer = screen.getByRole("textbox", { name: "给 AI 总编的消息" });
    await user.type(composer, "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await user.click(await screen.findByRole("button", { name: "停止生成" }));

    await waitFor(() => expect(api.interruptSession).toHaveBeenCalledWith("session-1"));
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    expect(await screen.findByText("已停止生成")).toBeVisible();
    await waitFor(() => expect(composer).toBeEnabled());
  });

  it("keeps streaming when the server cannot confirm interruption", async () => {
    await i18n.changeLanguage("zh-CN");
    const user = userEvent.setup();
    let streamSignal: AbortSignal | undefined;
    let finishStream!: () => void;
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, _onEvent, options) => {
      streamSignal = options?.signal;
      await new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      return { turnId: null, assistantMessageId: null };
    });
    vi.spyOn(api, "interruptSession").mockRejectedValue(new Error("停止失败"));
    renderHarness();

    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await user.click(await screen.findByRole("button", { name: "停止生成" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("停止失败");
    expect(streamSignal?.aborted).toBe(false);
    finishStream();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeEnabled());
  });

  it("can stop a server turn that was already running when the panel mounted", async () => {
    await i18n.changeLanguage("zh-CN");
    const user = userEvent.setup();
    vi.spyOn(api, "interruptSession").mockResolvedValue({ interrupted: true });
    const client = new QueryClient();
    render(
      <MemoryRouter><QueryClientProvider client={client}>
        <ChatPanel
          activeDocumentPath={null}
          currentSession={{ ...session, isProcessing: true, processingStartedAt: new Date().toISOString() }}
          hasOlderMessages={false}
          loadingOlderMessages={false}
          messages={[]}
          onLoadOlderMessages={vi.fn()}
          project={project}
        />
      </QueryClientProvider></MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "停止生成" }));

    await waitFor(() => expect(api.interruptSession).toHaveBeenCalledWith("session-1"));
  });

  it("keeps the canonical answer separate from a collapsible trace", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, onEvent) => {
      onEvent({ version: 1, runId: "run-1", seq: 1, timestamp: 1, type: "run_started" });
      onEvent({ version: 1, runId: "run-1", seq: 2, timestamp: 2, type: "thinking_delta", agentId: "writer", parentToolCallId: "delegate-1", blockId: "writer:0:0", delta: "构思章节" });
      onEvent({ version: 1, runId: "run-1", seq: 3, timestamp: 3, type: "answer_delta", agentId: "chief_editor", delta: "章节" });
      onEvent({ version: 1, runId: "run-1", seq: 4, timestamp: 4, type: "answer_finished", text: "章节已完成" });
      onEvent({ version: 1, runId: "run-1", seq: 5, timestamp: 5, type: "run_finished", durationMs: 4 });
      return { turnId: null, assistantMessageId: null };
    });
    renderHarness();

    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "写第一章");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("章节已完成")).toBeVisible();
    expect(screen.queryByText("章节章节已完成")).not.toBeInTheDocument();
    const disclosure = await screen.findByRole("button", { name: "展开 Agent 运行详情" });
    fireEvent.click(disclosure);
    expect(screen.getByText("构思章节")).toBeVisible();
  });

  it("marks premature stream closure and re-enables the composer", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, onEvent) => {
      onEvent({ version: 1, runId: "run-1", seq: 1, timestamp: 1, type: "run_started" });
      throw new ChatStreamInterruptedError();
    });
    renderHarness();

    const composer = screen.getByRole("textbox", { name: "给 AI 总编的消息" });
    await user.type(composer, "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText("连接中断")).toBeVisible();
    expect(screen.queryByText("Chat stream ended before a terminal event")).not.toBeInTheDocument();
    await waitFor(() => expect(composer).toBeEnabled());
  });

  it("rebinds a live trace when persisted messages replace optimistic identifiers", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, onEvent) => {
      onEvent({ version: 1, runId: "run-1", seq: 1, timestamp: 1, type: "run_started" });
      onEvent({ version: 1, runId: "run-1", seq: 2, timestamp: 2, type: "thinking_finished", agentId: "writer", blockId: "b1", text: "持久构思" });
      onEvent({ version: 1, runId: "run-1", seq: 3, timestamp: 3, type: "run_finished", durationMs: 2 });
      return { turnId: "turn-server", assistantMessageId: "reply-server" };
    });
    const { client } = renderHarness();
    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "继续");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 AI 总编的消息" })).toBeEnabled());

    client.setQueryData<MessagePages>(sessionMessagesQueryKey(session.id), {
      pages: [{ items: [{ id: "reply-server", turnId: "turn-server", role: "assistant", text: "完成", status: "complete", createdAt: "2026-07-01T00:00:00.000Z" }], nextCursor: null }],
      pageParams: [""],
    });

    await screen.findByText("完成");
    await user.click(await screen.findByRole("button", { name: "展开 Agent 运行详情" }));
    expect(screen.getByText("持久构思")).toBeVisible();
  });

  it("shows one change card for a live document event and navigates to its version", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "streamChat").mockImplementation(async (_input, onEvent) => {
      onEvent({ version: 1, runId: "run-change", seq: 1, timestamp: 1, type: "run_started" });
      onEvent({
        version: 1, runId: "run-change", seq: 2, timestamp: 2, type: "document_changed",
        agentId: "writer", toolCallId: "write-1", versionId: "version-live", path: "text/ch-001.md",
        versionNo: 4, addedLines: 8, deletedLines: 3, changedSections: ["雨夜"],
      });
      onEvent({ version: 1, runId: "run-change", seq: 3, timestamp: 3, type: "run_finished", durationMs: 2 });
      return { turnId: null, assistantMessageId: null };
    });
    renderHarness();

    await user.type(screen.getByRole("textbox", { name: "给 AI 总编的消息" }), "修改章节");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByText("1 篇文档已修改")).toBeVisible();
    expect(screen.getAllByRole("region", { name: "文档修改" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "在文档中查看 text/ch-001.md 第 4 版" }));
    expect(screen.getByLabelText("location")).toHaveTextContent("/projects/project-1/chapters?document=text%2Fch-001.md&version=version-live");
  });

  it("restores a persisted trace after remounting", async () => {
    const persisted = {
      id: "reply-server", turnId: "turn-server", role: "assistant" as const, text: "完成", status: "complete" as const,
      createdAt: "2026-07-01T00:00:00.000Z",
      trace: { version: 1 as const, runId: "run-1", status: "succeeded" as const, durationMs: 20, truncated: true, steps: [
        { type: "thinking" as const, id: "thinking:b1", agentId: "writer" as const, summary: "刷新后构思摘要", status: "finished" as const, truncated: true },
        { type: "tool" as const, id: "tool:t1", agentId: "writer" as const, toolName: "write_doc", args: { path: "chapter.md" }, result: { ok: true }, status: "succeeded" as const },
      ] },
    };
    const client = new QueryClient();
    const userMessage = { id: "user-server", turnId: "turn-server", role: "user" as const, text: "继续写", status: "complete" as const, createdAt: "2026-07-01T00:00:00.000Z" };
    render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={[userMessage, persisted] as any} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);

    expect(screen.getByText("总编")).toBeInTheDocument();
    expect(screen.getByText("你")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开 Agent 运行详情" }));
    expect(screen.getByText("刷新后构思摘要")).toBeVisible();
    expect(screen.getByText("写入 · chapter.md")).toBeVisible();
    expect(screen.getByText(/参数/)).toBeVisible();
    expect(screen.getByText("结果")).toBeVisible();
    expect(screen.getByText("部分执行详情已截断")).toBeVisible();
  });

  it("restores a persisted document change card", () => {
    const persisted: SessionMessage = {
      id: "reply-change", turnId: "turn-change", role: "assistant", text: "角色已更新", status: "complete",
      createdAt: "2026-07-01T00:00:00.000Z",
      trace: { version: 1, runId: "run-change", status: "succeeded", steps: [{
        type: "document_change", id: "document:v5", agentId: "character_designer", toolCallId: "write-5",
        versionId: "v5", path: "characters/hero.md", versionNo: 5, addedLines: 6, deletedLines: 1,
        changedSections: ["性格"],
      }] },
    };
    const client = new QueryClient();
    render(<MemoryRouter><QueryClientProvider client={client}><ChatPanel activeDocumentPath={null} currentSession={session} hasOlderMessages={false} loadingOlderMessages={false} messages={[persisted]} onLoadOlderMessages={vi.fn()} project={project} /></QueryClientProvider></MemoryRouter>);

    expect(screen.getByText("1 篇文档已修改")).toBeVisible();
    expect(screen.getByText("characters/hero.md")).toBeVisible();
  });

  it("queues an Enter submission while processing and auto-sends after the run settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    vi.spyOn(api, "streamChat").mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { turnId: "turn-live", assistantMessageId: "reply-live" };
    });
    const user = userEvent.setup();
    renderHarness();
    const composer = await screen.findByRole("textbox", { name: "给 AI 总编的消息" });

    // 第一轮：Enter 直接发送，但被闸门卡住 → 进入 processing
    await user.type(composer, "进行中的一句{Enter}");
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(1));
    expect(composer).toBeEnabled();

    // 生成中再按 Enter → 入队而不是发送
    await user.type(composer, "排队的一句{Enter}");
    expect(window.localStorage.getItem("novel-vibe:queue:" + session.id)).toContain("排队的一句");
    expect(api.streamChat).toHaveBeenCalledTimes(1);

    // 首轮落地 → 队首自动续发 → 队列清空
    await act(async () => { release(); });
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(window.localStorage.getItem("novel-vibe:queue:" + session.id)).toBe("[]"));
  });
});
