# Meta Agent 协作实施计划

> 先完成反例测试与 actor 所有权重构，再接入工具和 UI。每一阶段都保持可运行，禁止用隐藏 PiConnection 或 SDK followUp 冒充项目级并行会话。

## 验收目标

用户可以在一个项目中：

1. 管理固定 default 在内的角色目录；
2. 显式选择角色创建不可变角色会话；
3. 在可收缩扁平左栏观察多个会话并自由切换焦点；
4. 让 Agent 自行查看、创建、并行、等待、互发消息、中止和删除其他会话；
5. 使用临时模式自动回传成功结果并清理；
6. 在失败、中止、断线和重启后得到明确、可恢复的结果。

最终必须通过：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

并完成 `/health`、浏览器主流程和真实多 Agent dogfood。

---

## Task 1：锁定协议 DTO 与失败边界

**修改：**

- `src/shared/protocol.ts`
- `src/shared/protocol.test.ts`

**步骤：**

1. 先写失败测试：
   - new conversation 缺 roleId 被拒绝；
   - 项目空态可表达；
   - role catalog/CRUD 精确回执；
   - project summary 含 role/activity/temporary/attention；
   - history discriminated item 与 live transcript item；
   - stale/wrong identity frame 被拒绝；
   - `A → B → A` 的迟到 snapshot 因 focusId 不匹配被拒绝。
   - role catalog、project snapshot 与 conversation snapshot 在合法最坏输入下仍有明确帧预算，客户端命令仍保持独立 1 MiB 上限。
2. 升级协议版本。
3. 定义 `RoleSummary`、`ConversationRoleSnapshot`、`ConversationActivity`、`ConversationHistoryItem` 和卡片 DTO。
4. 扩展 acknowledged operation，保持 commandId 不可复用。
5. 让 project snapshot 同时限制条数、字段和总字节；当前/活跃/attention/unread 会话优先保留，卡片可达性使用独立必填三态 `peerPresence`（`present | absent | unknown`），不依赖被截断侧栏；同步投影先为 `unknown`，只有完整稳定 header census 才能解析为 `present/absent`。
6. 运行 `npm test -- src/shared/protocol.test.ts` 与 typecheck。

**成功标准：** 浏览器需要的所有状态都有唯一身份和有界 schema；没有 SDK event 类型泄漏。

---

## Task 2：实现用户级 RoleStore

**新增：**

- `src/server/role-store.ts`
- `src/server/role-store.test.ts`

**修改：**

- `src/server/pi-runtime.ts`
- `src/server/pi-runtime.test.ts`

**步骤：**

1. 写失败测试覆盖：
   - 首次创建固定 default；
   - default 不可删除但可编辑；
   - revision 单调增加；
   - 角色数和字段字节上限；
   - 损坏、未知字段、未知版本 fail closed；
   - 并发保存串行且原子；
   - 角色模型可用性由当前 registry 计算，不持久伪造。
2. 在 `<agentDir>/piweb/roles.json` 实现严格、原子、可订阅的角色目录。
3. 首次 default 选择当前默认或首个可用模型；无模型时保留 null。
4. 将 RoleStore 作为 socket server 进程级共享依赖。
5. 增加不创建隐藏 AgentSession 的项目模型目录：在空项目也经过 trust resolution 加载项目静态 provider，并纳入认证刷新与 coordinator 生命周期；无 focus 时按“存活 actor → 项目目录 → 进程基线”选择 registry。
6. 运行 focused tests 与 typecheck。

**成功标准：** 项目文件不能修改用户角色库；模板更新不会触碰 conversation。

---

## Task 3：定义 reserved JSONL 元数据与持久 inbox

**新增：**

- `src/server/conversation-meta.ts`
- `src/server/conversation-meta.test.ts`
- `src/server/project-inbox.ts`
- `src/server/project-inbox.test.ts`

**修改：**

- `src/server/session-file.ts`
- `src/server/session-file.test.ts`
- `src/server/project-store.ts`
- `src/server/project-store.test.ts`

**步骤：**

