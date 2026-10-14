import type { ApiRequestContext } from "./context.js";

/** Deployment profile the BFF is running, as reported by `GET /api/mode`. */
export interface ServerMode {
  /** True when the BFF runs the local-first profile: no sign-in step. */
  localMode: boolean;
}

/**
 * Read the deployment profile.
 *
 * The BFF answers this itself, so this is the WebUI's single source of truth
 * for the mode: the frontend never inspects its own environment variables.
 */
export function getMode(client: ApiRequestContext): Promise<ServerMode> {
  return client.request<ServerMode>("/api/mode");
}
