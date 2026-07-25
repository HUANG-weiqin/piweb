# 项目与持久会话

`updated: 2026-07-24`

## 这个模块是干什么的

项目存储层让工作台状态跟工作目录移动，而不是跟浏览器、WebSocket 或服务进程走。它持有项目清单、Pi 对话、跨会话 inbox 和用户 pending prompt queue；角色与 API Key 仍分别由用户级 `RoleStore` 和 Pi 全局 `AuthStorage` 管理。

## 身份与生命周期

```text
projectId       durable，来自 .piweb/project.json
conversationId  durable，来自 Pi JSONL header
sessionId       ephemeral，一次浏览器 project observation epoch
focusId         ephemeral，一次 conversation attach
runId           ephemeral，一次 prompt
```

这些身份不能复用：

- 项目移动保留 projectId 和 conversationId。
- 项目复制可能复制这两个 durable ID，因此进程内租约按 `canonical cwd + conversationId` 键控，不能只按 projectId。
- 重连会创建新的 sessionId；打开、创建或切回同一 conversation 都创建新的 focusId，用它阻断 `A → B → A` 的迟到 transcript。
- 每次 prompt 使用新的 runId。

## 磁盘布局

```text
<canonical cwd>/.piweb/
  project.json
  sessions/
    <timestamp>_<conversationId>.jsonl
  inbox/
    <messageId>.json
  pending-prompts/
    <promptId>.json
  notebooks/
    <conversationId>.json
```

`project.json` 当前是严格 v1：

```json
{
  "version": 1,
  "projectId": "<uuid>",
  "createdAt": "<canonical ISO timestamp>",
  "toolMode": "read_only | full_access",
  "lastConversationId": "<optional Pi session id>"
}
```

未知字段、非法版本和非法值都 fail closed，不会自动覆盖坏清单。旧版 `workspace_write` 是唯一兼容迁移：打开时映射为 `full_access` 并立即原子重写，运行时 API 和线协议不再接受该值。清单变更经过 store 内串行队列，并用同目录临时文件加 rename 替换。

## 打开循环

```text
initialize(cwd, target)
→ canonicalize cwd
→ ProjectSessionCoordinator.acquireProject()
→ 校验 .piweb 与 sessions 不是 symlink/junction
→ refreshConversations()，枚举并验证全部 JSONL，再与 SessionManager.listAll(custom sessionDir) 一一核对
→ 严格扫描 inbox / pending-prompts，并用 JSONL receipt 保守对账 crash 窗口
→ recent 可返回项目空态；open 选择 exact conversation；new 必须显式 roleId
→ coordinator singleflight 取得/等待 writer lease
→ SessionManager.create/open(..., current cwd override)
→ 创建或读取 conversation profile 与其追加式角色变更
→ PiRuntime 用固定 role model/prompt/tools 创建 ConversationActor
→ PiConnection attach observer 并分配 focusId
→ state + role/project snapshot + focused conversation snapshot
```

`recent` 优先使用 manifest 中仍存在的 `lastConversationId`，否则使用索引中最近修改的对话；项目没有对话时保持空态并显示角色选择页，不创建隐含 default 会话。

显式 `open` 只接受浏览器从服务端索引获得的 conversationId。服务端重新列举受控目录并解析文件路径，不能接受客户端文件路径。Pi 的 `open(nonexistent)` 会创建 manager 而不是可靠报错，所以必须先证明目标存在。

删除同样只接受 conversationId，并遵守 actor 边界：

