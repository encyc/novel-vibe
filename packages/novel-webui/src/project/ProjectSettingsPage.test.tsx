import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import type { Project } from "../types";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("zh-CN");
});

const activeProject: Project = {
  id: "project-1",
  title: "长夜临渊",
  genre: "玄幻",
  synopsis: "北境孤城",
  lifecycle_status: "active",
  writing_stage: "planning",
  creative_language: "zh-CN",
};

function renderPage(project = activeProject) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectSettingsPage onProjectChanged={vi.fn()} project={project} />
    </QueryClientProvider>,
  );
}

describe("ProjectSettingsPage", () => {
  it("renders project settings without project Skill controls", async () => {
    renderPage();
    expect(screen.getByRole("banner", { name: "项目设置工作区" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "项目档案" })).toBeInTheDocument();
    expect(screen.getByText("PROJECT ARCHIVE · 05")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "项目技能" })).not.toBeInTheDocument();
  });

  it("updates metadata and writing stage", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "updateProject").mockResolvedValue({ ...activeProject, title: "长夜新章", writing_stage: "drafting" });
    renderPage();

    const title = screen.getByLabelText("项目标题");
    await user.clear(title);
    await user.type(title, "长夜新章");
    await user.selectOptions(screen.getByLabelText("创作阶段"), "drafting");
    await user.click(screen.getByRole("button", { name: "保存基本信息" }));

    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
      title: "长夜新章",
      writing_stage: "drafting",
    }));
    expect(screen.getByRole("heading", { name: "生命周期" })).toBeInTheDocument();
  });

  it("updates creative language without changing interface locale", async () => {
    await i18n.changeLanguage("en");
    const user = userEvent.setup();
    vi.spyOn(api, "updateProject").mockResolvedValue({
      ...activeProject,
      creative_language: "en",
    });
    renderPage();

    await user.selectOptions(screen.getByLabelText("Creative language"), "en");
    await user.click(screen.getByRole("button", { name: "Save project details" }));

    expect(api.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
      creative_language: "en",
    }));
    expect(i18n.language).toBe("en");
  });

  it("archives, trashes and restores through explicit actions", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "archiveProject").mockResolvedValue({ ...activeProject, lifecycle_status: "archived" });
    vi.spyOn(api, "trashProject").mockResolvedValue({ ...activeProject, lifecycle_status: "trash" });
    vi.spyOn(api, "restoreProject").mockResolvedValue(activeProject);
    const { rerender } = renderPage();

    await user.click(screen.getByRole("button", { name: "归档项目" }));
    expect(api.archiveProject).toHaveBeenCalledWith("project-1");
    await user.click(screen.getByRole("button", { name: "移入回收站" }));
    expect(api.trashProject).toHaveBeenCalledWith("project-1");

    rerender(<QueryClientProvider client={new QueryClient()}><ProjectSettingsPage onProjectChanged={vi.fn()} project={{ ...activeProject, lifecycle_status: "archived" }} /></QueryClientProvider>);
    await user.click(screen.getByRole("button", { name: "恢复项目" }));
    expect(api.restoreProject).toHaveBeenCalledWith("project-1");
  });

  it("requires the exact Project title before permanent deletion", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "permanentlyDeleteProject").mockResolvedValue({ jobId: "job-1", status: "pending" });
    renderPage({ ...activeProject, lifecycle_status: "trash" });

    await user.click(screen.getByRole("button", { name: "永久删除" }));
    const confirm = screen.getByLabelText("输入项目标题以确认");
    expect(screen.getByRole("button", { name: "确认永久删除" })).toBeDisabled();
    await user.type(confirm, "长夜临渊");
    await user.click(screen.getByRole("button", { name: "确认永久删除" }));

    await waitFor(() => expect(api.permanentlyDeleteProject).toHaveBeenCalledWith("project-1"));
  });
});
