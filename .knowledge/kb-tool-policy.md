# 工具权限

`updated: 2026-09-30`

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

- `full_access` 在角色授权层允许所有工具和命令，不区分来源或目标位置；项目外路径和 `.piweb` 也不额外拦截。ConversationActor 另对 builtin `edit/write` 执行 run-scoped 首次写入 LoopList 门，它是认知承诺而不是权限或路径 sandbox，`bash`、脚本和扩展工具仍可绕过。
- `read_only` 对模型只展示 `source=builtin` 的 Pi 原生 `read / grep / find / ls`，以及 `source=sdk` 的宿主受审查 `bash` 及其 run-scoped `bash_output / bash_stop`、conversation-scoped `notebook_write / notebook_list / notebook_grep / notebook_read`、本机时间 `current_time`、只读 LSP `lsp_symbols / lsp_definition / lsp_references`、LoopList `todo_read / todo_write / todo_pause`、`request_context_compaction` 和 `list_roles / read_role / propose_role_revision`；builtin `bash`、`edit / write`、会话编排 meta 和其他扩展工具不进入有效 registry、model tools 或 system prompt。
- 执行 gate 独立重复同一 identity 约束；`read_only` 直接拒绝项目写入、unknown、会话编排 meta，以及同名 builtin/extension/project Bash。宿主 `bash / bash_output / bash_stop`、`current_time` 和三个角色工具只有 `source=sdk` 时放行；工具不可见不是权限边界，硬拒绝仍不可删除。
- 扩展可以用 `read` 等名称覆盖内置工具；策略必须同时检查最终 `toolName` 和 SDK `ToolInfo.sourceInfo.source`，不能只按名称放行。PiRuntime 对每次 `setActiveToolsByName`（包括 extension refresh 和 `setActiveTools`）重新做 source-aware 投影，同名覆盖发生后宁可移除该工具，也不把扩展 schema/snippet 暴露给只读模型。
- Agent 的 `read_only` 只限制经过 Pi 工具入口的调用；工作台宿主仍会写 manifest 和 transcript。

## 受审查的只读 Bash

Actor-owned 会话由 `PiRuntime` 在 session services 解析完成后注入 `source=sdk` 的 `bash / bash_output / bash_stop`，用同一 `SettingsManager` 的有效 `shellPath`，替代 Pi builtin Bash。`read_only` 的启动工具仍在任何执行前审查最终 `command`，通过后才委托公开的 Pi `createBashToolDefinition` 与 local operations，保留原生输出、截断、全文临时文件和失败语义；它不接受或追加 `shellCommandPrefix`，避免审查后再改变文本。`full_access` 使用同一有界生命周期，但允许有效配置中的原生 command prefix。没有 Actor ownership 的独立 runtime 兼容路径仍保留原生同步 Bash。

`bash.timeout` 是整数毫秒，默认 120000、上限 600000；默认前台阻塞到结束，直接返回原生结果，不发布 id。只有显式 `run_in_background:true` 才立即发布当前逻辑 run 的独立 UUID `task_id`；`bash_output` 默认阻塞读取 30000ms（上限 600000），超时或 `block:false` 返回非消费快照，无 id 时立即列有界摘要。`bash_stop({task_id})` 是停止请求，不是停止证明。两个后续工具不能提交命令、cwd 或其它 run 的 id，所以不会扩大查询审查目录。SDK signal 只取消当前等待；真正执行使用独立 controller，预先 aborted 的启动调用仍必须在任何准入/执行前拒绝。权限 gate 保持 sequential；可并发的是已经准入的有限命令，不是工具预检。详见 [kb-server-runtime.md](kb-server-runtime.md) 的 Bash 执行边界。

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

同一 canonical sidecar 的读写和 cascade delete 共用进程内操作队列；仅在该队列的操作入口恢复严格命名的 `.<conversationId>.json.<create|replace|delete>.<uuid>.<tmp|quarantine>` artifact，不在 project open 或全局扫描时触碰它们。F 为正式 sidecar、T 为 staged file、Q 为 quarantine：create 的 `link(T,F)`、replace 的 `link(T,F)` 是提交切点；delete 先以 `link(F,T)` 保留预提交 inode guard，再以 `rename(F,Q)` 提交。replace 在清理 Q 前保留 T；delete 先清理经验证的 T，仍保留 Q guard，再清理 Q：`T=F` 无 Q 是可清理的预提交状态，`T=Q` 且 F 缺席是可清理的已提交状态。若同进程的 Q cleanup 报错，只有 Q 仍匹配保存 inode 时才允许以 fresh transaction 的 provisional typed T 重建 guard、证明 Q 与 provisional 都匹配保存 inode，再以 no-clobber `link(P,T)` 安装原 transaction 的 T，并证明 `T=Q=P` 后才删除经验证的 P、恢复；provisional 只属于该同步 repair path，generic/open recovery 从不由 bare Q 重建。rebuild/proof/P cleanup 中任一失败会留下 distinct transaction 或 inode mismatch 并永久 fail closed。Q-only、T-only/F 缺席或任一未能证明的 T/F/Q inode 关系都 fail closed，不能恢复或消费可能被换入的 sidecar。故进程恰在 T unlink 后退出会留下须人工处理的 bare Q；这是安全优先限制，不承诺全 crash cut 自动修复。恢复按完整 filename owner、operation、transaction 与 inode 关系判定，多个 transaction、重复 stage、legacy/近似名或矛盾 inode 均 fail closed，且不清理其它 conversation 的 artifact。清理报错后，只有 recovery 已证明期望最终状态且本 transaction artifact 已消失才可成功返回；否则保留现场供下一次同一 sidecar 操作恢复。

