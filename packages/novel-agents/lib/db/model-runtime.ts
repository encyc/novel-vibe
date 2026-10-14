import {
  mapRuntimeModelRow,
  type DisableRuntimeModelInput,
  type RuntimeModelApiRow,
  type RuntimeModelRow,
} from "../../model-runtime/types.js";

import type { DbRequestContext } from "./context.js";

export async function getRuntimeModel(ctx: DbRequestContext, provider: string, modelId: string): Promise<RuntimeModelRow | null> {
    const url = `${ctx.pgUrl}/model_runtime_catalog?provider=eq.${encodeURIComponent(provider)}&model_id=eq.${encodeURIComponent(modelId)}&limit=1`;
    const res = await fetch(url, { headers: ctx.headers() });
    if (!res.ok) {
      throw new Error(`Get runtime model failed [${res.status}]: ${await res.text()}`);
    }
    const rows = await res.json() as RuntimeModelApiRow[];
    return rows[0] ? mapRuntimeModelRow(rows[0]) : null;
  }

export async function disableRuntimeModel(ctx: DbRequestContext, input: DisableRuntimeModelInput): Promise<boolean> {
    const res = await fetch(`${ctx.pgUrl}/rpc/disable_dynamic_model`, {
      method: "POST",
      headers: ctx.headers(),
      body: JSON.stringify({
        p_provider: input.provider,
        p_model_id: input.modelId,
        p_runtime_fingerprint: input.runtimeFingerprint,
        p_classification: input.classification,
        p_error_code: input.errorCode ?? null,
        p_error_summary: input.errorSummary,
        p_request_id: input.requestId ?? null,
        p_recipient: input.recipient ?? null,
      }),
    });
    if (!res.ok) {
      throw new Error(`Disable runtime model failed [${res.status}]: ${await res.text()}`);
    }
    return await res.json() as boolean;
  }
