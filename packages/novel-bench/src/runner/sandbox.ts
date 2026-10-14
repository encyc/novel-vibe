import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BenchCase } from "../types.ts";
import type { BffClient } from "./bff-client.ts";

export interface Sandbox {
  projectId: string;
  sessionId: string;
}

/** Create an isolated project + session for one case, preloading its setup documents. */
export async function setupSandbox(
  deps: { client: BffClient },
  runId: string,
  benchCase: BenchCase,
  casesDir: string,
  onProject?: (projectId: string) => void,
): Promise<Sandbox> {
  const project = await deps.client.createProject({
    title: `bench/${runId}/${benchCase.id}`,
    genre: benchCase.layer,
    synopsis: benchCase.title,
  });
  onProject?.(project.id);
  for (const setup of benchCase.setup) {
    const fixturePath = resolve(join(casesDir, benchCase.layer), setup.fixture);
    const content = await readFile(fixturePath, "utf8");
    await deps.client.writeDocument(project.id, setup.path, content);
  }
  const session = await deps.client.createSession(project.id);
  return { projectId: project.id, sessionId: session.id };
}
