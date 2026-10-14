# Lingqi WebUI Design System

## 1. Product Character

Lingqi is a long-form fiction production workbench, not a generic AI chat product. The interface should feel like a quiet editorial studio where writers organize manuscripts, direct specialist agents, inspect generated files, and revise work deliberately.

The product experience has four qualities:

- **Literary:** typography, paper, catalogues, proofreading, and archival language belong to the act of writing.
- **Calm:** generous negative space, low-saturation color, and restrained motion protect concentration.
- **Operational:** files, status, next actions, and agent activity remain clear and inspectable.
- **Trustworthy:** review, warnings, destructive actions, and generated changes are visible rather than magical.

The memorable concept is **The Quiet Editorial Manual（静谧文学编辑手册）**. Every page is a chapter in the same working book.

## 2. Visual Direction

### 2.1 Core Metaphors

Use editorial and archival metaphors as functional visual language:

- Paper sheets contain primary work.
- Catalogue rows represent projects, Skills, files, and records.
- Chapter numbers establish page hierarchy.
- Proofreading marks and seals communicate review state.
- Fine rules organize information like a manuscript or ledger.
- Book-spine marks identify long-lived creative objects.

These are not decorative themes. Each metaphor must clarify hierarchy or state.

### 2.2 Tone

The tone is refined editorial minimalism: warm ivory paper placed in a misty sage environment, written in ink, with occasional oxidized-red review marks. Interfaces should feel tactile without becoming nostalgic or ornamental.

Avoid:

- Generic white cards stacked on a flat background.
- Large rounded SaaS containers and excessive pills.
- Decorative gradients without spatial purpose.
- Purple AI branding, neon accents, glassmorphism, or playful chatbot motifs.
- Hero-scale typography inside dense workbench panels.
- Applying paper texture to every nested element.

## 3. Design Tokens

`packages/novel-webui/src/styles/tokens.css` is the implementation source of truth. Use semantic variables rather than page-local approximations.

### 3.1 Color

```css
--color-canvas: hsl(188 18% 96%);       /* misty application environment */
--color-surface: hsl(0 0% 100%);        /* neutral controls and overlays */
--color-paper: hsl(42 35% 96%);         /* primary editorial sheet */
--color-paper-deep: hsl(42 24% 91%);    /* inset and secondary paper */
--color-ink: hsl(162 12% 18%);          /* primary text */
--color-sage-900: hsl(162 28% 22%);     /* primary action */
--color-sage-700: hsl(165 24% 31%);     /* active navigation */
--color-sage-600: hsl(168 22% 45%);     /* secondary identity */
--color-sage-300: hsl(165 25% 78%);     /* rules and indicators */
--color-sage-100: hsl(168 20% 92%);     /* selected and quiet status */
--color-mist-100: hsl(188 20% 92%);     /* informational surface */
--color-seal: hsl(8 28% 42%);           /* review seal and warnings */
--color-rose-100: hsl(345 30% 90%);     /* warning background */
--color-border: hsl(192 15% 85%);       /* structural rules */
--color-muted: hsl(165 10% 40%);        /* secondary text */
```

Usage rules:

- Canvas establishes atmosphere; it must not compete with content.
- Paper is reserved for primary editorial surfaces.
- Sage-dark is the only default primary action color.
- Seal and rose colors communicate review, conflict, warning, or destructive intent—not decoration.
- Borders should remain visible at normal contrast without appearing heavy.

### 3.2 Typography

