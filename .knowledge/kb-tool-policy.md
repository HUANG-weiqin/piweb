# 工具权限

`updated: 2026-09-09`

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
→ run-scoped edit-budget check（仅 builtin edit/write）
→ allow 或 hard deny
→ 宿主 read_only bash 的有界词法与逐命令查询审查
→ SDK block result 或 tool.execute
→ 成功 mutation 的 completion accounting
```

权限层本身没有通用的逐工具询问或一次性许可；唯一的命令白名单是宿主 `read_only` Bash 包装器内固定的查询 shell 文本目录。`propose_role_revision` 是另一项工具语义内的窄例外，必须等待 conversation-scoped editor 返回用户提交文本后才写角色 prompt。

## 状态所有权

- `RoleStore.toolMode` 是角色模板的 `read_only | full_access` 持久权威值；新角色和旧角色迁移都默认 `read_only`。
- 创建 conversation 或用户在 idle 边界显式切换角色时，工具权限进入 conversation 当前角色快照；run ticket 再捕获该快照。编辑模板不会自动改变已有会话，角色切换也不能改变已经启动的 run。
- `ProjectStore.toolMode` 只为旧 manifest / 非协调运行路径保留兼容读取，不参与当前 `ConversationActor` 的工具决策；v22 线协议不再接受 `initialize.toolMode` 或 `set_tool_mode`。
- 浏览器只在角色设置中编辑模板权限，不参与单次工具决策。

## 策略

- `full_access` 在角色授权层允许所有工具和命令，不区分来源或目标位置；项目外路径和 `.piweb` 也不额外拦截。ConversationActor 另对 builtin `edit/write` 执行 run-scoped 编辑额度门，它是认知承诺而不是权限或路径 sandbox，`bash`、脚本和扩展工具仍可绕过。
- `read_only` 对模型只展示 `source=builtin` 的 Pi 原生 `read / grep / find / ls`，以及 `source=sdk` 的宿主受审查 `bash`、conversation-scoped `notebook_write / notebook_list / notebook_grep / notebook_read`、本机时间 `current_time`、只读 LSP `lsp_symbols / lsp_definition / lsp_references`、LoopList `todo_read / todo_write / todo_pause`、`request_context_compaction` 和 `list_roles / read_role / propose_role_revision`；builtin `bash`、`edit / write`、会话编排 meta 和其他扩展工具不进入有效 registry、model tools 或 system prompt。
- 执行 gate 独立重复同一 identity 约束；`read_only` 直接拒绝项目写入、unknown、会话编排 meta，以及同名 builtin/extension/project Bash。宿主 Bash、`current_time` 和三个角色工具只有 `source=sdk` 时放行；工具不可见不是权限边界，硬拒绝仍不可删除。
- 扩展可以用 `read` 等名称覆盖内置工具；策略必须同时检查最终 `toolName` 和 SDK `ToolInfo.sourceInfo.source`，不能只按名称放行。PiRuntime 对每次 `setActiveToolsByName`（包括 extension refresh 和 `setActiveTools`）重新做 source-aware 投影，同名覆盖发生后宁可移除该工具，也不把扩展 schema/snippet 暴露给只读模型。
- Agent 的 `read_only` 只限制经过 Pi 工具入口的调用；工作台宿主仍会写 manifest 和 transcript。

## 受审查的只读 Bash

`read_only` 会话由 `PiRuntime` 在 session services 解析完成后注入一个 `source=sdk`、名称仍为 `bash` 的宿主包装器，它使用同一 `SettingsManager` 的有效 `shellPath`，覆盖并替代 Pi builtin Bash；`full_access` 会话继续直接使用 Pi builtin Bash。包装器保留 Pi Bash 的参数 schema、timeout、AbortSignal、流式更新、输出截断和结果语义，但在任何进程执行前先审查最终 `command`，通过后才委托 `createBashToolDefinition(cwd, { shellPath })`。包装器不接受或追加 `shellCommandPrefix`，避免审查后再改变命令文本。

审查只接受有长度上限、整串锚定的安全词法子集。每个程序名都必须是字面量并属于固定查询目录：受约束的 Git 查询、`rg`，以及目录/文件查看和纯 stdout 变换工具。未引用且处于 word 起始的 `~`（包括 `~/…`、`~user`、`~+`、`~-`）属于 shell expansion，必须在执行前拒绝；引用或 token 中间的字面 `~` 不因此拒绝。 受审查命令可以用 `|` 或 `&&` 组合；每个 segment 都独立复核。`cd [--] path` 只能位于同一次调用的后续查询之前，不能持久改变下一次工具调用的 cwd。换行、`; / || / &`、重定向、Shell 展开、环境赋值、命令路径和未知程序一律拒绝。`find` 的删除/执行/文件输出 action、`rg` 的 preprocessor/hostname program、Git 外部 filter/pager/output、`sort` 文件输出/外部 compressor/显式临时目录、`uniq` 输出文件、`tail` follow 和 `file` 解压/compile 等命令级副作用入口及其实际可用长选项缩写另行拒绝。允许安全的裸参数、单引号字面量，以及不含展开或转义的双引号字面量。

包装器在启动 Pi Bash 时还移除 `BASH_ENV / ENV / BASHOPTS / SHELLOPTS / PS4 / CDPATH / RIPGREP_CONFIG_PATH` 和导出的 `BASH_FUNC_*`，并固定 `GIT_OPTIONAL_LOCKS=0 / GIT_PAGER=cat`，减少审查文本之外的 shell startup、函数遮蔽、rg config、可选 Git 写入与 pager 注入。它的权威事实仍只是“请求文本属于保守的查询 shell 目录”，不是语义或 OS 级只读保证。真实 Bash 仍继承其余进程环境并经 PATH 解析程序；仓库/用户 Git 配置、attributes、pager、fsmonitor、credential/remote helper 和查询命令自身仍可能执行程序或产生写入。可信项目扩展也能绕开工具 gate。需要无人值守或敌对输入隔离时必须使用 OS/container/VM sandbox，不能扩大规则目录来假装获得安全边界。

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
read_only only: bash（受审查的 Git/rg/文件查询 shell 包装器）
all roles: notebook_write / notebook_list / notebook_grep / notebook_read
all roles: current_time（本机 RFC 3339 offset 时间与 IANA 时区）
all roles: lsp_symbols / lsp_definition / lsp_references（已配置且信任的本机 LSP）
all roles: todo_read / todo_write / todo_pause
full_access only: request_edit_budget
all roles: request_context_compaction
all roles: list_roles / read_role / propose_role_revision
canManageSessions only: list_sessions / current_session / peek_session
canManageSessions only: start_session / send_session_message
canManageSessions only: wait_for_session / abort_session / delete_session
```

