# Pending Prompt 原子批量 Steer 设计

`date: 2026-07-29`

## 问题

当前每条待处理用户消息各自发送一个 `steer_pending_prompt`。这些命令可以绑定同一个 workbench `runId`，但它们没有共同的批次身份，也没有共同的 SDK 入队边界。

Pi SDK 的 `steeringMode=all` 只表示一次 drain 取走“当时已经在队列里的全部消息”。如果第二条命令在第一次 drain 之后才进入 SDK，仍会产生另一个逻辑模型 turn。因此：

- 同一个 `runId` 不等于同一次模型观察；
- 多次相邻点击不构成原子批次；
- 仅覆盖 `steeringMode` 是时序补丁，不是语义保证；
- 现有 fake-session 测试只证明多条 receipt 使用同一 run，不能证明模型调用边界。

## 目标语义

新增显式“全部 Steer”操作。一次操作在服务端线性化点冻结该 conversation 的全部 `queued` pending prompts，并保证：

1. 冻结成员按 `createdAt + promptId` FIFO 排序；
2. 这一批在 SDK 中作为一个不可拆分的 user guidance 单元交付；
3. 模型在一个逻辑 turn 中同时看到完整批次；
4. 批次继续绑定命令携带的 exact active `runId`，不会迁移到后续 run；
5. SDK 接受前的确定性失败可整体恢复为 queued；SDK 接受后的不确定结果整体转 attention，绝不自动重试；
6. 崩溃恢复能区分“已准备、已开始 SDK 交付、已证明 durable delivery、已完成清理”。

这里的“一次模型调用”指一次逻辑 `streamFn` turn；provider transport retry 不属于第二个用户 turn。

## 关键决策

### 1. 显式批次，而不是猜测“同时点击”

新增 `steer_all_pending_prompts` 命令，携带：

```text
commandId + batchId + sessionId + conversationId + focusId + exact runId
```

命令不携带客户端看到的 promptIds。服务端在 project lifecycle 串行边界读取权威队列并冻结全部 queued 成员，避免 stale snapshot、非连续选择和跨命令竞态。

现有单条 `steer_pending_prompt` 保留；客户端在任一队列操作未结算时禁用其它 Steer 操作，避免把多次独立点击误当成批次。

### 2. 一个 SDK user message 是原子模型输入单元

锁定版 Pi SDK 没有原子 `steerMany()`；循环调用 `session.steer()` 会产生已接受前缀，不能在第 N 条失败时回滚。因此批次不循环调用 SDK，而是把冻结消息编码成一个确定性的、带顺序的 batch guidance 文本，再调用一次 `session.steer()`。

这会让 durable Pi transcript 中出现一个批次 user message，而不是 N 个物理 user entries。批次正文明确保留每条原始消息的编号和边界；待处理 sidecar、receipt 和 batch manifest 仍逐条保存 prompt identity。

编码后的完整 batch guidance 必须仍满足单条 `MAX_PROMPT_CHARACTERS` 上限；超限时在 manifest/claim 前整体拒绝并保持 queued，不能静默截取前缀。批次成员若以 `/` 开头也整体拒绝并保持 queued，避免把原本可能触发 skill/template 展开的命令静默改成普通批次正文。

### 3. Durable batch manifest

在目标 conversation JSONL 中追加非上下文 `piweb.pending_prompt_batch.v1` custom entry。每个状态记录都重复不可变身份：

```text
batchId
conversationId
runId
ordered items: promptId + createdAt + immutable payload SHA-256
state: prepared | started | delivered | completed | failed | attention
updatedAt
reason? (failed/attention)
```

状态含义：

```text
prepared  : membership 已持久冻结，SDK 尚未开始
started   : 所有 sidecar 已 claim，第一次 SDK mutation 前的 fence 已提交
delivered : 同一个 raw batch user message 已按对象引用证明写入 SessionManager
completed : 每条 receipt 已持久化且 sidecar 已清理
failed    : SDK 接受前确定失败，所有成员已恢复 queued
attention : started 后无法证明完整交付，禁止自动重试
```

