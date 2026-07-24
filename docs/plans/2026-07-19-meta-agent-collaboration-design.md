# Meta Agent 协作设计

`status: approved`

## 目标

让每个 Pi Web Agent 都寄生于一个持久会话，并拥有用户的大部分会话编排能力。所有会话仍然是平级的一等会话；工作台只提供可靠的观察、通信、等待和生命周期原语，不内建固定的总指挥或父子树。

核心公式：

```text
多 Agent 协作
= 项目级 conversation actor
+ 不可变角色快照
+ 持久跨会话邮箱
+ run 完成通知
+ 用户与 Agent 共用的会话控制面
```

## 已确认的用户体验

### 角色

- 角色模板由用户管理；第一版 Agent 只能查看和选择，不能创建、修改或删除角色。
- 角色包含名称、简介、专属提示词和固定模型。
- 模型只能从当前已登录或已有 API Key 的提供商可用模型中选择。
- 每个会话创建时复制角色快照；模板后续修改只影响新会话。
- 会话开始后不能更换角色或模型。
- 角色库永久存在一个 `default` 角色；它不可删除，但名称、提示词和模型可编辑。
- 新建会话必须显式选择角色。默认角色只是固定选项，不会被自动选择。
- 角色选择使用完整起始页；选择前不显示 composer。
- 会话底部显示固化的角色和模型。点击后展示该会话的完整角色快照，并说明模板更新不会追溯。

### 会话控制面

- 左侧使用可收缩的专用会话栏。
- 会话列表永远扁平，不显示父子关系，也不引入持久的 subagent 层级。
- 活跃会话显示旋转圆圈；显式等待中的会话显示沙漏；等待用户处理时显示橙色标记。
- 普通跨会话新消息只产生未读，不产生 attention；attention 只用于失败、扩展 UI 等确实需要处理的状态，聚焦会话后清除。
- 会话项显示标题、角色和最后活跃时间；活跃项优先，其余按最后活跃时间排序。
- Agent 创建后台会话时不切换用户当前会话，只更新左栏和当前 transcript 中的会话消息卡片。
- 标题可由创建者指定；未指定时根据第一条任务生成，用户之后可以改名。
- 用户可以在当前会话运行期间查看或新建其他会话；切换观察焦点不能中止后台 Agent。

### 会话消息

- Agent 间消息是会驱动目标 Agent 的一等输入，不是隐藏通知。
- transcript 使用独立、简洁的“会话消息卡片”，明确显示来源/目标会话、角色、状态和正文。
- 同一次委派使用稳定卡片 ID 原地更新，不连续刷出创建、等待和完成三条状态。
- 点击卡片可以打开仍存在的目标会话。
- 消息是 durable steering 输入：目标 busy 时先持久 claim 到其精确 run，再在当前工具调用结束、下一次模型请求前注入；不会创建第二个 run。目标 idle 时才由 inbox 启动新 run。消息仅在 Pi 写入 incoming marker 且精确 run 已结算后完成清理；abort、断线或重启前未写 marker 的 claim 会恢复为 queued 重投。
- 发送成功只表示工作台已经持久接收，不表示目标已经处理或回复。

### 创建、等待与临时模式

- Agent 创建会话必须提供已有 `roleId` 和初始任务；标题可选。
- 创建操作在初始 task、固定 runId 和会话身份被可靠接受并调度后立即返回，不自动挂起调用者；若目标恰被更早的 browser run 占用，该 Agent run 保持持久待调度，不能谎称已经取得 actor run ticket。
- 调用者随后可以：
  - 显式调用等待工具并暂停；
  - 继续当前工作，与目标并行；
  - 完全不等待，之后接收目标主动发来的会话消息。
