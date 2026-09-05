# Inbox Delivery 与 Reload Handoff 生命周期拆分

日期：2026-09-05

## 1. 问题

当前 `.piweb/inbox/<messageId>.json` 同时承担：

1. 尚未交付消息的 transport intent；
2. 已接受但尚未进入下一次模型调用的 wait interruption；
3. recipient run 的重启恢复索引；
4. source card、temporary return 和 delegation settlement 的回写凭证。

结果是 target transcript 已经持久化 incoming message 后，sidecar 仍要等整个 recipient run settlement 才删除。长生命周期 run 因而把 per-target 64 条配额耗尽。

Reload 也混淆了两个边界：replacement 是否已经持久接管 continuation，以及 recipient run 是否已经结束。`resumeAfterReload()` 启动 inbox recovery 后仍返回 pending，supervisor 持续重试，browser continuation 又必须等 actor idle 才能另起 run。

## 2. 设计原则

一次 delivery 有两个不同事实，不能继续共用一个记录：

- **IncomingMessageMarker**：目标模型上下文曾经观察到消息；属于可 rewind 的 transcript。
- **DeliveryReceipt**：transport 已不可逆完成；属于宿主账本，不能被普通 rewind 删除。

反例是当前 rewind：`ProjectStore.truncateConversation()` 会物理重写 JSONL。若直接把 context-bearing message marker 当永久 receipt，用户 rewind 后 dedup/run recovery authority 会消失。因此 marker 与 receipt 必须拆开，或把 receipt 放到不可 rewind 的等价账本。本设计选择同一 conversation JSONL 中的 hidden host entry，并要求 truncate 原子保留它。

## 3. 支持契约

必须保持：

- durable admission、FIFO、目标单 active run；
- marker 前 crash 可重投，receipt 后永不重复注入；
- send-before-wait、wait wake-once 和 `waitedByRunId`；
- fixed initial delegation 首次原子创建为 processing；
- temporary explicit/automatic return 的精确 receipt；
- delegation outcome 仍由 `RunSettlement` 决定；
- reload 后 unfinished browser work 与 inbox work 均不丢失；
- legacy 数据无法证明精确身份时 fail closed，不按正文或“当前 run”猜测。

## 4. 权威状态

### 4.1 `PendingDelivery`

物理载体仍是 inbox sidecar。它只在 durable `DeliveryReceipt` 出现前拥有 transport 语义。

```text
absent -> queued
absent -> claimed(initialRunId)       // fixed initial delegation，原子创建
queued -> claimed(targetRunId, mode)
claimed -> queued                     // 仅 marker/receipt 均不存在且 delivery 失败
claimed -> incoming marker
incoming marker -> delivery receipt
receipt -> sidecar cleanup
```

`fromRunId`、`processingRunId`、`processingDelivery`、`waitedByRunId` 和 temporary assignment 只服务 receipt 前的 transport/observation。

### 4.2 `IncomingMessageMarker`

现有 `piweb.conversation_message.v1` 保持 context-bearing：

- 包含模型与 UI 需要的 message/card/body/snapshot；
- 证明该消息已进入一次目标模型调用；
- 不承担永久 dedup、run recovery 或 reload locator；
- 可以被用户 rewind 从 active transcript 移除。

新协议不需要把宿主 run correlation 塞入模型消息 details，也不需要制造 `conversation_message.v2`。

### 4.3 `DeliveryReceipt`

新增 hidden host entry，例如 `piweb.message_delivery_receipt.v1`：

```text
messageId
cardId
fromConversationId
toConversationId
sourceRunId
targetRunId
kind
sentAt
payloadFingerprint
temporaryReturnAssignment?
deliveredAt
```

约束：

- 必须在 exact incoming marker 已持久化后创建；
- source/target/message/card/payload/run identity 冲突必须 fail closed；
- 同一内容重复 append 幂等，冲突重复拒绝；
- 普通 conversation rewind 必须原子保留；
- target conversation 正式删除时可随 target ledger 删除，因为 deletion tombstone 已禁止再次投递到该 identity。

新消息的正常 receipt 由 processing sidecar 与 marker exact join 生成。旧 v1 marker 也只有在 exact processing sidecar 仍存在时才可迁移；marker 无 sidecar/run identity 时不得补造。

### 4.4 `RunSettlement`

`piweb.run_settlement.v1` 只证明 run outcome。它不撤销普通消息 delivery。

```text
UnsettledPeerWork(runId)
  = DeliveryReceipt(targetRunId = runId)
    minus RunSettlement(runId)
```

`processingBatches` 仅是进程内调度缓存。一个 conversation 同时存在多个未 settlement 的 recoverable targetRunId 违反单 active run 不变量，恢复必须 attention/fail closed。

因为 receipt 会跨 rewind 保留，truncate 必须同时保留这些 receipt 引用的 `RunSettlement`；否则已结束的旧 run 会被误判为待恢复。

### 4.5 Source card projection

