# Self-Hosting Novel Vibe

Novel Vibe runs on your own machine: a PostgreSQL-backed InsForge instance, the Agent Server, the
Web BFF and the browser WebUI. Nothing in this path needs a hosted account, an author API key, or a
connection to the author's servers — the only network access it needs is the initial `git clone`
and the Docker image pull.

This document is the short version. For how the pieces fit together, read
[`architecture.md`](architecture.md) and [`current-system-map.md`](current-system-map.md).

## Prerequisites

| Requirement | Notes |
|---|---|
| **Docker** | Docker Desktop on macOS, or Docker Engine + Compose v2 on Linux. InsForge (PostgreSQL, Storage, Auth, AI gateway) runs from the compose file in the fork below. |
| **Node.js 22+** | Matches the version CI uses. |
| **npm** | Ships with Node.js; the repository is an npm workspace. |
| **git** | To clone this repository and the InsForge fork. |

Ports used locally: **7130** InsForge (API + dashboard), **5430** PostgREST, **7140** Agent Server,
**9120** Web BFF, **5173** WebUI dev server.

## The two projects involved

| Project | Where it comes from | What it contains |
|---|---|---|
| **Novel Vibe** (this repository) | — | Agent orchestration, tools, HTTP API, Web BFF, browser WebUI, and the **application** schema (`scripts/migrations/*.sql`) |
| **InsForge** (a public fork) | `https://github.com/encyc/novel-vibe-insforge.git` (Apache-2.0) | The backend services plus the **platform** schema (auth, storage, system, realtime, deployments, `pg_cron`) |

`InsForge/` is gitignored: it is cloned next to this checkout and never becomes part of it.

## One command (macOS)

```bash
make setup     # clones the InsForge fork into InsForge/, creates env files, runs npm install
make up        # starts InsForge (Docker) + Agent Server + Web BFF + WebUI dev server
```

`make setup` is `bash scripts/setup.sh`, and it is idempotent — an existing `InsForge/` directory is
left untouched. Point it at a mirror, a fork or a pinned revision with `INSFORGE_REPO_URL`:

```bash
INSFORGE_REPO_URL=https://example.com/insforge.git bash scripts/setup.sh
```

Apply the application schema once the stack is up:

```bash
make migrate-sessions      # runs scripts/run-migrations.sh against the local database
```

### Local-first mode (no sign-in, no account)

`make up` runs the ordinary development stack, which still expects the InsForge auth flow. If you
want the single-user local mode — a locally minted identity instead of sign-in:

```bash
bash scripts/setup.sh          # once: provides InsForge/ and the env files
./scripts/local-start.sh       # starts InsForge + Agent Server + Web BFF in local mode
./scripts/local-start.sh --stop
```

Local-first mode generates its own `JWT_SECRET` into `.env.local` (mode `0600`, gitignored) and sets
`NOVEL_VIBE_LOCAL_MODE=true`. Chat still needs your own model key (BYOK) — see
[`adr/0007-keep-postgres-for-local-mode.md`](adr/0007-keep-postgres-for-local-mode.md) for why local
mode still ships PostgreSQL rather than a file database.

## Linux

`scripts/setup.sh` and `scripts/start.sh` drive the **macOS** development services (they manage
launchd-style logs), so they deliberately exit on Linux with a pointer to this document. On Linux,
run the same three steps by hand and then use the local-first entry point:

```bash
git clone https://github.com/encyc/novel-vibe-insforge.git InsForge   # or your own mirror
cp packages/novel-agents/.env.example packages/novel-agents/.env      # then edit it
npm install
./scripts/local-start.sh
```

## Verifying the install

```bash
curl -fsS http://127.0.0.1:7130/api/health    # InsForge is up
npm run check:agents                          # typecheck + unit tests (packages/novel-agents)
bash scripts/local-e2e.sh                     # local-first loop, no model calls
```

`scripts/local-e2e.sh` proves the loop end to end without a model: create a project, open a session,
write a document, restart the agent server, and confirm the history survived.

## Building the WebUI for a server

The production browser UI is a prebuilt artifact. The server does not compile it:

```bash
make build-webui-dist     # builds packages/novel-webui and syncs into webui-dist/
```

Serve `webui-dist/` behind nginx (the env-parameterized routing contract ships in
`nginx/templates/`, and `nginx/nginx.conf` is a generic base config). `webui-dist/` is generated
build output, so the published source tree does not carry it — build it here for your own
deployment, and do not commit it to a fork of the public tree.

## What is *not* covered here

- **Hosted operations** — the production compose file, TLS certificates, server lifecycle, desktop
  release signing/notarization and SEO submission live in the private ops repository. This
  repository intentionally ships no production Makefile.
- **SaaS surfaces of the hosted product** — community, credits, membership, referrals and
  account registration are part of this codebase, but they assume the hosted configuration
  (payment provider, SMTP, multi-tenant RLS). A local install can ignore them; the local-first path
  never touches them.
- **The desktop shell** — `packages/novel-desktop` is a connected Tauri shell that loads the WebUI
  origin and an updater feed published by the author. Building it locally (`npm run desktop:make`)
  works, but it points at the hosted update channel by default.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `InsForge did not become ready on :7130` | Docker is not running, or the image pull failed. Check `cd InsForge && docker compose logs`. |
| Port already in use | Something else holds 7130/7140/9120. Stop it, or override the port in the relevant `.env`. |
| `JWT_SECRET` mismatch between services | `make setup` syncs `JWT_SECRET` from `packages/novel-agents/.env` into `InsForge/.env`; in local mode the value comes from `.env.local`. Regenerate one and re-run setup. |
| Chat fails with no model configured | Local-first mode has no platform model budget: add your own provider key (BYOK) in the app settings. |
| `scripts/setup.sh` exits immediately | You are on Linux. Use the manual steps in [Linux](#linux). |
