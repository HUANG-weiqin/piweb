# Pi Web Agent Guide

## 项目目标

Pi Web 是本机优先的极简 Agent 工作台。当前目标不是复制 Pi 或 OpenCode 的全部功能，而是保持一个可用、可测试、能逐步扩展的工作台基座。

- 复用 Pi SDK 的模型、认证、工具和 Agent 循环。
- 工作台拥有自己的稳定协议、会话生命周期和 UI 投影。
- 只实现必须由工作台拥有的状态与控制语义；能被成熟外部工具完整替代的能力不重复建设。
- 默认只监听 loopback；不要把当前安全模型扩展到远程访问。
- 项目身份、工具模式和 Pi JSONL 对话由项目内 `.piweb/` 持久化；OS 级隔离仍是后续能力。
- 项目信任决定必须来自用户级 Pi trust store 或当前交互；项目内文件不能让项目自证可信。

代码标识使用英文；面向用户和项目知识页优先使用中文。

## 必读顺序

1. 本文件。
2. [`.knowledge/INDEX.md`](.knowledge/INDEX.md)。
3. 与任务相关的 `kb-*.md`。
4. 修改行为前再读对应源码、测试和 `docs/plans/` 中的历史设计。

## 架构硬边界

- 新功能先判断它是否必须参与 Agent 生命周期、权限决策、持久会话或协议关联；如果不需要，并且外部工具可以完整替代，就不进入工作台核心。
- Git 负责 diff、历史、回滚和分支；编辑器负责文件浏览与人工编辑；终端负责通用交互式 shell。工作台最多提供浅层交接，不维护第二份真相。
- `src/shared/protocol.ts` 是浏览器与服务端的唯一线协议；浏览器不得导入 Pi SDK 事件类型。
- initialize 前的只读目录浏览属于 socket control，不属于 PiConnection actor；必须用一次性 commandId 关联有界列表。浏览 `path` 不是项目 cwd，不得创建项目状态或触发资源加载；用户确认后仍由 initialize 独立校验。
- `PiRuntime` 进程级共享 `AuthStorage` 与基线 `ModelRegistry`，每个 session 另有隔离的模型目录；所有认证/模型缓存修改必须从串行入口经过。
- 项目扩展可以注册工具、hooks 和静态 provider 配置；在引入 worker/进程隔离前，必须拒绝进程全局的 `streamSimple` 与 OAuth provider 注册。
- 项目资源必须在 trust resolution 后加载；默认 `SettingsManager` 不得以 `projectTrusted=true` 启动。
- 允许的 provider 配置必须先深快照再交给 SDK，不能保留扩展传入的可变对象引用。
- `ProjectStoreRegistry` 按 canonical cwd 在活动 handle 生命周期内复用项目 store，末次 release 后逐出；`.piweb/project.json` 是 durable manifest，`.piweb/sessions` 是受控 Pi sessionDir。
- `PiConnection` 原子持有一个 session bundle：`sessionId + project handle + conversationId + SessionManager + writer lease + settings + modelRegistry + AgentSession + dispose + unsubscribe`。
- `projectId`、`conversationId`、`sessionId` 和 `runId` 属于不同生命周期，禁止合并或互相替代。
- 同一进程内一个 `canonical cwd + conversationId` 只能有一个 writer lease；租约必须在 Pi `open()` 前取得，并在所有失败/关闭路径释放。
- 已有对话重连可有界等待旧 lease；等待必须 FIFO、可取消，不能通过第二个 writer 解决。
- 删除只接受 conversationId：active conversation 必须拒绝，非当前目标必须 fail-fast 取得独占 writer lease，并在完整路径/identity 校验后精确 unlink 单个 JSONL；删除与索引刷新共用串行边界。
- Pi `SessionManager.listAll()` 不是完整性证明：宿主必须验证受控目录内全部常规 JSONL 的尾换行、有限 JSON 数值、header、经迁移后的 entry payload/tree，并要求磁盘全集与 SDK 索引按规范路径和 conversationId 一一对应；任何遗漏、损坏、重复或扫描期变化都 fail closed。
- 工具权限属于用户级角色模板，并在新 conversation 创建时冻结到角色快照；新角色和旧角色迁移默认 `read_only`，模板后续编辑不得改变已有会话。
- 浏览器不是 transcript owner；恢复必须从服务端 `conversation_snapshot` hydrate，localStorage 只保存目录和安全偏好。
- 客户端收到匹配的 history snapshot 前不得发送 prompt；state 提交和历史恢复是两个观察边界。
- `WebSocket.send()` 不是 prompt 提交点。只有匹配 sessionId + runId 的 `run_queued` 才能清空草稿并投影 user message；确认前断线必须保留草稿、恢复历史后提示核对，禁止自动重发。
- 普通会话操作串行执行；`abort`、认证响应、认证取消和生命周期失效走控制通道，session dispose 排回 actor 队列。
- 所有 session command/state/event 都带 `sessionId`；run command/event 还带 `runId`。客户端必须丢弃不匹配的身份。
- 会让界面等待配置结果的命令必须有精确关联身份；当前 API Key 与模型选择使用 sessionId + 连接内一次性 commandId，不能把任意 PublicState 刷新当作成功回执。
- Pi 的模型切换不是持久化事务：command success 以目标 model 已进入当前 AgentSession 为准，后续 session/settings 写入失败要单独报告，不能谎称运行态未切换。
- Pi 的 thinking/name setter 也有相同的“内存先变更”顺序；新增 SDK 状态 setter 接入前必须核对源码顺序并用后置条件测试覆盖部分提交。
- OAuth 命令与事件都带 `authFlowId`；取消必须覆盖 active 和尚在 actor 队列中的 flow。
- SDK 事件只能在服务端 `SessionEventProjector` 内转换成工作台事件。
- 不要直接开放 `AgentSession.reload()`；扩展 hook 当前与服务进程同生死，真正的超时/崩溃隔离属于 worker runtime。
- 扩展 UI 只桥接 `select/confirm/input/editor/notify`；响应是控制命令，必须按 sessionId/requestId 精确匹配并在 timeout、abort、reinitialize、disconnect 时结算。
- 扩展 command 的 session replacement 操作必须 fail closed。当前 slash command 也必须拒绝，直到 detached Agent turn 有明确的 host run ownership。
- `PiConnection.activeRun` 是 queued/running/cancelling 的唯一服务端真相；`PublicState.busy` 只能由它派生，聊天 reducer 不维护第二份 busy。
- AgentSession 创建后的 owner bind、host gate、startup 校验和 extension error 投影必须处于统一清理边界；成功创建后任一步失败都要 teardown session 并逐出 registry owner。
- 同步 emitter 驱动的 OAuth/extension UI rendezvous 必须先登记 pending 再 emit；emit 或监听注册失败也不能留下 waiter、registry owner 或阻断其余 session teardown。
- 工具策略必须位于项目扩展 `tool_call` hook 之后、真实 `tool.execute` 之前，并只按 run 启动时冻结的 conversation role 权限决策。
- 工具 gate 启用时固定使用 sequential execution，避免 SDK parallel preflight 在 abort 或模式收紧后执行已积累的 thunk。
- `read_only` 只允许 `source=builtin` 的 Pi 原生 `read/grep/find/ls`；命令、写入、未知工具及扩展同名工具都由服务端硬拒绝。`full_access` 直接允许所有工具。
- `.piweb` 是宿主持久状态；只读模式不阻止宿主保存，但 `full_access` 也不会替 Agent 额外保护该目录。
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
