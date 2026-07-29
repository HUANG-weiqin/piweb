# 服务端运行时

`updated: 2026-07-24`

## 这个模块是干什么的

服务端运行时负责 Pi 原生资源、项目级 conversation actor、命令调度、认证交互和安全状态投影。

## 架构

`PiRuntime` 是进程级对象：

- 唯一持有共享 `AuthStorage` 与基线 `ModelRegistry`。
- 持有 Pi 用户级 `ProjectTrustStore`；受保护的项目资源在 trust resolution 前不能进入最终 resource loader。
- 为每个 session 创建独立 `ModelRegistry`，隔离 cwd 扩展的静态模型、base URL 和 headers。
- 可为项目创建独立的 model catalog：走与 session 相同的 trust、resource loader、静态 provider 深快照和不安全 provider 拒绝路径，但不创建或启动 `AgentSession`。它让空项目也能列出项目扩展模型并配置第一条会话。
- 串行执行认证/模型配置变更。
- 变更后 reload/refresh，并通知活动连接发布新状态。
- 生产路径先 `createAgentSessionServices()` 加载 cwd 扩展/provider，再 `createAgentSessionFromServices()` 恢复持久模型，避免恢复顺序选错 fallback。

`ProjectStoreRegistry` 也是进程级对象：

- 按 canonical cwd、仅在活动 handle 生命周期内复用项目 manifest 和派生会话索引；末次 release 后逐出。
- 按 `canonical cwd + conversationId` 独占 writer lease。
- 重连可 FIFO 等待旧 lease，等待有 5 秒上限且可随初始化取消。
- 由一个 socket server 的所有 `PiConnection` 共享；不能每连接各建 registry。

`ProjectRunCoordinator` 按 canonical cwd 协调多个连接：read_only 收紧会同步封锁新 run、取消旧 run，并在全部旧 run 结算后才确认项目模式。

`RoleCatalog` 是进程级用户角色目录：

- 严格读写 `<Pi agent dir>/piweb/roles.json`；首次初始化赠送可编辑、可删除的“默认 / 默认角色”普通模板，删除后不自动重建；v2 只迁移未改过的旧默认文案，不覆盖用户已编辑的名称或简介；
- 用共享模型目录动态计算模板可用性；
- 创建或切换会话角色时返回完整深快照，不把模板对象引用交给 session；角色默认思考强度必须属于固定模型实际支持的档位，无可调档位的模型使用唯一有效值。工作台投影模型可选思考档位必须与 Pi SDK 的 `getSupportedThinkingLevels()` 语义一致：`null` 表示禁用，`xhigh/max` 只有显式映射时才可选。
- 未携带角色快照的旧会话迁移为独立“旧会话”快照；可复用其历史模型或任一现存角色模型，但不依赖、也不重建已删除的初始化模板。

`ProjectSessionCoordinator` 是 conversation 生命周期拥有者：

- 按 canonical cwd 维护 project context、无 AgentSession 的 project model catalog、持久 inbox、pending prompt queue、恢复任务和 observers；
- 按 `canonical cwd + conversationId` singleflight 打开唯一 `ConversationActor`；
- actor 持有 `SessionManager + writer lease + settings/model registry + AgentSession + activeRun`，与 WebSocket 是否连接无关；
- inbox、完成 ledger、waiter、临时回传和删除都经过项目/actor 串行边界；
- 维护进程级项目活动目录，每个 context 的摘要独立缓存，只在 busy/compacting/attention 汇总真正变化时通知全局 observer；普通运行错误 attention 与 durable pending-prompt attention 分开拥有、按 conversation 去重合并，聚焦只确认前者，后者从 sidecar 恢复并持续显示到精确 dismiss/delete；高频 `session_event` 不触发目录扫描，可发布目录始终限制为 100 项，遗漏项目一旦变化就进入目录并优先替换最旧的低活动项；
- server close 会同步封闭新 acquisition 与项目 lifecycle queue；已排队但未开始的 task 在持久写前失败，队列完全 drain 后才 dispose 尚在打开的 actor/catalog、全部后台 actor、项目 model catalog 并释放共享项目 handle。

只读目录浏览属于 socket server 的 pre-session 控制边界：每次请求只枚举指定位置的一层子目录，结果按 commandId 返回；它不进入 `PiConnection` actor，也不参与项目或会话持久化。

`PiConnection` 是每 WebSocket 一个的项目观察与焦点控制器：

