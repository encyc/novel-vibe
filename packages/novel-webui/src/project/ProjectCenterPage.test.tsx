import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../app/AppProviders";
import { api } from "../api/client";
import { i18n } from "../i18n/config";
import { LocalModeProvider } from "../local-mode";
import { ProjectCenterPage } from "./ProjectCenterPage";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  window.localStorage.setItem("novel-vibe:interface-locale", "zh-CN");
});

function renderPage(localMode = false) {
  window.history.replaceState({}, "", "/projects");
  return render(
    <AppProviders>
      <LocalModeProvider value={localMode}>
        <ProjectCenterPage onSignedOut={vi.fn()} user={{ id: "user-1", email: "writer@example.com" }} />
      </LocalModeProvider>
    </AppProviders>,
  );
}

describe("ProjectCenterPage", () => {
  it("does not expose Skill management in the home header", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "项目中心" });
    expect(screen.queryByRole("link", { name: "Skill 管理" })).not.toBeInTheDocument();
  });

  it("links to the community from the project center header", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "项目中心" });
    expect(screen.getByRole("link", { name: "社区" }))
      .toHaveAttribute("href", `${window.location.origin}/community`);
  });

  it("hides hosted-only header entries in local-first mode", async () => {
    renderPage(true);
    await screen.findByRole("heading", { name: "项目中心" });

    expect(screen.queryByRole("link", { name: "社区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "会员权益" })).not.toBeInTheDocument();
    // The account and sign-out controls stay: they are not hosted-only.
    expect(screen.getByRole("link", { name: "writer@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  });

  it("shows lifecycle counts, sorts active Projects, and makes each card the project link", async () => {
    vi.spyOn(api, "listProjects").mockImplementation(async (status = "active") => {
      if (status === "archived") return [{ id: "archived", title: "封存之书", lifecycle_status: "archived", creative_language: "zh-CN" }];
      if (status === "trash") return [];
      return [
        { id: "older", title: "旧城", lifecycle_status: "active", last_activity_at: "2026-06-01T00:00:00Z", creative_language: "zh-CN" },
        { id: "newer", title: "长夜临渊", genre: "玄幻", lifecycle_status: "active", last_activity_at: "2026-06-30T00:00:00Z", creative_language: "zh-CN" },
      ];
    });
    const user = userEvent.setup();
    renderPage();

    const cards = await screen.findAllByRole("article");
    expect(screen.getByRole("region", { name: "项目馆藏" })).toBeInTheDocument();
    expect(screen.getByText("YOUR MANUSCRIPTS · 02")).toBeInTheDocument();
    const catalogue = screen.getByRole("list", { name: "项目目录" });
    expect(within(catalogue).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "进行中 2" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "已归档 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "回收站 0" })).toBeInTheDocument();
    expect(within(cards[0]).getByText("长夜临渊")).toBeInTheDocument();
    await user.click(within(cards[0]).getByRole("link", { name: "打开项目：长夜临渊" }));
    expect(window.location.pathname).toBe("/projects/newer/overview");
  });

  it("uses separate lifecycle tabs and filters the current list", async () => {
    vi.spyOn(api, "listProjects").mockImplementation(async (status = "active") => status === "archived"
      ? [{ id: "archived", title: "封存之书", lifecycle_status: "archived", creative_language: "zh-CN" }]
      : [{ id: "active", title: "星海纪事", lifecycle_status: "active", creative_language: "zh-CN" }]);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("星海纪事")).toBeInTheDocument();
    await user.click(await screen.findByRole("tab", { name: "已归档 1" }));
    expect(await screen.findByText("封存之书")).toBeInTheDocument();
    expect(api.listProjects).toHaveBeenCalledWith("archived");

    await user.type(screen.getByRole("searchbox", { name: "搜索项目" }), "不存在");
    expect(screen.getByText("没有匹配的项目")).toBeInTheDocument();
  });

  it("creates a Project through two steps and can open it ready for Chief Editor discussion", async () => {
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "createProject").mockResolvedValue({ id: "new-project", title: "新书", lifecycle_status: "active", creative_language: "zh-CN" });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("还没有进行中的项目")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "新建项目" }));
    await user.type(screen.getByLabelText("项目标题"), "新书");
    await user.type(screen.getByLabelText("作品类型"), "东方奇幻");
    await user.click(screen.getByRole("button", { name: "下一步" }));

    expect(api.createProject).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "选择创作起点" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "与总编讨论" }));
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() => expect(window.location.pathname).toBe("/projects/new-project/overview"));
    expect(window.localStorage.getItem("novel-vibe:assistant-collapsed")).toBe("false");
    expect(api.createProject).toHaveBeenCalledWith({ title: "新书", genre: "东方奇幻", synopsis: undefined, creative_language: "zh-CN" });
  });

  it("creates a project with an independently selected creative language", async () => {
    localStorage.setItem("novel-vibe:interface-locale", "en");
    vi.spyOn(api, "listProjects").mockResolvedValue([]);
    vi.spyOn(api, "createProject").mockResolvedValue({
      id: "new-project", title: "中文小说", lifecycle_status: "active", creative_language: "zh-CN",
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "New project" }));
    await user.type(screen.getByLabelText("Project title"), "中文小说");
    await user.selectOptions(screen.getByLabelText("Creative language"), "zh-CN");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({
      title: "中文小说",
      creative_language: "zh-CN",
    }));
  });
});
