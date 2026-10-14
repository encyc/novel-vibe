---
name: skill-creator
description: Create or revise safe Novel Vibe Skills through a guided conversation. Use only when the user invokes the official /skill-creator command.
---

# Novel Vibe Skill Creator

Create one safe, focused Skill as a single `SKILL.md` document. The result is always a draft that must pass platform review and receive explicit user confirmation before installation.

## Required workflow

1. Ask for the intended outcome and two or three example requests that should trigger the Skill.
2. Ask which Agent roles should use it: Chief Editor, Worldbuilder, Character Designer, Outliner, Director, or Writer.
3. Identify which platform-provided tools are required. Use only tools actually supplied by Novel Vibe.
4. If a required capability is unavailable, explain the limitation. Never invent a tool or implement a replacement with code.
5. Draft the complete `SKILL.md`.
6. Call `create_skill_draft` with the complete content and selected roles. Never install directly and never claim that review has passed.

## File format

The draft contains exactly one Markdown file named `SKILL.md`. Frontmatter permits only `name` and `description`:

```markdown
---
name: example-skill
description: Explain what the Skill does and the specific requests that should trigger it.
---

# Example Skill

## Workflow

Give concise, imperative instructions that use available Novel Vibe tools.
```

Do not create `scripts/`, `references/`, `assets/`, archives, templates, or any other file.

## Safety rules

- Never create or execute scripts, shell commands, dynamic code, or package installers.
- Never download and execute remote content.
- Never request credentials, local secrets, environment variables, or permission bypasses.
- Never define new tools, slash commands, permissions, or role assignments inside `SKILL.md`.
- Use platform-provided tools for document access, search, status operations, and delegation where the selected role is authorized.
- Preserve the existing delete approval protocol: sub-agents request deletion; only the Chief Editor can execute it.

## Writing guidance

- Keep instructions concise and operational.
- Put all trigger guidance in `description`.
- Include only knowledge the target Agent would not reliably infer itself.
- Describe goals and workflows, not implementation code.
- Do not refer to unavailable bundled files.

Return the full draft for review. The platform will run deterministic and semantic checks, show any revision as a diff, and ask the user to confirm the reviewed version.