- 原子持有 `sessionId + project handle + focused conversationId/focusId + project observer + focused extension UI route`。
- 普通命令进入 `SerialTaskQueue`。
- `abort`、raw `steer`、pending prompt commands、`auth_response`、`cancel_auth`、`close_session` 走控制通道；steer 必须在当前 run 尚占用 actor operation queue 时即可注入，durable enqueue/withdraw/dismiss 仍由 project lifecycle 串行化。
- generation 使创建中的 project observation 变成 stale；detach 只释放观察 handle，不 dispose 后台 actor。不同 cwd 的 project context 与 conversation actor 各自持有运行状态，单个浏览器连接切换项目只替换观察投影，不能 abort 或 dispose 其它项目仍在执行的 run。
- 每次 attach 分配新 focusId；PiConnection 只向浏览器转发匹配当前 focus 的 transcript/run event，项目级 activity 仍通过 snapshot 更新。
- PiConnection 对 coordinator 的全局项目活动目录只订阅一次，并独立发布不带当前 sessionId/focusId 的 `project_activity_snapshot`；切换 cwd 只替换当前详细投影，不会失去其它已加载项目的活动摘要。
- `ExtensionUIBroker` 是连接级临时 rendezvous，每次 focus 使用独立 scope 和 AbortController；后台 actor 缺少 UI delegate 时由 conversation router 保留请求并进入 attention，聚焦后再接入 broker，不抢焦点。focus/create 的 controller 在命令进入串行队列前登记，后续 focus、initialize、close 或 disconnect 会先同步 abort，再排队 detach，避免 extension activation 等浏览器对话框、而取消操作反过来等待同一队列的死锁。成功 attach 后该 controller 转交给 view 并取消旧 scope；切换失败则保留原 view controller，使原会话 UI 仍可继续使用。create 在 activation 后观察到 abort 时必须在同一 project lifecycle 内删除刚创建的 conversation/actor，不能留下无 attach 回执的幽灵会话。

## 决策

