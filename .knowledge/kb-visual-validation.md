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

## 通过条件

脚本会在 HTTP 非 2xx、页面没有 `.workbench`/角色页/Setup 根节点、找不到“开启工作区”入口、Setup 无法打开或 Escape 无法关闭，以及根页面出现横向溢出时以失败退出。`--reduced-motion` 会记录对应媒体条件下的截图和动画诊断。

## 边界

该脚本不发送 prompt、不删除会话、不选择项目、不修改设置，也不证明真实 transcript、工具调用、LoopList、OAuth、Extension 或所有 Dialog 的完整状态。涉及这些内容时，应在隔离 fixture 或人工浏览器流程中继续验收，并保护项目 `.piweb` 持久状态。
