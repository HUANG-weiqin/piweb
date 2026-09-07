# Windows 极简 Computer Use 设计

日期：2026-09-07

状态：**已实现；待 Windows 人工 smoke**

## 1. 目标

Pi Web 在 `full_access` conversation 中提供本机 Windows 前台桌面的极简 computer use。Agent 可以观察一张当前屏幕、执行一小批鼠标键盘动作，并在后续上下文中知道已经向桌面发送过什么动作。

核心模型只有两类事实：

```text
持久事实：普通 computer tool result 中的文字操作记录
易失事实：当前 run 内存中的一张 CurrentObservation
```

截图不是聊天历史、不是浏览器数据，也不是新的持久账本。

## 2. 范围与非目标

### 范围

- Windows、本机、前台、**主显示器**；第一版不支持跨显示器或虚拟桌面坐标。
- 仅 `full_access` 角色可见和执行 `computer`。
- 一个工具、一次有界动作批：`click`、`type`、`keypress`、`scroll`、`wait`，以及批末可选的 `observe`。
- 每个 exact active run 最多持有一张内存 PNG；模型每个观察只看一次。
- 进程内同一时刻仅一个 Pi Web run 可控制物理桌面。

### 非目标

- 不做 OS/VM/container sandbox、远程访问、浏览器 DOM/可访问性树、网页专用自动化或逐操作人工确认。
- 不做截图历史、多图窗口、截图裁剪/压缩历史、截图回放、截图 UI 预览或任何新的 WebSocket 命令/事件。
- 不做多显示器、拖拽、双击、剪贴板读写、文件上传、OCR、元素定位、录制回放或后台窗口控制。
- 不承诺防止人类在物理桌面上切换窗口、移动鼠标或修改屏幕；发生后 Agent 应重新 `observe`。

现有 loopback-only 服务边界不变；`full_access` 仍不是 OS sandbox。

## 3. 用户可见工具合同

只新增一个 SDK custom tool：

```ts
computer({ actions, observe })
```

为兼容 provider 对工具 schema 的保守子集，`actions` 使用一个平坦对象而不是 `oneOf`/discriminated union；服务端按 `kind` 做完整的二次校验。

```ts
interface ComputerActionInput {
  kind: "click" | "type" | "keypress" | "scroll" | "wait";
  x?: number;       // click/scroll: screenshot 像素坐标
  y?: number;
  button?: "left" | "right"; // click，默认 left
  text?: string;    // type
  keys?: string[];  // keypress，例如 ["CTRL", "L"] 或 ["ENTER"]
  deltaX?: number;  // scroll
  deltaY?: number;
  ms?: number;      // wait
}

interface ComputerInput {
  actions: ComputerActionInput[];
  observe: boolean;
}
```

固定限制：

- `actions` 最多 8 项；`[] + observe: false` 拒绝。
- `type.text` 最多 4096 UTF-8 bytes；`keypress.keys` 为 1–4 个受支持键名或单字符；`wait.ms` 为 0–5000；滚动增量为有界非零整数。
- 整批参数必须在取得桌面副作用前完全验证；非法输入不使旧观察失效。
- 动作严格顺序执行，绝不并行。单次 tool 调用以 `MAX_COMPUTER_CALL_MS = 15000` 的总 deadline（包含 capture/全部 primitives）与 run `AbortSignal` 组合：await 以 abort race 及时返回，另以 monotonic deadline 在同步 native/encode 阻塞后的成功和失败路径复核；超时向 adapter 发 abort，结果如实标为 `interrupted/timed_out`。若 native primitive/capture Promise 尚未 settle，lease 仍保留到其 quiesce，不能为 deadline 提前交给下一 owner。
- `click` 和 `scroll` 必须来自当前模型 decision 中有效的 screenshot frame；没有有效 frame 时拒绝。`type`、`keypress`、`wait` 可不依赖坐标执行。

`observe: true` 的含义是：在全部动作完成后捕获一张新的主显示器 PNG。初始观察是：

```ts
computer({ actions: [], observe: true })
```

Agent 的 tool prompt 必须明确：先 `observe`，只有当前 provider turn 实际带有屏幕图时才可基于它作坐标判断；执行会改变屏幕的动作后，如需确认必须再次 `observe`。

