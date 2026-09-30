# Bash 前台长阻塞与后台任务完成唤醒

日期：2026-09-30

取代 [`2026-09-30-run-scoped-bash-execution.md`](2026-09-30-run-scoped-bash-execution.md) 中的 Agent API、yield 句柄与"V1 不做自动完成唤醒"部分；该文档里的输出上限、共享额度、`cleanup_unknown`、有界清理和迟到 callback 隔离仍然有效，除非本文明确改写。

## 问题

当前 `bash` 默认短等 1 秒后返回 `executionId`，`bash_poll` 最多等待 5 秒，run 结束时 actor 以 `run_end` 关闭并杀掉本 run 全部执行。Agent 因此既不能结束回合等待通知，也不能一次等久，只能每 5 秒调用一次模型轮询；每次轮询都重发完整上下文，一个 5 分钟构建至少 60 次模型调用。宿主在执行完成时只刷新 UI 状态条，不通知 Agent。

Codex unified exec 采用同样的轮询模型，已有公开 issue 记录相同的 token 浪费（openai/codex#13733、#38495），其社区修复提案（#32188 `on_exit: "wake"`）与 Claude Code 现行方案一致：前台长阻塞，显式后台任务结束时由宿主推送有界通知并唤醒 Agent。本设计对齐 Claude Code。

## 目标与边界

- 常见构建/测试一次前台调用拿到结果，不产生轮询。
- 显式后台任务可跨 Agent 回合运行；完成时宿主推送一次有界通知，Agent 空闲时自动唤醒，不需要轮询。
- 不做 PTY、stdin、持久 shell、跨进程重启的任务注册表或恢复；reload/dispose/进程退出终止后台任务。
- 不改变 `activeRun` 唯一真相、prompt 准入、steering、inbox 优先级和 writer lease 契约。
- finished 不等于成功：仍只有明确 `exitCode=0` 且结果正常生成才证明成功。

## Agent API（对齐 Claude Code 的参数形态）

工具名保持 Pi 风格小写 snake_case。schema 继续使用平坦 TypeBox object，不引入 anyOf/oneOf，不接受 cwd、PID、role。

### `bash({command, timeout?, run_in_background?})`

- `timeout`：**毫秒**，整数，上限 600000；前台默认 120000，后台未显式给出时不设期限（对齐 Claude Code，只由 `bash_stop`、reload 或 dispose 终止）。包装层换算为秒交给 Pi 原生 bash 的 timeout 语义（超时终止并报错）。这是对当前"秒、无默认"语义的有意变更，需同步工具描述与测试。
- 前台（默认）：阻塞到命令结束或超时，直接返回 Pi 原生结果/错误；不发布句柄、不返回 id。
- `run_in_background: true`：准入后立即返回 `task_id`（独立 UUID，不是 PID/toolCallId/runId）和"完成时会收到通知，不要轮询"的说明；不等待。
- 删除 `yieldMs`。

### `bash_output({task_id?, block?, timeout?})`

- 有 `task_id`：`block` 默认 true，`timeout` 毫秒默认 30000、上限 600000。已完成则返回最终结果（沿用现有 `settledResult` 的失败/partial/未知退出码判定）；未完成且超时返回非消费快照（沿用 1 KiB 预览）。`block:false` 立即返回快照。
- 无 `task_id`：立即列出本会话后台任务的有界摘要（`block`/`timeout` 必须省略或为非阻塞），供压缩后找回 id。
- 只接受本会话 registry 中存在的 id；旧/foreign/重启前 id fail closed。
- 读取不消费输出、不改变 ownership。返回最终结果时把该任务标记为 **已观测**（见"通知去重"）。

### `bash_stop({task_id})`

幂等停止请求，固定有界短等待（沿用约 1 秒）；已完成返回原结果，未证明终结返回 stopping，不覆盖已完成结果。

### 删除与改名

- 删除 `bash_poll`，由 `bash_output` 取代；`bash_stop` 参数由 `executionId` 改为 `task_id`。
- 同步 `src/server/tool-policy.ts` 只读白名单（`bash_poll` → `bash_output`）及其中文 reason、`src/client/components/ToolCard.tsx` 的工具卡片分支、AGENTS.md 与知识页中的工具名单。
- 工具描述明确写出：前台可阻塞最长 10 分钟；长时间运行、需要并行或不想阻塞等待的命令用 `run_in_background`（后台默认不设 timeout）；后台任务完成时会自动收到通知，**不要轮询**；需要结果时用一次阻塞的 `bash_output`。

