# Computer Use 观察与输入能力升级设计稿

日期：2026-09-07
最近修订：2026-09-16
状态：**已实现并验收**
范围：Windows 主显示器、`full_access` conversation 的 `computer` custom tool

> 2026-09-16 修订取代早期的 provider-only `before + after` 临时图片对方案。当前合同没有图片滑动窗口，也不在 provider conversion 时改写历史。

## 0. 已实施合同

一次成功截图直接成为当前 `computer` tool result 的标准 image content：

```text
[结果 JSON text]
[安全标签 text]
[image/png 或 image/jpeg]
```

- `actions: [] + observe:true` 产生一张 `current` 图。
- `actions.length > 0 + observe:true` 在动作和 settle 后产生一张 `after action batch` 图。
- `observe:false` 不产生图片。
- 前一张图已经存在于持久 transcript；动作结果不再复制它。连续观察自然形成 `A → B → C` 的 append-only 历史，而不是 `(A,B) → (B,C)` 的临时窗口。
- image block 由 Pi `SessionManager` 写入 JSONL，并在后续 provider 请求中按原顺序和原字节重放。只要源 entry 仍在有效模型上下文中，retry 和后续请求看到完全相同的 block；compaction 可把较早 entry 排除出有效模型上下文，但不删除持久 JSONL。
- 浏览器线协议不携带 base64。实时 tool event 只投影 shape-only image marker；history 使用 `(messageId, imageOrdinal)` 的 `resultImageRefs`，用户需要时再通过 `open_image` 读取持久字节。
- 图片持久化与坐标授权是两个不同状态。Controller 只瞬态保留不含图片字节的 `Frame` 几何、前台绑定和 label/MIME/hash 交付证据；持久图片本身永不授权输入。
- 每个 assistant decision 只授权其列出的 exact computer tool-call IDs；首个实际 controller primitive 或 capture 消费该 decision。schema/extension/host preflight 拒绝不消费 sibling 的授权。
- capture 失败、abort、compaction、reload、run terminal、dispose 或没有 computer call 的下一 decision 都清除瞬态 frame。旧持久图片不能复活为 coordinate frame。
- 非 vision model 与 `images.blockImages=true` 都在创建 desktop adapter 或产生桌面副作用前拒绝 computer use。
- 原始 desktop PNG 与通用 durable image 读取合同共享 16 MiB decoded-byte 上限；computer 在 tool 返回前进一步归一化到最大 2000×2000、base64 严格小于 4.5 MiB，持久化的是归一化结果。

### 0.1 前台窗口观察

`foregroundWindow?: boolean` 默认 `false`，且只有 `observe:true` 可使用。

- `false` 截取完整主显示器。
- `true` 截取**当时**前台顶层窗口 `GetWindowRect` 与主显示器的非空交集，不是窗口 selector，也不读取隐藏或遮挡内容。
- `IsIconic`、空交集、几何/API 失败或 capture 前后绑定漂移均 fail closed，绝不退回完整屏。
- action batch 的 after capture 在动作和 settle 后重新读取当时前台窗口，因此窗口 A 可以产生 popup B 的 after 图。
- model-image-local 坐标先经 `captureBounds` 映射，再以完整主显示器 `inputBounds` 归一化给 `SendInput`。原始 PNG 宽高必须精确等于 capture bounds；归一化持久图可等比缩小，Frame 的模型尺寸随实际持久图更新。
- HWND、PID、raw bounds、capture bounds 和 input bounds 仅存在于进程内 frame；tool result 的安全标签只含 `scope` 与 `size`。

## 1. 核心目标

Computer use 的可靠闭环是：

```text
观察 A
→ 基于 A 决定一个有界动作批次
→ 执行动作并观察 B
→ provider 历史自然包含 A、动作结果、B
→ 基于 B 决定下一步
```

必须同时满足两个独立性质：

1. **观察历史可重放**：同一 transcript 的 provider 输入保持 append-only，使 SSE prompt cache 和 Codex WebSocket continuation 能复用稳定前缀。
2. **输入能力不过期**：坐标只来自紧邻 decision 的最新 frame，不能从持久历史任取旧图来点击。

## 2. 非目标与硬边界

- 不做 OS、VM、容器或文件系统 sandbox；`full_access` 仍表示宿主完整授权。
- 不新增浏览器 WebSocket command/event，不把 base64 放进 history snapshot、PublicState、localStorage 或普通 tool event。
- 不建立第二套截图账本、图片滑动窗口或 provider-only image injector。持久 transcript 是唯一图片历史。
- 不在 compaction 后继续把被压缩掉的旧图强行注入 provider context。
- 不自动判断应用或游戏业务是否成功；`sent` 只表示 Windows 接受了宿主派发。
- 不允许跨 conversation 共享观察 frame、坐标授权或鼠标按下状态。
- 不支持跨调用无限保持按键或鼠标按下；长按和拖拽必须在一个调用内清理。
- 不公开 HWND/PID、窗口标题或桌面物理 origin。

