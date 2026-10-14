import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  estimateTranscriptTokens,
  selectCompactionWindow,
  SessionCompactor,
  type SequencedMessage,
} from "./compactor.js";
import type { ModelDescriptor } from "./types.js";
import { ContextCompactor } from "../context/compactor.js";
import { ContextManager } from "../context/manager.js";
import { MessageRestorer } from "../context/message-restorer.js";

const model: ModelDescriptor = {
  api: "openai-completions",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  contextWindow: 100,
};

const pricingQuote = {
  version: 1 as const, requestStartedAt: "2026-08-17T05:59:59.000Z",
  modelId: model.model, modelProvider: model.provider, creditRateId: "rate-1",
  creditRateWindowId: null, pricingPeriod: "off_peak", billingMultiplier: 2,
  inputRate: 1, outputRate: 2, cacheReadRate: 0.1, cacheWriteRate: 0.5,
};

function compactionBilling() {
  return {
    createPricingQuote: vi.fn().mockResolvedValue(pricingQuote),
    recordCompactionUsage: vi.fn().mockResolvedValue(undefined),
  };
}

function usage(output: number) {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(content: string): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistant(outputTokens: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "答" }],
    api: model.api,
    provider: model.provider,
    model: model.model,
    usage: usage(outputTokens),
    stopReason: "stop",
    timestamp: 2,
  };
}

function transcript(outputs: number[]): SequencedMessage[] {
  return outputs.flatMap((output, index) => [
    { sequence: index * 2 + 1, turnId: `turn-${index + 1}`, message: user("问") },
    { sequence: index * 2 + 2, turnId: `turn-${index + 1}`, message: assistant(output) },
  ]);
}

describe("compaction selection", () => {
  it("uses provider output usage and falls back to a conservative character estimate", () => {
    expect(estimateTranscriptTokens([assistant(20), user("12345678")])).toBe(24);
  });

  it("does nothing below 70% of the context window", () => {
    expect(selectCompactionWindow(transcript([20, 20]), 100)).toBeNull();
  });

  it("triggers exactly at 70% of the context window", () => {
    const selected = selectCompactionWindow(transcript([34, 34]), 100);
    expect(selected?.compact.map((entry) => entry.turnId)).toEqual(["turn-1", "turn-1"]);
  });

  it("compacts at 70% and retains at least 25% without splitting turns", () => {
    const selected = selectCompactionWindow(transcript([23, 23, 23]), 100);

    expect(selected?.compact.map((entry) => entry.turnId)).toEqual(["turn-1", "turn-1"]);
    expect(selected?.retain.map((entry) => entry.turnId)).toEqual([
      "turn-2", "turn-2", "turn-3", "turn-3",
    ]);
    expect(selected?.throughSequence).toBe(2);
  });

  it("keeps an assistant tool call and tool result in the same retained turn", () => {
    const rows = transcript([24, 24]);
    rows.push({
      sequence: 5,
      turnId: "turn-tools",
      message: {
        ...assistant(25),
        content: [{ type: "toolCall", id: "call-1", name: "read_doc", arguments: { path: "a.md" } }],
      },
    });
    rows.push({
      sequence: 6,
      turnId: "turn-tools",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_doc",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 3,
      },
    });

    const selected = selectCompactionWindow(rows, 100);
    expect(selected?.retain.map((entry) => entry.sequence)).toEqual(expect.arrayContaining([5, 6]));
  });
});

