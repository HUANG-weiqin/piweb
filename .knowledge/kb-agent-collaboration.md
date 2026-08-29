# Agent 协作

`updated: 2026-08-27`

## 这个模块是干什么的

Pi Web 把同一项目中的每个持久 conversation 运行成平级 Agent。工作台只提供角色、观察、通信、等待和生命周期原语；UI 不建立父子树或固定总指挥，但生命周期删除会使用持久来源谱系清理 descendants。

```text
用户 prompt / inbox 消息 / meta tool
→ canonical cwd + conversationId
→ ProjectSessionCoordinator
→ 唯一 ConversationActor
→ Pi AgentSession
→ durable settlement / inbox / card
```

## 角色

- `RoleStore` 是用户级严格 v5 目录，`<Pi agent dir>/piweb/roles.json` 保存角色元数据与受控 Markdown 引用，提示词正文位于同级 `role-prompts/<roleId>.<revision>.md`；角色目录不由项目文件定义或重定向。角色 ID 按大小写不敏感唯一校验；RoleStore 对上层仍投影完整 `systemPrompt`，浏览器协议和管理界面不观察文件边界。
- 角色包含稳定 ID、revision、名称、简介、system prompt、固定 provider/model、模型默认思考强度、`read_only | full_access` 工具权限，以及 `canManageSessions` 能力。提示词文件必须与角色 ID/revision 精确匹配、是有限合法 UTF-8 的常规文件；每次读取重新 hydrate，因此外部编辑会影响后续模板读取，但没有 watcher 主动广播。读取使用同一打开句柄的有界内容，lstat/fstat 身份可用时复核，平台没有 O_NOFOLLOW 时不伪造保证。创建/更新先原子写新 revision Markdown，再原子替换 manifest，旧版 inline prompt 会保真迁移；成功重开时只清理严格受控且未引用的 prompt orphan。损坏、缺失、未知字段和未知版本 fail closed。更新使用 expected revision 加 UI base 的 expectedSystemPrompt，旧版角色的默认思考强度为 `off`、工具权限为 `read_only`、会话编排严格 opt-in。write tail 与 revision CAS 是单个 `RoleStore` 实例内的串行边界，不提供跨进程文件锁；同一 agent dir 不应由多个 Pi Web 服务并发写角色目录。
- 每个工作台 Agent 都能读取任意角色的完整定义，因此角色 system prompt 会进入调用模型和来源 conversation transcript，不是秘密存储，不得放 API Key 或其它敏感值。Agent 只能通过 `propose_role_revision` 提议完整替换 system prompt；用户在 conversation-scoped editor 中取消时不写，完成后宿主才按 expected revision + captured base prompt CAS 写下一 revision。取消有效到 `RoleStore` 的 commit 开始：入队前、排队任务开始和 commit 前都检查宿主创建的 `AbortError`，一旦 commit 已调用就按已授权提交处理，不尝试虚假回滚。CAS queue race 若基线已变化返回结构化 `stale`，基线未变化则继续抛出原始 I/O/可用性错误。名称、简介、模型、思考强度、工具权限和会话管理能力均由旧模板复制，工具参数不能提交这些字段。
- 初始化“默认 / 默认角色”只是首次展示模板，可以像其它角色一样编辑、删除，删除后不会重建；新会话仍必须显式选择角色。
- `RoleCatalog` 用当前项目 actor 的 session-local 模型目录动态计算模板是否可用，因此项目静态 provider 也能参与选择；空项目使用 coordinator 持有的 project model catalog，它经过相同 trust/resource/provider 校验，但不会创建隐藏 AgentSession。角色 CRUD、模型列表和 API Key provider 校验都使用这条项目目录；真正创建还会由 `PiRuntime` 在项目资源加载后再次校验固定模型。
- 新会话把完整角色修订（包括默认思考强度、工具权限与会话管理能力）复制到 `piweb.conversation_meta.v1`。之后修改或删除模板不会自动改变旧会话；用户可在 idle 边界显式应用一个当前可用模板，宿主追加 `piweb.conversation_role_change.v1` 并用同一 SessionManager 重建 AgentSession。角色 prompt 追加到会话 system prompt，实际模型与初始思考强度必须与当前快照完全一致，SDK fallback/clamp 会被拒绝。旧 conversation metadata 缺少默认思考强度、工具权限或能力字段时分别按 `off` / `read_only` / 关闭迁移。
- 旧会话第一次在独占 writer lease 下打开时迁移为独立“旧会话”快照；其 system prompt 固定为空，并尽量保留旧分支模型，不依赖初始化模板。

