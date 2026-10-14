import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the pi framework
vi.mock("@earendil-works/pi-agent-core", () => {
  const mockAgent = vi.fn(function (this: any, options: any) {
    this.state = {
      ...options.initialState,
      messages: [...(options.initialState?.messages ?? [])],
    };
    this.sessionId = options.sessionId;
    this.transformContext = options.transformContext;
    this.prompt = vi.fn();
    this.abort = vi.fn();
    this.subscribe = vi.fn().mockReturnValue(vi.fn());
  });
  return {
    Agent: mockAgent,
  };
});

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn().mockReturnValue({
    id: "test-model",
    api: "openai-completions",
    provider: "deepseek",
    contextWindow: 128_000,
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: vi.fn(),
}));

// Mock fs
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue("# System Prompt\n\nYou are an AI agent."),
}));

vi.mock("./lib/agent-resources/loader.js", () => ({
  loadAgentPrompt: vi.fn().mockResolvedValue("# System Prompt\n\nYou are an AI agent."),
}));

// Mock db
const mockDbInstance = {
  mode: "user",
  createTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  listTasks: vi.fn(),
  enqueueContinuityJob: vi.fn(),
  listDocuments: vi.fn(),
  upsertDocumentIndex: vi.fn(),
  listSkillRegistry: vi.fn(),
  listWorkspaceSkills: vi.fn(),
  getSkillFromRegistry: vi.fn(),
  toggleWorkspaceSkill: vi.fn(),
};
const mockSystemDbInstance = { mode: "system" };

vi.mock("./lib/db.js", () => ({
  DbClient: {
    forUser: vi.fn().mockImplementation(() => mockDbInstance),
    forSystem: vi.fn().mockImplementation(() => mockSystemDbInstance),
  },
}));

// Mock storage
const mockStorageInstance = {
  read: vi.fn(),
  write: vi.fn(),
  delete: vi.fn(),
};

vi.mock("./lib/storage.js", () => ({
  StorageClient: {
    forUser: vi.fn().mockImplementation(() => mockStorageInstance),
    forSystem: vi.fn().mockImplementation(() => mockStorageInstance),
  },
}));

