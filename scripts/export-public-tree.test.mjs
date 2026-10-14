/**
 * Tests for the public-tree exporter.
 *
 * Fixture note: the strings below include private paths (for example the
 * operator deploy script) purely as *classification inputs* — the tests assert
 * which bucket a path lands in, and never read the path from disk. That is
 * deliberate: the exporter must classify paths the current checkout may not even
 * contain, because an export is exactly the tree where private files are absent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  classifyPaths,
  isGitWorkTree,
  parseArguments,
  planExport,
} from "./export-public-tree.mjs";

const PUBLIC_FILE = "README.md";
const PRIVATE_FILE = "scripts/deploy.sh";
const UNCLASSIFIED_FILE = "docs/definitely-not-in-the-manifest.md";

describe("parseArguments", () => {
  it("defaults to a plan-only run with no checks", () => {
    const { options } = parseArguments([]);
    assert.deepEqual(options, { dest: null, check: false, quiet: false });
  });

  it("reads --dest, --check and --quiet", () => {
    const { options } = parseArguments(["--dest=/tmp/x", "--check", "--quiet"]);
    assert.equal(options.dest, "/tmp/x");
    assert.equal(options.check, true);
    assert.equal(options.quiet, true);
  });

  it("treats an unknown flag as an error rather than ignoring it", () => {
    const { error } = parseArguments(["--dest=/tmp/x", "--typo"]);
    assert.match(error, /unknown argument: --typo/);
  });

  it("rejects --dest= with no directory", () => {
    const { error } = parseArguments(["--dest="]);
    assert.match(error, /without a directory/);
  });
});

describe("isGitWorkTree", () => {
  it("is true for the checkout the tests run in", () => {
    // The negative case cannot be unit-tested here: the root is resolved from
    // the module location. It is covered by running the CLI in an export
    // directory, which has no .git and must not print a stack trace.
    assert.equal(isGitWorkTree(), true);
  });
});

describe("classifyPaths", () => {
  it("splits paths into public, private and unclassified buckets", () => {
    const buckets = classifyPaths([PUBLIC_FILE, PRIVATE_FILE, UNCLASSIFIED_FILE]);
    assert.deepEqual(buckets.public, [PUBLIC_FILE]);
    assert.deepEqual(buckets.private, [PRIVATE_FILE]);
    assert.deepEqual(buckets.unclassified, [UNCLASSIFIED_FILE]);
  });

  it("never treats an unknown path as public", () => {
    // The manifest is a closed allowlist. A path nobody wrote a rule for must
    // land in `unclassified`, because that is what makes the caller stop.
    const buckets = classifyPaths([UNCLASSIFIED_FILE]);
    assert.deepEqual(buckets.public, []);
    assert.deepEqual(buckets.unclassified, [UNCLASSIFIED_FILE]);
  });

  it("sorts each bucket so output is stable", () => {
    const buckets = classifyPaths(["packages/b/x.ts", "packages/a/y.ts"]);
    assert.deepEqual(buckets.public, ["packages/a/y.ts", "packages/b/x.ts"]);
  });
});

describe("planExport", () => {
  it("accepts a consistent tracked tree", () => {
    const { problems } = planExport({
      tracked: [PUBLIC_FILE, PRIVATE_FILE],
      untracked: [],
      dest: null,
    });
    assert.deepEqual(problems, []);
  });

  it("refuses when a publishable path is untracked", () => {
    // This is the failure that motivated the check: a newly written public file
    // is absent from `git ls-files`, so the export silently omits it.
    const { problems } = planExport({
      tracked: [PUBLIC_FILE],
      untracked: ["docs/self-hosting.md"],
      dest: null,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not tracked by git/);
    assert.match(problems[0], /docs\/self-hosting\.md/);
  });

  it("refuses when a tracked path has no manifest entry", () => {
    const { problems } = planExport({
      tracked: [UNCLASSIFIED_FILE],
      untracked: [],
      dest: null,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not in the manifest/);
  });

  it("ignores untracked private paths", () => {
    // Untracked private material is normal (a local .env, a scratch file).
    const { problems } = planExport({
      tracked: [PUBLIC_FILE],
      untracked: [PRIVATE_FILE],
      dest: null,
    });
    assert.deepEqual(problems, []);
  });

  describe("destination handling", () => {
    const created = [];
    const makeDir = (populate) => {
      const dir = mkdtempSync(join(tmpdir(), "export-public-tree-test."));
      created.push(dir);
      if (populate) writeFileSync(join(dir, "leftover.txt"), "stale\n");
      return dir;
    };
    after(() => {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a destination that already holds files", () => {
      // Merging into an old tree could publish a stale file as current.
      const dir = makeDir(true);
      const { problems } = planExport({ tracked: [], untracked: [], dest: dir });
      assert.equal(problems.length, 1);
      assert.match(problems[0], /refusing to merge/);
    });

    it("accepts a missing destination and an empty one", () => {
      const empty = makeDir(false);
      for (const dest of [join(tmpdir(), "export-public-tree-test-absent"), empty]) {
        assert.deepEqual(planExport({ tracked: [], untracked: [], dest }).problems, []);
      }
    });

    it("ignores a node_modules entry when judging emptiness", () => {
      // A symlinked node_modules is how the export is exercised locally; it is
      // not content that could go stale in the published tree.
      const dir = makeDir(false);
      mkdirSync(join(dir, "node_modules"));
      const { problems } = planExport({ tracked: [], untracked: [], dest: dir });
      assert.deepEqual(problems, []);
    });
  });
});