1. 写失败测试覆盖 reserved conversation metadata、card、message 和 settlement 的严格 schema。
2. 让 session validator 一次解析返回：
   - conversationId；
   - role/lifecycle snapshot；
   - delivered message IDs；
   - run settlements；
   - host lastActivityAt。
3. 新 conversation 在 header 后、AgentSession 创建前写唯一 role metadata。
4. legacy conversation 只在正式 open 且持有 lease 时追加一次空 prompt/default snapshot。
5. 实现 `.piweb/inbox/<messageId>.json` 原子 sidecar：
   - 常规目录/文件检查；
   - 容量上限；
   - 幂等同 payload；
   - 相同 ID 不同 payload 拒绝；
   - target 删除 tombstone；
   - JSONL 对账恢复。
6. 发送前预分配 `messageId + cardId`，用 `sending → queued/delivered/failed` reserved card journal；恢复时修复 inbox 已提交但发送方状态缺失的窗口。
7. 新增不修改 `lastConversationId` 的 inspection API。
8. 为 registry 增加 writer lease → deletion lease 的原子升级；直到精确 unlink 与索引刷新后才释放。
9. 删除 conversation 时只清理以其为目标的 pending inbox/metadata，保留已经发往其他会话的 outbound/temporary return envelope。
10. 运行相关 server tests 与 typecheck。

**成功标准：** busy 目标的 durable custom steering 不创建第二个 run；重启后 pending envelope 可恢复且不重复。

---

## Task 4：让 PiRuntime 接受固定角色运行参数和宿主工具

**修改：**

- `src/server/pi-runtime.ts`
- `src/server/pi-runtime.test.ts`
- `src/server/tool-policy.ts`
- `src/server/tool-policy.test.ts`

**步骤：**

1. 先写失败测试：
   - direct factory 与 two-phase factory 都收到固定 model/customTools；
   - 角色 prompt 在保留项目 append prompt 后追加；
   - model 无认证或 SDK fallback 时 teardown 并失败；
   - meta tool 保持 active；
   - extension 同名工具不能冒充宿主 identity；
   - read_only 不被静默扩大。
2. 扩展 `CreatePiSessionOptions`：
   - explicit model；
   - role system prompt；
   - workbench custom tools；
   - tool class identity。
3. 两条 session factory 路径都传入相同参数。
4. 创建后校验实际模型与 role snapshot 完全一致。
5. 保留 extension hook → stable JSON freeze → host gate 的顺序。
6. 运行 focused tests 与 typecheck。

**成功标准：** 每次 actor 重开都恢复相同 prompt/model/tools，不能静默回退。

---

## Task 5：从 PiConnection 提取 ConversationActor

**新增：**

- `src/server/conversation-actor.ts`
- `src/server/conversation-actor.test.ts`

**修改：**

- `src/server/pi-service.ts`
- `src/server/pi-service.test.ts`
- `src/server/project-run-coordinator.test.ts`

**步骤：**

1. 先把现有 `ActiveSession`、`RunTicket`、prompt、abort、SDK event projector、tool gate、dispose 反例迁入 actor 测试，行为保持不变。
2. actor 原子持有：
   - profile；
   - SessionManager/lease；
   - CreatedPiSession；
   - activeRun；
   - queue/control channel；
   - observers。
3. browser prompt、inbox custom message 都必须先同步安装唯一 run ticket，再进入 actor queue。
4. 增加 `waiting` phase，但不增加第二份 busy。
5. 显式 wait 通过 active run ownership token 做 `running → waiting(target, runId) → running`，所有异常/取消走 `finally`，过期 token 不得复活 settled run。
6. finish 顺序：
   - 生成精确 completion；
   - 追加 durable settlement；
   - 释放 ProjectRunLease；
   - 发布 terminal；
   - 通知 coordinator。
7. detach observer 不能 abort actor；dispose 才取消并释放 writer lease。
8. 确认 read_only barrier 同时覆盖用户与 Agent 发起的 run。
9. 运行 actor、pi-service、run-coordinator tests。

**成功标准：** conversation 生命周期不再依附 WebSocket；所有旧 run/lease 安全测试继续通过。

