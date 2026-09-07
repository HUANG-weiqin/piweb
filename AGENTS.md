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
- `src/shared/protocol.ts` 是浏览器与服务端的唯一线协议，当前为 v43；浏览器不得导入 Pi SDK 事件类型。角色模板、冻结角色快照、角色目录和 conversation snapshot 的角色 payload 都必须携带必填 nullable `compactionModel`，不新增命令。
- initialize 前的只读目录浏览只属于 socket control；必须用一次性 commandId 关联有界列表。浏览 `path` 不是项目 cwd，不得创建项目状态或触发资源加载；用户确认后仍由 initialize 独立校验。
- `PiRuntime` 进程级共享 `CredentialStore` 与基线 `ModelRegistry`，每个 session 另有隔离的模型目录；所有认证/模型缓存修改必须从串行入口经过。Pi 0.85.1 的私有 `_runDefaultCompaction` 是唯一默认压缩适配点：custom `session_before_compact` 结果直接采用，否则 fresh-resolve 冻结的显式压缩模型并保留 Pi 原生准备、摘要、split-turn、文件、usage、abort、持久化和 continuation；失败不回退、不追加 compaction/rebuild，接点前 Pi transient overflow recovery 变化不承诺回滚。
- 项目扩展可以注册工具、hooks 和静态 provider 配置；在引入 worker/进程隔离前，必须拒绝进程全局的 `streamSimple` 与 OAuth provider 注册。
- 项目资源必须在 trust resolution 后加载；默认 `SettingsManager` 不得以 `projectTrusted=true` 启动。
- 允许的 provider 配置必须先深快照再交给 SDK，不能保留扩展传入的可变对象引用。
- `ProjectStoreRegistry` 按 canonical cwd 在活动 handle 生命周期内复用项目 store，末次 release 后逐出；`.piweb/project.json` 是 durable manifest，`.piweb/sessions` 是受控 Pi sessionDir。角色快照中的 compaction identity 随 conversation 持久化并由 coordinator 在 reopen/rollback 及 peer 路径中保持，不由当前目录刷新改写。
- `ConversationActor` 原子持有一个持久 conversation 的 project store、`SessionManager`、writer lease、角色/LoopList 快照、AgentSession runtime 和唯一 active run；`PiConnection` 只持有项目观察、当前 focus 与连接级临时交互。
- `projectId`、`conversationId`、`sessionId` 和 `runId` 属于不同生命周期，禁止合并或互相替代。
- 同一进程内一个 `canonical cwd + conversationId` 只能有一个 writer lease；租约必须在 Pi `open()` 前取得，并在所有失败/关闭路径释放。
- 已有对话重连可有界等待旧 lease；等待必须 FIFO、可取消，不能通过第二个 writer 解决。
- 删除只接受 conversationId：目标及其 metadata descendant set 中任一 busy/compacting conversation 都必须拒绝；删除前先冻结 cascade set，非当前目标必须 fail-fast 取得独占 writer lease，并在完整路径/identity 校验后逐个精确 unlink JSONL；删除与索引刷新共用串行边界。
- Pi `SessionManager.listAll()` 不是完整性证明：完整列表、显式 audit 与 cascade delete 必须验证受控目录内全部常规 JSONL 的尾换行、有限 JSON 数值、header、经迁移后的 entry payload/tree，并要求磁盘全集与 SDK 索引按规范路径和 conversationId 一一对应；任何遗漏、损坏、重复或扫描期变化都 fail closed。精确 cold open/preview 则先做有界 header census，只要求目标 ID 恰有一个合法 claim，再验证目标完整 payload/tree；无关 body 损坏或 append 不能扩大为 target 不可用，但另一合法 header 对同一 ID 的 collision 必须拒绝。
- 工具权限属于用户级角色模板，并进入 conversation 当前角色快照；RoleStore v7 的模板、draft 和 frozen snapshot 都必须有 nullable `compactionModel`：`null` 跟随冻结 primary model，显式模型只用于默认压缩；旧 v1–v6 角色文档及旧 conversation/card/role-change 快照缺失该字段时归 `null`，不增加语义 revision。显式压缩模型在 create/update/switch 时必须可用且 finite positive `contextWindow >= primary`，目录漂移不阻止已有会话打开，但每次默认压缩 fresh-resolve/revalidate，失败不 fallback。模板后续编辑不得自动改变已有会话。每个 Agent 可读取任意角色完整定义，并在用户明确要求后通过 `propose_role_revision` 提议完整替换 system prompt；只有 conversation-scoped editor 返回用户提交文本后才能按 expected revision + base prompt CAS 写入下一模板 revision，名称、简介、模型、思考强度、压缩模型与权限必须原样保留。用户仍只可在会话空闲时显式应用一个当前可用角色，coordinator 将完整冻结 identity 传给每个 runtime create/reopen/switch/rollback/peer 路径，宿主必须追加角色变更记录并用同一 SessionManager 重建运行时；失败要恢复上一角色或将 actor 置为 fatal。
- 浏览器不是 transcript owner；恢复必须从服务端 `conversation_snapshot` hydrate，localStorage 只保存最后工作目录与最近工作区目录列表（`piweb.lastCwd` / `piweb.workspaces`）。
- LoopList 是 conversation-scoped 的宿主权威三态任务列表，每项只能是 `pending | active | completed`，允许多个 active 且顺序只用于展示；active 是持久关注状态，不能替代 `armed` 或 `activeRun`。只允许 `todo_read/todo_write/todo_pause` 三个 SDK 工具整表读写或暂停；新状态和 continuation 用严格 v2 custom entry 持久化，读取 v1 时只把 checked 映射为 pending/completed，绝不推导 active。full-access Agent 的 `request_edit_budget` 在授予额度时必须看到至少一个 active；成功申请把 `fileCount` 覆盖为本 run 的总 distinct-file 上限（包含已修改文件），拒绝不能改变额度。armed 且存在非 completed 项时，actor 在同一 runId 内用隐藏 custom message 最多续跑 8 次，完成或空列表才自然结算，达到上限、异常和 abort 都暂停；重启不得自动开跑，后续普通用户 prompt 可重置 armed。actor 从 active branch 的既有全量快照和 `updatedAt` 重放派生两个 wall-clock 计时锚点，不新增持久字段：无序稳定 item ID 集合变化表示整份计划变化并重置两者，无序 active ID 集合变化只重置 active 锚点；整表锚点从当前 plan snapshot 建立时开始，active 锚点只在存在 active 时保留。仅当存在 active 项时，每次普通 Agent turn 的 provider 请求才把最多 4096 UTF-8 bytes 的规范 `piweb_work` 摘要（含自解释、向下取整且负值钳零的 `activeElapsedMinutes/loopListElapsedMinutes`，full-access run 还带极简 `editLeft` 剩余数）与 `<piweb_ctx>` 合并进同一个瞬时尾部 text part；无 active 时完全不注入该尾部，且任何提示都不写入会话历史；独立的 compaction/branch-summary summarizer 不消费执行任务提醒，下一 Agent turn 会重新读取权威列表。完整列表只进入 focused snapshot 与三元 focus 身份关联的低频事件，不能进入 PublicState、project snapshot、localStorage 或 sidebar。
- 客户端收到匹配的 history snapshot 前不得发送 prompt；state 提交和历史恢复是两个观察边界。
- `WebSocket.send()` 不是 prompt 提交点。idle prompt 只有匹配 focus + runId 的 `run_queued` 才确认新 run 已接收；busy prompt 只有匹配 focus + promptId 的 `prompt_admitted` 才确认已进入 SDK steering 队列并投影“等待中”。`prompt_delivered`（raw user 持久化证明）再把 busy prompt 结算为已投递。确认前断线必须保留草稿；断线后从 `conversation_snapshot.pendingPrompts` 恢复等待中列表，禁止自动重发或按正文去重。
- 用户可随时尝试发送消息：busy 且 actor 为 `running | waiting`、SDK 已 streaming、没有 input extension handler 时，浏览器 prompt 才通过 `streamingBehavior:"steer"` 进入 SDK steering 队列；否则必须在触碰 `prompt()` 前 fail closed 并保留浏览器草稿，不能让 pre-stream prompt 启动无主 SDK run，也不能把 extension `handled` 当成入队。当前 assistant turn 的工具调用全部结束后、下一次模型调用前注入；steeringMode 固定 `all`，排队消息一次模型轮次全部注入。宿主零 pump/零重建/零持久队列。进程重启或 abort 时未投递消息丢失（UI 必须诚实显示"等待中"而非"已发送"）；abort 清空 steering/followUp 队列与 admissions 并通知 UI。
- 跨会话 inbox 仍是 durable 工作：idle 时 browser prompt 必须经过同一 project lifecycle 且不越过已有 inbox 工作；inbox envelope 准入容量必须为每条 immutable payload 预留最坏合法 JSON 状态大小，状态替换仍复核实际 next bytes；inbox 删除 tombstone 使用独立有界预算，不能因 envelope 满载而无法建立删除 fence。需要初始 processing claim 的 inbox envelope 必须首次原子创建成目标状态，不能先 commit queued 再改写。
- `wait_for_session` 的精确 `conversationId + runId` 只限定哪次 settlement 算成功；等待期间任何实际投递到当前 run 的新 peer/inbox 消息或被 SDK 接受的用户 guidance 都必须结束 wait。工具结果只返回消息来源 metadata 或 `{ outcome:"guidance" }`，正文仍只由 custom/raw user message 注入一次；message metadata 的 `fulfillsTemporaryReturn:true` 明确对应正文已满足 one-shot temporary 回传，不能只为稍后的 exact settlement 再 wait，普通 message 则仍只是 interruption；wait 注册前已 SDK 接受但尚未观察的消息/guidance 也要补查，单有 inbox `processing` 不是接受证明。`waitedByRunId`、每条 guidance 的 claimed 标记及 actor terminal CAS 共同防止重复唤醒；temporary receipt 仍只属于精确 temporary wait。source actor 对每个 run 只持有一个冻结目标的 local attempt（`open | delivering | terminal`），没有 target-keyed waiter 或 cycle graph；输入先于 settlement/receipt、reachability 与 `singleWaitCommitment` 检查。没有 active exact ticket、inbox processing/receipt-only/reload 等权威来源的 target 返回 `target_unreachable`（aggregate 任一 target 不可达同样终结）；`idle` 本身不是反证。open attempt 四分钟后轮询，`piweb.wait_poll.v1` 为同一逻辑 run 持久记录最多八次 `{ outcome:"checkpoint" }`，恢复不重置；额度耗尽返回 `{ outcome:"wait_exhausted" }`。timer 进入 project lifecycle 后复核 ownership/attempt，任一 terminal CAS 统一清理。
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
- `read_only` 的有效工具集只投影 `source=builtin` 的 Pi 原生 `read/grep/find/ls`，以及 `source=sdk` 的宿主受审查 `bash`、conversation-scoped notebook/LoopList 工具、本机时间 `current_time`、`request_context_compaction` 和 `list_roles/read_role/propose_role_revision`；`PiRuntime` 必须用当前 session 的有效 `SettingsManager.shellPath` 创建宿主 `bash`；该工具先用有界词法与命令级规则审查 Git、rg 和常用文件查询，可组合受审查管道/`&&`，`cd` 只改变同一次调用的目录，然后才委托 Pi 的真实 Bash；builtin/project/extension 同名工具仍拒绝。该规则只是防误操作的文本 guardrail，不保证 PATH、Git 配置或 helper 没有副作用；压缩工具只预约当前完整 tool turn 后的安全 checkpoint，返回 accepted 不是成功证明，最后一个角色工具只能经用户 editor 提交后由宿主写角色 prompt。其它命令、项目写入、未知工具和会话编排 meta 仍由服务端 gate 硬拒绝。`full_access` 直接允许所有工具，不是角色目录或项目外路径的 OS sandbox。
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

涉及 WebSocket 的集成测试需要允许监听临时的 `127.0.0.1` 端口。涉及 UI 行为时，还应覆盖对应组件测试；涉及生产启动时，再验证 `/health` 和一次浏览器主流程。
