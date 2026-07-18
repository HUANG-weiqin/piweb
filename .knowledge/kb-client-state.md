# 客户端状态

`updated: 2026-07-19`

## 这个模块是干什么的

客户端负责连接本机服务、选择工作目录和模型、展示认证交互，并把稳定 session events 投影成聊天消息。

## 架构

`App` 持有当前 session epoch、active conversationId、服务端 `PublicState`、低频项目索引、连接状态、认证弹窗和临时 extension UI 队列。`chatReducer` 只持有 transcript、工具投影和 token fallback。

```text
ServerEvent
→ 校验 protocolVersion / sessionId
→ PublicState 更新权威 activeRun / busy
→ project_snapshot 更新会话列表
→ conversation_snapshot 原子 hydrate 持久历史
→ SessionEvent 按 runId 更新 transcript
→ extension_ui_request/closed 按 sessionId + requestId 维护临时模态队列
→ Chat 纯展示与发送用户意图
```

## 决策

- `PublicState.activeRun`（以及由它派生的 busy）是服务端运行真相；聊天错误不改写 PublicState。
- `outstandingRunId` 只覆盖“浏览器已交给 WebSocket、服务端运行状态尚未被观察到”的本地传输间隙，并为 Stop 提供 runId；匹配的 PublicState、terminal 或 error 会结算它，它不伪装成 Agent 状态。
- `PiSocket.send() === true` 只表示浏览器 transport 接受了帧，不表示服务端接受 prompt。只有匹配 sessionId + runId 的 `run_queued` 才是接收提交点：此时才能清空草稿并把 user message 投影进 transcript。
- prompt 接收确认前断线属于 unknown outcome。客户端保留内存草稿、重连恢复 durable conversation 后提示用户核对，绝不自动重发；显式切项目、新建或打开另一对话会清掉草稿，避免跨生命周期泄漏。
- 每次 initialize 或重连生成新的 sessionId。
- projectId/conversationId 随 state 更新，重连用新 sessionId 显式 `open` 当前 durable conversation；若尚未知 ID 才请求 `recent`。
- WebSocket transport open 与协议握手 ready 是两个状态；版本不兼容会失效 session/run/auth 并禁止发送。
- 启动页目录输入由 App 受控；内置目录浏览器只展示服务端确认过的临时浏览位置，不自动 initialize。导航结果按一次性 commandId 匹配；只有用户点击“选择当前文件夹”才替换输入，取消保留原值，错误可回到服务启动目录，断线会关闭临时浏览状态。
- 切目录先发送 `close_session`，随后清空本地 epoch；旧 state/event 一律忽略。
- 新建/切换对话复用同一 initialize 生命周期，但生成新 sessionId 并先清空旧 transcript；旧 snapshot 不能越过 sessionId/conversationId 双重过滤。
- 对话列表来自 `project_snapshot`，恢复消息来自 `conversation_snapshot`；两者的 truncated 提示必须可见，localStorage 不是数据 fallback。
- 删除入口只出现在非当前对话，必须二次确认。发送后以 sessionId + commandId 保持单一 pending 状态，匹配的 `command_complete` / error 才能结算；普通 snapshot 只更新列表，不能冒充删除回执。断线属于未知结果，应清除等待态并提示用户重新核对列表。
- state 只说明 runtime 已提交，不说明历史已经 hydrate；`conversationReady` 必须等匹配 sessionId + conversationId 的 snapshot，期间 composer 和 `sendPrompt` 双重禁用，避免 hydrate 覆盖刚发送的本地消息。
- user、assistant、tool、usage 和 prompt error 全部按 runId 路由，不能更新“最后一条消息”来猜归属。
- OAuth UI 只接收当前 authFlowId；取消或新 flow 之后的旧 request/progress/complete 一律忽略。
- 模型连接使用“提供商 → 凭据 → 该提供商可用模型”的两步界面，不把完整模型库和全部认证方式同时倾倒给用户。
- Pi 凭据属于当前用户并由所有项目共享；移除凭据必须明确提示全局影响并二次确认。空模型列表的恢复动作必须真的发送 `refresh_models`，不能用“重新打开设置”冒充刷新。
- API Key 保存和模型切换只由匹配 sessionId + operation + commandId 的 `command_complete` / error 结算；任何中途 `state` 刷新都不能关闭等待态。断线会清除未确认的 Key、释放弹窗并要求重试。
- extension UI 可在首个 state 前出现，因此对话框必须位于 Setup/Chat 之外的 session-scoped overlay；它不能依赖 activeRun。
- extension request 按到达顺序排队，server closed event、initialize、session change 或 disconnect 都会移除 stale 项；浏览器只回答当前 sessionId。
- OAuth、API Key 和 extension UI 同时出现时只展示一个模态边界；隐藏不等于丢弃输入草稿，只有 request 更换、权威 closed/cancel 或连接生命周期结束才清理。
- transcript 仅在用户位于底部附近时跟随流式输出；跟随时必须滚动 transcript 容器到真实 `scrollHeight`，不能滚动 padding 之前的占位节点。用户向上阅读后显示“回到最新消息”，不能用每个 delta 强制抢走滚动位置。composer 是受控草稿并按内容在有界高度内增长。
- 认证、设置和扩展交互拥有模态焦点边界。
- 工具模式的服务端 state 是执行真相；限制到 `read_only` 的本地意图立即持久化，放宽到 `full_access` 只能在服务端确认后持久化，重连不得在 ack 间隙扩大权限。
- PiSocket 的每个回调捕获创建它的 socket；旧 socket 以及 React effect 已销毁的旧 PiSocket 实例都不得操作当前连接。
- SDK 的 tool_started 投影代表 preflight 已观察到调用，工具卡先显示 pending；后续 `tool_prepared` 用扩展变换后的最终参数校准展示。
- 服务端累计 token 优先，reducer 累计值只作为旧状态或短暂缺失时的 fallback。

## 认知模型

客户端不是 Agent 状态的拥有者。它只保存“我当前观察哪个 session”以及“这个 session 的事件投影结果”。

## 入口

- `src/client/App.tsx`
- `src/client/lib/socket.ts`
- `src/client/chat/reducer.ts`
- `src/client/components/Chat.tsx`
- `src/client/components/Setup.tsx`
- `src/client/App.test.tsx`
- `src/client/chat/reducer.test.ts`

## 坑点

- 不带当前 sessionId 的迟到状态不能恢复已关闭的工作区。
- 设置、认证或 registry 错误不能作为 run finished 处理。
- `message_end` 可能没有任何流式 delta；最终文本校准必须由服务端 projector 提供。
- 断线重连会先清空旧投影，再用新 epoch 打开当前 conversation 并 hydrate；不得把旧浏览器消息和新快照拼接。
- 不能因为先收到 state 就开放输入；服务端按 state → project snapshot → conversation snapshot 发布，大历史会放大这个窗口。
- extension dialog 的提交不能靠本地关闭冒充成功；服务端会发送 `extension_ui_closed`，超时或 abort 时也由它清掉浏览器残影。
- 不要用 `provider.configured` 或任意新 state 推断刚提交的 Key 已保存；配置刷新可能先于原命令的失败错误到达。
- 不要在 `WebSocket.send()` 成功后清空 composer 或插入 user message；这会在帧未到达服务端时制造不可恢复的数据丢失窗口。
- 目录列表中的 `path` 只是浏览投影，不是项目 cwd；不要在用户确认和 initialize 校验前创建项目状态、加载资源或持久化会话。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
