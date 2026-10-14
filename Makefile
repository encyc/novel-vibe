# Novel Vibe — Makefile (local development)
#
# This is the local development entry point: it runs the InsForge container
# stack, the agent server, the Web BFF and the native WebUI on one machine.
#
#   make setup    # first-time: install npm deps, create the local env file
#   make up       # start everything (infra + dev services)
#   make logs     # tail the local service logs
#   make stop     # stop the dev services
#
# Hosted deployment (production compose, server lifecycle, TLS certificates,
# release promotion) is maintained in the private ops repository. This
# repository does not ship a production Makefile, so the targets below are
# local-dev only and safe to run on any OS.
#
# Service lifecycle logic lives in scripts/*.sh.

.DEFAULT_GOAL := help

# ─── setup ─────────────────────────────────────────────────────────────
# First-time local install: npm dependencies + env file.

.PHONY: setup
setup:
	@bash scripts/setup.sh

# ─── Shared local targets ──────────────────────────────────────────────

.PHONY: stop restart down logs clean-db migrate-sessions
stop:
	@./scripts/stop.sh

down: stop
	@cd InsForge && docker compose down
	@echo "Docker stopped."

restart: stop dev

logs:
	@scripts/dev-logs.sh all

clean-db:
	@echo "Cleaning sessions and messages from DB..."
	docker exec novel-vibe-postgres-1 psql -U postgres -d insforge -c "DELETE FROM session_messages; DELETE FROM sessions;"
	@echo "Done. Restart the agent server to pick up clean state."

migrate-sessions:
	@./scripts/run-migrations.sh

# ─── Per-service log targets (dev viewer) ──────────────────────────────
# scripts/dev-logs.sh tails the local launchd log files with colored service
# tags, timestamps, and dev-noise filtered out.

.PHONY: logs-agent logs-web logs-webui logs-bridge logs-verbose logs-nginx
logs-agent:
	@scripts/dev-logs.sh agent
logs-web logs-bridge:
	@scripts/dev-logs.sh web
logs-webui:
	@scripts/dev-logs.sh webui
logs-verbose:
	@scripts/dev-logs.sh all --verbose
logs-nginx:
	@echo "[logs-nginx] nginx is not part of local dev. The configs in nginx/ are for self-hosting. Use: make logs"

# ─── Local dev targets ─────────────────────────────────────────────────

.PHONY: up dev infra agent webui build test status build-webui-dist stage-webui-dist
up:
	@./scripts/start.sh

dev:
	@./scripts/start.sh --dev-only

infra:
	@./scripts/start.sh --infra-only

agent:
	@./scripts/start.sh --agent-only

webui:
	@./scripts/start.sh --ui-only

build:
	npm run build --workspace=packages/novel-agents

test:
	npm run test --workspace=packages/novel-agents

status:
	@./scripts/status.sh

# Build browser WebUI into webui-dist/ for production. Run this wherever the
# artifact is needed, then serve webui-dist/ behind nginx.
.PHONY: build-webui-dist
build-webui-dist:
	@echo "Building browser WebUI for production..."
	@npm --workspace @novel-vibe/webui run build
	@mkdir -p webui-dist
	@tmp_dir=$$(mktemp -d /tmp/webui-pwa.XXXXXX); \
	for asset in favicon.ico favicon.svg apple-touch-icon.png icon-192.png icon-512.png manifest.json; do \
		[ -f "webui-dist/$$asset" ] && cp "webui-dist/$$asset" "$$tmp_dir/"; \
	done; \
	rsync -a --delete packages/novel-webui/dist/ webui-dist/; \
	for asset in favicon.ico favicon.svg apple-touch-icon.png icon-192.png icon-512.png manifest.json; do \
		[ -f "$$tmp_dir/$$asset" ] && cp "$$tmp_dir/$$asset" "webui-dist/"; \
	done; \
	rm -rf "$$tmp_dir"

# Stage a rebuilt webui-dist/. The artifact is generated output rather than source:
# the published open-source tree does not carry it, and this repository keeps a copy
# only for the operator-side deploy path.
.PHONY: stage-webui-dist
stage-webui-dist:
	@git add -f webui-dist
	@echo "Staged webui-dist (git add -f). Review with: git status"

# ─── help ──────────────────────────────────────────────────────────────

.PHONY: help
help:
	@echo "Usage: make <target>   (local development)"
	@echo ""
	@echo "Getting started:"
	@echo "  setup             First-time install (npm deps + env file)"
	@echo "  up                Start everything (infra + dev)"
	@echo "  dev               Start agent + web BFF + webui"
	@echo "  infra             Start InsForge Docker only"
	@echo "  agent             Start agent server (7140)"
	@echo "  webui             Start web UI dev server (5173)"
	@echo "  status            Show running services"
	@echo "  stop              Stop agent + web BFF + webui"
	@echo "  down              Stop everything including Docker"
	@echo "  restart           Stop dev services and restart"
	@echo ""
	@echo "Logs:"
	@echo "  logs              Tail all service logs (tagged, dev-noise filtered)"
	@echo "  logs-agent        Tail agent server log only"
	@echo "  logs-web          Tail web BFF log only"
	@echo "  logs-webui        Tail webui dev server log only"
	@echo "  logs-verbose      Tail all logs without the noise filter"
	@echo ""
	@echo "Verification:"
	@echo "  build             Build novel-agents"
	@echo "  test              Run novel-agents tests"
	@echo "  clean-db          Delete sessions/messages from the local DB"
	@echo "  migrate-sessions  Run database migrations"
	@echo ""
	@echo "Frontend artifact:"
	@echo "  build-webui-dist  Build browser WebUI into webui-dist"
	@echo "  stage-webui-dist  git add -f the rebuilt webui-dist"
