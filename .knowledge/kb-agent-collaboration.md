# Agent 协作

`updated: 2026-07-19`

## 这个模块是干什么的

Pi Web 把同一项目中的每个持久 conversation 运行成平级 Agent。工作台只提供角色、观察、通信、等待和生命周期原语，不建立父子树或固定总指挥。

```text
用户 prompt / inbox 消息 / meta tool
→ canonical cwd + conversationId
→ ProjectSessionCoordinator
→ 唯一 ConversationActor
→ Pi AgentSession
→ durable settlement / inbox / card
```

## 角色

- `RoleStore` 是用户级严格 v1 文件，默认路径为 `<Pi agent dir>/piweb/roles.json`；项目文件不能修改角色目录。
- 角色包含稳定 ID、revision、名称、简介、system prompt、固定 provider/model，以及 `canManageSessions` 能力。写入原子串行，更新使用 expected revision，损坏、未知字段和未知版本 fail closed。会话编排严格 opt-in：旧角色缺少能力字段、初始化“默认”模板和 UI 新建角色都默认关闭，只有用户明确打开才启用。
- 初始化“默认 / 默认角色”只是首次展示模板，可以像其它角色一样编辑、删除，删除后不会重建；新会话仍必须显式选择角色。
- `RoleCatalog` 用当前项目 actor 的 session-local 模型目录动态计算模板是否可用，因此项目静态 provider 也能参与选择；空项目使用 coordinator 持有的 project model catalog，它经过相同 trust/resource/provider 校验，但不会创建隐藏 AgentSession。角色 CRUD、模型列表和 API Key provider 校验都使用这条项目目录；真正创建还会由 `PiRuntime` 在项目资源加载后再次校验固定模型。
- 新会话把完整角色修订（包括会话管理能力）复制到 `piweb.conversation_meta.v1`。之后修改或删除模板不会改变旧会话；角色 prompt 追加到会话 system prompt，实际模型必须与快照完全一致，SDK fallback 会被拒绝。旧 conversation metadata 缺少能力字段时按关闭迁移。
- 旧会话第一次在独占 writer lease 下打开时迁移为独立“旧会话”快照；其 system prompt 固定为空，并尽量保留旧分支模型，不依赖初始化模板。

## Actor 所有权

`ProjectSessionCoordinator` 由 socket server 共享，并按 canonical cwd 维护项目上下文。每个 `canonical cwd + conversationId` 最多一个 `ConversationActor`：

- actor opening singleflight，浏览器和 Agent 打开同一会话会复用 actor 与 writer lease；
- 每个项目还 singleflight 建立一个无 AgentSession 的 project model catalog；空项目可据此显示项目扩展模型、管理角色和创建第一条会话，最后一个项目 handle 释放后统一 dispose；
- actor 原子拥有角色快照、`SessionManager`、writer lease、隔离的 settings/model registry、`AgentSession`、唯一 `activeRun`、串行队列和观察者；
- `activeRun` 的 `queued / running / waiting / cancelling` 是侧栏 activity 与 busy 的唯一来源；
- 浏览器切换焦点只更换观察者，不 abort、dispose 或暂停后台 actor；
- coordinator close 会同步封闭新 lifecycle 入队并结算全部 extension UI/waiter，排空关闭前已接收的 lifecycle task 后再释放资源；尚未开始的 task 在任何持久写前失败，不能让 close 返回后继续追加卡片。迟到 actor/catalog 会立即 dispose，随后清理包括无浏览器观察者在内的全部 actor、后台恢复任务与项目 handle。

`PiConnection` 不再拥有 conversation 生命周期。它只拥有浏览器 project observation epoch、当前 focus、认证 flow 和 extension UI broker。

### Extension UI

扩展 UI 只在线路上路由到当前被该浏览器 focus 的 conversation。后台 actor 暂无 UI delegate 时，请求留在 conversation router 中并把目标标为 attention，不会抢走用户焦点；用户切换到该会话后才发出对话框并可正常回答。等待 focus 期间仍遵守 extension 的 AbortSignal/timeout；切走 focus 会取消已经发给浏览器的旧对话框，项目关闭会用取消值结算全部待处理请求。

