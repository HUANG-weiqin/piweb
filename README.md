# Pi Web

一个本机专用的极简 Agent 工作台基座。它直接嵌入官方 `@earendil-works/pi-coding-agent` SDK，不重新实现模型、认证、工具或 Agent 循环；工作台只负责会话生命周期、稳定协议和 Web UI。

极简原则：只实现必须由工作台拥有的运行状态、权限控制和持久会话。Git 已能完成的 diff/history/revert、编辑器已能完成的文件管理、终端已能完成的通用 shell，不在这里重复建设。

## 第一版能力

- 使用 Pi 内置及 `~/.pi/agent/models.json` 中的模型
- 复用 `~/.pi/agent/auth.json` 中的 API Key 和订阅登录
- 支持 Pi 公开的全部 API Key 提供商及 OAuth 订阅提供商
- 使用 Pi 默认编码工具：`read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`
- 用户可定义 Agent 角色：名称、简介、专属提示词和已配置提供商的固定模型
- 永久保留可编辑、不可删除的 default 角色；新会话仍必须显式选角色，不会自动套用 default
- 角色和模型在会话创建时固化，模板后续编辑不会追溯，也不能在会话中途切换
- 思考级别仍写入 Pi 原生 `settings.json`
- 工作目录可在启动页用工作台内置的只读文件夹浏览器选择，也保留绝对路径手输
- 每个项目在 `.piweb/` 中持久保存项目清单、Pi JSONL 对话和跨会话 inbox
- 可收缩的扁平左侧会话栏是唯一会话控制面，展示角色、稳定句柄、最后活跃时间、运行 spinner、等待沙漏、attention、未读和临时标记
- 支持恢复最近对话、新建、切换观察、重命名和永久删除 idle 对话；切换焦点或断线不会中止后台 Agent
- 损坏、crash 截断或结构上不是 Pi entry tree 的 JSONL，以及畸形 inbox/角色元数据，在索引与打开前 fail closed
- Agent 拥有 9 个项目内 meta 工具，可列出角色/会话、查看自身与近期消息、创建 peer、互发消息、精确等待/中止 run 和删除 idle peer
- Agent 创建会话默认不挂起调用者；它可以继续并行、显式等待，或让另一会话稍后主动回信
- 临时会话成功后先持久回传精确初始 run 结果再自动删除；失败、中止或无回复会回传失败并保留目标
- 跨会话消息是目标 Agent 的一等输入，并在双方 transcript 中显示可打开相关会话的独立消息卡片；busy 目标不会被打断
- 进程级共享 Pi 认证与模型目录，多浏览器连接不会各自持有陈旧缓存
- 项目存在受保护的 `.pi` / `.agents` 资源时，会在加载前询问信任；长期决定写入用户级 Pi trust store，项目不能自证可信
- 项目扩展会绑定 `session_start` / `session_shutdown`，扩展错误会进入工作台错误与 run 终态
- 项目扩展可通过 Web UI 使用 `select / confirm / input / editor / notify`；等待回答、停止、切目录和断线都有明确结算
- 每个 session 使用隔离的模型目录，项目扩展注册的静态模型或代理不会污染其他工作区
- 空项目会先加载一个不创建隐藏 AgentSession 的项目模型目录，因此项目扩展模型可用于管理角色、保存 Key 和创建第一条会话
- 使用版本化、运行时校验的工作台协议，不向浏览器透传 Pi SDK 原生事件
- 使用不可复用的 sessionId / runId 隔离切目录、关闭、重连和迟到命令
- run 显式区分 queued / running / waiting / cancelling；停止可以取消尚未执行的 prompt
- 消息只有在服务端明确接收后才进入对话并清空输入框；确认前断线会保留草稿、恢复历史后提示核对，不会自动重复执行
- 流式输出只在用户位于底部时自动跟随；向上阅读时可一键回到最新消息，输入框会随内容有界增长
- 工具权限只保留“全部授权”和“只读”两个项目级模式
- 全部授权模式下所有工具和命令直接执行，也可以修改项目外文件
- 只读模式只允许 Pi 原生 `read/grep/find/ls`；命令、写入、扩展和未知工具由服务端直接阻止
- 多窗口共享项目切到只读时会先封锁新运行、取消并结算旧运行，再确认持久模式
- OAuth request/progress/response/cancel 使用 authFlowId 关联，取消后的迟到帧不会复活旧流程
- 展示累计计费 token，并区分上下文 token 的 measured / estimated / unknown 来源
- 仅监听 `127.0.0.1`

