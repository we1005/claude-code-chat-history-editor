# Claude Code JSONL Editor 机制与能力调研

## 摘要

研究对象仅为 `参考项目/claude-code-jsonl-editor/`。本地 `HEAD` 已核对为固定快照 `7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5`，`git status --short` 为空；远端身份为 `didvc/claude-code-jsonl-editor`。本次未联网、未改参考仓库、未访问真实 `~/.claude`/`~/.codex`，也未运行 Claude Code/Codex resume 或模型请求。

**总判断（源码已确认）**：该项目是一个约千行的 Preact + Express 原型。它可以浏览 `type=user|assistant` 的 Claude 风格 JSONL，并把某条消息的整个 `message.content` 替换为字符串；保存时不是字节或行级“原地修改”，而是把内存中的全部可解析对象重新 `JSON.stringify` 后覆盖原文件。对“唯一 UUID + 字符串 content + 全部行均为 JSON 对象”的简单记录，它会保留目标之后的对象及其顺序；但复杂 content block 会在编辑目标行时丢失，坏行会在任意保存中消失，删除不修复会话图或工具调用关系。

**与用户目标的适配结论**：可借鉴 UI 和最小读写链，但不能直接作为“Claude + Codex 历史原地编辑且保留后续消息”的可靠后端。源码没有 Codex schema、真正的 fork/截断/repair/compact、并发保护、原子提交、图一致性校验或 resume 集成。README 所称“编辑后继续对话”不是当前 Claude Code 官方恢复行为的充分证据。

## 1. 项目、快照与证据口径

### 1.1 定位与技术栈

