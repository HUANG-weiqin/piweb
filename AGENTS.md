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
- `src/shared/protocol.ts` 是浏览器与服务端的唯一线协议；浏览器不得导入 Pi SDK 事件类型。
- initialize 前的只读目录浏览只属于 socket control；必须用一次性 commandId 关联有界列表。浏览 `path` 不是项目 cwd，不得创建项目状态或触发资源加载；用户确认后仍由 initialize 独立校验。
- `PiRuntime` 进程级共享 `CredentialStore` 与基线 `ModelRegistry`，每个 session 另有隔离的模型目录；所有认证/模型缓存修改必须从串行入口经过。
- 项目扩展可以注册工具、hooks 和静态 provider 配置；在引入 worker/进程隔离前，必须拒绝进程全局的 `streamSimple` 与 OAuth provider 注册。
- 项目资源必须在 trust resolution 后加载；默认 `SettingsManager` 不得以 `projectTrusted=true` 启动。
- 允许的 provider 配置必须先深快照再交给 SDK，不能保留扩展传入的可变对象引用。
- `ProjectStoreRegistry` 按 canonical cwd 在活动 handle 生命周期内复用项目 store，末次 release 后逐出；`.piweb/project.json` 是 durable manifest，`.piweb/sessions` 是受控 Pi sessionDir。
- `ConversationActor` 原子持有一个持久 conversation 的 project store、`SessionManager`、writer lease、角色/LoopList 快照、AgentSession runtime 和唯一 active run；`PiConnection` 只持有项目观察、当前 focus 与连接级临时交互。
- `projectId`、`conversationId`、`sessionId` 和 `runId` 属于不同生命周期，禁止合并或互相替代。
- 同一进程内一个 `canonical cwd + conversationId` 只能有一个 writer lease；租约必须在 Pi `open()` 前取得，并在所有失败/关闭路径释放。
- 已有对话重连可有界等待旧 lease；等待必须 FIFO、可取消，不能通过第二个 writer 解决。
- 删除只接受 conversationId：目标及其 metadata descendant set 中任一 busy/compacting conversation 都必须拒绝；删除前先冻结 cascade set，非当前目标必须 fail-fast 取得独占 writer lease，并在完整路径/identity 校验后逐个精确 unlink JSONL；删除与索引刷新共用串行边界。
- Pi `SessionManager.listAll()` 不是完整性证明：宿主必须验证受控目录内全部常规 JSONL 的尾换行、有限 JSON 数值、header、经迁移后的 entry payload/tree，并要求磁盘全集与 SDK 索引按规范路径和 conversationId 一一对应；任何遗漏、损坏、重复或扫描期变化都 fail closed。
- 工具权限属于用户级角色模板，并进入 conversation 当前角色快照；新角色和旧角色迁移默认 `read_only`，模板后续编辑不得自动改变已有会话。每个 Agent 可读取任意角色完整定义，并在用户明确要求后通过 `propose_role_revision` 提议完整替换 system prompt；只有 conversation-scoped editor 返回用户提交文本后才能按 expected revision + base prompt CAS 写入下一模板 revision，名称、简介、模型、思考强度与权限必须原样保留。用户仍只可在会话空闲时显式应用一个当前可用角色，宿主必须追加角色变更记录并用同一 SessionManager 重建运行时；失败要恢复上一角色或将 actor 置为 fatal。
- 浏览器不是 transcript owner；恢复必须从服务端 `conversation_snapshot` hydrate，localStorage 只保存最后工作目录与最近工作区目录列表（`piweb.lastCwd` / `piweb.workspaces`）。
- LoopList 是 conversation-scoped 的宿主权威复选列表，只允许 `todo_read/todo_write/todo_pause` 三个 SDK 工具整表读写或暂停；严格 custom entry 持久化状态。armed 且未完成时，actor 在同一 runId 内用隐藏 custom message 最多续跑 8 次，完成或空列表才自然结算，达到上限、异常和 abort 都暂停；重启不得自动开跑，后续普通用户 prompt 可重置 armed。完整列表只进入 focused snapshot 与三元 focus 身份关联的低频事件，不能进入 PublicState、project snapshot、localStorage 或 sidebar。
- 客户端收到匹配的 history snapshot 前不得发送 prompt；state 提交和历史恢复是两个观察边界。
- `WebSocket.send()` 不是 prompt 提交点。idle prompt 只有匹配 focus + runId 的 `run_queued` 才确认新 run 已接收；busy prompt 只有匹配 focus + promptId 的 `prompt_admitted` 才确认已进入 SDK steering 队列并投影“等待中”。`prompt_delivered`（raw user 持久化证明）再把 busy prompt 结算为已投递。确认前断线必须保留草稿；断线后从 `conversation_snapshot.pendingPrompts` 恢复等待中列表，禁止自动重发或按正文去重。
- 用户可随时尝试发送消息：busy 且 actor 为 `running | waiting`、SDK 已 streaming、没有 input extension handler 时，浏览器 prompt 才通过 `streamingBehavior:"steer"` 进入 SDK steering 队列；否则必须在触碰 `prompt()` 前 fail closed 并保留浏览器草稿，不能让 pre-stream prompt 启动无主 SDK run，也不能把 extension `handled` 当成入队。当前 assistant turn 的工具调用全部结束后、下一次模型调用前注入；steeringMode 固定 `all`，排队消息一次模型轮次全部注入。宿主零 pump/零重建/零持久队列。进程重启或 abort 时未投递消息丢失（UI 必须诚实显示"等待中"而非"已发送"）；abort 清空 steering/followUp 队列与 admissions 并通知 UI。
- 跨会话 inbox 仍是 durable 工作：idle 时 browser prompt 必须经过同一 project lifecycle 且不越过已有 inbox 工作；inbox envelope 准入容量必须为每条 immutable payload 预留最坏合法 JSON 状态大小，状态替换仍复核实际 next bytes；inbox 删除 tombstone 使用独立有界预算，不能因 envelope 满载而无法建立删除 fence。需要初始 processing claim 的 inbox envelope 必须首次原子创建成目标状态，不能先 commit queued 再改写。
- `wait_for_session` 的精确 `conversationId + runId` 只限定哪次 settlement 算成功；等待期间任何实际投递到当前 run 的新 peer/inbox 消息或被 SDK 接受的用户 guidance 都必须结束 wait。工具结果只返回消息来源 metadata 或 `{ outcome:"guidance" }`，正文仍只由 custom/raw user message 注入一次；message metadata 的 `fulfillsTemporaryReturn:true` 明确对应正文已满足 one-shot temporary 回传，不能只为稍后的 exact settlement 再 wait，普通 message 则仍只是 interruption；wait 注册前已 claim 且尚未观察的消息/guidance 也要补查。`waitedByRunId`、每条 guidance 的 claimed 标记及 host callback 成功认领共同防止重复唤醒；temporary receipt 仍只属于精确 temporary wait。符合大上下文与实际模型 cache-read 成本门槛的静默 wait 可在四分钟后返回 `{ outcome:"checkpoint" }`，它不是目标完成证明；每个来源 run 最多八次，下一 assistant usage 缺失、非法或 cache hit 低于 50% 时关闭剩余额度。timer 必须绑定 exact waiter、进入 project lifecycle 后复核 identity/ownership，并由统一 detach 覆盖 settlement/message/guidance/abort/fatal/close。
- 用户消息投递只能在 raw user `message_end` 后，从同一 SessionManager entries 找到 `entry.message === rawMessage` 的对象引用来证明。初始 raw user 无条件先归当前 run 的 initial prompt；后续 browser admission 与显式 steer 按 SDK 接受顺序共用 FIFO，并只由 FIFO 头的实际 queued text 匹配认领，禁止跨队列按正文搜索。run settlement 本身不是交付证明。admit 有界（单会话同时最多 64 条 pending）；存量 `.piweb/pending-prompts` 只做一次性迁移，迁移后目录必须删除，不允许重新创建队列状态。
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
- 工具策略必须位于项目扩展 `tool_call` hook 之后、真实 `tool.execute` 之前，并只按 run 启动时冻结的 conversation role 权限决策。
- 会话角色切换命令必须精确匹配 `sessionId + conversationId + focusId + commandId`；busy 会话拒绝，切换不能改变 conversationId、历史、lifecycle 或 createdBy。
- 工具 gate 启用时固定使用 sequential execution，避免 SDK parallel preflight 在 abort 或模式收紧后执行已积累的 thunk。
- `read_only` 的有效工具集只投影 `source=builtin` 的 Pi 原生 `read/grep/find/ls`，以及 `source=sdk` 的宿主 `git_status/git_diff`、conversation-scoped notebook/LoopList 工具、`request_context_compaction` 和 `list_roles/read_role/propose_role_revision`；压缩工具只预约当前完整 tool turn 后的安全 checkpoint，返回 accepted 不是成功证明，最后一个角色工具只能经用户 editor 提交后由宿主写角色 prompt。命令、项目写入、未知工具、会话编排 meta 及扩展同名工具仍由服务端 gate 硬拒绝。`full_access` 直接允许所有工具，不是角色目录或项目外路径的 OS sandbox。
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
- 保持改动小而可验证；不为尚未确认的功能预建抽象。
- 新增或重命名知识页时，同步 `.knowledge/INDEX.md`。

## 完成门槛

代码变更至少运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

涉及 WebSocket 的集成测试需要允许监听临时的 `127.0.0.1` 端口。涉及 UI 行为时，还应覆盖对应组件测试；涉及生产启动时，再验证 `/health` 和一次浏览器主流程。
