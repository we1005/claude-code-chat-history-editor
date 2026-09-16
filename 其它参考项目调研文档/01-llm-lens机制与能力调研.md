# llm-lens 机制与能力调研

> 唯一研究对象：`参考项目/llm-lens/`\
> 固定快照：[`307c31acb0c255d5c3aa6cb4a3001bfe21af11a0`](https://github.com/jajanet/llm-lens/tree/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0)\
> 调研日期：2026-09-14\
> 证据等级：`源码已确认`、`隔离测试已确认`、`文档声称`、`待验证 / 未知`

## 摘要

1. **它不是双引擎编辑器。** `llm-lens` 0.2.7 是 Python/Flask + 原生 ES Modules 的本地 Web UI，当前后端只发现和修改 Claude Code 的 `~/.claude/projects`；没有 Codex 会话发现、解析、写回或 provider 实现。`源码已确认`（[`pyproject.toml` L5-L29](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/pyproject.toml#L5-L29)，[`llm_lens/__init__.py` L1-L9、L31-L44](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1-L44)）
2. **普通 user/assistant 正文可原地改写，并保留文件中其后的有效 JSON 记录。** 保存时保持目标记录的 `uuid`、`parentUuid`、`sessionId`、`message.usage` 等外围字段；后续记录不会按“截断到编辑点”删除。多文本块会合并成一个 `text` 块。`源码已确认`（`_replace_content`、`api_edit_message`，[`__init__.py` L2671-L2685、L2977-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2671-L2685)）；`隔离测试已确认`（合成四节点链中编辑首条 user 后，后面三条记录逐对象相等，全部 UUID/父链不变）。
3. **“不改 UUID/父链”不等于结构安全。** 当前 UI 和后端允许把含 `tool_use`、`tool_result`、`thinking` 或其他结构块的整条 `message.content` 压成一个文本块，但没有同步维护另一条记录里的工具配对。编辑 `tool_use` 后会留下孤立 `tool_result`；编辑或删除 `tool_result` 后会留下孤立 `tool_use`。`源码已确认`（[`messages.js` L619-L641、L1205-L1261](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L619-L641)，[`__init__.py` L2977-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2977-L3041)）；`隔离测试已确认`（编辑工具调用后集合为 `tool_use=[]`、`tool_result=[t1]`；删除结果后反向孤儿同样出现）。
4. **当前格式 subagent 编辑存在“200 成功但正文未变”。** 展示层会解包 `type: progress -> data.message`，写回层却只改顶层 `entry.message`；真实正文位于更深的 `data.message.message.content` 时，接口仍返回成功但实际内容不变。顶层 system/queue 事件也有同类假成功。`源码已确认`（`_format_entry_message`，[`__init__.py` L866-L982](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L866-L982)；`api_edit_message`，[`__init__.py` L3002-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3002-L3041)）；`隔离测试已确认`（两种合成记录均返回成功，嵌套/顶层正文保持原值）。
5. **普通编辑路径没有会话文件备份、临时文件、原子替换、文件锁或并发版本检查。** 它先解析全文件，再以 `open(..., "w")` 截空并重写；不可解析的原始行会静默消失。只有 Debloat 采用同目录临时文件 + `os.replace`，并在统计不变量失败时用内存备份恢复；这仍不是 resume 验证。`源码已确认`（[`__init__.py` L3007-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3007-L3041)，[`debloat.py` L276-L367](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/debloat.py#L276-L367)）；`隔离测试已确认`（合成畸形行在一次正文编辑后丢失）。

因此，若新项目的硬目标是“**原地修改且保留后续消息**”，可借鉴其浏览 UI、Claude 路径发现和部分纯文本转换，但不能直接复用现有 mutation 作为可靠写入层；应另做 lossless AST、双向工具配对校验、compare-and-swap 写入、备份/回滚和 provider 抽象。

## 1. 项目与快照

### 1.1 快照核对与调研边界

- 本地执行 `git rev-parse HEAD` 得到 `307c31acb0c255d5c3aa6cb4a3001bfe21af11a0`，与任务固定快照一致；候选仓库 `git status --short` 为空。`隔离测试已确认`
- 全程未修改 `参考项目/llm-lens/`，未读取或写入真实 `~/.claude`、`~/.codex` 会话，未执行 `claude --resume`，未发送模型请求，未联网搜索。`隔离测试已确认`
- 仓库声明版本为 0.2.7、Python `>=3.8`，运行时依赖仅列 `flask>=2.0`，命令入口为 `llm-lens-web = llm_lens:main`。`源码已确认`（[`pyproject.toml` L5-L29](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/pyproject.toml#L5-L29)）
- README 将其描述为离线 Claude Code 历史审计/裁剪工具，并明确“目前仅 Claude，架构可容纳 Codex/Gemini”。后半句只是规划，不是已存在的 provider 层。`文档声称`（[`README.md` L6-L10、L274-L291](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L6-L10)）

### 1.2 技术栈、入口与关键模块

| 模块 | 职责 | 证据 |
|---|---|---|
| `llm_lens/__init__.py` | 单体 Flask app；Claude 发现、JSONL 解析、统计、REST 路由和绝大多数文件 mutation | `源码已确认`：`app`、`main`（[`L31-L44`](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L31-L44)，[`L3453-L3477`](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3453-L3477)） |
| `static/index.html`, `static/js/main.js` | 无构建步骤 SPA 壳、hash 路由、事件委派 | `源码已确认`（[`index.html` L1-L30](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/index.html#L1-L30)，[`main.js` L75-L115、L207-L291](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/main.js#L75-L115)） |
| `static/js/views/messages.js` | 消息加载、扁平展示、编辑/转换/删除/导出交互 | `源码已确认`（[`messages.js` L43-L97、L360-L403](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L43-L97)） |
| `static/js/api.js` | 前端 fetch 包装；编辑 POST 只发送 `{text}` | `源码已确认`（[`api.js` L1-L24、L113-L121](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/api.js#L1-L24)） |
| `static/js/transforms.js` | 客户端纯文本 redact/空白/词表转换，结果仍走通用 `/edit` | `源码已确认`（[`transforms.js` L1-L18、L190-L245](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/transforms.js#L1-L18)） |
| `peek_cache.py` | `sessions.json` 统计/预览 sidecar，进程内锁、mtime+size 失效、延迟原子落盘 | `源码已确认`（[`peek_cache.py` L1-L25、L51-L80](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/peek_cache.py#L1-L25)） |
| `debloat.py` | 有损瘦身及统计不变量回滚，是唯一较完整的临时文件写回实现 | `源码已确认`（[`debloat.py` L1-L29、L276-L367](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/debloat.py#L1-L29)） |
| `tag_store.py` / `tag_set.py` | 标签 sidecar 与纯数据结构，不参与会话恢复 | `源码已确认`（[`tag_store.py` L1-L45、L134-L152](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/tag_store.py#L1-L45)） |

服务 `main()` 绑定 `0.0.0.0` 且源码没有认证中间件；这不是只对 loopback 可见。`源码已确认`（[`__init__.py` L3458-L3473](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3458-L3473)）

## 2. 核心架构及完整读写调用链

### 2.1 实际读取和写入的路径

| 路径 | 用途 | 证据 |
|---|---|---|
| `~/.claude/projects/<project-folder>/<session-id>.jsonl` | 主会话发现、读取和原地写回 | `源码已确认`：`CLAUDE_PROJECTS_DIR`、`_convo_files`、`_convo_path`（[`__init__.py` L38-L44、L1320-L1329、L1960-L1970](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L38-L44)） |
| `~/.claude/projects/<folder>/<session-id>/subagents/agent-*.jsonl` | 新格式 subagent run 发现、展示；编辑/删除通过 UUID 搜索到对应文件 | `源码已确认`（[`__init__.py` L1077-L1079、L1139-L1244、L2548-L2580](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1077-L1079)） |
| `~/.cache/llm-lens/archive/<folder>/<id>.jsonl` | archive/unarchive 的会话副本 | `源码已确认`（[`__init__.py` L41-L68、L2294-L2348](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L41-L68)） |
| `~/.cache/llm-lens/sessions.json` | 预览、统计、删除/编辑 tombstone、Debloat 标记 | `源码已确认`（[`peek_cache.py` L18-L25、L220-L284](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/peek_cache.py#L18-L25)） |
| `~/.cache/llm-lens/tags.json` | 标签 | `源码已确认`（[`tag_store.py` L32-L45](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/tag_store.py#L32-L45)） |
| `~/.cache/llm-lens/word_lists.json`、`download_fields.json` | 转换词表、导出字段偏好 | `源码已确认`（[`__init__.py` L2858-L2904、L2942-L2974](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2858-L2904)） |
| `~/.claude/projects/<folder>/<new-id>.dup.json` | duplicate 的共享前缀统计 sidecar，和会话放在同目录 | `源码已确认`（[`__init__.py` L738-L749、L2278-L2289](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L738-L749)） |

没有任何 `~/.codex` 路径或 Codex schema 实现。`源码已确认`

### 2.2 发现与列表

1. `api_projects()` 枚举 live root 与 archive root 的一级目录，以每个目录下顶层 `*.jsonl` 作为会话；项目名称直接来自目录名。`源码已确认`（[`__init__.py` L1344-L1386](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1344-L1386)）
2. `_convo_files()` 只收顶层 JSONL，按文件 mtime 排序；`api_conversations()` 取文件 stem 为会话 ID，并以 `_peek()` 和 `_stats()` 补预览、cwd、大小、上下文统计。`源码已确认`（[`__init__.py` L1320-L1329、L1835-L1899](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1320-L1329)）
3. `_peek_jsonl_cached()` 最多扫描头 30 行取 `cwd`、首条非 meta user 文本等；尾部预览最多逐步读到 4 MB。cache key 为路径、mtime、size。`源码已确认`（[`__init__.py` L74-L144、L147-L240](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L74-L144)）

### 2.3 JSONL → 消息模型 → 展示

核心链路为：

```text
GET /api/projects/:folder/conversations/:id
  → _convo_path()
  → stat(mtime,size)
  → _parse_messages_cached()
  → 逐行 json.loads
  → 跳过 isSidechain 主视图记录
  → _format_entry_message()
  → _dedup_by_uuid()
  → 分页 JSON
  → api.messages()
  → Messages.show()/render()
  → processContent()/renderSingleMsg()
```

- `_parse_messages_cached()` 对空行跳过；JSON 解码失败也跳过；主视图过滤 `isSidechain`，然后按 UUID 保留第一次出现。它不按 `parentUuid` 求一条活动分支，而是保持文件顺序。`源码已确认`（[`__init__.py` L985-L999、L1048-L1074](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L985-L999)）
- `_format_entry_message()` 支持三类 envelope：普通 `entry.message`、subagent `progress.data.message`、无 `message` 的 system/queue 顶层 `content`。它将后两类包装成统一的展示消息。`源码已确认`（[`__init__.py` L866-L919](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L866-L919)）
- 内容块被**有损扁平化**：`text` 取文字；`tool_use` 变成 `[Tool: name:id]`；`tool_result` 只剩 `[Tool Result]`；`thinking` 变成 `<thinking>…</thinking>`；image 和未知 block 不进入展示字符串。API 额外仅带 `has_tool_use/has_thinking/has_tool_result` 布尔值，Bash 才保留 command/id 供展示。`源码已确认`（[`__init__.py` L920-L982](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L920-L982)）
- 前端 `processContent()` 再把 thinking 与工具 marker 转为折叠块/徽标；这层操作的是展示字符串，不是可往返的原始块模型。`源码已确认`（[`messages.js` L405-L515](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L405-L515)）
- `api_conversation()` 默认只返回最后 50 条，前端使用 60；可加载更早或整段。subagent run 由同一响应中的 `agent_runs` 导航。`源码已确认`（[`__init__.py` L2079-L2138](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2079-L2138)，[`messages.js` L691-L717](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L691-L717)）
- raw 下载绕过扁平 parser，直接 `send_file(filepath)`，因而是唯一保留所有原始字段的导出。普通 JSONL export 只有 `uuid/role/content/timestamp/commands/model/usage`，不能 round-trip Claude 会话。`源码已确认`（[`__init__.py` L2167-L2182](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2167-L2182)，[`exports.js` L7-L19、L40-L51](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/exports.js#L7-L19)）

### 2.4 编辑保存与写回

核心保存链为：

```text
Edit 按钮
  → editMsg(uuid) 将扁平 m.content 放入 textarea
  → saveEditMsg(uuid)
  → api.editMessage(folder,id,uuid,text)
  → POST .../messages/:uuid/edit {text}
  → _find_message_file() 搜主会话和 subagent 文件
  → readlines() + 对每个非空行 json.loads（坏行丢弃）
  → 按顶层 uuid 找 target
  → _replace_content(target.message,new_text)
  → 统计前后差写入 peek_cache.deleted_delta
  → open(filepath,"w") 重写所有已解析 entry
  → 清 LRU cache
  → 前端重新 GET 并 render
```

- UI 明确允许所有有 UUID 的消息编辑；含工具/thinking 的消息仅显示警告，不禁止保存。textarea 初始值来自扁平后的 `m.content`。`源码已确认`（[`messages.js` L609-L668、L1205-L1261](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L609-L668)）
- `_find_message_file()` 只看候选记录的**顶层** `uuid`，主文件优先，其次 `subagents/agent-*.jsonl`。同 UUID 多处出现会命中第一处。`源码已确认`（[`__init__.py` L2548-L2580](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2548-L2580)）
- `_replace_content()` 对 string 保持 string 形状；对任何 list（不检查 block 类型）直接替换为一个 `[{"type":"text","text":...}]`。虽然存在 `_is_prose_only()`，但 `api_edit_message()` 没有调用它。`源码已确认`（[`__init__.py` L2650-L2685、L2977-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2650-L2685)）
- 写回不是改单行，而是重序列化全部成功解析的 entry；默认 `json.dumps` 会改变空白表现，且不可解析行不会回写。`源码已确认`（[`__init__.py` L3007-L3040](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3007-L3040)）

## 3. 编辑能力矩阵

| 对象/粒度 | UI/后端行为 | 能否安全满足“原地改且保留后续” | 证据 |
|---|---|---|---|
| user string 正文 | 可编辑；仍写为 string | **基本可以**，外围字段及后续有效记录保留；可靠写入问题另见第 6 节 | `源码已确认`；`隔离测试已确认` |
| user 单个 text block | 可编辑；写成单 text block | **基本可以** | `源码已确认`；`隔离测试已确认` |
| assistant 纯正文 | 与 user 相同；`usage/model/message.id` 等 target 其他字段不主动改变 | **基本可以**，但未证明 Claude resume 采用新文 | `源码已确认` |
| 多个 text blocks | 展示时以换行连接；保存后合并成一个 text block | 后续记录保留，但块边界和块级额外字段丢失 | `源码已确认`（[`__init__.py` L934-L959、L2671-L2685](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L934-L959)） |
| thinking/reasoning block | UI 显示并允许编辑，保存会把整条 content（含签名等）压成文本 | **不安全**；不是“编辑 thinking 字段”，而是删除结构后改成普通 text | `源码已确认`（[`messages.js` L619-L630、L1216-L1235](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L619-L630)） |
| tool_use | UI 警告后允许；保存删除 id/name/input，只留文本 | **不安全**；可能留下配对结果孤儿 | `源码已确认`；`隔离测试已确认` |
| tool_result | UI 可编辑；保存删除 `tool_use_id` 和结果结构 | **不安全**；可能留下调用孤儿。批量“prose/non-prose”分类还只检查 `has_tool_use/has_thinking`，会把 tool_result-only 漏算为 prose | `源码已确认`（[`messages.js` L804-L841、L1033-L1053](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L804-L841)）；`隔离测试已确认` |
| image/未知 block | parser 不展示该块；若同条有可见文字仍可点击编辑，list 整体被替换 | **不安全**；隐含块会被无提示或不完整提示删除 | `源码已确认` |
| 顶层 system/queue `content` | 展示层造出可编辑 pseudo-message；写回只看 `target.message`，因此通常 no-op 仍返回成功 | **不支持且有假成功** | `源码已确认`；`隔离测试已确认` |
| 当前 `progress.data.message.message.content` subagent | 可展示；写回命中外层 UUID 后改错层级，正文不变仍成功 | **不支持且有假成功** | `源码已确认`；`隔离测试已确认` |
| 旧式 inline sidechain | 可作为 agent run 展示；实际记录在主文件，顶层普通 `message` 时可写 | 取决于记录形状；仍有工具/并发风险 | `源码已确认`（[`__init__.py` L1081-L1136、L1276-L1317](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1081-L1136)） |
| `isMeta`、file-history-snapshot、无展示正文的原始记录 | 被过滤或不展示 | 无 UI 编辑能力 | `源码已确认` |
| 任意原始 JSON/字段级编辑 | 只有 raw 预览/下载，没有 raw editor 或导入恢复 API | **不支持** | `源码已确认`（[`messages.js` L1738-L1806](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L1738-L1806)） |
| Codex turn/reasoning/item | 无 discovery/parser/writer | **不支持** | `源码已确认` |

README 仍称“prose-only，tool/thinking locked”，与此快照实际 UI、后端和仓库测试所表达的行为不一致；不能据 README 判定为受保护。`文档声称`（[`README.md` L20-L24](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L20-L24)）；`源码已确认`（上述 mutation 证据）

## 4. 后续历史、parentUuid 与工具关联

### 4.1 原地正文编辑

- 编辑不改目标 entry 的 `uuid`、`parentUuid`、`sessionId`，也不改后续 entry 的父指针；目标以外的有效 JSON 对象原样留在 `entries` 列表中再序列化。语义是“替换这一条的 `message.content`”，**不是截断**。`源码已确认`
- 合成链 `u1 → a1(tool_use t1) → r1(tool_result t1) → a2` 中编辑 `u1` 后，后三个解析对象逐对象相等，链仍为 `[(u1,null),(a1,u1),(r1,a1),(a2,r1)]`。`隔离测试已确认`
- 上述只证明本项目 writer 的对象结果；不证明 Claude Code 的 resume 路径会读取全部这些节点，更不证明模型上下文采用了修改文字。`待验证 / 未知`

### 4.2 编辑与工具配对

- `api_edit_message()` 没有扫描 `tool_use.id ↔ tool_result.tool_use_id`，也没有调用 `_strip_blocks()`；非 prose 编辑只把目标条 content 整体替换。`源码已确认`
- 编辑含 `tool_use id=t1` 的 assistant 后，后续 `tool_result(tool_use_id=t1)` 保留，形成结果孤儿。编辑 tool_result 则反向形成调用孤儿。`隔离测试已确认`
- 因此，README/UI 中“resume chain intact”最多指 UUID/parentUuid 没被改，不能扩张为所有 Claude replay 不变量都保持。`文档声称`（[`README.md` L20-L24、L124-L140](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L20-L24)）；`源码已确认`（工具配对没有维护）

### 4.3 删除、截断、fork、repair、compact、debloat 的严格区分

| 操作 | 此项目真实语义 | 与“原地改且保留后续”的关系 |
|---|---|---|
| **Edit/Redact/文本转换** | Redact/normalize/词表转换都在客户端生成新字符串，再调用同一个 `api_edit_message`；改目标 content，全文件重写 | 正文编辑通常保留后续；结构块编辑可能破坏工具配对。Redact 不是删除，也不是截断 |
| **Delete message** | 删除指定 UUID 记录；直接子节点改挂到被删节点的父节点。若被删条含 tool_use，会从其他条移除对应 tool_result；结果条若因此为空也删除并继续改挂子节点 | 后续一般保留并重连，不是截断。但逻辑是单向的：单删 tool_result 不会删 tool_use，仍可能破坏配对。`源码已确认`（`api_delete_message`，[`__init__.py` L2583-L2647](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2583-L2647)）；`隔离测试已确认` |
| **Truncate** | 没有“从某点删除所有后续记录”的端点或 UI。源码中的 `open(...,"w")` 是文件 I/O 截空后重写，不是会话语义上的 truncate | **不提供** |
| **Extract** | 源文件不变；选择 UUID 写入新文件，父指针跳到最近被选择祖先，并去掉缺配对的工具块 | 是“抽取子集”，不是原地编辑，也不是完整 fork。它不重写选中 entry 的 UUID 或 `sessionId`；合成测试中新文件名 UUID 与 entry 内 `sessionId="s"` 不一致。`源码已确认`（[`__init__.py` L3242-L3315](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3242-L3315)）；`隔离测试已确认` |
| **Duplicate / fork-like copy** | 新文件 ID；逐行重写顶层 `sessionId/uuid/parentUuid`，源文件不变；额外写 `.dup.json`。subagent 目录直接复制，嵌套记录 sessionId 明确不修 | 最接近完整 fork，但不是经过 Claude 官方机制创建的 fork；subagent 身份残留，外部/前向父引用也可能被置空。`源码已确认`（[`__init__.py` L2224-L2291](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2224-L2291)） |
| **Repair** | 没有独立 validator/repair 命令。删除与 extract 只做局部父链和工具孤儿处理；既不全面扫描原文件，也不修编辑产生的孤儿 | **不提供通用 repair**。仓库测试中的 `assert_resume_safe` 是测试方自定义启发式，不是 Claude 官方校验器，也没有接入生产保存路径 |
| **Compact** | 只识别并统计 `system/subtype=compact_boundary`，展示 `[Compacted]`，估计 summary 字符；不执行 `/compact`、不生成摘要、不修改 compaction 边界 | **只观察，不 compact**。`源码已确认`（[`__init__.py` L406-L450、L896-L919](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L406-L450)） |
| **Debloat** | 有损截短 oversized thinking、tool results/stdout，或删除 normalizedMessages；保留记录数及部分结构 id，并检查本项目统计不变量 | 不是 compact，不产生摘要，也不是无损编辑。只能证明聚合统计相同，不能证明模型恢复语义相同。`源码已确认`（[`debloat.py` L83-L179、L386-L393](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/debloat.py#L83-L179)） |
| **Archive / Unarchive** | 在 live root 与 cache archive root 之间移动 JSONL、subagent 目录及 duplicate sidecar；目标冲突返回 409 | 是可逆“隐藏/恢复文件位置”，不是恢复某次消息编辑前的内容。`源码已确认`（[`__init__.py` L2294-L2348](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2294-L2348)） |

## 5. 恢复语义：四层证据不得混同

| 层级 | 本快照能证明什么 | 不能推出什么 |
|---|---|---|
| **1. UI 已变化** | 保存/转换成功后调用 `show(folder,convoId)`，重新 GET 并 render；因此 UI 可显示后端再读到的新正文。`源码已确认`（[`messages.js` L1248-L1261、L1146-L1192](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L1248-L1261)） | 不等于文件写回具有原子性；subagent/top-level 假成功甚至可能重新显示旧值 |
| **2. 实际存储已写回** | 普通顶层 prose 目标会在 JSONL 中变成新 string/单 text block，后续有效记录被重新写回。`源码已确认`；`隔离测试已确认` | 不等于 Claude Code 能解析/选择同一分支；不等于 tool pairing 完整 |
| **3. resume 成功** | 本项目完全没有调用 Claude；README 也承认工具内无法确认 edited copy 能否 `/resume`，要求另行从终端测试。`文档声称`（[`README.md` L90-L95、L124-L140](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L90-L95)） | 本调研没有运行真实 resume；**是否能成功为 `待验证 / 未知`** |
| **4. 恢复后模型实际使用新内容** | 无源码、测试或运行证据。`待验证 / 未知` | 即使 UI 正确、磁盘已改、CLI resume 不报错，也不能自动推出模型上下文采用了新内容；可能存在分支选择、缓存、compaction summary、内部数据库或版本差异 |

README 声称删除/编辑能降低未来 resume 上下文，或 redacted 内容会被发送；这属于第三方项目对未公开行为的主张，不是 Claude Code 官方事实。`文档声称`（[`README.md` L18-L32](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L18-L32)）

## 6. 写入可靠性与恢复能力

### 6.1 普通 Edit/Delete/Extract/Duplicate

| 可靠性项 | 结论 | 证据 |
|---|---|---|
| 会话文件备份 | Edit/Delete message 前没有 `.bak` 或持久备份；raw download/duplicate 只是用户手动替代方案。项目也无 raw import/restore endpoint | `源码已确认` |
| 临时文件/原子替换 | Edit/Delete 直接 `open(filepath,"w")`；Extract/Duplicate 直接创建目标并流式写。进程崩溃、磁盘满或异常可留下空/半文件 | `源码已确认`（[`__init__.py` L2643-L2647、L3037-L3041、L3297-L3315、L2254-L2270](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2643-L2647)） |
| fsync/directory fsync | 没有 | `源码已确认` |
| 文件锁 | 会话 JSONL 没有 `flock`、advisory lock 或进程内 mutation lock。`peek_cache`/`tag_store` 的锁只保护自己的内存 sidecar | `源码已确认`（[`peek_cache.py` L22-L25、L51-L68](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/peek_cache.py#L22-L25)） |
| hash/mtime/版本检查 | mtime+size 仅用于 read cache key。保存读取前 stat 后没有在 replace 前再次比较，也没有内容 hash/ETag/CAS | `源码已确认` |
| 活动会话检测 | 不检查 Claude 进程、打开文件、最近 append、lockfile 或 session 活跃状态 | `源码已确认` |
| 并发写入 | Claude 若在 read 与 `open("w")` 之间追加，追加内容可被旧内存快照覆盖；两个 Web 请求也可 last-writer-wins | `源码已确认`（由无锁 read-modify-write 路径直接得出）；并发复现 `待验证 / 未知` |
| 异常恢复 | 普通 mutation 无 try/rollback；而 tombstone 在会话写回前先更新，故后续写失败还可能让统计 sidecar 与会话不一致 | `源码已确认`（Edit [`L3026-L3041`](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3026-L3041)，Delete [`L2617-L2647`](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2617-L2647)） |
| 畸形/未知行 | 解析失败行在展示时跳过；Edit/Delete/Extract 的内存 entries 只收成功 JSON，重写后坏行永久消失 | `源码已确认`；`隔离测试已确认`（插入 `not-json-preserve-me` 后编辑，行不存在） |
| 文件权限/元数据 | 重写现有文件没有显式 chmod/chown/xattr/mtime 恢复。Archive 用 `copy2` 尽力保留元数据，但跨设备的 copy+remove 不是单步原子移动 | `源码已确认`（[`__init__.py` L55-L68](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L55-L68)）；完整平台行为 `待验证 / 未知` |
| 批量操作事务性 | 批量 transform/delete 逐条请求或逐会话循环；中途失败会部分应用，无批次 rollback | `源码已确认`（[`messages.js` L1645-L1705、L1818-L1837](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L1645-L1705)） |

### 6.2 Debloat 的较强保护及边界

- `apply_debloat()` 先将原文件全部读入内存为 `backup_bytes`，在同目录 `mkstemp` 写完，再 `os.replace`；对本项目 `_INVARIANT_KEYS` 做前后统计相等检查，失败则 `path.write_bytes(backup_bytes)`。`源码已确认`（[`debloat.py` L276-L350、L386-L393](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/debloat.py#L276-L350)）
- 保护仍有限：无会话锁、无写前 CAS、无 fsync；恢复本身是直接写，不原子；`mkstemp` 新 inode 的 mode/ownership/xattr 没有从原文件复制；内存备份不会成为用户可恢复版本。`源码已确认`（实现不存在相应步骤）；具体权限结果 `待验证 / 未知`
- `_verify_stats_equal` 比较的是 llm-lens 自己统计器可见的 token/tool/thinking 等字段；规则本身明确截短 thinking 与 tool result。统计不变量相等不能证明 Claude resume 或模型语义相等。`源码已确认`

### 6.3 sidecar 的可靠性不是会话可靠性

- `peek_cache.flush()` 使用 `.tmp + os.replace`，但写失败被吞掉，且是 2 秒 daemon Timer；它保护的是统计 cache，不是会话正文。`源码已确认`（[`peek_cache.py` L42-L68](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/peek_cache.py#L42-L68)）
- `tag_store.flush()` 会复制一个 `tags.json.bak` 再原子替换，但同样只保护标签。`源码已确认`（[`tag_store.py` L128-L152](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/tag_store.py#L128-L152)）

## 7. 许可证、依赖与复用分析

### 7.1 许可证与依赖核验

- 仓库 LICENSE 为 MIT，允许使用、复制、修改、合并、发布、分发、再许可和销售，但复制/实质部分必须保留版权和许可声明，并按“AS IS”免责。`源码已确认`（[`LICENSE` L1-L20](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/LICENSE#L1-L20)）
- 项目元数据也声明 `license = "MIT"`。`源码已确认`（[`pyproject.toml` L5-L26](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/pyproject.toml#L5-L26)）
- 直接运行依赖仅声明 Flask `>=2.0`，构建依赖 setuptools/wheel；没有 lockfile 或上限，因而固定快照并不固定 Flask 及其传递依赖版本。传递依赖许可证没有在本调研中安装/展开核验。`源码已确认`；传递依赖精确版本与许可证 `待验证 / 未知`
- 前端是原生模块，无 npm 构建依赖。`源码已确认`

### 7.2 可复用模块和改造成本

| 模块 | 可复用价值 | 耦合/改造成本 |
|---|---|---|
| `transforms.js` 纯文本转换 | **高，低成本**：函数大多是 text→text，可独立单测 | 只应作用于明确选定的 text block；不能再把扁平整条消息回写。词表内容与“改变 agent 行为”的因果主张需另行验证 |
| 项目/会话浏览 UI、hash router、API wrapper | **中高，中成本**：无框架、易迁移；分页/搜索/导出交互可借鉴 | state 和 route 都默认单 provider、Claude folder/id；消息模型是有损字符串，双引擎必须改为 provider-aware、block-aware view model |
| Claude discovery、peek、stats | **中，中成本**：路径枚举、缓存思路和费用展示可参考 | `Path.home()` 常量、Claude 字段和 Flask route 混在 3477 行单体中；需要拆成 `ClaudeProvider`。mtime+size cache 不能兼作写入并发控制 |
| `_format_entry_message` | **只适合只读展示参考，高改造成本** | 它丢 image/未知块和 tool_result 内容，不是 lossless editor 模型；必须同时保留 raw record、block identity 和 display projection |
| `_tool_use_ids`、`_strip_blocks`、父链重连 | **概念可取，中高成本** | 当前只覆盖局部方向和 Claude block 形状；应改为保存前全图 validator，双向处理 use/result，输出明确 repair plan，而不是隐式删块 |
| Debloat temp-write + invariant 实现模式 | **模式可借鉴，中成本** | 应升级为权限保留、fsync、CAS、磁盘备份和可恢复日志；内容规则有损且不是统一编辑器核心。统计 invariant 不能替代 provider resume invariant |
| `peek_cache` / `tag_store` | **中低，低至中成本** | 标签可独立拿；tombstone 统计与当前业务耦合，不应充当真实版本历史或备份 |

### 7.3 统一 Codex + Claude 产品适配度

- 作为**界面和 Claude 只读原型**：适配度中等。项目→会话→消息导航、搜索、raw 下载、归档/标签等交互可参考。`源码已确认`
- 作为**统一双引擎可靠写入核心**：适配度低。没有 Provider protocol 实现、没有 Codex 代码，Claude parser 与 route/mutation 单体耦合，且保存模型有损、无并发控制。`源码已确认`
- README 给出了未来抽取 `Provider` 的建议，但当前并未落地；不能按“已有可插拔架构”估算成本。`文档声称`（[`README.md` L274-L291](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/README.md#L274-L291)）

建议新项目先定义：

```text
Provider
  discoverSessions()
  loadLosslessDocument()
  projectDisplayModel()
  planMutation(block/field target)
  validateStructure(before, after)
  atomicSave(expectedRevision, backupPolicy)
  restoreBackup()
```

Claude 与 Codex 各自实现 schema、身份链、工具关联和活跃检测；共享层只接收 provider 的 lossless document 与 mutation plan。

## 8. 风险、未知项与最小隔离验证方案

### 8.1 主要风险与未知项

1. **恢复链未知。** Claude Code 如何从多分支、compact boundary、重复 UUID、sidechain 和工具块组装 resume context 未有本项目可依赖的官方契约。`待验证 / 未知`
2. **模型采用未知。** 文件内容变化后，Claude Code 是否从其他缓存/summary/数据库读取，及模型是否实际收到新文，均未验证。`待验证 / 未知`
3. **结构编辑高风险。** tool/thinking/image/未知块可被压成 text；工具配对会成为孤儿。`源码已确认`；`隔离测试已确认`
4. **subagent 假成功。** 新 envelope 的 read projection 与 write locator 不对称。`源码已确认`；`隔离测试已确认`
5. **数据丢失和竞态。** 畸形行丢失、直接截空重写、无锁、无 CAS、批量部分成功。`源码已确认`；畸形行 `隔离测试已确认`
6. **Extract 身份不一致。** 新 filename ID 没同步 entry `sessionId`；是否可被 Claude resume 识别未知。`源码已确认`；身份值 `隔离测试已确认`；resume `待验证 / 未知`
7. **Duplicate subagent 身份残留。** 顶层主文件重写 ID，但复制的嵌套 sessions 保持旧 sessionId。`源码已确认`
8. **LAN 暴露。** 服务监听所有接口且没有认证，mutation API 可直接改本机历史。`源码已确认`

### 8.2 建议的最小隔离验证

以下验证应全部使用项目 `.研究临时数据/` 下合成 HOME，不触碰真实会话：

1. **建立双 provider fixture corpus。** 每种引擎至少覆盖纯文本、多 text block、thinking/reasoning、成对/多重 tool call、image、未知字段、fork、多 parent、compact、subagent、空行、畸形尾行和超大行。`待验证 / 未知`
2. **先做 lossless round-trip。** 未编辑文档必须 byte-for-byte 不变；编辑一个 text block 时，允许变化的 JSON Pointer 白名单只含目标字段，其他记录与字段逐字节或 canonical-object 相等。`待验证 / 未知`
3. **全图结构校验。** 保存前后验证 UUID 唯一性、parent 引用、活动分支可达性、双向工具配对、provider 必需 envelope、session ID 一致；发现问题应拒绝或展示 repair plan，不能静默删块。`待验证 / 未知`
4. **并发和故障注入。** 在 read 后模拟外部 append/replace，保存必须因 expected hash/mtime/size 不符而拒绝；分别在 temp write、fsync、replace、backup manifest 阶段注入异常，验证原文件或备份总有一份完整。`待验证 / 未知`
5. **权限/元数据测试。** 在 macOS/Linux 验证 mode、owner、xattr、mtime 策略和 symlink 拒绝；验证同目录 temp + file fsync + directory fsync。`待验证 / 未知`
6. **subagent 定位测试。** display node 必须携带 provider document pointer，而不是保存时按 UUID重新猜文件/层级；对 `progress.data.message.message.content` 做读写对称断言。`待验证 / 未知`
7. **恢复分层测试。** 在得到明确授权前，只完成“UI→磁盘”和结构 validator；不要运行真实 resume。未来若批准，应在一次性系统用户/容器和 disposable HOME 中分开记录：(a) CLI 能列出，(b) resume 不报错，(c)通过可观测上下文证据确认新文被采用。三项任何一项都不能替代下一项。`待验证 / 未知`

## 9. 本次隔离测试方法与结果

### 9.1 方法

- 测试脚本：`.研究临时数据/agent1_llm_lens_probe.py`（主项目相对路径）。
- synthetic HOME：`.研究临时数据/agent1-llm-lens-home/`；脚本把 `CLAUDE_PROJECTS_DIR`、archive 与 `peek_cache` 路径全部改到该目录。未访问真实 `~/.claude`/`~/.codex`。`隔离测试已确认`
- 工作区未安装 Flask，遵守“不安装大型依赖”约束。脚本提供仅满足 import/decorator/jsonify/request 的最小 Flask stub，**直接调用** `api_edit_message`、`api_delete_message`、`api_extract_messages`；因此结果验证 mutation 函数和磁盘数据，不等价于完整 HTTP/浏览器 E2E。`隔离测试已确认`
- 执行命令：

```bash
HOME=".../.研究临时数据/agent1-llm-lens-home" \
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=".../参考项目/llm-lens" \
python3 ".研究临时数据/agent1_llm_lens_probe.py"
```

- 第一次尝试直接导入时因 `ModuleNotFoundError: flask` 停止，没有产生会话 mutation；随后使用上述 stub。没有运行仓库完整 pytest、浏览器 UI 或真实 resume。`隔离测试已确认`

### 9.2 结果

| 用例 | 结果 |
|---|---|
| 编辑链首条纯文本 | 返回成功；目标变为新 text；后三条对象相等；UUID/parent 链全部不变。`隔离测试已确认` |
| 编辑含 `tool_use t1` 条 | 返回成功；目标只剩 text；后续 `tool_result t1` 保留，出现孤儿。`隔离测试已确认` |
| 删除含 `tool_use t1` 条 | 调用条与纯结果条均移除，后续 `a2` 改挂到 `u1`，其余后续保留。`隔离测试已确认` |
| 只删除 `tool_result t1` 条 | `tool_use t1` 保留、结果集合为空，出现反向孤儿。`隔离测试已确认` |
| Extract `u1,a2` | 源不在该函数中改写；新文件 ID 为新 UUID，但两条 entry 的 `sessionId` 仍为旧值 `s`；`a2.parentUuid` 跳到 `u1`。`隔离测试已确认` |
| 编辑顶层 system event | 返回成功，顶层 `content` 仍是 `original event`。`隔离测试已确认` |
| 编辑 progress-wrapped subagent | 返回成功，`data.message.message.content` 仍是 `nested original`。`隔离测试已确认` |
| 文件含畸形行后编辑 prose | 返回成功；畸形行不再存在。`隔离测试已确认` |

## 10. 结论

`llm-lens` 已经证明了一个有价值的产品形态：本地浏览 Claude JSONL、把复杂块投影为聊天 UI、对选定消息做文本变换、保留普通编辑点之后的历史记录，并提供 raw 下载、归档、抽取和统计。但它的核心数据模型是“**有损展示字符串 + 全文件重序列化**”，不是可靠的会话编辑文档模型。

对用户目标的最终判断：

- **Claude 普通正文原地修改且保留后续消息：可作为原型，不能直接作为生产保证。** `源码已确认`；`隔离测试已确认`
- **Claude 结构化消息、subagent、并发活动会话：当前实现不可靠。** `源码已确认`；关键失败已 `隔离测试已确认`
- **Codex：完全未实现。** `源码已确认`
- **真实 resume 和模型采用新内容：没有证据。** `待验证 / 未知`
- **推荐复用：** UI 交互、纯文本 transforms、部分只读 discovery/统计、Debloat 的 temp-replace 思路；**不推荐直接复用：** `_format_entry_message` 作为编辑模型、当前 edit/delete/extract writer、以自定义“resume-safe”断言替代 provider 官方/实证验证。

## 11. 证据索引

| 结论 | 固定提交源码 |
|---|---|
| 仅 Claude 路径、未来 provider 尚未抽象 | [`llm_lens/__init__.py` L1-L9、L38-L44](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1-L44) |
| JSONL 消息投影和内容块扁平化 | [`llm_lens/__init__.py` L866-L982](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L866-L982) |
| 主消息读取、过滤、UUID 去重 | [`llm_lens/__init__.py` L985-L999、L1048-L1074](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L985-L999) |
| 当前/旧式 subagent 发现 | [`llm_lens/__init__.py` L1077-L1317](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L1077-L1317) |
| 编辑文件定位 | [`llm_lens/__init__.py` L2548-L2580](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2548-L2580) |
| Delete 父链和单向工具清理 | [`llm_lens/__init__.py` L2517-L2545、L2583-L2647](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2517-L2545) |
| content 替换规则 | [`llm_lens/__init__.py` L2650-L2685](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2650-L2685) |
| Edit 完整写回路径 | [`llm_lens/__init__.py` L2977-L3041](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2977-L3041) |
| Extract 父链/工具处理与 sessionId 缺口 | [`llm_lens/__init__.py` L3242-L3315](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L3242-L3315) |
| Duplicate ID 重写与 subagent 缺口 | [`llm_lens/__init__.py` L2224-L2291](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/__init__.py#L2224-L2291) |
| 前端非 prose 编辑明确放行 | [`messages.js` L609-L668、L1205-L1261](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/static/js/views/messages.js#L609-L668) |
| Debloat 规则、原子替换与回滚边界 | [`debloat.py` L83-L179、L276-L393](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/llm_lens/debloat.py#L83-L179) |
| MIT 许可证 | [`LICENSE` L1-L20](https://github.com/jajanet/llm-lens/blob/307c31acb0c255d5c3aa6cb4a3001bfe21af11a0/LICENSE#L1-L20) |
