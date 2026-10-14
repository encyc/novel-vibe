import { Value } from "@sinclair/typebox/value";
import { frontmatterSchemas } from "../schemas/frontmatter.js";
import { countWords, parseFrontmatter } from "./frontmatter.js";

export interface PreparedIndexedDocument {
  path: string;
  docType: string;
  name?: string;
  status?: string;
  chapterNum?: number;
  volumeNum?: number;
  meta: Record<string, unknown>;
  wordCount: number;
}

interface DocumentIndexDb {
  upsertDocumentIndex(params: {
    projectId: string; docPath: string; docType: string; name?: string; status?: string;
    chapterNum?: number; volumeNum?: number; meta: Record<string, unknown>;
    wordCount?: number; checksum?: string;
  }): Promise<void>;
  upsertForeshadow(params: {
    projectId: string; foreshadowId: string; docPath: string; description?: string;
    importance?: number; plantChapter?: number; plannedResolve?: number;
    actualResolve?: number | null; status?: string;
  }): Promise<void>;
}

export function prepareIndexedDocument(path: string, content: string): PreparedIndexedDocument | null {
  const { frontmatter, body } = parseFrontmatter(content);
  const rawType = frontmatter.type ?? frontmatter.doc_type;
  if (rawType === undefined) return null;
  if (typeof rawType !== "string" || !frontmatterSchemas[rawType]) {
    throw new Error(`Unsupported document type "${String(rawType)}"`);
  }
  const normalizedFrontmatter = frontmatter.type === undefined
    ? { ...frontmatter, type: rawType }
    : frontmatter;
  const schema = frontmatterSchemas[rawType];
  if (!Value.Check(schema, normalizedFrontmatter)) {
    const first = [...Value.Errors(schema, normalizedFrontmatter)][0];
    const detail = first ? `${first.path || "/"}: ${first.message}` : "schema mismatch";
    throw new Error(`Invalid ${rawType} frontmatter at ${path}: ${detail}; received keys: ${Object.keys(normalizedFrontmatter).join(", ")}`);
  }
  return {
    path,
    docType: rawType,
    name: typeof normalizedFrontmatter.name === "string" ? normalizedFrontmatter.name : undefined,
    status: typeof normalizedFrontmatter.status === "string" ? normalizedFrontmatter.status : undefined,
    chapterNum: typeof normalizedFrontmatter.chapter === "number" ? normalizedFrontmatter.chapter : undefined,
    volumeNum: typeof normalizedFrontmatter.volume === "number" ? normalizedFrontmatter.volume : undefined,
    meta: normalizedFrontmatter,
    wordCount: countWords(body),
  };
}

export async function syncPreparedDocument(
  db: DocumentIndexDb,
  projectId: string,
  prepared: PreparedIndexedDocument,
  checksum: string,
): Promise<void> {
  await db.upsertDocumentIndex({
    projectId,
    docPath: prepared.path,
    docType: prepared.docType,
    name: prepared.name,
    status: prepared.status,
    chapterNum: prepared.chapterNum,
    volumeNum: prepared.volumeNum,
    meta: prepared.meta,
    wordCount: prepared.wordCount,
    checksum,
  });
  if (prepared.docType !== "foreshadow") return;
  const meta = prepared.meta;
  await db.upsertForeshadow({
    projectId,
    foreshadowId: meta.id as string,
    docPath: prepared.path,
    description: meta.description as string,
    importance: meta.importance as number,
    plantChapter: meta.plant_chapter as number,
    plannedResolve: meta.planned_resolve as number,
    actualResolve: meta.actual_resolve as number | null,
    status: meta.status as string,
  });
}
