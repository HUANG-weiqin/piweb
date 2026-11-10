# 主题分层

`updated: 2026-11-11`

## 用途

本页说明多套界面主题怎样共存：哪一层负责什么，新增主题要改哪里，以及怎样证明改动没有影响其它主题。布局（网格、宽高、位置、断点）由组件 CSS 拥有，所有主题共用，主题不能改。

## 术语

- **主题（theme）**：用户在“设置 → 外观”里选的一项，线协议字段仍叫 `colorScheme`。一个主题 = 一个配色 + 一个风格 + 一个色调。
- **配色（palette）**：一组颜色变量。文件 `src/client/styles/themes/<id>.css`，选择器 `html[data-color-scheme="<id>"]`。
- **风格（skin）**：字体、字号/圆角/线宽/字距旋钮、动效、阴影，以及该风格独有的装饰。文件 `src/client/styles/skins/<skin>.css`，选择器 `html[data-skin="<skin>"]`。
- **色调（tone）**：工作面与运行状态的着色方式。`quiet`：深色工作面，运行/等待/完成/失败按 intent/warning/success/danger 着色；`poster`：纸张与氧化红海报配色。规则在组件 CSS 中写作 `html[data-tone="quiet"] …`。
- **装饰变量**：以 `--decor-` 开头，只由某个风格定义。使用处必须写中性兜底，例如 `clip-path: var(--decor-clip-send-button, none)`。

## 分层

1. 组件 CSS（`src/client/styles/*.css`）：布局，以及只通过变量取值的外观。不得出现 `data-color-scheme` 或 `data-skin` 选择器（契约测试检查）。
2. `tokens.css`：由风格旋钮派生的阶梯。`--fs-12`、`--radius-10`、`--stroke-3`、`--fw-800` 的数字是 Rebel 的参考值，不是最终值；风格用 `--type-scale`/`--type-shift`/`--type-max`、`--radius-scale`、`--stroke-scale`、`--weight-max` 统一换算，也可以单独覆盖某一级。
3. 风格文件：契约块（每个风格都必须定义同一组变量，以 `skins/rebel.css` 为参考）和可选的装饰块。没有定义的装饰变量自动回到中性兜底，所以新风格默认是干净的。
4. 配色文件：只写颜色。每个配色必须与 `themes/quiet-rebel.css` 定义完全相同的变量集合。`--scheme-rebel-*` 是各区域的角色名（black=主工作面，rail-black=工作区栏，sidebar-black=会话栏，raised=抬升面，paper=主文字，red=品牌强调），新配色也要逐个填写。
5. 风格覆盖文件（可选，如 `skins/code-overrides.css`）：在所有组件 CSS 之后加载，只重绘（背景、颜色、轮廓、装饰伪元素自身的框），不移动、不改尺寸。只在变量层无法表达时使用，颜色仍取自配色变量。

`src/client/lib/theme-registry.ts` 是客户端唯一的主题清单：名称、简介、风格、色调、设置页色板。`applyTheme()` 同时写 `data-color-scheme`、`data-skin`、`data-tone`。`index.html` 静态写默认主题属性，保证首帧正确。服务端只按共享 `COLOR_SCHEMES` 校验 id。

## 新增一个主题

1. 在 `src/shared/protocol.ts` 的 `COLOR_SCHEMES` 加 id，并推进 `PROTOCOL_VERSION`（桥会因版本不一致拒绝旧服务端，需要重新 build 并重连 MCP）。
2. 写 `themes/<id>.css`，定义全部配色变量。
3. 需要新形状时写 `skins/<skin>.css`；否则复用已有风格。
4. 在 `theme-registry.ts` 登记，并在 `src/client/styles.css` 导入新文件（契约测试检查导入）。
5. 运行验证（下一节）。

## 证明其它主题没变

- `npm run theme:snapshot -- capture --url <dev 地址> --out a.json` 在 DEV fixture 上记录每个元素的计算样式与几何；改动后再录一次，用 `compare a.json b.json` 对比。fixture 通过 `?theme=<id>` 选择主题。它只看静止状态。
- hover/focus/媒体查询等状态规则需要静态核对：逐条规则在每个主题下替换变量后比较结果。本次重构用的是一次性脚本，未入库；需要时按同样思路重写。
- `npm run visual:verify -- --fixture --theme <id>` 截图与交互检查；motion 期望值从当前主题的 `--motion-*-duration` 读取，值为 `0ms` 的动作视为该主题关闭并跳过。
- `src/client/styles/theme-contract.test.ts` 检查配色与风格完整、装饰变量都有兜底、组件 CSS 没有主题选择器。

## 坑点

- 自定义属性在定义它的元素上就完成 `var()` 替换。定义在 `html` 上的变量不能引用只在组件上定义的区域别名（如 `--rebel-raised`），否则整个变量失效、使用处静默落到兜底值。
- 基线 CSS 里已有 5 个从未定义的变量：`--text`、`--surface`、`--shadow`、`--rebel-paper-deep`、`--rebel-line-strong`。使用处一直按“未定义”渲染（继承或初始值）。不要新增同名变量，否则会改变现有外观；要修复它们，应单独评估视觉变化。
- Rebel 的纸张海报面（设置卡、角色卡、角色对话框）里 paper 是底色、black 是文字。深色风格可以在这些容器内交换两者，但对话框里 black 同时画了标题栏、按钮和选中行，需要逐个映射。
