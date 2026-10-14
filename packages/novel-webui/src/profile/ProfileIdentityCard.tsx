import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { localizeApiError } from "../i18n/error-message";
import type { UserProfile } from "../types";

export function ProfileIdentityCard({ profile }: { profile: UserProfile }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const save = useMutation({
    mutationFn: async () => {
      const trimmed = name.trim();
      if ([...trimmed].length < 1 || [...trimmed].length > 40) throw new Error(t("profile.identityCard.invalidName"));
      let updated = await api.updateProfile({ displayName: trimmed });
      if (avatar) updated = await api.uploadAvatar(avatar);
      return updated;
    },
    onSuccess: (updated) => { queryClient.setQueryData(["profile"], updated); setEditing(false); setAvatar(null); setError(null); },
    onError: (reason) => setError(localizeApiError(reason, "profile.identityCard.saveFailed")),
  });
  function selectAvatar(file: File | undefined) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError(t("profile.identityCard.invalidAvatar")); return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setAvatar(file); setPreview(URL.createObjectURL(file)); setError(null);
  }
  return (
    <div className="profile-identity">
      <div className="profile-avatar">{preview || profile.avatarUrl ? <img alt={t("profile.identityCard.avatarAlt")} src={preview ?? profile.avatarUrl ?? ""} /> : <span>{profile.displayName.slice(0, 1)}</span>}</div>
      {editing ? (
        <div className="profile-edit-form">
          <label>{t("profile.identityCard.displayName")}<input aria-label={t("profile.identityCard.displayName")} maxLength={40} onChange={(event) => setName(event.target.value)} value={name} /></label>
          <label className="avatar-picker"><Camera size={15} />{t("profile.identityCard.changeAvatar")}<input accept="image/jpeg,image/png,image/webp" aria-label={t("profile.identityCard.avatarInput")} onChange={(event) => selectAvatar(event.target.files?.[0])} type="file" /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div><button className="secondary-button" onClick={() => { setEditing(false); setName(profile.displayName); setError(null); }} type="button">{t("profile.identityCard.cancel")}</button><button className="primary-button" disabled={save.isPending} onClick={() => save.mutate()} type="button">{t("profile.identityCard.save")}</button></div>
        </div>
      ) : (
        <div className="profile-identity-copy"><strong>{profile.displayName}</strong><span>{profile.email}</span><small>{profile.id}</small></div>
      )}
      {!editing ? <button className="secondary-button profile-edit-action" onClick={() => setEditing(true)} type="button"><Pencil size={14} />{t("profile.identityCard.edit")}</button> : null}
    </div>
  );
}
