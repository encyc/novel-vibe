import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/styles/workbench.css", "utf8");
const baseCss = readFileSync("src/styles/base.css", "utf8");
const projectCenterCss = readFileSync("src/styles/project-center.css", "utf8");
const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

describe("responsive workbench CSS contract", () => {
  it("keeps the quiet editorial palette as the shared default", () => {
    expect(tokensCss).toContain("--color-canvas: hsl(188 18% 96%)");
    expect(tokensCss).toContain("--color-paper: hsl(42 35% 96%)");
    expect(tokensCss).toContain("--color-sage-900: hsl(162 28% 22%)");
    expect(tokensCss).toContain("--color-seal: hsl(8 28% 42%)");
    expect(css).not.toContain("oklch(");
    expect(tokensCss).not.toContain("oklch(");
  });

  it("does not re-skin components through token remapping", () => {
    expect(css).not.toContain("--color-room-canvas");
    expect(css).not.toContain("--color-manuscript");
    expect(css).not.toContain("--color-action");
    expect(css).not.toContain("--color-proof");
    expect(css).not.toMatch(/\.workbench,[^{]*\{[^}]*--color-canvas:/);
  });

  it("uses the legacy serif stacks with semantic size roles", () => {
    expect(tokensCss).toContain('--font-writing: Lora, "Noto Serif SC", "Songti SC", Georgia, serif');
    expect(tokensCss).toContain('"Cormorant Garamond"');
    expect(tokensCss).not.toContain("--font-interface:");
    expect(tokensCss).toContain("--text-caption:");
    expect(tokensCss).toContain("--text-reading:");
    expect(tokensCss).toContain("--ease-quiet: cubic-bezier(.22, .72, .24, 1)");
    expect(tokensCss).toContain("--ease-settle: cubic-bezier(.2, .65, .25, 1)");
  });

  it("renders the manuscript as flat dsh text, not a paper sheet", () => {
    // No parchment card: the editor and preview sit directly on the pane.
    expect(css).not.toContain(".module-chip-navigation");
    expect(css).not.toContain(".workspace-document-strip");
    expect(css).toMatch(/\.source-editor>\.markdown-preview\{width:100%;min-height:100%;margin:0;background:transparent;border:0\}/);
    expect(css).toMatch(/\.markdown-preview \{[^}]*font-family: var\(--font-ui\)/);
    // Reading density comes from the shared editor tokens.
    expect(tokensCss).toContain("--editor-font-size: var(--text-14)");
    expect(tokensCss).toContain("--editor-line-height: 1.75");
  });

  it("leaves entry animations to existing page-level choreography only", () => {
    expect(css).not.toContain("green-room-enter");
    expect(css).not.toContain("manuscript-settle");
    expect(css).not.toContain("animation:login-petal-breathe");
  });

  it("renders document metadata as a collapsible mono card, not a paragraph blob", () => {
    expect(css).toContain(".frontmatter-card {");
    expect(css).toMatch(/\.frontmatter-card-body \{[^}]*font-family: ui-monospace/);
    expect(css).toMatch(/\.frontmatter-card-body \{[^}]*white-space: pre-wrap/);
  });

  it("uses a three-zone grid (sessions | chat | workspace pages) without a legacy desktop minimum width", () => {
    expect(css).not.toContain("min-width: 1180px");
    // Tracks are owned by AppFrame (shell/columns.ts drives the variable).
    expect(css).toContain(".app-frame {");
    expect(css).toContain("grid-template-columns: var(--app-frame-columns)");
    // Five children (sidebar/gutter/center/gutter/details) must be explicitly
    // placed — auto-flow wraps them onto a second row and shreds the layout.
    expect(css).toContain('.app-frame-gutter[data-for="sidebar"] { grid-area: 1 / 2; }');
    expect(css).toContain(".app-frame-center { grid-area: 1 / 3;");
    expect(css).toContain('.app-frame-gutter[data-for="details"] { grid-area: 1 / 4; }');
    expect(css).toContain(".app-frame-details { grid-area: 1 / 5;");
    // Compact collapses to a single cell the chat owns; rail and workspace
    // pages are promoted out of the grid and positioned as overlays.
    expect(css).toContain(".app-frame-sidebar,.app-frame-details { display:contents }");
    expect(css).toContain(".app-frame-center { grid-area:1/1 }");
    expect(css).toContain(".app-frame .workspace-main { position:absolute");
    expect(css).toContain(".session-rail");
    expect(css).toContain("data-context-collapsed");
    expect(css).not.toContain(".project-sidebar");
  });

  it("keeps surfaces flat and the chrome on dsh components (M1.5)", () => {
    expect(css).not.toContain("--texture-rule");
    expect(css).not.toContain("background-image: linear-gradient(var(");
    // composer is the dsh r22 card with a shadow, not a full-width bar
    expect(css).toMatch(/\.assistant-composer \{[^}]*border-radius: var\(--alias-radius-composer\)/);
    // better-sidebar activity rail: active page marked by the accent edge bar
    expect(css).toMatch(/\.workspace-rail \{/);
    expect(css).toMatch(/\.workspace-rail-item\[data-active\]::before/);
    // alias layer carries the dsh semantics component styles rely on
    for (const token of [
      "--alias-border-l2:", "--alias-label-tertiary:", "--alias-interactive-hover:",
      "--alias-shadow-lv2:", "--alias-scrollbar-thumb:",
    ]) expect(tokensCss).toContain(token);
  });

  it("defines tablet and mobile workspace layouts", () => {
    expect(css).toContain("@media (max-width: 1179px)");
    expect(css).toContain("@media (max-width: 767px)");
  });

  it("keeps touch controls large enough and provides compact-panel scrims", () => {
    expect(baseCss).toContain("@media (pointer: coarse)");
    expect(baseCss).toContain("min-height: 44px");
    expect(css).toContain(".workbench-scrim");
    expect(css).toContain("@media(pointer:coarse)");
  });

  it("gives the phone manuscript a full-width writing surface", () => {
    expect(css).toContain("--editor-font-size:16px");
    expect(css).toContain(".source-editor>.cm-editor,.source-editor>.markdown-preview{width:100%");
    expect(css).toContain(".overview-community-callout{grid-template-columns:1fr");
  });

  it("honors motion, transparency, and contrast preferences", () => {
    expect(baseCss).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-reduced-transparency:reduce");
    expect(css).toContain("prefers-contrast:more");
  });

  it("keeps every portal surface above shell chrome in a shared layer order", () => {
    expect(tokensCss).toContain("--layer-modal-backdrop: 80");
    expect(tokensCss).toContain("--layer-modal: 81");
    expect(tokensCss).toContain("--layer-popover: 90");
    expect(tokensCss).toContain("--layer-tooltip: 100");
    expect(css).toMatch(/\.dropdown-content\s*\{[^}]*z-index:\s*var\(--layer-popover\)/s);
    expect(css).toMatch(/\.dialog-overlay\s*\{[^}]*z-index:\s*var\(--layer-modal-backdrop\)/s);
    expect(css).toMatch(/\.dialog-content\s*\{[^}]*z-index:\s*var\(--layer-modal\)/s);
    expect(css).toMatch(/\.session-dialog-overlay\s*\{[^}]*z-index:\s*var\(--layer-modal-backdrop\)/s);
    expect(css).toMatch(/\.session-dialog-content\s*\{[^}]*z-index:\s*var\(--layer-modal\)/s);
    expect(baseCss).toMatch(/\.tooltip-content\s*\{[^}]*z-index:\s*var\(--layer-tooltip\)/s);
    expect(projectCenterCss).toContain("z-index:var(--layer-modal-backdrop)");
  });

  it("styles document change cards and responsive unified diffs", () => {
    expect(css).toContain(".document-change-card");
    expect(css).toContain(".document-version-history");
    expect(css).toContain(".document-diff-viewer");
    expect(css).toContain('.diff-line[data-kind="insert"]');
    expect(css).toContain('.diff-line[data-kind="delete"]');
    expect(css).toMatch(/\.diff-line\[data-kind="insert"\]\{background:hsl\(160 /);
    expect(css).toMatch(/\.diff-line\[data-kind="delete"\]\{background:hsl\(8 /);
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.document-diff-hunks/);
  });

  it("keeps components on the alias token layer", () => {
    expect(tokensCss).toContain("--alias-bg-base: var(--color-canvas)");
    expect(tokensCss).toContain("--alias-border-l1: var(--color-border)");
    expect(tokensCss).toContain("--alias-ease-standard: cubic-bezier(0.4, 0, 0.2, 1)");
    expect(css).toContain("transition: grid-template-columns var(--alias-duration-slow) var(--alias-ease-standard)");
  });

  it("migrates review surfaces onto shared tokens", () => {
    expect(css).toMatch(/\.document-diff-viewer\{[^}]*background:var\(--color-paper\)/);
    expect(css).toMatch(/\.document-version-history\{[^}]*background:var\(--color-surface\)/);
    expect(css).toMatch(/\.document-change-card\{[^}]*border-left:3px solid var\(--color-sage-900\)/);
  });
});
