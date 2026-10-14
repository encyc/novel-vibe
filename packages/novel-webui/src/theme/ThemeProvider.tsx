import { createContext, type PropsWithChildren, useContext, useLayoutEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "novel-vibe-theme";
const ThemeContext = createContext<ThemeContextValue>({ mode: "system", setMode: () => undefined });

function storedMode(): ThemeMode {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<ThemeMode>(storedMode);

  useLayoutEffect(() => {
    const media = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : { addEventListener: () => undefined, matches: false, removeEventListener: () => undefined };
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({
    mode,
    setMode(nextMode) {
      window.localStorage.setItem(STORAGE_KEY, nextMode);
      setModeState(nextMode);
    },
  }), [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
