import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ChatSession } from "../types";
import { UnsavedChangesProvider } from "./UnsavedChangesGuard";
import { SessionRail } from "./SessionRail";

function session(patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1", projectId: "project-1", title: "人物讨论", isProcessing: false,
    memoryStatus: "healthy", messageCount: 3, lastMessageAt: "2026-08-20T08:00:00.000Z",
    createdAt: "2026-08-18T08:00:00.000Z", ...patch,
  };
}

const project = { id: "project-1", title: "长夜临渊", genre: "玄幻", lifecycle_status: "active" as const, creative_language: "zh-CN" } as const;
const typedProject: import("../types").Project = { ...project, creative_language: "zh-CN" };

afterEach(cleanup);

describe("SessionRail", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(api, "getCreditSummary").mockResolvedValue({
      balance: 4200, totalGranted: 5000, totalConsumed: 800, level: 2, levelName: "青铜",
    });
  });

  function renderRail(sessions: ChatSession[] = [session()], handlers: Partial<Parameters<typeof SessionRail>[0]> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          <MemoryRouter>
            <UnsavedChangesProvider>
              <SessionRail
                canCreate
                currentSessionId="session-1"
                hasMore={false}
                loading={false}
                onDelete={vi.fn(async () => {})}
                onOpenManager={vi.fn()}
                onCreate={vi.fn(async () => {})}
                onRename={vi.fn(async () => {})}
                onSignedOut={vi.fn()}
                onSelect={vi.fn(async () => {})}
                project={typedProject}
                sessions={sessions}
                user={{ id: "user-1", email: "writer@example.com" }}
                {...handlers}
              />
            </UnsavedChangesProvider>
          </MemoryRouter>
        </Tooltip.Provider>
      </QueryClientProvider>,
    );
  }

  it("lists sessions with credits at the bottom and highlights the current one", async () => {
    renderRail();

    expect(screen.getByRole("button", { name: "选择会话：人物讨论" })).toBeInTheDocument();
    expect(await screen.findByText("积分余额")).toBeInTheDocument();
    expect(screen.getByText("4,200")).toBeInTheDocument();
    expect(screen.getByText("长夜临渊")).toBeInTheDocument();
  });

  it("filters the list locally without server calls", async () => {
    const user = userEvent.setup();
    renderRail([session(), session({ id: "session-2", title: "大纲推演" })]);

    await user.type(screen.getByRole("textbox", { name: "搜索总编会话" }), "大纲");
    expect(screen.queryByRole("button", { name: "选择会话：人物讨论" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "搜索总编会话" }));
    expect(screen.getByRole("button", { name: "选择会话：人物讨论" })).toBeInTheDocument();
  });

  it("renames inline through the row menu instead of window.prompt", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => {});
    renderRail([session()], { onRename });

    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    await user.click(await screen.findByText("重命名"));

    const input = screen.getByRole("textbox", { name: "会话名称" });
    await user.clear(input);
    await user.type(input, "主角动机研讨");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("session-1", "主角动机研讨"));
  });

  it("confirms deletion with an in-rail dialog and guards processing sessions", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    renderRail([session({ isProcessing: true }), session({ id: "session-9", title: "旧稿讨论" })], { onDelete });

    // Processing sessions cannot be deleted.
    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    const guardedDelete = await screen.findByRole("menuitem", { name: "删除" });
    expect(guardedDelete).toHaveAttribute("data-disabled");
    await user.keyboard("{Escape}");

    const staleDelete = await screen.findByRole("button", { name: "会话操作：旧稿讨论" });
    await user.click(staleDelete);
    await user.click(await screen.findByRole("menuitem", { name: "删除" }));
    await user.click(await screen.findByRole("button", { name: "确认删除会话" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("session-9"));
  });
});
