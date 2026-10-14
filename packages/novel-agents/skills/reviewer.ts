import { complete } from "@earendil-works/pi-ai/compat";
import { parseFrontmatter } from "../lib/frontmatter.js";
import type { ModelResolver } from "../model-runtime/model-resolver.js";
import type { RuntimeModelHealthService } from "../model-runtime/health-service.js";
import {
  getSystemModelHealthService,
  getSystemModelResolver,
} from "../model-runtime/system-resolver.js";
import { CAPABILITY_CATALOG } from "./capabilities.js";
import {
  SKILL_POLICY_VERSION,
  SKILL_ROLES,
  type SkillRole,
  type SkillValidationIssue,
  validateSkill,
} from "./policy.js";

export const SKILL_REVIEW_PROMPT_VERSION = "1";

export interface SemanticFinding {
  code: string;
  severity: "error" | "warning";
  line?: number;
  message: string;
}

export interface SemanticReviewResult {
  verdict: "approved" | "revision_required" | "rejected" | "failed";
  findings: SemanticFinding[];
  requiredCapabilities: string[];
  recommendedRoles: SkillRole[];
  revisedContent?: string;
  failureMessage?: string;
}

export interface ReviewExecutionResult extends SemanticReviewResult {
  attempts: number;
  candidateContent: string;
}

export interface ReviewGeneratorInput {
  systemPrompt: string;
  userPrompt: string;
}

export type ReviewGenerator = (input: ReviewGeneratorInput) => Promise<string>;

export interface ReviewSkillInput {
  slug: string;
  content: string;
  roles: readonly SkillRole[];
  deterministicIssues: readonly SkillValidationIssue[];
}

const REVIEW_SYSTEM_PROMPT = `You review Novel Vibe SKILL.md documents.
Return one JSON object only. Allowed keys: verdict, findings, requiredCapabilities, recommendedRoles, revisedContent.
Skills are instruction-only, single-file Markdown. They cannot create or run scripts, install dependencies,
read secrets, bypass permissions, invent tools, or use bundled resources. Map work only to the supplied
platform capability catalog. Use revision_required only when a safe wording-only adaptation preserves intent.`;

const allowedResponseKeys = new Set([
  "verdict", "findings", "requiredCapabilities", "recommendedRoles", "revisedContent",
]);
const knownCapabilities = new Set(CAPABILITY_CATALOG.map((entry) => entry.id));

function failed(message: string, attempts: number, candidateContent: string): ReviewExecutionResult {
  return {
    verdict: "failed",
    findings: [],
    requiredCapabilities: [],
    recommendedRoles: [],
    failureMessage: message,
    attempts,
    candidateContent,
  };
}

function parseResponse(raw: string): SemanticReviewResult {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review response must be an object");
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !allowedResponseKeys.has(key));
  if (unknownKeys.length) throw new Error(`Unknown review response fields: ${unknownKeys.join(", ")}`);
  if (!(["approved", "revision_required", "rejected"] as unknown[]).includes(record.verdict)) {
    throw new Error("Invalid review verdict");
  }
  if (!Array.isArray(record.findings) || !Array.isArray(record.requiredCapabilities) || !Array.isArray(record.recommendedRoles)) {
    throw new Error("Invalid review response arrays");
  }
  const findings = record.findings.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid review finding");
    const finding = item as Record<string, unknown>;
    if (typeof finding.code !== "string" || typeof finding.message !== "string"
      || (finding.severity !== "error" && finding.severity !== "warning")) {
      throw new Error("Invalid review finding");
    }
    return {
      code: finding.code,
      message: finding.message,
      severity: finding.severity as SemanticFinding["severity"],
      ...(typeof finding.line === "number" ? { line: finding.line } : {}),
    };
  });
  const requiredCapabilities = record.requiredCapabilities.map((item) => {
    if (typeof item !== "string" || !knownCapabilities.has(item)) throw new Error(`Unknown capability: ${String(item)}`);
    return item;
  });
  const recommendedRoles = record.recommendedRoles.map((item) => {
    if (typeof item !== "string" || !(SKILL_ROLES as readonly string[]).includes(item)) {
      throw new Error(`Unknown role: ${String(item)}`);
    }
    return item as SkillRole;
  });
  if (record.revisedContent !== undefined && typeof record.revisedContent !== "string") {
    throw new Error("revisedContent must be a string");
  }
  if (record.verdict === "revision_required" && typeof record.revisedContent !== "string") {
    throw new Error("revision_required must include revisedContent");
  }
  return {
    verdict: record.verdict as SemanticReviewResult["verdict"],
    findings,
    requiredCapabilities,
    recommendedRoles,
    ...(typeof record.revisedContent === "string" ? { revisedContent: record.revisedContent } : {}),
  };
}