## Agent 宿主工具

ConversationActor 按角色模式和会话管理能力注入宿主工具：

```text
all Actor-owned roles: bash / bash_output / bash_stop（read_only 的 bash 仍只接受受审查查询）
all roles: notebook_write / notebook_list / notebook_grep / notebook_read
all roles: current_time（本机 RFC 3339 offset 时间与 IANA 时区）
all roles: lsp_symbols / lsp_definition / lsp_references（已配置启用的本机 LSP，无信任询问）
all roles: todo_read / todo_write / todo_pause
all roles: request_context_compaction
all roles: list_roles / read_role / propose_role_revision
canManageSessions only: list_sessions / current_session / peek_session
canManageSessions only: start_session / send_session_message
canManageSessions only: wait_for_session / abort_session / delete_session
```

这些宿主 schema 同样避免 `anyOf/oneOf`，以兼容对工具 schema 子集较严格的 provider。`current_time` 在单次调用中读取本机 civil clock，返回带 offset 的 RFC 3339 `localTime` 和 IANA `timeZone`；它不从模型知识推测时间、不持久化，也不扩大浏览器协议。

### 首次写入 LoopList 门控

角色 ToolPolicy 先决策；只有 `full_access` run 中最终来源为 builtin 的 `edit/write` 才受此门控。同一逻辑 run 的第一次这类调用前，ConversationActor 的权威 LoopList 必须至少有一个 `status=active` 项。路径参数为非空 string 且条件满足时，宿主在真正 builtin 执行前同步追加 non-context 的 exact-run `piweb.edit_gate.v1` marker；持久化失败就 fail closed，不执行写入。marker 一旦写成，当前 run 后续所有 builtin `edit/write` 都直接通过这项检查，即使 LoopList 随后暂停、完成或没有 active 项。它是一次性“已获准尝试”的记录，不等工具成功、路径可写或 provider 结果返回，以免部分写入、错误或进程替换后重新收紧同一 run。

recovered exact run 从 active branch 的 marker 恢复该 latch。为保持旧 JSONL 可打开，解析器仍严格验证历史 `piweb.edit_budget.v1` 的 `grant/charge` journal；同一 run 的有效 legacy `charge` 也作为过去已经通过写入准入的兼容证据。旧条目不再注册工具、不产生新条目、不授予新 run 权限，也不投影额度。没有 path canonicalization、distinct-file cap、completion accounting、`piwebEditBudget` details 或 provider `editLeft` 提示；该门控仍不宣称覆盖 `bash` 或进程内项目扩展。

它们仍是 Agent 工具调用，不是绕过 gate 的内部 RPC：

- 项目 extension `tool_call` hook 先观察/变换调用，宿主再按最终工具 identity 与 run ownership 决策；
- 工具闭包固定来源 conversation 和 canonical project，参数不能提交 cwd/projectId；
- `read_only` 允许 `notebook_write`，因为它只写当前 conversation 的宿主工作记忆 sidecar，生命周期等同 transcript，不是项目源码写入；
- `read_only` 允许 `request_context_compaction`，因为它只预约当前 run 的安全轮次边界并最终写 Pi 原生 compaction entry，不修改项目源码；请求是易失控制意图，工具结果不冒充持久成功证明；
- `read_only` 允许读取所有用户级角色 prompt，它们会进入调用模型与当前 transcript，因此角色 prompt 不能保存秘密；`propose_role_revision` 的 Agent 参数只包含目标、expected revision、完整替换 prompt 和理由，名称、模型及权限字段不存在于 schema。取消有效到 `RoleStore` commit 开始；CAS queue race 返回 `stale`，commit 开始后按已授权提交处理；用户取消或中止 run 在此之前都不会落版；
- `read_only` 不因 list/peek 看似只读而部分开放会话控制面；八个会话编排工具仍全部拒绝；
- `full_access` 才允许 Agent 创建、通信、等待、中止和删除 peer conversation；删除会级联 metadata descendants，但 self delete、级联删除自身、self abort/wait、busy delete、stale runId 等生命周期约束仍由 coordinator 独立校验；
- 三个 LSP 工具也要求最终 `source=sdk`；参数没有 cwd/command/method，只运行用户级配置中已启用的语言服务，不查询 project trust 或弹出信任询问；项目 SDK 资源信任检查保持独立。只读查询不是语言服务进程的 OS sandbox；工作区池的取消、磁盘同步和有界结果见 [kb-lsp.md](kb-lsp.md)；
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
- `src/server/bash-execution.ts`
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
