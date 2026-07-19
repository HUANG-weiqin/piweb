# 客户端状态

`updated: 2026-07-19`

## 这个模块是干什么的

客户端负责连接本机服务、选择工作目录和会话角色、展示认证交互，并把项目控制面与当前 focus transcript 分开投影。

## 架构

`App` 持有当前 project observation sessionId/projectId、focused conversationId/focusId、服务端 `PublicState`、低频角色/会话索引、连接状态、认证弹窗和当前 focus 的 extension UI 队列。`chatReducer` 只持有当前 focus 的 message/card transcript、工具投影和 token fallback。

```text
ServerEvent
→ 校验 protocolVersion / project observation
→ PublicState 更新权威 activeRun / busy
→ role_catalog_snapshot / project_snapshot 更新项目控制面
→ focus_attached 提交 conversationId + focusId
→ conversation_snapshot 原子 hydrate focused items
→ SessionEvent 按 focusId + runId 更新 transcript
→ conversation_item 按 focusId + cardId upsert
→ extension_ui_request/closed 按 sessionId + requestId 维护临时模态队列
→ Chat 纯展示与发送用户意图
```

## 决策

- `PublicState.activeRun`（以及由它派生的 busy）只描述当前 focus；项目其余会话的 activity 来自 `project_snapshot`。聊天 reducer 不维护第二份 busy。
- `outstandingRunId` 只覆盖“浏览器已交给 WebSocket、服务端运行状态尚未被观察到”的本地传输间隙，并为 Stop 提供 runId；匹配的 PublicState、terminal 或 error 会结算它，它不伪装成 Agent 状态。
- `PiSocket.send() === true` 只表示浏览器 transport 接受了帧，不表示服务端接受 prompt。只有匹配 focus 三元身份 + runId 的 `run_queued` 才是接收提交点：此时才能清空草稿并把 user message 投影进 transcript。
- prompt 接收确认前断线属于 unknown outcome。客户端保留内存草稿、重连恢复 durable conversation 后提示用户核对，绝不自动重发；显式切项目、新建或打开另一对话会清掉草稿，避免跨生命周期泄漏。
- 每次 initialize 或重连生成新的 observation sessionId；每次 initialize/open/create/focus 由服务端返回新的 focusId。
- 当前 transcript 身份是 `sessionId + conversationId + focusId`。即使 conversationId 再次相同，旧 focus 的 state/snapshot/live item 也必须丢弃。
- projectId/conversationId 随精确 `focus_attached` 提交；重连用新 sessionId 显式 `open` 当前 durable conversation，若尚未知 ID 才请求 `recent`。
- WebSocket transport open 与协议握手 ready 是两个状态；版本不兼容会失效 session/run/auth 并禁止发送。
- 启动页目录输入由 App 受控；内置目录浏览器只展示服务端确认过的临时浏览位置，不自动 initialize。导航结果按一次性 commandId 匹配；只有用户点击“选择当前文件夹”才替换输入，取消保留原值，错误可回到服务启动目录，断线会关闭临时浏览状态。
- 切目录先发送 `close_session`，随后清空本地 epoch；旧 state/event 一律忽略。
- 新建/切换对话复用同一 project observation sessionId，只更新 focusId。只有匹配 commandId 的 `focus_attached` 才提交本地 focus；pending state 暂存到 ack 后再应用。
- 当前会话被其它 Agent 删除时，客户端只接受精确匹配当前 `sessionId + projectId + conversationId + focusId` 的 `focus_invalidated`，原子清空 transcript、角色、草稿、pending prompt 和 extension UI，并回到角色选择页；迟到或其它 focus 的失效事件必须忽略。
- 项目空态和用户点击“新建会话”都进入完整 `RoleSelectionPage`。页面初始不选 default；显式选择可用角色并收到 create attach 前，不渲染 Chat/composer。
- 对话列表来自 `project_snapshot`，角色来自 `role_catalog_snapshot`，恢复消息/卡片来自 `conversation_snapshot`；它们的 truncated 提示必须可见，localStorage 不是数据 fallback。
- `project_snapshot` 同时投影持久创建来源；侧栏只为 `createdBy.kind=conversation` 的会话在标题旁显示紧凑 `Agent` 徽标，用户创建与来源未知的旧会话不显示，列表仍保持扁平。
- 扁平可折叠 `ConversationSidebar` 是项目会话的唯一列表/新建/打开/改名/删除控制面；模型连接抽屉不维护第二套会话入口。running/queued/cancelling/waiting 的活跃项优先，再按 attention 和最后活跃时间排序；spinner、沙漏、attention、unread 与 temporary 都来自服务端投影。
- 后台 actor 的创建、运行或完成只能更新侧栏/通知，不能改变 current focus、draft 或 transcript。用户在当前会话 running 时仍可切换观察。
- 删除以 sessionId + commandId 保持单一 pending 状态，匹配的 `command_complete` / error 才能结算；普通 snapshot 只更新列表，不能冒充删除回执。断线属于未知结果，应清除等待态并提示用户重新核对。
- state 只说明 focused runtime 已提交，不说明历史已经 hydrate；`conversationReady` 必须等匹配 focus 三元身份的 snapshot，期间 composer 和 `sendPrompt` 双重禁用，避免 hydrate 覆盖刚发送的本地消息。
- user、assistant、tool、usage 和 prompt error 全部按 runId 路由，不能更新“最后一条消息”来猜归属。
- OAuth UI 只接收当前 authFlowId；取消或新 flow 之后的旧 request/progress/complete 一律忽略。
- 右侧抽屉只负责“提供商 → 凭据 → 可用模型”的连接状态，不承载项目权限、会话生命周期或 Agent 行为控制。项目工具权限位于工作台顶栏和新会话角色选择页；当前会话的思考级别靠近 composer；角色管理只从新会话角色选择流程进入；会话改名位于左侧会话栏。
- 会话不再中途选择模型。角色管理只列已配置提供商当前可用模型，并把 provider/model 固定到模板。角色表单还显式控制“允许管理会话”：新建角色默认关闭，编辑时按模板原值显示；关闭意味着 Agent 完全看不到工作台会话工具。
- Pi 凭据属于当前用户并由所有项目共享；移除凭据必须明确提示全局影响并二次确认。空模型列表的恢复动作必须真的发送 `refresh_models`，不能用“重新打开设置”冒充刷新。
- API Key 保存和角色 CRUD 只由匹配 sessionId + operation + commandId 的 `command_complete` / error 结算；任何中途 state/catalog 刷新都不能关闭等待态。角色 update/delete 同时带 expectedRevision。
- default 在角色管理中固定置顶，没有删除按钮，但允许编辑。失效模板保留原 provider/model 展示，不能静默换成其它模型。
- Chat composer 底部显示会话固化角色 pill；详情展示快照 revision、简介、prompt、模型和会话管理能力，不提供切换操作。
- 跨会话消息使用独立 `SessionMessageCard`。卡片默认收起，只用一行显示方向、对端会话和状态；用户主动展开后才显示来源/目标标题、角色、短句柄、正文、结果与打开入口，状态更新不能擅自展开卡片。reducer 用 cardId 原地 upsert，并保持卡片在 transcript 中原来的位置；紧跟 assistant 的 outgoing/incoming 卡片在渲染时都归入同一回复的执行区，固定显示在工具调用之后、最终正文之前，完成或送达更新不能占据回答下方。没有可关联 assistant 的卡片仍按独立时间点展示。打开入口只由卡片自身的服务端 `peerExists` 决定，不能用截断侧栏做存在性判断。相关 peer 仍存在时可直接打开，临时会话删除后入口消失。
- extension UI 可在首个 state 前出现，因此对话框必须位于 Setup/Chat 之外的 session-scoped overlay；协调模式只把当前 focus 路由到浏览器，后台请求通过侧栏 attention 提示，不抢焦点。
- extension request 按到达顺序排队，server closed event、initialize、session change 或 disconnect 都会移除 stale 项；浏览器只回答当前 sessionId。
- OAuth、API Key 和 extension UI 同时出现时只展示一个模态边界；隐藏不等于丢弃输入草稿，只有 request 更换、权威 closed/cancel 或连接生命周期结束才清理。
- transcript 仅在用户位于底部附近时跟随流式输出；跟随时必须滚动 transcript 容器到真实 `scrollHeight`，不能滚动 padding 之前的占位节点。用户向上阅读后显示“回到最新消息”，不能用每个 delta 强制抢走滚动位置。composer 是受控草稿并按内容在有界高度内增长。
- 认证、设置和扩展交互拥有模态焦点边界。
- 工具模式的服务端 state 是执行真相；限制到 `read_only` 的本地意图立即持久化，放宽到 `full_access` 只能在服务端确认后持久化，重连不得在 ack 间隙扩大权限。
- PiSocket 的每个回调捕获创建它的 socket；旧 socket 以及 React effect 已销毁的旧 PiSocket 实例都不得操作当前连接。
- SDK 的 tool_started 投影代表 preflight 已观察到调用，工具卡先显示 pending；后续 `tool_prepared` 用扩展变换后的最终参数校准展示。
- 服务端累计 token 优先，reducer 累计值只作为旧状态或短暂缺失时的 fallback。

