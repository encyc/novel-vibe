import type { ChatSession } from "../types";

export function sessionDisplayTitle(session: ChatSession, defaultTitle: string): string {
  if (session.titleIsCustom === false && session.messageCount === 0) {
    return defaultTitle;
  }
  return session.title;
}