- 显式等待绑定精确的目标 `conversationId + runId`。目标已经结算时立即返回，不能错过完成事件。
- 创建时可选择临时模式。临时会话仍是扁平的一等会话，只增加“成功回传后清理”的生命周期行为。
- 临时会话成功且产生 Agent 最终回复时，先把该 run 的最终回复持久发送给调用者，再自动删除临时会话。
- 临时会话失败、中止或没有 Agent 回复时，向调用者发送明确失败消息，但保留会话，由调用者决定查看、重试或删除。

### 权限边界

Agent 可以：

- 查看当前项目的会话元信息；
- 明确查看某个会话最近 6 条、最多 20 条用户可见内容；
- 查看自己的会话身份；
- 查看角色目录并选择角色；
- 创建普通或临时会话；
- 向其他会话发消息；
- 等待具体 run；
- 精确中止其他会话的 run；
- 删除其他 idle 会话。

Agent 不能：

- 跨 canonical project cwd 查看或控制会话；
- 修改角色目录、认证、项目 trust 或安全设置；
- 更换任何既有会话的角色或模型；
- 删除自身会话；
- 直接删除 busy 会话。它必须先 abort、等待结算，再 delete。

工作台 meta 工具仍经过宿主 run ownership 和工具模式 gate。现有 `read_only` 硬边界不因本功能静默扩大；完整自主编排在 `full_access` 下启用。

## 核心运行循环

```text
收到用户 prompt、跨会话 envelope 或 meta tool call
→ 按 canonical cwd + conversationId 定位唯一 ConversationActor
→ 在 actor 串行边界安装或观察 activeRun
→ 经过 ProjectRunCoordinator 注册项目 run
→ 调用 Pi AgentSession
→ 持久化 transcript、run settlement 和卡片状态
→ 通知浏览器观察者、waiter，并泵送下一批 inbox
```

创建另一个会话不会隐式调用等待：

```text
source Agent 调用 start_session
→ coordinator 创建 target actor
→ 持久化冻结角色、task、确定 runId 和初始卡片
→ 若 target idle：安装 run ticket 并发布 run_queued
→ 若更早 run 已占用：保持同 task/runId 持久待调度
→ start_session 返回 conversationId + runId
→ source Agent 自行决定 wait、继续并行或结束当前回合
```

## 状态所有权

### 进程级

- `PiRuntime`：认证、全局模型目录和 session 局部模型目录。
- `RoleStore`：用户级角色模板及其 revision。
- `ProjectStoreRegistry`：项目 store 和 conversation writer lease。
- `ProjectRunCoordinator`：项目权限收紧屏障。
- `ProjectSessionCoordinator`：项目 conversation actor、完成记录、waiter 和 inbox pump。

### conversation actor

每个 `canonical cwd + conversationId` 最多一个：

- 不可变角色快照；
- `SessionManager` 和唯一 writer lease；
- session 局部 settings/model registry；
- `AgentSession`；
- 唯一 `activeRun`；
- actor 串行队列与控制通道；
- 浏览器观察者；
- extension UI attention 状态。

`activeRun` 仍是 `queued / running / waiting / cancelling` 的唯一真相。侧栏 spinner、沙漏和 busy 都从它派生，不增加第二份 boolean。

### 浏览器连接

浏览器只拥有：

- 当前项目观察 epoch；
- 当前聚焦的 conversation；
- 本地角色选择页、侧栏收缩和弹窗意图；
- 当前 conversation 的 transcript 投影。

切换焦点只 detach/attach observer，不销毁或中止目标 actor。

## 持久化

### 用户级角色目录

路径：

```text
<Pi agent dir>/piweb/roles.json
```

严格 v1：

```ts
interface RoleTemplateV1 {
  id: "default" | string;
  revision: number;
  name: string;
  description: string;
  systemPrompt: string;
  model: { provider: string; id: string } | null;
  createdAt: string;
  updatedAt: string;
}
```

- 首次创建固定 `default`。
- 若存在可用模型，首次默认角色绑定当前默认或首个可用模型；否则保持 `model: null` 并禁止创建会话。
- 文件损坏、未知版本或未知字段 fail closed，不覆盖原文件。
- Agent 工具只得到角色摘要与可用性，不得到 CRUD 能力。

