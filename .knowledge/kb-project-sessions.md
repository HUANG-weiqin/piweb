# 项目与持久会话

`updated: 2026-07-19`

## 这个模块是干什么的

项目存储层让工作台状态跟工作目录移动，而不是跟浏览器、WebSocket 或服务进程走。它持有项目清单、Pi 对话和跨会话 inbox；角色与 API Key 仍分别由用户级 `RoleStore` 和 Pi 全局 `AuthStorage` 管理。

## 身份与生命周期

```text
projectId       durable，来自 .piweb/project.json
conversationId  durable，来自 Pi JSONL header
sessionId       ephemeral，一次浏览器 project observation epoch
focusId         ephemeral，一次 conversation attach
runId           ephemeral，一次 prompt
```

这些身份不能复用：

- 项目移动保留 projectId 和 conversationId。
- 项目复制可能复制这两个 durable ID，因此进程内租约按 `canonical cwd + conversationId` 键控，不能只按 projectId。
- 重连会创建新的 sessionId；打开、创建或切回同一 conversation 都创建新的 focusId，用它阻断 `A → B → A` 的迟到 transcript。
- 每次 prompt 使用新的 runId。

## 磁盘布局

```text
<canonical cwd>/.piweb/
  project.json
  sessions/
    <timestamp>_<conversationId>.jsonl
  inbox/
    <messageId>.json
```

`project.json` 当前是严格 v1：

```json
{
  "version": 1,
  "projectId": "<uuid>",
  "createdAt": "<canonical ISO timestamp>",
  "toolMode": "read_only | full_access",
  "lastConversationId": "<optional Pi session id>"
}
```

未知字段、非法版本和非法值都 fail closed，不会自动覆盖坏清单。旧版 `workspace_write` 是唯一兼容迁移：打开时映射为 `full_access` 并立即原子重写，运行时 API 和线协议不再接受该值。清单变更经过 store 内串行队列，并用同目录临时文件加 rename 替换。

## 打开循环

```text
initialize(cwd, target)
→ canonicalize cwd
→ ProjectSessionCoordinator.acquireProject()
→ 校验 .piweb 与 sessions 不是 symlink/junction
→ refreshConversations()，枚举并验证全部 JSONL，再与 SessionManager.listAll(custom sessionDir) 一一核对
→ recent 可返回项目空态；open 选择 exact conversation；new 必须显式 roleId
→ coordinator singleflight 取得/等待 writer lease
→ SessionManager.create/open(..., current cwd override)
→ 创建或读取不可变 conversation profile
→ PiRuntime 用固定 role model/prompt/tools 创建 ConversationActor
→ PiConnection attach observer 并分配 focusId
→ state + role/project snapshot + focused conversation snapshot
```

`recent` 优先使用 manifest 中仍存在的 `lastConversationId`，否则使用索引中最近修改的对话；项目没有对话时保持空态并显示角色选择页，不创建隐含 default 会话。

显式 `open` 只接受浏览器从服务端索引获得的 conversationId。服务端重新列举受控目录并解析文件路径，不能接受客户端文件路径。Pi 的 `open(nonexistent)` 会创建 manager 而不是可靠报错，所以必须先证明目标存在。

删除同样只接受 conversationId，并遵守 actor 边界：

- busy conversation 不可删除，必须先精确 abort 并等待 run 结算；Agent 永远不能删除自己的 conversation。
- 已打开的 idle actor 把当前 writer lease 在 registry 内原子升级为 deletion lease；未打开目标先 fail-fast 取得独占 lease。升级、精确 unlink 和索引刷新之间不能出现 release/reacquire 窗口。
- 删除与索引刷新共用同一串行队列。服务端完整校验 sessions 目录、由 ID 解析内部常规 JSONL、复验 header identity，再执行精确单文件 `unlink`；不级联 parent/child 会话。
- 删除只清理 `toConversationId` 等于目标的 pending inbox；目标此前发往其他会话的 outbound envelope 不随来源删除。
- `lastConversationId` 只在仍等于目标时清除，避免覆盖另一连接刚提交的最近对话。删除成功后更新派生缓存并通过项目订阅发布新 snapshot。
- 删除不存在的干净目标是幂等成功；目录损坏、链接、身份错配或文件系统拒绝删除仍 fail closed。

Project store handle 按 canonical cwd 引用计数；ProjectSessionCoordinator 在项目 actor 生命周期内保留一个共享 handle，socket server 关闭时统一释放。registry 末次 release 后逐出 store；相同路径随后代表一个新项目时必须重新读取磁盘身份，不能让缓存反向覆盖项目生命周期。

## Conversation profile 与 reserved entries

新对话在 header 后、AgentSession 创建前写唯一 `piweb.conversation_meta.v1`：

- 完整角色 `id/revision/name/description/systemPrompt/model`；
- `normal` 或 `temporary` lifecycle；
- `user` 或来源 conversation 的 `createdBy`。

