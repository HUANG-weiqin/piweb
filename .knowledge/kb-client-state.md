# 客户端状态

`updated: 2026-07-29`

## 这个模块是干什么的

客户端负责连接本机服务、选择工作目录和会话角色、展示认证交互，并把项目控制面与当前 focus transcript 分开投影。

## 架构

`App` 持有当前 project observation sessionId/projectId、focused conversationId/focusId、服务端 `PublicState`、低频角色/会话索引、连接状态、认证弹窗和当前 focus 的 extension UI 队列。`chatReducer` 只持有当前 focus 的 message/card transcript、工具投影和 token fallback。

```text
ServerEvent
→ 校验 protocolVersion / project observation
→ PublicState 更新权威 activeRun / busy
→ project_activity_snapshot 更新跨项目工作区状态
→ role_catalog_snapshot / project_snapshot 更新当前项目控制面
→ focus_attached 提交 conversationId + focusId
→ conversation_snapshot 原子 hydrate focused items
→ pending_prompts_snapshot 替换当前 focus 的服务端持久队列投影
→ SessionEvent 按 focusId + runId 更新 transcript
→ conversation_item 按 focusId + cardId upsert
→ extension_ui_request/closed 按 sessionId + requestId 维护临时模态队列
→ Chat 纯展示与发送用户意图
```

## 决策