### conversation 角色快照

新 JSONL 在 header 后首先追加 reserved `custom` entry：

```ts
customType: "piweb.conversation_meta.v1"
data: {
  role: {
    id, revision, name, description, systemPrompt,
    model: { provider, id }
  },
  lifecycle:
    | { kind: "normal" }
    | {
        kind: "temporary",
        callerConversationId,
        delegationId,
        returnMessageId,
        initialRunId
      },
  createdBy:
    | { kind: "user" }
    | { kind: "conversation", conversationId }
}
```

它不进入 LLM context。角色专属提示词以 system prompt append 的方式注入，模型在创建 `AgentSession` 时显式传入并做后置条件校验，禁止 SDK fallback。

旧会话在第一次取得独占 writer lease 并正式打开时追加一次 legacy snapshot：

- 角色 ID/名称使用当时的 default；
- `systemPrompt` 固定为空，保留旧行为；
- 模型使用旧会话当前分支最后记录的模型；
- 模板未来修改不追溯。

重复、冲突或畸形 reserved metadata 一律拒绝打开。

### 跨会话 inbox

路径：

```text
<project>/.piweb/inbox/<messageId>.json
```

每条 envelope 单文件原子写入。目录和文件必须是项目拥有的常规路径，链接、非法 JSON、超量文件或冲突 ID fail closed。

至少保存：

```ts
{
  version: 1,
  messageId,
  fromConversationId,
  toConversationId,
  sentAt,
  kind,
  body,
  replyToMessageId?,
  delegationId?,
  fromRunId?,
  fromSnapshot,
  toSnapshot,
  state: "queued" | "processing",
  processingRunId?,
  processingDelivery?: "steer",
  waitedByRunId?
}
```

顺序：

1. 原子写入 inbox 后，发送者才能收到“已接收”。
2. busy 目标将最早 queued envelope（包括临时结果/失败）持久改为 `processing(runId, "steer")`，再以 reserved `custom_message` 作为 SDK steering 注入当前 run；当前工具调用不被中断，普通发送在 durable claim 后返回而不等待 pre-stream SDK 队列。
3. 目标 idle 后由 actor 将一批 envelope 写为 reserved `custom_message` 并启动 run。
4. `content` 包含来源标题、角色、句柄和正文，保证目标 LLM 可回复；`details` 保存卡片元数据且不进入模型。
5. 对应 run durable settled 后，先持久化发送方 terminal 卡片，再删除 inbox sidecar；steering claim 若尚无目标 JSONL marker，则恢复 queued 而非确认交付。
6. 主动消息冻结可选 `fromRunId`；cycle check、waiter 注册与 inbox 补查在同一项目 lifecycle 边界，发送先赢时仍能按来源 conversation + run 找回精确回复。processing envelope 用 `waitedByRunId` receipt 防止同一接收 run 的连续 wait 重放相同 messageId；异常必须 remove+detach waiter。
7. 重启时用 `messageId` 对账 JSONL 和 sidecar，避免重复投递；异步 steering acceptance 拒绝会触发 tracked actor reopen/recovery，不能留下无 settlement 的永久 processing claim。旧 v1 envelope 缺少 `fromRunId` 时 crash replay 保留字段缺席。

发送方卡片和目标 inbox 也需要可恢复的事务边界：

- 发送前预分配 `messageId + cardId`，先在发送方 JSONL 追加 `sending` 卡片，再原子提交目标 inbox，最后追加同卡片的 `queued` 状态。
- 如果进程在 inbox commit 后、发送方 `queued` 卡片前崩溃，恢复时必须从 envelope 的 `cardId` 修复发送方卡片，不能让消息已经送达却永久显示“发送中”。
- sidecar 清理前先确认目标 JSONL 已含 delivered marker，并完成发送方卡片对账。
- 删除会话只清理 `toConversationId` 等于该目标的待收 envelope；以被删会话为来源的 outbound envelope（尤其是临时结果回传）必须保留，直到接收方持久消费。