## 持久通信

项目内布局增加 inbox：

```text
<project>/.piweb/
  project.json
  sessions/
    *.jsonl
  inbox/
    <messageId>.json
    target-<conversationId hash>.tombstone.json
```

每个 inbox envelope 是严格 v1 的单文件原子记录，保存稳定 `messageId/cardId`、来源/目标 conversation 快照、正文、消息种类以及 `queued | processing`。目录、文件、身份、容量或内容异常都 fail closed。

发送线性化顺序：

```text
来源 JSONL 追加 sending 卡片
→ 原子写目标 inbox
→ 来源同 cardId 追加 queued 卡片
→ 目标 idle 后转 processing，写入 custom_message 并启动 run
→ 精确 run settlement 持久化
→ 来源同 cardId 更新 terminal 状态
→ 删除 sidecar
```

- busy 目标不会被打断；消息保持 queued，等当前 run 结算后泵送。
- inbox commit 是取消边界：commit 前取消可拒绝，commit 后即使来源 run 随即取消，目标 pump 仍继续；同步启动失败会有界重试一次并保留 durable sidecar。
- 同一目标严格按 `sentAt + messageId` 泵送，新的 idle-target send 也必须先经过项目 inbox pump，不能越过更早的 queued 消息。
- inbox 每次最多批量投递 8 条。允许管理会话的目标 LLM 会收到来源标题、角色、完整 conversationId、正文、回复工具提示，以及“自行管理所创建会话生命周期”的提醒；关闭能力的角色只收到来源元信息和正文，不会看到任何会话工具名称或管理提示。隐藏提示只存在于 Agent 上下文，浏览器卡片仍只从 `details.body` 投影用户可见正文。
- incoming 消息使用 `piweb.conversation_message.v1` 并进入目标上下文；outgoing/委派状态使用 `piweb.conversation_card.v1`，只用于投影。
- 同一 `cardId` 的后续 entry 原地覆盖卡片状态；浏览器和重启恢复不会刷出多张重复卡。
- 每个 run 先追加 `piweb.run_settlement.v1`，记录精确 `runId/outcome/finalText`，再通知 waiter 和 inbox 清理。等待与临时回传不能从“最后一条 assistant”猜结果。
- 重启会扫描 inbox 与 reserved JSONL：修复 inbox 已提交但来源仍是 sending 的卡片，恢复 processing run、临时结果和目标 pump；已经 durable settled 的 run 不会重复执行。
- terminal sender card 必须先于 sidecar 删除；两步间崩溃时，残留 sidecar 可在重启后完成对账。
- 删除 conversation 会先持久化 target tombstone，再把只以它为目标的 pending inbox 对应 sender card 终结并清理；tombstone 在内存中也是 open/create/pump/send 的硬 fence，删除事务中的后到消息被明确拒绝，它此前发出的 outbound envelope 仍会继续送达。JSONL 删除完成后 tombstone 会幂等回收；若进程在这两步之间退出，下次项目打开先恢复 fence，再完成删除或只清理目标已不存在且没有 pending 消息的完成标记，避免重新打开目标或长期编排耗尽固定 tombstone 数量。

## 上下文前缀与缓存

- 已进入模型上下文的 user、assistant、tool 和 incoming custom message 都是 append-only；新的宿主提示只附加到以后收到的新消息，不能回填或重写旧 entry。
- 角色完整修订已冻结在 conversation metadata 中；重新打开会话仍使用同一角色 prompt 和模型，角色模板后续编辑不会改变既有会话的 system prompt。
- 卡片状态、run settlement、meta operation 和 conversation metadata 使用普通 `custom` entry；SDK 的 `buildSessionContext()` 会忽略它们，因此状态更新既不改旧消息，也不污染模型缓存前缀。
- 会话自动压缩阈值同样使用普通 `piweb.compaction_threshold.v1` custom entry 保存；缺省为 70%，允许 20%–90%，最后一条有效记录生效，不进入模型上下文。
- 两个明确例外会有意改变模型输入：Pi 在上下文逼近上限时追加 compaction summary 并以摘要替换活动上下文，以及重新启动后项目资源本身发生变化导致基础 system prompt 变化。前者是继续运行所需，后者反映用户真实修改；工作台不为提高命中率伪装旧项目状态。

