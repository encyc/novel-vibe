import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  const bytes = await readBody(req);
  const text = bytes.toString("utf8");
  return text ? JSON.parse(text) as T : {} as T;
}

export async function readBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function json(
  res: ServerResponse,
  data: unknown,
  status = 200,
  headers: OutgoingHttpHeaders = {},
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}

export function errorResponse(
  res: ServerResponse,
  status: number,
  code: string,
  message?: string,
  details?: Record<string, unknown>,
  headers: OutgoingHttpHeaders = {},
): void {
  json(res, {
    error: {
      code,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
    },
  }, status, headers);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = pair.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = rawValue.join("=");
  }
  return cookies;
}

export function cookieFlags(isSecure: boolean, maxAgeSeconds: number, domain?: string): string {
  return [
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    isSecure ? "Secure" : "",
    domain ? `Domain=${domain}` : "",
  ].filter(Boolean).join("; ");
}

export function isStateChangingMethod(method: string | undefined): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method ?? "GET");
}

export function hasAllowedBrowserOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  return !origin || allowedOrigins.includes(origin);
}
