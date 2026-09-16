# coldxx 机制与能力调研

> 研究对象：`参考项目/coldxx/`；固定快照：`9265318527336a9300f29584690c12a1d4e3cc31`（v0.1.4）\
> 调研日期：2026-09-14；未联网；未读取或修改真实 `~/.codex` / `~/.claude`；未运行真实 `resume` 或模型请求。

## 摘要

**结论：coldxx 是一个纯 Node.js、Codex-only 的本地 JSONL 管理器。它已经实现了本项目最关心的“原地改某一 turn 的用户/助手文本，同时保留后续 record”，并专门同步其所支持 rollout 结构中相同文本的 `event_msg`、`response_item`、`task_complete` 多重表示。**但这个同步是“同一推断 turn 内，按 `side + 完全相同文本` 聚组”，不是基于稳定消息 ID 的 schema 级关联；本仓库也未提供真实 Codex rollout 样本来证明所有版本都有这些副本。它不处理 Claude Code session，也不证明 Codex `resume` 会成功，更不证明恢复后的模型一定采用改写内容。

写回有操作前备份、同目录临时文件加 `rename`、10 分钟 mtime 活动保护；缺少锁、CAS（hash/mtime/版本）、fsync、语义校验和并发追加合并。因此它适合作为**读取/备份/原子替换/通用 record 编辑的参考实现**，不宜原样作为双引擎生产写入层。

## 1. 项目与快照

