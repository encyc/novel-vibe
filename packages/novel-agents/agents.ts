/**
 * Agent orchestrator: creates all 7 novel agents, handles sub-agent invocation,
 * and manages the Chief Editor ↔ sub-agent delegation flow.
 */
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { parseFrontmatter } from "./lib/frontmatter.js";

import type { EntitlementPort, TurnUsageBilling } from "./lib/policy-ports.js";
import { attachUsageTracker } from "./lib/usage-tracker.js";
import type { ByokTurnState } from "./lib/byok.js";
import { createFileTools } from "./tools/file-tools.js";
import { createIndexTools } from "./tools/index-tools.js";
import { createStatusTools } from "./tools/status-tools.js";
import { createLintDocTool, createNotesHealthTool } from "./tools/lint-tools.js";
import { createReferenceTools } from "./tools/reference-tools.js";
import { createPromoteVariantTool } from "./tools/variant-tools.js";
import {
  buildReaderReport,
  createSimulateReaderTool,
  foldReaderReply,
  MAX_READER_CHAPTERS,
  NOTES_CHAR_BUDGET,
  READER_SYSTEM_PROMPT,
  renderReaderPrompt,
  type ReportSection,
} from "./tools/simulator-tools.js";
import { createToolContext, type ToolContext } from "./tools/file-tools.js";
import { createSkillDraftTool, createSkillEvolutionTool } from "./tools/skill-tools.js";
import { createWebTools } from "./tools/web-tools.js";
import { createInteractionTools } from "./tools/interaction-tools.js";
import { AGENT_IDS, type AgentId, type ModelDescriptor } from "./session/types.js";
import { ContextManager } from "./context/manager.js";
import { createLogger } from "./lib/logger.js";
import { loadAgentPrompt } from "./lib/agent-resources/loader.js";
import type { SupportedLanguage } from "./lib/language.js";
import { renderLanguageContext } from "./context/prompt-builder.js";
import type { ModelResolver } from "./model-runtime/model-resolver.js";
import type { RuntimeModelHealthService } from "./model-runtime/health-service.js";
import {
  getSystemModelHealthService,
  getSystemModelResolver,
} from "./model-runtime/system-resolver.js";

const log = createLogger("agents");

// ─── Agent config ─────────────────────────────────────────────────

interface AgentConfig {
  id: AgentId;
  promptFile: string;
  modelProvider: string;
  modelName: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  toolSets: ("file" | "index" | "status" | "delegate" | "skill" | "web" | "interaction" | "lint" | "notes" | "reference" | "variant" | "simulator")[];
}

const TOOL_NAMES_BY_SET = {
  file: ["read_doc", "list_skills", "load_skill", "write_doc", "delete_doc", "search_docs", "list_docs", "chapter_context"],
  index: ["sync_index", "sync_all_indexes"],
  status: ["update_status", "get_project_status"],
  delegate: ["delegate_to_agent"],
  skill: ["create_skill_draft", "propose_skill_evolution"],
  web: ["web_search", "web_fetch"],
  interaction: ["update_run_plan", "request_user_interaction"],
  lint: ["lint_doc"],
  notes: ["notes_health"],
  reference: ["query_references", "foreshadow_debt", "list_variants"],
  variant: ["promote_variant"],
  simulator: ["simulate_reader"],
} as const;

const LLM_PROVIDER = () => process.env.LLM_PROVIDER ?? "deepseek";
const LLM_MODEL = () => process.env.LLM_MODEL ?? "deepseek-v4-flash";

function getAgentConfigs(): AgentConfig[] {
  return [
  {
    id: "chief_editor",
    promptFile: "chief-editor",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "status", "delegate", "skill", "web", "interaction", "notes", "reference", "variant", "simulator"],
  },
  {
    id: "worldbuilder",
    promptFile: "worldbuilder",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "reference"],
  },
  {
    id: "character_designer",
    promptFile: "character-designer",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "reference"],
  },
  {
    id: "outliner",
    promptFile: "outliner",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "reference"],
  },
  {
    id: "director",
    promptFile: "director",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "lint", "reference"],
  },
  {
    id: "writer",
    promptFile: "writer",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "lint", "reference"],
  },
  {
    id: "script_supervisor",
    promptFile: "script-supervisor",
    modelProvider: LLM_PROVIDER(),
    modelName: LLM_MODEL(),
    thinkingLevel: "medium",
    toolSets: ["file", "index", "lint", "notes", "reference"],
  },
  ];
}

