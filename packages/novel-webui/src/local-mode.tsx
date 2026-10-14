import { createContext, useContext, type ReactNode } from "react";
import type { User } from "./types";

/**
 * Deployment profile as reported by the BFF's `GET /api/mode`.
 *
 * The default is `false` on purpose: a component rendered outside the provider
 * (a unit test, an isolated story) keeps the hosted behaviour, and the WebUI
 * never derives the mode from anything but the BFF response.
 */
const LocalModeContext = createContext(false);

export function LocalModeProvider({ children, value }: { children: ReactNode; value: boolean }) {
  return <LocalModeContext.Provider value={value}>{children}</LocalModeContext.Provider>;
}

/** True when the WebUI is talking to a local-first BFF. */
export function useLocalMode(): boolean {
  return useContext(LocalModeContext);
}

/**
 * Last-resort identity for local mode when `/api/me` cannot be read.
 *
 * Mirrors the local identity served by the BFF and minted by the agent server
 * (`packages/novel-agents/lib/local-mode.ts`). Entering the app must never
 * depend on it, so it is only a display fallback — but keeping it equal to the
 * real identity means a degraded render still labels the same local user.
 */
export const LOCAL_IDENTITY_FALLBACK: User = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "local@novel-vibe.local.invalid",
};
