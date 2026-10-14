#!/usr/bin/env node
/**
 * Public-repo hygiene check.
 *
 * ## Why this exists
 *
 * The open-source split plan (see `docs/opensource/public-repo-manifest.md`) keeps the hosted
 * operations material in a private repository and publishes everything else. The boundary is
 * enforced at *file* level, but a file-level split is only as good as its leak check: a stray
 * production IP, an SSH alias, a real `.env`, or a committed certificate must never reach the
 * public tree, and a private path must never be published by accident.
 *
 * This script is the automated half of that review. It is deliberately independent from
 * `check-architecture-boundary.mjs`: that one governs *code dependency direction*, this one
 * governs *publication safety*. Both are reportable-only by default in CI and both are driven by
 * an explicit, reviewable rule table rather than by heuristics over git history.
 *
 * ## Scope and non-goals
 *
 * - It scans **the working tree it is pointed at** (`--root=<dir>`, default the repository root).
 *   It does not read git history. A file-level split is necessary but not sufficient: publishing
 *   with the existing history would still expose production identifiers recorded in old commits,
 *   so history curation is a separate, explicitly user-decided step (documented in the manifest).
 * - It reads text files up to `--max-bytes` (default 5 MB) and skips binaries, `node_modules/`,
 *   `.git/`, `.worktrees/` and build/cache output. Running it on the mixed repository root is
 *   expected to report findings — that is the point; running it on an exported public set must
 *   report nothing.
 * - Credential findings never echo the value: the report prints `<redacted len=N>` so a leak check
 *   cannot itself leak into CI logs.
 *
 * ## Rule table
 *
 * | rule | severity | what it catches |
 * |---|---|---|
 * | `prod-ip` | violation | any address under the production /16 prefix |
 * | `ssh-key-file-reference` | violation | the production SSH private-key file name and the root user's SSH directory |
 * | `operator-ssh-path` | violation | the operator SSH directory (`~/` + the dot-ssh directory); non-test files only |
 * | `private-key-block` | violation | a PEM private-key header |
 * | `prod-ssh-alias` | violation | remote-exec through the production SSH Host alias |
 * | `credential-value` | violation | a credential-named variable assigned a non-placeholder value |
 * | `real-env-file` | violation | a real `.env` (anything but `*.example` / `*.sample` / `*.template`) |
 * | `key-material-file` | violation | private-key / certificate extensions and key file names |
 * | `private-path` | violation | a path that the manifest assigns to the private repository |
 * | `pending-decision-path` | pending | a path the manifest marks as undecided (fails only with `--strict`) |
 * | `unclassified-path` | advisory | a path the manifest does not classify yet — a manifest gap |
 * | `dangling-private-ref` | violation / advisory | a **public** file that references a **private** path (see below) |
 *
 * This script and its test are scanned like any other file, so neither may contain the literal
 * strings it looks for: the sensitive samples in the test are assembled from fragments, and this
 * header describes the rules instead of quoting them.
 *
 * `operator-ssh-path` is scoped to non-test files because a public security test legitimately
 * contains a synthetic operator path while proving that such instructions are blocked. Committed
 * key *material* is still caught everywhere by `key-material-file` (extension/name based).
 *
 * ## Dangling private references (`--dangling`)
 *
 * A file-level split is only safe if the published half still *works*. Zero credential findings
 * prove the export is not leaky; they do not prove it is runnable. A public test that reads a
 * private fixture — directly or through a helper — breaks the public checkout at import time while
 * every content rule stays green. `dangling-private-ref` closes that gap.
 *
 * A finding requires a **public referrer** and a **private target**, both judged by the same
 * `classifyPath()` manifest used everywhere else (never by heuristics over the file contents):
 *
 * - **code level** (violation when unguarded, advisory when guarded): a string literal handed to
 *   `readFileSync`, `readRoot`, `existsSync`, `readFile`, `statSync`, `require`, `from "…"`,
 *   `import("…")`, `new URL("…", …)`, or `source` in a shell script, whose target resolves to a
 *   private path. Targets are resolved against the manifest — not against the scanned tree — so the
 *   rule fires on an export where the private file is *absent* too, which is exactly the
 *   broken-export case.
 * - **text level** (advisory, never fails the check): a private path written out in a
 *   non-code file (a doc, a runbook, a config template). Historical links in ADRs and manifests
 *   are worth reporting but must not turn CI red, hence advisory.
 *
 * ### Guard awareness
 *
 * A private path that the file *checks for first* is not a broken export: the standard public-repo
 * shape is "assert when the operator-held file is present, skip when it is not". Reporting those as
 * violations would leave the gate permanently red, and a permanently red gate gets switched off —
 * the same as having no guard at all. So the code level is severity-graded by whether the same file
 * guards the same literal with an existence check:
 *
 * - **unguarded** → violation (fails the check);
 * - **guarded** → advisory (detail says `guarded by an existence check in this file`).
 *
 * The exact criterion — static analysis cannot follow runtime control flow, so this is a
 * deliberately decidable approximation, scoped to the *literal* (a guard for one path never excuses
 * another path):
 *
 * 1. the file contains a **consumed** existence check whose argument text contains the literal
 *    verbatim: `existsSync("…")`, `existsSync(new URL("…", …))`,
 *    `existsSync(join(root, "…"))`, or `existsSync(fileURLToPath(new URL("…", …)))`;
 * 2. or the file declares a local **guard wrapper** — a function or arrow whose body contains such a
 *    check (`hasRoot`, `readIfPresent`) — and calls it with the literal;
 * 3. or the file binds a variable to an expression containing the literal and a consumed check
 *    mentions that variable (`const dir = fileURLToPath(new URL("…", …)); existsSync(dir)`).
 *
 * "Consumed" means the check's result is bound, tested (`if` / `?:` / `!` / `&&` / `||`) or passed
 * as an argument; a bare `existsSync("…");` statement proves nothing and is not accepted, so the
 * rule cannot be silenced with a discarded call.
 *
 * The criterion is file-scoped for a literal (a check for `a.yml` covers every read of `a.yml` in
 * that file, because which read a check protects is not decidable from text) and literal-scoped
 * across paths (guarding `a.yml` does not excuse an unguarded read of `b.sh` in the same file).
 * A file that guards `a.yml` *and* guards `b.sh` reports both as advisory; one that only guards
 * `a.yml` still reports `b.sh` as a violation.
 *
 * The checker's own source is exempt (`DANGLING_RULE_EXEMPT_FILES`): it *owns* the private-path
 * manifest and would otherwise report its own data table as a dangling reference.
 *
 * The rule is opt-in: `--dangling` enables both levels, `--dangling-code-only` enables the code
 * level only. Neither flag changes the default scan.
 *
 * ## Path classification is a closed allowlist
 *
 * `classifyPath()` returns `public`, `private`, `pending` or `unclassified`. Anything not listed is
 * `unclassified`, never silently public, so the manifest can be checked for completeness: the
 * dry-run export asserts that zero exported files are unclassified.
 *
 * ## Usage
 *
 *   node scripts/check-public-repo-hygiene.mjs                          # whole tree (use on an export)
 *   node scripts/check-public-repo-hygiene.mjs --public-only --strict   # mixed repo / CI gate
 *   node scripts/check-public-repo-hygiene.mjs --root=/tmp/export       # scan another tree
 *   node scripts/check-public-repo-hygiene.mjs --dangling               # also catch public→private refs
 *   node scripts/check-public-repo-hygiene.mjs --dangling-code-only     # … code level only
 *   node scripts/check-public-repo-hygiene.mjs --json                    # machine-readable
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC = "public";
export const PRIVATE = "private";
export const PENDING = "pending";
export const UNCLASSIFIED = "unclassified";

const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", ".worktrees", "coverage", "dist", "build", "out",
  ".next", ".turbo", ".cache", ".venv",
]);
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".dmg", ".exe", ".msi", ".pdf",
  ".mp3", ".mp4", ".mov", ".wasm", ".node", ".so", ".dylib", ".dll",
]);
/** Extensions that are key or certificate material, regardless of content. */
const KEY_MATERIAL_EXTENSIONS = new Set([
  ".pem", ".key", ".crt", ".cer", ".der", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".asc",
]);
const KEY_MATERIAL_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys", ".npmrc", ".netrc", ".pypirc",
  "credentials.json", "secrets.json", "service-account.json",
]);

