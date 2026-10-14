/**
 * Shared request context for db domain modules.
 *
 * DbClient implements this interface; every domain function under lib/db/
 * receives it as its first parameter. It carries the PostgREST endpoint,
 * the InsForge API endpoint, the auth mode, and header generation.
 */

import crypto from "node:crypto";

export interface DbRequestContext {
  readonly pgUrl: string;
  readonly apiUrl: string;
  readonly mode: "user" | "system" | "anon";
  headers(extra?: Record<string, string>): Record<string, string>;
}

export function generateToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET env var is required");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    role: "postgres",
    iss: "insforge",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export function generateStorageToken(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET env var is required");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: "novel-vibe-system",
    email: "system@novel-vibe.local",
    role: "project_admin",
    iss: "insforge",
    iat: Math.floor(Date.now() / 1000),
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
