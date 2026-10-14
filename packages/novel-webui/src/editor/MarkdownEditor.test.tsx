import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(cleanup);

describe("MarkdownEditor", () => {
  it("renders a controlled CodeMirror textbox with an accessible name", () => {
    render(<MarkdownEditor onChange={vi.fn()} value="# 第一章" />);

    const editor = screen.getByRole("textbox", { name: "文档源码" });
    expect(editor).toHaveTextContent("# 第一章");
  });
});
