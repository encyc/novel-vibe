import type { AgentId } from "../session/types.js";
import type { SupportedLanguage } from "../lib/language.js";
import type { PromptBlock, PromptLoader, SkillLoader, InstructionLoader } from "./types.js";

export function renderLanguageContext(language: SupportedLanguage): string {
  if (language === "en") {
    return `<language_context>
<project_language>en</project_language>
<project_language_name>English</project_language_name>
</language_context>

Reply and author new novel content in English.
An explicit language request in the current user task may override this for that task only.
Preserve existing source content unless translation is explicitly requested.
Do not translate proper nouns when preservation is appropriate, file paths, tool names,
frontmatter keys, enum values, or protocol markers.`;
  }
  return `<language_context>
<project_language>zh-CN</project_language>
<project_language_name>简体中文</project_language_name>
</language_context>

使用简体中文回复并创作新的小说内容。
当前用户任务若明确指定其他语言，仅在该任务内覆盖此设置。
除非明确要求翻译，否则保留已有来源内容。
不得翻译应保留的专有名词、文件路径、工具名、frontmatter 字段、枚举值或协议标记。`;
}

const DELETE_PROTOCOL = `
## 删除审批协议

你可以看到 \`delete_doc\` 工具，但**不能直接调用**。删除操作必须经过 Chief Editor 审批。

### 当你需要删除文件时：
1. **不要调用 delete_doc** — 调用会被自动拦截。
2. 在回复中明确声明删除请求，包含以下信息：
   - **待删除文件路径**（例如 \`characters/old-villain.md\`）
   - **删除原因**（例如：内容不满意、角色已合并、设定冲突、重复内容、重构后不再需要）
   - **前因后果**（简要说明为什么这个文件不再有价值）

### 常见删除场景：
- 之前生成的内容质量不达标，需要删除后重新生成
- 大纲调整导致某些章节卡不再需要
- 角色合并后旧角色文件成为冗余
- 世界观设定冲突，需要废弃旧版本
- 内容重复，保留一份即可

Chief Editor 会审查你的删除请求，通过后代为执行。`;

const WEB_SEARCH_PROTOCOL = `
## 联网搜索请求协议

你**没有** \`web_search\` 和 \`web_fetch\` 工具。当你需要外部知识（历史背景、科学原理、文化习俗、实时数据等）而不能仅靠已有项目文档回答时：

### 规则

1. **不要猜测或编造**你不确定的外部事实。如果你不确定某个事实的准确性，宁可请求搜索也不要瞎编。
2. 在回复中声明搜索请求，使用以下格式：

\`\`\`
[WEB_SEARCH_REQUEST]
query: <搜索查询关键词>
reason: <为什么需要这个信息>
\`\`\`

### 适用场景

- 需要核实某个历史事件的细节（例如"明朝县衙的建筑布局"）
- 需要了解你不熟悉的科学/文化知识（例如"量子纠缠的基础概念"）
- 需要查询当前真实世界的数据（例如"2025年全球人口排名前十的城市"）
- 需要找到特定风格或类型的参考资料

### 不适用

- 小说内部设定、角色、剧情 — 这些用 read_doc / search_docs
- 你可以从已有项目文档中直接获取的信息
- 纯粹创意的虚构内容（需要想象力，不需要搜索）

Chief Editor 会收到你的搜索请求，执行搜索后将结果传递给你。`;

function defaultBlocks(): PromptBlock[] {
  return [
    {
      name: "delete-protocol",
      appliesTo: (agentId) => agentId !== "chief_editor",
      render: () => DELETE_PROTOCOL,
    },
    {
      name: "web-search-protocol",
      appliesTo: (agentId) => agentId !== "chief_editor",
      render: () => WEB_SEARCH_PROTOCOL,
    },
  ];
}

export class PromptBuilder {
  private readonly promptLoader: PromptLoader;
  private readonly skillLoader: SkillLoader;
  private readonly instructionLoader?: InstructionLoader;
  private readonly blocks: PromptBlock[];
  private readonly token: string;
  private readonly projectId: string;
  private readonly userId: string | undefined;
  private creativeLanguage: SupportedLanguage;

  constructor(opts: {
    promptLoader: PromptLoader;
    skillLoader: SkillLoader;
    instructionLoader?: InstructionLoader;
    token: string;
    projectId: string;
    userId?: string;
    creativeLanguage: SupportedLanguage;
    blocks?: PromptBlock[];
  }) {
    this.promptLoader = opts.promptLoader;
    this.skillLoader = opts.skillLoader;
    this.instructionLoader = opts.instructionLoader;
    this.token = opts.token;
    this.projectId = opts.projectId;
    this.userId = opts.userId;
    this.creativeLanguage = opts.creativeLanguage;
    this.blocks = [...(opts.blocks ?? []), ...defaultBlocks()];
  }

  /** Build the complete system prompt for an agent. */
  async build(agentId: AgentId): Promise<string> {
    let prompt = await this.promptLoader(agentId);

    // Inject project-level creation guide (LINGQI.md) — hard rules sit closest
    // to the role definition, before skills and protocol blocks.
    if (this.instructionLoader) {
      const instructions = await this.instructionLoader(
        this.token,
        this.projectId,
        this.userId,
        agentId,
      );
      if (instructions) {
        prompt += "\n\n# 创作指南（LINGQI.md）\n\n" + instructions;
      }
    }

    // Inject skills
    const skillsPrompt = await this.skillLoader(
      this.token,
      this.projectId,
      this.userId,
      agentId,
    );
    if (skillsPrompt) {
      prompt += "\n\n" + skillsPrompt;
    }

    // Apply prompt blocks (protocols, custom sections)
    for (const block of this.blocks) {
      if (block.appliesTo(agentId)) {
        prompt += "\n" + block.render(agentId);
      }
    }

    prompt += "\n\n" + renderLanguageContext(this.creativeLanguage);
    return prompt;
  }

  setCreativeLanguage(language: SupportedLanguage): void {
    this.creativeLanguage = language;
  }

  /** Register an additional prompt block. */
  addBlock(block: PromptBlock): void {
    this.blocks.push(block);
  }
}