export function configuredToolNamesForRole(role: AgentId): string[] {
  const config = getAgentConfigs().find((candidate) => candidate.id === role);
  if (!config) return [];
  return [...new Set(config.toolSets.flatMap((set) => TOOL_NAMES_BY_SET[set]))];
}

// ─── Sub-agent delegation tool ────────────────────────────────────

import { Type } from "@sinclair/typebox";

const delegateParams = Type.Object({
  agent: Type.Union([
    Type.Literal("worldbuilder"),
    Type.Literal("character_designer"),
    Type.Literal("outliner"),
    Type.Literal("director"),
    Type.Literal("writer"),
    Type.Literal("script_supervisor"),
  ]),
  task: Type.String({ description: "Task description and context for the sub-agent" }),
  task_description: Type.Optional(Type.String({ description: "Short (3-8 word) display label of this delegation for UI progress rows" })),
  output_path: Type.String({ description: "Expected output file path, e.g. 'worldview/power_system/qi-system.md'" }),
});

function createDelegateTool(
  subAgents: Record<string, Agent>,
  ctx: ToolContext,
): AgentTool<typeof delegateParams> {
  return {
    name: "delegate_to_agent",
    label: "Delegate to Sub-Agent",
    description:
      "Delegate a task to a specialized sub-agent. The sub-agent will execute the task and write output to storage. Returns the sub-agent's output.",
    parameters: delegateParams,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate) => {
      const agent = subAgents[params.agent];
      if (!agent) {
        return {
          content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
          details: { error: true },
          isError: true,
        };
      }

      // Create task record
      const task = await ctx.db.createTask({
        projectId: ctx.projectId,
        agent: params.agent,
        taskType: "create",
        description: params.task_description ?? params.task,
        outputPath: params.output_path,
      });

      onUpdate?.({
        content: [{ type: "text", text: `Delegating to ${params.agent}${params.task_description ? ` · ${params.task_description}` : ""}...` }],
        details: { taskId: task.id, status: "working" },
      });

      const abortDelegatedAgent = () => agent.abort();
      signal?.addEventListener("abort", abortDelegatedAgent, { once: true });
      try {
        signal?.throwIfAborted();
        // Run sub-agent with the task
        const prompt = `${params.task}

输出文件路径: ${params.output_path}

write_doc 会自动校验 frontmatter 并同步索引；仅在修复旧索引时使用 sync_index。`;

        await agent.prompt(prompt);

        // Get the last assistant message as output
        const messages = agent.state.messages;
        const lastAssistant = [...messages]
          .reverse()
          .find((m: any) => m.role === "assistant");

        const outputText = lastAssistant
          ? (lastAssistant as any).content
              ?.filter((c: any) => c.type === "text")
              ?.map((c: any) => c.text)
              ?.join("\n") ?? "Sub-agent completed."
          : "Sub-agent completed (no text output).";

        // Mark task as submitted
        await ctx.db.updateTaskStatus(task.id, "submitted");

        return {
          content: [{ type: "text", text: `[${params.agent}] Task completed.\n\n${outputText}` }],
          details: { taskId: task.id, agent: params.agent, outputPath: params.output_path },
        };
      } catch (err: any) {
        await ctx.db.updateTaskStatus(task.id, "rejected", err.message);
        return {
          content: [{ type: "text", text: `[${params.agent}] Task failed: ${err.message}` }],
          details: { taskId: task.id, error: true },
          isError: true,
        };
      } finally {
        signal?.removeEventListener("abort", abortDelegatedAgent);
      }
    },
  };
}

