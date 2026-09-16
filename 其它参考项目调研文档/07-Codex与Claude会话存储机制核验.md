# Codex 与 Claude 会话存储机制核验

核验日期：2026-09-14。作者：主 Agent。

> 第二轮补充：已进一步核验 SQLite 分页投影和官方共享 writer lock，见下文及 [09-第二份参考资料核验与选型修订](09-第二份参考资料核验与选型修订.md)。

## 结论先行

**修改 JSONL 中能看见的文字，不一定改变下一次模型请求中的历史。** 对本项目最重要的四个事实是：

1. Codex 的有效历史需要重放 `response_item`、压缩记录、回退记录及其他有语义的记录；不是把所有行的文字拼起来。
2. 后续压缩检查点可能替代之前的原始记录。只改压缩前旧行，可能只改变审计视图。
3. 本次 Codex 官方快照还有 `legacy/paginated`、共享历史前缀和压缩 rollout；不能假定一个 session 就是一份独立、可随意重写的 JSONL。
4. Claude 官方文档确认了持久化、读取、resume、fork 和自定义存储接口，但没有为我们提供一个与 OpenCode `part.update` 等价的、任意改写旧正文并维护所有不变量的稳定接口。

本轮为**官方源码/文档核验，不是真实客户端 resume 或模型请求实测**。

## 1. 证据范围

| 来源 | 版本/身份 | 本文如何使用 |
|---|---|---|
| `参考项目/codex/` | 官方 `openai/codex`，commit `d76109773497850ed2699f2816e3f7b1867d0c14` | 核对持久化、恢复、协议及共享前缀实现 |
| Claude Agent SDK 官方文档 | 2026-09-14 查询到的文档 | 证明公开 API 契约；不冒充已安装 CLI 的完整实现 |
| `参考项目/claude-code-analysis/` | 第三方 commit `7b7b915d7da804088a8152ed24c68e3da2d1110e` | 仅把 README 和存储分析作为待核验线索 |
| 六份候选报告 | 根目录 `01`—`06` | 与官方机制对照，不重复宣称其测试由主 Agent执行 |

官方 Codex **main 的源码快照不等于用户安装的 release**。下面提到的新机制，需要通过实际客户端版本、feature 和会话元数据判断是否启用。

## 2. Codex：原始日志如何变成有效历史

### 2.1 普通日志读取与错误容忍

`RolloutRecorder::load_rollout_items` 逐行解码，跳过空行，统计并跳过部分解析错误；第一个 `SessionMeta` 决定线程身份。`get_rollout_history` 再构造 `InitialHistory::Resumed`。[C1]

这给编辑器两个提醒：

- 官方能够容忍部分坏行，不代表编辑器可以在一次保存中把那些原始行永久删掉。
- 能读出会话 ID、甚至进入恢复流程，也不证明所有记录都被正确使用。

### 2.2 正文与展示事件不能混为同一层

核心方法是 `Session::reconstruct_history_from_rollout`。[C2]

- 正向重放将 `RolloutItem::ResponseItem` 送入 `ContextManager::record_annotated_items`。
- `InterAgentCommunication` 也可被转换为模型输入，不能把“只有 response_item 有意义”作为永久规则。
- 普通 `EventMsg` 在该正向正文阶段被跳过；但 `ThreadRolledBack` 会删除有效历史中的末尾用户轮，反向扫描还使用 UserMessage/TurnStarted 等确定边界和元数据。

因此，在这条已核对的路径中，**只改 `event_msg.user_message` 或 `agent_message` 的展示文字，不能代替修改相应模型历史项**。coldxx 对多重表示做同步是有价值的，但它按同一 turn 内的“角色 + 相同文本”归组，仍需更可靠的来源关联。

这里核验的是模型 history 的重建；最终请求还可能加入系统提示、工具定义等内容，不能把这个 history 当成完整网络请求。

### 2.3 压缩后的编辑盲区

恢复代码从后向前寻找仍然有效的压缩检查点，使用 `replacement_history` 建立基线，再重放其后仍有效的日志；遇到 rollback 还会修正哪些检查点和轮次存活。[C2]

官方测试 `reconstruct_history_uses_replacement_history_verbatim` 明确断言：重建结果等于保存的 replacement history。本轮阅读了测试，**没有执行该 Rust 测试**。[C3]

例如，原始记录是：

```text
旧消息：主题颜色选蓝色
后续 compact：摘要记录“主题颜色选蓝色”
之后的正常消息……
```

只把第一行改成“绿色”，并不自动重算后面的摘要。新编辑器应标明该消息属于当前有效窗口、历史审计记录还是压缩基线中的副本；不能在仍采用旧摘要时提示“后续模型一定会看到新内容”。

对于已压缩的消息，第一版宜完整展示并明确限制写入范围；日后若支持修改有效快照，应采用独立的变更计划与验证，不自动删除 compact 记录或自动重跑摘要。

