# 项目与持久会话

`updated: 2026-10-07`

## 这个模块是干什么的

项目存储层让工作台状态跟工作目录移动，而不是跟浏览器、WebSocket 或服务进程走。它持有项目清单、Pi 对话和跨会话 inbox；角色与 API Key 仍分别由用户级 `RoleStore` 和 Pi 全局 `CredentialStore` 管理。浏览器消息投递不建持久队列（见下）。

## 身份与生命周期

```text
projectId       durable，来自 .piweb/project.json
conversationId  durable，来自 Pi JSONL header
sessionId       ephemeral，一次浏览器 project observation epoch
focusId         ephemeral，一次 conversation attach
runId           一次逻辑执行；settlement 持久化，恢复可沿用同一 identity
```

这些身份不能复用：

- 项目移动保留 projectId 和 conversationId。
- 项目复制可能复制这两个 durable ID，因此进程内租约按 `canonical cwd + conversationId` 键控，不能只按 projectId。
- 重连会创建新的 sessionId；打开、创建或切回同一 conversation 都创建新的 focusId，用它阻断 `A → B → A` 的迟到 transcript。
- 新的 idle prompt 创建新逻辑 run；busy prompt 的 disposable runId 不是接收方 active run，恢复/continuation 也不意味着新 run。

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
→ 建立 project context 与 inbox tombstone fence，启动按文件版本的恢复发现
→ 严格扫描 inbox；候选 fresh inspect、落实 abort 意图后才允许启动或恢复 run
→ recent 用目录发现投影选择目标；显式 open 选择 exact conversation；new 必须显式 roleId
→ cold exact/recent 可先从验证后的目标 JSONL 构造只读 active branch 与有界 preview（无 lease/runtime）
→ coordinator singleflight 取得/等待 writer lease
→ SessionManager.create/open(..., current cwd override)
→ 创建或读取 conversation profile 与其追加式角色变更
→ PiRuntime 用冻结 role 的 primary/compaction model、prompt/tools 创建 ConversationActor
→ PiConnection attach observer 并分配 focusId
→ focus attached + state + focused conversation snapshot
→ 异步 project refresh + role catalog
```

`recent` 优先使用发现结果中仍存在的 manifest `lastConversationId`，否则使用最近活动的对话；项目没有对话时保持空态并显示角色选择页，不创建隐含 default 会话。`listSessionsForDisplay()` 用 ProjectStore 的发现观察取代完整正文索引，不加载所有 authority profile；目标随后仍独立 exact open。宿主在发现开始到主 view subscription 安装之间观察 actor mutation，避免 seed handoff 丢更新。无 mutation 时首次 snapshot 从当前索引补充 actor role/activity/attention，并标 `coverage: "unknown"`；seed 失效时先发布 focused snapshot，再异步重新发现。后续项目变化和 `refresh_view` 也用发现路径，不能因窗口恢复或自动同步重新触发全部正文校验。run 结算只通过已有 `projectConversationSession()` 投影该 actor 的摘要，不另行全目录 refresh；否则启动恢复一个 run 就会重新付全部历史成本。展示缓存不进入 `context.profiles`，不能授权 open/delete。新 conversation 的 header 与初始 role/profile 先完整序列化并通过宿主校验，再写同目录临时文件，以 exclusive hard link 原子发布最终 JSONL；崩溃不能暴露 partial final，重复 identity 也不能覆盖旧文件。初次 SDK `open()` 若失败，宿主必须精确 unlink 刚发布的文件，不能留下调用方未拿到 handle 的 orphan conversation。

同一连接的 initialize B 被 C 替换时，B 只撤销自己对 recent 扫描、project model catalog singleflight、conversation actor singleflight，以及 actor 已 resolve 后 recent manifest write 的等待，不能继续占住 `PiConnection` 串行队列。扫描、catalog 创建、writer lease、文件打开、actor activation 和已准入 recent write 仍由 ProjectStore/coordinator 拥有并独立结算；caller signal 不作为这些 owner-owned promise 的操作取消信号。带 signal 的 open 只有在 recent write 等待成功且仍未 abort 后才确认 focus/清除 attention；无 signal 的内部调用仍保持 await write 前立即确认。B 退出时立即释放 project handle、recent seed subscription 与 extension UI route，C 可在 B 的底层 promise 完成前 attach；迟到的 B 结果不得发布 focus 或清除 attention。

focus 切换先 exact open：warm actor 直接复用；cold actor 在取得 writer lease 后做有界目录 header census，要求目标 ID 恰有一个合法 claim，再完整验证目标 JSONL payload/tree 并公开 `SessionManager.open()`。无关 body 损坏或 append 不阻断该目标；同 ID 的另一合法 header 必须拒绝。focused snapshot 发布不等待 `lastConversationId` 保存、全项目索引刷新或后台 full audit。focus attach 会立即确认并清除当时已有的 attention；这个观察确认与 recent 持久写是两个边界，之后新产生的错误或 UI 等待不能被迟到的旧写清除。recent intent 随后立即进入 ProjectStore 的原子写队列；focus 后台写和 initialize/open 的 awaited 写共用该调用顺序，A→B→A 的最终指针不能被旧任务覆盖。已准入 recent 写由 coordinator 在 close 前 drain；写失败只向仍精确观察该 focusId 的连接报告 session error，不撤销已经提交的 focus。

显式 `open` 只接受浏览器从服务端索引获得的 conversationId。服务端重新列举受控目录并解析文件路径，不能接受客户端文件路径。Pi 的 `open(nonexistent)` 会创建 manager 而不是可靠报错，所以必须先证明目标存在。

删除同样只接受 conversationId，并遵守 actor 边界：

- 目标及其 descendant set 中任一 busy conversation 都不可删除，必须先精确 abort 并等待 run 结算；Agent 永远不能删除自己，也不能通过删除祖先把自己级联删除。
- 删除先从 fresh 安全目录 header 全集及各文件首份 base metadata 的 `createdBy/orchestration` 冻结目标的 descendant set，不读取后续无关正文，也不使用展示 catalog、`context.profiles` 或 warm actor 的缓存谱系授权。正常新文件的 base metadata 紧跟 header，合法后置布局则流式读到该记录；缺失、不可读或无法确定的谱系仍拒绝。提交前复核目录成员、文件 inode/header 与 base 谱系，正常无关 tail append 不使观察失效。随后为每个目标设置 deleting fence；在任何 tombstone、inbox 或 source-card 持久副作用前，必须形成完整 lease bundle：已打开 idle actor 的既有 writer lease 计入 bundle，且只在实际删除时原地转为 deletion lease；每个 cold member 都先 fail-fast 取得独占 writer 并升级。任一预检失败要释放本次取得的 lease/fence，不能留下新的 durable 删除副作用。bundle 完整后以 root→descendant 顺序一次性写入并复验整批 tombstone；写后错误（含 `EEXIST`）按可能已发布处理并保留 reservation。启动/重试从一次 durable census 按 maximal lineage root 恢复批次，不能用单 target clear/prune 绕过捕获的批事务；升级、精确 unlink 和索引刷新之间不能出现 release/reacquire 窗口。
- 物理删除与索引刷新共用同一串行队列。`ProjectStore` 一次 fresh namespace census 证明全目录路径安全、合法 header 与唯一 identity，只对冻结目标批次完整校验 payload/tree；无关正文损坏或正常追加不阻断删除。整批 quarantine 后允许忽略本批精确 quarantine 路径作 namespace 复核，再执行每个目标的受限 notebook/manifest 副作用、复验精确身份、按子孙→祖先顺序 exact `unlink`，最后作无例外 namespace proof 并撤去派生索引中的已删除成员；不得退化为每个 descendant 重复全目录正文 proof。notebook 目标与其 stale temp 必须先证明是项目目录内常规文件，并在 transcript/最近指针发生不可逆修改前以 `unlink` 清理；禁止对预期文件路径使用 recursive `rm`，异常目录或链接必须 fail closed 且保留 transcript。
- transcript 删除先原子 rename 到宿主保留的 `.<original-basename>.<uuid>.delete-quarantine`。项目每次打开及每次串行删除开始时，都在任何 catalog/refresh 前严格扫描并恢复这类文件：名称、UUID、目录内常规 canonical 路径、稳定内容和 header identity 任一非法都 fail closed。普通 catalog 或 namespace proof 遇到任何 leftover quarantine 都拒绝；只有正常删除在 unlink 前的复核可显式传入并忽略该次删除的精确 quarantine 路径，unlink 后的最终 namespace proof 不再例外。合法 orphan 通过 exclusive hard link 恢复到原名；若上次恢复在 link 后、quarantine unlink 前崩溃，原名与 quarantine 的一次 fingerprint 会证明二者仍是同一 inode，此时只清理 quarantine；不同 inode 的真实碰撞才改存 `.delete-recovery.jsonl`，再由随后 namespace proof 对重复 identity fail closed；恢复文件本身始终经过严格正文校验。这样 rename 后崩溃不会让 tombstone 因索引暂时缺席而被误清理。
- unlink quarantine 不是删除成功边界。宿主必须在 unlink 后 fresh 证明完整 namespace 与所有被删 ID 的 absence；同 conversationId 的路径替换会明确失败且保留 replacement，协调层也保留 tombstone 供安全重试。最终结果只携带剩余 ID，不声明无关正文有效，也不为无关新增同步加载摘要；展示刷新独立进行。协调层在 source-card 与 captured sidecar 清理之后、清整批 fence 之前，还须通过 `assertConversationsAbsent()` fresh namespace 复核所有目标仍 absent；任何重现或观察不确定都保留 fence/attention，不能用较早的 Store proof 掩盖这段 await 期间的变化。该末次只读复核由 project lifecycle 与 deleting reservation 保护（正常删除还持有冻结 lease bundle），直接读取 strict header census，不排到 Store 的展示全文扫描后，也不恢复 quarantine 或写派生缓存；出现 quarantine 就拒绝。初始 `readConversationIds/readConversationLineages` 仍串行恢复 orphan 后再观察，不得用这个末次 guard 替代。
- 每个被删 conversation 只清理 `toConversationId` 等于它的 pending inbox；一次 inbox census 必须捕获整个批次的 tombstone、sidecar 路径、owner、fingerprint 和序列化 payload，随后只可删除仍精确匹配该 capture 的 P 个 sidecar。source 仅在同一 frozen physical deletion batch 中，或由本次 `ProjectStore` final namespace proof 明确证明 absent 时，才可跳过 terminal card；后者没有可见 transcript/audit surface。proof 中仍 present 的 external source 是本事务关联的 writer，必须在 transcript batch 已最终证明后、captured sidecar 删除前经安全写入校验并成功持久化 terminal card；其正文损坏、`undefined`、找不到 card 或写失败都必须保留 target fence 与 sidecar 重试，不能把这类关联 source 当作无关历史而跳过卡片，也不能按缓存或打开失败推断 absent。它此前发往其他会话的 outbound envelope 不随来源删除，除非接收方也在同一个 cascade set 中随后被删除。
- `lastConversationId` 只在仍等于目标时清除，避免覆盖另一连接刚提交的最近对话。删除成功后更新派生缓存并通过项目订阅发布新 snapshot。
- 删除不存在的干净目标是幂等成功；目录损坏、链接、身份错配或文件系统拒绝删除仍 fail closed。

“回到此处”是当前 conversation 内的物理后缀截断，不是 branch 或浏览器隐藏：

- snapshot 的 user ID 直接对应 Pi message entry，assistant 聚合 ID 的 `assistant:` 后缀对应该聚合首个物理 message entry；所选 entry 及其后 context-bearing branch entry 会删除，更早行保持字节不变。唯一 ledger 例外是 suffix 中的 `piweb.message_delivery_receipt.v1` 及其引用的 `piweb.run_settlement.v1`：它们必须原子保留并重挂到 retained parent，避免 rewind 令已投递消息或已结算 run 复活；这种只为 receipt 保留的已剪枝 settlement 必须剥离 output metrics，不能把已删除 run 的 UI 速率复活。
- 只允许 idle actor 执行；目标还有 queued/processing inbox 时拒绝，避免截断恢复账本后重复投递。已经送达其它 conversation 的外部效果不回滚。
- store 在项目会话串行边界内用既有 exact-target proof 重新证明唯一合法 header claim 与目标完整正文；一次 inspection 的物理 entries 与非空原始行配对，复用解析结果并保留 retained 行原字节。候选仍须完整验证，临时文件写完后复验规范路径及完整 fingerprint（dev/ino/size/mtimeNs/ctimeNs），再原子替换；非 message、inactive branch、已观察到的身份冲突、文件变化、链接或损坏都拒绝覆盖。此边界不提供跨进程目录锁，proof 结束后的外部 namespace 变化仍可能在提交后的发现阶段才被检测。
- 目标 rewrite 不以所有无关正文或 SDK 全量索引为授权前提；提交后复用目录 discovery 更新展示与成员观察，不把发现缓存升格为 writer/open 授权或完整正文证明。Agent 全量列表与 audit 仍走独立的 full proof；cascade delete 使用上述目标批次证明。
- durable 替换后，同一 actor 必须 reload SessionManager，并从 retained active context 重建 runtime、永久 runId 集合和压缩阈值。提交后的 discovery 失败须明确报告 `ConversationTruncateCommittedError`；actor 用 fresh exact open 恢复 retained runtime，并将项目目录覆盖标为 unknown。只有精确证明或 runtime 重建失败才进入 fatal，禁止用旧 parent 继续追加。

Project store handle 按 canonical cwd 引用计数；ProjectSessionCoordinator 在项目 actor 生命周期内保留一个共享 handle，socket server 关闭时统一释放。`project-store-registry.ts` 整体拥有 handle 复用/refcount 与 conversation writer/deletion lease 的 FIFO 状态机；磁盘 namespace、catalog 和 proof 仍只归 `ProjectStore`。registry 末次 release 后逐出 store；相同路径随后代表一个新项目时必须重新读取磁盘身份，不能让缓存反向覆盖项目生命周期。

## Conversation profile 与 reserved entries

新 conversation 在 header 后、AgentSession 创建前写唯一 base `piweb.conversation_meta.v1`：完整冻结角色、`normal` lifecycle、`createdBy` 和可选 orchestration。正式打开必须已有合法 profile；缺失整份 profile 不会被猜测性的“旧会话”快照补齐。角色定义/切换由[协作页](kb-agent-collaboration.md#角色)拥有；缺字段的兼容承诺另见下节。

| 记录 | 持久职责 |
|---|---|
| `piweb.conversation_role_change.v1` | 新完整角色及有效服务层级；重置 branch thinking 为角色默认 |
| `piweb.conversation_card.v1` / `piweb.conversation_message.v1` | outgoing 展示 / incoming 模型正文；不是永久交付证明 |
| `piweb.message_delivery_receipt.v1` / `piweb.run_settlement.v1` | 不可 rewind 的交付账本 / exact run outcome；settlement 可选 outputMetrics 仅恢复 focused 输出速率 |
| `piweb.meta_operation.v1` | 破坏性 meta 工具的 started/completed 幂等意图 |
| `piweb.compaction_threshold.v1` / `piweb.service_tier.v1` | 会话覆盖，不进入模型上下文；阈值 20%–90%，缺省 70% |
| `piweb.loop_list.v2` / `piweb.loop_list_continue.v2` / `piweb.edit_gate.v1` | 任务快照、同 run 续跑、首次 builtin 写入已准入证明；状态/续跑见[Actor](kb-agent-collaboration.md#looplist-状态与续跑)，写入准入见[工具策略](kb-tool-policy.md#首次写入-looplist-门控) |
| `piweb.compaction_resume.v1` / `piweb.context_hint.v1` | 隐藏 custom message，不恢复宿主状态、不投影卡片；resume 只携带合法 runId，hint 是有界字符串且无 details |
| `piweb.bash_task_notification.v1` | 标准 custom message 的完成事实，不是跨重启执行 registry；详见[运行时](kb-server-runtime.md#前台-run-与会话后台-bash) |

类型及 canonical payload 以 `conversation-meta.ts` 的 reserved registry 为准，未知 `piweb.*`、重复 profile、冲突 settlement、方向变化或畸形 payload 均 fail closed。新增宿主条目必须同步写入端与读取端。

同 cardId 只投影最后状态；来源/目标/正文/委派身份/fingerprint/冻结角色不可变化，状态与时间只能单调前进，runId 一旦出现即固定，terminal outcome/result 不可改写。settlement 只能从未报告推进到已报告。角色、阈值、tier、thinking 和 LoopList 按 active branch 聚合；永久 run settlement ledger 读物理全集。模板或目录刷新不改写冻结 identity；role-change 重置 thinking，后续 Pi thinking record 再覆盖。rewind 的 runtime 重建与 shutdown 写入边界见本页“回到此处”。

严格兼容读取仍包括 canonical v1 LoopList、有效旧 edit-budget journal、退役 `piweb.bash_execution_notice.v1` 与合法 `piweb.wait_poll.v1`（旧 custom carrier，UUID runId、1–8 count、无额外字段）。它们不产生新条目、执行权限、Bash 存活或旧 poll/quota 状态；畸形旧记录仍拒绝。

## 兼容性合同差异

以下是既有合同与当前实现的差距，**不是通过知识库维护撤销兼容承诺**：

| 已承诺行为 | 当前实现证据与限制 |
|---|---|
| 旧会话快照的配置兼容：[AGENTS.md](../AGENTS.md) 要求缺 `compactionModel` 归 `null`；[线协议](kb-wire-protocol.md#决策) 也保留旧 defaultServiceTier 补 `null`、role-change 缺 selectedServiceTier 保留原选择的承诺 | RoleStore v1–v6 目录迁移已实现，保留 revision；但 [conversation-meta.ts](../src/server/conversation-meta.ts) 的 roleSnapshotSchema 仍严格必填，三个入口直接 parse，role-change 也要求 selectedServiceTier。[测试](../src/server/conversation-meta.test.ts) 明确拒绝这些缺字段形状。不能宣称旧 JSONL 配置已补值；整份 profile 缺失与单字段缺失是不同问题。 |
| [AGENTS.md](../AGENTS.md) 要求存量 `.piweb/pending-prompts` 一次性迁移后删除目录 | 当前 `src/` 未见该目录迁移入口；[reserved parser 测试](../src/server/conversation-meta.test.ts) 拒绝旧 pending_prompt_delivery/batch carrier。不能宣称目录已迁移，或把“拒绝旧 carrier”当成目录迁移实现。 |

涉及这些旧数据时应先补齐实现与兼容测试，或由用户明确修订合同；不要手工删除旧 sidecar、凭正文去重或追加猜测性的 profile 来绕过。新格式保持无持久 browser prompt 队列。

## 工作区会话数据修复

普通 initialize/open/audit 继续严格校验，不能边读边静默改写损坏数据。初始化失败和工作区打开对话框另提供“检查会话数据”入口：连接级 `inspect_workspace_sessions` / `repair_workspace_sessions` 只用 `cwd + commandId` 关联，在没有有效 focus 时也可操作，不创建空项目状态、加载项目扩展或启动 Agent。

- 诊断重新读取安全目录及会话文件；纯零尾、合法最后记录缺换行可保留全部有效记录。仅不以换行结束、仍未闭合的最后一个 JSON 对象 fragment，可在用户明确同意后丢弃。已经闭合的完整 JSON 后附垃圾、完整 JSON 的语义错误、中段损坏、非法 UTF-8、身份碰撞、header/tree/reserved ledger 错误不猜测修复，不静默删除或隔离会话。
- 修复计划绑定规范路径、完整 fingerprint 与内容摘要；服务端 fresh 复核且 fail-fast 取得全部目标 writer lease，已有 actor/writer 的文件拒绝覆盖。批次与既有 project lifecycle、Store 会话串行边界排序，新项目 context 不得看到半个修复批次。
- 原始字节先以独占新文件保存到 `.piweb/session-repair-backups/` 并完成 sync，再写同目录独占临时文件、sync、复核源路径/指纹并原子替换；修复后再次严格校验。备份不放入 `.piweb/sessions`，避免变成重复 conversation claim。多文件不是磁盘事务：后续失败仍返回已提交文件的备份路径和错误，不声称全批回滚。
- 修复不等于恢复门闩成功。存在失败 context 时，在原 lifecycle 内重跑既有 foundation，完成精确恢复证明后才允许 run；失败原因为诊断所见保留，不靠直接设 ready 或补造 receipt/settlement。空修复请求用于明确重试已无文件损坏的恢复流程。修复界面重新检查后仍通过普通 initialize 和权威 snapshot 进入，不取得额外执行权限。
- 默认 reload/close 等待已准入的修复控制命令。既有 `reload --force` 仍可中断处理，不能承诺回执、批次 exactly-once 或所有临时 artifact 已清理；备份在源替换前完成，临时文件校验后才原子替换。连接丢失只能进入“结果未确认”并 fresh 检查，不自动重发。

## 持久 inbox 与恢复

`.piweb/inbox/<messageId>.json` 是 transport sidecar，目标 JSONL 的 immutable delivery receipt 才是永久交付 authority：receipt 持久后即可释放 sidecar；delegation card 的 terminal outcome 另等 exact run settlement。发送/claim/FIFO/配额/wait attempt 详见[持久通信](kb-agent-collaboration.md#持久通信)，不在此维护第二套流程。

启动 foundation 先恢复 tombstone fence，再严格扫描 inbox 与按文件版本的恢复候选；候选 fresh exact inspect，先发现并落实 started abort，随后才允许 pump、idle prompt、直接 dispatch 或 reload continuation。发现不确定时 run-start 门不就绪，但 exact 只读 open/preview 仍可用。receipt-only abort 也必须写 aborted settlement，不能因为 sidecar 已删而重新 resume。来源卡片修复使用 raw manager/精确账本，不为已结算历史目标启动 actor，也不重建 rewind 删除的卡片。恢复等待使用 `settleFixtureRecovery` 或 background drain，不以 initialize 返回推断完成。

删除的批量 fence、namespace proof、captured sidecar 与 source-card 失败边界由本页删除流程拥有；末次 absence 证明及清理完成前不清 fence。inactive peek 的短暂 writer lease 也在项目 lifecycle 内，与删除精确排序。`.piweb/notebooks/<conversationId>.json` 的操作恢复由[Notebook owner](kb-tool-policy.md#agent-notebook-工具)管理，不在项目启动时全局扫描其临时 artifact。

## 首轮自动标题

- normal 且由用户创建的 conversation 在首次 browser run 启动时可异步生成标题：仅当从未出现 `session_info` 且没有 message/custom-message/compaction context 时，使用冻结模型（思考档位按模型能力钳到最省：能关就关，否则取最小可用档；避免 `minimal` 不受支持时被 SDK 向上钳到 `high`/`max` 后思考吃光共享的 `max_tokens`，例如 deepseek v4.1），经 captured runtime 的 `AgentSession.agent.streamFunction` 发起无工具、无 transcript 的隔离请求，携带该 Pi session 的 `sessionId` 与 `transport`，保留 SDK 认证、provider 请求头与重试边界，不启动 Agent turn。输出清理为单行并按 24 个 Unicode 字符裁剪；普通失败、15 秒超时或空输出使用候选“新任务”。actor 仍同步发布 `run_queued`，正式 `AgentSession.prompt(originalText)` 与主 run settlement 都不等待标题请求或标题持久化。
- 标题候选仅由 ConversationActor 易失持有；同一 captured runtime 仍健康、没有 active run/compaction/rewind/role switch 时才同步提交。任何 `session_info`（包括人工清空）都优先；任一 actor run 的 abort、fatal、dispose 或 runtime 替换都会取消候选，迟到或忽略 signal 的 provider 结果没有追加权。正常或失败的主 run 结算不取消标题，候选可在随后安全 idle 边界提交；不增加后台 run、持久队列或恢复状态。候选生成后，Coordinator 只可为仍存活 actor 的浏览器项目列表临时投影其名称，便于首轮长 run 及时显示；该 preview 不进入 ProjectStore catalog、JSONL、恢复或自动命名资格，失效时必须撤回。
- 提交沿用当前 writer-owned、已由宿主落盘并 reopen 的 SessionManager 的同步 `setSessionName()` 边界，不再另做完整 JSONL inspection 门。成功后更新项目展示；若 setter 已改内存再抛错，使用现有 session-persistence quarantine 拒绝后续写入并报告错误，不能回滚或改写已经完成的主 run settlement。此保证不泛化到尚未持久化的新建 Pi manager；全项目 catalog refresh 也不是 durable proof。

## 浏览器消息投递

browser prompt 没有持久队列；live admission、raw-message 对象身份和取消证明由[协作页](kb-agent-collaboration.md#浏览器消息准入)拥有，草稿/恢复原件由[客户端](kb-client-state.md#输入与恢复)拥有。旧数据迁移不能从这一新格式事实推导，见上面的兼容性合同差异。

## 证明与发现

- 使用项目自有的 custom `sessionDir`；不能依赖 Pi 默认 cwd 编码目录作为 project key。
- provider 上下文以 `SessionManager.buildSessionProjection().messages` 为规范视图；`buildSessionContext()` 委托同一投影。它按 active branch 应用最新 compaction、system state 与 `context_edit` 替换/省略；不能把 `buildContextEntries()` 中仍位于保留范围的旧 compaction 当成有效旧摘要。物理 `getEntries()` / JSONL 仍是完整 audit、tree 引用、永久账本与原始字节权威，不因 provider 投影排除而删除。
- current-leaf fork 从冻结 physical branch 的规范 projection 生成独立 child：只物化最新 compaction、有效 system message/compaction snapshot，以及已经应用 context edits 的 retained/post messages；不复制 context-edit carrier，不复活省略正文或旧 physical summary。`firstKeptEntryId === compaction.id` 是合法 retain-none self-boundary，child 仍以自己的 compaction ID 表达空保留范围。fork 保留有效上下文与角色配置，但重建 host lifecycle，不复制 run ledger、card、receipt 或 LoopList。
- 列举使用 `SessionManager.listAll(sessionDir)`，避免项目移动后被旧 header cwd 过滤；但不能信任它的完整性，因为 SDK 会静默跳过部分损坏文件。
- Agent 完整列表与显式 audit 的索引刷新都先后快照受控目录中的全部常规 `.jsonl`，目录在 SDK 扫描期间变化会 fail closed。宿主完整读取每个文件，验证尾换行、逐行 JSON、有限数值、header identity，以及当前格式的 entry payload / tree 引用；随后要求 SDK 索引与该磁盘全集按规范路径和 ID 精确一一对应。
- 单目标 preview/open 不依赖该完整索引：用 file descriptor 读取每个受控常规文件的有界首行，只把能通过 session header 验证的同 ID 文件当作 collision candidate；随后稳定读取并完整验证目标。头行无法在上限内解析的文件没有 identity claim；I/O、路径或扫描期不确定性不能被当作无关。proof commit 复验所有 target candidate 的 path/inode/header claim，正常无关 body append 不改变该 scope。
- 宿主复用同一次稳定读取的完整 parse/inspection 结果，并随 verified read 返回给消费者；Pi SDK 自己的索引扫描仍是独立的完整性比对来源，不能省略。常规 metadata 不保留物理 entries，需要物理记录的消费者才显式 opt-in。同名重命名的持久化复核直接从这次 inspection 的物理 entries 倒序读取最新 `session_info`，不能用 active branch 或内存标题代替。namespace/header census 与前后 fingerprint 校验保持独立，不把该复用扩展成跨 lease 或跨 operation 的 raw/inspection 缓存；跨 operation 只允许复用下述 fingerprint 校验回执。
- 冷批量 `inspectConversations()` 只临时保留本次完整证明实际全文检查过的请求目标 inspection；整个 proof 成功后核对其 ID、规范路径和完整 fingerprint，并在 catalog publication await 之后复验全目录安全 fingerprint 集合，才可返回。失败或重试丢弃该 attempt 的 inspection；warm catalog 或校验回执没有 fresh inspection 时仍稳定重读目标。该交接不改变 catalog/回执的长期结构，不用 discovery 授权，也不省略删除后续 quarantine、side effect 与 unlink 的复核。
- 完整证明按文件保存进程内校验回执：键是规范路径，值是最近一次成功完整证明观测到的 fingerprint（`dev/ino/size/mtimeNs/ctimeNs`，不含 atime）及它证明出的 conversationId。下一轮只对 fingerprint 逐字段相同的文件跳过 `readFile` + `validatePiSessionFile`；指纹变化、路径缺失或路径安全失败一律完整重读重证，并且每轮仍重新证明当前安全文件全集、重复 ID、SDK 索引一一对应、全部 summary 与 before/after 集合相等。回执是文件版本身份令牌，随 `ProjectStore` 生命周期消失，不落盘、不跨 lease、不跨进程；same-fingerprint ABA（伪造 mtime/ctime 以隐藏损坏）不在保证内，不接受该假设时只能退回每次完整重读。
- 打开时第三个参数传当前 canonical cwd；JSONL header 保留原 cwd，运行态使用新位置。旧会话允许 header cwd 缺失或为空，但存在时必须是字符串。
- 新 Pi manager 默认要到首条 assistant 消息才创建文件。工作台一次写入合法 header 和 conversation metadata 后丢弃 pending manager，再用公开 `open()` 重开。
- `SessionManager` 没有 flush/close/fsync，也没有内建锁；正常 append 是同步 JSONL 写入。
- writer lease 必须先于 `open()`；宿主只接受当前 v3 header，严格审计同时覆盖先前 Pi 0.85 v3 fixture 与 Pi 1.0.0 的合法 payload，不接受 v1/v2 header，也不让 SDK 原地迁移用户文件。Pi 1 合法形状包括 `usage` entry、带祖先 target 与角色匹配 replacement/null 的 `context_edit`、`role=system` 的 sections/tool delta、compaction `systemMessage` snapshot，以及 assistant `pending/deferred` stop reasons 和对应可选 payload；未知字段、非法值、跨分支 edit 与非有限 usage 仍 fail closed。
- coordinator 打开已有对话时最多等待旧 writer lease 5 秒；等待队列 FIFO 且可取消。actor singleflight 确保浏览器和 Agent 不会因并发 open 获得第二个 writer。cold focus 被后继导航取消时，只结束该 PiConnection 对 shared opening 的等待；coordinator 自有的 singleflight、lease、文件打开和 actor activation 继续结算并供后续调用复用。
- `open()` 前宿主再次验证文件非空、以换行结束、每条非空 JSONL 可解析、所有数值有限、compaction `tokensBefore` 非负、首 header 身份匹配，并且 entry ID 唯一、parent/label 引用有效、compaction 保留点属于当前分支祖先链或合法 retain-none self-boundary。宿主 reserved entry 还必须绑定该 header identity：outbound card 的 source 与 inbound message 的 target 都必须是当前 conversation，不能把另一会话的合法记录搬入本文件。branch summary 可引用已有节点，或使用 Pi 合法的 `parentId=null + fromId=root` 哨兵。crash partial tail 或“合法 JSON、非法 Pi entry”都会 fail closed，不能被 SDK 静默跳过或恢复成空历史。
- 第一版只有进程内租约；跨进程文件锁尚未实现。

## 项目权限边界

工具权限属于用户级角色模板，并进入 conversation 当前角色快照；project manifest 没有 `toolMode`，也没有修改权限的线协议。

`.piweb` 是宿主持久目录。Agent 在 read_only 中不能写入，但宿主保存 transcript 不受只读模式影响；full_access 不额外保护该目录。

## 浏览器投影

持久真相不直接等于网络载荷：

- `PublicState` 是高频、小体积运行状态。
- `role_catalog_snapshot` 是低频用户角色目录及当前可用性。
- `project_snapshot` 是低频会话索引，包含服务端解析的 root、固化 role 摘要、activity、必填 `compacting`、attention；底层会话仍平级，浏览器可按 root 聚合导航。`compacting` 仍由 warm actor 唯一拥有，独立于 activity/busy/run；cold/durable/cache 观察明确投影 `false`。compaction 边沿由 coordinator 发送 summary-only `project_summary_changed`，连接只从 current index 重投影项目快照（coverage 为 `unknown`），不能触发 focused transcript、state rehydrate 或 run mutation。它还带 `coverage`：fresh discovery 证明完整安全且唯一的 header 成员集合后是 `complete`，并不声称全部正文已重新校验；cold/recent 当前索引 seed 是 `unknown`。count 与 JSON byte 裁剪把 compacting 会话作为保留候选，并优先保留完整 root 组；任何省略都置 `truncated`；后台 actor 变化只更新索引，不会切换 current focus。
- `project_activity_snapshot` 是进程级已加载项目的有界汇总，只投影 busy/attention 计数；它不复制会话索引、浏览器 unread 或 transcript。
- 浏览器分别维护最多 4 项 workspace LRU 与 8 项 conversation presentation LRU，让工作区或同项目会话切换时立即画出目标上一帧；两者独立逐出，只存在内存，不接管 transcript、不保存 draft/pending command，也不能解锁命令。conversation cache 以 workspace/project/conversation 为键，保存 reducer 产出的 ChatState 展示引用及角色/window/control 投影，但绝不 hydrate 回当前 reducer。新 observation/focus 仍必须 exact open durable conversation，并以匹配新完整 focus 身份的服务端 snapshot 覆盖缓存。只有 `coverage: "complete"` 且非截断 `project_snapshot` 的缺席才能证明条目已删除；`unknown` 或截断快照不能据此逐出。
- `conversation_preview` 是 command-correlated、无 focusId 的 cold 只读投影：常规 `inspectConversation(s)` 只返回 metadata，绝不附带或复制物理 entries；只有单目标 `inspectConversationPresentation` 在完整性证明后 opt-in 返回本次 JSON parse 新拥有的 readonly entries 浅数组。只读 adapter 从最后物理 leaf 沿 parentId 还原 active branch，getter 只复制数组壳，canonical projector 不修改 entry，再经 peer enrichment 与最终 window pipeline。投影构造失败只跳过 preview，文件完整性/read/identity 失败仍 fail closed。它不取得 writer lease，不创建 SessionManager/AgentSession/model catalog/extension route，也不能启用任何 focus 命令；actor 或 actorOpening 已存在时禁止发送磁盘 preview，emit 前还要同步复核一次 actor/opening/deleting/closing。
- `conversation_snapshot` 是当前 focus 的一次性 active-branch 权威投影，包含固化角色和 message/session_message/compaction/bash_task_notification discriminated items，并限制总字节以及单消息/tool/card payload。投影只有一条 canonical pipeline：捕获 durable physical slots → 用 raw SDK message 对象身份把已持久化 live message 精确交给 durable slot → semantic fold → peer enrichment → 一次最终 exact-JSON-byte window。不能按角色、文本或数量猜测交接，也不能分别裁 durable/live 后再拼接。session-message 的 peer enrichment 只能同步给 `peerPresence: "unknown"`；`ProjectStore` 的完整稳定 header census 在 coordinator lifecycle 内异步解析后，才以同一 projectionSeq 的 `conversation_item` 重投影当前仍匹配 view/actor/focus 的可见 card 为 `present/absent`。该 proof 不读/信任 catalog 或 transcript body，失败、目录/header 改动和 view 失效保持 unknown；它不承担 exact open 的完整性证明。
- 每条物理 user/assistant message 在任一时刻只能由 durable slot 或未持久化 live suffix 一方拥有。Pi 对 user 的 start/end/persistence 复用同一对象，但 pi-agent-core 的 assistant `message_start` 是 partial 浅拷贝，真正被 AgentSession 持久化的是 `message_end` 的 final 对象；因此 assistant live slot 必须在 end 时改绑 final identity，不能把 start payload 当成 durable identity。browser 初始 prompt slot 也只能绑定首条 user，后续 steer 不得覆盖它。exact handoff 后 durable item 保留当前 runId；live tool 状态只可覆盖尚无 durable tool result 的 pending 工具，一旦 JSONL 已有 result 就由 durable 状态获胜。compaction、user/steer 与卡片首次出现是时间线语义边界；不再保留“最后一次 compaction 后才使用 live”的特判。
- 最终窗口优先保留完整的最近语义 turn；最新 turn 自身超限时保留连续有序后缀，不能跳过一个超大 item 后再捡更早的小 item。非空来源必须至少投影最新 item；单项也按最终 `JSON.stringify` 的 UTF-8 bytes 自适应缩略，避免 JSON 转义把合法原文放大后得到空快照。`window.omittedBefore / startsMidTurn / contentTruncated` 精确描述覆盖范围，任何省略都不会删除 JSONL。
- `conversation_snapshot.bashActivity` 是当前 Actor 的 transient 聚合 `{ running, stopping, cleanupUnknown }`（总计最多 8，idle 也可非空） 或 null；只用于 focused 实时展示，不从历史句柄/摘要推导，不进入项目索引、PublicState、localStorage 或重启执行恢复。
- `conversation_snapshot` 携带当前 focus 的 admitted 项（`pendingPrompts`，`promptId + text`，最多 64 条）；它不进入高频 PublicState，也不使用 window，用于断线/多窗口恢复"等待中"列表。`compaction` 直接来自 Pi 的持久条目，位于压缩发生处；它作为独立小型 turn 保留。
- live run 仍按 runId 发送增量，卡片按 cardId upsert；恢复时 reducer 用 snapshot 原子 hydrate。两者都必须匹配 `sessionId + conversationId + focusId`，匹配快照到达前 composer 保持禁用。卡片更新若改变最终窗口成员，单条 upsert 无法表达淘汰，服务端必须改发完整 snapshot。
- Agent 的 `peek_session` 有意省略 compaction 分界项；它是用户界面元信息，不应增加 peer Agent 上下文。peek tail 同样按最终序列化字节裁剪，并保证 limit 非零且来源有可见 item 时不会因最新单项超限返回空列表。

## 故障语义

- actor 创建、extension activation 或固定模型校验失败时必须 dispose 新 runtime、释放 lease，并清理半创建 conversation。
- focus change/reinitialize/disconnect 只使浏览器观察 epoch 和 UI route 失效；后台 run 与 actor 保留。真正 server close 才统一取消、settle、dispose 并释放 conversation lease。
- 项目清单无效、状态目录是链接、JSONL 是链接、日志截断/损坏、非有限 JSON 数值、畸形 entry/tree、Pi 索引遗漏/错配或身份在 open 时变化都会 fail closed。普通读取不覆盖原件，也不能静默回退到另一条 recent 对话或新建对话；用户明确进入的会话数据修复流程仅按上述窄范围、备份与复核合同改写。
- 断线不会停止 coordinator-owned run；重连用新 sessionId/focusId 重新观察同一 conversation，并从 durable JSONL hydrate。coordinated `initialize/open` 会直接发送当前 focus 的 `conversation_snapshot`，即使 actor 仍在 `waiting`；因此 `wait_for_session` 已持久化 toolCall 但尚未持久化 result 时，恢复快照必须显示 `pending`。普通 `refresh_view` 则只在 actor idle 且未 compacting 时发送 focused snapshot。
- `lastConversationId` 只是恢复提示；索引是派生状态，丢失/陈旧时可从 sessionDir 重建。focus 已成功但该提示后台保存失败时不回滚 focus，并只向仍匹配原 focusId 的当前观察报告错误。

## 当前边界

- 没有 archive、用户多选批量删除、import、附件和跨设备同步；Agent 会话列表只有有界 cursor，不构成浏览器历史分页。
- Agent 完整列表与显式 audit 仍完整验证全部 JSONL 并与 Pi `listAll()` 对照；cascade delete 只完整验证冻结目标批次，另以 fresh header/base 谱系和最终 namespace 证明关系与 absence；完整证明回执只在进程内复用。启动/浏览器另用 path-keyed catalog v3：持久化有界展示摘要（role 不含 systemPrompt）和单一 `recoveryNeeded`。只有 canonical path、dev/ino/size/mtimeNs/ctimeNs 与 header 完全相等才跨重启复用发现；每轮仍重证安全目录、稳定 header 全集与唯一 identity。缺失、旧版、损坏或变更只使对应文件重读；不能把 I/O/inspection 失败记成无工作。发现不调用 SDK `listAll()`，不填充完整证明回执，也不能替代 exact target proof。目录观察提交仍受 owner/CAS 与 actor projection revision 保护；一个活跃文件的更新不得丢弃全部未变文件观察。跨重启负向发现要求 catalog 为宿主产生且未被另行篡改；格式合法的假阴性 cache 篡改及 same-fingerprint ABA 不在保证内。持久 cache 仍限 4 MiB：超限只保存能装入预算的稳定观察前缀并标 `coverage: "unknown"`，进程内保留完整观察；冷重启只重读预算外的未知行，不因超限清空所有加速。该 cache coverage 不替代当轮完整成员证明。删除 cache 安全但会重新建立观察。
- 压缩只减少模型上下文，不物理缩小 JSONL。单会话 cold open 仍需目标完整校验与 SDK 全量加载；本次目录发现优化不承诺这笔成本随当前上下文大小缩小，也不删除旧消息、图片或账本。
- 没有跨进程 writer lock 和断电级 durability。
- Pi JSONL header eager materialization 依赖锁定 SDK 的 v3 session format；升级 SDK 时必须用测试验证 header/open/list 行为。
- `.piweb` 可能包含敏感内容；Git 忽略策略由项目所有者决定。

## 入口

- `src/server/project-store.ts`
- `src/server/project-store-registry.ts`
- `src/server/session-file.ts`
- `src/server/project-snapshot.ts`
- `src/server/conversation-history.ts`
- `src/server/conversation-projection.ts`
- `src/server/conversation-meta.ts`
- `src/server/project-inbox.ts`
- `src/server/conversation-notebook.ts`
- `src/server/notebook-tools.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/conversation-extension-ui-router.ts`
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
