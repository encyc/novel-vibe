# Novel Vibe MCP 使用指南

通过 Model Context Protocol（MCP）远程控制你的 Novel Vibe 账户：管理项目与小说文档、查看版本历史、管理会话、回答编辑的提问、查询额度，甚至触发 Chief Editor 写作。

本文档面向**使用者**（你自己或授权的 MCP 客户端，如 Claude Desktop、Cursor、zcode）。设计与内部实现见**私有运维仓**的 `docs/superpowers/plans/2026-07-07-remote-mcp-api-token.md` 与 `docs/superpowers/plans/2026-09-02-mcp-surface-refresh.md`。

---

## 1. 它是什么

Novel Vibe 提供一个**远程（hosted）MCP 服务**，基于 **Streamable HTTP** 传输（不是 stdio，也不是旧式 SSE）：

- **生产端点**：`https://app.lingqiai.art/mcp`
- **协议版本**：`2025-06-18`
- **服务标识**：`serverInfo = { name: "novel-vibe", version: "0.1.0" }`
- **鉴权**：HTTP Bearer，`Authorization: Bearer lingqi_<publicId>_<secret>`
- **会话模型**：**无状态**（`sessionIdGenerator: undefined`）。每个 HTTP 请求独立；服务端不维持 session id，客户端也无需回传 session id header。

> **注意（与本地 MCP 客户端的差异）**：虽然传输层无状态，但 MCP 协议本身仍要求每个**连接**先完成 `initialize` → `notifications/initialized` 握手，之后才能 `tools/call`。标准 MCP 客户端会自动做这件事；手写脚本时需自行发送该序列（见 §5 示例）。

### 安全边界（重要）

MCP **只暴露 28 个应用级（用户面）工具**。Agent 内部工具**完全不对外**：

| 已正确隐藏的内部 Agent 工具 | 说明 |
|---|---|
| `delegate_to_agent` | Chief Editor 调度子 agent（worldbuilder/character/outliner/director/writer） |
| `read_doc` / `write_doc` / `delete_doc` / `sync_index` | Agent 的存储与索引操作 |
| `load_skill` | Agent 按需加载技能 |

外部 MCP 客户端只能看到 Chief Editor 的对话回合结果。子 agent 的委派决策不会实时暴露，但**事后可通过 `list_delegation_messages` 读取转写**（见 §3）。`run_agent` 工具是 Chief Editor 的 **chat 边界**（对应 `POST /api/chat` SSE），不是子 agent 的直接入口。

---

## 2. 获取 API Token

Token 只能通过**浏览器登录态**创建（不能"用 token 造 token"——`tokens:manage` scope 设计上不可下放）。

### 方式 A：WebUI（推荐）

登录 `https://app.lingqiai.art` → 个人资料页 → **API Token / MCP** 区块 → 创建。明文 token **只显示一次**，请立即保存。

### 方式 B：调用 API（需浏览器登录态的 cookie）

创建 token 的接口（走 Web BFF，需登录 cookie，不是 Bearer）：

```bash
curl -X POST https://app.lingqiai.art/api/profile/tokens \
  -b "cookie: <你的登录 cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-mcp-token",
    "presets": ["read", "write", "agent:run"],
    "lifetimeDays": 90
  }'
```

- `presets`（推荐）：`read` / `write` / `agent:run`，可多选。每个 preset 展开为一组 scope。
- 或 `scopes`：精确指定 scope 数组（二者只能提供一个一）。
- `lifetimeDays`：30 / 90 / 365。

返回里含**明文 token**（仅此一次）：
```json
{ "id": "...", "token": "lingqi_4ltxpWhIlnVTJkjG_xxx...", "scopes": [...], "expiresAt": "..." }
```

其它管理接口（同样需登录 cookie）：
- `GET /api/profile/tokens` — 列出 token（不含明文）
- `DELETE /api/profile/tokens/:id` — 撤销 token

> **Token 格式**：`lingqi_<16 字符 publicId>_<43 字符 secret>`。服务端只存 secret 的 SHA-256 哈希，用 constant-time 比对。丢失只能撤销重建。

---

## 3. Scope 与工具权限

每个 MCP 工具要求特定 scope，token 必须具备才能调用。否则返回结构化工具错误 `SCOPE_REQUIRED: <scopes>`（`isError: true`，`content[0].text` 即该文案）。

### 三个 preset 展开的 scope

| Preset | 展开的 scope |
|---|---|
| `read` | `projects:read`, `documents:read`, `sessions:read`, `skills:read`, `billing:read` |
| `write` | `documents:write`, `documents:export`, `sessions:write` |
| `agent:run` | `agents:run` |

