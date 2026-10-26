# agent-observatory 支持更多主流 Harness：调研与评估

日期：2026-10-26 · 范围：Token 统计（Token 页 / 实时流速 / 明细·Harness 维度 / 看板）可接入的本机 CLI harness 会话日志
方法：本机实证（WSL2，`~/.claude` `~/.codex` `~/.grok` `~/.pi` `~/.omp` `~/.opencode` `~/.codebuddy` `~/.qoder` `~/.gemini` `~/.qwen` `~/.cursor` `~/.kimi` `~/.iflow` `~/.factory` `~/.copilot` `~/.config/goose` `~/.trae`）+ 7 路并行一手来源调研（官方文档/源码/发布说明优先，社区逆向工具佐证）。每条事实标注来源级别：**本地实证**（本机文件/二进制 strings 提取）＞ **官方**（文档/源码）＞ **社区**（第三方逆向，多源一致才采信）。

---

## 1. 结论速览

| 优先级 | Harness | 用量数据 | 粒度 | 工作量 | 一句话结论 |
|---|---|---|---|---|---|
| **T0** | oh-my-pi（omp） | 五分类+cost，与 Pi 逐字段同构 | per-call | **S（≈0.5–1 天）** | 复用 Pi 解析器，只加一个日志根 |
| **T0** | OpenCode | 五分类+cost（官方 schema） | per-call | **M–L（3–5 天）** | 字段最全；但 v1.2.0 起迁 SQLite，需双后端 |
| **T1** | CodeBuddy Code | 五分类（两种写法并存） | per-call | **M（2–3 天）** | Claude 风格 JSONL，官方文档目录/env |
| **T1** | Qoder CLI | 五分类（Credits 计价，无 USD cost） | per-call | **M（2–4 天）** | 可行但脆：每日发版、JSONL+聚合双形态 |
| **T1** | Gemini CLI | 五分类（无 cost） | per-call | **M（2–4 天）** | 新版消息带 `tokens`；新旧两代格式并存 |
| **T1** | Qwen Code | 五分类（无 cost） | per-call | **M（2–3 天）** | 官方 JSONL+`usageMetadata`，证据最全 |
| **T2** | GitHub Copilot CLI | 五分类+精确 AIU credit | per-call | **M（2–3 天）** | SQLite `assistant_usage_events` 齐全，schema 未承诺稳定 |
| **T2** | Goose | 五分类+cost（字段最规整） | per-call | **M（2 天）** | `usage_ledger` 表完美；用户面较窄 |
| **T2** | Factory Droid | 五分类无 cost | **per-session** | **M（2–3 天）** | usage 在 sidecar JSON，闭源无 schema 承诺 |
| **T2** | Kimi Code CLI | 待实测 | 待实测 | **M–L** | 两代布局（Python→Rust），usage 形状未证实 |
| 不做 | Cursor CLI | **无 usage 字段** | — | — | blobs+protobuf，逆向无收益 |
| 不做 | iFlow CLI | — | — | — | **官方 2026-04-17 停服**，引导迁 Qoder |
| 不做 | Amp | 字段好但本地目录已废弃 | — | — | 现版本 server-authoritative，仅外部 API |
| 不做 | Aider | 默认不落盘 usage | — | — | 需用户显式开 `--analytics-log` |
| 不做 | Trae | IDE 主库 SQLCipher 加密 | — | — | trae-agent 仅可选 trajectory 文件 |
| 不做 | Amazon Q / Kiro CLI | 只能估算 | — | — | schema 漂移高风险 |

改动面是「按源线性扩展」的：每加一个源触及同一组文件（见 §2），无跨源耦合。**SQLite 是唯一新增的基础设施**，本机已验证可行（§2.2）。

---

## 2. 插件侧扩展点（代码事实）

### 2.1 每新增一个 `TokenSource` 的完整改动面

