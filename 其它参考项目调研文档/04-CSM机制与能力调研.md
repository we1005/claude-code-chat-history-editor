# CSM 机制与能力调研

> 唯一研究对象：`参考项目/csm/`\
> 固定快照：`130a9a788c285719f34583fffc2738ec5b0c86ef`（2026-03-17）\
> 证据口径：**源码已确认** / **隔离测试已确认** / **文档声称** / **待验证 / 未知**

## 摘要

**结论先行：CSM 不是 Codex/Claude 聊天正文编辑器。** 它是紧耦合本地 Codex Rust 源码的会话管理、修复、迁移和提示预览工具。现有命令没有 message-level `edit`、`delete` 或物理 `truncate`，也完全没有 Claude Code 存储适配。它能原地改的只有首条 `SessionMeta` 的少数字段，以及若干事件中的 `model_context_window`；这两种改写保留同一 session ID 和后续 JSONL 行，但**不能修改用户/assistant 正文**。

对目标“原地修改正文且保留后续消息”，CSM 最有价值的是：

1. **Codex 原生类型与有效历史重放思路**：`RolloutLine → RolloutItem → ResponseItem/EventMsg`，并正确考虑 compaction replacement history 和 rollback 标记。
2. **操作语义边界参考**：repair 只对账 SQLite；compact/rollback 是同线程原生操作；fork/migrate/distill 都创建新线程。
3. **有限的安全写入模式**：全量解析到内存后才调用 `codex_core::path_utils::write_atomically`；但没有备份、显式锁、活动会话检测或乐观并发保护。

因此不应直接把 CSM 包装成统一双引擎编辑器。应复用其“Codex 有效历史重放”和“写后索引修复”概念，另建正文级编辑计划器：同步处理 response/event 重复表示、turn 边界和 `call_id` 配对，并为 Claude 单独实现 JSONL schema、索引和恢复验证。

## 项目与快照

### 定位、技术栈与可构建性

