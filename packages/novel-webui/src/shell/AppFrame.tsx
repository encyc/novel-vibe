import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LAYOUT } from "./columns";
import { useLayout } from "./useLayout";

interface AppFrameProps {
  sidebar: ReactNode;
  center: ReactNode;
  details: ReactNode;
  detailsSlot: "panel" | "none";
  /** Collapse state is controlled by the shell (compact drawer/mobile reuse the same state machine). */
  sidebarCollapsed: boolean;
  detailsCollapsed: boolean;
  onSidebarCollapsedChange: (collapsed: boolean) => void;
  onDetailsCollapsedChange: (collapsed: boolean) => void;
  /** Drag/click handles exist on desktop only; compact and mobile rely on media queries and header toggles. */
  gutters?: boolean;
}

// dsh handle spec: 8px hit strip + 12x32 dot revealed on hover; transitions off while data-dragging.
export function AppFrame({
  details,
  detailsCollapsed,
  detailsSlot,
  gutters = true,
  center,
  onDetailsCollapsedChange,
  onSidebarCollapsedChange,
  sidebar,
  sidebarCollapsed,
}: AppFrameProps) {
  const { t } = useTranslation();
  const layout = useLayout({ detailsCollapsed, sidebarCollapsed });
  const frameRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const applyFrameWidth = layout.applyFrameWidth;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => applyFrameWidth(width));
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [applyFrameWidth]);

  const { columns } = layout;
  // Five tracks: sidebar | sidebar gutter | center | details gutter | details.
  // The gutter tracks must exist in the template — five children in a
  // three-track grid auto-wrap onto a second row and shred the layout.
  const tracks = [
    `${columns.sidebar}px`,
    "8px",
    "minmax(0, 1fr)",
    "8px",
    columns.detailsOpen ? `${columns.details}px` : "0px",
  ].join(" ");

  return (
    <div className="app-frame" data-dragging={layout.dragging || undefined} ref={frameRef} style={{ "--app-frame-columns": tracks } as React.CSSProperties}>
      <div className="app-frame-sidebar">{sidebar}</div>
      {gutters ? (
        <div
          className="app-frame-gutter"
          data-for="sidebar"
          onPointerDown={(event) => !sidebarCollapsed && layout.startDrag("sidebar", event)}
        >
          <button
            aria-label={t(sidebarCollapsed ? "workbench.expandContext" : "workbench.collapseContext")}
            className="app-frame-handle"
            onClick={() => {
              if (layout.didDrag()) return;
              onSidebarCollapsedChange(!sidebarCollapsed);
            }}
            type="button"
          />
        </div>
      ) : null}
      <div className="app-frame-center">{center}</div>
      {detailsSlot === "panel" && gutters ? (
        <>
          <div
            className="app-frame-gutter"
            data-for="details"
            onPointerDown={(event) => !detailsCollapsed && layout.startDrag("details", event)}
          >
            <button
              aria-label={t(detailsCollapsed ? "workbench.expandWorkspace" : "workbench.collapseWorkspace")}
              className="app-frame-handle"
              data-closed={!columns.detailsOpen || undefined}
              onClick={() => {
                if (layout.didDrag()) return;
                onDetailsCollapsedChange(!detailsCollapsed);
              }}
              type="button"
            />
          </div>
          <div className="app-frame-details" data-closed={!columns.detailsOpen || undefined}>{details}</div>
        </>
      ) : detailsSlot === "panel" ? (
        <div className="app-frame-details" data-closed={!columns.detailsOpen || undefined}>{details}</div>
      ) : null}
    </div>
  );
}