## Actor 所有权

`ProjectSessionCoordinator` 由 socket server 共享，并按 canonical cwd 维护项目上下文。每个 `canonical cwd + conversationId` 最多一个 `ConversationActor`：

- actor opening singleflight，浏览器和 Agent 打开同一会话会复用 actor 与 writer lease；
- actor 同时持有 conversation-scoped LoopList：`todo_write` 只做有界整表替换并为未完成项 armed，`todo_pause` 原样暂停；run 自然结束时若仍 armed 且有未勾选项，就写入隐藏的上下文快照并在同一 RunTicket/runId 内续跑，最多 8 次。完成/清空停止，异常、abort 或上限暂停；进程打开与 rewind 后只从 Pi active branch 恢复状态且不自动运行，不能让较晚写入的 inactive branch 覆盖当前列表，后续普通浏览器 prompt 才重新 armed。严格 JSONL 扫描仍校验物理全集，并要求每条 continuation 精确快照其最近祖先列表、该列表 armed 且有未完成项、同一 run 在各自 branch 上从 1 连续递增到最多 8。
- 每个项目还 singleflight 建立一个无 AgentSession 的 project model catalog；空项目可据此显示项目扩展模型、管理角色和创建第一条会话，最后一个项目 handle 释放后统一 dispose；
- actor 原子拥有角色快照、`SessionManager`、writer lease、隔离的 settings/model registry、`AgentSession`、唯一 `activeRun`、串行队列和观察者；
- `activeRun` 的 `queued / running / waiting / cancelling` 是侧栏 activity 与 busy 的唯一来源；
- 浏览器切换焦点只更换观察者，不 abort、dispose 或暂停后台 actor；
- coordinator close 会同步封闭新 lifecycle 入队并结算全部 extension UI/waiter，排空关闭前已接收的 lifecycle task 后再释放资源；尚未开始的 task 在任何持久写前失败，不能让 close 返回后继续追加卡片。迟到 actor/catalog 会立即 dispose，随后清理包括无浏览器观察者在内的全部 actor、后台恢复任务与项目 handle。

`PiConnection` 不再拥有 conversation 生命周期。它只拥有浏览器 project observation epoch、当前 focus、认证 flow 和 extension UI broker。

### Extension UI

扩展 UI 只在线路上路由到当前被该浏览器 focus 的 conversation。后台 actor 暂无 UI delegate 时，请求留在 conversation router 中并把目标标为 attention，不会抢走用户焦点；用户切换到该会话后才发出对话框并可正常回答。等待 focus 期间仍遵守 extension 的 AbortSignal/timeout；切走 focus 会取消已经发给浏览器的旧对话框，项目关闭会用取消值结算全部待处理请求。角色提示词 editor 额外绑定当前工具调用的 AbortSignal：无 delegate 或已发到浏览器时取消 run 都会结算 router/broker pending、关闭对话框并禁止迟到回答落版。

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

每个 inbox envelope 是严格 v1 的单文件原子记录，保存稳定 `messageId/cardId`、来源/目标 conversation 快照、正文、消息种类、可选的冻结来源 `fromRunId`，以及 `queued | processing`。processing 状态还可保存接收方 `waitedByRunId` receipt；`fromRunId` 让 wait 在“消息先提交、wait 后注册”时能补查精确回复，receipt 防止同一接收 run 的后续 wait 重复观察同一 messageId。两者都是 durable sidecar 状态；目录、文件、身份、容量或内容异常都 fail closed。32 MiB envelope 容量按每条记录的最坏 processing 形态预留，所以已接受 queued 记录不会因状态字段增长而无法 claim；删除 tombstone 使用独立的 1 MiB / 1024 条预算，满 envelope reservation 仍能先建立 durable fence。scan 允许旧版 actual-fit、reservation 超限的目录打开并清理，但禁止继续创建，状态替换还会复核实际 next bytes，不能把兼容性变成越界。需要固定 initial runId 的 start_session envelope 在首次原子创建时就写成 processing，不存在先 commit queued、再二次改写的窗口。

发送线性化顺序：

