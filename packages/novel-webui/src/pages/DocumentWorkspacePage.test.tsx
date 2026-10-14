import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";
import { AuthenticatedApp } from "../app/AuthenticatedApp";
import type { DocumentConflict, DocumentDiffPage, DocumentIndex, DocumentVersionSummary } from "../types";

vi.mock("../editor/MarkdownEditor", () => ({
  MarkdownEditor: ({ onChange, value }: { onChange(value: string): void; value: string }) => (
    <textarea aria-label="文档源码" onChange={(event) => onChange(event.target.value)} value={value} />
  ),
}));

const chapterText: DocumentIndex = {
  project_id: "project-1",
  doc_path: "chapters/001.md",
  doc_type: "chapter-text",
  name: "第一章",
  status: "draft",
};

const chapterTwo: DocumentIndex = {
  ...chapterText,
  doc_path: "chapters/002.md",
  name: "第二章",
};

const directorScript: DocumentIndex = {
  project_id: "project-1",
  doc_path: "scripts/ch-001.md",
  doc_type: "director-script",
  name: "第一章导演剧本",
  status: "draft",
};

const worldview: DocumentIndex = {
  project_id: "project-1",
  doc_path: "world/worldview.md",
  doc_type: "worldview",
  name: "世界观",
  status: "confirmed",
};

const storySummary: DocumentIndex = {
  project_id: "project-1",
  doc_path: "summary/story-so-far.md",
  doc_type: "story-summary",
  name: "故事至今",
  status: "draft",
};

