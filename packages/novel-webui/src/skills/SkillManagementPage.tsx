import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpenText, Feather, FileUp, History, LockKeyhole, Puzzle, RotateCcw, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { localizeApiError } from "../i18n/error-message";
import { formatDate } from "../i18n/format";
import { normalizeInterfaceLocale } from "../i18n/locale";
import type { Project, SkillDraft, SkillReview, SkillRole, SkillVersionSummary } from "../types";

const roles: SkillRole[] = ["chief_editor", "worldbuilder", "character_designer", "outliner", "director", "writer"];

interface SkillManagementPageProps {
  project?: Project;
  accessMode?: "writable" | "read-only";
}

export function SkillManagementPage({ accessMode = "writable", project }: SkillManagementPageProps) {
  const { i18n, t } = useTranslation();
  const locale = normalizeInterfaceLocale(i18n.resolvedLanguage ?? i18n.language);
  const [searchParams] = useSearchParams();
  const linkedDraftId = searchParams.get("draft");
  const client = useQueryClient();
  const installed = useQuery({ queryKey: ["skills"], queryFn: () => api.listSkills() });
  const workspaceSkills = useQuery({
    enabled: Boolean(project),
    queryKey: ["workspace-skills", project?.id],
    queryFn: () => api.listWorkspaceSkills(project!.id),
  });
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [review, setReview] = useState<SkillReview | null>(null);
  const [error, setError] = useState("");
  const linkedDraft = useQuery({
    enabled: Boolean(linkedDraftId),
    queryKey: ["skill-draft", linkedDraftId],
    queryFn: async () => {
      const loaded = await api.getSkillDraft(linkedDraftId!);
      return loaded.status === "draft" ? api.reviewSkillDraft(loaded.id, loaded.version) : { draft: loaded, review: null };
    },
    retry: false,
  });

  useEffect(() => {
    if (!linkedDraft.data) return;
    setDraft(linkedDraft.data.draft);
    if (linkedDraft.data.review) setReview(linkedDraft.data.review);
  }, [linkedDraft.data]);

  const createAndReview = useMutation({
    mutationFn: async (input: { slug: string; content: string; roles: SkillRole[]; filename?: string; source: "upload" | "paste" }) => {
      const created = await api.createSkillDraft(input);
      return api.reviewSkillDraft(created.id, created.version);
    },
    onSuccess: (result) => { setDraft(result.draft); setReview(result.review); setError(""); },
    onError: (cause) => setError(localizeApiError(cause, "skills.errors.review")),
  });
  const confirm = useMutation({
    mutationFn: () => api.confirmSkillDraft(draft!.id, {
      version: draft!.version,
      reviewId: review!.id,
      candidateHash: review!.candidateHash,
      idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `${draft!.id}-${Date.now()}`,
    }),
    onSuccess: async () => {
      setDraft(null); setReview(null);
      await client.invalidateQueries({ queryKey: ["skills"] });
      if (project) await client.invalidateQueries({ queryKey: ["workspace-skills", project.id] });
    },
    onError: (cause) => setError(localizeApiError(cause, "skills.errors.install")),
  });
  const toggleSkill = useMutation({
    mutationFn: ({ slug, enabled }: { slug: string; enabled: boolean }) => api.toggleWorkspaceSkill(project!.id, slug, enabled),
    onSuccess: () => project ? client.invalidateQueries({ queryKey: ["workspace-skills", project.id] }) : undefined,
    onError: (cause) => setError(localizeApiError(cause, "skills.errors.toggle")),
  });
  // Skill version history / rollback state.
  const [versionSlug, setVersionSlug] = useState<string | null>(null);
  const versions = useQuery({
    enabled: Boolean(versionSlug),
    queryKey: ["skill-versions", versionSlug],
    queryFn: () => api.listSkillVersions(versionSlug!),
  });
  const revertSkill = useMutation({
    mutationFn: ({ slug, versionNumber }: { slug: string; versionNumber: number }) => api.revertSkill(slug, versionNumber),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["skills"] });
      if (versionSlug) await client.invalidateQueries({ queryKey: ["skill-versions", versionSlug] });
    },
    onError: (cause) => setError(localizeApiError(cause, "skills.errors.revert")),
  });

  function versionReasonLabel(reason: SkillVersionSummary["snapshotReason"]): string {
    return t(`skills.reason.${reason === "evolution" ? "evolution" : reason === "revert" ? "revert" : "install"}`);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selected = roles.filter((role) => data.getAll("roles").includes(role));
    if (selected.length === 0) { setError(t("skills.errors.roleRequired")); return; }
    createAndReview.mutate({
      source: "paste",
      slug: String(data.get("slug") ?? "").trim(),
      content: String(data.get("content") ?? ""),
      roles: selected,
    });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    if (file.name !== "SKILL.md" || file.size > 64 * 1024) { setError(t("skills.errors.invalidFile")); return; }
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
    if (textarea) textarea.value = await file.text();
  }

  return <main className="skills-page">
    <header className="skills-topbar">
      <Link to={project ? `/projects/${project.id}/overview` : "/projects"}><ArrowLeft size={15} />{t(project ? "skills.backProject" : "skills.backProjects")}</Link>
    </header>
    <div className="skills-content">
      <div className="skills-title">
        <div><h1>{t("skills.title")}</h1><p>{t(project ? "skills.projectIntro" : "skills.intro", { title: project?.title })}</p></div>
      </div>

      {project ? <section aria-label={t("skills.projectRegion")} className="skills-panel skills-project-panel">
        <div className="skills-panel-heading"><div><h2>{t("skills.projectEnabled")}</h2><p>{t("skills.projectHelp", { title: project.title })}</p></div><Puzzle size={20} strokeWidth={1.5} /></div>
        {workspaceSkills.isLoading ? <p className="skill-list-state">{t("skills.projectLoading")}</p> : null}
        {workspaceSkills.isError ? <p className="skill-error" role="alert">{t("skills.projectLoadFailed")}</p> : null}
        {!workspaceSkills.isLoading && !workspaceSkills.isError && !workspaceSkills.data?.length ? <p className="skill-list-state">{t("skills.projectEmpty")}</p> : null}
        <div className="workspace-skill-list">
          {workspaceSkills.data?.map((skill) => (
            <label key={skill.slug}>
              <span><strong>{skill.name}</strong><small>{skill.description || skill.slug}</small>{skill.reviewStatus === "quarantined" ? <em>{t("skills.quarantined")}</em> : null}</span>
              <input
                aria-label={t("skills.enabledAria", { name: skill.name })}
                checked={skill.enabled}
                disabled={accessMode !== "writable" || toggleSkill.isPending || skill.reviewStatus === "quarantined"}
                onChange={(event) => toggleSkill.mutate({ slug: skill.slug, enabled: event.target.checked })}
                type="checkbox"
              />
            </label>
          ))}
        </div>
      </section> : null}

      <div className="skills-workspace">
        <section aria-label={t("skills.editorRegion")} className="skills-panel skills-editorial-sheet">
          <div className="skills-panel-heading"><div><h2>{t("skills.editorTitle")}</h2><p>{t("skills.editorHelp")}</p></div><Feather size={20} strokeWidth={1.5} /></div>
          <aside aria-label={t("skills.safetyRegion")} className="skill-safety-note">
            <ShieldCheck size={18} strokeWidth={1.5} />
            <div><strong>{t("skills.safetyTitle")}</strong><p><span>{t("skills.singleDocument")}</span><span>{t("skills.noScripts")}</span><span>{t("skills.reviewedBeforeUse")}</span></p></div>
          </aside>
          <form className="skill-form" onSubmit={submit}>
            <label><span className="skill-field-number">01</span>{t("skills.slug")}<input aria-label={t("skills.slug")} name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="xianxia-worldbuilding" required /></label>
            <label className="skill-file"><FileUp size={18} strokeWidth={1.5} /><span><strong>{t("skills.chooseFile")}</strong><small>{t("skills.fileLimit")}</small></span><input accept=".md,text/markdown" aria-label={t("skills.uploadAria")} onChange={(event) => void loadFile(event.target.files?.[0])} type="file" /></label>
            <label><span className="skill-field-number">02</span>{t("skills.content")}<textarea aria-label={t("skills.content")} name="content" placeholder={t("skills.contentPlaceholder")} required rows={15} /></label>
            <fieldset><legend>{t("skills.rolesLegend")}</legend><div className="skill-role-grid">{roles.map((role) => <label key={role}><input name="roles" type="checkbox" value={role} /><span>{t(`skills.roles.${role}`)}</span></label>)}</div></fieldset>
            {error ? <p className="skill-error" role="alert">{error}</p> : null}
            <div className="skill-form-footer"><p><LockKeyhole size={14} />{t("skills.preReviewNote")}</p><button className="primary-button" disabled={createAndReview.isPending} type="submit">{t(createAndReview.isPending ? "skills.reviewing" : "skills.submit")}</button></div>
          </form>
        </section>

        <section aria-label={t("skills.catalogueRegion")} className="skills-panel skills-catalogue">
          <div className="skills-panel-heading"><div><h2>{t("skills.catalogueTitle")}</h2><p>{t("skills.catalogueHelp")}</p></div><BookOpenText size={20} strokeWidth={1.5} /></div>
          <div className="skills-catalogue-count"><strong>{installed.data?.length ?? 0}</strong><span>{t("skills.catalogueCount").split("\n").map((line, index) => <span key={line}>{index > 0 ? <br /> : null}{line}</span>)}</span></div>
          {installed.isLoading ? <p className="skill-list-state">{t("skills.catalogueLoading")}</p> : null}
          {installed.isError ? <p className="skill-list-state" role="alert">{t("skills.catalogueFailed")}</p> : null}
          {!installed.isLoading && !installed.isError && !installed.data?.length ? <p className="skill-list-state">{t("skills.catalogueEmpty")}</p> : null}
          <div className="skill-list">{installed.data?.map((skill) => {
            const isUser = skill.source !== "built-in";
            const expanded = versionSlug === skill.slug;
            return <article key={`${skill.source}-${skill.slug}`}>
              <div>
                <h3>{skill.metadata.name}</h3>
                <p>{skill.metadata.description}</p>
                {skill.slug !== skill.metadata.name ? <small>{skill.slug}</small> : null}
                {isUser ? <button
                  className="skill-history-toggle"
                  onClick={() => setVersionSlug(expanded ? null : skill.slug)}
                  type="button"
                  aria-expanded={expanded}
                ><History size={14} strokeWidth={1.6} />{t(expanded ? "skills.collapseHistory" : "skills.versionHistory")}</button> : null}
              </div>
              <span className="skill-list-status">{skill.source === "built-in" ? t("skills.builtInReadonly") : skill.reviewStatus ? t(`skills.status.${skill.reviewStatus}`) : t("skills.reviewed")}</span>
              {isUser && expanded ? <div className="skill-versions">
                {versions.isLoading ? <p className="skill-list-state">{t("skills.versionsLoading")}</p> : null}
                {versions.isError ? <p className="skill-error" role="alert">{t("skills.versionsFailed")}</p> : null}
                {!versions.isLoading && !versions.isError && !versions.data?.length ? <p className="skill-list-state">{t("skills.versionsEmpty")}</p> : null}
                <ul>{versions.data?.map((version) => (
                  <li key={version.versionNumber}>
                    <span className="skill-version-number">v{version.versionNumber}</span>
                    <span className="skill-version-reason">{versionReasonLabel(version.snapshotReason)}</span>
                    <time>{formatDate(version.createdAt, locale, { dateStyle: "medium", timeStyle: "short" })}</time>
                    <button
                      className="skill-revert-button"
                      disabled={revertSkill.isPending || accessMode !== "writable"}
                      onClick={() => revertSkill.mutate({ slug: skill.slug, versionNumber: version.versionNumber })}
                      type="button"
                    ><RotateCcw size={13} strokeWidth={1.6} />{t("skills.revertVersion")}</button>
                  </li>
                ))}</ul>
              </div> : null}
            </article>;
          })}</div>
        </section>
      </div>

      {draft && review ? <section aria-label={t("skills.reviewRegion")} className="skills-panel skill-review">
        <div className="skills-panel-heading"><div><h2>{t("skills.reviewTitle")}</h2><p>{t(review.verdict === "revision_required" ? "skills.revisionHelp" : "skills.approvedHelp")}</p></div><span className="skill-review-seal">{t(review.verdict === "revision_required" ? "skills.revisionRequired" : "skills.ready")}</span></div>
        {review.findings.length ? <ul className="skill-findings">{review.findings.map((finding) => <li key={`${finding.code}-${finding.line ?? 0}`}><strong>{finding.code}</strong>{finding.message}</li>)}</ul> : null}
        <div className="skill-diff"><div><h3>{t("skills.original")}</h3><pre>{draft.originalContent}</pre></div><div><h3>{t("skills.candidate")}</h3><pre>{draft.candidateContent}</pre></div></div>
        <p className="skill-capabilities">{t("skills.capabilities", { value: review.requiredCapabilities.join(", ") || t("skills.noCapabilities") })}</p>
        <div className="skill-review-footer"><p>{t("skills.confirmNote")}</p><button className="primary-button" disabled={confirm.isPending} onClick={() => confirm.mutate()} type="button">{t("skills.confirm")}</button></div>
      </section> : null}
    </div>
  </main>;
}
