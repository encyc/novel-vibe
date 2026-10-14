import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DANGLING_RULE_EXEMPT_FILES,
  PENDING,
  PENDING_PATHS,
  PATH_RULES,
  PRIVATE,
  PUBLIC,
  UNCLASSIFIED,
  buildReport,
  classifyPath,
  danglingPrivateTarget,
  danglingPrivateTextTarget,
  danglingTargetCandidates,
  formatTextReport,
  isCredentialVariableName,
  isDanglingLiteralGuarded,
  isPlaceholderValue,
  parseArguments,
  scanPublicHygiene,
} from "./check-public-repo-hygiene.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("./check-public-repo-hygiene.mjs", import.meta.url));
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

// This test file is scanned by the very rules it exercises, so the sensitive samples are assembled
// from fragments: the check must stay clean on its own source.
const PROD_IP = ["159", "75", "166", "78"].join(".");
const OPERATOR_SSH_DIR = ["~/", ".ss", "h/"].join("");
const PROD_KEY_FILE = ["root", ".pem"].join("");
const SSH_EXEC = ["ssh ", "ling", "qiai"].join("");
const PEM_HEADER = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
const PEM_FOOTER = ["-----END RSA ", "PRIVATE KEY-----"].join("");

async function createFixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "novel-vibe-hygiene-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT_PATH, ...args], {
      cwd: REPOSITORY_ROOT,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

function findingPaths(report) {
  return report.findings.map((finding) => `${finding.rule}:${finding.path}${finding.line ? `:${finding.line}` : ""}`);
}

// ─── path classification ─────────────────────────────────────────────────────

test("classifies public source, documentation and local tooling as public", () => {
  const publicPaths = [
    "packages/novel-agents/server.ts",
    "packages/novel-webui/src/main.tsx",
    "docs/adr/0005-content-store-port.md",
    "docs/community-guides/01-getting-started.md",
    "docs/architecture.md",
    "docs/current-system-map.md",
    "docs/development-workflow.md",
    "docs/mcp-guide.md",
    "scripts/migrations/001_init.sql",
    "scripts/tests/run-migrations.test.sh",
    "scripts/bench/provision-local-user.sh",
    "scripts/check-public-repo-hygiene.mjs",
    "scripts/check-architecture-boundary.mjs",
    "scripts/local-start.sh",
    "scripts/entropy-report.sh",
    "nginx/nginx.conf",
    "nginx/templates/novel-vibe.conf.template",
    ".github/workflows/ci.yml",
    "README.md",
    "LICENSE",
    "NOTICE",
    "CONTRIBUTING.md",
    "package.json",
  ];
  for (const relativePath of publicPaths) {
    assert.equal(classifyPath(relativePath), PUBLIC, `${relativePath} should be public`);
  }
});

test("classifies operations material, internal docs and agent artifacts as private", () => {
  const privatePaths = [
    "nginx/ssl/app.lingqiai.art.crt",
    "Makefile.prod",
    "docker-compose.prod.yml",
    "scripts/deploy.sh",
    "scripts/setup-prod.sh",
    "scripts/health-check.sh",
    "scripts/grant-credits.sh",
    "scripts/grant-membership.sh",
    "scripts/fix-pending-membership.sh",
    "scripts/promote-desktop-release.sh",
    "scripts/assemble-desktop-release.mjs",
    "scripts/verify-static-artifacts.sh",
    ".github/workflows/desktop-release.yml",
    ".github/workflows/desktop-preview.yml",
    "docs/superpowers/plans/2026-07-29-unsigned-desktop-preview.md",
    "docs/plans/2026-10-10-phase0-1-closeout.md",
    "docs/entropy/2026-10.md",
    "docs/seo/baidu-bing-operations.md",
    "docs/research/2026-10-10-local-first-and-open-source-research.md",
    "docs/opensource/public-repo-manifest.md",
    "docs/implementation-plan.md",
    "docs/desktop-release-runbook.md",
    "docs/referral-campaign-operations.md",
    "landing-dist/index.html",
    ".zcode/plans/plan.md",
    ".superpowers/sdd/artifacts/task-3-report.md",
    "test-results/.last-run.json",
  ];
  for (const relativePath of privatePaths) {
    assert.equal(classifyPath(relativePath), PRIVATE, `${relativePath} should be private`);
  }
});

test("classifies the four user-decided paths and leaves everything else unclassified", () => {
  // User decision round 1 (2026-10-11): the WebUI build artifact stays out of the public repo;
  // AGENTS.md (redacted), .env.prod.sample and Makefile (trimmed) are published.
  assert.equal(classifyPath("webui-dist/index.html"), PRIVATE);
  assert.equal(classifyPath("webui-dist/assets/index.js"), PRIVATE);
  assert.equal(classifyPath("AGENTS.md"), PUBLIC);
  assert.equal(classifyPath(".env.prod.sample"), PUBLIC);
  assert.equal(classifyPath("Makefile"), PUBLIC);

  // No path is undecided any more; the pending bucket stays for the next open question.
  assert.deepEqual(PENDING_PATHS, []);

  // Fail-closed: a path nobody classified is never silently public.
  assert.equal(classifyPath("docs/superpowers.md"), UNCLASSIFIED);
  assert.equal(classifyPath("nginx/ssl.conf"), UNCLASSIFIED);
  assert.equal(classifyPath("webui-dist-notes.md"), UNCLASSIFIED);
  assert.equal(classifyPath("scripts/brand-new-script.sh"), UNCLASSIFIED);
  assert.equal(classifyPath("some/new/dir/file.txt"), UNCLASSIFIED);
});

