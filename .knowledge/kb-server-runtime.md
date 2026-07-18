# 服务端运行时

`updated: 2026-07-19`

## 这个模块是干什么的

服务端运行时负责 Pi 原生资源所有权、每连接 AgentSession 生命周期、命令调度、认证交互和安全状态投影。

## 架构

`PiRuntime` 是进程级对象：

- 唯一持有共享 `AuthStorage` 与基线 `ModelRegistry`。
- 持有 Pi 用户级 `ProjectTrustStore`；受保护的项目资源在 trust resolution 前不能进入最终 resource loader。
- 为每个 session 创建独立 `ModelRegistry`，隔离 cwd 扩展的静态模型、base URL 和 headers。
- 串行执行认证/模型配置变更。
- 变更后 reload/refresh，并通知活动连接发布新状态。
- 生产路径先 `createAgentSessionServices()` 加载 cwd 扩展/provider，再 `createAgentSessionFromServices()` 恢复持久模型，避免恢复顺序选错 fallback。

`ProjectStoreRegistry` 也是进程级对象：

- 按 canonical cwd、仅在活动 handle 生命周期内复用项目 manifest 和派生会话索引；末次 release 后逐出。
- 按 `canonical cwd + conversationId` 独占 writer lease。
- 重连可 FIFO 等待旧 lease，等待有 5 秒上限且可随初始化取消。
- 由一个 socket server 的所有 `PiConnection` 共享；不能每连接各建 registry。

`ProjectRunCoordinator` 按 canonical cwd 协调多个连接：read_only 收紧会同步封锁新 run、取消旧 run，并在全部旧 run 结算后才确认项目模式。

只读目录浏览属于 socket server 的 pre-session 控制边界：每次请求只枚举指定位置的一层子目录，结果按 commandId 返回；它不进入 `PiConnection` actor，也不参与项目或会话持久化。

`PiConnection` 是每 WebSocket 一个的会话 actor：

- 原子持有 `sessionId + project handle + conversationId + SessionManager + writer lease + settings + modelRegistry + session + dispose + unsubscribe`。
- 普通命令进入 `SerialTaskQueue`。
- `abort`、`auth_response`、`cancel_auth`、`close_session` 可立即中断。
- generation 使创建中被关闭的 session 变成 stale，并在完成后立即 dispose。
- `activeRun` 是唯一 run 状态机：queued / running / cancelling；busy 只由它派生。
- `ExtensionUIBroker` 是连接级交互 rendezvous；它能在 active bundle commit 前服务 `session_start`/trust 请求，并由 session generation 的 AbortSignal 结算。

## 决策

