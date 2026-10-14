import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api/client";
import type { User } from "../types";
import { Spinner } from "../ui/Spinner";
import { WorkspaceRouter } from "../workbench/WorkspaceRouter";

interface AuthenticatedAppProps {
  user: User;
  onSignedOut: () => void;
}

export function AuthenticatedApp({ onSignedOut, user }: AuthenticatedAppProps) {
  const { t } = useTranslation();
  const projects = useQuery({
    queryFn: () => api.listProjects("active"),
    queryKey: ["projects", { status: "active" }],
  });

  useEffect(() => {
    if (
      projects.error instanceof ApiError &&
      projects.error.status === 401
    ) {
      onSignedOut();
    }
  }, [projects.error, onSignedOut]);

  if (projects.isLoading) {
    return <main className="loading-screen"><Spinner label={t("projects.loading")} /></main>;
  }

  if (projects.isError) {
    // Session expired — redirecting to login (triggered by the effect above).
    if (projects.error instanceof ApiError && projects.error.status === 401) {
      return null;
    }
    return (
      <main className="loading-screen">
        <section className="load-error" role="alert">
          <h1>{t("projects.loadFailed")}</h1>
          <button className="primary-button" onClick={() => projects.refetch()} type="button">{t("common.retry")}</button>
        </section>
      </main>
    );
  }

  return <WorkspaceRouter onSignedOut={onSignedOut} projects={projects.data ?? []} user={user} />;
}
