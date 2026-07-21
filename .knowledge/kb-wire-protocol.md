# 线协议

`updated: 2026-07-21`

## 这个模块是干什么的

`src/shared/protocol.ts` 定义浏览器和服务端唯一共享的命令、状态与事件合同，并在两个方向做运行时校验。

## 架构

```text
ClientCommand
→ Zod 校验
→ PiConnection（项目观察与 focus）
→ ProjectSessionCoordinator / ConversationActor
→ SessionEventProjector
→ ServerEvent + observation/focus/run identity
→ Zod 校验
→ App / reducer
```

协议由 `PROTOCOL_VERSION` 标识，当前为 v21。工具参数和结果允许 `unknown`，但服务端在投影时会做有界遍历、转成 JSON-safe 数据并限制单值大小。

## 决策

- 协议只暴露 UI 实际消费的稳定事件。
- projectId/conversationId 是持久身份，sessionId 是浏览器项目观察 epoch，focusId 是一次 conversation attach，runId 是单次执行；协议必须显式携带消费方需要的身份，不能混用。
- `project_snapshot` 与 `role_catalog_snapshot` 用 `sessionId + projectId` 过滤；它们描述整个项目，不能因更新来自后台 conversation 就丢弃。
- `project_activity_snapshot` 是连接级、跨当前 observation 的进程目录，只汇总 coordinator 已加载项目的 cwd/projectId、busy conversation 数和 coordinator-owned attention 数；它不携带 transcript、当前 focus 或浏览器私有 unread。最多 100 项，超出时置 `truncated=true`。
- 当前 transcript 的 state、snapshot、live run 和卡片必须匹配 `sessionId + conversationId + focusId`。每次 initialize/open/create/focus 都分配新 focusId，因此快速 `A → B → A` 时第一次 A 的迟到帧不能污染第二次 A。
- prompt/abort 显式携带上述 focus 三元身份和 runId；运行中引导另用 `steer + commandId + 精确 active runId`，由 `command_complete(steer)` 确认 SDK 已把该 user message 实际送入当前 run，而不只是放进易失内存队列。steer 是控制通道，不能排在被当前 run 占用的 actor 串行队列之后；错 focus 或错 runId 必须失败，不能作用于当前观察。
- `browse_directory` 是 initialize 前的连接级只读控制命令，使用连接内一次性 commandId 关联 `directory_listing` 或 command error；`path` 是临时浏览位置，不是已提交项目 cwd。列表同时受项数和序列化字节数限制，迟到或不匹配的结果必须忽略。
- OAuth login/request/progress/response/cancel/complete 显式携带 authFlowId；浏览器不得接收非当前 flow 的帧。
- 扩展对话响应携带 sessionId / requestId；requestId 一次性使用，错类型、错选项、重复和 stale response 都是 no-op。
- `extension_ui_request → extension_ui_response → extension_ui_closed` 是当前 focus 的临时 rendezvous，不是持久状态；断线或 focus change 会销毁浏览器 route，但不会销毁 conversation actor。request 可在首个 PublicState 前出现。
- 扩展 `notify` 是有界、session-scoped 的 fire-and-forget 事件，不赋予任何工具许可。
- initialize 的 conversation target 是 `recent | new(roleId) | open(conversationId)`；客户端不能提交 session 文件路径。空项目的 `recent` 返回“项目已打开、没有 active conversation”，不会偷偷创建 default 会话。
- `focus_conversation` 和 `create_conversation` 使用一次性 commandId；服务端用同 commandId 的 `focus_attached` 确认新 focus。客户端在精确确认前不能把 pending target 当成当前 transcript。
- `refresh_view` 是页面恢复后的无等待只读重同步，必须精确携带当前 `sessionId + projectId` 以及成对出现的 `conversationId + focusId`；身份已经变化时服务端静默丢弃。它刷新 state、角色目录和项目索引，只有 focused actor 已空闲且未压缩时才重发 durable conversation snapshot，避免用持久快照覆盖正在流式生成的尾部。
- 当前 focus 被其它 Agent 删除时，服务端发送带完整 `sessionId + projectId + conversationId + focusId` 的 `focus_invalidated(reason=deleted)`；客户端只结算精确匹配的观察身份，然后回到角色选择页。不能从缺少当前项的截断列表猜测删除。
- 创建新 conversation 必须显式 roleId。`default` 只是角色 ID，不是省略选择时的隐含值。
- 工具模式只有 `read_only | full_access`，由角色模板持有并复制到 conversation 当前角色快照；角色 CRUD payload 必须同时携带模型默认思考强度和工具模式。v21 不接受 `initialize.toolMode` 与 `set_tool_mode`，协议仍没有逐工具询问命令或待回答状态。
- `rename_conversation` 同时匹配当前 sessionId 和目标 conversationId。
- `delete_conversation` 携带 sessionId、一次性 commandId 和目标 conversationId；浏览器不能提交文件路径。成功和失败都用同一 sessionId + commandId 精确结算。
- `truncate_conversation` 携带一次性 commandId、精确 `sessionId + conversationId + focusId` 和 snapshot 中的 durable messageId。assistant 聚合 ID 使用 `assistant:<entryId>`，仅由服务端剥离前缀并解析物理锚点；成功前服务端先发布截断后的完整 focused snapshot，再发送同 commandId 的完成事件，客户端不得本地猜测删除结果。
- 角色 CRUD 使用 `create_role/update_role/delete_role + sessionId + commandId`；create/update 的 role payload 包含 `canManageSessions`，update/delete 还携带 expectedRevision，不能用迟到 snapshot 冒充提交成功。初始化模板没有删除特权。
- 会话模型、初始思考强度、工具权限和会话管理能力都来自当前角色快照。v21 的 `switch_conversation_role` 携带精确 `sessionId + conversationId + focusId + commandId + roleId`，只允许 idle focus，并在服务端发布新 state、project snapshot 与 conversation snapshot 后完成；直接 `select_model` 仍明确拒绝。API Key 命令继续按 sessionId + commandId 精确结算。
- `compact_context` 携带一次性 commandId 和精确 `sessionId + conversationId + focusId`；只允许空闲 conversation，成功后服务端先刷新 state / snapshot，再发送同 commandId 的完成事件。
- `PublicState.compacting` 是当前 focused conversation 正在执行 Pi 标准压缩的可恢复瞬时状态；手动与自动压缩共用该字段。它独立于 `busy/activeRun`，因为自动压缩可能发生在 run 结算尾部，而手动压缩没有 runId。
- `set_compaction_threshold` 携带一次性 commandId 和精确 `sessionId + conversationId + focusId`，只接受 20–90 的整数百分比；`PublicState.compactionThresholdPercent` 是当前会话权威值，成功或失败必须按 commandId 精确结算。
- 高频 `PublicState` 不携带完整项目索引；项目空态允许 conversation/focus/model/runtime 字段缺席。`project_snapshot` 低频发布扁平会话列表及 role/activity/attention/unread/temporary，最多 100 项且整帧不超过 750,000 UTF-8 bytes；保留顺序优先 current、active、attention、unread，再按最后活跃时间。字段裁剪、条数省略或帧预算省略都会置 `truncated=true`。
- `role_catalog_snapshot` 独立发布用户级角色目录；最多 64 个角色，名称/简介与 durable store 一致按 80/1000 个 Unicode 字符校验，system prompt 按 128 KiB UTF-8 校验。客户端命令帧仍限制为 1 MB；服务端事件使用独立的 64 MiB 上限，以容纳最坏情况下 JSON 转义后的完整有界角色目录。socket 序列化后还会执行同一发送上限，超限只发送一条固定 protocol error，不能递归发送浏览器必然拒绝的原帧。
- `conversation_snapshot` 携带固化角色，并且必须在有界 `ConversationHistoryItem[]` 与兼容 `messages[]` 中二选一，禁止重复发送两份 transcript。普通 user/assistant 是 `message`，跨会话 incoming/outgoing 是 `session_message`，Pi active branch 上的持久压缩记录是 `compaction` 分界项。
- live 卡片使用 `conversation_item`，同 cardId 幂等更新；它不能伪装成某个 run 的文本 delta。
- wire 上的 `session_message.peerExists` 由服务端基于完整 durable 项目 ID 集合计算，不依赖可能截断的 `project_snapshot`；它只控制 peer 跳转入口，不写回 durable 卡片。
- snapshot 的 `truncated` 都只表示浏览器投影省略，不能解释成 durable 数据被删除。
- sessionId、focusId 和 acknowledged commandId 在一个连接内不可复用，runId 在一个 session 内不可复用；它们是关联身份，不承诺任意网络命令的 exactly-once。
- `run_queued → run_started → run_finished(outcome)` 由工作台适配层合成，不把 SDK 的 agent lifecycle 当成线协议真相。
- `run_queued` 还有明确的接收回执语义：服务端已校验身份、占用不可复用 runId、安装 active RunTicket，并接受该 prompt 进入 actor 队列。浏览器只有收到精确匹配 focus 三元身份 + runId 的这一帧，才能清草稿并投影本地 user message。
- runId 描述执行生命周期，不描述气泡生命周期。steer 被 SDK 真正取用时，projector 用 `user_message` 和 `assistant_message_started` 标出同一 run 内的新消息段；后续文本、思考、工具和 usage 仍归该 run，但 reducer 写入最新 assistant 段。最终 focused snapshot 继续以 Pi 的 durable message entry 为准。
- `WebSocket.send()` 不是协议提交点。确认前断线是 unknown outcome；当前协议没有 prompt 查询或幂等重放，因此客户端必须保留草稿、恢复历史后让用户核对，不能自动重试。
- 错误包含 `scope`，命令错误可包含 `operation`；需要精确结算的设置错误还必须携带 sessionId + commandId。通用设置错误不能结束一次运行。
- context usage 保留 `measured | estimated | unknown` 来源，不把未知伪装成精确数字。