> `tokens:manage` 不可下放给任何 token。其余 scope 均可下放，但 preset 之外的能力（删除、项目生命周期、项目写入）需要用 `scopes` 数组**精确自定义**：
>
> - `delete_document` 需要 `documents:delete`（任何 preset 都不含它）
> - `create_project` / `update_project` 需要 `projects:write`
> - `set_project_status` 需要 `projects:lifecycle`

### 28 个工具及其所需 scope

**项目**

| 工具 | 所需 scope | 映射到的应用 API | 副作用 |
|---|---|---|---|
| `list_projects` | `projects:read` | `GET /api/projects?status=` | 无 |
| `get_project` | `projects:read` | `GET /api/projects/:id` | 无 |
| `create_project` | `projects:write` | `POST /api/projects`（免费账户上限 3 个项目） | **写** + 审计 |
| `update_project` | `projects:write` | `PATCH /api/projects/:id` | **写** + 审计 |
| `set_project_status` | `projects:lifecycle` | `POST /api/projects/:id/(archive\|trash\|restore)` | **写** + 审计 |
| `list_tasks` | `projects:read` | `GET /api/tasks?project_id=` | 无 |

**文档**

| 工具 | 所需 scope | 映射到的应用 API | 副作用 |
|---|---|---|---|
| `list_documents` | `documents:read` | `GET /api/documents/:pid[?type=]` | 无 |
| `read_document` | `documents:read` | `GET /api/documents/:pid/:path` | 无 |
| `write_document` | `documents:write` | `PUT /api/documents/:pid/:path`（乐观锁） | **写** + 审计 |
| `delete_document` | `documents:delete` | `DELETE /api/documents/:pid/:path`（连带索引与伏笔索引清理） | **删除** + 审计 |
| `export_document` | `documents:export` | `GET .../export/:format`（**会员功能**，非会员 403） | 审计 |
| `list_document_versions` | `documents:read` | `GET /api/documents/:pid/:path/versions` | 无 |
| `get_document_version` | `documents:read` | `GET /api/document-versions/:id` | 无 |
| `get_document_version_diff` | `documents:read` | `GET /api/document-versions/:id/diff` | 无 |

**会话**

| 工具 | 所需 scope | 映射到的应用 API | 副作用 |
|---|---|---|---|
| `list_sessions` | `sessions:read` | `GET /api/projects/:id/sessions` | 无 |
| `create_session` | `sessions:write` | `POST /api/projects/:id/sessions` | **写** |
| `list_session_messages` | `sessions:read` | `GET /api/sessions/:id/messages` | 无 |
| `rename_session` | `sessions:write` | `PATCH /api/sessions/:id` | **写** |
| `interrupt_session` | `sessions:write` | `POST /api/sessions/:id/interrupt` | **写** + 审计 |
| `set_session_status` | `sessions:write` | `POST /api/sessions/:id/(archive\|restore)` | **写** + 审计 |
| `list_delegation_messages` | `sessions:read` | `GET /api/sessions/:id/delegations/:callId/messages` | 无 |

**Agent 与其余**

| 工具 | 所需 scope | 映射到的应用 API | 副作用 |
|---|---|---|---|
| `run_agent` | `agents:run` | `POST /api/chat`（SSE，在 `turn_started` 时返回并释放连接） | **写 + 消耗额度** + 审计 |
| `respond_interaction` | `agents:run` | `POST /api/chat`（`interaction_response` 信封，开启新回合） | **写 + 消耗额度** + 审计 |
| `list_pending_interactions` | `sessions:read` | 扫描 `/api/sessions/:id/messages?limit=100` | 无 |
| `get_agent_run` | `sessions:read` | 扫描 `/api/sessions/:id/messages?limit=100` | 无 |
| `get_credit_summary` | `billing:read` | `GET /api/credits/summary` | 无 |
| `list_models` | `billing:read` | `GET /api/models` | 无 |
| `list_skills` | `skills:read` | `GET /api/skills` | 无 |

---

## 4. 限流与审计

- **总请求**：120 次 / 60 秒 / token。超限 → `429 { error: "RATE_LIMITED", retryable: true }`。
- **agent 运行**：10 次 / 60 秒 / token（额外限制，作用于 `run_agent` 与 `respond_interaction`）。
- **审计**：`write_document` / `delete_document` / `export_document` / `run_agent` / `respond_interaction` / `interrupt_session` / `set_session_status` / `create_project` / `update_project` / `set_project_status` 会写入 `novel.api_audit_events`（当服务端配了 `JWT_SECRET` 时）。可在 InsForge Dashboard 查阅。

