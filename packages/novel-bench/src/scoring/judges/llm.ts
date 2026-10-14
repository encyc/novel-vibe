export interface ChatCompleteInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

/** Minimal OpenAI-compatible chat completion call (used for judges only). */
export async function chatComplete(input: ChatCompleteInput): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: input.temperature ?? 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`judge LLM ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("judge LLM returned empty content");
  }
  return content;
}
