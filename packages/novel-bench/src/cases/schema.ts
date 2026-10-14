import { Value } from "@sinclair/typebox/value";
import { Type, type Static } from "@sinclair/typebox";
import { parse as parseYaml } from "yaml";
// Agents 源码相对导入（显式 .ts）：tsc/vitest/tsx 三端原生解析，无 alias/构建依赖。
import { getDocDir } from "../../../novel-agents/lib/frontmatter.ts";
import { chapterTextPath } from "../../../novel-agents/lib/document-paths.ts";
import type { BenchCase, Dimension } from "../types.ts";

const DIMENSIONS: readonly Dimension[] = ["prose", "design", "continuity"];

const KNOWN_DOC_TYPES = [
  "worldview",
  "character",
  "relationships",
  "volume",
  "chapter-skeleton",
  "chapter-card",
  "director-script",
  "chapter-text",
  "foreshadow",
  "story-summary",
  "character-state",
] as const;

const CaseYamlSchema = Type.Object({
  id: Type.String({ pattern: "^(light|heavy)/[A-Za-z0-9][A-Za-z0-9-]*$" }),
  title: Type.String({ minLength: 1 }),
  layer: Type.Union([Type.Literal("light"), Type.Literal("heavy")]),
  dimension_focus: Type.Array(Type.Union(DIMENSIONS.map((d) => Type.Literal(d))), { minItems: 1 }),
  setup: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      type: Type.String(),
      fixture: Type.String({ minLength: 1 }),
    }),
  ),
  script: Type.Array(
    Type.Object({
      text: Type.String({ minLength: 1 }),
      expect: Type.Optional(
        Type.Object({
          doc_type: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          min_count: Type.Optional(Type.Number({ minimum: 1 })),
        }),
      ),
    }),
    { minItems: 1 },
  ),
  constraints: Type.Optional(
    Type.Object({
      min_words: Type.Optional(Type.Number({ minimum: 1 })),
      chapter_nums: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
      required_doc_types: Type.Optional(Type.Array(Type.String())),
      foreshadow_ids: Type.Optional(Type.Array(Type.String({ pattern: "^fs-[0-9]{3}$" }))),
    }),
  ),
  rubric_weights: Type.Optional(
    Type.Object({
      prose: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      design: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      continuity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
  ),
});

const CHAPTER_TEXT_PATH = /^text\/ch-[0-9]{3}\.md$/;
const FORESHADOW_PATH = /^foreshadowing\/fs-[0-9]{3}\.md$/;

function firstErrorMessage(errors: Array<{ path?: string; message?: string; messageText?: string }>): string {
  const first = errors[0];
  if (!first) return "schema mismatch";
  return `${first.path || "(root)"}: ${first.messageText ?? first.message ?? "invalid value"}`;
}

export class CaseSchemaError extends Error {
  constructor(
    public readonly caseId: string,
    message: string,
  ) {
    super(`case ${caseId}: ${message}`);
  }
}

/** Parse and validate one case YAML string into a BenchCase. */
export function parseCaseYaml(id: string, raw: string): BenchCase {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new CaseSchemaError(id, `invalid YAML: ${(err as Error).message}`);
  }
  if (!Value.Check(CaseYamlSchema, doc)) {
    const errors = [...Value.Errors(CaseYamlSchema, doc)];
    throw new CaseSchemaError(id, firstErrorMessage(errors));
  }
  const yaml = doc as Static<typeof CaseYamlSchema>;

  for (const setup of yaml.setup) {
    if (!(KNOWN_DOC_TYPES as readonly string[]).includes(setup.type)) {
      throw new CaseSchemaError(id, `setup doc ${setup.path}: unknown doc type ${setup.type}`);
    }
    const dir = getDocDir(setup.type);
    if (!setup.path.startsWith(`${dir}/`)) {
      throw new CaseSchemaError(id, `setup doc ${setup.path}: type ${setup.type} must live under ${dir}/`);
    }
    if (setup.type === "chapter-text" && !CHAPTER_TEXT_PATH.test(setup.path)) {
      throw new CaseSchemaError(id, `setup doc ${setup.path}: chapter-text must match ${chapterTextPath(1)}`);
    }
    if (setup.type === "foreshadow" && !FORESHADOW_PATH.test(setup.path)) {
      throw new CaseSchemaError(id, `setup doc ${setup.path}: foreshadow must match foreshadowing/fs-NNN.md`);
    }
  }

  for (const [index, step] of yaml.script.entries()) {
    if (step.expect?.doc_type && !(KNOWN_DOC_TYPES as readonly string[]).includes(step.expect.doc_type)) {
      throw new CaseSchemaError(id, `script step ${index}: unknown expect.doc_type ${step.expect.doc_type}`);
    }
  }

  return {
    id: yaml.id,
    title: yaml.title,
    layer: yaml.layer,
    dimensionFocus: yaml.dimension_focus,
    setup: yaml.setup.map((s) => ({ path: s.path, type: s.type, fixture: s.fixture })),
    script: yaml.script.map((s) => ({
      text: s.text,
      expect: s.expect
        ? { docType: s.expect.doc_type, path: s.expect.path, minCount: s.expect.min_count }
        : undefined,
    })),
    constraints: {
      minWords: yaml.constraints?.min_words,
      chapterNums: yaml.constraints?.chapter_nums,
      requiredDocTypes: yaml.constraints?.required_doc_types,
      foreshadowIds: yaml.constraints?.foreshadow_ids,
    },
    rubricWeights: yaml.rubric_weights ?? {},
  };
}