- 目标及其 descendant set 中任一 busy conversation 都不可删除，必须先精确 abort 并等待 run 结算；Agent 永远不能删除自己，也不能通过删除祖先把自己级联删除。
- 删除先基于 conversation metadata 冻结目标的 descendant set，再为每个目标设置 deleting fence；持久 tombstone 先写删除目标本身，再写 descendants，确保崩溃恢复至少能从目标重新推导 cascade。已打开的 idle actor 把当前 writer lease 在 registry 内原子升级为 deletion lease；未打开目标先 fail-fast 取得独占 lease。升级、精确 unlink 和索引刷新之间不能出现 release/reacquire 窗口。
- 删除与索引刷新共用同一串行队列。服务端完整校验 sessions 目录、由 ID 解析内部常规 JSONL、复验 header identity，再按子孙到祖先顺序逐个精确 `unlink`；每个 conversation 的 `.piweb/notebooks/<conversationId>.json` notebook sidecar 同步删除。
- 每个被删 conversation 只清理 `toConversationId` 等于它的 pending inbox，并按状态精确清理属于它的 queued/dispatching/attention prompt sidecar；它此前发往其他会话的 outbound envelope 不随来源删除，除非接收方也在同一个 cascade set 中随后被删除。
- `lastConversationId` 只在仍等于目标时清除，避免覆盖另一连接刚提交的最近对话。删除成功后更新派生缓存并通过项目订阅发布新 snapshot。
- 删除不存在的干净目标是幂等成功；目录损坏、链接、身份错配或文件系统拒绝删除仍 fail closed。

“回到此处”是当前 conversation 内的物理后缀截断，不是 branch 或浏览器隐藏：

- snapshot 的 user ID 直接对应 Pi message entry，assistant 聚合 ID 的 `assistant:` 后缀对应该聚合首个物理 message entry；所选 entry 本身和它之后的所有 JSONL entry 都被删除，更早行保持字节不变。
- 只允许 idle actor 执行；目标还有 queued/processing inbox 或任意 pending prompt 状态时拒绝，避免截断恢复账本后重复投递。已经送达其它 conversation 的外部效果不回滚。
- store 在项目会话串行边界内完整验证原文件与候选前缀，复验路径及扫描期间文件身份，写临时文件后原子替换；候选不是 message、文件变化、链接、损坏或身份错配都不覆盖原文件。
- durable 替换后，同一 actor 必须 reload SessionManager，并从其 active context 重建 Agent 内存 messages、runId 集合和压缩阈值。若磁盘已提交但内存同步失败，actor 进入 fatal 状态，禁止用旧 parent 继续追加。

Project store handle 按 canonical cwd 引用计数；ProjectSessionCoordinator 在项目 actor 生命周期内保留一个共享 handle，socket server 关闭时统一释放。registry 末次 release 后逐出 store；相同路径随后代表一个新项目时必须重新读取磁盘身份，不能让缓存反向覆盖项目生命周期。

## Conversation profile 与 reserved entries

新对话在 header 后、AgentSession 创建前写唯一 base `piweb.conversation_meta.v1`：

- 完整角色 `id/revision/name/description/systemPrompt/model`；
- `normal` 或 `temporary` lifecycle；
- `user` 或来源 conversation 的 `createdBy`。

同一 JSONL 还可包含：

- `piweb.conversation_role_change.v1`：用户在 idle 边界显式应用的新完整角色快照，最后一条有效记录成为当前角色；
- `piweb.conversation_card.v1`：发送方可见的 outgoing/委派状态；
- `piweb.conversation_message.v1`：进入目标 LLM context 的 incoming 消息；
- `piweb.run_settlement.v1`：精确 run outcome、final text 与临时回传报告标记；
- `piweb.pending_prompt_delivery.v1`：精确 `promptId + runId + deliveredAt` 的 host receipt，证明对应 user message 已先由 Pi 持久追加；
- `piweb.meta_operation.v1`：破坏性 meta 工具的 started/completed 幂等状态；
- `piweb.compaction_threshold.v1`：当前会话 20%–90% 的自动压缩阈值，缺省为 70%，最后一条单调时间记录生效。
- `piweb.compaction_resume.v1`：压缩后继续同一 workbench run 的隐藏 `custom_message`，必须 `display=false` 且只携带合法 `runId`，只校验不投影为卡片或 settlement。