Source card 不是 authority，且按 kind 使用不同状态机：

- `message`、`delegation_result`、`delegation_failure`：receipt 后 terminal `delivered`；
- `delegation_task`：receipt 后 `running`，最终 `completed | failed | aborted` 来自 target run settlement。

正常协议要求 sidecar 创建前 source card 已存在。idle batch 先用 exact targetRunId 调用 `startMessages()` 建立不可回滚的 run identity，再 best-effort 投影 `running`；否则 batch 中较早 card 已写而较晚 card 失败时，transport rollback 会让重试换一个 runId 并破坏 card identity。receipt 与所需 temporary assignment 持久化后先清理 sidecar、释放容量，再 best-effort 修复 card；投影失败只进入 attention，由 receipt ledger 后续重试。恢复只更新 exact `cardId` 的既有 card；如果 source card 因用户 rewind 被明确移除，不重新伪造缺失 requestedRole/orchestration 的 card，也不得仅为投影启动 inactive source model。Identity 冲突进入 attention。

### 4.6 Temporary return receipt

`TemporaryReturnReceipt(state="claimed")` 是 explicit return assignment 的竞争结果，不是 delivery proof；它必须在 sidecar admission 后、尝试目标 delivery 前持久化，以便阻止 automatic return 越过已接受的 explicit return。Message delivery reconciliation 只能在该 claim receipt 已存在或已被精确修复后删除 sidecar。

```text
sidecar admission with immutable assignment
-> caller TemporaryReturnReceipt(claimed) durable
-> incoming marker
-> DeliveryReceipt
-> sidecar cleanup
-> temporary settlement/report/delete
```

任何 temporary conversation 删除前必须能从 caller receipt 证明 exact initialRunId、callerRunId、messageId 和 settlement。DeliveryReceipt 必须携带重建 assignment 所需的 immutable identity。

### 4.7 Wait observation

`waitedByRunId` 仍属于 PendingDelivery，不新增长期 WaitObservation store：

- callback/host waiter 成功认领前不能烧掉；
- 已 claim、尚未进入下一模型调用的 sidecar 可以唤醒 exact wait 一次；
- incoming marker 出现说明模型已经观察消息，后续 wait 不应再次被它唤醒；
- receipt 后 sidecar 删除，不影响 send-before-wait，因为真正需要 interruption 的窗口只存在于 marker 前。

### 4.8 Reload handoff

Supervisor manifest 本身是唯一 durable host handoff authority；不能再在 conversation JSONL 建第二份 reload ledger。Manifest 非空期间保持原 `requestId`，每个 target 保存：

- `cwd + conversationId + continueTask`；
- 需要 browser continuation 时预先生成且始终稳定的 `continuationRunId`；
- `unadopted | adopted`；
- adopted 时的 exact `adoptedRunId`。

模型用的 `workbench.reload_resume.v1` 是带 exact request/continuation identity 的隐藏 instruction 和重放去重 marker，但不是 supervisor ownership authority。

规则：

1. replacement 返回 exact adopted run identity 后，supervisor 才把 target 原子改为 adopted；
2. adopted target 在同一 child 存活期间不重复 recovery pass、不刷 warning；显式 `retry` 会放弃 adoption、清除 adoptedRunId 并进入同一 child 的有界重试；
3. manifest 在整个 target 完成前保留 locator；child crash 后下一 child 必须一次性复核 adopted target，并依 delivery receipt、settlement 与稳定 continuation identity 恢复或判定完成；
4. actor idle、无 active reload run、无 queued/processing sidecar、无 receipt-only run、无 processing batch 后，child 才用 exact requestId + cwd + conversationId + adoptedRunId 通知 supervisor 删除 target；
5. 已有 inbox recovery run 可以吸收 browser continuation，不等待 idle、不另起第二个 run；
6. 无 recoverable inbox run时才以稳定 continuationRunId 启动隐藏 browser continuation；若 marker 已存在但 settlement 缺失，则用同一 runId 发送 recovery trigger；
7. `continueTask=false` 不注入 browser instruction，但仍须排空完整 inbox FIFO 链；
8. adoption response 或 completion IPC 丢失不产生第二个 run；replacement child 从 manifest 与 conversation durable facts 重放。

## 5. Reconciliation

在 project recovery、inbox admission 前、target pump 前和 actor completion 后执行有界 reconciliation：

```text
for each sidecar:
  receipt = target host receipt(messageId)
  marker = target incoming marker(messageId)

  if receipt exists:
    verify exact identity
    require/repair the earlier temporary claim receipt when assigned
    delete sidecar
    best-effort update existing source card with kind-specific state
  else if marker exists:
    verify exact sidecar/marker payload
    append host receipt from sidecar claim
    require/repair the earlier temporary claim receipt when assigned
    delete sidecar
    best-effort update existing source card
  else:
    keep/retry PendingDelivery

for each host receipt grouped by targetRunId:
  if settlement exists:
    repair existing delegation-task terminal projection
  else:
    expose one exact recoverable run obligation
```