const versionFixture = {
  summary: {
    id: "v1", projectId: "project-1", path: chapterText.doc_path, versionNo: 1, sourceType: "agent" as const, agentId: "writer",
    beforeHash: "old", afterHash: "hash-1", state: "complete" as const, diffStatus: "ready" as const,
    addedLines: 1, deletedLines: 0, changedSections: ["第一章"], createdAt: "2026-08-14T10:00:00.000Z", completedAt: "2026-08-14T10:00:01.000Z",
  },
  diff: {
    algorithmVersion: "jsdiff-v1" as const, status: "ready" as const, addedLines: 1, deletedLines: 0,
    changedSections: ["第一章"], frontmatterChanges: [], truncated: false, nextCursor: null,
    items: [{ index: 0, section: "第一章", oldStart: 1, newStart: 1, lines: [{ kind: "insert" as const, oldLine: null, newLine: 1, text: "第一章" }] }],
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDocumentPage(
  documents: DocumentIndex[] = [chapterText, worldview],
  route = "/projects/project-1/chapters",
  versionFixture?: { summary: DocumentVersionSummary; diff: DocumentDiffPage },
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "listProjects").mockResolvedValue([
    { id: "project-1", title: "长夜临渊", genre: "玄幻", creative_language: "zh-CN" },
  ]);
  vi.spyOn(api, "listDocuments").mockResolvedValue(documents);
  vi.spyOn(api, "listDocumentVersions").mockResolvedValue({ items: versionFixture ? [versionFixture.summary] : [], nextCursor: null });
  if (versionFixture) {
    vi.spyOn(api, "getDocumentVersion").mockResolvedValue(versionFixture.summary);
    vi.spyOn(api, "getDocumentVersionDiff").mockResolvedValue(versionFixture.diff);
  }
  vi.spyOn(api, "readDocument").mockImplementation(async (_projectId, path) => {
    if (path === chapterTwo.doc_path) return { content: "# 第二章", hash: "hash-2", path };
    if (path === directorScript.doc_path) return { content: "# 第一章导演剧本", hash: "hash-ds", path };
    if (path === storySummary.doc_path) return { content: "# 故事至今\n\n陆尘在废墟中醒来。", hash: "hash-summary", path };
    return { content: "# 第一章", hash: "hash-1", path };
  });
  vi.spyOn(api, "getMembershipStatus").mockResolvedValue({ active: true, features: ["export"], planName: "月卡会员", expiresAt: null });

  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <MemoryRouter initialEntries={[route]}>
          <AuthenticatedApp
            user={{ id: "user-1", email: "u@example.com" }}
            onSignedOut={vi.fn()}
          />
        </MemoryRouter>
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

describe("DocumentWorkspacePage", () => {
  it("filters chapter documents and opens the selected source in preview mode", async () => {
    renderDocumentPage();

    // Content is rendered as markdown — "# 第一章" becomes an <h1>
    expect(await screen.findByRole("heading", { name: "第一章" })).toBeInTheDocument();
    expect(screen.getByRole("banner", { name: "章节正文工作区" })).toBeInTheDocument();
    // Single-document modules render no document switcher strip.
    expect(screen.queryByRole("navigation", { name: "章节正文文稿目录" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "当前文稿" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "当前文稿" })).toHaveAttribute("data-motion", "paper-settle");
    expect(screen.getByText("CHAPTER MANUSCRIPTS · 05")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /世界观/ })).not.toBeInTheDocument();
    // Defaults to preview mode
    expect(screen.getByRole("button", { name: "编辑" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "预览" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "文档视图" })).toHaveAttribute("data-motion", "view-crossfade");
  });

  it("expands the slide-out document list from the module icon and changes documents in place", async () => {
    const user = userEvent.setup();
    renderDocumentPage([chapterText, chapterTwo]);

    await screen.findByRole("heading", { name: "第一章" });

    // better-sidebar: the list starts collapsed; the active module icon on the
    // activity rail expands it, and picking a document collapses it again.
    await user.click(screen.getByRole("button", { name: "章节正文" }));
    const rail = await screen.findByRole("navigation", { name: "章节正文文稿目录" });
    expect(within(rail).getByRole("button", { name: /第二章/ })).toBeInTheDocument();
    // The grid reserves the rail column only while the rail is visible.
    expect(document.querySelector(".document-workspace-body")).toHaveClass("has-document-rail");

    await user.click(within(rail).getByRole("button", { name: /第二章/ }));
    expect(await screen.findByRole("heading", { name: "第二章" })).toBeInTheDocument();
    // Selecting a document hands the width back to the manuscript.
    expect(screen.queryByRole("navigation", { name: "章节正文文稿目录" })).not.toBeInTheDocument();
    expect(document.querySelector(".document-workspace-body")).not.toHaveClass("has-document-rail");
  });

  it("releases the reserved rail column when the rail is dismissed", async () => {
    const user = userEvent.setup();
    renderDocumentPage([chapterText, chapterTwo]);

    await screen.findByRole("heading", { name: "第一章" });
    await user.click(screen.getByRole("button", { name: "章节正文" }));
    const rail = await screen.findByRole("navigation", { name: "章节正文文稿目录" });

    await user.click(within(rail).getByRole("button", { name: "收起文稿列表" }));
    expect(screen.queryByRole("navigation", { name: "章节正文文稿目录" })).not.toBeInTheDocument();
    // Without this the editor falls into the fixed rail track and the text
    // stays squeezed beside an empty reserved column.
    expect(document.querySelector(".document-workspace-body")).not.toHaveClass("has-document-rail");
  });

  it("never saves while typing, blurring, previewing, or waiting", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, "saveDocument").mockResolvedValue({
      ok: true, changed: true, hash: "hash-new", path: chapterText.doc_path, indexed: true,
      versionId: "version-1", versionNo: 2,
    });
    renderDocumentPage();

    // Switch to edit mode first (default is preview)
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.clear(editor);
    await user.type(editor, "# 本地草稿");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "预览" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("未保存")).toBeInTheDocument();
  });

  it("saves explicitly with the current base hash and adopts the returned hash", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, "saveDocument").mockResolvedValue({
      ok: true, changed: true, hash: "hash-new", path: chapterText.doc_path, indexed: true,
      versionId: "version-1", versionNo: 2,
    });
    renderDocumentPage();

    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.clear(editor);
    await user.type(editor, "# 第一章\n新增内容");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(save).toHaveBeenCalledWith(
      "project-1",
      chapterText.doc_path,
      "# 第一章\n新增内容",
      "hash-1",
    );
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("uses Cmd/Ctrl+S as the same explicit save action", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, "saveDocument").mockResolvedValue({
      ok: true, changed: true, hash: "hash-new", path: chapterText.doc_path, indexed: true,
      versionId: "version-1", versionNo: 2,
    });
    renderDocumentPage();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.type(editor, "\n修改");

    await user.keyboard("{Control>}s{/Control}");

    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the local draft and shows both versions on a conflict", async () => {
    const user = userEvent.setup();
    const conflict: DocumentConflict = {
      error: "Document conflict",
      code: "DOCUMENT_CONFLICT",
      content: "# 远端版本",
      hash: "hash-remote",
      path: chapterText.doc_path,
    };
    const save = vi.spyOn(api, "saveDocument").mockRejectedValue(new ApiError(409, {
      error: {
        code: "DOCUMENT_CONFLICT",
        message: "Document changed on the server",
        details: {
          content: conflict.content,
          hash: conflict.hash,
          path: conflict.path,
        },
      },
    }));
    renderDocumentPage();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.clear(editor);
    await user.type(editor, "# 本地版本");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const conflictHeading = await screen.findByRole("heading", { name: "文档已在其他位置更新" });
    expect(conflictHeading.closest('[role="dialog"]')).toHaveAttribute("data-motion", "dialog-settle");
    expect(screen.getByRole("textbox", { name: "本地草稿" })).toHaveValue("# 本地版本");
    expect(screen.getByRole("textbox", { name: "远端版本" })).toHaveValue("# 远端版本");
    await user.click(screen.getByRole("button", { name: "保留本地草稿" }));
    expect(screen.getByRole("textbox", { name: "文档源码" })).toHaveValue("# 本地版本");
    expect(save).toHaveBeenCalledOnce();
  });

  it("reloads the remote conflict version without issuing another save", async () => {
    const user = userEvent.setup();
    const conflict: DocumentConflict = {
      error: "Document conflict",
      code: "DOCUMENT_CONFLICT",
      content: "# 远端版本",
      hash: "hash-remote",
      path: chapterText.doc_path,
    };
    const save = vi.spyOn(api, "saveDocument").mockRejectedValue(new ApiError(409, conflict));
    renderDocumentPage();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.type(editor, "\n本地修改");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(await screen.findByRole("button", { name: "重新加载远端" }));

    expect(screen.getByRole("textbox", { name: "文档源码" })).toHaveValue("# 远端版本");
    expect(screen.getByText("已保存")).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
  });

  it("retains the draft and retries only after another explicit save", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, "saveDocument")
      .mockRejectedValueOnce(new Error("网络不可用"))
      .mockResolvedValueOnce({
        ok: true, changed: true, hash: "hash-new", path: chapterText.doc_path, indexed: true,
        versionId: "version-1", versionNo: 2,
      });
    renderDocumentPage();
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.type(editor, "\n本地修改");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("alert")).not.toHaveTextContent("网络不可用");
    expect(editor).toHaveValue("# 第一章\n本地修改");
    expect(save).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("已保存")).toBeInTheDocument();
  });

  it("guards switching documents while the current draft is dirty", async () => {
    const user = userEvent.setup();
    renderDocumentPage([chapterText, chapterTwo]);
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.type(editor, "\n本地修改");
    // The active module icon only toggles the slide-out list — no navigation,
    // so the dirty guard stays quiet while opening it.
    await user.click(screen.getByRole("button", { name: "章节正文" }));
    await user.click(within(screen.getByRole("navigation", { name: "章节正文文稿目录" })).getByRole("button", { name: /第二章/ }));

    expect(screen.getByRole("heading", { name: "放弃未保存的更改？" })).toBeInTheDocument();
    expect(api.readDocument).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    // After switching documents the view resets to preview; switch back to edit to see the source
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByRole("textbox", { name: "文档源码" })).toHaveValue("# 第二章");
  });

  it("filters director-script documents and excludes chapter-text in scripts module", async () => {
    renderDocumentPage([directorScript, chapterText], "/projects/project-1/scripts");

    expect(await screen.findByRole("heading", { name: "第一章导演剧本" })).toBeInTheDocument();
    expect(screen.getByRole("banner", { name: "导演剧本工作区" })).toBeInTheDocument();
    expect(screen.getByText("DIRECTOR SCRIPTS · 04")).toBeInTheDocument();
    // chapter-text document should not appear in scripts module sidebar
    expect(screen.queryByRole("button", { name: /chapters\/001/ })).not.toBeInTheDocument();
  });

  it("filters continuity documents and renders the rolling story summary", async () => {
    renderDocumentPage([storySummary, chapterText], "/projects/project-1/continuity?document=summary%2Fstory-so-far.md");

    expect(await screen.findByRole("banner", { name: "连续性档案工作区" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "故事至今" })).toBeInTheDocument();
    expect(screen.getByText("CONTINUITY ARCHIVE · 07")).toBeInTheDocument();
    expect(screen.getByText("陆尘在废墟中醒来。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /chapters\/001/ })).not.toBeInTheDocument();
  });

  it("shows continuity warnings when the summary trails confirmed chapters", async () => {
    const confirmedChapter: DocumentIndex = {
      ...chapterText,
      doc_path: "text/chapter-003.md",
      chapter_num: 3,
      status: "confirmed",
    };
    const staleSummary: DocumentIndex = {
      ...storySummary,
      meta: { latest_chapter: 2 },
    };
    renderDocumentPage([staleSummary, confirmedChapter], "/projects/project-1/continuity?document=summary%2Fstory-so-far.md");

    expect(await screen.findByRole("region", { name: "连续性检查" })).toHaveTextContent("滚动摘要落后于第 3 章");
  });

  it("warns when confirmed chapters have no rolling summary", async () => {
    const confirmedChapter: DocumentIndex = {
      ...chapterText, doc_path: "text/ch-003.md", chapter_num: 3, status: "confirmed",
    };
    renderDocumentPage([confirmedChapter], "/projects/project-1/continuity");

    expect(await screen.findByRole("region", { name: "连续性检查" })).toHaveTextContent("缺少滚动摘要");
  });

  it("warns when a character in the latest confirmed chapter has no state file", async () => {
    const confirmedChapter: DocumentIndex = {
      ...chapterText,
      doc_path: "text/ch-003.md",
      chapter_num: 3,
      status: "confirmed",
      meta: { characters_present: ["lin-fan"] },
    };
    const currentSummary: DocumentIndex = { ...storySummary, meta: { latest_chapter: 3 } };
    renderDocumentPage([currentSummary, confirmedChapter], "/projects/project-1/continuity");

    expect(await screen.findByRole("region", { name: "连续性检查" })).toHaveTextContent("缺少 1 个出场角色的状态文件");
  });

  it("preserves an unsaved draft while opening and closing a version", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(api, "saveDocument");
    renderDocumentPage([chapterText], "/projects/project-1/chapters?document=chapters%2F001.md", versionFixture);
    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByRole("textbox", { name: "文档源码" });
    await user.clear(editor);
    await user.type(editor, "# 未保存草稿");
    await user.click(await screen.findByRole("button", { name: /章节 Writer.*第 1 版/ }));
    expect(await screen.findByRole("region", { name: "修改对比" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭修改对比" }));

    expect(screen.getByRole("textbox", { name: "文档源码" })).toHaveValue("# 未保存草稿");
    expect(screen.getByText("未保存")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it("opens a deep-linked document version", async () => {
    renderDocumentPage(
      [chapterText],
      "/projects/project-1/chapters?document=chapters%2F001.md&version=v1",
      versionFixture,
    );

    expect(await screen.findByRole("region", { name: "修改对比" })).toBeVisible();
    expect(screen.getByText("@@ -1 +1 @@ 第一章")).toBeVisible();
    expect(api.getDocumentVersionDiff).toHaveBeenCalledWith("v1", null, 20);
  });

  describe("export", () => {
    it("renders export button", async () => {
      renderDocumentPage();
      expect(await screen.findByRole("button", { name: "导出" })).toBeInTheDocument();
    });

    it("shows format options on export button click", async () => {
      const user = userEvent.setup();
      renderDocumentPage();
      const exportBtn = await screen.findByRole("button", { name: "导出" });
      await user.click(exportBtn);

      expect(screen.getByText("Markdown (.md)")).toBeInTheDocument();
      expect(screen.getByText("纯文本 (.txt)")).toBeInTheDocument();
      expect(screen.getByText("Word (.docx)")).toBeInTheDocument();
    });

    it("calls api.exportDocument on selecting a format", async () => {
      const user = userEvent.setup();
      const exportSpy = vi.spyOn(api, "exportDocument").mockResolvedValue(undefined);
      renderDocumentPage();
      const exportBtn = await screen.findByRole("button", { name: "导出" });
      await user.click(exportBtn);
      await user.click(screen.getByText("Markdown (.md)"));

      expect(exportSpy).toHaveBeenCalledWith("project-1", "chapters/001.md", "md");
    });
  });
});