这些类型由宿主拥有。重复 profile、冲突 settlement、同 promptId/runId 指向不同 pending delivery receipt、方向变化、未知 `piweb.*` 类型或畸形 payload 都 fail closed。卡片以同 `cardId` 的最后状态投影；其来源/目标/正文/委派身份/request fingerprint/冻结角色不可变化，状态和时间只能单调前进，runId 一旦出现即固定，terminal outcome/result 不可改写。settlement 单调从未报告推进到已报告。

旧 JSONL 第一次由 coordinator 在 writer lease 下正式打开时追加独立“旧会话” profile：system prompt 为空，模型优先取旧分支模型，否则取任一现存角色模型；它不依赖或重建初始化模板。

## 持久 inbox 与恢复

`.piweb/inbox/<messageId>.json` 是严格 v1 sidecar，只允许常规项目路径；可选 `fromRunId` 冻结来源 run correlation，processing 状态的可选 `waitedByRunId` 记录接收 run 已观察该 messageId，供 wait 在订阅前消息已提交时补查且不重复消费。`fromRunId` 属于 immutable sender payload，`waitedByRunId` 属于 processing delivery state；兼容旧 v1 envelope 时必须保留 `fromRunId` 缺席，crash replay 不能自行补值制造 payload conflict。单条正文、每项目/目标消息数和总字节都有硬上限。`.piweb/notebooks/<conversationId>.json` 是 conversation-scoped Agent Notebook sidecar，由 notebook 工具按 title 管理，删除 conversation 时级联清理。

- 发送方先追加 `sending` 卡片，再原子提交 envelope，最后追加同 cardId 的 `queued` 状态；持久接收发生在目标处理之前。
- busy 目标把最早 queued envelope 持久 claim 为 `processing(runId, processingDelivery="steer")`，再由 actor 以 incoming `custom_message` 排入精确 run 的 SDK steering queue；当前工具调用不被中断。idle 后 inbox pump 才用确定 runId 启动新 run。普通发送在 durable claim 后即可返回，不等待 pre-stream SDK 内存队列，避免项目关闭与 provider/compaction preflight 互锁。
- run settlement durable 后，pump 先对账目标 JSONL incoming marker：带 steer 标记但尚无 marker 的 claim 恢复 queued；已有 marker 才把发送方卡片推进到 completed/failed/aborted 并删除 sidecar。同步 dispatch rollback 必须保留 `processingDelivery`，崩溃时残留 sidecar 用于恢复对账。
- wait 在项目 lifecycle 内把 cycle check、waiter 注册与 durable inbox 补查原子化：发送先赢时按目标 conversation + `fromRunId` 找回未被当前 receiving run receipt 的消息，注册先赢时发送直接结算 waiter，避免消息或 settlement 在订阅前到达而永久错过或同一 messageId 被连续 wait 重放。异常路径必须 remove+detach waiter；目标 exact run 在 durable settlement 前 fatal 时也必须按 runId reject 全部 waiter。临时 initial run 对 caller 只通过尚未 receipt 的回传 incoming message 交付正文，wait tool result 只返回 metadata；return 已 receipt/清理后再次 wait 返回 reported settlement。
- 启动恢复会扫描全部 sidecar、profile 和 settlement：修复 inbox 已提交而来源卡片仍是 sending 的窗口，恢复 processing batch，继续临时回传，并只执行尚未 settled 的 run。
- 临时 conversation 只观察 metadata 中的 `initialRunId`。成功且有 final text 时先 durable enqueue caller、标记 settlement 已报告，再自动删除；失败、中止或无回复同样回传失败，但保留目标并标记 attention。
- 删除 conversation 先冻结并 fence 目标及其 metadata descendants，任何成员 busy 都拒绝整次删除；随后先持久化目标 tombstone，再持久化 descendants tombstone，并按子孙到祖先顺序终结/删除每个目标的 pending envelope、删除 JSONL。事务中的后到消息明确失败，已发往 cascade set 之外的 outbound envelope 不受来源删除影响。删除完成后回收 tombstone，重启时也会安全清理“目标已不存在且无 pending”的残留标记。
- tombstone 从磁盘恢复到内存 deleting set 后才允许 actor open/create 和 inbox pump；因此进程在删除中途退出也不能让目标短暂复活。持久删除失败时 fence 与 tombstone 保留，直到后续恢复真正完成。
- 恢复会在任何 inbox actor pump 前扫描 `piweb.meta_operation.v1`。若发现 started 但未 completed 的精确 abort intent，会先中止仍匹配的活动 run，或把崩溃中断的 processing run 结算为 aborted，再完成来源卡片/sidecar/ledger 对账。
- inactive `peek_session` 的短暂 writer lease 也进入项目 lifecycle 串行边界；若同一目标同时删除，先开始者完整释放 lease 后后一个才进入 tombstone/deletion lease 阶段。

