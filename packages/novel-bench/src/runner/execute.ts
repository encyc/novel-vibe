import { countWords } from "../../../novel-agents/lib/frontmatter.ts";
import type { BenchCase, CaseExecution, CollectedDoc, TurnOutcome, TurnRecord } from "../types.ts";
import type { BffClient } from "./bff-client.ts";
import { runChatTurn } from "./chat-stream.ts";
import { setupSandbox } from "./sandbox.ts";

export interface ExecuteDeps {
  client: BffClient;
  provider?: string;
  model?: string;
  turnTimeoutMs: number;
  stallTimeoutMs?: number;
  expectPollIntervalMs?: number;
  expectTimeoutMs?: number;
}

function sumTokens(days: Array<{ totalTokens: number }>): number {
  return days.reduce((acc, day) => acc + (Number.isFinite(day.totalTokens) ? day.totalTokens : 0), 0);
}

async function creditsSnapshot(client: BffClient): Promise<number> {
  try {
    return sumTokens(await client.creditsActivity());
  } catch {
    return 0;
  }
}

async function checkExpect(
  client: BffClient,
  projectId: string,
  expect: NonNullable<BenchCase["script"][number]["expect"]>,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no documents seen";
  while (Date.now() <= deadline) {
    const rows = await client.listDocuments(projectId, expect.docType);
    if (expect.path) {
      const hit = rows.find((row) => row.doc_path === expect.path);
      if (hit) {
        return { ok: true, detail: `found ${hit.doc_path}` };
      }
      lastDetail = `path ${expect.path} not present (${rows.length} docs of type ${expect.docType ?? "*"})`;
    } else {
      const min = expect.minCount ?? 1;
      if (rows.length >= min) {
        return { ok: true, detail: `${rows.length} docs of type ${expect.docType} (min ${min})` };
      }
      lastDetail = `${rows.length} docs of type ${expect.docType}, need >= ${min}`;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { ok: false, detail: `timeout: ${lastDetail}` };
}

async function collectDocs(client: BffClient, projectId: string): Promise<CollectedDoc[]> {
  const rows = await client.listDocuments(projectId);
  const docs: CollectedDoc[] = [];
  for (const row of rows) {
    try {
      const content = await client.readDocument(projectId, row.doc_path);
      docs.push({
        path: row.doc_path,
        type: row.doc_type,
        content,
        wordCount: countWords(content),
      });
    } catch {
      // unreadable document: leave it out of scoring rather than failing the case
    }
  }
  return docs;
}

/**
 * Execute one bench case end to end: sandbox → scripted chat turns (with
 * expect assertions) → document collection → cost deltas. One failing turn
 * or failed expectation stops the case (later steps depend on it) but the
 * run continues with the next case.
 */
export async function executeCase(deps: ExecuteDeps, runId: string, benchCase: BenchCase, casesDir: string): Promise<CaseExecution> {
  const pollIntervalMs = deps.expectPollIntervalMs ?? 3_000;
  const expectTimeoutMs = deps.expectTimeoutMs ?? 180_000;
  const execution: CaseExecution = {
    caseId: benchCase.id,
    status: "failed",
    turns: [],
    docs: [],
    cost: { tokensBefore: 0, tokensAfter: 0, wallMs: 0 },
  };
  const wallStart = Date.now();
  const tokensBefore = await creditsSnapshot(deps.client);
  try {
    const sandbox = await setupSandbox(deps, runId, benchCase, casesDir, (projectId) => {
      execution.projectId = projectId;
    });
    execution.sessionId = sandbox.sessionId;
    let stepFailure: string | undefined;
    for (const [index, step] of benchCase.script.entries()) {
      const outcome: TurnOutcome = await runChatTurn(deps.client, {
        projectId: sandbox.projectId,
        sessionId: sandbox.sessionId,
        message: step.text,
        provider: deps.provider,
        model: deps.model,
        timeoutMs: deps.turnTimeoutMs,
        stallTimeoutMs: deps.stallTimeoutMs,
      });
      const record: TurnRecord = { step: index, outcome };
      if (outcome.kind === "failed") {
        execution.turns.push(record);
        stepFailure = `turn ${index} failed: ${outcome.reason}`;
        break;
      }
      if (step.expect) {
        record.expect = await checkExpect(deps.client, sandbox.projectId, step.expect, pollIntervalMs, expectTimeoutMs);
        if (!record.expect.ok) {
          execution.turns.push(record);
          stepFailure = `step ${index} expectation unmet: ${record.expect.detail}`;
          break;
        }
      }
      execution.turns.push(record);
    }
    // Whatever happened above, score what was produced: partial cases keep
    // their collected documents so judges/deterministic scorers see them.
    execution.docs = await collectDocs(deps.client, sandbox.projectId);
    if (stepFailure) {
      execution.error = stepFailure;
      execution.status = execution.turns.some((t) => t.outcome.kind === "complete") ? "partial" : "failed";
    } else {
      execution.status = "complete";
    }
    return execution;
  } catch (err) {
    execution.error = String(err instanceof Error ? err.message : err);
    execution.status = execution.turns.some((t) => t.outcome.kind === "complete") ? "partial" : "failed";
    if (execution.projectId && execution.docs.length === 0) {
      execution.docs = await collectDocs(deps.client, execution.projectId).catch(() => []);
    }
    return execution;
  } finally {
    execution.cost = {
      tokensBefore,
      tokensAfter: await creditsSnapshot(deps.client),
      wallMs: Date.now() - wallStart,
    };
  }
}