## 3. 新版 Codex：session 不再等于单一独立文件

### 3.1 legacy 与 paginated

`ThreadHistoryMode` 在此快照中是 **`Legacy` 与 `Paginated`**，默认枚举值为 Legacy；不能把它误写成“JSONL 与 SQLite 两种正文存储模式”。[C4]

App-server 对 paginated thread 调用 `thread_store.load_latest_model_context`。本地实现仍从当前 rollout 及其 lineage 反向扫描，在可用的压缩检查点处截取重放范围，并能处理压缩文件。[C5]

`state_5.sqlite` 仍然存在，源码同时声明 `thread_history_1.sqlite` 等辅助数据库。[C6] **发现数据库文件不等于证明模型正文从该数据库读取**；本文实际核验到的 model-context 路径扫描的是 rollout lineage。索引、投影与正文的更新责任需分别验证。

第二轮已补上投影职责的源码核验：`thread_history` 中的 items/turns/checkpoint 是分页历史投影，物化流程从保存的 byte offset 增量读取 rollout。改动已投影的旧前缀不会自动等价于重新物化，等长改动尤其可能保留旧 UI 内容。因此正文写入还需要版本化 projection 失效/重建方案；它与 model-context 从 lineage 重放的路径并不冲突。[投影代码](https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/thread-store/src/local/thread_history.rs#L49-L286)、[增量物化](https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/thread-store/src/local/thread_history_materialization.rs#L35-L122)。

同时不能把清三张表固化为永久契约：当前官方清理路径还包含 `thread_realtime_items`；共享前缀、压缩快照及活动内存会话也不会因此自动修复。

### 3.2 共享前缀与字节偏移

`SessionMeta.history_base` 引用另一份 rollout 的历史前缀，包含：

- 被引用的 rollout ID；
- 结束 ordinal；
- `end_byte_offset`。

注释还明确：revert 后物理 rollout ID 可能与稳定 thread ID 不同。[C7] `RolloutReferenceIndex` 专门扫描活动/归档文件，统计其他 rollout 对某份历史的引用。[C8]

由此得出的编辑风险：

1. 修改一份被 fork 引用的前缀，可能影响别的会话，而不是只改当前窗口中的一条消息。
2. 文本长度或 JSON 序列化改变，可能使已保存的字节边界失效。
3. “原 filename 中的 ID 永远等于 session ID”“复制一个 JSONL 就复制了全部会话”都不能作为通用假设。

这是六个候选之外，由主 Agent 核验出的重要补充。**初版写入不能直接覆盖 paginated、共享前缀或压缩 rollout；应先完成这些格式的专用适配。** 即使目标文件本身没有 `history_base`，也需考虑它是否被其他文件引用。

## 4. 官方 API 能否替代文件编辑

| API/能力 | 已核对的含义 | 是否等价于本项目目标 |
|---|---|---|
| `thread/read`、turn/item 分页读取 | 浏览持久化历史/投影 | 可辅助读取，不是正文改写 |
| `thread/inject_items` | 追加原始 Responses items，不启动用户 turn | 追加不是替换旧消息 |
| `thread/revert` | 将 paginated 历史替换为某 turn **之前**的前缀 | 排除该 turn 及其后全部内容，不满足保留后续 |
| `thread/fork` | 产生分支 | 不等于保留原 session 身份原地修改 |
| `thread/resume` 的 `history` | 实验性参数；源码将其包装为 `InitialHistory::Forked` | 不能当成原 session 的稳定历史覆盖接口 |

依据：协议注册及类型定义、实际 handler。[C9][C10]

`thread/resume.history` 明确标注 `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE`；对非运行中线程，它还会使 `thread_id` 被忽略。不能因为能传一个历史数组，就宣称获得了官方“任意历史编辑 API”。[C10]

本次核对未发现一个稳定公开的“按旧消息 ID 改 user/assistant 正文，并保持全部后继不变”的操作。这个结论限定于已核对的公开协议，不外推到未来版本。

### 已加载的线程不会因磁盘改动自动刷新

`thread_resume_inner` 会优先尝试重新接入运行中的线程，并可能直接返回；只有冷恢复才进入持久化历史加载。[C11]

因此，停止生成不总等于卸载内存会话。文件编辑之后必须验证冷恢复，而不是只重新打开一个仍复用原内存状态的 UI。文件改名替换的“原子性”也不能让持有旧文件句柄的写入者自动切换到新文件。

## 5. Claude Code：官方能确认的范围

官方 Agent SDK 文档提供：

- `listSessions`、`getSessionMessages`：发现和读取会话；[A1]
- `resume`：继续已有会话；`forkSession`：以新身份分支；[A2]
- `SessionStore.append/load`：外部存储的追加与恢复；还可选实现 session 删除、子路径枚举等。[A3]

这些文档支持“持久化记录参与恢复”的结论，但**没有提供任意替换已有正文、自动维护 parent/tool/compaction 的稳定事务接口**。删除整个 session 或 fork 也不能替代逐消息编辑。

若使用自定义 SessionStore，恢复前会调用 `load`，subagent 还可能依赖 `listSubkeys`。因此“只扫描并改 `~/.claude/projects`”不能自动覆盖使用外部存储的 SDK 应用。[A3]

### 第三方 Claude 分析的证据等级

`claude-code-analysis` 的 README 自称基于 2026-03-31 source map 泄露进行静态分析，并非 Claude 官方开源 SDK 实现。本轮只读其 README 与存储分析文档，没有展开其 `src.zip` 或复用其中源码。[A4]

它关于 `uuid/parentUuid`、主链/sidechain、compact boundary、progress 修复的描述，适合指导测试样例，但不能直接当作当前安装版本的官方契约。没有明确许可的源码也不应直接搬入新产品。

Claude adapter 应保留原始记录与内容块，按版本处理同 UUID 的更新/去重，不能一律取第一条、把所有相同 UUID 一起改，或把所有数组 content 压成字符串。

## 6. 对新项目的最低正确性要求

1. **区分原始日志、展示投影和有效上下文。** 每个可编辑块带来源文件、原始版本和 JSON 路径，不靠扁平字符串猜写入位置。
2. **先探测能力再启用写入。** 检测引擎/CLI 元数据、history mode、压缩、共享引用、未知类型、有效压缩窗口。
3. **保证改动边界。** 修改正文不隐式删除 thinking、image、tool；保留后续记录，也保留实际生成时的 usage 等元数据。
4. **写入可靠性单独实现。** 备份、同目录临时文件、权限、fsync、版本复查和可恢复日志都要覆盖实际 mutation 路径。
5. **不夸大并发保护。** 本工具的私有锁不能约束不遵守该锁的官方客户端；hash 复查到 rename 之间也不是跨进程原子 CAS。第二轮确认当前 Codex 有 `thread-writer-locks` 及 `.coordination.lock` 协议，应优先评估与指定版本/平台真实兼容的协调实现，而不是断言第三方永远无法协调。[官方锁实现](https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/rollout/src/writer_lock.rs#L17-L195)
6. **按操作更新派生数据。** 不是每次改正文都应触碰全部 SQLite/index/global 文件。必要的跨层变更要有明确计划和失败补偿。

## 7. 后续隔离验证矩阵（方案，尚未执行）

| 层级 | 验收内容 | 不能替代什么 |
|---|---|---|
| L1 展示 | 完整记录/内容块能呈现、正确定位 | 不能证明保存成功 |
| L2 写回 | 唯一目标字段变化，后续与未知记录保留，备份可还原，结构校验通过 | 不能证明官方冷恢复接受 |
| L3 冷恢复 | 固定客户端版本从隔离持久化记录重新加载成功 | 不能证明发出的请求用了新正文 |
| L4 请求核验 | 用本地 mock transport 捕获下一次请求，确认有效窗口包含新内容且旧副本没有误入 | 只能证明发送内容，不能保证模型必然按预期回答 |

用合成数据覆盖：普通 user/assistant、多文本块、混合工具/思考/图片、同文但不同逻辑消息、重复 UUID、坏尾行、compact 前后、rollback、共享 fork、压缩 rollout、并发追加和失败恢复。先做无真实模型调用的解析、写回及传输桩验证，再建立具体版本兼容矩阵。

## 来源

[C1]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/rollout/src/recorder.rs#L1069-L1149
[C2]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/core/src/session/rollout_reconstruction.rs#L134-L423
[C3]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/core/src/session/tests.rs#L2129-L2184
[C4]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/protocol/src/protocol.rs#L775-L803
[C5]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/thread-store/src/local/model_context.rs#L27-L79
[C6]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/state/src/sqlite.rs#L29-L34
[C7]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/protocol/src/protocol.rs#L3040-L3125
[C8]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/rollout/src/rollout_reference_index.rs#L19-L164
[C9]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/app-server-protocol/src/protocol/common.rs#L756-L869
[C10]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/app-server/src/request_processors/thread_processor.rs#L4470-L4519
[C11]: https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/app-server/src/request_processors/thread_processor.rs#L3561-L3608
[A1]: https://code.claude.com/docs/en/agent-sdk/typescript
[A2]: https://code.claude.com/docs/en/agent-sdk/sessions
[A3]: https://code.claude.com/docs/en/agent-sdk/session-storage
[A4]: https://github.com/liuup/claude-code-analysis/blob/7b7b915d7da804088a8152ed24c68e3da2d1110e/README.md#L3-L21

补充协议定义：[resume 的不稳定 history 参数](https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L330-L365)、[revert 的前缀语义](https://github.com/openai/codex/blob/d76109773497850ed2699f2816e3f7b1867d0c14/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1244-L1273)。
