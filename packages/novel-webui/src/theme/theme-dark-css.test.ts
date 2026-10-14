import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/theme-dark.css", "utf8");

describe("dark theme CSS coverage", () => {
  it("defines a green-black night palette without token remapping", () => {
    expect(css).toContain("--color-canvas: hsl(155 13% 10%)");
    expect(css).toContain("--color-paper: hsl(48 10% 15%)");
    expect(css).not.toContain("oklch(");
    expect(css).not.toContain("--color-room-canvas");
    expect(css).not.toContain("--color-manuscript");
    expect(css).not.toMatch(/\.workbench,[^{]*\{[^}]*--color-canvas:var\(--color-room/);
  });

  it.each([
    ".workbench",
    ".session-rail",
    ".project-center",
    ".profile-section",
    ".overview-brief",
    ".document-workspace-body",
    ".source-editor > .cm-editor",
    ".project-settings-archive",
    ".ai-assistant-rail",
    ".assistant-header",
    ".assistant-messages",
    ".assistant-markdown",
    ".interface-language-options",
    ".login-form .segmented",
    ".workspace-skill-list input[type=\"checkbox\"]",
  ])("covers the real surface selector %s", (selector) => {
    expect(css).toContain(`:root[data-theme="dark"] ${selector}`);
  });

  it.each([
    "--community-canvas",
    "--community-topbar",
    "--community-surface-soft",
    "--community-surface-hover",
    "--community-chip",
    "--community-chip-border",
    "--community-accent-soft",
    "--community-accent-line",
    "--community-input",
  ])("defines the community dark surface token %s", (token) => {
    expect(css).toContain(`${token}:`);
  });

  it.each([
    '.diff-line[data-kind="insert"]',
    '.diff-line[data-kind="delete"]',
    '.diff-line[data-kind="context"]',
    ".inline-insert",
    ".inline-delete",
  ])("covers document diff selector %s", (selector) => {
    expect(css).toContain(`:root[data-theme="dark"] ${selector}`);
  });
});
