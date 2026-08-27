# 工具权限

`updated: 2026-08-10`

## 这个模块是干什么的

工具权限层先按 conversation 角色把有效工具集投影给模型，再在 Pi 项目扩展完成参数变换之后、真实工具副作用之前做服务端 allow/deny 决策。它用于减少误操作，不是进程、文件系统或网络 sandbox。

## 核心循环

```text
conversation role snapshot
→ SDK tool-name ceiling + provenance projection
→ model tools / system prompt
→ project extension tool_call hook
→ stable JSON validation + recursive freeze
→ workbench ToolPolicy
→ allow 或 hard deny
→ SDK block result 或 tool.execute
```

权限层本身没有通用的逐工具询问、一次性许可或命令白名单；`propose_role_revision` 是工具语义内的窄例外，必须等待 conversation-scoped editor 返回用户提交文本后才写角色 prompt。

## 状态所有权

- `RoleStore.toolMode` 是角色模板的 `read_only | full_access` 持久权威值；新角色和旧角色迁移都默认 `read_only`。
- 创建 conversation 或用户在 idle 边界显式切换角色时，工具权限进入 conversation 当前角色快照；run ticket 再捕获该快照。编辑模板不会自动改变已有会话，角色切换也不能改变已经启动的 run。
- `ProjectStore.toolMode` 只为旧 manifest / 非协调运行路径保留兼容读取，不参与当前 `ConversationActor` 的工具决策；v22 线协议不再接受 `initialize.toolMode` 或 `set_tool_mode`。
- 浏览器只在角色设置中编辑模板权限，不参与单次工具决策。

## 策略

- `full_access` 允许所有工具和命令，不区分来源或目标位置；项目外路径和 `.piweb` 也不额外拦截。
- `read_only` 对模型只展示 `source=builtin` 的 Pi 原生 `read / grep / find / ls`，以及 `source=sdk` 的宿主 `git_status / git_diff`、conversation-scoped `notebook_write / notebook_list / notebook_grep / notebook_read`、LoopList `todo_read / todo_write / todo_pause` 和 `list_roles / read_role / propose_role_revision`；`bash / edit / write`、会话编排 meta 和其他扩展工具不进入有效 registry、model tools 或 system prompt。
- 执行 gate 独立重复同一 identity 约束；`read_only` 直接拒绝命令、项目写入、unknown、会话编排 meta，以及同名 extension/project 工具。三个角色工具只有 `source=sdk` 时放行；工具不可见不是权限边界，硬拒绝仍不可删除。
- 扩展可以用 `read` 等名称覆盖内置工具；策略必须同时检查最终 `toolName` 和 SDK `ToolInfo.sourceInfo.source`，不能只按名称放行。PiRuntime 对每次 `setActiveToolsByName`（包括 extension refresh 和 `setActiveTools`）重新做 source-aware 投影，同名覆盖发生后宁可移除该工具，也不把扩展 schema/snippet 暴露给只读模型。
- Agent 的 `read_only` 只限制经过 Pi 工具入口的调用；工作台宿主仍会写 manifest 和 transcript。

## Git 浅层投影

Git 浅层投影拆成 `git_status(path?)` 和 `git_diff(scope, path?)` 两个宿主工具，只注入 `read_only` 会话；`full_access` Agent 用 `bash git ...`，避免每次只读 Git 包装都创建临时 synthetic `GIT_DIR`。`scope` 只存在于 `git_diff`，取值 `worktree | staged | all`。可选 path 必须是 canonical project cwd 内的相对路径。对模型暴露的参数 schema 必须是单个 object + enum，不使用顶层 `anyOf/oneOf` union；通过工具拆分避免模型把 diff 参数传给 status。宿主构造固定 argv，使用项目外解析出的绝对 Git executable、`shell:false`、同一次调用 deadline、AbortSignal，以及 stdout/stderr 共享的 50 KiB / 2000 行预算。

Git 的“只读子命令”仍可能经 pager、external diff、textconv、content filter 或 fsmonitor 执行程序。主命令因此不读取真实 Git 配置：宿主先用固定 `rev-parse` 捕获并校验 repository top、git dir、index、objects、object format 和 HEAD，再为该次调用创建只含宿主 config/HEAD 的临时 synthetic `GIT_DIR`；work tree、index 和 object directory 显式绑定真实只读输入，global/system config 指向临时空文件，继承的 `GIT_*` 全部先删除。临时目录没有 `commondir`、hooks 或 info 链接，并在所有完成/失败路径清理。输出可能因未继承 `core.autocrlf/filemode/ignorecase`、sparse 和 info exclude 而比原生 Git 更嘈杂，这是关闭执行入口的保守代价。

