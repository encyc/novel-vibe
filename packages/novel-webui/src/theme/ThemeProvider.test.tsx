import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function ThemeProbe() {
  const { mode, setMode } = useTheme();
  return (
    <div>
      <span>{mode}</span>
      <button onClick={() => setMode("dark")} type="button">护眼</button>
    </div>
  );
}

function stubSystemTheme(dark: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: dark,
    removeEventListener: vi.fn(),
  }));
}

describe("ThemeProvider", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("uses the system preference by default", () => {
    stubSystemTheme(true);
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    expect(screen.getByText("system")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("persists an explicit eye-care theme selection", async () => {
    stubSystemTheme(false);
    render(<ThemeProvider><ThemeProbe /></ThemeProvider>);

    await userEvent.click(screen.getByRole("button", { name: "护眼" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("novel-vibe-theme")).toBe("dark");
  });
});
