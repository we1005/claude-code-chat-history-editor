





我又专门围绕 **“真正修改 Claude Code / Codex 已有 session 历史消息，并且修改后还能继续 resume”** 搜了一轮。这个方向确实有项目，而且这次找到了几个比普通 JSONL Viewer 更对口的。

### 我认为最值得看的项目

| 项目                                  | 对象        | 真正编辑历史消息 | 删除消息 | Resume 兼容处理            | 推荐度 |
| ------------------------------------- | ----------- | ---------------- | -------- | -------------------------- | ------ |
| **jajanet/llm-lens**                  | Claude Code | ✅                | ✅        | ✅ 专门处理链关系           | ⭐⭐⭐⭐⭐  |
| **outx-sec/coldxx**                   | Codex       | ✅                | ✅/删记录 | ✅ 有备份/回滚/active 防护  | ⭐⭐⭐⭐⭐  |
| **didvc/claude-code-jsonl-editor**    | Claude Code | ✅                | ✅        | ⚠️ 更接近直接 JSONL 修改    | ⭐⭐⭐⭐   |
| **citizenll/csm**                     | Codex       | 部分             | 间接     | ✅ 强调 repair/fork/compact | ⭐⭐⭐⭐   |
| **fengchenzxc/Codex-Session-Manager** | Codex       | ❌普通消息        | ❌        | ✅ repair/migrate/clone     | ⭐⭐⭐    |
| **bimcc/codex-session-man**           | Codex       | ❌普通消息        | ❌        | ✅ provider/metadata 修复   | ⭐⭐⭐    |

## 1. Claude Code：`jajanet/llm-lens` 是目前最符合你需求的

这是这轮搜索里我认为**最值得你研究的 Claude Code 历史消息编辑器**。

