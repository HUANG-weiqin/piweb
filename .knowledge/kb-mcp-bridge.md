# MCP 桥

`updated: 2026-10-11`

## 这个模块是干什么的

`src/mcp/` 让 Claude Code 等外部 Agent 通过 MCP 使用工作台：列出会话与角色、读历史、新建会话派任务、发消息、等待一轮结束、停止运行。它是浏览器之外的**第二个线协议客户端**，与 `src/client` 同级，只导入 `src/shared/`。

不负责：回答扩展对话框或决定项目信任（扩展确认、角色提示词 editor 都留给浏览器）、删除会话、修改角色或认证、远程访问、让工作台 Agent 主动呼叫外部 Agent。这些要么属于用户，要么需要先改核心协议。

## 架构

```text
Claude Code ──stdio(MCP)──> src/mcp/index.ts（McpServer + 7 个工具）
  → PiWebBridge：每次工具调用一条短连接
  → PiWebSession ──ws://127.0.0.1:<port>/ws──> socket-server → PiConnection
       hello 版本校验 → initialize(cwd, recent|open|new, extensionUi=none) → focus/prompt/abort/refresh_view
       每一帧收发都用共享 protocol.ts schema 校验
```

| 工具 | 协议动作 | 完成依据 |
|---|---|---|
| `piweb_list_conversations` | initialize(recent) + `refresh_view` | `project_snapshot`，优先 coverage=complete |
| `piweb_list_roles` | initialize(recent) | `role_catalog_snapshot` |
| `piweb_read_conversation` | initialize(open) | 同 focusId 的 `conversation_snapshot` 与 `state` |
| `piweb_create_conversation` | initialize(new, roleId) → 可选 rename → prompt | `run_queued` |
| `piweb_send_message` | initialize(open) → prompt | idle 的 `run_queued(runId)` 或 busy 的 `prompt_admitted(promptId)` |
| `piweb_wait` | initialize(recent，不打开会话) | `conversation_run_settled`；列表空闲后 1.5s 仍无结算才按空闲返回 |
| `piweb_abort` | initialize(open) → abort(activeRun) | 该 runId 的 `conversation_run_settled`，30s 内无确认报告 unknown |

消息正文自动加 `[Claude Code] ` 前缀，在工作台中仍是普通用户消息；准入、投递证明、Stop 语义与浏览器输入完全相同，见[浏览器消息准入](kb-agent-collaboration.md#浏览器消息准入)。`conversation_run_settled` 对项目观察广播、不要求 focus，所以 wait 不必聚焦目标。

## 决策

- 协议只为桥加了一个通用能力声明：initialize 带 `extensionUi: "none"`。除此之外桥就是另一个 observation，准入与 focus 校验和浏览器相同；后台 actor 与浏览器观察互不影响；unread 按连接计。
- 不接收扩展 UI：服务端不让桥成为任何会话的对话框 delegate，聚焦会话也不会接走浏览器的对话框；没有浏览器聚焦时对话框照常挂起并标 attention。桥不改项目“最近会话”，不清 attention；`recent` 只观察项目，不打开会话，所以 wait 不再需要停靠。
- 不决定信任：桥的请求若会让 Pi 询问项目信任（无保存决定、默认策略 ask，且需新建模型目录、冷打开或新建会话），服务端直接返回中文错误，不询问、不写 trust store。浏览器已打开（actor 存活）的会话不会再问，可照常读写。
- 从不回答对话框：服务端不会再发给桥；万一收到 `extension_ui_request` 仍立即断开，让服务端按取消结算，工具把对话框内容返回给调用方，由用户决定。
- 短连接：每次调用结束即断开，不长期占用项目 handle。
- 只连本机：`PIWEB_URL` 只接受 127.0.0.1 / localhost / [::1]；Origin 设为服务地址本身，处在既有“本机进程可信”模型内，不扩展远程访问。
- 共享 schema 加 hello 版本校验：服务端与桥代码不一致时显式失败，不能按旧结构运行。
- `@modelcontextprotocol/sdk` 精确锁定版本；只用 server + stdio，不用其 OAuth client。

## 认知模型

桥 = 一个只做一件事就关掉的浏览器标签页。判断改动是否越界：如果桥需要服务端为它开特例（不同的准入、跳过 focus 校验、替用户作答），就不是桥的改动，而是核心协议改动，需按[线协议](kb-wire-protocol.md)流程推进版本。

## 入口

- `src/mcp/index.ts`：stdio 入口，读取 `PIWEB_URL`（默认 `http://127.0.0.1:31415`）与 `PIWEB_CWD`（默认 MCP 进程 cwd）。
- `src/mcp/piweb-session.ts`：单连接握手、身份关联、等待条件、对话框中断。
- `src/mcp/piweb-bridge.ts`：七个操作与 wait/park 逻辑。
- `src/mcp/tools.ts`、`src/mcp/conversation-text.ts`：工具 schema 与面向调用方的文本投影。
- 测试：`src/mcp/piweb-bridge.test.ts`（真实 socket server + FakeRuntime）、`src/mcp/tools.test.ts`（投影与 MCP 注册）。
- 构建产物：`npm run build` 生成 `dist-server/mcp/index.js`。注册（用户级）：`claude mcp add --scope user piweb -- node <repo>/dist-server/mcp/index.js`；改代码后需重新 build 并在 Claude Code 中重连该 MCP。
- 调试：`PIWEB_MCP_DEBUG=1` 把收发帧类型与身份写到 stderr（stdout 属于 MCP 协议）。

## 坑点

- 修改 `protocol.ts` 中桥用到的命令（initialize 及其 `extensionUi`、focus_conversation、prompt、abort、rename_conversation、refresh_view）、事件（hello、focus_attached、state、project_snapshot、role_catalog_snapshot、conversation_snapshot、session_event.run_queued、prompt_admitted、conversation_run_settled、command_complete、error、extension_ui_request）或其回执语义时，同一改动必须同步 `src/mcp/` 并跑通 `npx vitest run src/mcp`。只推进 `PROTOCOL_VERSION` 时桥会自动拒绝旧服务端，仍需重新 build 并重连 MCP。
- initialize(recent) 只发展示索引（coverage=unknown），完整列表要 `refresh_view` 触发；按 ID 找不到会话时也先刷新再判定不存在。
- 项目列表里的空闲可能早于 `conversation_run_settled` 到达；直接按空闲返回会丢掉 outcome。
- 必须先登记等待再发送命令或切换 focus；`focus_attached` 之后同一 commandId 仍可能报错，后续等待要继续检查。
- 信任未决定时，桥在本进程内第一次打开该项目（还没有模型目录）就会失败，连列表也拿不到；用户先在浏览器打开项目并回答即可。默认策略为 ask 且每次只选“仅本次信任”的项目，桥只能使用浏览器已打开的会话，冷会话与新建都会报错，选“记住”后才解除。
- 残余窗口：服务端检查通过之后、Pi 真正创建 session 之前，若用户恰好删除了保存的信任决定，这次询问会交给浏览器或标 attention，仍不会到桥，也不会被当成“不信任”。
- 测试 fake 的用户消息必须先发 raw user `message_end` 再由同一 SessionManager `appendMessage`，否则缺投递标记会使 actor fatal。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-agent-collaboration.md](kb-agent-collaboration.md)
- [kb-repo-overview.md](kb-repo-overview.md)
