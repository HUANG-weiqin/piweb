# Pi Web

一个本机专用的极简 Agent 工作台基座。它直接嵌入官方 `@earendil-works/pi-coding-agent` SDK，不重新实现模型、认证、工具或 Agent 循环；工作台只负责会话生命周期、稳定协议和 Web UI。

极简原则：只实现必须由工作台拥有的运行状态、权限控制和持久会话。Git 已能完成的 diff/history/revert、编辑器已能完成的文件管理、终端已能完成的通用 shell，不在这里重复建设。

## 第一版能力

- 使用 Pi 内置及 `~/.pi/agent/models.json` 中的模型
- 复用 `~/.pi/agent/auth.json` 中的 API Key 和订阅登录
- 支持 Pi 公开的全部 API Key 提供商及 OAuth 订阅提供商
- 使用 Pi 默认编码工具：`read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`
- 模型和思考级别写入 Pi 原生 `settings.json`
- 工作目录可在启动页用工作台内置的只读文件夹浏览器选择，也保留绝对路径手输
- 每个项目在 `.piweb/` 中持久保存项目清单和 Pi JSONL 对话
- 支持恢复最近对话、新建、切换、重命名和永久删除非当前对话；项目移动后历史仍可打开
- 断线重连会有界等待旧连接释放对话；损坏、crash 截断或结构上不是 Pi entry tree 的 JSONL 在索引与打开前 fail closed，不会静默换会话、恢复成空历史或继续粘连写入
- 进程级共享 Pi 认证与模型目录，多浏览器连接不会各自持有陈旧缓存
- 项目存在受保护的 `.pi` / `.agents` 资源时，会在加载前询问信任；长期决定写入用户级 Pi trust store，项目不能自证可信
- 项目扩展会绑定 `session_start` / `session_shutdown`，扩展错误会进入工作台错误与 run 终态
- 项目扩展可通过 Web UI 使用 `select / confirm / input / editor / notify`；等待回答、停止、切目录和断线都有明确结算
- 每个 session 使用隔离的模型目录，项目扩展注册的静态模型或代理不会污染其他工作区
- 使用版本化、运行时校验的工作台协议，不向浏览器透传 Pi SDK 原生事件
- 使用不可复用的 sessionId / runId 隔离切目录、关闭、重连和迟到命令
- run 显式区分 queued / running / cancelling；停止可以取消尚未执行的 prompt
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
→ ProjectStore 按 canonical cwd 打开项目和持久对话
→ PiConnection 按 sessionId/runId 控制临时连接 epoch、run ticket 与工具策略
→ Pi SDK Agent 循环（扩展 hook → 工作台策略 → 工具执行）
→ 服务端投影低频项目索引、历史快照和高频运行事件
→ 浏览器按 sessionId/runId/authFlowId 过滤
→ reducer 按 runId 生成对话视图
```

共享认证、模型状态和用户级项目信任由进程级 `PiRuntime` 持有；项目身份、权限模式和对话文件由 `ProjectStore` 持有；每个浏览器连接只拥有当前 `AgentSession` 的临时运行 bundle。`abort`、认证回调、扩展 UI 回答和生命周期失效走独立控制通道；资源清理仍回到 actor 队列，因此既能及时取消，也不会与普通操作并发销毁。

持久身份与传输身份刻意分开：

- `projectId`：随 `.piweb/project.json` 移动的项目身份。
- `conversationId`：Pi JSONL 对话身份。
- `sessionId`：一次浏览器连接 bundle 的不可复用 epoch。
- `runId`：一次 prompt 执行身份。

项目布局：

```text
<project>/.piweb/
  project.json
  sessions/
    *.jsonl
```

`.piweb` 不保存 API Key；认证仍使用 Pi 的全局目录。只读模式下 Agent 不能写入它，但工作台宿主仍会保存清单和对话；全部授权模式不会额外保护 `.piweb`。

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
3. 如果还没有可用模型，页面会自动打开“工作台设置”。
4. 先选择提供商，再使用 API Key 或订阅登录；Key 通过 Pi 的 `AuthStorage` 保存，网页不会回显或在浏览器中保存。
5. 保存 Key 和切换模型会等待该次命令的明确结果；断线或失败不会伪装成成功。订阅账户按 Pi 返回的原生授权步骤操作。
6. 在“工具权限”中选择“全部授权”或“只读”。
7. 可在“项目对话”中新建、切换、命名或永久删除对话；当前对话需先新建或切换，避免删除仍在写入的 JSONL。
8. 选择模型后即可聊天。若消息发送确认前断线，先查看恢复后的对话是否已有该消息，再手动决定是否重试。

## 配置复用

本应用使用 Pi SDK 的默认目录，因此与终端 Pi 共用：

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`
- `~/.pi/agent/trust.json`
- 当前工作目录中的 Pi 资源、skills 和 extensions（仅在项目受信任后）；普通上下文文件仍按 Pi 规则加载

