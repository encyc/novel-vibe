import { describe, expect, it, vi } from "vitest";
import { createConfiguredReviewGenerator, reviewSkill, type ReviewGenerator } from "./reviewer.js";

const content = `---
name: Research
description: Research story background with available platform tools.
---
# Research

Search for relevant background, compare sources, and summarize findings.`;

const input = {
  slug: "research",
  content,
  roles: ["chief_editor"] as const,
  deterministicIssues: [],
};

function response(value: unknown): ReviewGenerator {
  return vi.fn().mockResolvedValue(JSON.stringify(value));
}

describe("reviewSkill", () => {
  it("uses the shared resolver result for configured semantic review", async () => {
    const model = { id: "future-model" };
    const modelResolver = {
      resolve: vi.fn().mockResolvedValue({ model, source: "opencode-dynamic" }),
    };
    const completeModel = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "reviewed" }],
    });
    const modelHealthService = { observeFailure: vi.fn() };
    const generator = createConfiguredReviewGenerator({
      modelResolver: modelResolver as never,
      completeModel: completeModel as never,
      modelHealthService: modelHealthService as never,
    });

    await expect(generator({ systemPrompt: "system", userPrompt: "user" })).resolves.toBe("reviewed");
    expect(modelResolver.resolve).toHaveBeenCalledOnce();
    expect(completeModel).toHaveBeenCalledWith(model, expect.any(Object));
  });

  it("accepts schema-valid approval", async () => {
    const result = await reviewSkill(input, response({
      verdict: "approved", findings: [], requiredCapabilities: ["documents.search"], recommendedRoles: ["chief_editor"],
    }));

    expect(result).toMatchObject({ verdict: "approved", attempts: 1, candidateContent: content });
  });

  it("fails closed on invalid JSON, unknown fields, and unknown capabilities", async () => {
    const invalidJson = await reviewSkill(input, vi.fn().mockResolvedValue("not json"));
    expect(invalidJson.verdict).toBe("failed");

    const unknownField = await reviewSkill(input, response({
      verdict: "approved", findings: [], requiredCapabilities: [], recommendedRoles: [], surprise: true,
    }));
    expect(unknownField.verdict).toBe("failed");

    const unknownCapability = await reviewSkill(input, response({
      verdict: "approved", findings: [], requiredCapabilities: ["web.crawl"], recommendedRoles: ["chief_editor"],
    }));
    expect(unknownCapability).toMatchObject({ verdict: "failed", failureMessage: expect.stringContaining("capability") });
  });

  it("fails closed when generation throws", async () => {
    const result = await reviewSkill(input, vi.fn().mockRejectedValue(new Error("timeout")));
    expect(result).toMatchObject({ verdict: "failed", failureMessage: "timeout" });
  });

  it("validates a revision once and preserves revision_required for user confirmation", async () => {
    const revised = content.replace("Search for relevant background", "Search existing project documents");
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        verdict: "revision_required",
        findings: [{ code: "TOOL_ADAPTATION", severity: "warning", message: "Use project search." }],
        requiredCapabilities: ["documents.search"], recommendedRoles: ["chief_editor"], revisedContent: revised,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        verdict: "approved", findings: [], requiredCapabilities: ["documents.search"], recommendedRoles: ["chief_editor"],
      }));

    const result = await reviewSkill(input, generate);
    expect(result).toMatchObject({ verdict: "revision_required", attempts: 2, candidateContent: revised });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("rejects revisions that violate deterministic policy or change frontmatter identity", async () => {
    const unsafe = content.replace("Search for relevant background", "Write a Python script");
    const unsafeResult = await reviewSkill(input, response({
      verdict: "revision_required", findings: [], requiredCapabilities: [], recommendedRoles: ["chief_editor"], revisedContent: unsafe,
    }));
    expect(unsafeResult.verdict).toBe("failed");

    const renamed = content.replace("name: Research", "name: Other");
    const renamedResult = await reviewSkill(input, response({
      verdict: "revision_required", findings: [], requiredCapabilities: [], recommendedRoles: ["chief_editor"], revisedContent: renamed,
    }));
    expect(renamedResult).toMatchObject({ verdict: "failed", failureMessage: expect.stringContaining("frontmatter") });
  });

  it("bounds review to one revision", async () => {
    const generate = response({
      verdict: "revision_required", findings: [], requiredCapabilities: [], recommendedRoles: ["chief_editor"], revisedContent: content,
    });
    const result = await reviewSkill(input, generate);
    expect(result).toMatchObject({ verdict: "failed", attempts: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