## 4. 状态、所有权与不变量

| 事实 | 权威所有者 | 生命周期 | 是否持久化/上 wire |
| --- | --- | --- | --- |
| 物理桌面独占 | `PiRuntime` 的进程级 `DesktopController` | 首次 computer 调用到 exact run terminal/abort/reload | 否 |
| `CurrentObservation`（PNG + frame） | exact `RunTicket` | successful observe 到替换、失效或 run 清理 | 否 |
| 当前 batch 的局部坐标 frame | 正在执行的 `computer` 调用 | batch 结算 | 否 |
| 动作历史 | Pi 原生、文字形式 `toolResult` | conversation JSONL / Pi normal history | 是；仅文字 |

必须成立：

1. 任一 exact run 至多有一张 `CurrentObservation`；其它 run 永远不能读取、覆盖或使用它。
2. PNG/Base64 不得进入 `SessionManager` entries、Pi JSONL、tool result、`details`、`SessionEventProjector`、WebSocket snapshot/event、`PublicState`、聊天 reducer 或 localStorage。
3. 不新增 custom entry 或第二份 `ComputerOperationRecord`。普通文字 tool result 就是唯一持久操作历史。
4. 只有当前模型实际支持 image input 时才允许 `computer` 进入有副作用的执行；不支持时在取得 desktop lease 或发送输入前明确失败。
5. desktop lease 的 identity 是完整 `ConversationRunOwnership`，不能只按可碰撞的 `runId` 判断。
6. lease 只串行 Pi Web 的桌面使用；人工桌面操作不在自动一致性保证中。

## 5. Desktop lease

`DesktopController` 是 `PiRuntime` 进程级唯一对象。它提供 fail-fast 的 acquire/release，不排队：

```text
首次 computer 调用
→ acquire(exact run ownership)
→ 成功：此 run 持有到 terminal / abort / reload
→ 失败：tool 返回 desktop_busy，不发送输入、不截图
```

持有 lease 的 run 可以多次 `computer`。其他 conversation 可继续聊天、读写项目或运行非 computer 工具；只有它们的 `computer` 调用返回 `desktop_busy`。同一 run 的 compaction 只清 observation，不释放 lease。

选择“run 生命周期独占”而不是桌面 revision/version，是有意的极简取舍：它保证 Pi Web 内不会在 A 的观察和 A 的坐标动作之间让 B 改变前台桌面。`settleRun`、基础设施失败、abort、reload handoff、session dispose 都必须幂等释放 lease 和丢弃 observation。

## 6. CurrentObservation 与模型输入

```text
computer(..., observe=true) 成功
→ 创建 CurrentObservation(PNG, frame, source tool call)
→ 正常文字 tool result 持久化
→ 紧随其后的一个逻辑模型 decision 临时收到该 PNG
→ 该 decision 成功结束后，后续 decision 不再收到同一 PNG
```

这里的“逻辑模型 decision”不是一次 HTTP transport attempt：同一次 provider auto-retry 必须再次获得**相同、不可变**图片。只有该 decision 产生成功 assistant message 后，图片才算已消费；429、断线、可重试 error 不能在发送时删除图片。

实现接点是 `AgentSession.agent.convertToLlm`：在 Pi extension transform 后，按稳定的 source `toolCallId`（不依赖 structured-clone 前后的 JS message identity）定位转换结果中的对应 `toolResult`，创建仅供 provider 使用的 LLM message 副本，并在其末尾追加 `ImageContent`。随后调用 `markProviderImagePresented(owner, sourceToolCallId)`；只有该 marker 存在，成功 assistant message 才可将 frame 授权给其精确 computer call IDs。绝不改写原始 AgentMessage 或 tool result。现有 `agent-context-budget.ts` 已是同类瞬时 provider-input seam；实现保持可组合的安装/restore 语义，且 image 注入不依赖 LoopList 是否有 active item。