这些宿主 schema 同样避免 `anyOf/oneOf`，以兼容对工具 schema 子集较严格的 provider。`current_time` 在单次调用中读取本机 civil clock，返回带 offset 的 RFC 3339 `localTime` 和 IANA `timeZone`；它不从模型知识推测时间、不持久化，也不扩大浏览器协议。

### 编辑额度承诺

新 RunTicket 从零额度开始；recovered exact run 则从 active branch 的 durable journal 回放。`request_edit_budget(fileCount, reason)` 只在 `full_access` 会话注册，单次声明本 run 预计修改的 1–100 个 distinct file 总数，理由 trim 后必须非空且不超过 2000 字符；每次实际授予前，ConversationActor 的权威 LoopList 都必须至少有一个 `status=active` 项。参数或 active 前置条件拒绝时不改变 ledger；成功申请先追加 exact-run `piweb.edit_budget.v1` `grant`，再把 `fileCount` 覆盖为当前总额度而非累加；已经 charged 的 canonical path 仍计入该总数，因此缩小到不大于 charged 数会留下零剩余额度。即使列表随后暂停或完成，已授予额度也不追溯撤销；再次覆盖仍重新检查当时的 active 状态。角色 ToolPolicy 先决策，随后只有最终来源为 builtin 的 `edit/write` 才检查额度。目标路径按 Pi 的 path 规范化相对 canonical project cwd 解析；存在文件使用 realpath，不存在目标从最近存在父目录的 realpath 加上未解析后缀得到身份；若路径穿过 dangling symlink chain，则递归按其 target 推导该身份，因而经目录或 final symlink 创建后仍与同一路径重试相同；遇到非目录父项时保留 Pi 的规范化绝对路径并让 builtin 报错。Windows identity 大小写折叠。每个新的 canonical path 都必须在 builtin 调用前同步追加不可逆 `charge`；无论调用随后成功、报错、abort 或进程崩溃，该 charge 都占一格，同路径重试不重复占用。因为 Pi 的写入可在错误前已生效，不能按错误释放额度；completion 只记录当前进程实际观察到的成功 touch，并以同一 run 的 AbortSignal + toolCallId 关联，旧 run 的迟到结果不能修改新 ticket。

