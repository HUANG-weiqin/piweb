# 浏览器视觉验证

## 用途

用项目内的无头浏览器脚本快速检查本地 Pi Web 页面是否成功渲染、常用尺寸是否出现页面级横向溢出，以及 Setup 对话框和 Escape 关闭路径是否可用。脚本只连接 loopback 地址，不替代真实工作区和完整交互的人工验收。

## 使用

先在一个终端启动本地服务：

```bash
npm run dev
```

再在另一个终端运行：

```bash
npm run visual:verify
```

默认检查 `http://127.0.0.1:5173/` 的 1440×900、1920×1080、3440×1440 和 390×844，并将 PNG 与 manifest 写入 `.visual-validation/<唯一运行目录>/`。该目录已加入 `.gitignore`。

常用选项：

```bash
npm run visual:verify -- --url http://127.0.0.1:5173/
npm run visual:verify -- --viewport 390x844
npm run visual:verify -- --reduced-motion
npm run visual:verify -- --wait 1200
```

如果浏览器不在默认路径，设置 `PIWEB_BROWSER` 指向 Edge/Chrome/Chromium 可执行文件。

需要固定的丰富工作台画面时，开发服务下打开 `http://127.0.0.1:5173/?fixture=workbench`，或直接捕获 1920×1080 与 1440×900 两个桌面尺寸：

```bash
npm run visual:verify -- --fixture
```

该 query 只在 Vite 开发模式生效。fixture 直接组合现有 WorkspaceRail、ConversationSidebar 与 Chat，不连接 WebSocket，也不读取或写入真实项目状态。fixture 模式会展开 Tasks 后截图，并跳过只适用于普通入口的 Setup 交互检查；不带 `--fixture` 时原有四尺寸和 Setup 检查保持不变。

## 通过条件

脚本会在 HTTP 非 2xx、页面没有 `.workbench`/角色页/Setup 根节点、找不到“开启工作区”入口、Setup 无法打开或 Escape 无法关闭，以及根页面出现横向溢出时以失败退出。`--reduced-motion` 会记录对应媒体条件下的截图和动画诊断。

## 边界

该脚本不发送 prompt、不删除会话、不选择项目、不修改设置。丰富工作台 fixture 只证明固定 mock 状态的生产组件 DOM/CSS 可以渲染，不证明 WebSocket、真实 streaming、OAuth、Extension 或所有 Dialog 的完整交互。涉及这些内容时仍需人工浏览器流程，并保护项目 `.piweb` 持久状态。