- `PublicState.activeRun`（以及由它派生的 busy）只描述当前 focus；项目其余会话的 activity 来自 `project_snapshot`。聊天 reducer 不维护第二份 busy。
- `outstandingRunId` 只覆盖“浏览器已交给 WebSocket、服务端运行状态尚未被观察到”的本地传输间隙，并为 Stop 提供 runId；匹配的 PublicState、terminal 或 error 会结算它，它不伪装成 Agent 状态。
- `PiSocket.send() === true` 只表示浏览器 transport 接受了帧，不表示服务端接受 prompt。只有匹配 focus 三元身份 + runId 的 `run_queued` 才是接收提交点：此时才能清空草稿并把 user message 投影进 transcript。
- prompt 接收确认前断线或显式切换项目属于 unknown outcome。客户端按 `workspaceKey + projectId + conversationId` 保留未确认草稿，切到其它项目/会话时不投影，切回原 focus 后恢复草稿并提示用户核对，绝不自动重发；只有匹配 focus 三元身份 + runId 的 `run_queued` 才能清掉该未确认草稿。
- 当前 focus busy、已有未确认 run 或已有 durable pending prompt 时，composer 仍可发送，但使用带新 `promptId + commandId` 的 `enqueue_prompt` 把原始用户意图持久提交给服务端；浏览器不再维护或自动泵送消息 FIFO，也不会自动 steer。每个 conversation 同时最多保留一个未结算 enqueue command，精确 ack/error 后才重新开放 composer，不限制已经 durable 的多条 prompt。`WebSocket.send()` 后草稿保持不变，只有匹配的 `command_complete(enqueue_prompt)` 或包含同一 promptId 的精确 `pending_prompts_snapshot` 才证明 durable commit。断线或工作区切换前尚未确认的 enqueue 按 `workspaceKey + projectId + conversationId` 保留 immutable submitted text/promptId 与独立的 retained draft/edit revision；确认只能清掉未被用户编辑的原 revision，即使用户把 A 改成 B 再改回 A 也不能按正文误判。后台 focus 的确定性 enqueue error 也必须恢复其正文和错误提示；即使命令属于旧 focus1、响应到达时 conversation 已经 A→B→A 进入 focus3，也按 workspace/project/conversation 恢复 UI，而命令结算本身仍校验旧 exact focus 身份。所有 retained intent 都绝不自动重放。
- `pending_prompts_snapshot` 是当前 focus 队列的唯一 UI 真相；切换 focus 立即清空旧投影，返回后等待服务端新快照，迟到快照必须同时匹配 sessionId、conversationId 和 focusId。`queued` 可逐条撤回；仅当当前 active run 精确处于 `running | waiting` 时，队列 header 才显示唯一的“同时 Steer N 条”。一次点击生成一个 batchId，只发送一条 `steer_all_pending_prompts`，不发送客户端 promptId 列表，也不循环单条 steer；服务端权威冻结当时全部 queued 记录并作为一个 SDK user message 处理。命令 pending 时，即使新快照出现晚到 queued 记录也不能再次发送；completion 按 commandId 结算，error 还必须匹配原 focus 与 exact runId。断线只清理本地等待态并依赖快照恢复，绝不自动重发 batch。`dispatching` 已越过可撤回边界；`attention` 表示服务端不能证明投递结果，只能显示原因并让用户移除记录，不能伪装成安全重试。相同正文的不同 promptId 必须分别显示和结算。
- 每次 initialize 或重连生成新的 observation sessionId；每次 initialize/open/create/focus 由服务端返回新的 focusId。
- 当前 transcript 身份是 `sessionId + conversationId + focusId`。即使 conversationId 再次相同，旧 focus 的 state/snapshot/live item 也必须丢弃。
- projectId/conversationId 随精确 `focus_attached` 提交；重连用新 sessionId 显式 `open` 当前 durable conversation，若尚未知 ID 才请求 `recent`。
- WebSocket transport open 与协议握手 ready 是两个状态；版本不兼容会失效 session/run/auth 并禁止发送。浏览器收到无法通过 `ServerEvent` runtime schema 的帧时，先显示有界 protocol error，再隔离并关闭该 socket，通过正常重连和 snapshot hydrate 恢复。服务端若在最终发送边界发现自己的投影不合法，则发送固定 error 并用专用 close code 终止 observation；客户端清空在线状态且不自动重连，避免确定性坏投影形成重连循环。两种路径都不能在可能缺失关键帧的连接上继续工作。
- 页面从后台、休眠或 bfcache 恢复时，把同一短时 burst 内的 `focus/pageshow/visibilitychange` 合并为一次 `refresh_view`；命令读取发送时最新的 project/focus 身份，pending focus、prompt 尚未确认、hidden、离线或握手未完成时不发送。恢复刷新不创建新 observation epoch，也不改变 transcript ownership。
- 工作区窄栏是浏览器本地的快速入口，只把最近目录列表与最后使用目录保存在 localStorage，不成为项目身份、信任或会话真相。服务端 `project_activity_snapshot` 只为这些本地入口补充跨项目 busy/attention 徽标，并与当前项目的详细 snapshot 分开保存；项目/会话切换不清除该目录，断线和协议失配必须清除，避免永久显示陈旧活动。目录截断时，未出现在快照中的本地工作区必须显示“活动状态未知”，不能被误画成 idle。首次没有记录时仍渲染完整工作台空态；握手后自动 initialize 最后工作区，用户确认切换时先发送 `close_session`，再生成新 observation epoch，旧 state/event 一律忽略。
- 开启工作区对话框的目录输入由 App 受控；内置目录浏览器只展示服务端确认过的临时浏览位置，不自动 initialize。导航结果按一次性 commandId 匹配；只有用户点击“选择当前文件夹”才替换输入，取消保留原值，错误可回到服务启动目录，断线会关闭临时浏览状态。
- 最近工作区不能把 initialize 成功当作目录永远存在。相关 initialize 失败时保留该入口并标记不可用，让用户重试、重新选择目录、切换其它工作区或显式从列表移除；不能因为一次失败自动删除本地记录。
- 新建/切换对话复用同一 project observation sessionId，只更新 focusId。切换命令成功交给 transport 后立即令旧 focus `conversationReady=false`，冻结 prompt、Stop、思考强度、压缩阈值和删除等 focus-bound 操作；pending focus 期间迟到的来源 snapshot 只能更新旧投影，不能把 ready 重新置真。只有匹配 commandId 的 `focus_attached` 才提交本地 focus，匹配 snapshot 后才重新启用 composer。切换失败仅在来源 focus 仍未变化时恢复原 ready 状态；pending state 暂存到 ack 后再应用。
- 当前会话被其它 Agent 删除时，客户端只接受精确匹配当前 `sessionId + projectId + conversationId + focusId` 的 `focus_invalidated`，原子清空 transcript、角色、草稿、pending prompt 和 extension UI，并回到角色选择页；迟到或其它 focus 的失效事件必须忽略。
- 项目空态和用户点击“新建会话”都进入完整 `RoleSelectionPage`。每张角色卡右下角直接提供管理与启动入口，不维护“先选卡牌、再点页面级开始”的中间状态；点击可用角色的启动图标后，在收到 create attach 前不渲染 Chat/composer。
- 对话列表来自 `project_snapshot`，角色来自 `role_catalog_snapshot`，恢复消息/卡片来自 `conversation_snapshot`；它们的 truncated 提示必须可见，localStorage 不是数据 fallback。
- `project_snapshot` 同时投影持久创建来源；侧栏只为 `createdBy.kind=conversation` 的会话在标题旁显示紧凑 `Agent` 徽标，用户创建与来源未知的旧会话不显示，列表仍保持扁平。
- 扁平可折叠 `ConversationSidebar` 是项目会话的唯一列表/新建/打开/改名/删除控制面；模型连接抽屉不维护第二套会话入口。桌面展开态可通过右边缘在 240–640px 内横向调整，折叠态与 600px 以下窄屏不提供 resize handle。running/queued/cancelling/waiting 的活跃项优先，再按 attention 和最后活跃时间排序；running/queued 使用与思考状态同尺寸、同转速的环形 spinner，沙漏、attention、unread 与 temporary 都来自服务端投影。
- 后台 actor 的创建、运行或完成只能更新侧栏/通知，不能改变 current focus、draft 或 transcript。用户在当前会话 running 时仍可切换观察。
- 删除 pending 固化 `sessionId + commandId + workspace/project/conversation`，删除当前 focus 时还固化 `focusId`；匹配的 `command_complete` / error 才能结算，且只有 exact 原 focus 仍在观察时才能清空当前 transcript。普通 snapshot 只更新列表，不能冒充删除回执。pending 期间禁止切换/新建 conversation，阻断 `A → B → A` 后旧删除回执清空新 focus 的 ABA；断线属于未知结果，应清除等待态并提示用户重新核对；initialize/工作区切换必须同步清掉旧 observation 的删除 pending，迟到的旧 session 回执不能锁住新项目按钮。
- state 只说明 focused runtime 已提交，不说明历史已经 hydrate；`conversationReady` 必须等匹配 focus 三元身份的 snapshot，期间 composer 和 `sendPrompt` 双重禁用，避免 hydrate 覆盖刚发送的本地消息。pending focus 期间 Chat 使用空 transcript 投影，不能继续展示旧 focus 的“工作过程”。
- tool、usage、prompt error 与停止仍按 runId 路由；但一个 run 可因 steering 包含多个 `assistant → user → assistant` 消息段。live projector 显式发送 user message 与 assistant segment start，reducer 只在该 run 的最新 assistant 段内追加 delta/tool，不能把“run 生命周期”误作“单个气泡生命周期”。切走再切回 running 会话时，恢复依赖服务端 conversation snapshot 的 live projection（含真实 runId、thinking/text/tool/status/usage），不依赖浏览器曾经收到后台 delta。
- OAuth UI 只接收当前 authFlowId；取消或新 flow 之后的旧 request/progress/complete 一律忽略。
- 右侧抽屉只负责“提供商 → 凭据 → 可用模型”的连接状态，不承载权限、会话生命周期或 Agent 行为控制。composer 底部控制按“当前角色 → 思考级别 → 上下文管理”排列；上下文用量、自动压缩和手动压缩属于同一个无外框视觉组，自动压缩阈值也在该组内展开。角色管理从新会话页的角色卡齿轮或添加卡进入，齿轮必须定位到对应角色；角色默认思考强度只列出所选模型真实支持的档位，模型没有可调档位时显示并锁定“模型默认”。会话改名位于左侧会话栏。
- 会话不直接选择模型或权限；它只在空闲时整体应用一个当前可用角色。角色管理只列已配置提供商当前可用模型，并把 provider/model 与工具权限固定到模板；新角色工具权限默认只读。角色表单还显式控制“允许管理会话”：新建角色默认关闭，编辑时按模板原值显示；关闭意味着 Agent 完全看不到工作台会话工具。
- Pi 凭据属于当前用户并由所有项目共享；移除凭据必须明确提示全局影响并二次确认。空模型列表的恢复动作必须真的发送 `refresh_models`，不能用“重新打开设置”冒充刷新。
- API Key 保存和角色 CRUD 只由匹配 sessionId + operation + commandId 的 `command_complete` / error 结算；任何中途 state/catalog 刷新都不能关闭等待态。角色 update/delete 同时带 expectedRevision。
- 初始化“默认”模板在角色管理中与其它角色相同，可编辑、可删除。失效模板保留原 provider/model 展示，不能静默换成其它模型。
- Chat composer 底部显示会话当前角色 pill；详情展示快照 revision、简介、prompt、模型、工具权限和会话管理能力，并列出当前项目可用模板。只有 history 已恢复、会话 idle、没有待提交消息或其它破坏性命令时才允许发送精确 `switch_conversation_role`；等待态只由匹配 commandId 的完成或错误结算。
- Chat 在 composer 底部现有控制行显示“自动压缩 N%”按钮，默认不增加 transcript 高度；点击后才展开 20%–90% 的会话级滑条，默认 70%。拖动只预览，松手或键盘调整结束才发送一次精确关联命令，等待相同 commandId 结算期间禁用控件。
- 同一控制行提供“手动压缩”按钮；只在在线、history 已恢复且会话空闲时启用，提交后等待精确 `compact_context` commandId 结算，不能把普通 state 刷新当成成功。手动 pending 按 `workspaceKey + projectId + conversationId` 保存，当前 UI 只投影当前 scope；A 的后台压缩不能让 B 显示 spinner，迟到 completion/error 仍按 commandId 回收 A，且结算前即使已切到 B 也不能删除 A。该 pending 与服务端 `PublicState.compacting` 共同驱动 transcript 底部的动态“正在压缩上下文”状态，因此点击后立即反馈，自动压缩与重连中的压缩也使用同一投影；压缩期间 composer 和角色切换禁用。
- 成功压缩后，completion snapshot 会把 Pi active branch 的持久 `compaction` 项 hydrate 为“上下文已压缩”分界线；它不属于 message、不会计入消息/token 投影，也不会被相邻会话卡片吸收到 assistant 回答中。
- 跨会话消息使用独立 `SessionMessageCard`。卡片默认收起，只用一行显示方向、对端会话和状态；用户主动展开后才显示来源/目标标题、角色、短句柄、正文、结果与打开入口，状态更新不能擅自展开卡片。reducer 用 cardId 原地 upsert，incoming/outgoing 都作为独立时间点穿插在 transcript 中；历史恢复只在 cardId 首次出现时切断 assistant 聚合，后续状态记录只更新原卡片，不能重复切段或跳到回答末尾。压缩记录同样是时间线边界。新卡片端点标题优先固化显式名称，否则使用有界首条消息 preview；服务端 wire 投影会从完整项目索引补齐旧卡片缺失的端点标题，但不改写 durable JSONL。打开入口只由卡片自身的服务端 `peerExists` 决定，不能用截断侧栏做存在性判断。相关 peer 仍存在时可直接打开，临时会话删除后入口消失。
- extension UI 可在首个 state 前出现，因此对话框必须位于 Setup/Chat 之外的 session-scoped overlay；协调模式只把当前 focus 路由到浏览器，后台请求通过侧栏 attention 提示，不抢焦点。
- extension request 按到达顺序排队，server closed event、initialize、session change 或 disconnect 都会移除 stale 项；浏览器只回答当前 sessionId。
- OAuth、API Key 和 extension UI 同时出现时只展示一个模态边界；隐藏不等于丢弃输入草稿，只有 request 更换、权威 closed/cancel 或连接生命周期结束才清理。
- 流式 transcript 不做浏览器端计时合并，reducer 收到网络投影后立即把最新权威文本交给 React；assistant 正文在流式期间按稳定 Markdown block 与当前活动尾部拆分：已经由空行或闭合代码围栏确定的 block 单独解析并保持稳定引用，尚未完成的尾部使用保留空白的纯文本连续显示；append-only delta 只让 splitter 消费新增完整行，`text_replaced` 或其它非追加校准会重置 splitter；run 结束后立即用收到的最终全文切换一次安全 Markdown。这个模型优先保证低延迟和连续输出，避免每个 delta 重新解析整篇文本，也不通过前端动画重播；历史消息、transcript block 和 token fallback 投影必须保留稳定引用或 memo 化，不能让当前 delta 重渲染整段历史；折叠的思考内容只在用户展开后解析。跟随滚动由每次文本提交驱动。跟随态不是硬锁定 `scrollHeight`：有内容的 transcript 在 composer 上方保留至少约三至四行正文的安全距离，最新内容先在更宽松的舒适区自然向下生长，越过下沿后再平滑回到区内。任何向上滚轮或实际向上位移都立即把滚动控制权交还用户；脱离后新 delta 不得改变 `scrollTop`，只显示“回到最新消息”，直到用户精确回到底部或主动点击按钮才重新跟随。主动点击是命令式硬跳：立即直接写入 `scrollTop = scrollHeight`，并在后续少数布局帧对同一 focus 重复硬跳，覆盖按钮消失、Markdown settle、工具折叠或 composer 高度变化带来的高度重排；它不能使用会被后续 delta 重定向的平滑动画，也不能依赖未来 delta 才生效。被动舒适区跟随仍可平滑滚动。composer 是受控草稿并按内容在有界高度内增长。
- 新 `sessionId + conversationId + focusId` 的 transcript 与同一 focus 的增量更新属于两个滚动观察边界：前者必须等匹配 snapshot hydrate 后无动画地直接定位到最新消息，不能从顶部复用被动跟随动画；后者才使用舒适区平滑跟随。重新打开同一 conversation 仍会获得新 focusId，因此也必须重新执行一次即时初始定位。
- transcript 使用 14px 的紧凑正文，并与 composer 共用响应式内容宽度：从原有 780px 阅读宽度随视口扩展，最高 1280px；窄屏仍由最小侧边距接管，不能产生横向溢出。assistant Markdown 的标题、段落、嵌套列表、引用、表格和代码只在 `.markdown` 内建立统一阅读节奏；宽表格与长代码由自身横向滚动承接，不能撑宽 transcript。
- assistant 的正文、思考和工具调用按真实到达顺序保存为 ordered parts；连续正文合并为正文块，连续思考或工具调用合并为一个默认收起的“工作过程”高层折叠区，即使只有一项也进入该区。折叠摘要必须实时反映内部状态：优先显示正在执行的工具动作与目标，其次显示当前思考预览；完成后显示最近一步动作、步骤数与工具调用数，仅当最近一步工具失败时显示错误态，历史失败不能压过后续进展。展开后以紧凑时间线保留思考/工具的原始顺序，思考和工具组仍各自可折叠；工具展开后每个工具仍是独立折叠项，以本地化动作、目标和状态概括调用，展开单项后按字段递归展示最终 args/result。正文、跨会话卡片和压缩项都会打断 activity 聚合，不能再把整轮思考/工具统一提到回复顶部。思考正文复用 Markdown 解析、清洗与排版，但折叠摘要只用纯文本预览，不能暴露 Markdown 标记噪声；内置工具优先提取文本输出，Agent 会话工具优先展示结构化 details，不能把宿主 JSON 包装直接暴露给用户。历史 Agent 的回复正文仍使用同一分隔线折叠语言；idle 时只保持最后一条 Agent 回复正文展开，新 run 期间同时保持当前 run 的相邻物理 assistant 段及它之前最近一条回复正文展开，直到 run 完成后才折叠旧正文。
- 每条 user 与 assistant 正文在既有消息间距中提供低干扰复制按钮，读取原始文本/Markdown 而不是渲染后的 HTML；assistant 操作组位于消息左下方，user 操作组保持右下方。“回到此处”只属于 user 消息，并先明确确认将彻底删除本条及之后所有消息。操作组必须使用内容宽度且禁止换行，不能被短 user bubble 压成竖排。运行中、恢复未完成、存在排队 prompt 或已有截断 pending 时禁用破坏性按钮。
- 截断只维护一个 `sessionId + commandId + conversationId + messageId` pending；命令成功发出后，composer 立即用所选 user 原文覆盖现有草稿，但客户端不先行 splice transcript，只接受匹配 focus 的服务端 snapshot 作为新内容，再用匹配 commandId 的 completion/error 结算等待态。命令未能发出时不得改写草稿。等待期间 composer、切换和新建会话禁用；断线属于未知结果，必须提示恢复后核对。
- 认证、设置和扩展交互拥有模态焦点边界。
- 会话角色快照中的工具权限是执行真相；客户端不保存全局工具模式偏好，也不提供项目级权限切换。
- PiSocket 的每个回调捕获创建它的 socket；旧 socket 以及 React effect 已销毁的旧 PiSocket 实例都不得操作当前连接。
- SDK 的 tool_started 投影代表 preflight 已观察到调用，工具卡先显示 pending；后续 `tool_prepared` 用扩展变换后的最终参数校准展示。恢复 snapshot 中没有对应 tool result 的调用同样保持 pending，只有 tool result 的 `isError=true` 才显示为失败。
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
- `src/client/components/WorkspaceRail.tsx`
- `src/client/components/WorkspacePlaceholder.tsx`
- `src/client/App.test.tsx`
- `src/client/chat/reducer.test.ts`