Admission 必须先 reconciliation，再调用 `ProjectInbox.put()`。`ProjectInbox` 继续只校验物理 transport 文件，不读取 conversation JSONL，也不新增 `delivered` sidecar 状态。

## 6. Crash matrix

| Durable state | Recovery action |
|---|---|
| sidecar，无 marker/receipt | 保留 FIFO，重投或继续 exact claim |
| processing sidecar，SDK queue 失败，无 marker | requeue |
| marker + sidecar，无 receipt | exact join 后补 receipt；不得重复正文 |
| receipt + sidecar，无 settlement | 补 temp/source 投影；删 sidecar；恢复 exact targetRunId |
| receipt，无 sidecar，无 settlement | 从 receipt 恢复 exact run |
| receipt + settlement | 不恢复 run；仅修复 delegation terminal projection |
| settlement + sidecar，无 marker/receipt | delivery 未成立；requeue，不能 terminal/delete |
| legacy marker + exact processing sidecar | 生成 host receipt 后进入新路径 |
| legacy marker，无 sidecar/run identity | 不猜 run，标 attention |
| marker/receipt/sidecar identity 冲突 | fail closed，不删除证据 |
| temporary receipt 写失败 | 保留 sidecar与 temporary conversation |
| rewind 删除 incoming marker | host receipt + referenced settlement 保留；不重投/不误恢复 |
| reload unadopted，child crash | manifest 让下一 child 重试 |
| reload adopted，run 未 settlement，child crash | 下一 child 用 manifest 的 exact adopted/continuation identity 与 receipt ledger 恢复 obligation |
| reload adopted，单个 run settlement 但仍有 inbox 链 | 保留 target 并继续 pump，不把 run settlement 当 target completion |
| reload adopted，target-level predicate 满足 | exact completion IPC 幂等删除 manifest target |

## 7. 删除与 rewind

- `ProjectStore.truncateConversation()` 的原子 rewrite 必须保留 delivery receipts、temporary return receipts，以及 delivery receipt 引用的 run settlements；它们不进入模型 transcript 投影。Reload authority 只在 supervisor manifest，不进入 project JSONL。
- Rewind 可移除 incoming marker 和 cards，但不能让同一 messageId 再次可投递，也不能复活已 settlement run。
- Conversation deletion 在 unlink target JSONL 前冻结并完成 sidecar/temporary reconciliation；删除 tombstone 是之后拒绝新投递的 authority。

## 8. 实现 owner

预计涉及：

- `src/server/conversation-meta.ts`：delivery receipt schema/aggregate/invariants；
- `src/server/conversation-actor.ts`：同一 inbox run 吸收 reload instruction；
- `src/server/project-session-coordinator.ts`：reconciliation、receipt-derived recovery、kind-specific cards、temporary ordering、reload handoff；
- `src/server/project-store.ts`：rewind 原子保留 host ledger entries；
- `src/server/session-file.ts`：receipt target identity 与完整性；
- `src/server/index.ts`、`src/server/socket-server.ts`：reload request identity/adoption/completion；
- `scripts/piweb-supervisor.mjs`：manifest v2 unadopted/adopted 生命周期；
- focused tests 与相关知识页。

不新增 delivery database、sidecar delivered 状态、第二套 settlement 或后台通用队列。

## 9. 最小验收反例

1. 同一长期 run 持久接收超过 64 条消息，第 65 条不会被已 receipt residue 拒绝；
2. marker 前 crash 可重投，marker/receipt 后 crash 不重复 context message；
3. sidecar 删除后仍从 receipt 精确恢复 targetRunId；
4. 普通 message 在 recipient run failed/aborted 后仍是 delivered；delegation task 才跟随 settlement；
5. send-before-wait 在 marker 前只唤醒一次，marker 后不唤醒后续 wait；
6. temporary receipt 写失败时不删除 return sidecar/temporary conversation；
7. legacy marker + processing sidecar 可迁移，缺失 run identity 时不猜；
8. rewind 移除 incoming marker 后仍不重投，且已 settlement run 不复活；
9. inbox recovery run 吸收 browser continuation，manifest 进入 adopted 而不等待 actor idle；
10. adopted run 长期 waiting 时 supervisor 不重复 recovery pass；
11. adoption response 丢失、child crash、再次 reload 不重复 continuation，并在 settlement 后清理 manifest。

## 10. 实施顺序

1. 新增 delivery receipt schema、aggregate 与反例测试，不改变 cleanup；
2. 收紧 rewind，原子保留非 rewindable host ledger；
3. 将 dedup/recovery 从 messageId marker 集合升级为 exact receipt；
4. 增加 reconciliation，先修复 temp/source 投影，再提前删除 sidecar；
5. settlement 改为 receipt-derived delegation projection；
6. 迁移 legacy marker + exact processing sidecar；
7. 实现 reload manifest/adoption split；
8. 跑 focused tests、完整 `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`，再更新知识页。
