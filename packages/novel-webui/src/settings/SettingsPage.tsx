import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ByokProviderConfig, UserLlmKey } from "../api/settings";
import { useLocalMode } from "../local-mode";

/** BYOK key management rendered inside the profile shell at /profile/settings. */
export function SettingsPage() {
  const { t } = useTranslation();
  const localMode = useLocalMode();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ["membership-status"], queryFn: () => api.getMembershipStatus() });
  const configQuery = useQuery({ queryKey: ["byok-config"], queryFn: () => api.getByokConfig() });
  const keysQuery = useQuery({ queryKey: ["llm-keys"], queryFn: () => api.listLlmKeys() });
  // BYOK is a membership benefit on the hosted service. A local install has no
  // plan to sell, so the key manager must not hide behind an upgrade link.
  const hasByok = localMode || (statusQuery.data?.active === true && statusQuery.data.features.includes("byok"));

  const providers = configQuery.data?.providers ?? [];
  const savedByProvider = new Map((keysQuery.data?.keys ?? []).map((key) => [key.provider, key] as const));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Default to the first provider holding a saved key, else the first listed.
  const selected = providers.find((provider) => provider.id === selectedId)
    ?? providers.find((provider) => savedByProvider.has(provider.id))
    ?? providers[0];

  const invalidateKeys = () => {
    queryClient.invalidateQueries({ queryKey: ["llm-keys"] });
  };
  const saveMutation = useMutation({
    mutationFn: ({ provider, apiKey }: { provider: string; apiKey: string }) => api.saveLlmKey(provider, apiKey),
    onSuccess: invalidateKeys,
  });
  const deleteMutation = useMutation({
    mutationFn: (provider: string) => api.deleteLlmKey(provider),
    onSuccess: invalidateKeys,
  });

  return (
    <div className="settings-page" data-embedded="true">
      <header className="settings-header">
        <h1>{t("settings.title")}</h1>
        <p>{t("settings.byok.description")}</p>
      </header>

      <section className="settings-section" aria-labelledby="byok-title">
        <h2 id="byok-title">{t("settings.byok.title")}</h2>
        {!hasByok ? (
          <div className="byok-member-gate">
            <p>{t("settings.byok.memberOnly")}</p>
            <Link className="byok-upgrade-link" to="/profile/membership">{t("settings.byok.upgrade")}</Link>
          </div>
        ) : configQuery.isLoading || keysQuery.isLoading ? null
        : configQuery.data && !configQuery.data.enabled ? (
          <p className="byok-unavailable">{t("settings.byok.unavailable")}</p>
        ) : configQuery.data && configQuery.data.providers.length > 0 ? (
          <div className="byok-manager">
            <label className="byok-provider-select">
              <span>{t("settings.byok.selectProvider")}</span>
              <select
                value={selected?.id ?? ""}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                    {savedByProvider.has(provider.id)
                      ? ` · ${t("settings.byok.savedSuffix", { last4: savedByProvider.get(provider.id)!.keyLast4 })}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {selected ? (
              <ByokProviderCard
                provider={selected}
                saved={savedByProvider.get(selected.id)}
                saveError={saveMutation.error instanceof Error ? saveMutation.error.message : null}
                saving={saveMutation.isPending && saveMutation.variables?.provider === selected.id}
                removing={deleteMutation.isPending && deleteMutation.variables === selected.id}
                onSave={(apiKey) => saveMutation.mutate({ provider: selected.id, apiKey })}
                onRemove={() => deleteMutation.mutate(selected.id)}
              />
            ) : null}
          </div>
        ) : keysQuery.isError || configQuery.isError ? (
          <p className="byok-unavailable">{t("settings.byok.loadFailed")}</p>
        ) : null}
      </section>
    </div>
  );
}

interface ByokProviderCardProps {
  provider: ByokProviderConfig;
  saved?: UserLlmKey;
  saveError: string | null;
  saving: boolean;
  removing: boolean;
  onSave: (apiKey: string) => void;
  onRemove: () => void;
}

function ByokProviderCard({ provider, saved, saveError, saving, removing, onSave, onRemove }: ByokProviderCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const submit = () => {
    if (!apiKey.trim()) return;
    onSave(apiKey.trim());
    setApiKey("");
    setEditing(false);
  };

  return (
    <article className="byok-card" data-provider={provider.id}>
      <h3 className="byok-card-title">{provider.label}</h3>
      {saved && !editing ? (
        <div className="byok-card-saved">
          <p>{t("settings.byok.savedAs", { last4: saved.keyLast4 })}</p>
          <div className="byok-card-actions">
            <button type="button" onClick={() => setEditing(true)}>{t("settings.byok.replace")}</button>
            <button type="button" className="byok-danger" disabled={removing} onClick={onRemove}>
              {removing ? t("settings.byok.removing") : t("settings.byok.remove")}
            </button>
          </div>
        </div>
      ) : (
        <div className="byok-card-form">
          <label>
            <span>{t("settings.byok.keyLabel")}</span>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
            />
          </label>
          {saveError ? <p className="byok-card-error">{saveError}</p> : null}
          <div className="byok-card-actions">
            <button type="button" disabled={saving || !apiKey.trim()} onClick={submit}>
              {saving ? t("settings.byok.saving") : t("settings.byok.save")}
            </button>
            {saved ? (
              <button type="button" onClick={() => setEditing(false)}>{t("settings.byok.savedAs", { last4: saved.keyLast4 })}</button>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}
