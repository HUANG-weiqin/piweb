# Pi Web Knowledge Index

`updated: 2026-10-11`

知识库记录当前架构、决策和易破坏的不变量；源码与测试是实现证据，`docs/plans/` 保留历史设计，不作为现状说明。

## 按任务找入口

| 你要解决的问题 | 先读 |
|---|---|
| 初次接手，判断功能该不该进入工作台 | [仓库总览](kb-repo-overview.md) |
| 消息“等待中”、停止后恢复、重连或切换后错位 | [客户端输入与恢复](kb-client-state.md#输入与恢复)，再读[浏览器准入](kb-agent-collaboration.md#浏览器消息准入) |
| 历史很多时打开变慢、文件损坏、列表缺席能否算删除 | [证明与发现](kb-project-sessions.md#证明与发现) |
| 老会话打不开或旧格式是否真的迁移 | [兼容性合同差异](kb-project-sessions.md#兼容性合同差异)；不要把代码现状当作兼容承诺已兑现 |
| 角色更新为什么不改变旧会话、如何创建/复用队友 | [角色与协作](kb-agent-collaboration.md) |
| 长命令、后台完成通知、停止是否真的成功 | [前台 run 与会话后台 Bash](kb-server-runtime.md#前台-run-与会话后台-bash) |
| 工具输出被省略、如何调整压缩规则 | [工具结果压缩](kb-server-runtime.md#工具结果压缩) |
| 新增工具、只读权限、首次写入或任务续跑 | [工具策略](kb-tool-policy.md)，任务状态另见[Actor LoopList](kb-agent-collaboration.md#looplist-状态与续跑) |
| 压缩、运行中安全停点、reload、截图与坐标 | [服务端运行时](kb-server-runtime.md) |
| 改命令/事件，决定身份、提交回执与投影粒度 | [线协议](kb-wire-protocol.md)；同时检查 [MCP 桥](kb-mcp-bridge.md#坑点) 是否需要同步 |
| 让 Claude Code 等外部 Agent 读写会话、协作派活 | [MCP 桥](kb-mcp-bridge.md) |
| 配置端点、模型目录、API Key 形态或 models.json | [自定义提供商](kb-custom-providers.md) |
| 配置本机语言服务、查询定义/引用或同步磁盘 | [LSP](kb-lsp.md) |
| 新增主题、改配色/风格，或证明改动没影响其它主题 | [主题分层](kb-theming.md) |
| UI 修改后如何验收真实交互 | [UI 开发流程](kb-ui-development-workflow.md)，静态布局另见[视觉校验](kb-visual-validation.md) |

## 页面与权威归属

| 页面 | 负责的详细事实 |
|---|---|
| [kb-repo-overview.md](kb-repo-overview.md) | 产品边界、模块关系与最小运行循环 |
| [kb-wire-protocol.md](kb-wire-protocol.md) | 线协议身份、观察边界、提交回执、schema 与预算 |
| [kb-server-runtime.md](kb-server-runtime.md) | Pi SDK 适配、配置/认证、压缩/checkpoint、Bash、computer、工具结果压缩 |
| [kb-custom-providers.md](kb-custom-providers.md) | 用户级 models.json、外科编辑、revision CAS 与端点探测 |
| [kb-project-sessions.md](kb-project-sessions.md) | `.piweb`、身份/租约、磁盘证明与发现、删除/截断/fork、持久格式 |
| [kb-agent-collaboration.md](kb-agent-collaboration.md) | 角色冻结、Actor、浏览器准入、inbox/receipt/settlement、八个会话工具与 wait |
| [kb-client-state.md](kb-client-state.md) | UI 消费方门控、草稿/恢复副本、展示缓存、导航、模态焦点与渲染 |
| [kb-tool-policy.md](kb-tool-policy.md) | source-aware 授权、只读 Bash 审查、Notebook 与 LoopList 首次写入门 |
| [kb-lsp.md](kb-lsp.md) | 本机 stdio 配置、共享连接、磁盘同步和只读语义查询 |
| [kb-mcp-bridge.md](kb-mcp-bridge.md) | 外部 Agent 的 MCP 工具、短连接、对话框边界与协议同步义务 |
| [kb-theming.md](kb-theming.md) | 主题清单、配色/风格/色调分层、装饰兜底与跨主题零变化验证 |
| [kb-ui-development-workflow.md](kb-ui-development-workflow.md) | 开发、隔离预览、测试与真实输入验收 |
| [kb-visual-validation.md](kb-visual-validation.md) | 无头 fixture 的布局/焦点/reduced-motion 检查及证明范围 |
| [_templet.md](_templet.md) | 新页模板（沿用现有文件名） |

## 模块图

```text
src/client                 src/mcp（MCP 桥，第二个协议客户端）
  ↕ src/shared/protocol.ts   ↕
src/server/socket-server.ts
  → PiRuntime（共享 credentials、基线模型与配置队列）
  → RoleCatalog / CustomProviderStore / UiPreferencesStore（用户级）
  → ProjectStoreRegistry（canonical cwd、handle 与 writer lease）
  → ProjectSessionCoordinator
      → ProjectContext（项目 store、inbox、惰性 WorkspaceLsp）
      → ConversationActor（每持久会话一个，与 socket 无关）
          → SessionManager + Pi SDK AgentSession + 唯一 activeRun
  → PiConnection（每连接的项目观察与 focus）
```

## 维护规则

- 每个长期主题保留一个详细 owner；其它页只保留本层不变量和链接，不复制实现流程。
- 新增、删除、重命名或改变章节导航时同步入口与引用；先合并/删除，再考虑新页。
- 不复制协议版本流水账、单次测试数量、临时性能数字或修补过程；保留仍影响决策的原因与失败边界。
- 实现与已承诺合同冲突时明确分开，不能用文档整理撤销安全或兼容承诺。