- 只在 source computer tool result 是本次输入尾部的对应 tool result 时注入。
- steering 若与该次 provider 调用一起被 SDK 合并，仍属于同一个 decision；不单独复制或持久化图片。
- automatic/manual compaction、reload、abort、terminal 都清除任何 `CurrentObservation`，包括已送入当前 decision、但其坐标 batch 尚未结算的 frame。下一 decision 没有实际图片时，Agent 必须重新 observe；不得仅因历史文字写过“captured”就接受坐标动作。
- 图片成功送入模型后，坐标 `frame` 仍只保留到由该 assistant message 产生的 computer batch 结算；其后释放。若该 batch 在 SDK schema、extension 或 host gate 被拒而从未进入 controller，下一次 provider decision 在无新 PNG 时也必须清掉该 authorized frame，不能让后续 decision 复用 call ID/旧坐标。

主显示器截图必须在 adapter 内规范化为一张有界 PNG，并带有：截图宽高、主显示器物理 bounds、从 screenshot 像素到 Windows 输入坐标的统一缩放映射。坐标越界拒绝，不能静默 clamp 到屏幕边缘。截图 bytes 的任何上限、缩放或编码失败都导致 `observe` 失败而非保留无界图片或复活旧图。

## 7. 执行状态机

### 7.1 成功观察

```text
no/current observation
→ validate tool input
→ acquire/confirm lease
→ clear any previous observation
→ capture PNG
→ install CurrentObservation
→ return text-only tool result { observation: "captured" }
```

新的 observe 尝试在开始时移除旧图；若截图失败，结果是无可用观察，不会把旧图重新暴露给模型。

### 7.2 带动作的 batch

```text
CurrentObservation available（坐标动作需要）
→ validate full batch
→ acquire/confirm lease
→ take local frame for this batch
→ clear global CurrentObservation before first primitive attempt
→ execute primitives sequentially
→ optional final observe
→ return exactly one text-only tool result
```

无论 `observe` 是否为 true，任一已准入 batch 在首个 primitive 尝试前均使旧观察失效。这样 `click` 已发生、后续 `type` 中断或最终截图失败时，不会把点击前的图误当作当前屏幕。

- `observe: false`：结算后没有可用观察。
- `observe: true`：只有整个 batch 成功且截图成功时才安装新图。
- primitive、abort 或截图失败：没有可用观察；不复活旧图。
- `wait` 也属于一个已准入 batch，会使旧观察失效，因为等待期间 UI 可能变化。

### 7.3 诚实的文字结果

电脑输入只能陈述宿主知道的事实，不能声称目标程序已经处理或页面已经成功改变。assistant 的普通 tool call 保存已验证的完整参数；其配对的普通 tool result 保存这些参数实际是否已发送。两者合起来是唯一的持久操作历史，不另写旁路账本。正常 tool result 使用有界 JSON 文本，例如：

```json
{
  "outcome": "completed",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" },
    { "index": 1, "kind": "type", "status": "sent" }
  ],
  "observation": { "status": "captured", "width": 1280, "height": 720 }
}
```

失败/abort 必须分开表达动作和观察：

```json
{
  "outcome": "interrupted",
  "actions": [
    { "index": 0, "kind": "click", "status": "sent" },
    { "index": 1, "kind": "type", "status": "unknown" },
    { "index": 2, "kind": "keypress", "status": "not_started" }
  ],
  "observation": { "status": "unavailable" }
}
```

`sent` 表示宿主已向 Windows adapter 发出完整 primitive；它不等价于应用 UI 已完成效果。某 primitive 不能确认完整发出时用 `unknown` / `may be partial`。Abort 最多阻止后续 primitive，不能把正在执行或已发出的输入改写成“未发生”。

## 8. 权限、协议与展示

- 不修改 `src/shared/protocol.ts` 或 `PROTOCOL_VERSION`：浏览器没有 computer command、截图或截图元数据的协议责任。
- 不向 browser 展示截图。现有工具卡只会通过正常 Pi 投影显示文字 action/result；不能把 `CurrentObservation` 塞进 `details` 作为便利通道。
- `read_only` 继续看不到且 gate 拒绝 `computer`。不把它加入 `READ_ONLY_TOOL_NAME_CEILING`。
- `full_access` 保持现有 source-aware tool gate 路径；computer 工具仍在 extension `tool_call` hook 后、实际 desktop adapter 前受同一个 host gate、run ownership 和 AbortSignal 约束。
- 工具固定 sequential execution；不依赖 SDK parallel preflight。

## 9. 建议实现边界

