import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { DocumentVersionSummary } from "../types";
import { DocumentVersionHistory } from "./DocumentVersionHistory";

const version = (overrides: Partial<DocumentVersionSummary> = {}): DocumentVersionSummary => ({
  id: "v7", projectId: "p1", path: "text/001.md", versionNo: 7, sourceType: "agent", agentId: "writer",
  beforeHash: "before", afterHash: "after", state: "complete", diffStatus: "ready", addedLines: 12,
  deletedLines: 5, changedSections: ["雨夜"], createdAt: "2026-08-14T10:00:00.000Z", completedAt: "2026-08-14T10:00:01.000Z",
  ...overrides,
});

it("selects versions, loads older entries, and exposes repair status", async () => {
  const onSelect = vi.fn();
  const onLoadMore = vi.fn();
  render(<DocumentVersionHistory
    hasMore
    loading={false}
    onLoadMore={onLoadMore}
    onSelect={onSelect}
    selectedVersionId="v7"
    versions={[version(), version({ id: "v6", versionNo: 6, diffStatus: "unavailable" })]}
  />);

  expect(screen.getByRole("button", { name: /章节 Writer.*第 7 版.*\+12 −5/ })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "显示版本历史" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("修改对比正在修复")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "加载更早版本" }));
  expect(onLoadMore).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: /第 6 版/ }));
  expect(onSelect).toHaveBeenCalledWith("v6");
});