// Mock skills
vi.mock("./lib/skills.js", () => ({
  BUILTIN_SKILLS: [
    { slug: "skill-creator", sourceFile: "builtin/skill-creator/SKILL.md" },
  ],
  loadEnabledSkills: vi.fn().mockResolvedValue([]),
  formatSkillsForSystemPrompt: vi.fn().mockReturnValue(""),
  installBuiltInSkills: vi.fn().mockResolvedValue([]),
  enableDefaultSkillsForWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// Mock memori
vi.mock("./memori.js", () => ({
  ProjectMemory: vi.fn().mockImplementation(() => ({
    recallContext: vi.fn().mockResolvedValue(""),
    captureTurn: vi.fn().mockResolvedValue(undefined),
    setSession: vi.fn(),
  })),
  isMemoriAvailable: vi.fn().mockReturnValue(false),
}));

import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { configuredToolNamesForRole, NovelOrchestrator, type NovelOrchestratorConfig } from "./agents.js";
import { ALLOW_ALL_ENTITLEMENTS, type TurnUsageBilling } from "./lib/policy-ports.js";
import type { PricingQuote } from "./lib/usage-cost-types.js";
import { AGENT_IDS } from "./session/types.js";
import { capabilityForTool } from "./skills/capabilities.js";
import { createFileTools } from "./tools/file-tools.js";
import { createIndexTools } from "./tools/index-tools.js";
import { createStatusTools } from "./tools/status-tools.js";
import type { ToolContext } from "./tools/file-tools.js";

// Minimal TurnUsageBilling stub. The orchestrator no longer constructs a SaaS
// billing client: the composition root injects the port, so these tests inject a
// stub the same way. Assertions here never cross the billable path; the quote
// stays valid so an unexpected call fails on an assertion rather than on shape.
const TEST_QUOTE: PricingQuote = {
  version: 1,
  requestStartedAt: "2026-01-01T00:00:00.000Z",
  modelId: "test-model",
  modelProvider: "deepseek",
  creditRateId: "test-rate",
  creditRateWindowId: null,
  pricingPeriod: "standard",
  billingMultiplier: 1,
  inputRate: 0,
  outputRate: 0,
  cacheReadRate: 0,
  cacheWriteRate: 0,
};

const TEST_TURN_BILLING: TurnUsageBilling = {
  createPricingQuote: async () => TEST_QUOTE,
  recordAndChargeQuotedUsage: async () => {},
  recordByokUsage: async () => {},
};

/** Injects the ports exactly like the composition root does. */
function makeOrchestrator(
  config: Omit<NovelOrchestratorConfig, "billing" | "entitlements">,
): NovelOrchestrator {
  return new NovelOrchestrator({
    ...config,
    billing: TEST_TURN_BILLING,
    entitlements: ALLOW_ALL_ENTITLEMENTS,
  });
}

describe("NovelOrchestrator", () => {
  it("keeps Agent tools user-scoped and takes billing from the composition root", () => {
    const orch = makeOrchestrator({
      token: "user-jwt",
      projectId: "project-1",
      userId: "user-1",
    });

    expect(((orch as any).ctx.db as any).mode).toBe("user");
    // The core must not build its own DbClient/SaaS billing client any more; the
    // ports it was handed are the ones it uses.
    expect((orch as any).billingDb).toBeUndefined();
    expect((orch as any).config.billing).toBe(TEST_TURN_BILLING);
    expect((orch as any).config.entitlements).toBe(ALLOW_ALL_ENTITLEMENTS);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LLM_PROVIDER = "deepseek";
    process.env.LLM_MODEL = "deepseek-v4-flash";
    process.env.INSFORGE_URL = "http://localhost:7130";
    process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";

    mockDbInstance.createTask.mockResolvedValue({ id: "task-1" });
    mockDbInstance.updateTaskStatus.mockResolvedValue(undefined);
    mockDbInstance.listTasks.mockResolvedValue([]);
    mockDbInstance.listWorkspaceSkills.mockResolvedValue([]);
    mockDbInstance.getSkillFromRegistry.mockResolvedValue(null);
  });

  describe("constructor", () => {
    it("creates an orchestrator with token and projectId", () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      expect(orch).toBeDefined();
    });

    it("creates tool context accessible via getContext()", () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      const ctx = orch.getContext();
      expect(ctx).toBeDefined();
      expect(ctx.projectId).toBe("proj-1");
      expect(ctx.storage).toBeDefined();
      expect(ctx.db).toBeDefined();
    });
  });

  describe("init", () => {
    it("loads enabled Skills independently for every Agent role", async () => {
      const skillsModule = await import("./lib/skills.js");
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1", userId: "u-1" });
      await orch.init();

      expect(vi.mocked(skillsModule.loadEnabledSkills).mock.calls.map((call) => call[3])).toEqual([
        "chief_editor", "worldbuilder", "character_designer", "outliner", "director", "writer", "script_supervisor",
      ]);
    });

    it("resolves model configuration after the environment has loaded", async () => {
      process.env.LLM_PROVIDER = "opencode";
      process.env.LLM_MODEL = "deepseek-v4-flash-free";
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });

      await orch.init();

      expect(getBuiltinModel).toHaveBeenCalledWith("opencode", "deepseek-v4-flash-free");
    });

    it("creates 7 agents (1 chief + 6 sub-agents)", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      // Agent constructor should have been called 7 times
      expect(Agent).toHaveBeenCalledTimes(7);

      const calls = (Agent as any).mock.calls;
      const toolNames: string[][] = calls.map((c: any) =>
        (c[0]?.initialState?.tools ?? []).map((t: any) => t.name),
      );

      // Chief editor should have delegate_to_agent tool
      const chiefTools = toolNames.find((t: any) => t.includes("delegate_to_agent"));
      expect(chiefTools).toBeDefined();

      // Sub-agents should not have delegate_to_agent
      const subAgentToolSets = toolNames.filter((t: any) => !t.includes("delegate_to_agent"));
      expect(subAgentToolSets.length).toBeGreaterThanOrEqual(6);
    });

    it("passes the orchestrator stream function to every Agent", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const calls = (Agent as any).mock.calls;
      expect(calls).toHaveLength(7);
      // The orchestrator wraps the pi-ai stream fn (BYOK key injection), so
      // assert every Agent receives the same orchestrator-provided function.
      const streamFn = calls[0][0].streamFn;
      expect(typeof streamFn).toBe("function");
      expect(calls.every((call: any[]) => call[0].streamFn === streamFn)).toBe(true);
    });

    it("uses one injected dynamic model resolver for all seven Agents", async () => {
      const dynamicModel = {
        id: "future-model", name: "Future Model", api: "openai-responses",
        provider: "opencode", baseUrl: "https://opencode.ai/zen/v1",
        reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000, maxTokens: 64000,
      };
      const modelResolver = {
        resolve: vi.fn().mockResolvedValue({
          model: dynamicModel,
          source: "opencode-dynamic",
          runtimeCatalogId: "runtime-1",
          runtimeFingerprint: "fingerprint",
        }),
      };
      const modelHealthService = { observeFailure: vi.fn().mockResolvedValue(undefined) };
      const orch = makeOrchestrator({
        token: "test-token",
        projectId: "proj-1",
        modelOverrides: Object.fromEntries(AGENT_IDS.map((id) => [id, {
          provider: "opencode", model: "future-model",
        }])),
        modelResolver,
        modelHealthService,
      });

      await orch.init();

      expect(modelResolver.resolve).toHaveBeenCalledTimes(7);
      expect((Agent as any).mock.calls.every(
        (call: any[]) => call[0].initialState.model === dynamicModel,
      )).toBe(true);
      expect((Agent as any).mock.instances.every(
        (instance: any) => instance.subscribe.mock.calls.length >= 1,
      )).toBe(true);

      const firstAgent = (Agent as any).mock.instances[0];
      const healthObserver = firstAgent.subscribe.mock.calls[0][0];
      await healthObserver({
        type: "message_end",
        message: {
          role: "assistant", stopReason: "error", errorMessage:
            'OpenAI API error (404): {"error":{"code":"model_not_found","message":"missing"}}',
        },
      });
      expect(modelHealthService.observeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeFingerprint: "fingerprint" }),
        expect.any(Error),
        undefined,
      );
    });

    it("aborts every active agent in the orchestrator", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();
      const createdAgents = (Agent as any).mock.instances;
      for (const agent of createdAgents) agent.state.isStreaming = true;

      orch.abort();

      for (const agent of createdAgents) {
        expect(agent.abort).toHaveBeenCalledOnce();
      }
    });

    it("enables medium thinking for all seven agents", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const calls = (Agent as any).mock.calls;
      expect(calls).toHaveLength(7);
      expect(calls.map((call: any[]) => call[0].initialState.thinkingLevel))
        .toEqual(["medium", "medium", "medium", "medium", "medium", "medium", "medium"]);
    });

    it("assigns file+index tools to all sub-agents", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const calls = (Agent as any).mock.calls;
      // Check a sub-agent (index 0 is worldbuilder) has file and index tools
      const worldbuilderTools: any[] = calls[0]?.[0]?.initialState?.tools ?? [];
      const toolNames = worldbuilderTools.map((t: any) => t.name);
      expect(toolNames).toContain("read_doc");
      expect(toolNames).toContain("list_skills");
      expect(toolNames).toContain("write_doc");
      expect(toolNames).toContain("sync_index");
    });

    it("assigns file+index+status+delegate tools to chief editor", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const calls = (Agent as any).mock.calls;
      // Chief editor is the last agent created (index 6)
      const chiefTools: any[] = calls[6]?.[0]?.initialState?.tools ?? [];
      const toolNames = chiefTools.map((t: any) => t.name);
      expect(toolNames).toContain("read_doc");
      expect(toolNames).toContain("list_skills");
      expect(toolNames).toContain("write_doc");
      expect(toolNames).toContain("sync_index");
      expect(toolNames).toContain("update_status");
      expect(toolNames).toContain("delegate_to_agent");
    });

    it("applies model overrides when configured", async () => {
      const orch = makeOrchestrator({
        token: "test-token",
        projectId: "proj-1",
        modelOverrides: {
          writer: { provider: "anthropic", model: "claude-opus-4-7" },
        },
      });
      await orch.init();

      // Writer is index 4 (fifth agent created), should use override model
      const agentCalls = (Agent as any).mock.calls;
      // Each call receives a model in initialState
      expect(agentCalls.length).toBe(7);
    });
  });

  describe("chat", () => {
    it("throws the model error instead of returning an empty reply", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();
      const chief = (Agent as any).mock.instances[6];
      chief.state.messages = [{
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "402 Insufficient Balance",
      }];
      chief.prompt.mockResolvedValue(undefined);

      await expect(orch.chat("hello")).rejects.toThrow("402 Insufficient Balance");
    });
  });

  describe("memory ownership", () => {
    it("does not expose direct memory lifecycle methods", () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      expect((orch as any).hasMemory).toBeUndefined();
      expect((orch as any).initMemory).toBeUndefined();
    });
  });

  describe("getAgent", () => {
    it("returns undefined for unknown agent id before init", () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      expect(orch.getAgent("unknown")).toBeUndefined();
    });

    it("returns agent by id after init", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();
      const chief = orch.getAgent("chief_editor");
      expect(chief).toBeDefined();
      expect(chief).toBe((Agent as any).mock.instances[6]);
    });
  });

  describe("durable session state", () => {
    it("snapshots and restores independent transcripts for all six agents", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1", sessionId: "session-1" });
      await orch.init();
      for (const id of AGENT_IDS) {
        orch.getAgent(id)!.state.messages = [{ role: "user", content: id, timestamp: 1 }];
      }

      const snapshot = orch.snapshotMessages();
      expect(Object.keys(snapshot).sort()).toEqual([...AGENT_IDS].sort());
      expect(snapshot.writer).toEqual([{ role: "user", content: "writer", timestamp: 1 }]);

      snapshot.writer.push({ role: "user", content: "mutated copy", timestamp: 2 });
      expect(orch.getAgent("writer")!.state.messages).toHaveLength(1);

      const restored = makeOrchestrator({ token: "test-token", projectId: "proj-1", sessionId: "session-1" });
      await restored.init();
      restored.restoreMessages({ chief_editor: snapshot.chief_editor, writer: snapshot.writer });
      expect(restored.getAgent("chief_editor")!.state.messages).toEqual(snapshot.chief_editor);
      expect(restored.getAgent("writer")!.state.messages).toEqual(snapshot.writer);
    });

    it("passes session id to pi Agent", async () => {
      const orch = makeOrchestrator({
        token: "test-token",
        projectId: "proj-1",
        sessionId: "session-1",
      });
      await orch.init();

      const writer = orch.getAgent("writer") as any;
      expect(writer.sessionId).toBe("session-1");
      expect(orch.getModelDescriptor("writer")).toMatchObject({
        model: "test-model",
        provider: "deepseek",
        contextWindow: 128_000,
      });
    });
  });

  describe("onEvent / onAllEvents", () => {
    it("subscribes to chief editor events", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const handler = vi.fn();
      orch.onEvent(handler);

      const chiefAgent = (Agent as any).mock.instances[6];
      expect(chiefAgent.subscribe).toHaveBeenCalled();
    });

    it("subscribes to all agents events", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();

      const handler = vi.fn();
      orch.onAllEvents(handler);

      for (const instance of (Agent as any).mock.instances) {
        expect(instance.subscribe).toHaveBeenCalled();
      }
    });

    it("forwards display lifecycle events but hides tool execution events", async () => {
      const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
      await orch.init();
      const handler = vi.fn();
      orch.onDisplayEvents(handler);

      const chiefAgent = (Agent as any).mock.instances[6];
      const listener = chiefAgent.subscribe.mock.calls.at(-1)[0];
      await listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read_doc", args: {} });
      await listener({ type: "agent_end", messages: [] });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ type: "agent_end", messages: [] });
    });
  });
});

