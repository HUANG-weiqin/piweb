# 工具权限

`updated: 2026-07-19`

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

- `ProjectStore.toolMode` 是当前项目的 `read_only | full_access` 持久权威值。
- run ticket 捕获启动时模式；项目随后收紧立即生效，随后放宽不能扩大已排队或运行的 run。
- `ProjectRunCoordinator` 是跨连接收紧屏障。任何 `read_only` 请求都会同步封锁新 run、取消项目旧 run，并在它们结算后才持久化和确认模式。
- 浏览器只提交模式选择并观察服务端 state，不参与单次工具决策。

## 策略

- `full_access` 允许所有工具和命令，不区分来源或目标位置；项目外路径和 `.piweb` 也不额外拦截。
- `read_only` 只允许 `source=builtin` 的 Pi 原生 `read / grep / find / ls`。
- `read_only` 直接拒绝 `bash / edit / write / unknown` 以及任何扩展工具。
- 扩展可以用 `read` 等名称覆盖内置工具；策略必须同时检查最终 `toolName` 和 SDK `ToolInfo.sourceInfo.source`，不能只按名称放行。
- Agent 的 `read_only` 只限制经过 Pi 工具入口的调用；工作台宿主仍会写 manifest 和 transcript。

## 生命周期

- 每个工具调用必须由当前 running ticket 拥有；无 active run、旧 generation 或已经取消的调用直接阻止。
- 有 read-only 收紧正在结算时，有效模式立即视为 `read_only`。
- 否则有效模式取 run 启动快照和当前项目模式中更严格的一档。
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
- `src/server/project-run-coordinator.ts`
- `src/shared/protocol.ts`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