- **源码已确认**：本地 `git rev-parse HEAD` 为指定的 `130a9a788c285719f34583fffc2738ec5b0c86ef`，候选仓库工作树无修改。固定源码链接统一使用 `https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/...`。
- **源码已确认**：包名 `codex-session-manager`、版本 `0.1.0`、Rust edition 2024、最低 Rust 1.85；描述明确是 Codex session inspection/repair/migration（[`Cargo.toml` L1-L9](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L1-L9)）。
- **源码已确认**：CLI 用 Clap，异步运行时为 Tokio，TUI 用 Crossterm + Ratatui，JSON 用 Serde；核心会话能力不是自实现，而是三个相邻目录 path dependency：`../codex/codex-rs/{core,protocol,state}`（[`Cargo.toml` L11-L27](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L11-L27)）。
- **隔离测试已确认**：运行 `cargo metadata --locked --no-deps --format-version 1` 成功，确认当前机器上三个 path dependency 可解析；元数据返回本包 `license=null`、`license_file=null`。运行环境是 `rustc/cargo 1.98.0`。该命令未编译、未触发模型、未读写真实会话。
- **文档声称**：README 把 CSM 定位为“安全检查、修复和迁移 Codex 会话”的工具，并宣称遵循原生 Codex 规则、不会盲目重写历史；又称 fork/compact 复用 `ThreadManager::fork_thread` 和 `Op::Compact`（[`README.md` L1-L30](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/README.md#L1-L30)、[`README.md` L109-L116](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/README.md#L109-L116)）。前者是产品表述，不足以覆盖本报告发现的无备份/锁/CAS、typed round-trip 与版本未固定风险；后者可由调用点源码确认，但 native 内部实现仍不在本快照中。
- **待验证 / 未知**：CSM 快照没有记录相邻 Codex 仓库的 commit。三个内部 crate 在 lockfile 中均只是 `0.0.0`，本地 path dependency 没有可复现源码身份（[`Cargo.lock` L1150-L1152](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.lock#L1150-L1152)、[`Cargo.lock` L1397-L1418](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.lock#L1397-L1418)、[`Cargo.lock` L1538-L1555](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.lock#L1538-L1555)）。仅凭本仓库无法复现 native fork/compact/rollback 的确切实现版本。

### CLI 入口与模块分派

- **源码已确认**：`main` 只做 `Cli::parse()` 后进入库 `run`（[`src/main.rs` L1-L7](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/main.rs#L1-L7)）。有 subcommand 时在 16 MiB 独立线程和单线程 Tokio runtime 中执行；无参数进入 TUI（[`src/lib.rs` L26-L74](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/lib.rs#L26-L74)）。
- **源码已确认**：命令集合为 `show/rename/repair/rewrite-meta/repair-resume-state/fork/archive/unarchive/copy-*/compact/rollback/migrate/smart/first-token-preview/distill`；没有 edit/delete/truncate 命令（[`src/cli.rs` L31-L76](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/cli.rs#L31-L76)）。
- **源码已确认**：`commands::run` 是统一分派点（[`src/commands.rs` L43-L63](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L43-L63)）；`operations.rs` 包装 Codex native thread/state 操作，`rollout_edit.rs` 只有两类 JSONL surgery，`summary.rs` 派生摘要，`preview.rs` 重放模型可见历史，`distill.rs` 生成继任会话。
- **源码已确认**：TUI 只是同一命令图的视觉外壳；Action 列表与 CLI 一致（[`src/tui.rs` L357-L416](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tui.rs#L357-L416)），把 UI 输入重新组装为 argv、交给 Clap 解析并调用 `run_command`（[`src/tui.rs` L1052-L1124](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tui.rs#L1052-L1124)）。不是消息树编辑 UI。

## Codex 发现、读取、解析、重放与写盘调用链

### 1. 目标发现与会话清单

**源码已确认**：

1. `resolve_target` 先构造 Codex `Config`，从 `find_codex_home()` 得到 `$CODEX_HOME`，再解析目标（[`src/runtime.rs` L25-L83](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L25-L83)）。
2. `resolve_rollout_path` 依次接受：已存在路径（canonicalize）、active thread ID、archived thread ID、active thread name；最后倒序扫描 `$CODEX_HOME/session_index.jsonl` 找同名最新 ID，再查 archived rollout（[`src/runtime.rs` L154-L177](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L154-L177)、[`src/runtime.rs` L204-L233](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L204-L233)）。
3. TUI 清单调用 Codex `RolloutRecorder::list_threads/list_archived_threads` 分页读取，并另外从 session index 批量取标题（[`src/tui.rs` L972-L1049](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tui.rs#L972-L1049)）。清单到底优先 SQLite 还是文件系统由未固定版本的 `codex-core` 决定。

实际涉及的持久化位置：

| 存储 | CSM 的读写 |
|---|---|
| `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-{thread_id}.jsonl` | 主记录；show/preview/repair/surgery/native resume 的输入；compact/rollback 仅支持 active |
| `$CODEX_HOME/archived_sessions/<rollout-file>` | archive/unarchive 通过 rename 搬移；文件名时间决定恢复目录 |
| `$CODEX_HOME/session_index.jsonl` | 读取名称；rename/fork/distill 通过 `append_thread_name` 追加，不回写 rollout 正文 |
| `$CODEX_HOME/config.toml` | 可选 profile 写入和 `smart-*` profile 清理 |
| `$CODEX_HOME/memories/memory_summary.md` | first-token-preview 只读，用于估计 memory prompt（[`src/preview.rs` L1073-L1096](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L1073-L1096)） |
| Codex SQLite state DB | `repair`/搬移后通过 `open_if_present + read_repair_rollout_path` 对账；本仓库未暴露数据库文件名和表结构 |

### 2. 读取、typed schema 与内部模型

- **源码已确认**：首条 meta 由 Codex `read_session_meta_line` 读取；其余 CSM 侧的基础解析模型是外部 `RolloutLine { timestamp, item }`，item 分为 `SessionMeta`、`ResponseItem`、`Compacted`、`TurnContext`、`EventMsg`。CSM 自有模型只是 `SessionSummary`、`TokenSnapshot`、`ForkRequest/Outcome` 等投影（[`src/types.rs` L6-L64](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/types.rs#L6-L64)）。
- **源码已确认**：`summary::read_rollout_lines` 一次读完整 UTF-8 文件，逐行 typed parse；**解析失败的非空行被静默跳过**，只有一条可解析记录都没有才报错（[`src/summary.rs` L104-L128](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/summary.rs#L104-L128)）。因此 show/distill raw analysis 面对新 schema 可能是不完整结果而非显式失败。
- **源码已确认**：摘要从 `ResponseItem` 中经 Codex `parse_turn_item` 提取用户消息；assistant、plan、reasoning、web search 等不计用户轮。遇到 `Compacted` 就用 `replacement_history` 重置用户消息，遇到 `ThreadRolledBack` 就从派生向量尾部移除 N 个用户轮（[`src/summary.rs` L22-L81](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/summary.rs#L22-L81)、[`src/summary.rs` L130-L168](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/summary.rs#L130-L168)）。
- **源码已确认**：first-token-preview 同时调用 Codex 原生 `RolloutRecorder::get_rollout_history`，又自行重放 rollout，用于计算下一轮有效历史（[`src/preview.rs` L39-L68](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L39-L68)）。重放从后向前确定最新 surviving turn context、rollback 数和 compaction replacement base，再向前应用 response items、后续 compaction 与 rollback（[`src/preview.rs` L612-L789](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L612-L789)）。

### 3. 正文、多内容块、reasoning、工具与双重表示

| 数据种类 | 识别/展示能力 | 编辑能力 |
|---|---|---|
| 用户正文 | summary/distill 通过 `ResponseItem::Message` + `parse_turn_item` 识别；preview 展示所有 text block，image 显示 `[image]` | **无** |
| assistant 正文 | distill 将 `AgentMessageItem.content` 的全部 text block 用换行拼接（[`src/distill.rs` L1103-L1113](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L1103-L1113)）；preview 展示 output text | **无** |
| reasoning | preview 保留 `ResponseItem::Reasoning`，只显示“encrypted reasoning content”并按密文长度估算（[`src/preview.rs` L1014-L1020](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L1014-L1020)、[`src/preview.rs` L1144-L1209](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L1144-L1209)）；distill 忽略 reasoning | **无；不能解密或同步改写** |
| function/custom tool call 与 output | preview 将 call/output 都保留在 prompt history，并分别标识（[`src/preview.rs` L836-L852](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L836-L852)、[`src/preview.rs` L979-L1006](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L979-L1006)） | **无** |
| `call_id` 配对 | **待验证 / 未知**：CSM `src/` 中没有 `call_id` 引用，不校验 orphan/duplicate/mismatch | **无** |
| event/response 双表示 | 有意识地区分：正文和模型历史以 `ResponseItem` 为准；`EventMsg::UserMessage/TurnStarted/TurnComplete` 主要用于 turn segment；warnings/errors 从 event 取；`RawResponseItem` 在 distill 中显式忽略（[`src/distill.rs` L501-L593](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L501-L593)） | **没有跨表示同步编辑器** |
| 原始未知记录 | rewrite-meta 对未改的后续行字节级保留；repair-resume-state 对未改行保留原 segment | 不认识的新 enum 会导致 resume-state surgery 在写前失败；summary 则静默跳过 |

关键限制：即使未来直接改了一个 `ResponseItem::Message`，仍可能留下对应 `EventMsg::UserMessage/AgentMessage/RawResponseItem` 的旧文本。CSM 没有建立 duplicate group，也没有工具链完整性计划器，不能证明恢复后只采用新内容。

### 4. 两种真正的 JSONL surgery

#### `rewrite-meta`

- **源码已确认**：只允许 patch `SessionMeta.model_provider/cwd/memory_mode`；首条非空行必须是 `SessionMeta`。仅这一行经 typed Serde 重序列化，其余 segment 原样拼接，保留是否有末尾换行（[`src/rollout_edit.rs` L9-L78](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/rollout_edit.rs#L9-L78)）。
- **源码已确认**：命令先全文件 `read_to_string`，内存改写成功后调用 `write_atomically`，再 repair SQLite（[`src/commands.rs` L147-L174](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L147-L174)）。ID 字段不在 patch 中，故保持 session ID；所有后续行保留。
- **风险**：修改行经当前 `codex-protocol` typed round-trip，未被类型保留的未来字段可能丢失。它不是正文 edit。

#### `repair-resume-state`

- **源码已确认**：严格 parse 每条非空行，仅更新 `EventMsg::TokenCount.info.model_context_window` 与 `EventMsg::TurnStarted.model_context_window`；其他项不动（[`src/rollout_edit.rs` L80-L135](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/rollout_edit.rs#L80-L135)）。改变的行会 typed reserialize，未改变的行原样保留。
- **源码已确认**：写盘和 SQLite repair 链与 rewrite-meta 相同（[`src/commands.rs` L177-L203](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L177-L203)）。它保留 ID 和后续历史，但只改窗口提示。
- **待验证 / 未知**：这些提示是否覆盖目标 Codex 版本恢复时的所有窗口来源；源码只改两个 event variant。

## 操作语义：严格区分 edit/delete/truncate/fork/repair/compact

| 操作 | CSM 中的严格定义 | 同 ID？ | 保留“后续消息”？ | 原始旧记录 | 是否新会话 |
|---|---|---:|---|---|---:|
| **正文 edit** | **不存在**。`rewrite-meta` 不是正文 edit | — | — | — | — |
| **delete** | **不存在**。archive 是搬移，不是删除 | — | — | — | — |
| **物理 truncate** | **不存在**。代码中的 `Vec::truncate`/字符串截短只用于派生摘要、preview、distill brief，不截 JSONL | — | — | — | — |
| **rollback** | 对 active rollout native resume，提交 `Op::ThreadRollback { num_turns }`；有效历史丢掉末尾 N 个用户轮及其后内容（[`src/operations.rs` L200-L234](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L200-L234)） | 是 | **否**，被回滚尾部不再有效 | CSM 重放逻辑表明旧 response 行可仍存在，由 rollback event 遮蔽；native 写法待依赖版本确认 | 否 |
| **fork** | 调 `ThreadManager::fork_thread(nth_user_message, …)`，可选只保留至第 N 个 user message；结果返回新 ID/rollout（[`src/operations.rs` L236-L326](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L236-L326)） | 否 | 未传 N 时 CSM 传 `usize::MAX` 请求完整前缀；传 N 时该点之后不进入新会话；具体复制集合由 native 实现决定 | 源文件保留 | **是** |
| **repair** | 从 rollout 首 meta 读 ID，调用 state DB `read_repair_rollout_path` 重建/对账数据库路径与 archived 状态（[`src/operations.rs` L43-L79](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L43-L79)） | 是 | 是，rollout 不改 | 全保留 | 否 |
| **repair-resume-state** | 原地改窗口提示，不修正文或工具链 | 是 | 是 | 除两类目标行外保留 | 否 |
| **compact** | native resume 后提交 `Op::Compact`，等 `ContextCompacted`/`TurnItem::ContextCompaction`（[`src/operations.rs` L165-L198](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L165-L198)、[`src/operations.rs` L402-L431](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L402-L431)） | 是 | CSM 不显式删后续行，但**模型有效历史被 replacement history/summary 改写**，不等于无损保留 | native 持久化细节待确认 | 否 |
| **migrate** | 可先在源线程 compact，再 fork；可选 archive source（[`src/commands.rs` L390-L525](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L390-L525)） | 新 ID | 新线程只继承 fork 的有效链；source 保留或搬到 archived | 源保留 | **是** |
| **distill** | 重建有效历史→抽取/截短 brief→启动新线程→以一个新的 UserTurn seed brief→等待模型回复；可选归档源（[`src/distill.rs` L62-L121](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L62-L121)、[`src/distill.rs` L224-L312](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L224-L312)） | 否 | **不保留原消息链**，只保留选择性 handoff brief | 源保留/归档 | **是** |

特别提醒：`distill --compression-level lossless` 只是策略名，不是字节或语义无损。源码仍有条数上限和字符截断；三档只是不同预算（[`src/distill.rs` L370-L415](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L370-L415)、[`src/distill.rs` L676-L735](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L676-L735)）。

`smart` 也不是一种新的存储语义：**源码已确认**，同 provider 的 direct 路径最多在原线程 compact、repair resume state 和写 profile，保持 ID；跨 provider 的 direct 路径调用 migrate，因此产生 fork 新 ID；选择 distill 路径则产生 handoff successor（[`src/smart.rs` L188-L365](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/smart.rs#L188-L365)、[`src/smart.rs` L366-L458](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/smart.rs#L366-L458)）。

## 数据一致性：ID、turn、工具链、compaction、索引/SQLite

### Session ID 与 fork lineage

- **源码已确认**：summary 的 ID、`forked_from_id` 来自首条 SessionMeta（[`src/summary.rs` L26-L35](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/summary.rs#L26-L35)）。meta/window surgery 都不改 ID。
- **源码已确认**：archive/unarchive 会校验文件名以 `{thread_id}.jsonl` 结尾并限制来源目录，恢复目录来自文件名日期（[`src/operations.rs` L81-L163](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L81-L163)、[`src/operations.rs` L328-L350](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L328-L350)）。
- **待验证 / 未知**：`fork_thread` 如何生成新 meta、复制哪些 extended history、设置 lineage，完全由未固定 `codex-core` 实现决定。

### Turn 边界与 rollback

- **源码已确认**：preview 用 `TurnStarted/TurnComplete/TurnAborted` 的 `turn_id` 和 `EventMsg::UserMessage` 判定 backward replay segment；缺失 ID 时采用兼容规则（[`src/preview.rs` L648-L720](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L648-L720)、[`src/preview.rs` L791-L826](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L791-L826)）。
- **源码已确认**：forward replay 的 rollback 是从第 N 个倒数 user message 的位置整体切断，所以会同时丢掉该 user message 之后的 assistant/tool items（[`src/preview.rs` L923-L947](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L923-L947)）。这与“删单条消息但保留后来历史”语义相反。

### Compaction 快照

- **源码已确认**：最新 `Compacted.replacement_history` 是有效历史新基线；有 replacement 时过滤可进入 prompt 的 items，无 replacement 的 legacy compact 则重建“近期 user 消息 + summary”，并清除 reference context（[`src/preview.rs` L740-L780](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L740-L780)、[`src/preview.rs` L855-L900](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L855-L900)）。
- **风险**：若原地编辑发生在旧的 pre-compaction response 行，但最新 replacement history 仍含旧文本，模型 resume 可能继续看到旧文本；反过来只改 replacement 也会让审计原始记录与有效快照不一致。CSM 没有解决这个问题。

### Index 与 SQLite

- **源码已确认**：rename 只向 `session_index.jsonl` 追加新标题（[`src/commands.rs` L127-L134](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L127-L134)）；同名解析倒序取最新条目。旧标题记录不会删除。
- **源码已确认**：rollout 改写、compact/rollback 成功后以及 archive/unarchive 后都会调用 repair/reconcile；repair 是最佳努力地 `open_if_present`，再调用 Codex state repair（[`src/operations.rs` L43-L79](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L43-L79)）。
- **待验证 / 未知**：`open_if_present` 返回无 DB 或 repair 内部失败时的可观察语义、数据库具体文件/表、事务边界，CSM 源码未说明。`read_repair_rollout_path` 返回值被忽略，CSM 无法证明所有索引字段都已同步。

## “UI → 存储 → resume → 模型采用”四层证据

| 层 | 结论 | 证据等级 |
|---|---|---|
| UI/CLI 表象 | TUI/CLI 能看摘要、预览、改 meta/window、repair、fork、compact、rollback、migrate/distill；没有逐消息正文编辑器 | **源码已确认**（[`src/tui.rs` L797-L929](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tui.rs#L797-L929)） |
| 存储写回 | meta/window surgery 确实生成新完整字符串并 `write_atomically` 回原 rollout；native 操作则委托 Codex；rename 写 index | **源码已确认** |
| resume | fork/distill 输出 `codex resume …` 命令；compact/rollback 内部调用 `resume_thread_from_rollout`；first-token-preview 调 native history 再自行模拟下一请求 | **源码已确认**（[`src/runtime.rs` L187-L201](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L187-L201)、[`src/operations.rs` L170-L180](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L170-L180)） |
| 模型实际采用修改内容 | 本次没有运行真实 resume/模型请求；CSM tests 也没有“改正文→resume→捕获最终 request”的用例。preview 自称重建请求，但仍是本地重放与 token 估算，且输出明确排除 live-discovered tools（[`src/preview.rs` L248-L305](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L248-L305)） | **待验证 / 未知** |

**不能跨层推断**：看到 UI “Completed”、rollout 文件发生改变，最多证明命令和写盘成功；不能据此断言未来 Codex 版本恢复时读取的是目标表示，更不能断言模型已采用修改。CSM 自身也没有任何 Claude Code resume 证据。

## 写入可靠性与异常恢复

| 机制 | 结论 |
|---|---|
| 写前全量验证 | **源码已确认**：两种 surgery 都先在内存完成；解析失败时不会进入写调用。resume-state 严格检查全文件，meta surgery 只严格检查首条非空行。 |
| 原子替换 | **源码已确认（调用层）**：调用 `codex_core::path_utils::write_atomically`（[`src/commands.rs` L162-L169](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L162-L169)）。**待验证 / 未知（实现层）**：相邻 Codex 源码 commit 未固定，临时文件权限、fsync、目录 fsync、Windows replace 语义无法从 CSM 快照确认。 |
| 备份/撤销 | **源码已确认（缺失）**：CSM 的 rollout surgery 路径没有 `.bak`、copy-on-write 版本或 undo journal。rollback 是聊天语义，不是文件备份恢复。 |
| 锁与活动会话检查 | **源码已确认（CSM 层缺失）**：直接 surgery 在 `read_to_string → write_atomically` 之间无显式 lock，也未检查会话是否正被 Codex 写入。底层 native 操作是否有锁属于 **待验证 / 未知**。 |
| hash/mtime/version 保护 | **源码已确认（缺失）**：没有 compare-and-swap、原内容 hash、mtime 重检或 schema version gate。并发 append 可能被基于旧快照的全文件替换覆盖。 |
| 写后修复 | **源码已确认**：surgery 写后 repair DB；但 repair 失败不会回滚已写 rollout。archive 先 rename 后 reconcile，后者失败不会自动搬回。 |
| 局部失败 | **源码已确认**：fork 已创建新线程后，rename/profile/shutdown 任一步失败会返回错误但新线程可能已存在（[`src/operations.rs` L281-L325](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L281-L325)）。distill 写 profile/建线程/命名后 seed 失败也可能留下半成品；归档源在 seed 成功后才发生，顺序相对安全。 |
| 超时 | **源码已确认**：native 操作按 submit ID 等待指定 event 并有 timeout，之后提交 shutdown（[`src/operations.rs` L402-L455](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L402-L455)）。timeout/事件丢失时操作究竟已落盘与否仍需重新检查。 |
| 搬移 | **源码已确认**：archive/unarchive 使用同文件系统 `tokio::fs::rename`，不是复制备份；unarchive 会 touch mtime（[`src/operations.rs` L107-L162](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L107-L162)）。 |

对新编辑器的最低要求应高于 CSM：拒绝活动会话；保存原文件权限；创建可验证备份；在写前重检 inode/size/mtime/hash；同目录 temp + fsync + replace；写后重新 parse、重放 effective history、修复索引/DB；任一步失败可从备份回滚。

## Schema/CLI 版本依赖与许可证

### 版本耦合

- **源码已确认**：这是**源码级**依赖而非稳定 Codex CLI/API 依赖。CSM直接使用 `ThreadManager`、`CodexThread`、`RolloutRecorder`、`Op`、`EventMsg`、`RolloutItem`、`ResponseItem`、state DB repair、config editor 等内部符号。
- **源码已确认**：Cargo.lock 锁住了 crates.io 与两个 websocket git patch commit（[`Cargo.toml` L33-L38](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L33-L38)），但锁不住三个 path dependency 的源码 commit。
- **风险**：`EventMsg` 和 `ResponseItem` 都是大枚举；新增 rollout variant 会使严格 rewrite-resume-state 失败，而宽松 summary 会静默漏项。typed 重序列化还可能丢掉当前类型未知的字段。这是正文编辑器不可接受的前向兼容策略。
- **待验证 / 未知**：与任何正式发布的 Codex CLI 版本对应关系。SessionMeta 测试 fixture 中的 `cli_version="0.0.0"` 只是合成值，不是兼容声明（[`src/tests.rs` L29-L47](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tests.rs#L29-L47)）。

### 许可证与依赖风险

- **源码已确认**：固定快照没有 `LICENSE`/`COPYING` 文件；`Cargo.toml` `[package]` 没有 `license`、`license-file`、repository 或 authors 字段（[`Cargo.toml` L1-L10](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L1-L10)）。`cargo metadata` 也报告 license 均为空。
- **结论**：**未识别到授权，不能假定可复制/修改/再分发 CSM 源码。** 在取得作者明确许可前，只能把机制当调研参考，不能把 `rollout_edit.rs`、`preview.rs` 等直接搬入新项目。
- **待验证 / 未知**：依赖许可证。lockfile 不记录许可证；必须对所有直接/传递依赖另跑 SBOM/license audit。尤其三个本地 Codex crate、两个 git patch、clipboard/TUI/native platform 依赖都要核对来源、版本和许可证兼容性。
- **依赖面风险**：为了少量 rollout 逻辑引入完整 `codex-core` 会带入网络、认证、MCP、sandbox、keyring、image 等很大的依赖面（可从 [`Cargo.lock` L1150-L1242](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.lock#L1150-L1242) 看到）。这增加构建、供应链、平台兼容和版本同步成本。

## 可复用模块与统一双引擎改造成本

### 可借鉴但当前不可直接复制

| 模块/思路 | 价值 | 改造要求 |
|---|---|---|
| `rollout_edit` 的“未改行原样保留、目标行 typed patch” | 减少不相关格式变化 | 必须改为 lossless JSON AST/原始字段保留，增加 schema/version gate、备份和 CAS |
| `summary`/`preview` 的 effective-history replay | 正确区分 raw log 与模型可见历史，处理 rollback/compaction | 应抽成版本化 Codex adapter，并和目标 Codex 的 native replay 做 differential test |
| `repair_rollout_state` | 写后维护 SQLite/index 一致性的正确意识 | 固定 Codex 版本，验证数据库事务、返回值和失败回滚 |
| `ForkRequest`/native Op 包装 | 对 fork/compact/rollback 语义较贴近 Codex | 这些不是正文原地编辑，不能替代 edit pipeline |
| CLI/TUI 共用命令图 | 可作为产品结构参考 | 现 TUI 无 message tree、diff、duplicate/tool pair 告警、保存确认/恢复 UI |

### 为“原地编辑且保留后续消息”必须新增

1. **Codex message graph**：把同一逻辑消息在 `ResponseItem`、`EventMsg`、`RawResponseItem`、compaction replacement 中的副本归组；标记哪个表示进入 resume prompt。
2. **turn/tool integrity planner**：解析 `turn_id`、user/assistant/tool 边界，按 `call_id` 将 call 与 output 成对校验；编辑/删除时拒绝制造孤儿或提供“连锁处理”预览。
3. **操作语义**：`edit` 仅替换选定逻辑消息并保留后继；`delete` 可删除一条逻辑消息但要处理工具依赖；`truncate` 明确丢弃目标点之后；`rollback` 采用原生语义；`fork` 新 ID；`compact` 改有效快照；这些按钮和审计日志不能混名。
4. **Claude adapter**：CSM 没有任何 Claude 发现、schema、index、resume 或写盘代码；需要独立实现，不能通过换路径复用 Codex adapter。
5. **可靠保存协议**：活动会话检测、锁、备份、CAS、原子替换、权限/mtime 策略、写后 parse/replay/index repair 和一键恢复。

成本判断：Codex 只读浏览可以较多借鉴其数据分类；Codex 正文安全编辑是**中高成本**；加入 Claude 并做到统一 UI、各自 native consistency 和 resume 证据是**高成本**。最大的难点不是文本框，而是多表示同步、compaction 快照、工具链配对、版本漂移和写后恢复验证。

## 风险、未知项与最小隔离验证方案

### 已知风险与未知项

1. **无正文 edit/delete**：CSM 不满足核心产品目标。
2. **无 Claude 支持**：双引擎需求至少要新增一整套 adapter。
3. **Codex commit 未固定**：无法复现 native operation/schema。
4. **并发覆盖风险**：direct surgery 没有锁和 hash/mtime CAS。
5. **typed round-trip 风险**：未知字段/variant 的处理不一致；changed line 可能丢未来字段。
6. **有效历史与原始记录分叉**：rollback/compaction 后，改“看见的旧行”不必然改模型有效上下文。
7. **工具链未校验**：没有 `call_id` 配对逻辑。
8. **repair 可观测性不足**：state repair 返回值未被检查，数据库细节在外部依赖。
9. **许可证阻塞**：无明确项目许可，源码不可默认复用。
10. **测试夹具不可复现**：`src/tests.rs` 的多个测试依赖 `test/rollout-…jsonl`（[`src/tests.rs` L78-L82](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tests.rs#L78-L82)），但 `.gitignore` 忽略 `test` 且该文件不在固定快照；完整测试套件预期受阻。

### 最小隔离验证方案

仅在项目 `.研究临时数据/csm-验证/` 下创建合成 `$CODEX_HOME`，绝不指向真实 home：

1. 固定一份明确 commit 的 Codex source/toolchain，构建 CSM；记录 `codex --version`、schema fixture version 和二进制 hash。
2. 合成 rollout 覆盖：多 text block/image、user/assistant event+response duplicate、reasoning 密文、function/custom call+output（正常/孤儿/重复 `call_id`）、TurnStarted/Complete/Aborted、两次 compaction（含/不含 replacement）、rollback、未知字段、未知 variant。
3. 先跑纯函数测试：meta/window patch 前后做逐行 byte diff；验证未知字段保留、parse failure 不写、CRLF/末尾换行、权限保留。
4. 再用隔离 `$CODEX_HOME` 跑 show/first-token-preview/repair/rename/archive roundtrip；读取合成 SQLite/index，核对 ID、路径、archived、名称和 mtime。
5. fork/compact/rollback 只用 mock provider 或完全离线 native fixture；捕获写前后 rollout，证明是新 ID还是同 ID、raw records 是否保留、effective history 如何变化。
6. 正文编辑原型必须做 differential replay：编辑前后分别由“自研 replay”和固定 Codex native `get_rollout_history` 计算模型有效历史，两者一致才允许保存。
7. 模型采用验证必须另列为受控集成测试：用 fake transport 捕获 resume 生成的最终 request，不发真实请求。文件 diff、preview 输出和模型采用三项分别断言。
8. 注入故障：写中断、repair 失败、目标文件并发 append、mtime/hash 改变、archive reconcile 失败，验证备份和回滚。

## 本次验证边界

- **隔离测试已确认**：HEAD 核对；`git status --short`；`cargo metadata --locked --no-deps`；Rust/Cargo 版本查询；所有操作均在候选源码或 manifest 层，未访问真实 `$CODEX_HOME`。
- **未运行**：`cargo test`、CSM 二进制、native resume/fork/compact/rollback、distill、任何模型请求。原因是完整构建会拉入/编译大型 Codex 依赖，且固定快照缺失源码测试所引用的真实 fixture；运行 native 操作也不属于本次安全边界。
- **未做**：联网搜索、修改候选仓库、读取或修改 `~/.codex`/`~/.claude`、Claude Code 实测。

## 结论

1. **源码已确认**：CSM 只有 meta/window 原地 surgery；没有正文 edit/delete/truncate。它不能直接实现“改旧消息并保留后续消息”。
2. **源码已确认**：rollback 和 truncate 不同——rollback 让末尾 N 个用户轮在有效历史中失效；fork/migrate/distill 则创建新 session。compact 保持同 ID，但会以摘要/replacement 改写模型有效历史。
3. **源码已确认**：CSM 对 Codex raw/effective history 的区分有参考价值，但没有 event/response/RawResponse duplicate 同步和 `call_id` 完整性维护。
4. **待验证 / 未知**：写入虽调用 `write_atomically` 并 repair SQLite，却缺少项目层备份、锁、活动会话检测、CAS 和失败回滚；文件写成功也不能等同于模型采用。
5. **许可证结论**：固定快照无许可证文件/元数据，不得默认复用源码；同时 path-pinned Codex commit 缺失，使构建和 schema 行为不可复现。

## 证据索引

| 主题 | 固定源码证据 |
|---|---|
| 包、Rust 与依赖 | [`Cargo.toml` L1-L27](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L1-L27) |
| CLI 命令全集 | [`src/cli.rs` L23-L76](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/cli.rs#L23-L76) |
| 命令分派 | [`src/commands.rs` L43-L63](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L43-L63) |
| 目标发现/index | [`src/runtime.rs` L154-L177](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L154-L177)、[`src/runtime.rs` L204-L233](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/runtime.rs#L204-L233) |
| 摘要 replay | [`src/summary.rs` L22-L81](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/summary.rs#L22-L81) |
| meta surgery | [`src/rollout_edit.rs` L28-L78](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/rollout_edit.rs#L28-L78) |
| window surgery | [`src/rollout_edit.rs` L80-L135](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/rollout_edit.rs#L80-L135) |
| 原子写调用与写后 repair | [`src/commands.rs` L147-L203](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/commands.rs#L147-L203) |
| SQLite repair | [`src/operations.rs` L43-L79](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L43-L79) |
| compact/rollback/fork | [`src/operations.rs` L165-L326](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/operations.rs#L165-L326) |
| effective history/compaction | [`src/preview.rs` L612-L852](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L612-L852) |
| rollback cut boundary | [`src/preview.rs` L923-L947](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/preview.rs#L923-L947) |
| distill 新线程与 seed turn | [`src/distill.rs` L224-L341](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/distill.rs#L224-L341) |
| TUI action 表象 | [`src/tui.rs` L797-L929](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/src/tui.rs#L797-L929) |
| 无许可证元数据 | [`Cargo.toml` L1-L10](https://github.com/citizenll/csm/blob/130a9a788c285719f34583fffc2738ec5b0c86ef/Cargo.toml#L1-L10) |
