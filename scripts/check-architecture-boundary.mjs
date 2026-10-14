#!/usr/bin/env node
/**
 * Architecture boundary check: the creation core must not depend on SaaS modules.
 *
 * ## Why this exists
 *
 * The local-first / open-source plan (a research note kept in the private ops repository, §4.2)
 * rejects a two-repository split. Instead it keeps one repository and enforces a **one-way
 * dependency rule** in code so the boundary cannot silently erode while the refactor is in flight:
 *
 *     saas  -> core   allowed   (the hosted product is a downstream of the same core)
 *     core  -> saas   VIOLATION (the creation core must never reach into billing/membership/community)
 *
 * Phase 0 only *reports*. `--enforce` turns the same rule into a non-zero exit code once the
 * known baseline is burned down.
 *
 * ## Classification (single source of truth)
 *
 * The tables below are the rule set. They are deliberately hard-coded rather than inferred from
 * the working tree, because "which module is SaaS" is a product decision, not a filesystem fact.
 * Classification is applied to the path relative to `packages/novel-agents/`, first matching rule
 * wins, and **everything not listed is core**:
 *
 *   1. `auth/`, `billing/`, `community/`, `referral/`, `registration/`, `scheduler/` directories.
 *      Rationale: these are SaaS subsystems the report marks as "SaaS 专属" — identity/accounts,
 *      credits+payments+membership, the community content service, invite/referral growth loops,
 *      email-verified signup, and the server-side cron scheduler that talks to Postgres directly.
 *      A local single-user mode has no use for any of them.
 *   2. `server/routes/{credits,payments,membership,profile,referrals,registration,community,settings}.ts`.
 *      Rationale: HTTP entry points that exist only to serve the hosted product's business surface
 *      (billing, entitlement, account profile, growth, community, workspace settings).
 *   3. `lib/db/{community,credits,membership,purchases,referrals,registration,users}.ts`.
 *      Rationale: SQL/PostgREST domain modules backing the SaaS tables listed in the report
 *      (community 9, referral 8, credits 5, registration 3, membership 2, users). Note that the
 *      `lib/db.ts` facade itself stays core: it is connection plumbing, and domain modules hang
 *      off it.
 *   4. `lib/{credits,pricing,zpay,lingqi,indexnow,baidu-submit}.ts`.
 *      Rationale: credit accounting, price tables, the zpay payment gateway, the hosted-service
 *      model catalog/runtime (`lingqi`), and SEO submission to IndexNow/Baidu.
 *      (`usage-tracker` left this group on 2026-10-10 — see the note on SAAS_LIB_MODULES.)
 *
 * Not in the table (deliberately still core, listed here to avoid re-litigating it):
 * `lib/auth.ts` (token verification used by both modes), `lib/byok*.ts` (bring-your-own-key is a
 * local-mode feature too), `server/routes/byok.ts`, `model-runtime/`, `lib/chat-trace.ts`, and
 * since the policy-port refactor `lib/usage-tracker.ts` (meters turns against a core-owned port).
 * Those are *candidates* for a later reclassification with the team; they are not violations today.
 *
 * ## Layers: why a composition root may import implementations
 *
 * "core must not import saas" is the *domain* rule. Applied verbatim to the whole tree it also
 * flags the **composition root** — the modules whose only job is to know every implementation so
 * that it can inject the SaaS ones into the core's ports. A composition root cannot satisfy
 * "do not import the implementation" and still do its job; requiring that would make the rule
 * unsatisfiable rather than violated. So the rule is layered:
 *
 *   - `domain`            (default core) — the creation core itself. **Enforced.** `--enforce`
 *                          fails on these edges. This is the boundary Phase 0 must burn down.
 *   - `composition-root`  — the deployment-specific spine (process entrypoint, route table,
 *                          per-request service factory). Exempt, because every one of its SaaS
 *                          imports exists to construct or inject that implementation. The list is
 *                          deliberately tiny, hard-coded with a one-line reason per file, and
 *                          locked by a test: growing it requires editing the test first.
 *   - `facade`            — `lib/db.ts`, the cross-domain DB facade. `DbClient` is the class every
 *                          core module talks to; its SaaS domain re-exports (`lib/db/<saas>.ts`)
 *                          are one-line delegations. They are **not** counted as domain
 *                          violations, but they are counted and printed separately so the
 *                          dependency is never invisible.
 *   - `saas`              — the hosted-product subsystems. They may import anything.
 *
 * `server/routes/*.ts` are **not** exempt as a group. A route module is a product handler: it holds
 * request policy, entitlement branching and response shape for one feature. Exempting the whole
 * directory would exempt the very coupling the rule exists to catch, and the domain list already
 * names `server/routes/{chat,documents,projects,sessions,tasks}.ts` as core handlers that must not
 * reach into SaaS.
 *
 * ### `server/http.ts` is a rejected composition-root candidate (see the constant below)
 *
 * It was proposed as a fourth exempt file ("HTTP context types"). Inspection shows it is mixed:
 * the `RouteContext` service types are injection shape, but `parseApiTokenCreateInput()` is a live
 * validator that reads the SaaS scope catalog (`API_SCOPES[...].delegable`) and hard-codes the SaaS
 * lifetime/preset policy, duplicating `auth/api-token-service.ts`. That is neither wiring, nor
 * types, nor a factory — and a local-only build without `auth/` cannot compile past it. It stays
 * classified `domain` until either the validator moves back into the SaaS layer or the file is
 * split. `REJECTED_COMPOSITION_ROOT_CANDIDATES` carries the evidence so the decision is reviewable
 * instead of implicit.
 *
 * ## Anti-gaming contract: two numbers, always
 *
 * The text and JSON reports always expose **two independent counts**:
 *
 *   - `total=`  the raw core -> saas edge count. It must never fall just because a layer was
 *               introduced; exempt edges stay in `total` and are still printed individually.
 *   - `domain=` the edges that the rule actually enforces. `--enforce` is decided by this number.
 *
 * A report that only shows one of them, or that shrinks `total` by reclassifying SaaS files as
 * core, is a regression of the check itself.
 *
 * ## What the scanner looks at
 *
 * - every `.ts` file under `packages/novel-agents/` (also `.mts` / `.cts`), skipping `*.test.ts`, `*.spec.ts`,
 *   `__tests__/`, `*.d.ts`, `node_modules/`, `coverage/`, `dist/` and dot-directories.
 * - Static `import ... from "..."`, `export ... from "..."`, side-effect `import "..."`, and
 *   dynamic `import("...")` / type-position `import("...")` specifiers. Comments are blanked out
 *   first so commented-out imports do not count.
 * - Specifiers are resolved inside the package only. NodeNext ESM maps `./x.js` to source
 *   `./x.ts`, so `.js` / `.mjs` / `.cjs` specifiers resolve to their TypeScript source. Bare
 *   package specifiers (`node:fs`, `@earendil-works/pi-ai`) are external and ignored; relative
 *   specifiers that escape the package or do not resolve are collected as "unresolved" and never
 *   counted as violations. That keeps the scan tolerant of files another contributor is editing.
 * - Reported line numbers point at the start of the import statement (ESLint convention), so a
 *   multi-line import clause reports its first line.
 *
 * Known limitation: CommonJS `require(...)` and `import x = require(...)` are not scanned. The
 * package is ESM-only and contains neither today (verified 2026-10-10); if one is ever added, this
 * script needs the extra pattern.
 *
 * ## Phase 0 baseline (informational, never used for pass/fail)
 *
 * Measured on 2026-10-10 on branch `feat/local-first`, before any boundary work landed:
 *   violations = 53 core -> saas edges, 47 files involved, of which 45 are runtime edges and
 *   8 are type-only edges.
 * The largest clusters are the server spine that wires SaaS subsystems into the HTTP server
 * (`server.ts`, `server/router.ts`, `server/http.ts`, `server/runtime.ts`), the `lib/db.ts` facade
 * re-exporting SaaS domain modules, and the chat request path (`server/routes/chat.ts` importing
 * credits/entitlements). See PHASE0_BASELINE below. The count is reported as a delta so the
 * baseline can be watched down without the script ever hard-coding a "green" result.
 *
 * The domain baseline is the *planned* Phase 0 domain budget of 11, i.e. the count that a
 * four-file composition root would produce. This run measures 17 because `server/http.ts` was
 * rejected as a non-wiring file (6 edges: 2 runtime + 4 type-only), so `domain-delta` is positive
 * by design and self-explanatory. Both numbers are printed, and neither is allowed to hide the
 * other.
 *
 * ## Usage
 *
 *   node scripts/check-architecture-boundary.mjs                 # report only, exit 0
 *   node scripts/check-architecture-boundary.mjs --report        # same, explicit
 *   node scripts/check-architecture-boundary.mjs --enforce       # exit 1 when domain violations exist
 *   node scripts/check-architecture-boundary.mjs --json          # machine-readable report
 *   node scripts/check-architecture-boundary.mjs --root=<dir>    # scan another package root
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CORE = "core";
export const SAAS = "saas";

/** Layers are orthogonal to `core`/`saas`: they say *which* core file is allowed to import SaaS. */
export const LAYER_SAAS = "saas";
export const LAYER_DOMAIN = "domain";
export const LAYER_COMPOSITION_ROOT = "composition-root";
export const LAYER_FACADE = "facade";

