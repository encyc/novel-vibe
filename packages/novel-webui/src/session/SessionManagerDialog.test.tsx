import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../types";
import { SessionManagerDialog } from "./SessionManagerDialog";

afterEach(cleanup);

function session(id: string, isProcessing = false): ChatSession {
  return {
    id,
    projectId: "project-1",
    title: id === "busy" ? "正在生成" : "人物讨论",
    isProcessing,
    memoryStatus: "healthy",
    messageCount: 3,
    lastMessageAt: "2026-06-29T08:00:00.000Z",
    createdAt: "2026-06-28T08:00:00.000Z",
  };
}

describe("SessionManagerDialog", () => {
  it("debounces search and selects without changing document routes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSearch = vi.fn();
    const onSelect = vi.fn();
    render(<SessionManagerDialog
      currentSessionId="session-1"
      hasMore={false}
      loading={false}
      onCreate={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      onLoadMore={vi.fn()}
      onOpenChange={onOpenChange}
      onRename={vi.fn()}
      onRestore={vi.fn()}
      onSearch={onSearch}
      onSelect={onSelect}
      open
      sessions={[session("session-1")]}
      status="active"
      onStatusChange={vi.fn()}
    />);

    await user.type(screen.getByRole("searchbox", { name: "搜索总编会话" }), "人物");
    await waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("人物"));
    await user.click(screen.getByRole("button", { name: "选择会话：人物讨论" }));
    expect(onSelect).toHaveBeenCalledWith("session-1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renames sessions and confirms deletion while protecting processing sessions", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onRename = vi.fn();
    render(<SessionManagerDialog
      currentSessionId="normal"
      hasMore={false}
      loading={false}
      onCreate={vi.fn()}
      onArchive={vi.fn()}
      onDelete={onDelete}
      onLoadMore={vi.fn()}
      onOpenChange={vi.fn()}
      onRename={onRename}
      onRestore={vi.fn()}
      onSearch={vi.fn()}
      onSelect={vi.fn()}
      open
      sessions={[session("normal"), session("busy", true)]}
      status="active"
      onStatusChange={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名" }));
    const title = screen.getByRole("textbox", { name: "会话名称" });
    await user.clear(title);
    await user.type(title, "人物关系线");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    expect(onRename).toHaveBeenCalledWith("normal", "人物关系线");

    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除会话" }));
    expect(onDelete).toHaveBeenCalledWith("normal");

    await user.click(screen.getByRole("button", { name: "会话操作：正在生成" }));
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveAttribute("data-disabled");
  });

  it("switches between active and archived sessions and protects processing lifecycle actions", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    const onStatusChange = vi.fn();
    const archived = { ...session("archived"), lifecycleStatus: "archived" as const };
    const { rerender } = render(<SessionManagerDialog
      currentSessionId={null}
      hasMore={false}
      loading={false}
      onArchive={onArchive}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onLoadMore={vi.fn()}
      onOpenChange={vi.fn()}
      onRename={vi.fn()}
      onRestore={onRestore}
      onSearch={vi.fn()}
      onSelect={vi.fn()}
      onStatusChange={onStatusChange}
      open
      sessions={[session("normal"), session("busy", true)]}
      status="active"
    />);

    await user.click(screen.getByRole("tab", { name: "已归档" }));
    expect(onStatusChange).toHaveBeenCalledWith("archived");

    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    await user.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(onArchive).toHaveBeenCalledWith("normal");

    rerender(<SessionManagerDialog
      currentSessionId={null} hasMore={false} loading={false} onArchive={onArchive}
      onCreate={vi.fn()} onDelete={vi.fn()} onLoadMore={vi.fn()} onOpenChange={vi.fn()}
      onRename={vi.fn()} onRestore={onRestore} onSearch={vi.fn()} onSelect={vi.fn()}
      onStatusChange={onStatusChange} open sessions={[archived]} status="archived"
    />);
    await user.click(screen.getByRole("button", { name: "会话操作：人物讨论" }));
    await user.click(screen.getByRole("menuitem", { name: "恢复" }));
    expect(onRestore).toHaveBeenCalledWith("archived");
    expect(screen.queryByRole("button", { name: "新建会话" })).not.toBeInTheDocument();
  });
});
