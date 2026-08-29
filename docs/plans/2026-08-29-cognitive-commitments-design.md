# 认知承诺：编辑额度与单会话等待

日期：2026-08-29

## 1. 目标

让 Agent 在跨越两个高机会成本边界前，把自己的判断外化成用户可见、宿主可核对的承诺：

1. 在首次修改新文件前，声明预计涉及的文件数量和理由。
2. 在只等待一个 Agent、因而放弃继续本地工作或等待多个独立结果前，说明为什么单独等待更合适。

这不是审批、安全凭证或隐藏思维链。Agent 只提交简短的计划/理由；宿主只核对可观察事实，不判断自然语言是否“正确”。

## 2. 设计原则

- **承诺绑定行为边界，不绑定关键词或轮次数。** 修改新文件和真正进入阻塞等待都有明确因果意义。
- **声明与事实分开。** Agent 声明数量和理由；宿主维护实际额度、已触及文件和剩余额度。
- **现有真相优先。** run 状态仍由 `ConversationActor.activeRun` 持有；工具历史仍由 Pi JSONL 和 `ConversationHistoryTool` 投影。
- **无通用框架。** 第一版只实现两个具体机制，不新增 Commitment 实体、触发 DSL、分类模型或通用工作流引擎。
- **可见但不打断。** UI 显示专用承诺卡；不弹确认框，不阻塞用户 steer/abort。
- **不夸大保护范围。** 编辑额度只覆盖 `source=builtin` 的 `edit`/`write`。`bash`、脚本和扩展工具仍可能写文件；`full_access` 也不是 OS sandbox。

## 3. 范围与非目标

### 本次实现

- 新 SDK host tool：`request_edit_budget`。
- 当前 run 内的 distinct-file edit ledger。
- `wait_for_session.singleWaitCommitment`。
- 单目标 wait 在真正阻塞前的 commitment guard。
- 从现有工具 args/result 派生的常显承诺卡。
- 服务端、恢复投影和客户端定向测试。

### 不做

- 不阻止 `bash` 或扩展工具写文件。
- 不让用户逐次批准承诺。
- 不持久化独立承诺记录，不在浏览器维护额度。
- 不在 run 结束时生成“合规评分”。
- 不把子 Agent 的承诺复制到祖先 transcript。
- 不限制多目标 aggregate wait。
- 不按根 Agent/子 Agent 区分规则；所有拥有相应工具的 Agent 使用相同边界。

## 4. 工具契约

### 4.1 `request_edit_budget`

参数：

```ts
{
  fileCount: integer; // 1..100
  reason: string;     // trim 后 1..2000 字符
}
```

描述必须明确：

- 在每个 run 首次调用内置 `edit`/`write` 前申请。
- `fileCount` 是预计首次成功修改的不同文件数量，不是 edit 调用次数。
- 范围扩大时再次申请并说明原因。
- 不要用 `bash` 绕过；该机制不是完整文件写保护。

成功结果：

```ts
{
  outcome: "edit_budget_granted";
  addedFiles: number;
  grantedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}
```

多次申请做加法，不覆盖之前额度。工具仅在 `full_access` 会话可见；不加入 read-only SDK allowlist。

### 4.2 `wait_for_session.singleWaitCommitment`

新增可选字段：

```ts
singleWaitCommitment?: string; // trim 后最多 1000 字符
```

规则：

- 只允许与精确 `conversationId + runId` 一起使用。
- 与 `targets` 同时出现时拒绝，哪怕 `targets` 只有一项。
- 空白值按缺失处理。
- 多目标 wait 保持原语义。
- 已可立即领取的 settlement/message/guidance 不要求承诺。
- 单目标 wait 若在即时检查后仍会阻塞且字段缺失，立即返回，不进入 waiting、不注册 waiter：

```ts
{
  outcome: "single_wait_commitment_required";
  message: "No wait was started. Explain why waiting for only this Agent is better than continuing useful local work or waiting for multiple independent targets, then call wait_for_session again with singleWaitCommitment.";
}
```

该 outcome 与三分钟静默产生的 `{ outcome: "checkpoint" }` 完全不同：前者表示等待从未开始，后者表示等待已经发生但仅返回 checkpoint。

## 5. 编辑额度状态机

### 5.1 所有者和生命周期

ledger 直接放在 `RunTicket`：

```ts
interface EditBudgetLedger {
  grantedFiles: number;
  touchedPathKeys: Set<string>;
  blockedAttempts: number;
}
```

