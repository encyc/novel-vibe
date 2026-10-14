import { createContext, type PropsWithChildren, useContext, useLayoutEffect, useMemo, useState } from "react";

export type DisplayScale = "extra-compact" | "compact" | "default" | "comfortable" | "large";

interface DisplayScaleContextValue {
  scale: DisplayScale;
  setScale: (scale: DisplayScale) => void;
}

const STORAGE_KEY = "novel-vibe-display-scale";
const DisplayScaleContext = createContext<DisplayScaleContextValue>({
  scale: "default",
  setScale: () => undefined,
});

function storedScale(): DisplayScale {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "extra-compact"
    || value === "compact"
    || value === "default"
    || value === "comfortable"
    || value === "large"
    ? value
    : "default";
}

export function DisplayScaleProvider({ children }: PropsWithChildren) {
  const [scale, setScaleState] = useState<DisplayScale>(storedScale);

  useLayoutEffect(() => {
    document.documentElement.dataset.displayScale = scale;
  }, [scale]);

  const value = useMemo<DisplayScaleContextValue>(() => ({
    scale,
    setScale(nextScale) {
      window.localStorage.setItem(STORAGE_KEY, nextScale);
      setScaleState(nextScale);
    },
  }), [scale]);

  return <DisplayScaleContext.Provider value={value}>{children}</DisplayScaleContext.Provider>;
}

export function useDisplayScale() {
  return useContext(DisplayScaleContext);
}