## 核心运行机制

```text
浏览器命令
→ WebSocket 协议校验
→ PiConnection 建立项目观察 session 与 conversation focus
→ ProjectSessionCoordinator 按 canonical cwd 管理项目 actor/inbox
→ ConversationActor 按 conversationId 独占 Pi SessionManager 与 activeRun
→ Pi SDK Agent 循环（扩展 hook → 工作台策略 → 工具执行）
→ 服务端持久 settlement/card 并投影项目索引、focused history 和 live event
→ 浏览器按 sessionId/projectId 与 conversationId/focusId/runId 过滤
→ reducer 按 runId/cardId 生成当前 transcript
```

共享认证、模型状态和用户级项目信任由进程级 `PiRuntime` 持有；用户角色由 `RoleCatalog` 持有；项目身份、权限模式、对话文件和 inbox 由项目存储持有。`ProjectSessionCoordinator` 让每个持久 conversation 对应唯一 `ConversationActor`，不依附浏览器连接；PiConnection 只观察项目并把当前 focus 的扩展 UI 路由到浏览器。`abort`、认证回调、扩展 UI 回答和生命周期失效走独立控制通道，资源清理仍回到 actor/coordinator 串行边界。

持久身份与传输身份刻意分开：

- `projectId`：随 `.piweb/project.json` 移动的项目身份。
- `conversationId`：Pi JSONL 对话身份。
- `sessionId`：一次浏览器项目观察的不可复用 epoch。
- `focusId`：一次 conversation attach 的不可复用身份；用于阻断快速切换产生的 ABA。
- `runId`：一次 prompt 执行身份。

项目布局：

```text
<project>/.piweb/
  project.json
  sessions/
    *.jsonl
  inbox/
    *.json
```

角色目录位于 `<Pi agent dir>/piweb/roles.json`，不随项目复制。`.piweb` 不保存 API Key；认证仍使用 Pi 的全局目录。只读模式下 Agent 不能写入它，但工作台宿主仍会保存清单、对话和 inbox；全部授权模式不会额外保护 `.piweb`。

## 要求

- Node.js 22.19 或更高版本
- Windows 上如需使用 `bash` 工具，应安装 Git Bash，或在 Pi 的 `settings.json` 中配置 `shellPath`

## 开发运行

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 会把 `/ws` 代理到本地 Pi 服务。

## 生产运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:31415>。

可用 `PORT` 环境变量更改端口；监听地址始终固定为 `127.0.0.1`。

## 使用

1. 点击“选择文件夹”选取 Agent 工作目录，或手动输入绝对路径，然后进入项目。
2. 若目录含项目级 Pi 资源，先决定是否信任；拒绝后仍可聊天，但项目设置、skills 和 extensions 会被跳过。
3. 如果还没有可用模型，先在“连接与权限”中选择提供商并用 API Key 或订阅登录；Key 通过 Pi 的 `AuthStorage` 保存，网页不会回显或写入浏览器存储。
4. 打开“管理角色”，为 default 或新角色填写简介、专属提示词和模型。角色保存只在该命令收到明确回执后完成。
5. 在角色选择页显式点选一个可用角色，再创建会话；选择前没有 composer，创建后角色和模型不可更换。
6. 在“工具权限”中选择“全部授权”或“只读”。Agent 的多会话 meta 工具只在全部授权下可用。
7. 用左侧会话栏查看、新建和切换平级会话；后台会话继续运行，不会抢走当前焦点。
8. 若消息发送确认前断线，先查看恢复后的对话是否已有该消息，再手动决定是否重试。

## 配置复用