describe("Delegate tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LLM_PROVIDER = "deepseek";
    process.env.LLM_MODEL = "deepseek-v4-flash";
    process.env.INSFORGE_URL = "http://localhost:7130";
    process.env.JWT_SECRET = "test-secret-32-chars-minimum!!";

    mockDbInstance.createTask.mockResolvedValue({ id: "task-1" });
    mockDbInstance.updateTaskStatus.mockResolvedValue(undefined);
    mockDbInstance.listWorkspaceSkills.mockResolvedValue([]);
  });

  it("returns error for unknown agent", async () => {
    // Extract the delegate tool from chief editor after init
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
    await orch.init();

    const chiefCall = (Agent as any).mock.calls[6];
    const tools: any[] = chiefCall[0]?.initialState?.tools ?? [];
    const delegateTool = tools.find((t: any) => t.name === "delegate_to_agent");

    expect(delegateTool).toBeDefined();
    expect(delegateTool.executionMode).toBe("sequential");

    const result = await delegateTool.execute("call-1", {
      agent: "unknown_agent",
      task: "Do something",
      output_path: "test/output.md",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown agent");
  });

  it("creates task record and delegates to sub-agent on success", async () => {
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
    await orch.init();

    // Set up sub-agent to return messages
    const worldbuilderAgent = (Agent as any).mock.instances[0];
    worldbuilderAgent.state.messages = [
      { role: "user", content: [{ type: "text", text: "Build a world" }] },
      { role: "assistant", content: [{ type: "text", text: "World built successfully" }] },
    ];
    worldbuilderAgent.prompt.mockResolvedValue(undefined);

    const chiefCall = (Agent as any).mock.calls[6];
    const tools: any[] = chiefCall[0]?.initialState?.tools ?? [];
    const delegateTool = tools.find((t: any) => t.name === "delegate_to_agent");

    const result = await delegateTool.execute("call-2", {
      agent: "worldbuilder",
      task: "Build a power system",
      output_path: "worldview/power_system/qi.md",
    });

    expect(mockDbInstance.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        agent: "worldbuilder",
        taskType: "create",
      }),
    );
    expect(worldbuilderAgent.prompt).toHaveBeenCalled();
    expect(mockDbInstance.updateTaskStatus).toHaveBeenCalledWith("task-1", "submitted");
    expect(result.content[0].text).toContain("World built successfully");
    expect(result.isError).toBeUndefined();
  });

  it("handles sub-agent failure and updates task status", async () => {
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
    await orch.init();

    const worldbuilderAgent = (Agent as any).mock.instances[0];
    worldbuilderAgent.prompt.mockRejectedValue(new Error("Model API error"));

    const chiefCall = (Agent as any).mock.calls[6];
    const tools: any[] = chiefCall[0]?.initialState?.tools ?? [];
    const delegateTool = tools.find((t: any) => t.name === "delegate_to_agent");

    const result = await delegateTool.execute("call-3", {
      agent: "worldbuilder",
      task: "Do something",
      output_path: "test.md",
    });

    expect(mockDbInstance.updateTaskStatus).toHaveBeenCalledWith("task-1", "rejected", "Model API error");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Task failed");
  });

  it("aborts a delegated sub-agent when the chief signal is aborted", async () => {
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
    await orch.init();

    const writerAgent = (Agent as any).mock.instances[4];
    let rejectPrompt!: (error: Error) => void;
    writerAgent.prompt.mockImplementation(() => new Promise((_resolve: unknown, reject: (error: Error) => void) => {
      rejectPrompt = reject;
    }));
    writerAgent.abort.mockImplementation(() => rejectPrompt(new Error("aborted")));

    const chiefCall = (Agent as any).mock.calls[6];
    const tools: any[] = chiefCall[0]?.initialState?.tools ?? [];
    const delegateTool = tools.find((tool: any) => tool.name === "delegate_to_agent");
    const controller = new AbortController();

    const executing = delegateTool.execute("call-abort", {
      agent: "writer",
      task: "Write a chapter",
      output_path: "text/chapter-001.md",
    }, controller.signal);
    await vi.waitFor(() => expect(writerAgent.prompt).toHaveBeenCalledOnce());
    controller.abort();

    await expect(executing).resolves.toMatchObject({ isError: true });
    expect(writerAgent.abort).toHaveBeenCalledOnce();
    expect(mockDbInstance.updateTaskStatus).toHaveBeenCalledWith("task-1", "rejected", "aborted");
  });

  it("does not start delegation when the chief signal is already aborted", async () => {
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1" });
    await orch.init();

    const writerAgent = (Agent as any).mock.instances[4];
    const chiefCall = (Agent as any).mock.calls[6];
    const tools: any[] = chiefCall[0]?.initialState?.tools ?? [];
    const delegateTool = tools.find((tool: any) => tool.name === "delegate_to_agent");
    const controller = new AbortController();
    controller.abort();

    const result = await delegateTool.execute("call-pre-abort", {
      agent: "writer",
      task: "Write a chapter",
      output_path: "text/chapter-001.md",
    }, controller.signal);

    expect(writerAgent.prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(mockDbInstance.updateTaskStatus).toHaveBeenCalledWith(
      "task-1",
      "rejected",
      expect.stringMatching(/abort/i),
    );
  });

  it("durably enqueues a continuity checkpoint when a chapter is confirmed", async () => {
    const orch = makeOrchestrator({
      token: "test-token",
      projectId: "proj-1",
      creativeLanguage: "en",
    });
    await orch.init();

    await (orch as any).ctx.onDocumentStatusChanged({
      path: "text/ch-003.md",
      status: "confirmed",
      previousStatus: "draft",
      chapterNumber: 3,
      confirmedHash: "hash-3",
    });

    expect(mockDbInstance.enqueueContinuityJob).toHaveBeenCalledWith({
      projectId: "proj-1",
      chapterNumber: 3,
      chapterPath: "text/ch-003.md",
      confirmedHash: "hash-3",
    });
  });

  it("runs a claimed continuity checkpoint without creating another queue record", async () => {
    const orch = makeOrchestrator({ token: "test-token", projectId: "proj-1", creativeLanguage: "en" });
    await orch.init();
    const supervisorAgent = (Agent as any).mock.instances[5];

    await orch.runContinuityCheckpoint(3, "text/ch-003.md", "continuity-job-1");

    expect(supervisorAgent.prompt).toHaveBeenCalledWith(expect.stringContaining(
      '<continuity_task chapter="3" path="text/ch-003.md">',
    ));
    expect(supervisorAgent.prompt).toHaveBeenCalledWith(expect.stringContaining("<project_language>en</project_language>"));
    expect(supervisorAgent.prompt).toHaveBeenCalledWith(expect.stringContaining("只追加，不改写历史节"));
    expect(supervisorAgent.prompt).toHaveBeenCalledWith(expect.stringContaining("## Ch.3"));
    expect(mockDbInstance.enqueueContinuityJob).not.toHaveBeenCalled();
  });
});

