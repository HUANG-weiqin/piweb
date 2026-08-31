# 客户端状态

`updated: 2026-08-31`

## 这个模块是干什么的

客户端负责连接本机服务、选择工作目录和会话角色、展示认证交互，并把项目控制面与当前 focus transcript 分开投影。

## 架构

`App` 持有当前 project observation sessionId/projectId、focused conversationId/focusId、服务端 `PublicState`、低频角色/会话索引、连接状态、认证弹窗和当前 focus 的 extension UI 队列。`chatReducer` 只持有当前 focus 的 message/card transcript、工具投影和 token fallback。

```text
ServerEvent
→ 校验 protocolVersion / project observation
→ PublicState 更新权威 activeRun / busy
→ project_activity_snapshot 更新跨项目工作区状态
→ conversation_run_settled 触发当前项目的实时完成提示
→ role_catalog_snapshot / project_snapshot 更新当前项目控制面
→ focus_attached 提交 conversationId + focusId
→ conversation_snapshot 原子 hydrate focused items
→ conversation_snapshot.pendingPrompts 恢复当前 focus 的"等待中"列表
→ SessionEvent 按 focusId + runId 更新 transcript
→ conversation_item 按 focusId + cardId upsert
→ extension_ui_request/closed 按 sessionId + requestId 维护临时模态队列
→ Chat 纯展示与发送用户意图
```

## 决策

