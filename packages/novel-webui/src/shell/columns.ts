// Letting chain: when space runs short, squeeze the right column to its
// minimum; if still short, close it; the center column absorbs the rest.
// Ported from dsh ui-layout/src/client/columns.ts (constants keep the dsh
// values under the quiet-study three-column semantics).
export const LAYOUT = {
  SIDEBAR_MIN: 264,
  SIDEBAR_MAX: 420,
  SIDEBAR_DEFAULT: 280,
  SIDEBAR_COLLAPSED: 56,
  SIDEBAR_AUTO_COLLAPSE: 1024,
  CENTER_MIN: 640,
  DETAILS_MIN: 300,
  /** Guaranteed cap on ordinary screens; wide frames grow past it (see detailsMaxFor). */
  DETAILS_MAX: 720,
  /** Ultrawide ceiling so a 34-inch display cannot turn the pane into a page. */
  DETAILS_ULTRA_CAP: 1280,
  /** Both gutters combined (8px each) between the three zones. */
  GUTTERS: 16,
  DETAILS_DEFAULT: 360,
} as const;

/**
 * Largest details width the current frame can offer: never past the center
 * floor, never under the base cap, growing with the frame (40%) up to the
 * ultrawide ceiling — so big displays get proportionally wider panes while
 * ordinary laptops keep the dsh constants.
 */
export function detailsMaxFor(frameWidth: number, sidebarWidth: number): number {
  const allowed = frameWidth - sidebarWidth - LAYOUT.GUTTERS - LAYOUT.CENTER_MIN;
  const scaled = Math.max(LAYOUT.DETAILS_MAX, Math.round(frameWidth * 0.4));
  return Math.max(LAYOUT.DETAILS_MIN, Math.min(allowed, scaled, LAYOUT.DETAILS_ULTRA_CAP));
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export interface ColumnPrefs { sidebar: number; details: number }
export interface ColumnFlags { sidebarCollapsed: boolean; detailsCollapsed: boolean }
export interface Columns { sidebar: number; center: number; details: number; detailsOpen: boolean }

export function computeColumns(
  frame: { width: number },
  prefs: ColumnPrefs,
  flags: ColumnFlags,
): Columns {
  const sidebar = flags.sidebarCollapsed ? LAYOUT.SIDEBAR_COLLAPSED : clamp(prefs.sidebar, LAYOUT.SIDEBAR_MIN, LAYOUT.SIDEBAR_MAX);
  let detailsOpen = !flags.detailsCollapsed;
  let details = clamp(prefs.details, LAYOUT.DETAILS_MIN, detailsMaxFor(frame.width, sidebar));
  let center = frame.width - sidebar - (detailsOpen ? details : 0);
  if (detailsOpen && center < LAYOUT.CENTER_MIN) {
    details = LAYOUT.DETAILS_MIN;
    center = frame.width - sidebar - details;
    if (center < LAYOUT.CENTER_MIN) {
      detailsOpen = false;
      details = 0;
      center = frame.width - sidebar;
    }
  }
  return { sidebar, center: Math.max(center, 0), details: detailsOpen ? details : 0, detailsOpen };
}