---

## Task 6：实现 ProjectSessionCoordinator 与 meta tools

**新增：**

- `src/server/project-session-coordinator.ts`
- `src/server/project-session-coordinator.test.ts`
- `src/server/meta-tools.ts`
- `src/server/meta-tools.test.ts`

**修改：**

- `src/server/pi-service.ts`
- `src/server/socket-server.ts`
- `src/server/socket-server.test.ts`

**步骤：**

1. 先写最小反例测试：
   - 来源工具内 start target 不重入来源 queue、不死锁；
   - 同一 conversation 并发 open singleflight；
   - 浏览器 attach 活跃 target 复用 actor/lease；
   - wait observe-or-subscribe 无 missed completion；
   - send 与 finish 线性化；
   - send/delete、run/delete 线性化；
   - wrong runId abort 不影响新 run；
   - self delete 拒绝；
   - server close 同步封闭并排空 lifecycle queue，关闭后没有迟到持久写；
   - inactive peek 与 delete 串行，不因短暂 inspection lease 留下 tombstone；
   - server close 清理 detached actor。
2. coordinator 按 canonical cwd + conversationId 管理 actor。
3. 实现 cancellable waiters 和 bounded completion cache；每次 wait 都先查目标 JSONL 的 durable settlement，缓存不能成为真相。
4. inbox pump 在 target idle 时批量投递并用新 runId 启动；busy target 则先持久 claim 到精确 runId，再以 custom steering 注入当前 run。
5. 实现 9 个 custom tools，闭包绑定 source actor token。
6. 每个 meta side effect 用 source conversation + toolCallId 幂等。
7. start_session 先持久保存冻结角色 + 初始 task + 确定 runId 并可靠调度；目标空闲时安装同一 ticket，若被更早 run 占用则保留待泵送；返回绝不隐式 wait。
8. 让 socket server 共享 coordinator，并在 close 时等待全部 actor dispose。
9. 运行 focused tests 与 typecheck。

**成功标准：** 浏览器和 Agent 调用同一 service；不存在隐藏连接、第二 writer 或工具重入。

---

## Task 7：完成消息回传、临时生命周期和恢复

**修改：**

- `src/server/project-session-coordinator.ts`
- `src/server/project-session-coordinator.test.ts`
- `src/server/project-inbox.ts`
- `src/server/conversation-history.ts`
- `src/server/conversation-history.test.ts`
- `src/server/session-events.ts`
- `src/server/session-events.test.ts`

**步骤：**

1. 写失败测试：
   - busy 目标在当前工具调用后、下一次模型请求前收到 durable custom steering，且不创建第二个 run；
   - steering claim 在 abort、断线或重启前未写 incoming marker 时按 FIFO 重投；
   - pre-stream steering 不阻塞项目 lifecycle close；异步 acceptance rejection 触发 tracked reopen/recovery；同步 dispatch rollback 保留 delivery discriminator；
   - 精确 wait 回复不越过满批次后的 predecessor；消息先于 wait 注册时由 durable `fromRunId` 补查，`waitedByRunId` receipt 防止重复观察；cycle check+add 原子化，任一注册后异常都 remove+detach；sender-card append 失败也必须结算 waiter；
   - 临时结果/失败对 busy caller 同样 steering，等待 initial run 时正文只通过尚未 receipt 的 incoming message 输入一次；reported return 已消费/清理后的再次 wait 返回 settlement；旧 v1 缺失 `fromRunId` 的 temporary crash replay 不冲突；
   - idle 后一批 inbox 只启动一次新 run；
   - append/sidecar crash window 不重复；
   - inbox 已提交但 sender queued card 缺失时恢复会补写同 cardId；
   - temp success 先 enqueue caller 再 delete；
   - return envelope 提交后 source 被删也不会丢失；
   - enqueue 失败不 delete；
   - failed/aborted/no assistant 只回报一次且保留；
   - 初始 run 失败后，后续成功 run 不触发旧 temporary cleanup；
   - 返回文本来自精确 run settlement；
   - 同 cardId hydrate/live 原地更新。
