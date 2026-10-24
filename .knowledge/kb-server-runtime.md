# 服务端运行时

`updated: 2026-10-23`

## 这个模块是干什么的

服务端运行时负责 Pi 原生资源、项目级 conversation actor、命令调度、认证交互和安全状态投影。

## 架构

`PiRuntime` 是进程级对象：

- 唯一持有共享 `CredentialStore` 与基线 `ModelRuntime` / `ModelRegistry`；认证和模型缓存由 Pi 1.0.0 runtime 统一读取；`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 及 SDK 内部 `pi-agent-core` 精确锁定 `1.0.0`。文件凭据按文件 identity/size/高精度时间戳复用已验证快照，同一 revision 的 provider 扇出读取不得重复取得跨进程排他锁；revision 变化时只允许一轮可取消的共享 reload 在锁内重新解析，写入仍锁定并让下一次读取重新验证磁盘。
- 会话级 steering capture adapter 同时提供 `CreatedPiSession.withdrawSteeringMessage(message)` 同步撤回：Pi 1.0.0 无官方单条删除入口，只在私有 `agent.steeringQueue.messages` 按严格对象引用删除唯一 slot，已 drain 到 loop 局部数组返回 false。成功后才按 SDK `contentText(content, "")` 同步一个 `_steeringMessages` 文本投影项并发 `_emitQueueUpdate`；文本 mirror 不参与 core 身份认领或 stale capture 回滚。私有 shape 变化必须 fail closed；queue_update 观察者在 mutation 提交后抛错只能报告，不能把实际撤回谎报为失败。无需修改 SDK、clear/replay 或第二队列。
- 持有 Pi 用户级 `ProjectTrustStore`；受保护的项目资源在 trust resolution 前不能进入最终 resource loader。这条检查不适用于本机 LSP：用户级配置中已启用的语言服务直接可用，不读写项目 trust store，也不弹信任询问。
- 为每个 session 或 project model catalog 创建独立 `ModelRuntime` / `ModelRegistry`，隔离 cwd 扩展的静态模型、base URL 和 headers；owner 必须在 AgentSession 创建后确认其 `modelRuntime` 身份。
- 服务层级要区分请求适配器能力与账号/模型资格：`src/server/service-tier.ts` 只在 `model.api` 为 Pi 官方 `openai-codex-responses` 请求路由时投影 `priority`，不按 provider 或 model ID 维护清单；因此同一路由的未来模型自动获得选项。角色目录用同一请求路由能力验证非空默认层级；ConversationActor 没有会话覆盖记录时读取冻结角色默认，有记录时连显式 `null` 也必须优先，并在角色切换时重置到新默认。账号与具体模型是否接受 priority 仍由供应商在 dispatch 时裁决，错误不得被捕获后降级。Pi Web 固定使用未修改的官方 Pi 1.0.0 包；由于官方 `streamSimple()` 尚不传播 tier，这个唯一依赖适配边界先用官方 `normalizeContext()` 规范化请求，再复用 `buildBaseOptions` / `clampThinkingLevel` 调用 session 自己的 `ModelRuntime.stream()` 并传入 tier，让认证、transport、响应解析和计费继续由官方低层适配器拥有。
### 上下文压缩与安全停点

- 默认 context compaction 固定接入 Pi 1.0.0 的私有五参数 `_runDefaultCompaction(preparation, model, customInstructions, signal, reason)`，位置在 custom `session_before_compact` hook 之后；custom 结果直接采用并跳过 resolver，否则每次 attempt fresh-resolve 冻结的 compaction identity。`null` 使用冻结 primary，显式 B 必须可用且有限正 contextWindow `>=` 本次 primary A，否则明确失败、绝不 fallback。Pi 原生 preparation、previous summary、split-turn、files、usage、abort、persistence 和 continuation 不被重写；普通 turn 仍使用冻结 primary。五参数接点不再携带 A 的 positional apiKey/headers/env：宿主只改 request model，Pi 随后通过 session-local `ModelRuntime` 为 B 解析摘要认证；显式 B 不继承 A service tier。request-local marker 在 provider 前剥离，Codex hint 保留但只含 B model，socket fence 仍生效。压缩失败不追加 compaction entry 或成功 rebuild，但 Pi seam 前已有的 transient overflow-recovery 内存变化可能保留。
- 压缩模型事实分成三层：冻结 role 的 `compactionModel` 只是配置 policy；live default attempt 只在 Pi 首次真正调用本次捕获的 `compactionStream(model, ...)` 后创建，记录独立 UUID、`follow_primary | explicit` 和实际 request target；成功后才把同一 attempt 写入标准 compaction entry 的 `details["piweb.compaction_provenance.v1"]`。显式 B 与 A identity 相同仍保留 `explicit`，不得按相等关系改写 policy；这些事实都不改变普通 turn 的 `selectedModel`。Pi 1 先 await 摘要认证、后读取 `agent.streamFunction`，因此宿主必须在 `await Reflect.apply(_runDefaultCompaction, ...)` 的整个调用结算期间保持 session-local stream override，并在 finally 中按 identity 恢复原函数，不能在同步调用返回 Promise 时立即恢复。wrapper 可承接 split calls，但要求每次 model identity 都等于首次解析目标并复用一个 attempt；同一 session 的 default attempts 不得重叠。observer 的 started/ended 回调必须 no-throw，不能改变 provider 结果。Actor 对 callback 做 runtime generation、compacting 和 attempt ID 防护并复制 payload，runtime 替换或压缩结束清空；只有 focused actor 由 `PiService` 投影，因而 custom hook 或 preparation/认证阶段可以只有 generic `compacting` 而没有 target。
- Durable provenance 不建立旁路 ledger：新 attempt 与成功 merge 都要求 request target 的 provider/id 非纯空白且各不超过 `MAX_MODEL_REFERENCE_BYTES`（1024 UTF-8 bytes），非法 live identity 在 provider dispatch 前拒绝；默认成功只合并进那条 Pi compaction entry 的原有 `details`。`undefined` 可新建 host namespace，已有值必须是 JSON-safe plain record 且不能占用该 namespace，否则 fail closed，Pi 的其它 details 原样保留。读取旧或手改 JSONL 时复用同一 identity 上限；`fromHook=true` 永远投影 `custom` 且不宣称模型，旧 entry、畸形、超界或碰撞 namespace 都安全省略 provenance，不能让 snapshot fatal，也不能从当前角色或 catalog 回填。失败与 abort 不持久化 attempt，也不声称 transport/provider 已接收请求。
### 认证、资源与配置

- API key 与 logout 只通过 `CredentialStore.modify/delete` 持久化；OAuth 在配置队列外使用 baseline provider 的 `auth.oauth.login(AuthInteraction)`，成功后再经 credential intent CAS 写入。扩展 OAuth 与进程全局 provider 注册仍 fail closed。
- 扩展 provider 只能通过 session-local runtime 注册可快照的静态配置；`streamSimple`、OAuth、`refreshModels` 和 native provider 注册会 fail closed，不允许绕过宿主的进程级边界。合法注册的静态 provider 即使暂时没有模型也必须保留在连接投影中，才能配置凭据并通过后续目录刷新恢复。
- 连接投影的鉴权能力必须分开报告：`apiKey` 取自 `Provider.auth.apiKey`，`oauth` 取自 `Provider.auth.oauth`。内置 anthropic、openai、xai 等 provider 同时具备两者；不能因为存在 OAuth 就隐藏 API Key，也不能给只有 OAuth 的 provider 一个会写入死凭据的 key 入口。
- Pi 内置 provider 的远程目录缓存有意由各 runtime 共享同一用户级 `models-store.json`；项目扩展不能注册会写目录缓存的动态/native provider，因此共享缓存只承载 Pi 官方目录，项目差异仍只存在于 session-local 静态 overlay。
- 配置变更通过 runtime 的串行 refresh 入口清理 credential command cache；基线可按显式 `allowNetwork` 刷新，session/project owner 则固定禁止网络刷新并保留每个 runtime 的错误聚合。后台模型目录由 `model-refresh.ts` 的 `ModelCatalogAutoRefresh` 维护：服务启动后立即执行一次非阻塞 `force:true` 联网刷新；`PiRuntime.commitCredentialChange` 在凭据实际写入后（即使随后本地刷新报错）通知 `subscribeCredentialChanges` 订阅者，再触发一次 `force:true` 刷新，避免运行中新加的凭据要等重启或手动刷新才看到远程目录；另每小时执行一次非强制联网刷新，是否真正下载由 Pi `withRemoteCatalog` 的 4 小时新鲜度窗口决定，主要用于重试失败并发现新发布模型。同一时刻最多一个在途，期间请求合并为一次重跑（任一请求要求 force 则 force）；每次 15 秒可取消，离线时跳过，失败只记日志。服务关闭或 reload 准备会永久 stop 并等待在途刷新退出；手动强刷仍走独立的精确命令。
- 可为项目创建独立的 model catalog：走与 session 相同的 trust、resource loader、静态 provider 深快照和不安全 provider 拒绝路径，但不创建或启动 `AgentSession`。它让空项目也能列出项目扩展模型并配置第一条会话。
- 串行执行认证/模型配置提交；OAuth provider 的交互式等待必须在队列外完成。
- 每个 provider 的 credential intent 在用户操作开始时取得一次性 revision，提交时只允许当前最新 revision 写入，避免旧 OAuth 结果覆盖后来发生的 API Key 或 logout。
- 变更后 reload/refresh，并通知活动连接发布新状态。若代码变更需要让当前运行中的 Pi Web 实例加载，由外部 supervisor 协调热重载：执行 `npm run reload`，需要跳过安全边界时执行 `npm run reload -- --force`。supervisor 先完成 `npm run build`；只有旧 server 冻结 admission 并为已有 active run 安装 reload latch 后，命令才返回 `accepted`，但该回执不等待最终 drain 或新进程 ready。默认模式等待每个 active assistant turn（含工具轮）到完整 turn boundary，随后旧进程完全退出，supervisor 才启动新实例；force 只提供立即中断的 best-effort，续跑前必须核对工作区和外部副作用。OS 临时目录中的严格 reload manifest v2 是唯一 durable handoff authority：每个 target 保存稳定 continuationRunId 与 `unadopted | adopted(exact adoptedRunId)`，supervisor 只用 exact requestId/runId CAS 更新。replacement child 在任何 project acquire/recovery 前同步预装全部 target reservation，并暂时拒绝 WebSocket upgrade；它串行执行每个 exact `requestId + resumeId` pass，只有 supervisor 原子应用 disposition 后返回的 exact ACK 才能释放首轮 startup barrier。`process.send` callback 只证明 IPC transport acceptance，不能清 reservation、flush completion 或删除 manifest target。只有稳定 header census 明确证明 manifest target 已不存在时，child 才返回 `completed` 以删除该 unadopted target；I/O、目录变化、完整性和其它恢复错误必须保留为 `retry`。first durable disposition set 即使包含 retry 也释放全局 WebSocket barrier；adopted target 则继续阻止 rewind/delete，直到 actor idle、没有 active reload run、queued/processing inbox、receipt-only run 或 processing batch，并收到 supervisor 的 exact target completion ACK。已存在的严格 legacy v1 manifest 会先原子迁移为 v2，再向 child 暴露新生成的稳定 continuation identity；pre-v2 writer 留下的无 `details` conversation reload marker 不提供 adoption 证据，也不能阻断后来具有新稳定 identity 的 exact target，读取时将其视为不相关并为当前 manifest continuation 建立新的精确 marker；已携带当前 `continuationRunId` 但缺少 `requestId` / `adoptedRunId` 或发生冲突的 marker 仍 fail closed，不能按当前 actor 或邻近 settlement 猜测。该能力没有公共 Pi tool，也不新增项目持久状态。
- 生产路径先 `createAgentSessionServices()` 加载 cwd 扩展/provider，再 `createAgentSessionFromServices()` 恢复持久模型，避免恢复顺序选错 fallback。Pi 1 的 session-local cache warming 在创建 AgentSession 前强制 `off`：实例级覆盖有效 `SettingsManager.getCacheWarmingMode()`，用户 `cacheWarming` 偏好及 settings 文件不变，teardown 后恢复原 getter。预热 provider 请求不能越过 actor ownership 或被投影成用户 run；不靠 `agent_start` 兜底后才中止预热。
### 桌面截图与坐标授权

- Windows 极简 `computer` 只在 frozen role 为 `full_access` 且 Actor 提供 exact active `ConversationRunOwnership` 时作为 custom tool 安装；`read_only` 既不可见也由既有 source-aware gate 拒绝。`PiRuntime` 惰性创建一个进程级 `DesktopController`，其 Koffi/Win32 adapter 只在真实首次调用加载；非 vision model 或 `images.blockImages=true` 会在 adapter 创建和任何桌面副作用前拒绝。controller 以 ownership 对象 identity fail-fast 串行 desktop lease；取消、terminal、reload、dispose 请求 release，但 native in-flight primitive settle 后才交给下一 owner。成功 capture 在 tool 返回前归一化成标准 durable content：结果 JSON text、安全 scope/size label 与一张 `image/png` 或 `image/jpeg`；空动作标为 `current`，非空动作只附新的 `after action batch`，不复制前图。原始 desktop PNG 受共享 16 MiB 输入上限约束，归一化结果最大 2000×2000 且 base64 严格小于 4.5 MiB，以确保 Pi SDK 后续 normalization 是 no-op；Pi 写入 SessionManager/JSONL 后，provider conversion 按这份持久 block 的原字节自然重放，连续截图形成 append-only `A → B → C`。没有 provider-only injector、before/after 滑动窗口或 controller 图片缓存；compaction 可把旧 entry 排除出模型上下文但不物理删除 JSONL。普通 tool event/history snapshot 仍只投影 image marker 与 `(messageId,imageOrdinal)` ref，base64 由既有 `open_image` 精确读取；`details`、PublicState 和普通 wire 不含图片字节。通用 durable read 仍以 16 MiB decoded bytes 为协议上限，其 canonical base64 落在 64 MiB server event envelope 内。
- 图片事实与坐标能力严格分离：controller 只瞬态保存不含图片字节的 pending/authorized `Frame` 几何、foreground binding、owner、source/exact decision IDs 及 label/MIME/哈希交付证据。同一次 validated capture 构造归一化 image result 与 pending frame；Frame 的模型坐标尺寸随实际持久图更新，`captureBounds` 仍是物理映射目标。宿主在项目 `tool_result` hook 与 Pi normalization 之后复核完整 content，任何改写或 hook 异常都 fail closed 并清 frame；最终 `convertToLlm` 边界再按 source toolCallId、规范 details text、label、MIME、图片哈希证明模型确实会看到同一像素与坐标元数据，`context`/`message_end` 删除或替换图片时不得授权。下一 assistant `toolUse` decision 才可把已证明 frame 授权给其中 exact computer IDs，local preflight 不消费，首个实际 controller primitive/capture 消费整次 decision；无 computer call、capture 失败、普通 assistant 结束、abort、compaction、reload、terminal 或 dispose 都清除 frame，持久旧图永不能恢复坐标能力。非空 `observe:true` action batch 默认 settle 150ms；失败只返回 unavailable，不保留历史前图。`keypress` hold、`mouseHold`、`drag` 均在调用内清理；只有可能按下而 up 未确认才永久 fail-close desktop controller，普通 unknown 不 taint。capture 内部以归一化 HWND+PID 绑定前台身份并检查 capture 前后稳定，授权批在首个 primitive 前复核；mismatch 清除 stale frame，身份永不投影。HWND/PID reuse 与 check→SendInput TOCTOU 是明确保留的 Windows 限制。
- `computer` 的 `foregroundWindow?: boolean` 默认 `false`，仅 `observe:true` 生效；它不是 selector，而是在 PMv2 DPI context 中以当前 foreground `GetWindowRect` 和主显示器求交的 crop。`captureBounds` 只负责 model-image-local→physical 映射，完整主显示器 `inputBounds` 只负责 `SendInput` absolute normalization，二者不可混用；原始 PNG 尺寸必须等于 crop，持久图可按上述 provider 边界等比缩小，因此 Frame 图像尺寸与物理 crop 尺寸不得合并。第一版不支持任意 region、副屏-only、virtual desktop 或 `MOUSEEVENTF_VIRTUALDESK`。minimized、空交集、Win32 读取失败或 capture binding 前后漂移均 fail closed、不 fallback 全屏。首个实际 primitive 保留既有 foreground identity 检查；window frame 的每个 coordinate primitive 还紧邻 dispatch 复核 identity、raw rect、crop 与 primary topology。任一 `foreground_mismatch` 都可能已有 `sent`；第一个 `not_started` action 和余项均未派发，必须由逐项 status 如实报告。durable image label 仅有 scope/size，绝不含 identity/title/物理 bounds；after 以动作后的当前 foreground 重新 capture，因此可与此前持久图有不同安全 scope/尺寸。

### 前台 run 与会话后台 Bash

`src/server/bash-execution.ts` 只拥有有界命令执行，不是 terminal、stdin、持久 shell 或调度器。前台使用 exact `ConversationRunOwnership` 的 session-local binding；后台由 Actor 的 `BashBackgroundTaskRegistry` 持有，并通过顶层 `CreatePiSessionOptions.backgroundTasks` 跨 runtime 重建复用。`task_id` 是独立 UUID，不是 PID、toolCallId 或 runId。每 run 最多 4 个前台、每 conversation 最多 4 个后台未终结及 64 个任务记录，`PiRuntime` 共享 32 个真正未终结执行的预算；已观测或已通知的终结记录才可 FIFO 回收。

`bash` timeout 为整数毫秒，上限 600000；前台默认 120000，后台未显式给出时不设期限，只由 `bash_stop`、reload 或 dispose 终止。前台等待并返回 Pi 原生结果，显式 `run_in_background:true` 立即返回 id。`bash_output` 默认阻塞等 30000ms（上限 600000），`block:false` 或等待超时返回非消费快照，无 id 立即列出本会话记录；`bash_stop({task_id})` 幂等短等。两者实际返回最终结果或错误时标记已观测；任务终结时若有这类调用仍在等待，registry 暂扣完成回调，由该调用直接返回结果而不再推送通知，避免 Agent 同一结果收到两次。没有正常原生结果、exitCode 0 且无 error/partial/stopReason 的事实，就不能宣称成功。

- 复用 Pi 公开 local operations 和 Bash factory，每个执行有独立 AbortController。SDK signal 仅取消工具等待，已经 aborted 的启动调用在准入前拒绝；命令 timeout 从启动起只计一次，不随 poll 重置。
- 输出先在 operations 边界限制原始 stdout+stderr 为 16 MiB，超限 stop/drop 并明确 `partial`；仅另捕获最多 1 KiB 原始滚动尾，最终仍复用 Pi 截断、错误文本及全文临时文件。latest payload 防御复制，不建完整 collector、游标或输出持久库；后台准入返回后不再更新旧 toolCallId。启动 shell/prefix/read-only/operations/budget 冻结，角色切换不改变已运行进程权限。
- 前台等待时，Actor 的同一 `onRunInputAccepted` 接点同时驱动等待中断与 `promoteForeground(exactOwner)`；只在浏览器、显式 steer、peer/inbox 或完成通知真实被 SDK 接受后调用，不把 registration catch-up、拒绝/extension handled 作为新输入。迁移原 record 到后台并立即返回 task_id，保留原 controller/timeout/operations/权限/预算，不重启或重复计数；后台额度不足返回 0，前台继续等且插话仍已入队。
- 普通工具返回、物理 `agent_end`、压缩和 LoopList 续跑不停止进程；run terminal/abort 只按约 2 秒宽限关闭前台，先清理再结算。后台跨普通 run_end/abort/角色切换/回滚存活，Actor reload/dispose 才有界关闭后台；已确认 killed 以 triggerTurn:false 写入通知，writer 不健康/写入失败只报告，unknown 不伪造终态。迟到前台 callback 只释放旧资源/计数，不复活 run。
- 后台终结 callback 向 Actor 报告事实，由 Actor 经标准 SDK custom message 写 `piweb.bash_task_notification.v1`（每批最多 4、command 256 UTF-8 bytes、尾部每项 1 KiB、正文 8 KiB）。streaming 复用 custom-steer FIFO，回合尾在 LoopList 之前同 run 续跑；idle 只经 coalesced coordinator pump 且 inbox-first，浏览器/inbox（含 receipt-only resume）抢先则 triggerTurn:false 携入。只 await 唤醒 admission wrapper，不持 lifecycle/operations 等完整 turn。原始输出是数据，不构成指令/新授权。
- 只有 `bash_output(task_id)` 返回最终结果/错误才标记已观测，可撤未交 SDK 的通知；SDK 已接受后不得撤回或重新提交，abort 可能清掉尚未观察的 SDK 队列。`wait_for_session` 只返回 `{outcome:"bash_task",taskIds}`，正文在原 custom message，成功 terminal CAS 才消费 wait 标记。Actor 先证明精确 JSONL entry 再发 `history_changed`，Service 只刷新 exact focused snapshot。
- 不再追加持久收尾摘要。旧 `piweb.bash_execution_notice.v1` 仅严格 reserved parser 兼容读取，不写入、不投影。清理未知持续占预算，使 Actor fatal、暂停自动工作；inbox pump/recovery 不能借 fresh Actor 绕过。
- Bash 清理未知不是可忽略的普通 reload 错误。默认 reload 在 Coordinator 与内部 `piweb_reload_blocked` IPC 上拒绝，不写新的 handoff manifest、不 kill/restart 旧 child，并保持 admission 冻结；只有显式 force 才允许 best-effort 替换。这个拒绝不是公共 WebSocket 命令。

重启后句柄失效，不重跑旧命令，不保证 daemon/disown、逃逸子孙或 force 的副作用 exactly-once；本机生命周期控制不是 OS sandbox。

### 其它进程级 owner

`ProjectStoreRegistry` 由 socket server 共享，按 canonical cwd 的活动 handle 复用 store；writer/deletion lease 必须先于 SDK open，FIFO/取消和末次 release 语义见[项目存储](kb-project-sessions.md#证明与发现)。

`RoleCatalog` 投影用户级模板的可用性与深快照，完整目录/迁移/冻结语义见[角色](kb-agent-collaboration.md#角色)。模型思考档位必须与 Pi getSupportedThinkingLevels() 一致，实际 fixed model 或 thinking 的 fallback/clamp 在 startup 拒绝；缺整份 profile 不会被猜测迁移，旧单字段补值差异见[兼容合同](kb-project-sessions.md#兼容性合同差异)。

`CustomProviderStore` 以用户级 models.json 为真相，写入经 PiRuntime.updateConfiguration 的共享队列，再 refreshAll 收敛基线及 session/project 目录；存储 CAS、外科编辑与探测只在[自定义提供商](kb-custom-providers.md)维护。服务入口注入真实 modelsPath/builtinProviderIds，socket server 默认只读 memory 实例，避免测试误写用户文件。

`UiPreferencesStore` 是进程级用户界面偏好 owner：严格 v1 读写同一 `<Pi agent dir>/piweb/ui-preferences.json`，当前只接受 `quiet-rebel | classic-rebel`。文件缺失是正常首次启动，以 `quiet-rebel` 开始且不产生 warning；不可读或 schema 损坏同样安全回退并保留启动 warning。损坏状态要求下一次显式选择修复，即使用户选择默认值也不能短路。每次提交在进程级 tail 上串行，以同目录独占临时文件写完后原子 rename；磁盘成功后才替换内存快照并允许 socket 广播，失败会 best-effort 清理临时文件且不得改变旧快照。socket server 会在 reload/close 同步冻结新偏好修改和新的 lazy coordination acquisition：普通 reload 先 drain 已接受写入再公开 admission-frozen，且等待期间不能从 absent coordinator 新建出未安装 latch 的 run；force reload 则按 best-effort 合同不等待旧写入。重复 reload 若 coordinator 在 freeze callback 前拒绝，外层也必须立即失败而不能悬挂。它不进入项目 `.piweb`、RoleCatalog、conversation lifecycle 或浏览器持久状态。

`ProjectSessionCoordinator` 拥有与连接无关的 project context/Actor 生命周期，详情见[协作页](kb-agent-collaboration.md#actor-所有权)。context 的 WorkspaceLsp 惰性共享至 coordinator close，不因 focus/runtime rebuild 释放；取消仅针对 caller，详见[LSP](kb-lsp.md)。

全局项目活动目录只在 busy/compacting/attention 聚合变化时更新，最多 100 项；高频 session_event 不触发扫描，遗漏项目变化时优先替换最旧低活动项。close 先同步封 admission/acquisition、drain 已接受 task，再 dispose actor/catalog 与项目 handle，迟到 owner 立即清理。

只读目录浏览属于 socket server 的 pre-session 控制边界：每次请求只枚举指定位置的一层子目录，结果按 commandId 返回；它不进入 `PiConnection` actor，也不参与项目或会话持久化。socket control 与 `PiConnection` 共用同一连接级 commandId registry，因此目录、偏好和 session 命令之间也不能复用身份。

`PiConnection` 是每 WebSocket 一个的项目观察与焦点控制器：

- 原子持有 `sessionId + project handle + focused conversationId/focusId + project observer + focused extension UI route`。
- 普通命令进入 `SerialTaskQueue`。
- `abort`、raw `steer`、`withdraw_prompt`、`auth_response`、`cancel_auth`、`close_session` 走控制通道；steer 与撤回必须在当前 run 尚占用 actor operation queue 时即可执行。撤回的来源 focus 校验与 native queue 删除同在无 await 的控制 turn，不等待 connection/actor/project lifecycle 串行队列。
- generation 使创建中的 project observation 变成 stale；detach 只释放观察 handle，不 dispose 后台 actor。不同 cwd 的 project context 与 conversation actor 各自持有运行状态，单个浏览器连接切换项目只替换观察投影，不能 abort 或 dispose 其它项目仍在执行的 run。
- 每次 attach 分配新 focusId；PiConnection 只向浏览器转发匹配当前 focus 的 transcript/run event，项目级 activity 仍通过 snapshot 更新。
- `initialize` 与 `focus_conversation` 可各自创建 invocation-local v1 phase recorder；它只累计 validation、context/catalog、presentation/target read、actor activation/lease envelope 与 snapshot build 五段单调时长，不进入 coordinator、`PublicState` 或持久状态。只有成功 transition 才把有界整数结果附于同 command 的首个 authority envelope：非空 focus 在 `focus_attached → state`（initialize 还先安排 project/role 投影）之后构建并附于 `conversation_snapshot`，不能为了观测提前阻塞 attach；空 initialize 不构建 snapshot，直接在空 `focus_attached` 上给出 `snapshotProjectionMs=null`。snapshot 阶段不含 send/delivery 或异步 project refresh；构建失败仍保持 attach/state 先行并走既有 session error，不发送半成品 diagnostics。
- PiConnection 对 coordinator 的全局项目活动目录只订阅一次，并独立发布不带当前 sessionId/focusId 的 `project_activity_snapshot`；切换 cwd 只替换当前详细投影，不会失去其它已加载项目的活动摘要。
- `ExtensionUIBroker` 是连接级临时 rendezvous，每次 focus 使用独立 scope 和 AbortController；后台 actor 缺少 UI delegate 时由 conversation router 保留请求并进入 attention，聚焦后再接入 broker，不抢焦点。focus/create 的 controller 在命令进入串行队列前登记，后续 focus、initialize、close 或 disconnect 会先同步 abort，再排队 detach，避免 extension activation 等浏览器对话框、而取消操作反过来等待同一队列的死锁。成功 attach 后该 controller 转交给 view 并取消旧 scope；切换失败则保留原 view controller，使原会话 UI 仍可继续使用。create 在 activation 后观察到 abort 时必须在同一 project lifecycle 内删除刚创建的 conversation/actor，不能留下无 attach 回执的幽灵会话。initialize 声明 `extensionUi:"none"` 的连接不创建 broker context、不附着任何 router，也不更新最近会话或清 attention；它的项目模型目录改用一律拒绝作答的 UI，使竞态下 trust 询问只会失败，不会被取消值结算成“本次不信任”。

## 决策

- cwd 校验通过后，旧 project view 会 detach，再取得 coordinator project handle；不同项目 actor 仍由 coordinator 独立拥有，直到服务关闭。
- initialize 建立无 AgentSession 的项目模型目录；cold exact/recent 的只读 preview 在该步骤前。模型查询、角色 CRUD、API Key provider 校验统一按 actor registry → project catalog → baseline 顺序。调用方取消只退出对 shared opening 的等待，不取消 store/coordinator-owned promise；打开、recent 写与导航取消细节见[项目打开循环](kb-project-sessions.md#打开循环)。
- recent 空项目保持空态，新建必须显式可用 role；浏览器 recent/refresh 走 discovery，不把展示摘要填入 authority profile。成员 complete 与全文 audit 是不同证明；删除也有独立目标批次 scope，统一见[证明与发现](kb-project-sessions.md#证明与发现)。
- warm focus 复用 actor，cold focus 先 lease + exact-target proof；attach 不等待全项目正文或 recent 写。已准入 recent intent 按 Store 队列顺序 drain，失败不反转已提交 focus，见[项目打开循环](kb-project-sessions.md#打开循环)。
- `createAgentSession` 一旦返回，owner bind、host tool gate 安装、startup provider/固定模型与初始思考强度校验和 extension load error 投影都必须位于同一个失败清理边界；其中任何一步抛错都 teardown 已创建的 AgentSession 并释放 actor lease。固定角色模型还在真实 `AgentSession.setModel()` mutation 边界由实例级 guard 强制：不同 provider/id 在写内存或追加记录前拒绝，同一 identity 保留 Pi 原生行为；guard 覆盖 `session_start` 到 `session_shutdown`，teardown 尝试完成后才恢复。ExtensionRunner 单独换成冻结的 readonly SessionManager facade，对所有 entry/tree/header 返回深防御复制；AgentSession 自身仍持有真实 manager。这里是可信扩展的 capability narrowing，不是恶意 JavaScript 沙箱。
- 持久 conversation、连接 observation sessionId、focusId 和 runId 是不同身份；同一 conversation 重连或重新 focus 都必须分配新传输身份。
- ConversationActor 在 rewind 或角色切换的 SDK runtime 替换空窗中仍持有 conversation 身份；`created` 才表示 runtime 可投影，此时精确 `refresh_view` 无操作、state/role catalog 不发布回退或错误，但 runtime-independent LoopList 与 fatal error 仍可观察，最终 snapshot 和 command completion 只由替换操作完成后发布。
- prompt/steer/inbox/abort 都由 exact active run 拥有，attach/detach 不穿过运行过程。[浏览器准入](kb-agent-collaboration.md#浏览器消息准入)拥有双 live gate、disposition、AsyncLocalStorage 与 raw 对象交付证明；本节只维护 SDK 适配。inbox custom steer 可在 ticket 已建立而 SDK 尚未 streaming 时暂存至 agent_start，普通发送只等 durable claim，不等内存暂存。SDK 异步 acceptance 拒绝必须经 tracked lifecycle recovery 复查 exact marker/receipt/settlement 后 finish 或 dispose/reopen exact processing run，不能吞掉 rejection。
- 精确校验来源 focus 后，手动 `compact_context` 直接交给来源 ConversationActor，不占用 PiConnection 的视图串行队列；压缩继续由 actor 拥有，浏览器可同时切换到另一 conversation。Actor 在返回 Promise 前同步预约 compacting，封住同时启动 run 或删除的间隙；删除端也必须拒绝 compacting actor，不能释放仍被压缩任务使用的 session。完成时仍按原 sessionId + commandId 回执；若当前 focus 已回到同一 conversation，即使 focusId 已更新也要刷新当前 snapshot，确保 A→B→A 不漏掉 compaction marker。Agent 的主动压缩工具已由 `reset_context({handoff})` 替代：它不调用这个 idle-only 入口、`compact()` 或摘要模型，只预约同 run 的完整工具轮次停点。工具接受前验证最近 `prepareRequest` 后唯一 assistant 的唯一直接 call；codemode 嵌套和混合 batch 都拒绝。Pi 已 flush turn_end 的 custom 输入后，Actor 再验证仅多出该成功 tool result，无未观察输入/队列/lifecycle 工作，才用 `appendCompaction(summary, null, tokensBefore, details)` 建 retain-none 边界并 `refreshContext()`。会话/run、权限/system/tools、Notebook、LoopList、后台任务和物理历史均不变，computer frame 清除；append/refresh 失败走 active-run infrastructure fatal，不重试未知 writer。accepted 不等于 committed，额外输入或 reload 取消请求，abort 不允许迟到提交。
- 会话角色切换同样是来源 ConversationActor 拥有的长操作，不占用 PiConnection 的视图串行队列；切换项目只撤销浏览器观察，不能取消或等待另一项目正在重建的 runtime。原 observation 仍有效时才刷新 focus 并回执，之后重开来源会话从 actor 权威角色快照恢复。
- `selectedServiceTier` 归 conversation actor 所有，以 `piweb.service_tier.v1` 严格 custom entry 持久化并恢复；`null` 表示请求中省略 provider 的 service-tier 字段、沿用供应商默认行为，不等价于显式 tier `default`。Coordinator 的变更入口必须经过 project lifecycle 串行边界，并在边界内复核 deletion reservation 后才 append 和回执；它由此与 rewind/delete 精确排序，不能让已经在途的破坏性操作在成功回执后抹掉刚追加的选择。只允许 idle、非 compacting/其它破坏性操作中的会话写入，非空选择必须由当前模型的请求路由声明支持；任何会改变实际模型的角色/模型变更也必须拒绝与现有非空 tier 不兼容的目标。模型目录漂移后已持久化的不兼容值仍保留并可清除，不能静默重置或降级；下一次模型 dispatch 会重新校验并 fail closed。因此 active run 的 tier 从启动到结算不可变。
- `PiRuntime` 在每个 session 自己的 `ModelRuntime.streamSimple` 边界安装 service-tier wrapper；它位于 coding-agent 的 session request decorator 之后，因此该 decorator 注入的 timeout、retry、attribution 与扩展 `before_provider_headers` transform 都先进入 options，再由 wrapper 显式保留。普通请求、工具循环和 compaction summary 都经过同一层，而 `agent.streamFunction` 身份不变，manual compaction 的认证选择不需另加恢复时序。`null` 仍交给官方原始 `streamSimple` 且省略 body tier；非空值先按本次请求的 `model.api` 复验路由能力，再用同一个 session `ModelRuntime` 调用官方低层 stream 并传入 `serviceTier`。只有内置 `openai-codex` 的 ChatGPT backend 额外镜像 first-party `x-codex-routing-hint`：默认值只含 model，非空值同时含 tier；自定义同 route provider 不接收该私有 header，既有 header transform 最后仍可覆盖它。由于 Pi 的 Codex WebSocket cache key 不含 routing hint，wrapper 按 session 记住最后 hint，并在 model/tier/route 变化时先关闭该 session 的旧连接；普通 auto transport 已固定为 SSE，这个 fence 只在显式 WebSocket 模式实际命中缓存。wrapper 不捕获 provider 错误，也不提供重试、回退或降级；tier 必须到达官方响应/计费路径。
- reset 的保护底座来自**当前规范投影**中依序有效的 raw user 输入、未知来源的 custom message 及全部 compaction/branch summaries，已 omit/replace 的旧 raw 不复活；宿主进度 hint、续跑控制、Bash 输出通知与 `piweb.conversation_message.v1` / `piweb.fork_context.v1` 不进入保护底座——peer/inbox 报告和 fork 上下文是工作上下文而非用户授权，它们随重置一起卸载，只在 summary 里留一条显式说明（条数、约多少 KiB、去 `history_search/history_read/peek_session` 回读），并且这条说明不写入 details 的 seed，所以不会沉淀进后续 checkpoint。体积门是模型预算预检（冻结 system/tools + 摘要用 Pi token 估算对比当前模型 context window），另加 128 KiB 的 seed sanity bound；被保留的输入含图片或超预算就拒绝，不用 marker 冒充保留图像。Agent handoff 另限 8 KiB；这笔预算检查不是 provider 精确 token 保证。seed 与 handoff 分开写入原生 compaction 的 `piweb.context_reset.v1` details 并验证 summary 一致；旧版本写入的无 `reports` 字段 checkpoint 仍按原文本复验。后续 reset 复用 seed，不递归吞入旧 handoff 或旧报告说明。它保留来源与顺序，但不声称保留原消息角色身份或修复过去有损压缩。每 run 最多 8 次，且再次 reset 前必须出现新工作/输入；未知进度不能靠重复 reset 续命。
- `agent-turn-boundary.ts` 复用原生 `prepareRequest`：先 await 原 callback，再记录本次 canonical-history frontier，不声称是最终 provider wire snapshot。`agent-context-budget` 在转换期追加的宿主 `context_hint` 是受控例外，其 LoopList/预算信息由原 owner 保持；其它 context 新增仍取消 reset。停点本身继续沿用既有 finishTurn/queue-pause。
- 自动压缩阈值属于 conversation actor：缺省 80%，从 `piweb.compaction_threshold.v1` 恢复（已有显式覆盖不迁移）；每轮开始前先处理上一次失败/中止遗留的高水位，正常结束后再用 Pi 的 context usage 检查百分比并触发标准 `compact()`，不改动同时影响摘要预算的 `reserveTokens`。长工具任务还会在每个成功 assistant/tool 轮次结束后重新调用 `getContextUsage()`：无论是否越过阈值，都发布一次低频 `context_usage` actor 事件，让 focused connection 立即刷新输入框下方的当前上下文计数；只有存在工具结果且达到阈值时，才让 Pi 在该轮完整结束后优雅停下。`agent-turn-boundary.ts` 包装 Agent 的 `finishTurn`，先 await 上游 hook，原样保留其非 undefined decision、error 与 abort 语义；只有完整结束的 `toolUse` turn 且已有 tool results 才运行宿主建议性检查。命中 checkpoint 时仅在宿主持有 pause 期间遮蔽 `hasQueuedMessages()` 对 queued continuation 的观察、消息本身不被删除，保证下一次模型请求不会越过宿主压缩；工作台取得控制权后释放该暂停，保持原 `runId`、busy 状态和 active run ownership，执行标准 `compact()`，再用隐藏 custom message 自动续跑并自然消费原队列。因此底层可出现多个 `agent_start`，但浏览器只观察到一个工作台 run；若 SDK 仍因其它内部恢复路径自行续跑，actor 识别后不会再注入第二次 resume。PiRuntime 只在上述默认压缩接点内为摘要请求临时包装 Agent stream，将 reasoning clamp 到模型支持的 `minimal`，不修改会话 thinking 状态、持久设置或普通 Agent 请求，并在调用成功、失败或取消的 finally 中恢复原 stream；custom compaction 不经过该 wrapper。Actor 同时观察 SDK 原生 `compaction_start/end` 作为 `compacting` 状态来源；同一 checkpoint 已见 SDK 压缩 attempt 时，宿主阈值检查不立即重复触发；任一宿主或 SDK 压缩失败只把下次尝试推迟到 context usage 再增长 5 个百分点，而不能永久关闭当前长 run 的压缩，成功则清除该 backoff。取消 run 在 compacting 时先调用 `abortCompaction()`；无论取消发生在 pre-run、轮次间还是 post-run 压缩，都必须等 compact 退出后把 run 结算为 aborted，且取消异常不能伪装成普通压缩错误。更新阈值只追加非上下文 custom entry。空闲会话还可通过精确 focus 关联的 `compact_context` 手动调用同一个标准 `compact()`；这些路径共用 actor 的瞬时 `compacting` 状态并阻止新的 run/角色切换/截断，focused connection 将其投影到 `PublicState`。成功 compact 产生的 Pi 原生持久条目仍在 snapshot 中投影为用户可见分界线，不另存第二份持久压缩状态。
- `PiRuntime` 对每个交给 `AgentSession` 的 `SessionManager` 安装实例级 compaction boundary adapter：追加压缩前只沿精确 active branch 检查 retained physical message，若 `toolResult` 的严格更早 assistant `toolCall` 落在边界前则把 `firstKeptEntryId` 反复回退到依赖闭包；缺失、乱序或非当前分支候选都在写入前 fail closed。普通 custom metadata 和 context-visible `custom_message` 不改变配对规则；adapter 在 AgentSession teardown 前恢复该实例原有方法，不修改 SDK prototype。
### 执行任务提示

仅普通 Agent 模型调用使用此提示；Pi 独立 compaction/branch-summary summarizer 不消费执行任务提醒。runtime 在 extension context hook 后读取 Actor 最新 LoopList，仅有 active 项时才合并当次 usage/阈值提示与 `piweb_work`；锚点重放规则由[LoopList owner](kb-agent-collaboration.md#looplist-状态与续跑)维护。

提示是一条隐藏、持久的 `piweb.context_hint.v1` custom message，streaming 经 steering 在下一模型调用前注入，idle 直接追加；同会话不足一分钟不重注入。最多 4096 UTF-8 bytes，只保留完整 active item 的 id/text，确有裁剪才写精确 omitted；字段顺序固定，分钟值 `activeElapsedMinutes/loopListElapsedMinutes` 自解释、向下取整且负值钳零。无 active 时连 ctx hint 也不注入；usage 不可用仍可输出 active 摘要，计时失败只省略分钟字段，距自动压缩阈值 5 个百分点时才提醒：先将必要笔记保存到 Agent Notebook，再携带明确 handoff 将 `reset_context` 作为唯一直接工具调用。注入 best-effort 不阻断模型。持久追加保证 provider 前缀 append-only，不能改回下轮消失的瞬态尾部。
### 请求与会话变更

- OpenAI Codex Responses 的 `auto` transport 在 AgentSession 创建前通过 session-local settings override 解析为 `sse`，让普通 turn、SDK retry 与 compaction summary 共用 zstd SSE；用户显式选择的 `sse | websocket | websocket-cached` 原样保留，override 不写回用户或项目 settings。完整 provider JSON、cached WebSocket delta、实际 WebSocket frame 与压缩 SSE body 是不同观察边界；工作台不得再用 raw context/provider body 字节阈值伪造 `context_length_exceeded` 或触发 durable compaction，generic WebSocket/request-buffer error 也必须保持 transport error。
- 空闲会话可通过精确 focus 关联的 `switch_conversation_role` 应用当前可用角色。Actor 同步封锁新 run，停止旧 AgentSession，追加包含 primary/compaction identity 的角色变更记录（该记录同时把 active-branch thinking 重置为新角色默认值），再用同一 SessionManager 和新角色 model/prompt/meta tools 重建；替换 runtime 打开失败时追加上一角色及失败前实际 thinking 作为补偿并恢复旧 runtime，补偿也失败则 actor fatal。conversationId、history、lifecycle 与 createdBy 不变。
- API Key 在共享配置队列完成后才确认；API Key、OAuth 与 logout 共用按 provider 排序的一次性 credential intent，旧操作若已被更新 intent 取代就不得写入或发送成功回执。凭据本身影响所有项目，但发起命令必须仍属于提交时的 observation session/generation，避免迟到页面修改全局认证。会话模型由角色快照固定，中途 `select_model` 明确拒绝，可信 extension 的 `pi.setModel()` 也必须经过 session-local fixed-model guard；actor 重开时再次校验实际模型，不能 SDK fallback。
- API Key、角色 CRUD 和删除等需要结算的操作都带原 sessionId + commandId，连接内复用 commandId 会被拒绝。手动 `refresh_models` 同样是 session-scoped 的精确 command：必须携带 `sessionId + commandId`，使用 `allowNetwork:true, force:true` 和 15 秒全操作 deadline；成功回 `command_complete`，失败回同一 correlation 的 error，不能只刷新公共状态。超时或生命周期取消会立即结算调用方，但底层 refresh 真正退出前仍占用单连接 refresh slot，不能积累第二个底层刷新。
- 会话“回到此处”由 project lifecycle、ConversationActor operation queue 和 ProjectStore 原子截断共同完成；busy、存在待处理 inbox、未 settlement delivery receipt 或 reload completion ACK gate 时拒绝。actor 先停止当前 runtime，让 extension `session_shutdown` 的写入仍位于待删 suffix，再执行 durable truncate；Store 复用 fresh exact-target inspection，不再在前后调用 SDK 全目录正文列表，且同一原文件只解析一次。候选仍完整审计，rename 前按完整安全 fingerprint 复验，提交后的目录更新只走既有 discovery；discovery 失败仍准确归为已提交，actor 必须 fresh exact reopen 后重建，不能恢复旧 future parent。truncate 会结构性重挂并保留 permanent delivery receipts 及其引用的 exact run settlements，同时允许删去 incoming marker/card 投影。truncate 未提交时从 shutdown 后的实际 branch thinking 恢复旧 runtime，恢复失败才 fatal。提交后统一按 retained active branch 重建 runtime；跨角色时同时恢复固定 model/system prompt/tools/权限，同角色也恢复 retained messages/thinking。只有 durable JSONL、runtime 与 coordinator profile cache 都同步后，PiConnection 才依次发布 focused snapshot 和 command completion。
- 自动压缩阈值与 thinking 的 conversation 写入口都经过 project lifecycle，在边界内复核 deletion reservation，再交给 actor 唯一 writer；它们因此与 rewind/delete 排序，不能由迟到写复活已删除状态。thinking 按 active branch 从角色默认值和后续 Pi 原生 `thinking_level_change` 聚合。`setThinkingLevel()` 和 `setSessionName()` 会先改内存再持久化；工作台以 actor 实际后置条件为准，发布新 state 并单独报告持久化风险。若空闲 rename 的 `setSessionName()` 已改内存而持久化失败，actor 必须进入专用 session-persistence quarantine：先投影不含幽灵标题的 state，再发送精确 correlated `settings_persist_failed`，绝不发送成功或补偿追加；任何会取得该 active manager 的普通/后台工作（包括 receipt-card 投影）都拒绝，避免以错误 leaf 为 parent。只有显式 open/reconnect 才能 dispose 并从验证后的磁盘重建；dispose 报错时也必须移除旧 actor 映射，使下次显式 open 可重试。相对地，`CredentialStore.modify/delete` 与 `ProjectStore.setToolMode` 都是持久写成功后才替换内存状态，不需要这种部分提交适配。
- browser prompt 可随时尝试，但 busy admission 只在 actor 与 SDK 双重 live 边界允许；失败时不发 `prompt_admitted`，浏览器保留草稿。接受后不建新 run ticket、不写持久队列，当前工具序列结束后下一次模型调用前注入；steeringMode="all" 让排队消息（含 inbox）一次模型轮次全部注入。idle 时经 project lifecycle 起新 run且不越过已有 inbox 工作。abort 在封闭新 admission 后先按 captured 对象逐个调用既有撤回 seam，仅真实 core removal 发 `prompt_withdrawn(reason=abort)` 并退休该 admission/guidance；然后 `clearQueue` 清其余 SDK steering/followUp 队列，再调用 SDK abort。已 drain 的 browser/explicit guidance tracking 保留至 raw durable delivery 或 settlement，避免吞掉 late delivery；capture 已发生、pre-ack postcheck 因 cancelling 拒绝的路径同样保留现存 tracking，但不复活已成功移除的项。没有 capture、bulk cleanup 或 aborted terminal 都不能补造取消证明；结算统一退休剩余易失记录，旧消息不能跨越结算边界污染下一次 run。admit 有界（单会话最多 64 条 pending），slash 开头拒绝。
- wait 的 source-local attempt、durable settlement/accepted input 唤醒、reachability 与 timer CAS 由[协作页](kb-agent-collaboration.md#agent-meta-工具)维护；它阻塞工具但不锁住 run。
- 四分钟 checkpoint 不证明 target 完成；调用者若仍依赖结果可再次 wait，宿主不自行重试。
- 取消 run 必须先清空 SDK 尚未消费的 steering/follow-up queue 再 abort；否则旧引导可能跨越结算边界污染下一次 prompt。持久跨会话消息仍由 inbox delivery marker 决定是否重投，不能把 SDK 内存队列当成 durable truth。
- 注册不可复用 runId、安装 active RunTicket 后立即发送 `run_queued`；它既是生命周期事件，也是 idle browser prompt 的接收回执。busy prompt 则只在 SDK 接受 steering 后发送 `prompt_admitted`。
- 首轮自动标题是 Actor 持有的易失辅助工作，不是 prompt 或 run settlement 的准入门；生成只产候选，健康且 same-runtime 的安全 idle writer 边界才同步提交，人工标题/清空优先。abort、fatal、dispose 和 runtime loss 取消候选，setter 部分持久化失败沿用 quarantine。详细条件见 [kb-project-sessions.md](kb-project-sessions.md)。
- SDK 异步 preflight 结束时会再次检查 run ticket；若期间已取消，会在真正启动 agent 前阻断。
- AgentSession 构造完成后，工作台在 SDK extension hook 外再包一层 host tool gate；扩展先修改/阻止，工作台再用最终 validated args 决策。模型直接工具调用经 `agent.beforeToolCall`；Pi 原生 codemode 等通过 `ctx.executeTool()` 发起的嵌套调用会绕过这个入口，所以宿主在 ExtensionRunner 的 nested `tool_call` 路径补同一个 gate，不重复授权顶层调用。嵌套 context 捕获原 run signal，child signal 与 parent signal 合并给 host gate 和 SDK 真正执行；旧 context 不能借下一 run 授权。写入准入在真正 builtin 执行前完成，不安装 host completion callback，也不把写入结果改写为额度事实。
- 首次 builtin 写入的 exact-run latch/marker 与历史 charge 兼容由[工具策略](kb-tool-policy.md#首次写入-looplist-门控)维护，不在 runtime 复制额度或 completion accounting。
### 工具结果压缩

- 每个 `bash` 或 `grep` 工具结果在 Pi extension 的 `tool_result` hook 完成后，由宿主在 `afterToolCall` 直接压缩最终有效 content 的文本 part（image 和其它 part 保持原样）；`grep` 在通用采样后折叠连续同路径行，两个工具都会把同一结果中的非连续长重复行引用到首次输出行，并以原始输入重新执行 10% UTF-8 收益门槛。该 hook 发生在 SDK `tool_execution_end` 和 tool-result `message_end` 前，默认压缩内容进入 Agent 内存、SessionManager/JSONL、UI、后续上下文和 compaction。后续可信 extension 的 `message_end` 仍可显式替换消息；压缩是默认优化而非安全边界。未被再次替换时，被省略的原始行不持久化，也不提供 recovery。
压缩适配在 `src/server/tool-result-compression.ts`，通用无状态内核在 `packages/context-compressor/src/index.ts`；规则详见 [包说明](../packages/context-compressor/README.md)。内核移除 ANSI/折叠连续重复行，超过 8192 UTF-8 bytes 后保留首尾、诊断邻域并采样其余行；仅候选节省至少 10% 才采用。验证入口为 `src/server/tool-result-compression.test.ts` 与 `packages/context-compressor/test/index.test.ts`。

### 工具、扩展与投影

- gate 启用时固定 sequential tool execution，避免 parallel preflight 在 abort 或权限收紧后执行已积累的调用。工具 availability 只描述 schema/loadout，不授予执行权限；真实授权仍由 frozen role、exact run ownership 与 source-aware gate 决定。
- extension startup 建立初始 tool topology；之后默认拒绝 `setActiveToolsByName` / tool registry refresh。唯一动态例外是 `full_access` 注入的 Pi 原生 MCP/tool_search factory：它们自己的 `registerTool/setActiveTools` 通过同步 scoped capability 更新模型工具菜单；普通项目扩展仍受冻结限制。`before_agent_start` 对完整 normalized `systemPromptOptions` 做调用前深快照与结果深比较，唯有原生 MCP handler 捕获的 `mcp_servers` 区段值可变化；其它 selected tools、force/custom/append prompt、sections、context files、skills、tool snippets/guidelines 和 prompt guidelines（含原地修改）仍拒绝。角色切换/rewind 用受控 runtime rebuild 建立新 topology。Pi SDK 的项目 `.pi/mcp.json` 只在 project trust 后读取；`read_only` 不加载这些原生 factory，因此不会启动 MCP stdio/HTTP 连接。GodBrave 等小型服务可用 `exposure:"direct"`，无需工作台另造 MCP 客户端或管理 UI。
- 有效工具集与 source-aware 授权以[工具策略](kb-tool-policy.md#策略)为准；宿主 SDK 例外不可被同名 builtin/project/extension 冒充。
- 生产 `SettingsManager` 先以 `projectTrusted=false` 创建。无受保护资源时直接继续；有资源时先读用户级 trust store/global default，必要时通过浏览器选择，再由 SDK 二阶段 resource reload 加载或跳过项目设置、skills 与 extensions。`projectTrustNeedsDecision(cwd)` 与这条路径共用同一判定（有受保护资源、无保存决定、默认策略为 ask），只供 `extensionUi:"none"` 连接在建模型目录、冷打开/新建/fork 前预先拒绝；“仅本次信任”不缓存，所以每个新 Pi session 都会重新询问。
- 创建后显式 `bindExtensions(mode=rpc)`；只把 `select/confirm/input/editor/notify` 接到 Web UI，TUI 定制仍继承 SDK no-op。session_start/resources_discover 会运行，扩展错误会绑定到当前 run 或 session。
- extension UI response 绕过 actor queue；request 绑定当前 focus 的 sessionId/generation，timeout、扩展 AbortSignal、run stop、focus change、close 和 disconnect 都按 Pi 默认值结算。requestId 在连接生命周期内不复用，并以 4096 次总请求上限约束去重集合；达到上限后必须重连，不能让扩展用顺序对话无界增长宿主内存。
- extension command 的 new/fork/tree/switch 返回 cancelled，reload 明确报 unsupported；当前入口拒绝 extension slash command，避免 handler 的 detached turn 越过 activeRun ownership。
- actor 无 activeRun（或 run 尚 queued）却出现 `agent_start` 时立即 abort；这是一条防止扩展旁路启动 Agent turn 的兜底不变量。
- SDK 报告的 extension load errors 也会进入 session 错误，不能只监听运行期 runner errors。
- initialize 在 project view 建立前就登记目标 observation epoch；focus 只有在精确 `focus_attached` 后才可发送 prompt。异步取得共享 coordination 后发布 role catalog 时也必须重新核对同一个 view 对象及其 session/generation，不能仅凭旧对象仍被引用就向新 observation 发迟到快照或错误。
- cold exact/recent/focus 可先发 command-correlated 只读 preview，不启动 catalog/runtime/extension route/lease；warm actor 或 actorOpening 不读 disk preview。prepare await 后复核 generation/session/abort/deleting/closing/actor race，emit 前再无 await 执行 coordinator gate；caller 取消只放弃观察。完整性错误阻止 open，仅证明后的展示失败可降级。正式 attach 先 focus_attached + state + 有界 focused snapshot，再异步 discovery/role catalog，不让全项目扫描挡住目标历史；pendingPrompts 与 durable/live 后缀从 Actor 权威 snapshot 恢复。
- focused history 由 ConversationActor 一次性捕获并完成 durable/live ownership 交接、语义折叠、peer enrichment 和最终窗口化；PiConnection 不得再次独立读取/裁剪 SessionManager。交接只认 `entry.message === rawMessage` 的对象身份，未匹配 live item 必须形成连续 suffix。user 使用 SDK 复用的原始对象；assistant 的 start 是 partial clone，必须在 `message_end` 改绑随后会被 AgentSession 持久化的 final 对象。初始 browser user slot 只绑定首条 user，后续 steer 各自拥有独立 slot。投影窗口按最终 JSON UTF-8 bytes 计算；窗口成员被卡片更新淘汰时必须发布完整 snapshot，而不是只发送无法删除旧 item 的 `conversation_item`。
- 同一 project view 的索引刷新同时最多执行一轮；进行中收到的任意数量请求折叠为一次尾随扫描，尾随到达时前一轮结果不投影。页面恢复的 `refresh_view` 只接受精确 observation/focus 身份；focused actor 未 compacting 时可重发 snapshot，包括 active run；必须使用 Actor durable/live handoff 后的投影，不能以纯 durable transcript 覆盖流式尾部。
- close/focus change 先同步使观察身份和 UI route 失效，再 detach project view；它不会把仍在运行的 conversation actor 当作连接资源销毁。
- WebSocket server handle 显式拥有升级监听、活动 socket、共享 RoleCatalog 与 ProjectSessionCoordinator；进程退出会先停止升级、断开客户端，再等待全部 connection 和 conversation actor dispose。
- 目录浏览不启动系统窗口或子进程；服务端重新校验浏览位置，只返回目录名与绝对路径，并同时限制数量和序列化字节数。用户确认后仍必须由 initialize 独立校验并提交项目 cwd。
- WebSocket upgrade 默认要求 loopback Origin 与请求 Host 精确一致；不能因为 hostname 是 localhost 就允许其它本机端口枚举目录或发送 Agent 命令。显式启用的 Tailscale Serve 是唯一远程例外：后端仍只监听 loopback，upgrade 必须来自 Origin/Host 精确一致的 `.ts.net` HTTPS 地址，并通过 `headersDistinct` 证明 Serve 只注入一个非空 `Tailscale-User-Login`；缺失或重复身份、HTTP、其它域名与跨 Origin 请求都 fail closed，访问授权仍由 tailnet access rules/设备分享拥有，禁止用 Funnel 或通用反向代理替代。
- ConversationActor dispose 会先等待取消，再发送 `session_shutdown(reason=quit)`，最后释放 AgentSession、session 模型目录和 writer lease。
- Pi SDK 的 `streamSimple`、OAuth 和 native provider 注册可能触及进程全局状态；第一版显式拒绝这些项目扩展 provider，不能用裸 per-session registry 伪装隔离。
- 允许的静态 provider config 会先做 host-owned 深快照，防止扩展在注册后修改原对象绕过策略。
- registry refresh 后必须把 AgentSession 当前 model 重新绑定到新对象；非 fixed 模型被删除时可以选择 registry fallback，但角色快照固定的模型被删除时必须 unset 并投影为 unavailable，绝不能继续使用旧 endpoint。配置已持久提交后，每个 session registry 与 baseline registry 的 refresh 都必须独立尝试，并在最后照常通知订阅者；单个 owner 抛错不能跳过其余 session，多个错误聚合后再返回调用方。
- SDK 内容事件只在当前 actor run ticket 匹配时投影；PiConnection 再按当前 focusId 决定是否发给浏览器。run lifecycle 由工作台适配层合成。
- SDK 可能用 assistant `stopReason=error` 表达失败并让 `prompt()` 正常 resolve；projector 以最终一次 assistant 结果校准 workbench outcome。
- SDK 原生事件只交给 `SessionEventProjector`，不直接发送。
- SDK 明确报告 context unknown 时保留 unknown；仅在 SDK 没有读数时做估算。

## 认知模型

共享配置、角色与 trust 归进程；conversation 与 inbox pump 归 coordinator/actor；浏览器临时交互归 focus generation；socket 归传输。任何新增状态都应先决定属于哪一层，再决定由哪条队列修改。

结构模块不得改变这些 lifetime：每个 `ConversationActor` 持有一份 `ConversationProjection`，后者只拥有跨 run 单调的 projectionSeq、当前 live suffix 与基于 raw SDK message 对象身份的 durable handoff，不拥有 activeRun 或事件订阅；`ConversationExtensionUIRouter` 仍按 project conversation 生存而非按连接生存；每个 `PiConnection` 持有一份 `ManualModelRefreshGate`，它只封装单次 refresh 的 admission、公开结算与底层 drain barrier，连接仍拥有命令队列、session/generation 校验和 wire 回执。

## 入口

- `src/server/pi-runtime.ts`
- `src/server/tool-result-compression.ts` / `src/server/tool-result-compression.test.ts`
- `packages/context-compressor/src/index.ts` / `packages/context-compressor/test/index.test.ts`
- `src/server/bash-execution.ts`
- `src/server/model-refresh.ts`
- `src/server/manual-model-refresh.ts`
- `src/server/agent-turn-boundary.ts`
- `src/server/agent-context-budget.ts`
- `src/server/pi-service.ts`
- `src/server/socket-server.ts`
- `src/server/role-store.ts`
- `src/server/role-catalog.ts`
- `src/server/conversation-actor.ts`
- `src/server/conversation-projection.ts`
- `src/server/conversation-extension-ui-router.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/directory-browser.ts`
- `src/server/serial-task-queue.ts`
- `src/server/session-events.ts`
- `src/server/session-usage.ts`
- 对应的 `*.test.ts`

## 坑点

- OAuth login 会等待浏览器回答；认证回答和取消不能排在 login 后面的同一队列，否则会死锁。
- OAuth/extension UI 这类同步 emitter 的请求必须先登记 pending waiter 再发事件；emit 抛错时要删除 waiter 并拒绝请求，避免同步回答丢失或残留悬挂状态。
- 项目信任和当前 focus 的 extension hook 也可能在首个 PublicState 前等待浏览器；扩展 UI 回答同样不能排 actor queue，也不能要求 PublicState 已存在。
- OAuth flow 由 authFlowId 关联；pending/cancelled tombstone 保证在 flow 创建前收到的 cancel 也能阻止它启动。宿主不能调用会在 provider 返回后自行同步 credential 的 `ModelRuntime.login()`；必须从 baseline provider 的 `auth.oauth` 取 login，在配置队列外传入 `AuthInteraction` 获取 credential，再复验 flow 未取消，并用 flow 开始时取得的一次性 provider revision 进入共享队列通过 `CredentialStore.modify` 提交。这样忽略 abort 的 provider 只能返回一个未提交值，且旧 flow 不能覆盖后来开始的 API Key、logout 或 OAuth intent。
- `tool_execution_start` 发生在 SDK 参数校验与 host 策略之前，不能解释成副作用已经开始。
- sessionId/focusId/runId 不得复用，否则迟到命令会形成 ABA；连接 view 与 conversation actor 会显式拒绝复用。
- `close` 与 `error` 都可能触发 dispose，清理必须幂等。
- Pi 1 只有精确 `queued` disposition 加该 invocation 的 message identity 捕获才证明接受易失 steering 队列；promise resolve 或 `handled` 都不能单独证明入队，更不证明 user message 已持久化。接受后的 delivery failure、run settlement 或 append 证明缺失不能回滚为 queued；只有 exact delivery receipt 才允许清 sidecar。
- 拥有资源 teardown 边界的串行队列必须同步封闭 admission，并在释放资源前 drain；仅设置 `disposed` 而不等待 tail 会允许关闭后迟到写。ConversationActor 通过唯一 activeRun completion 结算 operations，PiConnection 把 cleanup 排在同一 operations tail，ProjectSessionCoordinator 则显式 `SerialTaskQueue.close()`。
- teardown 的错误监听注册/注销本身也可能抛错；它们不能阻止 abort、等待运行结束和 dispose，所有失败应在完整清理后聚合报告。
- 调用 Pi 的状态 setter 后不能把任意 throw 直接解释成“没有生效”；先核对 AgentSession / SessionManager 后置条件，再区分提交前失败与提交后持久化风险。
- `SessionManager.open()` 可能迁移文件且对不存在路径不可靠报错；coordinator 必须从服务端受控索引解析 ID，并在 singleflight open 之前持有 lease。
- Node 的 `server.close()` 不会替你关闭已升级的 WebSocket；退出流程必须同时关闭 socket server handle。
- 目录列表请求不能复用 commandId；客户端导航时保留上一次成功列表，但只能接收最新 commandId 的结果。浏览位置不能提前取得项目 handle、创建 `.piweb` 或触发项目资源加载。
- 多连接配置同步依赖所有修改都经过 `PiRuntime.updateConfiguration()`。
- 不要直接开放 `AgentSession.reload()`；其全局 provider reset 绕过工作台所有权边界。需要 reload 时先设计 runtime 协调入口。
- extension `confirm` 只是扩展业务交互，不会改变 run 启动时冻结的 conversation 角色权限；经过 Pi 工具入口的副作用仍必须经过工作台 tool gate。
- Pi 1 的轮次接点是 Agent 实例可访问的 `finishTurn`，不再依赖已移除的 `shouldStopAfterTurn` 或私有 `createLoopConfig`；`agent-turn-boundary.ts` 只桥接该 hook 与 `hasQueuedMessages`。上游 decision、error/abort 不能被宿主覆盖，checkpoint pause 只遮蔽队列观察、不清空 steer/follow-up/custom 队列；actor 取得控制权后释放暂停、压缩并续跑。默认 compaction 仍依赖 1.0.0 私有五参数 `_runDefaultCompaction`，版本/shape 不符时 session 创建必须 fail closed；custom compaction 不经过 resolver。Pi 相关依赖必须精确锁定已验证版本；升级若移除这些形状，不能静默退化成在运行中直接 `compact()`、abort 工具或跳过轮次内压缩。
- trust decision 不能写入项目 `.piweb`；否则恶意仓库可以随自身内容一起声明自己可信。
- 项目扩展当前在服务进程内运行；无法安全强杀一个不返回的同步/异步 hook。只允许可信扩展，worker/子进程隔离是开放超时与动态 provider 的前置条件。
- writer lease 目前只覆盖同一服务进程；两个进程同时写同一 JSONL 仍不安全。
- Pi 的 `listAll()` 会静默跳过部分坏 JSONL，也可能为合法 JSON 中的非有限数值生成无效日期，或接受缺少 tree 字段的 entry。项目索引必须由宿主验证目录内全部常规 JSONL 的 JSON-safe 数值、当前 entry payload/tree，并要求磁盘全集与 SDK 索引按路径/identity 精确覆盖。只验证目标对话仍会让 `recent` 静默回退到另一条或新建。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-custom-providers.md](kb-custom-providers.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
