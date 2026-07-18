# Pi Web Agent Guide

## 项目目标

Pi Web 是本机优先的极简 Agent 工作台。当前目标不是复制 Pi 或 OpenCode 的全部功能，而是保持一个可用、可测试、能逐步扩展的工作台基座。

- 复用 Pi SDK 的模型、认证、工具和 Agent 循环。
- 工作台拥有自己的稳定协议、会话生命周期和 UI 投影。
- 默认只监听 loopback；不要把当前安全模型扩展到远程访问。
- 项目身份、工具模式和 Pi JSONL 对话由项目内 `.piweb/` 持久化；OS 级隔离仍是后续能力。

代码标识使用英文；面向用户和项目知识页优先使用中文。

## 必读顺序

1. 本文件。
2. [`.knowledge/INDEX.md`](.knowledge/INDEX.md)。
3. 与任务相关的 `kb-*.md`。
4. 修改行为前再读对应源码、测试和 `docs/plans/` 中的历史设计。

## 架构硬边界

- `src/shared/protocol.ts` 是浏览器与服务端的唯一线协议；浏览器不得导入 Pi SDK 事件类型。
- `PiRuntime` 进程级共享 `AuthStorage` 与基线 `ModelRegistry`，每个 session 另有隔离的模型目录；所有认证/模型缓存修改必须从串行入口经过。
- 项目扩展可以注册工具、hooks 和静态 provider 配置；在引入 worker/进程隔离前，必须拒绝进程全局的 `streamSimple` 与 OAuth provider 注册。
- 允许的 provider 配置必须先深快照再交给 SDK，不能保留扩展传入的可变对象引用。
- `ProjectStoreRegistry` 按 canonical cwd 在活动 handle 生命周期内复用项目 store，末次 release 后逐出；`.piweb/project.json` 是 durable manifest，`.piweb/sessions` 是受控 Pi sessionDir。
- `PiConnection` 原子持有一个 session bundle：`sessionId + project handle + conversationId + SessionManager + writer lease + settings + modelRegistry + AgentSession + dispose + unsubscribe`。
- `projectId`、`conversationId`、`sessionId` 和 `runId` 属于不同生命周期，禁止合并或互相替代。
- 同一进程内一个 `canonical cwd + conversationId` 只能有一个 writer lease；租约必须在 Pi `open()` 前取得，并在所有失败/关闭路径释放。
- 已有对话重连可有界等待旧 lease；等待必须 FIFO、可取消，不能通过第二个 writer 解决。
- 项目切 read_only 必须经过共享 `ProjectRunCoordinator`：同步封锁/取消旧 run，等它们结算后才能持久化和确认。
- 浏览器不是 transcript owner；恢复必须从服务端 `conversation_snapshot` hydrate，localStorage 只保存目录和安全偏好。
- 客户端收到匹配的 history snapshot 前不得发送 prompt；state 提交和历史恢复是两个观察边界。
- 普通会话操作串行执行；`abort`、认证响应、认证取消和生命周期失效走控制通道，session dispose 排回 actor 队列。
- 所有 session command/state/event 都带 `sessionId`；run command/event 还带 `runId`。客户端必须丢弃不匹配的身份。
- OAuth 命令与事件都带 `authFlowId`；取消必须覆盖 active 和尚在 actor 队列中的 flow。
- SDK 事件只能在服务端 `SessionEventProjector` 内转换成工作台事件。
- 不要直接开放 `AgentSession.reload()`；扩展 hook 当前与服务进程同生死，真正的超时/崩溃隔离属于 worker runtime。
- `PiConnection.activeRun` 是 queued/running/cancelling 的唯一服务端真相；`PublicState.busy` 只能由它派生，聊天 reducer 不维护第二份 busy。
- 工具授权必须位于项目扩展 `tool_call` hook 之后、真实 `tool.execute` 之前；响应必须走控制通道，不能排进 prompt 正占用的 actor 队列。
- 待审批项只从 `PublicState.activeRun.pendingApprovals` 投影；浏览器弹窗和工具卡都不是授权真相。
- 工具 gate 启用时固定使用 sequential execution，避免 SDK parallel preflight 在 abort 后执行已积累的 thunk。
- `read_only` 是服务端硬拒绝；`workspace_write` 只自动允许 `source=builtin` 且真实目标仍在 cwd 内的 `edit/write`。扩展可以覆盖内置名称，策略不能只按 toolName 判断。
- `.piweb` 是宿主保留状态，即使在 `workspace_write` 中也不得由 Agent `edit/write`；只读模式不阻止宿主持久化。
- 项目列表和历史是低频、有界协议快照，不能重新塞回每个高频 `PublicState` 更新。

## Agent 分工

主 Agent：

- 先还原运行循环、状态所有权和跨模块影响，再修改代码。
- 保留用户已有未提交改动；不要顺手整理无关文件。
- 对竞态、生命周期和协议变更先写最小反例测试。
- 完成后同步相关知识页，但不要写入短期任务进度。

子 Agent：

- 默认只读分析，除非任务明确授权编辑。
- 返回具体文件、行号、反例和验证证据。
- 不重复主 Agent 已分配给其他人的范围。

## 工具与修改习惯

- 搜索优先使用 `rg` / `rg --files`。
- 文件修改使用 `apply_patch`。
- 保持改动小而可验证；不为尚未确认的功能预建抽象。
- 新增或重命名知识页时，同步 `.knowledge/INDEX.md`。

## 完成门槛

代码变更至少运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

涉及 WebSocket 的集成测试需要允许监听临时的 `127.0.0.1` 端口。涉及 UI 行为时，还应覆盖对应组件测试；涉及生产启动时，再验证 `/health` 和一次浏览器主流程。
