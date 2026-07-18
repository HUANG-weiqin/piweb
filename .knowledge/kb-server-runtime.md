# 服务端运行时

`updated: 2026-07-18`

## 这个模块是干什么的

服务端运行时负责 Pi 原生资源所有权、每连接 AgentSession 生命周期、命令调度、认证交互和安全状态投影。

## 架构

`PiRuntime` 是进程级对象：

- 唯一持有共享 `AuthStorage` 与基线 `ModelRegistry`。
- 为每个 session 创建独立 `ModelRegistry`，隔离 cwd 扩展的静态模型、base URL 和 headers。
- 串行执行认证/模型配置变更。
- 变更后 reload/refresh，并通知活动连接发布新状态。
- 生产路径先 `createAgentSessionServices()` 加载 cwd 扩展/provider，再 `createAgentSessionFromServices()` 恢复持久模型，避免恢复顺序选错 fallback。

`ProjectStoreRegistry` 也是进程级对象：

- 按 canonical cwd、仅在活动 handle 生命周期内复用项目 manifest 和派生会话索引；末次 release 后逐出。
- 按 `canonical cwd + conversationId` 独占 writer lease。
- 重连可 FIFO 等待旧 lease，等待有 5 秒上限且可随初始化取消。
- 由一个 socket server 的所有 `PiConnection` 共享；不能每连接各建 registry。

`ProjectRunCoordinator` 按 canonical cwd 协调多个连接：read_only 收紧会同步封锁新许可、取消旧 run，并在全部旧 run 结算后才确认项目模式。

`PiConnection` 是每 WebSocket 一个的会话 actor：

- 原子持有 `sessionId + project handle + conversationId + SessionManager + writer lease + settings + modelRegistry + session + dispose + unsubscribe`。
- 普通命令进入 `SerialTaskQueue`。
- `abort`、`auth_response`、`cancel_auth`、`close_session` 可立即中断。
- generation 使创建中被关闭的 session 变成 stale，并在完成后立即 dispose。
- `activeRun` 是唯一 run 状态机：queued / running / cancelling；busy 只由它派生。
- `ToolApprovalBroker` 是连接级一次性授权 rendezvous；pending 审批只投影在当前 activeRun。

## 决策

