import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { DocumentDiffPage, DocumentVersionSummary } from "../types";
import { DocumentDiffViewer } from "./DocumentDiffViewer";

const version: DocumentVersionSummary = {
  id: "v1", projectId: "p1", path: "text/001.md", versionNo: 1, sourceType: "agent", agentId: "writer",
  beforeHash: "a", afterHash: "b", state: "complete", diffStatus: "ready", addedLines: 1, deletedLines: 1,
  changedSections: ["雨夜"], createdAt: "2026-08-14T10:00:00.000Z", completedAt: "2026-08-14T10:00:01.000Z",
};
const page: DocumentDiffPage = {
  algorithmVersion: "jsdiff-v1", status: "ready", addedLines: 1, deletedLines: 1, changedSections: ["雨夜"],
  frontmatterChanges: [{ key: "status", kind: "changed", before: "draft", after: "confirmed" }], truncated: true,
  nextCursor: "1", items: [
    { index: 0, section: "开场", oldStart: 49, newStart: 49, lines: [
      { kind: "delete", oldLine: 49, newLine: null, text: "雨停了" },
      { kind: "insert", oldLine: null, newLine: 49, text: "身后的雨声" },
    ] },
    { index: 1, section: "转折", oldStart: 70, newStart: 70, lines: [{ kind: "context", oldLine: 70, newLine: 70, text: "他回头。" }] },
    { index: 2, section: "结尾", oldStart: 90, newStart: 90, lines: [{ kind: "insert", oldLine: null, newLine: 90, text: "天亮了" }] },
  ],
};

it("renders accessible unified diff controls, properties, navigation and copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<DocumentDiffViewer error={undefined} hasMore loading={false} onClose={vi.fn()} onLoadMore={vi.fn()} pages={[page]} version={version} />);

  expect(screen.getByText("−")).toHaveAccessibleName("删除行 49");
  expect(screen.getAllByText("+")[0]).toHaveAccessibleName("新增行 49");
  expect(screen.getByRole("button", { name: "展开文档属性" })).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(screen.getByRole("button", { name: "下一处修改" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "复制 Diff" }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("+ 身后的雨声"));
  expect(screen.getByText("部分未修改上下文已省略")).toBeVisible();
  expect(screen.getByRole("button", { name: "加载更多修改" })).toBeVisible();
});

it("renders loading, errors, and unavailable diffs", () => {
  const { rerender } = render(<DocumentDiffViewer hasMore={false} loading onClose={vi.fn()} onLoadMore={vi.fn()} pages={[]} version={version} />);
  expect(screen.getByText("正在加载修改对比…")).toBeVisible();
  rerender(<DocumentDiffViewer error="网络错误" hasMore={false} loading={false} onClose={vi.fn()} onLoadMore={vi.fn()} pages={[]} version={version} />);
  expect(screen.getByRole("alert")).toHaveTextContent("网络错误");
  rerender(<DocumentDiffViewer hasMore={false} loading={false} onClose={vi.fn()} onLoadMore={vi.fn()} pages={[]} version={{ ...version, diffStatus: "unavailable" }} />);
  expect(screen.getByText("修改对比正在修复")).toBeVisible();
});