/** Path relative to a package root inside the repository, e.g. `packages/novel-agents`. */
const DEFAULT_PACKAGE_ROOT = "packages/novel-agents";

/** TypeScript source extensions that are scanned as importers. */
const SOURCE_EXTENSIONS = Object.freeze([".ts", ".mts", ".cts"]);
/** Extensions NodeNext resolution may map a specifier onto, in probe order. */
const RESOLUTION_EXTENSIONS = Object.freeze([".ts", ".mts", ".cts", ".tsx"]);
/** Specifier extensions that point at emitted JavaScript for a TypeScript source file. */
const EMITTED_EXTENSIONS = Object.freeze([".js", ".mjs", ".cjs", ".jsx"]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", "coverage", "dist", "build", "out", "test-results",
]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/** SaaS package-root directories. */
export const SAAS_DIRECTORIES = Object.freeze([
  "auth",
  "billing",
  "community",
  "referral",
  "registration",
  "scheduler",
]);

/** SaaS HTTP route modules (`server/routes/<stem>.ts`). */
export const SAAS_SERVER_ROUTES = Object.freeze([
  "credits",
  "payments",
  "membership",
  "profile",
  "referrals",
  "registration",
  "community",
  "settings",
]);

/** SaaS database domain modules (`lib/db/<stem>.ts`). */
export const SAAS_DB_MODULES = Object.freeze([
  "community",
  "credits",
  "membership",
  "purchases",
  "referrals",
  "registration",
  "users",
]);

