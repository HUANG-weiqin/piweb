# Computer Use 观察与输入能力升级设计稿

日期：2026-09-07
状态：**已实现并验收**
范围：Windows 主显示器、`full_access` conversation 的 `computer` custom tool

## 0. 已实施合同（2026-09-07）

- 初始 observe 产生 `current`；带动作且有已授权前图时产生有序 `before + after` pair；没有前图的带动作 observe 产生 `after_only`。图片只复制到 provider request，绝不进入 tool result、JSONL 或线协议。
- after capture 失败、settle 中断或动作不完整时，只为该 action tool call 保留一次性 `historical_before`，结果为 `after_missing`；它永不形成 coordinate frame。
- local schema/extension/host preflight 不消费同一 assistant decision 的 frame；第一个 controller primitive/capture 才消费。未消费 frame 在下一次 provider conversion 边界退休。
- pair 两张原始 PNG 合计上限为 16 MiB；超限显式 `pair_too_large`，不降级伪装成单图或 pair。
- 非空 `observe:true` action batch 默认在 after capture 前 settle 150ms；初始 observe 与 `observe:false` 保持零等待。
- `keypress` hold、`mouseHold`、`drag` 在 adapter 内完成 down/hold/move/up；仅无法确认可能已按下的 key/button 已释放时永久 taint controller，普通 `unknown` 不阻止后续 lease。
- capture 内部以归一化 HWND + PID 绑定前台身份：capture 前后必须一致，授权批在第一个实际 primitive 前再次核对；不一致即零派发、清除 stale frame 并返回 `foreground_mismatch`。该身份仅为内部安全判断，绝不进入 provider、tool result、JSONL 或 wire；HWND/PID reuse 与 check→SendInput 的 TOCTOU 仍是已知剩余限制。

### 0.1 前台窗口观察 focus（2026-09-07）

`computer` 新增可选的 `foregroundWindow?: boolean`，默认 `false`；只有 `observe:true` 可使用，`foregroundWindow:true + observe:false` 在 controller primitive 前拒绝且不消费 sibling frame。省略时严格保持完整主显示器行为。

- `true` 截取**当时**前台顶层窗口的 `GetWindowRect` 与主显示器的非空矩形交集。`IsIconic`、空交集、几何/API 读取失败或 capture 前后 binding 漂移都 fail closed；绝不退回完整屏、selector、`PrintWindow` 或隐藏/遮挡内容读取。action 的 after 在动作/settle 后重新取当时前台窗口，因此 A 可产生 popup B 的 after。
- image-local 坐标先经 `captureBounds`（PNG 的物理 crop）映射，再以完整主显示器 `inputBounds` 归一化给 `SendInput`。两者刻意分离；本版 PNG `width/height` 必须精确等于 `captureBounds` 尺寸。仅允许主显示器交集，故不支持 secondary-only capture、`region/scale` 或 `MOUSEEVENTF_VIRTUALDESK`。
- window binding 只在进程内保存：opaque HWND/PID、raw `GetWindowRect`、crop 和 primary input bounds。capture 在同一 PMv2 DPI context 前后比较完整 binding。已有的身份检查仍紧邻首个实际 primitive；此外每个 coordinate action 紧邻 dispatch 前都重读并比较完整 window binding。任何 `foreground_mismatch` 都可能已有 `sent`；第一个 `not_started` action 和所有余项均未派发，结果必须检查逐项 status 后重新 observe。
- provider-only label 对每图仅说明 `scope=primary_display|foreground_window` 和 `size=WxH px`；不包含 HWND/PID、title、物理 origin/raw bounds。PNG、binding 和 label 均不进入 wire/JSONL/result details；pair 的 before/after 可有不同 scope/size。

## 1. 核心目标

Computer use 的可靠闭环不是“输入已经发送”，而是：

```text
观察操作前状态
→ 执行一个有界动作批次
→ 取得操作后状态
→ 用前后状态验证结果
→ 再决定下一步
```

当前实现已经能在 `observe=true` 时取得操作后截图，但下一次模型请求只收到新图，不能同时对照操作前图。本设计优先补齐这个观察边界，再补充长按、悬停、拖拽等输入能力。