## 认知模型

客户端不是 Agent 状态的拥有者。它只保存“我正在观察哪个项目和 focus”以及该 focus 的事件投影；后台运行与 durable 消息属于服务端。

## 入口

- `src/client/App.tsx`
- `src/client/lib/socket.ts`
- `src/client/chat/reducer.ts`
- `src/client/components/Chat.tsx`
- `src/client/components/ConversationSidebar.tsx`
- `src/client/components/RoleSelectionPage.tsx`
- `src/client/components/RoleManagerDialog.tsx`
- `src/client/components/SessionMessageCard.tsx`
- `src/client/components/Setup.tsx`
- `src/client/App.test.tsx`
- `src/client/chat/reducer.test.ts`

## 坑点

- 不带当前 project observation sessionId 的迟到状态不能恢复已关闭的工作区；只匹配 conversationId 也不够。
- 设置、认证或 registry 错误不能作为 run finished 处理。
- `message_end` 可能没有任何流式 delta；最终文本校准必须由服务端 projector 提供。
- 断线重连会先清空旧投影，再用新 observation/focus identity 打开当前 conversation 并 hydrate；不得把旧浏览器消息和新快照拼接。
- 不能因为先收到 state 就开放输入；服务端按 state → project snapshot → conversation snapshot 发布，大历史会放大这个窗口。
- extension dialog 的提交不能靠本地关闭冒充成功；服务端会发送 `extension_ui_closed`，超时或 abort 时也由它清掉浏览器残影。
- 不要用 `provider.configured` 或任意新 state 推断刚提交的 Key 已保存；配置刷新可能先于原命令的失败错误到达。
- 不要在 `WebSocket.send()` 成功后清空 composer 或插入 user message；这会在帧未到达服务端时制造不可恢复的数据丢失窗口。
- 目录列表中的 `path` 只是浏览投影，不是项目 cwd；不要在用户确认和 initialize 校验前创建项目状态、加载资源或持久化会话。
- 后台 project snapshot 不能通过 conversationId 过滤；focused transcript event 也不能只按 conversationId 接收。两者处在不同观察边界。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
