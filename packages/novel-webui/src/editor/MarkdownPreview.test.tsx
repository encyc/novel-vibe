import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

afterEach(cleanup);

describe("MarkdownPreview", () => {
  it("renders GFM tables and task lists", () => {
    render(<MarkdownPreview content={[
      "| 角色 | 状态 |",
      "| --- | --- |",
      "| 林默 | 已确认 |",
      "",
      "- [x] 完成人物卡",
    ].join("\n")} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("does not render raw script elements", () => {
    const { container } = render(
      <MarkdownPreview content={'# 安全预览\n\n<script>alert("x")</script>'} />,
    );

    expect(screen.getByRole("article", { name: "文档预览" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
  });

  it("collapses frontmatter into a metadata card and renders the body", () => {
    const { container } = render(
      <MarkdownPreview content={
        "---\ntype: character\nname: 陆尘\ntags: [剑修, 失忆]\n---\n\n# 陆尘\n\n正文第一段。"
      } />,
    );

    const card = container.querySelector("details.frontmatter-card");
    expect(card).not.toBeNull();
    // Collapsed by default so the manuscript starts at the top of the pane.
    expect(card).not.toHaveAttribute("open");
    expect(card!.querySelector("summary")!.textContent).toContain("元数据");
    expect(card!.querySelector("summary")!.textContent).toContain("3");
    expect(card!.querySelector(".frontmatter-card-body")!.textContent).toContain("tags: [剑修, 失忆]");
    // The YAML block must not leak into the markdown body.
    expect(screen.getByRole("heading", { name: "陆尘" })).toBeInTheDocument();
    expect(screen.getByText("正文第一段。")).toBeInTheDocument();
    expect(container.querySelector(".markdown-preview > p")!.textContent).not.toContain("type: character");
  });

  it("renders plain markdown without a metadata card", () => {
    const { container } = render(<MarkdownPreview content={"# 普通文档\n\n正文。"} />);
    expect(container.querySelector(".frontmatter-card")).toBeNull();
  });
});
