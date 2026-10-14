import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentToolbar, type DocumentToolbarProps } from "./DocumentToolbar";

afterEach(cleanup);

const props: DocumentToolbarProps = {
  canDelete: true,
  canExport: true,
  canSave: true,
  exportAllowed: true,
  exporting: false,
  loading: false,
  mobile: false,
  onDelete: vi.fn(),
  onExport: vi.fn(),
  onRefresh: vi.fn(),
  onSave: vi.fn(),
  onViewModeChange: vi.fn(),
  saveLabel: "未保存",
  saveState: "unsaved",
  viewMode: "preview",
};

function renderToolbar(overrides: Partial<DocumentToolbarProps> = {}) {
  return render(<Tooltip.Provider><DocumentToolbar {...props} {...overrides} /></Tooltip.Provider>);
}

describe("DocumentToolbar", () => {
  it("keeps all document commands direct on desktop", () => {
    renderToolbar();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("keeps save direct and moves secondary commands into More on mobile", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    renderToolbar({ mobile: true, onRefresh });

    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多文档操作" }));
    expect(screen.getByRole("menuitem", { name: "Markdown (.md)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "纯文本 (.txt)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Word (.docx)" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