- cwd 校验通过后，旧 project view 会 detach，再取得 coordinator project handle；不同项目 actor 仍由 coordinator 独立拥有，直到服务关闭。
- initialize 在建立空态或打开 actor 前先 singleflight 建立 project model catalog；项目模型查询优先使用当前 actor registry，其次 project catalog，最后才是进程基线。模型列表、角色 CRUD 和 API Key provider 校验必须遵守同一顺序。
- initialize 的 `recent` 在空项目中提交项目空态，不创建隐含 default conversation。open 复用已有 actor；new 必须先解析可用角色并在 AgentSession 创建前持久写入角色/lifecycle metadata。
- `createAgentSession` 一旦返回，owner bind、host tool gate 安装、startup provider/固定模型与初始思考强度校验和 extension load error 投影都必须位于同一个失败清理边界；其中任何一步抛错都 teardown 已创建的 AgentSession 并释放 actor lease。
- 持久 conversation、连接 observation sessionId、focusId 和 runId 是不同身份；同一 conversation 重连或重新 focus 都必须分配新传输身份。
- prompt、运行中 steer、inbox custom messages 和 abort 都由 ConversationActor 的 active run ownership 控制；浏览器 attach/detach 不穿过或中止运行过程。浏览器 steer 只接受精确 `running | waiting` run，不能再额外依赖 SDK 的 `isStreaming` 投影：actor 会先公布 running，SDK 标志随后才可能追上，而 Pi 原生 user steering queue 已能安全接收。引导在当前 assistant turn 工具结束、下一次模型调用前生效，不创建第二个 RunTicket。Actor 为每个浏览器 steer 保留 FIFO delivery waiter；raw user `message_end` 之后还必须用同一对象引用证明 Pi 已同步追加到 SessionManager，才能确认命令，不能按文本关联。run 先结算或取消会拒绝所有未投递 waiter。Actor 还区分 SDK promise 尚未接受前的确定性拒绝与接受后的不确定失败；durable pending steer 只有前者可 requeue，后者必须转 attention。跨会话 inbox 默认同样 steering，但保留 `piweb.conversation_message.v1` custom identity；若 run ticket 先于 SDK streaming 就绪，actor 暂存 custom steer 并在 `agent_start` 注入。普通发送以 sidecar durable claim 为回执，不等待这段内存暂存完成，避免 lifecycle close 等待 preflight、而 actor abort 又排在 lifecycle drain 之后的互锁。异步 SDK acceptance rejection 必须进入 tracked lifecycle recovery：复查精确 marker/settlement 后 finish，或 dispose fatal actor、reopen 并恢复 processing run，不能静默吞掉 rejection。inbox sidecar 的 `processing(runId)` 与 JSONL marker 是持久真相，不能把 SDK 内存 queue 当作交付成功。
- 精确校验来源 focus 后，手动 `compact_context` 直接交给来源 ConversationActor，不占用 PiConnection 的视图串行队列；压缩继续由 actor 拥有，浏览器可同时切换到另一 conversation。Actor 在返回 Promise 前同步预约 compacting，封住同时启动 run 或删除的间隙；删除端也必须拒绝 compacting actor，不能释放仍被压缩任务使用的 session。完成时仍按原 sessionId + commandId 回执；若当前 focus 已回到同一 conversation，即使 focusId 已更新也要刷新当前 snapshot，确保 A→B→A 不漏掉 compaction marker。
- 会话角色切换同样是来源 ConversationActor 拥有的长操作，不占用 PiConnection 的视图串行队列；切换项目只撤销浏览器观察，不能取消或等待另一项目正在重建的 runtime。原 observation 仍有效时才刷新 focus 并回执，之后重开来源会话从 actor 权威角色快照恢复。
- 自动压缩阈值属于 conversation actor：缺省 70%，从 `piweb.compaction_threshold.v1` 恢复；每轮开始前先处理上一次失败/中止遗留的高水位，正常结束后再用 Pi 的 context usage 检查百分比并触发标准 `compact()`，不改动同时影响摘要预算的 `reserveTokens`。长工具任务还会在每个成功 assistant/tool 轮次结束后重新调用 `getContextUsage()`：无论是否越过阈值，都发布一次低频 `context_usage` actor 事件，让 focused connection 立即刷新输入框下方的当前上下文计数；只有存在工具结果且达到阈值时，才让 Pi 在该轮完整结束后优雅停下。命中 checkpoint 时 SDK 的 queued continuation 只被临时隐藏、消息本身不被删除，保证下一次模型请求不会越过宿主压缩；工作台取得控制权后释放该暂停，保持原 `runId`、busy 状态和 run lease，执行标准 `compact()`，再用隐藏 custom message 自动续跑并自然消费原队列。因此底层可出现多个 `agent_start`，但浏览器只观察到一个工作台 run；若 SDK 仍因其它内部恢复路径自行续跑，actor 识别后不会再注入第二次 resume。PiRuntime 在 SDK `compaction_start/end` 边界内只为摘要请求临时包装公开的 Agent stream，将 reasoning clamp 到模型支持的 `minimal`，不修改会话 thinking 状态、持久设置或普通 Agent 请求，并在结束、失败、取消和 session teardown 时恢复原 stream。Actor 同时观察 SDK 原生 `compaction_start/end` 作为 `compacting` 状态来源；同一 checkpoint 已见 SDK 压缩 attempt 时，宿主阈值检查不立即重复触发；任一宿主或 SDK 压缩失败只把下次尝试推迟到 context usage 再增长 5 个百分点，而不能永久关闭当前长 run 的压缩，成功则清除该 backoff。取消 run 在 compacting 时先调用 `abortCompaction()`；无论取消发生在 pre-run、轮次间还是 post-run 压缩，都必须等 compact 退出后把 run 结算为 aborted，且取消异常不能伪装成普通压缩错误。更新阈值只追加非上下文 custom entry。空闲会话还可通过精确 focus 关联的 `compact_context` 手动调用同一个标准 `compact()`；这些路径共用 actor 的瞬时 `compacting` 状态并阻止新的 run/角色切换/截断，focused connection 将其投影到 `PublicState`。成功 compact 产生的 Pi 原生持久条目仍在 snapshot 中投影为用户可见分界线，不另存第二份持久压缩状态。
- OpenAI Codex Responses 的 `auto` transport 在 AgentSession 创建前通过 session-local settings override 解析为 `sse`，让普通 turn、SDK retry 与 compaction summary 共用 zstd SSE；用户显式选择的 `sse | websocket | websocket-cached` 原样保留，override 不写回用户或项目 settings。完整 provider JSON、cached WebSocket delta、实际 WebSocket frame 与压缩 SSE body 是不同观察边界；工作台不得再用 raw context/provider body 字节阈值伪造 `context_length_exceeded` 或触发 durable compaction，generic WebSocket/request-buffer error 也必须保持 transport error。
- 空闲会话可通过精确 focus 关联的 `switch_conversation_role` 应用当前可用角色。Actor 同步封锁新 run，停止旧 AgentSession，追加角色变更记录，再用同一 SessionManager 和新角色 model/prompt/meta tools 重建；替换 runtime 打开失败时追加上一角色作为补偿并恢复旧 runtime，补偿也失败则 actor fatal。conversationId、history、lifecycle 与 createdBy 不变。
- API Key 在共享配置队列完成后才确认；凭据本身影响所有项目，但发起命令必须仍属于提交时的 observation session/generation，避免迟到页面修改全局认证。会话模型由角色快照固定，中途 `select_model` 明确拒绝；actor 重开时再次校验实际模型，不能 SDK fallback。
- API Key、角色 CRUD 和删除等需要结算的操作都带原 sessionId + commandId，连接内复用 commandId 会被拒绝。
- 会话“回到此处”由 project lifecycle、ConversationActor operation queue 和 ProjectStore 原子截断共同完成；busy 或存在待处理 inbox 时拒绝。只有 durable JSONL 与同一 AgentSession 内存 context 都同步后，PiConnection 才依次发布 focused snapshot 和 command completion。
- `setThinkingLevel()` 和 `setSessionName()` 会先改内存再持久化；工作台以 actor 实际后置条件为准，发布新 state 并单独报告持久化风险。相对地，`AuthStorage.set/remove` 与 `ProjectStore.setToolMode` 都是持久写成功后才替换内存状态，不需要这种部分提交适配。
- browser prompt、pending prompt 或 inbox run 在入队前先同步注册 actor run ticket，因此 abort 可以取消 queued run；精确 abort 复用同一个 SDK abort promise，错误 runId 不能影响后来的 run。direct browser admission 与 durable pump 共用 project lifecycle；actor idle 时仍要先处理已有 inbox 与 pending claim，不能在 completion/reconnect 观察窗口插队。pending prompt pump 总是让已排队的跨会话 inbox 优先；只有 actor idle 时才 claim 一条 FIFO prompt 并启动新 run。
- 取消 run 必须先清空 SDK 尚未消费的 steering/follow-up queue 再 abort；否则旧引导可能跨越结算边界污染下一次 prompt。持久跨会话消息仍由 inbox delivery marker 决定是否重投，不能把 SDK 内存队列当成 durable truth。
- 注册不可复用 runId、安装 active RunTicket 后立即发送 `run_queued`；它既是生命周期事件，也是浏览器提交 user draft 的唯一服务端接收回执。
- SDK 异步 preflight 结束时会再次检查 run ticket；若期间已取消，会在真正启动 agent 前阻断。
- AgentSession 构造完成后，工作台在 SDK extension hook 外再包一层 host tool gate；扩展先修改/阻止，工作台再用最终 validated args 决策。
- gate 启用时固定 sequential tool execution，避免 parallel preflight 在 abort 或权限收紧后执行已积累的调用。
- `read_only` 只允许最终来源为 builtin 的 Pi 原生 `read/grep/find/ls`；`full_access` 允许所有工具和命令。扩展同名工具不能冒充 builtin。
- 生产 `SettingsManager` 先以 `projectTrusted=false` 创建。无受保护资源时直接继续；有资源时先读用户级 trust store/global default，必要时通过浏览器选择，再由 SDK 二阶段 resource reload 加载或跳过项目设置、skills 与 extensions。
- 创建后显式 `bindExtensions(mode=rpc)`；只把 `select/confirm/input/editor/notify` 接到 Web UI，TUI 定制仍继承 SDK no-op。session_start/resources_discover 会运行，扩展错误会绑定到当前 run 或 session。
- extension UI response 绕过 actor queue；request 绑定当前 focus 的 sessionId/generation，timeout、扩展 AbortSignal、run stop、focus change、close 和 disconnect 都按 Pi 默认值结算。requestId 在连接生命周期内不复用，并以 4096 次总请求上限约束去重集合；达到上限后必须重连，不能让扩展用顺序对话无界增长宿主内存。
- extension command 的 new/fork/tree/switch 返回 cancelled，reload 明确报 unsupported；当前入口拒绝 extension slash command，避免 handler 的 detached turn 越过 activeRun ownership。
- actor 无 activeRun（或 run 尚 queued）却出现 `agent_start` 时立即 abort；这是一条防止扩展旁路启动 Agent turn 的兜底不变量。
- SDK 报告的 extension load errors 也会进入 session 错误，不能只监听运行期 runner errors。
- initialize 在 project view 建立前就登记目标 observation epoch；focus 只有在精确 `focus_attached` 后才可发送 prompt。异步取得共享 coordination 后发布 role catalog 时也必须重新核对同一个 view 对象及其 session/generation，不能仅凭旧对象仍被引用就向新 observation 发迟到快照或错误。
- attach 后先发布小体积 PublicState，再发布低频 role/project snapshot、有界 focused history snapshot 和独立 `pending_prompts_snapshot`；恢复历史与队列都不能依赖 SDK 或浏览器重放旧事件。异步读取队列后必须复验原 view 的 generation/conversationId/focusId。
- 同一 project view 的索引刷新同时最多执行一轮；进行中收到的任意数量请求折叠为一次尾随扫描，尾随到达时前一轮结果不投影。页面恢复的 `refresh_view` 只接受精确 observation/focus 身份；busy 或 compacting actor 不重发 durable transcript，避免覆盖当前流式尾部。
- close/focus change 先同步使观察身份和 UI route 失效，再 detach project view；它不会把仍在运行的 conversation actor 当作连接资源销毁。
- 切到 read_only 是项目级 barrier：先同步取消其它连接的旧 run，等待它们 release，再持久化并发布确认；不能只在异步策略前后“多检查一次”。
- WebSocket server handle 显式拥有升级监听、活动 socket、共享 RoleCatalog 与 ProjectSessionCoordinator；进程退出会先停止升级、断开客户端，再等待全部 connection 和 conversation actor dispose。
- 目录浏览不启动系统窗口或子进程；服务端重新校验浏览位置，只返回目录名与绝对路径，并同时限制数量和序列化字节数。用户确认后仍必须由 initialize 独立校验并提交项目 cwd。
- WebSocket upgrade 要求 loopback Origin 与请求 Host 精确一致；不能因为 hostname 是 localhost 就允许其它本机端口枚举目录或发送 Agent 命令。
- ConversationActor dispose 会先等待取消，再发送 `session_shutdown(reason=quit)`，最后释放 AgentSession、session 模型目录和 writer lease。
- Pi SDK 的 `streamSimple` 与扩展 OAuth 注册表是进程全局状态；第一版显式拒绝这两种项目扩展 provider，不能用裸 per-session registry 伪装隔离。
- 允许的静态 provider config 会先做 host-owned 深快照，防止扩展在注册后修改原对象绕过策略。
- registry refresh 后必须把 AgentSession 当前 model 重新绑定到新对象；若原模型被删除，则选择 registry fallback，不能继续使用旧 endpoint。配置已持久提交后，每个 session registry 与 baseline registry 的 refresh 都必须独立尝试，并在最后照常通知订阅者；单个 owner 抛错不能跳过其余 session，多个错误聚合后再返回调用方。
- SDK 内容事件只在当前 actor run ticket 匹配时投影；PiConnection 再按当前 focusId 决定是否发给浏览器。run lifecycle 由工作台适配层合成。
- SDK 可能用 assistant `stopReason=error` 表达失败并让 `prompt()` 正常 resolve；projector 以最终一次 assistant 结果校准 workbench outcome。
- SDK 原生事件只交给 `SessionEventProjector`，不直接发送。
- SDK 明确报告 context unknown 时保留 unknown；仅在 SDK 没有读数时做估算。

