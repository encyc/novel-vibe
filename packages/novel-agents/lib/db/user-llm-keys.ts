import type { DbRequestContext } from "./context.js";

/**
 * BYOK key rows. All functions assume a system DbRequestContext: RLS grants
 * browsers only owner-safe metadata columns, and every statement here carries
 * an explicit owner predicate so postgres-role access cannot drift into
 * cross-user reads.
 */

export async function listActiveUserLlmKeys(ctx: DbRequestContext, userId: string): Promise<any[]> {
  const url = `${ctx.pgUrl}/user_llm_keys?user_id=eq.${encodeURIComponent(userId)}&revoked_at=is.null&order=updated_at.desc`;
  const res = await fetch(url, { headers: ctx.headers() });
  if (!res.ok) throw new Error(`List user LLM keys failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

export async function findActiveUserLlmKey(ctx: DbRequestContext, userId: string, provider: string): Promise<any | null> {
  const url = `${ctx.pgUrl}/user_llm_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}&revoked_at=is.null&limit=1`;
  const res = await fetch(url, { headers: ctx.headers() });
  if (!res.ok) throw new Error(`Find user LLM key failed [${res.status}]: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

export async function upsertUserLlmKey(ctx: DbRequestContext, params: {
  userId: string;
  provider: string;
  encryptedKey: string;
  keyLast4: string;
}): Promise<any> {
  const existing = await findActiveUserLlmKey(ctx, params.userId, params.provider);
  if (existing) {
    const url = `${ctx.pgUrl}/user_llm_keys?id=eq.${encodeURIComponent(existing.id)}&user_id=eq.${encodeURIComponent(params.userId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({ Prefer: "return=representation" }),
      body: JSON.stringify({
        encrypted_key: params.encryptedKey,
        key_last4: params.keyLast4,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`Update user LLM key failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0];
  }
  const res = await fetch(`${ctx.pgUrl}/user_llm_keys`, {
    method: "POST",
    headers: ctx.headers({ Prefer: "return=representation" }),
    body: JSON.stringify({
      user_id: params.userId,
      provider: params.provider,
      encrypted_key: params.encryptedKey,
      key_last4: params.keyLast4,
    }),
  });
  if (!res.ok) throw new Error(`Insert user LLM key failed [${res.status}]: ${await res.text()}`);
  const rows = await res.json();
  return rows[0];
}

export async function revokeUserLlmKey(ctx: DbRequestContext, userId: string, provider: string): Promise<boolean> {
  const url = `${ctx.pgUrl}/user_llm_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}&revoked_at=is.null`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: ctx.headers({ Prefer: "return=representation" }),
    body: JSON.stringify({ revoked_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Revoke user LLM key failed [${res.status}]: ${await res.text()}`);
  const rows = await res.json();
  return rows.length > 0;
}