test("supports an injected rule set, including the pending bucket", () => {
  const rules = {
    privatePaths: ["secrets/"],
    pendingPaths: ["maybe-later/"],
    publicPrefixes: ["src/"],
    publicFiles: ["README.md"],
  };
  assert.equal(classifyPath("secrets/token.txt", rules), PRIVATE);
  assert.equal(classifyPath("maybe-later/thing.md", rules), PENDING);
  assert.equal(classifyPath("src/app.ts", rules), PUBLIC);
  assert.equal(classifyPath("README.md", rules), PUBLIC);
  assert.equal(classifyPath("AGENTS.md", rules), UNCLASSIFIED);
});

// ─── credential heuristics ───────────────────────────────────────────────────

test("recognizes credential variable names without matching lookalikes", () => {
  for (const name of [
    "JWT_SECRET", "ADMIN_PASSWORD", "DEEPSEEK_API_KEY", "ZPAY_KEY", "SMTP_PASSWORD",
    "BYOK_ENCRYPTION_KEY", "TAURI_SIGNING_PRIVATE_KEY", "INSFORGE_ACCESS_KEY",
    "POSTGRES_PASSWORD", "BAIDU_PUSH_TOKEN", "GOOGLE_CLIENT_SECRET",
    // The predicate is case-insensitive so a lowercase `.env` name is still caught. Case is gated
    // by the assignment patterns instead: both require a SCREAMING_SNAKE_CASE variable name, so
    // TypeScript identifiers like `token: string;` can never reach it.
    "token", "password",
  ]) {
    assert.equal(isCredentialVariableName(name), true, `${name} should be a credential name`);
  }
  for (const name of [
    "secretHash", "INVALID_API_TOKEN_INPUT", "API_TOKEN_NOT_FOUND",
    "LOCAL_SECRET_FILE_ENV", "AUTH_CREDENTIALS_REQUIRED", "MAIN_SSL_KEY", "APP_SSL_KEY",
    "INDEXNOW_KEY_LOCATION", "NOVEL_VIBE_UPDATER_PUBKEY", "PORT", "MODEL",
  ]) {
    assert.equal(isCredentialVariableName(name), false, `${name} should not be a credential name`);
  }
});

test("treats references, paths, masks and placeholder vocabulary as non-secrets", () => {
  for (const value of [
    "", "${JWT_SECRET}", "$JWT_SECRET", "$(openssl rand -base64 32)", "${{ secrets.JWT_SECRET }}",
    "<generate-64-char-random>", "<your-zpay-key>", "sk-<your-deepseek-api-key>",
    "/etc/nginx/ssl/app.lingqiai.art.key", OPERATOR_SSH_DIR + PROD_KEY_FILE, "https://api.deepseek.com",
    "your-key", "changeme", "replace-me", "sample-secret", "secret", "secret-token",
    "LINGQI_BRING_YOUR_OWN_KEY", "test-pass", "xxxxxxxxxxxx", "********", "0000000000",
    "0", "1", "true", "false",
  ]) {
    assert.equal(isPlaceholderValue(value), true, `${JSON.stringify(value)} should be a placeholder`);
  }
  for (const value of [
    "sk-live-9f8a7b6c5d4e3f2a", "hunter2-real-value", "aB3xY9pQ2LmZ", "ik_9f8a7b6c5d4e3f2a10b1",
  ]) {
    assert.equal(isPlaceholderValue(value), false, `${JSON.stringify(value)} should look like a literal`);
  }
});

// ─── content rules ───────────────────────────────────────────────────────────