### 卡片与 run settlement

- incoming 跨会话消息：目标 JSONL 的 reserved `custom_message`，进入目标上下文并投影成卡片。
- outgoing/委派状态：发起方 JSONL 的 reserved `custom`，可见但不重复进入发起方上下文。
- 同一 `cardId` 的后续 reserved entry 覆盖先前卡片投影。
- 每个 workbench run 结算前追加 reserved settlement，保存 `runId`、outcome、精确最终 Agent 文本和已报告状态。
- wait、临时回传和崩溃恢复只读取 settlement，不能从“会话最后一条 assistant”猜测。
- 临时自动回传只绑定 `initialRunId`。caller 正在等待该 run 时，settlement 不直接把 `finalText` 复制进 wait tool result；wait 保留到回传 envelope 提交，以 message metadata 结算，正文只由 incoming custom message 输入一次。该 run 失败后会话进入 durable `retained_failed` 状态；后续重试不能误触发旧委派的自动删除。
- 临时生命周期通过 reserved entries 单调推进：

```text
pending(initialRunId)
→ result_enqueued(returnMessageId)
→ deleted

pending(initialRunId)
→ failure_enqueued(returnMessageId)
→ retained_failed
```

恢复逻辑按 `initialRunId + returnMessageId` 对账，不能把后续任意成功 run 当作初始委派成功。

## ProjectSessionCoordinator

协调器提供用户命令和 Agent 工具共用的 service：

- `listSessions`
- `currentSession`
- `peekSession`
- `listRoles`
- `startSession`
- `sendMessage`
- `waitForRun`
- `abortRun`
- `deleteSession`
- `attachObserver` / `detachObserver`

重要约束：

- actor opening 使用 singleflight；不能为同一 conversation 创建两个 `AgentSession`。
- 工具不能伪造 `ClientCommand` 或创建隐藏 `PiConnection`。
- meta 工具不能回调来源 actor 的串行命令队列，否则会等待自身 run 完成而死锁。
- wait Promise 注册在 coordinator，不进入目标 actor queue。
- wait 先查询 durable settlement，再做 observe-or-subscribe；内存 ledger 只是有界缓存，不能成为重启后的唯一完成真相。
- 显式 wait 用来源 actor 的 run ownership token 将 phase 从 `running` 切为 `waiting(targetConversationId, targetRunId)`，并在成功、失败或 AbortSignal 的 `finally` 中恢复；过期 token 不能复活已经结算的来源 run。
- send、finish 和 inbox pump 在同一项目/目标串行边界线性化。
- delete 先设置 deleting fence，拒绝新消息和新 run；随后把 actor 持有的 writer lease 在 registry 内原子升级为 deletion lease。升级到精确 unlink 和索引刷新完成之前不能出现 release/reacquire 窗口。
- server close 必须 abort、settle、dispose 所有无浏览器 actor，不能只关闭 sockets。

## Agent meta 工具

固定宿主工具：

```text
list_roles
list_sessions
current_session
peek_session
start_session
send_session_message
wait_for_session
abort_session
delete_session
```

共同规则：

- 工具闭包绑定 canonical project 和来源 conversation，不接受 cwd/projectId 参数。
- 所有结果有界、JSON-safe、包含稳定 conversationId。
- 工具执行前后校验 actor generation、activeRun ownership 和 AbortSignal。
- 项目 extension hook 仍先执行；宿主 gate 再识别 workbench tool identity，扩展同名工具不能冒充。
- 有副作用的工具用 `sourceConversationId + toolCallId` 做幂等键。

精确语义：

