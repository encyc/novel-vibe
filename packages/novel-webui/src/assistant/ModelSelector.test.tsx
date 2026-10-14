import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "./ModelSelector";

describe("ModelSelector provider groups", () => {
  afterEach(() => cleanup());

  it("groups byok models under their provider label", () => {
    const models = [
      { id: "deepseek:m1", name: "Platform M1", provider: "deepseek", model: "m1" },
      {
        id: "byok-deepseek:deepseek-chat",
        name: "DeepSeek Chat",
        provider: "byok-deepseek",
        providerLabel: "DeepSeek",
        model: "deepseek-chat",
      },
    ];
    render(<ModelSelector models={models} value="" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select|选择|默认/ }));
    const group = screen.getByRole("group", { name: "byok-deepseek" });
    expect(group.querySelector(".model-selector-group-title")?.textContent).toBe("DeepSeek");
    expect(screen.getByText("DeepSeek Chat")).toBeInTheDocument();
  });
});