2. incoming envelope 使用 reserved custom_message；outgoing/delegation 使用 custom。
3. history projector 输出 discriminated items，并隐藏 thinking/auth/internal details。
4. SessionEventProjector 暴露本 run 精确最终文本，不从会话尾部猜测。
5. coordinator 启动时恢复 pending inbox、sender card journal，以及只绑定 initialRunId 的 temporary 单调状态机。
6. 运行 focused tests 与 typecheck。

**成功标准：** 消息、wait 和临时回传在断线/重启后仍有明确且不重复的结果。

---

## Task 8：把 PiConnection 改为项目观察与焦点控制

**修改：**

- `src/server/pi-service.ts`
- `src/server/pi-service.test.ts`
- `src/server/socket-server.ts`
- `src/server/socket-server.test.ts`
- `src/shared/protocol.ts`

**步骤：**

1. 写失败测试：
   - empty recent 返回项目空态，不创建默认 conversation；
   - 切换焦点不 abort 原 actor；
   - 后台 actor 事件更新 project snapshot，但不作为当前 transcript event；
   - stale observer epoch 丢弃；
   - `A → B → A` 只接受第二次 A 的 focusId；
   - background attention 可关联并回答；
   - delete 当前观察的 idle target 后安全回到角色选择页。
   - Agent、其他连接或临时清理删除当前 focus 时，精确 `focus_invalidated` 只清理匹配 focusId 的页面。
2. PiConnection 只持有 project view、focused actor subscription、认证 flow 和 extension UI routing。
3. initialize/open/new 通过 coordinator attach；new 必须 roleId；每次 attach 分配不复用 focusId，并以原 commandId 精确确认。
4. project snapshot 合并 durable summary、role profile 和 actor activity。
5. 角色 CRUD 通过 connection-global serial boundary 精确确认。
6. background extension UI 请求带 conversation identity 广播，不抢当前焦点。
7. 运行 pi-service/socket/protocol tests。

**成功标准：** 浏览器连接不再拥有 Agent 生命周期；切换观察和 Agent 并行互不干扰。

---

## Task 9：重构客户端项目状态与 transcript

**修改：**

- `src/client/App.tsx`
- `src/client/App.test.tsx`
- `src/client/chat/reducer.ts`
- `src/client/chat/reducer.test.ts`
- `src/client/lib/socket.ts`
- `src/client/lib/socket.test.ts`

**步骤：**

1. 写失败测试：
   - 项目已打开但无 conversation 时显示角色选择；
   - new 不发送命令，直到用户显式选择；
   - 只有匹配 create ack 才切焦点；
   - 后台创建/完成不改变当前 conversation、draft 或 transcript；
   - running 当前会话仍可切换；
   - project update 不按后台 conversationId 被错误过滤；
   - history card hydrate 与 live same-card update；
   - stale epoch/project frames 丢弃；
   - stale focusId 的 hydrate/live item 丢弃，即使 conversationId 再次相同。
2. 拆分服务端项目控制面与当前 transcript 投影。
3. `chatReducer` 使用 message/card discriminated union，并以 focusId 绑定 snapshot hydrate 与 live projection。
4. current focus 是本地用户意图；project activity 全部来自服务端。
5. 保持 run_queued 唯一 prompt 提交回执和 conversation snapshot hydrate gate。
6. 运行 focused client tests 与 typecheck。

**成功标准：** 后台 Agent 再活跃也不会抢走用户焦点或草稿。

---

## Task 10：实现角色选择、角色管理和不可变角色展示

**新增：**

- `src/client/components/RoleSelectionPage.tsx`
- `src/client/components/RoleSelectionPage.test.tsx`
- `src/client/components/RoleManagerDialog.tsx`
- `src/client/components/RoleManagerDialog.test.tsx`
- `src/client/components/ConversationRoleDialog.tsx`
- `src/client/components/ConversationRoleDialog.test.tsx`

**修改：**

