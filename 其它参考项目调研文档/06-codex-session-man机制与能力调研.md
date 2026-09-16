# codex-session-man 机制与能力调研

> 调研对象：`参考项目/codex-session-man/`\
> 固定快照：`e649549f008497c723b9ba51f90e089aa8657707`（tag `v0.2.8`，2026-03-05；本地 HEAD 已核对）\
> 上游：`bimcc/codex-session-man`；下文源码链接均固定到该 commit。README 只按“文档声称”计证。

## 摘要

**源码已确认**：这是一个小型 VS Code Webview 扩展，运行时代码是 CommonJS JavaScript，**没有 TypeScript 源码、`src/` 或 `tsconfig.json`**；唯一 npm 依赖只是开发期 `@types/vscode`。它把 Codex `state_5.sqlite` 的 `threads` 表当会话目录/索引，再按 `rollout_path` 流式读取 rollout JSONL。现有写操作仅有：修改首行 `session_meta.payload.model_provider` 并同步 DB、DB 从文件修正 provider、归档/恢复文件并更新 DB 路径、为疑似卡住 turn 追加 abort 事件。技术栈和入口见[固定 commit 文件树](https://github.com/bimcc/codex-session-man/tree/e649549f008497c723b9ba51f90e089aa8657707)、[`package.json` L1–18](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package.json#L1-L18)、[`package.json` L61–69](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package.json#L61-L69) 及 [`extension.js` `activate` L28–84](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L28-L84)。

**结论**：项目**没有用户/assistant 消息正文原地编辑能力**，也没有删除、截断、fork、compact 或原始记录编辑。它不定位消息行/内容块，不保留消息 ID，不处理 `call_id`，也不协调 Codex 中可能重复的 `event_msg` / `response_item` 表示。因此它不能直接满足“修改已有消息并保留后续消息”；适合复用的是 VS Code 壳、`threads` 查询、JSONL 流式预览、provider 双存储差异检测和首行替换，不是历史编辑内核。

## 1. 项目定位与扩展架构

### 1.1 激活、命令和模块形态

- **源码已确认**：manifest 只贡献 `codexSessionManager.open` 一个命令、一个 Activity Bar 容器和 `codexSessionManager.main` Webview View；由命令或视图激活（[`package.json` L14–59](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package.json#L14-L59)）。
- **源码已确认**：`activate()` 注册匿名 `WebviewViewProvider`；打开命令优先聚焦侧栏，失败才创建 Webview Panel。不存在 TreeDataProvider、独立 provider/service 类或后端进程；业务函数集中在 `extension.js`，前端状态/RPC/渲染集中在 `media/webview.js`（[`extension.js` L28–84](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L28-L84)，[`setupWebview` L88–117](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L88-L117)）。
- **源码已确认**：Webview 以 `{id, op, payload}` 发 RPC，扩展宿主经 `handleOperation()` 分派，再回 `{id, ok, data/error}`；前端有 45 秒超时（[`media/webview.js` `rpc` L103–143](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L103-L143)，[`extension.js` `handleOperation` L136–179](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L136-L179)）。
- **源码已确认**：`codexHome` 来自 VS Code configuration，空值解析为 `~/.codex`；没有使用 `workspaceState`、`globalState`、`storageUri` 或 `globalStorageUri`（[`getConfig` / `resolveCodexHome` L119–134](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L119-L134)）。Webview 的筛选、选中项等只在页面内存 `state` 中（[`media/webview.js` L4–20](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L4-L20)）。

### 1.2 UI 表象

**源码已确认**：界面是“活动/归档列表 + 搜索/provider 筛选 + 详情消息预览 + provider 编辑 + 执行状态修复 + resume/归档操作”。详情消息仅渲染 `role`、时间、扁平文本，没有编辑控件、行号、record ID、turn ID 或内容块视图（[`renderDetail` L387–441](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L387-L441)，[`getWebviewHtml` L1631–1700](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1631-L1700)）。所谓“编辑”按钮只属于 Provider。

## 2. 发现、读取、解析和写回调用链

### 2.1 会话发现与展示

1. `bootstrap()` → `loadHealth()` / `loadConfigProviders()` / `loadList()`（[`media/webview.js` L1034–1048](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L1034-L1048)）。
2. `handleOperation("listSessions")` 固定打开 `${codexHome}/state_5.sqlite`，用内建 `node:sqlite.DatabaseSync` 且 `readOnly:false`（[`extension.js` L136–194](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L136-L194)）。
3. `listSessions()` 查询 `threads` 表：活动/归档取决于 `archived`，搜索仅是 id/title/cwd/first_user_message/model_provider 的 SQL `LIKE`，排序 `updated_at DESC`。UI 请求上限 300；普通模式 mismatch 计数也只统计已取这批，`mismatchOnly` 才分页扫完整结果（[`buildWhere` / `listSessions` L520–653](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L520-L653)，[`loadList` L523–565](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L523-L565)）。
4. 每条 DB row 再读取 `rollout_path` 的**首行**，要求 `type=session_meta` 且有 `payload.id`，取 `payload.model_provider` 与 DB 比较；这里不校验首行 id 等于 row id（[`readFileProvider` L498–519](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L498-L519)，[`parseSessionMetaFromFile` L655–708](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L655-L708)）。
5. 选择会话后 `getSessionDetail()` 再查 `threads`，然后逐行流式读 JSONL；每行 JSON 解析失败会静默跳过，只保留最后 `maxMessages` 条可展示消息（UI 为 220，后端限制 20–500）（[`readSessionMessages` L814–849](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L814-L849)，[`getSessionDetail` L1193–1254](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1193-L1254)）。

**源码已确认**：项目不扫描 `sessions/` 发现孤儿文件，不读取/写入 `history.jsonl` 或另一份 session index，也没有 SQLite schema 建表、迁移、版本探测或重建索引逻辑。DB 没有 thread row 的 rollout 即不可见；row 路径错误则详情失败/为空。

### 2.2 消息解析粒度

`parseMessageEvent()` 只接受两类：

- `event_msg.payload.type=user_message` → `payload.message`；
- `response_item.payload.type=message` → role + `payload.content`。

证据为 [`parseMessageEvent` L781–812](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L781-L812)。`extractTextFromContent()` 会把字符串，或数组项的 `text` / `output_text` / `input_text` / `refusal` 以换行拼接并 `trim()`；未知块被忽略（[`extractTextFromContent` L736–779](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L736-L779)）。

由此得到：

- **源码已确认**：可预览 user 与 assistant 的扁平正文；多文本块合并后失去块边界和块类型。
- **源码已确认**：`reasoning`、function/custom tool call、tool output/result、token/event 及未知原始记录均不可见；`call_id` 不读取。
- **源码已确认**：若同一用户输入同时以 `event_msg.user_message` 和 `response_item.message(role=user)` 存在，会显示两次；代码没有去重或关联模型。
- **源码已确认**：返回 UI 的消息对象只有 role/text/timestamp，无物理行、record ID、turn ID，因而无法稳定定位或编辑某个原始内容块。

### 2.3 实际写操作

#### A. Provider 原地替换（不是消息编辑）

UI `onSaveProvider()` → RPC `updateProvider` → `updateProvider()` 查 thread/path → `writeProviderToSessionFile()`：校验首行 session id，修改 `payload.model_provider`，在同目录写临时文件（重序列化首行 + 原字节流复制其余内容），rename 覆盖原 JSONL；之后 `UPDATE threads SET model_provider, updated_at`（[`media/webview.js` L621–647](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L621-L647)，[`writeProviderToSessionFile` L710–734](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L710-L734)，[`updateProvider` L1256–1296](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1256-L1296)）。

`batchUpdateProviders()` 对每个 id 重复上述顺序，逐条收集失败，既没有全批事务也没有回滚（[`extension.js` L1299–1364](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1299-L1364)）。`repairSingle()` 则反向只把 JSONL provider 写入 DB，不改文件，且不核验文件 id 与 thread id（[`extension.js` L1365–1412](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1365-L1412)）。

#### B. “删除/恢复”实际是归档/取消归档

UI 元素名虽为 `deleteRestoreBtn`，按钮文字与 RPC 实际调用是“归档会话”/`moveToRecycle` 或“恢复会话”/`restoreFromRecycle`（[`media/webview.js` L718–780](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L718-L780)）。归档把文件移到 `archived_sessions/<basename>`，随后把 DB `archived=1`、`archived_at`、`updated_at`、`rollout_path` 更新；恢复根据 rollout 文件名日期放回 `sessions/YYYY/MM/DD/`，不匹配日期则放 `sessions/restored/`，再清 DB archived 字段（[`buildArchiveRolloutPath` / `buildSessionRolloutPath` L275–300](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L275-L300)，[`moveToRecycle` L1413–1480](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1413-L1480)，[`restoreFromRecycle` L1482–1548](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1482-L1548)）。它不删除 DB row 或 JSONL，也不是从 `.bak` 回滚。

#### C. 执行状态 repair

`analyzeSessionExecutionHealth()` 只扫描 `event_msg`：按若干可能位置提取 `turn_id`，用 `task_started` 加计数，用一组 complete/aborted/failed 事件减计数，再结合 JSONL 最后事件时间和文件 mtime 的 600 秒阈值判断 `healthy/running/stuck`（[`extractTurnId` / `TASK_CLOSE_EVENTS` L851–885](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L851-L885)，[`analyzeSessionExecutionHealth` L886–1046](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L886-L1046)）。repair 只对可修复 stuck turn：先复制 `.bak-<秒级时间戳>`，再在尾部追加 `task_aborted` 和 `turn_aborted` 两行，最后只更新 DB `updated_at`（[`appendAbortEvents` L1048–1098](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1048-L1098)，[`repairSessionHealth` L1133–1192](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1133-L1192)）。这是**补终止事件的状态修复**，不是正文 repair、截断或 compact。

## 3. 能力矩阵：必须严格区分的语义

| 操作/粒度 | 结论 | 证据等级与说明 |
|---|---|---|
| 浏览 user/assistant 正文 | 部分支持 | **源码已确认**：只看两种 message 表示并扁平化文本；最多最后 220 条。 |
| 多内容块 | 只合并文本 | **源码已确认**：块边界、类型及未知块丢出视图。 |
| reasoning、工具调用/结果、event 原始记录 | 不支持 | **源码已确认**：解析器无对应分支，UI 无 raw 模式。 |
| 原地编辑 user/assistant 正文且保留后续 | **不支持** | **源码已确认**：唯一编辑表单/写回函数针对 provider；不存在 message 更新 RPC。 |
| provider 编辑 | 支持 | **源码已确认 + 隔离测试已确认**：改 JSONL 首行后同步 DB，后续字节保持不变。 |
| 删除 | **不支持** | **源码已确认**：所谓 delete 按钮实际移动至 archive，DB row 保留。 |
| 截断/回滚到某 turn | 不支持 | **源码已确认**：无删除尾部记录逻辑。 |
| fork | 不支持 | **源码已确认**：不生成新 session id、不复制历史分支、不重建索引。 |
| repair | 仅两种狭义 repair | **源码已确认**：DB provider ← FILE；或给 stuck turn 追加 abort 事件。都不改消息正文。 |
| compact | 不支持 | **源码已确认**：不识别 compact/summary/snapshot，也不生成压缩记录。 |
| 迁移/索引重建 | 不支持 | **源码已确认**：只有既存 `state_5.sqlite.threads` 的读写。 |
| 归档/恢复 | 支持移动/取消移动 | **源码已确认 + 隔离测试已确认**：session id 不变，文件路径和 DB archived 状态改变。 |
| resume | 只发命令 | **源码已确认**：复制或终端发送 `codex resume <id>`；不观测退出码/加载结果。 |

### “保留后续历史”边界

**源码已确认**：provider 更新只重写第一行、流式复制其后字节，因此对于这个**元数据字段**，后续历史确实保留；但项目根本没有消息编辑，不能把这一性质外推为“正文原地编辑可保留后续”。session id 在 provider 写入时会校验，归档/恢复不生成新 id；health repair 复用提取出的 turn id 并只向末尾追加。相反，消息记录顺序、双重表示一致性、`call_id` 配对、compact 边界均没有校验或更新。

## 4. 多存储层来源、更新关系与部分更新风险

| 层 | 来源/用途 | 是否写入 | 一致性关系 |
|---|---|---|---|
| VS Code configuration | `codexSessionManager.codexHome` | 用户设置由 VS Code 管；扩展只读 | 只决定根目录；未持久化 UI 状态。 |
| `config.toml` | 展示 active/可选 providers | 否 | 自制轻量 TOML 行解析器；不修改配置（[`parseConfigProvidersText` L392–465](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L392-L465)）。 |
| `state_5.sqlite.threads` | 唯一会话目录/搜索索引、摘要元数据、rollout 路径 | 是 | provider、updated/archive/path 被直接 `UPDATE`；无 schema/version 适配。 |
| rollout JSONL | 首行 session meta、消息预览、执行事件 | 是 | provider 重写首行；health repair 尾部 append；不更新正文。 |
| `archived_sessions/` / `sessions/` | JSONL 文件位置 | 是 | 先移动文件，再更新 DB `rollout_path`。 |
| 其他历史索引 / VS Code storage | 未使用 | 否 | 不更新 `history.jsonl`、额外索引、workspace/global storage。 |

**源码已确认**：跨 SQLite/文件系统不存在事务边界，主要部分更新窗口是：

1. provider：JSONL rename 成功而 DB `UPDATE` 失败，会留下 FILE 新、DB 旧；项目能显示 mismatch，之后可 `repairSingle()` 令 DB 跟文件一致，但没有自动补偿。
2. batch：单会话和整批都允许部分成功，返回 failures 但不回滚。
3. archive/restore：先移动文件后更新 DB；DB 失败会留下旧 `rollout_path` 指向不存在位置。跨卷 `EXDEV` 退化为 copy + unlink，更非原子（[`moveFileSafe` L253–273](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L253-L273)）。
4. health repair：backup → append → DB update；任一步后续失败都无自动恢复。`.bak` 没有恢复 UI。
5. 当源文件不存在而推定目标路径存在时，归档/恢复会把它当成“其他工具已移动”，却不解析目标文件确认 session id，存在误配风险（[`moveToRecycle` L1440–1454](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1440-L1454)，[`restoreFromRecycle` L1509–1523](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1509-L1523)）。

## 5. “恢复有效”四层证据必须分开

| 层次 | 当前证据 | 结论 |
|---|---|---|
| 1. UI 表象 | **源码已确认**：保存后重载详情/列表并显示成功状态（[`onSaveProvider` L634–645](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L634-L645)）。 | 能反映重新读取后的 provider；未跑真实 Extension Host UI。 |
| 2. 实际存储写回 | **源码已确认 + 隔离测试已确认**：合成 JSONL 首行和 SQLite provider 均变化，首行后的字节完全相同；repair/归档也实际落盘。 | 对已实现操作成立；不涉及消息正文。 |
| 3. Codex resume 成功 | **源码已确认**：`runResumeCommand()` 只创建/复用终端并 `sendText`，随即返回 `started:true`（[`extension.js` L1576–1599](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1576-L1599)）。 | **待验证 / 未知**：没有检查 Codex 是否找到/解析/恢复该会话。 |
| 4. 模型实际使用修改内容 | 无模型调用、上下文检查或断言。 | **待验证 / 未知**：尤其不能从“终端已发送命令”推导模型采用修改历史。 |

README 称可“直接执行 resume”“修复可加载性”（[`README.md` L23–32](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/README.md#L23-L32)），仅属于**文档声称**；其中 provider 与 repair 写盘有源码支持，但 resume 成功和模型实际采纳没有证据。

## 6. 写入可靠性与并发

### 已有保护

- **源码已确认**：provider 写入先验证首行格式和 session id，再用同目录临时文件 + rename 替换；其余 JSONL 从首行结束偏移流式复制，避免在内存重建整文件（[`extension.js` L655–734](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L655-L734)）。
- **源码已确认**：同名归档目标通过 `-1/-2...` 避免覆盖；move 支持 `EXDEV` 退化路径（[`ensureUniqueFilePath` / `moveFileSafe` L239–273](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L239-L273)）。
- **源码已确认**：只有 health repair 在写入前自动备份并前后重跑状态分析；批量 provider、归档/恢复和 health repair 有模态确认（[`media/webview.js` L690–715](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L690-L715)、[L728–745](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L728-L745)、[L841–866](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/media/webview.js#L841-L866)）。

### 缺口

- **源码已确认**：provider 修改无备份；临时文件失败后无清理；没有 `fsync`/目录同步，替换后的 mode 也由新建临时文件决定。rename 是良好的同目录替换模式，但不等于掉电可恢复保证。
- **源码已确认**：无文件锁、活动 Codex 进程/打开 session 检测、mtime/hash/size/版本乐观并发检查。读首行与复制尾部之间若 Codex 并发追加/修改，结果没有冲突检测。
- **源码已确认**：health 的 `running/stuck` 是 event + mtime 启发式，不是锁或进程检测；它只在用户主动检测/repair 时使用，不会阻止 provider 更新、归档或 resume。repair 在分析、备份、append 之间也不重新检查。
- **源码已确认**：没有显式 SQLite transaction、busy timeout 或跨存储回滚；仅依赖单条 SQL 的 SQLite 行为。
- **源码已确认**：repair 备份名只有秒级精度，同一秒再次 repair 可覆盖同名备份；无备份清单、保留策略和恢复命令（[`buildBackupPath` L1048–1051](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1048-L1051)）。

## 7. 许可证、依赖、版本耦合与复用成本

### 7.1 许可与依赖

- **源码已确认**：MIT License，允许使用、复制、修改、合并、发布、分发、再许可/销售；分发 substantial portions 需保留版权及许可声明，无担保（[`LICENSE` L1–20](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/LICENSE#L1-L20)）。
- **源码已确认**：manifest 要求 VS Code `^1.90.0`，运行时依赖 VS Code API及 Node 内建 fs/path/readline/stream/`node:sqlite`；lockfile只有 `@types/vscode` 开发依赖（[`package-lock.json` L1–24](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package-lock.json#L1-L24)）。
- **待验证 / 未知**：`^1.90.0` 覆盖的较早 VS Code runtime 是否提供 `node:sqlite`。源码会在不可用时直接报“update VS Code”，但没有更精确最低版本或 fallback（[`getSqliteModule` L16–25](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L16-L25)、[`openDb` L181–194](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L181-L194)）。README 将内建 `node:sqlite` 作为当前实现说明，属于**文档声称**（[`README.md` L75–78](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/README.md#L75-L78)）。

### 7.2 Codex 耦合

无 Codex npm SDK 依赖，但数据契约高度硬编码：`state_5.sqlite`、`threads` 列名、首行 `session_meta`、`model_provider`、`event_msg`/`response_item` 类型、task 事件名、rollout 文件名日期和 `codex resume` CLI。`cli_version` 只查询返回，未用于分支解析/写入策略（[`listSessions` 查询 L583–590](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L583-L590)，[`getSessionDetail` L1203–1244](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1203-L1244)）。因此 Codex schema/事件演进可能表现为 SQL 失败、消息消失、误判 stuck 或写入不兼容；没有 schema capability negotiation。

### 7.3 可复用模块与成本

| 模块 | 可复用判断 | 新项目所需改造 |
|---|---|---|
| Webview RPC/双栏 UI | 中等 | 可提取壳和样式；需加入 record/block identity、raw/结构化视图、编辑状态与冲突提示。 |
| `listSessions` / `getSessionDetail` | Codex 专用但有价值 | 抽为 `CodexProvider`；加 schema 探测、孤儿扫描、分页、错误显式化及版本测试。 |
| `firstLineInfo` / `writeProviderToSessionFile` | 较高 | 可复用流式“首行替换”模式；补备份、权限保持、fsync、mtime/hash CAS、临时文件清理和跨存储事务日志。 |
| 消息 parser | 低到中 | 目前是有损 preview parser；历史编辑需无损行模型、双重表示关联、块级 identity、turn/call 配对和 compact 感知。 |
| archive/repair | 低到中 | 先修跨 SQLite/FS 原子性与目标 id 校验；health 事件集需按 Codex 版本验证。 |

**脱离 VS Code 成本：中等**。纯 Node 的 DB/文件/parser 函数可拆出，但配置、确认弹窗、剪贴板、终端、RPC、CSP/Webview 资源都直接依赖 `vscode`；需替换宿主适配器。没有 TypeScript 类型边界，拆分时还需建立 provider/service 接口和数据类型。

**适配 Claude Code 成本：高**。Claude 的会话发现位置、JSONL schema、消息 identity/父链/sidechain、工具块、compact/summary、resume 命令和归档索引均未抽象。可共用的主要是 UI 壳、无损文件写入应有的基础设施和通用 RPC；现有 SQLite/threads/provider/task repair 不能直接复用。若目标是统一 Codex/Claude 编辑器，应新建 `SessionProvider` 接口，而不是在 `handleOperation()` 中继续堆条件分支。

## 8. 隔离验证、风险与最小后续方案

### 8.1 本次实际验证

**隔离测试已确认**：未联网，未访问真实 `~/.codex`/`~/.claude`，未运行 Codex、Claude 或真实 resume，未启动 VS Code Extension Host；候选仓库 `git status --short` 为空。使用 Node `v24.14.1`，在项目 `.研究临时数据/codex-session-man/` 创建合成 `state_5.sqlite` 和 8 行 rollout，并以 VM 注入 `vscode` stub 调用候选源码函数：

1. `listSessions` 成功发现 1 条 synthetic thread；`getSessionDetail` 把 event/response 的同一 user 文本显示两次，只显示一条由两个文本块拼成的 assistant 消息；reasoning、function call/output 不显示。
2. `updateProvider` 后 JSONL 首行和 DB 都从 `old-provider` 变为 `new-provider`，首行之后的字节逐字节保持一致。
3. 合成 stale `task_started(turn-1)` 被判为 `stuck`；repair 创建备份、追加 2 行 abort，复检为 `healthy`。
4. archive/restore 实际移动文件并更新 DB，均成功。
5. 另执行 `node --check extension.js` 与 `node --check media/webview.js`，语法检查通过。

测试脚本保留在 `.研究临时数据/codex-session-man/isolated-check.js`。这只是**算法/存储级合成验证**，不能证明特定 VS Code/Codex 版本兼容、真实 resume 成功或模型采用变更。

### 8.2 主要风险与未知项

1. **需求缺口（确定）**：没有正文编辑，更无 event/response、turn/call、compact 一致性写入。
2. **版本风险（确定存在、影响待测）**：硬编码 `state_5`/threads 列和事件名；没有 Codex 版本矩阵。
3. **并发/部分写风险（确定）**：无锁/CAS/活动保护和跨存储事务；任何写操作都可能与 Codex 并发。
4. **恢复语义（未知）**：追加两种 abort 事件是否被目标 Codex 版本接受、是否足以解除真实 stuck；provider 改写是否影响 resume 可加载性；均未真实验证。
5. **模型上下文（未知）**：即使 rollout/DB 改写且命令启动，Codex 是否重建并采用修改内容，需官方机制及隔离 CLI 验证；本项目没有证据。
6. **UI/运行时兼容（未知）**：未运行 Extension Host；最低 VS Code 对 `node:sqlite` 的实际支持范围未验证。

### 8.3 面向新编辑器的最小隔离验证方案

1. 为每个受支持 Codex 版本准备复制到临时 `CODEX_HOME` 的 fixture：覆盖 event/response 双表示、多块、reasoning、function/custom tool、call output、compact、坏行及 WAL DB。
2. 先做只读 round-trip：为每行保留原字节、偏移、record kind、turn/message/call identity；无修改保存必须 byte-identical。
3. 对单条 user/assistant 文本定义显式关联更新计划，验证只改变目标块，后续所有行顺序/session id/call 配对/compact 记录不被意外改变；不确定关联时拒绝写。
4. 写入前复制 JSONL+SQLite(+WAL/SHM 或经一致快照)、记录 hash/mtime/schema version；模拟 JSONL 写后 DB 失败、DB busy、并发 append、EXDEV 与进程崩溃，验证事务日志/回滚。
5. 最后才在一次性临时 home 和无网络/假模型或官方可控 fixture 中验证 `resume` 的“可加载”；“模型实际使用新内容”另设上下文观测断言，绝不以 UI 成功或进程启动代替。

## 9. 结论

`codex-session-man` 是**Codex 会话索引浏览器 + provider/归档/狭义状态修复工具**，不是会话历史编辑器。它最有价值的经验是：SQLite thread index 与 rollout file 必须同时看、provider 不一致可检测、首行可用流式临时文件替换；同时也直接暴露了新项目必须解决的问题：无损 record/block 模型、双重表示与 turn/call/compact 一致性、跨 SQLite/JSONL 的可恢复事务、活动会话保护和分层 resume 证据。

对用户核心目标的最终判断为：**不能直接采用；可有限抽取 Codex 读取/provider 基础模块与 VS Code UI 壳，但正文编辑、Claude provider、可靠写入和真实恢复验证都需要新设计。**

## 证据索引

| 主题 | 固定源码证据 |
|---|---|
| manifest / 激活 / 单命令 | [`package.json` L14–59](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package.json#L14-L59)，[`extension.js` `activate` L28–84](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L28-L84) |
| RPC operation 全集 | [`handleOperation` L136–179](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L136-L179) |
| SQLite threads 发现/搜索 | [`buildWhere` / `listSessions` L520–653](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L520-L653) |
| JSONL 消息解析 | [`extractTextFromContent` / `parseMessageEvent` L736–812](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L736-L812)，[`readSessionMessages` L814–849](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L814-L849) |
| Provider 双写 | [`writeProviderToSessionFile` L710–734](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L710-L734)，[`updateProvider` L1256–1296](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1256-L1296) |
| provider mismatch repair | [`repairSingle` L1365–1412](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1365-L1412) |
| stuck health / repair | [`analyzeSessionExecutionHealth` L886–1046](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L886-L1046)，[`repairSessionHealth` L1133–1192](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1133-L1192) |
| 归档/恢复 | [`moveToRecycle` L1413–1480](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1413-L1480)，[`restoreFromRecycle` L1482–1548](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1482-L1548) |
| Resume 仅发送命令 | [`runResumeCommand` L1576–1599](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/extension.js#L1576-L1599) |
| MIT / 依赖 | [`LICENSE` L1–20](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/LICENSE#L1-L20)，[`package.json` L61–69](https://github.com/bimcc/codex-session-man/blob/e649549f008497c723b9ba51f90e089aa8657707/package.json#L61-L69) |