## 坑点

- 不带当前 project observation sessionId 的迟到状态不能恢复已关闭的工作区；只匹配 conversationId 也不够。durable prompt queue 属于服务端，浏览器只按完整 focus 身份投影快照；本地未确认草稿、队列命令 waiter 和手动压缩 pending 仍必须至少按 `workspaceKey + projectId + conversationId` 分区。
- 设置、认证或 registry 错误不能作为 run finished 处理。
- `message_end` 可能没有任何流式 delta；最终文本校准必须由服务端 projector 提供。
- 断线重连会先清空旧投影，再用新 observation/focus identity 打开当前 conversation 并 hydrate；不得把旧浏览器消息和新快照拼接。
- 不能因为先收到 state 就开放输入；服务端按 state → project snapshot → conversation snapshot 发布，大历史会放大这个窗口。
- extension dialog 的提交不能靠本地关闭冒充成功；服务端会发送 `extension_ui_closed`，超时或 abort 时也由它清掉浏览器残影。
- 不要用 `provider.configured` 或任意新 state 推断刚提交的 Key 已保存；配置刷新可能先于原命令的失败错误到达。
- 不要在 `WebSocket.send()` 成功后清空 composer 或插入 user message；这会在帧未到达服务端时制造不可恢复的数据丢失窗口。
- 目录列表中的 `path` 只是浏览投影，不是项目 cwd；不要在用户确认和 initialize 校验前创建项目状态、加载资源或持久化会话。
- 后台 project snapshot 不能通过 conversationId 过滤；focused transcript event 也不能只按 conversationId 接收。两者处在不同观察边界。
- `projectionSeq` 缺口表示当前工作过程投影不可证明完整；reducer 必须停止套用后续 delta 并触发 `refresh_view`，只能由匹配且不早于当前 watermark 的 snapshot 清除缺口。同 focus 的旧 snapshot 或在已进入 sequenced 模式后缺少序号的 snapshot 必须丢弃，不能回退 transcript/watermark；`conversation_item` 只能匹配当前 watermark，不能替代丢失的 run delta 推进序号。
- `message.text/thinking/tools` 是复制、token 与旧快照兼容投影，不再携带顺序语义。只有确实没有 `parts` 的旧快照可以退回历史固定布局；任何新实时或恢复路径都必须生成 ordered parts，不能再次从三个聚合字段猜时间顺序。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
