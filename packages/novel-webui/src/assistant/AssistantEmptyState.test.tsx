import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/config";
import { AssistantEmptyState } from "./AssistantEmptyState";

afterEach(cleanup);

describe("AssistantEmptyState", () => {
  it("offers useful localized starters and continues only with an active document", async () => {
    await i18n.changeLanguage("zh-CN");
    const onStart = vi.fn();
    render(<AssistantEmptyState activeDocumentPath="text/chapter-001.md" onStart={onStart} writable />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "继续当前章节" }));
    expect(onStart).toHaveBeenCalledWith(expect.stringContaining("text/chapter-001.md"));
  });

  it("omits continuation without an active document and shows no actions read-only", () => {
    const { rerender } = render(<AssistantEmptyState activeDocumentPath={null} onStart={vi.fn()} writable />);
    expect(screen.queryByRole("button", { name: "继续当前章节" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    rerender(<AssistantEmptyState activeDocumentPath={null} onStart={vi.fn()} writable={false} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("当前会话为只读状态，可以查看已有讨论。" )).toBeVisible();
  });
});