// ─── path classification (closed allowlist; mirrors the manifest tables) ─────

/**
 * Paths assigned to the private operations repository.
 * Directory entries end with `/`; file entries are exact paths.
 */
export const PRIVATE_PATHS = Object.freeze([
  // production infrastructure and certificates
  "nginx/ssl/",
  "Makefile.prod",
  "docker-compose.prod.yml",
  // production operations scripts
  "scripts/deploy.sh",
  "scripts/setup-prod.sh",
  "scripts/health-check.sh",
  "scripts/fix-pending-membership.sh",
  "scripts/grant-credits.sh",
  "scripts/grant-membership.sh",
  // desktop release / notarization / production upload pipeline
  ".github/workflows/desktop-preview.yml",
  ".github/workflows/desktop-release.yml",
  "scripts/assemble-desktop-preview.mjs",
  "scripts/assemble-desktop-preview.test.mjs",
  "scripts/assemble-desktop-release.mjs",
  "scripts/assemble-desktop-release.test.mjs",
  "scripts/promote-desktop-preview.sh",
  "scripts/promote-desktop-release.sh",
  "scripts/test-desktop-preview-workflow.sh",
  "scripts/test-promote-desktop-preview.sh",
  "scripts/test-promote-desktop-release.sh",
  "scripts/test-deploy-static-preflight.sh",
  "scripts/test-desktop-routing.sh",
  "scripts/test-landing-dist.sh",
  "scripts/test-nginx-config.sh",
  "scripts/verify-static-artifacts.sh",
  // internal design, planning and governance material
  "docs/superpowers/",
  "docs/plans/",
  "docs/entropy/",
  "docs/seo/",
  "docs/research/",
  "docs/opensource/",
  "docs/implementation-plan.md",
  "docs/desktop-release-runbook.md",
  "docs/referral-campaign-operations.md",
  // hosted marketing site build output and its search-console tokens
  "landing-dist/",
  // browser WebUI build artifact: production nginx serves it, but the public repository keeps
  // build output out of the source tree. The private deploy side runs `make build-webui-dist`
  // against the public source and ships the artifact from there.
  "webui-dist/",
  // agent/session artifacts and machine-generated test output
  ".zcode/",
  ".superpowers/",
  "test-results/",
]);

/**
 * Paths the manifest marks as undecided: excluded from the export, reported but not fatal.
 *
 * The first review round had four entries here; the user decided all four (webui-dist is private,
 * AGENTS.md / .env.prod.sample / Makefile are public), so the table is intentionally empty. The
 * bucket stays because the next undecided path needs somewhere to live.
 */
export const PENDING_PATHS = Object.freeze([]);

/** Directories whose whole subtree is public. */
export const PUBLIC_PREFIXES = Object.freeze([
  "packages/",
  "docs/adr/",
  "docs/community-guides/",
  "scripts/migrations/",
  "scripts/tests/",
  "scripts/bench/",
  "nginx/templates/",
]);

