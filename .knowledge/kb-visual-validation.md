# 浏览器视觉验证

## 用途

用项目内的无头浏览器脚本快速检查本地 Pi Web 页面是否成功渲染、常用尺寸是否出现页面级横向溢出，以及 Setup 对话框和 Escape 关闭路径是否可用。脚本只连接 loopback 地址，不替代真实工作区和完整交互的人工验收。

## Rebel 装饰密度

Rebel 装饰有意保持稀疏：新增 halftone、grain、撕边、笔刷或符号前，必须先指出一个具体的层级或身份识别失败，并证明该装饰是最小解。正文、工具结果、可编辑输入和 modal 阅读面保持无纹理；少量 section identity、选中态、COMMAND、mission 或真实状态标记也必须服从 solid shape mass，不能演变成 HUD 或游戏界面噪声。

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

该 query 只在 Vite 开发模式生效。fixture 直接组合现有 WorkspaceRail、ConversationSidebar 与 Chat，不连接 WebSocket，也不读取或写入真实项目状态。fixture 模式会展开 Tasks，等待布局观察器稳定后再截图；桌面尺寸把 transcript 定位到时间线开头，以便同时核对事件顺序和真实的“回到最新消息”状态，并保留原有 1440×900、1920×1080 selector、几何和 interaction 路径。390px 及以下的 phone fixture 初始处于 conversations list，只让 ConversationSidebar 可见；脚本通过真实的“显示工作区”“打开当前会话”和返回按钮依次检查 workspaces、chat 场景的互斥根节点、主要 rect、文档横向溢出和至少 44px 触控目标，不能用隐藏的 rail/sidebar/main 冒充可见。进入 Chat 后通过真实 launcher 打开 Tasks 与控制 sheet，展开 Tasks 并核对 dialog/backdrop、4 项、内部 overflow、关闭按钮尺寸与焦点恢复；`secondary&surface=composer-states` 还会进入 Chat 后打开等待中 sheet，核对 1 条 pending admission 与短屏内部滚动边界。601–960px 的 compact fixture 及不带 `--fixture` 的原有尺寸和 Setup 检查保持原路径。

次级界面矩阵使用 DEV-only `?fixture=secondary&surface=<name>`。脚本按 A（drawer、角色/目录/认证/扩展 dialog、feedback、已打开的 context tooltip、已展开的 activity/tool ledger、commitment、回到最新消息及其 focus-visible、composer 压力状态）和 B（setup、role-selection、empty、opening、unavailable、error-boundary）分组捕获生产组件：

```bash
npm run visual:verify -- --fixture --surfaces=A
npm run visual:verify -- --fixture --surfaces=B --reduced-motion
npm run visual:verify -- --fixture --surfaces=all
```

一般 surface 检查 1920×1080、1440×900 和 390×844；也可用 `--viewport` 缩小到单一尺寸。activity 与 commitment ledger 额外覆盖 3440×1440、960×900 和 390×600，jump 覆盖 1440×900、390×844、390×600，composer 压力状态覆盖 960×900、390×844、390×600。每个 scene 使用自己的生产 selector、分组 marker、可见性和横向溢出断言。context tooltip 通过真实指针 hover（移动尺寸走可访问的 focus-visible 路径）打开，并验证锚定、stacking 与 clipping。activity 通过真实点击依次展开原生 activity、tools 和 tool disclosure，要求六条连续 ledger row，并验证长 tool output 保持独立滚动。commitment 同样点击原生 `<details>` summary，验证长正文独立滚动、展开容器不裁切，并按桌面/移动断言详情对齐。jump 先以 CDP 原生 wheel 脱离底部，再用真实 pointer click 回到底部并重新脱离，分别捕获普通态与键盘 focus-visible。composer fixture 在脱离底部后真实收起、展开 Tasks，验证 pending、Tasks、notice、composer 不重叠且 ResizeObserver 不擅自恢复跟随，最后经 jump 返回底部。移动尺寸，以及新增 ledger/composer 的 960×900 证据，会通过真实折叠按钮收起 ConversationSidebar，避免可折叠导航占用主内容宽度。`--surfaces` 必须带 `--fixture`，并且不能与 `--motion` 同时使用。