工具结果只报告 `grantedFiles / chargedFiles / touchedFiles / remainingFiles / blockedAttempts` 等可观察事实；`chargedFiles` 是已获准执行而保守占位的 distinct path 数，`touchedFiles` 仅是本进程实际观察成功的数，二者不得互相伪装。`grantedFiles` 是本次覆盖后的总额度，不把声明时刻伪装成“已遵守”。SDK extension 的 `tool_result` hook 先运行；即使该 hook 在 builtin 已成功后抛错，ledger 仍按原始 execute 状态记账，而原异常继续传播。普通 object details 可附加 `piwebEditBudget`，非对象 details 不覆盖。`grant` 与 `charge` 是 raw non-context reserved entries，不进入模型或聊天投影；同一 active branch 的 recovered exact run 从它们回放 cap 与 charged paths，旧无记录 run 的 cap 为零，不能从工具卡、Git 或文件状态猜测。它仍不宣称覆盖 `bash` 或进程内项目扩展。

它们仍是 Agent 工具调用，不是绕过 gate 的内部 RPC：

- 项目 extension `tool_call` hook 先观察/变换调用，宿主再按最终工具 identity 与 run ownership 决策；
- 工具闭包固定来源 conversation 和 canonical project，参数不能提交 cwd/projectId；
- `read_only` 允许 `notebook_write`，因为它只写当前 conversation 的宿主工作记忆 sidecar，生命周期等同 transcript，不是项目源码写入；
- `read_only` 允许 `request_context_compaction`，因为它只预约当前 run 的安全轮次边界并最终写 Pi 原生 compaction entry，不修改项目源码；请求是易失控制意图，工具结果不冒充持久成功证明；
- `read_only` 允许读取所有用户级角色 prompt，它们会进入调用模型与当前 transcript，因此角色 prompt 不能保存秘密；`propose_role_revision` 的 Agent 参数只包含目标、expected revision、完整替换 prompt 和理由，名称、模型及权限字段不存在于 schema。取消有效到 `RoleStore` commit 开始；CAS queue race 返回 `stale`，commit 开始后按已授权提交处理；用户取消或中止 run 在此之前都不会落版；
- `read_only` 不因 list/peek 看似只读而部分开放会话控制面；八个会话编排工具仍全部拒绝；
- `full_access` 才允许 Agent 创建、通信、等待、中止和删除 peer conversation；删除会级联 metadata descendants，但 self delete、级联删除自身、self abort/wait、busy delete、stale runId 等生命周期约束仍由 coordinator 独立校验；
- 三个 LSP 工具也要求最终 `source=sdk`；参数没有 cwd/command/method，且在启动本机进程前强制解析同一用户级 project trust。只读查询不是语言服务进程的 OS sandbox；工作区池的取消、磁盘同步和有界结果见 [kb-lsp.md](kb-lsp.md)；
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
- `src/server/read-only-bash.ts`
- `src/server/notebook-tools.ts`
- `src/server/conversation-notebook.ts`
- `src/shared/protocol.ts`
- 对应的 `*.test.ts`

## 关联模块

- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-client-state.md](kb-client-state.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
