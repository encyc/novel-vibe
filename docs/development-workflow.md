# Development Workflow

## Default Change Order

1. Read `AGENTS.md`, `docs/current-system-map.md`, and the relevant package.
2. Put the change in the package that owns the behavior.
3. Add focused tests at that boundary.
4. Run the package check, then the full production check.
5. Rebuild and commit `webui-dist` after frontend changes.
6. Update current documentation when APIs, deployment, or ownership boundaries change.

## Ownership Guide

| Change | Preferred location |
| --- | --- |
| Browser components and state | `packages/novel-webui/src/` |
| Browser API client | `packages/novel-webui/src/api/` |
| Login, cookies, browser sessions, proxying | `packages/novel-web/src/` |
| Agent behavior and delegation | `packages/novel-agents/agents.ts`, `prompts/` |
| Agent tools | `packages/novel-agents/tools/` |
| Storage, database, credits, skills | `packages/novel-agents/lib/` |
| Internal HTTP/SSE API | `packages/novel-agents/server.ts` |
| Frontmatter schemas | `packages/novel-agents/schemas/` |
| Reverse-proxy routing | `nginx/` (self-hosting config; the hosted deployment's compose file lives in the private ops repository) |
| Local infrastructure | `InsForge/` — the compose stack, cloned by `make setup` from the public fork |

## Verification

```bash
npm run check:agents
npm run check:web
npm run check:webui
npm run check
```

For frontend changes:

```bash
make build-webui-dist
bash scripts/smoke-native-webui.sh
```

For shell changes and the local stack:

```bash
bash -n scripts/*.sh
docker compose config --quiet          # run inside InsForge/ (cloned by make setup)
```

Docker-dependent end-to-end checks:

```bash
npm run test:e2e
npm run test:e2e:full
```

## Local Runtime

```bash
./scripts/start.sh
./scripts/start.sh --infra-only
./scripts/start.sh --agent-only
./scripts/start.sh --web-only
./scripts/start.sh --ui-only
./scripts/status.sh
./scripts/stop.sh
```

The default start command launches InsForge, Agent Server, Web BFF, and native WebUI. The WebUI is available at `http://127.0.0.1:5173` during development.

## Frontend Rules

- Use `packages/novel-webui`; do not introduce a second frontend source tree.
- Keep browser calls same-origin and route authenticated operations through the BFF.
- Use the existing API client instead of direct InsForge or Agent Server calls.
- Preserve stable responsive dimensions for the project rail, chat surface, and document panel.
- Rebuild `webui-dist` locally because production servers do not have memory budget for frontend compilation.

## API Changes

When adding a browser operation:

1. Add or extend the internal route and tests in `packages/novel-agents` when domain behavior is required.
2. Add an authenticated BFF route and tests in `packages/novel-web`.
3. Add the typed client operation and UI tests in `packages/novel-webui`.
4. Run the three package checks.

## Git Hygiene

- Do not revert unrelated worktree changes.
- Keep dependency repositories separate from application commits.
- Stage explicit paths and inspect `git diff --check` before committing.
- Keep generated `webui-dist` changes in the same commit as their frontend source change.
