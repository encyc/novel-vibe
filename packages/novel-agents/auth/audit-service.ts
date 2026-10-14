import type { DbClient } from "../lib/db.js";

export interface AuditEventInput {
  userId: string;
  tokenId: string;
  operation: string;
  status: "accepted" | "complete" | "failed";
  projectId?: string;
  sessionId?: string;
  turnId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export class AuditService {
  constructor(private readonly db: DbClient, private readonly postgrestUrl = process.env.POSTGREST_URL ?? "http://localhost:5430") {}

  async record(input: AuditEventInput): Promise<void> {
    const response = await fetch(`${this.postgrestUrl}/api_audit_events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.db.pgToken}`,
        "Content-Type": "application/json",
        "Content-Profile": "novel",
      },
      body: JSON.stringify({
        user_id: input.userId,
        token_id: input.tokenId,
        operation: input.operation,
        status: input.status,
        project_id: input.projectId,
        session_id: input.sessionId,
        turn_id: input.turnId,
        metadata: input.metadata ?? {},
      }),
    });
    if (!response.ok) throw new Error(`Audit insert failed (${response.status})`);
  }
}