| 文件 | 改动 |
|---|---|
| `shared/tokens.ts` | `TOKEN_SOURCES` 并集 + `tokenSourceNames` 显示名 |
| `server/tokens/roots.ts` | `CONFIG_ENV[TokenSource]`：迁移变量名（按生效顺序）+ 默认目录 `standard(home)`；ACP 包装识别（需要时）加 `ACP_COMMANDS` |
| `server/tokens/parser.ts` | `initialParser` 的 sessionId 分支、`parseLine` 分派、新 parse 函数（模板：`parsePiLine` JSONL / `parseGrokUsage` 整读 JSON） |
| `server/tokens/ingester.ts` | 扫描模式分支（`root.source === "grok" ? scanGrok() : walk()`）；消失文件识别的源特判 |
| `server/tokens/reader.ts` | 增量 offset 读 vs 整文件重读（Grok 先例） |
| `server/tokens/live.ts`、`data.ts` | 仅当源无响应时间戳时需要特判（grok 先例：不参与输出速率） |
| `server/tokens/persistence.ts` | 账本 `source` 是 `z.enum(TOKEN_SOURCES)`——**加源必须 bump 账本版本**（2.14 先例：旧账本隔离、全量重导一次） |
| `client/token-board.tsx` | `sourceHues` 颜色映射 |
| `preview/tokens-fixture.js` | fixtures |
| `tests/tokens-*.test.ts` | 每源一组：parser / roots / ingestion / coverage |

不需要新增 locales 键：源显示名走 `tokenSourceNames`（代码侧），覆盖行/明细等文案是占位符复用。

### 2.2 SQLite 前提：已验证可用

- Paseo daemon 跑在 **Node v24.14.1**（本机 `paseo` → nvm node）；本机实测 `require("node:sqlite")` 返回 `DatabaseSync/StatementSync/backup`（实验警告，功能可用）。
- 结论：OpenCode（`opencode.db`）、Copilot CLI（`session-store.db`）、Goose（`sessions.db`）三类 SQLite 源可**零原生依赖**接入；插件无需引入 better-sqlite3 这类跨平台 native 包。
- 需要新的读法（与现有 offset 增量不同）：只读打开（immutable/只读连接，避开 WAL 写锁）+ 行级水位（时间戳/自增 id）+ 复用 `callKey` 去重。`node:sqlite` 仍标实验，**升级 Node 大版本时需回归**（风险 §5）。

### 2.3 自定义 Provider 自动发现的顺带收益