## 归属模型

### 前台执行

归当前 tool call 与 exact run ownership，行为与现状一致：abort/terminal/reload/dispose 通过现有有界 close 停止，清理先于 run settlement，`cleanup_unknown` 语义不变。工具 gate 仍 sequential，前台执行天然串行。

### 后台任务

- 归 **ConversationActor**（会话级），不归 run，也不归某个 AgentSession runtime。当前 binding 在 `PiRuntime` 每次创建 session 时构建（`src/server/pi-runtime.ts` 约 1301 行），角色切换、回滚、reopen 会重建 runtime；因此后台任务 registry 必须上移到 actor 生命周期，runtime 创建的工具只持有对该 registry 的引用，runtime 重建不得停止后台任务。
- 准入时按当时冻结角色的权限与命令审查（read_only 的受审查 bash 同样允许 `run_in_background`）；之后角色切换不影响已在跑的任务。
- **run 正常结束不停止后台任务**。
- **abort 不停止后台任务**（对齐 Claude Code 的 Esc）：abort 只停止当前 run 的前台执行。用户可通过 `bash_stop` 指示 Agent 或后续 UI 停止；本期 UI 不新增停止按钮。
- reload、actor dispose、进程退出终止全部后台任务（现有有界 close，reason `reload`/`dispose`）。
- 额度：每会话最多 4 个未终结后台任务；前台 + 后台共用 PiRuntime 共享 32 个受管未终结执行（`BashExecutionBudget`）。每会话已发布后台 task 记录上限 64；已终结且已观测/已通知的记录可按 FIFO 释放，未通知的完成记录不得静默丢弃，满前拒绝新后台 start。
- 16 MiB 原始输出 cap、partial 判定、Pi 截断与 fullOutputPath 沿用。
- `cleanup_unknown`：后台任务 close 未确认终结时，沿用"占用额度、阻止自动 inbox/唤醒、默认 reload 失败、只有显式 force 可越过"的现有语义，范围从 run 改为会话。

## 完成通知

### 内容

新的保留 custom type `piweb.bash_task_notification.v1`，作为 **进入模型上下文** 的 custom message 持久化（append-only，保持 provider 前缀稳定）。`content` 是给模型的文本，`details` 严格 schema：

- `taskId`、`command`（UTF-8 截断至 256 bytes）、`status: completed | failed | killed`、`exitCode: number | null`、`durationMs`、`stopReason?`、`partial?`、`outputFile?`；
- 文本附不超过 1 KiB 的尾部输出与"完整结果请调用 `bash_output({task_id})`"提示；
- 多个任务合并为一条消息时 `details.tasks` 为数组（上限 4）。

`status` 判定：`exitCode === 0` 且非 partial 为 completed；被 stop/timeout/output_limit/reload/dispose 终止为 killed；其它（非零、null、执行错误）为 failed。文本必须重申"finished 不等于成功"。

在 `src/server/conversation-meta.ts` 注册严格 reserved parser 与 create 函数，`conversation-history.ts` 投影为新的 history item（例如 `bash_task_notification`），浏览器渲染为轻量卡片说明 Agent 被唤醒的原因。旧 `piweb.bash_execution_notice.v1` 只读兼容解析保持不变。

### 送达路径

actor 持有内存中的待送达通知队列（会话级，随 actor 生命周期，不落盘）。任务终结时入队，按当时状态选择一条路径：