- `startRun()` 创建空 ledger。
- 自动重试、queued continuation 和 host compaction 仍使用同一个 ticket，因此共享额度。
- run settle、abort 或 fatal 后 ticket 被清除，额度自然消失。
- 重启不会恢复正在运行的 run，因此不需要 durable ledger。

### 5.2 路径身份

预算计数使用与 Pi 内置 edit/write 解析一致的目标：

1. 对最终 transformed args 中的 `path` 做 Unicode 空格、`@` 前缀、`~`、file URL 和 Windows shell path 规范化。
2. 相对路径按 canonical project cwd 解析为绝对路径。
3. 若目标已存在，使用 `realpath` 合并 symlink 别名；不存在则保留规范化绝对路径。
4. Windows 上使用不区分大小写的 path key。

这是计数身份，不是 workspace 边界校验。项目外绝对路径仍可能被 full-access 内置工具写入，也同样消耗额度。

### 5.3 准入与消耗

宿主现有顺序保持：

```text
extension tool_call transform
→ stable args snapshot
→ role ToolPolicy
→ edit-budget check
→ builtin execute
→ extension tool_result
→ edit-budget completion accounting
→ tool_execution_end / JSONL
```

准入仅匹配 `toolSource === "builtin" && (toolName === "edit" || toolName === "write")`：

- path 已在 `touchedPathKeys`：允许，不再消耗。
- path 未触及且 `grantedFiles - touchedPathKeys.size > 0`：允许。
- 否则增加 `blockedAttempts` 并返回明确 block reason，真实工具不执行。

只有原始 builtin execute 以 `isError=false` 完成时，才把新 path 加入 touched set。失败调用不消耗；同文件后续成功调用不重复消耗。SDK 在写入后收到 abort 的极窄竞态仍遵循 SDK 的最终工具状态：它会显示失败且本 run 不消耗；abort 随即结束该 ledger。

完成回调给成功 edit/write 的 tool result details 增加 namespaced 事实：

```ts
piwebEditBudget: {
  countedNewFile: boolean;
  grantedFiles: number;
  touchedFiles: number;
  remainingFiles: number;
  blockedAttempts: number;
}
```

只对普通 object/undefined details 做合并，不覆盖项目 extension 返回的非对象 details。ledger 本身不依赖该 UI metadata。

### 5.4 Runtime seam

`PiRuntime` 在现有 `ToolCallGate` 对称位置增加一个内部 `toolCallCompleted` callback。它收到最终 transformed args、工具 source、原始 execute 的 `isError` 和 result，并可返回 details patch。

- callback 安装在现有 extension/tool-result compression hook 之后。
- 即使 extension 的 post-hook 抛错，也按原始 builtin execute 状态更新 ledger；异常仍按 SDK 原语义传播。
- callback 必须 run-identity guarded；旧 run 的完成不能修改新 ticket。
- 继续强制 sequential execution，所以前一 edit 的消耗一定先于后一 edit 的 gate。

## 6. 单会话等待控制流

`singleWaitCommitment` 随 `MetaToolWaitInput` 传到 `ProjectSessionCoordinator`，但不成为持久状态。

精确 wait 的顺序：

1. 校验 source ownership、自等待、abort 和 target identities。
2. 执行现有 temporary receipt、completion cache、active actor、cold JSONL settlement 检查。
3. 领取已进入当前 run steering queue、尚未被先前 wait 观察的 guidance 或 claimed inbox message。
4. 再做一次现有 race-safe即时检查。
5. 若已有结果，按原 outcome 返回；不要求承诺。
6. 若仍需阻塞且 commitment 缺失，返回 `single_wait_commitment_required`。
7. 有 commitment 时才进入 `source.withWaiting()` 并注册原 waiter、cycle guard、guidance interrupt 和 checkpoint timer。

commitment 不保存到 coordinator，也不产生“已解锁”阶段；每次单目标阻塞调用都携带自己的理由。aggregate wait 完全走原路径。

## 7. UI 设计

### 7.1 信息层级

承诺卡从已有 `ToolItem` 派生：

- `request_edit_budget` 始终显示编辑承诺卡。
- 带非空 `singleWaitCommitment` 的 `wait_for_session` 显示等待承诺卡。
- 返回 `single_wait_commitment_required` 的 wait 显示“等待未开始”卡。
- 其它工具仍进入折叠的“工作过程”。

承诺工具不在常显卡和折叠 ToolCard 中重复出现。原始 args/result 放在卡片自己的展开区，历史恢复继续使用同一 `ConversationHistoryTool`，无需协议版本升级。

