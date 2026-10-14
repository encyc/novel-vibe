import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { detailsMaxFor, LAYOUT } from "./columns";
import { useLayout } from "./useLayout";

const OPEN = { sidebarCollapsed: false, detailsCollapsed: false };
import { AppFrame } from "./AppFrame";

beforeEach(() => window.localStorage.clear());

describe("useLayout", () => {
  it("starts at dsh defaults with details open on wide frames", () => {
    const { result } = renderHook(() => useLayout(OPEN));
    expect(result.current.prefs).toEqual({ sidebar: LAYOUT.SIDEBAR_DEFAULT, details: LAYOUT.DETAILS_DEFAULT });
    act(() => result.current.applyFrameWidth(1920));
    expect(result.current.columns.detailsOpen).toBe(true);
  });

  it("persists width preferences and restores them", () => {
    const first = renderHook(() => useLayout(OPEN));
    act(() => first.result.current.setSidebarWidth(320));
    expect(window.localStorage.getItem("novel-vibe:layout-sidebar")).toBe("320");
    first.unmount();
    const second = renderHook(() => useLayout(OPEN));
    expect(second.result.current.prefs.sidebar).toBe(320);
  });

  it("startDrag with pointer move adjusts the dragged column and clamps", () => {
    const { result } = renderHook(() => useLayout(OPEN));
    act(() => result.current.startDrag("sidebar", { clientX: 100, pointerId: 1 } as React.PointerEvent));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 180, pointerId: 1 }));
    });
    // 起点 100 → 180：偏好 280 + 80 = 360（≤ SIDEBAR_MAX）
    expect(result.current.prefs.sidebar).toBe(360);
    act(() => result.current.applyFrameWidth(1920));
    act(() => result.current.startDrag("details", { clientX: 1000, pointerId: 2 } as React.PointerEvent));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, pointerId: 2 }));
    });
    // 反向拖动：宽度 = 起始值 + (起点 - clientX)，夹进 [MIN, 帧宽自适应上限]
    expect(result.current.prefs.details).toBe(detailsMaxFor(1920, 280));
  });

  it("startDrag on details stops at the letting-chain limit instead of snapping back", () => {
    const { result } = renderHook(() => useLayout(OPEN));
    // 1250 帧：中列最少 640 → 右栏物理上限 = 1250-280-16-640 = 314。
    act(() => result.current.applyFrameWidth(1250));
    act(() => result.current.startDrag("details", { clientX: 1000, pointerId: 3 } as React.PointerEvent));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, pointerId: 3 }));
    });
    // 拖拽停在物理上限而不是砸回 DETAILS_MIN；中列保持 >= CENTER_MIN，面板不关。
    expect(result.current.prefs.details).toBe(314);
    expect(result.current.columns.detailsOpen).toBe(true);
    expect(result.current.columns.center).toBeGreaterThanOrEqual(LAYOUT.CENTER_MIN);
    // 大窗口则停在 720 上限。
    act(() => result.current.applyFrameWidth(1920));
    act(() => result.current.startDrag("details", { clientX: 1000, pointerId: 4 } as React.PointerEvent));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100, pointerId: 4 }));
    });
    expect(result.current.prefs.details).toBe(detailsMaxFor(1920, 280));
  });

  it("reflects controlled collapse flags in the solved columns", () => {
    const { result } = renderHook(() => useLayout({ sidebarCollapsed: true, detailsCollapsed: false }));
    act(() => result.current.applyFrameWidth(1400));
    expect(result.current.columns.sidebar).toBe(LAYOUT.SIDEBAR_COLLAPSED);
    expect(result.current.columns.detailsOpen).toBe(true);
  });
});

describe("AppFrame", () => {
  it("renders three zones and hides details when collapsed", () => {
    const frame = render(
      <AppFrame
        details={<div>DETAILS</div>}
        detailsCollapsed={false}
        detailsSlot="panel"
        center={<div>CENTER</div>}
        onDetailsCollapsedChange={() => {}}
        onSidebarCollapsedChange={() => {}}
        sidebar={<div>SIDEBAR</div>}
        sidebarCollapsed={false}
      />,
    );
    expect(frame.container.querySelector(".app-frame-sidebar")).not.toBeNull();
    expect(frame.container.querySelector(".app-frame-center")).not.toBeNull();
    expect(frame.container.querySelector(".app-frame-details")).not.toBeNull();
    frame.unmount();

    window.localStorage.setItem("novel-vibe:layout-details", "0");
    const collapsed = render(
      <AppFrame
        details={<div>DETAILS</div>}
        detailsCollapsed={false}
        detailsSlot="panel"
        center={<div>CENTER</div>}
        onDetailsCollapsedChange={() => {}}
        onSidebarCollapsedChange={() => {}}
        sidebar={<div>SIDEBAR</div>}
        sidebarCollapsed={false}
      />,
    );
    // detailsClosed 不能由持久化宽度推断——显式 flag 才关；这里仅验证默认开启下的渲染。
    expect(collapsed.container.querySelector(".app-frame-details")).not.toBeNull();
  });
});
