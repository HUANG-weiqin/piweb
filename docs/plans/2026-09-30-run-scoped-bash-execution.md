# 逻辑 run 范围的 Bash 自动让出执行

日期：2026-09-30

后续设计 [`2026-09-30-background-bash-wake.md`](2026-09-30-background-bash-wake.md) 取代本文的 Agent API、yield 句柄和不自动唤醒的决定；其余资源上限、输出与未知清理约束继续作为边界。

## 目标与边界

长时间搜索、测试和构建不能把 Agent 永久卡在一次 Bash 工具等待中。工具准入继续 sequential；命令启动后短等并返回独立执行句柄，使多个有限长命令能同时执行。V1 不提供 PTY、stdin、持久 shell、跨最终响应的开发服务器、自动完成唤醒或重启恢复进程。

等待结束、执行结束、停止请求和成功结果是不同事实。工作台只保证其受管执行器的生命周期，不承诺主动 daemon/disown、逃逸子孙进程或强制退出的副作用 exactly-once。可信扩展阻塞和 OS 隔离保持现有边界。

## 最小权威模型

只有 BashExecution：独立 UUID executionId，归属当前 ConversationActor 的 exact ConversationRunOwnership 对象。ID 不是 PID、toolCallId、conversationId 或 runId，也不按命令正文去重。

每个执行持有独立 AbortController、实际执行 promise、最新 Pi 有界输出快照、可选 stopRequest 和可选 settledResult。公共状态由这两个事实推导：有结果为 finished；无结果但已请求停止为 stopping；其余为 in_progress。finished 不表示成功；只有明确 exitCode=0 且结果正常生成才可证明成功，null/未知/保存失败不能通过。

SDK 物理 run signal 只取消当前工具等待，不作为后台执行控制器。Actor abort/terminal/reload/dispose 才请求停止执行。登记 owner 和资源额度在调用原生执行器之前；异步失败必须立即被 owner 接住，不能在 yield 后产生 unhandled rejection。普通工具返回、SDK agent_end、压缩和 LoopList 续跑都不结束逻辑 ownership。

## Agent API

- bash({command, timeout?, yieldMs?})：timeout 沿用秒单位和终止语义，无默认；yieldMs 是等待预算，默认 1000，整数 0–5000。快速结束返回原 Pi 结果/错误；未结束返回 executionId、in_progress/stopping、最多 1 KiB 的短预览和明确未结束说明。一次调用只启动一次。
- bash_poll({executionId?, waitMs?})：有 ID 默认短等 1000ms，上限 5000ms，读取非破坏快照或最终结果；无 ID 立即列出当前逻辑 run 的有界执行摘要，waitMs 必须为 0 或省略，供压缩后找回句柄。旧/foreign ID fail closed。
- bash_stop({executionId})：幂等停止请求，固定有界短等待；已完成则返回原结果，未证明完成则 stopping，不覆盖已完成结果。

schema 使用平坦 TypeBox object，不引入 anyOf/oneOf。参数不接受 cwd、PID 或 role。权限 gate 仍在项目 tool_call hook 和最终参数冻结之后；read_only 的命令审查、spawn 环境净化和来源校验保留。poll/stop 仅 source=sdk 且管理本 scope 已准入执行；同步更新只读白名单。

## 输出与资源

复用公开 createBashToolDefinition/createLocalBashOperations、Pi 的 UTF-8/截断/fullOutputPath 和节流 onUpdate。不建第二 collector、日志目录或持久执行索引；捕获最后一份防御复制后的 payload。未来查询生成新 tool result，持久旧结果不改；yield 后绝不继续调用原调用方 onUpdate。查询无消费 cursor/ACK。

最终输出沿用 50 KiB/2000 行展示与临时全文路径；未结束的查询仅附最多 1 KiB 短预览。stdout+stderr 原始捕获超过 16 MiB 请求停止并标记 partial，此后不再向 Pi accumulator 提交数据；截断结果不能证明查询完整或测试通过。临时文件保留沿用 Pi，不承诺整个 OS temp 目录恒定大小。

初始常量：每 run 4 个活跃执行、PiRuntime 共享 32 个受管未终结执行、每 run 64 个已发布句柄记录。快速结束且未发布句柄的内部记录可释放；未读结果不静默 LRU，满前拒绝新 start。工具已返回或 owner 放弃均不释放真实执行额度，只有受管执行器终结才释放。资源额度是受管执行，不是任意 OS 子孙 PID 计数。

## 生命周期与清理

Actor 普通 terminal、abort、safe reload（包括 preserveSettlement=true 路径）和 runtime dispose 汇入幂等 close：同步关闭新 launch admission、请求停止、给整组执行最多约 2 秒清理宽限。停止请求与完成竞争以已观测最终结果为准；poll 取消不消费结果。

