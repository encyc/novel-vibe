import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function stylesheet(name: string) {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");
}

describe("standalone mobile page styles", () => {
  it.each(["auth.css", "project-center.css", "community.css", "profile.css", "skills.css"])(
    "%s has a narrow-screen layout without a desktop minimum width",
    (name) => {
      const css = stylesheet(name);
      expect(css).toMatch(/@media\s*\(max-width:\s*(767|760|720|700|680|620|520|480|420)px\)/);
      expect(css).not.toContain("min-width: 1180px");
    },
  );

  it("makes shared phone dialogs safe-area-aware bottom sheets", () => {
    const css = stylesheet("workbench.css");
    expect(css).toContain('.dialog-content,.session-dialog-content{inset:auto 0 0');
    expect(css).toContain("max-height:calc(var(--app-height) - var(--safe-top) - 16px)");
    expect(css).toContain("padding-bottom:max(20px,var(--safe-bottom))");
  });

  it("keeps phone publishing actions above the device safe area", () => {
    const css = stylesheet("community.css");
    expect(css).toContain("padding-bottom:max(16px,var(--safe-bottom))");
  });

  it("replaces the profile index with a labeled selector on narrow screens", () => {
    const css = stylesheet("profile.css").replace(/\s+/g, "");
    expect(css).toContain(".profile-mobile-navigation{display:none");
    expect(css).toMatch(/@media\(max-width:760px\).*\.profile-desktop-navigation\{display:none;?\}.*\.profile-mobile-navigation\{display:grid/s);
  });

  it("stacks referral notice actions on narrow screens", () => {
    const css = stylesheet("profile.css");
    expect(css).toContain(".referral-notice { width: 100%; }");
    expect(css).toContain(".referral-notice-actions { align-items: stretch; flex-direction: column-reverse; }");
    expect(css).toContain(".referral-notice-actions button { width: 100%; }");
  });
});