## 持久 pending prompt queue

`.piweb/pending-prompts/<promptId>.json` 是严格 v1、项目级有界 sidecar。immutable payload 是 `promptId + conversationId + text + createdAt`，同 ID 重放只在 payload 完全相同时幂等；不同 promptId 即使正文相同也属于两条独立用户意图。状态只有：

- `queued`：尚未跨过运行时提交边界，可由用户精确撤回；
- `dispatching(runId, dispatchedAt)`：已为自动新 run 或用户显式 Steer 持久 claim，不可假装撤回；
- `attention(reason, attentionAt)`：投递结果无法证明，需要用户核对并显式移除记录，不能自动重发。

目录、文件名、regular-file identity、尾换行、JSON schema、单项目 256 条、单 conversation 64 条和实际总 32 MiB 都 fail closed。新建容量按每条 immutable payload 的最坏合法 JSON 序列化状态预留（包括控制字符被 `JSON.stringify` 转义后的最大 attention reason），因此本版本接受的 queued 记录必能转成 dispatching 或最大 attention；状态替换仍复核实际 next bytes。scan 允许旧版 actual-fit 但新 reservation 超限的队列打开、撤回和清理，只禁止继续创建，避免升级后把可恢复项目直接拒之门外。创建使用同项目父目录临时文件加 hard-link commit，状态替换使用原子 rename；列表按 `createdAt + promptId` FIFO。

- busy 时 `enqueue_prompt` 只 durable put，提交回执不等待后续 claim/pump 成功；post-commit pump 失败保留 exact queued sidecar 并投影 error/attention，不能把已经提交的意图回答成失败。idle pump 在跨会话 inbox 之后 claim 最早 queued prompt，并生成新 run。直接 browser prompt 的 admission 也经过同一 project lifecycle：发现更早 queued/processing inbox 或 queued/dispatching prompt 时先泵送 durable work 并拒绝本次 direct draft，不能从 idle-publication 或重连窗口插队。
- startPrompt 的首条 raw user `message_end` 与后续 guidance 是两个 receipt 槽位。只有从同一 SessionManager entries 找到 `entry.message === rawMessage` 的对象引用才能确认 Pi 已持久追加；首条只确认 initial prompt，不能顺手结算已经排队的 Steer。后续持久 raw user message 再按 SDK FIFO 逐条结算 guidance。
- run 的 durable user message 已观察后，宿主先追加 `piweb.pending_prompt_delivery.v1` receipt，再删除 sidecar。receipt 以 promptId 唯一绑定一个 run；同一 active run 可以合法接收多个不同 promptId，并为每条各写一个 receipt。
- 用户显式 Steer 必须携带当前 exact active runId。SDK promise 尚未接受前的确定性拒绝可精确 requeue；SDK 已接受后若 user message 持久证明丢失、run 提前结算或确认路径失败，只能转 attention，不能重试制造重复。
- 崩溃恢复只在 JSONL 中存在同一 `promptId + runId` delivery receipt 时清理 dispatching sidecar；单有 run settlement 不构成交付证明，因为 preflight failure 也会 settle。没有 receipt 的 dispatching 一律转 attention，queued 继续由 FIFO pump 处理。
- browser、项目切换和服务重启都不拥有该队列；当前 focus 只通过 `pending_prompts_snapshot` 观察完整列表。attention sidecar 另有服务端拥有的 durable attention 集合，会进入后台 conversation sidebar 与 workspace activity；聚焦不能清掉，只有最后一条 attention 被精确 dismiss 或 conversation 删除才消失。删除 conversation 会清理其所有状态；角色切换和物理截断在任意 pending record 存在时拒绝。

