import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "./rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("limits per key and resets after the window", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(2, 1000, () => now);
    limiter.check("a"); limiter.check("a");
    expect(() => limiter.check("a")).toThrow("RATE_LIMITED");
    expect(() => limiter.check("b")).not.toThrow();
    now = 1000;
    expect(() => limiter.check("a")).not.toThrow();
  });
});