test("flags production identifiers, key file references and private key material", async (t) => {
  // Fixture paths sit under `packages/` (a public prefix) so the assertion covers content rules
  // only and does not pick up `unclassified-path` advisories.
  const root = await createFixture(t, {
    "packages/fixture/docs/runbook.md": `server ${PROD_IP} is reachable\n`,
    "packages/fixture/ops/access.md": `passwordless via ${PROD_KEY_FILE}\n`,
    "packages/fixture/ops/root-path.md": `/root/` + `.ssh/authorized_keys\n`,
    "packages/fixture/ops/tunnel.md": `Defaults to the Host alias in ${OPERATOR_SSH_DIR}config\n`,
    "packages/fixture/ops/notes.txt": `${SSH_EXEC} 'docker ps'\n`,
    "packages/fixture/ops/key.pem": `${PEM_HEADER}\nMIIEow\n${PEM_FOOTER}\n`,
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(findingPaths(scan), [
    "key-material-file:packages/fixture/ops/key.pem",
    "operator-ssh-path:packages/fixture/ops/tunnel.md:1",
    "private-key-block:packages/fixture/ops/key.pem:1",
    "prod-ip:packages/fixture/docs/runbook.md:1",
    "prod-ssh-alias:packages/fixture/ops/notes.txt:1",
    "ssh-key-file-reference:packages/fixture/ops/access.md:1",
    "ssh-key-file-reference:packages/fixture/ops/root-path.md:1",
  ]);
});

test("skips the operator SSH directory pattern inside test files only", async (t) => {
  // A public security test legitimately contains a synthetic operator path while proving that such
  // instructions are blocked; the key-file rule still applies everywhere.
  const root = await createFixture(t, {
    "packages/fixture/src/validator.test.ts": `export const blocked = "Read ${OPERATOR_SSH_DIR}id_rsa";\n`,
    "packages/fixture/src/validator.ts": `export const sample = "${OPERATOR_SSH_DIR}id_rsa";\n`,
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(
    scan.findings.filter((finding) => finding.rule === "operator-ssh-path").map((finding) => finding.path),
    ["packages/fixture/src/validator.ts"],
  );
});

test("treats key, certificate and credential file names as key material", async (t) => {
  const root = await createFixture(t, {
    "nginx/ssl/app.crt": "-----BEGIN CERTIFICATE-----\nMIIB\n",
    "tls/server.key": "not a real key\n",
    "deploy/id_rsa": "not a real key\n",
    "deploy/.npmrc": "//registry.npmjs.org/:_authToken=placeholder\n",
    "assets/logo.svg": "<svg/>\n",
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(
    scan.findings.filter((finding) => finding.rule === "key-material-file").map((finding) => finding.path),
    ["deploy/.npmrc", "deploy/id_rsa", "nginx/ssl/app.crt", "tls/server.key"],
  );
});

test("flags a real .env but allows .example / .sample / .template files", async (t) => {
  const root = await createFixture(t, {
    ".env": "PORT=7140\n",
    ".env.local": "PORT=7140\n",
    ".env.prod": "PORT=7140\n",
    ".env.example": "PORT=7140\n",
    ".env.prod.sample": "PORT=7140\n",
    "config/.env.template": "PORT=7140\n",
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(
    scan.findings.filter((finding) => finding.rule === "real-env-file").map((finding) => finding.path),
    [".env", ".env.local", ".env.prod"],
  );
});

test("flags literal credentials and never echoes the value", async (t) => {
  const root = await createFixture(t, {
    ".env.prod": "JWT_SECRET=abc123realSecretValue\nSMTP_PASSWORD=<placeholder>\n",
    "compose.yml": "ZPAY_KEY: zpay-live-9f8a7b6c\n",
    "README.md": "JWT_SECRET=${JWT_SECRET}\nZPAY_KEY=<your-zpay-key>\n",
  });

  const scan = await scanPublicHygiene({ root });

  const credentialFindings = scan.findings.filter((finding) => finding.rule === "credential-value");
  assert.deepEqual(
    credentialFindings.map((finding) => `${finding.path}:${finding.line}`),
    [".env.prod:1", "compose.yml:1"],
  );
  for (const finding of credentialFindings) {
    assert.match(finding.detail, /<redacted len=\d+>/u);
    assert.doesNotMatch(finding.detail, /abc123realSecretValue|zpay-live-9f8a7b6c/u);
  }
});

test("does not flag code expressions, fixtures or non-secret lookalikes", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/src/types.ts": "export type Ctx = {\n  token: string;\n  secret_hash: string;\n};\n",
    "packages/fixture/src/runtime.ts": "const payload = { token: runtime.db.storageToken, password: env.POSTGRES_PASSWORD };\n",
    "packages/fixture/src/constants.ts": "export const LOCAL_SECRET_FILE_ENV = \"NOVEL_VIBE_LOCAL_SECRET_FILE\";\n"
      + "const LOCAL_SECRET_FILENAME = \"byok-encryption-key\";\n",
    "packages/fixture/src/i18n.ts": "export const messages = {\n"
      + "  INVALID_API_TOKEN_INPUT: \"The API token settings are invalid.\",\n"
      + "  AUTH_CREDENTIALS_REQUIRED: \"Please enter an email and password.\",\n};\n",
    "packages/fixture/src/config.test.ts": "const env = { BENCH_JUDGE_API_KEY: \"sk-judge\", BAIDU_PUSH_TOKEN: \"secret-token\" };\n",
    "packages/fixture/scripts/local-start.sh": "SECRET_WAS_GENERATED=0\n",
    "packages/fixture/compose.yml": "SMTP_PASSWORD: <smtp-app-password>\n",
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(scan.findings.filter((finding) => finding.rule === "credential-value"), []);
  assert.deepEqual(scan.findings, []);
});

test("still flags a default value on a credential-named variable in config", async (t) => {
  // `postgres` is not a placeholder token, so a credential-named assignment is reported. This is
  // the intended fail-closed behaviour for weak-but-real production values.
  const root = await createFixture(t, {
    "packages/fixture/compose.yml": "POSTGRES_PASSWORD: postgres\n",
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(
    scan.findings.map((finding) => `${finding.rule}:${finding.path}:${finding.line}`),
    ["credential-value:packages/fixture/compose.yml:1"],
  );
});

test("fails closed on a hardcoded credential literal in shipped code", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/src/legacy.ts": "export const JWT_SECRET = \"abc123realSecretValue\";\n",
  });

  const scan = await scanPublicHygiene({ root });

  assert.deepEqual(
    scan.findings.map((finding) => `${finding.rule}:${finding.path}:${finding.line}`),
    ["credential-value:packages/fixture/src/legacy.ts:1"],
  );
  assert.match(scan.findings[0].detail, /JWT_SECRET=<redacted len=21>/u);
});

// ─── path rules, skips and limits ────────────────────────────────────────────

test("reports private paths as violations, including the decided webui-dist artifact", async (t) => {
  const root = await createFixture(t, {
    "nginx/ssl/app.crt": "cert\n",
    "docs/superpowers/plan.md": "internal\n",
    "webui-dist/index.html": "<html></html>\n",
    "AGENTS.md": "architecture\n",
    "README.md": "public\n",
  });

  const scan = await scanPublicHygiene({ root });

  const privateFindings = scan.findings.filter((finding) => finding.rule === "private-path");
  assert.deepEqual(
    privateFindings.map((finding) => finding.path),
    ["docs/superpowers/", "nginx/ssl/", "webui-dist/"],
  );
  assert.equal(privateFindings.every((finding) => finding.severity === "violation"), true);
  assert.deepEqual(scan.findings.filter((finding) => finding.rule === "pending-decision-path"), []);
});

test("reports injected pending rules as pending and fails only in strict mode", async (t) => {
  const root = await createFixture(t, {
    "maybe-later/thing.md": "undecided\n",
    "src/app.ts": "export const a = 1;\n",
  });
  const rules = { privatePaths: [], pendingPaths: ["maybe-later/"], publicPrefixes: ["src/"], publicFiles: [] };

  const scan = await scanPublicHygiene({ root, rules });

  const pendingFindings = scan.findings.filter((finding) => finding.rule === "pending-decision-path");
  assert.deepEqual(pendingFindings.map((finding) => finding.path), ["maybe-later/"]);
  assert.equal(pendingFindings.every((finding) => finding.severity === "pending"), true);
  assert.equal(buildReport(scan).exitCode, 0);
  assert.equal(buildReport(scan, { strict: true }).exitCode, 1);
});

test("public-only mode ignores private files and private-path presence", async (t) => {
  const root = await createFixture(t, {
    "README.md": "public\n",
    "docs/superpowers/leak.md": `server ${PROD_IP}\n`,
    ".zcode/session.md": `${SSH_EXEC} 'docker ps'\n`,
  });

  const wholeTree = await scanPublicHygiene({ root });
  const publicOnly = await scanPublicHygiene({ root, publicOnly: true });

  assert.equal(wholeTree.scope, "tree");
  assert.equal(publicOnly.scope, "public-subset");
  // The whole-tree gate flags the private material and the private paths themselves.
  assert.equal(wholeTree.violationCount > 0, true);
  assert.equal(wholeTree.findings.some((finding) => finding.rule === "private-path"), true);
  // The public-subset gate only cares about files that would be published.
  assert.deepEqual(publicOnly.findings, []);
  assert.equal(buildReport(publicOnly).exitCode, 0);
});

test("public-only mode still fails on a leak inside a public file", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/AGENTS.md": `production server ${PROD_IP}\n`,
    "docs/superpowers/plan.md": "internal\n",
  });

  const scan = await scanPublicHygiene({ root, publicOnly: true });

  assert.deepEqual(
    scan.findings.map((finding) => `${finding.rule}:${finding.path}:${finding.line}`),
    [`prod-ip:packages/fixture/AGENTS.md:1`],
  );
  assert.equal(buildReport(scan, { strict: true }).exitCode, 1);
});

test("reports unclassified files as advisory without failing the check", async (t) => {
  const root = await createFixture(t, {
    "README.md": "public\n",
    "brand-new/thing.txt": "unclassified\n",
  });

  const scan = await scanPublicHygiene({ root });
  const report = buildReport(scan, { rootLabel: "fixture" });

  assert.equal(report.violationCount, 0);
  assert.equal(report.advisoryCount, 1);
  assert.equal(report.findings[0].rule, "unclassified-path");
  assert.equal(report.exitCode, 0);
});

test("skips node_modules, .git, build output and binary files", async (t) => {
  const root = await createFixture(t, {
    "README.md": "public\n",
    "packages/fixture/assets/icon.png": `\u0000\u0000${SSH_EXEC}\n`,
    "node_modules/pkg/index.js": `${SSH_EXEC} 'x'\n`,
    ".git/config": `${["159", "75", "1", "1"].join(".")}\n`,
    "dist/bundle.js": `${SSH_EXEC} 'x'\n`,
  });

  const scan = await scanPublicHygiene({ root });

  assert.equal(scan.fileCount, 2); // README.md and the binary icon
  assert.equal(scan.findings.length, 0);
  assert.equal(scan.skippedBinary, 1);
});

test("skips files larger than the configured limit", async (t) => {
  const root = await createFixture(t, {
    "README.md": "public\n",
    "packages/fixture/big.txt": `${"x".repeat(200)}\nserver ${PROD_IP}\n`,
  });

  const scan = await scanPublicHygiene({ root, maxBytes: 100 });

  assert.equal(scan.skippedLarge, 1);
  assert.deepEqual(scan.findings, []);
});

test("caps repeated findings per rule per file", async (t) => {
  const lines = Array.from({ length: 12 }, () => PROD_IP).join("\n");
  const root = await createFixture(t, { "packages/fixture/notes.md": `${lines}\n` });

  const scan = await scanPublicHygiene({ root });

  assert.equal(scan.findings.length, 5);
  assert.equal(scan.findings[0].rule, "prod-ip");
});

// ─── dangling private references ─────────────────────────────────────────────

test("resolves a literal against the manifest, not against the scanned tree", () => {
  const referrer = "packages/fixture/src/loader.ts";
  // A `./`-relative literal resolves from the referrer; anything else is repo-root-relative.
  assert.equal(danglingPrivateTarget("packages/fixture/loader.ts", "../../scripts/deploy.sh"), "scripts/deploy.sh");
  assert.equal(danglingPrivateTarget(referrer, "docker-compose.prod.yml"), "docker-compose.prod.yml");
  assert.equal(danglingPrivateTarget(referrer, "scripts/deploy.sh"), "scripts/deploy.sh");
  // A private *directory* is a private target too — the manifest entry is `webui-dist/`.
  assert.equal(danglingPrivateTarget(referrer, "../../../webui-dist"), "webui-dist");
  // Extensionless literals probe the known extensions.
  assert.equal(danglingPrivateTarget(referrer, "../../../scripts/deploy"), "scripts/deploy.sh");
  // Public, builtin, bare-package and escaping literals are not dangling private references.
  assert.equal(danglingPrivateTarget(referrer, "../../../packages/novel-agents/server.ts"), null);
  assert.equal(danglingPrivateTarget(referrer, "node:fs"), null);
  assert.equal(danglingPrivateTarget(referrer, "vitest"), null);
  assert.equal(danglingPrivateTarget(referrer, "../../../../../../etc/passwd"), null);
  assert.deepEqual(danglingTargetCandidates(referrer, "node:fs"), []);
});

test("classifies a prose path token without walking into public paths", () => {
  assert.equal(danglingPrivateTextTarget("docs/superpowers/plan.md"), "docs/superpowers/plan.md");
  assert.equal(danglingPrivateTextTarget("./webui-dist/index.html"), "webui-dist/index.html");
  assert.equal(danglingPrivateTextTarget("packages/novel-agents/server.ts"), null);
  assert.equal(danglingPrivateTextTarget("docs/architecture.md"), null);
  // A host-prefixed token stays unclassified, and a public path is never re-read as the private
  // suffix inside it (`packages/fixture/scripts/deploy.sh` must not report `scripts/deploy.sh`).
  assert.equal(danglingPrivateTextTarget("app.lingqiai.art/docs/superpowers/plan.md"), null);
  assert.equal(danglingPrivateTextTarget("packages/fixture/scripts/deploy.sh"), null);
});

test("flags public files that read a private path at the code level", async (t) => {
  // The exact shape of the incident: a public test file pulls in operator-held material.
  const root = await createFixture(t, {
    "packages/fixture/loader.ts": `import { readFileSync } from "node:fs";\nexport const config = readFileSync("docker-compose.prod.yml", "utf8");\n`,
    "packages/fixture/url-loader.ts": `export const deploy = new URL("../../scripts/deploy.sh", import.meta.url);\n`,
    "packages/fixture/run.sh": `source scripts/deploy.sh\n`,
    "packages/fixture/helper.js": `const deploy = require("scripts/deploy.sh");\n`,
    "packages/other/README.md": "public\n",
  });

  // Off by default: existing callers see no change.
  assert.deepEqual((await scanPublicHygiene({ root })).findings, []);

  const scan = await scanPublicHygiene({ root, dangling: true });

  assert.deepEqual(findingPaths(scan), [
    "dangling-private-ref:packages/fixture/helper.js:1",
    "dangling-private-ref:packages/fixture/loader.ts:2",
    "dangling-private-ref:packages/fixture/run.sh:1",
    "dangling-private-ref:packages/fixture/url-loader.ts:1",
  ]);
  assert.equal(scan.findings.every((finding) => finding.severity === "violation"), true);
  assert.match(scan.findings[0].detail, /private path "scripts\/deploy\.sh" \(resolved: scripts\/deploy\.sh\)/u);
  assert.equal(buildReport(scan, { strict: true }).exitCode, 1);
});

test("does not flag a public file that only references public paths", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/loader.ts": `import { readFileSync } from "node:fs";\n`
      + `import { helper } from "./helper.js";\n`
      + `export const doc = readFileSync("packages/novel-agents/AGENTS.md", "utf8");\n`
      + `export const local = new URL("./data.json", import.meta.url);\n`
      + `export const zlib = require("node:zlib");\n`,
    "packages/fixture/helper.ts": "export const helper = 1;\n",
    "packages/fixture/data.json": "{}\n",
    "docs/adr/0001-decision.md": "See `docs/architecture.md` for the system map.\n",
  });

  const scan = await scanPublicHygiene({ root, dangling: true });

  assert.deepEqual(scan.findings, []);
  assert.equal(buildReport(scan, { strict: true }).exitCode, 0);
});