## 3. 三类状态

### 3.1 持久观察记录

图片 owner 是 tool-result message；身份是 `(messageId, imageOrdinal)`，生命周期随 branch、truncate 和 conversation 删除。

它包含：

- 一条 JSON 结果 text；
- 一条安全标签，例如 `[computer observation current; scope=primary_display; size=1920x1080 px]`；
- 一条经有界归一化的 `image/png` 或 `image/jpeg` base64 content。

相同像素出现在不同 tool result 中仍是不同观察记录，不按内容去重。

### 3.2 瞬态坐标 frame

`Frame` 只保存坐标映射和安全复核所需数据：

- image width/height；
- scope；
- capture/input bounds；
- foreground identity；
- 可选 foreground-window binding。

它不保存 PNG，不进入 provider、JSONL 或 wire。

### 3.3 Assistant-decision 授权

授权由 `{ owner, frame, exact toolCallIds }` 组成，只服务一个 assistant decision。持久图片只是模型输入事实，不能替代该能力。

## 4. Tool result 与 provider 历史

### 4.1 成功截图

初始观察：

```ts
computer({ actions: [], observe: true })
```

返回：

```text
{"outcome":"completed","actions":[],"observation":{"status":"captured","width":1920,"height":1080}}
[computer observation current; scope=primary_display; size=1920x1080 px]
<durable image A>
```

带动作观察只返回新捕获的 after 图：

```text
<此前持久的 durable image A>
assistant → computer(actions, observe:true)
{"outcome":"completed", ... "observation":{"status":"captured", ...}}
[computer observation after action batch; ...]
<durable image B>
```

下一 provider request 通过普通 transcript conversion 看到 A 和 B。它不复制 A，也不在 converter 尾部临时插图。

### 4.2 Append-only 约束

- `computer` execute 返回的 image content 必须由 Pi 正常持久化后再参与 history projection。
- computer 在 tool 返回前完成一次有界归一化，使项目 `tool_result` hook 之后的 Pi SDK normalization 成为 no-op；宿主随后复核完整标准 content，label/image 被删除、替换、重排或 hook 抛错时 fail closed 并清除 frame。
- 最终 `convertToLlm` 边界只校验、不注入：source toolCallId 对应的规范 details text、label、MIME 与图片哈希必须匹配 pending frame；`context` / `message_end` 改写、`blockImages` 或缺图会撤销交付证明。
- provider retry 对同一消息产生相同标签、MIME、顺序和 base64。
- 追加 B 后，追加前的 provider input 必须是追加后 input 的严格前缀；不能删除 A、把 A 改写成比较标签或把 B 重复成下一轮 before。
- `agent-context-budget.ts` 只负责 LoopList/context hint，不拥有 desktop image。
- `images.blockImages=true` 时不能生成一个“模型未看到但仍可授权坐标”的 frame，因此整个 computer call fail closed。

### 4.3 Wire 与按需读取

三种投影故意不同：

| 边界 | 图片表示 |
|---|---|
| Pi JSONL / provider history | 完整标准 image content |
| tool event / history snapshot | image marker + `resultImageRefs`，无 base64 |
| `open_image` 一次性响应 | 从当前 branch 的精确 message/ordinal 读取 base64 |

`details` 中禁止放 PNG/base64；通用 wire redaction 只处理标准 content image block。

### 4.4 Compaction

Compaction summary 不复制图片。被 cut point 排除的 image entry 不再进入后续 provider context，因此 cache 的新稳定前缀从 summary 和保留 tail 开始。原 JSONL entry 仍用于审计/history/open-image，直到 branch 或 conversation 删除。

## 5. Frame 状态迁移

```text
successful raw capture
  ↓ one-time provider normalization
pending_frame(owner, displayed frame, sourceToolCallId, details/label/MIME/hash)
  ↓ final convertToLlm finds the exact durable block
presented pending_frame
  ↓ next assistant message_end with toolUse
beginAssistantDecision(owner)
  ↓ exact computer call IDs are non-empty and presentation still matches
authorized_frame(owner, frame, toolCallIds)
  ↓ first real primitive or capture
spent decision + clear authorized frame
  ↓ optional successful observe
new pending_frame(owner, new frame)
```

规则：