- cwd 校验通过后，旧 bundle 会完整 shutdown/dispose，再创建新 runtime；这样两个工作区的扩展不会重叠运行。新 runtime 创建失败时连接保持无 active session。
- initialize 先取得 refcounted project handle，按 new/recent/open 选择 conversation，并在 Pi `open()` 前取得或等待 writer lease；任何 stale/失败路径都要取消等待并释放资源。
- `createAgentSession` 一旦返回，owner bind、host tool gate 安装、startup provider 校验和 extension load error 投影都必须位于同一个失败清理边界；其中任何一步抛错都 teardown 已创建的 AgentSession 并从进程 registry 集合逐出 owner。
- 持久 conversation、连接 sessionId 和 runId 是不同身份；同一 conversation 重连时必须分配新 sessionId。
- prompt 在 actor 队列中等待完整运行结束，配置与重初始化不会穿过运行过程。
- API Key 在共享配置队列完成后才确认；凭据本身影响所有项目，但发起命令必须仍属于提交时的 active session/generation，避免迟到页面修改全局认证。模型选择以“目标模型已成为当前 AgentSession 的实际 model”为提交点。Pi 的 `setModel()` 会依次改运行态、追加 session entry、排队默认设置写入，并非原子事务；若运行态已切换但后续步骤失败，服务端确认模型已应用并在最新 state 之后另发 settings error，只有提交点前的失败才回 command error。
- 两类设置结果都带原 sessionId + commandId，连接内复用 commandId 会被拒绝。
- 同构扫描确认 `setThinkingLevel()` 和 `setSessionName()` 也会先改内存再持久化；工作台同样以实际 session 后置条件为准，发布新 state 并单独报告持久化风险。相对地，`AuthStorage.set/remove` 与 `ProjectStore.setToolMode` 都是持久写成功后才替换内存状态，不需要这种部分提交适配。
- prompt 在入队前先注册 run ticket，因此 abort 可以取消 queued prompt；重复 abort 复用同一个 SDK abort promise。
- 注册不可复用 runId、安装 active RunTicket 后立即发送 `run_queued`；它既是生命周期事件，也是浏览器提交 user draft 的唯一服务端接收回执。
- SDK 异步 preflight 结束时会再次检查 run ticket；若期间已取消，会在真正启动 agent 前阻断。
- AgentSession 构造完成后，工作台在 SDK extension hook 外再包一层 host tool gate；扩展先修改/阻止，工作台再用最终 validated args 决策。
- gate 启用时固定 sequential tool execution，避免 parallel preflight 在 abort 或权限收紧后执行已积累的调用。
- `read_only` 只允许最终来源为 builtin 的 Pi 原生 `read/grep/find/ls`；`full_access` 允许所有工具和命令。扩展同名工具不能冒充 builtin。
- 生产 `SettingsManager` 先以 `projectTrusted=false` 创建。无受保护资源时直接继续；有资源时先读用户级 trust store/global default，必要时通过浏览器选择，再由 SDK 二阶段 resource reload 加载或跳过项目设置、skills 与 extensions。
- 创建后显式 `bindExtensions(mode=rpc)`；只把 `select/confirm/input/editor/notify` 接到 Web UI，TUI 定制仍继承 SDK no-op。session_start/resources_discover 会运行，扩展错误会绑定到当前 run 或 session。
- extension UI response 绕过 actor queue；request 绑定 sessionId/generation，timeout、扩展 AbortSignal、run stop、reinitialize、close 和 disconnect 都按 Pi 默认值结算。
- extension command 的 new/fork/tree/switch 返回 cancelled，reload 明确报 unsupported；当前入口拒绝 extension slash command，避免 handler 的 detached turn 越过 activeRun ownership。
- 无 activeRun（或 run 尚 queued）却出现 `agent_start` 时立即 abort；这是一条防止扩展旁路启动 Agent turn 的兜底不变量。
- SDK 报告的 extension load errors 也会进入 session 错误，不能只监听运行期 runner errors。
- initialize 在 bundle 创建完成前就建立目标 epoch，因此同一 WebSocket 中紧随其后的 prompt 会排队，不会静默丢失。
- commit 后先发布小体积 PublicState，再发布低频 project snapshot 与有界 history snapshot；恢复历史不能依赖 SDK 重放旧事件。
- close 先同步使 epoch 失效并请求取消，再把 session dispose 排回 actor 队列，避免和普通操作并发销毁。
- 切到 read_only 是项目级 barrier：先同步取消其它连接的旧 run，等待它们 release，再持久化并发布确认；不能只在异步策略前后“多检查一次”。
- WebSocket server handle 显式拥有升级监听、活动 socket 与连接 actor；进程退出会先停止升级、断开客户端并等待全部 dispose。
- 目录浏览不启动系统窗口或子进程；服务端重新校验浏览位置，只返回目录名与绝对路径，并同时限制数量和序列化字节数。用户确认后仍必须由 initialize 独立校验并提交项目 cwd。
- WebSocket upgrade 要求 loopback Origin 与请求 Host 精确一致；不能因为 hostname 是 localhost 就允许其它本机端口枚举目录或发送 Agent 命令。
- dispose 会先等待取消，再发送 `session_shutdown(reason=quit)`，最后释放 AgentSession 与 session 模型目录。
- Pi SDK 的 `streamSimple` 与扩展 OAuth 注册表是进程全局状态；第一版显式拒绝这两种项目扩展 provider，不能用裸 per-session registry 伪装隔离。
- 允许的静态 provider config 会先做 host-owned 深快照，防止扩展在注册后修改原对象绕过策略。
- registry refresh 后必须把 AgentSession 当前 model 重新绑定到新对象；若原模型被删除，则选择 registry fallback，不能继续使用旧 endpoint。
- SDK 内容事件只在捕获的 bundle generation 与当前 run ticket 同时匹配时投影；run lifecycle 由适配层合成。
- SDK 可能用 assistant `stopReason=error` 表达失败并让 `prompt()` 正常 resolve；projector 以最终一次 assistant 结果校准 workbench outcome。
- SDK 原生事件只交给 `SessionEventProjector`，不直接发送。
- SDK 明确报告 context unknown 时保留 unknown；仅在 SDK 没有读数时做估算。

