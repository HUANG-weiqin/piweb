# 消息直通极简设计（对抗攻击靶子）

`created: 2026-08-08`

## 目标语义（产品需求，用户原话）

1. 用户消息与 Agent 是否忙**无关**，随时可以发。
2. **发出就等于进入对话消息**：消息是对话的一部分（立即在对话流中可见），不是"队列项"。
3. Agent 在**下一次尽快可读**的时候读到；如果结构里有消息，**一次性全部读到**（FIFO 顺序）。
4. 移除目前的复杂机制：三态状态机（queued/dispatching/attention）、撤回（withdraw）、移除记录（dismiss）、Steer、batch steer、**batch guidance 信封**（"以下消息属于同一批，请作为整体处理"的 JSON 信封，宿主机制泄漏进模型上下文，用户明确列为蛋疼）、"待处理消息"卡片 UI、容量预算与 payload 校验链。

## SDK 事实（已从源码确认，v0.80.7）

- `prompt(text, {streamingBehavior})`：非 streaming 时 = 写 user entry + 启动 run（promise 在整 run 结束后 resolve）；streaming 时**必须**给 streamingBehavior，`"followUp"` 进内存 followUp 队列。
- `session.followUp(text)` / `agent.followUp(msg)`：消息进 **Agent core 内存队列**（`followUpQueue`），不写 JSONL。
- runLoop 外层循环：Agent 将要停止时 poll `getFollowUpMessages()`，**全部**设为 pending 继续处理（"忙完自动一次性全读"是 SDK 原生行为）；`_handlePostAgentRun` 的 `while (agent.hasQueuedMessages()) agent.continue()` 也会 drain 队列。
- 队列消息投递时才 emit `message_start/message_end`，session 层在 `message_end` 时 `sessionManager.appendMessage()` 持久化到 JSONL。**进程重启 = 队列丢失（已接受未投递的消息消失）**。
- `sendUserMessage(content, {deliverAs})` = `prompt(text, {expandPromptTemplates:false, streamingBehavior})`。
- `sendCustomMessage(msg, {triggerTurn:true})`（非 streaming）→ `_runAgentPrompt(msg)` 触发 run；`triggerTurn` 语义是"append + starts new turn"。inbox 的 `startMessages` 就是走这条路径（custom entry + 最后一条 triggerTurn）。
- `agent.continue()`（agent core 公开 API）：最后一条消息是 user/toolResult 时 `runAgentLoopContinue`，**不新增消息**、用整个现有上下文跑；注释："Used for retries - context already has user message or tool results"。SDK 内部用它 drain 队列。
- `agent.prompt(input)` 的 input 可以是**消息数组**（`normalizePromptInput`：Array.isArray → 原样返回）：`runAgentLoop` 对每条初始消息 emit `message_start/message_end`，一次 run 处理全部（多条 user 消息 → 一次 assistant 回复）。`session.prompt` 只接受单条 text。
- `prompt()` 的完整语义：extension command 处理 → input hook → skill/template 展开 → auth/模型校验 → compaction 检查 → `before_agent_start` hook → `preflightResult` 回执。
- 项目已有"宿主改 `agent.state.messages` 重建上下文"先例：truncate 后 `this.session.agent.state.messages = this.sessionManager.buildSessionContext().messages`。
- 宿主拥有 writer lease；当前 busy 时宿主不能动 `agent.state.messages`（SDK 正在使用）。

## 候选方案

### 方案 A：SDK followUp 原语（最简）
- 发送 = `session.prompt(text, {streamingBehavior:"followUp"})`（busy）/ `session.prompt(text)`（idle），一个入口。
- SDK 忙完自动 drain 队列，一次性处理全部。
- UI 乐观投影"等待中"消息到对话流；投递时（message_start 匹配）替换为真实消息。
- **缺口**：未投递消息在内存，服务重启丢失；回执语义要重新定义（接受 = 进队列）。
- 删除面最大：pending-prompts 文件、状态机、全部队列命令、卡片 UI。

