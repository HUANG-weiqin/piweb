# 仓库总览

`updated: 2026-07-18`

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
  更新一个原子运行 bundle
  将 SDK 事件投影成稳定事件
  发布带 sessionId/runId 的状态与增量
  客户端过滤旧身份并按 run 更新视图
```

状态分四层：

- 进程态：Pi 认证存储、基线模型目录及其配置修改队列。
- 项目态：`.piweb` manifest、Pi JSONL 对话索引和 conversation writer lease。
- session 态：cwd 隔离的模型目录、扩展生命周期、SessionManager 和 AgentSession。
- 连接态：当前 session bundle、activeRun ticket、OAuth flow、命令队列和生命周期 generation。

## 决策

- Pi SDK 是 Agent 实现来源，工作台不复制 provider、tool 或 retry 逻辑。
- 当前 AgentSession 使用项目自有 sessionDir 的 `SessionManager`；持久 conversation 与临时 session epoch 明确分离。
- WebSocket 只做传输；会话身份和 SDK 事件都不能由 socket 隐式定义。
- 远程访问和 OS 级隔离仍需单独设计；持久化与工具审批都不能替代 sandbox。

## 认知模型

从零重建只需要三件事：

1. 一个跟项目走的 durable conversation，以及一个拥有明确生命周期的 AgentSession bundle。
2. 一个稳定且可校验的命令/事件协议。
3. 一个把事件确定性投影成 UI 的状态机。

模型目录、OAuth 交互、Markdown 和样式都是必要工程，但不是运行核心。

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
- 不要在认证变更时新建第二份 `AuthStorage` 或绕过 `PiRuntime`。
- 不要把 Pi SDK 的动态 API/OAuth registry 当成 session 局部状态；它们是进程全局的，当前策略是拒绝项目扩展注册。

## 关联模块

- [kb-wire-protocol.md](kb-wire-protocol.md)
- [kb-server-runtime.md](kb-server-runtime.md)
- [kb-project-sessions.md](kb-project-sessions.md)
- [kb-client-state.md](kb-client-state.md)