详细编排语义见 [kb-agent-collaboration.md](kb-agent-collaboration.md)。

## Pi SessionManager 边界

- 使用项目自有的 custom `sessionDir`；不能依赖 Pi 默认 cwd 编码目录作为 project key。
- 列举使用 `SessionManager.listAll(sessionDir)`，避免项目移动后被旧 header cwd 过滤；但不能信任它的完整性，因为 SDK 会静默跳过部分损坏文件。
- 每次索引刷新都先后快照受控目录中的全部常规 `.jsonl`，目录在 SDK 扫描期间变化会 fail closed。宿主完整读取每个文件，验证尾换行、逐行 JSON、有限数值、header identity，以及经 Pi 内存迁移后的 entry payload / tree 引用；随后要求 SDK 索引与该磁盘全集按规范路径和 ID 精确一一对应。
- 打开时第三个参数传当前 canonical cwd；JSONL header 保留原 cwd，运行态使用新位置。旧会话允许 header cwd 缺失或为空，但存在时必须是字符串。
- 新 Pi manager 默认要到首条 assistant 消息才创建文件。工作台一次写入合法 header 和 conversation metadata 后丢弃 pending manager，再用公开 `open()` 重开。
- `SessionManager` 没有 flush/close/fsync，也没有内建锁；正常 append 是同步 JSONL 写入。
- SDK 打开旧格式时可能原地迁移，因此 writer lease 必须先于 `open()`。
- coordinator 打开已有对话时最多等待旧 writer lease 5 秒；等待队列 FIFO 且可取消。actor singleflight 确保浏览器和 Agent 不会因并发 open 获得第二个 writer。
- `open()` 前宿主再次验证文件非空、以换行结束、每条非空 JSONL 可解析、所有数值有限、首 header 身份匹配，并且 entry ID 唯一、parent/label 引用有效、compaction 保留点属于当前分支祖先链。branch summary 可引用已有节点，或使用 Pi 合法的 `parentId=null + fromId=root` 哨兵。crash partial tail 或“合法 JSON、非法 Pi entry”都会 fail closed，不能被 SDK 静默跳过或恢复成空历史。
- 第一版只有进程内租约；跨进程文件锁尚未实现。

## 旧项目权限字段

严格 v1 manifest 仍保留 `toolMode`，用于兼容旧项目与非协调内部路径；当前 v24 协调运行不再把它当作工具权限真相，也不提供修改它的线协议。工具权限属于用户级角色模板，并进入 conversation 当前角色快照；旧 manifest 的值不能扩大或收紧当前 `ConversationActor`。

`.piweb` 是宿主持久目录。Agent 在 read_only 中不能写入，但宿主保存 transcript 不受只读模式影响；full_access 不额外保护该目录。

## 浏览器投影

持久真相不直接等于网络载荷：

