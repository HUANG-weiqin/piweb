# wait_for_session 检查点设计

日期：2026-08-21（按当前 target-only 等待实现更新）

## 目标

`wait_for_session` 在等待期间没有 provider 请求。为避免无限静默等待，来源 actor 的一个 open local attempt 在四分钟后可返回：

```json
{ "outcome": "checkpoint" }
```

这不是目标完成，也不代表已观察到消息；Agent 若仍依赖结果，使用同一组 target 再次等待。

## 约束

- 不创建第二个 run，不伪造 peer 消息、settlement 或 durable 工作。
- 不无限心跳，也不自动重试。
- wait 只接受调用时冻结的 1–32 个 target；任一 target 的 durable settlement、实际投递的 peer/inbox 消息、SDK 已接受的 guidance、abort、fatal 或 close 都与 timer 竞争同一个 source-local attempt。
- timer 不写 JSONL，也没有持久化 checkpoint 计数或恢复路径。

## 线性化与清理

1. coordinator 在 source actor 上安装一个 opaque local attempt，并完成即时 settlement、已 claim 消息和已接受 guidance 的补查。
2. open attempt 安装已 `unref` 的四分钟 timer。
3. timer 到期后进入 project lifecycle，复核 opaque attempt identity、source run ownership、当前 attempt 状态、target settlement 与 reachability。
4. 复核仍成立时，timer 以 terminal CAS 结算 attempt 并返回 checkpoint。
5. settlement、message、guidance、abort、fatal、close、delivery reservation 或其它 terminal cause 先赢时，统一清理 timer；迟到 timer 为 no-op。

checkpoint 不修改 inbox receipt、message delivery marker、guidance observation、target settlement 或 sender card。它只结束当前 source-local wait；下一次模型调用仍会根据权威状态决定是否再次等待。

## 验证

- 静默 wait 到期返回 checkpoint，目标仍运行。
- settlement、message、guidance、abort、fatal 或 close 先赢时 timer 被清理。
- checkpoint 后再次等待仍使用 target-only 输入，并由新的 local attempt 重新核对权威状态。
