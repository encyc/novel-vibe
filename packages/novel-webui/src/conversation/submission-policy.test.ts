import { describe, expect, it } from "vitest";
import { resolveSubmit } from "./submission-policy";

describe("resolveSubmit", () => {
  it("sends immediately when idle", () => expect(resolveSubmit(false)).toBe("send"));
  it("queues while a run is active", () => expect(resolveSubmit(true)).toBe("queue"));
});
