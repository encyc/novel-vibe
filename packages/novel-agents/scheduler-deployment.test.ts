import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootUrl = new URL("../../", import.meta.url);
const readRoot = (path: string) => readFileSync(new URL(path, rootUrl), "utf8");
const hasRoot = (path: string) => existsSync(new URL(path, rootUrl));

// `docker-compose.prod.yml` and `scripts/deploy.sh` belong to the operator-held side
// of the repository: the full checkout ships them, the public export does not. Their
// assertions are skipped — never deleted — when the file is absent, so the public
// repository still runs every assertion it can and the full checkout keeps all of its
// production-deployment coverage.
const hasPrivateCompose = hasRoot("docker-compose.prod.yml");
const hasPrivateDeployScript = hasRoot("scripts/deploy.sh");

describe("scheduler production deployment", () => {
  it("ships scheduler sources in the production image", () => {
    const dockerfile = readRoot("packages/novel-agents/Dockerfile");
    expect(dockerfile)
      .toContain("COPY packages/novel-agents/scheduler/ packages/novel-agents/scheduler/");
    expect(dockerfile)
      .toContain("COPY packages/novel-agents/model-runtime/ packages/novel-agents/model-runtime/");
  });

  it("keeps apk and npm downloads cached across production image rebuilds", () => {
    const dockerfile = readRoot("packages/novel-agents/Dockerfile");
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:/);
    expect(dockerfile).toContain("target=/var/cache/apk");
    expect(dockerfile.match(/target=\/root\/.npm/g)).toHaveLength(4);
    expect(dockerfile).not.toContain("npm cache clean --force");
    expect(dockerfile).toMatch(/^FROM node:22-alpine@sha256:[a-f0-9]{64}$/m);
  });

  it.skipIf(!hasPrivateCompose)("runs a private scheduler worker with database and SMTP configuration", () => {
    const compose = readRoot("docker-compose.prod.yml");
    expect(compose).toContain("scheduler-worker:");
    expect(compose).toContain("packages/novel-agents/scheduler/worker.ts");
    for (const name of [
      "POSTGRES_HOST", "POSTGRES_PASSWORD", "SMTP_HOST", "SMTP_PORT", "SMTP_EMAIL", "SMTP_PASSWORD",
    ]) expect(compose).toContain(name);
  });

  it.skipIf(!hasPrivateCompose)("keeps dynamic OpenCode execution off by default in both private services", () => {
    const compose = readRoot("docker-compose.prod.yml");
    expect(compose.match(/OPENCODE_DYNAMIC_MODELS_ENABLED=\$\{OPENCODE_DYNAMIC_MODELS_ENABLED:-false\}/g))
      .toHaveLength(2);
  });

  it("keeps dynamic OpenCode execution off by default in the sample environment", () => {
    expect(readRoot(".env.prod.sample")).toContain("OPENCODE_DYNAMIC_MODELS_ENABLED=false");
  });

  it.skipIf(!hasPrivateDeployScript)("builds, starts, and verifies the scheduler during deployment", () => {
    const deploy = readRoot("scripts/deploy.sh");
    expect(deploy).toContain("build agent-server novel-web scheduler-worker");
    expect(deploy).toContain("up -d scheduler-worker");
    expect(deploy).toContain("Scheduler worker is running");
    expect(deploy).toContain("logs --tail=100 scheduler-worker");
  });

  it("keeps the scheduler interval referenced so the worker stays alive", () => {
    expect(readRoot("packages/novel-agents/scheduler/worker.ts")).not.toContain("interval.unref()");
  });
});