主工作台 motion 需要可复核证据时，在单个代表性 viewport 上组合 `--fixture --motion`；再用相同命令追加 `--reduced-motion`：

```bash
npm run visual:verify -- --fixture --motion --viewport 1440x900
npm run visual:verify -- --fixture --motion --reduced-motion --viewport 1440x900
```

motion 模式只驱动三个已有生产接缝：模型按钮按下的 PUNCH、会话组展开指示的 SLASH、context compaction `DONE` 的 STAMP。脚本通过浏览器原生 CSS/Animation 协议冻结实际 transition/animation 的中间帧，不在产品 DOM 中加入测试 class。每个接缝输出 start/mid/settled（reduced 下为 start/instant/settled）局部 PNG，并在 manifest 记录实际 property、duration、easing、布局 box、展开时 DOM 是否已挂载、自然完成时的 iteration/fill，以及 settled 后仍活跃的 motion；证据 motion 会先完成并接受断言，再由脚本清理。该证据是开发期产物，不进入生产 bundle。

## 通过条件

脚本会在 HTTP 非 2xx、页面没有 `.workbench`/角色页/Setup 根节点、找不到“开启工作区”入口、Setup 无法打开或 Escape 无法关闭，以及根页面出现横向溢出时以失败退出。surface 模式还会拒绝 scene marker/分组不匹配、目标生产 surface 缺失或不可见、fixture error 泄漏、setup 表单缺失、tooltip 未真实显示或越界、ledger disclosure/本地滚动边界不成立、commitment 仍有裁切或对齐错误、真实 wheel/pointer/focus 路径不成立、composer 状态重叠或 resize 错误恢复跟随，以及 reduced-motion 下主目标或附加目标（含伪元素）仍有 CSS timing。交互诊断随 capture 写入 manifest，便于区分静态截图与真实浏览器路径证据。motion 模式还要求 PUNCH/SLASH/STAMP 命中各自 110/150/130ms token，只动画 paint/composite property，过程中布局 box 与工作台列稳定、section DOM 不被动画延迟；正常 motion 必须以有限 iteration 完成，结束后没有活跃 motion，STAMP 不能保留视觉残影。`--reduced-motion` 必须让 animation 与 transition 均为 `none`/`0s`，状态立即投影，静态诊断为 `animations: []`。

## 边界

该脚本不发送 prompt、不删除会话、不选择项目、不修改设置。motion 模式可在隔离 fixture 页面中暂时强制伪状态、点击本地 disclosure，并重启已存在的终态 CSS animation；它不触发对应产品命令，也不把证据钩子写入生产组件。activity/jump/composer scene 使用生产 Chat 的 disclosure、wheel、pointer、focus 与 ResizeObserver 路径，但数据仍是固定 fixture props；它们不证明真实 Agent run、steering admission 或服务端 settlement。fixture 只证明固定 props 下的生产组件 DOM/CSS、焦点边界和 ErrorBoundary fallback 可以渲染；App 没有独立组件 owner 的 feedback wrapper 与 Setup modal shell 只做同构的 fixture 投影，不复制 App 的 lifecycle、身份匹配、命令 guard 或持久状态。surface fixture 也不证明 WebSocket、真实 streaming、OAuth/Extension rendezvous 的完整流程。涉及这些内容时仍需生产状态测试或人工浏览器流程，并保护项目 `.piweb` 持久状态。

焦点恢复还必须用真实浏览器原生指针/键盘路径验证：组件测试可以固定 connected launcher、effect 后的首选目标和关闭后的 exact element，但不能单独证明 React commit 中原生 autofocus 与 effect capture 的先后，也不能替代嵌套模态栈、backdrop 命中和 Escape 传播的生产 DOM 证据。
