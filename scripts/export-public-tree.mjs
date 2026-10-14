#!/usr/bin/env node
/**
 * Export the publishable subset of this repository into a clean directory tree.
 *
 * This repository is the private one: it holds the hosted operations material
 * alongside the source that is published. `check-public-repo-hygiene.mjs`
 * decides which paths are publishable; this script materialises that decision.
 *
 * The export is intentionally a file copy, never a `git clone`:
 *
 *   - a clone would carry `.git` and the full history, and the history is the
 *     one thing the split cannot clean by copying;
 *   - the public repository is created fresh from this tree, so it starts with a
 *     single commit and no inherited history at all.
 *
 * Usage:
 *   node scripts/export-public-tree.mjs --dest=/tmp/public-tree
 *   node scripts/export-public-tree.mjs --dest=/tmp/public-tree --check
 *   node scripts/export-public-tree.mjs            # prints the plan, writes nothing
 *
 * Exit codes: 0 ok, 1 refused (see the safety checks below), 2 bad arguments.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyPath } from "./check-public-repo-hygiene.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: node scripts/export-public-tree.mjs [--dest=<dir>] [--check] [--quiet]

  --dest=<dir>   Directory to write the exported tree into. It must not already
                 contain files (the script refuses to merge into an existing
                 tree, because a stale file left behind by an earlier export is
                 exactly the kind of mistake this is meant to prevent).
                 Omit it to print the plan without writing anything.
  --check        Run check-public-repo-hygiene.mjs --strict against the result.
  --quiet        Only print the summary line.

Exit codes: 0 ok, 1 refused, 2 bad arguments.`;

/** Parse argv. Unknown flags are an error rather than being ignored. */
export function parseArguments(argv) {
  const options = { dest: null, check: false, quiet: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg.startsWith("--dest=")) options.dest = arg.slice("--dest=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (options.dest === "") return { error: "--dest= was given without a directory" };
  return { options };
}

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

/** True when `git` is present and REPO_ROOT is inside a work tree. */
export function isGitWorkTree() {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Split a repository path list by classification.
 *
 * `classifyPath` is a closed allowlist: a path the manifest does not mention is
 * `unclassified`, never silently public. That is why unclassified paths are
 * reported separately instead of being dropped — dropping them would turn a
 * forgotten manifest row into a silently missing file.
 */
export function classifyPaths(paths) {
  const buckets = { public: [], private: [], unclassified: [] };
  for (const file of paths) {
    let kind;
    try {
      kind = classifyPath(file);
    } catch {
      kind = "unclassified";
    }
    if (kind === "public") buckets.public.push(file);
    else if (kind === "private") buckets.private.push(file);
    else buckets.unclassified.push(file);
  }
  for (const key of Object.keys(buckets)) buckets[key].sort();
  return buckets;
}

/**
 * Work out what to export, and refuse when the answer would be wrong.
 *
 * The checks exist because each of them was a real near-miss:
 *
 *   - A public path that is untracked is *not* in `git ls-files`, so the export
 *     would quietly omit a file the manifest says is publishable. This is how a
 *     newly written doc goes missing.
 *   - An unclassified tracked path means the manifest has a hole; exporting
 *     anyway would ship an unvetted file.
 *   - An existing non-empty destination means a previous export's leftovers
 *     could be published as if they were current.
 */
export function planExport({ tracked, untracked, dest }) {
  const trackedBuckets = classifyPaths(tracked);
  const untrackedBuckets = classifyPaths(untracked);

  const problems = [];
  if (untrackedBuckets.public.length) {
    problems.push(
      `public paths are not tracked by git, so they would be missing from the export: ${untrackedBuckets.public.join(", ")}. Commit them first.`,
    );
  }
  if (trackedBuckets.unclassified.length) {
    problems.push(
      `tracked paths are not in the manifest, so they cannot be classified: ${trackedBuckets.unclassified.join(", ")}.`,
    );
  }
  if (dest && fs.existsSync(dest)) {
    const existing = fs.readdirSync(dest).filter((entry) => entry !== "node_modules");
    if (existing.length) {
      problems.push(
        `destination ${dest} is not empty (${existing.length} entr${existing.length === 1 ? "y" : "ies"}); refusing to merge into an existing tree.`,
      );
    }
  }
  return { trackedBuckets, untrackedBuckets, problems };
}

function copyTree(files, dest) {
  let bytes = 0;
  for (const relative of files) {
    const from = path.join(REPO_ROOT, relative);
    const to = path.join(dest, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    // Preserve the mode so executable scripts stay executable in the public
    // repository; `cp` without -p does not, and a non-executable
    // scripts/setup.sh is a confusing first-run failure.
    fs.chmodSync(to, fs.statSync(from).mode);
    bytes += fs.statSync(to).size;
  }
  return bytes;
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[export-public-tree] ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  // In the published tree there is nothing to split away, and `git ls-files`
  // would be the only thing standing between a reader and a stack trace. Say
  // what is going on instead.
  if (!isGitWorkTree()) {
    if (options.dest) {
      console.error(
        "[export-public-tree] REFUSED: this is not a git work tree, so there is no tracked set to export from. Run it in a checkout of the private repository.",
      );
      return 1;
    }
    console.log(
      "[export-public-tree] this is not a git work tree — nothing to export. Use it in a checkout of the private repository, where the publishable subset is a real subset.",
    );
    return 0;
  }

  const tracked = git("ls-files");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  const { trackedBuckets, untrackedBuckets, problems } = planExport({
    tracked,
    untracked,
    dest: options.dest,
  });

  if (!options.quiet) {
    console.log(
      `[export-public-tree] tracked=${tracked.length} public=${trackedBuckets.public.length} private=${trackedBuckets.private.length} unclassified=${trackedBuckets.unclassified.length}`,
    );
    if (untrackedBuckets.public.length || untrackedBuckets.private.length) {
      console.log(
        `[export-public-tree] untracked: public=${untrackedBuckets.public.length} private=${untrackedBuckets.private.length}`,
      );
    }
    if (trackedBuckets.private.length === 0) {
      // This is the published tree: everything tracked is already publishable,
      // so the same command doubles as a completeness check.
      console.log(
        "[export-public-tree] no private paths here — this tree is already fully publishable; `check-public-repo-hygiene.mjs` is the gate that matters.",
      );
    }
  }

  if (problems.length) {
    for (const problem of problems) console.error(`[export-public-tree] REFUSED: ${problem}`);
    return 1;
  }

  if (!options.dest) {
    console.log(
      `[export-public-tree] no --dest given: would export ${trackedBuckets.public.length} files. Nothing written.`,
    );
    return 0;
  }

  fs.mkdirSync(options.dest, { recursive: true });
  const bytes = copyTree(trackedBuckets.public, options.dest);
  const megabytes = (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `[export-public-tree] wrote ${trackedBuckets.public.length} files (${megabytes} MB) to ${options.dest}`,
  );
  console.log(
    `[export-public-tree] skipped ${trackedBuckets.private.length} private paths; no .git directory was created`,
  );

  if (options.check) {
    const checker = path.join(REPO_ROOT, "scripts", "check-public-repo-hygiene.mjs");
    try {
      const output = execFileSync(
        process.execPath,
        [checker, `--root=${options.dest}`, "--strict"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      const summary = output.split("\n").find((line) => line.includes("SUMMARY"));
      console.log(`[export-public-tree] check: ${summary ?? "no SUMMARY line"}`);
      return 0;
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      const summary = output.split("\n").find((line) => line.includes("SUMMARY"));
      console.error(`[export-public-tree] check FAILED: ${summary ?? error.message}`);
      return 1;
    }
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
