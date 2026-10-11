# Agent 协作

`updated: 2026-10-06`

## 这个模块是干什么的

Pi Web 把同一项目中的每个持久 conversation 运行成平级 Agent。工作台只提供角色、观察、通信、等待和生命周期原语；UI 不建立父子树或固定总指挥，但生命周期删除会使用持久来源谱系清理 descendants。

```text
用户 prompt / inbox 消息 / Agent 工具
→ canonical cwd + conversationId
→ ProjectSessionCoordinator
→ 唯一 ConversationActor
→ Pi AgentSession
→ durable settlement / inbox / card
```

## 角色

- `RoleStore` 是用户级严格 v7 目录，`<Pi agent dir>/piweb/roles.json` 保存角色元数据与受控 Markdown 引用，提示词正文位于同级 `role-prompts/<roleId>.<revision>.md`；角色目录不由项目文件定义或重定向。角色 ID 按大小写不敏感唯一校验；RoleStore 对上层仍投影完整 `systemPrompt`，浏览器协议和管理界面不观察文件边界。
- 角色包含稳定 ID、revision、名称、简介、system prompt、固定 primary provider/model、必填 nullable `compactionModel`、模型默认思考强度、nullable 默认服务层级、`read_only | full_access` 工具权限，以及 `canManageSessions` 能力；模板、draft 和 frozen snapshot 都保留该字段，`null` 跟随冻结 primary model。当前格式要求字段完整；RoleStore v1–v6 目录迁移会补 `compactionModel=null` 且保留 revision。旧 conversation/card/role-change 快照的补值承诺与 strict parser 不一致，见[兼容性合同差异](kb-project-sessions.md#兼容性合同差异)，不要与模板迁移混为一谈。提示词文件必须与角色 ID/revision 精确匹配、是有限合法 UTF-8 的常规文件；每次读取重新 hydrate，因此外部编辑会影响后续模板读取，但没有 watcher 主动广播。读取使用同一打开句柄的有界内容，lstat/fstat 身份可用时复核，平台没有 O_NOFOLLOW 时不伪造保证。创建/更新先原子写新 revision Markdown，再原子替换 manifest，旧版 inline prompt 会保真迁移；成功重开时只清理严格受控且未引用的 prompt orphan。损坏、缺失、未知字段和未知版本 fail closed。更新使用 expected revision 加 UI base 的 expectedSystemPrompt，旧版角色的默认思考强度为 `off`、默认服务层级为 `null`、工具权限为 `read_only`、会话编排严格 opt-in。write tail 与 revision CAS 是单个 `RoleStore` 实例内的串行边界，不提供跨进程文件锁；同一 agent dir 不应由多个 Pi Web 服务并发写角色目录。
- 每个工作台 Agent 都能读取任意角色的完整定义，因此角色 system prompt 会进入调用模型和来源 conversation transcript，不是秘密存储，不得放 API Key 或其它敏感值。Agent 只能通过 `propose_role_revision` 提议完整替换 system prompt；用户在 conversation-scoped editor 中取消时不写，完成后宿主才按 expected revision + captured base prompt CAS 写下一 revision。取消有效到 `RoleStore` 的 commit 开始：入队前、排队任务开始和 commit 前都检查宿主创建的 `AbortError`，一旦 commit 已调用就按已授权提交处理，不尝试虚假回滚。CAS queue race 若基线已变化返回结构化 `stale`，基线未变化则继续抛出原始 I/O/可用性错误。名称、简介、模型、思考强度、默认服务层级、工具权限和会话管理能力均由旧模板复制，工具参数不能提交这些字段。
- 初始化“默认 / 默认角色”只是首次展示模板，可以像其它角色一样编辑、删除，删除后不会重建；新会话仍必须显式选择角色。
- `RoleCatalog` 用当前项目 actor 的 session-local 模型目录动态计算模板是否可用，因此项目静态 provider 也能参与选择；空项目使用 coordinator 持有的 project model catalog，它经过相同 trust/resource/provider 校验，但不会创建隐藏 AgentSession。角色 CRUD、模型列表和 API Key provider 校验都使用这条项目目录；非空默认服务层级还必须由固定模型的请求路由显式声明支持。显式 `compactionModel` 也必须当前可用、contextWindow 为有限正数且不小于 primary；主模型或压缩模型变化时都重验。目录漂移可使模板 unavailable，但不会阻止已有 frozen conversation 打开；每次默认压缩仍 fresh-resolve 并重验，失败不回退。真正创建仍会由 `PiRuntime` 在项目资源加载后再次校验固定模型。
- 新会话把完整角色修订（包括 primary model、nullable `compactionModel`、默认思考强度、默认服务层级、工具权限与会话管理能力）复制到 `piweb.conversation_meta.v1`；用户和 Agent 创建的队友都从这份冻结快照取得初始服务层级与压缩模型 identity。之后修改或删除模板不会自动改变旧会话；用户可在 idle 边界显式应用一个当前可用模板，宿主追加同时携带新有效服务层级的 `piweb.conversation_role_change.v1` 并用同一 SessionManager 重建 AgentSession，失败补偿也用一条记录恢复旧角色与旧有效层级。角色 prompt 追加到会话 system prompt，实际模型与初始思考强度必须与当前快照完全一致，SDK fallback/clamp 会被拒绝。新写入的 metadata 与 role-change 必须携带完整字段；已有快照的合同差异由[持久会话页](kb-project-sessions.md#兼容性合同差异)统一记录。
- 正式打开前必须已经有当前格式的冻结 conversation profile；缺失 profile 或 role snapshot 的 JSONL 一律拒绝，不追加猜测性的兼容快照。
- extension startup 后冻结完整 normalized prompt/tool topology，不能只冻结 rendered system prompt：`before_agent_start` 返回的 `systemPromptOptions` 全字段（含原地修改）、运行期 active tool set 和 registry refresh 都受边界检查。selected tools、sections、context files、skills、tool snippets/guidelines 和 prompt guidelines 也属于 provider prefix；角色切换/rewind 只能通过受控 runtime rebuild 建立新 topology。

## Actor 所有权

`ProjectSessionCoordinator` 由 socket server 共享，并按 canonical cwd 维护项目上下文。每个 `canonical cwd + conversationId` 最多一个 `ConversationActor`：

- actor opening singleflight，浏览器和 Agent 打开同一会话会复用 actor 与 writer lease；
- actor 持有 conversation-scoped LoopList，其状态/续跑见下一节；首次 builtin 写入准入由[工具策略](kb-tool-policy.md#首次写入-looplist-门控)拥有。
- 每个项目还 singleflight 建立一个无 AgentSession 的 project model catalog；空项目可据此显示项目扩展模型、管理角色和创建第一条会话，最后一个项目 handle 释放后统一 dispose；
- actor 原子拥有角色快照（含冻结的 primary/compaction identity）、`SessionManager`、writer lease、隔离的 settings/model registry、`AgentSession`、唯一 `activeRun`、串行队列和观察者；coordinator 将该完整 frozen identity 传入每次 runtime create/reopen/switch/rollback/peer 路径；
- `activeRun` 的 `queued / running / waiting / cancelling` 是侧栏 activity 与 busy 的唯一来源；
- 浏览器切换焦点只更换观察者，不 abort、dispose 或暂停后台 actor；
- coordinator close 会同步封闭新 lifecycle 入队并结算全部 extension UI/waiter，排空关闭前已接收的 lifecycle task 后再释放资源；尚未开始的 task 在任何持久写前失败，不能让 close 返回后继续追加卡片。迟到 actor/catalog 会立即 dispose，随后清理包括无浏览器观察者在内的全部 actor、后台恢复任务与项目 handle。

`PiConnection` 不再拥有 conversation 生命周期。它只拥有浏览器 project observation epoch、当前 focus、认证 flow 和 extension UI broker。

### LoopList 状态与续跑

LoopList 是 Actor 权威的三态列表，不是 busy 或队列。仅 todo_read/todo_write/todo_pause 整表读写/暂停，允许多个 active，顺序只用于展示。新状态/continuation 写 v2；canonical v1 checked 仅在内存映射 pending/completed，绝不推导 active、不改旧 JSONL。

- todo_write 有未完成项就 armed；pause 保留全部状态。自然结束仍 armed 且有未完成项时，沿同一 RunTicket/runId 写隐藏快照并续跑，最多 8 次；完成/清空停止，异常/abort/上限暂停。重启/rewind 只恢复 active branch，不自动开跑，普通用户 prompt 可重新 armed。
- 锚点从 active-branch 全量快照及 updatedAt 重放，不新增持久字段：无序 item ID 集合变化重置 list/active，无序 active ID 集合变化只重置 active；list 从当前 plan 建立开始，active 仅有 active 项时保留。重排、改文案、pause 或不改变 active 集合的进度不重置计时，多个 active 共用锚点。
- updatedAt 取当前时钟、active branch 和全部物理 LoopList 记录最近时间戳之最大值，防回拨；可见计划/锚点仍只来自 active branch，inactive branch 不覆盖它们。
- exact run 恢复读取该 branch 最新 continuation，从下一序号继续，8 次上限跨恢复累计。严格审计要求 continuation 规范快照匹配最近祖先列表、armed 且未完成、同 run 在该 branch 从 1 连续递增至最多 8。
- 首次写入 latch 见[工具策略](kb-tool-policy.md#首次写入-looplist-门控)；调用前的持久提示、分钟值与限频由[运行时](kb-server-runtime.md#执行任务提示)拥有；客户端只能只读投影。

### 浏览器消息准入

浏览器观察不控制后台 run。输入以 `promptId` 在 conversation JSONL 先持久准入、后发接收回执；live busy 走同步 owner/control 路径，idle 仍经 project lifecycle：先启动已有 inbox/receipt 工作，再持久准入浏览器输入并暂缓 SDK 投递，不能让它越过 durable work。只有 running/waiting、AgentSession.isStreaming 与 low-level agent.state.isStreaming 同为 true、没有 input extension handler 时才尝试 prompt(steer)；pre-stream/post-loop 窗口只保留持久输入，不启动无主 SDK run。steeringMode 固定 all，当前工具序列结束后一次注入已排队消息。

initial disposition 必须 started，busy browser/显式 steer 必须 queued，handled 不算接受。PiRuntime 用 invocation-scoped AsyncLocalStorage 包住异步调用，在 native agent.steer 真正 enqueue 前同步复核 exact ticket 并捕获唯一 user 对象，返回后再检查 disposition/admission。私有文本 mirror 可能先更新，不能按文本/长度回滚或 clearQueue 破坏并发合法输入。

持久未投递浏览器输入单会话最多 64 条、64 MiB；`prompt_admitted` 证明接收但不声称一定已进 SDK 队列，`prompt_delivered` 才证明投递。首个 raw user 无条件归 initial，后续 browser/explicit guidance 共用 SDK 接受顺序 FIFO，仅队头 captured object 与 raw object 同一引用时认领。同文扩展消息不消费记录，原地改正文不改变身份。AgentSession 的 raw `message_end` 在 appendMessage 前发出：宿主同步包裹同一 SessionManager 的 appendMessage，先写带 `promptId + 实际 runId` 的 delivery marker；只有紧邻、直接以 marker 为父的 raw user entry 才证明投递。孤立 marker 是可恢复崩溃间隙，settlement 不是投递证明。

`withdraw_prompt` 对已入 SDK 队列的对象只接受 exact 移除证明，已 drain 必须拒绝；尚未入队且不正驱动当前 run 的持久输入以 withdrawal marker 结算；当前 run 的初始 raw 输入不能假装可撤回。Stop 封闭当前 run admission、清 SDK 易失队列并 abort，但不撤销已接收、未投递的浏览器输入；它在 durable inbox 之后自动续投。已 drain/captured pre-ack 的 tracking 保留至 raw delivery 或 settlement，bulk clear、terminal、snapshot 缺席都不是逐条取消证明。不清 inbox durable 工作，不倒回已接受 input 引发的 wait 唤醒/Bash 迁移；客户端仅保留普通草稿与未确认回执，不建恢复副本。

### Extension UI

扩展 UI 只在线路上路由到当前被该浏览器 focus 的 conversation；initialize 声明 `extensionUi:"none"` 的连接（MCP 桥）即使 focus 也不成为 delegate，不会接走浏览器的对话框。后台 actor 暂无 UI delegate 时，请求留在 conversation router 中并把目标标为 attention，不会抢走用户焦点；用户切换到该会话后才发出对话框并可正常回答。等待 focus 期间仍遵守 extension 的 AbortSignal/timeout；切走 focus 会取消已经发给浏览器的旧对话框，项目关闭会用取消值结算全部待处理请求。角色提示词 editor 额外绑定当前工具调用的 AbortSignal：无 delegate 或已发到浏览器时取消 run 都会结算 router/broker pending、关闭对话框并禁止迟到回答落版。

## 持久通信

项目内布局增加 inbox：

```text
<project>/.piweb/
  project.json
  sessions/
    *.jsonl
  inbox/
    <messageId>.json
    target-<conversationId hash>.tombstone.json
```

每个 inbox envelope 是严格 v1 的单文件原子记录，保存稳定 `messageId/cardId`、来源/目标 conversation 快照、正文、消息种类、冻结来源 `fromRunId`，以及 `queued | processing`。新 admission 必须携带 exact `fromRunId`；旧文件仍可解析，但缺失该身份时在投递前 fail closed，不能按正文、当前 actor 或最新 run 猜测。processing 状态还可保存接收方 `waitedByRunId`；它让同一 receiving run 的后续 wait 不重复观察同一 messageId。sidecar 只负责 transport：目标 JSONL 持久化严格的 `piweb.message_delivery_receipt.v1` 后即可删除，不再占用单目标 64 条配额直至 run settlement。receipt 保存 source/target conversation 与 exact run、immutable payload fingerprint、delivery 时间；它是隐藏、不可 rewind 的 delivery authority，incoming marker 与 sender card 都只是可 rewind/可修复投影。目录、文件、身份、容量或内容异常都 fail closed。32 MiB envelope 容量按每条记录的最坏 processing 形态预留，所以已接受 queued 记录不会因状态字段增长而无法 claim；删除 tombstone 使用独立的 1 MiB / 1024 条预算，满 envelope reservation 仍能先建立 durable fence。scan 允许旧版 actual-fit、reservation 超限的目录打开并清理，但禁止继续创建，状态替换还会复核实际 next bytes，不能把兼容性变成越界。需要固定 initial runId 的 start_session envelope 在首次原子创建时就写成 processing，不存在先 commit queued、再二次改写的窗口。

发送的 authority 顺序：

```text
来源 JSONL 追加 sending 卡片
→ 原子写目标 inbox
→ 来源同 cardId 追加 queued 卡片
→ claim exact targetRunId 并投递 custom message
→ 目标 JSONL 持久写入 custom_message marker
→ 目标 JSONL 追加 immutable delivery receipt
→ 删除 transport sidecar，释放目标容量
→ best-effort 修复来源 card 投影
→ 精确 run settlement 持久化；delegation_task card 再随 settlement 终结
```

sender card 的 `running/delivered` 更新可因 active actor 的观察时点出现在 marker 两侧，但它不是 delivery authority。idle batch 必须先让 `startMessages()` 接受 exact targetRunId，再 best-effort 写 `running`，避免部分 card 写成功后回滚 transport 并在重试时换 runId。ordinary/result/failure 在 receipt 后投影为 `delivered`；只有 `delegation_task` 在 receipt 后保持 `running`，再由 exact settlement 投影为 `completed | failed | aborted`。receipt 已经持久化后，card 投影失败只标 attention，由 ledger 以后修复，不能继续占用 sidecar 容量。

- busy target 默认接收 steering：所有 peer message 种类都先持久转为 `processing(runId)`，再以 `piweb.conversation_message.v1` custom message 放入当前 Pi turn 的 steering queue；它在当前工具调用结束、下次模型请求前生效，不创建第二个 run。busy 注入必须真正进入该 live run 的 SDK steering queue；只在 turn end 把 custom message 追加到 AgentSession state 不算交付，因为 Pi 当前 run 使用启动时冻结的 context snapshot，正文不会进入该 run 的下一次模型请求。普通发送以 durable claim 为确认点，不等待 pre-stream SDK 内存队列，因此不会与项目关闭或 preflight 互锁。Pi 已写入 exact custom marker 后，coordinator 会在同一 target JSONL 物化 immutable delivery receipt；receipt durable 后即可删除 sidecar，无需等待该 run settlement。marker 前 abort/启动失败或 settlement 会恢复 `queued` 并按 FIFO 重投；marker 已有但 receipt 未写的崩溃由 reconciliation 补写 receipt；receipt 已有时绝不再次注入正文，即使用户后来 rewind 掉 marker。因此切换浏览器项目/focus、断线或进程重启都不能依赖内存 steering queue。目标 idle 时仍由 inbox pump 启动新 run。目标正通过 `wait_for_session` 阻塞时，wait 注册之后实际投递给其当前 run 的任何新 peer/inbox 消息（不再要求来源精确匹配所等 target）都会立即结算 wait 并返回消息真实来源 metadata；发送者若正处活跃 run，同一投递即返回 `delivered_to_wait`。wait 注册前已 claim 进当前 run queue 的未观察消息在注册时同样结算（见 wait_for_session 条目）。
- inbox commit 是取消边界：commit 前取消可拒绝，commit 后即使来源 run 随即取消，目标 pump 仍继续；同步启动失败会有界重试一次并保留 durable sidecar。
- 同一目标严格按 `sentAt + messageId` 投递；busy steering 也只能认领最早的未送 envelope，不能越过更早的 queued 或其它 run 的 processing envelope。
- 普通 inbox claim 每次最多批量投递 8 条。精确 wait 回复若排在该批之后，会先按 FIFO 把目标有界 inbox（单目标最多 64 条）中它之前的消息全部排入同一 steering queue，再排回复并结算 wait；否则未完成的 wait 工具会阻止前批 steering 被消费并形成死锁。through drain 中任一 predecessor（或 through envelope 本身）的 SDK steer 投递失败且无 durable marker 时 fail closed：把该 predecessor 恢复 `queued` 并 rethrow 原错误，由 `deliverEnvelopeToWaitingRun` 注销/reject waiter 并向 sender 抛错，through envelope 保持 queued，绝不回落到普通 claim 把 wake 消息误排入等待 run 后留下悬挂 waiter；普通非-through 批量路径仍保持异步 recover/return false 语义。这里的“批量”既描述 sidecar claim、FIFO 和 run ownership，也描述模型观察：steeringMode="all" 下同一轮工具序列结束后排队的多条 custom steer（含用户消息）会一次全部注入同一次模型调用。允许管理会话的目标 LLM 会收到来源标题、角色、完整 conversationId、正文、回复工具提示，以及“自行管理所创建会话生命周期”的提醒；关闭能力的角色只收到来源元信息和正文，不会看到任何会话工具名称或管理提示。隐藏提示只存在于 Agent 上下文，浏览器卡片仍只从 `details.body` 投影用户可见正文。
- incoming 消息使用 `piweb.conversation_message.v1` 并进入目标上下文；outgoing/委派状态使用 `piweb.conversation_card.v1`，只用于投影。`piweb.message_delivery_receipt.v1` 不进入模型或聊天历史，却永久阻止同一 messageId 被二次注入；幂等 replay 必须精确匹配整个 immutable envelope identity。
- 同一 `cardId` 的后续 entry 原地覆盖卡片状态；浏览器和重启恢复不会刷出多张重复卡。消息可能先因目标 run 启动进入 `running`，随后才因精确 wait rendezvous 追加 `delivered` 确认；该 `running → delivered` 转换是合法的异步观察顺序，之后仍可进入 terminal 状态。
- 每个 run 追加 `piweb.run_settlement.v1`，记录精确 `runId/outcome/finalText`，再通知等待方并终结 delegation projection；ordinary sidecar 已在 delivery receipt 后清理，不再等待这里。source actor 在 active run 上持有唯一 local wait attempt；发送、accepted input/receipt/settlement 查询和 attempt terminal CAS 均在同一 project lifecycle 边界线性化。不存在 target-keyed waiter 或 wait-for graph；扫描、aggregate、投影失败、fatal、abort 或 close 都不能留下 ghost attempt。等待返回 durable settlement 或精确目标 run 主动发来的 message metadata；消息正文只通过 incoming custom message 注入一次，不能在 tool result 再复制一份。message metadata 与 incoming custom message 必须同在恢复该 Agent 的一次模型请求中，调用者不应为取得正文再 `wait_for_session` 或 `peek_session`。
- 重启扫描 inbox，并从 ProjectStore 的文件版本发现观察取得恢复候选，再 fresh exact inspect 候选 JSONL；未变化且无工作的历史不重复全文读取。先完成所有 abort 意图的发现与落实，再允许 run 启动；发现不确定时保留未就绪门，不能由 idle prompt、直接 dispatch 或 reload 绕过。用 marker+sidecar 补写 receipt，以 `delivery receipt(targetRunId) − run settlement(runId)` 找出 receipt-only 未完成 run，不重投正文地恢复 exact run；abort 也必须覆盖无 sidecar 的 receipt-only run。待修来源卡片独立定位目标 receipt/settlement，用 raw manager 修复，不为已 settled 的历史 delegation 目标启动 actor；普通 `delivered` 卡片不重复候选。多个 run 候选或缺失精确来源身份都 fail closed。SDK custom-steer acceptance 若异步拒绝，coordinator 仍在 lifecycle 边界复查 marker/receipt/settlement，幂等 finish 或 dispose/reopen 后恢复精确 processing run，不能让无 settlement 的 claim 永久阻断 FIFO。
- receipt durable 后才删除 sidecar；来源 card 失败标 attention，以永久账本修复既有卡片，不能重投正文。inactive source 修复只用 raw writer lease，不启动模型 actor；rewind 保留 receipts 与所需 settlements，未结算 receipt 阻止 rewind。回投按 source 分组，每个源只 open 一次、复用本 pass lease，失败逐 receipt 记 attention。回投只在现场 receipt、该 run settlement 和启动 pending-card 修复发生；prompt 准入/显式 steer 只 aggregate target warm branch，不冷开来源历史。pump 按目标合并；失败保留 pendingPumps，由下一请求或恢复收尾重排。

## 上下文前缀与缓存

- user、assistant、tool 和 incoming custom message 的物理记录保持 append-only；新的宿主提示只附加到以后收到的新消息，不能回填或重写旧 entry。provider 的规范视图是 `SessionManager.buildSessionProjection().messages`，不是 physical entry 列表：它应用最新 compaction、system state 与 context edits，物理 JSONL 仍承担完整 audit/tree/账本权威。fork 同样保留该规范投影（含 retain-none self-boundary），不复活旧 physical summary 或已覆盖正文。
- 静默 `wait_for_session` 在四分钟后由 source actor 的 open local attempt 返回非错误 `{ outcome: "checkpoint" }`；它不证明 target 完成，仍需要结果时必须再次 wait，次数不设额度。poll 只在 accepted input、settlement 和 authoritative reachability 检查均未命中后发生；宿主不自行重试、预热缓存、做经济性判断或自动压缩。Pi 1 的 SDK session cache warming 也强制 `off`，只覆盖有效 SettingsManager getter，用户偏好不变且 teardown 恢复；预热 provider 请求不能成为用户 run。
- 当前角色完整修订由 base conversation metadata 加后续角色变更记录得出；重新打开会话使用最后一次成功应用的角色。角色模板后续编辑不会自动改变既有会话，只有用户显式切换才会从下一轮改变 system prompt、模型、默认思考强度、默认服务层级、权限与 meta 工具 schema。聊天页的思考强度控制仍只修改当前运行会话，不反写角色模板或角色快照。
- 卡片状态、run settlement、message delivery receipt、meta operation 和 conversation metadata 使用普通 `custom` entry；SDK 的 `buildSessionProjection().messages` 会忽略它们，因此状态更新既不改旧消息，也不污染模型缓存前缀。
- 当前会话可用 `piweb.service_tier.v1` 覆盖角色默认服务层级；没有该记录时使用冻结角色默认，显式 `null` 记录则覆盖为供应商默认。切换角色会重置为新角色默认，但不会把会话覆盖反写角色模板或快照。
- 会话阈值以非上下文 `piweb.compaction_threshold.v1` 保存，缺省 80%、允许 20%–90%，已有显式覆盖保持不变。摘要模型、Pi 接点、认证后 stream 捕获和失败边界只在[运行时压缩章节](kb-server-runtime.md#上下文压缩与安全停点)维护。
- 用户可在会话空闲时发送精确关联的 `compact_context` 命令手动调用 Pi 标准 `compact()`；运行中会话拒绝手动压缩，成功后重新发布 state 与 snapshot。Agent 可用 `reset_context({handoff})` 预约完整工具轮次后的同 conversation/run 工作上下文重置，不调用摘要模型，旧主动压缩工具已退役。accepted 不是提交证明；输入保护、拒绝条件与原生 retain-none 提交边界只在[运行时](kb-server-runtime.md#上下文压缩与安全停点)维护。`history_search/history_context/history_read` 从活动祖先物理历史恢复有界证据，Notebook/LoopList 仍由原 owner 持有。
- 明确例外会有意改变模型输入：Pi 在上下文逼近上限时追加 compaction summary 并以摘要替换活动上下文，原生 `context_edit` 通过新 entry 替换/省略投影中的旧消息，以及重新启动后项目资源本身发生变化导致基础 system prompt 变化。压缩是继续运行所需，资源变化反映用户真实修改；这些都不等于改写物理旧 entry，工作台不为提高命中率伪装旧项目状态。

## Agent meta 工具

每个 actor 无论工具模式和 `canManageSessions` 值都注入三个角色工具：

```text
list_roles
read_role
propose_role_revision
```

`list_roles` 返回有界角色元数据与 revision；`read_role` 一次读取一个角色的完整当前定义；`propose_role_revision` 要求调用方提交刚读取的 expected revision 和完整替换 prompt，只在用户 editor 提交后落版；prompt-only 提议的完整 draft 仍原样复制冻结的 compaction identity。提案可指向任意角色（包括调用者自身和 default），但不能创建/删除角色，也不能改认证、trust、既有会话角色或模型。prompt 已是目标值时返回 `already_current`；基线变化返回 `stale`；取消/中止返回 `cancelled`；用户改回基线返回 `unchanged`；成功返回新 revision。editor 返回后会重新读取基线，真正写入仍由 `RoleStore.updateRole` CAS 防止竞态。

只有 frozen role 的 `canManageSessions=true` 时，actor 才额外注入八个会话编排工具：

```text
list_sessions
current_session
peek_session
start_session
send_session_message
wait_for_session
abort_session
delete_session
```

`canManageSessions=false` 时不注册会话编排工具，也不向模型提供它们的名称、参数、说明、回复提示或生命周期管理提示。该决定只读取 conversation role snapshot；后续编辑角色模板不会改变已存在会话的编排 schema，因此不会破坏既有会话的缓存前缀。

- 工具闭包绑定来源 conversation 和当前 canonical project，不接受 cwd/projectId，不能跨项目；角色目录本身是用户级共享状态，但模型可用性仍按来源 actor 的 session-local model registry 投影。
- `start_session` 必须给 role 和 task，创建平级持久会话；inbox admission 出错先按 exact messageId 复查 commit：envelope 已存在则保留目标供 replay，确认不存在才终结 source card 并删除本次新建目标，防 orphan/sending 卡悬挂。工具指导要求 Agent 创建持久会话前先用 `list_sessions(scope=created_by_me)` 查找自己负责的现有会话，职责匹配时通过 `send_session_message` 复用，只有没有合适会话才新建。创建在冻结角色、初始 task 和固定 runId 被可靠接受并调度后返回 `conversationId + runId`。目标空闲时立即取得 run ticket；若更早的 run 抢先则持久等待泵送，不会隐式等待或挂起调用者。
- 运行时会话仍保持平级，但宿主在 conversation metadata 与来源 delegation card 中持久保存 `rootConversationId + depth + sourceRunId`。项目 summary 只向浏览器额外投影服务端已解析的 `rootConversationId`，不暴露 depth/sourceRunId；浏览器只按该 root 汇总“根任务 + Agent 成员”，不再维护“全部”扁平视图，也绝不从可能被截断的 `createdBy` 链自行求根。count 与 JSON byte 两个项目快照边界优先整组装入或移除；极端超大旧组才保留 root/current/高优先成员并明确 `truncated`。这些都是导航投影，不新增 Team 实体、层级运行时或组级生命周期。
- root 深度为 0，最多委派到深度 3；一个来源 run 最多消费 64 个 peer reservation，同一 root 最多保留 64 个 live descendants。per-run 计数来自来源 JSONL 的 append-only card，目标删除和重启都不能退回额度；live 容量只有 conversation 真正删除后才释放。创建来源与 orchestration identity 必须由当前 metadata 显式提供；删除一个 conversation 会级联其 metadata descendants。恢复中的 run 只依据可验证的当前 card/run identity 计入额度。
- `send_session_message` 必须同时给完整的 `message` 与面向人的 `summary`：summary 会 trim、拒绝空白，最多 500 个 Unicode 字符（2 KiB UTF-8），作为不可变 payload 写入 sender card、inbox 和接收 marker，并参与 idempotency/fingerprint；折叠消息卡片只预览它，展开时显示完整内容。`message` 才是接收 Agent 的完整模型输入，summary 绝不注入模型上下文；旧持久消息可无该字段，浏览器稳定投影为空字符串。调用必须在单个 `conversationId` 与 2–64 个唯一 `conversationIds` 之间二选一；多目标只是同一 payload 的有界扇出，每个目标仍拥有独立 message/card/receipt、目标内 FIFO 与返回状态，不建立群组实体，也不承诺跨目标原子性或观察顺序。可静态判断的空集、重复、自发或超限整批拒绝；运行期某目标失败会在有序 `results` 中单独报告，并继续尝试后续目标。批量调用把完整有序目标集、summary 与 message 纳入 fingerprint，并为每个槽位派生稳定身份，因此同一 tool call 的精确重放不会重复投递，改变目标集或 payload 则冲突。持久接收后返回；busy 目标仍保持当前 run。若目标正在等待发送者的精确 run，则该目标返回 `delivered_to_wait`，消息直接进入目标当前 turn，发送者仍可继续运行。
- `wait_for_session` 只接受显式 `targets` wait-any（调用时去重并冻结 1–32 个 `conversationId + canonical runId`）。source actor 将去重后的 targets 冻结在一个 opaque local attempt 中；任一 listed durable settlement 按冻结 target 顺序 terminalize attempt，再返回 settlement 并额外标明 `conversationId`。活动投影只显示 `targetCount`，不伪装成首个 target；不建立或检查全局 cycle graph。wait 会先读 durable settlement，再 observe-or-subscribe；也可由 wait 注册之后实际投递到当前 run 的新 peer/inbox 消息（来源任意 conversation/run，返回真实来源 metadata，消息正文只经 incoming custom message 注入一次），或用户 guidance 被当前 run 的 SDK steering queue 接受（显式 steer 与 busy 浏览器 prompt 共用同一 accepted-but-unobserved FIFO tracking，只返回 `outcome=guidance`，正文仍仅由 raw user message 注入一次，不伪造 peer identity 或重复正文）。wait 注册时若当前 run 已有 accepted 且未观察的 guidance，立即结算；每条 guidance 最多唤醒本 run 的一个 wait，并在其 raw user message_end 被认领时精确退休。消息到达后若仍需最终结果，Agent 可再次等待。任何消息/guidance、settlement、reachability、poll、取消或异常都只 terminalize source actor 的 local attempt 并恢复 phase；相互 wait 可以同时存在，宿主不为它们自动重试。
- `wait_for_session` 的 poll timer 只属于 source actor 的一个 open local attempt：到期后进入 project lifecycle，复核 opaque attempt identity、run ownership、accepted input、settlement 与 reachability，再 terminalize attempt 并返回 checkpoint；任何 settlement、message、guidance、abort、fatal、close 或 delivery reservation 先赢时都使 timer inert。
- Meta tool schema 为 provider 兼容只把 run identity 表达成有界字符串；`wait_for_session` 的每个 target 与 `abort_session` 的执行边界仍必须在进入 lifecycle、活动状态或 durable operation 前拒绝非 canonical UUID。不能把模型回传的未校验 runId 投影进严格线协议。
- `abort_session` 只匹配精确目标 run；stale runId 不会中止后来的 run。其精确目标与已决定结果也写入来源会话的 `piweb.meta_operation.v1`，同一 tool call 在结算或重启后重放仍返回原结果；若进程在 started intent 后崩溃，恢复会先精确中止/结算该 run，再允许 inbox pump 继续。
- `delete_session` 删除目标及其 metadata descendants；拒绝 self、会把自己级联删除的祖先目标，以及任何 busy 成员；需要先 abort、等待结算，再删除。删除 intent/result 以 `piweb.meta_operation.v1` 持久化，相同 toolCall 重放不能改删另一个目标。
- 启动会话的角色、task、title 和 lifecycle 进入 sender card 指纹，相同 toolCall 改 payload 会冲突而不是谎报成功。
- `peek_session` 不启动 inactive 目标的模型/扩展，不移动 recent；只返回 user/assistant 可见正文和会话卡片，过滤 thinking/tool/auth/internal，默认只看最近 2 项，工具说明提醒 Agent 通常先看最后 1–2 项即可，最多 20 项且完整 JSON 不超过 256 KiB。inactive inspection 与删除共用 lifecycle 边界，因此短暂 writer lease 会先释放，删除不会留下只能靠重启恢复的 tombstone。
- 列表和正文同样有界；Agent 看到稳定完整 conversationId，而 UI 可另显示短句柄。`list_sessions` 的每项显式返回 durable `createdBy` 与观察者相对的 `createdByMe`，并支持 `scope=created_by_me`，让 Agent 无需依赖对话记忆即可找回自己负责的会话；缺少 conversation profile 的条目不是可展示兼容对象，而是 fail-closed 完整性错误。

所有宿主工具仍经过项目扩展 hook、run ownership 和 source-aware tool gate；工具 availability/schema 不等于 authorization，Pi 1 system message 中的工具声明也不能授予角色权限。`list_roles/read_role/propose_role_revision` 是 `source=sdk` 的显式只读模式例外：前两个只读宿主状态，最后一个只有用户 editor 提交才写角色 prompt。八个会话编排工具仍只在 `canManageSessions=true + full_access` 时可用；扩展或项目工具即使同名也不能冒充 SDK 角色工具。`full_access` 仍允许通用文件工具访问项目外路径，不是角色目录的 OS sandbox，因此这里的人工确认保证只覆盖 `propose_role_revision` 工作流。

## 入口

- `src/server/role-store.ts`
- `src/server/role-catalog.ts`
- `src/server/conversation-meta.ts`
- `src/server/project-inbox.ts`
- `src/server/conversation-actor.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/meta-tools.ts`
- `src/server/pi-service.ts`
- `src/client/components/ConversationSidebar.tsx`
- `src/client/components/SessionMessageCard.tsx`

## 关联模块

- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
