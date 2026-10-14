import { describe, expect, it } from "vitest";
import { runJudge } from "./judge.ts";
import type { ChatCompleteInput } from "./llm.ts";
import { chatComplete } from "./llm.ts";

const CFG = { judgeBaseUrl: "http://judge.local", judgeModel: "judge-x", judgeApiKey: "sk-test" };

function llmReturning(content: string) {
  return async (_input: ChatCompleteInput) => content;
}

function llmRecording(record: Array<ChatCompleteInput>, content: string) {
  return async (input: ChatCompleteInput) => {
    record.push(input);
    return content;
  };
}

const GOOD = JSON.stringify({
  items: [
    { criterion: "ai_flavor", score: 8, evidence: "他攥紧了拳头" },
    { criterion: "dialogue", score: 7, evidence: "“你少管。”" },
    { criterion: "detail_showing", score: 9, evidence: "茶杯碎了一地" },
  ],
});

describe("runJudge", () => {
  it("parses a good judge response and clamps scores", async () => {
    const recorded: Array<ChatCompleteInput> = [];
    const result = await runJudge(
      llmRecording(recorded, GOOD),
      CFG,
      "prose_flavor",
      "章节正文……",
    );
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({ criterion: "ai_flavor", score: 8, evidence: "他攥紧了拳头" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.model).toBe("judge-x");
    expect(recorded[0]?.system).toContain("JSON");
    expect(recorded[0]?.user).toContain("ai_flavor");
  });

  it("extracts JSON from surrounding prose", async () => {
    const result = await runJudge(llmReturning(`评审如下：${GOOD} 以上。`), CFG, "prose_flavor", "正文");
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(3);
  });

  it("retries once on unparsable output, then succeeds", async () => {
    const calls: string[] = [];
    const llm = async (input: ChatCompleteInput) => {
      calls.push(input.user);
      return calls.length === 1 ? "我不会输出 JSON" : GOOD;
    };
    const result = await runJudge(llm, CFG, "prose_flavor", "正文");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("再次提醒");
  });

  it("returns ok:false with note after two failures", async () => {
    const result = await runJudge(llmReturning("还是不输出"), CFG, "prose_flavor", "正文");
    expect(result.ok).toBe(false);
    expect(result.note).toBeTruthy();
  });

  it("propagates transport errors into ok:false", async () => {
    const llm = async () => {
      throw new Error("judge LLM 500: exploded");
    };
    const result = await runJudge(llm, CFG, "prose_flavor", "正文");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("500");
  });

  it("caps scores into 0-10", async () => {
    const result = await runJudge(
      llmReturning(JSON.stringify({ items: [{ criterion: "goal", score: 42, evidence: "x" }] })),
      CFG,
      "design_outline",
      "章卡",
    );
    expect(result.ok).toBe(true);
    expect(result.items[0]?.score).toBe(10);
  });
});

describe("chatComplete", () => {
  it("posts an OpenAI-compatible request and unwraps the choice", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await chatComplete({
      baseUrl: "http://judge.local/v1/",
      apiKey: "sk",
      model: "m1",
      system: "sys",
      user: "usr",
      fetchImpl: fakeFetch,
    });
    expect(text).toBe("ok");
    const cap = captured as { url: string; init: RequestInit };
    expect(cap.url).toBe("http://judge.local/v1/chat/completions");
    const body = JSON.parse(String(cap.init.body)) as { messages: Array<{ role: string }>; temperature: number };
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.temperature).toBe(0);
  });

  it("throws on non-ok responses", async () => {
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(
      chatComplete({ baseUrl: "http://x", apiKey: "sk", model: "m", system: "s", user: "u", fetchImpl: fakeFetch }),
    ).rejects.toThrow(/500/);
  });
});
