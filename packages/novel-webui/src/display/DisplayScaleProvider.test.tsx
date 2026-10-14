import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DisplayScaleProvider, useDisplayScale } from "./DisplayScaleProvider";

function DisplayScaleProbe() {
  const { scale, setScale } = useDisplayScale();
  return (
    <div>
      <span>{scale}</span>
      <button onClick={() => setScale("compact")} type="button">紧凑</button>
    </div>
  );
}

describe("DisplayScaleProvider", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-display-scale");
  });

  it("uses the default display scale initially", () => {
    render(<DisplayScaleProvider><DisplayScaleProbe /></DisplayScaleProvider>);

    expect(screen.getByText("default")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-display-scale", "default");
  });

  it("persists a compact display scale selection", async () => {
    render(<DisplayScaleProvider><DisplayScaleProbe /></DisplayScaleProvider>);

    await userEvent.click(screen.getByRole("button", { name: "紧凑" }));

    expect(document.documentElement).toHaveAttribute("data-display-scale", "compact");
    expect(window.localStorage.getItem("novel-vibe-display-scale")).toBe("compact");
  });

  it("restores the smallest saved display scale", () => {
    window.localStorage.setItem("novel-vibe-display-scale", "extra-compact");

    render(<DisplayScaleProvider><DisplayScaleProbe /></DisplayScaleProvider>);

    expect(screen.getByText("extra-compact")).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("data-display-scale", "extra-compact");
  });
});