1. **有 active run 且 `session.isStreaming`**：复用 `ticket.customSteerDeliveries` + `flushCustomSteers`，以 `deliverAs:"steer"` 在当前工具调用全部结束后、下一次模型调用前注入。这属于"实际投递到当前 run 的消息"，必须按现有规则结束 `wait_for_session`（结果只返回来源 metadata，正文仍只由该 custom message 注入一次）。
2. **run 处于回合末尾、尚未结算**（`execute()` 已返回，`executeRun` 的续跑循环中）：在 LoopList continuation 检查之前增加分支，若队列非空则 `sendCustomMessage(notification, {triggerTurn:true})` 在同一 runId 内续跑。此分支不计入 LoopList 续跑次数。这保证"完成恰好落在 Agent 回答边界"时不丢。
3. **会话空闲**：actor 向 coordinator 发出唤醒请求；coordinator 在同一 project lifecycle 内调度，**排在该会话已有 inbox 工作之后**，满足 `assertRunStartAllowed`、非 `cleanup_unknown`、actor idle 时调用新的 `actor.startBashNotifications({runId})`，新增 run origin `"bash_task"`（扩展 `ConversationRunOrigin`）。该方法在 actor 串行队列内取空队列即返回 `not_started`，否则把队列中全部通知作为 custom message 送入并 `triggerTurn`。`bash_task` run 不 rearm LoopList、不生成自动标题、不产生 raw user message；其余结算与普通 run 相同。
4. **空闲时浏览器 prompt 抢先启动**：`startPrompt` 在调用 `session.prompt` 前先把队列中的通知以 `triggerTurn:false` 送入，再发送用户 prompt；coordinator 随后的唤醒因队列为空而 `not_started`。inbox run 同理，在 `startMessages` 的消息前送入。

多个任务接近同时完成时合并为一次送达；唤醒次数由 Agent 自己启动的后台任务数自然限定，不另设唤醒上限。

### 通知去重

- `bash_output` 或 `bash_stop` 已把最终结果返回给 Agent 时，任务标记为已观测：若其通知仍在 actor 内存队列、尚未交给 SDK，则移出不再发送。
- 任务终结时若有 `bash_output`/`bash_stop` 正在等待它，registry 暂扣完成回调：等待调用返回最终结果即视为已观测、不再通知；只有全部等待都结束且未观测时才补发。否则 streaming 时通知会在同一同步调用栈内交给 SDK，早于等待调用返回，最常见的"后台启动、需要时阻塞读取"模式将每次都重复送达。
- 通知一旦交给 SDK（steer 已被接受或已 `sendCustomMessage`），不撤回；此时与 `bash_output` 结果重复可接受，内容一致且都不声称成功以外的事实。
- 同一任务最多入队一次。

### reload / dispose 终止后台任务

reload 或 dispose 终止后台任务时，在仍持有健康 writer 的前提下追加一条 `status: killed`、`stopReason: reload|dispose` 的通知 entry，**不触发 run**。这样 reload continuation 或下一次用户 run 能看到任务已不存在，Agent 不会等待永远不会到来的唤醒。writer 不健康或写入失败只报告错误，不阻塞退出。进程崩溃/force 不保证该记录。重启后不自动开跑，旧 `task_id` 在 `bash_output` 中 fail closed。

## 前台命令期间的用户插话（自动转后台）

前台最长可阻塞 10 分钟，而 piweb 允许用户随时 steer。对齐 Claude Code 的 ctrl+b：当前台 bash 正在等待时，若当前 run 接受了用户 guidance（`admitSteerPrompt` 成功、显式 `steer`）或 custom steer 投递（peer/inbox），宿主把该前台执行 **转为后台任务**：

- 执行记录从 run scope 迁入会话后台 registry（受后台 4 个额度约束；额度不足则不迁移，前台继续阻塞，steer 仍在工具结束后注入）；
- 前台工具调用立即返回 `task_id` 与"已因新消息转入后台，完成时会收到通知"的说明；
- 此后该任务完全按后台任务处理，包括完成通知。

挂钩点与现有 `fireWaitingSteerInterrupt(ticket)` 相同，统一由一个"当前 run 收到新投递"事件驱动 `wait_for_session` 结束与前台转后台，避免两套判定。

## Reload 行为

- 默认安全 reload 仍等待完整 assistant turn（含前台 bash，至多其 timeout）到达安全边界。
- 后台任务不阻塞安全 reload；reload 以 `reload` reason 有界关闭，然后写入 killed 通知（见上）。
- `cleanup_unknown` 阻止默认 reload 的现有规则不变。

## 协议与 UI

- `ConversationBashActivity` 去掉 `runId`，改为会话级 `{running, stopping, cleanupUnknown}`（前台 + 后台合计，计数上限随额度调整）；会话空闲时也可非 null。focused snapshot 与精确 `sessionId + conversationId + focusId` 关联的低频 `bash_activity` 事件继续投影它；stdout 不触发事件。
- 新增 `bash_task_notification` history item 与轻量卡片。
- `PROTOCOL_VERSION` 从 64 升到 65；同步 validator、reserved registry、snapshot/window/peek 的 exhaustive 消费点。
- 不新增浏览器命令、PublicState/sidebar 任务表或单任务实时事件。