/**
 * SaaS library modules (`lib/<stem>.ts`).
 *
 * `usage-tracker` was removed on 2026-10-10. It metered turns against a
 * `Pick<CreditBillingClient, …>` type, which made the file itself SaaS; the policy-port
 * refactor (ADR 0006) replaced that with the core-owned `TurnUsageBilling` and repointed
 * its `PricingQuote` import at `usage-cost-types.ts`, so it now imports no SaaS module at
 * all. Metering *when* a turn is billed is a core concern; computing *what* it costs is
 * not. It is core by default now — if a SaaS import ever returns, this scanner flags it
 * again with no further edit here.
 */
export const SAAS_LIB_MODULES = Object.freeze([
  "credits",
  "pricing",
  "zpay",
  "lingqi",
  "indexnow",
  "baidu-submit",
]);

/**
 * The cross-domain DB facade. `lib/db.ts` owns the `DbClient` every core module talks to and
 * delegates each SaaS domain to `lib/db/<domain>.ts`, so its SaaS edges are counted separately
 * (never as domain violations) and always printed.
 */
export const FACADE_FILE = "lib/db.ts";

/**
 * The complete composition-root exemption list. Locked by
 * `scripts/check-architecture-boundary.test.mjs`: adding a file here without changing that test
 * fails the suite. Each entry states why the file is wiring rather than product logic.
 */
export const COMPOSITION_ROOT_FILES = Object.freeze([
  Object.freeze({
    path: "server.ts",
    reason: "Process entrypoint: it starts the workers, builds the live orchestrator and injects "
      + "the SaaS service instances into the HTTP dispatcher. Its SaaS imports are construction "
      + "and error-to-HTTP translation; it holds no product rule of its own.",
  }),
  Object.freeze({
    path: "server/router.ts",
    reason: "Declarative route table: it maps method+path to handler functions and nothing else. "
      + "Knowing which SaaS handlers exist is required to mount them.",
  }),
  Object.freeze({
    path: "server/runtime.ts",
    reason: "Per-request service factory: it constructs DbClient, the session runtime and the SaaS "
      + "services, and adapts core ports (billing, instruction loader) onto those instances. "
      + "Pure factory/adapter code.",
  }),
  Object.freeze({
    path: "server/http.ts",
    reason: "Generic HTTP helpers plus the `RouteContext` injection contract. Its only remaining "
      + "SaaS dependency is the four type-only service shapes the composition root injects. This "
      + "file was rejected as non-wiring on 2026-10-10 while it still held "
      + "`parseApiTokenCreateInput`; that SaaS token policy moved to server/routes/profile.ts, "
      + "which is what makes the exemption legitimate rather than a way to hide a runtime edge. "
      + "The type-only invariant is enforced by a test, not by this comment.",
  }),
]);

/**
 * Companion to the exemption list: files that were considered for the composition-root layer and
 * deliberately rejected, with the evidence. Keeping the rejection in code prevents a later reader
 * from "fixing" the domain count by silently re-adding the file.
 *
 * Currently empty. `server/http.ts` was the sole entry: rejected on 2026-10-10 because it carried
 * `parseApiTokenCreateInput()`, a live SaaS token-policy validator, in the shared HTTP spine. Its
 * prescribed remediation was applied — `parseApiTokenCreateInput` and `ApiTokenInputError` now live
 * in `server/routes/profile.ts` — which left only type-only `RouteContext` shapes and made the
 * exemption legitimate. If a runtime SaaS import ever returns to `server/http.ts`, take the file
 * back out of COMPOSITION_ROOT_FILES and record the rejection here again.
 */
export const REJECTED_COMPOSITION_ROOT_CANDIDATES = Object.freeze([]);

const COMPOSITION_ROOT_PATHS = new Set(COMPOSITION_ROOT_FILES.map((entry) => entry.path));

