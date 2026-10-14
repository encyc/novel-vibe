# Novel Vibe（灵器 AI）

**多 Agent 的网文创作系统：本地优先，云可选。**

你只和**总编（Chief Editor）**对话，由它统筹 6 个子 Agent 协作产出作品；所有创作内容都是**带 YAML frontmatter 的 Markdown 文件**（世界观、角色、关系、大纲、章节卡、导演稿、正文、伏笔、故事摘要、角色状态），Markdown 是唯一事实来源，数据库里的只是可重建的索引。

| 子 Agent | 负责 |
|---|---|
| `worldbuilder` | 世界观 |
| `character_designer` | 角色与关系 |
| `outliner` | 卷 / 章大纲 |
| `director` | 章节导演稿 |
| `writer` | 正文 |
| `script_supervisor` | 连续性与场记 |

**先看这六条：**

- **许可**：Apache License 2.0，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。允许商业使用、修改、再分发，**也允许第三方把本软件作为托管服务提供**。
- **品牌不在授权范围内**：名称（"Novel Vibe" / "灵器 AI"）、域名（`lingqiai.art`）与 logo 是项目方标识，Apache-2.0 不授予其使用权；fork 需要换名字与标识，不得暗示官方背书。详见 [`NOTICE`](NOTICE) 的商标段。
- **本地优先**：整套系统可以在自己的机器上运行 —— 不需要注册账号，也不经过作者的模型服务。代价是 **Docker + 自备模型 API Key**（见 [怎么跑](#怎么跑)）。
- **云可选**：作者运营的托管实例 <https://lingqiai.art> 免部署，模型调用由平台代付（消耗平台积分）。
- **日常启动是一条命令**：`./scripts/local-start.sh`（首次准备见下）。
- **公开 / 私有边界**：公开仓包含复现、构建、运行、测试本产品所需的全部内容（六个 `packages/` 应用、应用 schema 迁移、ADR、CI、公开仓泄漏自检）；生产环境标识与凭据、部署与发版运维、内部设计与计划材料不在公开仓，托管运维在私有仓（见 [`AGENTS.md`](AGENTS.md) 的 Hosted Operations 一节）。

> 架构、工具、会话持久化、技能系统与端口的权威说明在 [`AGENTS.md`](AGENTS.md)。本 README 不复述架构，避免与它二次漂移。

## 怎么跑

### A. 本地自部署（local-first，默认路径）

在自己的机器上运行整套系统。**先看清代价：**

- **需要 Docker。** 本地模式的持久化仍然是 PostgreSQL + InsForge，不是 SQLite —— 这是明确决策，理由与实测数据见 [`docs/adr/0007-keep-postgres-for-local-mode.md`](docs/adr/0007-keep-postgres-for-local-mode.md)。实测占用：**4 个容器、空闲约 750 MiB 内存、镜像约 2.7 GB**；macOS / Windows 上 Docker 引擎自身还需要一台 Linux VM。
- **需要自备模型 API Key（BYOK）。** 本地模式不调用作者的模型服务，也不消耗平台积分：模型请求直接发往你自己的 provider key（本地组合根把计费端口接成空实现，见 [`packages/novel-agents/server/runtime.ts`](packages/novel-agents/server/runtime.ts) 与 [`packages/novel-agents/lib/policy-ports.ts`](packages/novel-agents/lib/policy-ports.ts)）。支持的 provider 以 [`packages/novel-agents/lib/byok.ts`](packages/novel-agents/lib/byok.ts) 的 `BYOK_ALLOWED_PROVIDERS` 为准，当前共 9 个：

  | provider id | 显示名 |
  |---|---|
  | `deepseek` | DeepSeek |
  | `openai` | OpenAI |
  | `anthropic` | Claude |
  | `google` | Gemini |
  | `moonshotai` | Kimi |
  | `zai` | 智谱 GLM Coding（国际） |
  | `zai-coding-cn` | 智谱 GLM（Coding 计划） |
  | `xiaomi` | 小米 MiMo |
  | `xiaomi-token-plan-cn` | 小米 MiMo（Token 计划） |

  key 在 WebUI 的**设置 → 自带模型密钥**里保存。
- **不需要注册账号。** 设置 `NOVEL_VIBE_LOCAL_MODE=true` 后使用本地身份，没有登录步骤（[`packages/novel-agents/lib/local-mode.ts`](packages/novel-agents/lib/local-mode.ts)）。

#### 前置条件与已知限制（重要，请先读）

本地模式需要这些：**Node 22 + npm**（CI 使用的版本）、**Docker**、**`InsForge/` 后端检出**。

- `InsForge/` 不在本仓库内（[`.gitignore`](.gitignore) 第 1–8 行排除了它），由 `make setup` 从**公开的** InsForge fork 克隆：`https://github.com/encyc/novel-vibe-insforge.git`（Apache-2.0）。镜像、fork 或固定版本用 `INSFORGE_REPO_URL` 覆盖 —— 见 [`scripts/setup.sh`](scripts/setup.sh)。
- **Novel Vibe 自己的应用 schema 在本仓库内**（[`scripts/migrations/`](scripts/migrations) 的 `000a–000j`），由 [`scripts/run-migrations.sh`](scripts/run-migrations.sh) 应用（`local-start.sh` 会自动调用）。项目表、会话表、积分表、存储 bucket 与 RLS 策略都在这里。
- **InsForge 的平台 schema 在那份公开 fork 里**（auth / storage / system / realtime / deployments / pg_cron 等基建与平台迁移）。两份 schema 的分工、完整自托管走查（含 Linux 的手动步骤）与验证命令见 [`docs/self-hosting.md`](docs/self-hosting.md) —— 从公开来源出发的自托管现在是完整的。
- 仍存在的限制：本地模式的一键路径**不在 CI 里**（见下面的状态说明）；`scripts/setup.sh` 与 `scripts/start.sh`（即 `make setup` / `make up`）目前只在 macOS 上驱动开发服务，Linux 按 `docs/self-hosting.md` 的手动步骤 + `./scripts/local-start.sh` 走。
- 当前定位：本地模式面向"能自己起 Docker、自带模型 key"的用户，不是"下载即用"；如果你要的是后者，现在的答案是下面的托管实例。

#### 快速开始

```bash
# 首次准备（任选其一）
make setup                    # macOS：克隆公开的 InsForge fork + 写 .env + npm install（scripts/setup.sh 仅 macOS）
# Linux：按 docs/self-hosting.md「Linux」一节手动 clone + npm install
#        （脚本只驱动 macOS 开发服务；local-start.sh 本身没有系统限制）

# 之后每次启动就是一条命令
./scripts/local-start.sh      # 起 InsForge(7130) + Agent Server(7140) + Web BFF(9120)
./scripts/local-e2e.sh        # 端到端自检：建项目 → 开会话 → 写文档 → 重启 Agent Server → 历史仍在
npm run webui:new             # 另开一个终端：WebUI 开发服务器 → http://localhost:5173
```

> **状态说明（记录于 2026-10-13）**：本地模式**不在 CI 里** —— `.github/workflows/` 没有任何 job 调用 `local-start.sh` 或 `local-e2e.sh`（CI 跑 typecheck / test / desktop 与公开仓泄漏自检）。`local-e2e.sh` 是自检脚本而不是发布门，且默认**不调用模型**（设 `LOCAL_E2E_CHAT=1` 才会尝试一次真实对话，那需要已保存的 BYOK key）。启动脚本在 2026-10-10 曾针对本地栈跑过端到端自检并修掉两个阻塞问题（迁移未执行、JWT_SECRET 与容器不一致；提交 `683bc9d`），但**含真实模型调用的完整一轮、以及 CI 门禁，都还没有**。请把首次运行当作"需要你帮忙验证"的路径，而不是"已验证"的路径。

本地模式下的服务端口：

| 服务 | 端口 | 说明 |
|---|---|---|
| InsForge（API + Dashboard） | 7130 | PostgreSQL / Storage / Auth 的入口 |
| PostgREST | 5430 | 直接 DB 查询 |
| Agent Server | 7140 | Agent 编排 HTTP/SSE API |
| Web BFF | 9120 | 浏览器会话与代理 |
| WebUI 开发服务器 | 5173 | `npm run webui:new` |

### B. 托管实例（免部署）

<https://lingqiai.art>，应用入口 <https://app.lingqiai.art>。注册账号后即可使用；模型调用由平台代付，消耗平台积分。托管服务的部署与运维由项目方负责，运维材料（生产 compose、证书、发版）在私有仓，不属于本公开仓的内容。

## 开发与验证

先装依赖（`npm install`，或让 `make setup` 代劳），然后：

```bash
npm run check            # 全链路：i18n → agents → web → webui → mcp → desktop → seo → bench
npm run check:agents     # 单包：packages/novel-agents
npm run check:web        # 单包：packages/novel-web
npm run check:webui      # 单包：packages/novel-webui
npm run check:mcp        # 单包：packages/novel-mcp
npm run check:bench      # 单包：packages/novel-bench
npm run check:boundary   # 架构边界守卫（注意：不在 npm run check 的链路里）
npm run check:hygiene -- --public-only --strict   # 公开仓泄漏自检（同样不在 check 链里）
```

CI 的顺序是先 typecheck、后 test，两者都必须通过（typecheck job 里还会跑公开仓泄漏自检）。`check:desktop` 需要 Rust 工具链（`cargo fmt` / `clippy` / `test`）；CI 使用 Node 22。

## 架构与文档索引

不要从 README 学习架构，去读这些文件：

- [`AGENTS.md`](AGENTS.md) —— **唯一权威**的架构、命令、端口、工具与技能系统说明；「Hosted Operations」一节说明托管运维为何不在本仓
- [`docs/architecture.md`](docs/architecture.md)、[`docs/current-system-map.md`](docs/current-system-map.md)
- [`docs/adr/`](docs/adr/) —— 架构决策记录（内容存储端口、策略端口、本地模式保留 PostgreSQL 等）
- [`docs/development-workflow.md`](docs/development-workflow.md) —— 改动放哪、怎么验证
- [`docs/self-hosting.md`](docs/self-hosting.md) —— 自托管走查：公开 InsForge fork、端口、Linux 手动步骤、验证命令
- [`docs/community-guides/`](docs/community-guides/) —— 面向创作者的平台使用指南

## 桌面端

[`packages/novel-desktop`](packages/novel-desktop) 是 Tauri 2 的"连接式外壳"：它加载**远程**的 `app.lingqiai.art`，本身不含 Agent / 会话 / 计费 / 文档等业务逻辑。**这是设计决策，不是未完成的功能**：

- **本地优先的表面是浏览器**。自托管者跑起本地栈后用浏览器访问（见[怎么跑](#怎么跑)）；桌面壳是托管服务的客户端，两者面向不同场景。
- 壳里几乎不带东西（只有断网恢复页），产品 UI 运行时从服务器加载——**桌面用户的界面永远最新**，不需要为 UI 变更发桌面版本。
- 出于安全考虑，`APP_ORIGIN` 在编译期冻结（`policy.rs`），导航策略按单一可信源站设计（含防仿冒域名的白名单）；未签名构建不注册更新器。
- 因此自己从源码 build 出来的桌面 App 同样指向官方托管实例。如果将来需要让桌面壳指向自托管部署，规划中的路径是编译期源站覆盖 + UI 的 API base 可配置——同一份 `packages/novel-webui` 构建，属于增量改造而非重写。

想了解它到底做了什么，直接读源码：[`packages/novel-desktop/src-tauri/`](packages/novel-desktop/src-tauri)（`policy.rs` 管导航、`main.rs` 建窗口与注入 CSP、`bridge.rs` 是 `window.novelDesktop` 契约、`recovery.rs` 是加载超时看门狗、`offline/` 是断网恢复页）。设计记录属内部材料，不在公开仓。

## 许可与品牌

本项目采用 **Apache License 2.0**，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。它允许商业使用、修改、再分发，**也允许第三方把本软件作为托管服务提供**；同时要求保留版权声明与 `NOTICE`。`lingqiai.art` 是作者运营的托管实例，只是便利，不是许可条件 —— 许可证授予你的权利与该服务无关。

**品牌不在许可证范围内。** Apache-2.0 第 6 条明确不授予商标或品牌使用权：「Novel Vibe」「灵器 AI / 灵器」、`lingqiai.art` 域名与项目 logo 均属项目方标识。fork 或自托管时请使用不同的名称与标识，不要暗示官方背书；以事实方式说明"这是 Novel Vibe 的 fork"没有问题。完整声明见 [`NOTICE`](NOTICE)。

## 贡献

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。提交使用 **DCO**（`git commit -s`），不需要签 CLA；贡献以 Apache-2.0 授权（inbound = outbound）。

## English

Novel Vibe is a multi-agent web-novel writing system: a Chief Editor agent coordinates six sub-agents (worldbuilding, characters, outlining, chapter direction, prose, continuity), and every artifact is stored as Markdown with YAML frontmatter, with the database acting only as a rebuildable index. It is local-first and cloud-optional: self-host it on your own machine (no account, no author-operated model service; you bring your own model API key and run Docker), or use the author-hosted instance at [lingqiai.art](https://lingqiai.art). The usual start is a single command, `./scripts/local-start.sh`, after a one-time setup: `make setup` clones the public InsForge fork (Apache-2.0, override with `INSFORGE_REPO_URL`) and creates the env files, so self-hosting from public sources is now complete — see [`docs/self-hosting.md`](docs/self-hosting.md) for the walkthrough and the manual Linux steps. What is still missing is coverage: the one-command local path is not exercised by CI. The public repository contains everything needed to build, run and test the product; production identifiers and credentials, deployment and release operations, and internal design material are not published, and hosted operations live in a private repository. The project is licensed under Apache-2.0, which permits commercial use and third-party hosting; names, domains and logos are brand identifiers and are **not** licensed, so forks need their own name and branding — see [`NOTICE`](NOTICE). Contributions are accepted under the DCO — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