## 2. 非目标与硬边界

- 不做 OS、VM、容器或文件系统 sandbox；`full_access` 仍表示宿主完整授权。
- 不新增浏览器 WebSocket command/event，不把 PNG 写入 Pi JSONL、tool result details、snapshot、localStorage 或项目文件。
- 不建立无限截图历史、录像回放或截图账本。
- 不自动判断“游戏已经胜利”或任意应用业务是否成功；工具只报告输入和截图事实，模型负责业务判断。
- 不允许跨 conversation 共享桌面观察、坐标 frame 或鼠标按下状态。
- 不支持跨调用无限保持按键/鼠标按下；所有新增长按和拖拽必须是一次调用内可清理的原子动作。

## 3. 关键术语

- **decision frame**：模型作出本批动作决策时实际看到的最新截图。
- **before image**：本批动作对应的 decision frame 的 PNG。它不是动作开始前偷偷重新截取的第二张图。
- **after image**：本批动作全部发送完成、可选 settle 等待结束后捕获的 PNG。
- **coordinate frame**：允许下一批坐标动作使用的 frame。只有 after image 成功后形成的 frame 才有资格成为 coordinate frame。
- **comparison pair**：`before image + after image + 动作结果`。图片只进入 provider-only 输入，不持久化。

最重要的区分：

```text
before/after 是比较证据
coordinate frame 是输入授权
```

前图可以帮助模型理解变化，但不能授权模型继续点击旧坐标；下一批坐标只能使用 after frame。

## 4. 前后截图合同

### 4.1 初始观察

```ts
computer({ actions: [], observe: true })
```

返回一个单独的当前观察：

```text
initial frame → provider 只收到 current image
```

它可以成为第一批动作的 coordinate frame。此时不存在 before/after pair。

### 4.2 带动作的观察

保留现有 `observe: boolean` 字段，采用以下语义：

- `actions: [] + observe:true`：捕获单张 current image。
- `actions.length > 0 + observe:true`：捕获 after image，并在下一次 provider decision 注入 before + after 两张图。
- `observe:false`：不捕获 after；建议只保留给不需要画面确认的纯键盘/文本动作。坐标动作和可能改变 UI 的动作默认由工具 prompt 要求使用 `observe:true`。
- 后续可把默认值改为 `observe:true`，但第一版先保留现有字段兼容性。

一次完整链路：

```text
provider decision sees A
→ assistant calls computer(actions, observe:true)
→ execute actions against A's authorized coordinate frame
→ capture B
→ next provider decision sees:
   [computer tool result text]
   [before image A]
   [after image B]
→ assistant may issue next computer call using B coordinates
```

下一轮滑动窗口为：

```text
(A, B) → action → (B, C)
```

最多保留当前 pair；不得继续积累 A、B、C 历史。

### 4.3 Provider-only 注入

`agent-context-budget.ts` 的 provider-only clone 扩展为支持最多两个 image part，并添加明确的文字标签：

```text
[computer observation before action batch; scope=foreground_window; size=800x600 px]
<before image>
[computer observation after action batch; scope=foreground_window; size=640x480 px]
<after image>
```

标签和图片只存在 provider 输入副本中；原始 tool result 仍然是纯文本 JSON。两张图必须：

- 使用同一个 source computer toolCallId 关联。
- 在 provider retry 中保持相同 PNG bytes、顺序和标签。
- 只在精确匹配的 computer tool result 存在时注入。
- provider 成功 assistant message 后才完成该 pair 的生命周期迁移。

### 4.4 Frame 状态迁移

建议将现有单图状态扩展为以下语义，不必暴露新的公共协议：

```text
current/authorized frame
  └─ assistant 成功产生 computer tool call
       ↓
authorized before frame
  └─ computer 执行成功并 capture after
       ↓
pending comparison pair(before, after)
  └─ provider converter 成功注入 pair
       ↓
presented pair
  └─ assistant 成功结束并产生下一 computer tool call
       ↓
authorized after frame
```

实现要求：

