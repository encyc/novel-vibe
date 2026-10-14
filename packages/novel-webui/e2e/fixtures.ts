import type { Page } from "@playwright/test";

export const documents = [
  {
    project_id: "project-1",
    doc_path: "chapters/001.md",
    doc_type: "chapter-text",
    name: "第一章 雾中的来客",
    status: "draft",
    word_count: 3280,
    updated_at: "2026-06-27T08:00:00.000Z",
  },
  {
    project_id: "project-1",
    doc_path: "chapters/001-director.md",
    doc_type: "director-script",
    name: "第一章导演脚本",
    status: "confirmed",
    word_count: 860,
    updated_at: "2026-06-27T07:30:00.000Z",
  },
  {
    project_id: "project-1",
    doc_path: "world/worldview.md",
    doc_type: "worldview",
    name: "北境世界观",
    status: "locked",
    word_count: 2100,
    updated_at: "2026-06-26T10:00:00.000Z",
  },
];

const currentSession = {
  id: "session-1",
  projectId: "project-1",
  title: "AI 总编",
  isProcessing: false,
  memoryStatus: "healthy",
  messageCount: 0,
  lastMessageAt: "2026-06-27T08:00:00.000Z",
  createdAt: "2026-06-27T08:00:00.000Z",
};

export const documentVersion = {
  id: "version-1",
  projectId: "project-1",
  path: "chapters/001.md",
  versionNo: 7,
  sourceType: "agent",
  agentId: "writer",
  beforeHash: "hash-before",
  afterHash: "hash-after",
  state: "complete",
  diffStatus: "ready",
  addedLines: 12,
  deletedLines: 5,
  changedSections: ["雨夜", "来客", "城门"],
  createdAt: "2026-08-14T10:00:00.000Z",
  completedAt: "2026-08-14T10:00:01.000Z",
};

export const documentDiff = {
  algorithmVersion: "jsdiff-v1",
  status: "ready",
  addedLines: 12,
  deletedLines: 5,
  changedSections: ["雨夜", "来客", "城门"],
  frontmatterChanges: [{ key: "status", kind: "changed", before: "draft", after: "confirmed" }],
  truncated: true,
  nextCursor: null,
  items: [
    { index: 0, section: "雨夜", oldStart: 48, newStart: 48, lines: [
      { kind: "context", oldLine: 48, newLine: 48, text: "城门在子夜前关闭。" },
      { kind: "delete", oldLine: 49, newLine: null, text: "雨停了。" },
      { kind: "insert", oldLine: null, newLine: 49, text: "身后的雨声越来越近。" },
    ] },
    { index: 1, section: "来客", oldStart: 72, newStart: 72, lines: [
      { kind: "delete", oldLine: 72, newLine: null, text: "他没有回头。" },
      { kind: "insert", oldLine: null, newLine: 72, text: "沈砚握紧刀柄，没有回头。" },
    ] },
    { index: 2, section: "城门", oldStart: 103, newStart: 103, lines: [
      { kind: "context", oldLine: 103, newLine: 103, text: "雾吞没了最后一盏灯。" },
      { kind: "insert", oldLine: null, newLine: 104, text: "门后传来三声叩响。" },
    ] },
  ],
};

export async function mockWorkspace(page: Page, conflict = false, withDiff = false) {
  const documentPuts: Array<Record<string, unknown>> = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/me") {
      await route.fulfill({ json: { user: { id: "user-1", email: "writer@example.com" } } });
      return;
    }
    if (url.pathname === "/api/profile") {
      await route.fulfill({ json: { id: "user-1", email: "writer@example.com", displayName: "沈砚", locale: "zh-CN" } });
      return;
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({
        json: {
          projects: [{
            id: "project-1",
            title: "长夜临渊",
            genre: "东方奇幻",
            synopsis: "失去城主的北境孤城，在漫长极夜中等待一位无名来客。",
          }],
        },
      });
      return;
    }
    if (url.pathname === "/api/projects/project-1/sessions") {
      await route.fulfill({ json: { items: [currentSession], nextCursor: null, activeSessionId: currentSession.id } });
      return;
    }
    if (url.pathname === "/api/sessions/session-1/messages") {
      await route.fulfill({ json: { items: withDiff ? [{
        id: "assistant-change", turnId: "turn-change", role: "assistant", text: "第一章已经修订完成。", status: "complete", createdAt: "2026-08-14T10:00:02.000Z",
        trace: { version: 1, runId: "run-change", status: "succeeded", steps: [{
          type: "document_change", id: "document:version-1", agentId: "writer", toolCallId: "write-1",
          versionId: "version-1", path: "chapters/001.md", versionNo: 7, addedLines: 12, deletedLines: 5,
          changedSections: ["雨夜", "来客", "城门"],
        }] },
      }] : [], nextCursor: null } });
      return;
    }
    if (url.pathname === "/api/models") {
      await route.fulfill({ json: { models: [] } });
      return;
    }
    if (url.pathname === "/api/membership/status") {
      await route.fulfill({ json: { active: false, features: [] } });
      return;
    }
    if (url.pathname === "/api/documents/project-1") {
      await route.fulfill({ json: { documents } });
      return;
    }
    if (url.pathname === "/api/documents/project-1/chapters/001.md/versions") {
      await route.fulfill({ json: { items: withDiff ? [documentVersion] : [], nextCursor: null } });
      return;
    }
    if (url.pathname === "/api/document-versions/version-1") {
      await route.fulfill({ json: documentVersion });
      return;
    }
    if (url.pathname === "/api/document-versions/version-1/diff") {
      await route.fulfill({ json: documentDiff });
      return;
    }
    if (url.pathname === "/api/documents/project-1/chapters/001.md") {
      if (route.request().method() === "PUT") {
        documentPuts.push(route.request().postDataJSON() as Record<string, unknown>);
        if (conflict) {
          await route.fulfill({
            status: 409,
            json: {
              error: "Document conflict",
              code: "DOCUMENT_CONFLICT",
              content: "# 第一章 远端版本\n\n远端已经更新。",
              hash: "hash-remote",
              path: "chapters/001.md",
            },
          });
          return;
        }
        await route.fulfill({
          json: { ok: true, hash: "hash-new", path: "chapters/001.md", indexed: true },
        });
        return;
      }
      await route.fulfill({
        json: {
          content: "---\ntype: chapter-text\nstatus: draft\n---\n\n# 第一章 雾中的来客\n\n城门在子夜前关闭。沈砚抵达时，最后一盏引路灯刚刚熄灭。\n\n他在雾里听见有人说：别回头。",
          hash: "hash-initial",
          path: "chapters/001.md",
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return documentPuts;
}