```text
来源 JSONL 追加 sending 卡片
→ 原子写目标 inbox
→ 来源同 cardId 追加 queued 卡片
→ busy target：先转 processing 并按精确 runId 作为 SDK custom steering 注入；idle target：写入 custom_message 并启动 run
→ Pi 持久写入 custom_message marker
→ 精确 run settlement 持久化
→ 来源同 cardId 更新 terminal 状态
→ 删除 sidecar
```

- busy target 默认接收 steering：所有 peer message 种类（包括临时结果/失败）都先持久转为 `processing(runId)`，再以 `piweb.conversation_message.v1` custom message 放入当前 Pi turn 的 steering queue；它在当前工具调用结束、下次模型请求前生效，不创建第二个 run。普通发送以 durable claim 为确认点，不等待 pre-stream SDK 内存队列，因此不会与项目关闭或 preflight 互锁。只有 Pi 已把 custom message marker 写入 JSONL 且该精确 run 已结算，sidecar 才能删除；abort、启动失败或在 marker 前结算会将 envelope 恢复为 `queued` 并按 FIFO 重投。因此切换浏览器项目/focus、断线或进程重启都不能依赖内存 steering queue。目标 idle 时仍由 inbox pump 启动新 run。目标正通过 `wait_for_session` 阻塞时，wait 注册之后实际投递给其当前 run 的任何新 peer/inbox 消息（不再要求来源精确匹配所等 target）都会立即结算 wait 并返回消息真实来源 metadata；发送者若正处活跃 run，同一投递即返回 `delivered_to_wait`。wait 注册前已 claim 进当前 run queue 的未观察消息在注册时同样结算（见 wait_for_session 条目）。
- inbox commit 是取消边界：commit 前取消可拒绝，commit 后即使来源 run 随即取消，目标 pump 仍继续；同步启动失败会有界重试一次并保留 durable sidecar。
- 同一目标严格按 `sentAt + messageId` 投递；busy steering 也只能认领最早的未送 envelope，不能越过更早的 queued 或其它 run 的 processing envelope。
- 普通 inbox claim 每次最多批量投递 8 条。精确 wait 回复若排在该批之后，会先按 FIFO 把目标有界 inbox（单目标最多 64 条）中它之前的消息全部排入同一 steering queue，再排回复并结算 wait；否则未完成的 wait 工具会阻止前批 steering 被消费并形成死锁。through drain 中任一 predecessor（或 through envelope 本身）的 SDK steer 投递失败且无 durable marker 时 fail closed：把该 predecessor 恢复 `queued` 并 rethrow 原错误，由 `deliverEnvelopeToWaitingRun` 注销/reject waiter 并向 sender 抛错，through envelope 保持 queued，绝不回落到普通 claim 把 wake 消息误排入等待 run 后留下悬挂 waiter；普通非-through 批量路径仍保持异步 recover/return false 语义。这里的“批量”既描述 sidecar claim、FIFO 和 run ownership，也描述模型观察：steeringMode="all" 下同一轮工具序列结束后排队的多条 custom steer（含用户消息）会一次全部注入同一次模型调用。允许管理会话的目标 LLM 会收到来源标题、角色、完整 conversationId、正文、回复工具提示，以及“自行管理所创建会话生命周期”的提醒；关闭能力的角色只收到来源元信息和正文，不会看到任何会话工具名称或管理提示。隐藏提示只存在于 Agent 上下文，浏览器卡片仍只从 `details.body` 投影用户可见正文。
- incoming 消息使用 `piweb.conversation_message.v1` 并进入目标上下文；outgoing/委派状态使用 `piweb.conversation_card.v1`，只用于投影。
- 同一 `cardId` 的后续 entry 原地覆盖卡片状态；浏览器和重启恢复不会刷出多张重复卡。消息可能先因目标 run 启动进入 `running`，随后才因精确 wait rendezvous 追加 `delivered` 确认；该 `running → delivered` 转换是合法的异步观察顺序，之后仍可进入 terminal 状态。
- 每个 run 先追加 `piweb.run_settlement.v1`，记录精确 `runId/outcome/finalText`，再通知 waiter 和 inbox 清理。cycle check、waiter 注册与 committed inbox 补查处于项目 lifecycle 同一线性边界：发送先赢时按 `fromConversationId + fromRunId` 找回未被当前 receiving run receipt 的回复，注册先赢时发送路径直接 rendezvous；扫描/aggregate/投影失败，以及目标 exact run 在 settlement 前进入 fatal infrastructure 状态时，都必须移除 waiter 和 AbortSignal listener，不能留下 ghost wait edge。等待返回 durable settlement 或精确目标 run 主动发来的 message metadata；消息正文只通过 incoming custom message 注入一次，不能在 tool result 再复制一份。临时 initial run 的 caller waiter 会保留到自动回传 envelope 提交，只返回 message metadata，不再同时返回含同一正文的 settlement；但该 initial run 在 caller 正在精确等待时立即 `send_session_message`，会把 exact-wait assignment 与 message 一起原子写进 inbox envelope，这个 inbox commit 是替代成功自动回传的线性化点。宿主随后在 caller JSONL 物化严格的 `piweb.temporary_return_receipt.v1` claimed receipt（temporary conversation、initial run、message、caller run 和时间）；若进程在物化前退出，temporary completion 会从仍在的 assigned envelope 幂等补写。即使后续 inbox steering 或 SDK steer 拒绝，envelope 也会重投而 assignment 仍有效。成功 final 先将 caller receipt 升级为含完整 reported settlement 的 settled 状态，再标记 temporary settlement 并删除 temporary，因此即使 temporary JSONL 已删除，后续 wait 仍能从 caller receipt 返回最终 settlement，不再投递第二条 `delegation_result`；失败、中止、无 final 或超限仍照常投递 `delegation_failure`，以免失败消息与 settlement 竞态。每个 temporary initial run 最多一个 receipt，冲突 fail closed。等待与临时回传不能从“最后一条 assistant”猜结果。
- 重启会扫描 inbox 与 reserved JSONL：修复 inbox 已提交但来源仍是 sending 的卡片，恢复 processing run、临时结果和目标 pump；已经 durable settled 的 run 不会重复执行。SDK custom-steer acceptance 若异步拒绝，coordinator 会在 lifecycle 边界复查 marker/settlement，幂等 finish 或 dispose/reopen 后恢复精确 processing run，不能让无 settlement 的 claim 永久阻断 FIFO。
- terminal sender card 必须先于 sidecar 删除；两步间崩溃时，残留 sidecar 可在重启后完成对账。
- 删除 conversation 会先冻结 target 的 metadata descendant set 并设置 deleting fence；任一成员 busy 时整次拒绝。随后按子孙到祖先顺序持久化 target tombstone、把只以当前被删会话为目标的 pending inbox 对应 sender card 终结并清理；tombstone 在内存中也是 open/create/pump/send 的硬 fence，删除事务中的后到消息被明确拒绝，它此前发往 cascade set 外的 outbound envelope 仍会继续送达。JSONL 删除完成后 tombstone 会幂等回收；若进程在这两步之间退出，下次项目打开先恢复 fence，再完成删除或只清理目标已不存在且没有 pending 消息的完成标记，避免重新打开目标或长期编排耗尽固定 tombstone 数量。