/** Individual public files. */
export const PUBLIC_FILES = Object.freeze([
  // repository governance and entry points
  "README.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "DESIGN.md", "ROADMAP.md", "CLAUDE.md",
  ".impeccable.md", ".gitignore", ".gitattributes", "package.json", "package-lock.json",
  // the authoritative architecture document, published after the production-access section was
  // removed (the full operator version lives in the private ops repository)
  "AGENTS.md",
  // public configuration template: every credential value is a placeholder
  ".env.prod.sample",
  // local development entry point, published after the production lifecycle and tunnel sections
  // were removed
  "Makefile",
  // public architecture documentation
  "docs/architecture.md", "docs/current-system-map.md", "docs/development-workflow.md",
  "docs/mcp-guide.md",
  // self-hosting walkthrough (added with the public InsForge fork)
  "docs/self-hosting.md",
  // local development, verification and internal-tool surface
  "scripts/start.sh", "scripts/stop.sh", "scripts/status.sh", "scripts/dev-logs.sh",
  "scripts/setup.sh", "scripts/run-migrations.sh", "scripts/entropy-report.sh",
  "scripts/local-start.sh", "scripts/local-e2e.sh",
  "scripts/e2e-test.sh", "scripts/e2e-mcp-test.ts",
  "scripts/smoke-web-login.sh", "scripts/smoke-native-webui.sh",
  "scripts/check-seo.sh", "scripts/test-seo-routing.sh",
  "scripts/check-webui-i18n.mjs", "scripts/check-webui-i18n.test.mjs",
  "scripts/check-architecture-boundary.mjs", "scripts/check-architecture-boundary.test.mjs",
  "scripts/check-public-repo-hygiene.mjs", "scripts/check-public-repo-hygiene.test.mjs",
  "scripts/export-public-tree.mjs", "scripts/export-public-tree.test.mjs",
  // CI
  ".github/workflows/ci.yml",
  // nginx: the env-parameterized routing contract, without certificates
  "nginx/nginx.conf",
]);

/** The rule set used by default; injectable so tests can exercise every classification. */
export const PATH_RULES = Object.freeze({
  privatePaths: PRIVATE_PATHS,
  pendingPaths: PENDING_PATHS,
  publicPrefixes: PUBLIC_PREFIXES,
  publicFiles: PUBLIC_FILES,
});

