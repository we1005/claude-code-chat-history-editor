# Codex Session Manager 机制与能力调研

> 唯一调研对象：`参考项目/Codex-Session-Manager/`\
> 固定快照：`724c8bc391634b2d83f09e4cf0cc5147894ae2d0`\
> 本地 HEAD：已核对一致；提交时间 `2026-06-04T09:47:44+08:00`\
> 调研日期：2026-09-14；未联网，未读取或修改真实 `~/.codex` / `~/.claude`，未运行真实 resume 或模型请求。

## 摘要

**结论：该项目是 Codex 会话“浏览、侧栏修复、Provider 整体复制/迁移和清理”工具，不是历史消息编辑器，也完全没有 Claude Code 适配。**

- **源码已确认**：会话详情只把 rollout 尾部映射为只读 `ConversationItem` 后以 `<pre>` 展示；前端 API 和 Tauri command 集合没有消息编辑、保存、截断、fork 或 compact command。因此它**不能完成“原地修改一条既有用户/assistant 消息且保留后续消息”**。[UI 展示](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L794-L823)；[前端 API 全集](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/tauri.ts#L268-L292)；[后端 command 注册全集](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2709-L2744)。
- **源码已确认**：Provider **clone** 是复制完整 rollout、改首个 `session_meta` 的 id/provider/`cloned_from`、插入新 SQLite thread 和索引；原会话保留，但新 session id 改变。它不是选定 turn 的 fork，也不是原地编辑。[实现](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2015-L2111)。
- **源码已确认**：Provider **migrate** 保持 session id 和全部消息，只改 rollout 首个元数据中的 provider、SQLite provider/thread_source，并确保索引存在；它改的是 Provider，不是正文。[实现](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2113-L2157)。
- **源码已确认**：所谓 **repair** 只调整全局工作区/侧栏状态、SQLite 时间和 `thread_source`、补索引，不改 conversation；删除则删除整个 rollout/thread，而非删除单条消息。[repair 动作](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1520-L1555)；[删除](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2167-L2215)。
- **源码已确认**：多存储写入没有跨 JSONL/JSON/SQLite 事务、原子替换、文件锁、mtime/hash/版本前置检查或自动回滚。虽先复制备份并检测部分 Codex 进程，但中途失败可留下部分写入；`changedFiles` 还漏报 rollout 和 `session_index.jsonl`。[执行器](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1795-L1881)；[备份](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2273-L2339)。
- **源码已确认**：bundle import 和 backup restore 在此快照只是计划外壳；执行器没有 `preview_import` / `restore_file` 分支，实际 apply 会静默忽略。恢复 UI 甚至只显示计划 toast，没有把 restore 计划送入工作台。[import 计划](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2491-L2518)；[restore 计划](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2600-L2630)；[UI](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L1106-L1128)。

## 项目与快照

### 定位与技术栈

- **源码已确认**：React 19 + TypeScript + Vite 6 前端，Tauri 2 桌面壳，Rust 2021 后端；Rust 通过 `rusqlite`（bundled SQLite）、Serde JSON、Chrono、SHA-256、UUID 和 WalkDir 操作 Codex 状态。[npm 清单](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/package.json#L1-L33)；[Cargo 清单](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/Cargo.toml#L1-L27)。
- **源码已确认**：Web 入口 `src/main.tsx` 渲染 `App`；native 入口 `main.rs` 调 `codex_session_manager_lib::run()`，后者注册 22 个 Tauri commands。[Web 入口](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/main.tsx#L1-L10)；[Rust 入口](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/main.rs#L1-L3)；[`run`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2709-L2744)。
- **源码已确认**：`src/tauri.ts` 在 Tauri runtime 中动态导入 `invoke`，浏览器预览则返回 mock；所以浏览器里的成功/数据不代表真实状态读写。[invoke 分流](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/tauri.ts#L14-L37)。
- **文档声称**：README 将其描述为查看、修复、复制、迁移、备份和清理 Codex Desktop/CLI 会话的 Tauri 应用，而非消息编辑器。[README](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/README.md#L1-L9)。
- **源码已确认**：全仓源码/清单没有 Claude/Claude Code 字样；存储根固定为显式配置或 `~/.codex`。因此不能浏览或写回 Claude Code session。[`codex_home`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L327-L342)。

## 架构及跨层调用链

### 1. 发现与列表

1. **源码已确认**：`App.refresh()` 顺序调用 `scanCodexState`、`querySessions`、`getSessionDetail`、provider/skills/backups/cleanup/Git 状态，然后把结果放进 React state。[`refresh`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L386-L416)。
2. **源码已确认**：`scan_sessions*` 以 `state_5.sqlite.threads` 为主清单，读取 `session_index.jsonl` 的 id 集、全局 JSON 的 workspace/sidebar 映射，并从每个 SQLite row 指向的 rollout 前 24 行补 cwd 与 `cloned_from`。没有 SQLite row 的普通 orphan rollout 不会成为 session；`archived_sessions` 目录只被另外枚举成路径列表。[SQL/合并](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1154-L1261)；[归档路径枚举](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1263-L1271)。
3. **源码已确认**：后端另起 `codex app-server --stdio`，initialize 后分页调用 `thread/list`，按 `updated_at desc` 扫描至 1000 条；首屏按 50 条标记。调用失败只标 `unverified`，不把本地推断冒充官方列表。[app-server 客户端](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L884-L1001)；[状态合并](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1003-L1033)。
4. **源码已确认**：一次初始刷新会通过 inventory、query 和 detail 重复扫描，并可能重复启动 app-server；这是可复用前应消除的性能/竞态面。[前端调用](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L386-L416)；[`get_session_detail` 再扫描](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1381-L1390)。

### 2. rollout → UI 模型 → 展示

- **源码已确认**：详情仅读 rollout 最后 2 MiB/4000 行，最多显示最后 180 个 item，每项文本最多 12000 字符；截到文件中间时丢弃第一段残行。因此“详情”不是完整历史视图。[常量](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L42-L49)；[tail/限量](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L560-L605)。
- **源码已确认**：`normalize_rollout_row` 识别 message、reasoning、function/tool call、output 和 `event_msg.message`，其余序列化为 raw；`ConversationItem` 只有 id/kind/role/text/toolName/callId/timestamp。[类型](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L125-L145)；[解析](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L607-L675)。
- **源码已确认**：多 content block 被抽取 text/content/summary 后用换行拼成一个字符串，块 type、块索引和其他字段丢失；UI id 只是“当前 tail 切片中的行序号”，不是持久 record/turn id。[`content_text`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L678-L707)；[`conversation_item`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L717-L735)。
- **源码已确认**：`call_id` 仅随工具 call/output 映射到 UI，没有配对校验或写入；没有 turn id 字段。event 和 response item 逐行独立映射，没有双重表示的去重/同步模型。[工具映射](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L643-L674)。
- **源码已确认**：前端把每项作为 `<pre>` 或折叠 raw JSON 只读输出，无 `contentEditable`、消息 textarea、保存按钮或消息写回调用。[`Conversation`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L800-L823)。

### 3. 计划与写入

- **源码已确认**：clone/migrate/repair/cleanup 先生成带 UUID 的 `OperationPlan`，仅保存在进程内 `Mutex<HashMap<...>>`；用户在工作台确认后调用 `apply_operation(planId)`。[计划状态](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L23-L26)；[UI apply](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L825-L860)。
- **源码已确认**：执行器检查/可强杀部分 Codex 进程、创建备份，再依动作顺序改全局 JSON 内存、SQLite、index 和 rollout，最后直接 `fs::write` 全局 JSON。[执行器](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1795-L1881)。

## 能力与操作语义矩阵

| 操作 | 真实语义（固定快照） | 后续消息 | 原 session 身份 | 证据等级 |
|---|---|---:|---:|---|
| 浏览 | SQLite 会话清单 + rollout 尾部的有损只读投影 | 只显示最近部分 | 保持 | **源码已确认** |
| 消息原地编辑 | **不存在** UI、command、后端定位/改写逻辑 | 不适用 | 不适用 | **源码已确认** |
| Provider clone/复制 | 完整逐行复制 rollout；只改遇到的首个 session_meta；新建 SQLite row/index 并修侧栏 | 全部复制，原文件也保留 | **新 UUID v4** | **源码已确认**：[2015-2111](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2015-L2111) |
| Provider migrate/迁移 | 原 rollout 首个 meta 的 provider + 原 SQLite row provider/thread_source + 索引 | 全部原样保留 | 保持 | **源码已确认**：[2113-2157](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2113-L2157) |
| repair | 工作区数组/hint/折叠过滤；touch SQLite updated_at；补 thread_source/index | 不碰消息 | 保持 | **源码已确认**：[1520-1555](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1520-L1555) |
| 删除归档 | 仅当路径字符串含 `/archived_sessions/` 时删整个文件，再删 archived SQLite row | 全删 | 删除 | **源码已确认**：[2167-2177](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2167-L2177) |
| 删除旧 Provider 会话 | 先确认当前 Provider 存在 `cloned_from=id` 的副本，再删整份 rollout、SQLite row 和 index | 全删；副本另存完整历史 | 删除旧 id | **源码已确认**：[2179-2215](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2179-L2215) |
| fork | 不存在；clone 总是复制整个文件，不能选分叉 turn | 不适用 | 不适用 | **源码已确认** |
| 截断/删除单条 | 不存在 | 不适用 | 不适用 | **源码已确认** |
| compact/compaction | 不存在语义操作；未知 compaction row 只会 raw 展示，但 clone/migrate 因逐行复制会机械保留原行 | 机械保留，不理解 | 视 clone/migrate | **源码已确认** |
| bundle export | 复制选中 rollout，写 manifest/index fragment/checksum | 复制全文件 | manifest 保留原 id | **源码已确认**：[2431-2488](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2431-L2488) |
| bundle import | 仅 `preview_import` 计划；apply 无实现 | 不写入 | 不适用 | **源码已确认** |
| backup restore | 仅 `restore_file` 计划；apply 无实现，UI 也未进入 apply 工作台 | 不写入 | 不适用 | **源码已确认** |

**关键边界**：clone 和 migrate 确实能保留后续消息，但用户不能先编辑某条消息；“保留后续消息”不能据此转述为“支持原地历史编辑”。

## 多存储一致性

### 读取时的来源优先级

- **源码已确认**：会话 id、title、provider、source、rollout path、时间、token、preview、thread_source 来自 SQLite `threads`；index 只被解析为 id 是否存在；cwd 优先 SQLite，空时才尝试 rollout meta，再尝试 global hint。[SQL 合并](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1170-L1249)。
- **源码已确认**：侧栏是否真的列出最终由 app-server `thread/list` 覆盖；global heartbeat 只是 app-server 查询前的本地推断。[本地判断](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L745-L756)；[覆盖](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1003-L1033)。

### 各操作覆盖层

| 操作 | rollout | SQLite | session_index | global/workspace |
|---|---|---|---|---|
| repair | 不改 | touch 时间、可补 thread_source | 缺失时追加 | 工作区/hint/过滤/折叠状态 |
| clone | 新文件，meta 新 id/provider/`cloned_from` | INSERT OR REPLACE 新 row | 为新 id 追加 | 通过后续 repair actions 加映射 |
| migrate | 原文件 meta provider | UPDATE 原 row | 缺失时追加 | 通过 repair actions 调整 |
| 删除旧 Provider | 删除整文件 | 删除 row | 删除 id 行 | **不清理** hint/pinned/heartbeat 等 |
| 删除 archived | 删除整文件 | 仅删 archived row | **不处理** | **不处理** |

### 一致性缺口

- **源码已确认**：`ensure_session_index` 只在 id 不存在时追加，不更新已有条目的 title、rollout_path、updated_at，也没有和 SQLite 同事务。[实现](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1980-L2013)。
- **源码已确认**：clone 先写新 rollout、再插 SQLite、再补 index；migrate 先重写 rollout、再更新 SQLite、再补 index。任一步失败都没有补偿；可能产生 orphan rollout 或 provider 分裂。[clone](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2015-L2064)；[migrate](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2113-L2123)。
- **源码已确认**：若 rollout 没有可识别 `session_meta`，clone/migrate 不会插入一个新 meta，却仍继续 DB 写入，可能形成 DB id/provider 与 rollout 不一致。[重写循环](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2075-L2111)。
- **源码已确认**：clone 使用旧 rollout 的父目录；若来源在 `archived_sessions`，新 active row 也可能指向归档目录。没有阻止对 archived session clone 的后端校验。[路径生成](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2067-L2073)。
- **源码已确认**：删除旧会话不清 global state；删除归档不清 index/global。README 关于“同 id 仍有 active rollout 时保留 active index 并把 Desktop thread 指回 active 文件”的说法，在该函数中没有对应搜索/重指逻辑，应仅列为**文档声称且实现未证实**。[README](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/README.md#L215-L223)；[实际函数](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2167-L2215)。
- **源码已确认**：`call_id`、event/response 双重表示、turn 和 compaction 没有进入写入模型；项目只能在整文件 clone/migrate 时不加理解地复制这些行，无法在消息编辑后维护其一致性。

## 恢复四层证据

必须分开看以下四层，当前快照只覆盖前两层的一部分：

| 层级 | 当前证据 | 判断 |
|---|---|---|
| 1. UI 显示成功 | `apply()` 只把 `OperationResult.message` 放进 toast；没有自动 refresh/post-condition 检查 | **源码已确认**：toast 不等于状态正确。[UI apply](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L848-L860) |
| 2. 实际存储写回 | clone/migrate/repair/delete 路径确有 `fs::write`/SQLite execute；import/restore 没有 | **源码已确认**；但本次未对 Rust 写路径做隔离执行 |
| 3. `codex resume` 成功 | 后端创建自删除 zsh 脚本并让终端运行 `codex resume <id>`；返回 `ok:true` 仅代表终端打开命令成功，不等待 resume 结果 | **源码已确认**：[脚本](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L471-L524)、[command](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1584-L1612)；真实成功为**待验证 / 未知** |
| 4. 模型实际采用修改后内容 | 无消息修改能力、无模型上下文探针、无 resume 后断言 | **待验证 / 未知**，不能由文件改写或 toast 推导 |

- **隔离测试已确认**：2026-09-14 在固定快照运行 `npm test`，35/35 通过（约 47 ms）。测试使用代码内合成 JSONL，确认 JS 侧 parser 能渲染 message/reasoning/tool call/output、限制数量/文本长度、读取 `cloned_from`，以及 repair 计划和 cleanup 候选的纯函数行为。[合成 parser 测试](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/tests/codex-state.test.mjs#L416-L506)。
- **隔离测试已确认（边界）**：这批测试没有启动 Tauri/Rust 写路径、没有真实 SQLite fixture、没有 import/restore apply、没有 `codex resume` 或模型调用；测试脚本只是 Node test runner。[runner](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/scripts/run-tests.mjs#L1-L18)。

## 写入可靠性

### 已有保护

- **源码已确认**：所有主变更计划标为 dry-run/backup required；apply 前检查进程，用户允许时先 AppleScript 退出 Codex App，再 TERM/KILL 命中的进程。[计划示例](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1494-L1515)；[检测/关闭](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2217-L2271)。
- **源码已确认**：备份复制 `state_5.sqlite`、WAL、SHM、global、index；对 clone/migrate/delete 还复制相关 rollout 到 `rollouts/`。[备份](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2273-L2339)。

### 可靠性缺口

- **源码已确认**：所有 JSON/JSONL 改写都是直接 `fs::write` 目标；没有 temp + fsync + rename 原子替换，进程崩溃/磁盘满可能截断目标。[典型写入](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2109-L2157)。
- **源码已确认**：SQLite 各 `execute` 使用独立 connection；没有事务包裹一个 operation，更不可能与文件写入形成事务。[DB helpers](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1911-L1977)。
- **源码已确认**：计划只保存动作，不保存输入文件 hash/mtime/size/schema version；生成后底层变化仍可重放旧计划。唯一 Mutex 只保护内存 plan map，不是文件锁，计划成功后也不移除。[plan map/apply](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L23-L26)；[取计划](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1795-L1804)。
- **源码已确认**：SHA-256 只用于导出 bundle 生成 `checksums.json`；import 既不校验 checksum 也不实际导入。[checksum](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2545-L2557)。
- **源码已确认**：进程识别只匹配 Codex.app、`com.openai.codex`、命令行中带空格的 `codex resume` / `codex exec`；不能视为完整活动会话锁。误漏后并发写仍可能发生。[匹配规则](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2237-L2271)。
- **源码已确认**：backup 目录名只有秒级时间，同秒操作复用目录；SQLite/WAL/SHM 由普通文件复制而非 SQLite backup API。进程若漏检，三文件快照一致性不保证。[`create_backup`](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2273-L2291)。
- **源码已确认**：apply 任一动作报错即返回错误，没有 rollback；此时备份虽通常存在，但 `OperationResult` 不会返回 backup path，且 restore 尚未实现。
- **源码已确认**：成功结果的 `changedFiles` 永远只列 global JSON 和 SQLite，即使实际还改了 rollout/index；审计结果不可信。[返回值](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1873-L1879)。
- **源码已确认**：归档安全检查使用字面 `/archived_sessions/`，与项目宣称的 Windows 构建支持存在路径分隔符耦合；Windows 上可能计划危险删除但实际静默 no-op。[检查](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2167-L2176)。

## 许可证、依赖与复用分析

### 许可证与依赖

- **源码已确认**：项目代码为 MIT；复制或修改时必须保留版权及许可声明，不提供担保。[LICENSE](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/LICENSE#L1-L21)。
- **源码已确认**：npm 直接依赖为 Tauri API、React/ReactDOM、Lucide；开发依赖 Tauri CLI、TypeScript、Vite。锁文件快照为 Tauri API 2.11.0、CLI 2.11.2、React 19.2.7、Lucide 0.475.0、TS 5.9.3、Vite 6.4.3。[npm 清单](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/package.json#L20-L33)；[锁定 Tauri](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/package-lock.json#L1196-L1217)。
- **源码已确认**：Cargo 直接依赖包括 Tauri 2、rusqlite 0.32 bundled、Serde/JSON、Chrono、dirs、sha2、thiserror、uuid v4、walkdir；锁定 Tauri 2.11.2、rusqlite 0.32.1、serde_json 1.0.150、uuid 1.23.2。[Cargo 清单](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/Cargo.toml#L14-L27)。

### 版本耦合

- **源码已确认**：SQL 硬编码 `threads` 的 29 列及毫秒/`thread_source` 字段，没有 schema introspection 或迁移适配；Codex DB schema 改列会使扫描/clone 失败。[查询](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1934-L1977)。
- **源码已确认**：app-server JSON-RPC 方法、参数名、响应 `data/nextCursor/status` 也硬编码；CLI 协议变化会降级为 unverified。[协议调用](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L920-L990)。
- **待验证 / 未知**：UUID v4 新 session id、复制旧 `cli_version`、旧 created_at 与新 updated_at 的组合，是否被目标 Codex CLI/Desktop 各版本完整接受；本项目没有真实 resume 集成测试。

### 可复用模块与改造成本

| 模块 | 复用价值 | 必须改造 |
|---|---|---|
| Tauri/React 三栏浏览 UI、诊断/计划工作台 | 中 | 增加完整历史分页、可编辑 block UI、dirty/冲突/保存/验证状态；操作语义分栏，不能把 repair 当 edit |
| rollout 只读 normalizer | 低到中 | 改为无损 AST：保留原行、全局行号、record type、block type/index、turn/call 关联、event/response 镜像和 compaction |
| SQLite + global + index 聚合扫描 | 中 | schema capability detection、只读快照、统一 session repository、orphan 发现、缓存 app-server 结果 |
| app-server thread/list 客户端 | 中 | 抽象协议版本/超时/生命周期；将“列表可见”与“可 resume/模型上下文正确”分开 |
| plan/action 模型 | 中 | 加输入 hash/mtime/schema version、单次 token、post-condition、准确 changed set、journal/rollback |
| clone/migrate/repair | 中（管理功能） | 顺序事务化、缺 meta 拒绝/补全、清理所有存储层；明确不是 edit/fork |
| backup/export helper | 低到中 | SQLite backup API、唯一目录、原子文件、manifest/checksum 验证、可执行 restore |

**统一双引擎成本判断：高。** Codex 侧要新建真正的 message mutation engine；Claude Code 侧则从发现、JSONL/DAG/parentUuid、工具关联、索引、活动检测到 resume 验证都要另写 adapter。可复用的主要是 GUI 壳、诊断/计划交互和少量 Codex 扫描概念，不应以现有 `ConversationItem` 作为无损编辑模型。

## 风险、未知项与最小隔离验证方案

### 高风险/未知项

1. **源码已确认**：没有原地消息编辑；核心用户目标不是“存在 bug”，而是功能缺失。
2. **源码已确认**：import/restore 是未落地外壳，UI 文案可能让用户误以为可恢复。
3. **源码已确认**：多文件部分写、直接覆盖、旧计划重放和不完整进程检测，均可能导致多层状态分裂。
4. **待验证 / 未知**：当前 Codex 版本恢复时以 rollout、SQLite、compaction snapshot 或其他内部状态中的哪一份为权威；本候选源码不能回答。
5. **待验证 / 未知**：修改旧 event/response 后，模型上下文是否读取修改；本项目既不修改它们也不验证。
6. **待验证 / 未知**：clone 出的 UUID v4 和旧 schema row 是否可被所有目标 Codex 版本 resume。
7. **文档声称但源码未证实**：backup restore、bundle import，以及归档删除时自动指回同 id active rollout。

### 建议的最小隔离验证（本次未执行）

所有 fixture 均放在主项目 `.研究临时数据/csm-fixture/`，通过测试专用入口显式传 `codex_home`；绝不读取真实 home，也不用真实 `codex`：

1. 建最小 `state_5.sqlite`（按代码所需 29 列）、global JSON、index 和含 session_meta/message/reasoning/tool/event/compaction 的合成 rollout；把 `CODEX_CLI` 指向只实现 initialize/thread-list 的假脚本。
2. 对 clone/migrate/repair/delete 每项分别运行 plan/apply；逐字节比较所有层，验证 session id、完整后续行、call_id、未知 compaction 行、index 和 global 映射，并注入“第二步失败”检查部分写及备份可恢复性。
3. 加无 session_meta、malformed line、多 content blocks、event/response 双表示、旧/新 DB schema、Windows 风格路径、归档来源 clone、同秒两次 backup fixture。
4. 为 import/restore 加负向断言：当前快照 apply 后 fixture 不变化，防止 UI 把无操作报告为成功。
5. 只有在复制出的完全隔离 `CODEX_HOME` 和 mock CLI 验证通过后，才由人工在 disposable OS 用户/容器中测试官方 CLI resume；模型是否采用修改内容必须设计可辨识上下文探针，不能以 resume 进程退出码替代。

## 结论

1. **不适合作为双引擎历史编辑核心**：没有 Claude 支持，没有任何消息保存链路，也没有无损 record/block 定位。
2. **可作为 Codex 管理 GUI 的参考**：SQLite/index/global/rollout/app-server 的聚合视图、dry-run plan 和 Provider clone/migrate 的产品分层有借鉴价值。
3. **必须严格命名语义**：clone=完整副本+新 id；migrate=原 id 改 Provider；repair=侧栏/索引修复；delete=整会话删除；本快照无 fork/truncate/compact/edit。
4. **写入内核不宜直接复用**：在实现原地编辑前，应先建立无损模型、重复表示/工具/compaction 一致性规则、原子写/事务 journal、冲突检测和真实 post-condition。
5. **任何“修改后可恢复且模型会采用”的结论均尚无证据**；本次仅确认 JS 合成 parser 测试 35/35，通过不等于 Rust 写回、官方 resume 或模型上下文验证。

## 证据索引

| 主题 | 固定提交源码 |
|---|---|
| 技术栈/依赖 | [`package.json` L1-L33](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/package.json#L1-L33)、[`Cargo.toml` L1-L27](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/Cargo.toml#L1-L27) |
| Tauri command/API 边界 | [`src/tauri.ts` L268-L292](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/tauri.ts#L268-L292)、[`lib.rs` L2709-L2744](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2709-L2744) |
| 多层发现 | [`lib.rs` L1154-L1261](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1154-L1261) |
| 官方 thread/list 对照 | [`lib.rs` L884-L1033](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L884-L1033) |
| rollout 解析/有损投影 | [`lib.rs` L560-L735](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L560-L735) |
| 只读 UI | [`App.tsx` L669-L823](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src/ui/App.tsx#L669-L823) |
| repair/clone/migrate 计划 | [`lib.rs` L1451-L1693](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1451-L1693) |
| 写入执行器 | [`lib.rs` L1795-L1881](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L1795-L1881) |
| clone/migrate 实现 | [`lib.rs` L2015-L2165](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2015-L2165) |
| 删除/进程保护/备份 | [`lib.rs` L2167-L2339](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2167-L2339) |
| export/import/restore 边界 | [`lib.rs` L2431-L2630](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/src-tauri/src/lib.rs#L2431-L2630) |
| MIT 许可 | [`LICENSE` L1-L21](https://github.com/fengchenzxc/Codex-Session-Manager/blob/724c8bc391634b2d83f09e4cf0cc5147894ae2d0/LICENSE#L1-L21) |
