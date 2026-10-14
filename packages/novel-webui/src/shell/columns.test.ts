import { describe, expect, it } from "vitest";
import { LAYOUT, computeColumns } from "./columns";

describe("computeColumns", () => {
  it("uses preferred widths when space is plentiful", () => {
    const r = computeColumns({ width: 1920 }, { sidebar: 280, details: 360 }, { sidebarCollapsed: false, detailsCollapsed: false });
    expect(r).toEqual({ sidebar: 280, center: 1280, details: 360, detailsOpen: true });
  });

  it("caps details at the frame-adaptive maximum before touching center", () => {
    const r = computeColumns({ width: 1250 }, { sidebar: 280, details: 360 }, { sidebarCollapsed: false, detailsCollapsed: false });
    // detailsMaxFor(1250, 280) = 314: the pane takes everything up to the
    // center floor instead of dropping to its minimum.
    expect(r.details).toBe(1250 - 280 - LAYOUT.GUTTERS - LAYOUT.CENTER_MIN);
    expect(r.center).toBe(1250 - 280 - r.details);
    expect(r.detailsOpen).toBe(true);
  });

  it("closes details (width 0, preference untouched) when even minimum cannot fit", () => {
    const r = computeColumns({ width: 800 }, { sidebar: 280, details: 360 }, { sidebarCollapsed: false, detailsCollapsed: false });
    expect(r.detailsOpen).toBe(false);
    expect(r.details).toBe(0);
    expect(r.center).toBe(800 - 280);
  });

  it("clamps sidebar preference into [SIDEBAR_MIN, SIDEBAR_MAX]", () => {
    const r = computeColumns({ width: 1920 }, { sidebar: 9999, details: 360 }, { sidebarCollapsed: false, detailsCollapsed: false });
    expect(r.sidebar).toBe(LAYOUT.SIDEBAR_MAX);
  });

  it("yields the 56px icon rail when collapsed below the auto-collapse breakpoint", () => {
    const r = computeColumns({ width: 1400 }, { sidebar: 280, details: 360 }, { sidebarCollapsed: true, detailsCollapsed: false });
    expect(r.sidebar).toBe(LAYOUT.SIDEBAR_COLLAPSED);
    expect(r.center).toBe(1400 - LAYOUT.SIDEBAR_COLLAPSED - 360);
    expect(r.detailsOpen).toBe(true);
  });
});
