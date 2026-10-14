import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COMPACT_QUERY, MOBILE_QUERY, resolveViewportMode, useViewportMode } from "./useViewportMode";

describe("useViewportMode", () => {
  it("maps phone, compact, and desktop media states", () => {
    expect(resolveViewportMode(true, true)).toBe("mobile");
    expect(resolveViewportMode(false, true)).toBe("compact");
    expect(resolveViewportMode(false, false)).toBe("desktop");
  });

  it("tracks both breakpoints and removes both listeners", () => {
    const state = new Map([[MOBILE_QUERY, false], [COMPACT_QUERY, true]]);
    const listeners = new Map<string, Set<() => void>>([
      [MOBILE_QUERY, new Set()],
      [COMPACT_QUERY, new Set()],
    ]);
    const removeEventListener = vi.fn((query: string, listener: () => void) => listeners.get(query)?.delete(listener));
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      get matches() { return state.get(query) ?? false; },
      addEventListener: (_event: string, listener: () => void) => listeners.get(query)?.add(listener),
      removeEventListener: (_event: string, listener: () => void) => removeEventListener(query, listener),
    })));

    const { result, unmount } = renderHook(() => useViewportMode());
    expect(result.current).toBe("compact");

    act(() => {
      state.set(MOBILE_QUERY, true);
      listeners.get(MOBILE_QUERY)?.forEach((listener) => listener());
    });
    expect(result.current).toBe("mobile");

    unmount();
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });
});