function normalize(relativePath) {
  return String(relativePath).split(path.sep).join("/").replace(/^\.\//u, "");
}

function matchesManifestEntry(normalized, entry) {
  return entry.endsWith("/")
    ? normalized === entry.slice(0, -1) || normalized.startsWith(entry)
    : normalized === entry;
}

/**
 * Classify one repository-relative path.
 * @returns {"public"|"private"|"pending"|"unclassified"}
 */
export function classifyPath(relativePath, rules = PATH_RULES) {
  const normalized = normalize(relativePath);
  if (rules.pendingPaths.some((entry) => matchesManifestEntry(normalized, entry))) return PENDING;
  if (rules.privatePaths.some((entry) => matchesManifestEntry(normalized, entry))) return PRIVATE;
  if (rules.publicPrefixes.some((entry) => normalized.startsWith(entry))) return PUBLIC;
  if (rules.publicFiles.includes(normalized)) return PUBLIC;
  return UNCLASSIFIED;
}

// ─── content rules ──────────────────────────────────────────────────────────

/**
 * Content rules. `testFilesOnly: false` rules run on every text file; rules marked
 * `skipTestFiles` are skipped inside `*.test.*` / `*.spec.*` / `__tests__` because their fixtures
 * legitimately contain the pattern (see the header note).
 */
const CONTENT_RULES = Object.freeze([
  {
    id: "prod-ip",
    severity: "violation",
    pattern: /159\.75\.\d{1,3}\.\d{1,3}/gu,
    detail: (match) => match,
  },
  {
    id: "ssh-key-file-reference",
    severity: "violation",
    pattern: /(?:^|[^\w])root\.pem\b|\/root\/\.ssh\//gu,
    detail: (match) => match.trim(),
  },
  {
    id: "operator-ssh-path",
    severity: "violation",
    skipTestFiles: true,
    pattern: /~\/\.ssh\//gu,
    detail: (match) => match,
  },
  {
    id: "private-key-block",
    severity: "violation",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu,
    detail: (match) => match,
  },
  {
    id: "prod-ssh-alias",
    severity: "violation",
    pattern: /\bssh\s+lingqiai\b/gu,
    detail: (match) => match,
  },
]);

/** Variable names whose value must never be a literal in a public tree. */
const CREDENTIAL_TOKENS = Object.freeze([
  "SECRET", "SECRETS", "PASSWORD", "PASSWD", "TOKEN", "API_KEY", "APIKEY", "ACCESS_KEY",
  "ACCESS_TOKEN", "PRIVATE_KEY", "ENCRYPTION_KEY", "SIGNING_KEY", "CLIENT_SECRET",
  "CREDENTIAL", "CREDENTIALS", "AUTH_KEY", "WEBHOOK_SECRET", "ZPAY_KEY", "MASTER_KEY",
  "SERVICE_ROLE_KEY",
]);

export function isCredentialVariableName(name) {
  const upper = String(name).toUpperCase();
  // The credential token must be the whole name or a leading/trailing component. Names that merely
  // *contain* a token are usually not secrets: `LOCAL_SECRET_FILE_ENV` names a file, not a secret.
  return CREDENTIAL_TOKENS.some((token) => (
    upper === token || upper.startsWith(`${token}_`) || upper.endsWith(`_${token}`)
  ));
}

/**
 * Placeholder vocabulary, with `_` treated as a word separator so `LINGQI_BRING_YOUR_OWN_KEY`
 * counts as a placeholder even though JS `\b` would not see a boundary around `YOUR`.
 */
const PLACEHOLDER_WORDS = /(?:^|[^A-Za-z0-9])(your|you|my|change|changeme|replace|secret|example|sample|placeholder|dummy|fake|todo|tbd|generate|generated|redacted|hidden|omitted|none|nil|null|undefined|test|testing|dev|local|localhost|same-as|as-above|see-above)(?:$|[^A-Za-z0-9])/iu;

/**
 * Decide whether an assigned value is a placeholder (or a reference to one) rather than a literal
 * secret. Everything here must be conservative: an unknown literal counts as a leak.
 */
export function isPlaceholderValue(rawValue) {
  const value = String(rawValue).trim().replace(/^["']/u, "").replace(/["']\s*[,;]?\s*$/u, "").trim();
  if (value === "") return true;
  if (/^\$\{?[A-Za-z_]/u.test(value)) return true; // ${VAR} / $VAR
  if (/^\$\(/u.test(value)) return true; // $(command)
  if (value.includes("{{")) return true; // GitHub Actions expression
  if (/^<.*>$/u.test(value)) return true; // <placeholder>
  if (value.includes("<") && value.includes(">")) return true; // sk-<your-key>
  if (/^[./~]/u.test(value)) return true; // filesystem path
  if (/\.(?:key|crt|pem|p12|pfx|jks)$/iu.test(value)) return true; // key/cert path
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return true; // URL / DSN
  if (/^\d+$/u.test(value)) return true; // numeric flag/value, e.g. SECRET_WAS_GENERATED=0
  if (/^(?:true|false|yes|no|on|off)$/iu.test(value)) return true; // boolean flag
  if (PLACEHOLDER_WORDS.test(value)) return true;
  // Masked or repeated filler: xxxxxxxx, ********, 00000000, AAAAAAAA.
  if (/x{5,}/iu.test(value) || /\*{5,}/u.test(value) || /0{8,}/u.test(value) || /(.)\1{7,}/u.test(value)) return true;
  return false;
}

/**
 * Configuration-style assignments only: a whole line of the form `NAME=value` (env / shell) or
 * `NAME: value` (YAML), with a SCREAMING_SNAKE_CASE name. Whole-line matching is what keeps this
 * rule from firing on TypeScript object literals, named arguments and type declarations such as
 * `token: string;` or `secret_hash: input.secretHash,`.
 */
const ENV_ASSIGNMENT_PATTERN = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]{2,})[ \t]*=[ \t]*(.+?)[ \t]*$/u;
const YAML_ASSIGNMENT_PATTERN = /^[ \t]*([A-Z][A-Z0-9_]{2,})[ \t]*:[ \t]*(.+?)[ \t]*$/u;
/**
 * Secondary net for hardcoded secrets in shipped code: a SCREAMING_SNAKE_CASE credential name bound
 * to a long quoted literal. Deliberately narrow (>= 12 chars, no whitespace) and limited to
 * non-test files, because test fixtures legitimately name credential variables with fake values.
 */
const CODE_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]{3,})\s*[:=]\s*(["'])([^"'\n]{12,})\2/gu;

function stripInlineComment(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") || trimmed.startsWith("\"")) return trimmed;
  const hash = trimmed.search(/\s#/u);
  return hash === -1 ? trimmed : trimmed.slice(0, hash).trim();
}

function credentialFindingsForSource(source, { includeCodeNet = true } = {}) {
  const findings = [];
  let lineNumber = 0;
  for (const line of source.split("\n")) {
    lineNumber += 1;
    const trimmedLine = line.trim();
    // A trailing comma/semicolon means this is a code expression, not a config assignment.
    const isConfigLine = trimmedLine !== "" && !trimmedLine.endsWith(",") && !trimmedLine.endsWith(";");

    if (isConfigLine) {
      const assignment = line.match(ENV_ASSIGNMENT_PATTERN) ?? line.match(YAML_ASSIGNMENT_PATTERN);
      if (assignment) {
        const [, variableName, rawValue] = assignment;
        if (isCredentialVariableName(variableName)) {
          const value = stripInlineComment(rawValue);
          if (!isPlaceholderValue(value)) {
            // Never echo the value itself: this report goes into CI logs.
            findings.push({
              line: lineNumber,
              detail: `${variableName}=<redacted len=${value.replace(/^["']|["']$/gu, "").length}>`,
            });
            continue;
          }
        }
      }
    }

    if (!includeCodeNet) continue;
    CODE_ASSIGNMENT_PATTERN.lastIndex = 0;
    let codeMatch;
    while ((codeMatch = CODE_ASSIGNMENT_PATTERN.exec(line)) !== null) {
      const [, variableName, , value] = codeMatch;
      if (!isCredentialVariableName(variableName)) continue;
      if (value.includes(" ") || value.includes("\t")) continue;
      if (isPlaceholderValue(value)) continue;
      findings.push({
        line: lineNumber,
        detail: `${variableName}=<redacted len=${value.length}>`,
      });
    }
  }
  return findings;
}

// ─── dangling private references ────────────────────────────────────────────

/**
 * Files exempt from the dangling-reference rule.
 *
 * These own the private-path manifest itself (`PRIVATE_PATHS`, and the fixtures in the test that
 * assert its classifications). Every private path in them is *data*, not a reference to a file
 * they read, so the rule must not report them — exempting by path is explicit and testable, unlike
 * a heuristic on the surrounding code.
 */
export const DANGLING_RULE_EXEMPT_FILES = Object.freeze([
  "scripts/check-public-repo-hygiene.mjs",
  "scripts/check-public-repo-hygiene.test.mjs",
]);

/** Extensions whose string literals are treated as path references by the code-level rule. */
const DANGLING_CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const DANGLING_SHELL_EXTENSIONS = new Set([".sh", ".bash"]);

/**
 * Code-level reference patterns. Each captures the string literal passed to a path-consuming call.
 * Deliberately the same set the manual export review used; widening it changes the expected
 * findings for the current tree, so additions belong in a separate, deliberate change.
 */
const DANGLING_CODE_PATTERNS = Object.freeze([
  /(?:readFileSync|readRoot|existsSync|readFile|statSync|require)\s*\(\s*[`"']([^`"'\n]+)[`"']/gu,
  /\bfrom\s+[`"']([^`"'\n]+)[`"']/gu,
  /\bimport\s*\(\s*[`"']([^`"'\n]+)[`"']/gu,
  /new URL\(\s*[`"']([^`"'\n]+)[`"']/gu,
]);

/** Shell `source` includes, the shell equivalent of an import. */
const DANGLING_SHELL_PATTERN = /\bsource\s+[`"']?([^\s`"';]+)/gu;

/** Extensions tried when a literal omits one (`.deploy` → `deploy.sh`). */
const DANGLING_TARGET_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sh"]);

/**
 * Resolve one string literal to repo-relative candidate paths, in priority order.
 *
 * A `./`-relative literal resolves against the referrer's directory; anything else is treated as
 * repo-root-relative, which is how the real findings are written (`"scripts/deploy.sh"`). Bare
 * specifiers (`node:fs`, `vitest`, `@scope/pkg`) are dropped here — they are not repository paths —
 * and a literal that escapes the root is dropped rather than reported as a weird `../` path.
 */
export function danglingTargetCandidates(referrerPath, literal) {
  const cleaned = String(literal).trim();
  if (!cleaned) return [];
  if (/^[a-z][a-z0-9+.-]*:/iu.test(cleaned)) return []; // node:, https:, data:
  if (cleaned.startsWith("@")) return []; // npm scope
  const normalizedLiteral = cleaned.split("\\").join("/");
  const base = normalizedLiteral.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(normalize(referrerPath)), normalizedLiteral))
    : path.posix.normalize(normalizedLiteral.replace(/^\/+/u, ""));
  if (!base || base === "." || base.startsWith("..") || path.posix.isAbsolute(base)) return [];
  const candidates = [base, ...DANGLING_TARGET_EXTENSIONS.map((extension) => `${base}${extension}`)];
  const swapped = base.replace(/\.(?:mjs|cjs|js)$/u, ".ts");
  if (swapped !== base) candidates.push(swapped);
  return [...new Set(candidates)];
}

/**
 * The private path a literal points at, or null when it does not point at one.
 *
 * Classification comes from the manifest (`classifyPath`), not from the scanned tree: a reference
 * to a private file is dangling precisely when that file is *not* published, so requiring the
 * target to exist would miss the broken-export case the rule exists to catch. Unclassified targets
 * are not reported — the manifest's own completeness is `unclassified-path`'s job, and treating
 * every unknown relative import as a dangling private reference would be pure noise.
 */
export function danglingPrivateTarget(referrerPath, literal, rules = PATH_RULES) {
  for (const candidate of danglingTargetCandidates(referrerPath, literal)) {
    if (classifyPath(candidate, rules) === PRIVATE) return candidate;
  }
  return null;
}

/**
 * Path-like tokens in prose: at least one `/` and a dotted final segment, so `docs/x/y.md` matches
 * while `localhost:5173/api` and `readme` do not.
 */
const TEXT_PATH_TOKEN_PATTERN = /(?:\.{1,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]+/gu;

/** The private path a prose token names, or null. See {@link danglingPrivateTarget}. */
export function danglingPrivateTextTarget(token, rules = PATH_RULES) {
  const cleaned = String(token).trim().replace(/^\.\//u, "");
  if (!cleaned || cleaned.startsWith("..") || cleaned.includes("\\")) return null;
  // Only the token itself is classified. Walking its `/`-suffixes would make a public path such as
  // `packages/fixture/scripts/deploy.sh` report the private `scripts/deploy.sh` inside it.
  return classifyPath(cleaned, rules) === PRIVATE ? cleaned : null;
}

function danglingCodePatternsFor(relativePath) {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (DANGLING_SHELL_EXTENSIONS.has(extension)) return [DANGLING_SHELL_PATTERN];
  if (DANGLING_CODE_EXTENSIONS.has(extension)) return DANGLING_CODE_PATTERNS;
  return [];
}

function isTextScannableFile(relativePath) {
  return danglingCodePatternsFor(relativePath).length === 0;
}

// ── guard detection (task-22) ───────────────────────────────────────────────
//
// Static analysis cannot follow runtime control flow, so "is this reference protected?" is
// approximated by "does the same file check for this literal's existence?". See the module header
// for the exact, deliberately decidable criterion.

/** Declaration heads used to slice a source into statements: `const x = …`, `function f(…)`, … */
const DECLARATION_HEAD_PATTERN = /(?:^|\n)[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function[ \t]+([A-Za-z_$][\w$]*)|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=)/gu;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Slice a source into declaration spans. A span runs from its head to the next head, and is
 * `functionLike` when it is a `function` declaration or its initializer contains an arrow — the
 * only declarations that can act as an existence-check wrapper.
 */
function declarationSpans(source) {
  const heads = [];
  DECLARATION_HEAD_PATTERN.lastIndex = 0;
  let match;
  while ((match = DECLARATION_HEAD_PATTERN.exec(source)) !== null) {
    heads.push({ name: match[1] ?? match[2], start: match.index, isFunctionKeyword: match[1] !== undefined });
  }
  return heads.map((head, index) => {
    const text = source.slice(head.start, heads[index + 1]?.start ?? source.length);
    return { name: head.name, text, functionLike: head.isFunctionKeyword || text.includes("=>") };
  });
}

/** The argument text of the call whose opening `(` is at `openParenIndex`, parens balanced. */
function balancedCallArgument(source, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return source.slice(openParenIndex + 1);
}

/**
 * Whether an existence check is *used*: bound to a name, tested, fed to a call, returned, or the
 * body of an arrow (the `hasRoot` / `readIfPresent` shape). A bare `existsSync("…");` statement
 * guards nothing, so accepting it would let the rule be silenced.
 */
function checkResultIsUsed(source, callStartIndex) {
  const before = source.slice(0, callStartIndex).replace(/\s+$/u, "");
  if (before === "" || /[;{}]$/u.test(before)) return false;
  return /[=(,?:&|!+\-*/>]$/u.test(before) || /\breturn$/u.test(before);
}

/** Local function/arrow names whose body contains a used existence check (transitively). */
function guardWrapperNames(source) {
  const candidates = declarationSpans(source).filter((declaration) => declaration.functionLike);
  const names = new Set();
  for (let pass = 0; pass <= candidates.length; pass += 1) {
    let changed = false;
    for (const declaration of candidates) {
      if (names.has(declaration.name)) continue;
      if (!declarationWrapsExistenceCheck(declaration.text, names)) continue;
      names.add(declaration.name);
      changed = true;
    }
    if (!changed) break;
  }
  return names;
}

function declarationWrapsExistenceCheck(text, knownGuardNames) {
  const existsPattern = /\bexistsSync\s*\(/gu;
  let match;
  while ((match = existsPattern.exec(text)) !== null) {
    if (checkResultIsUsed(text, match.index)) return true;
  }
  for (const name of knownGuardNames) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "u").test(text)) return true;
  }
  return false;
}

/**
 * The decidable guard criterion from the module header: is `literal` protected by an existence
 * check in `source`? Exported so the criterion itself is covered by the test suite.
 */
export function isDanglingLiteralGuarded(source, literal) {
  const checkArguments = [];
  const existsPattern = /\bexistsSync\s*\(/gu;
  let match;
  while ((match = existsPattern.exec(source)) !== null) {
    if (checkResultIsUsed(source, match.index)) {
      checkArguments.push(balancedCallArgument(source, match.index + match[0].length - 1));
    }
  }
  for (const name of guardWrapperNames(source)) {
    const wrapperPattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "gu");
    while ((match = wrapperPattern.exec(source)) !== null) {
      if (checkResultIsUsed(source, match.index)) {
        checkArguments.push(balancedCallArgument(source, match.index + match[0].length - 1));
      }
    }
  }

  if (checkArguments.some((argument) => argument.includes(literal))) return true;

  // Indirect form: `const dir = <expression containing literal>; … existsSync(dir)`.
  return declarationSpans(source)
    .filter((declaration) => !declaration.functionLike && declaration.text.includes(literal))
    .map((declaration) => declaration.name)
    .some((name) => checkArguments.some((argument) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "u").test(argument)));
}

/**
 * Collect public→private references for one scanned tree.
 *
 * Runs as a second pass because it needs the classification of every file (the target side), which
 * the single-pass content loop does not build. Only runs when the rule is enabled.
 */
async function collectDanglingPrivateRefs({ absoluteRoot, files, rules, codeOnly, maxBytes }) {
  const findings = [];
  const exempt = new Set(DANGLING_RULE_EXEMPT_FILES);

  for (const relativePath of files) {
    if (classifyPath(relativePath, rules) !== PUBLIC) continue;
    if (exempt.has(normalize(relativePath))) continue;

    let stats;
    try {
      stats = await stat(path.join(absoluteRoot, relativePath));
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size > maxBytes) continue;
    let source;
    try {
      source = await readFile(path.join(absoluteRoot, relativePath), "utf8");
    } catch {
      continue;
    }
    if (source.includes("\u0000")) continue;

    const seen = new Set();
    const push = (finding) => {
      const key = `${finding.severity}:${finding.line}:${finding.target}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        rule: "dangling-private-ref",
        severity: finding.severity,
        path: relativePath,
        line: finding.line,
        detail: finding.detail,
      });
    };

    // Code level: an unguarded private reference is a violation, a guarded one is advisory. Each
    // severity is capped independently so a run of guarded references can never push a real
    // violation out of the report.
    const guardCache = new Map();
    const isGuarded = (literal) => {
      if (!guardCache.has(literal)) guardCache.set(literal, isDanglingLiteralGuarded(source, literal));
      return guardCache.get(literal);
    };
    let violationEmitted = 0;
    let guardedEmitted = 0;
    for (const pattern of danglingCodePatternsFor(relativePath)) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const literal = match[1];
        const target = danglingPrivateTarget(relativePath, literal, rules);
        if (!target) continue;
        const guarded = isGuarded(literal);
        if (guarded) {
          if (guardedEmitted >= FINDINGS_PER_RULE_PER_FILE) continue;
          guardedEmitted += 1;
        } else {
          if (violationEmitted >= FINDINGS_PER_RULE_PER_FILE) continue;
          violationEmitted += 1;
        }
        push({
          severity: guarded ? "advisory" : "violation",
          line: lineOf(source, match.index),
          target,
          detail: guarded
            ? `code references private path "${literal}" (resolved: ${target}), guarded by an existence check in this file`
            : `code references private path "${literal}" (resolved: ${target})`,
        });
      }
    }

    if (codeOnly || !isTextScannableFile(relativePath)) continue;

    let textEmitted = 0;
    TEXT_PATH_TOKEN_PATTERN.lastIndex = 0;
    let tokenMatch;
    while ((tokenMatch = TEXT_PATH_TOKEN_PATTERN.exec(source)) !== null) {
      if (textEmitted >= FINDINGS_PER_RULE_PER_FILE) break;
      const target = danglingPrivateTextTarget(tokenMatch[0], rules);
      if (!target) continue;
      textEmitted += 1;
      push({
        severity: "advisory",
        line: lineOf(source, tokenMatch.index),
        target,
        detail: `text mentions private path "${target}"`,
      });
    }
  }

  return findings;
}

// ─── file scanning ──────────────────────────────────────────────────────────

async function collectFiles(root) {
  const files = [];

  async function visit(absoluteDirectory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return; // tolerate directories disappearing or being unreadable
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // `.git` can be a directory (normal repo) or a file (worktree/submodule pointer).
      if (entry.name === ".git") continue;
      const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await visit(path.join(absoluteDirectory, entry.name), relativeEntry);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relativeEntry);
    }
  }

  await visit(path.resolve(root), "");
  return files;
}

const ENV_FILE_ALLOWED_PATTERN = /\.(?:example|sample|template)$/iu;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isTestFile(relativePath) {
  return TEST_FILE_PATTERN.test(path.posix.basename(relativePath))
    || relativePath.split("/").includes("__tests__");
}

function isEnvLikeFile(name) {
  if (!name.startsWith(".env")) return false;
  if (name === ".env") return true;
  return !ENV_FILE_ALLOWED_PATTERN.test(name);
}

function keyMaterialKind(relativePath) {
  const name = path.posix.basename(relativePath);
  if (KEY_MATERIAL_NAMES.has(name)) return `file name: ${name}`;
  const extension = path.posix.extname(name).toLowerCase();
  if (KEY_MATERIAL_EXTENSIONS.has(extension)) return `extension: ${extension}`;
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

/** Keep CI logs readable: at most `cap` findings per rule per file. */
const FINDINGS_PER_RULE_PER_FILE = 5;

/**
 * Scan one directory tree for publication-safety findings.
 *
 * @param {object} options
 * @param {string} options.root                    directory to scan
 * @param {number} [options.maxBytes]              per-file text scan limit
 * @param {object} [options.rules]                 path classification rules (default PATH_RULES)
 * @param {boolean} [options.publicOnly]           mixed-repository mode: only files classified
 *   public are content-checked, and private/pending path presence is not reported (it is expected
 *   in the mixed repository). Use it in CI on the working tree; use the default mode on an export.
 * @param {boolean} [options.dangling]             also report public→private references
 *   (`dangling-private-ref`). Off by default so existing callers are unaffected.
 * @param {boolean} [options.danglingCodeOnly]     with `dangling`, report the code level only and
 *   skip the advisory text level.
 * @returns report object (also serialisable as JSON)
 */
export async function scanPublicHygiene({
  root,
  maxBytes = 5 * 1024 * 1024,
  rules = PATH_RULES,
  publicOnly = false,
  dangling = false,
  danglingCodeOnly = false,
} = {}) {
  const absoluteRoot = path.resolve(root ?? ".");
  const allFiles = await collectFiles(absoluteRoot);
  const findings = [];
  const pathInventory = new Map();
  let scannedFiles = 0;
  let skippedBinary = 0;
  let skippedLarge = 0;

  const push = (finding) => findings.push(finding);

  for (const relativePath of allFiles) {
    const kind = classifyPath(relativePath, rules);
    let bucket = pathInventory.get(kind);
    if (!bucket) {
      bucket = { kind, count: 0, samples: [] };
      pathInventory.set(kind, bucket);
    }
    bucket.count += 1;
    if (bucket.samples.length < 8) bucket.samples.push(relativePath);

    if (publicOnly && kind !== PUBLIC) continue;

    const name = path.posix.basename(relativePath);
    if (isEnvLikeFile(name)) {
      push({ rule: "real-env-file", severity: "violation", path: relativePath, line: null, detail: name });
    }
    const keyKind = keyMaterialKind(relativePath);
    if (keyKind) {
      push({ rule: "key-material-file", severity: "violation", path: relativePath, line: null, detail: keyKind });
    }

    const extension = path.posix.extname(name).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      skippedBinary += 1;
      continue;
    }
    let stats;
    try {
      stats = await stat(path.join(absoluteRoot, relativePath));
    } catch {
      continue;
    }
    if (stats.size > maxBytes) {
      skippedLarge += 1;
      continue;
    }
    let source;
    try {
      source = await readFile(path.join(absoluteRoot, relativePath), "utf8");
    } catch {
      continue;
    }
    if (source.includes("\u0000")) {
      skippedBinary += 1;
      continue;
    }
    scannedFiles += 1;

    const isTest = isTestFile(relativePath);
    for (const rule of CONTENT_RULES) {
      if (isTest && rule.skipTestFiles) continue;
      rule.pattern.lastIndex = 0;
      let match;
      let emitted = 0;
      while ((match = rule.pattern.exec(source)) !== null) {
        if (emitted >= FINDINGS_PER_RULE_PER_FILE) break;
        emitted += 1;
        push({
          rule: rule.id,
          severity: rule.severity,
          path: relativePath,
          line: lineOf(source, match.index),
          detail: rule.detail(match[1] ?? match[0]),
        });
        if (match[0].length === 0) rule.pattern.lastIndex += 1;
      }
    }

    for (const finding of credentialFindingsForSource(source, { includeCodeNet: !isTestFile(relativePath) })) {
      push({
        rule: "credential-value",
        severity: "violation",
        path: relativePath,
        line: finding.line,
        detail: finding.detail,
      });
    }
  }

  // Path-level rules are reported per manifest entry, not per file. In `publicOnly` mode the
  // private entries are expected to exist (it is the mixed repository), so only content matters.
  if (!publicOnly) {
    for (const entry of rules.privatePaths) {
      const presence = pathPresence(allFiles, entry);
      if (presence.count > 0) {
        push({
          rule: "private-path",
          severity: "violation",
          path: entry,
          line: null,
          detail: `${presence.count} file(s) present in a public candidate tree`,
        });
      }
    }
    for (const entry of rules.pendingPaths) {
      const presence = pathPresence(allFiles, entry);
      if (presence.count > 0) {
        push({
          rule: "pending-decision-path",
          severity: "pending",
          path: entry,
          line: null,
          detail: `${presence.count} file(s) present; excluded from the export until the user decides`,
        });
      }
    }
    for (const [kind, bucket] of pathInventory) {
      if (kind !== UNCLASSIFIED) continue;
      push({
        rule: "unclassified-path",
        severity: "advisory",
        path: bucket.samples[0],
        line: null,
        detail: `${bucket.count} unclassified file(s), first: ${bucket.samples.join(", ")}`,
      });
    }
  }

  // Dangling public→private references need every file's classification (the target side), so they
  // are collected in their own pass. Opt-in: the default scan is unchanged.
  if (dangling) {
    for (const finding of await collectDanglingPrivateRefs({
      absoluteRoot,
      files: allFiles,
      rules,
      codeOnly: danglingCodeOnly,
      maxBytes,
    })) {
      push(finding);
    }
  }

  const order = { violation: 0, pending: 1, advisory: 2 };
  findings.sort((left, right) => (
    order[left.severity] - order[right.severity]
    || left.rule.localeCompare(right.rule)
    || left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0)
  ));

  return {
    root: absoluteRoot,
    scope: publicOnly ? "public-subset" : "tree",
    fileCount: allFiles.length,
    scannedFiles,
    skippedBinary,
    skippedLarge,
    findings,
    violationCount: findings.filter((finding) => finding.severity === "violation").length,
    pendingCount: findings.filter((finding) => finding.severity === "pending").length,
    advisoryCount: findings.filter((finding) => finding.severity === "advisory").length,
    pathInventory: [...pathInventory.values()].sort((left, right) => left.kind.localeCompare(right.kind)),
  };
}

function pathPresence(files, manifestEntry) {
  const prefix = manifestEntry.endsWith("/") ? manifestEntry : null;
  const exact = prefix ? manifestEntry.slice(0, -1) : manifestEntry;
  const matches = files.filter((file) => (prefix ? file === exact || file.startsWith(prefix) : file === exact));
  return { count: matches.length, first: matches[0] ?? null };
}

export function buildReport(scan, { strict = false, rootLabel = "." } = {}) {
  const exitCode = scan.violationCount > 0 || (strict && scan.pendingCount > 0) ? 1 : 0;
  return {
    schemaVersion: 1,
    check: "public-repo-hygiene",
    strict,
    scope: scan.scope ?? "tree",
    root: rootLabel,
    fileCount: scan.fileCount,
    scannedFiles: scan.scannedFiles,
    skippedBinary: scan.skippedBinary,
    skippedLarge: scan.skippedLarge,
    violationCount: scan.violationCount,
    pendingCount: scan.pendingCount,
    advisoryCount: scan.advisoryCount,
    ruleCounts: countByRule(scan.findings),
    findings: scan.findings,
    pathInventory: scan.pathInventory,
    exitCode,
  };
}

function countByRule(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((left, right) => left.rule.localeCompare(right.rule));
}

const SEVERITY_LABEL = { violation: "VIOLATION", pending: "PENDING  ", advisory: "ADVISORY " };

export function formatTextReport(report) {
  const lines = [];
  lines.push("[public-repo-hygiene] rule: no production identifiers, credentials, key material or private paths in a public tree");
  lines.push(
    `[public-repo-hygiene] root: ${report.root} (scope=${report.scope}, files=${report.fileCount}, `
    + `text-scanned=${report.scannedFiles}, binary-skipped=${report.skippedBinary}, `
    + `large-skipped=${report.skippedLarge})`,
  );
  lines.push(
    `[public-repo-hygiene] findings: violations=${report.violationCount} pending=${report.pendingCount} `
    + `advisory=${report.advisoryCount} `
    + `(${report.ruleCounts.map((entry) => `${entry.rule}=${entry.count}`).join(", ") || "none"})`,
  );
  for (const finding of report.findings) {
    const location = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
    lines.push(`[public-repo-hygiene]   ${SEVERITY_LABEL[finding.severity]} ${finding.rule} ${location} — ${finding.detail}`);
  }
  lines.push(
    `[public-repo-hygiene] path inventory: ${report.pathInventory
      .map((entry) => `${entry.kind}=${entry.count}`)
      .join(", ")}`,
  );
  const strictLabel = report.strict ? "strict=on" : "strict=off";
  lines.push(
    `[public-repo-hygiene] SUMMARY scope=${report.scope} violations=${report.violationCount} `
    + `pending=${report.pendingCount} advisory=${report.advisoryCount} files=${report.fileCount} `
    + `${strictLabel} exit=${report.exitCode}`,
  );
  if (report.exitCode === 0 && report.pendingCount > 0) {
    lines.push(
      "[public-repo-hygiene] pending-decision paths are excluded from the export by default; "
      + "re-run with --strict once the user decides.",
    );
  }
  return lines.join("\n");
}

export function parseArguments(argv) {
  const options = {
    root: null, json: false, strict: false, publicOnly: false, maxBytes: 5 * 1024 * 1024, help: false,
  };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--public-only") options.publicOnly = true;
    // The dangling flags are added only when passed: the default options object keeps its documented
    // shape, so callers (and the contract test) that never opt in see exactly the old result.
    else if (argument === "--dangling") options.dangling = true;
    else if (argument === "--dangling-code-only") {
      options.dangling = true;
      options.danglingCodeOnly = true;
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("--root=")) options.root = argument.slice("--root=".length);
    else if (argument.startsWith("--max-bytes=")) {
      const parsed = Number(argument.slice("--max-bytes=".length));
      if (!Number.isFinite(parsed) || parsed <= 0) return { options, error: `invalid --max-bytes: ${argument}` };
      options.maxBytes = parsed;
    } else return { options, error: `unknown argument: ${argument}` };
  }
  return { options, error: null };
}

export const USAGE = [
  "Usage: node scripts/check-public-repo-hygiene.mjs [options]",
  "",
  "Options:",
  "  --root=<dir>       directory to scan (default: repository root)",
  "  --public-only      mixed-repository mode: content-check only files classified public",
  "                     and ignore private-path presence (use this on the working tree / in CI)",
  "  --dangling         also report public files that reference private paths: code-level",
  "                     references are violations, textual mentions are advisories",
  "  --dangling-code-only  enable --dangling but report code-level references only",
  "  --json             print the machine-readable JSON report",
  "  --strict           also fail on pending-decision paths",
  "  --max-bytes=<n>    per-file text scan limit (default 5242880)",
  "  -h, --help         show this help",
  "",
  "Exit codes: 0 clean, 1 findings, 2 bad input. Without --root on an exported public tree the",
  "default (whole-tree) scope is the strict gate; --public-only is the gate for the mixed repo.",
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
    console.error(`[public-repo-hygiene] ${error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const rootLabel = options.root ?? ".";
  const root = path.resolve(repositoryRoot, rootLabel);
  if (!(await isDirectory(root))) {
    console.error(`[public-repo-hygiene] root not found: ${root}`);
    process.exitCode = 2;
    return;
  }

  const scan = await scanPublicHygiene({
    root,
    maxBytes: options.maxBytes,
    publicOnly: options.publicOnly,
    dangling: options.dangling === true,
    danglingCodeOnly: options.danglingCodeOnly === true,
  });
  const report = buildReport(scan, { strict: options.strict, rootLabel: normalize(rootLabel) });

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${formatTextReport(report)}\n`);

  process.exitCode = report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