## 实现归属

- `src/server/bash-execution.ts`：拆分前台执行与会话级后台 registry；新工具 schema（毫秒 timeout、`run_in_background`、`bash_output`、`bash_stop({task_id})`）；终结回调向 actor 报告 `{taskId, summary}` 以入队通知；前台转后台的迁移原语；删除 yield/发布句柄逻辑。
- `src/server/pi-runtime.ts`：工具工厂改为引用 actor 提供的后台 registry 与 owner 访问器；runtime dispose 只清理前台执行，不停止后台任务。
- `src/server/conversation-actor.ts`：持有后台 registry 与通知队列；四条送达路径；统一的"run 收到新投递"事件（`wait_for_session` 与前台转后台）；reload/dispose 的 killed 通知；`ConversationRunOrigin` 增加 `"bash_task"`；`startBashNotifications`。
- `src/server/project-session-coordinator.ts`：接收唤醒请求并按 inbox 之后的顺序调度；复核 ownership 与 lifecycle。
- `src/server/conversation-meta.ts` / `conversation-history.ts`：新 reserved entry 的严格 parser、create 与 history 投影。
- `src/shared/protocol.ts`、`src/client/**`：activity 形状、新 history item、卡片、ToolCard 工具名。
- `src/server/tool-policy.ts`：只读白名单与 reason。
- AGENTS.md「Actor-owned `bash/bash_poll/bash_stop`」一条与「`read_only` 的有效工具集」一条需改写；同步 `kb-server-runtime.md`、`kb-agent-collaboration.md`、`kb-tool-policy.md`、`kb-wire-protocol.md`、`kb-client-state.md`、`kb-project-sessions.md` 中相关事实。

工作树当前有未提交改动（移除旧 run 收尾摘要写入、协议 v64 相关调整），实施时在其基础上进行，不要回退。

## 实施顺序

1. **提交一：前台与新 API**。毫秒 timeout 与默认 120000、`run_in_background` 准入、`bash_output`/`bash_stop({task_id})`、删除 `bash_poll`/yield、工具描述、tool-policy、ToolCard。此阶段后台任务仍可暂按 run 归属并在 run 结束时停止（过渡），但工具描述不得承诺通知。
2. **提交二：会话级后台 registry 与完成唤醒**。归属上移、通知 entry、四条送达路径、去重、coordinator 调度、reload/dispose killed 通知、协议 v65 与 UI。
3. **提交三：前台自动转后台**（依赖提交二）。

## 验收

先写最小反例测试，再实现：

- 前台：超过默认 120000 ms 被终止；`timeout` 超出 600000 或非整数被拒绝；毫秒到秒换算正确；前台结束直接返回原生结果。
- 后台：run 正常结束与 abort 后任务继续运行；runtime 重建（角色切换、回滚）后任务与 `bash_output` 仍可用；foreign/旧 id fail closed；额度满拒绝新 start；未通知的完成记录不被释放。
- 送达：完成落在工具执行中（steer）、落在回答边界（同 run 续跑）、落在空闲（coordinator 新 run）、空闲时浏览器 prompt 抢先、inbox 抢先，各路径恰好送达一次；`wait_for_session` 被通知结束；多个同时完成合并；`bash_output` 先返回结果后队列中通知被撤销；已交 SDK 的通知不撤回。
- 调度：唤醒不越过已有 inbox 工作；`cleanup_unknown` 阻止唤醒；重启后无自动 run、旧 id 失效。
- reload/dispose：后台任务被终止并写入不触发 run 的 killed 通知；writer 不健康时不阻塞退出；reload continuation 能看到该通知。
- 转后台：前台等待中用户 steer 被接受后工具立即返回 `task_id`，steer 在下一次模型调用前送达；额度不足时不迁移。
- 协议/UI：v65 validator、会话级 activity 在空闲时投影、通知卡片渲染、旧 v1 notice 仍只读兼容。

完成门槛：`npm test`、`npm run test:slow`（涉及 coordinator 与 actor 生命周期）、`npm run typecheck`、`npm run build`、`git diff --check`；并在真实浏览器走一遍：前台长命令、后台命令后 Agent 结束回合并被自动唤醒、前台期间插话转后台、安全 reload 终止后台任务。