## 认知模型

协议不是 SDK 类型的网络别名，而是工作台自己的兼容层。修改它时要问：

1. 浏览器真的需要这个字段吗？
2. 这个字段能安全 JSON 序列化吗？
3. 迟到命令和事件如何匹配 observation session、focus、run、extension request 或 auth flow？
4. 这是高频 state、低频项目索引、一次性历史，还是 run 增量？
5. 新增状态能否从一帧 state 完整重建，而不是依赖曾经收到某个事件？

## 入口

- `src/shared/protocol.ts`
- `src/shared/protocol.test.ts`
- `src/server/session-events.ts`
- `src/server/session-events.test.ts`
- `src/client/lib/socket.ts`

## 坑点

- 新事件必须同时加入 TypeScript 类型、Zod schema、服务端 projector 和 reducer 测试。
- 协议版本不兼容时要显式失败，不能静默按旧结构运行。
- 新增命令时必须先决定归 socket control、PiConnection project view 还是 ConversationActor；进入连接命令队列后仍要在 exhaustive scope switch 中选择 observation / focus / global 生命周期。会触发用户等待态的命令还要决定是否需要一次性 commandId 和显式完成事件。
- 等待 prompt 或 extension activation 内部 Promise 的响应命令必须走控制通道，不能进入普通 actor 队列。
- 扩展 select 的响应值必须属于服务端保存的原始 options；不能相信浏览器回传值。
- 扩展 UI 文本与选项有独立上限；超限是扩展错误，不能静默截断后改变选择语义。
- 大型或循环工具结果必须经过 `toWireValue()`；不要直接放入 `ServerEvent`。
- 不要把完整 conversation list 放回 PublicState，也不要发送无总量上限的历史快照。
- 不要用普通 prompt/run_queued 冒充运行中引导。新 run 只由 `run_queued` 提交，当前 run 的 steer 只由精确 commandId 的 `command_complete(steer)` 提交；身份不匹配的回执必须忽略。
- 不要只按 conversationId 过滤 transcript。conversationId 会在 `A → B → A` 中重复，focusId 才能阻断 ABA。

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