### 错误语义（重要）

工具内的失败**不会**抛 JSON-RPC 协议错误，而是返回 `isError: true` 的工具结果，且 `structuredContent` 携带上游完整结构化负载（HTTP status、错误码、以及冲突内容等附加字段）；`content[0].text` 是同一负载的 JSON 字符串。Scope 不足同样是工具错误：`SCOPE_REQUIRED: <scopes>`。

### 应用层错误码速查

| status | `error` 字段 | 含义 / 处置 |
|---|---|---|
| 400 | `INVALID_CHAT_INPUT` | `run_agent` 缺 message/command，或参数不合法 |
| 403 | `MEMBERSHIP_REQUIRED` | 会员功能（导出、高级模型）对非会员关闭 |
| 403 | `PROJECT_LIMIT_REACHED` | 免费账户最多 3 个项目 |
| 403 | `FORBIDDEN` | 项目不属于该 token 用户 |
| 404 | `DOCUMENT_VERSION_NOT_FOUND` | 版本 id 不存在 |
| 409 | `DOCUMENT_CONFLICT` | 乐观锁冲突；**负载里带当前 `content` 与 `hash`**，可直接重读重写 |
| 409 | `DOCUMENT_DIFF_UNAVAILABLE` | 版本 diff 暂不可用；`repairable: true` 表示服务端可修复 |
| 409 | `PROJECT_READ_ONLY` | 项目处于归档/回收站状态，禁止写作回合 |
| 409 | `SESSION_*`（如 `SESSION_BUSY`） | 会话状态冲突（如有回合正在进行） |
| 413 | `INTERACTION_CONFLICT` | 交互回应超过 16KB 上限 |

### 传输层错误码速查

| HTTP | `error` 字段 | 含义 |
|---|---|---|
| 401 | `AUTH_INVALID` | token 缺失 / 无效 / 过期 / 已撤销 |
| 404 | `Not found` | 路径非 `/mcp` 或 `/health` |
| 405 | `Method not allowed` | `/mcp` 只接受 GET / POST / DELETE |
| 429 | `RATE_LIMITED` | 触发限流（带 `retryable: true`） |
| 500 | `INTERNAL_ERROR` | 服务端异常 |

---

## 5. 实操示例

### 5.1 手写 curl（JSON-RPC）

**初始化握手**（每个连接先做一次）：

```bash
TOKEN='lingqi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
BASE='https://app.lingqiai.art'

curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{
      "protocolVersion":"2025-06-18",
      "capabilities":{},
      "clientInfo":{"name":"my-client","version":"0.0.1"}
    }
  }'
# → event: message
#   data: {"result":{"protocolVersion":"2025-06-18",...,"serverInfo":{"name":"novel-vibe","version":"0.1.0"}},...}
```

**列出工具**：

```bash
curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

**调用工具**（例：列出项目）：

```bash
curl -sS -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"list_projects","arguments":{"status":"active"}}
  }'
```

响应格式（SSE 帧，取最后一行 `data:`）：
```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"projects\":[...]}"}],"structuredContent":{...}},"jsonrpc":"2.0","id":3}
```

> 工具结果同时给出 `content`（人类可读 JSON 字符串）和 `structuredContent`（结构化对象），客户端可任取其一。失败时 `isError: true`，负载同样结构化。

### 5.2 典型工作流（read → write → agent）

```bash
PID='f042718f-747f-4e9f-8ed1-dbee4739b40a'   # 某个项目 id

# 1) 看这个项目有哪些文档
curl ... -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
  "name":"list_documents","arguments":{"projectId":"'$PID'"}}}'

# 2) 读世界观设定
curl ... -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
  "name":"read_document","arguments":{
    "projectId":"'$PID'","path":"worldview/world-setting.md"}}}'

# 3) 写回（需先读出当前 checksum 作 baseHash，乐观并发）
curl ... -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{
  "name":"write_document","arguments":{
    "projectId":"'$PID'","path":"worldview/world-setting.md",
    "content":"---\\ntype: worldview\\n...\\n---\\n# ...",
    "baseHash":"faf8c287b6b35f4c"}}}'   # baseHash = list_documents 返回的 checksum

# 4) 让 Chief Editor 干活：先建会话，再 run_agent
curl ... -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{
  "name":"create_session","arguments":{"projectId":"'$PID'"}}}'