### 7.2 视觉语言

卡片与现有工具卡共享 10–12px 圆角、12px 辅助字号和 disclosure 交互，但使用独立的“意图”语义：

- 左侧 3px 靛紫色 intent rail，而不是 success/error 状态色。
- 极浅的紫灰渐变底和细边框；dark theme 使用同一语义变量。
- 小型菱形/节点标记，不复用工具调用的勾号，也不使用警告 emoji。
- eyebrow：`编辑承诺` / `单会话等待承诺`。
- 主标题：`预计修改 3 个文件` / `等待 <会话>`。
- 理由常显两行，溢出省略并保留 title。
- 右侧紧凑 fact chips：`新增额度 3`、`剩余 2`、`等待中`。
- `single_wait_commitment_required` 改用 warning rail 和 `等待未开始`，但保持同一组件，不做红色错误大卡。
- 已声明但工具动作被拒绝时使用紧凑 error rail 和 `执行失败` fact；其它已完成声明仍保持中性，不把声明伪装成合规结论。
- pending wait 使用小 spinner；卡片本身不暗示用户审批。

移动端将 facts 换行到标题下，命中区不少于 36px；支持键盘 focus 和 reduced-motion。

### 7.3 文案

编辑声明：

```text
编辑承诺
预计修改 3 个文件                   新增额度 3 · 剩余 3
修复 active run 与历史恢复之间的参数一致性。
```

等待声明：

```text
单会话等待承诺
等待 API 审查 Agent                 等待中
该审查位于提交前关键路径；此时没有独立的本地工作可继续。
```

缺失声明：

```text
等待未开始
需要先说明单独等待的理由
可以继续本地工作、改为多目标等待，或带承诺再次调用。
```

## 8. 投影与恢复

- live：`tool_started/tool_prepared/tool_finished` 仍更新同一个 tool part。
- durable：Pi toolCall args 和 toolResult content/details 仍由 `conversation-history.ts` 恢复。
- 承诺卡只读 `ToolItem`，不新增 reducer 状态或 localStorage。
- edit budget 的权威状态只在 server run ticket；UI facts 来自已持久化 tool result details。
- 不回写早先声明卡；后续 edit/write 卡显示各自消耗事实，避免把“当时声明”伪装成动态对象。

## 9. 文件与测试计划

最小实现边界：

- `src/server/edit-budget.ts`：tool schema、路径身份和 ledger 操作。
- `src/server/conversation-actor.ts`：RunTicket owner、host tool、gate/completion wiring。
- `src/server/pi-runtime.ts`：post-execute callback adapter。
- `src/server/meta-tools.ts`：wait 字段、规范化和文案。
- `src/server/project-session-coordinator.ts`：即时检查后的单目标 guard。
- `src/client/components/ToolCard.tsx`：专用 CommitmentCard 与字段文案。
- `src/client/components/Message.tsx`：把承诺工具从折叠 activity 中提升为常显卡。
- `src/client/styles.css`：light/dark/mobile/reduced-motion 样式。

边界测试：

1. edit ledger：无额度拒绝；失败不消耗；同 canonical path 去重；新 path 消耗；追加额度恢复准入。
2. runtime：extension 变换后的 args 先进入 host gate，成功结果触发 completion callback，仍为 sequential。
3. wait：即时 settlement 无承诺可返回；真正单目标阻塞无承诺立即返回且不进入 waiting；带承诺保持原 wait；aggregate 不受影响。
4. history：request result 和 wait args/result 经 JSONL 恢复。
5. UI：两种承诺卡常显、原始详情可展开、缺失承诺状态、普通工具仍折叠、light/dark 样式不依赖运行时第二状态。

完成门槛：`npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。

## 10. 取舍

- **选择自然语言理由而非 Boolean/token。** Boolean 只能证明调用，理由能让 Agent 外化反事实判断；宿主仍只验证非空和长度。
- **选择 per-run ledger 而非持久实体。** 剩余额度是当前 run 的真实资源；跨 run 继承反而会模糊新任务的计划。
- **选择 distinct file 而非调用次数。** 同文件迭代是正常纠错；范围扩张才是需要重新承诺的信号。
- **选择专用卡而非普通 ToolCard 皮肤。** 承诺需要常显和可问责，但仍保留 disclosure 与原始数据，避免成为第二种 transcript。
- **选择所有可用 Agent 一致执行。** 是否为根 Agent 不改变阻塞等待或文件范围扩张的机会成本。
