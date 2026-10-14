import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type ApiTokenLifetimeDays,
  type ApiTokenPreset,
  type ApiTokenScope,
  type ApiTokenSummary,
  type CreatedApiToken,
} from "../api/client";
import { localizeApiError } from "../i18n/error-message";
import { formatDate } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import { IconButton } from "../ui/IconButton";

const TOKEN_QUERY_KEY = ["profile", "api-tokens"] as const;
const PRESETS: Array<{ id: ApiTokenPreset; key: "read" | "write" | "agent" }> = [
  { id: "read", key: "read" },
  { id: "write", key: "write" },
  { id: "agent:run", key: "agent" },
];

function scopeLabelKeys(scopes: readonly ApiTokenScope[]): Array<"read" | "write" | "agent"> {
  const labels: Array<"read" | "write" | "agent"> = [];
  if (scopes.some((scope) => scope.endsWith(":read") || scope === "billing:read")) labels.push("read");
  if (scopes.some((scope) => scope.endsWith(":write") || scope.endsWith(":export"))) labels.push("write");
  if (scopes.includes("agents:run")) labels.push("agent");
  return labels;
}

function withoutPlaintext(created: CreatedApiToken): ApiTokenSummary {
  const { token: _token, ...summary } = created;
  return summary;
}

export function ApiTokenCard() {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const queryClient = useQueryClient();
  const tokens = useQuery({ queryKey: TOKEN_QUERY_KEY, queryFn: () => api.listApiTokens() });
  const [name, setName] = useState("");
  const [lifetimeDays, setLifetimeDays] = useState<ApiTokenLifetimeDays>(30);
  const [presets, setPresets] = useState<ApiTokenPreset[]>(["read"]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenSummary | null>(null);

  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.revokeApiToken(tokenId),
    onSuccess: async () => {
      setRevokeTarget(null);
      await queryClient.invalidateQueries({ queryKey: TOKEN_QUERY_KEY });
    },
  });

  function togglePreset(preset: ApiTokenPreset) {
    setPresets((current) => current.includes(preset)
      ? current.filter((item) => item !== preset)
      : [...current, preset]);
  }

  async function createToken() {
    const trimmedName = name.trim();
    if (!trimmedName) { setCreateError(t("profile.apiTokens.requiredName")); return; }
    if (presets.length === 0) { setCreateError(t("profile.apiTokens.requiredPreset")); return; }
    setCreating(true);
    setCreateError("");
    try {
      const created = await api.createApiToken({ name: trimmedName, lifetimeDays, presets });
      queryClient.setQueryData<ApiTokenSummary[]>(TOKEN_QUERY_KEY, (current = []) => [withoutPlaintext(created), ...current]);
      setPlaintext(created.token);
      setName("");
    } catch (error) {
      setCreateError(localizeApiError(error, "profile.apiTokens.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  function closePlaintext() {
    setPlaintext(null);
    setCopied(false);
  }

  async function copyPlaintext() {
    if (!plaintext) return;
    await navigator.clipboard.writeText(plaintext);
    setCopied(true);
  }

  return <>
    <form className="api-token-form" onSubmit={(event) => { event.preventDefault(); void createToken(); }}>
      <label>{t("profile.apiTokens.name")}<input aria-label={t("profile.apiTokens.name")} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t("profile.apiTokens.namePlaceholder")} value={name} /></label>
      <label>{t("profile.apiTokens.lifetime")}<select aria-label={t("profile.apiTokens.lifetime")} onChange={(event) => setLifetimeDays(Number(event.target.value) as ApiTokenLifetimeDays)} value={lifetimeDays}>
        {[30, 90, 365].map((days) => <option key={days} value={days}>{t("profile.apiTokens.days", { count: days })}</option>)}
      </select></label>
      <fieldset><legend>{t("profile.apiTokens.presets")}</legend><div className="api-token-presets">{PRESETS.map((preset) => <label key={preset.id}>
        <input checked={presets.includes(preset.id)} onChange={() => togglePreset(preset.id)} type="checkbox" />
        <span><strong>{t(`profile.apiTokens.preset.${preset.key}.label`)}</strong><small>{t(`profile.apiTokens.preset.${preset.key}.detail`)}</small></span>
      </label>)}</div></fieldset>
      <p className="api-token-warning">{t("profile.apiTokens.warning")}</p>
      {createError && <p className="api-token-error" role="alert">{createError}</p>}
      <button className="primary-button" disabled={creating} type="submit"><KeyRound size={15} />{t(creating ? "profile.apiTokens.creating" : "profile.apiTokens.create")}</button>
    </form>

    <div className="api-token-list" aria-live="polite">
      {tokens.isPending && <p className="profile-empty">{t("profile.apiTokens.loading")}</p>}
      {tokens.isError && <p className="api-token-error" role="alert">{t("profile.apiTokens.loadFailed")}</p>}
      {tokens.data?.length === 0 && <p className="profile-empty">{t("profile.apiTokens.empty")}</p>}
      {tokens.data?.map((token) => <article className="api-token-row" data-revoked={Boolean(token.revoked_at)} key={token.id}>
        <div className="api-token-row-head"><div><strong>{token.name}</strong><code>lingqi_{token.public_id}</code></div>
          {!token.revoked_at && <IconButton label={t("profile.apiTokens.revokeAria", { name: token.name })} onClick={() => setRevokeTarget(token)} tone="danger" type="button"><Trash2 size={15} /></IconButton>}
        </div>
        <div className="api-token-scopes">{scopeLabelKeys(token.scopes).map((key) => <span key={key}>{t(`profile.apiTokens.scope.${key}`)}</span>)}{token.revoked_at && <span>{t("profile.apiTokens.revoked")}</span>}</div>
        <dl><div><dt>{t("profile.apiTokens.created")}</dt><dd>{formatDate(token.created_at, locale, { dateStyle: "medium" })}</dd></div><div><dt>{t("profile.apiTokens.expires")}</dt><dd>{formatDate(token.expires_at, locale, { dateStyle: "medium" })}</dd></div><div><dt>{t("profile.apiTokens.lastUsed")}</dt><dd>{token.last_used_at ? formatDate(token.last_used_at, locale, { dateStyle: "medium" }) : t("profile.apiTokens.neverUsed")}</dd></div></dl>
      </article>)}
    </div>

    <Dialog.Root open={plaintext !== null}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content api-token-secret-dialog" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
        <div className="dialog-heading"><Dialog.Title>{t("profile.apiTokens.saveTitle")}</Dialog.Title></div>
        <Dialog.Description>{t("profile.apiTokens.saveDescription")}</Dialog.Description>
        <div className="api-token-secret"><code>{plaintext}</code><IconButton label={t("profile.apiTokens.copy")} onClick={() => void copyPlaintext()} type="button">{copied ? <Check size={16} /> : <Copy size={16} />}</IconButton></div>
        <div className="dialog-actions"><button className="primary-button" onClick={closePlaintext} type="button">{t("profile.apiTokens.closeSecret")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root onOpenChange={(open) => { if (!open && !revoke.isPending) setRevokeTarget(null); }} open={revokeTarget !== null}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
        <div className="dialog-heading"><Dialog.Title>{t("profile.apiTokens.revokeTitle")}</Dialog.Title></div>
        <Dialog.Description>{t("profile.apiTokens.revokeDescription", { name: revokeTarget?.name ?? "" })}</Dialog.Description>
        {revoke.isError && <p className="api-token-error" role="alert">{t("profile.apiTokens.revokeFailed")}</p>}
        <div className="dialog-actions"><Dialog.Close className="secondary-button">{t("common.cancel")}</Dialog.Close><button className="danger-button" disabled={revoke.isPending} onClick={() => revokeTarget && revoke.mutate(revokeTarget.id)} type="button">{t(revoke.isPending ? "profile.apiTokens.revoking" : "profile.apiTokens.confirmRevoke")}</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
