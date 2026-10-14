import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthPrincipal } from "../../novel-agents/auth/principal.js";

export interface RequestContext {
  principal: AuthPrincipal;
  delegatedToken: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function requireContext(): RequestContext {
  const context = requestContext.getStore();
  if (!context) throw new Error("AUTH_INVALID");
  return context;
}