- **源码已确认**：CLI/NPM bin 是 `start.js`；它接收文件/目录、端口、备份和监听参数，再启动 `server.js` 与 Vite 客户端（[`package.json` `bin/scripts` L16–27](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/package.json#L16-L27)，[`start.js` CLI 与 spawn L17–31、L118–191](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/start.js#L17-L31)）。
- **源码已确认**：前端是 Preact + TypeScript + Vite，入口 `main.tsx` 渲染 `App`；后端是 Node ESM + Express/CORS（[`src/main.tsx` L1–5](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/main.tsx#L1-L5)，[`package.json` L28–42](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/package.json#L28-L42)）。
- **源码已确认**：10 个 JS/TS/TSX 源文件合计约 1,021 个物理行；核心集中在 `start.js`、`server.js`、`src/app.tsx`、`src/utils/jsonlParser.ts` 和两个消息组件。项目没有单元/E2E 测试脚本，只有安装脚本测试（[`package.json` L20–27](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/package.json#L20-L27)）。
- **文档声称**：README 将其描述为 Claude Code 会话的交互式编辑器，并宣称 real-time sync、安全备份和编辑后继续对话（[`README.md` L1–3、L18–24、L39–47](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/README.md#L1-L47)）。后文源码链路表明“real-time”和“safe”均需大幅限定。

### 1.2 证据级别

- **源码已确认**：可由固定提交中的实现直接推出。
- **隔离测试已确认**：仅复现项目算法或在 `.研究临时数据/` 合成记录上执行；不代表官方客户端兼容性。
- **文档声称**：只来自 README/CLI 帮助，不等同于实现或官方保证。
- **待验证 / 未知**：本次限制下未做，或需要 Claude Code/Codex 官方实现、具体版本及端到端环境才能判定。

## 2. 核心架构及完整读写调用链

### 2.1 文件选择与发现

1. **源码已确认**：用户必须用 `--jsonl-path` 指定单文件或目录；未指定时只尝试启动工作目录的 `./samples`，并不自动发现 `~/.claude` 中的项目/会话（[`start.js` `program`/配置验证 L17–31、L87–111](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/start.js#L17-L31)）。
2. **源码已确认**：`server.js:getPathInfo()` 对目录只做一层 `readdir`，仅列文件名以 `.jsonl` 结尾的顶层项；单文件模式只返回该文件的 basename（[`server.js` `getPathInfo` L84–109、`GET /api/files` L132–154](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L84-L109)）。没有按项目、session ID、更新时间或 Claude 会话元数据索引。
3. **源码已确认**：前端探测 localhost 的 3001–3010 端口，取得 `/api/files` 后自动载入列表第一项；选择器切换时再请求指定文件（[`src/app.tsx` `findServerPort`/`loadAvailableFiles`/`loadFileFromServer` L14–31、L62–90](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L14-L31)）。
4. **源码已确认**：纯浏览器模式可用 `FileReader` 导入任意 `.jsonl`，但 `currentFile` 被置空，不能写回原文件；只能导出一个名为 `edited-conversation.jsonl` 的下载副本（[`src/app.tsx` `handleFileLoad`/`handleExport` L156–168、L208–221](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L156-L168)）。

### 2.2 读取、解析与呈现

```text
GET /api/files/:filename
  → fs.readFile(filePath, "utf-8")
  → JSON 响应中的 content 字符串
  → App.loadFileFromServer()
  → parseJSONL()
  → entries（全部成功 JSON.parse 的值）
     ├─ summaries（type=summary）
     └─ messages（type=user|assistant）
  → ConversationView → MessageBubble → extractMessageContent()
```

- **源码已确认**：服务端读取全文，不流式、不分页（[`server.js` 读取端点 L156–185](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L156-L185)）。
- **源码已确认**：`parseJSONL()` 先 `trim()`，按换行拆分并过滤空行；每个非空行独立 `JSON.parse`。语法错误只 `console.error` 后跳过，没有向 UI 汇总错误，也没有 schema 校验（[`src/utils/jsonlParser.ts` `parseJSONL` L3–19](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L3-L19)）。因此它的“容错”实际是**丢弃坏行后继续**，并非保留或修复。
- **隔离测试已确认**：7 行合成输入含 1 个坏行，得到 6 个对象和 4 条可见消息；保存后的输出不再包含坏行。另用合法 JSON 值 `null` 测试时，后续 `entry.type` 访问抛 `TypeError`；所以“逐行 catch”也不等于能容忍所有合法 JSONL 值。
- **源码已确认**：UI 只呈现 `user`/`assistant`，按 `entries` 的物理顺序，不沿 `parentUuid` 选主链，也不排除 `isSidechain`；summary 和其他记录不可见（[`src/utils/jsonlParser.ts` L16–19](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L16-L19)，[`src/components/ConversationView.tsx` L11–24](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/components/ConversationView.tsx#L11-L24)）。
- **源码已确认**：字符串 content 原样显示；数组 content 仅筛 `type === "text"`，取 `text` 后**无分隔拼接**。thinking、tool_use、tool_result 及未知 block 均不显示（[`src/utils/jsonlParser.ts` `extractMessageContent` L26–40](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L26-L40)）。时间仅通过 `new Date(...).toLocaleTimeString()` 展示（[`MessageBubble.tsx` L34–39](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/components/MessageBubble.tsx#L34-L39)）。

### 2.3 编辑状态、序列化与落盘

```text
MessageBubble.Edit
  → 把当前“抽取后的纯文本”放进本地 textarea state
MessageBubble.Save
  → App.handleEdit(uuid, text)
  → map 全部 entries：所有 uuid 相等且有 message 的项
  → {...entry, message:{...entry.message, content:text}}
  → 只更新浏览器内存

顶部 Save to File
  → serializeJSONL(conversation.entries)
  → 每个对象 JSON.stringify + LF，末尾再加 LF
  → POST 整个 content
  → 读取原文件并写 file.backup.<Date.now()>
  → fs.writeFile(original, content, "utf-8") 覆盖
  → 返回 success，前端 alert
```

- **源码已确认**：消息气泡内的 “Save” 只结束 textarea 编辑并改内存；只有顶部 “Save to File” 才写盘。Cancel 不改全局状态（[`MessageBubble.tsx` `handleEdit/handleSave/handleCancel` L12–32、L41–63](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/components/MessageBubble.tsx#L12-L32)，[`src/app.tsx` L246–248](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L246-L248)）。
- **源码已确认**：`handleEdit()` 展开外层 entry 和 message，但把 `message.content` 整体替换为字符串；它不是 block 级编辑（[`src/app.tsx` `handleEdit` L170–191](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L170-L191)）。
- **源码已确认**：`serializeJSONL()` 对全部 entries 重序列化并强制单个 LF 分行和末尾 LF，不保存原始行文本、空行、缩进或换行风格（[`src/utils/jsonlParser.ts` `serializeJSONL` L22–24](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L22-L24)）。
- **源码已确认**：`saveFileToServer()` 发送整份快照；服务端备份后直接 `fs.writeFile` 原路径，成功响应前没有重新读取、重新解析或比对（[`src/app.tsx` L92–129](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L92-L129)，[`server.js` 保存端点 L188–230](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L188-L230)）。

## 3. 格式保真与编辑能力矩阵

| 对象/粒度 | 浏览 | 编辑后的真实结果 | 未编辑保存的保真度 | 证据级别 |
|---|---|---|---|---|
| user 字符串正文 | 显示 | 整个 content 换成新字符串 | JSON 值保留，字节格式不保留 | 源码已确认 |
| assistant 字符串正文 | 显示 | 同上 | 同上 | 源码已确认 |
| 多个 text blocks | 无分隔拼成一段 | 整个数组坍缩成一个字符串，block 边界消失 | 数组语义保留但整行重序列化 | 源码已确认；隔离测试已确认 `firstsecond` |
| thinking block | 不显示 | 编辑同一消息时被删除 | 未触碰时作为未知 block 随对象保留 | 源码已确认 |
| tool_use / tool_result | 不显示 | 编辑所在消息时全部删除 | 未触碰时保留；不做配对校验 | 源码已确认；隔离测试已确认 tool_use 丢失 |
| 未知 content block/字段 | 不显示 | content 子树全部丢失 | 未触碰时保留 JSON 值 | 源码已确认 |
| entry/message 上未知字段 | 不显示 | 目标行经对象展开而保留 | 保留 JSON 值 | 源码已确认；隔离测试已确认 `unknownTop`/`unknownMessage` |
| 未知 `type` 的合法对象 | 不显示 | UI 无法直接编辑 | 仍在 `entries`，保存时重序列化 | 源码已确认；隔离测试已确认 `progress` 保留 |
| summary / compact 相关记录 | summary 不显示；无 compact 模型 | 无专门编辑 | 合法对象通常穿透 | 源码已确认；具体新版本格式待验证 |
| 空行、缩进、CRLF、末尾换行 | 不呈现 | 统一成紧凑 JSON + LF | 不保留词法形式 | 源码已确认 |
| 语法错误行 | 控制台报错，UI 不见 | 下一次保存永久丢弃 | 不保留 | 源码已确认；隔离测试已确认 |
| 原始记录/raw line | 无此模型 | 无法做局部 raw patch | 不可能字节无损 | 源码已确认 |

补充边界：

- **源码已确认**：TypeScript 类型只声明 `{type, text}` content block，但运行时没有验证（[`src/types.ts` `ClaudeMessage` L1–4](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/types.ts#L1-L4)）。类型声明不能保护真实历史中的工具、thinking 或未来 block。
- **源码已确认**：合法 JSON 对象的未知属性一般可穿透 `JSON.parse` → JS 对象 → `JSON.stringify`；这只是**值级**保留。重复键、数值词法/精度、转义、键/空白布局等原始表示没有保存通道。
- **待验证 / 未知**：该固定快照对当前 Claude Code 各版本全部记录类型的覆盖率。项目 schema 仅列 `summary|user|assistant` 和少量元数据（[`src/types.ts` `ClaudeEntry` L6–21](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/types.ts#L6-L21)），不能据此推断官方完整 schema。
- **源码已确认**：项目没有 Codex 记录类型、item schema 或会话发现适配器。Codex JSONL 即使每行能被 `JSON.parse`，也可能完全不进入 `messages`，因此不能称为 Codex 编辑器。

## 4. 后续历史、标识与功能语义

### 4.1 “原地修改且保留后续消息”到底成立到哪一层

- **源码已确认**：编辑使用 `entries.map`，不删除、不排序其他对象；保存使用该数组原顺序。因此在**目标 UUID 唯一、所有行均成功解析**时，目标之后的对象仍会存在且相对顺序不变（[`src/app.tsx` L170–190](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L170-L190)）。
- **隔离测试已确认**：合成数据编辑第 3 行后，第 4–6 行及其 `parentUuid`/未知字段仍在输出；但第 3 行 content 数组中的 tool_use 消失，坏的第 7 行消失。
- **源码已确认**：这不是文件偏移上的“原地 patch”，而是**整文件覆盖式逻辑编辑**。所以“后续对象仍在”不等于后续对象字节未变，更不等于会话图、工具状态或恢复上下文仍有效。
- **源码已确认**：定位只按 `uuid` 等值比较。重复 UUID 会批量修改/删除；缺失 UUID 的带 message 记录也可能因 `undefined === undefined` 被批量命中。没有唯一性检查（[`src/app.tsx` `handleEdit/handleDelete` L170–202](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L170-L202)）。

### 4.2 一致性维护

- **源码已确认**：普通编辑不主动改变 entry 的 `uuid`、`parentUuid`、timestamp、requestId 或数组顺序；这是对象展开的副作用，不是显式不变量验证。
- **源码已确认**：项目从不遍历 `parentUuid`，`isSidechain` 也只在类型中出现。它不判断当前 leaf、主链、分支或 summary 的 `leafUuid` 是否一致（[`src/types.ts` L6–20](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/types.ts#L6-L20)，[`ConversationView.tsx` L11–24](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/components/ConversationView.tsx#L11-L24)）。
- **源码已确认**：没有 tool_use ID ↔ tool_result.tool_use_id 配对模型。编辑复杂消息会直接破坏配对；删除也可能留下孤立工具结果。
- **待验证 / 未知**：Claude Code resume 遇到已改正文但旧 usage/cache、requestId、summary、工具结果时的处理方式。第三方代码没有官方校验器，不能回答。

### 4.3 编辑、删除、截断、fork、repair、compact 严格区分

| 操作 | 是否存在 | 实际语义 |
|---|---|---|
| 编辑 | 是 | 按 UUID 将一个或多个 entry 的完整 `message.content` 替换为字符串；其他已解析对象保留；整文件重写。 |
| 删除 | 是 | `filter(entry.uuid !== uuid)` 删除所有匹配记录；其后的记录仍在，不修 child.parentUuid、summary.leafUuid 或工具配对。它不是截断。 |
| 截断 | 否 | 没有“从某消息以后删除”的实现。 |
| fork | 否 | 不复制 session、不生成新 UUID/文件、不重接父链。README 的 “Conversation Branching” 只是应用设想（[`README.md` L29–35](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/README.md#L29-L35)）；导出副本也不是语义 fork。 |
| repair | 否 | 无 schema、引用、工具配对、坏行或 leaf 修复器；解析异常仅跳过。 |
| compact | 否 | 只筛出 `summary` 数组，既不显示也不生成/更新 summary；源码无 compact 调用链。 |

以上“存在/不存在”均为**源码已确认**（编辑/删除见 [`src/app.tsx` L170–202](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L170-L202)，summary 筛选见 [`jsonlParser.ts` L16–19](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L16-L19)）。

## 5. 保存成功、resume 成功与模型采用：三条不同证据边界

1. **文件保存成功（源码已确认的最低语义）**：服务端只有在 `await fs.writeFile(...)` resolve 后才返回 `{success:true}`，前端据此 alert（[`server.js` L223–230](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L223-L230)，[`src/app.tsx` L112–128](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L112-L128)）。这只说明 Node 写调用完成；源码没有 fsync、重读、JSONL 校验或内容 hash 验证。
2. **Claude Code resume 成功（待验证 / 未知）**：源码没有 resume 命令、会话注册、版本探测或恢复测试；全仓源码中没有 `resume` 实现。即便文件仍可被 Claude Code 打开，也只能证明某版本解析/选择了某会话。
3. **恢复后模型实际采用新内容（待验证 / 未知）**：还需证明构造给模型的上下文包含新正文，而不是旧 summary/compact、另一条 parent 链、缓存或别的 leaf。能启动 UI/看到文件、能列出 session、甚至 resume 不报错，都不足以证明这一点。

**文档声称**：README 称“Edit the response directly → Continue conversation”并宣称保留完整上下文（[`README.md` L18–25](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/README.md#L18-L25)）。这是第三方项目说明，不能充当当前 Claude Code 官方行为证据。

## 6. 写入可靠性与损坏窗口

| 维度 | 源码结论 | 风险 |
|---|---|---|
| 备份 | 默认先读原文件，再写相邻 `.backup.<毫秒时间戳>`；`server.js` 直接支持 `--no-backup` | 有基础回退副本，但无列表、校验、轮换、恢复按钮；备份失败只 warning，仍继续覆盖（[`server.js` L41–43、L211–223](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L41-L43)）。主 CLI 声明 Commander negated option，却检查 `options.noBackup` 再转发（[`start.js` L27、L129–131](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/start.js#L27-L27)）；该字段名是否导致主 CLI 禁用失效，因依赖未安装属**待验证 / 未知**。 |
| 原子性 | 直接 `fs.writeFile(original, ...)` | 不是 temp + fsync + rename；进程/机器故障可能留下空或部分文件。 |
| 并发控制 | 无锁、无 mtime/hash/版本/ETag 比对 | 从加载到保存间的 Claude 追加、另一浏览器保存会被旧快照整文件覆盖，最后写者胜。 |
| 活动会话 | 无 Claude 进程/活动文件检测，无只读模式 | 对正在写入的 session 风险最高。 |
| 顺序/校验 | 数组顺序写出；不校验 JSONL/图/工具关系 | 写调用成功仍可能得到语义损坏的会话。 |
| 权限/所有权 | 以启动服务的 OS 身份读写；源码无 chmod/chown/mode 保留策略 | 原文件能否写取决于 OS；备份新文件权限受默认创建规则影响。实际 ACL/扩展属性行为待验证。 |
| 请求体/大文件 | 全文装进内存并包在 JSON 请求体；`express.json()` 未配置 limit（[`server.js` L78–82](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L78-L82)） | 有内存放大；有效 body 上限取决于 Express 默认配置，本次因依赖未安装未实测。 |

其他可靠性/安全细节：

- **源码已确认**：页面加载后仅持有内存快照，没有文件 watcher。`useEffect` 在 1 秒和 5 秒各探测一次服务；每次成功都会重新加载文件列表并自动打开第一项，5 秒重检甚至可能覆盖用户刚切换/尚未落盘的内存编辑（[`src/app.tsx` L34–54、L62–72、L143–154](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L34-L54)）。README 的 “Real-time File Sync” 与实现不符。
- **源码已确认**：目录模式将路由参数直接 `path.join(jsonlPath, filename)`，没有 basename、扩展名、resolve 后 containment 或 symlink 校验（[`server.js` L156–178、L198–209](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L156-L178)）。**待验证 / 未知**：特定编码的 `../` 经 Express 路由后的可利用形式；但后端缺少路径沙箱本身已确认。
- **源码已确认**：前端 API 固定访问 `localhost`，CORS 也只允许 localhost 来源；`--expose` 虽令监听地址变为 `0.0.0.0`，并不足以构成可靠远程访问方案（[`src/app.tsx` L14–31](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L14-L31)，[`server.js` L74–82](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L74-L82)）。这也不应被视为访问控制。

## 7. 许可证、依赖与复用分析

### 7.1 许可证与依赖

- **源码已确认**：项目是 MIT License，可使用、复制、修改、合并、发布、分发、再许可和出售；分发软件或 substantial portions 时必须保留版权和许可声明，且作者不提供担保（[`LICENSE` L1–21](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/LICENSE#L1-L21)）。
- **源码已确认**：直接运行依赖为 Preact、Express、CORS、concurrently、chalk、commander；开发依赖为 Preact Vite preset、TypeScript、Vite 和 Node/Express/CORS 类型包（[`package.json` L28–46](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/package.json#L28-L46)）。
- **待验证 / 未知**：所有传递依赖的许可证、安全状态和当前兼容性；本次没有安装或审计依赖。

### 7.2 可提取模块及价值

| 模块 | 可复用点 | 不应原样复用之处 |
|---|---|---|
| `jsonlParser.ts` | 极小、逐行解析和对象序列化接口清楚 | 丢坏行、无 raw line/schema/诊断、复杂 content 展示错误 |
| `MessageBubble`/`ConversationView` | 简单聊天浏览、内联 textarea 交互 | 混合主链/sidechain，只显示拼接文本，UUID key/定位不稳健 |
| `App` 状态流 | 文件选择—编辑—显式保存的原型 | 整文件快照、双重自动重载、无 dirty/conflict 状态 |
| `server.js` 文件 API | 单文件/目录入口和“先备份再写”思路 | 非原子、无 CAS/锁/校验/路径沙箱/恢复管理 |
| `start.js` | 小型本地 CLI 启停壳 | 客户端 API 地址与服务配置脱节，活动会话无保护 |

### 7.3 改造成稳健双引擎后端所需工作

1. **格式层**：为 Claude 与 Codex 建独立、版本化 adapter；保留每行原始 bytes、解析状态和稳定行 ID，只重序列化被批准修改的字段/块。
2. **编辑层**：以 content block 为基本单位；thinking/tool_use/tool_result 默认只读或提供显式结构化编辑；禁止把复杂数组隐式坍缩成字符串。
3. **一致性层**：构建 Claude UUID/parent/leaf/sidechain 图与 Codex 对应顺序/引用模型；保存前校验唯一 ID、父引用、tool pair、summary/compact 边界和时间顺序。
4. **提交层**：dirty diff、原文件 hash+size+mtime CAS、活动会话只读保护、同目录 temp 写入、flush/fsync、原子 rename、目录 fsync、权限/ACL 策略、可验证备份和一键恢复。
5. **产品语义**：把“编辑并保留后续”“删除单条”“截断后续”“fork 到新 session”“repair”“compact”做成不同命令、预览和审计记录，不能共用模糊的 Delete/Export。
6. **恢复验证层**：按 Claude Code/Codex 版本维护隔离 fixture 和 resume 兼容矩阵；把“文件写成”“客户端恢复”“模型上下文采用”分别记结果。

**统一双引擎价值（分析结论）**：可共享会话目录索引、raw-line 存储、diff/事务写入、备份恢复和通用消息 UI；但 Claude 的 UUID/parent/sidechain/summary 与 Codex 的事件/item 语义必须留在不同 adapter 内。统一应发生在事务和展示抽象层，不应强行统一底层 schema。

## 8. 风险、未知项与最小隔离验证方案

### 8.1 主要风险与未知项

1. **高：复杂消息静默破坏（源码已确认）**——一旦编辑，非 text block 和多块边界消失，且 UI 不预警。
2. **高：并发丢写/故障截断（源码已确认）**——整文件旧快照覆盖，无原子替换、锁或 CAS；备份失败仍继续。
3. **高：会话图与工具关系失效（源码已确认）**——删除、批量 UUID 命中和 content 坍缩均可能制造孤儿引用。
4. **高：resume 与模型采用未知（待验证 / 未知）**——项目没有任何官方恢复证据。
5. **中：坏行和词法信息丢失（源码已确认）**——“未编辑的行”也会被 parse/stringify 改写；合法 `null` 还能令解析流程崩溃（隔离测试已确认）。
6. **中：Codex 不受支持（源码已确认）**——不能因“也是 JSONL”就视为兼容。
7. **中：大文件、权限、路径边界（部分源码已确认；具体阈值/平台表现待验证）**。

### 8.2 最小隔离验证方案

所有 fixture 和输出只放在项目 `.研究临时数据/`，绝不读写真实会话：

1. **解析/保真 corpus（无需模型）**：覆盖纯文本、多 text block、thinking、tool_use/result、未知 type/字段、summary/compact 样例、CRLF/BOM/空行、坏行、`null`、重复 UUID、超大整数。逐行比较 raw hash、解析值和诊断；要求未修改行 byte-for-byte 不变。
2. **编辑不变量（无需模型）**：修改中间一条指定 block，断言后续 raw 行 hash 不变；校验 ID 唯一、parent/leaf 可达、tool_use/result 成对、物理顺序和时间戳策略。删除、截断、fork 分别用不同 golden files。
3. **写入故障/并发（无需模型）**：在临时目录模拟“加载后外部追加”“两个编辑器竞争”“备份失败”“temp 写一半进程终止”“rename 前后终止”；验证冲突拒绝、原文件或备份至少一份完整、权限策略和恢复流程。另测大请求体上限。
4. **客户端解析/resume（未来授权后）**：使用隔离 `HOME` 和去敏 session 副本，锁定 Claude Code/Codex 版本；先在阻断网络/模型传输条件下验证会话发现与解析。如果 CLI resume 必然触发模型请求，则本阶段停止，不能把“列表可见”写成“resume 成功”。
5. **模型实际采用（未来单独授权）**：在可审计的隔离账号/传输桩环境中给被改文本植入唯一 marker，捕获实际发送上下文或用确定性问题验证 marker；同时覆盖有/无 summary/compact、不同 leaf、工具调用前后。只有此步才能支持“恢复后模型采用新内容”。

## 9. 本次实际验证状态

- **隔离测试已确认**：运行 `.研究临时数据/claude-jsonl/parser-check.mjs`，输入 7 行；输出为 6 个解析对象、4 条可见消息、坏行未保留、未知 record/字段保留、`first` + tool_use + `second` 显示成 `firstsecond`、编辑后数组变字符串且 tool_use 消失、外层 parentUuid/requestId 保留。后续对象仍在输出。
- **隔离测试已确认**：独立复现 `parseJSONL` 对 `null\n` 的行为，得到 `TypeError: Cannot read properties of null (reading 'type')`。
- **隔离测试已确认**：`node --check server.js` 与 `node --check start.js` 通过语法检查。
- **待验证 / 未知**：尝试只针对临时目录启动服务端，在模块加载阶段因本地未安装 `express` 而终止；遵守限制未安装依赖。因此 HTTP 备份/覆盖、并发、权限、路径和请求体上限未做运行时验证。
- **未执行**：真实 Claude/Codex session 读取、真实 resume、模型请求、构建、浏览器 UI/E2E；没有修改候选仓库源码。

## 10. 结论

`claude-code-jsonl-editor` 最准确的定位是：**一个带备份的、整文件重写式 Claude 风格 JSONL 文本原型**。它对简单字符串消息提供了低成本 UI，并在理想输入下保留目标后的已解析对象；但其“编辑”会把复杂 content 强制降级为字符串，“删除”仅删对象而不修图，“保存”是无并发检查的非原子覆盖。项目不存在 fork、截断、repair、compact 或 resume 实现，也没有 Codex adapter。

对新项目，可复用其聊天式 UI、显式保存入口和备份概念；核心存储与编辑后端应重写为 raw-line 保真、双 schema adapter、block 级 patch、图/工具校验和事务性写入。任何“Claude Code 能 resume”或“模型会使用改后内容”的产品承诺，都必须通过独立版本化隔离测试建立，不能从本项目 README 或写盘成功推导。

## 11. 证据索引

| 主题 | 固定提交源码 |
|---|---|
| 类型边界 | [`src/types.ts` L1–27](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/types.ts#L1-L27) |
| 逐行解析、筛选、序列化、文本抽取 | [`src/utils/jsonlParser.ts` L3–40](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/utils/jsonlParser.ts#L3-L40) |
| 文件加载、保存、编辑、删除、导出 | [`src/app.tsx` L62–129、L156–221](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/app.tsx#L62-L129) |
| 消息编辑状态与呈现 | [`src/components/MessageBubble.tsx` L12–63](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/src/components/MessageBubble.tsx#L12-L63) |
| 服务端文件发现与读取 | [`server.js` L84–109、L132–185](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L84-L109) |
| 备份与覆盖写 | [`server.js` L188–230](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/server.js#L188-L230) |
| CLI/默认目录/进程启动 | [`start.js` L17–31、L87–145、L176–191](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/start.js#L17-L31) |
| 依赖与脚本 | [`package.json` L16–46](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/package.json#L16-L46) |
| 项目文档声称 | [`README.md` L7–47、L185–204](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/README.md#L7-L47) |
| MIT 许可 | [`LICENSE` L1–21](https://github.com/didvc/claude-code-jsonl-editor/blob/7edc2d0f58db28b81e199a4ffa106d1e9ed96ff5/LICENSE#L1-L21) |