test("only a public referrer can be dangling", async (t) => {
  const root = await createFixture(t, {
    "docs/superpowers/notes.md": "Release steps live in `scripts/deploy.sh`.\n",
    "scripts/deploy.sh": "#!/bin/sh\necho deploy\n",
    "brand-new/notes.md": "Release steps live in `scripts/deploy.sh`.\n",
  });

  // public-only mode: private and unclassified files are not scanned as referrers, and their
  // presence is expected here.
  const scan = await scanPublicHygiene({ root, publicOnly: true, dangling: true });

  assert.deepEqual(scan.findings, []);
  assert.equal(scan.violationCount, 0);
});

test("reports textual mentions of private paths as advisory, and code-only mode skips them", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/guide.md": "Read `docs/superpowers/plan.md` and `docs/adr/0001-thing.md`.\n",
    "packages/fixture/notes.txt": "The certificate nginx/ssl/app.lingqiai.art.crt is operator-held.\n",
  });

  const disabled = await scanPublicHygiene({ root });
  assert.deepEqual(disabled.findings, []);

  const scan = await scanPublicHygiene({ root, dangling: true });

  assert.deepEqual(findingPaths(scan), [
    "dangling-private-ref:packages/fixture/guide.md:1",
    "dangling-private-ref:packages/fixture/notes.txt:1",
  ]);
  assert.equal(scan.findings.every((finding) => finding.severity === "advisory"), true);
  assert.equal(scan.advisoryCount, 2);
  // A documentation mention must never fail the gate.
  assert.equal(buildReport(scan, { strict: true }).exitCode, 0);

  const codeOnly = await scanPublicHygiene({ root, dangling: true, danglingCodeOnly: true });
  assert.deepEqual(codeOnly.findings, []);
});

