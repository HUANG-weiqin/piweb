# 线协议

`updated: 2026-07-18`

## 这个模块是干什么的

`src/shared/protocol.ts` 定义浏览器和服务端唯一共享的命令、状态与事件合同，并在两个方向做运行时校验。

## 架构

```text
ClientCommand
→ Zod 校验
→ PiConnection
→ SessionEventProjector
→ ServerEvent + sessionId + runId
→ Zod 校验
→ App / reducer
```

协议由 `PROTOCOL_VERSION` 标识，当前为 v4。工具参数和结果允许 `unknown`，但服务端在投影时会做有界遍历、转成 JSON-safe 数据并限制单值大小。

## 决策

- 协议只暴露 UI 实际消费的稳定事件。
- `session_event` 与 `PublicState` 都绑定 session epoch。
- projectId/conversationId 是持久身份，sessionId 是 bundle epoch，runId 是单次执行；协议必须显式携带消费方需要的身份，不能混用。
- 所有会话命令显式携带 sessionId；prompt/abort 和内容事件额外携带 runId。
- OAuth login/request/progress/response/cancel/complete 显式携带 authFlowId；浏览器不得接收非当前 flow 的帧。
- 工具响应携带 sessionId / runId / approvalId；approvalId 是一次性许可身份，toolCallId 只能用于展示关联。
- 待审批项是 `PublicState.activeRun.pendingApprovals` 的权威快照，不使用不可恢复的一次性 request event。
- initialize 的 conversation target 是 `recent | new | open(conversationId)`；客户端不能提交 session 文件路径。
- 工具模式由项目 manifest 持有；initialize 的 read_only 只可收紧，权限扩大必须走 `set_tool_mode` 并等待 state 确认。
- `rename_conversation` 同时匹配当前 sessionId 和 conversationId，只允许重命名 active conversation。
- 高频 `PublicState` 不携带完整项目索引。`project_snapshot` 低频发布有界对话列表，`conversation_snapshot` 在恢复时发布有界 active-branch 历史。
- 两种 snapshot 的 `truncated` 都只表示浏览器投影省略，不能解释成 durable 数据被删除。
- sessionId 在一个连接内不可复用，runId 在一个 session 内不可复用；它们是关联身份，不承诺网络重试的 exactly-once。
- `run_queued → run_started → run_finished(outcome)` 由工作台适配层合成，不把 SDK 的 agent lifecycle 当成线协议真相。
- 错误包含 `scope`，命令错误可包含 `operation`；通用设置错误不能结束一次运行。
- context usage 保留 `measured | estimated | unknown` 来源，不把未知伪装成精确数字。

## 认知模型

协议不是 SDK 类型的网络别名，而是工作台自己的兼容层。修改它时要问：

1. 浏览器真的需要这个字段吗？
2. 这个字段能安全 JSON 序列化吗？
3. 迟到命令和事件如何匹配 session、run 或 auth flow？
4. 这是高频 state、低频项目索引、一次性历史，还是 run 增量？
5. 新增授权状态能否从一帧 state 完整重建，而不是依赖曾经收到某个事件？

## 入口

- `src/shared/protocol.ts`
- `src/shared/protocol.test.ts`
- `src/server/session-events.ts`
- `src/server/session-events.test.ts`
- `src/client/lib/socket.ts`

## 坑点

- 新事件必须同时加入 TypeScript 类型、Zod schema、服务端 projector 和 reducer 测试。
- 协议版本不兼容时要显式失败，不能静默按旧结构运行。
- 新增命令时必须在服务端 exhaustive scope switch 中选择 session / epoch / global 生命周期。
- 等待 prompt 内部 Promise 的响应命令必须走控制通道，不能进入普通 actor 队列。
- 大型或循环工具结果必须经过 `toWireValue()`；不要直接放入 `ServerEvent`。
- 不要把完整 conversation list 放回 PublicState，也不要发送无总量上限的历史快照。

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
