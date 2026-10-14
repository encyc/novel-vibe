import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import type { Project } from "../types";
import { SkillManagementPage } from "./SkillManagementPage";

const project: Project = {
  id: "project-1",
  title: "长夜临渊",
  lifecycle_status: "active",
  creative_language: "zh-CN",
};

function renderPage(element = <SkillManagementPage />) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{element}</MemoryRouter>
  </QueryClientProvider>);
}

describe("SkillManagementPage", () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await i18n.changeLanguage("zh-CN");
  });

  it("creates, reviews, displays changes, and confirms a pasted Skill", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([]);
    vi.spyOn(api, "createSkillDraft").mockResolvedValue({
      id: "d1", slug: "style", source: "paste", originalContent: "original", candidateContent: "original",
      roles: ["writer"], status: "draft", version: 1,
    });
    vi.spyOn(api, "reviewSkillDraft").mockResolvedValue({
      draft: {
        id: "d1", slug: "style", source: "paste", originalContent: "original", candidateContent: "revised",
        roles: ["writer"], status: "awaiting_confirmation", version: 1,
      },
      review: {
        id: "r1", draftId: "d1", draftVersion: 1, verdict: "revision_required",
        findings: [{ code: "TOOL_ADAPTATION", severity: "warning", message: "使用平台工具" }],
        requiredCapabilities: ["documents.read"], recommendedRoles: ["writer"], candidateHash: "hash",
      },
    });
    vi.spyOn(api, "confirmSkillDraft").mockResolvedValue({
      slug: "style", source: "user", metadata: { name: "Style", description: "Style" }, content: "revised", path: "skills/style",
    });
    renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Skill 标识"), "style");
    await user.type(screen.getByLabelText("SKILL.md 内容"), "---\nname: Style\ndescription: Style\n---\nbody");
    await user.click(screen.getByLabelText("章节作家"));
    await user.click(screen.getByRole("button", { name: "提交审核" }));

    expect(await screen.findByText("使用平台工具")).toBeInTheDocument();
    expect(screen.getByText("original")).toBeInTheDocument();
    expect(screen.getByText("revised")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认安装修订稿" }));
    await waitFor(() => expect(api.confirmSkillDraft).toHaveBeenCalled());
  });

  it("shows installed Skills and keeps built-ins read-only", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([{
      slug: "skill-creator", source: "built-in", metadata: { name: "skill-creator", description: "Create skills" },
      content: "body", path: "builtin/skill-creator",
    }]);
    renderPage();
    expect(await screen.findByText("skill-creator")).toBeInTheDocument();
    expect(screen.getByText("内置 · 只读")).toBeInTheDocument();
  });

  it("presents creation, safety guidance, and the installed collection as distinct editorial regions", async () => {
    vi.spyOn(api, "listSkills").mockResolvedValue([]);
    renderPage();

    expect(await screen.findByRole("region", { name: "编写与送审" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Skill 安全边界" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "已安装 Skill" })).toBeInTheDocument();
  });

  it("shows project Skill toggles when opened from a project workspace", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listSkills").mockResolvedValue([]);
    vi.spyOn(api, "listWorkspaceSkills").mockResolvedValue([{ slug: "style", name: "Style", description: "Voice", enabled: false }]);
    vi.spyOn(api, "toggleWorkspaceSkill").mockResolvedValue(undefined);

    renderPage(<SkillManagementPage accessMode="writable" project={project} />);

    expect(await screen.findByRole("region", { name: "当前项目 Skill" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回项目工作台" })).toHaveAttribute("href", "/projects/project-1/overview");
    await user.click(await screen.findByRole("checkbox", { name: "Style 启用状态" }));
    expect(api.toggleWorkspaceSkill).toHaveBeenCalledWith("project-1", "style", true);
  });

  it("localizes English chrome without translating Skill metadata or the project title", async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(api, "listSkills").mockResolvedValue([{
      slug: "voice", source: "user", metadata: { name: "古风语感", description: "保持原文描述" },
      content: "原始 Skill 正文", path: "skills/voice", reviewStatus: "approved",
    }]);
    vi.spyOn(api, "listWorkspaceSkills").mockResolvedValue([]);
    renderPage(<SkillManagementPage project={project} />);
    expect(await screen.findByRole("heading", { name: "Skill management" })).toBeInTheDocument();
    expect(screen.getAllByText(/长夜临渊/)).toHaveLength(2);
    expect(await screen.findByText("古风语感")).toBeInTheDocument();
    expect(screen.getByText("保持原文描述")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByText("approved")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to project workspace" })).toHaveAttribute("href", "/projects/project-1/overview");
  });
});