- `PublicState` 是高频、小体积运行状态。
- `role_catalog_snapshot` 是低频用户角色目录及当前可用性。
- `project_snapshot` 是低频扁平会话索引，包含固化 role 摘要、activity、attention 和 temporary；后台 actor 变化不会切换 current focus。
- `project_activity_snapshot` 是进程级已加载项目的有界汇总，只投影 busy/attention 计数；它不复制会话索引、浏览器 unread 或 transcript。
- `conversation_snapshot` 是当前 focus 的一次性 active-branch 投影，包含固化角色和 message/session-message/compaction discriminated items，并限制总字节以及单消息/tool/card payload。
- `pending_prompts_snapshot` 是同一 focus 的独立完整队列投影；它不进入高频 PublicState 或 transcript，也不使用 truncated，因为 durable store 已硬限制为每 conversation 64 条。`compaction` 直接来自 Pi 的持久条目，位于压缩发生处；它作为独立小型 turn 保留，避免较早的大消息被截断时连分界线一起丢失。
- `truncated=true` 只表示 UI 投影省略；不会删除 JSONL。
- live run 仍按 runId 发送增量，卡片按 cardId upsert；恢复时 reducer 用 snapshot 原子 hydrate。两者都必须匹配 `sessionId + conversationId + focusId`，匹配快照到达前 composer 保持禁用。同一 run 内一旦出现 durable compaction，重新聚焦时其前缀必须使用持久聚合投影，不能继续把每个 live assistant segment 展开后再套总字节上限；否则细粒度 live 表示会把本可恢复的压缩前历史整段挤出 snapshot。最后一次 compaction 之后的活动后缀才继续使用 live 投影。
- Agent 的 `peek_session` 有意省略 compaction 分界项；它是用户界面元信息，不应增加 peer Agent 上下文。

## 故障语义

- actor 创建、extension activation 或固定模型校验失败时必须 dispose 新 runtime、释放 lease，并清理半创建 conversation。
- focus change/reinitialize/disconnect 只使浏览器观察 epoch 和 UI route 失效；后台 run 与 actor 保留。真正 server close 才统一取消、settle、dispose 并释放 conversation lease。
- 项目清单无效、状态目录是链接、JSONL 是链接、日志截断/损坏、非有限 JSON 数值、畸形 entry/tree、Pi 索引遗漏/错配或身份在 open 时变化都会 fail closed，原文件不被“修复”覆盖，也不能静默回退到另一条 recent 对话或新建对话。
- 断线不会停止 coordinator-owned run；重连用新 sessionId/focusId 重新观察同一 conversation，并从 durable JSONL hydrate。coordinated `initialize/open` 会直接发送当前 focus 的 `conversation_snapshot`，即使 actor 仍在 `waiting`；因此 `wait_for_session` 已持久化 toolCall 但尚未持久化 result 时，恢复快照必须显示 `pending`。普通 `refresh_view` 则只在 actor idle 且未 compacting 时发送 focused snapshot。
- `lastConversationId` 只是恢复提示；索引是派生状态，丢失/陈旧时可从 sessionDir 重建。

## 当前边界

- 没有 archive、用户多选批量删除、fork/import、附件和跨设备同步；Agent 会话列表只有有界 cursor，不构成浏览器历史分页。
- 每次索引刷新会由宿主完整验证该项目全部 JSONL，并由 Pi `listAll()` 再扫描一次；这是第一版用完整性换简单性的选择。长期项目需要在引入分页时一并设计增量 catalog 和等价的完整性证明。
- 没有跨进程 writer lock 和断电级 durability。
- Pi JSONL header eager materialization 依赖锁定 SDK 的 v3 session format；升级 SDK 时必须用测试验证 header/open/list 行为。
- `.piweb` 可能包含敏感内容；Git 忽略策略由项目所有者决定。

## 入口

- `src/server/project-store.ts`
- `src/server/session-file.ts`
- `src/server/project-snapshot.ts`
- `src/server/conversation-history.ts`
- `src/server/conversation-meta.ts`
- `src/server/project-inbox.ts`
- `src/server/project-prompt-queue.ts`
- `src/server/conversation-notebook.ts`
- `src/server/notebook-tools.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/role-store.ts`
- `src/server/pi-service.ts`
- `src/server/pi-runtime.ts`
- `src/shared/protocol.ts`
- `src/client/App.tsx`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