function lastAssistantText(agent: Agent): string {
  const messages = agent.state.messages;
  const lastAssistant = [...messages]
    .reverse()
    .find((m: any) => m.role === "assistant");
  if (!lastAssistant) return "";
  return ((lastAssistant as any).content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

// ─── Agent factory ────────────────────────────────────────────────

export interface NovelOrchestratorConfig {
  token: string;
  projectId: string;
  /** Turn billing port. The composition root decides the implementation (SaaS credits
   * client, local no-op, ...); the core never constructs one. */
  billing: TurnUsageBilling;
  /** Membership gate port. Same rule as `billing`: injected, never constructed here. */
  entitlements: EntitlementPort;
  userId?: string;
  sessionId?: string;
  systemJobId?: string;
  modelOverrides?: Record<string, { provider: string; model: string }>;
  /** Shared per-orchestrator BYOK slot: mutated by setByokTurnContext, read by
   * streamFn / reader checkpoint / compaction billing for the active turn. */
  byokTurnState?: ByokTurnState;
  contextManager?: ContextManager;
  creativeLanguage?: SupportedLanguage;
  modelResolver?: Pick<ModelResolver, "resolve">;
  modelHealthService?: Pick<RuntimeModelHealthService, "observeFailure">;
}

export class NovelOrchestrator {
  private agents: Record<string, Agent> = {};
  private ctx: ToolContext;
  private config: NovelOrchestratorConfig;
  private userId?: string;
  private sessionId?: string;
  private modelDescriptors: Partial<Record<AgentId, ModelDescriptor>> = {};
  private usageTrackingSetup = false;
  private modelResolver: Pick<ModelResolver, "resolve">;
  private modelHealthService: Pick<RuntimeModelHealthService, "observeFailure">;
  private readonly streamFn: StreamFn;

  constructor(config: NovelOrchestratorConfig) {
    this.config = config;
    this.userId = config.userId;
    this.sessionId = config.sessionId;
    this.ctx = createToolContext(
      config.token,
      config.projectId,
      config.userId,
      config.sessionId,
      config.systemJobId,
      config.entitlements,
    );
    this.modelResolver = config.modelResolver ?? getSystemModelResolver();
    this.modelHealthService = config.modelHealthService ?? getSystemModelHealthService();
    this.streamFn = this.wrapStreamFn(streamSimple);
  }

  /** Injects the turn-scoped BYOK key into every provider call. An explicit
   * options.apiKey overrides provider env auth inside pi-ai (compat.js). */
  private wrapStreamFn(base: StreamFn): StreamFn {
    return (model, context, options) => {
      const apiKey = this.config.byokTurnState?.apiKey;
      return base(model, context, apiKey ? { ...options, apiKey } : options);
    };
  }

  /** Initialize all agents. Must be called before use. */
  async init(): Promise<void> {
    // Install built-in skills (idempotent — skips already installed).
    // Always enable all built-in skills for the current workspace, not just
    // newly installed ones — server.ts pre-installs into the registry at
    // startup, so a workspace init would never see "new" installs and built-in
    // skills would never be auto-enabled.
    try {
      const { installBuiltInSkills, enableDefaultSkillsForWorkspace, BUILTIN_SKILLS } = await import("./lib/skills.js");
      const installed = await installBuiltInSkills(this.config.token);
      if (installed.length > 0) {
        log.info(`Installed built-in skills: ${installed.join(", ")}`);
      }
      const builtInSlugs = BUILTIN_SKILLS.map((s) => s.slug);
      await enableDefaultSkillsForWorkspace(this.config.token, this.config.projectId, builtInSlugs);
    } catch (err: any) {
      log.warn(`Failed to install/enable built-in skills: ${err.message}`);
    }

    const subAgents: Record<string, Agent> = {};
    const agentConfigs = getAgentConfigs();

    // When contextManager is available, skills are handled by PromptBuilder.
    // When not, load them the old way for backward compat.
    const skillsPrompts: Partial<Record<AgentId, string>> = {};
    if (!this.config.contextManager) {
      const { loadEnabledSkills, formatSkillsForSystemPrompt } = await import("./lib/skills.js");
      for (const cfg of agentConfigs) {
        try {
          const skills = await loadEnabledSkills(this.config.token, this.config.projectId, this.userId, cfg.id);
          skillsPrompts[cfg.id] = skills.length > 0 ? formatSkillsForSystemPrompt(skills) : "";
        } catch (err: any) {
          skillsPrompts[cfg.id] = "";
        }
      }
    }

    // Create sub-agents first (without delegate tool)
    for (const cfg of agentConfigs.filter((c) => c.id !== "chief_editor")) {
      const agent = await this.createAgent(cfg, [], skillsPrompts[cfg.id] ?? "");
      subAgents[cfg.id] = agent;
      this.agents[cfg.id] = agent;
    }

    this.ctx.onDocumentStatusChanged = (event) => this.handleDocumentStatusChanged(event);

    // Create chief editor with delegation tool
    const chiefConfig = agentConfigs.find((c) => c.id === "chief_editor")!;
    const delegateTool = createDelegateTool(subAgents, this.ctx);
    const chiefAgent = await this.createAgent(chiefConfig, [delegateTool], skillsPrompts.chief_editor ?? "");
    this.agents["chief_editor"] = chiefAgent;

    // Sync model descriptors to ContextManager so it can resolve models
    if (this.config.contextManager) {
      this.config.contextManager.setModelDescriptors(this.modelDescriptors);
    }

    this.setupUsageTracking();
  }

  private async handleDocumentStatusChanged(
    event: import("./tools/file-tools.js").DocumentStatusChange,
  ): Promise<void> {
    if (
      event.status !== "confirmed"
      || event.chapterNumber === undefined
      || !event.confirmedHash
    ) return;
    await this.ctx.db.enqueueContinuityJob({
      projectId: this.config.projectId,
      chapterNumber: event.chapterNumber,
      chapterPath: event.path,
      confirmedHash: event.confirmedHash,
    });
  }

  async runContinuityCheckpoint(chapterNumber: number, path: string, jobId: string, confirmedHash?: string): Promise<void> {
    const supervisor = this.agents.script_supervisor;
    if (!supervisor) throw new Error("script_supervisor is not initialized");
    const previousSystemJobId = this.ctx.systemJobId;
    this.ctx.systemJobId = jobId;
    try {
      const hashLine = confirmedHash ? `\nconfirmed_hash: ${confirmedHash}` : "";
      const continuityTask = `<continuity_task chapter="${chapterNumber}" path="${path}">${hashLine}
本章已确认进入正典。按笔记规范追加连续性笔记（只追加，不改写历史节）：
1. 用 read_doc 读取本章正文，列出本章实际出场的角色（以正典 character 档案为限；无档案的路人只进摘要节，不开状态文件）。
2. summary/story-so-far.md 追加 "## Ch.${chapterNumber} <章节名>" 一节：3-6 句本章摘要加一句章末局面。
3. 每个出场角色在 characters/{slug}-state.md 追加本章一节：位置 / 新知道的信息 / 持有物变化 / 关系变化，每条内联出处 (ch${chapterNumber}: "原文短引")。
4. 依据正文实际内容推进本章埋设/回收的伏笔生命周期（foreshadowing/fs-{NNN}.md）。
5. 所有更新文件的 frontmatter latest_chapter 如实写 ${chapterNumber}。
已完成章节的旧节保持原样；对本章内容有疑问时用 search_docs 在正典原文中自证。write_doc validates and indexes automatically.
</continuity_task>`;
      await supervisor.prompt(
        `continuity:chapter:${chapterNumber}\n\n${continuityTask}\n\n${renderLanguageContext(this.config.creativeLanguage ?? "zh-CN")}`,
      );
    } finally {
      this.ctx.systemJobId = previousSystemJobId;
    }
  }

  /**
   * Serial limited-memory reader simulation (verifier-stack Phase 4).
   * Runs a throwaway zero-tool agent chapter by chapter with rolling notes;
   * the agent is discarded afterwards so no memory leaks across runs.
   */
  async runReaderCheckpoint(fromChapter: number, toChapter: number): Promise<{
    report: string;
    chaptersRead: number[];
    confusionCount: number;
  }> {
    const all = await this.ctx.db.listDocuments(this.ctx.projectId, "chapter-text");
    const approvedStatuses = new Set(["confirmed", "locked"]);
    const chapters = (all as any[])
      .filter((d) => approvedStatuses.has(d.status)
        && typeof d.chapter_num === "number"
        && d.chapter_num >= fromChapter
        && d.chapter_num <= toChapter
        && typeof d.doc_path === "string")
      .sort((a, b) => a.chapter_num - b.chapter_num);
    if (chapters.length === 0) {
      throw new Error(`第 ${fromChapter}–${toChapter} 章范围内没有已确认的章节文本`);
    }

    const truncated = chapters.length > MAX_READER_CHAPTERS;
    const selected = truncated ? chapters.slice(0, MAX_READER_CHAPTERS) : chapters;

    // Throwaway proxy: tools-less, no context-manager coupling, discarded after this run.
    // On BYOK turns the reader follows the chief editor's model so the user's
    // own key pays for it too; platform turns keep the platform default model.
    const byokActive = Boolean(this.config.byokTurnState?.apiKey);
    const readerDescriptor = byokActive ? this.getModelDescriptor("chief_editor") : null;
    const resolvedModel = await this.modelResolver.resolve(
      readerDescriptor?.provider ?? LLM_PROVIDER(),
      readerDescriptor?.model ?? LLM_MODEL(),
    );
    const readerAgent = new Agent({
      streamFn: this.streamFn,
      initialState: {
        systemPrompt: READER_SYSTEM_PROMPT,
        model: resolvedModel.model,
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      convertToLlm: (messages) => messages as any[],
    });
    // Bill the throwaway proxy like any other agent activity; the enclosing
    // chat turn already passed the pre-flight balance authorization.
    if (this.userId) {
      attachUsageTracker({
        agent: readerAgent,
        billing: this.config.billing,
        userId: this.userId,
        projectId: this.config.projectId,
        sessionId: () => this.sessionId || undefined,
        agentId: "reader_simulation",
        isByokTurn: () => Boolean(this.config.byokTurnState?.apiKey),
      });
    }

    let notes = "（连载刚开始，暂无记忆）";
    const sections: ReportSection[] = [];
    for (const doc of selected) {
      const content = await this.ctx.storage.read(doc.doc_path);
      const body = parseFrontmatter(content).body.trim();
      await readerAgent.prompt(renderReaderPrompt({ chapter: doc.chapter_num, body, notes }));
      const rawReply = lastAssistantText(readerAgent);
      const { parsed, nextNotes } = foldReaderReply(rawReply, notes);
      notes = nextNotes.slice(0, NOTES_CHAR_BUDGET);
      sections.push({ chapter: doc.chapter_num, path: doc.doc_path, rawReply, parsed });
    }

    return {
      report: buildReaderReport({ fromChapter, toChapter, sections, truncated }),
      chaptersRead: sections.map((section) => section.chapter),
      confusionCount: sections.reduce((sum, section) => sum + section.parsed.confusions.length, 0),
    };
  }

  private async createAgent(cfg: AgentConfig, extraTools: AgentTool<any>[] = [], skillsPrompt = ""): Promise<Agent> {
    const tools: AgentTool<any>[] = [];

    for (const set of cfg.toolSets) {
      switch (set) {
        case "file":
          tools.push(...createFileTools(this.ctx, cfg.id));
          break;
        case "index":
          tools.push(...createIndexTools(this.ctx));
          break;
        case "lint":
          tools.push(createLintDocTool(this.ctx));
          break;
        case "notes":
          tools.push(createNotesHealthTool(this.ctx));
          break;
        case "reference":
          tools.push(...createReferenceTools(this.ctx));
          break;
        case "variant":
          tools.push(createPromoteVariantTool(this.ctx));
          break;
        case "simulator":
          tools.push(createSimulateReaderTool(this));
          break;
        case "status":
          tools.push(...createStatusTools(this.ctx));
          break;
        case "delegate":
          // handled separately via extraTools
          break;
        case "skill":
          tools.push(createSkillDraftTool(this.ctx));
          tools.push(createSkillEvolutionTool(this.ctx));
          break;
        case "web":
          tools.push(...createWebTools(this.ctx));
          break;
        case "interaction":
          tools.push(...createInteractionTools(this.ctx));
          break;
      }
    }
    tools.push(...extraTools);

    const modelOverride = this.config.modelOverrides?.[cfg.id];
    const provider = modelOverride?.provider ?? cfg.modelProvider;
    const modelId = modelOverride?.model ?? cfg.modelName;
    const resolvedModel = await this.modelResolver.resolve(provider, modelId);
    const { model } = resolvedModel;

    const descriptor: ModelDescriptor = {
      api: model.api,
      provider: model.provider,
      model: model.id,
      contextWindow: model.contextWindow,
    };
    this.modelDescriptors[cfg.id] = descriptor;

    // Propagate to ContextManager immediately so asCallback / buildContext
    // can resolve the model before init() completes the global sync.
    if (this.config.contextManager) {
      this.config.contextManager.setModelDescriptors(this.modelDescriptors);
    }

    let systemPrompt: string;
    if (this.config.contextManager) {
      systemPrompt = await this.config.contextManager.prompt.build(cfg.id);
    } else {
      // Legacy fallback (tests only). The production ContextManager path
      // also injects the project-level LINGQI.md creation guide here; this
      // branch intentionally does not — LINGQI injection requires an async
      // storage read that this synchronous signature cannot accommodate.
      systemPrompt = await loadAgentPrompt(cfg.id);
      if (skillsPrompt) {
        systemPrompt += "\n\n" + skillsPrompt;
      }
      if (cfg.id !== "chief_editor") {
        systemPrompt += `
\n## 删除审批协议

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

        systemPrompt += `
\n## 联网搜索请求协议

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
      }
      systemPrompt += `\n\n${renderLanguageContext(this.config.creativeLanguage ?? "zh-CN")}`;
    }

    if (cfg.id === "chief_editor") {
      systemPrompt += `\n\n## Structured interaction protocol\n\nUse update_run_plan only for meaningful multi-step work. Use request_user_interaction only when user input is necessary. The form is rendered by the interface, so do not reproduce its choices in prose. After requesting an interaction, stop and wait for the user's structured response.`;
    }

    const agent = new Agent({
      streamFn: this.streamFn,
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: cfg.thinkingLevel ?? "off",
        tools,
        messages: [],
      },
      convertToLlm: (messages) => messages as any[],
      sessionId: this.sessionId,
      transformContext: this.config.contextManager
        ? this.config.contextManager.asCallback(cfg.id, this.sessionId ?? "")
        : undefined,
      beforeToolCall: cfg.id !== "chief_editor"
        ? async (context) => {
            if (context.toolCall.name === "delete_doc") {
              return {
                block: true,
                reason:
                  "删除操作需要 Chief Editor 审批。请勿直接调用 delete_doc。\n" +
                  "请在回复中明确声明删除需求，Chief Editor 看到后会代为执行。\n" +
                  `被拦截的删除目标: ${(context.args as any)?.path ?? "未知"}`,
              };
            }
          }
        : undefined,
    });
    agent.subscribe(async (event) => {
      if (event.type !== "message_end"
        || event.message.role !== "assistant"
        || event.message.stopReason !== "error") return;
      await this.modelHealthService.observeFailure(
        resolvedModel,
        new Error(event.message.errorMessage ?? "Model request failed without an error message"),
        this.sessionId,
      );
    });
    return agent;
  }

  /** Set user ID for credit billing */
  setUserId(userId: string): void {
    this.userId = userId;
    this.setupUsageTracking();
  }

  /** Lock pricing at turn_start and charge completed usage on every agent. */
  private setupUsageTracking(): void {
    if (this.usageTrackingSetup || !this.userId) return;
    this.usageTrackingSetup = true;

    const billing = this.config.billing;

    for (const [id, agent] of Object.entries(this.agents)) {
      attachUsageTracker({
        agent,
        billing,
        userId: this.userId,
        projectId: this.config.projectId,
        sessionId: () => this.sessionId || undefined,
        agentId: id,
        isByokTurn: () => Boolean(this.config.byokTurnState?.apiKey),
      });
    }
  }

  /** Turn-scoped BYOK key slot; mirrored into the shared state object that
   * streamFn / summaryGenerator / compaction billing all read. */
  setByokTurnContext(ctx: { apiKey: string } | null): void {
    if (this.config.byokTurnState) this.config.byokTurnState.apiKey = ctx?.apiKey ?? null;
  }

  /** Set session for memory scoping */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
    for (const agent of Object.values(this.agents)) agent.sessionId = sessionId;
  }

  /** Attach the durable Session turn to tool provenance and interaction ownership. */
  setTurnContext(turnId: string | null, assistantMessageId: string | null = null): void {
    this.ctx.turnId = turnId ?? undefined;
    this.ctx.assistantMessageId = assistantMessageId ?? undefined;
  }

  /** Backward-compatible document provenance setter. */
  setTurnId(turnId: string | null): void {
    this.setTurnContext(turnId, null);
  }

  snapshotMessages(): Record<AgentId, AgentMessage[]> {
    return Object.fromEntries(
      AGENT_IDS.map((id) => [id, [...(this.agents[id]?.state.messages ?? [])]]),
    ) as Record<AgentId, AgentMessage[]>;
  }

  restoreMessages(messages: Partial<Record<AgentId, AgentMessage[]>>): void {
    for (const id of AGENT_IDS) {
      if (messages[id] && this.agents[id]) this.agents[id].state.messages = [...messages[id]!];
    }
  }

  getModelDescriptor(agentId: AgentId): ModelDescriptor {
    const descriptor = this.modelDescriptors[agentId];
    if (!descriptor) throw new Error(`Agent model is not initialized: ${agentId}`);
    return descriptor;
  }

  getContextWindow(agentId: AgentId): number {
    return this.getModelDescriptor(agentId).contextWindow;
  }

  /** Send a message to the Chief Editor (main user interface). */
  async chat(message: string): Promise<string> {
    const chief = this.agents["chief_editor"];
    if (!chief) throw new Error("Orchestrator not initialized. Call init() first.");

    await chief.prompt(message);

    // Extract last assistant text
    const messages = chief.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m: any) => m.role === "assistant");

    if ((lastAssistant as any)?.errorMessage) {
      throw new Error((lastAssistant as any).errorMessage);
    }
    if ((lastAssistant as any)?.stopReason === "error") {
      throw new Error("Model request failed without an error message");
    }

    const reply = lastAssistant
      ? (lastAssistant as any).content
          ?.filter((c: any) => c.type === "text")
          ?.map((c: any) => c.text)
          ?.join("\n") ?? ""
      : "";

    return reply;
  }

  /** Abort any Agent currently participating in the active turn. */
  abort(): void {
    for (const agent of Object.values(this.agents)) {
      if (agent.state.isStreaming) agent.abort();
    }
  }

  /** Subscribe to Chief Editor events only. */
  onEvent(handler: (event: AgentEvent) => void): void {
    const chief = this.agents["chief_editor"];
    if (chief) {
      chief.subscribe(async (event) => {
        handler(event);
      });
    }
  }

  onDisplayEvents(handler: (event: AgentEvent) => void): () => void {
    const chief = this.agents["chief_editor"];
    if (!chief) return () => {};
    const visibleTypes = new Set<AgentEvent["type"]>([
      "message_start",
      "message_update",
      "message_end",
      "agent_end",
    ]);
    return chief.subscribe(async (event) => {
      if (visibleTypes.has(event.type)) handler(event);
    });
  }

  /** Subscribe to all agent events, tagged with agentId for sub-agent visibility.
   * Returns an array of unsubscribe functions — call all of them to clean up. */
  onAllEvents(handler: (event: AgentEvent & { agentId: AgentId }) => void): Array<() => void> {
    const unsubscribes: Array<() => void> = [];
    for (const [id, agent] of Object.entries(this.agents)) {
      const unsub = agent.subscribe(async (event) => {
        handler({ ...event, agentId: id as AgentId });
      });
      unsubscribes.push(unsub);
    }
    return unsubscribes;
  }

  /** Get a specific sub-agent by ID. */
  getAgent(id: string): Agent | undefined {
    return this.agents[id];
  }

  /** Get the tool context. */
  getContext(): ToolContext {
    return this.ctx;
  }

  getContextManager(): ContextManager {
    if (!this.config.contextManager) {
      throw new Error("ContextManager is not configured for this orchestrator");
    }
    return this.config.contextManager;
  }
}
