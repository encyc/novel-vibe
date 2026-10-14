import type { DbRequestContext } from "./context.js";

export async function getActiveAgentResource(ctx: DbRequestContext, resourceType: string, resourceKey: string): Promise<any | null> {
    const select = "id,resource_type,resource_key,active_version:agent_resource_versions!agent_resources_active_version_fk(*)";
    const url = `${ctx.pgUrl}/agent_resources?resource_type=eq.${encodeURIComponent(resourceType)}`
      + `&resource_key=eq.${encodeURIComponent(resourceKey)}&select=${encodeURIComponent(select)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get active agent resource failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0] ?? null;
  }

export async function getNextAgentResourceVersion(ctx: DbRequestContext, resourceType: string, resourceKey: string): Promise<number> {
    const active = await getActiveAgentResource(ctx, resourceType, resourceKey);
    if (!active) return 1;
    const url = `${ctx.pgUrl}/agent_resource_versions?resource_id=eq.${encodeURIComponent(active.id)}`
      + "&select=version_number&order=version_number.desc&limit=1";
    const res = await fetch(url, { headers: ctx.headers({ "Accept-Profile": "public" }) });
    if (!res.ok) throw new Error(`Get next agent resource version failed [${res.status}]: ${await res.text()}`);
    const rows = await res.json();
    return rows[0] ? Number(rows[0].version_number) + 1 : 1;
  }

export async function publishAgentResourceVersion(ctx: DbRequestContext, input: {
    resourceType: string; resourceKey: string; versionNumber: number;
    storagePath: string; contentHash: string; changeNote?: string;
  }): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/rpc/publish_agent_resource_version`, {
      method: "POST",
      headers: ctx.headers({ "Accept-Profile": "public", "Content-Profile": "public" }),
      body: JSON.stringify({
        p_resource_type: input.resourceType, p_resource_key: input.resourceKey,
        p_version_number: input.versionNumber, p_storage_path: input.storagePath,
        p_content_hash: input.contentHash, p_change_note: input.changeNote ?? null,
      }),
    });
    if (!res.ok) throw new Error(`Publish agent resource failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }

export async function activateAgentResourceVersion(ctx: DbRequestContext, resourceType: string, resourceKey: string, versionNumber: number): Promise<any> {
    const res = await fetch(`${ctx.pgUrl}/rpc/activate_agent_resource_version`, {
      method: "POST",
      headers: ctx.headers({ "Accept-Profile": "public", "Content-Profile": "public" }),
      body: JSON.stringify({
        p_resource_type: resourceType, p_resource_key: resourceKey, p_version_number: versionNumber,
      }),
    });
    if (!res.ok) throw new Error(`Activate agent resource failed [${res.status}]: ${await res.text()}`);
    return (await res.json())[0];
  }