- `list_sessions`：默认 50、最多 100，支持 cursor；含标题、角色、状态、最后活跃时间、当前 runId 和 self 标记。
- `current_session`：返回来源 conversation、角色、模型和当前 run。
- `peek_session`：默认 6、最多 20，只返回用户可见 user/assistant/会话卡片，不返回 thinking、认证或 SDK 内部事件；inactive 目标检查不能修改 recent pointer。
- inactive `peek_session` 与删除共用项目 lifecycle 边界；读取持有的短暂 writer lease 必须先释放，删除才能写 tombstone 并 fail-fast 取得 deletion lease。
- `start_session`：`roleId + task` 必填，`title + temporary` 可选；必须先把完整角色快照、初始 task、确定的 `runId` 和临时生命周期元数据持久化并可靠调度后才返回。目标空闲时安装同一个 run ticket；若更早的 browser run 抢先，则保留这个 task/runId 等待泵送。崩溃恢复继续这一个 task/runId，不能确认成功后丢任务或另造 run。
- `send_session_message`：持久接收后返回 queued/processing/delivered 状态；目标 busy 时不打断当前工具调用，但作为 durable steering 注入其当前 run。
- `wait_for_session`：必须绑定 target `conversationId + runId`；先查 durable settlement，已经完成则立即返回；等待自身当前 run 被拒绝；AbortSignal 取消 waiter；来源会话只在这次显式等待期间显示沙漏。精确回复不得越过更早 inbox 消息；为避免未完成 wait 工具阻止既有 steering 被消费，宿主先把有界 predecessor chain 按 FIFO 排入同一 run，再排回复并结算 wait。
- `abort_session`：精确匹配 runId，错误 runId 不得中止后来 run。
- `delete_session`：拒绝 self 和 busy；并发删除最多一个实际执行，目标已不存在可返回幂等结果。

## 线协议

协议升级，不做 v10 静默兼容。

主要变化：

- `initialize.conversation.kind === "new"` 强制 `roleId`。
- `recent` 在空项目中不偷偷创建默认会话；连接进入“项目已打开、尚无 active conversation”状态。
- `PublicState.conversationId` 和 conversation runtime 字段允许在项目空态缺席。
- 新增低频 `role_catalog_snapshot`。
- 角色 CRUD 命令带 `sessionId + commandId`，用精确 complete/error 结算。
- `project_snapshot` 增加角色摘要、动态 activity、runId、attention 和 temporary。
- 每次 open/new/focus 都分配连接内不复用的 `focusId`，并用原命令的 `commandId` 精确确认 attach。当前 conversation 的 snapshot、run/card live event 和 attach-complete 必须同时带 `focusId + conversationId`。
- 客户端用 `project observation epoch` 过滤项目控制面，用 `focusId + conversationId` 过滤当前 transcript。即使快速 `A → B → A`，第一次 A 的迟到 frame 也不能污染第二次 A。
- `conversation_snapshot` 携带固化角色快照，并把历史改为 discriminated items：

```ts
type ConversationHistoryItem =
  | { kind: "message"; role: "user" | "assistant"; ... }
  | { kind: "conversation_message"; ... }
  | { kind: "delegation"; ... };
```

- live 卡片使用带 `sessionId + conversationId + itemId` 的幂等 transcript item 事件，不伪装成任意 run delta。
- 项目级更新按观察 epoch + projectId 过滤，不按被更新的 conversationId 丢弃。

## UI 投影

- `ConversationSidebar`：扁平列表、折叠、activity/attention/unread/temporary。
- `RoleSelectionPage`：完整卡片页，初始不选，显式确认后才创建。
- `RoleManagerDialog`：左侧角色列表、右侧编辑；default 固定置顶；模型只列可用项。
- `SessionMessageCard`：独立于 user/assistant Markdown 和普通工具卡。
- `Chat`：composer 底部显示不可变角色 pill；角色选择页存在时不渲染 composer。
- `ConnectionDrawer`：保留认证、项目工具模式和角色管理入口；移除当前会话模型切换和旧对话列表。
- 后台创建、状态变化和 attention 只更新侧栏/通知，不抢焦点。