```css
--font-ui: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-writing: Lora, "Noto Serif SC", "Songti SC", Georgia, serif;
--font-display: "Cormorant Garamond", "Noto Serif SC", "Songti SC", Georgia, serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

- Display: page titles, editorial section headings, book marks, and major numeric values.
- Writing: manuscript content, literary descriptions, and intentional narrative copy.
- UI: navigation, buttons, forms, tables, statuses, and dense operational content.
- Mono: slugs, file paths, hashes, timestamps, and machine-facing identifiers.

English eyebrow labels use 0.16–0.22em letter spacing at 8–11px. Chinese body text should not use wide tracking. Avoid negative letter spacing.

### 3.3 Shape, Rules, and Depth

- Controls: 2–7px radius depending on size.
- Paper panels: 0–4px radius; they should read as sheets, not bubbles.
- Floating dialogs: up to 10px radius.
- Catalogue rows: usually square and separated by rules rather than individual cards.
- Side rails: full-height regions without radius.
- Shadows: broad, quiet, low-opacity shadows only for layer separation.
- Grain: one subtle page-level noise layer; never impair text contrast.

## 4. Shared Composition

### 4.1 Editorial Header

Public or standalone pages use a 58–66px top rule with:

- Back or brand navigation on the left.
- Product/section identity on the right.
- A short horizontal rule as an optional archival mark.

Authenticated workbench pages may compress this into their existing shell header.

### 4.2 Page Introduction

Standalone pages use:

```text
ENGLISH EYEBROW · CHAPTER NUMBER
Large editorial title
One short explanatory paragraph
Optional vertical Chinese section mark
```

Large introductions belong only at page level. Operational panels use compact section headings.

### 4.3 Editorial Section

A major section consists of:

```text
Section number — short rule
English eyebrow
Chinese heading                         optional icon / seal
One-line description
Content
```

Do not wrap every section in a card. Use paper sheets for primary work, catalogue lists for repeated records, and rules for secondary grouping.

### 4.4 States

- Loading: contextual language such as “正在翻阅目录…” instead of generic spinners alone.
- Empty: an intentionally blank catalogue or manuscript state with one next action.
- Error: a proofing note with clear recovery action.
- Review required: oxidized-red mark or seal plus exact findings.
- Success: sage status treatment; avoid celebratory animation.
- Destructive: rose surface and explicit confirmation.

Copy may be literary, but actions and errors must remain unambiguous.

## 5. Primary Pages

### 5.1 Login — Chapter 01: Entry Leaf

Purpose: provide a calm threshold into the writing environment.

Desktop structure:

```text
Quiet canvas
┌──────────────────────────────────────────────┐
│ Editorial foreword       │ Sign-in sheet     │
│ brand / short statement  │ mode / fields     │
│ restrained atmosphere    │ primary action    │
└──────────────────────────────────────────────┘
```

Rules:

- Use an asymmetric split sheet rather than a generic centered login card.
- The foreword carries brand mood; the form remains compact and conventional.
- Login/register mode stays obvious and keyboard accessible.
- On narrow screens, foreword and form stack; the form remains first-class.
- Authentication logic and error behavior do not change.

### 5.2 Project Center — Chapter 02: Project Archive

Purpose: help writers scan, find, and open manuscripts quickly.

Structure:

- Editorial page introduction and primary “新建项目” action.
- Status tabs and search on a ruled toolbar.
- Default desktop presentation as a catalogue/list, not a gallery of generic cards.
- Each project row includes book mark, title, genre, synopsis excerpt, recent activity, and opening action.
- Empty states appear as a blank archive shelf with one clear action.

On small screens, each catalogue row stacks into a compact book entry. Search remains full-width and status tabs remain reachable.

### 5.3 Project Workspace — Chapter 03: Writing Desk

Current implementation keeps its existing operational zones:

```text
Project sidebar | Main workspace | AI assistant rail
```

This redesign changes only the shell:

- Canvas atmosphere and major surface hierarchy.
- Sidebar paper tone, section rules, active state, and footer identity.
- Top workspace bar and project title treatment.
- Main workspace boundary and empty/loading surfaces.
- Assistant rail boundary and collapsed-shell appearance.
- Responsive shell behavior already owned by the workbench.

Do not redesign chat messages, composer, document editor, document preview, trace components, or AI assistant internals in this phase.

Workspace density remains higher than standalone pages. Decorative chapter marks must not reduce usable editor space.

### 5.4 Profile — Chapter 04: Writer's Ledger

Purpose: make identity, Credit balance, activity, purchase, and ledger history easy to inspect.

Desktop structure:

```text
Editorial introduction
Identity sheet | Ledger content
               | Credit summary
               | Activity heatmap
               | Records
               | Recharge
