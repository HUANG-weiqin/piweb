# Pi Web Agent Guide

## 项目目标

Pi Web 是本机优先的极简 Agent 工作台。当前目标不是复制 Pi 或 OpenCode 的全部功能，而是保持一个可用、可测试、能逐步扩展的工作台基座。

- 复用 Pi SDK 的模型、认证、工具和 Agent 循环。
- 工作台拥有自己的稳定协议、会话生命周期和 UI 投影。
- 只实现必须由工作台拥有的状态与控制语义；能被成熟外部工具完整替代的能力不重复建设。
- 默认只监听 loopback；不要把当前安全模型扩展到远程访问。
- 项目身份、conversation 角色快照和 Pi JSONL 对话由项目内 `.piweb/` 持久化；OS 级隔离仍是后续能力。
- 项目信任决定必须来自用户级 Pi trust store 或当前交互；项目内文件不能让项目自证可信。

代码标识使用英文；面向用户和项目知识页优先使用中文。

## 必读顺序

1. 本文件。
2. [`.knowledge/INDEX.md`](.knowledge/INDEX.md)。
3. 与任务相关的 `kb-*.md`。
4. 修改行为前再读对应源码、测试和 `docs/plans/` 中的历史设计。

## 架构硬边界

- 新功能先判断它是否必须参与 Agent 生命周期、权限决策、持久会话或协议关联；如果不需要，并且外部工具可以完整替代，就不进入工作台核心。
- Git 负责 diff、历史、回滚和分支；编辑器负责文件浏览与人工编辑；终端负责通用交互式 shell。工作台最多提供浅层交接，不维护第二份真相。
- `src/shared/protocol.ts` 是浏览器与服务端的唯一线协议；`PROTOCOL_VERSION` 是当前版本的唯一来源，浏览器不得导入 Pi SDK 事件类型。角色模板、冻结角色快照、角色目录和 conversation snapshot 的角色 payload 都必须携带必填 nullable `compactionModel`，不新增命令。
- `src/mcp/` 是浏览器之外的第二个线协议客户端（Claude Code 等外部 Agent 经 MCP 以浏览器同等身份使用工作台），只导入 `src/shared/`，服务端不得反向依赖它，也不为它开准入或 focus 特例。修改 `protocol.ts` 中桥用到的命令、事件、回执语义或 `PROTOCOL_VERSION` 时，必须在同一改动中同步 `src/mcp/`、跑通 `npx vitest run src/mcp` 并更新 [`kb-mcp-bridge.md`](.knowledge/kb-mcp-bridge.md)。桥只连本机，initialize 声明 `extensionUi:"none"`：服务端不让该连接成为任何会话的扩展对话框 delegate、不更新最近会话或清 attention，它触发的模型目录/冷打开/新建/fork 若会引发项目信任询问就直接报错，从不替用户询问或写 trust store。桥从不回答扩展对话框（万一收到即断开并把内容交给用户），不提供删除会话或改角色/认证。`piweb_start` 只在用户同意后、仅从桥所在仓库以 `npm run start` 启动可见的独立服务进程，不得继承桥的 stdio，已运行时不重复启动、不替用户 reload。
- initialize 前的只读目录浏览只属于 socket control；必须用一次性 commandId 关联有界列表。浏览 `path` 不是项目 cwd，不得创建项目状态或触发资源加载；用户确认后仍由 initialize 独立校验。
- `PiRuntime` 进程级共享 `CredentialStore` 与基线 `ModelRegistry`，每个 session 另有隔离的模型目录；所有认证/模型缓存修改必须从串行入口经过。Pi 相关包精确锁定 `1.0.0`（`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 及 SDK 内部 `pi-agent-core`）。私有五参数 `_runDefaultCompaction(preparation, model, customInstructions, signal, reason)` 是唯一默认压缩适配点：custom `session_before_compact` 结果直接采用并绕过 resolver，否则 fresh-resolve 冻结的显式压缩模型并保留 Pi 原生准备、摘要、split-turn、文件、usage、abort、持久化和 continuation；Pi 先 await 摘要认证再捕获 stream，故 session-local `agent.streamFunction` override 必须保持到整个调用 await 结算，在 finally 中按 identity 恢复，不能同步调用后立即恢复。失败不回退、不追加 compaction/rebuild，接点前 Pi transient overflow recovery 变化不承诺回滚。
- 运行中压缩/reload checkpoint 只经 `agent-turn-boundary.ts` 包装 Agent 的 `finishTurn` 与 `hasQueuedMessages`：先保留上游 decision/error/abort，仅完整结束的 `toolUse` turn 可请求宿主暂停；暂停期间只遮蔽 queued-message 观察，不清实际队列，actor 取得控制权后释放并续跑同一 run。每个 session 的 cache warming 强制 `off`，只覆盖有效 `SettingsManager.getCacheWarmingMode()` 并在 teardown 恢复，不改用户偏好，不允许预热 provider 请求变成用户 run。
- 项目扩展可以注册工具、hooks 和静态 provider 配置；在引入 worker/进程隔离前，必须拒绝进程全局的 `streamSimple` 与 OAuth provider 注册。
- 项目资源必须在 trust resolution 后加载；默认 `SettingsManager` 不得以 `projectTrusted=true` 启动。
- 本机 stdio LSP 由 `ProjectContext` 惰性拥有；用户级配置中的已启用语言服务允许所有角色直接使用，不查询 project trust、不弹信任询问，也不写入信任决定；项目 SDK 资源的信任检查保持独立。三个只读 SDK 工具固定为 `lsp_symbols/lsp_definition/lsp_references`，路径必须在当前工作区内，位置为 1-based UTF-16。连接按 canonical root + 完整冻结配置指纹共享；只串行磁盘复核/同步/派发，响应等待在门外，caller 取消不能杀其它 actor 使用的进程。已知变化无有效同步覆盖则停止复用；不修改 Pi 内核、浏览器协议，不建立第二套索引或虚拟源码读取。语言差异只属于 `src/server/lsp/servers/` 声明或局部适配，用户配置仅从 `<Pi agent dir>/piweb/lsp.json` 读取。
- `computer` 的成功截图必须作为标准 image content 持久进入对应 tool result，使 provider history 对后续 turn 保持 append-only；每次 capture 只保存一张 current/after 图，不建立 provider-only injector、before/after 图片滑动窗口或 controller 图片缓存。原始 desktop PNG 不得超过共享 16 MiB 输入/读取上限；宿主在 tool 返回前按 Pi provider 边界归一化到最大 2000×2000、base64 严格小于 4.5 MiB，结果可为 PNG 或 JPEG，持久化与重放的是这份归一化后的精确 block。普通 wire/history 只投影 image marker 与精确持久引用，base64 由既有 `open_image` 按需读取。坐标授权仍是独立的 run-scoped 瞬态 Frame：模型坐标尺寸使用归一化后图像、物理映射仍使用 capture bounds；只授权下一 assistant decision 的 exact computer call IDs，首个真实 primitive/capture 消费，失败、abort、compaction、reload 和 terminal 都清除，持久旧图永不授权坐标。项目 `tool_result` hook 或最终 provider conversion 若改变/丢失已捕获的标准 details/label/image 必须 fail closed 并清除或拒绝 frame，不能授权与模型所见不一致的像素。非 vision model 或 `images.blockImages=true` 必须在 desktop adapter 创建前拒绝。
- 允许的 provider 配置必须先深快照再交给 SDK，不能保留扩展传入的可变对象引用。
- `ProjectStoreRegistry` 按 canonical cwd 在活动 handle 生命周期内复用项目 store，末次 release 后逐出；`.piweb/project.json` 是 durable manifest，`.piweb/sessions` 是受控 Pi sessionDir。角色快照中的 compaction identity 随 conversation 持久化并由 coordinator 在 reopen/rollback 及 peer 路径中保持，不由当前目录刷新改写。
- `ConversationActor` 原子持有一个持久 conversation 的 project store、`SessionManager`、writer lease、角色/LoopList 快照、AgentSession runtime 和唯一 active run；`PiConnection` 只持有项目观察、当前 focus 与连接级临时交互。
- provider 上下文的规范视图是 `SessionManager.buildSessionProjection().messages`，物理 JSONL 仍是完整 audit/tree/账本权威，二者不能混用。严格 v3 审计同时接受先前 Pi 0.85 v3 与 Pi 1 合法形状（`usage`、`context_edit`、system message delta/compaction snapshot、`pending/deferred` stop reasons）；fork 复制规范投影，只保留最新 compaction、有效 system state 与 context edits 的结果，保留 retain-none self-boundary，不复活物理旧摘要或已覆盖正文。
- `projectId`、`conversationId`、`sessionId` 和 `runId` 属于不同生命周期，禁止合并或互相替代。
- 同一进程内一个 `canonical cwd + conversationId` 只能有一个 writer lease；租约必须在 Pi `open()` 前取得，并在所有失败/关闭路径释放。
- 已有对话重连可有界等待旧 lease；等待必须 FIFO、可取消，不能通过第二个 writer 解决。
- 删除只接受 conversationId：目标及其 metadata descendant set 中任一 busy/compacting conversation 都必须拒绝；先从安全目录的唯一 header 全集及 fresh base metadata 的 `createdBy/orchestration` 冻结 cascade set，不使用展示 catalog 或 profile 缓存授权。删除只完整验证冻结目标的 payload/tree；无关正文损坏或正常追加不阻断删除，路径、header、谱系不确定或重复身份仍 fail closed。非当前目标必须 fail-fast 取得独占 writer lease，提交前复核冻结谱系与文件身份，经 quarantine 后逐个精确 unlink JSONL，最后用 fresh namespace 证明目标 absent；该结果不声称全项目正文有效。删除与索引刷新共用串行边界。
- Pi `SessionManager.listAll()` 不是完整性证明：Agent 完整列表与显式 audit 必须验证受控目录内全部常规 JSONL 的尾换行、有限 JSON 数值、header、经迁移后的 entry payload/tree，并要求磁盘全集与 SDK 索引按规范路径和 conversationId 一一对应；任何遗漏、损坏、重复或扫描期变化都 fail closed。精确 cold open/preview 则先做有界 header census，只要求目标 ID 恰有一个合法 claim，再验证目标完整 payload/tree；无关 body 损坏或 append 不能扩大为 target 不可用，但另一合法 header 对同一 ID 的 collision 必须拒绝。完整证明的字节级复用只能来自**进程内**同 fingerprint 校验回执：只有规范路径 + dev/ino + size + mtimeNs + ctimeNs 逐字段相同的文件才可复用上次成功完整证明得到的 conversationId，指纹变化、路径缺失或路径安全失败的文件必须完整重读重证；每轮仍须重新证明当前安全文件全集、重复 ID、SDK 索引一一对应、全部 summary 与 before/after 集合相等。该证明回执随 `ProjectStore` 生命周期消失，不落盘、不跨进程。启动与浏览器列表另用 catalog v3 的**发现观察**：每次重证安全目录与唯一合法 header 全集，仅完整 fingerprint 相等时跨进程复用展示摘要和单一恢复候选标记；变化、缺失或无法确认的观察不能产生“无工作”结论。候选执行仍 fresh exact inspect，不能用发现缓存授权 open/delete/lease 或填充完整证明缓存；完整发现只证明 `project_snapshot.coverage=complete` 的成员集合。跨进程负向发现以宿主产生且未被另行篡改的 catalog 为前提；格式合法的假阴性 cache 篡改与 same-fingerprint ABA（同用户伪造 mtime/ctime 隐藏变化）不在保证内，不接受该假设时只能完整重读。
- 工具权限属于用户级角色模板，并进入 conversation 当前角色快照；RoleStore v7 的模板、draft 和 frozen snapshot 都必须有 nullable `compactionModel`：`null` 跟随冻结 primary model，显式模型只用于默认压缩；旧 v1–v6 角色文档及旧 conversation/card/role-change 快照缺失该字段时归 `null`，不增加语义 revision。显式压缩模型在 create/update/switch 时必须可用且 finite positive `contextWindow >= primary`，目录漂移不阻止已有会话打开，但每次默认压缩 fresh-resolve/revalidate，失败不 fallback。模板后续编辑不得自动改变已有会话。每个 Agent 可读取任意角色完整定义，并在用户明确要求后通过 `propose_role_revision` 提议完整替换 system prompt；只有 conversation-scoped editor 返回用户提交文本后才能按 expected revision + base prompt CAS 写入下一模板 revision，名称、简介、模型、思考强度、压缩模型与权限必须原样保留。用户仍只可在会话空闲时显式应用一个当前可用角色，coordinator 将完整冻结 identity 传给每个 runtime create/reopen/switch/rollback/peer 路径，宿主必须追加角色变更记录并用同一 SessionManager 重建运行时；失败要恢复上一角色或将 actor 置为 fatal。
- 浏览器不是 transcript owner；恢复必须从服务端 `conversation_snapshot` hydrate，localStorage 只保存最后工作目录与最近工作区目录列表（`piweb.lastCwd` / `piweb.workspaces`）。
- LoopList 是 conversation-scoped 的宿主权威三态任务列表，每项只能是 `pending | active | completed`，允许多个 active 且顺序只用于展示；active 是持久关注状态，不能替代 `armed` 或 `activeRun`。只允许 `todo_read/todo_write/todo_pause` 三个 SDK 工具整表读写或暂停；新状态和 continuation 用严格 v2 custom entry 持久化，读取 v1 时只把 checked 映射为 pending/completed，绝不推导 active。full-access Agent 的同一逻辑 run 第一次最终来源为 builtin 的 `edit/write` 前，权威 LoopList 必须至少有一个 active；通过时宿主先写入非上下文 `piweb.edit_gate.v1` 标记，随后该 run 的 builtin `edit/write` 永不再检查 todo，即使列表暂停或完成；recovered run 由该标记恢复，旧 `piweb.edit_budget.v1` 的有效 charge 也只作为既已通过的兼容证据，不能授予新权限。armed 且存在非 completed 项时，actor 在同一 runId 内用隐藏 custom message 最多续跑 8 次，完成或空列表才自然结算，达到上限、异常和 abort 都暂停；重启不得自动开跑，后续普通用户 prompt 可重置 armed。actor 从 active branch 的既有全量快照和 `updatedAt` 重放派生两个 wall-clock 计时锚点，不新增持久字段：无序稳定 item ID 集合变化表示整份计划变化并重置两者，无序 active ID 集合变化只重置 active 锚点；整表锚点从当前 plan snapshot 建立时开始，active 锚点只在存在 active 时保留。仅当存在 active 项时，宿主才在模型调用前把最多 4096 UTF-8 bytes 的规范 `piweb_work` 摘要（含自解释、向下取整且负值钳零的 `activeElapsedMinutes/loopListElapsedMinutes`）与 `<piweb_ctx>` 合并成一条隐藏的 `piweb.context_hint.v1` custom message，且同一会话距上次注入不足一分钟时不重复注入；该提示会持久化进会话历史，使 provider 前缀保持 append-only、不破坏提示缓存，因此不得再以“仅在本次请求追加、下轮消失”的瞬时尾部改写最后一条 provider message；无 active 项时不注入；独立的 compaction/branch-summary summarizer 不消费执行任务提醒，下一 Agent turn 会重新读取权威列表。完整列表只进入 focused snapshot 与三元 focus 身份关联的低频事件，不能进入 PublicState、project snapshot、localStorage 或 sidebar。
- 客户端收到匹配的 history snapshot 前不得发送 prompt；state 提交和历史恢复是两个观察边界。
- `WebSocket.send()` 不是 prompt 提交点。浏览器输入先以唯一 `promptId` 将原文/图片写入 conversation JSONL，成功后才允许 idle 的 `run_queued` 或 busy/暂缓的 `prompt_admitted` 确认接收；后者携带接受时的实际 runId，暂缓输入不伪称已经进入 SDK 队列。`prompt_delivered` 只在精确 raw user 持久化后结算投递。确认前断线保留原草稿和 `promptId`；匹配 `conversation_snapshot` 恢复后，同 ID、同内容、全新 runId 自动重发并由服务端幂等对账，不能按正文去重。快照 `pendingPrompts` 投影持久未投递输入。
- 用户可随时尝试发送消息：浏览器初始输入在注册了 input extension handler 时必须于持久准入前拒绝，避免 SDK `handled` 而没有 raw user 投递。只有 busy actor 为 `running | waiting`、`AgentSession.isStreaming` 与 `session.agent.state.isStreaming` 都为 true 且没有 input extension handler 时，持久接收后的浏览器输入才以 `streamingBehavior:"steer"` 进入 SDK 队列；其它 busy 阶段不调用无主 `prompt()`，持久输入留待现有 project lifecycle 自动续投。Pi 私有 steering 文本 mirror 可能先于真实入队更新；stale capture 只阻止 core enqueue，不按文本/长度回滚或清并发队列。SDK steeringMode 固定 `all`，已入队消息仍在当前 assistant turn 工具完成后、下一模型调用前注入。Stop 只停止当前生成并清 SDK 易失队列，不撤销已接收、未投递的持久浏览器输入；run terminal 不伪造逐条取消凭据，后续 run 或进程重启在 durable inbox 之后按原准入顺序自动续投。单条手动撤回需精确移除 SDK 队列对象，或对尚未入队且不正驱动当前 run 的持久输入以撤回标记结算；已 drain 或正驱动当前 run 的初始输入不能谎称撤回。浏览器不保留另一份输入恢复列表、容量预算或手动恢复面板；普通草稿和未确认结果仍易失且按 focus 隔离。
- 跨会话 inbox 仍是 durable 工作：idle 时 browser prompt 必须经过同一 project lifecycle；已有 inbox/receipt 工作先启动，浏览器输入仍先持久准入并暂缓 SDK 投递，不越过它们；inbox envelope 准入容量必须为每条 immutable payload 预留最坏合法 JSON 状态大小，状态替换仍复核实际 next bytes；inbox 删除 tombstone 使用独立有界预算，不能因 envelope 满载而无法建立删除 fence。需要初始 processing claim 的 inbox envelope 必须首次原子创建成目标状态，不能先 commit queued 再改写。
- `wait_for_session` 只接受 1–32 个冻结的 `targets`，等待任一 listed durable settlement 并在结果中标明 `conversationId`；等待期间任何实际投递到当前 run 的新 peer/inbox 消息或被 SDK 接受的用户 guidance 都必须结束 wait。工具结果只返回消息来源 metadata 或 `{ outcome:"guidance" }`，正文仍只由 custom/raw user message 注入一次；普通 message 仍只是 interruption；wait 注册前已 SDK 接受但尚未观察的消息/guidance 也要补查。`waitedByRunId`、每条 guidance 的 claimed 标记及 actor terminal CAS 共同防止重复唤醒。source actor 对每个 run 只持有一个冻结目标集的 local attempt，没有 target-keyed waiter 或 cycle graph；没有 active target ticket、inbox processing/receipt-only/reload 等权威来源的 target 返回 `target_unreachable`，`idle` 本身不是反证。open attempt 四分钟后返回 `{ outcome:"checkpoint" }`；Agent 若仍需结果可再次等待，次数不设额度。timer 进入 project lifecycle 后复核 ownership/attempt，任一 terminal CAS 统一清理。
- Pi 1 prompt disposition 必须精确匹配：initial 只接受 `started`，真正尝试 SDK steering 的 busy browser prompt 和显式 steer 只接受 `queued`，`handled` 不算入队。异步 input handler 下的身份捕获仍由 invocation-scoped `AsyncLocalStorage` 包住 native `agent.steer`，真实 enqueue 前同步复核 exact active ticket；不能按文本或队列长度认领。首个 raw user 无条件归 initial，后续 browser/explicit guidance 按 SDK 接受顺序共用 FIFO，只在队头 captured object 与 raw object 同一引用时认领。浏览器投递由同步包裹同一 SessionManager 的 `appendMessage()` 写入 `piweb.browser_prompt_delivery.v1` 标记，再以紧邻且直接以该标记为父的 raw user entry 证明；孤立标记不是投递证明，run settlement 也不是。每个会话同时最多 64 条、64 MiB 未投递浏览器输入；活动分支决定续投，文件检查验证全部物理记录；不重建 `.piweb/pending-prompts` sidecar。
- 普通会话操作串行执行；`abort`、认证响应、认证取消和生命周期失效走控制通道，session dispose 排回 actor 队列。
- 所有 session command/state/event 都带 `sessionId`；run command/event 还带 `runId`。客户端必须丢弃不匹配的身份。
- 会让界面等待配置结果的命令必须有精确关联身份；当前 API Key、模型选择与远程供应商模型刷新使用 sessionId + 连接内一次性 commandId，不能把任意 PublicState 刷新当作成功回执；服务启动后后台模型目录只做一次非阻塞 force:true 刷新，15 秒可取消且离线跳过，运行中仅手动强刷。
- Pi 的模型切换不是持久化事务：command success 以目标 model 已进入当前 AgentSession 为准，后续 session/settings 写入失败要单独报告，不能谎称运行态未切换。
- Pi 的 thinking/name setter 也有相同的“内存先变更”顺序；新增 SDK 状态 setter 接入前必须核对源码顺序并用后置条件测试覆盖部分提交。
- OAuth 命令与事件都带 `authFlowId`；取消必须覆盖 active 和尚在 actor 队列中的 flow。
- SDK 事件只能在服务端 `SessionEventProjector` 内转换成工作台事件。
- 不要直接开放 `AgentSession.reload()`；扩展 hook 当前与服务进程同生死，真正的超时/崩溃隔离属于 worker runtime。
- 扩展 UI 只桥接 `select/confirm/input/editor/notify`；响应是控制命令，必须按 sessionId/requestId 精确匹配并在 timeout、abort、reinitialize、disconnect 时结算。
- 扩展 command 的 session replacement 操作必须 fail closed。当前 slash command 也必须拒绝，直到 detached Agent turn 有明确的 host run ownership。
- `ConversationActor.activeRun` 是 queued/running/waiting/cancelling 的唯一服务端真相；`PublicState.busy` 只能由当前 focused actor 派生，聊天 reducer 不维护第二份 busy。
- AgentSession 创建后的 owner bind、host gate、startup 校验和 extension error 投影必须处于统一清理边界；成功创建后任一步失败都要 teardown session 并逐出 registry owner。
- 同步 emitter 驱动的 OAuth/extension UI rendezvous 必须先登记 pending 再 emit；emit 或监听注册失败也不能留下 waiter、registry owner 或阻断其余 session teardown。
- 工具策略必须位于项目扩展 `tool_call` hook 之后、真实 `tool.execute` 之前，并覆盖模型直接调用与 `ctx.executeTool` 嵌套调用；只按 run 启动时冻结的 conversation role 权限决策，嵌套 builtin `edit/write` 仍经首次写入 LoopList 门。工具 availability 不是 authorization。`full_access` 才加载 Pi 原生 codemode、tool_search 与 MCP；`read_only` 不得启动 MCP 连接。extension startup 后冻结完整 normalized prompt/tool topology；仅宿主注入的 Pi 原生 MCP/tool_search 可在同步 scoped capability 内动态更新工具菜单，原生 MCP 可修改自己捕获的 `mcp_servers` 提示词区段。其它 `before_agent_start` 的 `systemPromptOptions` 变化（含原地修改）和运行期 active tools/registry 变化都必须在影响 provider prefix 前拒绝，不能只比 rendered prompt 字符串。
- 会话角色切换命令必须精确匹配 `sessionId + conversationId + focusId + commandId`；busy 会话拒绝，切换不能改变 conversationId、历史、lifecycle 或 createdBy。
- 工具 gate 启用时固定使用 sequential execution，避免 SDK parallel preflight 在 abort 或模式收紧后执行已积累的 thunk。
- Actor-owned `bash/bash_output/bash_stop` 复用公开 Pi operations/factory/输出；`bash.timeout` 为整数毫秒，上限 600000；前台默认 120000，后台未显式给出时不设期限，前台阻塞并保持 exact run ownership，显式 `run_in_background` 立即返回独立 UUID `task_id`。后台 registry 属于 conversation Actor，普通 run_end/abort/runtime 重建不停止后台任务，启动时冻结 shell/prefix/read-only/operations；每 run 最多 4 个前台、每 conversation 最多 4 个后台未终结及 64 个任务记录、每 runtime 最多 32 个真正未终结。只有已观测或已通知的终结记录可 FIFO 回收。`bash_output` 默认阻塞 30000ms（上限 600000），无 id 立即列表；`bash_stop` 幂等短等。SDK signal 只取消等待、预先 aborted 启动拒绝；16 MiB 原始输出 cap 后标 partial 并停止。finished 不等于成功，必须正常原生结果、已知 exitCode 0 且无 error/partial/stopReason。前台等待期间只有真实 SDK 已接受的新投递经同一 `onRunInputAccepted` 接点触发迁入后台，立即返回 task_id；沿用原进程/权限/timeout/预算，额度不足则仍前台等待、保留已接受插话，拒绝/extension handled/过时 input 不迁移。
- 后台完成由 Actor 推送 `piweb.bash_task_notification.v1` 标准 custom message：每批最多 4 项，command 256 UTF-8 bytes、真实原始输出尾每项 1 KiB、正文 8 KiB；输出是数据而非新指令或授权，tail 不进入结构化 details。复用 streaming custom-steer FIFO、同 run 回合尾续跑、idle inbox-first 唤醒、browser/inbox 抢先时 triggerTurn:false（含 receipt-only recovery）；idle 唤醒只经既有 coalesced pump，不能在 lifecycle/operations 内等完整 Agent turn。`bash_output(task_id)` 或 `bash_stop(task_id)` 实际返回最终结果或错误才算已观测，未交 SDK 的通知可撤；任务终结时若仍有这类等待中的调用，registry 暂扣完成回调，调用返回最终结果即不再通知，只有全部等待都未观测才补发；已接受后不撤回、不重排，同任务只入队一次，abort 可能丢失 SDK 已接受但未观察正文。`wait_for_session` 的 bash_task outcome 只返回 taskIds，正文由原 custom message 注入；只有成功 terminal CAS 消费 wait 标记。history 刷新必须先证明精确持久 entry。
- run terminal/abort 先 bounded close 前台再结算；Actor reload/dispose 才停止后台并 best-effort 追加不触发 run 的 killed 通知。未知清理持续占预算、阻止自动 inbox/fresh-actor 绕过及默认 reload，只有明确 force 可越过。实时 UI 只投影 exact-focus 的会话级 `bash_activity` 聚合（最多 8、允许 idle 非空），不建任务表/每任务事件、持久执行 registry、PTY/stdin 或跨重启恢复；旧 task_id 重启后失效。不再写持久收尾摘要，旧 `piweb.bash_execution_notice.v1` 仅严格读取兼容，不投影。
- `read_only` 的有效工具集只投影 `source=builtin` 的 Pi 原生 `read/grep/find/ls`，以及 `source=sdk` 的宿主受审查 `bash` 及本会话后台任务的 `bash_output/bash_stop`、conversation-scoped notebook/LoopList 工具、本机时间 `current_time`、只读 `lsp_symbols/lsp_definition/lsp_references`、`request_context_compaction` 和 `list_roles/read_role/propose_role_revision`；`PiRuntime` 必须用当前 session 的有效 `SettingsManager.shellPath` 创建宿主 `bash`；该工具先用有界词法与命令级规则审查 Git、rg 和常用文件查询，可组合受审查管道/`&&`，`cd` 只改变同一次调用的目录，然后才委托 Pi 的真实 Bash；builtin/project/extension 同名工具仍拒绝。该规则只是防误操作的文本 guardrail，不保证 PATH、Git 配置或 helper 没有副作用；压缩工具只预约当前完整 tool turn 后的安全 checkpoint，返回 accepted 不是成功证明，最后一个角色工具只能经用户 editor 提交后由宿主写角色 prompt。其它命令、项目写入、未知工具和会话编排 meta 仍由服务端 gate 硬拒绝。`full_access` 直接允许所有工具，不是角色目录或项目外路径的 OS sandbox。
- `.piweb` 是宿主持久状态；只读模式不阻止宿主保存，但 `full_access` 也不会替 Agent 额外保护该目录。
- 项目列表和历史是低频、有界协议快照，不能重新塞回每个高频 `PublicState` 更新。

## Agent 分工

主 Agent：

- 先还原运行循环、状态所有权和跨模块影响，再修改代码。
- 保留用户已有未提交改动；不要顺手整理无关文件。
- 对竞态、生命周期和协议变更先写最小反例测试。
- 完成后同步相关知识页，但不要写入短期任务进度。

子 Agent：

- 默认只读分析，除非任务明确授权编辑。
- 返回具体文件、行号、反例和验证证据。
- 不重复主 Agent 已分配给其他人的范围。

## 工具与修改习惯

- 搜索优先使用 `rg` / `rg --files`。
- 文件修改使用 `apply_patch`。
- Windows 上删除 worktree 前必须检查其中的 reparse point。若 `node_modules` 是指向另一 worktree 的 Junction，先用不会遍历目标的 `cmd /d /c rmdir "<worktree>\node_modules"` 单独解除链接，再执行 `git worktree remove`；禁止让 Git、`Remove-Item -Recurse` 或其它递归删除直接处理共享 Junction。清理后不能只检查包清单，至少对共享根执行 `npm ls`、关键包动态 import 和 typecheck/build。
- 保持改动小而可验证；不为尚未确认的功能预建抽象。
- 新增或重命名知识页时，同步 `.knowledge/INDEX.md`。

## 开发期热重载

- `npm run dev` 和 `npm start` 由外部 supervisor 托管；当前实例需要加载已验证的代码改动时，Agent 可执行 `npm run reload`。
- reload 先运行完整 `npm run build`。只有旧 server 已冻结 admission，并为已有 active run 安装 reload latch 后，命令才返回 `accepted`；该回执不等待最终 drain 或新进程 ready。
- 默认 reload 等待完整 assistant turn（包括顺序工具调用及结果）到达安全边界。旧进程完全退出后才启动新进程；原 browser work 以隐藏的新 run 自动续做，durable inbox work 使用既有精确恢复路径。
- `npm run reload -- --force` 会跳过安全等待并立即 best-effort 替换进程，不提供副作用 exactly-once 保证；续跑前必须核对工作区及外部副作用。
- 仅在确实需要当前实例加载改动时调用 reload，不要在每次测试后自动重启。该能力不暴露为 Pi tool、公共 WebSocket 命令或 UI 操作。

## 完成门槛

代码变更至少运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

日常 `npm test` 默认排除 `**/*.slow.test.ts`：这些是真实落盘、整体跑起来很慢的协调器测试（`project-session-coordinator.slow.test.ts` 覆盖会话生命周期、inbox、steering/wait，`project-session-budget*.slow.test.ts` 覆盖 inbox 容量耗尽/释放与 `MAX_PEER_SESSIONS_PER_RUN`、`MAX_LIVE_DELEGATION_DESCENDANTS` 等硬边界）。只有改动触及 `project-session-coordinator` 相关逻辑（会话生命周期、inbox、steering/wait、容量/预算边界）或直接影响其持久化协作模块（conversation-actor、project-store、conversation-meta 的会话/目录路径）时，才需要补跑 `npm run test:slow`；改动其它模块不需要。

涉及 WebSocket 的集成测试需要允许监听临时的 `127.0.0.1` 端口。涉及 UI 行为时，还应覆盖对应组件测试；涉及生产启动时，再验证 `/health` 和一次浏览器主流程。
