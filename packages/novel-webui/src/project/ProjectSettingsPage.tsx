import { useMutation } from "@tanstack/react-query";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { Project } from "../types";
import { WorkspaceColophon } from "../workbench/WorkspaceColophon";

interface ProjectSettingsPageProps {
  project: Project;
  onProjectChanged: (project: Project | null) => void;
}

export function ProjectSettingsPage({ onProjectChanged, project }: ProjectSettingsPageProps) {
  const { t } = useTranslation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => { setConfirmingDelete(false); setConfirmation(""); }, [project.id]);

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateProject>[1]) => api.updateProject(project.id, patch),
    onSuccess: onProjectChanged,
  });
  const lifecycle = useMutation({
    mutationFn: (command: "archive" | "trash" | "restore") => command === "archive"
      ? api.archiveProject(project.id)
      : command === "trash"
        ? api.trashProject(project.id)
        : api.restoreProject(project.id),
    onSuccess: onProjectChanged,
  });
  const permanentDelete = useMutation({
    mutationFn: () => api.permanentlyDeleteProject(project.id),
    onSuccess: () => onProjectChanged(null),
  });
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    update.mutate({
      title: String(data.get("title") ?? "").trim(),
      genre: String(data.get("genre") ?? "").trim() || null,
      synopsis: String(data.get("synopsis") ?? "").trim() || null,
      writing_stage: String(data.get("writing_stage")) as Project["writing_stage"],
      creative_language: String(data.get("creative_language")) as Project["creative_language"],
    });
  }

  const status = project.lifecycle_status ?? "active";
  return (
    <div className="project-settings-page">
      <WorkspaceColophon eyebrow="PROJECT ARCHIVE · 05" title={t("projects.settingsTitle")} detail={t("projects.settingsDetail")} />
      <section aria-label={t("projects.archiveRegion")} className="project-settings-archive">
        <form className="project-settings-card" onSubmit={save}>
        <h2>{t("projects.basicInfo")}</h2>
        <label>{t("projects.title")}<input defaultValue={project.title} name="title" required /></label>
        <label>{t("projects.genre")}<input defaultValue={project.genre ?? ""} name="genre" /></label>
        <label>{t("projects.synopsis")}<textarea defaultValue={project.synopsis ?? ""} name="synopsis" rows={4} /></label>
        <label>{t("projects.writingStage")}<select defaultValue={project.writing_stage ?? "planning"} name="writing_stage"><option value="planning">{t("projects.stages.planning")}</option><option value="drafting">{t("projects.stages.drafting")}</option><option value="revising">{t("projects.stages.revising")}</option><option value="completed">{t("projects.stages.completed")}</option></select></label>
        <label>{t("projects.creativeLanguage")}<select aria-label={t("projects.creativeLanguage")} defaultValue={project.creative_language} name="creative_language"><option value="zh-CN">{t("common.chinese")}</option><option value="en">{t("common.english")}</option></select><small>{t("projects.creativeLanguageHelp")}</small></label>
        <button className="primary-button" disabled={update.isPending || status !== "active"} type="submit">{t("projects.saveDetails")}</button>
        </form>
        <section className="project-settings-card danger-zone">
        <h2>{t("projects.lifecycle")}</h2><p className="quiet-copy">{t("projects.lifecycleHelp")}</p>
        <div className="settings-actions">
          {status === "active" ? <button className="secondary-button" onClick={() => lifecycle.mutate("archive")} type="button"><Archive size={15} />{t("projects.archive")}</button> : null}
          {status !== "trash" ? <button className="secondary-button" onClick={() => lifecycle.mutate("trash")} type="button"><Trash2 size={15} />{t("projects.moveToTrash")}</button> : null}
          {status !== "active" ? <button className="secondary-button" onClick={() => lifecycle.mutate("restore")} type="button"><RotateCcw size={15} />{t("projects.restore")}</button> : null}
          {status === "trash" ? <button className="danger-button" onClick={() => setConfirmingDelete(true)} type="button">{t("projects.permanentlyDelete")}</button> : null}
        </div>
        {confirmingDelete ? <div className="permanent-delete-confirm"><p>{t("projects.deletePrompt", { title: project.title })}</p><label>{t("projects.deleteConfirmation")}<input onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label><button className="danger-button" disabled={confirmation !== project.title || permanentDelete.isPending} onClick={() => permanentDelete.mutate()} type="button">{t("projects.confirmPermanentDelete")}</button></div> : null}
        </section>
      </section>
    </div>
  );
}