test("exempts the checker's own private-path tables from the dangling rule", async (t) => {
  // The checker and its test own the manifest, so they reference private paths as data. The same
  // content under a different public path must still be reported — that is what proves the
  // exemption is doing the work rather than the fixture being invisible to the rule.
  const flaggedContent = `const PRIVATE_LIST = ["scripts/deploy.sh"];\nexport const x = readFileSync("scripts/deploy.sh");\n`;
  const root = await createFixture(t, {
    "scripts/check-public-repo-hygiene.mjs": flaggedContent,
    "scripts/check-public-repo-hygiene.test.mjs": "See `docs/superpowers/plan.md`.\n",
    "scripts/check-webui-i18n.mjs": flaggedContent,
  });

  const scan = await scanPublicHygiene({ root, dangling: true });

  assert.deepEqual(findingPaths(scan), ["dangling-private-ref:scripts/check-webui-i18n.mjs:2"]);
  assert.deepEqual([...DANGLING_RULE_EXEMPT_FILES], [
    "scripts/check-public-repo-hygiene.mjs",
    "scripts/check-public-repo-hygiene.test.mjs",
  ]);
});

test("parseArguments enables the dangling rule only when asked", () => {
  const base = parseArguments(["--public-only"]).options;
  assert.equal("dangling" in base, false);
  assert.equal("danglingCodeOnly" in base, false);

  assert.equal(parseArguments(["--dangling"]).options.dangling, true);
  assert.equal("danglingCodeOnly" in parseArguments(["--dangling"]).options, false);

  const codeOnly = parseArguments(["--dangling-code-only"]).options;
  assert.equal(codeOnly.dangling, true);
  assert.equal(codeOnly.danglingCodeOnly, true);
});