未确认终结时执行仍为 stopping，Actor 以 fatal/cleanup_unknown 瞬时状态阻止自动执行；默认 reload 失败而不是偷偷 force。旧执行继续占共享额度，旧 closed owner 的未终结资源使同 conversation 新 Bash fail closed，迟到 callback 只清理旧资源，不写 transcript/新 run。显式 force/crash 保持 best-effort；旧句柄不可恢复，不自动重启历史命令。

## 收尾清理与 UI

terminal、abort、reload 和 dispose 必须等待 Bash 整组有界清理，再写既有 run settlement；cleanup_unknown 仍将 Actor 标记 fatal 并暂停自动工作。清理 callback 不写 transcript。新逻辑 run 收尾不追加 custom_message 或额外 assistant/tool result 摘要；工具原始返回仍是命令状态的唯一新增历史内容，不能把工具返回成功显示成命令通过。

旧 JSONL 中可能已有 `piweb.bash_execution_notice.v1`。服务端保留严格 reserved parser 仅为使这些旧会话仍可读取；读路径不重写该物理记录，也不投影到浏览器 history/wire，新的执行绝不追加它。重启后无 live registry，旧句柄不提供存活能力或恢复授权。

瞬时浏览器状态仅为 ConversationBashActivity={runId,running,stopping,cleanupUnknown}。focused snapshot 与精确 focus 关联的低频事件投影它；工具卡片注明“返回时执行尚未结束/请求停止”，不能把工具返回成功显示成命令通过。

用户补充要求：本会话仍有后台命令时应在 UI 告知，先做简单表现。只在输入区上方加轻量状态条，显示执行/停止数量及 cleanup_unknown 警示，不展开任务列表或控制面板。新增瞬态 ConversationBashActivity={runId,running,stopping,cleanupUnknown}，各计数及合计不超过 4；focused snapshot 的 nullable bashActivity 和精确 sessionId+conversationId+focusId 关联的低频 bash_activity 事件投影它。启动、停止、实际终结及清理超时才通知；stdout 不触发事件。恢复时从当前 actor hydrate，冷进程没有执行 registry，因此 null 不证明历史命令的 OS 子孙已消失。迟到通知必须校验同 runtime generation 与 exact owner（包括保留的未知清理 owner），不得覆盖新 run。协议 v64 不再接受/发送持久收尾摘要 item。

不新增浏览器命令、PublicState/sidebar job 表或单个 job 实时事件系统。同步 PROTOCOL_VERSION、validator、reserved registry、snapshot/window/peek 的 exhaustive 消费点和薄 UI。

## 实现归属与内部 seam

- 新 src/server/bash-execution.ts 与测试：一个窄 controller、共享额度和三个工具。owner 为结构类型 {conversationId, runId}，授权使用对象 identity。
- PiRuntime：解析有效 shellPath/full_access commandPrefix；以 createBaseTool(operations) factory 复用 Pi 或受审查 Bash，注入 shared budget、conversationKey 和 getOwner；CreatedPiSession 暴露 bashExecutions lifecycle，失败和 dispose 均覆盖清理。
- ConversationActor：传 exact owner、控制 abort/terminal/reload/基础设施失败；等待清理后写 settlement，不追加持久收尾摘要；不在物理 agent_end 清理。
- conversation-meta/history/shared protocol/client：只保留旧摘要格式的只读兼容解析；新协议不定义摘要 item，旧摘要不再投影；不拥有进程或调度。

Controller seam：createBashExecutionBinding({getOwner, conversationKey, budget, operations, createBaseTool, onChange?}) 返回 {tools, lifecycle}。lifecycle.requestStop(owner, reason) 同步关闭该 owner 准入；lifecycle.close(owner, reason) 有界返回 {executions, cleanupUnknown}；lifecycle.dispose() 覆盖全部 scope；activity(owner) 只读推导 {running,stopping,cleanupUnknown}，onChange(owner) 不携带输出并隔离 observer 错误。summary 行含 executionId/state、可选 exitCode/stopReason/error/outputFile；reason 为 manual|timeout|output_limit|run_end|abort|reload|dispose。实际类型和源工具结果保持可验证且不使用文本解析猜退出码。

## 验收

先写永不退出短 yield、退出/停止竞态、取消 poll、输出洪泛和特殊 reload 路径的最小反例。再覆盖：同文独立执行、foreign/expired ID、late error、timeout 不因 poll 重置、UTF-8/cap 边界、read_only/source/settings/hook、compaction/LoopList 继续持有、所有终态清理、unknown 不假回收额度、迟到 callback 隔离、历史恢复不授权 live job、工具状态与宿主摘要 UI。

最终集成状态必须通过 npm test、npm run test:slow、npm run typecheck、npm run build、git diff --check，并在真实浏览器窗口走并发执行、查询、停止、UI abort、安全 reload/恢复及瞬时状态条路径；验证不产生新的持久 Bash 收尾摘要。同步长期知识页，保留无关 worktree 变更。