- `PublicState.activeRun`（以及由它派生的 busy）只描述当前 focus；项目其余会话的 activity 来自 `project_snapshot`。聊天 reducer 不维护第二份 busy。
- `outstandingRunId` 只覆盖“浏览器已交给 WebSocket、服务端运行状态尚未被观察到”的本地传输间隙，并为 Stop 提供 runId；匹配的 PublicState、terminal 或 error 会结算它，它不伪装成 Agent 状态。
- `PiSocket.send() === true` 只表示浏览器 transport 接受了帧，不表示服务端接受 prompt。idle prompt 以匹配 focus 三元身份 + runId 的 `run_queued` 为接收点；busy prompt 则以匹配 focus 三元身份 + promptId 的 `prompt_admitted` 为接收点。只有对应回执才能清空草稿并投影 user intent。
- prompt 接收确认前断线或显式切换项目属于 unknown outcome。客户端按 `workspaceKey + projectId + conversationId` 保留未确认草稿，切到其它项目/会话时不投影，切回原 focus 后恢复草稿并提示用户核对，绝不自动重发；只有对应 idle `run_queued` 或 busy `prompt_admitted` 才能清掉该未确认草稿。
- composer 始终发送带新 `promptId + runId` 的 `prompt`。busy 时 `prompt_admitted` 只证明消息已进入 SDK 易失 steering 队列，因此 UI 显示“等待中”而不是“已发送”；匹配的 `prompt_delivered` 才把它结算为已投递。断线或工作区切换前尚未确认的 prompt 按 `workspaceKey + projectId + conversationId` 保留当前草稿，用户继续编辑时同步更新该 retained draft。所有 retained intent 都绝不自动重放；进程重启后等待中消息消失（服务端无持久队列），UI 据 snapshot 反映真实状态。
- `conversation_snapshot.pendingPrompts` 是当前 focus 等待中列表的唯一 UI 真相；切换 focus 立即清空权威 reducer 投影，返回后等待服务端快照，迟到快照必须同时匹配 sessionId、conversationId 和 focusId。命中 presentation cache 时可以只读显示目标会话上一帧，但不能把其中 pending 项 hydrate 回 reducer 或当作已恢复真相。`prompt_delivered` 移除对应等待中项（按 promptId 精确匹配）；`run_finished(aborted)` 清空全部等待中项（SDK steering 队列已被 abort 清空）。相同正文的不同 promptId 必须分别显示和结算。
- 每次 initialize 或重连生成新的 observation sessionId；每次 initialize/open/create/focus 由服务端返回新的 focusId。
- 当前 transcript 身份是 `sessionId + conversationId + focusId`。即使 conversationId 再次相同，旧 focus 的 state/snapshot/live item 也必须丢弃。
- LoopList 展开重置仍按完整 focus 身份；transcript item 的 React key 使用当前 observation 的 `sessionId + conversationId + item id`，仅同会话换 focus 时复用。未 ready 的空投影不显示空会话 onboarding，同步提示不参与主布局。
- projectId/conversationId 随精确 `focus_attached` 提交；重连用新 sessionId 显式 `open` 当前 durable conversation，若尚未知 ID 才请求 `recent`。
- WebSocket transport open 与协议握手 ready 是两个状态；版本不兼容会失效 session/run/auth 并禁止发送。浏览器收到无法通过 `ServerEvent` runtime schema 的帧时，先显示有界 protocol error，再隔离并关闭该 socket，通过正常重连和 snapshot hydrate 恢复。首次异常关闭立即重试，后续失败有界退避；裸 transport open 不能重置退避，只有同一 socket 持续稳定打开 10 秒才算恢复，避免服务端反复 `open → malformed frame → close` 形成零延迟自旋。服务端若在最终发送边界发现自己的投影不合法，则发送固定 error 并用专用 close code 终止 observation；客户端清空在线状态且不自动重连，避免确定性坏投影形成重连循环。两种路径都不能在可能缺失关键帧的连接上继续工作。
- 页面从后台、休眠或 bfcache 恢复时，把同一短时 burst 内的 `focus/pageshow/visibilitychange` 合并为一次 `refresh_view`；命令读取发送时最新的 project/focus 身份，pending focus、prompt 尚未确认、hidden、离线或握手未完成时不发送。恢复刷新不创建新 observation epoch，也不改变 transcript ownership。
- 工作区窄栏是浏览器本地的快速入口，只把最近目录列表与最后使用目录保存在 localStorage，不成为项目身份、信任或会话真相。服务端 `project_activity_snapshot` 只为这些本地入口补充跨项目 busy/attention 徽标，并与当前项目的详细 snapshot 分开保存；项目/会话切换不清除该目录，断线和协议失配必须清除，避免永久显示陈旧活动。目录截断时，未出现在快照中的本地工作区必须显示“活动状态未知”，不能被误画成 idle。首次没有记录时仍渲染完整工作台空态；握手后自动 initialize 最后工作区。A→B 切换直接生成新 observation epoch 并发送 `initialize`，不先发 `close_session`；服务端 coordinated initialization 自行 detach 旧 view，后台 actor/run 保持运行。当前工作区图标左上角的低干扰关闭按钮在桌面悬停或键盘聚焦时出现，在无 hover 设备上保持可见；关闭只从浏览器最近目录列表移除当前入口、detach 当前 observation 并回到持久空态，即使仍有其它入口也不自动选择，绝不删除目录、`.piweb`、会话或 Git 数据。
- 开启工作区对话框的目录输入由 App 受控；内置目录浏览器只展示服务端确认过的临时浏览位置，不自动 initialize。导航结果按一次性 commandId 匹配；只有用户点击“选择当前文件夹”才替换输入，取消保留原值，错误可回到服务启动目录，断线会关闭临时浏览状态。
- App 为最多 4 个已访问工作区保留 LRU 内存展示缓存，内容是该工作区最后一次 `conversationReady` 时的 ChatState 与项目/角色/会话控制面；它不写 localStorage，也不拥有 transcript。切换命中缓存时一个渲染周期内展示旧投影，但标记“正在同步”，保持 transport 在线语义并冻结 prompt、Stop、角色、新建/改名/删除、压缩和设置等当前项目控制命令；工作区窄栏仍可继续切到另一个目标。同时用缓存中的 durable conversationId 发送 exact `open`，cache miss 才用 `recent`。只有匹配新 `sessionId + conversationId + focusId` 的 `conversation_snapshot` 能用权威内容替换缓存并解锁；只有 pending initialize 请求 `recent` 时，匹配当前 `sessionId + initialize commandId` 且明确没有 conversation 的 `focus_attached` 才能作为空项目结算边界，清除临时缓存展示并解锁角色选择。exact `open` 必须等同一目标 conversationId 和已定义 focusId 的 attachment；空 attachment 必须忽略并继续只读同步。projectId 不匹配、initialize 失败或移除工作区都会丢弃对应缓存；旧 observation 的 state/snapshot/live event 以及旧 command 的 acknowledgement 仍按完整身份拒绝。普通断线重握手也从当前工作区 LRU 恢复只读展示并建立新 observation；若 cached exact open 已失败，则清除该 conversation 提示，使后续重连或重试改走 `recent`，不能无限重试已失效 ID。
- workspace initialize 与 conversation focus/create 的延迟探针由客户端独立 timing owner 持有，不进入产品状态或线协议：intent 按 `sessionId + commandId` 关联，精确 `focus_attached` 记录 attach，精确 `conversation_snapshot`（`recent` 空项目则为无 conversation 的 initialize attach）记录 ready。替换、发送失败、命令失败、断线和销毁只清理当前 marks；旧 observation/command 不能完成新 transition。Performance API 不完整时整体 no-op。
- 最近工作区不能把 initialize 成功当作目录永远存在。相关 initialize 失败时保留该入口并标记不可用，让用户重试、重新选择目录、切换其它工作区或显式关闭该浏览器入口；命中过展示缓存的失败也必须先退出同步态并清掉伪投影，不能因为一次失败自动删除本地记录。
- App 另以 `workspaceKey + projectId + conversationId` 为键保留最多 8 个 conversation presentation LRU，和 4 项 workspace LRU 独立逐出。缓存只保存最近已投影的 ChatState、PublicState、角色与 window，不保存 draft 或 pending command，也不 hydrate 当前 reducer；每项以 `authority: preview | snapshot` 明确记录展示来源，snapshot 后的 matching live delta/card 会更新权威展示引用。切换命中时立即展示目标会话上一帧与“正在同步会话”，cache miss 才显示空 transcript；无论命中与否都保持只读，只有新 `sessionId + conversationId + focusId` 的 snapshot 才解锁。`focus_invalidated` 和精确删除回执必须同步逐出 conversation presentation，以及仍指向该 conversation 的 workspace projection，不能等待异步项目快照后才清；非截断 `project_snapshot` 确认缺席时也精确逐出，`truncated=true` 的缺席则不是删除证明。App 用 `projectId → conversationId set` 的同步 ref 保存当前 session 最近一次非截断成员证明；截断快照不能覆盖它，session/project 生命周期更换时必须清空。任何缓存写入（包括迟到 preview）都必须先拒绝已被该完整项目快照确认缺席的 conversation，避免 stale workspace 投影或晚到事件把已删目标重新带回 LRU。
- `conversation_preview` 只是 server-only prepare 阶段的提前展示：客户端只接受精确匹配当前 pending initialize/focus 的 `sessionId + commandId + workspaceKey + 已知 projectId + 目标 conversationId`；`recent` initialize 的目标 conversationId 可由服务端选定，exact open/focus 则不能变更目标。preview items 必须交给独立的 `chatReducer` 投影，并配套只含事件 cwd/toolMode/role、`busy=false` 且没有 focusId/activeRun 的最小 `PublicState`，不能写入当前 focus ref、主 chat reducer、pending prompt/admission 或 conversationReady。preview 在匹配 `focus_attached` 后继续只读显示，由精确 `conversation_snapshot` 替换并升级为 snapshot cache；命令错误、observation replacement 和断线只清临时展示。preview 期间 prompt、Stop、角色切换、回退、删除、压缩和连接设置全部保持禁用，不能把较早看见 transcript 等同于获得执行权限。
- 新建/切换对话复用同一 project observation sessionId，只更新 focusId。切换命令成功交给 transport 后立即令旧 focus `conversationReady=false`，冻结 prompt、Stop、思考强度、压缩阈值和删除等 focus-bound 操作，但当前工作区的会话选择与侧栏折叠仍可用，transcript 仍可滚动和复制。active workspace 中新的 `focus_conversation` 可替换尚未 attach 的旧 focus command，也可在 attach 后、权威 snapshot 到达前再次导航：替换命令必须先成功写入 WebSocket，再替换 pending command、timing intent 与只读 presentation；发送失败保持原 transition 不动。客户端用有界 superseded-command registry 保留同一替换链中已成功发送的旧 command；最新目标等待期间，registry 中旧 command 的 exact `focus_attached` 是服务端已经提交该 focus 的权威证明，必须按 WebSocket 到达顺序更新底层 executable fallback，但不能替换最新目标的只读展示或解锁操作。fallback 的 matching state/snapshot 独立延迟保存；最新命令失败时恢复最后一次已观察的 fallback，但 deferred snapshot 只作为只读展示，不能直接恢复 `conversationReady`。客户端必须保持 `conversationSyncing=true / conversationReady=false`，并用该 fallback 的精确 `sessionId + projectId + conversationId + focusId` 发送 `refresh_view`；只有随后匹配的新 snapshot（也可以是原本仍在途的 snapshot）才能补齐可能遗漏的 live suffix 并解锁。刷新发送失败仍保持 unready 并明确报错，绝不能回退到更早的浏览器假定来源。重复 attach 在首次消费 registry entry 后丢弃；最新 exact attach、命令结算、observation replacement 和断线都会清空 registry/deferred authority，所以最新成功后迟到的旧 attach 无法回滚 focus。旧 preview/error 仍不能改变最新目标。只有当前 executable focus 且不存在不同 pending target 时，重复点击当前会话才短路；有不同 pending target 时点击当前 focus 仍是一条合法 replacement。workspace initialize、create、删除、截断、待确认 prompt 或角色切换等冲突仍拒绝 conversation focus。
- 当前会话被其它 Agent 删除时，客户端只接受精确匹配当前 `sessionId + projectId + conversationId + focusId` 的 `focus_invalidated`，原子清空 transcript、角色、草稿、pending prompt 和 extension UI，并回到角色选择页；迟到或其它 focus 的失效事件必须忽略。
- 项目空态和用户点击“新建会话”都进入完整 `RoleSelectionPage`。每张角色卡右下角直接提供管理与启动入口，不维护“先选卡牌、再点页面级开始”的中间状态；点击可用角色的启动图标后，在收到 create attach 前不渲染 Chat/composer。
- 对话列表来自 `project_snapshot`，角色来自 `role_catalog_snapshot`，恢复消息/卡片与 LoopList 来自 `conversation_snapshot`；localStorage 不是数据 fallback。项目索引继续显示 `truncated` 提示；conversation 则保存精确 `window`，分别提示“省略较早历史”“从 turn 中间开始”和“已选内容被缩略”，不能把三种覆盖差异重新合并为一个布尔值。focus change、disconnect 和新 observation 都先重置 window 与 LoopList，只有匹配 focus 的 snapshot 能恢复；live LoopList 更新也必须匹配完整 focus 身份且不能进入 presentation cache。
- `project_snapshot` 同时投影持久创建来源和服务端解析的可选 `rootConversationId`。侧栏只把当前快照中 root 与至少一个 descendant 都存在的集合画成协作组；缺字段、缺 root 或没有成员的会话按独立会话显示，绝不从 `createdBy` 递归猜测。`createdBy.kind=conversation` 仍只控制紧凑 `Agent` 来源标记。Chat 顶栏的“根任务 › 当前 Agent”同样只在当前 focus history ready 且 root/current summary 都存在时派生；切换、cache/preview 或事实缺失期间省略，不能展示旧来源。
- 完成音效只消费精确匹配当前 `sessionId + projectId` 的实时 `conversation_run_settled`：仅 `outcome=completed` 且 `createdBy.kind=user` 时播放，因此后台用户会话也可提示，而 Agent 创建会话、中止、失败、初次 hydrate 和重连恢复都不响。音效由浏览器 Web Audio API 本地合成双音，不依赖外部素材；页面用首次 pointer/keyboard 交互解锁自动播放策略，失败时静默降级，不能影响会话生命周期。客户端不得从 `project_snapshot` 的 busy→idle 猜测完成。
- `ConversationSidebar` 是项目会话唯一的新建/打开/改名/删除控制面；模型连接抽屉不维护第二套入口。侧栏唯一列表按 root 把会话投影为一级协作组，不提供“按任务 / 全部”模式切换；组展开和空闲成员 reveal 只属于组件内易失状态，不写 localStorage 或 App。只有服务端已确认的 focus 换组时才自动展开新组一次；pending target 只可改变视觉选择，失败回退不得重开用户手动收起的来源组。工作区/项目 scope 变化会重置展开与 idle reveal，复制项目即使 conversationId 相同也不能串用组件意图；后台 activity 或新 Agent 同样不得重开。成员按 attention、active、unread 与最后活跃时间排序，普通 idle 默认只显示最近三项；current 只决定选择态并确保当前成员可见，不参与排序，点击会话不会把它提升到顶部；组摘要始终同时给出最新活动时间。root、成员与独立会话三条渲染路径复用同一个 `ConversationRow`，并由分组投影调用点显式传入 `root / member / standalone` 纯展示变体，禁止从 `createdBy` 猜层级。主任务和独立主会话使用一级中性卡片、较大标题与文字标签；成员使用缩进连接轨道、冷色浅底、较小字号和“协作 Agent”分区。activity、attention、unread 与 temporary 仍来自服务端事实并保留状态图标和行内“改名/删除”按钮；运行色只表达状态，不覆盖整行的身份层级。改名/删除仍复用原 modal 与命令 gate。对客户端 `ConversationSummary` 消费点的同构扫描确认，除该侧栏行外只有命令判定和 transcript 会话卡片，不存在第二套会话导航行。
- Sidebar 显式分开 `navigationEnabled` 与 `actionsEnabled`：conversation focus 同步中前者保持开启，使选择、视图和折叠可以替换目标，后者关闭以禁止新建/改名/删除；任何已存在的 conversation focus 只要尚未 `conversationReady`，侧栏 lifecycle actions、对应 App handler、Chat 模型设置和 ConnectionDrawer 都必须关闭，不能用 deferred/cached transcript 获得写入能力。没有 conversation focus 的真正空项目不受这个 readiness gate 影响，仍可新建会话和打开模型连接。transport offline 时两者都关闭，不能把同步伪装成离线。桌面展开态可通过右边缘在 240–640px 内横向调整，折叠态与 600px 以下窄屏不提供 resize handle。组和成员继续按 attention、running/queued/cancelling/waiting、unread 与最后活跃时间排序，current 不参与排序优先级；running/queued 使用与思考状态同尺寸、同转速的环形 spinner；running 会话标题使用成功态绿色，waiting 标题使用警告态黄色；沙漏、attention、unread 与 temporary 都来自服务端投影。
- `WorkspaceRail`、`ConversationSidebar` 与 `Chat` 按各自事实使用 `React.memo`，把 workspace activity、conversation index 与 focused transcript 三种重渲染边界分开：单纯 chat reducer 的 streaming delta 不得重算 rail/sidebar，单纯 `project_activity_snapshot` 也不得重渲染 Chat 或 transcript item。App 交给这些边界的选择、添加、折叠、新建、改名、删除、发送、中止、设置、思考、压缩、角色和回退等回调使用 stable latest-callback；wrapper identity 不变，callback ref 只在 commit-phase 发布最新闭包，因此被 Suspense 放弃的 concurrent render 不能改变旧 DOM 事件所调用的逻辑。Sidebar 的协作组投影只在 conversation/busy 输入变化时重算，时间 formatter 为模块级单例；App 的顶栏协作路径也按 conversations/current/readiness memo，不能让 transcript delta 重新扫描项目索引。每行按 conversation 引用、选择、activity/attention、在线权限和 deletion/busy 等真实 props 独立 memo。项目/会话 snapshot、focused state/chat 与在线状态变化仍必须发布新事实并更新自己的 projection，不能为了 bailout 固定旧值。
- 后台 actor 的创建、运行或完成只能更新侧栏/通知，不能改变 current focus、draft 或 transcript。用户在当前会话 running 时仍可切换观察。
- 删除 pending 固化 `sessionId + commandId + workspace/project/conversation`，删除当前 focus 时还固化 `focusId`；匹配的 `command_complete` / error 才能结算，且只有 exact 原 focus 仍在观察时才能清空当前 transcript。普通 snapshot 只更新列表，不能冒充删除回执。pending 期间禁止切换/新建 conversation，阻断 `A → B → A` 后旧删除回执清空新 focus 的 ABA；断线属于未知结果，应清除等待态并提示用户重新核对；initialize/工作区切换必须同步清掉旧 observation 的删除 pending，迟到的旧 session 回执不能锁住新项目按钮。
- state 只说明 focused runtime 已提交，不说明历史已经 hydrate；`conversationReady` 必须等匹配 focus 三元身份的 snapshot，期间 composer 和 `sendPrompt` 双重禁用，避免 hydrate 覆盖刚发送的本地消息。pending focus 期间 Chat 只能使用目标 conversation 的只读 presentation cache；未命中时使用空 transcript，绝不能继续展示来源 focus 的“工作过程”或把缓存当成可操作状态。
- tool、usage、prompt error 与停止仍按 runId 路由；但一个 run 可因 steering 包含多个 `assistant → user → assistant` 消息段。live projector 显式发送 user message 与 assistant segment start，reducer 只在该 run 的最新 assistant 段内追加 delta/tool，不能把“run 生命周期”误作“单个气泡生命周期”。切走再切回 running 会话时，恢复依赖服务端把 durable timeline 与未持久化 live suffix 交接后的 conversation snapshot（当前 run message 含真实 runId/thinking/text/tool/status/usage），不依赖浏览器曾经收到后台 delta。
- OAuth UI 只接收当前 authFlowId；取消或新 flow 之后的旧 request/progress/complete 一律忽略。
- 右侧抽屉只负责“提供商 → 凭据 → 可用模型”的连接状态，不承载权限、会话生命周期或 Agent 行为控制。模型刷新按钮始终显示，即使没有 provider、provider 未配置、目录为空或已有模型；只按 online、busy 和当前 refresh command pending 禁用。点击后固化 `sessionId + commandId`，只显示精确匹配的 pending/result，成功保留 `ok=true`，失败显示 error/alert；断线或 session replacement 清除 pending 并显示 unknown/重试提示。远程供应商目录刷新失败只属于设置回执，不落为全局错误。composer 底部控制按“当前角色 → 思考级别 → 上下文管理”排列；上下文用量、自动压缩和手动压缩属于同一个无外框视觉组，自动压缩阈值也在该组内展开。角色管理从新会话页的角色卡齿轮或添加卡进入，齿轮必须定位到对应角色；角色默认思考强度只列出所选模型真实支持的档位，模型没有可调档位时显示并锁定“模型默认”。角色默认服务层级同样只读取所选模型的 `PublicModel.serviceTiers`，不按 provider/model 猜测；`null` 显示“供应商默认”，`priority` 显示“快速”，切换到不支持现有非空层级的模型时回到 `null`。会话改名位于左侧会话栏。
- 服务层级采用“冻结角色默认 + 当前会话覆盖”：用户或 Agent 创建会话时从角色快照取得默认值，因此队友不会丢失角色的快速设置；composer 仍可只为当前会话调整并持久化覆盖，显式切换角色则重置到新角色默认。composer 选项只读取服务端对当前模型 `PublicModel.serviceTiers` 的显式投影，不按 provider 或 model ID 猜测；服务端没有投影 tier 且当前选择为 `null` 时不显示。`null` 在 UI 中显示为“供应商默认”，`priority` 在线路值中保持不变但显示为“快速”。已持久化 tier 因模型目录漂移而不再可用时，仍以禁用的“不可用”选项显示，同时继续列出当前请求路由投影的 tiers；用户可清回 `null` 或直接替换为任一受支持 tier，客户端不能静默替换。提交不做乐观更新，只在 history 已恢复、会话 idle 且未压缩时发送；pending 固化 `sessionId + conversationId + focusId + commandId`，只有同一 focus 的精确回执才能结算，断线则提示状态未知。
- 会话不直接选择模型或权限；它只在空闲时整体应用一个当前可用角色。角色管理只列已配置提供商当前可用模型，并把 provider/model、默认服务层级与工具权限固定到模板；新角色默认使用供应商服务层级且工具权限为只读。角色表单还显式控制“允许管理会话”：新建角色默认关闭，编辑时按模板原值显示；关闭意味着 Agent 完全看不到工作台会话工具。
- Pi 凭据属于当前用户并由所有项目共享；移除凭据必须明确提示全局影响并二次确认。空模型列表的恢复动作必须真的发送 `refresh_models`，不能用“重新打开设置”冒充刷新。
- API Key 保存和角色 CRUD 只由匹配 sessionId + operation + commandId 的 `command_complete` / error 结算；模型刷新同样只接受精确 `refresh_models + sessionId + commandId` 的成功/失败回执，stale 回执必须忽略；任何中途 state/catalog 刷新都不能关闭等待态。角色 update/delete 同时带 expectedRevision，update 还携带对话框独立保存的 `expectedSystemPrompt`，同 revision 的目录刷新不能静默替换编辑中的 base/draft。
- 初始化“默认”模板在角色管理中与其它角色相同，可编辑、可删除。失效模板保留原 provider/model 展示，不能静默换成其它模型。
- Chat composer 底部显示会话当前角色 pill；详情展示快照 revision、简介、prompt、模型、工具权限和会话管理能力，并列出当前项目可用模板。只有 history 已恢复、会话 idle、没有待提交消息或其它破坏性命令时才允许发送精确 `switch_conversation_role`；等待态只由匹配 commandId 的完成或错误结算。
- 非空 LoopList 在 composer 内上方以只读折叠面板显示“执行中 / 已暂停 / 已完成”（CSS 状态键仍为 `executing/paused/completed`），折叠摘要同时显示完成数与剩余项数；Agent 对非空列表的 ID/文字/勾选更新不能擅自收起用户已展开的面板，只有 focus 变化、清空或转为全完成才收起。全完成仍保留，空列表则完全不挂载容器、不占高度。展开项只能查看不可编辑，composer 用 ResizeObserver 发布实际高度给 transcript inset，避免覆盖最新消息。
- Chat 在 composer 底部现有控制行显示“自动压缩 N%”按钮，默认不增加 transcript 高度；点击后才展开 20%–90% 的会话级滑条，默认 70%。拖动只预览，松手或键盘调整结束才发送一次精确关联命令，等待相同 commandId 结算期间禁用控件。
- 同一控制行提供“手动压缩”按钮；只在在线、history 已恢复且会话空闲时启用，提交后等待精确 `compact_context` commandId 结算，不能把普通 state 刷新当成成功。手动 pending 按 `workspaceKey + projectId + conversationId` 保存，当前 UI 只投影当前 scope；A 的后台压缩不能让 B 显示 spinner，迟到 completion/error 仍按 commandId 回收 A，且结算前即使已切到 B 也不能删除 A。该 pending 与服务端 `PublicState.compacting` 共同驱动 transcript 底部的动态“正在压缩上下文”状态，因此点击后立即反馈，自动压缩与重连中的压缩也使用同一投影；压缩期间 composer 和角色切换禁用。
- 成功压缩后，completion snapshot 会把 Pi active branch 的持久 `compaction` 项 hydrate 为“上下文已压缩”分界线；它不属于 message、不会计入消息/token 投影，也不会被相邻会话卡片吸收到 assistant 回答中。
- 跨会话消息使用独立 `SessionMessageCard`。卡片默认收起，只用一行显示方向、对端会话和状态；用户主动展开后才显示来源/目标标题、角色、短句柄、正文、结果与打开入口，状态更新不能擅自展开卡片。reducer 用 cardId 原地 upsert，incoming/outgoing 都作为独立时间点穿插在 transcript 中；历史恢复只在 cardId 首次出现时切断 assistant 聚合，后续状态记录只更新原卡片，不能重复切段或跳到回答末尾。压缩记录同样是时间线边界。新卡片端点标题优先固化显式名称，否则使用有界首条消息 preview；服务端 wire 投影会从完整项目索引补齐旧卡片缺失的端点标题，但不改写 durable JSONL。打开入口只由卡片自身的服务端 `peerExists` 决定，不能用截断侧栏做存在性判断。相关 peer 仍存在时可直接打开，临时会话删除后入口消失。
- extension UI 可在首个 state 前出现，因此对话框必须位于 Setup/Chat 之外的 session-scoped overlay；协调模式只把当前 focus 路由到浏览器，后台请求通过侧栏 attention 提示，不抢焦点。
- extension request 按到达顺序排队，server closed event、initialize、session change 或 disconnect 都会移除 stale 项；浏览器只回答当前 sessionId。
- OAuth、API Key 和 extension UI 同时出现时只展示一个模态边界；隐藏不等于丢弃输入草稿，只有 request 更换、权威 closed/cancel 或连接生命周期结束才清理。
- 流式 transcript 不做浏览器端计时合并，reducer 收到网络投影后立即把最新权威文本交给 React；assistant 正文在流式期间按稳定 Markdown block 与当前活动尾部拆分：已经由空行或闭合代码围栏确定的 block 单独解析并保持稳定引用，尚未完成的尾部使用保留空白的纯文本连续显示；append-only delta 只让 splitter 消费新增完整行，`text_replaced` 或其它非追加校准会重置 splitter；run 结束后立即用收到的最终全文切换一次安全 Markdown。这个模型优先保证低延迟和连续输出，避免每个 delta 重新解析整篇文本，也不通过前端动画重播；历史消息、transcript block 和 token fallback 投影必须保留稳定引用或 memo 化，不能让当前 delta 重渲染整段历史；折叠的思考内容只在用户展开后解析。跟随滚动由每次文本提交驱动。跟随态不是硬锁定 `scrollHeight`：有内容的 transcript 在 composer 上方保留至少约三至四行正文的安全距离，最新内容先在更宽松的舒适区自然向下生长，越过下沿后再平滑回到区内。任何向上滚轮或实际向上位移都立即把滚动控制权交还用户；脱离后新 delta 不得改变 `scrollTop`，只显示“回到最新消息”，直到用户精确回到底部或主动点击按钮才重新跟随。主动点击是命令式硬跳：立即直接写入 `scrollTop = scrollHeight`，并在后续少数布局帧对同一 focus 重复硬跳，覆盖按钮消失、Markdown settle、工具折叠或 composer 高度变化带来的高度重排；它不能使用会被后续 delta 重定向的平滑动画，也不能依赖未来 delta 才生效。被动舒适区跟随仍可平滑滚动。composer 是受控草稿并按内容在有界高度内增长。
- assistant Markdown 只把 token 层确认的 fenced `mermaid` 代码块升级为图；流式尾部、思考内容和尚未展开的历史回复仍保留源码。Mermaid 仅在遇到可见的稳定或最终代码块时动态加载；全局可变 renderer 串行执行，并在单次超时后对本页熔断，不能让悬挂任务继续阻塞或与后续任务并发。输入边界拒绝外部资源、资源标签和可携带图片的 `@{...}` metadata；单块 50k、整条 assistant 回复 8 图/100k 的预算按正文顺序固定分配，跨工具或思考分隔的正文与流式稳定块共享，折叠段的展开顺序不能改变准入。输出使用 strict 配置和 SVG 二次清洗，只允许本地片段 URI/CSS URL，不调用交互绑定。加载、语法、清洗、超时或超限失败都必须保留源码并明确回退。异步图形改变高度后只能在用户仍处于跟随态时重新对齐 transcript。
- 当前 observation 中新的 `sessionId + conversationId` 展示目标与同一目标的增量更新属于两个滚动观察边界：有内容的 cache/preview 在首次提交时就无动画地直接定位到最新消息，不能先从顶部绘制再等待权威 snapshot；未 ready 且无内容的目标仍等 snapshot hydrate 后执行首次定位。随后同一 conversation 的 preview focus 升级为 executable focus 不重新初始化滚动；用户未脱离跟随时由舒适区吸收 snapshot 差异，已主动向上滚动时则保持控制权。切到其它 conversation 再返回，或 observation sessionId 改变，仍是新的展示目标并重新定位。
- transcript 使用 14px 的紧凑正文，并与 composer 共用响应式内容宽度：从原有 780px 阅读宽度随视口扩展，最高 1280px；窄屏仍由最小侧边距接管，不能产生横向溢出。assistant Markdown 的标题、段落、嵌套列表、引用、表格和代码只在 `.markdown` 内建立统一阅读节奏；宽表格与长代码由自身横向滚动承接，不能撑宽 transcript。
- assistant 的正文、思考和工具调用按真实到达顺序保存为 ordered parts；连续正文合并为正文块，连续思考或工具调用合并为一个默认收起的“工作过程”高层折叠区，即使只有一项也进入该区。`request_edit_budget`、带非空 `singleWaitCommitment` 的 exact wait，以及返回 `single_wait_commitment_required` 的 wait 是例外：它们直接从现有 tool args/result 派生为常显 `CommitmentCard`，从相邻工作过程移除以免重复。卡片只属于作出声明的 conversation，通常使用中性 intent 样式；等待未开始使用 warning，已声明但工具动作被拒绝时使用 error，可展开复用原始 ToolDetails。它不新增 reducer/protocol/persistent Commitment 真相，重连仍由 JSONL toolCall/toolResult 恢复。编辑卡的“新增额度”保留该次声明事实；“本轮剩余”则按同一 run 可见的 `request_edit_budget` 与后续 builtin `edit/write` 结果顺序派生最新 ledger 快照，不能冻结在申请完成时。历史投影以 durable run settlement 为同一 run（包括 guidance 分段）补齐 `runId`；wire 截断和工具详情裁剪必须保留有界的最新 `piwebEditBudget` ledger 事实；单消息工具时间线裁剪则以不增加可见 part 的 sidecar 方式保留最新 budget/mutation 工具。若终态 mutation 仍看不到 ledger，客户端显示“本轮剩余未知”，不能回退到旧快照。折叠摘要必须实时反映内部状态：优先显示正在执行的工具动作与目标，其次显示当前思考预览；完成后显示最近一步动作、步骤数与工具调用数，仅当最近一步工具失败时显示错误态，历史失败不能压过后续进展。展开后以紧凑时间线保留思考/工具的原始顺序，思考和工具组仍各自可折叠；工具展开后每个工具仍是独立折叠项，以本地化动作、目标和状态概括调用，展开单项后按字段递归展示最终 args/result。正文、跨会话卡片和压缩项都会打断 activity 聚合，不能再把整轮思考/工具统一提到回复顶部。思考正文复用 Markdown 解析、清洗与排版，但折叠摘要只用纯文本预览，不能暴露 Markdown 标记噪声；内置工具优先提取文本输出，Agent 会话工具优先展示结构化 details，不能把宿主 JSON 包装直接暴露给用户。历史 Agent 的回复正文仍使用同一分隔线折叠语言；idle 时只保持最后一条 Agent 回复正文展开，新 run 期间同时保持当前 run 的相邻物理 assistant 段及它之前最近一条回复正文展开，直到 run 完成后才折叠旧正文。
- 每条 user 与 assistant 正文在既有消息间距中提供低干扰复制按钮，读取原始文本/Markdown 而不是渲染后的 HTML；assistant 操作组位于消息左下方，user 操作组保持右下方。“回到此处”只属于 user 消息，并先明确确认将彻底删除本条及之后所有消息。操作组必须使用内容宽度且禁止换行，不能被短 user bubble 压成竖排。运行中、恢复未完成、存在排队 prompt 或已有截断 pending 时禁用破坏性按钮。
- 截断只维护一个 `sessionId + commandId + conversationId + messageId` pending；命令成功发出后，composer 立即用所选 user 原文覆盖现有草稿，但客户端不先行 splice transcript，只接受匹配 focus 的服务端 snapshot 作为新内容，再用匹配 commandId 的 completion/error 结算等待态。命令未能发出时不得改写草稿。等待期间 composer、切换和新建会话禁用；断线属于未知结果，必须提示恢复后核对。
- 认证、设置和扩展交互拥有模态焦点边界。
- 会话角色快照中的工具权限是执行真相；客户端不保存全局工具模式偏好，也不提供项目级权限切换。
- PiSocket 的每个回调捕获创建它的 socket；旧 socket 以及 React effect 已销毁的旧 PiSocket 实例都不得操作当前连接。
- SDK 的 tool_started 投影代表 preflight 已观察到调用，工具卡先显示 pending；后续 `tool_prepared` 用扩展变换后的最终参数校准展示。恢复 snapshot 中没有对应 tool result 的调用同样保持 pending，只有 tool result 的 `isError=true` 才显示为失败。
- 服务端累计 token 优先，Chat 从当前 message items 的 usage 汇总值只作为旧状态或短暂缺失时的 fallback。

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
- `src/client/components/CommitmentCard.tsx`
- `src/client/components/Setup.tsx`
- `src/client/components/WorkspaceRail.tsx`
- `src/client/components/WorkspacePlaceholder.tsx`
- `src/client/App.test.tsx`
- `src/client/chat/reducer.test.ts`