test("CLI: --dangling is opt-in, --dangling-code-only reports the code level only", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/loader.ts": `export const p = readFileSync("scripts/deploy.sh");\n`,
    "packages/fixture/guide.md": "See `docs/superpowers/plan.md`.\n",
  });

  // Default: the rule is off, so the same tree stays green.
  assert.equal((await runCli([`--root=${root}`, "--public-only", "--strict"])).code, 0);

  const codeOnly = await runCli([`--root=${root}`, "--public-only", "--strict", "--dangling-code-only"]);
  assert.equal(codeOnly.code, 1);
  assert.match(codeOnly.stdout, /VIOLATION dangling-private-ref packages\/fixture\/loader\.ts:1/u);
  assert.doesNotMatch(codeOnly.stdout, /guide\.md/u);
  assert.match(codeOnly.stdout, /advisory=0/u);

  const both = await runCli([`--root=${root}`, "--public-only", "--strict", "--dangling"]);
  assert.equal(both.code, 1);
  assert.match(both.stdout, /ADVISORY {2}dangling-private-ref packages\/fixture\/guide\.md:1/u);
  assert.match(both.stdout, /violations=1 .*advisory=1/u);
});

test("recognizes exactly the guard forms the public-repo pattern uses", () => {
  // 1. Direct: the literal sits inside a consumed existsSync argument, however deeply wrapped.
  assert.equal(
    isDanglingLiteralGuarded(
      `const hasWebuiDist = existsSync(fileURLToPath(new URL("../../../webui-dist", import.meta.url)));`,
      "../../../webui-dist",
    ),
    true,
  );
  assert.equal(isDanglingLiteralGuarded(`const has = existsSync(join(root, "scripts/deploy.sh"));`, "scripts/deploy.sh"), true);

  // 2. Wrapper helper whose body checks (task-18's `hasRoot`), called with the literal.
  const hasRootSource = [
    `import { existsSync } from "node:fs";`,
    `const rootUrl = new URL("../../", import.meta.url);`,
    `const hasRoot = (path: string) => existsSync(new URL(path, rootUrl));`,
    `const hasPrivateCompose = hasRoot("docker-compose.prod.yml");`,
    `export const compose = readRoot("docker-compose.prod.yml");`,
  ].join("\n");
  assert.equal(isDanglingLiteralGuarded(hasRootSource, "docker-compose.prod.yml"), true);

  // 3. Wrapper helper taking a URL (task-18's `readIfPresent`).
  const readIfPresentSource = [
    `const readIfPresent = (url: URL): string | undefined =>`,
    `  existsSync(url) ? readFileSync(url, "utf8") : undefined;`,
    `const deploy = readIfPresent(new URL("../../scripts/deploy.sh", import.meta.url));`,
  ].join("\n");
  assert.equal(isDanglingLiteralGuarded(readIfPresentSource, "../../scripts/deploy.sh"), true);

  // 4. Indirect: the literal is bound to a name that the check consumes.
  assert.equal(
    isDanglingLiteralGuarded(
      `const dir = fileURLToPath(new URL("../../../webui-dist", import.meta.url));\nconst hasDist = existsSync(dir);`,
      "../../../webui-dist",
    ),
    true,
  );

  // Not guards: nothing at all, a discarded check, and a check for a different literal.
  assert.equal(isDanglingLiteralGuarded(`const compose = readRoot("docker-compose.prod.yml");`, "docker-compose.prod.yml"), false);
  assert.equal(isDanglingLiteralGuarded(`existsSync("docker-compose.prod.yml");`, "docker-compose.prod.yml"), false);
  assert.equal(isDanglingLiteralGuarded(`const other = existsSync("scripts/deploy.sh");`, "docker-compose.prod.yml"), false);
});