## 临时会话

临时会话仍是扁平的一等 conversation，只给初始委派增加生命周期：

- metadata 固定 caller conversation、delegation ID、return message ID 和精确 initial run ID；
- initial run 成功且有最终 Agent 文本时，先把结果作为 durable inbox 消息发给 caller、把 settlement 标记为已报告，再删除临时会话；
- initial run 失败、中止或没有最终回复时，同样持久回传失败消息，但保留会话并标记 attention；
- 后续重试的成功 run 不会误触发初始委派的自动删除。

## Agent meta 工具

只有 frozen role 的 `canManageSessions=true` 时，actor 才注入完整九个工具：

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

`canManageSessions=false` 时工具列表是空数组，不注册占位工具，也不向模型提供名称、参数、说明、回复工具提示或生命周期管理提示。该决定只读取 conversation role snapshot；后续编辑角色模板不会改变已存在会话的工具 schema，因此不会破坏既有会话的缓存前缀。

- 工具闭包绑定来源 conversation 和当前 canonical project，不接受 cwd/projectId，不能跨项目。
- Agent 只能查看和选择角色，不能 CRUD 角色、改认证/trust、换既有会话角色或模型。
- `start_session` 必须给 role 和 task，创建平级普通/临时会话；它在冻结角色、初始 task 和固定 runId 被可靠接受并调度后返回 `conversationId + runId`。目标空闲时立即取得 run ticket；若更早的 run 抢先则持久等待泵送。两种情况都不会隐式等待或挂起调用者。
- `send_session_message` 在持久接收后返回；busy 目标仍保持当前 run。
- `wait_for_session` 绑定精确 `conversationId + runId`，先读 durable settlement，再 observe-or-subscribe；只有它会把来源 run 显示为 waiting，取消和异常都恢复 phase。
- `abort_session` 只匹配精确目标 run；stale runId 不会中止后来的 run。其精确目标与已决定结果也写入来源会话的 `piweb.meta_operation.v1`，同一 tool call 在结算或重启后重放仍返回原结果；若进程在 started intent 后崩溃，恢复会先精确中止/结算该 run，再允许 inbox pump 继续。
- `delete_session` 拒绝 self 和 busy 目标；需要先 abort、等待结算，再删除。删除 intent/result 以 `piweb.meta_operation.v1` 持久化，相同 toolCall 重放不能改删另一个目标。
- `start_session` 的角色、task、title 和 temporary 进入 sender card 指纹，相同 toolCall 改 payload 会冲突而不是谎报成功。
- `peek_session` 不启动 inactive 目标的模型/扩展，不移动 recent；只返回 user/assistant 可见正文和会话卡片，过滤 thinking/tool/auth/internal，最多 20 项且完整 JSON 不超过 256 KiB。inactive inspection 与删除共用 lifecycle 边界，因此短暂 writer lease 会先释放，删除不会留下只能靠重启恢复的 tombstone。
- 列表和正文同样有界；Agent 看到稳定完整 conversationId，而 UI 可另显示短句柄。`list_sessions` 的每项显式返回 durable `createdBy` 与观察者相对的 `createdByMe`，并支持 `scope=created_by_me`，让 Agent 无需依赖对话记忆即可找回自己负责的会话；尚未迁移、确实没有 conversation profile 的旧条目如实标为 `createdBy.kind=unknown`。

meta 工具仍经过项目扩展 hook、run ownership 和宿主 tool gate。它们不是 builtin 只读工具，因此完整 Agent 编排只在 `full_access` 可用，`read_only` 语义不变。

## 入口

- `src/server/role-store.ts`
- `src/server/role-catalog.ts`
- `src/server/conversation-meta.ts`
- `src/server/project-inbox.ts`
- `src/server/conversation-actor.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/meta-tools.ts`
- `src/server/pi-service.ts`
- `src/client/components/ConversationSidebar.tsx`
- `src/client/components/SessionMessageCard.tsx`

## 关联模块

- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
