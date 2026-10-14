import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  main?: string;
  private?: boolean;
  scripts?: Record<string, string>;
}

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("Agent package entrypoint", () => {
  it("uses the HTTP server as its only development entrypoint", () => {
    expect(manifest.private).toBe(true);
    expect(manifest.main).toBeUndefined();
    expect(manifest.scripts?.dev).toBe("tsx watch server.ts");
    expect(manifest.scripts?.server).toBe("tsx server.ts");
  });

  it("does not retain the obsolete static registration entrypoint", () => {
    expect(existsSync(`${packageRoot}/index.ts`)).toBe(false);
    expect(existsSync(`${packageRoot}/index.test.ts`)).toBe(false);
  });
});