[GitHub：jajanet/llm-lens](https://github.com/jajanet/llm-lens?utm_source=chatgpt.com)

它不是简单的 JSONL Editor，而是明确知道自己修改的是 **Claude Code transcript**。

它支持：

- 浏览 `~/.claude/projects/**/*.jsonl`
- 直接修改某一条 user / assistant 文本
- 删除单条消息
- Redact 消息
- Duplicate 整个会话
- Extract 一部分消息生成新会话
- Archive 会话
- Debloat 会话
- 下载原始 JSONL
- 修改之前 preview diff

最关键的是：

> 删除一条消息时，它不是简单 `delete line`。

它会处理 Claude Code 的：

```
parentUuid
```

链，并处理因为删除消息产生的孤立：

`tool_use` / `tool_result`

项目 README 明确说明，它在删除消息时会**重新链接 parentUuid chain，并清理 orphan tool blocks**，目的是尽可能维持 `/resume` 可用。([GitHub](https://github.com/jajanet/llm-lens?utm_source=chatgpt.com))

比如它甚至提供这样的 API：

```text
DELETE /api/projects/:folder/conversations/:id/messages/:uuid
POST   /api/projects/:folder/conversations/:id/messages/:uuid/edit
```

也就是说，可以真正做到：

```text
Claude session

User:
帮我实现 A

Assistant:
错误方案 B

User:
继续按照 B 做
```

你可以把中间 Assistant 修改成：

```text
Assistant:
正确方案 C
```

或者删除一段消息，再继续：

```bash
claude --resume <session-id>
```

这基本就是你最开始所说的**“修改 session 历史，让后续模型看到修改后的历史”**。它自己也明确表示：Edit 会原地修改 prose message，同时保留 usage、UUID 和 resume chain。([GitHub](https://github.com/jajanet/llm-lens))

不过项目目前还比较新，大约只有 **6 Stars、28 commits**，作者自己也标注为 Alpha，所以我会把它理解成：

> 设计思路非常正确，但还不能把它当成熟基础设施。

------

## 2. Codex：`outx-sec/coldxx` 几乎就是你描述的工具

这个是这轮搜索最大的发现。

[GitHub：outx-sec/coldxx](https://github.com/outx-sec/coldxx?utm_source=chatgpt.com)

它直接读取：

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

而且提供一个本地 Web UI：

```bash
npm install -g coldxx

coldxx ui
```

然后你可以在 UI 中：

```text
Session
 └── Turn
      ├── User
      ├── Assistant
      ├── Reasoning
      ├── Tool calls
      └── Raw JSONL
```

最重要的是，它真的支持：

**直接编辑一个 Turn 的 User Input：**

```text
User
[ Edit ]
```

以及：

**直接编辑 Assistant Output：**

```text
Assistant
[ Edit ]
```

还可以直接打开某条底层 JSON：

```json
{
  "timestamp": "...",
  "type": "response_item",
  "payload": {
    ...
  }
}
```

修改并保存。([GitHub](https://github.com/outx-sec/coldxx))

甚至有：

```text
Rollback to this Turn
```

本质上就是：

```text
Turn 1
Turn 2
Turn 3
Turn 4
Turn 5
        ↓
Rollback Turn 3
        ↓
Turn 1
Turn 2
Turn 3
```

把 Turn 3 后面的 JSONL records 全删掉，再让你：

```bash
codex resume <session-id>
```

继续。

它还有一个设计我很喜欢：**最近 10 分钟仍发生写入的 session 默认拒绝修改**，避免 Codex 和 editor 同时改一个 JSONL；修改、drop、UI save 都会自动创建 backup。CLI 还支持 `--dry-run`。([GitHub](https://github.com/outx-sec/coldxx))

例如：

```bash
coldxx edit latest \
  --replace "old text" \
  --with "new text" \
  --scope user \
  --dry-run
```

确认之后：

```bash
coldxx edit latest \
  --replace "old text" \
  --with "new text" \
  --scope user \
  --yes
```

甚至：

```bash
coldxx drop latest --lines 12-18 --yes
```

直接删除 JSONL 记录。([GitHub](https://github.com/outx-sec/coldxx))

**就你现在的需求，我会直接把 coldxx 排在 Codex 第一名。**

------

## 3. Claude Code：`didvc/claude-code-jsonl-editor`

这个是更加传统的：

> 把 Claude Code JSONL 显示成 ChatGPT 风格，然后直接编辑。

[GitHub：didvc/claude-code-jsonl-editor](https://github.com/didvc/claude-code-jsonl-editor?utm_source=chatgpt.com)

功能非常直白：

```text
User
┌─────────────────────────────┐
│ prompt                      │
└─────────────────────────────┘
              Edit  Copy Delete

Assistant
┌─────────────────────────────┐
│ response                    │
└─────────────────────────────┘
              Edit  Copy Delete
```

支持：

- inline Edit
- Copy
- Delete
- 多 JSONL 文件
- 自动 backup
- 实时写回文件
- 浏览器 UI
- LAN 暴露

README 本身就是把“修改历史 Response 后继续 conversation”当作核心用途。([GitHub](https://github.com/didvc/claude-code-jsonl-editor/blob/main/README.md))

但是我发现了一个值得警惕的问题：

**它 README 的安装地址写错了。**

实际仓库是：

```text
didvc/claude-code-jsonl-editor
```

但是 README 给出的：

```bash
curl ... raw.githubusercontent.com/anthropics/claude-code-jsonl-editor/...
```

以及：

```bash
git clone https://github.com/anthropics/claude-code-jsonl-editor.git
```

我实际检查了这个 `anthropics/claude-code-jsonl-editor` 地址，目前是 **404**。([GitHub](https://github.com/didvc/claude-code-jsonl-editor/blob/main/README.md))

因此如果你要试，**不要直接复制 README 那个 curl 命令**。应该从真正的 `didvc` 仓库 clone 后检查源码再运行。

这也让我更偏向 `llm-lens`。

因为 didvc 更像：

```text
JSONL
 ↓
解析成 UI
 ↓
直接改 JSON
 ↓
保存
```

而 llm-lens 更像：

```text
Claude transcript graph
 ↓
识别 message/tool/parentUuid
 ↓
执行 conversation-aware mutation
 ↓
修复 chain
 ↓
保存
```

后者更符合 Claude Code 的真实存储模型。

------

## 4. Codex：`citizenll/csm`

这个也非常值得研究，但定位稍微不同。

[GitHub：citizenll/csm](https://github.com/citizenll/csm?utm_source=chatgpt.com)

它不像 coldxx 那么强调：

> “我要修改第 17 条 Assistant message。”

它更偏：

```text
Inspect
Repair
Fork
Compact
Migrate
Distill
Resume
```

但是源码里面确实存在：

```text
src/rollout_edit.rs
```

README 直接把它称为：

> JSONL surgery

并且它尽量复用 Codex 自身的 Rust 内部逻辑，例如：

```text
ThreadManager::fork_thread
Op::Compact
```

而不是自己随意造一个 rollout 文件。([GitHub](https://github.com/citizenll/csm))

这一点其实非常重要。

如果你的最终目标不是：

> “单纯把一句话从 AAA 改成 BBB”

而是：

> “在历史的某一点切断，把污染 context 删除，再产生一个合法的新 session。”

那么 CSM 的设计甚至可能**比直接改 JSONL 更合理**。

------

## 5. `fengchenzxc/Codex-Session-Manager`

[GitHub：fengchenzxc/Codex-Session-Manager](https://github.com/fengchenzxc/Codex-Session-Manager?utm_source=chatgpt.com)

这是一个 Tauri 桌面 GUI。

它会同时理解：

```text
~/.codex/state_5.sqlite
~/.codex/session_index.jsonl
~/.codex/sessions/.../rollout.jsonl
~/.codex/archived_sessions/
Codex app-server
```

这点比普通 JSONL Viewer 高一个层次。

它可以：

```text
Clone Session
Migrate Provider
Repair Session
Backup
Restore
Resume
```

而且真正写之前：

```text
Dry Run
 ↓
生成修改计划
 ↓
Backup
 ↓
确认 Codex 没在运行
 ↓
Apply
```

安全设计很好。([GitHub](https://github.com/fengchenzxc/Codex-Session-Manager/blob/main/README.en.md))

但它目前**不提供普通 user/assistant message 的逐条自由编辑**。

所以它不是你第一选择。

------

## 6. `bimcc/codex-session-man`

[GitHub：bimcc/codex-session-man](https://github.com/bimcc/codex-session-man?utm_source=chatgpt.com)

这是 VS Code Extension。

主要解决：

```text
Codex Session
├── provider
├── session_index
├── state_5.sqlite
├── rollout JSONL
└── resume
```

支持修改 provider，并同步：

```text
JSONL
+
SQLite
```

还支持 stuck session repair。([GitHub](https://github.com/bimcc/codex-session-man?utm_source=chatgpt.com))

但仍然不是逐消息编辑器，所以更多作为 **Codex session maintenance tool**。

------

### 一个很重要的技术区别

现在我更确定，你之前那个需求不能简单理解成：

```text
打开 JSONL
↓
找到文字
↓
Ctrl+H Replace
```

特别是 Claude Code。

Claude transcript 实际上具有：

```text
uuid
   ↑
parentUuid
   ↑
uuid
   ↑
parentUuid
```

同时存在：

```text
tool_use
      ↕
tool_result

subagent
sidechain
summary
file-history-snapshot
compact boundary
```

Claude Code 自己的恢复逻辑甚至专门有“删除中间消息之后重新连接 `parentUuid`”的处理。这也是为什么普通 JSON 编辑器虽然**能改文件**，却不等于**能正确编辑会话**。相关的 Claude Code 存储分析也显示，其 transcript 是 append-only event log，resume 时会重建消息链。([GitHub](https://github.com/liuup/claude-code-analysis/blob/main/analysis/04i-session-storage-resume.md?utm_source=chatgpt.com))

Codex 也是类似。Codex 官方源码把 rollout 定义为可 replay 的 canonical JSONL，而且现在还存在 `state_5.sqlite`、session index、rollout metadata 等多个状态层。([GitHub](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs?utm_source=chatgpt.com))

另外，Codex Desktop 直到 2026 年仍有人专门提 Feature Request，希望可以**编辑任意以前的消息**；目前原生 UI 并没有完整提供这种能力。([GitHub](https://github.com/openai/codex/issues/18708?utm_source=chatgpt.com))

所以如果你真正想实现：

```text
找到一条错误历史消息
        ↓
删除 / 修改
        ↓
去掉受到污染的后续 Turn
        ↓
继续原来的 Claude/Codex session
```

我的选择已经很明确了：

```text
Claude Code
    ↓
jajanet/llm-lens
    ↓
didvc/claude-code-jsonl-editor（更简单，但风险稍高）


Codex
    ↓
outx-sec/coldxx          ← 最符合你的要求
    ↓
citizenll/csm            ← 更适合 fork / repair / compact
    ↓
Codex-Session-Manager    ← 管理和修复
```

其中 **`llm-lens + coldxx` 基本就是目前我找到的一对最接近“Claude Code / Codex 历史会话可视化编辑器”的组合**。它们现在 Stars 都很少，不代表功能方向不对，更像是这个需求本身直到 2026 年才开始逐渐形成一个独立工具类别。([GitHub](https://github.com/jajanet/llm-lens))

如果你愿意，我下一步可以继续专门沿着这个方向再挖一轮：**GitHub Code Search，不搜项目名字，而是直接搜索 `~/.claude/projects`、`parentUuid`、`~/.codex/sessions`、`rollout-` + `write/edit/delete` 的源码**。这种方法很可能还能抓到一些 README 根本没写“session editor”、但实际上已经具有历史消息 surgery 功能的冷门项目。



可以，下面只列 GitHub 原始链接，方便你直接复制。

Claude Code：

```text
https://github.com/jajanet/llm-lens

https://github.com/didvc/claude-code-jsonl-editor
```

Codex：

```text
https://github.com/outx-sec/coldxx

https://github.com/citizenll/csm

https://github.com/fengchenzxc/Codex-Session-Manager

https://github.com/bimcc/codex-session-man
```

其中我最建议你优先看这两个：

```text
https://github.com/jajanet/llm-lens
https://github.com/outx-sec/coldxx
```

前者针对 **Claude Code 历史会话直接编辑**，后者针对 **Codex session JSONL 的查看、编辑、回滚和修复**。([GitHub](https://github.com/jajanet/llm-lens?utm_source=chatgpt.com))