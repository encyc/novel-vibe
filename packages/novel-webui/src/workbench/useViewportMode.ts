import { useEffect, useState } from "react";

export type ViewportMode = "mobile" | "compact" | "desktop";

export const MOBILE_QUERY = "(max-width: 767px), (max-height: 500px) and (pointer: coarse)";
export const COMPACT_QUERY = "(max-width: 1179px)";

export function resolveViewportMode(mobile: boolean, compact: boolean): ViewportMode {
  return mobile ? "mobile" : compact ? "compact" : "desktop";
}

function currentViewportMode(): ViewportMode {
  if (typeof window.matchMedia !== "function") return "desktop";
  return resolveViewportMode(
    window.matchMedia(MOBILE_QUERY).matches,
    window.matchMedia(COMPACT_QUERY).matches,
  );
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState(currentViewportMode);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobile = window.matchMedia(MOBILE_QUERY);
    const compact = window.matchMedia(COMPACT_QUERY);
    const update = () => setMode(resolveViewportMode(mobile.matches, compact.matches));
    update();
    mobile.addEventListener("change", update);
    compact.addEventListener("change", update);
    return () => {
      mobile.removeEventListener("change", update);
      compact.removeEventListener("change", update);
    };
  }, []);

  return mode;
}