### 方案 B：宿主写 user entry + `agent.continue()` 触发
- 发送（任何状态）= 宿主把 user entry 原子写入 JSONL（durable，"发出即进入对话"字面成立）→ 对话快照/增量自然投影。
- run 结束后 pump：检测"最后一条 user entry 未被消费"→ `setSessionFile` 重建 + `state.messages = buildSessionContext().messages` → `agent.continue()`。
- **缺口**：`continue()` 跳过 prompt 的完整语义（无 template/skill 展开、无 input hook、无 auth 校验、无 compaction 检查、无 before_agent_start）；依赖 agent core 内部语义（"最后一条是 user"的假设）；`state.messages` 替换与 SDK 持久化的交互需验证。

### 方案 C：保留 durable 队列文件但极简（现状骨架）
- 保留 `.piweb/pending-prompts` FIFO 队列文件（砍到只有 queued 一态 + promptId/text/createdAt）。
- busy 发送 → 入队（durable）+ 投影"等待中"消息到对话流；idle pump → 逐条 `startPrompt`（SDK 写 entry + run）。
- **缺口**：仍有"队列文件"这个第二存储；"一次性全部读到"需要 batch 机制或连续 run；投影消息 → 真实消息的替换语义。

### 方案 D：busy 消息用 custom entry + `sendCustomMessage(triggerTurn)`
- 复用 inbox/`startMessages` 的成熟公开路径（custom entry + triggerTurn 触发 run）。
- **缺口**：消息 role 是 custom 而非 user（模型上下文、历史兼容）；对话里多一条 custom entry 的投影与语义。

## 不变的硬边界（攻击时不可突破）

1. **防丢**：用户已确认发送的消息不能因服务重启而消失（"发出即进入对话"暗示 durable 落点）。
2. **精确回执**：清空草稿必须发生在服务端确认后；断线时草稿保留，恢复后与对话核对，禁止自动重发。
3. **busy 边界**：当前 run 进行中宿主不得修改 `agent.state.messages`。
4. **writer lease**、身份过滤（sessionId/focusId/runId/promptId）、fail closed 原则。
5. 浏览器不是 transcript owner；恢复必须从服务端 snapshot hydrate。
6. 消息投递证明：只能凭 JSONL 中 exact `promptId + runId` delivery receipt；run settlement 本身不是交付证明。

## 需要裁决的问题（攻击重点）

1. **durable 落点**：JSONL（B/D）还是队列文件（C）还是放弃（A）？"发出即进入对话"与 SDK 投递后写入的矛盾怎么解？
2. **触发原语**：followUp 队列 / continue() / sendCustomMessage triggerTurn / 逐条 prompt，哪个在"忙完自动一次性全读 + 不重复写入"下成立？
3. **投影语义**：busy 时"等待中"占位消息在对话流中的投影，与投递后真实消息如何替换；断线重连恢复后如何保持一致（服务端 vs 客户端合成）。
4. **一次性全读**：多条排队消息是一个 run（batch）还是多个 run？与"每条消息独立 user entry"的对话历史如何相容？
5. **迁移**：删除现有队列文件/命令/UI 后，存量队列、协议版本、测试的处置；extension/meta-tools/inbox 与新路径的交互。

---

# 执行共识（2026-08-08 终稿：方案 A'，用户拍板）

三路智囊团两轮对抗 + 落盘实证实验 + 用户决策后定稿。**用户选择方案 A'：纯 SDK followUp，接受"重启丢未投递消息"。**

## 产品语义（最终）

- 用户消息与 Agent 是否忙无关，随时可发；busy 时消息显示为对话流中的"等待中"项，SDK 投递后成为真实 user entry。
- Agent 忙完自动读取（SDK followUp 队列 drain，无需宿主 pump/rebuild/触发），`followUpMode="all"` 保证排队消息一次性全部读取。
- 未投递消息仅存于内存：进程重启/abort 时消失——**这是用户明确接受的代价**（UI 诚实显示"等待中"而非"已发送"）。

## 发送路径