## 上下文前缀与缓存

- 已进入模型上下文的 user、assistant、tool 和 incoming custom message 都是 append-only；新的宿主提示只附加到以后收到的新消息，不能回填或重写旧 entry。
- 长时间 `wait_for_session` 不会产生 provider 流量，因此不能靠本地 actor/WebSocket 活跃保住远端 prompt cache。对于至少 32k tokens、当前模型有限正数定价满足 `3 * cacheRead < input` 的来源 run，宿主可在静默 3 分钟后让当前 exact 或 aggregate waiter 返回非错误 `{ outcome: "checkpoint" }`，由同一 AgentSession 自然发起下一轮；它不证明目标完成，仍需要结果时必须用相同 target 或冻结 target set 再 wait。每个来源 run 最多两个 checkpoint；下一条 assistant usage 的 `cacheRead / (input + cacheRead + cacheWrite)` 低于 50% 或缺失/非法时关闭该 run 后续 checkpoint。该状态只在 RunTicket 内易失保存，不做隐藏预热、无限心跳、自动压缩或持久恢复。
- 当前角色完整修订由 base conversation metadata 加后续角色变更记录得出；重新打开会话使用最后一次成功应用的角色。角色模板后续编辑不会自动改变既有会话，只有用户显式切换才会从下一轮改变 system prompt、模型、默认思考强度、权限与 meta 工具 schema。聊天页的思考强度控制仍只修改当前运行会话，不反写角色模板或角色快照。
- 卡片状态、run settlement、temporary return receipt、meta operation 和 conversation metadata 使用普通 `custom` entry；SDK 的 `buildSessionContext()` 会忽略它们，因此状态更新既不改旧消息，也不污染模型缓存前缀。
- 会话自动压缩阈值同样使用普通 `piweb.compaction_threshold.v1` custom entry 保存；缺省为 70%，允许 20%–90%，最后一条有效记录生效，不进入模型上下文。
- 用户可在会话空闲时发送精确关联的 `compact_context` 命令手动调用 Pi 标准 `compact()`；运行中会话拒绝手动压缩，成功后重新发布 state 与 snapshot。Agent 可调用 conversation-scoped `request_context_compaction` 提交一次易失请求；工具结果只证明请求被接受，不证明压缩成功。Actor 会等当前 assistant/tool turn 完整结束，再复用阈值压缩的安全 checkpoint，在同一 `runId` 内压缩并恢复未完成任务；实际成功仍只由 Pi 原生 compaction entry 证明。
- 两个明确例外会有意改变模型输入：Pi 在上下文逼近上限时追加 compaction summary 并以摘要替换活动上下文，以及重新启动后项目资源本身发生变化导致基础 system prompt 变化。前者是继续运行所需，后者反映用户真实修改；工作台不为提高命中率伪装旧项目状态。

