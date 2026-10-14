import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunPlanCard } from "./RunPlanCard";

describe("RunPlanCard", () => {
  it("shows textual statuses and exact progress", () => {
    render(<RunPlanCard plan={{ schemaVersion: 1, id: "p1", title: "起草本章", items: [
      { id: "read", title: "读取上下文", status: "completed" },
      { id: "draft", title: "起草场景", status: "in_progress" },
      { id: "review", title: "检查连续性", status: "pending" },
    ] }} />);
    expect(screen.getByRole("region", { name: "起草本章" })).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("进行中")).toBeVisible();
    expect(screen.getByText("已完成")).toBeVisible();
  });
});