- wire 统一 prompt 命令（删 enqueue_prompt 等五命令）。
- idle：`session.prompt(text, { preflightResult })`（现状不变，SDK 写 entry + run）。
- busy：`session.prompt(text, { streamingBehavior: "followUp", preflightResult })`——promise 立即 resolve（仅已接受进队列），run 结束 SDK 自动 drain，消息由 SDK 写入 JSONL。
- followUpMode="all"：会话创建前 `settingsManager.applyOverrides({ followUpMode: "all" })`（已确认 applyOverrides 是内存 deepMerge，不写 settings.json，不污染用户设置）。

## 服务端 admitted 跟踪（内存，per-actor）

- FIFO 列表 {promptId, text, createdAt}；SDK 投递时按 FIFO 匹配（SDK 用文本移除队列），移除并发 delivered 事件。
- 断线重连：conversation_snapshot 附 admitted 项（服务端投影，多窗口一致；浏览器不保存）。
- 服务重启：admitted 消失（接受项）。

## abort 语义

abort 时清空 followUp 队列（与现状 clearQueue 一致，conversation-actor.ts:1611-1618），等待中消息消失并通知 UI（停止 = 取消未投递）。

## 删除面

- project-prompt-queue.ts（966 行）、pending-prompt-batch-guidance.ts、三态状态机、容量预留链。
- 协议五命令 + pending_prompts_snapshot + PendingPrompt 类型；PROTOCOL_VERSION 29→30 同批发布。
- coordinator 的 pumpPendingPrompt 及相关 fence 检查（替换为"无 admitted 消息"检查）；Chat 队列卡片/撤回/Steer/移除按钮；App PendingQueueCommand 回执链。

## 保留面

- prompt/abort+runId/conversation_snapshot/run_queued/run_finished/live projection；actor 内部 steer（extension UI 回答）；inbox（startMessages/custom 路径）与 inbox 优先级；writer lease、busy 边界、fail closed、slash command 拒绝。
- 简单容量防护：单条 MAX_PROMPT_CHARACTERS + followUp 队列长度上限（防内存打爆，~10 行）。

## 迁移

- 存量 .piweb/pending-prompts：启动时一次性迁移——queued 按 FIFO 重新投递后删文件；dispatching/attention 无 receipt 记录直接丢弃（A' 语义）。
- 协议 v30 与客户端同批发布，禁止新旧混跑。

## 实施顺序（每步可验证）

1. SDK 行为测试（vitest + verify 脚本扩展）：busy followUp 的 promise resolve 时机、queue_update 事件、投递时序与文本匹配、abort 清队列、followUpMode="all" 的 drain 行为。
2. 服务端：actor busy 分支 + admitted 跟踪 + delivered 事件 + abort 清队列。
3. 协议 v30：删五命令 + snapshot 事件；snapshot/增量带 admitted 项。
4. 客户端：删卡片/按钮/回执链；等待中消息投影与替换。
5. 存量迁移 + 删旧实现/旧测试。
6. 知识页与 AGENTS.md 硬边界条款更新（pending prompt 相关约 10 条改写为新语义）。

## 验证清单

- busy 发消息 → 等待中 → run 结束自动投递（多条一次性）→ 真实消息。
- 断线重连等待中消息仍在（snapshot）；abort 后消失；服务重启未投递消失（接受）。
- idle 发送不受影响；extension UI steer、inbox、meta-tools 回归。
- 存量队列迁移正确。

## 残余风险（接受项）

- 重启/abort 丢未投递消息（用户拍板）。
- SDK 文本匹配投递歧义：相同文本按 FIFO 匹配，基本可靠。
- followUpMode="all" 需实施时验证与项目 SettingsManager 的兼容（applyOverrides 已确认内存态）。

## 产品语义最终定义

- 用户消息与 Agent 是否忙无关，随时可发；发出 = 服务端 durable admission（消息立即作为 server-owned 对话项出现在对话流，带 deliveryState）。
- **"发出即进入对话"定义为"服务端 admitted conversation item"，不是"物理 Pi JSONL user 行立即存在"**——v0.80.7 下两者不相等，硬物化需要 SDK 新原语（见下）。
- Agent 在下一次可读时按 FIFO 尽快读取全部已 admit 消息；UI 不再有队列卡片、撤回、Steer、batch guidance。

## 架构裁决（三方一致 + 主持定案）

