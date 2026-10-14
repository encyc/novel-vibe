import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("continuity Docker packaging", () => {
  it("copies extracted Agent runtime directories into the production image", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(
      "COPY packages/novel-agents/server/ packages/novel-agents/server/",
    );
    expect(dockerfile).toContain(
      "COPY packages/novel-agents/continuity/ packages/novel-agents/continuity/",
    );
  });
});