1. `completeAssistantDecision()` 只授权该 assistant decision 中精确的 computer call IDs。
2. 对下一批坐标动作，只授权 pair 的 after frame。
3. after frame 的 PNG 可作为下一批的 before image；旧 before image 在迁移后释放。
4. assistant tool call 被 schema、extension 或 host gate 预检拒绝时，不消费当前 assistant decision 的 frame；同一 decision 的精确 sibling 仍可使用它。只有下一 provider conversion boundary 才清除未消费 frame。
5. 普通成功 assistant message、abort、compaction、reload、run terminal 和 dispose 清除图片及授权。
6. native primitive 尚未 settle 时，仍保留 desktop lease；不能让另一 run 使用旧或未知状态的 frame。

### 4.5 操作结果 DTO

现有文字结果保持兼容，增加可选的 pair 描述。PNG 不进入其中：

```json
{
  "outcome": "completed",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" }
  ],
  "observation": {
    "before": { "status": "captured", "width": 3440, "height": 1440 },
    "after": { "status": "captured", "width": 3440, "height": 1440 },
    "comparison": "paired"
  }
}
```

允许的失败状态：

```json
{
  "outcome": "interrupted",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" },
    { "index": 1, "kind": "drag", "status": "unknown" }
  ],
  "observation": {
    "before": { "status": "captured", "width": 3440, "height": 1440 },
    "after": { "status": "unavailable" },
    "comparison": "after_missing"
  }
}
```

`sent` 只表示宿主向 Windows adapter 发出了完整 primitive；它不表示应用已经处理。`after` 截图也只表示某个采样时刻，不表示业务成功。

### 4.6 失败处理

- before 已存在、动作部分发送、after 捕获失败：可以把 before 作为“历史比较图”提供给下一 decision，但不得把它当 current/coordinate frame。
- abort、compaction、reload、run terminal：直接丢弃 before/after，不向后续 decision 提供旧桌面图。
- after 捕获失败：明确 `after_missing`，不能复活旧图冒充 after。
- `observe:false`：不生成 pair，也不保留旧坐标授权；下一次坐标操作必须重新获得有效 after/current frame。
- 任何图片注入失败不能阻塞无关模型请求，但必须使坐标动作 fail closed。

## 5. 长按与扩展输入动作

### 5.1 原则

不开放跨 tool call 的裸 `keyDown` / `keyUp` 或 `mouseDown` / `mouseUp` 状态。因为模型中断、abort、窗口切换或进程退出时容易留下卡键。

第一版只开放“调用内完成并释放”的原子动作。

### 5.2 键盘长按

在现有 `keypress` 上增加可选 `holdMs`：

```json
{
  "kind": "keypress",
  "keys": ["SPACE"],
  "holdMs": 1000
}
```

语义：

1. 按声明顺序发送所有 key down。
2. 保持 `holdMs`。
3. 按逆序发送所有 key up。
4. 无论正常完成、abort、超时还是 native 异常，都尽力释放本动作已经按下的键。

约束：

- `holdMs` 为有限非负整数，建议上限 5000ms，并受整批 15000ms deadline 约束。
- 缺省或 `0` 保持当前瞬时 keypress 语义。
- 结果仍使用 `sent / unknown / not_started`；释放不确定时不能报告完整 sent。
- 记录中可增加 `holdMs`，但不记录图片或 native 输入字节。

### 5.3 鼠标移动与悬停

新增：

```json
{ "kind": "move", "x": 1000, "y": 500 }
```

语义是移动鼠标，不点击。适用于：

- 检查 hover tooltip。
- 检查目标格高亮。
- 在点击前让应用显示瞄准预览。

`move` 必须使用当前有效 screenshot frame 的坐标；动作后如果需要确认必须 `observe:true`。

### 5.4 鼠标长按

新增原子动作：

```json
{
  "kind": "mouseHold",
  "x": 1000,
  "y": 500,
  "button": "left",
  "holdMs": 1200
}
```

语义：move → mouse down → 保持 → mouse up。不能跨调用保持按下。

### 5.5 拖拽

新增原子动作：

```json
{
  "kind": "drag",
  "fromX": 500,
  "fromY": 500,
  "toX": 900,
  "toY": 700,
  "button": "left",
  "durationMs": 600
}
```

