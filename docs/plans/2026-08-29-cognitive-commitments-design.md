# 认知承诺：编辑额度

日期：2026-08-29（等待承诺部分已移除）

## 1. 目标

让 Agent 在首次修改新文件前，把预计涉及的文件数量和理由外化成用户可见、宿主可核对的声明。

这不是审批、安全凭证或隐藏思维链。Agent 只提交简短计划；宿主只核对可观察的额度与路径事实。

## 2. 设计原则

- 声明绑定首次修改新文件的行为边界。
- 声明与事实分开：Agent 声明数量和理由，宿主维护实际额度、已触及文件和剩余额度。
- run 状态仍由 `ConversationActor.activeRun` 持有；工具历史仍由 Pi JSONL 和 `ConversationHistoryTool` 投影。
- 不新增 Commitment 实体、触发 DSL、分类模型或通用工作流引擎。
- 编辑额度只覆盖 `source=builtin` 的 `edit`/`write`；`bash`、脚本和扩展工具仍可能写文件，`full_access` 也不是 OS sandbox。

## 3. 工具契约

`request_edit_budget`：

```ts
{
  fileCount: integer; // 1..100
  reason: string;     // trim 后 1..2000 字符
}
```

- 在每个 run 首次调用内置 `edit`/`write` 前申请。
- `fileCount` 是预计首次成功修改的不同文件数量，不是 edit 调用次数。
- 范围变化时再次申请新的总数并说明原因；新值覆盖旧值，且包含本 run 已修改文件。
- 不要用 `bash` 绕过；该机制不是完整文件写保护。

成功结果：

```ts
{
  outcome: "edit_budget_granted";
  grantedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}
```

多次申请覆盖本 run 的总额度，不做加法；已修改 canonical path 仍计入新总数。工具仅在 `full_access` 会话可见；不加入 read-only SDK allowlist。

## 4. 编辑额度状态机

ledger 直接放在 `RunTicket`：

```ts
interface EditBudgetLedger {
  grantedFiles: number;
  touchedPathKeys: Set<string>;
  blockedAttempts: number;
}
```

- `startRun()` 创建空 ledger。
- 自动重试、queued continuation 和 host compaction 使用同一个 ticket，因此共享额度。
- run settle、abort 或 fatal 后 ticket 被清除，额度自然消失。
- 重启不会恢复正在运行的 run，因此不需要 durable ledger。

预算计数使用与 Pi 内置 edit/write 解析一致的 canonical path key。相对路径按 canonical project cwd 解析；存在的目标以 `realpath` 合并 symlink；Windows 使用不区分大小写的 key。这是计数身份，不是 workspace 边界校验。

准入只匹配 `toolSource === "builtin" && (toolName === "edit" || toolName === "write")`：

- 路径已在 `touchedPathKeys`：允许，不再消耗。
- 未触及且仍有额度：允许。
- 否则增加 `blockedAttempts` 并拒绝，真实工具不执行。

只有原始 builtin execute 以 `isError=false` 完成时，新路径才加入 touched set。失败调用不消耗；同文件后续成功调用不重复消耗。

成功 edit/write 的 details 加入：

```ts
piwebEditBudget: {
  countedNewFile: boolean;
  grantedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}
```

ledger 不依赖该 UI metadata。

## 5. Runtime 与 UI

`PiRuntime` 在现有 `ToolCallGate` 的对称位置调用内部 `toolCallCompleted` callback；它收到最终 transformed args、工具 source、原始 execute 的 `isError` 与 result，并可返回 details patch。该 callback run-identity guarded，旧 run 的完成不能修改新 ticket；工具仍顺序执行。

`CommitmentCard` 只由 `request_edit_budget` 的现有 `ToolItem` 派生，不新增 reducer、协议或持久 Commitment 真相。卡片常显，原始 args/result 仍可展开；重连由 JSONL toolCall/toolResult 恢复。编辑卡显示该次覆盖后的总额度，以及按同一 run 可见预算/写工具结果顺序派生的最新剩余额度。若终态 mutation 看不到 ledger，客户端显示“本轮剩余未知”。

## 6. 最小验证

1. 无额度拒绝；失败不消耗；同 canonical path 去重；新 path 消耗；覆盖后的总额度决定后续准入。
2. extension 变换后的 args 先进入 host gate，成功结果触发 completion callback，仍为 sequential。
3. request result 和 edit/write ledger facts 经 JSONL 恢复。
4. 编辑额度卡常显、原始详情可展开；普通工具仍折叠。

完成门槛：`npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。
