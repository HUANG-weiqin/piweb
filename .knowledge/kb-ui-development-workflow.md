# UI 开发与验证流程

## SOP

1. 从干净的 `main` 创建 feature 分支/worktree；不要直接修改 `main`。
2. 修改 UI 时同步补组件测试。
3. 启动本地预览并优先使用隔离 fixture：

   ```bash
   npm run dev
   npm run visual:verify -- --fixture
   ```

   fixture 不连接 WebSocket，也不读写真实 `.piweb` 状态。真实会话流程另做生产状态测试或人工验收。
4. 检查桌面、移动端、弹窗/焦点/Escape、响应式和 reduced-motion；详细命令见 `kb-visual-validation.md`。
5. 提交前运行：

   ```bash
   npm test
   npm run typecheck
   npm run build
   git diff --check
   ```

6. 在干净的 integration worktree 中用 `--no-ff` 合并到 `main`；`main` 有未提交改动时不要合并。
7. 合并后再次运行上述门槛，并做 `/health` 与浏览器主流程 smoke。仅当运行中的服务需要加载新代码时执行 `npm run reload`。

## 真实交互隔离验收

涉及准入、SDK 运行或会话持久化时，可在构建后运行：

```bash
npm run build
npx --no-install tsx scripts/verify-interaction.ts
```

该脚本用本机 Chrome/Edge（可设 `PIWEB_BROWSER`）和临时 agentDir/cwd 启动真实 HTTP/WS、PiRuntime、Coordinator、Actor 与 SDK；唯一替身是 session-local 模型响应，不调用收费模型、不碰用户项目。它区分 browser send、`run_queued`、busy `prompt_admitted` 与 raw JSONL `prompt_delivered`，验证标题 gate 未放行时主 run 已结算，以及等待中消息经新 exact reconnect snapshot 恢复、随后只落盘一次。浏览器进程和 fixture owner 均按有界清理退出。

它不是 `visual:verify -- --fixture` 的静态展示替代品；后者不能证明运行和持久化。单次 `piweb.transition` trace 只作分阶段观察，不能当作延迟分位数或一般性能收益。涉及 coordinator/actor/store 协作路径还须按 AGENTS 运行 `npm run test:slow`。

## 产物

截图、日志和构建证据放在 `.visual-validation/`，不进入产品提交。