- **A 否决**：followUp 是内存队列，preflight(true)≠commit（agent-session.js:812-823），abort 的 clearQueue() 合法丢已接受消息（conversation-actor.ts:1611-1618），默认 one-at-a-time 非 all（settings-manager.js:470-472）。
- **B 否决（当前版本）**：busy 写 JSONL 与 SDK 树分叉（leaf sibling、buildSessionContext 沿 parent 链）；裸 agent.continue() 无 actor ticket 会被 outside-workbench abort（conversation-actor.ts:1680-1690）、不 emit 已有 user（agent-loop.js:57-69）、跳过 prompt 全套语义。真正可落地需不存在的 SDK 原语（quiesce/adopt+receipt）。
- **D 仅保留 inbox/meta-tools**：sendCustomMessage 的 triggerTurn 在 busy 时无效（isStreaming 分支直接进内存队列），custom 投影不是 user。
- **定案：C' = durable admission ledger（内部保留、改名、隐藏状态）+ 统一 send_message 协议 + 服务端 transcript projection（同一 item 的 deliveryState）+ idle 后标准 startPrompt 投递 + followUp 仅作非权威同进程快路（可选，receipt 前不清 ledger）。**
- **"一次性全部读到"**：主线 = pump 连续 FIFO 处理全部（每条一个 run，Agent 忙完连续处理所有已 admit 消息，无用户操作打断）；batch adapter（N 条 user entry 一次 assistant，需要先做 prompt(array) 实验验证）列为可选增强，不阻塞主线。

## 删除面（暴露层，用户要的"奇葩"）

- 五个命令：enqueue_prompt / steer_pending_prompt / steer_all_pending_prompts / withdraw_pending_prompt / dismiss_pending_prompt；统一为 send_message（commandId+sessionId+conversationId+focusId+promptId+text）。
- pending_prompts_snapshot 事件、PendingPrompt 三态类型、queued/dispatching/attention UI 语义。
- batch guidance JSON 信封（createPendingPromptBatchGuidance/parsePendingPromptBatchGuidance/steerPendingPromptBatch）——宿主机制不再进入模型上下文；但 durable batch fence 控制面身份在内部保留。
- Chat prompt-queue 卡片与撤回/Steer/移除记录按钮；App 的 PendingQueueCommand 复杂回执链（保留简化 admission ack）。

## 保留面（内部正确性，防丢成本，不暴露 UI）

- durable ledger（可改名 admitted-message ledger，格式可简化）：immutable payload + promptId/messageId + createdAt + FIFO + 容量上限。
- exact promptId+runId delivery receipt（JSONL user entry 物证）对账；run settlement 不是 delivery proof。
- admitted/uncertain 恢复语义（内部）；writer lease、busy 边界、fail closed；inbox 优先级（pumpTarget 先 inbox 后 prompt）。
- conversation_snapshot / run_queued / session_event / abort+runId / focus 身份体系；promptId 保留为 immutable client intent。

## 协议变化

- PROTOCOL_VERSION 29→30，与客户端同批发布，禁止新旧混跑；4002 只用于投影/schema/size 非法。
- 新增：send_message 命令；admission ack（command_complete 补 conversationId/focusId/promptId/messageId）；conversation item/snapshot 上 admitted item（deliveryState=admitted/delivered，稳定 messageId）。
- 注意：admitted item 进 snapshot 管线时不得触发 projectConversationItems 的 durable-live-suffix 保护（conversation-actor.ts:762-770），需作为 host-owned 观察边界处理。

## 实现顺序（每批可独立验证）