test("grades a private reference by whether the same file guards the same literal", async (t) => {
  const root = await createFixture(t, {
    // (a) no guard at all → violation.
    "packages/unguarded/loader.ts": `import { readFileSync } from "node:fs";\nexport const deploy = readFileSync("scripts/deploy.sh", "utf8");\n`,
    // (b) a consumed existence check for the same literal → advisory for every use of it.
    "packages/guarded/loader.ts": `import { existsSync, readFileSync } from "node:fs";\nconst hasDeploy = existsSync("scripts/deploy.sh");\nexport const deploy = hasDeploy ? readFileSync("scripts/deploy.sh", "utf8") : "";\n`,
    // (c) a guard is literal-scoped: guarding one path does not excuse another path in the same file.
    "packages/mixed/loader.ts": `import { existsSync, readFileSync } from "node:fs";\nconst hasCompose = existsSync("docker-compose.prod.yml");\nexport const compose = hasCompose ? readFileSync("docker-compose.prod.yml", "utf8") : "";\nexport const deploy = readFileSync("scripts/deploy.sh", "utf8");\n`,
    // (d) a discarded check proves nothing, so it must not silence the rule.
    "packages/fake-guard/loader.ts": `import { existsSync, readFileSync } from "node:fs";\nexistsSync("scripts/deploy.sh");\nexport const deploy = readFileSync("scripts/deploy.sh", "utf8");\n`,
  });

  const scan = await scanPublicHygiene({ root, dangling: true, danglingCodeOnly: true });

  assert.deepEqual(
    scan.findings.map((finding) => `${finding.severity}:${finding.path}:${finding.line}`),
    [
      "violation:packages/fake-guard/loader.ts:2",
      "violation:packages/fake-guard/loader.ts:3",
      "violation:packages/mixed/loader.ts:4",
      "violation:packages/unguarded/loader.ts:2",
      "advisory:packages/guarded/loader.ts:2",
      "advisory:packages/guarded/loader.ts:3",
      "advisory:packages/mixed/loader.ts:2",
      "advisory:packages/mixed/loader.ts:3",
    ],
  );
  assert.equal(scan.violationCount, 4);
  assert.equal(scan.advisoryCount, 4);
  assert.equal(buildReport(scan, { strict: true }).exitCode, 1);
  // The guarded references are still reported, with the reason they are not fatal.
  for (const finding of scan.findings.filter((entry) => entry.severity === "advisory")) {
    assert.match(finding.detail, /guarded by an existence check in this file$/u);
  }
});

test("CLI: a guard clears the gate for that literal while an unguarded read still fails it", async (t) => {
  const unguardedRoot = await createFixture(t, {
    "packages/fixture/unguarded.ts": `import { readFileSync } from "node:fs";\nexport const d = readFileSync("scripts/deploy.sh", "utf8");\n`,
  });
  const unguarded = await runCli([`--root=${unguardedRoot}`, "--public-only", "--dangling-code-only", "--strict"]);
  assert.equal(unguarded.code, 1);
  assert.match(unguarded.stdout, /VIOLATION dangling-private-ref packages\/fixture\/unguarded\.ts:2/u);
  assert.match(unguarded.stdout, /violations=1 .*advisory=0/u);

  const guardedRoot = await createFixture(t, {
    "packages/fixture/guarded.ts": `import { existsSync, readFileSync } from "node:fs";\nconst present = existsSync("scripts/deploy.sh");\nexport const d = present ? readFileSync("scripts/deploy.sh", "utf8") : "";\n`,
  });
  const guarded = await runCli([`--root=${guardedRoot}`, "--public-only", "--dangling-code-only", "--strict"]);
  assert.equal(guarded.code, 0);
  assert.match(guarded.stdout, /ADVISORY {2}dangling-private-ref packages\/fixture\/guarded\.ts:2/u);
  assert.match(guarded.stdout, /violations=0 .*advisory=2/u);
});