### 新模块

`src/server/computer-use.ts`：

- 无平台细节的 `WindowsDesktopAdapter` 接口与 fake adapter；
- 进程级 `DesktopController`、fail-fast lease、屏幕 capture/coordinate-frame 归一化；
- `CurrentObservation` 的 run-scoped store；
- 平坦 schema 的二次校验、批执行、文字结果构造；
- 只读的 observation injection controller，不直接依赖 WebSocket 或持久化。

真实 Windows adapter 是该模块内部可替换依赖。它必须支持 screenshot、cursor click、key typing/chord、scroll、abort-aware wait，并在单 primitive 无法确认时返回 `unknown`；不得通过 shell 命令伪造桌面控制。

### 现有边界

- `src/server/pi-runtime.ts`：创建并在进程生命周期拥有一个 `DesktopController`；在 session construction 时接入 computer custom tool 和 provider-input injector；dispose 时清理 adapter/controller。
- `src/server/conversation-actor.ts`：以 `ConversationRunOwnership` 创建 run bridge，工具仅从当前 `activeRun` 取得所有权；在 `settleRun`、`failRunInfrastructure`、abort/reload/compaction 生命周期准确清 observation/release lease。
- `src/server/agent-context-budget.ts` 或一个紧邻的可组合 adapter：在 `convertToLlm` 后构造 LLM-only image part，保持既有瞬时 LoopList hint 行为不变。
- `src/server/tool-policy.ts`：只补充 computer 的 read-only 拒绝测试；默认 `full_access` allow 语义不扩张。
- `src/server/session-events.ts` / `conversation-history.ts`：增加反例测试，证明普通 tool result 中没有 image/Base64 且投影无法泄露它。

不要创建新的浏览器模块、持久化 schema、JSONL custom entry、后台队列或第二个 AgentSession。

## 10. 最小测试矩阵

1. `read_only` 看不到/拒绝 computer；`full_access` 且 vision-capable model 才可进入有副作用路径；非 vision model 在 lease/action 前失败。
2. `[] + observe:false`、错误字段、越界坐标、超出 batch/文本/等待边界均在副作用前拒绝。
3. 初始 observe 产生文字 result；`SessionManager`、tool event、history snapshot 和 WebSocket fixture 均不含 PNG/Base64；对应 LLM-only input 恰有一张 image。
4. 同一逻辑 provider retry 获得同一图片；成功 assistant message 后下一 decision 不再获得该图片。
5. click/type/keypress/scroll/wait 严格顺序；坐标映射在缩放下正确；坐标动作无有效 frame 被拒绝。
6. 任何已准入 batch 在首个 primitive 前使旧图失效；后续 primitive、abort、capture 失败均不会复活旧图；只有完整成功的 `observe` 安装新图。
7. partial/abort tool result 如实记录 `sent`、`unknown`、`not_started` 和独立 observation 状态。
8. 两个 conversation 争抢 desktop：第一个 run 持有到 settlement，第二个 fail-fast busy；terminal、failed infrastructure、abort、reload、dispose 均释放，之后可重新 acquire。
9. compaction、steer 与 run recovery 不把图片写进持久历史；compaction/reload 后坐标动作要求新 observe。
10. Windows adapter 的单元测试用 fake；真实主显示器点击/输入/截图只做明确人工环境的手工 smoke，不能让 CI 操控开发者桌面。

实现完成后运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

## 11. 验收标准

当前自动化验证：`computer-use` fake/lease/abort/FFI-boundary 测试、provider-only converter 相关性测试、Actor 生命周期测试、runtime full-access/read-only 投影测试均已覆盖；真实 Windows 主显示器 smoke 仍须在明确人工环境执行。

功能完成仅当：

- Agent 可 observe 一张本机主显示器图片，基于它执行有界动作批，并在下一轮知道已发送的动作。
- 任意时刻只存在一张内存图片；图片绝不成为 Pi 历史或浏览器数据。
- 操作记录是普通文字 tool result，失败和 abort 不伪造成功。
- provider retry、compaction、abort、reload、跨 conversation 竞争和坐标缩放均满足上述状态机。
- 代码没有扩大浏览器协议、角色持久格式、截图历史或 sandbox 承诺。
