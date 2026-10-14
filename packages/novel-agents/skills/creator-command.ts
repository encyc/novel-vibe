export type OfficialChatCommand = { type: "skill-creator" } | { type: "lingqi" };

export function parseChatCommand(body: unknown): OfficialChatCommand | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const command = (body as Record<string, unknown>).command;
  if (command === "skill-creator") return { type: "skill-creator" };
  if (command === "lingqi") return { type: "lingqi" };
  return null;
}

export function buildSkillCreatorPrompt(userMessage?: string): string {
  return `[official_command name="skill-creator"]
Load the official built-in skill with load_skill using slug "skill-creator" and follow it exactly.
Guide the user toward a single-file Skill draft. Send every result through the review and confirmation workflow.
${userMessage?.trim() ? `Initial request: ${userMessage.trim()}` : "Begin by asking what the Skill should accomplish."}`;
}
