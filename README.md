# Pi Web

一个本机专用的极简 Pi Web UI。它直接嵌入官方 `@earendil-works/pi-coding-agent` SDK，不重新实现模型、认证、工具或 Agent 循环。

## 第一版能力

- 使用 Pi 内置及 `~/.pi/agent/models.json` 中的模型
- 复用 `~/.pi/agent/auth.json` 中的 API Key 和订阅登录
- 支持 Pi 公开的全部 API Key 提供商及 OAuth 订阅提供商
- 使用 Pi 默认编码工具：`read`、`bash`、`edit`、`write`
- 模型和思考级别写入 Pi 原生 `settings.json`
- 工作目录由启动页面指定
- 对话使用 `SessionManager.inMemory()`，不会生成会话 JSONL
- 仅监听 `127.0.0.1`

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

1. 输入 Agent 工作目录并开始。
2. 如果还没有可用模型，页面会自动打开“模型与登录”。
3. API Key 会通过 Pi 的 `AuthStorage` 保存；网页不会回显或在浏览器中保存 Key。
4. 对于 ChatGPT、Claude 或 GitHub Copilot 等订阅，点击“订阅登录”，按 Pi 返回的原生授权步骤操作。
5. 选择模型后即可聊天。模型拥有 Pi 默认文件与命令工具，请只选择你信任的工作目录。

## 配置复用

本应用使用 Pi SDK 的默认目录，因此与终端 Pi 共用：

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`
- 当前工作目录中的 Pi 资源、skills、extensions 和上下文文件

浏览器只在 `localStorage` 中保存最后一次工作目录，键名为 `piweb.lastCwd`。消息和 Key 均不会写入浏览器存储。

## 验证

```bash
npm test
npm run typecheck
npm run build
```

健康检查：<http://127.0.0.1:31415/health>

## 安全边界

这是本机工具，不适合通过反向代理、局域网或公网暴露。服务端会拒绝非 localhost 来源的 WebSocket 连接，但 Pi Agent 本身拥有文件修改及命令执行能力。