## 认知模型

共享配置、角色与 trust 归进程；conversation 与 inbox pump 归 coordinator/actor；浏览器临时交互归 focus generation；socket 归传输。任何新增状态都应先决定属于哪一层，再决定由哪条队列修改。

## 入口

- `src/server/pi-runtime.ts`
- `src/server/agent-turn-boundary.ts`
- `src/server/pi-service.ts`
- `src/server/socket-server.ts`
- `src/server/role-store.ts`
- `src/server/role-catalog.ts`
- `src/server/conversation-actor.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/project-prompt-queue.ts`
- `src/server/directory-browser.ts`
- `src/server/serial-task-queue.ts`
- `src/server/session-events.ts`
- `src/server/session-usage.ts`
- 对应的 `*.test.ts`

## 坑点

- OAuth login 会等待浏览器回答；认证回答和取消不能排在 login 后面的同一队列，否则会死锁。
- OAuth/extension UI 这类同步 emitter 的请求必须先登记 pending waiter 再发事件；emit 抛错时要删除 waiter 并拒绝请求，避免同步回答丢失或残留悬挂状态。
- 项目信任和当前 focus 的 extension hook 也可能在首个 PublicState 前等待浏览器；扩展 UI 回答同样不能排 actor queue，也不能要求 PublicState 已存在。
- OAuth flow 由 authFlowId 关联；pending/cancelled tombstone 保证在 flow 创建前收到的 cancel 也能阻止它启动。宿主不能直接调用会在 provider 返回后自行提交 credential 的 `AuthStorage.login()`；必须先调用 baseline provider 获取 credential，复验 flow 未取消后才由宿主提交。这样忽略 abort 的 provider 只能返回一个未提交值，不需要用旧快照回滚，也不会覆盖同时发生的 token refresh。
- `tool_execution_start` 发生在 SDK 参数校验与 host 策略之前，不能解释成副作用已经开始。
- sessionId/focusId/runId 不得复用，否则迟到命令会形成 ABA；连接 view 与 conversation actor 会显式拒绝复用。
- `close` 与 `error` 都可能触发 dispose，清理必须幂等。
- SDK steer promise resolve 只证明 Pi 接受了易失队列，不证明 user message 已持久化。resolve 后的 delivery failure、run settlement 或 append 证明缺失不能回滚为 queued；只有 exact delivery receipt 才允许清 sidecar。
- 拥有资源 teardown 边界的串行队列必须同步封闭 admission，并在释放资源前 drain；仅设置 `disposed` 而不等待 tail 会允许关闭后迟到写。ConversationActor 通过唯一 activeRun completion 结算 operations，PiConnection 把 cleanup 排在同一 operations tail，ProjectSessionCoordinator 则显式 `SerialTaskQueue.close()`。
- teardown 的错误监听注册/注销本身也可能抛错；它们不能阻止 abort、等待运行结束和 dispose，所有失败应在完整清理后聚合报告。
- 调用 Pi 的状态 setter 后不能把任意 throw 直接解释成“没有生效”；先核对 AgentSession / SessionManager 后置条件，再区分提交前失败与提交后持久化风险。
- `SessionManager.open()` 可能迁移文件且对不存在路径不可靠报错；coordinator 必须从服务端受控索引解析 ID，并在 singleflight open 之前持有 lease。
- Node 的 `server.close()` 不会替你关闭已升级的 WebSocket；退出流程必须同时关闭 socket server handle。
- 目录列表请求不能复用 commandId；客户端导航时保留上一次成功列表，但只能接收最新 commandId 的结果。浏览位置不能提前取得项目 handle、创建 `.piweb` 或触发项目资源加载。
- 多连接配置同步依赖所有修改都经过 `PiRuntime.updateConfiguration()`。
- 不要直接开放 `AgentSession.reload()`；其全局 provider reset 绕过工作台所有权边界。需要 reload 时先设计 runtime 协调入口。
- extension `confirm` 只是扩展业务交互，不会改变项目工具模式；经过 Pi 工具入口的副作用仍必须经过工作台 tool gate。
- Pi core 已提供轮次后的 `shouldStopAfterTurn`，但当前 `AgentSession` 没有公开配置入口；`agent-turn-boundary.ts` 是唯一允许依赖 `Agent.createLoopConfig` 与 `hasQueuedMessages` 运行时形状的适配点。命中宿主 checkpoint 后只暂停 SDK 对 queued continuation 的观察，不能清空实际 steer/follow-up/custom 队列；actor 取得控制权后释放暂停、压缩并续跑。Pi 相关依赖必须精确锁定已验证版本；升级若移除这些形状，session 创建必须 fail closed，不能静默退化成在运行中直接 `compact()`、abort 工具或跳过轮次内压缩。
- trust decision 不能写入项目 `.piweb`；否则恶意仓库可以随自身内容一起声明自己可信。
- 项目扩展当前在服务进程内运行；无法安全强杀一个不返回的同步/异步 hook。只允许可信扩展，worker/子进程隔离是开放超时与动态 provider 的前置条件。
- writer lease 目前只覆盖同一服务进程；两个进程同时写同一 JSONL 仍不安全。
- Pi 的 `listAll()` 会静默跳过部分坏 JSONL，也可能为合法 JSON 中的非有限数值生成无效日期，或接受缺少 tree 字段的 entry。项目索引必须由宿主验证目录内全部常规 JSONL 的 JSON-safe 数值、当前 entry payload/tree，并要求磁盘全集与 SDK 索引按路径/identity 精确覆盖。只验证目标对话仍会让 `recent` 静默回退到另一条或新建。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
