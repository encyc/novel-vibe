import { createContext, useContext } from "react";
import type { ChatTraceState, DelegationSummary } from "./chat-trace";

export interface DelegationDrillTarget {
  callId: string;
  agentId: string | null;
  /** Owning chat session; the durable transcript endpoint is keyed by it. */
  sessionId: string | null;
  /** Aggregated row data at click time, for the breadcrumb label. */
  summary?: Pick<DelegationSummary, "agentId" | "running" | "isError" | "durationMs">;
  /**
   * Live trace state captured when the drill opens. Used while the owning
   * run is still streaming; the durable transcript API replaces it once it
   * has rows.
   */
  stateSnapshot?: ChatTraceState;
  /**
   * Liveness check evaluated against the freshest trace registry at call
   * time, so the drill-in stops polling once the owning run settles.
   */
  isRunningNow?: () => boolean;
}

/** Trace rows have no session scope; the shell contributes it on open. */
export type DelegationDrillRequest = Omit<DelegationDrillTarget, "sessionId">;

export interface DelegationDrillContextValue {
  open(target: DelegationDrillRequest): void;
  /** Latest trace per assistantMessageId, refreshed on every ChatTrace render. */
  liveTraces: { current: Record<string, ChatTraceState> };
}

export const DelegationDrillContext = createContext<DelegationDrillContextValue | null>(null);

export function useDelegationDrill() {
  return useContext(DelegationDrillContext);
}