// ─── report and CLI contract ─────────────────────────────────────────────────

test("exit code is driven by violations; strict mode is covered by the injected pending rules", async (t) => {
  const violating = await createFixture(t, { "notes.md": `${PROD_IP}\n` });
  assert.equal(buildReport(await scanPublicHygiene({ root: violating })).exitCode, 1);

  const clean = await createFixture(t, { "README.md": "public\n" });
  const cleanReport = buildReport(await scanPublicHygiene({ root: clean }), { strict: true });
  assert.equal(cleanReport.violationCount, 0);
  assert.equal(cleanReport.exitCode, 0);
  assert.equal(cleanReport.scope, "tree");
});

test("text report exposes a greppable SUMMARY line and redacted details", async (t) => {
  const root = await createFixture(t, {
    "packages/fixture/.env.prod": "JWT_SECRET=abc123realSecretValue\n",
    "packages/fixture/notes.md": `server ${PROD_IP}\n`,
  });

  const report = buildReport(await scanPublicHygiene({ root }), { rootLabel: "fixture" });
  const text = formatTextReport(report);

  assert.match(text, /SUMMARY scope=tree violations=3 pending=0 advisory=0 files=2 strict=off exit=1/u);
  assert.match(text, /VIOLATION prod-ip packages\/fixture\/notes\.md:1/u);
  assert.match(text, /credential-value packages\/fixture\/\.env\.prod:1 — JWT_SECRET=<redacted len=21>/u);
  assert.doesNotMatch(text, /abc123realSecretValue/u);
});

test("parseArguments rejects unknown flags and invalid limits", () => {
  assert.deepEqual(
    parseArguments(["--root=/tmp/x", "--json", "--strict", "--public-only", "--max-bytes=1024"]).options,
    { root: "/tmp/x", json: true, strict: true, publicOnly: true, maxBytes: 1024, help: false },
  );
  assert.match(parseArguments(["--nope"]).error, /unknown argument: --nope/u);
  assert.match(parseArguments(["--max-bytes=zero"]).error, /invalid --max-bytes/u);
});

test("CLI: violations exit 1, a clean tree exits 0, and --json is machine readable", async (t) => {
  const dirty = await createFixture(t, { "notes.md": `server ${PROD_IP}\n` });
  const dirtyRun = await runCli([`--root=${dirty}`]);
  assert.equal(dirtyRun.code, 1);
  assert.match(dirtyRun.stdout, /SUMMARY scope=tree violations=\d+ .*exit=1/u);

  const clean = await createFixture(t, { "README.md": "public\n", "src/app.ts": "export const a = 1;\n" });
  assert.equal((await runCli([`--root=${clean}`])).code, 0);

  const json = await runCli([`--root=${dirty}`, "--json"]);
  const parsed = JSON.parse(json.stdout);
  assert.equal(json.code, 1);
  assert.equal(parsed.check, "public-repo-hygiene");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.scope, "tree");
  assert.equal(parsed.violations ?? parsed.violationCount, parsed.violationCount);
  assert.equal(parsed.findings[0].rule, "prod-ip");
  assert.equal(parsed.exitCode, 1);
});

test("CLI: --public-only is the green mixed-repository gate, and bad input exits 2", async (t) => {
  const mixed = await createFixture(t, {
    "README.md": "public\n",
    "docs/superpowers/plan.md": `internal server ${PROD_IP}\n`,
  });

  // The whole-tree gate fails on the mixed repository (as it must).
  assert.equal((await runCli([`--root=${mixed}`])).code, 1);
  // The public-subset gate is the meaningful one for the working tree.
  const publicOnly = await runCli([`--root=${mixed}`, "--public-only", "--strict"]);
  assert.equal(publicOnly.code, 0);
  assert.match(publicOnly.stdout, /SUMMARY scope=public-subset violations=0/u);

  assert.equal((await runCli(["--unknown"])).code, 2);
  assert.equal((await runCli([`--root=${path.join(mixed, "missing")}`])).code, 2);
});

test("CLI: a fully classified clean tree passes strict mode on both scopes", async (t) => {
  const clean = await createFixture(t, {
    "README.md": "public\n",
    "LICENSE": "MIT\n",
    "package.json": "{}\n",
    "docs/adr/0001-thing.md": "decision\n",
    "scripts/migrations/001_init.sql": "select 1;\n",
    "AGENTS.md": "architecture\n",
  });

  // Every path in this fixture is classified public or private, so nothing is unclassified and no
  // sensitive content exists: strict mode is green on both the whole tree and the public subset.
  assert.equal((await runCli([`--root=${clean}`, "--strict"])).code, 0);
  assert.equal((await runCli([`--root=${clean}`, "--strict", "--public-only"])).code, 0);
});