- **源码已确认**：本地 `HEAD` 精确等于清单提交 `9265318527336a9300f29584690c12a1d4e3cc31`，提交主题为 `chore: release v0.1.4`；候选仓库工作树无修改。
- **源码已确认**：包版本 0.1.4，ESM，Node.js `>=20`，CLI bin 为 `src/cli.js`；`package-lock.json` 只有根包，没有 runtime/dev package 条目，即运行时仅用 Node 内置模块（[`package.json:1-42`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/package.json#L1-L42)，[`package-lock.json:1-18`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/package-lock.json#L1-L18)）。
- **源码已确认**：入口 `main()` 分派 `list/show/clean/edit/drop/trash/profiles/ui/doctor`；不存在 Claude、fork 创建、repair、context compact 或 resume 命令（[`src/cli.js:54-99`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/cli.js#L54-L99)，[`src/cli.js:675-721`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/cli.js#L675-L721)）。

关键模块很集中：

| 模块 | 职责 |
|---|---|
| `src/core.js` | 文件发现、JSONL 解析、session/turn 建模、编辑、备份/Trash/恢复、profile 与改写后端 |
| `src/cli.js` | 参数、确认门槛、活动保护、命令输出 |
| `src/ui-server.js` | 无框架 HTTP API + 内嵌 HTML/CSS/JS UI；token 鉴权 |

## 2. 核心架构及完整读写调用链

### 2.1 发现、读取与摘要

1. `resolveCodexHome()` 取显式参数、`CODEX_HOME` 或 `~/.codex`；session 根固定为 `<CODEX_HOME>/sessions`（[`src/core.js:23-49`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L23-L49)）。
2. `collectJsonlFiles()` 递归遍历该根目录、排序并收集所有 `.jsonl`；没有固定要求 `YYYY/MM/DD`，也没有读取 SQLite、索引或其他 Codex 状态库（[`src/core.js:60-83`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L60-L83)）。
3. `scanSessions()` 对每个文件调用 `readSessionSummary()` 后按时间倒序（[`src/core.js:506-518`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L506-L518)）。摘要从首个 `session_meta` 取 session id/cwd/model/CLI 版本，识别 `forked_from_id` 或 subagent parent；后续 `turn_context` 补 cwd/model，首个 `event_msg:user_message` 用作预览（[`src/core.js:520-610`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L520-L610)）。
4. `readJsonl()` 一次性读全文件，逐非空行 `JSON.parse`，错误含物理行号；没有流式解析（[`src/core.js:85-107`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L85-L107)）。

**边界问题（源码已确认）**：空行会在 `records` 中被跳过，但编辑行号实际按 record 数组的 1-based 下标；`readSessionForEditing()` 又以 `lines[index]` 取得 raw，而单行 API `readJsonlLine()` 按物理行计数。因此含中间空行的文件可能出现 UI 行号、raw 行和实际更新对象错位（[`src/core.js:85-106`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L85-L106)，[`src/core.js:966-1015`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L966-L1015)）。

### 2.2 建模与展示

- **源码已确认**：`groupSessionTurns()` 以 `event_msg:task_started` 为首选 turn 边界；没有该事件时，在遇到 user target 且当前 turn 已同时见过 user 和 assistant 后启新 turn。setup 被单列为 index 0；`sourceTurnId` 取任意 record 的 `payload.turn_id` / `record.turn_id`（[`src/core.js:1290-1435`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1290-L1435)）。这是启发式边界，不是 Codex schema 验证器。
- **源码已确认**：`readSessionForEditing()` 将每个原始对象描述为 line/type/payloadType/role/text/bytes，可选择附 JSON；再把 turn 元数据标注到各 record（[`src/core.js:966-995`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L966-L995)，[`src/core.js:1265-1409`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1265-L1409)）。
- **源码已确认**：HTTP `GET /api/sessions/:id/records` 返回 session、records、turns；前端 `loadRecords()` 装入状态，主视图 `renderTurns()` 显示 user/assistant 摘要，底层 JSONL Lines 可展开，右侧可载入整条 JSON（[`src/ui-server.js:328-361`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L328-L361)，[`src/ui-server.js:3236-3262`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L3236-L3262)，[`src/ui-server.js:3383-3442`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L3383-L3442)）。

### 2.3 修改、序列化和落盘

有三条 session 修改路径：

1. **整条 record 编辑**：UI 将 JSON 文本发到 `PUT /records/:line`，服务端只校验能解析且顶层是普通对象；`updateSessionRecord()` 替换数组对应元素（[`src/ui-server.js:364-372`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L364-L372)，[`src/core.js:1036-1072`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1036-L1072)）。
2. **turn 快速编辑**：先 `getSessionTurnEditPlan()` 找出可编辑路径并按组返回；保存时 `updateSessionTurnMessages()` 深拷贝涉及的 record，仅 `setPathValue()` 改字符串目标，再批量一次写回（[`src/core.js:1156-1263`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1156-L1263)）。
3. **递归文本替换/删行**：`replaceInSession()` 对 scope 命中的整个 record 树递归替换所有字符串；`dropSessionLines()` 直接过滤 record 下标（[`src/core.js:875-964`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L875-L964)，[`src/core.js:1585-1644`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1585-L1644)）。

共同落盘链：**读全文件 → 生成 `nextRecords` → 备份原文件 → 每条 `JSON.stringify` 组成新 JSONL → 同目录临时文件 → `rename` 覆盖**（[`src/core.js:109-145`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L109-L145)，[`src/core.js:1074-1122`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1074-L1122)）。它不是字节级 in-place patch：未改对象的值和顺序保留，但**全文件格式、空白、空行都会被重写/规范化**。

除 rollout 外，coldxx 自身还写：

- `<COLDXX_HOME>/backups/<backupId>/{原文件名,manifest.json}`；
- `<COLDXX_HOME>/trash/<batchId>/...` 和 manifest；
- Codex profile `<CODEX_HOME>/<name>.config.toml` 及可选 `prompts/<name>-model-instructions.md`；
- 浏览器 `localStorage` 中的布局、活动写入开关及 rewrite settings（包含可选 API key）（[`src/core.js:118-145`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L118-L145)，[`src/core.js:692-752`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L692-L752)，[`src/ui-server.js:2683-2724`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L2683-L2724)，[`src/ui-server.js:3085-3138`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L3085-L3138)）。没有代码更新 Codex 的其他索引/数据库。

## 3. Codex 双重/多重表示分析

### 3.1 快速编辑识别的表示

`editableMessageTargets()` 明确支持（[`src/core.js:1437-1485`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1437-L1485)）：

| side | record/payload | 被改字段 |
|---|---|---|
| user | `event_msg:user_message` | `payload.message`、`payload.text` |
| assistant | `event_msg:agent_message` | `payload.message`、`payload.text` |
| assistant | `event_msg:task_complete` | `last_agent_message`、`message`、`text` |
| user/assistant | `response_item:message` + 相应 role | `payload.message`、`text`、每个 `payload.content[i].text` |

因此 coldxx **假定并支持**一个逻辑用户输入同时表示为 `response_item message/input_text` 和 `event_msg:user_message`，助手文本同时表示于 `agent_message`、`response_item message/output_text` 与 `task_complete.last_agent_message`。UI 也明确告知“相同文本的重复表示合并，保存时同步写回”（[`src/ui-server.js:4770-4809`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L4770-L4809)）。**真实 Codex 各版本是否总是生成这些副本：待验证 / 未知。**

### 3.2 匹配机制与限制

- **源码已确认**：组 key 是 `${side}\0${text}`，但只在同一推断 turn 的行区间中聚合；组 ID 又包含 turn id、side、文本和首行。保存按路径逐个设值（[`src/core.js:1156-1207`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1156-L1207)，[`src/core.js:1214-1263`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1214-L1263)）。
- **能力**：在各副本原本完全相同、turn 边界识别正确时，一次编辑可同步全部副本。
- **限制**：已发生差异的副本会成为不同输入框，不会被识别为同一逻辑消息；反之，同 side、同 turn、碰巧同文的两个独立 content block 会被合并。没有稳定 message/item ID、event↔item 引用或 provenance。
- **content block**：只要 `response_item:message` 的 content 元素是对象且有字符串 `text` 就可编辑，不检查 `input_text/output_text` 类型。多块不同文本会成为多组。
- **reasoning、工具调用/结果**：快速 turn 编辑不识别 `reasoning`、`function_call`、`function_call_output` 等；它们仍可在底层整条 JSON 编辑、递归 replace 或 drop 中被任意改动。也就是说“原始记录粒度”很强，但 schema 安全性很弱。
- **递归 replace 风险**：`scope=messages` 把所有 `response_item` / `event_msg` 都纳入，随后遍历 record 中所有字符串；可能改 timestamp、turn_id、call_id、工具参数/输出，不只可见消息。`scope=assistant` 又未必命中 `agent_message`（type 字符串不含 `assistant` 且通常无 role），所以它也不等价于快速编辑的 assistant 同步逻辑（[`src/core.js:1585-1607`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1585-L1607)）。

## 4. 编辑能力矩阵：严格区分语义

| 操作 | coldxx 实现 | 是否保留后续消息 | 语义与风险 |
|---|---|---:|---|
| **原地 turn 编辑** | 有，UI `PUT /turns/:id/edit` | **是** | 仅改目标路径；record 数量/顺序和后续数组元素不变。并发无保证。 |
| **整 record 编辑** | 有，`PUT /records/:line` | 是 | 后续保留，但可任意破坏 type/id/call_id/schema。 |
| **文本 replace** | 有，CLI/UI | 是 | 递归字符串替换，不是逻辑消息编辑；可能波及协议字段。 |
| **record 删除（drop）** | 有，按 1-based 范围 | 其余后续保留并前移 | 不检查 turn 完整性、工具调用配对。 |
| **session 删除/clean** | 有；默认移动 Trash，可 permanent | 不适用 | 删除/搬走整个 rollout，不是内容编辑。 |
| **truncate** | 有；保留选中 turn，删除其 `endLine` 后全部 record | **否** | 是截尾/回退，不是原地编辑（[`src/core.js:1124-1154`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1124-L1154)）。 |
| **fork** | 仅识别 parent 元数据 | 原父会话不变 | 不会创建新 rollout；不是编辑替代方案。首个 `session_meta.id` 仍作为 fork 自身 id（[`src/core.js:562-577`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L562-L577)）。 |
| **repair** | 无 | — | 没有 schema/turn/call pair 修复器。 |
| **compact** | 无会话压缩功能 | — | 源码中的 `compactPath`/CSS `compact` 仅展示，不是 Codex context compaction。 |

### 后续历史与一致性

- **源码已确认**：turn 编辑对 `records.slice()` 中指定行的深拷贝设值；未目标化的 earlier/later record 对象按原顺序序列化。因此单写者情况下，后续逻辑历史保留（[`src/core.js:1079-1119`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1079-L1119)）。
- **隔离测试已确认**：合成两 turn、12 records 的 rollout 中，首 turn 的 2 个 user 副本和 3 个 assistant 副本同步更新；第二 turn、reasoning、function call/output、顺序及相等 `call_id` 均保持。全文件空白格式被规范化。
- **session ID**：快速编辑不会目标化 `session_meta.id`；但 raw record 编辑和 replace 可修改它，且无“文件名 id = metadata id”校验。
- **turn 边界**：更新本身不移动边界；drop/raw 修改 `task_started` 可令下一次重新分组改变。
- **call_id 配对**：快速消息编辑通常不触碰工具 records；drop、raw 编辑、宽泛 replace 都可能产生 dangling/mismatched pair，项目无验证器。

## 5. 恢复语义的四层证据

必须把四层分开，不能从“文件变了”推导“模型采用了”：

| 层级 | 判断 | 证据等级 |
|---|---|---|
| 1. UI 已变化 | 文本改写结果先只替换 modal textarea；保存 API 成功后重新 `loadRecords()`。浏览器真实交互未跑。 | **源码已确认**（[`src/ui-server.js:3931-3953`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L3931-L3953)，[`src/ui-server.js:4006-4026`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L4006-L4026)）；实际 UI 为**待验证**。 |
| 2. 存储已写回 | JSONL 经备份、临时文件、rename 覆盖；隔离 fixture 复读得到新值。 | **源码已确认 + 隔离测试已确认**。 |
| 3. `codex resume` 成功 | coldxx 没有调用 resume，也没有兼容性测试矩阵。 | **待验证 / 未知**。不能对不同 Codex CLI 版本外推。 |
| 4. 模型恢复后实际使用修改内容 | 取决于 Codex 恢复时读取哪些 record、是否使用 event/item/compact state/其他索引；本仓库无证据。 | **待验证 / 未知**。 |

README 称工具可“查看、清理、备份、恢复和修改历史”，以及“回退到某轮”，这仅是**文档声称**，不是第 3/4 层证据（[`README.zh-CN.md:11-26`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/README.zh-CN.md#L11-L26)）。

## 6. 写入可靠性与失败恢复

### 已有保护

- **源码已确认**：每次有效 session edit/drop/truncate 前复制原文件，并写包含 original/backup path、原因、时间的 manifest（[`src/core.js:118-145`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L118-L145)）。恢复前又备份当前版本，再 copy 到同目录 tmp、沿用当前 mode、rename 覆盖（[`src/core.js:202-250`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L202-L250)）。
- **源码已确认**：普通 session 写入尝试把原 `stat.mode` 用于临时文件，并同目录 rename；这降低半写文件风险（[`src/core.js:109-116`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L109-L116)）。
- **源码已确认**：summary 保存真实文件 mtime 为 `fileUpdatedAt`；10 分钟窗口判 active。CLI 默认拒绝 active，除非 `--allow-active`；UI返回 409，开关可绕过（[`src/core.js:523-531`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L523-L531)，[`src/core.js:1528-1534`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1528-L1534)，[`src/ui-server.js:424-434`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L424-L434)）。
- **隔离测试已确认**：备份逐字节等于原文件、最终 fixture mode 为 `0640`、成功后无 dangling tmp；这只覆盖正常路径。

### 缺口

| 方面 | 结论 |
|---|---|
| 锁 / 并发 | **源码已确认：无 flock/lock。**Codex 在 read 与 rename 间追加的 record 可被旧快照覆盖；两个 coldxx 写入也是 last-writer-wins。 |
| CAS | **源码已确认：无 expected hash、mtime、size、inode 或版本检查。**UI turn plan 获取和保存之间若文件变化，组 ID 可能失配并静默 `changedGroups=0`，也可能覆盖并发内容。 |
| 活动检测 | 仅 mtime 时间窗启发式；不能证明进程持有/正在写，10 分钟外的长任务会成为假阴性，刚结束则假阳性。 |
| 原子与耐久 | 同目录 `rename` 通常提供名称级原子替换，但未 `fsync` 文件/目录；断电耐久未知。未测试跨平台 rename 行为。 |
| 权限 | session tmp 仅以 `mode` 创建，未显式恢复 owner/group/ACL/xattr；umask 仍可能影响创建 mode。profile 写入甚至不沿用旧 mode。 |
| tmp 清理 | `writeJsonlAtomic()` 没有 `try/finally` unlink；写/rename 失败可能遗留 tmp。`ensureNoDanglingTmpFiles()` 只是导出的检查函数，生产链未调用（[`src/core.js:2153-2157`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L2153-L2157)）。 |
| 备份完整性 | manifest 无 hash/长度，恢复不校验备份内容或 JSONL/schema。备份成功、写回失败时会留下“未实际生效”的操作历史。 |
| 语义校验 | 只校验 JSON 对象/行范围，不校验 session id、turn 边界、content type、call_id 对、事件顺序。 |

## 7. 许可证、依赖、耦合与复用价值

- **源码已确认**：MIT，允许使用、复制、修改、合并、发布、分发、再许可/出售；复制或 substantial portions 需保留版权和许可声明，且无担保（[`LICENSE:1-20`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/LICENSE#L1-L20)）。
- **依赖/部署**：Node `>=20`、零第三方 runtime deps、无构建步骤，提取成本低。单文件 UI 便于搬运但 `ui-server.js` 逾 5k 行，视图/API/状态耦合较重。
- **Codex 版本耦合**：项目不绑定正式 schema，兼容靠宽松字段探测和启发式 turn 边界。优点是未知 record 原样保留；缺点是新版 record 名称、边界或恢复语义变化不会被显式发现。summary 暴露 `cliVersion` 却不据此选择解析器。
- **Claude 支持**：**无。**Anthropic-compatible 仅是“改写文本”的远程 LLM 后端，不是读取/编辑 Claude Code history（[`src/core.js:472-503`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L472-L503)，[`src/core.js:1966-1989`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1966-L1989)）。

### 建议复用/重写

| 模块 | 建议 | 成本 |
|---|---|---|
| `readJsonl` / 备份 manifest /同目录替换 / rollback | 可提炼为引擎无关 storage adapter；补流式读取、物理行映射、hash CAS、锁、fsync、tmp cleanup、权限/ACL策略 | 中 |
| session selector/摘要/Trash | 大体可复用；路径和元数据提取改由 engine adapter 提供 | 低—中 |
| Codex `editableMessageTargets` | 有直接价值，作为 Codex adapter 起点；需稳定身份关联、record type allowlist、call pair/turn validator | 中—高 |
| `groupSessionTurns` | 只能作为 fallback；应按 CLI/schema 版本分解析策略并保留“不确定边界”状态 | 高 |
| UI turn/line 双视图 | 交互概念可复用；不建议直接复制巨型内嵌脚本 | 中—高 |
| Claude Code | 需独立 discovery/parser/identity/writeback adapter；coldxx 没有可直接复用的 Claude 语义代码 | 高 |

对统一双引擎产品，最合理的 seam 是：`EngineAdapter.discover/read/parseTurns/planEdits/validate` + 共享 `VersionedFileStore.backup/compareAndSwap/atomicReplace/restore`。跨引擎只共享存储安全和 UI 概念，**不能共享“按文本相等同步副本”的 Codex 规则**。

## 8. 风险、未知项与最小隔离验证方案

### 主要未知/风险

1. **待验证 / 未知**：目标 Codex CLI 各版本究竟从哪些 rollout records 重建模型输入，是否读取其他数据库/索引；尤其 event 与 response item 冲突时谁优先。
2. **待验证 / 未知**：带完整后续历史的中间 turn 改写后，`resume` 是否接受，以及模型下一轮看到旧文本还是新文本。
3. **源码已确认的风险**：无 CAS/锁导致追加丢失；active mtime 不是充分保护。
4. **源码已确认的风险**：文本相等聚组存在漏同步/误合并；raw/drop/replace 可破坏 tool pairing 和事件顺序。
5. **源码已确认的风险**：API key 以浏览器 localStorage 明文保存；如启用远程 rewrite，选中文本会发送到配置 endpoint。README 的“除非显式配置远程后端，否则不上传”属于**文档声称**（[`README.zh-CN.md:299-303`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/README.zh-CN.md#L299-L303)）。

### 推荐最小验证（不要碰真实会话）

1. 为每个受支持 Codex CLI 版本建立完全独立的临时 `CODEX_HOME`，只放人工合成/由 mock producer 生成的 rollout；禁止网络和真实账号。
2. 构造：双重 user、三重 assistant、多个 content blocks、reasoning、完整 function call/output 配对、至少两个后续 turns、fork metadata、compact 相关未知 record、含空行 JSONL。
3. 保存前记录文件 hash/mtime/inode/mode；在“读取后、rename 前”并发追加哨兵 record，确认新实现 CAS 拒绝而非覆盖。
4. 分别验证 quick edit、raw edit、drop、truncate；检查 record 顺序、session/turn id、call_id 一一配对、未知 record 字节/值保留、备份 hash 与失败注入后的恢复。
5. 若政策允许验证 resume，只对隔离、无网络或 mock 模型的 Codex 运行：分别记录“进程返回成功”“重建出的模型请求内容”两项，不能只看 UI 或文件。每个 CLI 版本单独出证据，不外推。

## 9. 本次实际验证

- **隔离测试已确认**：执行 `.研究临时数据/coldxx/isolated-check.mjs`；所有数据仅在项目 `.研究临时数据/coldxx/fixture/`。结果：2/3 个 user/assistant 重复 targets 同步；changed lines 为 `3,4,6,7,8`；后续 4 records、reasoning 与 call pair 保留；备份逐字节一致；mode `0640`；无成功路径 tmp；全文件格式被重写。
- **隔离测试已确认**：在候选仓库执行 `npm run check`，Node.js v24.14.1；三个源码文件语法检查通过。
- **未运行**：仓库自带 `npm test`（其 fixture 使用系统 `os.tmpdir()`，不满足本任务“仅使用项目 `.研究临时数据/`”限制）；未进行真实浏览器 UI 操作、故障注入、并发竞争、跨平台检查、Codex/Claude resume 或任何模型请求。

## 10. 结论

coldxx 对用户目标的最有价值证据是：**该项目已把 Codex rollout 的逻辑消息按多重文本表示建模，编辑器可在一次提交中同步这些记录；并且在单写者、格式兼容前提下，中间 turn 的路径级修改可以保留全部后续 record。**前者是 coldxx 源码与合成 fixture 所支持的结构，不是所有 Codex CLI 版本的事实证明。其实现证明了这一产品形态可行，但没有证明恢复语义。

新项目应复用其“turn 主视图 + 原始 record 兜底”“编辑前备份”“Codex target 映射”思路；写入层必须新增版本化 CAS/锁、物理行映射、schema/顺序/call_id 验证、故障安全和逐 CLI 版本 resume 验证。Claude Code 必须独立建模，不能把 Anthropic rewrite 接口误认为 Claude session 支持。

## 证据索引

| 主题 | 固定提交源码 |
|---|---|
| JSONL 发现/解析/写回 | [`src/core.js:60-116`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L60-L116) |
| session 摘要/fork metadata | [`src/core.js:520-610`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L520-L610) |
| turn 分组 | [`src/core.js:1290-1435`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1290-L1435) |
| 双重表示 targets | [`src/core.js:1437-1485`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1437-L1485) |
| turn 聚组与同步更新 | [`src/core.js:1156-1263`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1156-L1263) |
| record 更新 | [`src/core.js:1036-1122`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1036-L1122) |
| truncate | [`src/core.js:1124-1154`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1124-L1154) |
| 备份/恢复 | [`src/core.js:118-250`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L118-L250) |
| active guard | [`src/core.js:1528-1534`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/core.js#L1528-L1534)，[`src/ui-server.js:424-434`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L424-L434) |
| API/UI 保存链 | [`src/ui-server.js:275-415`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L275-L415)，[`src/ui-server.js:3741-4050`](https://github.com/outx-sec/coldxx/blob/9265318527336a9300f29584690c12a1d4e3cc31/src/ui-server.js#L3741-L4050) |