本应用使用 Pi SDK 的默认目录，因此与终端 Pi 共用：

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`
- `~/.pi/agent/trust.json`
- 当前工作目录中的 Pi 资源、skills 和 extensions（仅在项目受信任后）；普通上下文文件仍按 Pi 规则加载

浏览器只在 `localStorage` 中保存最后一次工作目录（`piweb.lastCwd`）。角色、工具权限、消息、会话索引、inbox 和 Key 均不会写入浏览器存储；角色与权限真相在用户级角色目录，消息真相在项目 `.piweb/`。

Pi 会话格式与 SDK 用法可参考官方 [SDK 文档](https://pi.dev/docs/latest/sdk) 和 [Session format](https://pi.dev/docs/latest/session-format)。本项目运行时行为以 `package.json` 锁定版本的实际类型与源码为准。

## 当前边界

- 刷新或断线后会用新观察/focus 身份恢复当前项目；coordinator-owned 后台 run 不因浏览器离开而停止。服务进程重启会中止内存中的运行，但从 durable settlement/inbox 恢复明确状态。
- 所有会话永远扁平；第一版没有父子树、固定 orchestrator 或持久 subagent 层级。
- 第一版支持新建、最近恢复、切换、重命名和单条永久删除；尚无 archive、批量删除、分支、导入、附件或多设备同步。
- busy 对话不能删除；Agent 还不能删除自身。用户界面会要求先切换/确认，Agent 必须先精确 abort、等待结算再 delete。
- 浏览器限制单次历史和卡片投影大小；完整 JSONL 不会因 UI 截断而删除。Agent 的 list/peek 同样有独立上限。
- 项目索引当前会完整验证全部 JSONL，并与 Pi 的索引结果一一核对；超长生命周期项目的增量 catalog 与分页留到下一阶段一起设计。
- 同一服务进程内会独占一个 conversation writer；尚无跨进程文件锁，不要让两个 Pi Web 服务同时写同一个对话。
- Pi JSONL 使用同步 append 但不执行 `fsync`；它保证正常进程生命周期内可恢复，不承诺断电级 durability。
- `.piweb` 可能包含敏感对话内容。是否提交版本控制由项目决定；本仓库已忽略自身的 `.piweb/`，嵌入其他项目时也建议按需加入忽略规则。
- 工具模式不是 sandbox：可信项目扩展仍可绕开 LLM 工具入口直接访问文件或启动进程，只读模式也不能隔离扩展宿主代码。
- 全部授权会以启动服务的用户权限执行工具；不可信或无人值守任务需要容器/VM 等 OS 隔离。
- 为避免 parallel preflight 在取消或模式收紧后启动已积累的工具，启用工作台 gate 的 session 第一版固定为顺序工具执行。
- 项目扩展的自定义 `streamSimple` 和 OAuth provider 暂不启用；Pi SDK 将它们注册到进程全局，需等 worker/进程隔离后再安全开放。
- 扩展 UI 首版只桥接可移植的对话原语；terminal input、widget、theme、header/footer 和 custom TUI 组件保持不可用。
- 扩展 UI 只在线路上路由到当前浏览器 focus；后台 conversation 的交互请求保持 pending 并标记 attention，用户聚焦后再弹出回答，不会自动抢焦点。
- 扩展 slash command 暂时显式拒绝：其 handler 可脱离当前 prompt 启动新 Agent turn，在有专门的 run ownership 方案前不能伪装成安全支持。prompt template 与 skill expansion 不受此限制。
- 项目扩展仍在服务进程内执行；第一版只适合可信扩展，阻塞式扩展 hook 也会阻塞对应 session。完整故障隔离需要后续 worker/子进程 runtime。
- 项目信任只阻止目录在批准前加载可执行资源，不是 sandbox；仓库文本仍可能包含 prompt injection。
- 当前安全模型只适用于可信本机用户。
- 文件夹浏览器只枚举当前目录的一层子目录，不展示文件，也不提供新建、删除、重命名或搜索；跨盘时可先输入目标盘的绝对路径再继续浏览。

这些是后续版本要显式设计的能力，不应通过绕过现有生命周期或协议边界临时拼接。

## 项目导航

未来修改先读 [AGENTS.md](AGENTS.md) 和 [`.knowledge/INDEX.md`](.knowledge/INDEX.md)。多 Agent 的角色、actor、inbox、临时会话和 9 个工具集中记录在 [Agent 协作知识页](.knowledge/kb-agent-collaboration.md)。

## 验证

```bash
npm test
npm run typecheck
npm run build
```

健康检查：<http://127.0.0.1:31415/health>

## 安全边界

这是本机工具，不适合通过反向代理、局域网或公网暴露。服务端只接受 localhost 且 Origin 与请求 Host 精确一致的 WebSocket 连接。工具策略降低误操作风险，但 Pi Agent 和可信扩展仍以启动服务的用户权限运行。
