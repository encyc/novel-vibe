import { useCallback, useMemo, useRef, useState } from "react";
import { computeColumns, detailsMaxFor, LAYOUT, type ColumnPrefs, type Columns } from "./columns";

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const KEY = { sidebar: "novel-vibe:layout-sidebar", details: "novel-vibe:layout-details" };

/** First-open width: 28% of the screen so wide displays start wider. */
function defaultDetails(): number {
  const width = typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1600;
  return Math.round(Math.min(Math.max(width * 0.28, LAYOUT.DETAILS_DEFAULT), LAYOUT.DETAILS_MAX));
}

function readPref(key: string, fallback: number) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // losing a layout preference is acceptable
  }
}

export interface LayoutOverrides { sidebarCollapsed: boolean; detailsCollapsed: boolean }

export function useLayout(overrides: LayoutOverrides) {
  const [prefs, setPrefs] = useState<ColumnPrefs>(() => ({
    sidebar: readPref(KEY.sidebar, LAYOUT.SIDEBAR_DEFAULT),
    details: readPref(KEY.details, defaultDetails()),
  }));
  const [dragging, setDragging] = useState(false);
  // frameWidth must live in state: the first RO report can land before styles
  // exist (width 0), and a ref would pin the letting chain permanently shut.
  // Width changes have to retrigger the computation.
  const [frameWidth, setFrameWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth ? window.innerWidth : 1600);

  const columns: Columns = useMemo(
    () => computeColumns({ width: frameWidth }, prefs, overrides),
    [frameWidth, overrides],
  );

  const setSidebarWidth = useCallback((px: number) => {
    const sidebar = clamp(px, LAYOUT.SIDEBAR_MIN, LAYOUT.SIDEBAR_MAX);
    setPrefs((current) => ({ ...current, sidebar }));
    writePref(KEY.sidebar, sidebar);
  }, []);
  const setDetailsWidth = useCallback((px: number) => {
    const max = detailsMaxFor(frameWidth, overrides.sidebarCollapsed ? LAYOUT.SIDEBAR_COLLAPSED : prefs.sidebar);
    const details = clamp(px, LAYOUT.DETAILS_MIN, max);
    setPrefs((current) => ({ ...current, details }));
    writePref(KEY.details, details);
  }, [frameWidth, overrides.sidebarCollapsed, prefs.sidebar]);

  // The drag baseline freezes at startDrag to avoid pointer jumps; the details
  // column runs reversed (its right edge widens leftward). dragMovedRef powers
  // click suppression: a resize drags the gutter handle under the cursor, so
  // the release would otherwise land on the button and fire its collapse
  // toggle. The timeout also clears the flag when no click follows the drag.
  const dragMovedRef = useRef(false);
  const startDrag = useCallback((which: "sidebar" | "details", event: React.PointerEvent) => {
    const origin = event.clientX;
    const base = which === "sidebar" ? prefs.sidebar : prefs.details;
    // Details stops at the letting-chain limit instead of overshooting into a
    // solver snap-back: the center column keeps its minimum and the pane takes
    // whatever the frame has left. Sidebar drags stay under the token clamp.
    const maxDetails = detailsMaxFor(
      frameWidth,
      overrides.sidebarCollapsed ? LAYOUT.SIDEBAR_COLLAPSED : prefs.sidebar,
    );
    dragMovedRef.current = false;
    setDragging(true);
    const move = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - origin) > 2) dragMovedRef.current = true;
      const delta = moveEvent.clientX - origin;
      const width = which === "sidebar"
        ? base + delta
        : Math.min(base - delta, maxDetails);
      (which === "sidebar" ? setSidebarWidth : setDetailsWidth)(width);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [frameWidth, overrides.sidebarCollapsed, prefs.details, prefs.sidebar, setDetailsWidth, setSidebarWidth]);

  // True when the interaction that just ended was a drag, not a click.
  const didDrag = useCallback(() => dragMovedRef.current, []);

  const applyFrameWidth = useCallback((width: number) => {
    setFrameWidth((current) => (current === width ? current : width));
  }, []);

  return {
    applyFrameWidth,
    columns,
    didDrag,
    dragging,
    prefs,
    setDetailsWidth,
    setSidebarWidth,
    startDrag,
  };
}
