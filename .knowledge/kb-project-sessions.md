# 项目与持久会话

`updated: 2026-09-11`

## 这个模块是干什么的

项目存储层让工作台状态跟工作目录移动，而不是跟浏览器、WebSocket 或服务进程走。它持有项目清单、Pi 对话和跨会话 inbox；角色与 API Key 仍分别由用户级 `RoleStore` 和 Pi 全局 `CredentialStore` 管理。浏览器消息投递不建持久队列（见下）。

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
  notebooks/
    <conversationId>.json
```

`project.json` 当前是严格 v2：

```json
{
  "version": 2,
  "projectId": "<uuid>",
  "createdAt": "<canonical ISO timestamp>",
  "lastConversationId": "<optional Pi session id>"
}
```

未知字段、非法版本和非法值都 fail closed，不会自动覆盖或迁移坏清单。工具权限只属于冻结的 conversation role，不在 project manifest 中保存。清单变更经过 store 内串行队列，并用同目录临时文件加 rename 替换。

## 打开循环

```text
initialize(cwd, target)
→ canonicalize cwd
→ ProjectSessionCoordinator.acquireProject()
→ 校验 .piweb 与 sessions 不是 symlink/junction
→ 建立 project context 与 inbox tombstone fence，不等待全项目 transcript audit
→ 严格扫描 inbox，并用 JSONL receipt 保守对账 crash 窗口
→ recent 仍用一次完整索引刷新选择目标；显式 open 选择 exact conversation；new 必须显式 roleId
→ cold exact/recent 可先从验证后的目标 JSONL 构造只读 active branch 与有界 preview（无 lease/runtime）
→ coordinator singleflight 取得/等待 writer lease
→ SessionManager.create/open(..., current cwd override)
→ 创建或读取 conversation profile 与其追加式角色变更
→ PiRuntime 用冻结 role 的 primary/compaction model、prompt/tools 创建 ConversationActor
→ PiConnection attach observer 并分配 focusId
→ focus attached + state + focused conversation snapshot
→ 异步 project refresh + role catalog
```

`recent` 优先使用 manifest 中仍存在的 `lastConversationId`，否则使用索引中最近修改的对话；项目没有对话时保持空态并显示角色选择页，不创建隐含 default 会话。recent 选择前的完整刷新结果也是该次 initialize 的已验证索引 seed；宿主在 seed 扫描结束到主 view subscription 安装之间临时观察 coordinator actor event，除 `project_changed` 外的 mutation 会使 seed 失效。无 mutation 时，目标 actor 打开后首次 `project_snapshot` 只从同一 ProjectStore 当前索引补充 actor role/activity/attention；seed 失效时不发送缓存 snapshot，而是先发布 focused snapshot，再异步 fresh refresh project snapshot。这个无扫描投影不是新的完整性证明，只能用于刚完成验证后的展示，不能用于 open/delete 决策；后续项目变化和 `refresh_view` 仍走完整刷新。新 conversation 的 header 与初始 role/profile 先完整序列化并通过宿主校验，再写同目录临时文件，以 exclusive hard link 原子发布最终 JSONL；崩溃不能暴露 partial final，重复 identity 也不能覆盖旧文件。初次 SDK `open()` 若失败，宿主必须精确 unlink 刚发布的文件，不能留下调用方未拿到 handle 的 orphan conversation。

同一连接的 initialize B 被 C 替换时，B 只撤销自己对 recent 扫描、project model catalog singleflight、conversation actor singleflight，以及 actor 已 resolve 后 recent manifest write 的等待，不能继续占住 `PiConnection` 串行队列。扫描、catalog 创建、writer lease、文件打开、actor activation 和已准入 recent write 仍由 ProjectStore/coordinator 拥有并独立结算；caller signal 不作为这些 owner-owned promise 的操作取消信号。带 signal 的 open 只有在 recent write 等待成功且仍未 abort 后才确认 focus/清除 attention；无 signal 的内部调用仍保持 await write 前立即确认。B 退出时立即释放 project handle、recent seed subscription 与 extension UI route，C 可在 B 的底层 promise 完成前 attach；迟到的 B 结果不得发布 focus 或清除 attention。

focus 切换先 exact open：warm actor 直接复用；cold actor 在取得 writer lease 后做有界目录 header census，要求目标 ID 恰有一个合法 claim，再完整验证目标 JSONL payload/tree 并公开 `SessionManager.open()`。无关 body 损坏或 append 不阻断该目标；同 ID 的另一合法 header 必须拒绝。focused snapshot 发布不等待 `lastConversationId` 保存、全项目索引刷新或后台 full audit。focus attach 会立即确认并清除当时已有的 attention；这个观察确认与 recent 持久写是两个边界，之后新产生的错误或 UI 等待不能被迟到的旧写清除。recent intent 随后立即进入 ProjectStore 的原子写队列；focus 后台写和 initialize/open 的 awaited 写共用该调用顺序，A→B→A 的最终指针不能被旧任务覆盖。已准入 recent 写由 coordinator 在 close 前 drain；写失败只向仍精确观察该 focusId 的连接报告 session error，不撤销已经提交的 focus。

显式 `open` 只接受浏览器从服务端索引获得的 conversationId。服务端重新列举受控目录并解析文件路径，不能接受客户端文件路径。Pi 的 `open(nonexistent)` 会创建 manager 而不是可靠报错，所以必须先证明目标存在。

删除同样只接受 conversationId，并遵守 actor 边界：

- 目标及其 descendant set 中任一 busy conversation 都不可删除，必须先精确 abort 并等待 run 结算；Agent 永远不能删除自己，也不能通过删除祖先把自己级联删除。
- 删除先基于 conversation metadata 冻结目标的 descendant set，再为每个目标设置 deleting fence；在任何 tombstone、inbox 或 source-card 持久副作用前，必须形成完整 lease bundle：已打开 idle actor 的既有 writer lease 计入 bundle，且只在实际删除时原地转为 deletion lease；每个 cold member 都先 fail-fast 取得独占 writer 并升级。任一预检失败要释放本次取得的 lease/fence，不能留下新的 durable 删除副作用。bundle 完整后以 root→descendant 顺序一次性写入并复验整批 tombstone；写后错误（含 `EEXIST`）按可能已发布处理并保留 reservation。启动/重试从一次 durable census 按 maximal lineage root 恢复批次，不能用单 target clear/prune 绕过捕获的批事务；升级、精确 unlink 和索引刷新之间不能出现 release/reacquire 窗口。
- 删除与索引刷新共用同一串行队列。`ProjectStore` 对整批先 quarantine、作一次允许本批 quarantine 的完整 catalog proof，再执行每个目标的受限 notebook/manifest 副作用、复验精确身份、按子孙→祖先顺序 exact `unlink`，最后再作一次无例外完整 proof 并发布索引；不得退化为每个 descendant 重复全目录 proof。notebook 目标与其 stale temp 必须先证明是项目目录内常规文件，并在 transcript/最近指针发生不可逆修改前以 `unlink` 清理；禁止对预期文件路径使用 recursive `rm`，异常目录或链接必须 fail closed 且保留 transcript。
- transcript 删除先原子 rename 到宿主保留的 `.<original-basename>.<uuid>.delete-quarantine`。项目每次打开及每次串行删除开始时，都在任何 catalog/refresh 前严格扫描并恢复这类文件：名称、UUID、目录内常规 canonical 路径、稳定内容和 header identity 任一非法都 fail closed。普通 catalog 遇到任何 leftover quarantine 都拒绝；只有正常删除在 unlink 前的两次 proof 可显式传入并忽略该次删除的精确 quarantine 路径，unlink 后的最终 proof 不再例外。合法 orphan 通过 exclusive hard link 恢复到原名；若上次恢复在 link 后、quarantine unlink 前崩溃，原名与 quarantine 的一次 fingerprint 会证明二者仍是同一 inode，此时只清理 quarantine；不同 inode 的真实碰撞才改存 `.delete-recovery.jsonl`，再由随后完整 catalog 对重复 identity 或损坏内容 fail closed。这样 rename 后崩溃不会让 tombstone 因索引暂时缺席而被误清理。
- unlink quarantine 不是删除成功边界。宿主必须在 unlink 后重新取得完整 verified catalog，并只从该 proof 发布索引；同 conversationId 的路径替换会明确失败且保留 replacement，协调层也保留 tombstone 供安全重试。无关的合法新增会由这次 proof 纳入投影。
- 每个被删 conversation 只清理 `toConversationId` 等于它的 pending inbox；一次 inbox census 必须捕获整个批次的 tombstone、sidecar 路径、owner、fingerprint 和序列化 payload，随后只可删除仍精确匹配该 capture 的 P 个 sidecar。source 仅在同一 frozen physical deletion batch 中，或由本次 `ProjectStore` final complete catalog 明确证明 absent 时，才可跳过 terminal card；后者没有可见 transcript/audit surface。proof 中仍 present 的 external source 必须在 transcript batch 已最终证明后、captured sidecar 删除前成功持久化 terminal card；`undefined`、找不到 card 或写失败都必须保留 target fence 与 sidecar 重试，不能按缓存或打开失败推断 absent。它此前发往其他会话的 outbound envelope 不随来源删除，除非接收方也在同一个 cascade set 中随后被删除。
- `lastConversationId` 只在仍等于目标时清除，避免覆盖另一连接刚提交的最近对话。删除成功后更新派生缓存并通过项目订阅发布新 snapshot。
- 删除不存在的干净目标是幂等成功；目录损坏、链接、身份错配或文件系统拒绝删除仍 fail closed。

“回到此处”是当前 conversation 内的物理后缀截断，不是 branch 或浏览器隐藏：

- snapshot 的 user ID 直接对应 Pi message entry，assistant 聚合 ID 的 `assistant:` 后缀对应该聚合首个物理 message entry；所选 entry 及其后 context-bearing branch entry 会删除，更早行保持字节不变。唯一 ledger 例外是 suffix 中的 `piweb.message_delivery_receipt.v1` 及其引用的 `piweb.run_settlement.v1`：它们必须原子保留并重挂到 retained parent，避免 rewind 令已投递消息或已结算 run 复活。
- 只允许 idle actor 执行；目标还有 queued/processing inbox 时拒绝，避免截断恢复账本后重复投递。已经送达其它 conversation 的外部效果不回滚。
- store 在项目会话串行边界内完整验证原文件与候选前缀，复验路径及扫描期间文件身份，写临时文件后原子替换；候选不是 message、文件变化、链接、损坏或身份错配都不覆盖原文件。
- durable 替换后，同一 actor 必须 reload SessionManager，并从其 active context 重建 Agent 内存 messages、runId 集合和压缩阈值。若原子替换已提交但随后 catalog refresh 或内存同步失败，store 必须明确报告已提交，actor 进入 fatal 状态，禁止用旧 parent 继续追加。

Project store handle 按 canonical cwd 引用计数；ProjectSessionCoordinator 在项目 actor 生命周期内保留一个共享 handle，socket server 关闭时统一释放。registry 末次 release 后逐出 store；相同路径随后代表一个新项目时必须重新读取磁盘身份，不能让缓存反向覆盖项目生命周期。

## Conversation profile 与 reserved entries

新对话在 header 后、AgentSession 创建前写唯一 base `piweb.conversation_meta.v1`：

- 完整角色 `id/revision/name/description/systemPrompt/model/compactionModel/defaultThinkingLevel/defaultServiceTier/toolMode/canManageSessions`；`compactionModel` 为必填 nullable，`null` 跟随该 conversation 冻结的 primary model。
- `normal` lifecycle；
- `user` 或来源 conversation 的 `createdBy`。

同一 JSONL 还可包含：

- `piweb.conversation_role_change.v1`：用户在 idle 边界显式应用的新完整角色快照（含 `compactionModel`），最后一条有效记录成为当前角色，并把分支 thinking 重置为该角色默认值；
- `piweb.conversation_card.v1`：发送方可见的 outgoing/委派状态；
- `piweb.conversation_message.v1`：进入目标 LLM context 的 incoming 消息；
- `piweb.message_delivery_receipt.v1`：不可 rewind 的 transport ledger；
- `piweb.run_settlement.v1`：精确 run outcome 与 final text；
- `piweb.meta_operation.v1`：破坏性 meta 工具的 started/completed 幂等状态；
- `piweb.compaction_threshold.v1`：当前会话 20%–90% 的自动压缩阈值，缺省为 70%，最后一条单调时间记录生效。
- `piweb.compaction_resume.v1`：压缩后继续同一 workbench run 的隐藏 `custom_message`，必须 `display=false` 且只携带合法 `runId`，只校验不投影为卡片或 settlement。默认压缩由 Pi 0.85.1 私有 `_runDefaultCompaction` 在 `session_before_compact` 后执行；custom 结果直接采用并跳过模型解析，否则每次 attempt fresh-resolve 冻结的 compaction identity。显式模型必须可用、contextWindow 为有限正数且不小于本次 primary，失败无 fallback；缺少当前必填 role snapshot 字段的 JSONL 一律 fail closed，不做读时补值或语义迁移。
- 历史 `piweb.wait_poll.v1` 只接受严格合法的旧 `custom` carrier（UUID `runId`、1–8 整数 `count`、无额外字段），验证后不恢复任何 poll/quota/wait 生命周期状态；畸形记录和其它未知 `piweb.*` 仍 fail closed。

这些类型由宿主拥有。重复 profile、冲突 settlement、方向变化、未知 `piweb.*` 类型或畸形 payload 都 fail closed。卡片以同 `cardId` 的最后状态投影；其来源/目标/正文/委派身份/request fingerprint/冻结角色不可变化，状态和时间只能单调前进，runId 一旦出现即固定，terminal outcome/result 不可改写。settlement 单调从未报告推进到已报告。

当前受支持的 JSONL 在正式打开前已经包含合法 conversation profile；缺少 profile、role snapshot 或其它当前必填字段的文件一律拒绝，coordinator 不追加猜测性的“旧会话” profile。

角色、自动压缩阈值、service tier 和 thinking 都按 active branch 聚合；角色的 primary/compaction identity 由冻结快照及 role-change 记录恢复，模板或目录刷新不改写既有 conversation。永久 run settlement ledger 才读取物理全集。coordinator 在 create/reopen/switch/rollback/peer 路径和 meta tools 中都传递该完整 frozen identity。thinking 从当前角色默认值开始，后续 Pi 原生 `thinking_level_change` 覆盖，新的角色变更再次重置。rewind 必须在 durable truncate 前停止当前 AgentSession，使 `session_shutdown` 的尾部写入也落在随后删除的 suffix 中；truncate 未提交时按 shutdown 后的实际 branch thinking 恢复旧 runtime，恢复失败才 fatal。提交后统一从 retained branch 重建 runtime；跨角色时还要换回 retained profile 的 model/system prompt/tools/权限，不能保留未来 runtime 继续写入。

## 持久 inbox 与恢复

`.piweb/inbox/<messageId>.json` 是严格 v1 sidecar，只允许常规项目路径；必填 `fromRunId` 冻结来源 run correlation，processing 状态的可选 `waitedByRunId` 记录接收 run 已观察该 messageId，供 wait 在订阅前消息已提交时补查且不重复消费。`fromRunId` 属于 immutable sender payload，`waitedByRunId` 属于 processing delivery state；缺失或冲突都 fail closed，crash replay 不得自行补值。单条正文、每项目/目标消息数和总字节都有硬上限。`.piweb/notebooks/<conversationId>.json` 是 conversation-scoped Agent Notebook sidecar，由 notebook 工具按 title 管理，删除 conversation 时级联清理。

- 发送方先追加 `sending` 卡片，再原子提交 envelope，最后追加同 cardId 的 `queued` 状态；持久接收发生在目标处理之前。`start_session` 因目标 profile 必须先创建 target；若 inbox admission 抛错，宿主先按 exact messageId 复查 commit：已存在 envelope 就保留 target 供 replay 修复，确认不存在时则把 source card 终结为带原因的 `failed` 并删除本次新建 target。这样失败返回不能留下 orphan target 或永久 `sending`，相同 idempotency key 重放也稳定返回原 admission failure。
- busy 目标把最早 queued envelope 持久 claim 为 `processing(runId, processingDelivery="steer")`，再由 actor 以 incoming `custom_message` 排入精确 run 的 SDK steering queue；当前工具调用不被中断。idle 后 inbox pump 才用确定 runId 启动新 run。普通发送在 durable claim 后即可返回，不等待 pre-stream SDK 内存队列，避免项目关闭与 provider/compaction preflight 互锁。
- run settlement durable 后，pump 先对账目标 JSONL incoming marker：带 steer 标记但尚无 marker 的 claim 恢复 queued；已有 marker 才把发送方卡片推进到 completed/failed/aborted 并删除 sidecar。多 envelope 终结逐条从进程内 processing batch 精确移除；中途失败时保留失败项和后续项，并在同一 lifecycle 至多立即重试一次。terminal card 已追加但 sidecar 删除失败时，重试依赖 card 聚合幂等继续删除；仅整批成功才清除失败 retry key。idle batch 的逐条 `queued → processing` claim 属于同一 dispatch start/rollback 边界：任一 claim 失败时必须按每条原始 state 回滚整个 batch、不得启动 actor，再沿用一次 retry pump；同步 dispatch rollback 必须保留 `processingDelivery`，崩溃时残留 sidecar 用于恢复对账。
- wait 在项目 lifecycle 内把 cycle check、waiter 注册与 durable inbox 补查原子化：发送先赢时按目标 conversation + `fromRunId` 找回未被当前 receiving run receipt 的消息，注册先赢时发送直接结算 waiter，避免消息或 settlement 在订阅前到达而永久错过或同一 messageId 被连续 wait 重放。异常路径必须 remove+detach waiter；目标 exact run 在 durable settlement 前 fatal 时也必须按 runId reject 全部 waiter。wait tool result 只返回消息 metadata；消息正文只通过 incoming message 注入一次，已 receipt 的消息不会被再次投递。
- 启动恢复会扫描全部 sidecar、profile 和 settlement：修复 inbox 已提交而来源卡片仍是 sending 的窗口，恢复 processing batch，恢复可恢复的 inbox delivery，并只执行尚未 settled 的 run。
- 删除 conversation 先冻结并 fence 目标及其 metadata descendants，任何成员 busy 都拒绝整次删除；随后 root-first 批量持久化 tombstone，批量 quarantine/proof 后 leaf-first 删除 JSONL。root-last fence clear 若在中途失败，Inbox 只能回报已由 `deleteStoredFile()` 成功返回、故 original path 已证明 absent 的精确 cleared prefix；Coordinator 仅在同批 final catalog absence 和 captured sidecar cleanup 已成功后 finalize/release 这些 ID，失败项、未尝试项和无法证明 absent 的项都保留 fence/reservation/attention。批量 fence、captured inbox sidecar 和 exact identities 任何一步不能证明时都保留 durable reservation，重启按 lineage batch 安全重试；所有物理目标已最终证明 absent 后才清理对应 tombstone。事务中的后到消息明确失败，已发往 cascade set 之外的 outbound envelope 不受来源删除影响。
- tombstone 从磁盘恢复到内存 deleting set 后才允许 actor open/create 和 inbox pump；因此进程在删除中途退出也不能让目标短暂复活。tombstone 文件已创建但后续 scan/verify 失败同样是已提交删除意图，当前 coordinator 必须保留 warm `deleting` fence；持久删除失败时 fence 与 tombstone 保留，直到后续恢复真正完成。
- 恢复会在任何 inbox actor pump 前扫描 `piweb.meta_operation.v1`。若发现 started 但未 completed 的精确 abort intent，会先中止仍匹配的活动 run，或把崩溃中断的 processing run 结算为 aborted，再完成来源卡片/sidecar/ledger 对账。
- inactive `peek_session` 的短暂 writer lease 也进入项目 lifecycle 串行边界；若同一目标同时删除，先开始者完整释放 lease 后后一个才进入 tombstone/deletion lease 阶段。

## 浏览器消息投递（消息直通，无持久队列）

消息与忙闲无关，随时可发；工作台不再拥有持久 pending prompt 队列、pump 或 batch guidance。

- normal 且由用户创建的 conversation 在首次 browser run 的 `queued` 阶段执行一次宿主命名门：仅当 JSONL 从未出现 `session_info` 且没有 message/custom-message/compaction context 时，使用该会话固定模型与 session-local `ModelRuntime.completeSimple()` 做无工具、无 transcript 的隔离摘要。输出清理为单行并按 24 个 Unicode 字符裁剪；普通模型失败、超时或空输出持久化“新任务”。模型请求期间出现任何显式标题 intent 都优先，Agent/peer 创建、已有标题或已有 context 的会话不参与。
- 命名门不是浏览器消息接收回执的前置条件：actor 安装唯一 active run 后同步建立 live prompt 投影并发布 `run_queued`，让客户端立即确认并展示已接收的首轮消息；随后仍在 `queued` 阶段完成命名，并从 actor 持有 writer lease 的目标 JSONL 路径重新验证规范路径、稳定 fingerprint、完整 payload、conversation identity 和最新 `session_info` intent，证明持久标题后才调用正式 `AgentSession.prompt(originalText)`。全项目 catalog refresh 只是 best-effort UI 投影，不能充当 durable proof。abort/stale/dispose 取消隔离请求且不写 fallback；无法证明标题 intent 持久化时 actor 进入 fatal，不能在可能已部分提交的 SessionManager 上追加 run settlement。
- busy 时浏览器 `prompt`（带 promptId）只在 actor phase 为 `running | waiting` 且 `session.isStreaming=true` 时由 actor 调用 `session.prompt(text, { streamingBehavior: "steer", preflightResult })`；pre-stream 窗口必须在触碰 SDK 前拒绝，否则 SDK 会把 steer-mode prompt 当成新 run。busy 的 `/` 前缀 prompt 也在 SDK 前拒绝，因为 Pi 会先 await command lookup，越过宿主的同步对象身份捕获边界；idle slash 仍由普通 run 路径处理。注册了 input extension handler 时同样拒绝 busy browser prompt，因为 handler 可 `handled` 而不入队。真正接受后，消息在当前 assistant turn 工具调用全部结束、下一次模型调用前注入。会话创建时把 `steeringMode` 固定为 `all`：排队消息一次模型轮次全部注入，inbox 消息同队列同样批量。宿主零 pump/零重建。idle 时经 project lifecycle 起新 run，且不越过已有 inbox 工作。
- admitted 是 actor 内存 FIFO（`promptId + text`），有界（单会话最多 64 条）；宿主只在同步调用 `AgentSession.prompt(...steer)` / `steer()` 的栈内观察真实 `agent.steer(message)`，把该次 SDK 入队的原始 user `AgentMessage` 对象绑定到 accepted observation。不能用 steering mirror 文本或长度证明来源：前驱可同时 drain，可信 extension 也可产生同文 user message。abort/正常结算/fatal 都清空 admissions 和 accepted observation。进程重启时未投递消息丢失——UI 必须诚实显示"等待中"而非"已发送"。
- 投递证明：只在 raw user `message_end` 后，从同一 SessionManager entries 找到 `entry.message === rawMessage` 的对象引用。每个有 initial user 的 run 的首个 raw user end 无条件先归 initial；后续 busy browser admission 与显式 steer 按 SDK 接受顺序共用 accepted-but-unobserved FIFO，并且只有 FIFO 头捕获的 queued object 与 raw object 为同一引用时才结算精确 promptId/delivery。extension 可在 `message_end` 原地替换正文而不改变该身份；同文 extension user message 不消费或越过 host record。run settlement 本身不是交付证明。admissions 不能跨 restart 恢复。
- 工作台不迁移或恢复 `.piweb/pending-prompts` 队列；当前格式不存在该目录，发现旧队列状态即 fail closed。未投递 browser prompt 只存在于当前进程的 admitted FIFO，重启或 abort 后由协议诚实丢失。
- 当前 JSONL 不保留 `piweb.pending_prompt_delivery.v1` 或 `piweb.pending_prompt_batch.v1` 兼容读取；发现这些已废弃记录即 fail closed。

详细编排语义见 [kb-agent-collaboration.md](kb-agent-collaboration.md)。

## Pi SessionManager 边界

- 使用项目自有的 custom `sessionDir`；不能依赖 Pi 默认 cwd 编码目录作为 project key。
- 列举使用 `SessionManager.listAll(sessionDir)`，避免项目移动后被旧 header cwd 过滤；但不能信任它的完整性，因为 SDK 会静默跳过部分损坏文件。
- 完整索引刷新、显式 audit 与 cascade delete 都先后快照受控目录中的全部常规 `.jsonl`，目录在 SDK 扫描期间变化会 fail closed。宿主完整读取每个文件，验证尾换行、逐行 JSON、有限数值、header identity，以及当前格式的 entry payload / tree 引用；随后要求 SDK 索引与该磁盘全集按规范路径和 ID 精确一一对应。
- 单目标 preview/open 不依赖该完整索引：用 file descriptor 读取每个受控常规文件的有界首行，只把能通过 session header 验证的同 ID 文件当作 collision candidate；随后稳定读取并完整验证目标。头行无法在上限内解析的文件没有 identity claim；I/O、路径或扫描期不确定性不能被当作无关。proof commit 复验所有 target candidate 的 path/inode/header claim，正常无关 body append 不改变该 scope。
- 打开时第三个参数传当前 canonical cwd；JSONL header 保留原 cwd，运行态使用新位置。旧会话允许 header cwd 缺失或为空，但存在时必须是字符串。
- 新 Pi manager 默认要到首条 assistant 消息才创建文件。工作台一次写入合法 header 和 conversation metadata 后丢弃 pending manager，再用公开 `open()` 重开。
- `SessionManager` 没有 flush/close/fsync，也没有内建锁；正常 append 是同步 JSONL 写入。
- writer lease 必须先于 `open()`；宿主只接受当前 Pi JSONL 格式，绝不让 SDK 通过打开旧格式而原地迁移用户文件。
- coordinator 打开已有对话时最多等待旧 writer lease 5 秒；等待队列 FIFO 且可取消。actor singleflight 确保浏览器和 Agent 不会因并发 open 获得第二个 writer。cold focus 被后继导航取消时，只结束该 PiConnection 对 shared opening 的等待；coordinator 自有的 singleflight、lease、文件打开和 actor activation 继续结算并供后续调用复用。
- `open()` 前宿主再次验证文件非空、以换行结束、每条非空 JSONL 可解析、所有数值有限、compaction `tokensBefore` 非负、首 header 身份匹配，并且 entry ID 唯一、parent/label 引用有效、compaction 保留点属于当前分支祖先链。宿主 reserved entry 还必须绑定该 header identity：outbound card 的 source 与 inbound message 的 target 都必须是当前 conversation，不能把另一会话的合法记录搬入本文件。branch summary 可引用已有节点，或使用 Pi 合法的 `parentId=null + fromId=root` 哨兵。crash partial tail 或“合法 JSON、非法 Pi entry”都会 fail closed，不能被 SDK 静默跳过或恢复成空历史。
- 第一版只有进程内租约；跨进程文件锁尚未实现。

## 项目权限边界

工具权限属于用户级角色模板，并进入 conversation 当前角色快照；project manifest 没有 `toolMode`，也没有修改权限的线协议。

`.piweb` 是宿主持久目录。Agent 在 read_only 中不能写入，但宿主保存 transcript 不受只读模式影响；full_access 不额外保护该目录。

## 浏览器投影

持久真相不直接等于网络载荷：

- `PublicState` 是高频、小体积运行状态。
- `role_catalog_snapshot` 是低频用户角色目录及当前可用性。
- `project_snapshot` 是低频会话索引，包含服务端解析的 root、固化 role 摘要、activity、必填 `compacting`、attention；底层会话仍平级，浏览器可按 root 聚合导航。`compacting` 仍由 warm actor 唯一拥有，独立于 activity/busy/run；cold/durable/cache 观察明确投影 `false`。compaction 边沿由 coordinator 发送 summary-only `project_summary_changed`，连接只从 current index 重投影项目快照（coverage 为 `unknown`），不能触发 focused transcript、state rehydrate 或 run mutation。它还带 `coverage`：fresh full refresh 是 `complete`，cold/recent 当前索引 seed 是 `unknown`。count 与 JSON byte 裁剪把 compacting 会话作为保留候选，并优先保留完整 root 组；任何省略都置 `truncated`；后台 actor 变化只更新索引，不会切换 current focus。
- `project_activity_snapshot` 是进程级已加载项目的有界汇总，只投影 busy/attention 计数；它不复制会话索引、浏览器 unread 或 transcript。
- 浏览器分别维护最多 4 项 workspace LRU 与 8 项 conversation presentation LRU，让工作区或同项目会话切换时立即画出目标上一帧；两者独立逐出，只存在内存，不接管 transcript、不保存 draft/pending command，也不能解锁命令。conversation cache 以 workspace/project/conversation 为键，保存 reducer 产出的 ChatState 展示引用及角色/window/control 投影，但绝不 hydrate 回当前 reducer。新 observation/focus 仍必须 exact open durable conversation，并以匹配新完整 focus 身份的服务端 snapshot 覆盖缓存。只有 `coverage: "complete"` 且非截断 `project_snapshot` 的缺席才能证明条目已删除；`unknown` 或截断快照不能据此逐出。
- `conversation_preview` 是 command-correlated、无 focusId 的 cold 只读投影：常规 `inspectConversation(s)` 只返回 metadata，绝不附带或复制物理 entries；只有单目标 `inspectConversationPresentation` 在完整性证明后 opt-in 返回本次 JSON parse 新拥有的 readonly entries 浅数组。只读 adapter 从最后物理 leaf 沿 parentId 还原 active branch，getter 只复制数组壳，canonical projector 不修改 entry，再经 peer enrichment 与最终 window pipeline。投影构造失败只跳过 preview，文件完整性/read/identity 失败仍 fail closed。它不取得 writer lease，不创建 SessionManager/AgentSession/model catalog/extension route，也不能启用任何 focus 命令；actor 或 actorOpening 已存在时禁止发送磁盘 preview，emit 前还要同步复核一次 actor/opening/deleting/closing。
- `conversation_snapshot` 是当前 focus 的一次性 active-branch 权威投影，包含固化角色和 message/session-message/compaction discriminated items，并限制总字节以及单消息/tool/card payload。投影只有一条 canonical pipeline：捕获 durable physical slots → 用 raw SDK message 对象身份把已持久化 live message 精确交给 durable slot → semantic fold → peer enrichment → 一次最终 exact-JSON-byte window。不能按角色、文本或数量猜测交接，也不能分别裁 durable/live 后再拼接。session-message 的 peer enrichment 只能同步给 `peerPresence: "unknown"`；`ProjectStore` 的完整稳定 header census 在 coordinator lifecycle 内异步解析后，才以同一 projectionSeq 的 `conversation_item` 重投影当前仍匹配 view/actor/focus 的可见 card 为 `present/absent`。该 proof 不读/信任 catalog 或 transcript body，失败、目录/header 改动和 view 失效保持 unknown；它不承担 exact open 的完整性证明。
- 每条物理 user/assistant message 在任一时刻只能由 durable slot 或未持久化 live suffix 一方拥有。Pi 对 user 的 start/end/persistence 复用同一对象，但 pi-agent-core 的 assistant `message_start` 是 partial 浅拷贝，真正被 AgentSession 持久化的是 `message_end` 的 final 对象；因此 assistant live slot 必须在 end 时改绑 final identity，不能把 start payload 当成 durable identity。browser 初始 prompt slot 也只能绑定首条 user，后续 steer 不得覆盖它。exact handoff 后 durable item 保留当前 runId；live tool 状态只可覆盖尚无 durable tool result 的 pending 工具，一旦 JSONL 已有 result 就由 durable 状态获胜。compaction、user/steer 与卡片首次出现是时间线语义边界；不再保留“最后一次 compaction 后才使用 live”的特判。
- 最终窗口优先保留完整的最近语义 turn；最新 turn 自身超限时保留连续有序后缀，不能跳过一个超大 item 后再捡更早的小 item。非空来源必须至少投影最新 item；单项也按最终 `JSON.stringify` 的 UTF-8 bytes 自适应缩略，避免 JSON 转义把合法原文放大后得到空快照。`window.omittedBefore / startsMidTurn / contentTruncated` 精确描述覆盖范围，任何省略都不会删除 JSONL。
- `conversation_snapshot` 携带当前 focus 的 admitted 项（`pendingPrompts`，`promptId + text`，最多 64 条）；它不进入高频 PublicState，也不使用 window，用于断线/多窗口恢复"等待中"列表。`compaction` 直接来自 Pi 的持久条目，位于压缩发生处；它作为独立小型 turn 保留。
- live run 仍按 runId 发送增量，卡片按 cardId upsert；恢复时 reducer 用 snapshot 原子 hydrate。两者都必须匹配 `sessionId + conversationId + focusId`，匹配快照到达前 composer 保持禁用。卡片更新若改变最终窗口成员，单条 upsert 无法表达淘汰，服务端必须改发完整 snapshot。
- Agent 的 `peek_session` 有意省略 compaction 分界项；它是用户界面元信息，不应增加 peer Agent 上下文。peek tail 同样按最终序列化字节裁剪，并保证 limit 非零且来源有可见 item 时不会因最新单项超限返回空列表。

## 故障语义

- actor 创建、extension activation 或固定模型校验失败时必须 dispose 新 runtime、释放 lease，并清理半创建 conversation。
- focus change/reinitialize/disconnect 只使浏览器观察 epoch 和 UI route 失效；后台 run 与 actor 保留。真正 server close 才统一取消、settle、dispose 并释放 conversation lease。
- 项目清单无效、状态目录是链接、JSONL 是链接、日志截断/损坏、非有限 JSON 数值、畸形 entry/tree、Pi 索引遗漏/错配或身份在 open 时变化都会 fail closed，原文件不被“修复”覆盖，也不能静默回退到另一条 recent 对话或新建对话。
- 断线不会停止 coordinator-owned run；重连用新 sessionId/focusId 重新观察同一 conversation，并从 durable JSONL hydrate。coordinated `initialize/open` 会直接发送当前 focus 的 `conversation_snapshot`，即使 actor 仍在 `waiting`；因此 `wait_for_session` 已持久化 toolCall 但尚未持久化 result 时，恢复快照必须显示 `pending`。普通 `refresh_view` 则只在 actor idle 且未 compacting 时发送 focused snapshot。
- `lastConversationId` 只是恢复提示；索引是派生状态，丢失/陈旧时可从 sessionDir 重建。focus 已成功但该提示后台保存失败时不回滚 focus，并只向仍匹配原 focusId 的当前观察报告错误。

## 当前边界

- 没有 archive、用户多选批量删除、fork/import、附件和跨设备同步；Agent 会话列表只有有界 cursor，不构成浏览器历史分页。
- 完整列表、显式 audit 与 cascade delete 仍由宿主完整验证项目全部 JSONL，并由 Pi `listAll()` 再扫描一次；这不是显式 target open/preview 的前置条件。path-keyed catalog v2 是原子版本化、可损坏即丢弃的展示/诊断 observation：summary 按 `(relativePath, dev, ino, header claim)` 保留为可陈旧的 display cache，body 的 `valid | invalid | unverified` 只证明当前完整 fingerprint；同 inode/header 的 append 会保留 summary 并重新验证 body，file/header identity 改变才丢弃它。`SessionFileChangedError` 不记为 invalid，而是放弃该轮写入并由下一次 census 重试；scrub 提交按当前 catalog CAS，不能覆盖期间完成的完整 proof。cold current-index 只以 `coverage: "unknown"` 投影缓存；它不能替代当次 target proof。
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