## 容量上限

| 数据 | 上限 |
|---|---:|
| 角色数 | 64 |
| 角色名 | 80 字符 |
| 角色简介 | 1,000 字符 |
| system prompt | 128 KiB UTF-8 |
| 单条跨会话正文 | 256 KiB UTF-8 |
| 项目 pending inbox | 256 条、总计 32 MiB |
| 单目标 pending inbox | 64 条 |
| Agent 会话列表页 | 默认 50、最多 100 |
| peek | 默认 6、最多 20、总计 256 KiB |
| 浏览器单卡正文投影 | 80 KiB，可显示 truncated |
| 浏览器 focused history snapshot | 750 KiB |
| 浏览器 project snapshot | 最多 100 会话、750 KiB |
| role catalog snapshot | 最多 64 角色；单角色字段受上述限制 |
| 客户端命令帧 | 1 MB |
| 服务端事件帧 | 64 MiB；仅容纳最坏 JSON 转义后的有界目录 |

超限明确失败，不静默裁剪 Agent 实际收到的语义。临时结果超限时回传失败并保留临时会话。

## 必须先覆盖的反例

1. meta 工具在来源 prompt 内创建目标不会重入来源 actor queue 或死锁。
2. 浏览器打开 Agent 创建的活跃会话复用同一 actor 和 writer lease。
3. wait 注册前目标已完成时立即且只返回一次。
4. busy 目标收信进入当前 run 的下一次模型请求，不创建新 run；abort、断线或重启前未写 incoming marker 时 inbox 会按 FIFO 重投。
5. send/finish、send/delete、prompt/delete 都只有一个线性结果。
6. 错误 runId abort 不影响后来 run。
7. 自身 delete 永远拒绝。
8. 临时成功先持久回传再删除；回传失败、aborted 或无回复均保留。
9. append JSONL 后、更新 inbox 前崩溃，重启不重复同一 messageId。
10. 修改角色模板后旧会话 prompt/model/name snapshot 不变。
11. 角色模型无认证时创建失败且不遗留 conversation。
12. server close 会清理无 WebSocket actor 并释放 lease。
13. 后台会话更新不切换当前 transcript、draft 或 conversationId。
14. 默认角色未被用户显式选择时不能创建会话。
15. 临时初始 run 失败后，即使该会话后续重试成功，也不能自动删除。
16. 临时结果已进入调用方 inbox 后调用方被删除，结果 envelope 仍按目标身份保留或按明确目标 tombstone 处理，不能因来源清理误删。
17. actor writer lease 升级 deletion lease 的全过程没有第二个 opener 可进入的窗口。
18. `start_session` 返回“已可靠接受/调度”后立刻崩溃，重启只恢复同一个 task、冻结角色和 runId。
19. inbox 已提交但发送方 queued 卡片未写时，恢复能修复同 cardId 卡片。
20. wait 成功、目标失败和来源 abort 都恢复来源 phase；旧 wait token 不能复活已结束 run。
21. `A → B → A` 快速切换时，只有第二个 A 的 focusId 可以 hydrate 当前 transcript。
22. `start_session` 入队后同一 tick 关闭 coordinator 时，close 必须封闭并排空 lifecycle queue；关闭后不能继续追加永久 sending 卡片。
23. inactive `peek_session` 持有短暂 writer lease 时并发删除，必须先完成 peek 再进入 tombstone，不能把目标永久卡在 deleting。

## 非目标

- 不做会话父子树或固定 orchestrator。
- 不开放 Agent 角色 CRUD、认证、trust 或跨项目控制。
- 不做远程访问、OS sandbox、跨进程 writer lock。
- 不把完整会话索引重新塞入高频 state。
- 不依赖浏览器 localStorage 保存 transcript、角色或 durable inbox。