## 临时会话

临时会话仍是扁平的一等 conversation，只给初始委派增加生命周期：

- metadata 固定 caller conversation、delegation ID、return message ID 和精确 initial run ID；
- initial run 成功且有最终 Agent 文本时，默认先把结果作为 durable inbox 消息发给 caller、把 settlement 标记为已报告，再删除临时会话；若该 run 的普通显式消息已在发送时持久占用 caller 的精确 wait，caller 持久 receipt 会使该消息替代这条成功自动回传；receipt 先记录完整 reported settlement，随后 temporary settlement 以该 messageId 标记已报告后删除，避免重复结论；
- initial run 失败、中止或没有最终回复时，同样持久回传失败消息，但保留会话并标记 attention；
- 后续重试的成功 run 不会误触发初始委派的自动删除。

## Agent meta 工具

每个 actor 无论工具模式和 `canManageSessions` 值都注入三个角色工具：

```text
list_roles
read_role
propose_role_revision
```

`list_roles` 返回有界角色元数据与 revision；`read_role` 一次读取一个角色的完整当前定义；`propose_role_revision` 要求调用方提交刚读取的 expected revision 和完整替换 prompt，只在用户 editor 提交后落版。提案可指向任意角色（包括调用者自身和 default），但不能创建/删除角色，也不能改认证、trust、既有会话角色或模型。prompt 已是目标值时返回 `already_current`；基线变化返回 `stale`；取消/中止返回 `cancelled`；用户改回基线返回 `unchanged`；成功返回新 revision。editor 返回后会重新读取基线，真正写入仍由 `RoleStore.updateRole` CAS 防止竞态。

只有 frozen role 的 `canManageSessions=true` 时，actor 才额外注入九个会话编排工具：

```text
list_sessions
current_session
peek_session
start_session
start_temporary_session
send_session_message
wait_for_session
abort_session
delete_session
```

`canManageSessions=false` 时不注册会话编排工具，也不向模型提供它们的名称、参数、说明、回复提示或生命周期管理提示。该决定只读取 conversation role snapshot；后续编辑角色模板不会改变已存在会话的编排 schema，因此不会破坏既有会话的缓存前缀。