# 假设返回 sessionId = SID
curl ... -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{
  "name":"run_agent","arguments":{
    "projectId":"'$PID'","sessionId":"'$SID'",
    "message":"把第三章的开头改得更紧张一点"}}}'
# 返回 { turn_id, assistant_message_id, session_id }；agent 在后台异步执行
# run_agent 只等 turn_started 就返回；失败（如会员门控、余额不足）会在
# 结果里直接给出服务端原因，例如 403 MEMBERSHIP_REQUIRED / 余额提示文案。

# 5) 轮询 agent 结果
curl ... -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{
  "name":"get_agent_run","arguments":{
    "sessionId":"'$SID'","assistantMessageId":"<上一步返回的 id>"}}}'
# 未完成返回 { id, status:"running" }；完成后返回该 assistant message
# （status 可能是 running / complete / failed / interrupted）
```

> **关于 `write_document` 的 `baseHash`**：它是乐观锁。先用 `list_documents` 拿到文档的 `checksum`，作为 `baseHash` 传入；若期间被改动，返回 409 `DOCUMENT_CONFLICT`，且负载里带当前 `content` 与 `hash`——合并后用新 hash 重写即可。

### 5.3 交互回路（编辑提问 → 回答）

Chief Editor 常以"提问"结束回合（例如让用户在多个剧情走向中选择）。自动化脚本若不处理，会停在原地：

```bash
# 1) 列出最近窗口内未回答的交互问题
curl ... -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{
  "name":"list_pending_interactions","arguments":{"sessionId":"'$SID'"}}}'
# → { interactions: [{ id, assistantMessageId, status:"pending", request:{...} }] }

# 2) 回答（开启一个新回合，消耗额度）
curl ... -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{
  "name":"respond_interaction","arguments":{
    "projectId":"'$PID'","sessionId":"'$SID'",
    "interactionId":"<上一步的 id>",
    "answers":[{"fieldId":"plot-choice","type":"radio","value":"option-2"}]}}}'

# 3) 继续用 get_agent_run / list_session_messages 轮询新回合
```

`answers` 的形状：`{ fieldId, type: "radio"|"text"|"textarea", value: string }` 或 `{ fieldId, type: "checkbox", value: string[] }`；`request` 字段里是问题原文与选项，字段含义以问题内容为准。

### 5.4 版本审计（谁改了什么）

```bash
# 列出某文档的版本历史（新→旧，游标分页）
curl ... -d '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{
  "name":"list_document_versions","arguments":{
    "projectId":"'$PID'","path":"chapters/vol1/ch005.md","limit":10}}}'

# 看某个版本的 diff（分页）
curl ... -d '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{
  "name":"get_document_version_diff","arguments":{"versionId":"<id>"}}}'