```

Rules:

- Identity acts as a stable writer's bookplate on the left where width permits.
- Credit and activity become ruled ledger sections rather than repeated floating cards.
- Numeric values use display typography; labels and transactions use UI typography.
- Payment status is a clear inserted notice, not a decorative banner.
- On narrow screens, identity moves above ledger content and all sections become one column.

### 5.5 Skill Management — Reference Implementation

The Skill page defines the target visual language:

- “编写与送审” is a manuscript desk.
- “馆藏目录” is a compact archival index.
- Review comparison is a proofreading spread.
- Safety rules appear as a restrained marginal note.

Future pages should reuse its principles, not copy its exact layout.

## 6. Workbench Architecture

The long-term authenticated application continues to use a professional production layout:

```text
Project rail | Workspace | Inspector / AI rail
```

- Project rail: project identity, sessions, documents, settings, and project-level movement.
- Workspace: chat, chapter, file, review, or overview content.
- Inspector: agent activity, workflow, context, generated outputs, and issues.

Files remain the source of truth. Generated artifacts must expose their path, state, authoring agent, and next action whenever the relevant data exists.

The literary system must never hide operational controls. Calm presentation is not sparse information architecture.

## 7. Interaction and Motion

- Use one orchestrated page entrance: 6–10px rise with opacity over 350–550ms.
- Catalogue rows may stagger by 35–50ms.
- Hover changes use color, rule, or 1–2px movement; avoid scale-heavy cards.
- Focus rings must remain clearly visible over paper and canvas.
- All motion must be disabled or reduced under `prefers-reduced-motion: reduce`.
- Do not animate long content, text reflow, ledger values, or critical status changes.

## 8. Accessibility and Responsive Rules

- Every major page area has a semantic landmark and accessible name.
- Text and interactive controls meet WCAG AA contrast.
- Icon-only controls retain explicit accessible labels.
- Form labels remain visible; placeholders are supplementary.
- Keyboard focus order follows visual reading order.
- No fixed decorative object may block content zoomed to 200%.
- Desktop asymmetry becomes a clear single-column reading flow below the relevant breakpoint.
- Workspace center content has priority when horizontal space is constrained.

## 9. Implementation Boundaries

Page-specific styles remain separated:

- `tokens.css`: semantic design variables.
- `base.css`: shared primitives and accessibility utilities.
- `auth.css`: login and registration entry surfaces.
- `project-center.css`: project archive.
- `workbench.css`: workspace shell.
- `profile.css`: writer ledger.
- `skills.css`: Skill manuscript and review experience.

Implementation rules:

- Preserve APIs, routes, query keys, mutations, and business behavior during visual passes.
- Prefer semantic HTML and CSS before adding component abstraction.
- Extract a shared component only when at least two implemented pages need the same behavior, not merely similar decoration.
- Avoid broad selectors that leak into editor content or third-party Markdown rendering.
- Do not encode meaningful state using color alone.
- Keep production `webui-dist` synchronized after WebUI changes.

## 10. Verification

Every page-level redesign must verify:

1. Existing interaction tests continue to pass.
2. New semantic regions and critical navigation are covered by tests.
3. `npm run check:webui` passes.
4. Desktop and narrow layouts have no horizontal overflow.
5. Focus, loading, empty, error, and reduced-motion states remain usable.
6. `make build-webui-dist` completes and updates committed production assets.

## 11. Success Criteria

The system succeeds when:

- Login, project archive, workspace shell, profile, and Skill management clearly belong to one product.
- A writer remembers the interface as a quiet editorial studio rather than another AI dashboard.
- Project, file, agent, review, and Credit states remain faster to scan than before.
- Literary atmosphere supports concentration without obscuring controls.
- Mobile layouts preserve the same hierarchy without reproducing desktop decoration.
- New pages can derive their composition and tokens from this document without inventing a separate aesthetic.

## 12. Current Redesign Scope

The approved implementation phase covers:

- Full visual redesign of login.
- Full visual redesign of project center.
- Shell-only redesign of project workspace.
- Full visual redesign of profile.
- Shared token reinforcement.
- Existing Skill management page remains the visual reference.

Out of scope for this phase:

- Chat message and composer redesign.
- Document editor and preview redesign.
- AI assistant internal component redesign.
- API, routing, persistence, billing, or authentication behavior changes.