要求：

- 起点和终点都必须来自同一有效 before/current frame。
- move → down → 有界移动 → up 必须由一次 adapter primitive 拥有。
- 中断发生在 down 后时，必须尽力发送 up；up 未确认则结果为 `unknown`。
- 不允许把 down 和 up 分散到两个 tool call。

### 5.6 双击（明确 deferred）

`doubleClick` 和 `intervalMs` **不在本次已实现 schema 或 prompt 中**。未来若实现，必须由 adapter 作为单个可清理 primitive 处理；不得把两个独立 click 伪装成原子双击。

## 6. 操作后稳定采样

新增 tool-level 可选参数：

```ts
settleMs?: number
```

建议：

- 范围 `0..2000`，受整批总 deadline 约束。
- 动作全部发送成功后等待 `settleMs`，再捕获 after。
- 非空 `observe:true` action batch 默认 150ms；模型可针对动画或加载界面显式增加。
- 这是固定延迟，不是“等待应用完成”的证明。
- 不做第一版的像素稳定检测、OCR 等隐式成功判断。

批次内部的 `wait` 仍可保留，用于动作之间的间隔；但最终 after capture 的等待应由 `settleMs` 明确表达。

## 7. 局部高清观察与窗口安全

### 7.1 局部截图（明确 deferred）

`region` / `scale` 及其坐标映射 **不在本次实现中**；在双图稳定后才可增加可选观察区域：

```ts
region?: { x: number; y: number; width: number; height: number }
scale?: number
```

要求：

- region 坐标必须来自当前全屏 frame。
- 返回裁剪原点、宽高、缩放比例和原始 frame identity。
- before 与 after 必须明确是否使用同一区域和缩放。
- 坐标动作仍以全屏物理坐标映射为权威，不能把裁剪图像坐标直接当屏幕坐标。
- 全屏概览与局部图不同时建立第二套坐标真相。

### 7.2 前台窗口身份

本次已实现内部 opaque HWND + PID frame binding、capture 前后稳定校验及首个输入前复核；不匹配则零派发、返回 `foreground_mismatch` 并要求重新观察。身份数据不向 provider 或任何持久/线协议投影。

窗口标题、窗口边界、公开 expected-window schema 和由模型声明预期身份 **明确 deferred**。人工仍可能在观察后切换窗口，因此每个授权批仍须重新核对。

## 8. Schema 与验证

当前 `kind` 是宽泛字符串，建议继续使用 provider 兼容的 flat object，但在服务端做完整二次校验：

```ts
type ComputerActionKind =
  | "click"
  | "move"
  | "mouseHold"
  | "drag"
  | "type"
  | "keypress"
  | "scroll"
  | "wait";
```

工具说明必须列出：

- 每种 kind 的必填字段。
- 支持的键名和按钮。
- 坐标来自哪一张图。
- `holdMs`、`durationMs`、`settleMs` 上限。
- `observe:true` 对动作批的意义。
- `sent` 不等于应用成功。
- action batch 最多 8 项；scroll 至少一个 delta 非零；动作 pair 的双图约消耗两倍视觉 token；`foreground_mismatch` 表示零派发，必须重新 observe。

非法批次必须在任何 desktop lease、副作用、旧 frame 清理前完整拒绝。动作按顺序执行，最多 8 项，整批保留现有 15000ms deadline。

## 9. 内存与 provider 成本

- 每个 exact run 最多保留一组 comparison pair；不能积累历史。
- 每张 PNG 保持现有限制；新增 pair 总字节数也必须有界。
- 超出 pair 内存或 provider image 限制时，优先明确失败；不要偷偷只保留 after 却宣称 paired。
- provider retry 使用相同 immutable before/after bytes。
- 图片仍不进入 `SessionManager`、JSONL、history snapshot、wire、PublicState 或浏览器。
- 双图会增加视觉 token 成本，必须在工具描述和实现文档中明确；局部截图是降低成本的后续手段。

## 10. 实现边界

### `src/server/computer-use.ts`