describe("SessionCompactor", () => {
  function setup(generate = vi.fn().mockResolvedValue({
    summary: "结构化摘要", usage: usage(12), requestStartedAt: "2026-08-17T05:59:59.000Z",
  })) {
    const repository = { saveAgentSummary: vi.fn().mockResolvedValue(undefined) };
    const billing = compactionBilling();
    const compactor = new SessionCompactor({
      repository, billing, generate, now: () => new Date("2026-08-17T05:59:59Z"),
    });
    return { compactor, repository, billing, generate };
  }

  it("bills actual usage and persists summary with its boundary", async () => {
    const { compactor, repository, billing, generate } = setup();

    const result = await compactor.compactIfNeeded({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([23, 23, 23]),
    });

    expect(result.status).toBe("compacted");
    expect(billing.createPricingQuote).toHaveBeenCalledWith(expect.objectContaining({
      requestStartedAt: new Date("2026-08-17T05:59:59Z"),
    }));
    expect(vi.mocked(billing.createPricingQuote).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(generate).mock.invocationCallOrder[0]);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("未解决问题"),
    }));
    expect(billing.recordCompactionUsage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      quote: pricingQuote,
      usage: usage(12),
    }));
    expect(repository.saveAgentSummary).toHaveBeenCalledWith("s1", "writer", "结构化摘要", 2);
    expect(vi.mocked(billing.recordCompactionUsage).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(repository.saveAgentSummary).mock.invocationCallOrder[0]);
  });

  it("returns degraded after a failure below the hard limit", async () => {
    const { compactor, repository } = setup(vi.fn().mockRejectedValue(new Error("offline")));

    await expect(compactor.compactIfNeeded({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([23, 23, 23]),
    })).resolves.toMatchObject({ status: "degraded" });
    expect(repository.saveAgentSummary).not.toHaveBeenCalled();
  });

  it("throws a retryable domain error after compaction fails at the 90% hard limit", async () => {
    const { compactor } = setup(vi.fn().mockRejectedValue(new Error("offline")));

    await expect(compactor.compactIfNeeded({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([30, 30, 30]),
    })).rejects.toMatchObject({ code: "SESSION_COMPACTION_REQUIRED", status: 503 });
  });

  it("throws at the hard limit when no atomic compaction boundary exists", async () => {
    const { compactor, generate } = setup();

    await expect(compactor.compactIfNeeded({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([95]),
    })).rejects.toMatchObject({ code: "SESSION_COMPACTION_REQUIRED", status: 503 });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("creative-language compaction", () => {
  it("injects the English project-language contract into summary generation", async () => {
    const generate = vi.fn().mockResolvedValue({
      summary: "Structured summary", usage: usage(12), requestStartedAt: "2026-08-17T05:59:59.000Z",
    });
    const compactor = new ContextCompactor({
      repository: { saveAgentSummary: vi.fn().mockResolvedValue(undefined) },
      billing: compactionBilling(),
      generate,
      creativeLanguage: "en",
    });

    await compactor.compact({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([23, 23, 23]),
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("<project_language>en</project_language>"),
    }));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Write the summary in English."),
    }));
  });

  it("explicitly requests a Chinese summary for Chinese projects", async () => {
    const generate = vi.fn().mockResolvedValue({
      summary: "结构化摘要", usage: usage(12), requestStartedAt: "2026-08-17T05:59:59.000Z",
    });
    const compactor = new ContextCompactor({
      repository: { saveAgentSummary: vi.fn().mockResolvedValue(undefined) },
      billing: compactionBilling(),
      generate,
      creativeLanguage: "zh-CN",
    });

    await compactor.compact({
      sessionId: "s1",
      projectId: "p1",
      userId: "u1",
      agentId: "writer",
      model,
      messages: transcript([23, 23, 23]),
    });

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("请使用简体中文撰写摘要。"),
    }));
  });

  it("emits the stable summary marker and filters both new and legacy markers", async () => {
    const manager = new ContextManager({
      token: "token",
      projectId: "p1",
      userId: "u1",
      creativeLanguage: "en",
      repository: {
        loadAgentContext: vi.fn(),
        saveAgentSummary: vi.fn(),
      },
      promptLoader: async () => "BASE",
      skillLoader: async () => "",
      modelDescriptors: { writer: model },
      summaryGenerator: vi.fn(),
      billing: compactionBilling(),
    });
    vi.spyOn(manager.compactor, "compact").mockImplementation(async (input) => ({
      status: "compacted",
      messages: input.messages,
      summary: "summary",
      throughSequence: 1,
    }));
    const transform = manager.asCallback("writer", "s1");

    const result = await transform([
      user("[SESSION_SUMMARY]\nnew"),
      user("[会话摘要]\nlegacy"),
      user("keep"),
    ]);

    expect(manager.compactor.compact).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ message: expect.objectContaining({ content: "keep" }) })],
    }));
    expect(result[0]).toMatchObject({ role: "user", content: "[SESSION_SUMMARY]\nsummary" });
  });

  it("restores summaries with the new marker without changing stored messages", async () => {
    const stored = user("已有中文正文，不应翻译");
    const restorer = new MessageRestorer({
      loadAgentContext: vi.fn().mockResolvedValue({
        summary: "summary",
        messages: [{
          sequence: 7,
          turnId: "turn-7",
          agentId: "writer",
          message: stored,
        }],
      }),
      saveAgentSummary: vi.fn(),
    });

    const result = await restorer.restore("writer", "s1", model);

    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: "[SESSION_SUMMARY]\nsummary",
    });
    expect(result.messages[1]).toBe(stored);
    expect(result.sequenced[0]?.message).toBe(stored);
  });
});
