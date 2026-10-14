/**
 * Shared HTTP helpers and route context for the Agent Server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { deriveIdentity } from "../lib/auth.js";
import type { ProfileService } from "../billing/profile-service.js";
import type { PaymentService } from "../billing/payment-service.js";
import type { MembershipService } from "../billing/membership-service.js";
import type { CommunityService } from "../community/service.js";
import type { ByokKeyService } from "../lib/byok-service.js";
import type { EntitlementPort, TurnCostPolicy } from "../lib/policy-ports.js";
import type { InteractionResponseV1 } from "../interactions/types.js";
import { DbClient } from "../lib/db.js";
import { SessionDomainError } from "../session/types.js";
import { resolve, dirname } from "node:path";
import { createLogger } from "../lib/logger.js";

const log = createLogger("server");

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export function jsonResponse(res: import("node:http").ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

export function errorResponse(
  res: import("node:http").ServerResponse,
  status: number,
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): void {
  jsonResponse(res, {
    error: {
      code,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    },
  }, status);
}

export function apiTokenInfrastructureError(
  res: import("node:http").ServerResponse,
  error: unknown,
): void {
  log.error("API token repository error:", error);
  errorResponse(res, 500, "INTERNAL_ERROR");
}

export function textResponse(res: import("node:http").ServerResponse, data: string, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() });
  res.end(data);
}

export function parseBytes(req: import("node:http").IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) reject(new RequestBodyTooLargeError());
      else chunks.push(bytes);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function parseBody(req: import("node:http").IncomingMessage): Promise<string> {
  return (await parseBytes(req)).toString("utf8");
}

export function extractToken(req: import("node:http").IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

export async function validateProjectOwnership(token: string, projectId: string, userId: string): Promise<boolean> {
  const db = DbClient.forUser(token);
  const project = await db.getProject(projectId);
  // Only block on a real ownership mismatch. A missing project is left for
  // the downstream handler to reject — returning "not found" here would 403
  // requests that previously proceeded (e.g. a brand-new project id).
  return Boolean(project?.owner_id && String(project.owner_id) !== String(userId));
}

export function decodeApiTokenId(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded && decoded.length <= 200 ? decoded : null;
  } catch {
    return null;
  }
}

export function parseInteractionResponseEnvelope(value: unknown): InteractionResponseV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionDomainError("INTERACTION_CONFLICT", "Invalid interaction response", 400);
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 16 * 1024) {
    throw new SessionDomainError("INTERACTION_CONFLICT", "Interaction response is too large", 413);
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1
    || typeof input.interactionId !== "string"
    || typeof input.idempotencyKey !== "string"
    || !Array.isArray(input.answers)
    || (input.freeAnswer !== undefined && typeof input.freeAnswer !== "string")) {
    throw new SessionDomainError("INTERACTION_CONFLICT", "Invalid interaction response", 400);
  }
  return input as unknown as InteractionResponseV1;
}

export class RequestBodyTooLargeError extends Error {}

export type SessionIdentity = NonNullable<Awaited<ReturnType<typeof deriveIdentity>>>;

/** Request-scoped context handed to every route handler. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  token: string;
  identity: SessionIdentity;
  userId: SessionIdentity["userId"];
  email: SessionIdentity["email"];
  params: RegExpMatchArray;
  profileService: () => ProfileService;
  paymentService: () => PaymentService;
  membershipService: () => MembershipService;
  communityService: () => CommunityService;
  byokService: () => ByokKeyService;
  /**
   * Membership gate port for core route handlers. The composition root injects the
   * implementation (hosted: `billing/entitlement-adapter.ts`; local-first:
   * `ALLOW_ALL_ENTITLEMENTS`), so `server/routes/**` never import the membership
   * catalog. SaaS handlers keep using `membershipService()` above.
   */
  entitlements: () => EntitlementPort;
  /**
   * Turn-cost facts for the chat pre-flight. The gate itself — branch order and
   * every user-facing message — stays in `server/routes/chat.ts`; this port only
   * answers what the core cannot know (premium catalog, free models, balance).
   */
  chatPreflight: () => TurnCostPolicy;
}

/** Subset available before authentication (health, models, zpay). */
export interface PublicRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
}

export interface RouteEntry<C = RouteContext> {
  /** Undefined = any method (handler branches internally). */
  method?: string;
  exact?: string;
  pattern?: RegExp;
  handler: (ctx: C) => Promise<void>;
}