- cwd 校验通过后，旧 bundle 会完整 shutdown/dispose，再创建新 runtime；这样两个工作区的扩展不会重叠运行。新 runtime 创建失败时连接保持无 active session。
- initialize 先取得 refcounted project handle，按 new/recent/open 选择 conversation，并在 Pi `open()` 前取得或等待 writer lease；任何 stale/失败路径都要取消等待并释放资源。
- 持久 conversation、连接 sessionId 和 runId 是不同身份；同一 conversation 重连时必须分配新 sessionId。
- prompt 在 actor 队列中等待完整运行结束，配置与重初始化不会穿过运行过程。
- prompt 在入队前先注册 run ticket，因此 abort 可以取消 queued prompt；重复 abort 复用同一个 SDK abort promise。
- SDK 异步 preflight 结束时会再次检查 run ticket；若期间已取消，会在真正启动 agent 前阻断。
- AgentSession 构造完成后，工作台在 SDK extension hook 外再包一层 host tool gate；扩展先修改/阻止，工作台再用最终 validated args 决策。
- gate 启用时固定 sequential tool execution，避免 parallel preflight 在等待后续审批时积累尚未执行的已授权调用。
- read_only 对非读取工具硬拒绝；workspace_write 仅自动允许真实路径仍属于 cwd 的 edit/write。
- 创建后显式 `bindExtensions(mode=print)`；session_start/resources_discover 会运行，扩展错误会绑定到当前 run 或 session。
- SDK 报告的 extension load errors 也会进入 session 错误，不能只监听运行期 runner errors。
- initialize 在 bundle 创建完成前就建立目标 epoch，因此同一 WebSocket 中紧随其后的 prompt 会排队，不会静默丢失。
- commit 后先发布小体积 PublicState，再发布低频 project snapshot 与有界 history snapshot；恢复历史不能依赖 SDK 重放旧事件。
- close 先同步使 epoch 失效并请求取消，再把 session dispose 排回 actor 队列，避免和普通操作并发销毁。
- 切到 read_only 是项目级 barrier：先同步取消其它连接的旧 run，等待它们 release，再持久化并发布确认；不能只在异步审批前后“多检查一次”。
- WebSocket server handle 显式拥有升级监听、活动 socket 与连接 actor；进程退出会先停止升级、断开客户端并等待全部 dispose。
- dispose 会先等待取消，再发送 `session_shutdown(reason=quit)`，最后释放 AgentSession 与 session 模型目录。
- Pi SDK 的 `streamSimple` 与扩展 OAuth 注册表是进程全局状态；第一版显式拒绝这两种项目扩展 provider，不能用裸 per-session registry 伪装隔离。
- 允许的静态 provider config 会先做 host-owned 深快照，防止扩展在注册后修改原对象绕过策略。
- registry refresh 后必须把 AgentSession 当前 model 重新绑定到新对象；若原模型被删除，则选择 registry fallback，不能继续使用旧 endpoint。
- SDK 内容事件只在捕获的 bundle generation 与当前 run ticket 同时匹配时投影；run lifecycle 由适配层合成。
- SDK 可能用 assistant `stopReason=error` 表达失败并让 `prompt()` 正常 resolve；projector 以最终一次 assistant 结果校准 workbench outcome。
- SDK 原生事件只交给 `SessionEventProjector`，不直接发送。
- SDK 明确报告 context unknown 时保留 unknown；仅在 SDK 没有读数时做估算。

## 认知模型

共享配置归进程，会话归 actor，socket 归传输。任何新增状态都应先决定属于哪一层，再决定由哪条队列修改。

## 入口

- `src/server/pi-runtime.ts`
- `src/server/pi-service.ts`
- `src/server/socket-server.ts`
- `src/server/serial-task-queue.ts`
- `src/server/session-events.ts`
- `src/server/session-usage.ts`
- 对应的 `*.test.ts`

## 坑点

- OAuth login 会等待浏览器回答；认证回答和取消不能排在 login 后面的同一队列，否则会死锁。
- OAuth flow 由 authFlowId 关联；pending/cancelled tombstone 保证在 flow 创建前收到的 cancel 也能阻止它启动。
- approval response 必须绕过 actor queue；sessionId/runId/approvalId 不精确匹配时只能 no-op。
- `tool_execution_start` 发生在 SDK 参数校验与授权之前，不能解释成副作用已经开始。
- sessionId/runId 不得复用，否则迟到命令会形成 ABA；连接 actor 会显式拒绝复用。
- `close` 与 `error` 都可能触发 dispose，清理必须幂等。
- `SessionManager.open()` 可能迁移文件且对不存在路径不可靠报错；必须从服务端受控索引解析 ID，并在 open 之前持有 lease。
- Node 的 `server.close()` 不会替你关闭已升级的 WebSocket；退出流程必须同时关闭 socket server handle。
- 多连接配置同步依赖所有修改都经过 `PiRuntime.updateConfiguration()`。
- 不要直接开放 `AgentSession.reload()`；其全局 provider reset 绕过工作台所有权边界。需要 reload 时先设计 runtime 协调入口。
- 项目扩展当前在服务进程内运行；无法安全强杀一个不返回的同步/异步 hook。只允许可信扩展，worker/子进程隔离是开放超时与动态 provider 的前置条件。
- writer lease 目前只覆盖同一服务进程；两个进程同时写同一 JSONL 仍不安全。
- Pi 的 `listAll()` 会静默跳过部分坏 JSONL；目标对话必须在 `SessionManager.open()` 前由宿主验证完整尾换行、JSON 和 header identity。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
