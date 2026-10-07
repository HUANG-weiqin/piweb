# 线协议

`updated: 2026-10-07`

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

协议由 `src/shared/protocol.ts` 的 `PROTOCOL_VERSION` 标识；版本变更摘要紧邻该常量。

## 数据预算

| 边界 | 当前限制与语义 |
|---|---|
| prompt/steer 图片 | PNG/JPEG/WebP/GIF、canonical Base64；最多 4 张，单张解码后 8 MiB、合计 16 MiB |
| 客户端命令帧 | 完整 JSON 的 UTF-8 字节数最多 24 MiB，包含 Base64、文本转义和身份；发送前、共享 parser、WebSocket maxPayload 共用上限 |
| 历史图片读取 | `open_image` 单张解码后 16 MiB；与上传预算独立，cold reopen 不套上传帧限制 |
| 服务端事件 | 独立 64 MiB；发送前必须复验 schema、序列化及字节数，失败用固定 protocol error + 专用 close code 终止已丢帧的 observation |
| 目录浏览 | 列表字节预算为 1,000,000 减 64 KiB，另受项数限制，不随命令帧扩大 |

浏览器上传读取原文件，不为上传预算强制缩放；Pi 的 `images.autoResize` 仍按用户偏好执行。图片随原始 user/tool-result message 持久化，普通 wire/history 只投影 marker 与精确 active-branch locator `{messageId: entry.id, imageOrdinal}`（user 用 offset，tool result 用 contentIndex）。`open_image → conversation_image` 是一次性、完整 focus + command + locator 关联的读取，服务端复验 MIME、Base64 和签名；客户端仅点击时建立临时 Blob URL。被预算裁掉 locator 的 marker 必须显示“图片已省略”，不能猜测图片来源。桌面截图另遵守[运行时截图边界](kb-server-runtime.md#桌面截图与坐标授权)。

协议版本历史以 `PROTOCOL_VERSION` 旁摘要为准，不在知识页复制版本流水账。当前不接受旧 `messages[]` transcript、缺少 ordered parts、直接 `select_model` 或项目级工具模式切换；持久格式的兼容范围与尚未兑现的承诺见[会话兼容性](kb-project-sessions.md#兼容性合同差异)。

## 决策

- 协议只暴露 UI 实际消费的稳定事件。
- projectId/conversationId 是持久身份，sessionId 是浏览器项目观察 epoch，focusId 是一次 conversation attach，runId 是一次逻辑执行（可在宿主恢复中保持）；协议必须显式携带消费方需要的身份，不能混用。projectId 与所有 ephemeral correlation ID 是 UUID；conversationId 使用 Pi Web 的兼容策略（1–256 个 ASCII 字母数字及 `._-`，首尾为字母数字），以接纳常见的旧 durable Pi 非 UUID 会话，同时给 metadata、notebook 与 wire 一个共同的宿主上限；这不是 Pi SDK 自身的长度合同。
- `project_snapshot` 与 `role_catalog_snapshot` 用 `sessionId + projectId` 过滤；它们描述整个项目，不能因更新来自后台 conversation 就丢弃。
- `project_activity_snapshot` 是连接级、跨当前 observation 的进程目录，只汇总 coordinator 已加载项目的 cwd/projectId、busy conversation 数和 coordinator-owned attention 数；它不携带 transcript、当前 focus 或浏览器私有 unread。最多 100 项，超出时置 `truncated=true`。
- `conversation_run_settled` 是当前项目 observation 的实时结算边界：只在 actor 已持久写入精确 run settlement 并回到 idle 后发送，携带 `sessionId + projectId + conversationId + runId + outcome + createdBy`。它覆盖 focused 和后台 conversation，但不会由 initialize、refresh 或 snapshot 重放；浏览器不能从可能合并的 activity 快照反推这类瞬时完成事件。
- v64 删除持久 Bash 收尾摘要；旧 `piweb.bash_execution_notice.v1` 仅严格读取兼容，不写入、不投影。v65 的 focused `conversation_snapshot.bashActivity` 与低频 `bash_activity` 改为会话级 `{ running, stopping, cleanupUnknown }` 或 null，移除 runId，计数和最多 8，idle 也可非空。live event 仍精确携带 `sessionId + conversationId + focusId`，不携带 stdout、任务表、历史结果或第二 busy；恢复读当前 Actor 而非历史工具结果。
- v65 新增 `bash_task_notification` history item，按活动分支物理顺序投影 `piweb.bash_task_notification.v1` custom message。`tasks` 为 1–4 个严格 `ConversationBashTask`（taskId、command、status、nullable exitCode、durationMs、可选 stopReason/partial/outputFile），command 最多 256 UTF-8 bytes、正文最多 8 KiB；原始输出尾每任务最多 1 KiB，仅入正文，不进 details。completed 只允许 exitCode 0、无 partial/stopReason。持久卡片不是可恢复执行 registry，也不为 task_id 授权控制。
- `ConversationActivity.waiting` 只投影 `targetCount`（1–32），不能把首个 target 伪装成唯一等待目标。当前高频 PublicState 只投影 waiting phase，不暴露虚假的 `waitingFor`。
- 当前 transcript 的 state、snapshot、live run 和卡片必须匹配 `sessionId + conversationId + focusId`。每次 initialize/open/create/focus 都分配新 focusId，因此快速 `A → B → A` 时第一次 A 的迟到帧不能污染第二次 A。
- prompt/abort 显式携带上述 focus 三元身份和 runId；底层即时引导仍可使用 `steer + commandId + 精确 active runId`，由 `command_complete(steer)` 确认 SDK 已把该 user message 持久送入当前 run，而不只是放进易失内存队列。steer 是控制通道，不能排在被当前 run 占用的 actor 串行队列之后；错 focus 或错 runId 必须失败，不能作用于当前观察。
- 消息与忙闲无关，随时可发。busy 时浏览器 `prompt` 直接进 SDK steering 队列（当前工具序列结束后、下一次模型调用前注入，用户可及时纠正方向；排队消息一次全部注入）：服务端回 `prompt_admitted`（匹配 focus 三元身份 + promptId）即证明 SDK 已接受入队；其 `runId` 必须是实际接受输入的 run，不能取 prompt 命令自带的 disposable runId。`prompt_delivered`（raw user 持久化证明）才结算为已投递；admitted 是"等待中"，delivered 才是"已发送"。进程重启仍会丢失易失队列，UI 必须诚实显示等待中。撤回只认精确 `prompt_withdrawn` 证明：单条手动撤回用 `reason=manual`；abort 先逐对象发真实移除的 `reason=abort`，再清空其余 steering/followUp 队列；已 drain 尚未持久投递的 admissions/guidance tracking 保留至 raw durable delivery 或 settlement，不能宣称取消。当前页面只保留自己提交的原输入供手动恢复；错过取消/投递凭据的原件只能标记待核对，不自动重发。
- `conversation_snapshot` 携带有界 `pendingPrompts`（当前 focus 的 admitted 项，`promptId + text` FIFO），断线/多窗口据此恢复等待中列表；它不是 transcript，不进入高频 PublicState。客户端不得自建队列、重发或按正文去重；单条撤回只走服务端 `withdraw_prompt` 权威控制。focused snapshot 始终显式带该数组，空 FIFO 也必须发出，不能用字段缺失表达“没有变化”。
- v39 的 `conversation_snapshot.loopList` 与 `loop_list_update` 使用严格三态 item：`status` 只能是 `pending | active | completed`，不接受 `checked`。新持久写入只使用 `piweb.loop_list.v2` / `piweb.loop_list_continue.v2`；服务端可严格读取 canonical v1 `checked` history，并仅在内部规范化成 v2（`checked=true → completed`、`false → pending`），不改写既有 JSONL，也绝不推导 active。未知版本、非 canonical v1 或混用字段均 fail closed。列表允许多个 active，数组顺序只用于稳定展示；active 是持久关注状态，不能作为 `activeRun` 或 busy 的替代证明。完整有界 LoopList 仍只进入 focused snapshot 与匹配 `sessionId + conversationId + focusId` 的 live event，不进入高频 `PublicState`、`project_snapshot`、无 focus preview 或 presentation cache；切换 observation 时客户端先清空，后续匹配 snapshot 才恢复权威值。
- `browse_directory` 是 initialize 前的连接级只读控制命令，使用连接内一次性 commandId 关联 `directory_listing` 或 command error；`path` 是临时浏览位置，不是已提交项目 cwd。列表同时受项数和序列化字节数限制，迟到或不匹配的结果必须忽略。
- v69 的 `inspect_workspace_sessions / repair_workspace_sessions` 同属连接级 socket control，以 `cwd + 一次性 commandId` 关联 `workspace_sessions_inspected / workspace_sessions_repaired` 或 command error，不依赖 initialize/focus 成功。回执的 `cwd` 原样关联请求拼写，磁盘/租约所有权仍按 canonical cwd 处理；目录别名不能让正确回执被丢弃。诊断返回最多 100 个坏文件及 `truncated`；修复仅接受 basename 与当前诊断的 `expectedRevision`，每条计划绑定文件版本而非客户端 conversationId。丢弃不完整尾 fragment 必须显式携带用户同意；空 files 用于重新证明恢复 foundation。修复结果可同时有已提交 `backups` 和后续 `error`，不能按 transport send 或普通 state/snapshot 推导成功。写入控制命令参与 reload/close drain，冻结后拒绝新修复；结果失效后只能 fresh 检查，不自动重发。磁盘范围见[会话数据修复](kb-project-sessions.md#工作区会话数据修复)。
- `set_color_scheme` 同样属于 socket control，而非 project/session/actor 命令：只携带连接内一次性 commandId 与严格枚举值。服务端必须先在用户级 store 完成串行原子持久化，再广播最终 `UiPreferences`；写失败只给来源连接返回匹配 `operation + commandId` 的 command error，不能改变内存权威或向其它连接广播。`ui_preferences_changed.commandId` 仅是来源提交回执，缺失时只是跨连接 authority 更新，浏览器不能据此清除自己的未保存预览。
- v60 的 `save_custom_provider / delete_custom_provider / refresh_custom_providers / probe_custom_provider_models` 也是 socket control（无 sessionId），因为 `models.json` 是进程级用户配置而与会话无关。写盘必须回传上次快照的 `expectedRevision`（文件字节 sha256，文件缺失为 `"absent"`）并在共享配置队列内完成，成功后向所有连接广播 `custom_providers_snapshot`（仅来源带 commandId）；`refresh_custom_providers` 的读取失败不算命令失败，而是同一快照事件里的 `error` 字段。`custom_provider_models_probe` 只由发起来源以 commandId 关联。快照只暴露 `storedAuth` 形态、`authEnvNames`、`extraFields`、`editable` 与 `builtinOverride`，永不携带 apiKey 值。详细语义见 [kb-custom-providers.md](kb-custom-providers.md)。
- OAuth login/request/progress/response/cancel/complete 显式携带 authFlowId；浏览器不得接收非当前 flow 的帧。
- 扩展对话响应携带 sessionId / requestId；requestId 一次性使用，错类型、错选项、重复和 stale response 都是 no-op。
- `extension_ui_request → extension_ui_response → extension_ui_closed` 是当前 focus 的临时 rendezvous，不是持久状态；断线或 focus change 会销毁浏览器 route，但不会销毁 conversation actor。request 可在首个 PublicState 前出现。
- 扩展 `notify` 是有界、session-scoped 的 fire-and-forget 事件，不赋予任何工具许可。
- initialize 的 conversation target 是 `recent | new(roleId) | open(conversationId)`；客户端不能提交 session 文件路径。空项目的 `recent` 返回“项目已打开、没有 active conversation”，不会偷偷创建 default 会话。
- `focus_conversation` 和 `create_conversation` 使用一次性 commandId；服务端用同 commandId 的 `focus_attached` 确认新 focus。客户端在精确确认前不能把 pending target 当成当前 transcript。
- v42 的可选 `transitionDiagnostics` 只属于成功的 `initialize | focus_conversation` 调用，不覆盖独立 `create_conversation` 命令、错误或后续 refresh。非空 focus 只把它附在本次 attach 后的首个 `conversation_snapshot`；空项目 `initialize(recent)` 没有 snapshot，才附在无 conversation/focus 的 `focus_attached`，且 `snapshotProjectionMs=null`。payload 使用同一 commandId 与 operation 关联，version 固定为 1；`validationMs / contextOrCatalogMs / presentationOrTargetReadMs / actorActivationOrLeaseMs` 以及非空 focus 的 `snapshotProjectionMs` 都是 0–3,600,000 的有限非负整数。actor phase 是 lease、权威文件证明与 runtime activation 的整体 envelope；snapshot phase 只测同步构建，不含 enqueue、delivery 或异步 `project_snapshot`。它不进入 `PublicState` 或磁盘，失败仍只走既有 error，浏览器必须再匹配 active transition 的 session、command、operation 与已 attach focus 后才消费。
- `conversation_preview` 是 v33 的只读展示事件，只携带 `sessionId + commandId + projectId + conversationId` 关联的 cwd、toolMode、可选固化角色和有界 items/window；它没有 focusId，不是 transcript 或命令 authority。只有 cold exact/recent/focus 在只读完整性证明、当前命令身份以及 emit 前同步 actor/opening gate 都仍有效时才可能发送；display projection 失败可静默跳过，warm actor 直接等待其 live snapshot。后续精确 `focus_attached + conversation_snapshot` 才建立可执行 focus 并替换 preview。
- `refresh_view` 是页面恢复后的无等待只读重同步，必须精确携带当前 `sessionId + projectId` 以及成对出现的 `conversationId + focusId`；身份已经变化时服务端静默丢弃。它刷新 state、角色目录和项目索引；只要 focused actor 未压缩，就可重发 conversation snapshot。active run 的 snapshot 由 actor 把 durable active branch 与尚未持久化的 live suffix 精确交接后生成，不能用纯持久快照覆盖正在流式生成的尾部，也不能把同一物理消息重复投影两次。
- `refresh_models` 是 session-scoped 的联网配置命令，必须携带当前 `sessionId + commandId`。它使用 `refreshConfiguration({ allowNetwork: true, force: true, signal })`；成功只能由同一 correlation 的 `command_complete` 证明，失败由同一 correlation 的 command error 结算，不能用普通 state/catalog 更新冒充成功。连接内 commandId 不可复用；15 秒超时是明确失败，断线属于 unknown，生命周期替换会取消旧命令，三者都不得自动重发。服务启动后另有一次非阻塞、`force:true`、15 秒可取消的后台刷新，离线跳过；运行中仅手动强刷，不发送 wire 回执。
- 当前 focus 被其它 Agent 删除时，服务端发送带完整 `sessionId + projectId + conversationId + focusId` 的 `focus_invalidated(reason=deleted)`；客户端只结算精确匹配的观察身份，然后回到角色选择页。不能从缺少当前项的截断列表猜测删除。
- 创建新 conversation 必须显式 roleId。`default` 只是角色 ID，不是省略选择时的隐含值。
- 工具模式只有 `read_only | full_access`，由角色模板持有并复制到 conversation 当前角色快照；角色 CRUD payload 必须同时携带模型默认思考强度和工具模式。v27 不接受 `initialize.toolMode` 与 `set_tool_mode`，协议仍没有逐工具询问命令或待回答状态。
- v58 的 `rename_conversation` 必须携带一次性 `commandId`，并同时匹配当前 `sessionId` 和目标 `conversationId`；成功只由同一 `sessionId + commandId` 的 `command_complete(rename_conversation)` 结算，失败也必须用相同关联身份的 command/settings error。settings error 专指内存标题已应用但 durable persistence 未获证明，不能被普通项目快照或未关联错误冒充成功/失败。
- `delete_conversation` 携带 sessionId、一次性 commandId 和目标 conversationId；浏览器不能提交文件路径。成功和失败都用同一 sessionId + commandId 精确结算。
- `truncate_conversation` 携带一次性 commandId、精确 `sessionId + conversationId + focusId` 和 snapshot 中的 durable messageId。assistant 聚合 ID 使用 `assistant:<entryId>`，仅由服务端剥离前缀并解析物理锚点；锚点必须属于最终物理 leaf 定义的 active branch，截断只保留它之前的 active-branch 前缀，并重新接上不可 rewind 的 delivery receipt 及其所需 settlement ledger。成功前服务端先发布截断后的完整 focused snapshot，再发送同 commandId 的完成事件，客户端不得本地猜测删除结果。
- 角色 CRUD 使用 `create_role/update_role/delete_role + sessionId + commandId`；create/update 的 role payload 必须包含 nullable `compactionModel`、nullable `defaultServiceTier` 与 `canManageSessions`，update/delete 还携带 expectedRevision；`update_role` 另携带当前 UI base 的必填 `expectedSystemPrompt`，服务端在串行边界重新读取并拒绝外部 prompt 冲突，不能用迟到 snapshot 冒充提交成功。初始化模板没有删除特权。
- 会话 primary 模型、nullable `compactionModel`、初始思考强度、默认服务层级、工具权限和会话管理能力都来自当前角色快照；切换角色不会隐式改变显式 compaction model。v27 的 `switch_conversation_role` 携带精确 `sessionId + conversationId + focusId + commandId + roleId`，只允许 idle focus，并在服务端发布新 state、project snapshot 与 conversation snapshot 后完成；协议没有直接 `select_model` 命令。API Key 命令继续按 sessionId + commandId 精确结算。
- `compact_context` 携带一次性 commandId 和精确 `sessionId + conversationId + focusId`；只允许空闲 conversation，成功后服务端先刷新 state / snapshot，再发送同 commandId 的完成事件。
- `PublicState.compacting` 是当前 focused conversation 正在执行 Pi 标准压缩的可恢复瞬时状态；手动与自动压缩共用该字段。它独立于 `busy/activeRun`，因为自动压缩可能发生在 run 结算尾部，而手动压缩没有 runId。v41 的可选 `compactionAttempt` 只表示 default 路径已首次真正调用 request stream：严格携带 UUID `id`、`generator=default`、冻结 policy `follow_primary | explicit` 和实际 `requestTarget(provider/id)`；两个 identity 分量都必须非纯空白且各不超过 1024 UTF-8 bytes；preparation、custom hook 或已经结束时可以仍有 `compacting` 而没有 attempt。它只来自当前 focused actor，runtime replacement/结束会清除；不得用它覆盖普通 Agent `selectedModel`，也不得从 role 配置提前合成。
- `set_compaction_threshold` 携带一次性 commandId 和精确 `sessionId + conversationId + focusId`，只接受 20–90 的整数百分比；`PublicState.compactionThresholdPercent` 是当前会话权威值，成功或失败必须按 commandId 精确结算。
- v37 的服务层级合同使用稳定 wire 值 `auto | default | flex | scale | priority`。`PublicModel.serviceTiers` 只在服务端确认该模型的请求 API 路由能表达相应 tier 时投影有界选项；它描述适配器能力，不承诺当前账号或模型一定获准。v38 给角色模板和冻结 conversation role snapshot 增加 nullable `defaultServiceTier`：新会话没有覆盖记录时采用它，Agent 创建队友同样继承；旧角色目录按 `null` 迁移已实现，但旧 conversation 快照的补值承诺与 strict parser 有差距，见[兼容性合同差异](kb-project-sessions.md#兼容性合同差异)。`PublicState.selectedServiceTier` 始终以 `ServiceTier | null` 投影当前会话有效选择，即使目录漂移后该非空值已不在模型选项中也不能隐藏。`null` 表示 dispatch 省略 provider 字段并使用供应商默认行为，不是显式 `default`。
- `set_service_tier` 携带一次性 commandId、精确 `sessionId + conversationId + focusId` 和 nullable tier；服务端只允许 idle、非 compacting 的会话修改，并拒绝当前模型请求路由未声明支持的非空值。客户端 pending 还必须保持同一 focus，且只由匹配 `sessionId + commandId` 的完成回执或带完整 focus 身份的 command error 结算，防止 `A → B → A` 的迟到结果。显式角色切换会把有效层级重置为新角色默认，并在同一角色变更记录中持久化；旧角色变更记录缺该字段时保留原选择是既有兼容承诺，但当前 parser 要求 selectedServiceTier；不要宣称该读时兼容已经实现，见[合同差异](kb-project-sessions.md#兼容性合同差异)。协议不提供其它静默重置、降级或 optimistic selection。
- 高频 `PublicState` 不携带完整项目索引；当前连接没有 focused actor 时允许 conversation/focus/model/runtime 字段缺席（这不证明项目为空）。共享 wire validator 要求 `conversationId` 与 `focusId` 成对、`busy` 与 `activeRun` presence 精确一致；activeRun 以及 conversationName、selectedModel、compacting、compactionAttempt、usage/threshold 等 actor 字段必须有完整 focus。`compactionAttempt` 还要求 `compacting=true`，但反向不成立：无 run 的 compacting preparation/custom 路径合法。v56 的 `project_snapshot` 低频发布会话 summary 及 role/activity/必填 `compacting`/attention/unread，并可携带服务端已解析、遵循 conversation ID 语法的 `rootConversationId`；不投影 orchestration depth/sourceRunId。`compacting` 是 actor-owned、独立于 activity/busy/run 的瞬时 bool；冷/持久索引 fallback 明确为 `false`。compaction 边沿只发布 summary-only 项目快照，不能借此重 hydrate focused transcript、state 或 run。v48 不再投影 peer lifecycle flag，所有 Agent 创建的 peer 会话都按持久会话处理。最多 100 项且整帧不超过 750,000 UTF-8 bytes；保留顺序优先 current、active、compacting、attention、unread，再按最后活跃时间，但 count 与最终 JSON byte 裁剪优先把同一 root 组整体装入或移除。单组自身超过硬预算时只保留 root/current/最高优先成员且置 `truncated=true`，绝不突破 wire budget。成员条数或整组预算省略会置 `truncated=true`；单字段的展示级裁剪不改变成员覆盖。
- `project_snapshot.coverage="complete"` 表示本次取得了完整、稳定、安全且 header identity 唯一的成员集合，不表示所有 JSONL 正文都刚完成全量 audit。浏览器目录发现可复用文件版本绑定的展示摘要；无扫描 current-index seed 仍为 `unknown`。只有 `complete && !truncated` 的缺席才可逐出展示缓存，exact open 的正文、身份与 lease 验证仍独立执行。
- `role_catalog_snapshot` 独立发布用户级角色目录；每个 role payload 都含必填 nullable `compactionModel`，最多 64 个角色，名称/简介与 durable store 一致按 80/1000 个 Unicode 字符校验，system prompt 按 128 KiB UTF-8、model provider/id 各按 1024 UTF-8 bytes 校验，不可用原因最多 4096 个字符。客户端命令帧限制为 24 MiB；服务端事件使用独立的 64 MiB 上限，以容纳最坏情况下 JSON 转义后的完整有界角色目录。socket 发送边界必须先用同一 `serverEventSchema` 复验运行时事件，再执行序列化与发送上限；schema、序列化或大小失败会发送各自固定且可解析的 protocol error，然后以专用 close code 终止已经丢帧的 observation，不能在缺失关键帧后继续运行，也不能把浏览器必然拒绝的原帧发出去。
- `conversation_snapshot` 携带固化角色（含必填 nullable `compactionModel`）和必填有界 `ConversationHistoryItem[]`；不再在线路上保留 `messages[]` 兼容投影。普通 user/assistant 是 `message`，跨会话 incoming/outgoing 是 `session_message`，Pi active branch 上的持久压缩记录是 `compaction` 分界项。v41 的 compaction marker 可选 `provenance`：default 成功携带与真实 attempt 相同的 `attemptId/policy/requestTarget`，并复用 live target 的空白与 UTF-8 上限；custom hook 只携带 `{ generator: "custom" }`；旧记录或严格 host namespace 无法验证（含 identity 超界）时省略该字段而不是令 snapshot 失败，客户端不得从当前配置回填。session-message 的固化 endpoint title 可以比浏览器显示边界更长，投影时必须按 24 个 Unicode 字符裁剪，wire 校验也使用相同字符语义而不是 UTF-16 code unit。assistant message 额外用有界 `parts` 保存 text/thinking span 与 toolCallId 的原始顺序；span 只引用已有聚合字符串，不能在线路上复制整段正文或思考。工具调用状态区分 `pending | running | done | error`：没有对应 tool result 的调用仍在执行中，不能投影成失败。浏览器 timeline 的单 assistant 工作过程只保留最近 16 个 timeline part/tool 条目，并在 UI 中按最新到最旧显示；超过上限时置 `contentTruncated`，不能让较早工作挤掉最新内容。tools 截断时必须同步裁剪 parts，保留的 toolCallId 仍要有对应工具详情；若 parts 顺序或引用无法证明，服务端拒绝该投影，而不是重建旧格式 fallback，避免浏览器在不可信顺序上继续运行。Agent `peek_session` 的 20 项上限属于另一观察边界，不能用来裁剪浏览器工具时间线。active snapshot 中属于当前 run 的 message 必须带真实 runId。`window` 必须显式携带 `omittedBefore / startsMidTurn / contentTruncated`；`startsMidTurn=true` 必然要求 `omittedBefore=true`。三者分别表示较早 item 被省略、窗口从一个语义 turn 内部开始、已选 item 的载荷被缩略，不能再压成一个含糊的 `truncated`。
- v57 要求每个 focused `conversation_snapshot` 显式携带非负 `projectionSeq` 与完整 `pendingPrompts` FIFO；两者由同一 actor snapshot 原子投影。`projectionSeq` 是 transcript checkpoint，不是完整 snapshot revision：admission FIFO 可以在相同 checkpoint 改变，所以无 gap 的同序 snapshot 仍可替换全部 snapshot-backed 状态；较低 checkpoint 不能回滚已观察 transcript。`session_event.projectionSeq` 保持可选及既有连续性语义。`conversation_item` 只带当前 transcript watermark 用于证明卡片更新没有跨过丢失的 run delta；它不得推进 watermark。浏览器只接受连续 run 增量；发现缺口时请求 `refresh_view` 并等待新的 snapshot，而不是猜测丢失的工作过程。
- live 卡片使用 `conversation_item`，同 cardId 幂等更新；它不能伪装成某个 run 的文本 delta。
- wire 上的 `session_message.peerPresence` 是当前投影的暂时知识，不是 peer 生命周期或侧栏成员关系：`present/absent` 仅来自完整、稳定的受控 JSONL first-line header census，census I/O、目录或 header-claim 不稳定时保持 `unknown`；它不依赖可能截断的 `project_snapshot`，也不写回 durable 卡片。只 `absent` 控制打开入口，`present/unknown` 都交给普通精确 open 重新验证完整 payload、identity、lease 与删除竞态。
- `project_snapshot` 等控制面快照的 `truncated` 与 conversation 的结构化 `window` 都只描述浏览器投影覆盖范围，不能解释成 durable 数据被删除。`project_snapshot.truncated` 只表示**成员集合**可能被裁剪（会话数/字节预算/整组移除）；字段值（preview/name/autoTitlePreview）的展示级裁剪不得置位，否则浏览器会把每个真实项目的缺席都当成不可信，永远无法撒回已删除会话。当前 conversation 没有公开分页 cursor；在 load-older 命令及 stale-cursor 语义落地前不能先暴露伪 cursor。
- sessionId、focusId 和 acknowledged commandId 在一个连接内不可复用，runId 在一个 session 内不可复用；它们是关联身份，不承诺任意网络命令的 exactly-once。
- `run_queued → run_started → run_finished(outcome)` 由工作台适配层合成，不把 SDK 的 agent lifecycle 当成线协议真相。
- `prompt_admitted` 是 busy prompt 的接收回执：服务端已校验身份并让它进入当前 run 的 SDK steering 队列。浏览器只有收到精确匹配 focus 三元身份 + promptId 的这一帧，才能清草稿并投影“等待中” user message；`prompt_delivered` 才把它标为已投递。
- runId 描述执行生命周期，不描述气泡生命周期。projector 为每条物理 assistant message 发送 `assistant_message_started`，steer 被 SDK 真正取用时另用 `user_message` 标出同一 run 内的新用户段；后续文本、思考、工具和 usage 仍归该 run，但 reducer 只写入最新 assistant 段。UI 可以合并没有 card/compaction/user 边界的同 run 相邻段，最终 focused snapshot 仍以 Pi durable entry 的 ordered parts 为准。
- `WebSocket.send()` 不是协议提交点。idle prompt 由匹配 focus + runId 的 `run_queued` 确认；busy prompt 由匹配 focus + promptId 的 `prompt_admitted` 确认。回执前断线是 unknown outcome，客户端必须保留草稿并在恢复后让用户核对，不能自动重试，也不能按正文去重。
- 错误包含 `scope`，命令错误可包含 `operation`；需要精确结算的设置错误还必须携带 sessionId + commandId。通用设置错误不能结束一次运行。`refresh_models` 的失败只进入设置回执，不得落为全局运行错误。
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
- 不要把完整 conversation list 放回 PublicState，也不要发送无总量上限的历史快照。conversation window 必须按最终 `JSON.stringify` UTF-8 bytes 计量；非空来源至少保留最新 item，不能因为最新 turn/item 单独超限而返回空快照。
- 浏览器唯一路径是带 promptId 的 `prompt`：服务端按忙闲分流（busy 进 SDK steering 队列，idle 起新 run），投递证明只能凭 exact promptId + runId 的 raw user 持久化 receipt，run settlement 本身不是交付证明。底层 raw steer 同时承载浏览器消息与 inbox/extension 消息（同一队列，按到达顺序注入）。
- 不要只按 conversationId 过滤 transcript。conversationId 会在 `A → B → A` 中重复，focusId 才能阻断 ABA。

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-custom-providers.md](kb-custom-providers.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