1. **前置缺陷修复**：inbox finishBatch marker 清理（processing 无 processingDelivery:"steer" 误删 B，project-session-coordinator.ts:3845-4008）；fatal actor 后 reopen 恢复活性（2415-2433）；pump 每次 await 后重检 closing/deleting/idle/fatal（5871-5890）。
2. **SDK 验证实验**（智囊团 7 项）：followUp mode 行为；crash 窗口（_queueFollowUp 后/message_start 前/message_end 前/后 abort+重启）的 ledger/JSONL/receipt 恢复；busy 外写 JSONL 的树分叉实证；continue+ticket 实验；followUpMode=all 是否污染用户设置；admitted snapshot handoff 与 live-suffix；inbox marker fail-closed。
3. **协议 v30 + send_message 统一 + admission ack**（服务端同时接受新命令，旧命令暂留兼容）。
4. **服务端 admitted projection**：ledger item 以 server-owned conversation item 出现在 snapshot/增量；投递 receipt 后同一 item 转 delivered。
5. **删除客户端**：队列卡片/按钮/五命令/快照事件；断线草稿保留 + 恢复后按 promptId 核对逻辑简化但保留。
6. **迁移存量**：冻结旧写入→保留旧解析器（pending_prompt_delivery.v1/batch.v1）→可重入 marker 对账迁移（marker 已存在只删 sidecar；无 receipt 转 uncertain 不自动重发）→batch fence drain→最后删旧实现/测试/知识页。

## 验证门槛

npm test / typecheck / build / git diff --check；新增用例覆盖：busy 发送→admitted 投影→断线恢复→receipt→delivered；重启后 ledger 恢复；删除/truncate/rewind 与未消费 tail 的 fence；双窗口一致性。

## 残余风险

- "物理 JSONL 立即存在"的字面语义需用户确认接受"admitted conversation item"定义；否则需等 SDK adopt 原语（上游 feature）。
- followUp 快路首期可不做（pump 已满足"忙完尽快读"），减少改动面。
- batch adapter（一次 assistant）为可选增强，未验证前不做。

---

# 落盘实验结论（2026-08-08，scripts/verify-append-continue.ts）

用户追问"busy 时直接把消息落盘到 json 里不行吗"，用真实 pi-agent-core Agent + 假 streamFn 做了实证：

## 事实 1：走 SessionManager API 落盘不分叉（智囊团假设不成立）

- `sessionManager.appendMessage()`（公开 API）同步更新内存索引（fileEntries/byId/leafId）并写文件，parentId=当前 leaf——不是裸写文件的"sibling"。
- busy 时 append 实测树形状：`user(U1)[parent=历史] → user(U2)[parent=U1] → assistant(A1)[parent=U2]`——活动链上、位置与因果一致，buildSessionContext 包含 U2。
- 结论：**写入层面安全**，智囊团"树分叉"反例只对裸写文件成立。

## 事实 2：busy 落盘后 continue 永远不可用（触发无解）

- run 的回复 A1 总是在 busy 期间 append 的 U2 之后（A1[parent=U2]），rebuild 后最后一条必是 assistant。
- 实测 `agent.continue()` 抛 `Cannot continue from message role: assistant`。
- prompt() 会重复写 entry。→ busy 时落盘没有触发原语。

## 事实 3：run 结束后落盘 + rebuild + continue 完全可行

- 实测：appendMessage(U1) → `state.messages = buildSessionContext().messages`（最后一条 user）→ `agent.continue()` 成功。
- LLM 第二次收到的 context = [U0, U1]（模型同时看到全部未回复 user，天然"一次性全读"）；树 `user(U1)[parent=A0] → assistant(A1)[parent=U1]` 顺序正确、不重复；事件流完整。
- 代价：continue 跳过 template/skill 展开、input hook、auth 校验、提交前 compaction、before_agent_start（需宿主补或接受退化）；无 U1 的 message_end 事件（receipt 需宿主自证）。

## 对共识的影响

- **C'（prompt 投递）维持**：与"run 结束后落盘 + continue"在用户感知上不可区分（都是"等待中→已发送"），而 C' 白得 SDK 全语义与现成 receipt 链。
- 若用户坚持"消息必须物理在 JSONL"：场景 B 的 continue 路径是可行的替代投递原语，但需补 preflight/compaction/retry 与宿主 receipt——成本高于 C'，列为 fallback。
- "busy 期间消息不在物理 JSONL"是 SDK 结构决定的（run 独占写入），任何方案都只能让消息在"run 结束瞬间"或"SDK 投递时"落盘，无法更早。
- 实验脚本保留（scripts/verify-append-continue.ts），SDK 升级时重跑验证。
