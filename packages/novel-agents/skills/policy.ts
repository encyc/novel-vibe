import { parseFrontmatter } from "../lib/frontmatter.js";

export const SKILL_POLICY_VERSION = "1";
export const SKILL_RULES_VERSION = "1";
export const SKILL_ROLES = [
  "chief_editor",
  "worldbuilder",
  "character_designer",
  "outliner",
  "director",
  "writer",
  "script_supervisor",
] as const;

export type SkillRole = typeof SKILL_ROLES[number];

export interface SkillValidationIssue {
  code: string;
  severity: "error" | "warning";
  blocking: boolean;
  line?: number;
  message: string;
}

export interface SkillValidationResult {
  valid: boolean;
  slug?: string;
  name?: string;
  description?: string;
  issues: SkillValidationIssue[];
}

const MAX_SKILL_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_FRONTMATTER = new Set(["name", "description"]);

const UNSAFE_PATTERNS: ReadonlyArray<{
  code: string;
  message: string;
  pattern: RegExp;
}> = [
  {
    code: "BUNDLED_RESOURCE_REFERENCE",
    message: "Skills cannot depend on scripts, references, or assets directories.",
    pattern: /(?:^|[\s(/`])(?:scripts?|references?|assets?)\//im,
  },
  {
    code: "ARBITRARY_CODE_EXECUTION",
    message: "Skills cannot instruct an Agent to create or run scripts.",
    pattern: /\b(?:write|create|generate|run|execute)\s+(?:an?\s+)?(?:python|javascript|typescript|node|bash|ruby|perl|php)?\s*script\b|(?:编写|创建|生成|运行|执行).{0,12}(?:脚本|python|javascript)/iu,
  },
  {
    code: "SHELL_EXECUTION",
    message: "Skills cannot instruct an Agent to execute shell commands.",
    pattern: /\b(?:shell|bash|zsh|powershell)\s+(?:command|命令)|(?:执行|运行).{0,8}(?:shell|bash|终端|命令行)|\bcurl\s+https?:\/\//iu,
  },
  {
    code: "DEPENDENCY_INSTALLATION",
    message: "Skills cannot install dependencies.",
    pattern: /\b(?:npm|pnpm|yarn|pip|pip3|gem|cargo)\s+(?:install|add)\b|(?:安装|下载).{0,10}(?:依赖|软件包|package)/iu,
  },
  {
    code: "DYNAMIC_EVALUATION",
    message: "Skills cannot use dynamic code evaluation.",
    pattern: /\b(?:eval|exec|new\s+Function)\s*\(/iu,
  },
  {
    code: "SECRET_ACCESS",
    message: "Skills cannot request credentials or sensitive local files.",
    pattern: /(?:~\/\.ssh|id_rsa|\.env\b|environment\s+secrets?|api[_ -]?keys?|passwords?|读取.{0,10}(?:密钥|密码|凭据))/iu,
  },
  {
    code: "PERMISSION_BYPASS",
    message: "Skills cannot bypass permissions, approval, or higher-priority instructions.",
    pattern: /(?:bypass|ignore|circumvent).{0,20}(?:permission|approval|policy|system prompt)|(?:绕过|忽略).{0,15}(?:权限|审批|安全|系统指令)/iu,
  },
];

function issue(code: string, message: string, line?: number): SkillValidationIssue {
  return { code, message, line, severity: "error", blocking: true };
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

export function validateSkill(input: {
  filename?: string;
  slug: string;
  content: string;
  roles: string[];
}): SkillValidationResult {
  const issues: SkillValidationIssue[] = [];

  if (input.filename !== undefined && input.filename !== "SKILL.md") {
    issues.push(issue("INVALID_FILENAME", "The uploaded file must be named SKILL.md."));
  }
  if (Buffer.byteLength(input.content, "utf8") > MAX_SKILL_BYTES) {
    issues.push(issue("CONTENT_TOO_LARGE", `SKILL.md must not exceed ${MAX_SKILL_BYTES} bytes.`));
  }
  if (!SLUG_RE.test(input.slug) || input.slug.length > 64) {
    issues.push(issue("INVALID_SLUG", "Skill slug must be lowercase kebab-case and at most 64 characters."));
  }
  if (input.roles.length === 0) {
    issues.push(issue("MISSING_ROLE", "Select at least one Agent role."));
  }
  for (const role of input.roles) {
    if (!(SKILL_ROLES as readonly string[]).includes(role)) {
      issues.push(issue("INVALID_ROLE", `Unsupported Agent role: ${role}`));
    }
  }

  const startsWithFrontmatter = input.content.trimStart().startsWith("---\n");
  const parsed = parseFrontmatter(input.content);
  const keys = Object.keys(parsed.frontmatter);
  if (!startsWithFrontmatter || keys.length === 0) {
    issues.push(issue("MISSING_FRONTMATTER", "SKILL.md must start with YAML frontmatter."));
  }
  for (const key of keys) {
    if (!ALLOWED_FRONTMATTER.has(key)) {
      issues.push(issue("UNSUPPORTED_FRONTMATTER_FIELD", `Unsupported frontmatter field: ${key}`));
    }
  }

  const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
  const description = typeof parsed.frontmatter.description === "string"
    ? parsed.frontmatter.description.trim()
    : "";
  if (!name) issues.push(issue("MISSING_NAME", "Frontmatter name is required."));
  if (!description) issues.push(issue("MISSING_DESCRIPTION", "Frontmatter description is required."));
  if (!parsed.body.trim()) issues.push(issue("EMPTY_BODY", "SKILL.md must contain instruction text."));

  for (const unsafe of UNSAFE_PATTERNS) {
    const match = unsafe.pattern.exec(input.content);
    if (match) issues.push(issue(unsafe.code, unsafe.message, lineOf(input.content, match.index)));
  }

  return {
    valid: issues.every((item) => !item.blocking),
    ...(SLUG_RE.test(input.slug) ? { slug: input.slug } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    issues,
  };
}