同一 JSONL 还可包含：

- `piweb.conversation_card.v1`：发送方可见的 outgoing/委派状态；
- `piweb.conversation_message.v1`：进入目标 LLM context 的 incoming 消息；
- `piweb.run_settlement.v1`：精确 run outcome、final text 与临时回传报告标记；
- `piweb.meta_operation.v1`：破坏性 meta 工具的 started/completed 幂等状态；
- `piweb.compaction_threshold.v1`：当前会话 20%–90% 的自动压缩阈值，缺省为 70%，最后一条单调时间记录生效。

这些类型由宿主拥有。重复 profile、冲突 settlement、方向变化、未知 `piweb.*` 类型或畸形 payload 都 fail closed。卡片以同 `cardId` 的最后状态投影；其来源/目标/正文/委派身份/request fingerprint/冻结角色不可变化，状态和时间只能单调前进，runId 一旦出现即固定，terminal outcome/result 不可改写。settlement 单调从未报告推进到已报告。

旧 JSONL 第一次由 coordinator 在 writer lease 下正式打开时追加独立“旧会话” profile：system prompt 为空，模型优先取旧分支模型，否则取任一现存角色模型；它不依赖或重建初始化模板。

## 持久 inbox 与恢复

`.piweb/inbox/<messageId>.json` 是严格 v1 sidecar，只允许常规项目路径；单条正文、每项目/目标消息数和总字节都有硬上限。

- 发送方先追加 `sending` 卡片，再原子提交 envelope，最后追加同 cardId 的 `queued` 状态；持久接收发生在目标处理之前。
- busy 目标不会被插入当前 branch。idle 后 inbox pump 把 envelope 标为 `processing`，追加 incoming `custom_message` 并用确定 runId 启动 actor。
- run settlement durable 后，pump 先把发送方卡片推进到 completed/failed/aborted，再删除 sidecar；崩溃时残留 sidecar 用于恢复对账。
- wait 总是先查 JSONL settlement，再订阅内存 completion，避免注册前已经完成而永久错过。
- 启动恢复会扫描全部 sidecar、profile 和 settlement：修复 inbox 已提交而来源卡片仍是 sending 的窗口，恢复 processing batch，继续临时回传，并只执行尚未 settled 的 run。
- 临时 conversation 只观察 metadata 中的 `initialRunId`。成功且有 final text 时先 durable enqueue caller、标记 settlement 已报告，再自动删除；失败、中止或无回复同样回传失败，但保留目标并标记 attention。
- 删除 conversation 先持久化目标 tombstone、终结并删除该目标的 pending envelope，再删除 JSONL；事务中的后到消息明确失败，已发往别处的 outbound envelope 不受影响。删除完成后回收 tombstone，重启时也会安全清理“目标已不存在且无 pending”的残留标记。
- tombstone 从磁盘恢复到内存 deleting set 后才允许 actor open/create 和 inbox pump；因此进程在删除中途退出也不能让目标短暂复活。持久删除失败时 fence 与 tombstone 保留，直到后续恢复真正完成。
- 恢复会在任何 inbox actor pump 前扫描 `piweb.meta_operation.v1`。若发现 started 但未 completed 的精确 abort intent，会先中止仍匹配的活动 run，或把崩溃中断的 processing run 结算为 aborted，再完成来源卡片/sidecar/ledger 对账。
- inactive `peek_session` 的短暂 writer lease 也进入项目 lifecycle 串行边界；若同一目标同时删除，先开始者完整释放 lease 后后一个才进入 tombstone/deletion lease 阶段。

详细编排语义见 [kb-agent-collaboration.md](kb-agent-collaboration.md)。

## Pi SessionManager 边界

- 使用项目自有的 custom `sessionDir`；不能依赖 Pi 默认 cwd 编码目录作为 project key。
- 列举使用 `SessionManager.listAll(sessionDir)`，避免项目移动后被旧 header cwd 过滤；但不能信任它的完整性，因为 SDK 会静默跳过部分损坏文件。
- 每次索引刷新都先后快照受控目录中的全部常规 `.jsonl`，目录在 SDK 扫描期间变化会 fail closed。宿主完整读取每个文件，验证尾换行、逐行 JSON、有限数值、header identity，以及经 Pi 内存迁移后的 entry payload / tree 引用；随后要求 SDK 索引与该磁盘全集按规范路径和 ID 精确一一对应。
- 打开时第三个参数传当前 canonical cwd；JSONL header 保留原 cwd，运行态使用新位置。旧会话允许 header cwd 缺失或为空，但存在时必须是字符串。
- 新 Pi manager 默认要到首条 assistant 消息才创建文件。工作台一次写入合法 header 和 conversation metadata 后丢弃 pending manager，再用公开 `open()` 重开。
- `SessionManager` 没有 flush/close/fsync，也没有内建锁；正常 append 是同步 JSONL 写入。
- SDK 打开旧格式时可能原地迁移，因此 writer lease 必须先于 `open()`。
- coordinator 打开已有对话时最多等待旧 writer lease 5 秒；等待队列 FIFO 且可取消。actor singleflight 确保浏览器和 Agent 不会因并发 open 获得第二个 writer。
- `open()` 前宿主再次验证文件非空、以换行结束、每条非空 JSONL 可解析、所有数值有限、首 header 身份匹配，并且 entry ID 唯一、parent/label 引用有效、compaction 保留点属于当前分支祖先链。branch summary 可引用已有节点，或使用 Pi 合法的 `parentId=null + fromId=root` 哨兵。crash partial tail 或“合法 JSON、非法 Pi entry”都会 fail closed，不能被 SDK 静默跳过或恢复成空历史。
- 第一版只有进程内租约；跨进程文件锁尚未实现。