## Agent Notebook 工具

Agent Notebook 是 conversation-scoped 的外部工作记忆，绑定 `canonical cwd + conversationId`，存放在 `.piweb/notebooks/<conversationId>.json`。它不是项目共享知识库，不自动注入模型上下文；只有 Agent 显式调用 list/grep/read 时才进入当前 turn。Notebook 内容只是工作记忆，最终引用源码仍要重新读取来源范围。

V1 只有四个工具：

- `notebook_write(title, content?, archived?)`：按 title 全量创建/替换内容，或切换 archive 状态；新 title 必须带 content；没有 hard delete。
- `notebook_list(status?)`：默认列 active note，只返回 title/preview/archive/size/updatedAt，不返回全文。
- `notebook_grep(pattern, status?)`：对 title + content 做大小写不敏感的 literal 搜索，返回 bounded snippet，不支持 regex/semantic/cursor/limit。
- `notebook_read(titles)`：按精确 title 读取 active 或 archived note；调用方应先用 list/grep 发现 title。

Archive 是可恢复隐藏，不是删除：默认 list 不显示 archived，但 `status=archived/all` 仍可发现，read 也能按精确标题打开。会话删除通过 project store 级联删除对应 sidecar 文件。单 note 内容和 note 数量之外，宿主还在写临时文件前按最终 JSON 的 UTF-8 字节数复核总文件预算；NUL 等 JSON escape 膨胀也计入，不能提交一个下一次读取会因超限而拒绝的 sidecar。

## Agent 宿主工具

ConversationActor 按角色模式和会话管理能力注入宿主工具：

```text
read_only only: git_status / git_diff
all roles: notebook_write / notebook_list / notebook_grep / notebook_read
all roles: todo_read / todo_write / todo_pause
all roles: list_roles / read_role / propose_role_revision
canManageSessions only: list_sessions / current_session / peek_session
canManageSessions only: start_session / start_temporary_session / send_session_message
canManageSessions only: wait_for_session / abort_session / delete_session
```

这些宿主 schema 同样避免 `anyOf/oneOf`，以兼容对工具 schema 子集较严格的 provider。

它们仍是 Agent 工具调用，不是绕过 gate 的内部 RPC：

- 项目 extension `tool_call` hook 先观察/变换调用，宿主再按最终工具 identity 与 run ownership 决策；
- 工具闭包固定来源 conversation 和 canonical project，参数不能提交 cwd/projectId；
- `read_only` 允许 `notebook_write`，因为它只写当前 conversation 的宿主工作记忆 sidecar，生命周期等同 transcript，不是项目源码写入；
- `read_only` 允许读取所有用户级角色 prompt，它们会进入调用模型与当前 transcript，因此角色 prompt 不能保存秘密；`propose_role_revision` 的 Agent 参数只包含目标、expected revision、完整替换 prompt 和理由，名称、模型及权限字段不存在于 schema。取消有效到 `RoleStore` commit 开始；CAS queue race 返回 `stale`，commit 开始后按已授权提交处理；用户取消或中止 run 在此之前都不会落版；
- `read_only` 不因 list/peek 看似只读而部分开放会话控制面；九个会话编排工具仍全部拒绝；
- `full_access` 才允许 Agent 创建、通信、等待、中止和删除 peer conversation；删除会级联 metadata descendants，但 self delete、级联删除自身、self abort/wait、busy delete、stale runId 等生命周期约束仍由 coordinator 独立校验；
- 用户从 UI 发起的角色管理、焦点切换和宿主持久化不经过 Agent tool gate，仍受协议身份与各自串行边界约束。

`full_access` 是执行许可，不是无限生命周期权限或文件系统 sandbox。会话编排能力只限当前项目，不能通过 meta 工具改认证、trust 或既有会话的角色/模型；但通用 `bash/edit/write` 仍可访问进程有权访问的项目外路径，包括用户级角色文件，所以人工确认只保证 `propose_role_revision` 这条宿主工作流，不能替代 OS 隔离。

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
- `src/server/git-inspect.ts`
- `src/server/notebook-tools.ts`
- `src/server/conversation-notebook.ts`
- `src/server/project-run-coordinator.ts`
- `src/shared/protocol.ts`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
