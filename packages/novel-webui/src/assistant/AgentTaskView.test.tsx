import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { LocaleProvider } from "../i18n/LocaleProvider";
import type { DelegationTranscriptEntry } from "../types";
import { AgentTaskView } from "./AgentTaskView";

afterEach(cleanup);

const entryCreatedAt = new Date(Date.UTC(2026, 7, 27, 1, 2));

function entry(patch: Partial<DelegationTranscriptEntry> = {}): DelegationTranscriptEntry {
  return {
    id: "e-1",
    sequence: 1,
    role: "assistant",
    blocks: [{ kind: "text", text: "分镜初稿第一段。" }],
    createdAt: entryCreatedAt.toISOString(),
    ...patch,
  };
}

function renderView(props: Partial<Parameters<typeof AgentTaskView>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onBack = vi.fn();
  render(
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <AgentTaskView
            onBack={onBack}
            sessionId={props.sessionId ?? "session-1"}
            {...props}
            target={{
              agentId: props.target?.agentId ?? "writer",
              callId: props.target?.callId ?? "call-d",
              sessionId: "session-1",
              stateSnapshot: props.target?.stateSnapshot,
              summary: props.target?.summary ?? {
                agentId: "writer", durationMs: 4200, isError: false, running: false,
              },
            }}
          />
        </Tooltip.Provider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
  return onBack;
}

describe("AgentTaskView", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
    vi.spyOn(api, "listDelegationMessages").mockResolvedValue({
      items: [
        entry(),
        entry({
          blocks: [{ kind: "tool", text: "write_doc: 已写入章节" }],
          id: "e-2", role: "tool", sequence: 2,
        }),
        entry({
          blocks: [{ kind: "reasoning", text: "先想清楚转折" }, { kind: "text", text: "再说" }],
          id: "e-3", sequence: 3,
        }),
      ],
      nextCursor: null,
    });
    vi.spyOn(api, "listModels").mockResolvedValue([]);
  });

  it("renders the durable transcript with breadcrumb and read-only notice", async () => {
    renderView();
    const expectedTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      .format(entryCreatedAt);

    expect(await screen.findByText("分镜初稿第一段。")).toBeInTheDocument();
    expect(screen.getAllByText("write_doc: 已写入章节")).toHaveLength(1);
    expect(screen.getByText("章节写手")).toBeInTheDocument();
    expect(screen.getByText("子代理任务为只读回放；需要调整请回到总编对话中说明。")).toBeInTheDocument();
    expect(screen.getAllByText(expectedTime).length).toBe(3);
  });

  it("returns to the conversation through the breadcrumb control", async () => {
    const user = userEvent.setup();
    const onBack = renderView();

    await screen.findByText("分镜初稿第一段。");
    await user.click(screen.getByRole("button", { name: /返回对话/ }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("falls back to the pending copy while a live run has no rows yet", async () => {
    vi.mocked(api.listDelegationMessages).mockResolvedValue({ items: [], nextCursor: null });
    renderView({
      target: {
        agentId: "director",
        callId: "call-live",
        sessionId: "session-1",
        summary: { agentId: "director", isError: false, running: true },
      },
    });

    expect(await screen.findByText("任务运行中，记录将随进度出现。")).toBeInTheDocument();
    expect(screen.getByText("章节导演")).toBeInTheDocument();
  });

  it("flags transcripts that extend beyond the loaded page", async () => {
    vi.mocked(api.listDelegationMessages).mockResolvedValue({ items: [entry()], nextCursor: "cursor-older" });
    renderView();

    expect(await screen.findByText("分镜初稿第一段。")).toBeInTheDocument();
    expect(screen.getByText("记录较多，仅展示最近部分。")).toBeInTheDocument();
  });
});
