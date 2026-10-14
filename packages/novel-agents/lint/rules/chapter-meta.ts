/**
 * chapter-text internal frontmatter consistency:
 * pov, characters_present, and style_tags coherence. Deterministic only —
 * cross-document name/alias checks arrive with Phase 2 reference queries.
 */
import type { LintFinding } from "../types.js";

export function checkChapterMeta(frontmatter: Record<string, unknown>): LintFinding[] {
  const findings: LintFinding[] = [];

  const pov = frontmatter.pov;
  if (typeof pov !== "string" || !pov.trim()) {
    findings.push({
      rule: "chapter.pov_missing",
      severity: "warning",
      message: "缺少有效的 pov 字段（视角角色 slug）",
    });
  }

  const present = frontmatter.characters_present;
  if (!Array.isArray(present) || present.length === 0) {
    findings.push({
      rule: "chapter.present_empty",
      severity: "warning",
      message: "characters_present 为空，无法支撑后续引用查询与一致性核对",
      hint: "列出本章实际出场角色的 slug",
    });
  } else if (typeof pov === "string" && pov.trim() && !present.includes(pov)) {
    findings.push({
      rule: "chapter.pov_not_listed",
      severity: "warning",
      message: `pov "${pov}" 未出现在 characters_present 中`,
      hint: "视角角色通常应在场；若确为旁观视角，请把视角角色补入列表并注明",
    });
  }

  const styleTags = frontmatter.style_tags;
  if (!Array.isArray(styleTags) || styleTags.length === 0) {
    findings.push({
      rule: "chapter.style_tags_empty",
      severity: "warning",
      message: "style_tags 为空，写作风格无法沉淀到项目记忆",
    });
  }

  return findings;
}
