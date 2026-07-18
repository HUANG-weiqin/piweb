# 工具权限与审批

`updated: 2026-07-18`

## 这个模块是干什么的

工具权限层在 Pi 项目扩展完成参数变换之后、真实工具副作用之前做服务端决策。它降低误操作风险，但不是进程或文件系统 sandbox。

## 核心循环

```text
SDK validated args
→ project extension tool_call hook
→ stable JSON validation + recursive freeze
→ workbench ToolPolicy
→ allow / hard deny / pending approval
→ browser response control lane
→ SDK block result 或 tool.execute
```

## 状态所有权

- `ProjectStore.toolMode` 是当前项目的 `read_only | workspace_write` 持久权威值。
- run ticket 捕获启动时模式；项目随后收紧立即生效，随后放宽不能扩大已排队/运行的 run。
- `ProjectRunCoordinator` 是跨连接收紧屏障；read_only 意图同步取消项目旧 run，只有这些 run 结算后才允许 manifest/state 确认。这样消除异步 policy/approval 与模式切换之间的 check→execute 窗口。
- `ToolApprovalBroker` 属于 `PiConnection`，pending ticket 绑定 `sessionId + runId + approvalId`。
- `PublicState.activeRun.pendingApprovals` 是浏览器唯一可恢复的待审批快照。
- React 只保存一次提交中的 approvalId 来防双击，不拥有授权决定。

## 策略

- 两种模式都只自动允许 `source=builtin` 的 `read / grep / find / ls`。
- `read_only` 对 `edit / write / bash / unknown` 直接返回 block，不提供临时越权。
- `workspace_write` 自动允许 `source=builtin` 且真实目标位于 cwd 内的 `edit / write`。
- `.piweb` 及指向它的 symlink alias 是宿主保留状态，内置 `edit/write` 直接拒绝，不进入一次性审批。
- 项目外或无法证明归属的写入需要一次性审批。
- `bash` 和未知扩展工具始终审批；命令文本不足以证明副作用范围。
- 扩展可以用 `write`、`read` 等名称覆盖内置工具；策略必须使用 SDK `ToolInfo.sourceInfo` 识别最终工具来源。
- 路径判断解析 cwd、已存在目标、最近存在父目录以及已有/断裂符号链接；无法解析时 fail closed。
- Agent 工具的 read_only 不等于项目磁盘只读；宿主仍必须保存 manifest 和 transcript。

## 生命周期

- 审批响应绕过 `SerialTaskQueue`，否则 prompt 等响应、响应等 prompt 会死锁。
- exact session/run/approval first-wins；错误、重复和迟到响应均为 no-op。
- abort、close、reinitialize、disconnect 和 dispose 都会结算 pending 为 deny。
- 项目级 read_only 转换也会结算其它连接的 pending approval；迟到 allow 只能 no-op。
- SDK gate 缺少 AbortSignal、策略异常或 broker 异常时必须阻止工具并发布诊断。
- missing / pre-aborted signal 必须在进入项目扩展 hook 前阻止；hook 返回后再次检查取消。
- 扩展处理后的参数必须是可克隆的普通 JSON 数据，并在策略判断前原地递归冻结；审批快照与实际执行参数不能出现可变引用窗口。
- 无法无损放入线协议的审批参数（超限、截断或不可序列化）必须直接阻止，不能让用户批准一段不完整预览。
- gate 启用时 Agent 使用 sequential tool execution，规避 SDK parallel preflight 的 post-abort thunk 窗口。

## 边界

- SDK 的 `tool_execution_start` 在校验和审批前发出；客户端把它显示为 pending，不宣称副作用已经开始。
- `tool_prepared` 携带扩展变换、SDK 校验并锁定后的最终参数，用于校准工具卡和审批内容。
- 项目扩展与服务进程同权限，扩展可直接操作系统并绕开工具 gate；只加载可信扩展。
- 路径检查存在不可消除的 TOCTOU。强隔离必须使用 worker 之外更强的 OS/container/VM 边界。

## 入口

- `src/server/tool-approval.ts`
- `src/server/pi-runtime.ts`
- `src/server/pi-service.ts`
- `src/shared/protocol.ts`
- `src/client/components/ToolApprovalDialog.tsx`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
