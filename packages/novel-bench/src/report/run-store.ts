import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaseResultFile, CollectedDoc, RunManifest } from "../types.ts";

export function sanitizeFileId(id: string): string {
  return id.replaceAll("/", "__");
}

export async function currentGitSha(repoDir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--short=7", "HEAD"], { cwd: repoDir }, (err, stdout) => {
      resolve(err || !stdout.trim() ? "nogit" : stdout.trim());
    });
  });
}

export function formatStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function newRunId(genModel: string, now: Date, gitSha: string): string {
  const slug = genModel.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  return `${formatStamp(now)}-${gitSha}-${slug}`;
}

export async function writeRun(
  runsDir: string,
  manifest: RunManifest,
  results: CaseResultFile[],
  artifacts: Record<string, CollectedDoc[]>,
  reportMarkdown: string,
): Promise<string> {
  const runDir = join(runsDir, manifest.runId);
  await mkdir(join(runDir, "cases"), { recursive: true });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const result of results) {
    await writeFile(join(runDir, "cases", `${sanitizeFileId(result.caseId)}.json`), JSON.stringify(result, null, 2));
    const docs = artifacts[result.caseId] ?? [];
    for (const doc of docs) {
      const artifactPath = join(runDir, "artifacts", sanitizeFileId(result.caseId), sanitizeFileId(doc.path));
      await mkdir(dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, doc.content);
    }
  }
  await writeFile(join(runDir, "report.md"), reportMarkdown);
  return runDir;
}

export interface StoredRun {
  manifest: RunManifest;
  results: CaseResultFile[];
  dir: string;
}

export async function readRun(runsDir: string, runId: string): Promise<StoredRun> {
  const dir = join(runsDir, runId);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as RunManifest;
  const names = (await readdir(join(dir, "cases"))).filter((n) => n.endsWith(".json"));
  const results: CaseResultFile[] = [];
  for (const name of names) {
    results.push(JSON.parse(await readFile(join(dir, "cases", name), "utf8")) as CaseResultFile);
  }
  results.sort((a, b) => a.caseId.localeCompare(b.caseId));
  return { manifest, results, dir };
}