- 工具闭包绑定来源 conversation 和当前 canonical project，不接受 cwd/projectId，不能跨项目；角色目录本身是用户级共享状态，但模型可用性仍按来源 actor 的 session-local model registry 投影。
- `start_session` 必须给 role 和 task，创建平级持久会话；工具指导要求 Agent 创建持久会话前先用 `list_sessions(scope=created_by_me)` 查找自己负责的现有会话，职责匹配时通过 `send_session_message` 复用，只有没有合适会话才新建。`start_temporary_session` 创建一次性会话，用于只需要初始最终答复的调查、审计或快速 review；成功结果返回给调用者后自动删除。两者都在冻结角色、初始 task 和固定 runId 被可靠接受并调度后返回 `conversationId + runId`。目标空闲时立即取得 run ticket；若更早的 run 抢先则持久等待泵送。两种情况都不会隐式等待或挂起调用者。
- UI 仍投影扁平会话，但宿主在 conversation metadata 与来源 delegation card 中持久保存 `rootConversationId + depth + sourceRunId`。root 深度为 0，最多委派到深度 3；一个来源 run 最多消费 32 个 peer reservation，同一 root 最多保留 32 个 live descendants。per-run 计数来自来源 JSONL 的 append-only card，目标删除、临时会话自删和重启都不能退回额度；live 容量只有 conversation 真正删除后才释放。旧 `createdBy` 链会递归推导并校验；删除一个 conversation 会级联其 metadata descendants，旧隐式 child 不再阻止父删除，而是跟随父删除；恢复中的旧 run 则把无法关联 runId 的 legacy delegation card 保守计入额度。
- `send_session_message` 在持久接收后返回；busy 目标仍保持当前 run。若目标正在等待发送者的精确 run，则返回 `delivered_to_wait`，消息直接进入目标当前 turn，发送者仍可继续运行。
- `wait_for_session` 接受兼容的精确 `conversationId + runId`，或显式 `targets` wait-any（调用时去重并冻结 1–32 个 `conversationId + canonical runId`，不得混用两种形态）。aggregate waiter 以同一对象注册到每个 target key；任一 listed durable settlement 先赢时先从全部 key 原子注销，再返回 settlement 并额外标明 `conversationId`。活动投影只显示 `targetCount`，不伪装成首个 target；cycle check 遍历全部 listed target。两种形态都会先读 durable settlement，再 observe-or-subscribe；它们也都可由 wait 注册之后实际投递到当前 run 的新 peer/inbox 消息（来源任意 conversation/run，返回真实来源 metadata，消息正文只经 incoming custom message 注入一次），或用户 guidance 被当前 run 的 SDK steering queue 接受（显式 steer 与 busy 浏览器 prompt 共用同一 accepted-but-unobserved FIFO tracking，只返回 `outcome=guidance`，正文仍仅由 raw user message 注入一次，不伪造 peer identity 或重复正文）。wait 注册时若当前 run 已有 accepted 且未观察的 guidance（含 waitForSession 之前已接受的），立即结算；每条 guidance 最多唤醒本 run 的一个 wait（waited 标记与 raw observation 独立，且只在 host 的精确 waiter 实际存在并成功认领后才烧掉——callback 返回 boolean，stale callback（waiter 已被 abort/settlement/message 移除、withWaiting restore 尚未跑）返回 false 不烧 record，下一次 wait 仍能被同一 record 唤醒，避免 raw 注入前注册的后续 blocking tool/wait 死锁），并在其 raw user message_end 被认领时精确退休（同一 raw event 同时 retire 记录，不能遗留导致后续 wait 伪唤醒）；preflight/SDK rejection 绝不留下 accepted 记录。busy 浏览器 prompt 的准入：SDK 调用前 fail closed——run 未 streaming（`!session.isStreaming`，pre-stream 窗口）时拒绝且不触碰 SDK（避免 unowned SDK run），注册了 input extension handler 时拒绝（SDK 可消费输入而不入队，ghost 路径整体排除；extension command 已由宿主拒绝）；preflight(true) 后以队列尾部 entry 为自身（own push→preflight 原子、drain 只从队首、交错 push 先于 own；长度证明会在 predecessor drain 时误拒并静默遗留正文），记录 SDK 实际入队的 delivery text（可能被扩展/转换）；raw user message_end 认领：本 run 首个 raw user end 无条件归 initial prompt（先清 flag 再走 persistence proof，绝不能被同文 busy admission 抢先）；后续 raw end 只认领 unified observation FIFO 头的 deliveryText 匹配记录（explicit steer 的 queued text 在 `session.steer` 调用后同步捕获，真实 SDK 在 async 首个 await 前同步 push；capture 不到则 fail closed 拒绝，不在 promise rejection 前伪 accept），同文消息靠 FIFO 种类/identity 而非全局正文搜索，mismatched raw（如 extension user message）不消费/不越过 host record；record 按对象 identity 从 pendingAdmissions/guidanceDeliveries 移除并精确结算 promptId/delivery。run ticket 仍处 phase=queued 时 busy admission 明确拒绝（run not ready），避免第二 SDK run 逸出；finishRun/failRunInfrastructure 清空未投递 admissions，不跨 run 遗留。注册时也会检查当前 run 的 steering queue 里已 durable claim 但尚未观察（无 delivered marker、未被本 run wait 领用）的 message：wait 不得阻止其消费，立即以该消息真实来源结算并标记 `waitedByRunId`。"已观察"只由 delivered marker + `waitedByRunId`/当前 `processingRunId` 判定，不能单凭 wait 注册时间；精确 target 的 durable settlement 语义不变，已被同一 receiving run 观察过的消息不重复唤醒，消息的 FIFO predecessor 必须先进入同一 steering queue 才能结算 wait。消息到达后若仍需最终结果，Agent 可再次等待。临时 return receipt/assignment 对精确 wait 或 aggregate 中列出的 temporary caller target 生效，unrelated 消息不会建立 receipt。活动 session waiter 同时构成 wait-for graph，新增边若会形成任意长度环则在注册前拒绝；取消、异常和消息 rendezvous 都必须注销 waiter 并恢复 phase。
- `wait_for_session` 的 cache checkpoint timer 只属于一个 exact 或 aggregate `SessionWaiter`：注册期 durable settlement/message/guidance 补查完成后才安装，到期后进入 project lifecycle，并在修改额度前复核 timer、waiter object identity 与 run ownership。settlement、message、guidance、abort、fatal 或 close 先赢时统一 `detachWaiter` 清 timer；checkpoint 不写 `waitedByRunId`、guidance claimed、temporary receipt 或 settlement，也不会保留幽灵 wait graph 边。
- Meta tool schema 为 provider 兼容只把 run identity 表达成有界字符串，wait 的互斥形态也不用 `anyOf/oneOf`；`wait_for_session`（包括每个 aggregate target）与 `abort_session` 的执行边界仍必须在进入 lifecycle、活动状态或 durable operation 前拒绝非 canonical UUID。不能把模型回传的未校验 runId 投影进严格线协议。
- `abort_session` 只匹配精确目标 run；stale runId 不会中止后来的 run。其精确目标与已决定结果也写入来源会话的 `piweb.meta_operation.v1`，同一 tool call 在结算或重启后重放仍返回原结果；若进程在 started intent 后崩溃，恢复会先精确中止/结算该 run，再允许 inbox pump 继续。
- `delete_session` 删除目标及其 metadata descendants；拒绝 self、会把自己级联删除的祖先目标，以及任何 busy 成员；需要先 abort、等待结算，再删除。删除 intent/result 以 `piweb.meta_operation.v1` 持久化，相同 toolCall 重放不能改删另一个目标。
- 启动会话的角色、task、title 和 lifecycle 进入 sender card 指纹，相同 toolCall 改 payload 会冲突而不是谎报成功。
- `peek_session` 不启动 inactive 目标的模型/扩展，不移动 recent；只返回 user/assistant 可见正文和会话卡片，过滤 thinking/tool/auth/internal，默认只看最近 2 项，工具说明提醒 Agent 通常先看最后 1–2 项即可，最多 20 项且完整 JSON 不超过 256 KiB。inactive inspection 与删除共用 lifecycle 边界，因此短暂 writer lease 会先释放，删除不会留下只能靠重启恢复的 tombstone。
- 列表和正文同样有界；Agent 看到稳定完整 conversationId，而 UI 可另显示短句柄。`list_sessions` 的每项显式返回 durable `createdBy` 与观察者相对的 `createdByMe`，并支持 `scope=created_by_me`，让 Agent 无需依赖对话记忆即可找回自己负责的会话；尚未迁移、确实没有 conversation profile 的旧条目如实标为 `createdBy.kind=unknown`。

所有宿主工具仍经过项目扩展 hook、run ownership 和 source-aware tool gate。`list_roles/read_role/propose_role_revision` 是 `source=sdk` 的显式只读模式例外：前两个只读宿主状态，最后一个只有用户 editor 提交才写角色 prompt。九个会话编排工具仍只在 `canManageSessions=true + full_access` 时可用；扩展或项目工具即使同名也不能冒充 SDK 角色工具。`full_access` 仍允许通用文件工具访问项目外路径，不是角色目录的 OS sandbox，因此这里的人工确认保证只覆盖 `propose_role_revision` 工作流。

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