同一 conversation 同时最多一个非 terminal batch。`batchId` 不得复用；`commandId` 只做连接内回执关联，不能替代 durable batch identity。

### 4. Claim 与恢复

`ProjectPromptQueue` 增加 bulk claim/rollback 原语：

- 在一个 queue operation 中扫描并验证全部权威 queued 成员；
- 按 FIFO 逐个写为 `dispatching(runId)`；
- 进程内第 N 个写失败时，精确回滚此前写入的同 run claims；
- `prepared` manifest 让重启能识别 claim 中途崩溃，并安全整体 requeue；
- `started` fence 后若没有 `delivered` 证明，则整批剩余 sidecar 转 attention；
- `delivered` 后恢复可幂等补齐逐条 receipt 和清理 sidecar，再追加 completed。

在 manifest 提交前已进入 lifecycle 的 enqueue 会被包含；排在批命令之后的 enqueue 不属于该批，继续保持 queued。

### 5. Delivery proof

ConversationActor 为批次只注册一个 delivery waiter。只有 SDK 发出 batch raw user `message_end`，且同一对象引用已经存在于同一 SessionManager entries 中，waiter 才成功。

Coordinator 随后先追加 batch `delivered` fence，再为每个 prompt 追加 `piweb.pending_prompt_delivery.v1`（带 batchId），最后删除 sidecar并追加 completed。这样任一清理步骤崩溃都可由 delivered fence 恢复，不需要重投模型输入。

## 实现阶段

### 阶段 1：持久批次与队列原语

文件：

- `src/server/conversation-meta.ts`
- `src/server/conversation-meta.test.ts`
- `src/server/session-file.ts`
- `src/server/session-file.test.ts`
- `src/server/conversation-history.ts`
- `src/server/project-prompt-queue.ts`
- `src/server/project-prompt-queue.test.ts`

验收：严格 schema、状态转换、冲突检测、bulk FIFO claim、进程内失败回滚、历史不投影 manifest。

### 阶段 2：Actor、coordinator 与恢复

文件：

- `src/server/conversation-actor.ts`
- `src/server/conversation-actor.test.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/project-session-coordinator.test.ts`

验收：一个 batch 只调用一次 `session.steer()`；prepared/start/delivered/terminal 顺序正确；exact run、并发 enqueue、确定失败、uncertain、abort、重启各有反例测试；单条 steer 行为不回归。

### 阶段 3：协议与连接控制

文件：

- `src/shared/protocol.ts`
- `src/shared/protocol.test.ts`
- `src/server/pi-service.ts`
- `src/server/pi-service.test.ts`

验收：协议升级；完整 focus/run/batch 关联；一次性 commandId；成功只在整批 durable cleanup 后回执；错误可精确结算。

### 阶段 4：客户端显式操作

文件：

- `src/client/App.tsx`
- `src/client/App.test.tsx`
- `src/client/components/Chat.tsx`
- `src/client/components/Chat.test.tsx`

验收：多条 queued 且 active run 为 running/waiting 时显示“全部 Steer”；发送单一 batch command；等待期间冻结全部队列动作；精确 completion/error 结算；snapshot 仍是队列真相。

### 阶段 5：真实 SDK 合同与知识页

使用真实锁定版 Pi Agent loop 和受控 `streamFn` 验证：批次 raw guidance 只形成一个 user message，并在一个后续逻辑模型 context 中完整出现一次。同步：

- `.knowledge/kb-server-runtime.md`
- `.knowledge/kb-client-state.md`
- `.knowledge/kb-wire-protocol.md`

最终运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

## 非目标

- 不承诺 provider 物理 HTTP 只尝试一次；retry 仍属于同一逻辑 turn。
- 不把普通单条 Steer 自动猜成批次。
- 不按文本去重或在 unknown outcome 后自动重发。
- 不修改或 patch `node_modules`；缺少 upstream 原子 `steerMany()` 时使用单一 batch user guidance 作为 SDK 原子单位。
