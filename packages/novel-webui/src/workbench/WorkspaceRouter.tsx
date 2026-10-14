import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { Project, User } from "../types";
import { DocumentWorkspacePage } from "../pages/DocumentWorkspacePage";
import { ProjectOverviewPage } from "../pages/ProjectOverviewPage";
import { WorkbenchShell, useWorkbench } from "./WorkbenchShell";
import { ProjectCenterPage } from "../project/ProjectCenterPage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Spinner } from "../ui/Spinner";
import { ProjectSettingsPage } from "../project/ProjectSettingsPage";
import { ProfilePage } from "../profile/ProfilePage";
import { SkillManagementPage } from "../skills/SkillManagementPage";
import { CommunityPage } from "../community/CommunityPage";
import { ArticleDetailPage } from "../community/ArticleDetailPage";
import { ArticleEditorPage } from "../community/ArticleEditorPage";
import { AuthorProfilePage } from "../community/AuthorProfilePage";
import { MyFeedbackPage } from "../community/MyFeedbackPage";
import { useLocalMode } from "../local-mode";
import { ReferralAdminPage } from "../referral/ReferralAdminPage";

interface WorkspaceRouterProps {
  projects: Project[];
  user: User;
  onSignedOut: () => void;
}

export function WorkspaceRouter({ onSignedOut, projects, user }: WorkspaceRouterProps) {
  const localMode = useLocalMode();

  return (
    <Routes>
      <Route path="/" element={<ProjectCenterPage onSignedOut={onSignedOut} user={user} />} />
      <Route path="/projects" element={<ProjectCenterPage onSignedOut={onSignedOut} user={user} />} />
      <Route path="/profile" element={<ProfilePage onSignedOut={onSignedOut} user={user} />} />
      <Route path="/profile/:sectionId" element={<ProfilePage onSignedOut={onSignedOut} user={user} />} />
      {/* Legacy standalone URLs — membership and BYOK settings now live under the profile shell. */}
      <Route path="/membership" element={<Navigate replace to={localMode ? "/profile" : "/profile/membership"} />} />
      <Route path="/settings" element={<Navigate replace to="/profile/settings" />} />
      {localMode ? null : <Route path="/admin/referrals" element={user.isCommunityAdmin ? <ReferralAdminPage /> : <Navigate replace to="/projects" />} />}
      <Route path="/skills" element={<SkillManagementPage />} />
      {/* Community is a hosted-service surface: local mode redirects its URLs to the project centre rather than offering dead entries. */}
      {localMode ? (
        <Route path="/community/*" element={<Navigate replace to="/projects" />} />
      ) : (
        <>
          <Route path="/community" element={<CommunityPage onSignedOut={onSignedOut} user={user} />} />
          <Route path="/community/my-feedback" element={<MyFeedbackPage onSignedOut={onSignedOut} user={user} />} />
          <Route path="/community/write" element={<ArticleEditorPage onSignedOut={onSignedOut} user={user} />} />
          <Route path="/community/edit/:articleId" element={<ArticleEditorPage onSignedOut={onSignedOut} user={user} />} />
          <Route path="/community/author/:userId" element={<AuthorProfilePage onSignedOut={onSignedOut} user={user} />} />
          <Route path="/community/:articleId" element={<ArticleDetailPage onSignedOut={onSignedOut} user={user} />} />
        </>
      )}
      <Route
        path="/projects/:projectId"
        element={<ProjectRoute onSignedOut={onSignedOut} projects={projects} user={user} />}
      >
        <Route index element={<Navigate replace to="overview" />} />
        <Route path="overview" element={<ProjectOverviewPage />} />
        <Route path="settings" element={<ProjectSettingsRoute />} />
        <Route path="skills" element={<ProjectSkillRoute />} />
        <Route path=":moduleId" element={<DocumentWorkspacePage />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/projects" />} />
    </Routes>
  );
}

function ProjectSkillRoute() {
  const { accessMode, project } = useWorkbench();
  return <SkillManagementPage accessMode={accessMode} project={project} />;
}

function ProjectSettingsRoute() {
  const { project } = useWorkbench();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return <ProjectSettingsPage project={project} onProjectChanged={(next) => {
    if (!next) {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
      return;
    }
    queryClient.setQueryData(["project", project.id], next);
    queryClient.invalidateQueries({ queryKey: ["projects"] });
    if (next.lifecycle_status === "trash") navigate("/projects");
  }} />;
}

function ProjectRoute({ onSignedOut, projects, user }: WorkspaceRouterProps) {
  const { t } = useTranslation();
  const { projectId } = useParams();
  const queryClient = useQueryClient();
  const cachedProjects = queryClient.getQueryData<Project[]>(["projects", { status: "active" }]) ?? [];
  const availableProjects = [...projects, ...cachedProjects.filter((cached) => !projects.some((project) => project.id === cached.id))];
  const knownProject = availableProjects.find((project) => project.id === projectId);
  const projectDetail = useQuery({
    enabled: Boolean(projectId && !knownProject),
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId!),
    retry: false,
  });
  if (!projectId) {
    return <Navigate replace to="/projects" />;
  }
  if (!knownProject && projectDetail.isLoading) {
    return <main className="loading-screen"><Spinner label={t("projects.loading")} /></main>;
  }
  const project = knownProject ?? projectDetail.data;
  if (!project) {
    return <Navigate replace to="/projects" />;
  }
  const routedProjects = availableProjects.some((item) => item.id === project.id)
    ? availableProjects
    : [project, ...availableProjects];
  return <WorkbenchShell onSignedOut={onSignedOut} projects={routedProjects} user={user} />;
}
