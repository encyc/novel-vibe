# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

`AGENTS.md` is the single source of truth for architecture, commands, service ports, the agent/tool system, document storage, and the skill system. Read it before changing code, deployment config, or docs. The notes below only cover what AGENTS.md does not.

The supported frontend is `packages/novel-webui`. Browser requests pass through `packages/novel-web` (BFF) to `packages/novel-agents`; InsForge is the backend for auth, storage, and PostgreSQL.

## Make targets

The root `Makefile` is the local-development entry point (it no longer dispatches on OS):

- `make setup` — first-time install: clones the public InsForge fork into `InsForge/`, creates the env files, runs `npm install`
- `make up` — start everything via `scripts/start.sh` (InsForge Docker + Agent Server + Web BFF + WebUI dev server)
- `make build-webui-dist` — build `packages/novel-webui` and sync it into `webui-dist/` (see below)
- `make stage-webui-dist` — `git add -f webui-dist`; the artifact is generated output, not source,
  and the published open-source tree does not carry it (see below)

Hosted operations (production compose, server lifecycle, TLS, release promotion) live in the private
ops repository; this repository does not ship a production Makefile. AGENTS.md's command block lists
the raw `npm`/script invocations, and `docs/self-hosting.md` is the end-to-end self-hosting
walkthrough.

## Publishing frontend changes

`webui-dist/` is the prebuilt `packages/novel-webui` output that nginx serves directly in production;
the server never builds the WebUI. The open-source tree does not commit it (build output), so
generate it wherever the artifact is needed:

```bash
make build-webui-dist     # build + rsync into webui-dist/ (preserves PWA assets)
bash scripts/smoke-native-webui.sh
```

`make build-webui-dist` produces an artifact carrying the `name="novel-vibe-webui" content="native"`
marker; the hosted release preflight rejects a `webui-dist/` missing it. The hosted deployment builds
that artifact from this source in the private ops repository.

## Verification

CI order is typecheck first, then tests; both must pass. Run a single package or a single test file rather than the whole chain during iteration:

```bash
npm run check:webui                          # typecheck + test (packages/novel-webui)
npm --workspace @novel-vibe/webui run test -- --run src/assistant/Markdown.test.tsx   # one file
```

Coverage thresholds (statements 70 / branches 65 / functions 75 / lines 70). `packages/novel-agents/` has no eslint — typecheck + vitest only.
