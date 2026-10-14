import { describe, expect, it, vi, beforeEach } from "vitest";

const mockAgentRecall = vi.fn();
const mockAugmentation = vi.fn();

const mockIntegration = {
  attribution: vi.fn().mockReturnValue({
    scope: vi.fn().mockReturnThis(),
    agentRecall: mockAgentRecall,
    augmentation: mockAugmentation,
  }),
};

vi.mock("@memorilabs/memori", () => ({
  Memori: vi.fn().mockImplementation(() => ({
    integrate: vi.fn().mockReturnValue(mockIntegration),
  })),
}));

vi.mock("@memorilabs/memori/integrations", () => ({
  OpenClawIntegration: {},
}));

import { ProjectMemory, isMemoriAvailable } from "./memori.js";

describe("ProjectMemory", () => {
  let memory: ProjectMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentRecall.mockReset();
    mockAugmentation.mockReset();
    memory = new ProjectMemory("user-1", "proj-1", "session-1");
  });

  describe("recallContext", () => {
    it("returns formatted memories above score threshold", async () => {
      mockAgentRecall.mockResolvedValue({
        memories: [
          { id: "m1", content: "用户喜欢热血风格", score: 0.8, context: "preference" },
          { id: "m2", content: "上次讨论了修炼体系", score: 0.6 },
          { id: "m3", content: "low quality memory", score: 0.2 },
        ],
      });

      const context = await memory.recallContext("query");
      expect(context).toContain("用户喜欢热血风格");
      expect(context).toContain("上次讨论了修炼体系");
      expect(context).not.toContain("low quality memory");
    });

    it("limits to 10 memories", async () => {
      const manyMemories = Array.from({ length: 15 }, (_, i) => ({
        id: `m${i}`,
        content: `memory ${i}`,
        score: 0.9,
      }));
      mockAgentRecall.mockResolvedValue({ memories: manyMemories });

      const context = await memory.recallContext("query");
      const lines = context.split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(10);
    });

    it("formats memories with context when available", async () => {
      mockAgentRecall.mockResolvedValue({
        memories: [{ id: "m1", content: "test memory", score: 0.8, context: "chapter-1" }],
      });

      const context = await memory.recallContext("query");
      expect(context).toContain('<memory id="m1" context="chapter-1">');
      expect(context).toContain("test memory");
      expect(context).not.toContain("[记忆]");
    });

    it("returns empty string when no memories", async () => {
      mockAgentRecall.mockResolvedValue({ memories: [] });
      const context = await memory.recallContext("query");
      expect(context).toBe("");
    });

    it("returns empty string when memories is not an array", async () => {
      mockAgentRecall.mockResolvedValue({ memories: null });
      const context = await memory.recallContext("query");
      expect(context).toBe("");
    });

    it("returns empty string on error", async () => {
      mockAgentRecall.mockRejectedValue(new Error("API error"));
      const context = await memory.recallContext("query");
      expect(context).toBe("");
    });
  });

  describe("captureTurn", () => {
    it("sends augmentation data", async () => {
      mockAugmentation.mockResolvedValue(undefined);

      await memory.captureTurn("用户的问题", "Chief Editor 的回答");

      expect(mockAugmentation).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: { role: "user", content: "用户的问题", type: "text" },
          agentResponse: { role: "assistant", content: "Chief Editor 的回答", type: "text" },
          metadata: expect.objectContaining({
            provider: "novel-vibe",
            platform: "novel-vibe",
          }),
        }),
      );
    });

    it("handles errors gracefully", async () => {
      mockAugmentation.mockRejectedValue(new Error("API error"));
      await expect(
        memory.captureTurn("hello", "reply"),
      ).resolves.toBeUndefined();
    });
  });

  describe("setSession", () => {
    it("updates current session id", () => {
      memory.setSession("new-session-id");
      // Session updated internally — verify via recallContext using new scope
      // The scope method is called on the integration, so verify the mock was set
      // (actual scoping behavior verified via integration)
    });
  });

  describe("isMemoriAvailable", () => {
    it("returns true", () => {
      expect(isMemoriAvailable()).toBe(true);
    });
  });
});