/**
 * Phase 0 violation baseline, measured on the current branch.
 * Purely informational: used to print a `delta` so burn-down is visible. It never decides pass/fail.
 */
export const PHASE0_BASELINE = Object.freeze({
  measuredAt: "2026-10-10",
  branch: "feat/local-first",
  violations: 53,
  files: 47,
  // `domainViolations` is the planned Phase 0 domain budget (the four-file composition root),
  // not a second measurement. `domainMeasuredAtBaseline` is what the layer split actually
  // measured on the same tree, so the gap caused by rejecting server/http.ts stays visible.
  domainViolations: 11,
  domainMeasuredAtBaseline: 17,
  domainNote: "planned Phase 0 domain budget, i.e. the count a four-file composition root would "
    + "produce before any burn-down. The layer split first measured 17 on this tree because "
    + "server/http.ts was rejected as non-wiring rather than exempted. The Phase 0 close-out then "
    + "did better than the budget: it moved the duplicated SaaS token policy out of server/http.ts "
    + "into server/routes/profile.ts (making the exemption legitimate) and sank the shared usage / "
    + "pricing value types into lib/usage-cost-types.ts, leaving 7 enforced domain edges. A negative "
    + "domain-delta therefore means the Phase 3 policy-port work is all that remains.",
  note: "the remaining enforced domain edges are the SaaS gates on the creative path: agents.ts "
    + "(CreditBillingClient), server/routes/chat.ts (credits + membership), "
    + "server/routes/{documents,projects}.ts (membership), tools/web-tools.ts (web_search "
    + "entitlement). Each needs a core-owned port that the SaaS layer implements, which is the "
    + "Phase 3 work. The composition root and the lib/db.ts facade are grouped separately because "
    + "a composition root must know every implementation it injects.",
});

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function stripExtension(fileName) {
  const extension = path.posix.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

/**
 * Classify one package-relative path as `saas` or `core`, and assign its architecture layer.
 * @returns {{ kind: string, rule: string, layer: string }}
 */
export function classifyModule(relativePath) {
  const normalized = normalizePath(String(relativePath)).replace(/^\.\//u, "");
  const segments = normalized.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  const stem = stripExtension(fileName);
  const directory = segments.slice(0, -1).join("/");

  // Rule 1: whole SaaS subsystem directories (nested files included).
  if (SAAS_DIRECTORIES.includes(segments[0])) {
    return { kind: SAAS, rule: `directory:${segments[0]}/`, layer: LAYER_SAAS };
  }
  // Rule 2: SaaS HTTP entry points.
  if (directory === "server/routes" && SAAS_SERVER_ROUTES.includes(stem)) {
    return { kind: SAAS, rule: "server/routes:<saas-route>.ts", layer: LAYER_SAAS };
  }
  // Rule 3: SaaS database domain modules.
  if (directory === "lib/db" && SAAS_DB_MODULES.includes(stem)) {
    return { kind: SAAS, rule: "lib/db/<saas-domain>.ts", layer: LAYER_SAAS };
  }
  // Rule 4: SaaS library modules.
  if (directory === "lib" && SAAS_LIB_MODULES.includes(stem)) {
    return { kind: SAAS, rule: "lib/<saas-module>.ts", layer: LAYER_SAAS };
  }
  // Layer split inside core. `rule` is unchanged so the classification summary stays comparable.
  if (COMPOSITION_ROOT_PATHS.has(normalized)) {
    return { kind: CORE, rule: "default:creation-core", layer: LAYER_COMPOSITION_ROOT };
  }
  if (normalized === FACADE_FILE) {
    return { kind: CORE, rule: "default:creation-core", layer: LAYER_FACADE };
  }
  // Default: the creation core itself, i.e. the layer `--enforce` guards.
  return { kind: CORE, rule: "default:creation-core", layer: LAYER_DOMAIN };
}

export function isRelativeSpecifier(specifier) {
  return specifier === "." || specifier === ".."
    || specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Resolve a relative import specifier to a scanned package-relative source file.
 * @returns {{ status: "resolved"|"external"|"outside-package"|"unresolved", target: string|null }}
 */
export function resolveSpecifier(specifier, importer, fileSet) {
  if (!isRelativeSpecifier(specifier)) return { status: "external", target: null };

  const importerDirectory = path.posix.dirname(importer);
  const joined = path.posix.normalize(path.posix.join(importerDirectory, specifier));
  if (joined === ".." || joined.startsWith("../")) {
    return { status: "outside-package", target: null };
  }

  const extension = path.posix.extname(joined);
  const candidates = [];
  if (EMITTED_EXTENSIONS.includes(extension)) {
    // NodeNext ESM imports name the emitted `.js` file; the scanned tree holds the `.ts` source.
    const withoutExtension = joined.slice(0, -extension.length);
    for (const candidateExtension of RESOLUTION_EXTENSIONS) candidates.push(withoutExtension + candidateExtension);
    candidates.push(joined);
  } else if (SOURCE_EXTENSIONS.includes(extension) || RESOLUTION_EXTENSIONS.includes(extension)) {
    candidates.push(joined);
  } else if (extension) {
    candidates.push(joined);
  } else {
    for (const candidateExtension of RESOLUTION_EXTENSIONS) candidates.push(joined + candidateExtension);
    for (const candidateExtension of RESOLUTION_EXTENSIONS) candidates.push(`${joined}/index${candidateExtension}`);
  }

  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return { status: "resolved", target: candidate };
  }
  return { status: "unresolved", target: null };
}

/**
 * Detect `import type ...` / `export type ...` / all-`type`-prefixed named imports.
 * The distinction matters for burn-down cost: a type-only edge is usually fixed by moving a type
 * into core, while a runtime edge needs a real extension point or port.
 */
export function isTypeOnlyStatement(statement) {
  if (/^(?:import|export)\s+type\b/u.test(statement)) return true;
  const namedClause = statement.match(/\{([\s\S]*)\}/u);
  if (!namedClause) return false;
  const entries = namedClause[1].split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return false;
  return entries.every((entry) => /^type\s/u.test(entry));
}

/** Blank out comments while preserving line structure, so line numbers stay valid. */
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:\w])\/\/[^\n]*/gu, (match, prefix) => prefix + " ".repeat(match.length - prefix.length));
}

