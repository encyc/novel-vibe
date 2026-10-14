import { createHmac, randomBytes, randomInt } from "node:crypto";

export function normalizeRegistrationEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isRegistrationEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

export function generateEmailCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function secretHash(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex");
}

export function registrationSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.REGISTRATION_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (env.NODE_ENV !== "production" && env.JWT_SECRET?.trim()) return env.JWT_SECRET.trim();
  throw new Error("REGISTRATION_TOKEN_SECRET is required");
}
