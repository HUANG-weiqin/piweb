# wait_for_session 缓存检查点设计

`date: 2026-08-21`

## 问题

`wait_for_session` 当前把来源 Agent 的工具调用一直保持 pending。等待期间没有 provider 请求；即使 `ConversationActor`、WebSocket 和稳定 sessionId 都仍然存在，也不会刷新 provider 持有的 prompt/KV cache。目标运行时间超过 provider 的短缓存 TTL 后，来源下一轮可能重新支付完整上下文输入成本。

现有上下文本身已经适合前缀缓存：会话消息 append-only，角色和工具 schema 在 run 内冻结，状态卡片、settlement 与 metadata custom entry 不进入模型上下文。因此不重写消息模型，只处理静默时间。

## 原则

远端缓存只有三类有效杠杆：延长 provider retention、在 TTL 前发出真实请求、或缩小以后要读取的上下文。本阶段只实现第二类，并满足：

- 不在 `AgentSession` 外发隐藏模型请求；
- 不伪造 peer 消息、settlement 或 durable 工作；
- 不创建第二个 run；
- 不无限心跳；
- settlement、消息、guidance、abort 和 close 继续与 checkpoint 竞争同一个 exact waiter；
- 缓存收益不能证明时 fail closed。

## 行为

静默 wait 满足成本条件时，四分钟后返回：

```json
{ "outcome": "checkpoint" }
```

这只是“尚未观察到目标结果”的非错误结果。Pi 正常结束当前工具调用并进入下一次模型请求；如果目标结果仍是当前工作的依赖，Agent 使用相同 `conversationId + runId` 再次等待。

每个来源 run 最多成功产生八个 checkpoint。它们是 run-local 易失控制状态，不进入 JSONL；进程重启不会尝试恢复旧的 provider cache 租约。

## 成本门槛

只有同时满足以下条件才安装 timer：

- `getContextUsage().tokens >= 32_000`，unknown/null 不启用；
- 当前 AgentSession 的实际模型提供有限正数 input/cache-read 定价；
- cache read 明显便宜，使八个 checkpoint 加最终一次 cached read 的输入价仍低于一次 uncached read：

```text
(maxCheckpoints + 1) * cacheReadRate < inputRate
```

- 当前 exact run 尚未禁用 checkpoint 且未用完八次额度。

checkpoint 后下一条 assistant usage 是实际反馈。以：

```text
cacheRead / (input + cacheRead + cacheWrite)
```

计算命中比例；usage 缺失、非法、分母为零或命中低于 50% 时，本 run 不再产生 checkpoint。该反馈只用于控制后续开销，不作为 durable 完成真相。

## 线性化与清理

Timer 属于一个具体 `SessionWaiter`：

1. waiter 已进入 `context.waiters`，并完成 registration-time settlement、committed message、claimed inbox 与 guidance 补查；
2. waiter 仍存在时才安装 timer；
3. timer 到期后进入 project lifecycle queue；
4. 在任何状态修改前，以 key + waiter object identity 复查 membership；
5. 赢得竞争后由来源 actor 复核 exact ownership、`phase=waiting` 和 run-local 额度，再移除 waiter、统一 detach 并返回 checkpoint。

所有已有结算路径继续删除同一个 waiter。`detachWaiter` 同时清除 AbortSignal listener 和 timer，因此 settlement/message/guidance/abort/fatal/close 先赢时，迟到 timer 只能 no-op。

Checkpoint 不修改 inbox `waitedByRunId`、guidance `waited`、temporary receipt、target settlement 或 sender card。timer 与直接 guidance callback 即使不共用 lifecycle queue，也只通过同一 waiter identity 竞争；timer 不触碰 guidance FIFO，stale callback 仍返回 false，保留未观察 guidance 给下一次模型调用。

## 可接受的语义变化

Checkpoint 会短暂结束 wait graph 中的边并让来源进入模型轮次。此时目标可能建立反向 wait；来源若随后重新等待，会由现有 cycle check 按新的真实图拒绝。工作台不保留“幽灵等待边”来强迫旧优先级。

Agent 也可以在 checkpoint 后选择不再等待。这是刻意保留的控制权，不把缓存优化伪装成目标完成。

## 非目标

- 不自动设置 `cacheRetention: "long"`；不同 provider 的 retention 与写入价格不同，后续单独设计。
- 不做无限 periodic keepalive。
- 不做 AgentSession 外的 cache warming。
- 不因等待主动 compact；摘要请求本身也会读取上下文，并有信息损失。
- 不新增浏览器协议或持久配置。

## 验证

最小反例测试覆盖：

- eligible 静默 wait 到期返回 checkpoint，目标仍运行；
- 小/未知上下文和不经济定价不触发；
- settlement、guidance、abort、close 先赢时 timer 被清理；
- 同一来源 run 最多八个 checkpoint；
- checkpoint 后实际 cache hit 允许剩余额度，miss/unknown usage 禁用；
- 现有 FIFO predecessor、temporary receipt、cycle、durable settlement 与 guidance one-shot 测试不回归。