```

### 5.5 接入 MCP 客户端

**Claude Desktop / Cursor / zcode 等**（标准 Streamable HTTP 配置）：

```json
{
  "mcpServers": {
    "novel-vibe": {
      "url": "https://app.lingqiai.art/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer lingqi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

接入后客户端会自动完成 `initialize` 握手并拉取 `tools/list`，你即可在对话里直接说"列出我的小说项目""读一下修仙大师的世界观""让编辑给第五章加个伏笔"等自然语言指令。

### 5.6 接入 WorkBuddy / CodeBuddy（stdio 型客户端）

WorkBuddy 的 MCP 配置是标准 `mcpServers` JSON，但按官方文档形态只直接支持 **stdio 型**（`command` / `args` / `env`，如 `uvx` / `npx` 启动本地进程），没有远程 URL + header 的配置项。用社区标准的 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) 桥接即可接入我们的远程端点——它作为本地 stdio 进程运行，把 MCP 流量转发到远程 Streamable HTTP 服务并附加鉴权头。

**步骤**（前提：本机已安装 Node.js / npx）：

1. 按 §2 创建你的 API token（至少勾 `read` + `agent:run` preset）。
2. 打开 WorkBuddy → 侧边栏**插件** → 右上角 **MCP 服务器** → **配置 MCP**，把以下内容写入（用户级配置文件路径 `~/.workbuddy/mcp.json`，全项目生效）：

```json
{
  "mcpServers": {
    "novel-vibe": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "https://app.lingqiai.art/mcp",
        "--header", "Authorization: Bearer lingqi_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      ]
    }
  }
}
```

3. 保存后观察服务器状态灯：**绿色** = 桥接与鉴权成功；红色 = 检查 token 是否有效、npx 是否可用（在终端跑 `npx -y mcp-remote https://app.lingqiai.art/mcp --header "Authorization: Bearer <你的token>"` 看握手输出可快速定位）。

说明：

- token 决定可见工具：只有 `read` preset 时只看到读类工具；要 `run_agent` / `respond_interaction` 需勾 `agent:run`（见 §3 的 scope 表）。
- 首次连接 `npx` 会下载 `mcp-remote` 包，状态灯可能延迟几秒变绿。
- CodeBuddy IDE 同理；若你的客户端版本支持远程 URL 型配置，直接用 §5.5 的配置更轻，无需本地进程。
- 把上面配置片段（去掉你的 token）分享给其他 WorkBuddy 用户，对方换成自己的 token 即可接入——这是目前让"所有人可用"的标准分发方式：WorkBuddy 连接器尚无第三方上架渠道，自定义连接器均为用户自用（见 §7 误区 8）。

---

## 6. 健康检查与排障

- **服务健康**：`GET https://app.lingqiai.art/health` → `{"status":"ok","service":"novel-web"}`（BFF 层，非 MCP）。
- **MCP 是否路由到**：`POST /mcp` 返回 JSON-RPC（而非 HTML 405）即说明 nginx → MCP 链路通。
- **token 是否有效**：发一个 `initialize`；401 = 无效，200 = 有效。
- **scope 是否够**：调用报 `SCOPE_REQUIRED: <scopes>` 即说明 token 缺该 scope，去 WebUI 重建 token 勾上对应 preset（删除与项目生命周期类能力需自定义 `scopes` 数组）。
- **域名打不开（`webblock` 重定向）**：`app.lingqiai.art` 在腾讯云侧若被重定向到 `dnspod.qcloud.com/static/webblock.html`，是域名/备案层面问题，与本应用无关——检查域名解析与备案状态。
- **本地开发**：MCP 服务监听 `NOVEL_VIBE_MCP_PORT`（默认 7150），仅容器内/本机可达，不对外发布端口；外部只能经 nginx `/mcp` 访问。本地跑 e2e：全栈起好后 `MCP_API_TOKEN=lingqi_... npm run test:e2e:mcp`。

---

## 7. 常见误区

1. **"为什么 `tools/list` 里有 `run_agent`？"** —— 它是 Chief Editor 的 chat 边界，不是子 agent 入口。子 agent 的 `delegate_to_agent` / `read_doc` 等内部工具**不会**出现在列表里；子 agent 的执行过程只能事后经 `list_delegation_messages`（sessions:read）读取转写。
2. **"握手过了为什么 `tools/call` 还 400？"** —— 无状态传输下，仍需在同一连接序列里先发 `notifications/initialized`。标准客户端自动处理；手写脚本要补上（见 §5.1 的顺序）。
3. **"能不能用 MCP token 创建新 token？"** —— 不能。`tokens:manage` 不可下放，只能用浏览器登录态管理 token。
4. **"`get_agent_run` 一直返回 `running`？"** —— 它扫描最近 100 条 display message；长会话里目标消息可能被推出窗口，此时返回 `running`（合法状态）而非伪造结果。可用 `list_session_messages` 翻页确认。
5. **"自动化跑到一半不动了？"** —— 多半是 Chief Editor 发起了交互提问。用 `list_pending_interactions` 查看，用 `respond_interaction` 回答；不回答回合不会自己继续。
6. **"`run_agent` 报错但没有细节？"** —— 现在错误负载是结构化的（会员门控、余额不足、免费模型限额等原因都在 `structuredContent` 里）。若仍见笼统文案，确认服务端已升级到含 `run_failed` 透传的版本。
7. **"`delete_document` 报 `SCOPE_REQUIRED`？"** —— `documents:delete` 不在任何 preset 里，需要创建 token 时用自定义 `scopes` 数组显式勾选。这是有意设计：外部 token 默认无删除权。
8. **"能不能把 Novel Vibe 发布到 WorkBuddy 连接器市场/腾讯云 MCP 广场，让所有人一键安装？"** —— 目前不能。WorkBuddy 连接器只有官方内置（QQ 邮箱、腾讯文档等）与用户自用的自定义连接器两类，无第三方上架入口；WorkBuddy 文档指向的[腾讯云 MCP 广场](https://cloud.tencent.com/developer/mcp)也已声明"针对第三方 MCP 产品，目前暂不提供上架与更新服务"。现行的"所有人可用"方式即 §5.6：分享 mcp-remote 桥接配置片段，各用户填自己的 token。