const STATIC_FROM_PATTERN = /\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_PATTERN = /\bimport\s*["']([^"']+)["']/gu;
const DYNAMIC_PATTERN = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

/**
 * Extract every import/export specifier together with its source line.
 * @returns {Array<{ specifier: string, line: number, typeOnly: boolean }>}
 */
export function extractImportSpecifiers(source) {
  const scanned = blankComments(source);
  const found = [];
  for (const pattern of [STATIC_FROM_PATTERN, SIDE_EFFECT_PATTERN, DYNAMIC_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(scanned)) !== null) {
      found.push({
        specifier: match[1],
        line: lineOf(scanned, match.index),
        typeOnly: isTypeOnlyStatement(match[0]),
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

async function collectSourceFiles(packageRoot) {
  const files = [];

  async function visit(absoluteDirectory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return; // tolerate a directory disappearing or being rewritten mid-scan
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(path.join(absoluteDirectory, entry.name), relativeEntry);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.posix.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.includes(extension)) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (TEST_FILE_PATTERN.test(entry.name)) continue;
      if (relativeEntry.split("/").includes("__tests__")) continue;
      files.push(relativeEntry);
    }
  }

  await visit(path.resolve(packageRoot), "");
  return files.sort();
}

/**
 * Decide what the rule does with one core -> saas edge.
 * `total` counts all of them; only `domain` is enforced.
 */
function verdictForLayer(layer) {
  if (layer === LAYER_COMPOSITION_ROOT) return "composition-root-exempt";
  if (layer === LAYER_FACADE) return "facade-separate";
  return "domain";
}

function countBy(list, predicate) {
  return list.filter(predicate).length;
}

/**
 * Scan one package root and report core -> saas import edges.
 * Importers and imported files are classified with {@link classifyModule}.
 *
 * `violations` / `violationCount` are the raw total and never shrink when a layer is introduced;
 * `domainViolations` is the subset the rule enforces.
 */
export async function scanArchitectureBoundary({ packageRoot, classify = classifyModule }) {
  const absolutePackageRoot = path.resolve(packageRoot);
  const files = await collectSourceFiles(absolutePackageRoot);
  const fileSet = new Set(files);
  const classification = new Map();
  for (const file of files) classification.set(file, classify(file));

  const edges = new Map();
  const unresolved = [];
  let internalImportCount = 0;

  for (const importer of files) {
    let source;
    try {
      source = await readFile(path.join(absolutePackageRoot, importer), "utf8");
    } catch {
      continue; // tolerate a file being deleted between discovery and read
    }
    for (const { specifier, line, typeOnly } of extractImportSpecifiers(source)) {
      const resolution = resolveSpecifier(specifier, importer, fileSet);
      if (resolution.status === "external") continue;
      if (resolution.status !== "resolved") {
        unresolved.push({ importer, specifier, line, reason: resolution.status });
        continue;
      }
      internalImportCount += 1;
      const key = `${importer}\u0000${resolution.target}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { importer, imported: resolution.target, specifier, lines: [], typeOnly: true };
        edges.set(key, edge);
      }
      if (!edge.lines.includes(line)) edge.lines.push(line);
      // A single runtime import is enough to make the whole edge a runtime dependency.
      edge.typeOnly = edge.typeOnly && typeOnly;
    }
  }

  const violations = [];
  for (const edge of edges.values()) {
    const importerClassification = classification.get(edge.importer);
    const importedKind = classification.get(edge.imported).kind;
    if (importerClassification.kind !== CORE || importedKind !== SAAS) continue;
    const importerLayer = importerClassification.layer
      ?? (importerClassification.kind === SAAS ? LAYER_SAAS : LAYER_DOMAIN);
    const lines = [...edge.lines].sort((left, right) => left - right);
    violations.push({
      importer: edge.importer,
      importerKind: CORE,
      importerLayer,
      imported: edge.imported,
      importedKind,
      specifier: edge.specifier,
      line: lines[0],
      lines,
      occurrences: lines.length,
      typeOnly: edge.typeOnly,
      verdict: verdictForLayer(importerLayer),
    });
  }
  violations.sort((left, right) => (
    left.importer.localeCompare(right.importer)
    || left.imported.localeCompare(right.imported)
    || left.line - right.line
  ));

  const domainViolations = violations.filter((violation) => violation.verdict === "domain");
  const compositionRootViolations = violations.filter((violation) => violation.verdict === "composition-root-exempt");
  const facadeViolations = violations.filter((violation) => violation.verdict === "facade-separate");

  const involvedFiles = new Set();
  const domainFiles = new Set();
  for (const violation of violations) {
    involvedFiles.add(violation.importer);
    involvedFiles.add(violation.imported);
    if (violation.verdict === "domain") {
      domainFiles.add(violation.importer);
      domainFiles.add(violation.imported);
    }
  }

  const ruleSummary = new Map();
  const layerSummary = new Map();
  const saasFiles = [];
  let coreFileCount = 0;
  for (const file of files) {
    const { kind, rule, layer } = classification.get(file);
    const bucket = ruleSummary.get(rule) ?? { rule, kind, count: 0 };
    bucket.count += 1;
    ruleSummary.set(rule, bucket);
    layerSummary.set(layer, (layerSummary.get(layer) ?? 0) + 1);
    if (kind === SAAS) saasFiles.push({ path: file, rule });
    else coreFileCount += 1;
  }

  return {
    packageRoot: absolutePackageRoot,
    scannedFiles: files,
    scannedFileCount: files.length,
    coreFileCount,
    saasFileCount: saasFiles.length,
    saasFiles,
    classificationSummary: [...ruleSummary.values()].sort((left, right) => left.rule.localeCompare(right.rule)),
    layerSummary: [...layerSummary.entries()]
      .map(([layer, count]) => ({ layer, count }))
      .sort((left, right) => left.layer.localeCompare(right.layer)),
    internalImportCount,
    edgeCount: edges.size,
    violations,
    violationCount: violations.length,
    runtimeViolationCount: countBy(violations, (violation) => !violation.typeOnly),
    typeOnlyViolationCount: countBy(violations, (violation) => violation.typeOnly),
    domainViolations,
    domainViolationCount: domainViolations.length,
    domainRuntimeViolationCount: countBy(domainViolations, (violation) => !violation.typeOnly),
    domainTypeOnlyViolationCount: countBy(domainViolations, (violation) => violation.typeOnly),
    compositionRootViolations,
    compositionRootViolationCount: compositionRootViolations.length,
    compositionRootRuntimeViolationCount: countBy(compositionRootViolations, (violation) => !violation.typeOnly),
    compositionRootTypeOnlyViolationCount: countBy(compositionRootViolations, (violation) => violation.typeOnly),
    facadeViolations,
    facadeViolationCount: facadeViolations.length,
    facadeRuntimeViolationCount: countBy(facadeViolations, (violation) => !violation.typeOnly),
    facadeTypeOnlyViolationCount: countBy(facadeViolations, (violation) => violation.typeOnly),
    filesInvolved: involvedFiles.size,
    domainFilesInvolved: domainFiles.size,
    unresolved,
  };
}

/**
 * Build the machine-readable report consumed by the CLI and by CI.
 * `baseline` is informational only and never affects `exitCode`; `exitCode` is decided by the
 * *domain* violation count, never by the raw total.
 */
export function buildReport(scan, { mode = "report", packageRootLabel = DEFAULT_PACKAGE_ROOT, baseline = PHASE0_BASELINE, baselineApplies = true } = {}) {
  const exitCode = mode === "enforce" && scan.domainViolationCount > 0 ? 1 : 0;
  const applicableBaseline = baselineApplies ? baseline : null;
  const hasDomainBaseline = Number.isInteger(applicableBaseline?.domainViolations);
  return {
    schemaVersion: 1,
    check: "architecture-boundary",
    rule: "core must not import saas (saas -> core is allowed)",
    enforcedLayer: LAYER_DOMAIN,
    mode,
    packageRoot: packageRootLabel,
    scannedFileCount: scan.scannedFileCount,
    coreFileCount: scan.coreFileCount,
    saasFileCount: scan.saasFileCount,
    layerSummary: scan.layerSummary,
    internalImportCount: scan.internalImportCount,
    edgeCount: scan.edgeCount,
    // Raw total: every core -> saas edge, exempt ones included.
    violationCount: scan.violationCount,
    totalViolationCount: scan.violationCount,
    runtimeViolationCount: scan.runtimeViolationCount,
    typeOnlyViolationCount: scan.typeOnlyViolationCount,
    // Enforced subset: the creation core itself.
    domainViolationCount: scan.domainViolationCount,
    domainRuntimeViolationCount: scan.domainRuntimeViolationCount,
    domainTypeOnlyViolationCount: scan.domainTypeOnlyViolationCount,
    // Separately counted layers, so nothing is invisible.
    compositionRootViolationCount: scan.compositionRootViolationCount,
    compositionRootRuntimeViolationCount: scan.compositionRootRuntimeViolationCount,
    compositionRootTypeOnlyViolationCount: scan.compositionRootTypeOnlyViolationCount,
    facadeViolationCount: scan.facadeViolationCount,
    facadeRuntimeViolationCount: scan.facadeRuntimeViolationCount,
    facadeTypeOnlyViolationCount: scan.facadeTypeOnlyViolationCount,
    filesInvolved: scan.filesInvolved,
    domainFilesInvolved: scan.domainFilesInvolved,
    violations: scan.violations,
    compositionRootFiles: COMPOSITION_ROOT_FILES,
    rejectedCompositionRootCandidates: REJECTED_COMPOSITION_ROOT_CANDIDATES,
    saasFiles: scan.saasFiles,
    classificationSummary: scan.classificationSummary,
    unresolvedRelativeImports: scan.unresolved,
    baseline: applicableBaseline
      ? {
        ...applicableBaseline,
        delta: scan.violationCount - applicableBaseline.violations,
      }
      : null,
    domainBaseline: hasDomainBaseline
      ? {
        measuredAt: applicableBaseline.measuredAt,
        violations: applicableBaseline.domainViolations,
        measuredAtBaseline: Number.isInteger(applicableBaseline.domainMeasuredAtBaseline)
          ? applicableBaseline.domainMeasuredAtBaseline
          : null,
        note: applicableBaseline.domainNote ?? null,
        delta: scan.domainViolationCount - applicableBaseline.domainViolations,
      }
      : null,
    exitCode,
  };
}

function padKind(kind) {
  return kind.padEnd(Math.max(CORE.length, SAAS.length), " ");
}

function formatDelta(value) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

export function formatTextReport(report) {
  const lines = [];
  lines.push(`[architecture-boundary] rule: ${report.rule}`);
  lines.push(
    `[architecture-boundary] enforced layer: ${report.enforcedLayer} `
    + "(composition-root is exempt, the db facade is counted separately)",
  );
  lines.push(`[architecture-boundary] root: ${report.packageRoot} (mode=${report.mode})`);
  lines.push(
    `[architecture-boundary] scanned ${report.scannedFileCount} files `
    + `(core=${report.coreFileCount}, saas=${report.saasFileCount}, `
    + `classification rules=${report.classificationSummary.length})`,
  );
  lines.push(
    `[architecture-boundary] classification: ${report.classificationSummary
      .map((entry) => `${entry.rule}=${entry.count}`)
      .join(", ")}`,
  );
  lines.push(
    `[architecture-boundary] layers: ${report.layerSummary
      .map((entry) => `${entry.layer}=${entry.count}`)
      .join(", ")}`,
  );
  lines.push(
    `[architecture-boundary] violations: total=${report.totalViolationCount} `
    + `(runtime=${report.runtimeViolationCount}, type-only=${report.typeOnlyViolationCount}) across `
    + `${report.filesInvolved} file(s)`,
  );
  lines.push(
    `[architecture-boundary]   domain=${report.domainViolationCount} `
    + `(runtime=${report.domainRuntimeViolationCount}, type-only=${report.domainTypeOnlyViolationCount}) `
    + `<-- enforced by --enforce`,
  );
  lines.push(
    `[architecture-boundary]   composition-root=${report.compositionRootViolationCount} `
    + `(runtime=${report.compositionRootRuntimeViolationCount}, `
    + `type-only=${report.compositionRootTypeOnlyViolationCount}) <-- exempt; `
    + `locked list: ${report.compositionRootFiles.map((entry) => entry.path).join(", ")}`,
  );
  lines.push(
    `[architecture-boundary]   facade=${report.facadeViolationCount} `
    + `(runtime=${report.facadeRuntimeViolationCount}, type-only=${report.facadeTypeOnlyViolationCount}) `
    + `<-- counted separately (${FACADE_FILE})`,
  );
  for (const violation of report.violations) {
    const label = violation.verdict === "domain"
      ? "VIOLATION"
      : violation.verdict === "facade-separate" ? "FACADE" : "EXEMPT";
    lines.push(
      `[architecture-boundary]   ${label} ${violation.importer}:${violation.line} `
      + `${padKind(violation.importerKind)} -> ${padKind(violation.importedKind)} `
      + `${violation.imported} (specifier "${violation.specifier}", `
      + `${violation.typeOnly ? "type-only" : "runtime"}, x${violation.occurrences}, `
      + `layer=${violation.importerLayer})`,
    );
  }
  for (const candidate of report.rejectedCompositionRootCandidates) {
    lines.push(
      `[architecture-boundary] NOTE rejected composition-root candidate ${candidate.path}: `
      + `${candidate.reason}`,
    );
    for (const item of candidate.evidence) {
      lines.push(`[architecture-boundary]   evidence: ${item}`);
    }
    lines.push(`[architecture-boundary]   remediation: ${candidate.remediation}`);
  }
  if (report.unresolvedRelativeImports.length > 0) {
    const byReason = new Map();
    for (const entry of report.unresolvedRelativeImports) {
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    }
    lines.push(
      `[architecture-boundary] unresolved relative imports (not violations): ${report.unresolvedRelativeImports.length} `
      + `(${[...byReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ")})`,
    );
  }
  const baseline = report.baseline;
  const baselineLabel = baseline
    ? `baseline=${baseline.measuredAt}:${baseline.violations} delta=${formatDelta(baseline.delta)}`
    : "baseline=n/a";
  const domainBaseline = report.domainBaseline;
  const domainBaselineLabel = domainBaseline
    ? `domain-baseline=${domainBaseline.measuredAt}:${domainBaseline.violations} `
      + `domain-delta=${formatDelta(domainBaseline.delta)}`
    : "domain-baseline=n/a domain-delta=n/a";
  // Order matters: the first half of this line is a stable greppable contract that predates the
  // layer split, so the two anti-gaming numbers are appended at the end.
  lines.push(
    `[architecture-boundary] SUMMARY mode=${report.mode} violations=${report.violationCount} `
    + `runtime=${report.runtimeViolationCount} type-only=${report.typeOnlyViolationCount} `
    + `files=${report.filesInvolved} scanned=${report.scannedFileCount} ${baselineLabel} `
    + `exit=${report.exitCode} total=${report.totalViolationCount} domain=${report.domainViolationCount} `
    + `composition-root=${report.compositionRootViolationCount} facade=${report.facadeViolationCount} `
    + `${domainBaselineLabel}`,
  );
  if (domainBaseline) {
    lines.push(
      `[architecture-boundary] domain baseline note: ${domainBaseline.violations} is the planned `
      + "Phase 0 budget (four exempt server-spine files); the layer split measured "
      + `${domainBaseline.measuredAtBaseline} on the same tree because server/http.ts was rejected `
      + "as non-wiring. domain-delta is against the planned budget.",
    );
  }
  if (report.mode === "report" && report.domainViolationCount > 0) {
    lines.push(
      "[architecture-boundary] report-only mode: exiting 0. "
      + "--enforce judges the domain layer only, so re-run with --enforce once the domain baseline "
      + "is burned down (exempt composition-root and facade edges never block).",
    );
  }
  return lines.join("\n");
}

export function parseArguments(argv) {
  const options = { enforce: false, json: false, root: null, help: false };
  for (const argument of argv) {
    if (argument === "--enforce") options.enforce = true;
    // `--report` is the explicit spelling of the default mode; it never enables enforcement.
    else if (argument === "--report") options.enforce = false;
    else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--root=")) options.root = argument.slice("--root=".length);
    else return { options, error: `unknown argument: ${argument}` };
  }
  return { options, error: null };
}

export const USAGE = [
  "Usage: node scripts/check-architecture-boundary.mjs [options]",
  "",
  "Reports two numbers: total= (raw core -> saas edges, never reduced by layering) and",
  "domain= (the edges --enforce blocks). Composition-root wiring and the lib/db.ts facade are",
  "counted separately and printed, never hidden.",
  "",
  "Options:",
  "  --report      report only, exit 0 (default)",
  "  --enforce     exit 1 when a core *domain* -> saas import exists",
  "  --json        print the machine-readable JSON report instead of the text report",
  "  --root=<dir>  scan another package root (relative to the repository root)",
  "  -h, --help    show this help",
].join("\n");

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { options, error } = parseArguments(process.argv.slice(2));
  if (error) {
    console.error(`[architecture-boundary] ${error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const packageRootLabel = options.root ?? DEFAULT_PACKAGE_ROOT;
  const packageRoot = path.resolve(repositoryRoot, packageRootLabel);
  if (!(await isDirectory(packageRoot))) {
    console.error(`[architecture-boundary] package root not found: ${packageRoot}`);
    process.exitCode = 2;
    return;
  }

  const scan = await scanArchitectureBoundary({ packageRoot });
  const report = buildReport(scan, {
    mode: options.enforce ? "enforce" : "report",
    packageRootLabel: normalizePath(packageRootLabel),
    baselineApplies: options.root === null,
  });

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatTextReport(report)}\n`);

  process.exitCode = report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