1. 只有 pending frame 的 owner 可以授权它。
2. 只有该 assistant decision 中列出的 exact computer call 可使用授权。
3. validation/preflight 在任何 lease、frame consumption 或桌面副作用前完成。
4. 首个实际 primitive/capture 使该 decision 成为 spent；同一 decision 的第二个 batch 即使列在 sibling IDs 中也拒绝。
5. 同一次 validated after/current capture 先归一化为最终 image result，并让 pending frame 的模型坐标尺寸等于该图；物理 capture/input bounds 不变。
6. 只有普通 Pi 持久化成功且最终 converter 看到 exact source/details/label/MIME/hash 后，pending frame 才具有下一 decision 的交付证明。
7. failed capture/normalization 清除 frame，并返回 unavailable 或 fail closed；不会回退到历史图。
7. `observe:false` 不产生新 frame；执行完后下一坐标动作必须重新 observe。
8. 普通 assistant 结束、没有 computer call 的 tool decision、abort、compaction、reload、terminal 和 dispose 都清理 frame。
9. desktop native primitive 尚未 settle 时仍保留 lease，不能让另一 run 使用未知桌面状态。

## 6. 结果 DTO 与失败语义

结果 metadata 只描述本次调用：

```json
{
  "outcome": "completed",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" }
  ],
  "observation": {
    "status": "captured",
    "width": 1920,
    "height": 1080
  }
}
```

capture 失败或未请求观察：

```json
{
  "outcome": "interrupted",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" },
    { "index": 1, "kind": "drag", "status": "unknown" }
  ],
  "observation": { "status": "unavailable" },
  "reason": "aborted"
}
```

- `sent`：宿主完成该 adapter primitive 的派发，不证明应用处理或业务成功。
- `unknown`：不能确认 primitive 是否完整完成。
- `not_started`：该 action 没有派发。
- `foreground_mismatch` 可能发生在若干 action 已 sent 之后；第一个 not_started 及余项未派发，调用方必须检查逐项状态并重新 observe。
- capture 失败时 content 只有结果 JSON text，不附安全标签或 image。

## 7. 输入动作

支持的 flat action：

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

### 7.1 坐标动作

`click`、`move`、`mouseHold`、`drag` 和 `scroll` 必须使用本 decision 的 authorized frame。坐标是 image-local 像素，`(0,0)` 为返回图片左上角，绝不能直接使用桌面全局坐标。

完整 foreground identity 在首个 primitive 前复核；foreground-window frame 还在每个坐标 primitive 紧邻 dispatch 前复核完整 binding。

### 7.2 长按与拖拽

- `keypress.holdMs`：按声明顺序 key down，等待，再逆序 key up。
- `mouseHold`：move → down → hold → up。
- `drag`：move start → down → bounded move/end → up。
- 无论正常、abort、deadline 或 native error，都尽力释放已经按下的 key/button。
- 只有无法确认可能已按下状态已释放时才永久 taint controller；普通 `unknown` 不永久占有 lease。
- 不开放跨 tool call 的裸 `keyDown/keyUp` 或 `mouseDown/mouseUp`。

## 8. 操作后稳定采样

`settleMs?: number` 范围为 `0..2000`，受整批 15000ms deadline 约束。

- 非空 `actions + observe:true` 默认在 after capture 前等待 150ms。
- 初始空 observe 和 `observe:false` 不自动等待。
- settle 是固定延迟，不证明应用已经稳定或业务完成。
- 批内 `wait` 用于 action 之间的显式间隔；最终 capture 延迟仍由 settleMs 表达。

## 9. Schema、容量与成本

- action batch 最多 8 项。
- `type` 最多 4096 UTF-8 bytes。
- `holdMs <= 5000`、`durationMs <= 5000`、`wait.ms <= 5000`。
- scroll delta 绝对值不超过 10000，且至少一个 delta 非零。
- 原始 desktop PNG 必须有合法 signature、正尺寸，且 decoded bytes 不超过共享的 16 MiB image cap。
- computer 的持久结果最大 2000×2000，base64 严格小于 4.5 MiB，可为 PNG 或 JPEG；Pi SDK 的第二次 normalization 必须是 no-op。
- 通用 `open_image` 仍允许最多 16 MiB decoded bytes（canonical base64 最大约 21.34 MiB），低于 64 MiB server event envelope。
- 每张图在 compaction 前会随 transcript 重放并消耗视觉 token。这是 append-only/cache-stable 合同的直接成本；实现不得用滑动窗口或重复 before 图来隐藏或扩大该成本。
- 本修订没有另设 provider request 的累计图片字节预算。密集的大截图可能在 token-based compaction 之前触及 provider/transport 总请求上限；当前诚实暴露该错误，后续若治理应在 compaction/admission 边界处理，不能静默删改持久前缀。
- JSONL 会保留完整图片，compaction 不物理删除旧 entry。项目没有另建 retention policy；Git/branch/conversation 生命周期仍是持久数据管理边界。

