import { describe, expect, it, vi } from "vitest";
import { UserRuntimeRegistry } from "./runtime-registry.js";

describe("UserRuntimeRegistry", () => {
  it("uses the verified user id as the stable cache key", () => {
    const create = vi.fn((token: string) => ({ token }));
    const registry = new UserRuntimeRegistry(create, { maxEntries: 10 });

    const first = registry.get("user-1", "token-a", 1);
    expect(registry.get("user-1", "token-a", 2)).toBe(first);

    const rotated = registry.get("user-1", "token-b", 3);
    expect(rotated).not.toBe(first);
    expect(rotated.token).toBe("token-b");
    expect(registry.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("bounds runtime cardinality with least-recently-used eviction", () => {
    const registry = new UserRuntimeRegistry((token) => ({ token }), { maxEntries: 2 });
    registry.get("user-1", "token-1", 1);
    registry.get("user-2", "token-2", 2);
    registry.get("user-1", "token-1", 3);
    registry.get("user-3", "token-3", 4);

    expect(registry.size).toBe(2);
    expect(registry.has("user-1")).toBe(true);
    expect(registry.has("user-2")).toBe(false);
    expect(registry.has("user-3")).toBe(true);
  });
});