浏览器只在 `localStorage` 中保存最后一次工作目录和工具模式偏好，键名分别为 `piweb.lastCwd` 与 `piweb.toolMode`。消息、会话索引和 Key 均不会写入浏览器存储；消息真相位于项目 `.piweb/sessions`。

Pi 会话格式与 SDK 用法可参考官方 [SDK 文档](https://pi.dev/docs/latest/sdk) 和 [Session format](https://pi.dev/docs/latest/session-format)。本项目运行时行为以 `package.json` 锁定版本的实际类型与源码为准。

## 当前边界

- 刷新、断线或服务重启后会恢复当前项目最近一次对话；断线仍会停止正在运行的 prompt。
- 第一版支持新建、最近恢复、切换、重命名和单条永久删除；尚无分页、归档、批量删除、分支、导入、附件或多设备同步。
- 活动对话不会直接删除；先新建或切换后，列表会提供带二次确认的删除入口。
- 浏览器首版最多投影最近 200 个对话索引，并限制单次历史快照大小；完整 JSONL 不会因 UI 截断而删除。
- 项目索引当前会完整验证全部 JSONL，并与 Pi 的索引结果一一核对；超长生命周期项目的增量 catalog 与分页留到下一阶段一起设计。
- 同一服务进程内会独占一个 conversation writer；尚无跨进程文件锁，不要让两个 Pi Web 服务同时写同一个对话。
- Pi JSONL 使用同步 append 但不执行 `fsync`；它保证正常进程生命周期内可恢复，不承诺断电级 durability。
- `.piweb` 可能包含敏感对话内容。是否提交版本控制由项目决定；本仓库已忽略自身的 `.piweb/`，嵌入其他项目时也建议按需加入忽略规则。
- 工具模式不是 sandbox：可信项目扩展仍可绕开 LLM 工具入口直接访问文件或启动进程，只读模式也不能隔离扩展宿主代码。
- 全部授权会以启动服务的用户权限执行工具；不可信或无人值守任务需要容器/VM 等 OS 隔离。
- 为避免 parallel preflight 在取消或模式收紧后启动已积累的工具，启用工作台 gate 的 session 第一版固定为顺序工具执行。
- 项目扩展的自定义 `streamSimple` 和 OAuth provider 暂不启用；Pi SDK 将它们注册到进程全局，需等 worker/进程隔离后再安全开放。
- 扩展 UI 首版只桥接可移植的对话原语；terminal input、widget、theme、header/footer 和 custom TUI 组件保持不可用。
- 扩展 slash command 暂时显式拒绝：其 handler 可脱离当前 prompt 启动新 Agent turn，在有专门的 run ownership 方案前不能伪装成安全支持。prompt template 与 skill expansion 不受此限制。
- 项目扩展仍在服务进程内执行；第一版只适合可信扩展，阻塞式扩展 hook 也会阻塞对应 session。完整故障隔离需要后续 worker/子进程 runtime。
- 项目信任只阻止目录在批准前加载可执行资源，不是 sandbox；仓库文本仍可能包含 prompt injection。
- 当前安全模型只适用于可信本机用户。
- 文件夹浏览器只枚举当前目录的一层子目录，不展示文件，也不提供新建、删除、重命名或搜索；跨盘时可先输入目标盘的绝对路径再继续浏览。

这些是后续版本要显式设计的能力，不应通过绕过现有生命周期或协议边界临时拼接。

## 项目导航

未来修改先读 [AGENTS.md](AGENTS.md) 和 [`.knowledge/INDEX.md`](.knowledge/INDEX.md)。核心知识页分别描述线协议、服务端运行时与客户端状态投影。

## 验证

```bash
npm test
npm run typecheck
npm run build
```

健康检查：<http://127.0.0.1:31415/health>

## 安全边界

这是本机工具，不适合通过反向代理、局域网或公网暴露。服务端只接受 localhost 且 Origin 与请求 Host 精确一致的 WebSocket 连接。工具策略降低误操作风险，但 Pi Agent 和可信扩展仍以启动服务的用户权限运行。
