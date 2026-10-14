import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentChangeCard } from "./DocumentChangeCard";

afterEach(cleanup);

describe("DocumentChangeCard", () => {
  it("shows explicit line stats and opens a changed document version", async () => {
    const onOpen = vi.fn();
    render(<DocumentChangeCard changes={[{
      versionId: "v1",
      path: "text/ch-001.md",
      versionNo: 1,
      agentId: "writer",
      toolCallId: "c1",
      addedLines: 12,
      deletedLines: 5,
      changedSections: ["雨夜"],
    }]} onOpen={onOpen} />);

    expect(screen.getByText("1 篇文档已修改")).toBeVisible();
    expect(screen.getByText("+12 −5")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "在文档中查看 text/ch-001.md 第 1 版" }));
    expect(onOpen).toHaveBeenCalledWith("text/ch-001.md", "v1");
  });

  it("groups versions by document and expands a bounded section summary", async () => {
    render(<DocumentChangeCard changes={[
      { versionId: "v2", path: "text/ch-001.md", versionNo: 2, agentId: "writer", toolCallId: "c2", addedLines: 2, deletedLines: 1, changedSections: ["三", "四"] },
      { versionId: "v1", path: "text/ch-001.md", versionNo: 1, agentId: "writer", toolCallId: "c1", addedLines: 1, deletedLines: 0, changedSections: ["一", "二"] },
      { versionId: "v3", path: "characters/hero.md", versionNo: 3, agentId: "character_designer", toolCallId: "c3", addedLines: 4, deletedLines: 2, changedSections: ["性格"] },
    ]} onOpen={vi.fn()} />);

    expect(screen.getByText("2 篇文档已修改")).toBeVisible();
    expect(screen.getAllByText("text/ch-001.md")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "展开修改摘要" }));
    expect(screen.getByText("一 · 二 · 三")).toBeVisible();
    expect(screen.queryByText(/四/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/第 [12] 版/).map((node) => node.textContent)).toEqual(["第 1 版", "第 2 版"]);
  });
});
