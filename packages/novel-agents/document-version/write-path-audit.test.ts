import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionFiles = [
  new URL("../tools/file-tools.ts", import.meta.url),
  new URL("../tools/status-tools.ts", import.meta.url),
  new URL("../server.ts", import.meta.url),
  new URL("../server/routes/documents.ts", import.meta.url),
];

describe("project document write path audit", () => {
  it("packages the document version runtime in the production image", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain(
      "COPY packages/novel-agents/document-version/ packages/novel-agents/document-version/",
    );
  });

  it("does not let Agent or HTTP document writes bypass VersionedDocumentWriter", () => {
    const sources = productionFiles.map((url) => readFileSync(url, "utf8"));
    expect(sources[0]).not.toMatch(/ctx\.storage\.write\s*\(/);
    expect(sources[1]).not.toMatch(/ctx\.storage\.write\s*\(/);
    expect(sources[2]).not.toMatch(/storage\.write\s*\(\s*docPath\s*,\s*content\s*\)/);
    expect(sources.join("\n")).toContain("documentWriter.write");
    expect(sources.join("\n")).toContain("writer.write");
  });
});
