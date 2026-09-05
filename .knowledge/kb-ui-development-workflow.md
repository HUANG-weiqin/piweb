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

## 产物

截图、日志和构建证据放在 `.visual-validation/`，不进入产品提交。
