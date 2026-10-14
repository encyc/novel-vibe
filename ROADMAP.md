# ROADMAP

> **范围**：本文件是公开路线图。内部设计、计划与运营材料（`docs/superpowers/**`、`docs/plans/**`、
> `docs/entropy/**`、`docs/research/**`）保存在**私有运维仓**，下文对这些路径的引用均指私有仓内的位置。

当前权威路线图。历史细节（已批准设计、地基状态）见私有运维仓的 `docs/superpowers/specs/` 与 `docs/implementation-plan.md`；本文件只保留**现在有效**的阶段与节奏。

## 当前阶段：生产运营 + 熵减常态化

**目标**：线上产品稳定运行；每月精简日对抗代码熵增；按需推进功能路线。

**非目标**（本阶段不做）：重写运行时、更换存储模型、扩大 novel-desktop 业务边界。

### 常设治理节奏

- **月度精简日（每月 1 日）**：流程与护栏见私有运维仓的 `docs/entropy/README.md`，由 AGENTS.md「逆熵精简机制」章节约束。产出物：一份归档报告（`docs/entropy/YYYY-MM.md`）+ 只做减法的提交。精简发现的结构性问题（如本次的 SIGPIPE 工具故障）当月修复。
- **治理变更走 `governance(<scope>)` 提交**：North Star、Cornerstone、边界、不变量、DoD、阶段边界、留存规则的变更必须独立提交并说明理由（scope：charter / roadmap / design / approval / retention）。
- **文档清理**：每个阶段收尾后按 project-governance 工作流清理过期计划与重复记录；完成态的实现计划删除，结论回灌本文件或对应 spec。

### 近期已完成（结论式归档）

- **2026-08 dsh 风格 WebUI 重写**（`feat/dsh-style-webui` 全线 + 三页跟进）：AppFrame 三栏让步链、会话优先布局、better-sidebar 活动栏、平面视觉体系、暗色 alias 层完整化。设计：私有运维仓 `docs/superpowers/specs/2026-08-28-dsh-style-webui-rewrite-design.md`。
- **2026-08 工作台状态简化**：CSS 根层重复定义 52→0；URL 成为导航唯一权威（`?view=` 标签、路径推导 pageId）；shell useState 11→8；compact/mobile 合并评估后弃案。设计：私有运维仓 `docs/superpowers/specs/2026-08-30-workbench-state-simplification-design.md`。
- **2026-08 生产部署链路**：私有运维仓部署脚本的全量迁移重放 010/032 函数签名冲突已修（`5e9d4a9`）；线上跑 `44265a3`。
- **2026-09 MCP 面刷新**（`feat/mcp-surface-refresh`）：工具 15→28（交互回路、会话中断/归档、文档版本历史、项目写入与生命周期、任务看板、子 agent 转写）；上游错误结构化透传（冲突内容/会员门控/失败原因不再丢失）；`run_agent` 等到 `turn_started` 即释放 SSE 连接；部署脚本纳管 `novel-mcp`（此前生产容器停在 2026-07-08 的根因）。计划：私有运维仓 `docs/superpowers/plans/2026-09-02-mcp-surface-refresh.md`。**观察项**：Agent Server API 后续演进须同步 MCP 工具面，纳入月度精简日检查。
- **2026-09 BYOK 自带模型密钥 + 会员调价**（`feat/byok`）：会员可用自有 LLM API Key（`byok-<provider>` 命名空间，一期白名单 DeepSeek/OpenAI/Anthropic/Google/Moonshot/智谱（含国际 zai）/小米 MiMo（含 Token 计划 CN））驱动全部 Agent 与压缩摘要——per-request 经 pi-ai `options.apiKey` 注入（压过 env key），免平台积分但 `usage_records` 留痕（`credits_consumed=0`）；Key AES-256-GCM 加密存 `novel.user_llm_keys`（migration 035，明文/密文永不出后端，列表只回末四位），加密密钥 `BYOK_ENCRYPTION_KEY` 缺失即服务端整体禁用；月卡价格 ¥9.90→¥19.99（migration 036，010 seed 全量重放会被压回、037 权益同理）；038 把 `byok` 回填进存量生效会员的 `features_snapshot`（快照购买时冻结，照 034 先例，否则老会员续购前看不到 BYOK）；`/settings` 页 + 模型选择器按「byok 权益 ∧ 已存 Key」注入。设计：私有运维仓 `docs/superpowers/specs/2026-09-03-byok-design.md`。**部署项**：`.env.prod` 需新增 `BYOK_ENCRYPTION_KEY`（任意口令，SHA-256 派生 AES 密钥；生产建议高熵随机值）。**遗留（二期）**：自定义 OpenAI 兼容端点、保存 Key 时主动向 provider 验证、多 Key per provider。

### 功能路线（方向性）

- **小说域 harness 补强**：Phase 2 引用查询（Phase 1 prose-lint 已落地）。设计见私有运维仓 `docs/superpowers/specs/2026-08-27-novel-harness-verifier-stack-design.md`。
- **写作工艺外部参考：[Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill)**（2026-09 评估；快照在仓库根 `Chinese-WebNovel-Skill/`，gitignored 不入库，含 166 篇语料与可用检索脚本）：单文件网文方法论 + 语料"结构摘录/标签/检索"蒸馏链。可借鉴点：①「去 AI 味」正反例规则（writer prompt / prose-lint 素材）；②九组质量 checklist（script_supervisor 量规与 harness 待办的 eval 哨兵素材）；③章纲四件套「目标/冲突/新信息/章末拉力」（对照 chapter-skeleton/chapter-card schema）；④范本检索机制与本项目 files+grep 路线同源。边界：语料为爬取的盐选内容，只借鉴机制、不搬语料；其带脚本/附件形态不符合本项目收窄的 Skill 规格，不可作为 User Skill 安装。
- **写作工艺注入（源自 Chinese-WebNovel-Skill 借鉴评估，2026-09-03 批准）**：批次 1 writer 去 AI 味硬规则+对白三要素、director 章末七型+开头抓手（纯 prompt）；批次 2 outliner 开头打法+黄金三章分工、chief-editor 九组审稿量规；A4 chapter-card 补「冲突/新信息/章末拉力」optional 字段；A5 chief-editor 选材诊断+hook/premise 入口层。范本检索体系（C：语料库+search_exemplar+默认先查范本）暂缓，待静态工艺知识验证边际收益后再决策。**eval 哨兵不再推进**：0710 harness 评测面（sandbox/judge/CI gate）与 8/31「轻层 harness」共识相悖，2026-09-03 确认搁置，spec 仅存档不实施；工艺评审由 chief-editor 审稿量规与 lint/reader 模拟承接。
- **WebUI backlog**：composer 服务端权威排队、⌘K 快捷键层、trace 工具名本地化扩展。

## 留存规则

- 归档的逆熵报告永久保留（趋势证据）；完成态实现计划删除；`webui-dist/`（构建产物，不入公开仓）与 `packages/novel-webui` 源码必须同步（发布预检强制）。
