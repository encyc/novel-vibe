/**
 * Craft rubrics for LLM judges. Content is sourced from the same craft
 * knowledge injected into writer/director prompts (Chinese-WebNovel-Skill
 * borrowing, batches 1-2): 去 AI 味硬约束、对白三要素、章末七型、章纲四件套。
 * Bump `version` when criteria change so cross-run comparability stays honest.
 */

export interface Rubric {
  id: string;
  version: number;
  /** Scoring dimensions this rubric feeds. */
  dimension: "prose" | "design" | "continuity";
  system: string;
  criteria: Array<{ key: string; description: string }>;
  /** Guidance on what input payload the judge receives. */
  payloadHint: string;
}

const JUDGE_SYSTEM_BASE = `你是中文网文的资深审稿编辑。你要按给定评审项对作品打分（0-10 整数），并从原文摘录一句作为证据。
严格要求：只输出一个 JSON 对象，格式为 {"items":[{"criterion":"<评审项key>","score":<0-10整数>,"evidence":"<原文短句>"}]}，不要输出任何其它文字、解释或 markdown 代码块。
评分参考：9-10 优秀，7-8 良好，5-6 及格，3-4 欠缺，0-2 完全不合格。评审项不适用时给 5 分并在 evidence 说明"不适用"。`;

export const RUBRICS: Rubric[] = [
  {
    id: "prose_flavor",
    version: 1,
    dimension: "prose",
    system: JUDGE_SYSTEM_BASE,
    payloadHint: "章节正文全文",
    criteria: [
      {
        key: "ai_flavor",
        description:
          "去 AI 味：是否存在排比句滥用、每段以总结句收尾、直接解释情绪而非用动作/细节呈现、空洞的景物铺垫、AI 高频套话（如'仿佛在诉说着''空气中弥漫着'）。越像真人作者写的分越高。",
      },
      {
        key: "dialogue",
        description:
          "对白三要素：对白是否同时承载信息推进、冲突张力、人物性格。念稿式/互相告知式对白扣分；有潜台词和口语质感加分。",
      },
      {
        key: "detail_showing",
        description:
          "呈现力：关键情节是否用具体的动作、感官细节、场景变化来呈现，而不是叙述概括。禁止'他很愤怒'式的直接标注，要看有没有摔杯子、攥紧拳头这类可拍摄的细节。",
      },
    ],
  },
  {
    id: "prose_structure",
    version: 1,
    dimension: "prose",
    system: JUDGE_SYSTEM_BASE,
    payloadHint: "章节正文全文（如有章卡一并附上）",
    criteria: [
      {
        key: "opening_hook",
        description:
          "开头抓手：前三句是否让读者入戏（冲突现场/悬念/动作切入），而非天气铺垫、回顾上章、大段设定说明。",
      },
      {
        key: "ending_pull",
        description:
          "章末拉力（七型任一：真相揭开一角/新危机落地/主角被迫选择/误会加深/关系变化/爽点预告/余韵收尾）：章末是否留下后劲。收在总结句、讲道理、情绪散尽、解释掉悬念即为不合格。",
      },
      {
        key: "pacing",
        description: "节奏：场景切换是否利落，有没有注水对话、重复信息、无功能的过渡段。",
      },
    ],
  },
  {
    id: "design_outline",
    version: 1,
    dimension: "design",
    system: JUDGE_SYSTEM_BASE,
    payloadHint: "章纲/章卡文档",
    criteria: [
      { key: "goal", description: "目标：本章主角要做什么，是否具体可执行，而非'继续变强'式的空目标。" },
      { key: "conflict", description: "冲突：谁/什么力量在阻止主角，冲突是否具体到能写出场景。" },
      { key: "new_info", description: "新信息：本章给读者的新信息（设定揭开/关系变化/新麻烦），是否足够支撑一章的信息量。" },
      {
        key: "ending_pull",
        description: "章末拉力：章纲是否明确了章末停在哪个变化上（七型），而不是'本章结束'。",
      },
    ],
  },
  {
    id: "design_worldbuilding",
    version: 1,
    dimension: "design",
    system: JUDGE_SYSTEM_BASE,
    payloadHint: "世界观/人物设定文档",
    criteria: [
      {
        key: "golden_finger",
        description: "金手指/核心设定：能力是否清晰、有代价或限制（没有代价的金手指扣分），能否直接制造事件而非摆设。",
      },
      {
        key: "character_drive",
        description:
          "人物驱动：主角是否有明确的欲望（要什么）、伤口（怕什么）、动机（为什么非行动不可）；配角是否各有功能而非工具人。",
      },
      {
        key: "sellable",
        description: "卖点清晰度：一句话能否说清这本书最想卖什么、读者为什么追；设定是否大到空洞、事件是否弱。",
      },
    ],
  },
  {
    id: "continuity_review",
    version: 1,
    dimension: "continuity",
    system: JUDGE_SYSTEM_BASE,
    payloadHint: "抽样章节正文 + 前情摘要（如有）+ 伏笔清单（如有）",
    criteria: [
      {
        key: "consistency",
        description: "前情一致：人物称呼、能力边界、时间线、地点是否与前文/前情摘要矛盾。发现硬伤扣分并引用矛盾处。",
      },
      {
        key: "state_evolution",
        description: "人物状态演进：人物的性格与处境是否随事件演进，而非每章重置。",
      },
      {
        key: "foreshadow_echo",
        description: "伏笔呼应：正文是否呼应了伏笔清单/前文埋点（若提供）；无凭空出现的新设定。",
      },
    ],
  },
];

export function getRubric(id: string): Rubric {
  const rubric = RUBRICS.find((r) => r.id === id);
  if (!rubric) {
    throw new Error(`unknown rubric: ${id}`);
  }
  return rubric;
}

export const RUBRIC_VERSION: number = Math.max(...RUBRICS.map((r) => r.version));