## 10. 实现所有权

### `src/server/computer-use.ts`

- 校验 action、管理 lease/deadline/pressed-state 与 foreground safety。
- 捕获原始 PNG，构造标准 tool-result content，并只保留无图片字节的 pending/authorized frame 及小型交付摘要。
- 维护 one-decision/one-batch 消费语义。

### `src/server/pi-runtime.ts`

- 注册 tool schema、说明与 image-delivery admission。
- 在 tool 返回前一次性归一化图片并同步 Frame 的模型坐标尺寸，使 Pi SDK normalization 成为 no-op。
- 在项目 tool-result hook 后保护标准 content，并在最终 converter 边界校验 exact source/details/label/MIME/hash；不一致时清除或拒绝 frame。
- 在 assistant decision 边界传递 exact computer tool-call IDs。
- converter 不缓存、不注入也不改写图片。

### `src/server/conversation-actor.ts`

- 在 assistant `message_end` 驱动 decision 完成。
- 在 abort、compaction、reload、settle 和 dispose 清理 frame/lease。
- 通过通用 durable-image 路径证明 image tool result 已写入，再刷新 history projection。

### `src/server/conversation-history.ts` / `session-events.ts`

- 从 wire 投影删除 base64，生成精确 `resultImageRefs`。
- 不改变 JSONL 中的标准 image content。

### `src/shared/protocol.ts`

- 继续使用既有 `open_image` / `conversation_image` 命令事件，不新增协议命令。
- durable image schema 精确限制 16 MiB decoded bytes，覆盖通用持久图片与 raw desktop 输入；computer 的正常持久结果另受更严的 provider normalization 边界约束。`PROTOCOL_VERSION` 不因向后兼容的上限扩大而变化。

### `src/server/agent-context-budget.ts`

- 不参与 computer image 生命周期；只负责 conversation context hint/LoopList 预算。

## 11. 测试矩阵

### 持久图片与缓存

1. initial observe 返回 JSON、current label 和一张 PNG/JPEG。
2. action observe 返回 JSON、after label 和仅一张新图，不复制前图。
3. >2000px 的真实 PNG 在 tool 返回前归一化；Pi `afterToolCall` 不再改写它，Frame 显示尺寸与持久图一致且仍映射到完整物理 bounds；同尺寸不可解码输入 fail closed 并清 frame。
4. SessionManager/JSONL 保存最终 base64；wire/history 不含 base64，只含 ref。
5. 相同 history 重复 `convertToLlm` 得到逐字节相同 image block。
6. 追加下一 observation 后，旧 provider input 是新 input 的严格前缀；A、B 各出现一次。
7. `open_image(messageId, ordinal)` 返回持久字节；超共享上限与 off-branch locator fail closed。
8. `blockImages=true` 和非 vision model 在 desktop adapter 创建前拒绝。
9. project `tool_result` hook 改写/丢弃 content 时调用失败并清 frame；最终 converter 的 details、label、MIME、图片 hash 任一不同或缺图也不能授权。

### Frame 与失败

10. pending frame 只授权同 owner、下一 decision 的 exact computer IDs。
11. local validation/preflight 不消费 sibling；首个实际 batch 消费 decision。
12. capture 失败、abort、timeout、observe:false 不保留或复活旧 frame。
13. post-action 结果只有 after 图；它对应的 frame 驱动下一 decision 坐标映射。
14. foreground identity/binding 漂移在正确边界返回 mismatch，且逐 action status 准确。
15. compaction、reload、terminal 和 dispose 清除瞬态能力，不删除持久 transcript 事实。

### 输入与并发

16. keypress/mouseHold/drag 在正常与中断路径尽力释放。
17. move 不点击，drag 两端都经过同一 frame 映射。
18. 两个 conversation 由 desktop lease fail-fast 互斥。
19. 真实 Windows adapter 的人工 smoke 覆盖观察、点击、键盘长按、鼠标长按、拖拽和前台窗口裁剪；CI 使用 fake adapter。

## 12. 验收标准

- provider history 对追加消息保持严格 append-only；retry 重放完全相同的 image block。
- 每次 capture 只持久化一张当前事实，不存在图片滑动窗口、重复 before 图或 provider-only injector。
- 浏览器 snapshot/event 不携带 base64，按需读取仍能得到持久化的精确归一化图。
- 最新 frame 是下一 assistant decision 唯一坐标依据；旧持久图片没有授权能力。
- capture、输入发送、应用响应和业务成功不会被混为同一状态。
- abort、retry、compaction、reload、窗口切换和多 run 竞争不会泄露 stale frame 或按下状态。
- 现有点击、移动、长按、拖拽、文本、滚动、wait 和 foreground-window crop 保持兼容。
