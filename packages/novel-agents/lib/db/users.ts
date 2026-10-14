import type { SupportedLanguage } from "../language.js";

import type { DbRequestContext } from "./context.js";

export interface UserProfileRow {
  id: string;
  nickname: string | null;
  avatar_url: string | null;
  locale: SupportedLanguage | null;
}

export async function getLevelConfig(ctx: DbRequestContext, level: number): Promise<any | null> {
    const url = `${ctx.pgUrl}/level_config?level=eq.${level}`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`Get level config failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ?? null;
  }

export async function listLevelConfigs(ctx: DbRequestContext): Promise<any[]> {
    const url = `${ctx.pgUrl}/level_config?order=level.asc`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) throw new Error(`List level configs failed [${res.status}]: ${await res.text()}`);
    return res.json();
  }

export async function recalcUserLevel(ctx: DbRequestContext, userId: string): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/rpc/recalc_user_level`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) throw new Error(`Recalc user level failed [${res.status}]: ${await res.text()}`);
  }

export async function getUserProfile(ctx: DbRequestContext, userId: string): Promise<UserProfileRow | null> {
    const url = `${ctx.pgUrl}/users?id=eq.${encodeURIComponent(userId)}&select=id,nickname,avatar_url,locale&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get user profile failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json() as UserProfileRow[];
    return rows[0] ?? null;
  }

export async function upsertUserProfile(ctx: DbRequestContext, params: {
    userId: string;
    nickname: string | null;
    avatarUrl: string | null;
    locale: SupportedLanguage;
  }): Promise<UserProfileRow> {
    const url = `${ctx.pgUrl}/users?id=eq.${encodeURIComponent(params.userId)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: ctx.headers({
        "Accept-Profile": "public",
        "Content-Profile": "public",
        Prefer: "return=representation",
      }),
      body: JSON.stringify({
        nickname: params.nickname,
        avatar_url: params.avatarUrl,
        locale: params.locale,
      }),
    });
    if (!res.ok) throw new Error(`Update user profile failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json() as UserProfileRow[];
    if (!rows[0]) throw new Error(`No user profile found for ${params.userId}`);
    return rows[0];
  }

/**
 * Create the fixed local-first owner row if it does not exist.
 *
 * `novel.projects.owner_id` references `auth.users(id)`, so a local install needs a
 * real owner row before it can create its first project. It cannot be created through
 * `public.users`: that view does not expose `email`, which `auth.users` requires, and
 * the `auth` schema is not exposed to PostgREST at all. The exposed `novel` schema
 * therefore carries a SECURITY DEFINER RPC (migration 040) for exactly this.
 *
 * Idempotent — the function is `ON CONFLICT (id) DO NOTHING`, so every local start
 * may call it.
 */
export async function ensureUserRow(ctx: DbRequestContext, params: {
    userId: string;
    email: string;
    nickname?: string | null;
  }): Promise<void> {
    const res = await fetch(`${ctx.pgUrl}/rpc/ensure_local_user`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_user_id: params.userId,
        p_email: params.email,
        p_nickname: params.nickname ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Ensure user row failed [${res.status}]: ${await res.text()}`);
  }