`roots.ts` 的 provider 发现（daemon 环境 → provider `env` → 命令行 → 启动脚本字面赋值）目前只认 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME`/`PI_CODING_AGENT_*`。每接入一个源，把它的目录变量加进 `CONFIG_ENV` 即可让 Paseo 托管的同名 ACP Provider 自动被发现（本机 `~/.paseo/opencode-home/` 已存在，即 daemon 给 opencode 型 Provider 备的隔离 home，目前为空）。

---

## 3. 各 Harness 详细档案

标记：✔=本地实证，📄=官方文档/源码，👥=社区逆向。

### 3.1 oh-my-pi（omp）— T0，工作量 S

- **身份**：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，Pi（badlogic/pi-mono，现 earendil-works/pi）的增强 fork；与上游同步点 2026-03-22（📄 [porting 文档](https://github.com/can1357/oh-my-pi/blob/main/docs/porting-from-pi-mono.md)）。
- **路径**：`~/.omp/agent/sessions/<encoded-cwd>/<ts>_<sessionId>.jsonl` ✔（本机 4.0 GB 真实日志）。迁移变量沿用 Pi 的：`PI_CONFIG_DIR`（home 下根名，默认 `.omp`）、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` ✔（本机 `strings ~/.bun/bin/omp` 提取到 13+5 处引用；📄 [environment-variables.md](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md)）。
- **格式**：JSONL 追加，`{"type":"session","version":3,...}` header，assistant 行 `usage:{input,output,cacheRead,cacheWrite,totalTokens,cost:{input,output,cacheRead,cacheWrite,total}}`——与现有 Pi 解析器消费的字段**逐字段一致** ✔。差异：文件头多一个 **256 字节定宽 `type:"title"` 槽位**（现有 `parsePiLine` 按 `row.type` 分派，未知类型自然忽略，兼容）；另有 `model_usage` entry（标题生成等非转录调用，带 usage，可计）与 `compaction` entry（📄 [session.md](https://github.com/can1357/oh-my-pi/blob/main/docs/session.md)，官方把它定为格式契约文档）。
- **元数据**：model ✔、header `cwd` ✔、header `parentSession`（子代理/fork 关联）✔。
- **注意**：`~/.omp/agent/agent.db` 是凭据库（不解析）；`omp stats` 的 `stats.db` 是派生缓存（不依赖）。目录桶名经历过哈希桶→路径编码的回滚（17.2.x，#7397），扫描按 `.jsonl` 文件名模式（现有 `piSessionId` 已按 `<ts>_<id>.jsonl` 解析）即可，不依赖桶名。
- **做法**：`TOKEN_SOURCES` 加 `omp`（显示名 "oh-my-pi"，横评/明细与 Pi 区分）；`CONFIG_ENV` 加 `PI_CONFIG_DIR`→`$PI_CONFIG_DIR/agent/sessions`（standard：`~/.omp/agent/sessions`）；解析复用 `parsePiLine`（`file.source` 传参化）。[INFERENCE] 工作量 0.5–1 天含测试。
- **决策点**：独立 source（推荐，Harness 维度可分）vs 并入 `pi` 显示（省一个源，但 Pi 用户与 omp 用户混合统计）。

### 3.2 OpenCode — T0，工作量 M–L

- **路径**：旧布局 `~/.local/share/opencode/storage/{session,message,part,project}` 每实体一分片 JSON ✔（本机 2375 个 message 文件）；**v1.2.0（2026-02-14）起全部迁入 `~/.local/share/opencode/opencode.db`（SQLite/WAL）**（📄 [Release v1.2.0](https://github.com/anomalyco/opencode/releases/tag/v1.2.0)，仓库迁至 anomalyco/opencode）。数据目录跟随 `XDG_DATA_HOME` ✔（二进制 strings 有 9 处；📄）；`OPENCODE_CONFIG_DIR` ✔；`OPENCODE_DATA_DIR` 是社区推进中（👥 [issue #8968](https://github.com/anomalyco/opencode/issues/8968)，ccusage 已支持读它）。
- **usage 字段**（📄 [schema v1/session.ts](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/v1/session.ts)）：assistant 消息 `tokens:{input,output,reasoning,cache:{read,write}}` + `cost`（models.dev 价格表自算的 USD 估算）+ `modelID/providerID` + `time:{created,completed}` + `path.cwd` ✔（本机样例逐字段吻合：gemini-3-flash-preview，cost 0.0072653）。
- **子代理**：独立 session + `session.parent_id` + 消息 `parentID`（📄 [tool/task.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts)）。项目归属：`storage/project/*.json` 的 `worktree` 字段 ✔。
- **工作量所在**：双后端——SQLite（`session`/`message` 表，`data` 列 JSON blob）+ legacy 分片 JSON（一消息一文件，文件数多但小）；迁移有已知缺陷（增量升级用户可能被跳迁，👥 [#13654](https://github.com/anomalyco/opencode/issues/13654)、[#36178](https://github.com/anomalyco/opencode/issues/36178)），两代数据可能并存。ccusage `opencode` 源（Beta）已趟平同一路径（👥 [ccusage opencode 指南](https://ccusage.com/guide/opencode)）。
- **结论**：字段最全、社区有先例；主要成本是 SQLite 读法 + 双后端兜底。[INFERENCE] 3–5 天。

### 3.3 CodeBuddy Code（腾讯）— T1，工作量 M

- **路径**：`~/.codebuddy/projects/<cwd-slug>/<session-uuid>.jsonl` ✔；官方文档化了 `.codebuddy` 目录树与 `<parentSessionId>/subagents/agent-<id>.jsonl`（📄 [codebuddy-dir](https://www.codebuddy.ai/docs/cli/codebuddy-dir)、[sub-agents](https://www.codebuddy.ai/docs/cli/sub-agents)）；`CODEBUDDY_CONFIG_DIR` 迁移 ✔（本机包体 strings 79 处引用；📄 [env-vars](https://www.codebuddy.ai/docs/cli/env-vars)）。包名 `@tencent-ai/codebuddy-code` ✔。
- **格式**：JSONL 追加。本机实证两种 usage 写法**同文件并存**：`{"usage":{"requests":1,"inputTokens":…,"outputTokens":…,"totalTokens":…,"inputTokensDetails":[{"cached_tokens":…}]}}`（OpenAI 风格）与 `{"usage":{"input_tokens":…,"output_tokens":…,"cache_read_input_tokens":…,"cache_creation_input_tokens":…}}`（Claude 风格）；`session-meta` 行 + `type:"message"` 行；`model` 字段 ✔（本机样例 deepseek-v4.1-flash；官方多场景模型意味着同会话多模型，需按消息取）。会话子目录含 `subagents/`、`tool-results/` ✔（大工具输出外置指针，📄）。
- **元数据**：cwd 由项目目录名派生 ✔；每行毫秒 `timestamp` ✔。
- **生态**：社区解析器 tokmesh-core 有专门 `parse_codebuddy_file`（👥）；ccusage 尚未支持。
- **结论**：与 Claude 解析器同构，主要工作是多 usage 形态兼容 + subagents 树。无官方 schema 保证是主要风险。[INFERENCE] 2–3 天。

### 3.4 Qoder CLI（阿里）— T1，工作量 M

- **路径**：`~/.qoder/projects/<slug>/<session>.jsonl`（📄 [docs.qoder.com/cli/sessions](https://docs.qoder.com/cli/sessions)）✔ 本机有 9 个；另有 `<uuid>-session.json` 明文聚合（`prompt_tokens/completion_tokens/cost/total_prompt_tokens/total_completed_tokens/total_cached_tokens/working_dir/message_count` ✔，官方未文档化）与 `<uuid>/state.json`（blob 疑加密 ✔，**不可作数据源**）；`logs/runs/<ts>/manifest.json`（`cwd/project_id/cli_version` ✔，日志保留 30 天 📄）。`QODER_CONFIG_DIR` 迁移（📄；CN 版默认 `~/.qoder-cn`）。
- **usage**：JSONL per-call `message.usage` 含 input/output/cache creation/cache read（👥 [GrayXu/ccusage-qoder](https://github.com/GrayXu/ccusage-qoder) 逆向，ccusage fork 已实现 daily 统计）；官方计量单位是 **Credits**（📄 [cost-usage](https://docs.qoder.com/cli/sdk/cost-usage)），无 USD cost；官方 SDK 文档确认每 assistant 消息携带 request 级 usage + 子代理 transcript `subagents/agent-<id>`（📄）。本机 2026-08 旧样例 JSONL 无 usage 行（全为报错会话）——字段真实性以新版+ccusage-qoder 双重佐证，接入前先用本机新会话采样验证。
- **元数据**：JSONL 首部 `workspace-directories`（cwd ✔）、`runtime-config`（model ✔）；逐条 `timestamp` ✔。
- **风险**：1.1.x 近乎每日发版（10-13→10-23 七个版本），落盘形态出现过代际差；建议「JSONL 优先、`-session.json` 聚合兜底、字段缺失降级」。iFlow 官方停服迁 Qoder（见 §3.12），Qoder 是国内增量最大的源之一。[INFERENCE] 2–4 天。

### 3.5 Gemini CLI — T1，工作量 M

- **路径**：`~/.gemini/tmp/<projectHash>/chats/session-*` ✔（本机 37 份）；`projectHash` = cwd 绝对路径的 SHA-256（📄 [paths.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/paths.ts)）——可正算反查项目；v0.60+ 另有 `~/.gemini/projects.json` 映射（👥）。迁移变量 `GEMINI_CLI_HOME`（📄 [configuration.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md)）。
- **usage**：**新版每条 gemini 消息写 `tokens:{input,output,cached,thoughts,tool,total}`**（📄 `ChatRecordingService.recordMessageTokens`，[chatRecordingTypes.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)）；无 cost。本机 37 份全是旧代际单 JSON、无 usage 字段 ✔——旧代际**无数据可统计**，只支持新版。
- **格式代际**：单 JSON 整写 → **JSONL 追加流**（首行 metadata，`$set`/`$patch`/`$rewindTo` 控制行，原子写，📄 [chatRecordingService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts)）；stable v0.65（2026-10），迭代快。ccusage 已官方支持 Gemini CLI 双代际（👥 [ccusage gemini](http://ccusage.com/guide/gemini)）。
- **结论**：可行，但只覆盖新版；需双代际识别 + 磁盘上按 hash 目录聚合项目。[INFERENCE] 2–4 天。

### 3.6 Qwen Code — T1，工作量 M

- **路径**：`~/.qwen/projects/<sanitized-cwd>/chats/<uuid>.jsonl`（📄 [Headless Mode](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)）✔ 本机实证为 JSONL（`uuid/parentUuid/sessionId/timestamp/type/cwd/version`，Claude Code 同构头）；旧版 `tmp/<hash>/` 已弃。`QWEN_RUNTIME_DIR` 重定向 `tmp/`、`projects/` 等（📄 官方 SKILL.md）。
- **usage**：`usageMetadata:{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,cachedContentTokenCount,totalTokenCount}` per-call，含 cache read 与 thinking（📄 [chatRecordingService.ts](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/services/chatRecordingService.ts) 引入 GenerateContentResponseUsageMetadata + 👥 解析样例）；无 cost。本机样例文件未见 usage 行（旧版本/低用量），接入前采样验证。模型：`qwen sessions list --json` 含 cwd/startTime/模型（📄）。
- **结论**：四家国产里证据最全；格式 2026 仍在快速演进，需容忍字段增减。[INFERENCE] 2–3 天。

### 3.7 GitHub Copilot CLI — T2，工作量 M

- **路径**：`~/.copilot/session-store.db`（SQLite/WAL ✔ 本机；📄 [官方 config 参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)）+ `~/.copilot/session-state/<id>/events.jsonl`；`COPILOT_HOME` 迁移（📄）。
- **usage**：`assistant_usage_events` 每 API 请求一行：input（**cache-inclusive**，需拆分）、cache_read、cache_write、reasoning、output、`total_nano_aiu`（精确 credit）、`request_multiplier`（👥 [codeburn copilot.md](https://github.com/getagentseal/codeburn/blob/main/docs/providers/copilot.md) 实测 1.0.80–1.0.85；官方仅说 usage 表「随会话增量写入」，schema 不承诺稳定）。本机库 `turns`/`assistant_usage_events` 为 0 行（旧版/低用量），接入前采样。
- **结论**：数据质量高；风险是 schema 未官方化 + VS Code agent-host 会话不写逐请求行（只有 shutdown rollup）。[INFERENCE] 2–3 天。

### 3.8 Goose — T2，工作量 M

- **路径**：`$XDG_DATA_HOME/goose/sessions/sessions.db`（默认 `~/.local/share/goose/sessions/`）✔ 本机实证；`GOOSE_PATH_ROOT` 迁移（👥；📄 [logs.md](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/logs.md)）。
- **usage**：≥1.10.0 SQLite 的 `usage_ledger` 表：`session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction`——per-request 行，五分类+cost 全（👥 多源一致：[ccusage goose](https://ccusage.com/guide/goose)、ClawMetry）；旧 JSONL（首行 session meta 含 `working_dir`）迁移后留存。
- **结论**：字段是所有候选里最规整的；但用户面小于 opencode/gemini，排 T2。[INFERENCE] 2 天。

### 3.9 Factory Droid — T2，工作量 M

- **路径**：`~/.factory/sessions/<projectKey>/<sessionId>.jsonl` + 同名 `.settings.json` sidecar（👥 [DoubleAgent](https://github.com/seanthegeek/doubleagent/blob/main/research/factory-droid.md)、openusage；`FACTORY_HOME_OVERRIDE` 迁移；另有索引 `~/.factory/cache/session-index/index.db`）。本机 `sessions/` 为空（未重度使用），无法实证字段。
- **usage**：`.settings.json` 的 `tokenUsage:{inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,thinkingTokens}`——**per-session 聚合**、会话结束时写入；无 cost。JSONL 内多行共享 `message.id`，per-call 需去重取最大行（👥 entire-cli transcript.go）。
- **结论**：session 级五分类可靠；per-call 粒度弱于其他家（实时流速/每轮归因受限），闭源无 schema 承诺。[INFERENCE] 2–3 天。

### 3.10 Kimi Code CLI（MoonshotAI）— T2，工作量 M–L

- **路径**：旧 kimi-cli `~/.kimi/sessions/<workDirMD5>/<sessionId>/{context.jsonl,wire.jsonl,state.json}` + `subagents/<id>/`（📄 [data-locations](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/configuration/data-locations.md)）；**已改名 Kimi Code CLI（Rust 重写），迁 `~/.kimi-code/`，变量 `KIMI_CODE_HOME`，提供 `kimi migrate`**（📄 [新版文档](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)）。
- **usage**：官方文档确认 context.jsonl 内有含 token usage 的内部记录行，但字段形状未列出（部分未证实）；本机旧版 wire.jsonl 全空 ✔。
- **结论**：需两代布局兼容 + 实测采样，投入产出比低于 T1。[INFERENCE] 3–5 天。

### 3.11 明确不做（及理由）

| Harness | 理由 |
|---|---|
| **Cursor CLI** | `~/.cursor/chats/<md5>/<uuid>/store.db` 每会话一 SQLite，表只有 `blobs(sha256, BLOB)`+`meta`，消息 JSON 无 usage（👥 txcript 明确 "usage never present"），¼ blob 是未公开 protobuf；token 统计无从谈起 |
| **iFlow CLI** | 官方 **2026-04-17 停服**引导迁 Qoder（📄 [cli.iflow.cn](https://cli.iflow.cn/)）；本机残留会话 usage 全 0 ✔。若用户仍有旧日志且想要历史统计，可复用 Claude 解析器读 `~/.iflow/projects`，但不应投入正式支持 |
| **Amp** | `~/.local/share/amp/threads/T-*.json` 字段好（per-message 五分类+credits），但现版本 server-authoritative、本地目录不再写入（👥 txcript 二分验证）；接入只能走外部 API（网络方案，超出本插件「读本机日志」的边界） |
| **Aider** | 默认只写 Markdown 历史，无 token；需用户显式 `--analytics-log` 才有 per-message usage（📄 [options](https://aider.chat/docs/config/options.html)）——不适合做默认数据源 |
| **Trae** | TRAE IDE 对话主库是 SQLCipher-4 加密 SQLite（👥 论坛逆向）；trae-agent 仅在显式产出 trajectory JSON 时有五分类 usage（📄 [TRAJECTORY_RECORDING.md](https://github.com/bytedance/trae-agent/blob/main/docs/TRAJECTORY_RECORDING.md)），任务级产物非常驻日志 |
| **Amazon Q / Kiro CLI** | token 常缺、社区只能用 context 百分比×窗口估算（👥 openusage，schema confidence LOW） |

---

## 4. 工作量汇总与排序建议

| 批次 | 内容 | 估算 [INFERENCE] | 依赖/前置 |
|---|---|---|---|
| 1 | `omp` 源（复用 Pi 解析器） | 0.5–1 天 | 无；先做决策点：独立 source or 并入 pi |
| 2 | SQLite 读取基建 spike + **OpenCode** | 3–5 天 | `node:sqlite` 已验证可用；水位去重 + WAL 只读 |
| 3 | CodeBuddy、Qoder | 4–7 天 | 各需先本机采样新版 usage 行 |
| 4 | Gemini CLI、Qwen Code | 4–7 天 | Gemini 需双代际识别（只统计新版） |
| 5 | Copilot、Goose（SQLite 复用批次 2 基建） | 4–5 天 | 复用批次 2 |
| 6 | Droid、Kimi（可选） | 5–8 天 | 收益打折，按需 |

通用注意：
- **账本版本一次 bump 带全所有新源**（`persistence.ts`），避免多次全量重导。
- 上限预算复算：当前 2 万日志/64 GB/75 万去重键对新增 6–8 个源仍然充足（opencode 一消息一文件的 legacy 后端文件数偏多，注意 `TOKEN_IMPORT_LIMITS.files` 与扫描条目上限）。
- 每个新源配「真实日志切片」测试夹具（现有 `tokens-grok-pi.test.ts` 模式），并留格式探针：解析失败静默降级为「读不到的来源不显示」（现有 README 口径），不报错打扰。
- README「读哪些目录」一节与 `providerSource`/`ACP_COMMANDS`（ACP 包装识别 grok/pi 的先例）随批次更新。

## 5. 风险登记

1. **`node:sqlite` 实验状态**：Node 大版本升级可能破坏 SQLite 源；缓解：读操作集中在单一模块，出问题只影响 SQLite 批次源。
2. **非 1.0 产品的格式漂移**（Qoder 日更、Qwen/Gemini 快迭代、CodeBuddy 双 usage 形态）：全部按「字段缺失降级 + 多写法兼容」实现；不承诺百分比。
3. **OpenCode 迁移缺陷**：SQLite 与 legacy JSON 可能并存/孤儿，需两后端合并去重（`callKey` 天然按内容去重，风险可控）。
4. **口径差异**：OpenCode `input` 不含 cache read；Copilot input cache-inclusive；Grok input 含缓存读写——沿用现有「每源解析时拆干净」的约定，别把口径差异漏进汇总。
5. **Credits vs USD**：Qoder/Copilot 只有平台计量单位，插件明确不估费用（现有口径：不显示 cost，只统计 token），无需改动。

## 6. 本机实证清单（与文档交叉验证过的点）

- `~/.omp/agent/sessions/<slug>/<ts>_<id>.jsonl`：title 槽 + session v3 header + usage/cost 字段 ✔；`strings` 提取 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`/`PI_CONFIG_DIR` ✔
- `~/.local/share/opencode/storage/{session,message,part,project}`：message JSON `tokens/cost/modelID/time/path.cwd` ✔；`XDG_DATA_HOME`/`OPENCODE_CONFIG_DIR` strings ✔；本机仍为 legacy 布局（未迁 1.2.0 SQLite）
- `~/.codebuddy/projects/<slug>/<uuid>.jsonl`：session-meta/message 行、双 usage 形态、model 字段 ✔；`CODEBUDDY_CONFIG_DIR` strings ✔
- `~/.qoder/projects/`：`<uuid>.jsonl`（workspace-directories/runtime-config/assistant 行）✔、`<uuid>-session.json` 明文聚合 ✔、state.json 加密 blob ✔、`logs/runs/*/manifest.json`（cwd/project_id/cli_version 1.1.78）✔
- `~/.gemini/tmp/<sha256>/chats/*.json`：37 份全旧代际、无 usage ✔（新版 tokens 字段为官方源码证实）
- `~/.qwen/projects/<slug>/chats/*.jsonl`：Claude 同构头 ✔（usage 行待新版采样）
- `~/.cursor/chats/<md5>/<uuid>/store.db`：blobs+meta 两表 ✔；`~/.copilot/session-store.db`：sessions/turns/assistant_usage_events 表存在、本地空 ✔；`~/.local/share/goose/sessions/sessions.db`：messages+usage_ledger 表存在 ✔
- `~/.iflow/projects/<slug>/session-*.jsonl`：Claude 同构、usage 全 0 ✔（配合官方停服公告 → 不做）
- daemon Node v24.14.1 `node:sqlite` DatabaseSync 可用 ✔；`~/.paseo/opencode-home/` 存在（daemon 给 opencode 型 Provider 的隔离 home）✔
