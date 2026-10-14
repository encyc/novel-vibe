import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CORE,
  COMPOSITION_ROOT_FILES,
  LAYER_COMPOSITION_ROOT,
  LAYER_DOMAIN,
  LAYER_FACADE,
  LAYER_SAAS,
  PHASE0_BASELINE,
  REJECTED_COMPOSITION_ROOT_CANDIDATES,
  SAAS,
  buildReport,
  classifyModule,
  extractImportSpecifiers,
  formatTextReport,
  isTypeOnlyStatement,
  parseArguments,
  resolveSpecifier,
  scanArchitectureBoundary,
} from "./check-architecture-boundary.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(new URL("./check-architecture-boundary.mjs", import.meta.url));
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

async function createFixture(t, files) {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "novel-vibe-boundary-"));
  t.after(() => rm(packageRoot, { force: true, recursive: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(packageRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return packageRoot;
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

// ─── classification table ────────────────────────────────────────────────────

test("classifies whole SaaS subsystem directories, including nested files", () => {
  for (const directory of ["auth", "billing", "community", "referral", "registration", "scheduler"]) {
    for (const relativePath of [`${directory}/service.ts`, `${directory}/nested/deep.ts`]) {
      const result = classifyModule(relativePath);
      assert.equal(result.kind, SAAS, `${relativePath} should be saas`);
      assert.equal(result.rule, `directory:${directory}/`);
    }
  }
});

test("classifies SaaS HTTP route modules only", () => {
  const saasRoutes = [
    "credits", "payments", "membership", "profile",
    "referrals", "registration", "community", "settings",
  ];
  for (const route of saasRoutes) {
    const result = classifyModule(`server/routes/${route}.ts`);
    assert.equal(result.kind, SAAS, `server/routes/${route}.ts should be saas`);
    assert.equal(result.rule, "server/routes:<saas-route>.ts");
  }
  assert.equal(classifyModule("server/routes/documents.ts").kind, CORE);
  assert.equal(classifyModule("server/routes/chat.ts").kind, CORE);
  assert.equal(classifyModule("server/routes/sessions.ts").kind, CORE);
  // Only the route directory is matched, not a same-named file elsewhere.
  assert.equal(classifyModule("server/credits.ts").kind, CORE);
});

test("classifies SaaS database domain modules but keeps the db facade core", () => {
  for (const domain of [
    "community", "credits", "membership", "purchases", "referrals", "registration", "users",
  ]) {
    const result = classifyModule(`lib/db/${domain}.ts`);
    assert.equal(result.kind, SAAS, `lib/db/${domain}.ts should be saas`);
    assert.equal(result.rule, "lib/db/<saas-domain>.ts");
  }
  assert.equal(classifyModule("lib/db/documents.ts").kind, CORE);
  assert.equal(classifyModule("lib/db/sessions.ts").kind, CORE);
  // The DbClient facade is connection plumbing and stays core.
  assert.equal(classifyModule("lib/db.ts").kind, CORE);
  assert.equal(classifyModule("lib/db.ts").rule, "default:creation-core");
});

test("classifies SaaS library modules only", () => {
  for (const module of [
    "credits", "pricing", "zpay", "lingqi", "indexnow", "baidu-submit",
  ]) {
    const result = classifyModule(`lib/${module}.ts`);
    assert.equal(result.kind, SAAS, `lib/${module}.ts should be saas`);
    assert.equal(result.rule, "lib/<saas-module>.ts");
  }
  // `lib/usage-tracker.ts` left the SaaS group on 2026-10-10: the policy-port refactor
  // replaced its `Pick<CreditBillingClient, …>` parameter with the core-owned
  // `TurnUsageBilling`, so it imports no SaaS module any more (ADR 0006).
  assert.equal(classifyModule("lib/usage-tracker.ts").kind, CORE);
  for (const relativePath of [
    "lib/storage.ts", "lib/content-store.ts", "lib/frontmatter.ts", "lib/skills.ts",
    "lib/auth.ts", "lib/byok.ts", "lib/chat-trace.ts",
    "agents.ts", "server.ts", "server/router.ts", "server/http.ts", "server/runtime.ts",
    "tools/web-tools.ts", "session/compactor.ts", "context/types.ts", "commands/agent-resources.ts",
  ]) {
    assert.equal(classifyModule(relativePath).kind, CORE, `${relativePath} should be core`);
  }
});

test("normalizes platform separators and a leading ./ before classifying", () => {
  assert.equal(classifyModule("./lib/credits.ts").kind, SAAS);
  assert.equal(classifyModule("lib\\credits.ts".split("\\").join(path.sep)).kind, SAAS);
});

// ─── specifier resolution ────────────────────────────────────────────────────

test("resolves NodeNext .js specifiers onto TypeScript sources", () => {
  const fileSet = new Set(["lib/credits.ts", "server/routes/chat.ts"]);
  assert.deepEqual(
    resolveSpecifier("../../lib/credits.js", "server/routes/chat.ts", fileSet),
    { status: "resolved", target: "lib/credits.ts" },
  );
});

test("resolves extensionless and directory-index specifiers", () => {
  const fileSet = new Set(["lib/storage.ts", "lint/index.ts", "context/types.mts"]);
  assert.deepEqual(
    resolveSpecifier("./storage", "lib/anything.ts", fileSet),
    { status: "resolved", target: "lib/storage.ts" },
  );
  assert.deepEqual(
    resolveSpecifier("../lint", "server/router.ts", fileSet),
    { status: "resolved", target: "lint/index.ts" },
  );
  assert.deepEqual(
    resolveSpecifier("./types.mts", "context/manager.ts", fileSet),
    { status: "resolved", target: "context/types.mts" },
  );
});

test("separates external, outside-package and unresolved specifiers", () => {
  const fileSet = new Set(["lib/storage.ts"]);
  assert.deepEqual(
    resolveSpecifier("node:fs", "lib/storage.ts", fileSet),
    { status: "external", target: null },
  );
  assert.deepEqual(
    resolveSpecifier("@earendil-works/pi-ai", "lib/storage.ts", fileSet),
    { status: "external", target: null },
  );
  assert.deepEqual(
    resolveSpecifier("../../../scripts/migrations/001.sql", "lib/storage.ts", fileSet),
    { status: "outside-package", target: null },
  );
  // A file another contributor has not created yet must not crash or count as a violation.
  assert.deepEqual(
    resolveSpecifier("./not-created-yet.js", "lib/storage.ts", fileSet),
    { status: "unresolved", target: null },
  );
});

// ─── specifier extraction ────────────────────────────────────────────────────

test("extracts static, side-effect and dynamic specifiers with line numbers", () => {
  const source = [
    'import { a } from "./a.js";',
    'import type { B } from "./b.js";',
    'export { c } from "./c.js";',
    'import "./side-effect.js";',
    'const lazy = () => import("./d.js");',
    'const t: import("./e.js").T = {} as never;',
  ].join("\n");
  const specifiers = extractImportSpecifiers(source);
  assert.deepEqual(
    specifiers.map((entry) => [entry.specifier, entry.line, entry.typeOnly]),
    [
      ["./a.js", 1, false],
      ["./b.js", 2, true],
      ["./c.js", 3, false],
      ["./side-effect.js", 4, false],
      ["./d.js", 5, false],
      ["./e.js", 6, false],
    ],
  );
});

test("handles multi-line import clauses and all-type named imports", () => {
  const source = [
    "import {",
    "  type Usage,",
    '} from "../lib/credits.js";',
    "import {",
    "  runtimeThing,",
    "  type TypeThing,",
    '} from "../lib/mixed.js";',
  ].join("\n");
  const specifiers = extractImportSpecifiers(source);
  // Reported line is where the import statement starts, like ESLint.
  assert.deepEqual(
    specifiers.map((entry) => [entry.specifier, entry.line, entry.typeOnly]),
    [
      ["../lib/credits.js", 1, true],
      ["../lib/mixed.js", 4, false],
    ],
  );
});

test("ignores commented-out imports and marks type-only statements", () => {
  const source = [
    '// import { gone } from "../lib/zpay.js";',
    "/*",
    'import { alsoGone } from "../lib/pricing.js";',
    "*/",
    'import { realThing } from "../lib/credits.js";',
  ].join("\n");
  const specifiers = extractImportSpecifiers(source);
  assert.deepEqual(specifiers, [{ specifier: "../lib/credits.js", line: 5, typeOnly: false }]);
  assert.equal(isTypeOnlyStatement("import type { A } from \"x\";"), true);
  assert.equal(isTypeOnlyStatement("export type { A } from \"x\";"), true);
  assert.equal(isTypeOnlyStatement("import { type A, type B } from \"x\";"), true);
  assert.equal(isTypeOnlyStatement("import { type A, B } from \"x\";"), false);
  assert.equal(isTypeOnlyStatement("import \"x\";"), false);
  assert.equal(isTypeOnlyStatement('import("x")'), false);
});

// ─── scanning ────────────────────────────────────────────────────────────────

test("flags core -> saas edges and allows saas -> core, core -> core and saas -> saas", async (t) => {
  const packageRoot = await createFixture(t, {
    "server/routes/chat.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "server/routes/documents.ts": 'import { StorageClient } from "../../lib/storage.js";\n',
    "lib/storage.ts": 'import { DbClient } from "./db.js";\nexport class StorageClient {}\n',
    "lib/db.ts": "export class DbClient {}\n",
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
    "billing/entitlements.ts": 'import { StorageClient } from "../lib/storage.js";\nexport const ok = StorageClient;\n',
    "community/service.ts": 'import { consumeCredits } from "../lib/credits.js";\nexport const c = consumeCredits;\n',
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.violationCount, 1);
  assert.deepEqual(
    result.violations.map((violation) => ({
      importer: violation.importer,
      imported: violation.imported,
      line: violation.line,
      typeOnly: violation.typeOnly,
    })),
    [{ importer: "server/routes/chat.ts", imported: "lib/credits.ts", line: 1, typeOnly: false }],
  );
  assert.equal(result.runtimeViolationCount, 1);
  assert.equal(result.typeOnlyViolationCount, 0);
  assert.equal(result.scannedFileCount, 7);
});

test("flags dynamic core -> saas imports and reports type-only edges separately", async (t) => {
  const packageRoot = await createFixture(t, {
    "session/compactor.ts": 'export const load = () => import("../lib/pricing.js");\n',
    "context/types.ts": 'import type { Usage } from "../lib/credits.js";\nexport type T = Usage;\n',
    "lib/pricing.ts": "export type PricingQuote = { total: number };\n",
    "lib/credits.ts": "export type Usage = { tokens: number };\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.violationCount, 2);
  assert.equal(result.runtimeViolationCount, 1);
  assert.equal(result.typeOnlyViolationCount, 1);
  const byImporter = new Map(result.violations.map((violation) => [violation.importer, violation]));
  assert.equal(byImporter.get("session/compactor.ts").typeOnly, false);
  assert.equal(byImporter.get("context/types.ts").typeOnly, true);
});

test("skips test files and tolerates unresolved or external specifiers", async (t) => {
  const packageRoot = await createFixture(t, {
    "lib/credits.test.ts": 'import { consumeCredits } from "../lib/credits.js";\n',
    "server/routes/chat.spec.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "server/routes/__tests__/helper.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "lib/consumer.ts": [
      'import fs from "node:fs";',
      'import { pending } from "./written-by-a-teammate-later.js";',
      'import "../../../scripts/migrations/001.sql";',
      'export const value = [fs, pending];',
    ].join("\n"),
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
    "server/routes/chat.ts": "export const chat = 1;\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.violationCount, 0);
  assert.equal(result.scannedFileCount, 3);
  assert.deepEqual(
    result.unresolved.map((entry) => [entry.importer, entry.specifier, entry.reason]),
    [
      ["lib/consumer.ts", "./written-by-a-teammate-later.js", "unresolved"],
      ["lib/consumer.ts", "../../../scripts/migrations/001.sql", "outside-package"],
    ],
  );
});

test("keeps one entry per importer/imported edge and collapses repeated occurrences", async (t) => {
  const packageRoot = await createFixture(t, {
    "server.ts": [
      'import { a } from "./lib/credits.js";',
      'import { b } from "./lib/credits.js";',
      'import { c } from "./lib/pricing.js";',
    ].join("\n"),
    "lib/credits.ts": "export const a = 1; export const b = 2;\n",
    "lib/pricing.ts": "export const c = 3;\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.violationCount, 2);
  assert.equal(result.edgeCount, 2);
  assert.equal(result.internalImportCount, 3);
  const credits = result.violations.find((violation) => violation.imported === "lib/credits.ts");
  assert.deepEqual(credits.lines, [1, 2]);
  assert.equal(credits.occurrences, 2);
  assert.equal(credits.line, 1);
});

test("summarizes the classification table and scans the whole fixture tree", async (t) => {
  const packageRoot = await createFixture(t, {
    "auth/service.ts": "export const a = 1;\n",
    "billing/entitlements.ts": "export const b = 1;\n",
    "lib/credits.ts": "export const c = 1;\n",
    "lib/storage.ts": "export const d = 1;\n",
    "lib/db/users.ts": "export const e = 1;\n",
    "agents.ts": "export const f = 1;\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.scannedFileCount, 6);
  assert.equal(result.saasFileCount, 4);
  assert.equal(result.coreFileCount, 2);
  assert.deepEqual(
    result.saasFiles.map((entry) => entry.path),
    ["auth/service.ts", "billing/entitlements.ts", "lib/credits.ts", "lib/db/users.ts"],
  );
  assert.equal(result.classificationSummary.length, 5);
});

// ─── report and CLI contract ─────────────────────────────────────────────────

test("buildReport never fails the build in report mode and drives exit codes in enforce mode", async (t) => {
  const packageRoot = await createFixture(t, {
    "server/routes/chat.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
  });
  const scan = await scanArchitectureBoundary({ packageRoot });

  const report = buildReport(scan, { mode: "report", packageRootLabel: "fixture", baseline: null });
  assert.equal(report.exitCode, 0);
  assert.equal(report.violationCount, 1);
  assert.equal(report.runtimeViolationCount, 1);
  assert.equal(report.baseline, null);
  assert.equal(report.packageRoot, "fixture");

  const enforcing = buildReport(scan, { mode: "enforce", baseline: null });
  assert.equal(enforcing.exitCode, 1);

  const empty = await scanArchitectureBoundary({
    packageRoot: await createFixture(t, { "lib/storage.ts": "export const x = 1;\n" }),
  });
  assert.equal(buildReport(empty, { mode: "enforce", baseline: null }).exitCode, 0);
});

test("text report exposes a greppable SUMMARY line and every violation", async (t) => {
  const packageRoot = await createFixture(t, {
    "server/routes/chat.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
  });
  const scan = await scanArchitectureBoundary({ packageRoot });
  const text = formatTextReport(buildReport(scan, { mode: "report", packageRootLabel: "fixture", baseline: null }));

  assert.match(
    text,
    /SUMMARY mode=report violations=1 runtime=1 type-only=0 files=2 scanned=2 baseline=n\/a exit=0/u,
  );
  assert.match(text, /VIOLATION server\/routes\/chat\.ts:1 core -> saas\s+lib\/credits\.ts/u);
});

test("parseArguments rejects unknown flags and accepts the documented ones", () => {
  assert.deepEqual(
    parseArguments(["--enforce", "--json", "--root=packages/novel-agents"]).options,
    { enforce: true, json: true, root: "packages/novel-agents", help: false },
  );
  assert.match(parseArguments(["--nope"]).error, /unknown argument: --nope/u);
});

test("CLI: report mode exits 0 with violations, enforce mode exits 1", async (t) => {
  const packageRoot = await createFixture(t, {
    "server/routes/chat.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
  });

  const report = await runCli([`--root=${packageRoot}`]);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /violations=1 .*exit=0/u);

  const enforce = await runCli([`--root=${packageRoot}`, "--enforce"]);
  assert.equal(enforce.code, 1);

  const json = await runCli([`--root=${packageRoot}`, "--json"]);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.check, "architecture-boundary");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.mode, "report");
  assert.equal(parsed.violationCount, 1);
  assert.equal(parsed.violations[0].importer, "server/routes/chat.ts");
  assert.equal(parsed.baseline, null);
});

test("CLI: enforce mode exits 0 on a clean tree and 2 on bad input", async (t) => {
  const cleanRoot = await createFixture(t, { "lib/storage.ts": "export const x = 1;\n" });
  assert.equal((await runCli([`--root=${cleanRoot}`, "--enforce"])).code, 0);
  assert.equal((await runCli(["--unknown-flag"])).code, 2);
  assert.equal((await runCli([`--root=${path.join(cleanRoot, "does-not-exist")}`])).code, 2);
});

// ─── layers: composition root / facade / domain ──────────────────────────────

test("assigns architecture layers on top of the core/saas classification", () => {
  for (const file of ["server.ts", "server/router.ts", "server/runtime.ts"]) {
    const result = classifyModule(file);
    assert.equal(result.kind, CORE, `${file} stays core`);
    assert.equal(result.layer, LAYER_COMPOSITION_ROOT, `${file} is composition-root`);
    // Layering must not rewrite the classification rule, or the summary stops being comparable.
    assert.equal(result.rule, "default:creation-core");
  }
  assert.equal(classifyModule("lib/db.ts").kind, CORE);
  assert.equal(classifyModule("lib/db.ts").layer, LAYER_FACADE);
  assert.equal(classifyModule("lib/db.ts").rule, "default:creation-core");
  for (const file of [
    "agents.ts", "tools/web-tools.ts", "session/compactor.ts",
    "context/types.ts", "server/routes/chat.ts", "server/routes/documents.ts",
  ]) {
    assert.equal(classifyModule(file).layer, LAYER_DOMAIN, `${file} is domain`);
  }
  // server/http.ts was domain until 2026-10-10; its SaaS token policy moved into the SaaS route,
  // leaving only the type-only RouteContext injection contract.
  assert.equal(classifyModule("server/http.ts").layer, LAYER_COMPOSITION_ROOT);
  for (const file of [
    "auth/service.ts", "billing/entitlements.ts", "lib/credits.ts",
    "lib/db/users.ts", "server/routes/credits.ts",
  ]) {
    assert.equal(classifyModule(file).kind, SAAS, `${file} is saas`);
    assert.equal(classifyModule(file).layer, LAYER_SAAS, `${file} has the saas layer`);
  }
});

test("exempts composition-root wiring from the domain count but keeps it in the total", async (t) => {
  const packageRoot = await createFixture(t, {
    "server.ts": 'import { consumeCredits } from "./lib/credits.js";\n',
    "server/router.ts": 'import { creditsSummaryGet } from "./routes/credits.js";\n',
    "server/runtime.ts": 'import { CreditBillingClient } from "../lib/credits.js";\n',
    "server/routes/credits.ts": "export const creditsSummaryGet = 1;\n",
    "lib/credits.ts": "export function consumeCredits() { return 1; }\nexport class CreditBillingClient {}\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  // The raw total must never shrink because a layer was introduced.
  assert.equal(result.violationCount, 3);
  assert.equal(result.compositionRootViolationCount, 3);
  assert.equal(result.compositionRootRuntimeViolationCount, 3);
  assert.equal(result.domainViolationCount, 0);
  assert.equal(result.facadeViolationCount, 0);
  for (const violation of result.violations) {
    assert.equal(violation.importerKind, CORE);
    assert.equal(violation.importedKind, SAAS);
    assert.equal(violation.verdict, "composition-root-exempt");
  }

  const report = buildReport(result, { mode: "enforce", baseline: null });
  assert.equal(report.totalViolationCount, 3);
  assert.equal(report.domainViolationCount, 0);
  // Inevitable wiring must not block CI.
  assert.equal(report.exitCode, 0);
});

test("counts the db facade separately and never as a domain violation", async (t) => {
  const packageRoot = await createFixture(t, {
    "lib/db.ts": [
      'import { getUsers } from "./db/users.js";',
      'import { listDocuments } from "./db/documents.js";',
    ].join("\n"),
    "lib/db/users.ts": "export function getUsers() { return []; }\n",
    "lib/db/documents.ts": "export function listDocuments() { return []; }\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  // Only lib/db.ts -> lib/db/users.ts is core -> saas; lib/db/documents.ts is core.
  assert.equal(result.violationCount, 1);
  assert.equal(result.facadeViolationCount, 1);
  assert.equal(result.facadeRuntimeViolationCount, 1);
  assert.equal(result.domainViolationCount, 0);
  assert.equal(result.compositionRootViolationCount, 0);
  assert.equal(result.violations[0].importer, "lib/db.ts");
  assert.equal(result.violations[0].imported, "lib/db/users.ts");
  assert.equal(result.violations[0].verdict, "facade-separate");
  assert.equal(buildReport(result, { mode: "enforce", baseline: null }).exitCode, 0);
});

test("reports total and domain together in the same run", async (t) => {
  const packageRoot = await createFixture(t, {
    "server.ts": 'import { consumeCredits } from "./lib/credits.js";\n',
    "lib/db.ts": 'import { getUsers } from "./db/users.js";\n',
    "server/routes/chat.ts": 'import { checkEntitlement } from "../../billing/entitlements.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
    "lib/db/users.ts": "export function getUsers() { return []; }\n",
    "billing/entitlements.ts": "export function checkEntitlement() { return true; }\n",
  });

  const result = await scanArchitectureBoundary({ packageRoot });

  assert.equal(result.violationCount, 3);
  assert.equal(result.compositionRootViolationCount, 1);
  assert.equal(result.facadeViolationCount, 1);
  assert.equal(result.domainViolationCount, 1);
  assert.equal(
    result.violationCount,
    result.compositionRootViolationCount + result.facadeViolationCount + result.domainViolationCount,
  );

  const report = buildReport(result, { mode: "report", packageRootLabel: "fixture", baseline: null });
  assert.equal(report.totalViolationCount, 3);
  assert.equal(report.domainViolationCount, 1);
  assert.equal(report.enforcedLayer, LAYER_DOMAIN);

  const text = formatTextReport(report);
  assert.match(text, /SUMMARY .*total=3 domain=1/u);
  assert.match(text, /VIOLATION server\/routes\/chat\.ts:1 core -> saas\s+billing\/entitlements\.ts/u);
  assert.match(text, /EXEMPT server\.ts:1/u);
  assert.match(text, /FACADE lib\/db\.ts:1/u);
  // Every edge is listed, including the ones the rule does not enforce.
  assert.equal(text.split("\n").filter((line) => /(?:VIOLATION|EXEMPT|FACADE) /u.test(line)).length, 3);
});

test("enforce is decided by the domain layer, not by the raw total", async (t) => {
  const exemptOnly = await scanArchitectureBoundary({
    packageRoot: await createFixture(t, {
      "server/router.ts": 'import { creditsSummaryGet } from "./routes/credits.js";\n',
      "server/routes/credits.ts": "export const creditsSummaryGet = 1;\n",
    }),
  });
  assert.equal(exemptOnly.violationCount, 1);
  assert.equal(exemptOnly.domainViolationCount, 0);
  assert.equal(buildReport(exemptOnly, { mode: "enforce", baseline: null }).exitCode, 0);

  const facadeOnly = await scanArchitectureBoundary({
    packageRoot: await createFixture(t, {
      "lib/db.ts": 'import { getUsers } from "./db/users.js";\n',
      "lib/db/users.ts": "export function getUsers() { return []; }\n",
    }),
  });
  assert.equal(facadeOnly.violationCount, 1);
  assert.equal(facadeOnly.domainViolationCount, 0);
  assert.equal(buildReport(facadeOnly, { mode: "enforce", baseline: null }).exitCode, 0);

  const withDomain = await scanArchitectureBoundary({
    packageRoot: await createFixture(t, {
      "lib/db.ts": 'import { getUsers } from "./db/users.js";\n',
      "lib/db/users.ts": "export function getUsers() { return []; }\n",
      "agents.ts": 'import { consumeCredits } from "./lib/credits.js";\n',
      "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
    }),
  });
  assert.equal(withDomain.violationCount, 2);
  assert.equal(withDomain.domainViolationCount, 1);
  assert.equal(buildReport(withDomain, { mode: "enforce", baseline: null }).exitCode, 1);
});

test("CLI: enforce ignores composition-root and facade edges in a fixture tree", async (t) => {
  const packageRoot = await createFixture(t, {
    "server.ts": 'import { consumeCredits } from "./lib/credits.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
  });

  const report = await runCli([`--root=${packageRoot}`]);
  assert.equal(report.code, 0);
  assert.match(report.stdout, /total=1 domain=0/u);
  assert.equal((await runCli([`--root=${packageRoot}`, "--enforce"])).code, 0);
});

// ─── guardrails: the exemption list is locked by tests ───────────────────────

test("locks the composition-root exemption list to the reviewed minimal set", () => {
  const paths = COMPOSITION_ROOT_FILES.map((entry) => entry.path);
  // Growing this list is a deliberate act: it must be changed here first.
  assert.deepEqual(paths, ["server.ts", "server/router.ts", "server/runtime.ts", "server/http.ts"]);
  assert.equal(new Set(paths).size, paths.length, "no duplicate entries");

  for (const entry of COMPOSITION_ROOT_FILES) {
    assert.equal(typeof entry.reason, "string", `${entry.path} needs a reason`);
    assert.ok(entry.reason.trim().length > 40, `${entry.path} needs a substantive reason`);
    // The list and the classifier must not drift apart.
    assert.equal(classifyModule(entry.path).layer, LAYER_COMPOSITION_ROOT, entry.path);
  }

  // These are product handlers / shared infrastructure, never wiring.
  for (const file of [
    "agents.ts", "server/routes/chat.ts", "server/routes/documents.ts",
    "lib/db.ts", "tools/web-tools.ts",
  ]) {
    assert.notEqual(classifyModule(file).layer, LAYER_COMPOSITION_ROOT, `${file} must not be exempt`);
  }
});

test("keeps the shared HTTP spine pure: server/http.ts may only hold type-only SaaS edges", async () => {
  // server/http.ts is exempt only because it holds generic helpers plus the `RouteContext`
  // injection contract. That was not always true: it once carried a live SaaS token-policy
  // validator, which is why it was rejected as non-wiring. The policy moved to
  // server/routes/profile.ts. This guard is what stops a future runtime SaaS import from hiding
  // behind COMPOSITION_ROOT_FILES — the list lock alone cannot see inside the file.
  const result = await scanArchitectureBoundary({
    packageRoot: path.join(REPOSITORY_ROOT, "packages/novel-agents"),
  });
  const spineEdges = result.violations.filter((violation) => violation.importer === "server/http.ts");
  // The RouteContext injection contract should still be visible, so this cannot pass vacuously.
  assert.ok(spineEdges.length > 0, "expected the RouteContext injection contract to be visible");
  for (const edge of spineEdges) {
    assert.equal(
      edge.typeOnly,
      true,
      `server/http.ts must not import SaaS values at runtime: ${edge.specifier}`,
    );
  }
  assert.equal(classifyModule("server/http.ts").layer, LAYER_COMPOSITION_ROOT);
  // Nothing is pending rejection now that the remediation landed.
  assert.deepEqual(REJECTED_COMPOSITION_ROOT_CANDIDATES, []);
});

test("keeps a domain baseline and prints it as a delta next to the total baseline", async (t) => {
  const packageRoot = await createFixture(t, {
    "server/routes/chat.ts": 'import { consumeCredits } from "../../lib/credits.js";\n',
    "lib/credits.ts": "export function consumeCredits() { return 1; }\n",
  });
  const scan = await scanArchitectureBoundary({ packageRoot });
  const report = buildReport(scan, { mode: "report", packageRootLabel: "fixture" });

  assert.equal(report.baseline.violations, 53);
  assert.equal(report.baseline.delta, 1 - 53);
  assert.equal(report.domainBaseline.measuredAt, "2026-10-10");
  assert.equal(report.domainBaseline.violations, 11);
  assert.equal(report.domainBaseline.violations, PHASE0_BASELINE.domainViolations);
  assert.equal(report.domainBaseline.measuredAtBaseline, 17);
  assert.equal(report.domainBaseline.delta, 1 - 11);

  const text = formatTextReport(report);
  assert.match(text, /SUMMARY .*baseline=2026-10-10:53 delta=-52 exit=0/u);
  assert.match(text, /total=1 domain=1/u);
  assert.match(text, /domain-baseline=2026-10-10:11 domain-delta=-10/u);
  assert.match(text, /domain baseline note:/u);
});

test("real package: total equals composition-root + facade + domain", async () => {
  const result = await scanArchitectureBoundary({
    packageRoot: path.join(REPOSITORY_ROOT, "packages/novel-agents"),
  });

  assert.ok(result.scannedFileCount > 100, `expected a full scan, got ${result.scannedFileCount}`);
  assert.equal(
    result.violationCount,
    result.compositionRootViolationCount + result.facadeViolationCount + result.domainViolationCount,
  );
  assert.ok(result.domainViolationCount <= result.violationCount);
  assert.ok(result.compositionRootViolationCount > 0, "the server spine still imports SaaS handlers");
  assert.ok(result.facadeViolationCount > 0, "lib/db.ts still forwards SaaS domain modules");

  const report = buildReport(result, { mode: "report", packageRootLabel: "packages/novel-agents" });
  const text = formatTextReport(report);
  assert.match(text, new RegExp(`total=${result.violationCount} domain=${result.domainViolationCount}`));
  assert.match(text, /layers: .*composition-root=4.*domain=.*facade=1.*saas=/u);
  // The rejected candidate was remediated on 2026-10-10: the SaaS token policy moved into the SaaS
  // route, so server/http.ts became legitimate wiring and no rejection remains pending.
  assert.doesNotMatch(text, /NOTE rejected composition-root candidate/u);
  // The enforced debt reached zero on 2026-10-10 with the policy-port refactor (ADR 0006):
  // every remaining core->saas edge is now either composition-root wiring or the lib/db.ts
  // facade. If this set becomes non-empty again the enforced layer has regressed — name the
  // offending files deliberately here rather than relaxing the rule.
  assert.deepEqual(
    [...new Set(result.domainViolations.map((violation) => violation.importer))].sort(),
    [],
  );
  assert.equal(result.domainViolationCount, 0, "the enforced domain layer must stay clean");
});

test("parseArguments accepts an explicit --report and never enables enforcement", () => {
  const explicit = parseArguments(["--report"]);
  assert.equal(explicit.error, null);
  assert.equal(explicit.options.enforce, false);
  // --report after --enforce turns enforcement back off; the option shape stays unchanged.
  assert.deepEqual(
    parseArguments(["--enforce", "--report"]).options,
    { enforce: false, json: false, root: null, help: false },
  );
});
