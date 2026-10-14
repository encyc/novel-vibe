import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/config";
import { CreditActivityHeatmap } from "./CreditActivityHeatmap";
import { daysInYear } from "./profile-utils";

describe("CreditActivityHeatmap", () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
  });
  it("builds leap and ordinary years", () => {
    expect(daysInYear(2024)).toHaveLength(366);
    expect(daysInYear(2026)).toHaveLength(365);
  });

  it("renders every date with an accessible exact value", () => {
    render(<CreditActivityHeatmap days={[{ date: "2026-07-01", creditsConsumed: 12.5, totalTokens: 6200 }]} year={2026} />);
    expect(screen.getAllByRole("gridcell")).toHaveLength(365);
    expect(screen.getByRole("gridcell", { name: "2026年7月1日，消耗 12.5 Credit，6,200 tokens" })).toHaveAttribute("data-level");
  });

  it("uses English date and number formatting when selected", async () => {
    await i18n.changeLanguage("en");
    render(<CreditActivityHeatmap days={[{ date: "2026-07-01", creditsConsumed: 12.5, totalTokens: 6200 }]} year={2026} />);
    expect(screen.getByRole("gridcell", { name: "July 1, 2026, used 12.5 Credit, 6,200 tokens" })).toHaveAttribute("data-level");
  });
});