## 坑点

- 不带当前 project observation sessionId 的迟到状态不能恢复已关闭的工作区；只匹配 conversationId 也不够。浏览器只按完整 focus 身份投影服务端 admissions；本地未确认草稿和手动压缩 pending 仍必须至少按 `workspaceKey + projectId + conversationId` 分区。
- 设置、认证或 registry 错误不能作为 run finished 处理。
- `message_end` 可能没有任何流式 delta；最终文本校准必须由服务端 projector 提供。
- `run_started` 创建的客户端空 assistant 占位符必须在首个 `assistant_message_started` 到达时接管服务端 `projectionId`，并且只有确实找到占位符时才能走接管分支。否则同 focus 的 live snapshot hydrate 会改变 React message key，重挂载并关闭用户已经展开的工作过程；空 transcript 下也不能把 `findIndex() === -1` 误判为“占位符位于末尾”而吞掉 assistant start。
- 断线重连会先清空旧投影，再用新 observation/focus identity 打开当前 conversation 并 hydrate；不得把旧浏览器消息和新快照拼接。
- 不能因为先收到 state 就开放输入；服务端按 state → project snapshot → conversation snapshot 发布，大历史会放大这个窗口。
- extension dialog 的提交不能靠本地关闭冒充成功；服务端会发送 `extension_ui_closed`，超时或 abort 时也由它清掉浏览器残影。
- 不要用 `provider.configured` 或任意新 state 推断刚提交的 Key 已保存；配置刷新可能先于原命令的失败错误到达。模型目录刷新也不能用新 state 推断成功；必须等精确 refresh command result，断线则保持 unknown，不自动重发。
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
