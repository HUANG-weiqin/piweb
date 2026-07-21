# 工具权限

`updated: 2026-07-21`

## 这个模块是干什么的

工具权限层在 Pi 项目扩展完成参数变换之后、真实工具副作用之前做服务端 allow/deny 决策。它用于减少误操作，不是进程、文件系统或网络 sandbox。

## 核心循环

```text
SDK validated args
→ project extension tool_call hook
→ stable JSON validation + recursive freeze
→ workbench ToolPolicy
→ allow 或 hard deny
→ SDK block result 或 tool.execute
```

没有逐工具询问、一次性许可或命令白名单。

## 状态所有权

- `RoleStore.toolMode` 是角色模板的 `read_only | full_access` 持久权威值；新角色和旧角色迁移都默认 `read_only`。
- 创建 conversation 或用户在 idle 边界显式切换角色时，工具权限进入 conversation 当前角色快照；run ticket 再捕获该快照。编辑模板不会自动改变已有会话，角色切换也不能改变已经启动的 run。
- `ProjectStore.toolMode` 只为旧 manifest / 非协调运行路径保留兼容读取，不参与当前 `ConversationActor` 的工具决策；v20 线协议不再接受 `initialize.toolMode` 或 `set_tool_mode`。
- 浏览器只在角色设置中编辑模板权限，不参与单次工具决策。

## 策略

- `full_access` 允许所有工具和命令，不区分来源或目标位置；项目外路径和 `.piweb` 也不额外拦截。
- `read_only` 只允许 `source=builtin` 的 Pi 原生 `read / grep / find / ls`。
- `read_only` 直接拒绝 `bash / edit / write / unknown`、扩展工具以及工作台 meta 工具。
- 扩展可以用 `read` 等名称覆盖内置工具；策略必须同时检查最终 `toolName` 和 SDK `ToolInfo.sourceInfo.source`，不能只按名称放行。
- Agent 的 `read_only` 只限制经过 Pi 工具入口的调用；工作台宿主仍会写 manifest 和 transcript。

## Agent 编排工具

每个 ConversationActor 注入 9 个宿主 meta 工具：

```text
list_roles / list_sessions / current_session / peek_session
start_session / send_session_message / wait_for_session
abort_session / delete_session
```

它们仍是 Agent 工具调用，不是绕过 gate 的内部 RPC：

- 项目 extension `tool_call` hook 先观察/变换调用，宿主再按最终工具 identity 与 run ownership 决策；
- 工具闭包固定来源 conversation 和 canonical project，参数不能提交 cwd/projectId；
- `read_only` 不因 list/peek 看似只读而部分开放整套控制面，第一版统一拒绝 meta 工具；
- `full_access` 才允许 Agent 创建、通信、等待、中止和删除 peer conversation，但 self delete、self abort/wait、busy delete、stale runId 等生命周期约束仍由 coordinator 独立校验；
- 用户从 UI 发起的角色管理、焦点切换和宿主持久化不经过 Agent tool gate，仍受协议身份与各自串行边界约束。

`full_access` 是执行许可，不是无限生命周期权限。meta 能力只限当前项目，不能修改角色目录、认证、trust 或既有会话的角色/模型。

## 生命周期

- 每个工具调用必须由当前 running ticket 拥有；无 active run、旧 generation 或已经取消的调用直接阻止。
- 有效模式只取 run 启动时冻结的 conversation role 权限。
- SDK gate 缺少 AbortSignal 或策略异常时 fail closed。
- missing / pre-aborted signal 必须在进入项目扩展 hook 前阻止；hook 返回后再次检查取消。
- 扩展处理后的参数必须是稳定的普通 JSON 数据，并在进入 host gate 前原地递归冻结。
- Agent 固定使用 sequential tool execution，避免 SDK parallel preflight 先积累一批已放行 thunk、再在取消或模式收紧后启动执行。

## 展示与边界

- SDK 的 `tool_execution_start` 在 host 策略前发出；客户端把它显示为 pending，不能据此宣称副作用已经开始。
- `tool_prepared` 尽力投影扩展变换后的最终参数，用于校准工具卡。参数过大或不能进入线协议时可以省略预览，但不能因此阻止 `full_access` 执行。
- 项目扩展与服务进程同权限，可以直接操作系统并绕开工具 gate；只加载可信扩展。
- `read_only` 不是 sandbox，`full_access` 更是明确的宿主完整授权。不可信或无人值守任务仍需要 OS/container/VM 隔离。

## 入口

- `src/server/tool-policy.ts`
- `src/server/pi-runtime.ts`
- `src/server/pi-service.ts`
- `src/server/conversation-actor.ts`
- `src/server/project-session-coordinator.ts`
- `src/server/meta-tools.ts`
- `src/server/project-run-coordinator.ts`
- `src/shared/protocol.ts`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
