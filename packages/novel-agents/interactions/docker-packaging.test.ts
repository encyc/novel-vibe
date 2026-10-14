import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("typed interaction production packaging", () => {
  it("copies the interaction runtime into the production image", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain(
      "COPY packages/novel-agents/interactions/ packages/novel-agents/interactions/",
    );
    expect(dockerfile).toContain(
      "COPY packages/novel-agents/registration/ packages/novel-agents/registration/",
    );
    expect(dockerfile).toContain(
      "COPY packages/novel-agents/referral/ packages/novel-agents/referral/",
    );
  });
});
