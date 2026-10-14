import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { InterfaceLanguageSelector } from "./InterfaceLanguageSelector";
import { LocaleProvider } from "./LocaleProvider";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InterfaceLanguageSelector", () => {
  it("presents language choices as an accessible two-option switch", async () => {
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <InterfaceLanguageSelector authenticated={false} />
      </LocaleProvider>,
    );

    const group = screen.getByRole("group", { name: "界面语言" });
    const chinese = screen.getByRole("button", { name: "中文" });
    const english = screen.getByRole("button", { name: "English" });
    expect(group).toHaveClass("interface-language-selector");
    expect(chinese).toHaveAttribute("aria-pressed", "true");
    expect(english).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await user.click(english);

    await waitFor(() => expect(english).toHaveAttribute("aria-pressed", "true"));
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists authenticated changes through the account profile", async () => {
    vi.spyOn(api, "updateProfile").mockResolvedValue({
      id: "user-1",
      email: "u@example.com",
      displayName: "Writer",
      avatarUrl: null,
      locale: "en",
    });
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <InterfaceLanguageSelector authenticated />
      </LocaleProvider>,
    );

    await user.click(screen.getByRole("button", { name: "English" }));

    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith({ locale: "en" }));
  });
});