- `src/client/components/Chat.tsx`
- `src/client/components/Chat.test.tsx`
- `src/client/components/ConnectionDrawer.tsx`
- `src/client/components/ConnectionDrawer.test.tsx`

**步骤：**

1. 先写组件测试：
   - default 置顶但未选；
   - 未选择时无 composer/不能开始；
   - unavailable role 标红；
   - default 不显示删除；
   - CRUD 只由精确 ack 结算；
   - 模型只列 configured + available；
   - 当前失效模型仍显示且不静默替换；
   - 会话底部显示固化快照，模板 rerender 不改变；
   - 详情无切换按钮。
2. 实现完整角色选择主页面。
3. 实现左列表/右编辑角色管理 dialog。
4. ConnectionDrawer 移除当前会话模型切换与旧 conversation list，保留认证/权限/角色入口。
5. Chat composer footer 增加角色 pill。
6. 运行 component tests 与 typecheck。

**成功标准：** 用户无法因忘记切角色而在错误身份中发送第一条消息。

---

## Task 11：实现扁平会话栏和会话消息卡片

**新增：**

- `src/client/components/ConversationSidebar.tsx`
- `src/client/components/ConversationSidebar.test.tsx`
- `src/client/components/SessionMessageCard.tsx`
- `src/client/components/SessionMessageCard.test.tsx`

**修改：**

- `src/client/components/Message.tsx`
- `src/client/components/Message.test.tsx`
- `src/client/components/Chat.tsx`
- `src/client/styles.css`
- `src/client/App.test.tsx`

**步骤：**

1. 写失败测试：
   - 列表永远扁平；
   - activity 排序与 spinner；
   - waiting 沙漏只来自显式 waiting；
   - activity 优先，再显示 attention；
   - temporary/unread；
   - collapse/expand；
   - running 时仍可导航；
   - 创建后台会话不切焦点；
   - 卡片 source/target/status/open；
   - temp success 删除后隐藏 open；
   - reduced motion 关闭 spinner animation。
2. 使用 `.workbench` 双栏布局；composer 相对 main pane，不再依赖 `100vw`。
3. 移动端侧栏改 overlay。
4. 消息卡片独立于 assistant Markdown 与普通 ToolCard。
5. 同一 cardId 原地更新。
6. 运行全部 client tests 与 typecheck。

**成功标准：** 用户能一眼看出谁在工作、谁在等待、谁需要处理，且不会看到伪层级。

---

## Task 12：知识页、全量验证和真实 dogfood

**修改：**

- `.knowledge/INDEX.md`
- `.knowledge/kb-wire-protocol.md`
- `.knowledge/kb-server-runtime.md`
- `.knowledge/kb-project-sessions.md`
- `.knowledge/kb-client-state.md`
- `.knowledge/kb-tool-policy.md`
- 必要时新增 `.knowledge/kb-agent-collaboration.md`
- `README.md`

**步骤：**

1. 更新长期稳定事实：
   - conversation actor 所有权；
   - role/inbox/settlement 格式；
   - meta tool 和权限边界；
   - 项目观察与焦点状态；
   - crash recovery 顺序。
2. 运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

3. 启动生产服务，验证 `/health`。
4. 使用真实已配置 provider/key 在浏览器完成：
   - 创建至少两个非默认角色；
   - 用户显式选择角色创建会话；
   - 主 Agent `list_roles/list_sessions/current_session`；
   - 主 Agent 创建两个后台普通会话并继续并行工作；
   - 一个显式 wait，一个通过主动消息回传；
   - busy target 收消息在当前工具调用后作为 durable steering 进入同一 run；
   - 临时成功回传并自动删除；
   - 临时 abort 回传失败并保留；
   - Agent abort 后 delete 另一个会话；
   - Agent 删除自身被拒绝；
   - 浏览器全程不被后台会话抢焦点。
5. 重启服务，再验证角色、会话卡片和 pending inbox 恢复。
6. 做一次 recently-modified-code 简化复核，删除只由本功能产生的重复和无用抽象。

**成功标准：** 自动测试、生产构建和真实多 Agent 主流程全部通过，用户可以直接在工作树中试用。