- 将单 `ObservationState` 扩展为 before/after pair 与 authorized coordinate frame。
- 保留 exact owner、toolCallId、lease、abort、deadline 规则。
- `execute()` 在动作批前保存可比较的 authorized before image；动作结束后按 `settleMs` 捕获 after。
- 增加 move、mouseHold、drag、keypress hold 的验证和 adapter dispatch。
- 处理中断后的释放与 quiescence，不能提前转移 desktop lease。

### `src/server/pi-runtime.ts`

- 更新 flat tool schema 和 prompt guideline。
- 将 pair provider image resolver 传给 converter。
- `completeAssistantDecision()` 只授权 after frame。
- 处理旧工具调用的兼容结果，禁止被拒调用复用旧坐标。

### `src/server/agent-context-budget.ts`

- 将单 `ComputerProviderImage` 扩展为有序 before/after image parts。
- 只修改 provider-only clone，不修改原 AgentMessage。
- 只有 exact source toolResult 才注入 pair。
- provider retry 保持 pair 不变。

### `src/server/conversation-actor.ts`

- 复核 assistant message_end、abort、compaction、reload、settle、dispose 的清理路径。
- 确保正常 assistant toolUse 后只把 after frame 交给后续 coordinate call。

### 文档

- 更新 `docs/plans/2026-09-07-minimal-computer-use-design.md` 的单图约束，标注已被本设计替换的部分。
- 不修改 `src/shared/protocol.ts` 或 `PROTOCOL_VERSION`。

## 11. 测试矩阵

### 双图

1. 初始 observe 只有 current image。
2. A → actions → B 后，provider 输入按 before=A、after=B 顺序包含两图。
3. 下一批变为 B、C，不再包含 A。
4. 只有 B 的 frame 可用于下一批坐标；A 坐标被拒绝。
5. provider retry 收到完全相同的 A/B bytes。
6. tool result、history、JSONL、wire fixture 不包含 PNG/base64/image part。
7. after 捕获失败返回 `after_missing`，不伪造 paired。
8. partial dispatch、abort、timeout 不复活旧 after，也不把 before 授权为坐标 frame。
9. schema/extension/host gate 预检拒绝不消费同一 decision 的 exact sibling frame；下一 provider conversion 清除未消费 frame。
10. compaction、reload、terminal、dispose 清除 pair 和 lease。

### 长按与输入

11. keypress `holdMs` 按下顺序正确、释放逆序正确。
12. mouseHold 正常结束释放鼠标。
13. mouseHold 在 abort/native unknown 后尽力释放，结果为 unknown 而非 sent。
14. drag 起点/终点均校验，跨调用无法遗留按下状态。
15. move/hover 不产生点击。
16. duration、hold、settle 超限在副作用前拒绝。
17. `sent / unknown / not_started` 在每个动作阶段准确。

### 边界

18. 前台窗口不匹配时不发送输入。
19. **Deferred：**region/scale 映射及裁剪坐标合同尚未实现，不能把本项当作本次验收。
20. 两个 conversation 仍由 desktop lease fail-fast 互斥。
21. 非 vision model、read_only、无 exact active run 仍在副作用前拒绝。
22. 真实 Windows adapter 的人工 smoke 覆盖键盘长按、鼠标长按、拖拽和前后截图；CI 只使用 fake adapter。（本次按任务约束未执行真实桌面 I/O。）

## 12. 验收标准

实现完成必须满足：

- Agent 能看到动作前后两张明确标注的图，并根据差异继续决策。
- 后图是下一批唯一可用坐标依据。
- 长按、悬停、拖拽在一次调用内可完成并可清理。
- 输入发送、截图取得、应用响应、业务成功不会被混为一个状态。
- abort、retry、compaction、reload、窗口切换和多 run 竞争不会泄露旧图、旧坐标或按下状态。
- 截图不进入持久历史或浏览器协议。
- 现有短按、点击、输入文本和滚动保持兼容。

推荐实现顺序：

```text
1. before/after pair 与 provider-only 注入
2. after 默认采样与 settleMs
3. keypress holdMs
4. move / mouseHold / drag
5. 明确 schema 与内部 foreground identity 保护
6. **Deferred：**局部高清截图/region/scale、公开 expected-window schema 和双击
```
