import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTrace } from "./ChatTrace";
import { initialChatTrace, type ChatTraceState } from "./chat-trace";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function runningTrace(): ChatTraceState {
  return {
    ...initialChatTrace("message-1"),
    runId: "run-1",
    status: "running",
    startedAt: 1000,
    order: ["thinking:writer:0:0", "tool:write-1"],
    thinking: {
      "writer:0:0": {
        blockId: "writer:0:0",
        agentId: "writer",
        parentToolCallId: "delegate-1",
        text: "构思章节冲突与转折",
        status: "running",
      },
    },
    tools: {
      "write-1": {
        toolCallId: "write-1",
        toolName: "write_doc",
        agentId: "writer",
        parentToolCallId: "delegate-1",
        args: { path: "text/1.md" },
        status: "running",
      },
    },
  };
}

describe("ChatTrace", () => {
  it("is expanded while running and exposes tool details", () => {
    render(<ChatTrace trace={runningTrace()} />);

    expect(screen.getByLabelText("Agent 运行详情")).toHaveAttribute("aria-live", "off");
    expect(screen.getByText("构思章节冲突与转折")).toBeVisible();
    expect(screen.getByText("写入 · text/1.md")).toBeVisible();
    fireEvent.click(screen.getByText(/参数/));
    // args JSON 全文出现在展开卡里；行内摘要已含路径，故用 getAllBy 断言 ≥1 处
    expect(screen.getAllByText(/text\/1\.md/).length).toBeGreaterThan(0);
  });

  it("starts collapsed after success and opens for failure", () => {
    const success = {
      ...initialChatTrace("m1"),
      status: "succeeded" as const,
      durationMs: 14200,
    };
    const { rerender } = render(<ChatTrace trace={success} />);
    expect(screen.getByRole("button", { name: "展开 Agent 运行详情" }))
      .toHaveAttribute("aria-expanded", "false");

    rerender(<ChatTrace trace={{ ...success, status: "failed", error: "write failed" }} />);
    expect(screen.getByText("write failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "收起 Agent 运行详情" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("updates elapsed time while a run is active", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    render(<ChatTrace trace={runningTrace()} />);
    expect(screen.getByText(/1\.0s/)).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/2\.0s/)).toBeVisible();
  });
});
