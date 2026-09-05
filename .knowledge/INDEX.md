# Pi Web Knowledge Index

`updated: 2026-09-03`

知识库只记录长期稳定的架构事实、决策和坑点，不记录某次任务进度。

## 快速入口

| 页面 | 用途 |
|---|---|
| [kb-repo-overview.md](kb-repo-overview.md) | 先理解产品边界、核心循环和模块关系 |
| [kb-wire-protocol.md](kb-wire-protocol.md) | 修改 WebSocket 命令、事件、版本或 session epoch |
| [kb-server-runtime.md](kb-server-runtime.md) | 修改 Pi SDK、认证、模型缓存、会话、并发控制或热重载 |
| [kb-project-sessions.md](kb-project-sessions.md) | 修改 `.piweb`、项目身份、持久对话、恢复、索引或租约 |
| [kb-agent-collaboration.md](kb-agent-collaboration.md) | 修改角色、conversation actor、跨会话消息、等待或临时会话 |
| [kb-client-state.md](kb-client-state.md) | 修改 React App、聊天 reducer、重连和 UI 状态 |
| [kb-visual-validation.md](kb-visual-validation.md) | 使用本地无头浏览器检查界面尺寸、根节点、Setup/Escape 和 reduced-motion |
| [kb-ui-development-workflow.md](kb-ui-development-workflow.md) | UI 修改、预览、验证、合并与发布前 smoke 流程 |
| [kb-tool-policy.md](kb-tool-policy.md) | 修改只读/全部授权模式、工具来源判断或 SDK gate |
| [_templet.md](_templet.md) | 新知识页模板 |

## 模块图

```text
src/client
  ↕ src/shared/protocol.ts
src/server/socket-server.ts
  → PiRuntime（进程共享）
  → RoleCatalog（用户级角色目录）
  → ProjectStoreRegistry（按项目共享）
  → ProjectSessionCoordinator（按项目共享 conversation actor）
      → ConversationActor（每持久会话一个）
          → Pi SDK AgentSession
  → PiConnection（每连接项目观察与焦点）
```

## 维护规则

- 一个页面只讲一个主题。
- 新增、删除或重命名知识页时同步本索引。
- 只有跨任务仍然有效的事实才进入知识库。
- 临时计划、未验证猜测和单次 bug 过程放在 issue、计划或测试中。
