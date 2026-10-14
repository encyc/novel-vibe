import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");
const tokens = readFileSync("src/styles/tokens.css", "utf8");
const base = readFileSync("src/styles/base.css", "utf8");

describe("mobile viewport foundation", () => {
  it("supports dynamic browser chrome and display cutouts", () => {
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
    expect(tokens).toContain("--safe-top: env(safe-area-inset-top, 0px)");
    expect(tokens).toContain("--safe-bottom: env(safe-area-inset-bottom, 0px)");
    expect(base).toContain("min-height: 100dvh");
  });

  it("protects mobile editing and touch interaction", () => {
    expect(base).toContain("@media (max-width: 767px)");
    expect(base).toMatch(/input,[\s\S]*textarea,[\s\S]*select[\s\S]*font-size:\s*16px/);
    expect(base).toContain("overflow-wrap: anywhere");
  });
});