## 认知模型

共享配置与 trust 归进程，会话归 actor，临时交互归 session generation，socket 归传输。任何新增状态都应先决定属于哪一层，再决定由哪条队列修改。

## 入口

- `src/server/pi-runtime.ts`
- `src/server/pi-service.ts`
- `src/server/socket-server.ts`
- `src/server/directory-browser.ts`
- `src/server/serial-task-queue.ts`
- `src/server/session-events.ts`
- `src/server/session-usage.ts`
- 对应的 `*.test.ts`

## 坑点

- OAuth login 会等待浏览器回答；认证回答和取消不能排在 login 后面的同一队列，否则会死锁。
- OAuth/extension UI 这类同步 emitter 的请求必须先登记 pending waiter 再发事件；emit 抛错时要删除 waiter 并拒绝请求，避免同步回答丢失或残留悬挂状态。
- 项目信任和 extension hook 也可能在 active bundle commit 前等待浏览器；扩展 UI 回答同样不能排 actor queue，也不能要求 PublicState 已存在。
- OAuth flow 由 authFlowId 关联；pending/cancelled tombstone 保证在 flow 创建前收到的 cancel 也能阻止它启动。
- `tool_execution_start` 发生在 SDK 参数校验与 host 策略之前，不能解释成副作用已经开始。
- sessionId/runId 不得复用，否则迟到命令会形成 ABA；连接 actor 会显式拒绝复用。
- `close` 与 `error` 都可能触发 dispose，清理必须幂等。
- teardown 的错误监听注册/注销本身也可能抛错；它们不能阻止 abort、等待运行结束和 dispose，所有失败应在完整清理后聚合报告。
- 调用 Pi 的状态 setter 后不能把任意 throw 直接解释成“没有生效”；先核对 AgentSession / SessionManager 后置条件，再区分提交前失败与提交后持久化风险。
- `SessionManager.open()` 可能迁移文件且对不存在路径不可靠报错；必须从服务端受控索引解析 ID，并在 open 之前持有 lease。
- Node 的 `server.close()` 不会替你关闭已升级的 WebSocket；退出流程必须同时关闭 socket server handle。
- 目录列表请求不能复用 commandId；客户端导航时保留上一次成功列表，但只能接收最新 commandId 的结果。浏览位置不能提前取得项目 handle、创建 `.piweb` 或触发项目资源加载。
- 多连接配置同步依赖所有修改都经过 `PiRuntime.updateConfiguration()`。
- 不要直接开放 `AgentSession.reload()`；其全局 provider reset 绕过工作台所有权边界。需要 reload 时先设计 runtime 协调入口。
- extension `confirm` 只是扩展业务交互，不会改变项目工具模式；经过 Pi 工具入口的副作用仍必须经过工作台 tool gate。
- trust decision 不能写入项目 `.piweb`；否则恶意仓库可以随自身内容一起声明自己可信。
- 项目扩展当前在服务进程内运行；无法安全强杀一个不返回的同步/异步 hook。只允许可信扩展，worker/子进程隔离是开放超时与动态 provider 的前置条件。
- writer lease 目前只覆盖同一服务进程；两个进程同时写同一 JSONL 仍不安全。
- Pi 的 `listAll()` 会静默跳过部分坏 JSONL，也可能为合法 JSON 中的非有限数值生成无效日期，或接受缺少 tree 字段的 entry。项目索引必须由宿主验证目录内全部常规 JSONL 的 JSON-safe 数值、当前 entry payload/tree，并要求磁盘全集与 SDK 索引按路径/identity 精确覆盖。只验证目标对话仍会让 `recent` 静默回退到另一条或新建。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
