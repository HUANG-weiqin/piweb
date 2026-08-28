# 仓库总览

`updated: 2026-08-28`

## 这个模块是干什么的

Pi Web 给 Pi SDK 提供一个本机 Web 工作台。它不重写 Agent，而是补齐浏览器入口、会话控制、协议隔离和 UI 投影。

## 架构

核心一句话：

```text
Pi Web = 项目持久状态 + WebSocket 控制循环 + Pi SDK 工具循环 + 本机安全约束
```

最小执行循环：

```text
while 连接存在:
  校验浏览器命令
  按控制语义串行或中断执行
  打开项目内持久 conversation
  由 conversation actor 更新唯一 active run
  将 SDK 事件投影成稳定事件
  发布带 sessionId/runId 的状态与增量
  客户端过滤旧身份并按 run 更新视图
```

状态分五层：

- 进程态：Pi 认证存储、用户级 project trust、基线模型目录及其配置修改队列。
- 项目态：`.piweb` manifest、Pi JSONL 对话索引和 conversation writer lease。
- conversation actor 态：cwd 隔离的模型目录、扩展生命周期、SessionManager、AgentSession 和唯一 activeRun ticket。
- 连接态：项目 observation、当前 conversation focus、OAuth/UI 路由、命令队列和生命周期 generation。
- 临时交互态：pre-session 目录浏览请求绑定 socket/commandId；extension UI request/response 绑定 session generation。两者都不进入持久对话。

## 决策

- Pi SDK 是 Agent 实现来源，工作台不复制 provider、tool 或 retry 逻辑。
- 工作台只拥有 Agent 运行必须共享的状态与控制边界；可由 Git、编辑器、终端等成熟工具完整替代的能力留在外部。
- 不内建第二套 diff/history/revert、文件管理器或通用终端。未来若需要，只做无状态交接或薄集成。
- 当前 AgentSession 使用项目自有 sessionDir 的 `SessionManager`；持久 conversation 与临时 session epoch 明确分离。
- WebSocket 只做传输；会话身份和 SDK 事件都不能由 socket 隐式定义。
- 远程访问和 OS 级隔离仍需单独设计；持久化与二元角色工具权限都不能替代 sandbox。

## 认知模型

从零重建只需要三件事：

1. 一个跟项目走的 durable conversation，以及一个拥有明确生命周期的 AgentSession bundle。
2. 一个稳定且可校验的命令/事件协议。
3. 一个把事件确定性投影成 UI 的状态机。

模型目录、OAuth 交互、Markdown 和样式都是必要工程，但不是运行核心。

判断一个新功能是否应进入核心，只问三件事：它是否拥有不可替代的状态、是否参与安全控制、是否必须跨重连恢复。三者都是否时，优先交给现有工具。

## 入口

- `src/server/index.ts`
- `src/server/socket-server.ts`
- `src/server/pi-runtime.ts`
- `src/server/pi-service.ts`
- `src/server/project-store.ts`
- `src/server/conversation-history.ts`
- `src/shared/protocol.ts`
- `src/client/App.tsx`
- `npm test`
- `npm run typecheck`

## 坑点

- 不要把浏览器连接等同于持久对话；projectId/conversationId 是 durable 身份，sessionId/runId 只是关联 epoch。
- 不要把完整会话索引塞进高频 PublicState；项目索引与历史分别走有界快照。
- 不要在 client/shared 中重新引入 `AgentSessionEvent`。
- 不要在认证变更时新建第二份 `CredentialStore` 或绕过 `PiRuntime`。
- 不要把 Pi SDK 的动态 API/OAuth registry 当成 session 局部状态；它们是进程全局的，当前策略是拒绝项目扩展注册。
- 不要以默认 trusted 的 SettingsManager 读取陌生项目；trust 必须在项目可执行资源加载前解析，且不能由 `.piweb` 持有。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-client-state.md](kb-client-state.md)