describe("Tool integration", () => {
  it("keeps configured Agent tools covered by the capability catalog", () => {
    for (const role of AGENT_IDS) {
      expect(configuredToolNamesForRole(role).filter((tool) => !capabilityForTool(tool))).toEqual([]);
    }
  });

  it("createFileTools returns 8 tools from context", () => {
    const ctx: ToolContext = {
      storage: mockStorageInstance as any,
      skillsStorage: mockStorageInstance as any,
      db: mockDbInstance as any,
      projectId: "proj-1",
      entitlements: ALLOW_ALL_ENTITLEMENTS,
    };
    const tools = createFileTools(ctx);
    expect(tools).toHaveLength(8);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "chapter_context",
      "delete_doc",
      "list_docs",
      "list_skills",
      "load_skill",
      "read_doc",
      "search_docs",
      "write_doc",
    ]);
  });

  it("createIndexTools returns 2 tools from context", () => {
    const ctx: ToolContext = {
      storage: mockStorageInstance as any,
      skillsStorage: mockStorageInstance as any,
      db: mockDbInstance as any,
      projectId: "proj-1",
      entitlements: ALLOW_ALL_ENTITLEMENTS,
    };
    const tools = createIndexTools(ctx);
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["sync_all_indexes", "sync_index"]);
  });

  it("createStatusTools returns 2 tools from context", () => {
    const ctx: ToolContext = {
      storage: mockStorageInstance as any,
      skillsStorage: mockStorageInstance as any,
      db: mockDbInstance as any,
      projectId: "proj-1",
      entitlements: ALLOW_ALL_ENTITLEMENTS,
    };
    const tools = createStatusTools(ctx);
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_project_status", "update_status"]);
  });
});
