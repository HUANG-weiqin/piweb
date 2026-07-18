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

协议由 `PROTOCOL_VERSION` 标识，当前为 v5。工具参数和结果允许 `unknown`，但服务端在投影时会做有界遍历、转成 JSON-safe 数据并限制单值大小。

## 决策

- 协议只暴露 UI 实际消费的稳定事件。
- `session_event` 与 `PublicState` 都绑定 session epoch。
- projectId/conversationId 是持久身份，sessionId 是 bundle epoch，runId 是单次执行；协议必须显式携带消费方需要的身份，不能混用。
- 所有会话命令显式携带 sessionId；prompt/abort 和内容事件额外携带 runId。
- OAuth login/request/progress/response/cancel/complete 显式携带 authFlowId；浏览器不得接收非当前 flow 的帧。
- 工具响应携带 sessionId / runId / approvalId；approvalId 是一次性许可身份，toolCallId 只能用于展示关联。
- 扩展对话响应携带 sessionId / requestId；requestId 一次性使用，错类型、错选项、重复和 stale response 都是 no-op。
- `extension_ui_request → extension_ui_response → extension_ui_closed` 是临时 rendezvous，不是持久状态；断线必然销毁拥有它的 session bundle。request 可在首个 PublicState 前出现。
- 扩展 `notify` 是有界、session-scoped 的 fire-and-forget 事件，不赋予任何工具许可。
- 待审批项是 `PublicState.activeRun.pendingApprovals` 的权威快照，不使用不可恢复的一次性 request event。
- initialize 的 conversation target 是 `recent | new | open(conversationId)`；客户端不能提交 session 文件路径。
- 工具模式由项目 manifest 持有；initialize 的 read_only 只可收紧，权限扩大必须走 `set_tool_mode` 并等待 state 确认。
- `rename_conversation` 同时匹配当前 sessionId 和 conversationId，只允许重命名 active conversation。
- `select_model` 与 `set_api_key` 携带 sessionId 和连接内一次性 commandId；成功必须收到同 session + command 的 `command_complete`，失败错误回显相同身份。普通 `state` 刷新不能解释成该命令成功。API Key 虽写入用户级全局存储，但提交授权仍绑定当前 session epoch，stale/未知 session 只能 no-op。
- 对模型选择，`command_complete` 表示目标模型已经成为匹配 session 的运行态模型，不承诺 Pi 的会话记录与默认设置是一个原子事务；后续持久化风险会作为独立 settings error 显示。
- 高频 `PublicState` 不携带完整项目索引。`project_snapshot` 低频发布有界对话列表，`conversation_snapshot` 在恢复时发布有界 active-branch 历史。
- 两种 snapshot 的 `truncated` 都只表示浏览器投影省略，不能解释成 durable 数据被删除。
- sessionId 和 setting commandId 在一个连接内不可复用，runId 在一个 session 内不可复用；它们是关联身份，不承诺网络重试的 exactly-once。
- `run_queued → run_started → run_finished(outcome)` 由工作台适配层合成，不把 SDK 的 agent lifecycle 当成线协议真相。
- `run_queued` 还有明确的接收回执语义：服务端已校验身份、占用不可复用 runId、安装 active RunTicket，并接受该 prompt 进入 actor 队列。浏览器只有收到精确匹配 sessionId + runId 的这一帧，才能清草稿并投影本地 user message。
- `WebSocket.send()` 不是协议提交点。确认前断线是 unknown outcome；当前协议没有 prompt 查询或幂等重放，因此客户端必须保留草稿、恢复历史后让用户核对，不能自动重试。
- 错误包含 `scope`，命令错误可包含 `operation`；需要精确结算的设置错误还必须携带 sessionId + commandId。通用设置错误不能结束一次运行。
- context usage 保留 `measured | estimated | unknown` 来源，不把未知伪装成精确数字。

## 认知模型

协议不是 SDK 类型的网络别名，而是工作台自己的兼容层。修改它时要问：

1. 浏览器真的需要这个字段吗？
2. 这个字段能安全 JSON 序列化吗？
3. 迟到命令和事件如何匹配 session、run、extension request 或 auth flow？
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
- 新增命令时必须在服务端 exhaustive scope switch 中选择 session / epoch / global 生命周期；会触发用户等待态的配置命令还要决定是否需要一次性 commandId 和显式完成事件。
- 等待 prompt 或 extension activation 内部 Promise 的响应命令必须走控制通道，不能进入普通 actor 队列。
- 扩展 select 的响应值必须属于服务端保存的原始 options；不能相信浏览器回传值。
- 扩展 UI 文本与选项有独立上限；超限是扩展错误，不能静默截断后改变选择语义。
- 大型或循环工具结果必须经过 `toWireValue()`；不要直接放入 `ServerEvent`。
- 不要把完整 conversation list 放回 PublicState，也不要发送无总量上限的历史快照。
- 不要新增另一个 prompt ack 或从 `state.busy` 猜测接收成功；`run_queued` 是唯一提交事件，身份不匹配的回执必须忽略。

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
