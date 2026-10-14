# syntax=docker/dockerfile:1.7
# Novel Vibe Agent Server + Web BFF — production Docker image
#
# Build from repo root:
#   docker build -f packages/novel-agents/Dockerfile -t novel-vibe-agents .
#
# Run agent:
#   docker run -d --env-file .env.prod novel-vibe-agents packages/novel-agents/server.ts

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add tini git

WORKDIR /app

# ── Layer 1: novel-agents ──
COPY packages/novel-agents/package.json packages/novel-agents/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/novel-agents && npm install --omit=dev --ignore-scripts

# Copy novel-agents source (only what's needed at runtime)
COPY packages/novel-agents/*.ts packages/novel-agents/
COPY packages/novel-agents/lib/ packages/novel-agents/lib/
COPY packages/novel-agents/prompts/ packages/novel-agents/prompts/
COPY packages/novel-agents/schemas/ packages/novel-agents/schemas/
COPY packages/novel-agents/tools/ packages/novel-agents/tools/
# New runtime dirs imported by server.ts: project lifecycle, session, built-in skills
COPY packages/novel-agents/project/ packages/novel-agents/project/
COPY packages/novel-agents/session/ packages/novel-agents/session/
COPY packages/novel-agents/lint/ packages/novel-agents/lint/
COPY packages/novel-agents/builtin/ packages/novel-agents/builtin/
COPY packages/novel-agents/billing/ packages/novel-agents/billing/
COPY packages/novel-agents/skills/ packages/novel-agents/skills/
COPY packages/novel-agents/context/ packages/novel-agents/context/
COPY packages/novel-agents/auth/ packages/novel-agents/auth/
COPY packages/novel-agents/community/ packages/novel-agents/community/
COPY packages/novel-agents/commands/ packages/novel-agents/commands/
COPY packages/novel-agents/document-version/ packages/novel-agents/document-version/
COPY packages/novel-agents/continuity/ packages/novel-agents/continuity/
COPY packages/novel-agents/server/ packages/novel-agents/server/
COPY packages/novel-agents/interactions/ packages/novel-agents/interactions/
COPY packages/novel-agents/model-runtime/ packages/novel-agents/model-runtime/
COPY packages/novel-agents/registration/ packages/novel-agents/registration/
COPY packages/novel-agents/referral/ packages/novel-agents/referral/

# ── Layer 3: remote MCP server ──
COPY packages/novel-mcp/package.json packages/novel-mcp/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/novel-mcp && npm install --omit=dev --ignore-scripts
COPY packages/novel-mcp/src/ packages/novel-mcp/src/
COPY packages/novel-mcp/tsconfig.json packages/novel-mcp/

# ── Layer 2: novel-web BFF ──
COPY packages/novel-web/package.json packages/novel-web/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/novel-web && npm install --omit=dev --ignore-scripts
COPY packages/novel-web/src/ packages/novel-web/src/
COPY packages/novel-web/tsconfig.json packages/novel-web/

# Install tsx globally for TypeScript execution at runtime
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm install -g tsx

# Scheduler changes should not invalidate dependency-install layers above.
COPY packages/novel-agents/scheduler/ packages/novel-agents/scheduler/

# ── Non-root user + runtime dirs ──
RUN addgroup -S novelvibe && adduser -S -G novelvibe -h /app novelvibe && \
    mkdir -p /tmp/novel-vibe-sessions /tmp/novel-vibe-skill-storage && \
    chown -R novelvibe:novelvibe /app /tmp/novel-vibe-sessions /tmp/novel-vibe-skill-storage

USER novelvibe

EXPOSE 7140 7150 9120

ENTRYPOINT ["/sbin/tini", "--", "npx", "tsx"]
CMD ["packages/novel-agents/server.ts"]
