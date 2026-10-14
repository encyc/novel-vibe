import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders inline markdown as structured HTML", () => {
    render(<Markdown>{"**bold** and `code`"}</Markdown>);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });

  it("renders GFM features (strikethrough, table)", () => {
    const { container } = render(<Markdown>{"~gone~\n\n| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);
    expect(container.querySelector("del")).not.toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("renders an empty string without crashing", () => {
    const { container } = render(<Markdown>{""}</Markdown>);
    expect(container.firstChild).not.toBeNull();
  });
});
