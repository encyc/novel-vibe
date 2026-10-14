/**
 * `/lingqi` official chat command — edit the project-level LINGQI.md guide.
 *
 * Mirrors `/skill-creator` in shape but has no review/confirmation flow: the
 * Chief Editor reads `LINGQI.md` with `read_doc` and writes the new version
 * with `write_doc` directly. The file is project-scoped
 * (novels/{projectId}/LINGQI.md) and dispatches to agents via `## [role]`
 * heading tags.
 *
 * The prompt is intentionally short and directive — mirroring
 * buildSkillCreatorPrompt's "do X exactly" structure — so the Chief cannot
 * mistake this for a Skill draft or a request to create something named "lingqi".
 */

const SHARED = `[official_command name="lingqi"]
你现在执行的是 LINGQI 命令——编辑本项目的创作指南文件 LINGQI.md（路径固定为 "LINGQI.md"，位于项目根）。

第一步：立即用 read_doc 读取 "LINGQI.md"。

注意：
- 这是 LINGQI.md 文件，**不是 Skill**。不要调用 create_skill_draft，不要走 Skill 草稿/审核流程。
- 这个文件是本书专属的创作指南（类似 CLAUDE.md），每个 Agent 在工作时都会读取它。
- 回复作者时请称之为 "LINGQI" 或 "创作指南"，不要说成 "Skill"。

LINGQI.md 的格式：
- 以 frontmatter 开头：\`doc_type: lingqi\`、\`name: 创作指南\`、\`version\`、\`updated_at\`。
- 正文按 \`##\` 分节，标题可用 \`[role1, role2]\` 标记该节适用的 Agent；未标记或标 \`[all]\` 的节对所有 6 个 Agent 可见。
- 角色名取自：chief_editor、worldbuilder、character_designer、outliner、director、writer。

frontmatter 模板：
\`\`\`yaml
---
doc_type: lingqi
name: 创作指南
version: 1
updated_at: <YYYY-MM-DD>
---
\`\`\`

分节示例：
\`\`\`
## 全局禁忌              ← 所有 Agent
## [writer, director] 文风  ← 仅 writer、director
## [chief_editor] 商业线     ← 仅 chief_editor
\`\`\``;

/**
 * Build the system-injected prompt for the `/lingqi` command.
 * - With an argument: read the current guide, revise per the request, save directly.
 * - Without an argument: read the current guide and summarize it for the user.
 */
export function buildLingqiPrompt(userMessage?: string): string {
  const request = userMessage?.trim();
  if (!request) {
    return `${SHARED}

读取后：
- 若读取失败（文件不存在）：告诉作者当前项目还没有 LINGQI，并说明可用 "/lingqi <要求>" 让你起草，或在左侧 LINGQI 页面手动编辑。
- 若读取成功：向作者清晰摘要当前 LINGQI——有哪些节、分别覆盖哪些角色、关键约束各一条。让作者一眼掌握全貌，不要逐字复述。
- 最后询问作者是否需要调整。`;
  }

  return `${SHARED}

读取后按作者的要求修改 LINGQI.md：
- 若文件不存在，从零创建（套用上面的 frontmatter 模板）。
- 保留未涉及的节，调整或新增相关节，保持分节标签格式。
- 用 write_doc 写回完整新版本（路径 "LINGQI.md"），**直接落盘，无需确认**。
- 简要告诉作者改了什么（新增/修改/删除了哪些节、影响哪些角色），不要复述全文。

作者的要求：${request}`;
}
