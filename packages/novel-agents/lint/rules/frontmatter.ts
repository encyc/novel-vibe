/**
 * Frontmatter schema rule — mirrors the write path's TypeBox validation
 * (lib/document-indexing.ts prepareIndexedDocument) but reports findings
 * instead of throwing, so agents can self-check drafts before submitting.
 */
import { Value } from "@sinclair/typebox/value";
import { frontmatterSchemas } from "../../schemas/frontmatter.js";
import type { LintFinding } from "../types.js";

export function checkFrontmatter(frontmatter: Record<string, unknown>): LintFinding[] {
  const rawType = frontmatter.type ?? frontmatter.doc_type;
  if (rawType === undefined || rawType === null || rawType === "") {
    return [{
      rule: "frontmatter.missing_type",
      severity: "error",
      message: "缺少 frontmatter.type 字段",
      hint: "在 YAML frontmatter 第一行写明文档类型，例如 type: chapter-text",
    }];
  }
  if (typeof rawType !== "string" || !frontmatterSchemas[rawType]) {
    return [{
      rule: "frontmatter.unknown_type",
      severity: "error",
      message: `未支持的文档类型 "${String(rawType)}"`,
      hint: `可用类型：${Object.keys(frontmatterSchemas).join(", ")}`,
    }];
  }

  const normalized = frontmatter.type === undefined
    ? { ...frontmatter, type: rawType }
    : frontmatter;
  const schema = frontmatterSchemas[rawType];
  if (Value.Check(schema, normalized)) return [];

  const details = [...Value.Errors(schema, normalized)]
    .slice(0, 10)
    .map((e) => `${e.path || "/"}: ${e.message}`);
  return [{
    rule: "frontmatter.schema",
    severity: "error",
    message: `${rawType} frontmatter 校验失败：${details.join("；")}`,
    hint: `实际字段：${Object.keys(normalized).join(", ")}`,
  }];
}