## 项目权限模式

`toolMode` 属于项目 manifest，不属于浏览器或单次 AgentSession：

- `initialize(toolMode=read_only)` 是安全 ceiling，可收紧持久模式。
- `initialize(toolMode=full_access)` 不能扩大已持久的 read_only。
- 权限扩大只能通过当前 session 的 `set_tool_mode`，成功原子落盘后再由 state 确认。
- run 在入队/启动时捕获模式；项目后来收紧会立即生效，后来放宽不会扩大已经排队的 run。
- `ProjectRunCoordinator` 在 read_only 转换开始时同步阻止新 run、取消同项目所有旧 run，并等这些 run 释放项目 run lease 后才落盘和确认只读。UI 收到 read_only 时，旧 full-access run 已经结算。

`.piweb` 是宿主持久目录。Agent 在 read_only 中不能写入，但宿主保存 transcript 不受只读模式影响；full_access 不额外保护该目录。

## 浏览器投影

持久真相不直接等于网络载荷：

- `PublicState` 是高频、小体积运行状态。
- `role_catalog_snapshot` 是低频用户角色目录及当前可用性。
- `project_snapshot` 是低频扁平会话索引，包含固化 role 摘要、activity、attention 和 temporary；后台 actor 变化不会切换 current focus。
- `conversation_snapshot` 是当前 focus 的一次性 active-branch 投影，包含固化角色和 message/session-message discriminated items，并限制总字节以及单消息/tool/card payload。
- `truncated=true` 只表示 UI 投影省略；不会删除 JSONL。
- live run 仍按 runId 发送增量，卡片按 cardId upsert；恢复时 reducer 用 snapshot 原子 hydrate。两者都必须匹配 `sessionId + conversationId + focusId`，匹配快照到达前 composer 保持禁用。

## 故障语义

- actor 创建、extension activation 或固定模型校验失败时必须 dispose 新 runtime、释放 lease，并清理半创建 conversation。
- focus change/reinitialize/disconnect 只使浏览器观察 epoch 和 UI route 失效；后台 run 与 actor 保留。真正 server close 才统一取消、settle、dispose 并释放 conversation lease。
- 项目清单无效、状态目录是链接、JSONL 是链接、日志截断/损坏、非有限 JSON 数值、畸形 entry/tree、Pi 索引遗漏/错配或身份在 open 时变化都会 fail closed，原文件不被“修复”覆盖，也不能静默回退到另一条 recent 对话或新建对话。
- 断线不会停止 coordinator-owned run；重连用新 sessionId/focusId 重新观察同一 conversation，并从 durable JSONL hydrate。
- `lastConversationId` 只是恢复提示；索引是派生状态，丢失/陈旧时可从 sessionDir 重建。

## 当前边界

- 没有 archive、批量删除、fork/import、附件和跨设备同步；Agent 会话列表只有有界 cursor，不构成浏览器历史分页。
- 每次索引刷新会由宿主完整验证该项目全部 JSONL，并由 Pi `listAll()` 再扫描一次；这是第一版用完整性换简单性的选择。长期项目需要在引入分页时一并设计增量 catalog 和等价的完整性证明。
- 没有跨进程 writer lock 和断电级 durability。
- Pi JSONL header eager materialization 依赖锁定 SDK 的 v3 session format；升级 SDK 时必须用测试验证 header/open/list 行为。
- `.piweb` 可能包含敏感内容；Git 忽略策略由项目所有者决定。

## 入口

- `src/server/project-store.ts`
- `src/server/session-file.ts`
- `src/server/project-snapshot.ts`
- `src/server/conversation-history.ts`
- `src/server/conversation-meta.ts`
- `src/server/project-inbox.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/role-store.ts`
- `src/server/pi-service.ts`
- `src/server/pi-runtime.ts`
- `src/shared/protocol.ts`
- `src/client/App.tsx`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-tool-policy.md](kb-tool-policy.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
