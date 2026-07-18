# 项目与持久会话

`updated: 2026-07-19`

## 这个模块是干什么的

项目存储层让工作台状态跟工作目录移动，而不是跟浏览器、WebSocket 或服务进程走。它只持有项目清单和 Pi 对话；API Key 仍由 Pi 全局 `AuthStorage` 管理。

## 身份与生命周期

```text
projectId       durable，来自 .piweb/project.json
conversationId  durable，来自 Pi JSONL header
sessionId       ephemeral，一次 PiConnection bundle epoch
runId           ephemeral，一次 prompt
```

四者不能复用：

- 项目移动保留 projectId 和 conversationId。
- 项目复制可能复制这两个 durable ID，因此进程内租约按 `canonical cwd + conversationId` 键控，不能只按 projectId。
- 重连或切换对话会创建新的 sessionId，用它隔离迟到状态。
- 每次 prompt 使用新的 runId。

## 磁盘布局

```text
<canonical cwd>/.piweb/
  project.json
  sessions/
    <timestamp>_<conversationId>.jsonl
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
→ ProjectStoreRegistry.acquireProject()
→ 校验 .piweb 与 sessions 不是 symlink/junction
→ refreshConversations()，枚举并验证全部 JSONL，再与 SessionManager.listAll(custom sessionDir) 一一核对
→ 选择 new / recent / exact open
→ 在 open 前取得/等待 conversation writer lease
→ SessionManager.create/open(..., current cwd override)
→ PiRuntime 两阶段创建 services 和 AgentSession
→ commit ActiveSession bundle
→ state + project_snapshot + conversation_snapshot
```

`recent` 优先使用 manifest 中仍存在的 `lastConversationId`，否则使用索引中最近修改的对话；项目没有对话时新建。

显式 `open` 只接受浏览器从服务端索引获得的 conversationId。服务端重新列举受控目录并解析文件路径，不能接受客户端文件路径。Pi 的 `open(nonexistent)` 会创建 manager 而不是可靠报错，所以必须先证明目标存在。

删除同样只接受 conversationId，并遵守 Pi 的活动会话边界：

- 当前 active conversation 不可直接删除；用户先新建或切换，确保旧 AgentSession 已 dispose 并释放 writer lease。
- 非当前目标先 fail-fast 取得 `canonical cwd + conversationId` 独占 lease；另一窗口仍在使用时明确失败，不等待后突然删除。
- 删除与索引刷新共用同一串行队列。服务端完整校验 sessions 目录、由 ID 解析内部常规 JSONL、复验 header identity，再执行精确单文件 `unlink`；不级联 parent/child 会话。
- `lastConversationId` 只在仍等于目标时清除，避免覆盖另一连接刚提交的最近对话。删除成功后更新派生缓存并通过项目订阅发布新 snapshot。
- 删除不存在的干净目标是幂等成功；目录损坏、链接、身份错配或文件系统拒绝删除仍 fail closed。

Project store handle 按 canonical cwd 引用计数；最后一个活动 bundle 或初始化释放 handle 后，registry 会逐出内存 store。相同路径随后代表一个新项目时必须重新读取磁盘身份，不能让服务进程缓存反向覆盖项目生命周期。

## Pi SessionManager 边界

- 使用项目自有的 custom `sessionDir`；不能依赖 Pi 默认 cwd 编码目录作为 project key。
- 列举使用 `SessionManager.listAll(sessionDir)`，避免项目移动后被旧 header cwd 过滤；但不能信任它的完整性，因为 SDK 会静默跳过部分损坏文件。
- 每次索引刷新都先后快照受控目录中的全部常规 `.jsonl`，目录在 SDK 扫描期间变化会 fail closed。宿主完整读取每个文件，验证尾换行、逐行 JSON、有限数值、header identity，以及经 Pi 内存迁移后的 entry payload / tree 引用；随后要求 SDK 索引与该磁盘全集按规范路径和 ID 精确一一对应。
- 打开时第三个参数传当前 canonical cwd；JSONL header 保留原 cwd，运行态使用新位置。旧会话允许 header cwd 缺失或为空，但存在时必须是字符串。
- 新 Pi manager 默认要到首条 assistant 消息才创建文件。工作台为“空对话立即可见”预写合法 header 后丢弃 pending manager，再用公开 `open()` 重开。
- `SessionManager` 没有 flush/close/fsync，也没有内建锁；正常 append 是同步 JSONL 写入。
- SDK 打开旧格式时可能原地迁移，因此 writer lease 必须先于 `open()`。
- 重连打开已有对话时最多等待旧 writer lease 5 秒；等待队列 FIFO 且随 initialize/connection 的 AbortSignal 取消。真正的并发 writer 不会因重连而被绕过。
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
- `project_snapshot` 是低频会话索引，最多投影最近 200 项，并裁剪名称/预览。
- `project_snapshot` 即使截断也保留当前 active conversation，使设置抽屉始终能定位正在观察的对话。
- `conversation_snapshot` 是恢复时的一次性 active-branch 投影，限制总字节以及单消息/tool payload；截断按完整 user/assistant 回合装箱，不生成孤立 assistant。
- `truncated=true` 只表示 UI 投影省略；不会删除 JSONL。
- live run 仍按 runId 发送增量，恢复时 reducer 用 snapshot 原子 hydrate；匹配快照到达前 composer 必须保持禁用。

## 故障语义

- initialize、extension activation 或 stale generation 失败时必须 dispose 新 runtime 并释放 lease。
- close/reinitialize/disconnect 先使 epoch 失效和取消 run，再串行 dispose bundle；conversation lease 和 project handle 即使 dispose 失败也会结算。
- 项目清单无效、状态目录是链接、JSONL 是链接、日志截断/损坏、非有限 JSON 数值、畸形 entry/tree、Pi 索引遗漏/错配或身份在 open 时变化都会 fail closed，原文件不被“修复”覆盖，也不能静默回退到另一条 recent 对话或新建对话。
- 断线会停止当前 run；此前 Pi 已 append 的 transcript 保留，重连用新 sessionId 打开同一 conversation。
- `lastConversationId` 只是恢复提示；索引是派生状态，丢失/陈旧时可从 sessionDir 重建。

## 当前边界

- 没有分页、archive、批量删除、fork/import、附件和跨设备同步。
- 每次索引刷新会由宿主完整验证该项目全部 JSONL，并由 Pi `listAll()` 再扫描一次；这是第一版用完整性换简单性的选择。长期项目需要在引入分页时一并设计增量 catalog 和等价的完整性证明。
- 没有跨进程 writer lock 和断电级 durability。
- Pi JSONL header eager materialization 依赖锁定 SDK 的 v3 session format；升级 SDK 时必须用测试验证 header/open/list 行为。
- `.piweb` 可能包含敏感内容；Git 忽略策略由项目所有者决定。

## 入口

- `src/server/project-store.ts`
- `src/server/session-file.ts`
- `src/server/project-snapshot.ts`
- `src/server/conversation-history.ts`
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