function promptFor(input: ReviewSkillInput, content: string, allowRevision: boolean): string {
  return JSON.stringify({
    policyVersion: SKILL_POLICY_VERSION,
    allowRevision,
    selectedRoles: input.roles,
    deterministicIssues: input.deterministicIssues,
    capabilityCatalog: CAPABILITY_CATALOG,
    skill: content,
  });
}

async function generateOnce(
  input: ReviewSkillInput,
  content: string,
  generator: ReviewGenerator,
  allowRevision: boolean,
): Promise<SemanticReviewResult> {
  const raw = await generator({ systemPrompt: REVIEW_SYSTEM_PROMPT, userPrompt: promptFor(input, content, allowRevision) });
  return parseResponse(raw);
}

export async function reviewSkill(input: ReviewSkillInput, generator: ReviewGenerator): Promise<ReviewExecutionResult> {
  let first: SemanticReviewResult;
  try {
    first = await generateOnce(input, input.content, generator, true);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), 1, input.content);
  }
  if (first.verdict !== "revision_required") {
    return { ...first, attempts: 1, candidateContent: input.content };
  }

  const revised = first.revisedContent!;
  const deterministic = validateSkill({ slug: input.slug, content: revised, roles: [...input.roles] });
  if (!deterministic.valid) return failed("Revised content violates deterministic policy", 1, revised);
  const originalFrontmatter = parseFrontmatter(input.content).frontmatter;
  const revisedFrontmatter = parseFrontmatter(revised).frontmatter;
  if (originalFrontmatter.name !== revisedFrontmatter.name || originalFrontmatter.description !== revisedFrontmatter.description) {
    return failed("Reviewer cannot change skill frontmatter identity", 1, revised);
  }

  try {
    const second = await generateOnce(input, revised, generator, false);
    if (second.verdict === "revision_required") return failed("Review exceeded one revision", 2, revised);
    if (second.verdict !== "approved") return { ...second, attempts: 2, candidateContent: revised };
    return {
      ...first,
      requiredCapabilities: second.requiredCapabilities,
      recommendedRoles: second.recommendedRoles,
      attempts: 2,
      candidateContent: revised,
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), 2, revised);
  }
}

export function createConfiguredReviewGenerator(options: {
  modelResolver?: Pick<ModelResolver, "resolve">;
  completeModel?: typeof complete;
  modelHealthService?: Pick<RuntimeModelHealthService, "observeFailure">;
} = {}): ReviewGenerator {
  const modelResolver = options.modelResolver ?? getSystemModelResolver();
  const completeModel = options.completeModel ?? complete;
  const modelHealthService = options.modelHealthService ?? getSystemModelHealthService();
  return async ({ systemPrompt, userPrompt }) => {
    const provider = process.env.SKILL_REVIEW_PROVIDER ?? process.env.LLM_PROVIDER ?? "deepseek";
    const modelName = process.env.SKILL_REVIEW_MODEL ?? process.env.LLM_MODEL ?? "deepseek-v4-flash";
    const resolved = await modelResolver.resolve(provider, modelName);
    let response;
    try {
      response = await completeModel(resolved.model, {
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] as any,
      });
    } catch (error) {
      await modelHealthService.observeFailure(resolved, error);
      throw error;
    }
    if (response.stopReason === "error") {
      await modelHealthService.observeFailure(
        resolved,
        new Error(response.errorMessage ?? "Skill review model request failed"),
      );
    }
    return response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  };
}
