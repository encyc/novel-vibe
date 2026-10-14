import { decodeJwt } from "jose";

export interface InsForgeAuthResult {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
}

function accessTokenExpiresAt(accessToken: string): number {
  try {
    const exp = decodeJwt(accessToken).exp;
    if (typeof exp === "number") return exp;
  } catch {
    // InsForge access tokens currently expire after 15 minutes. This fallback
    // keeps test doubles and older compatible servers refreshable.
  }
  return Math.floor(Date.now() / 1000) + 15 * 60;
}

export async function authenticateWithInsForge(
  baseUrl: string,
  mode: "login" | "signup",
  email: string,
  password: string,
): Promise<InsForgeAuthResult> {
  const endpoint = mode === "signup" ? "/api/auth/users?client_type=server" : "/api/auth/sessions?client_type=server";
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mode === "signup" ? { email, password, name: email.split("@")[0] || email } : { email, password }),
  });

  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? (mode === "signup" ? "注册失败" : "登录失败");
    throw new Error(String(message));
  }

  if (!payload?.user?.id || !payload?.user?.email || !payload?.accessToken || !payload?.refreshToken) {
    throw new Error("InsForge returned an incomplete auth session");
  }

  return {
    userId: String(payload.user.id),
    email: String(payload.user.email),
    accessToken: String(payload.accessToken),
    refreshToken: String(payload.refreshToken),
    accessTokenExpiresAt: accessTokenExpiresAt(String(payload.accessToken)),
  };
}

export async function refreshInsForgeSession(baseUrl: string, refreshToken: string): Promise<Pick<InsForgeAuthResult, "accessToken" | "refreshToken" | "accessTokenExpiresAt">> {
  const response = await fetch(`${baseUrl}/api/auth/refresh?client_type=server`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || !payload?.accessToken || !payload?.refreshToken) {
    const message = payload?.message ?? payload?.error ?? "Unable to refresh InsForge session";
    throw new Error(String(message));
  }
  return {
    accessToken: String(payload.accessToken),
    refreshToken: String(payload.refreshToken),
    accessTokenExpiresAt: accessTokenExpiresAt(String(payload.accessToken)),
  };
}
