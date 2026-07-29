# Codex 长任务传输可靠性修复计划

> 目标是修复 OpenAI Codex 长任务中的 outbound WebSocket/请求缓冲失败，同时严格保留用户配置的 token 压缩阈值。禁止再次把传输字节、逻辑 provider JSON 和模型 token 混成同一个压力信号。

## 已确认事实

1. Pi 官方 compaction 是 token 工作集机制：`contextTokens > contextWindow - reserveTokens`，并按 `keepRecentTokens` 保留近期消息。
2. 先前 Pi Web 的 896 KiB gate 把完整 provider JSON 伪装成 `context_length_exceeded`，导致 SDK 绕过用户的 token 阈值执行 durable compaction；该实现已由 `48904df` 完整回滚。
3. Codex `before_provider_request` 观察到的是完整逻辑 body；实际 WebSocket 可能在更晚阶段发送 cached delta，SSE 则发送 zstd 压缩 body。因此该 hook 的字节数不是实际 wire bytes。
4. 同一历史会话的 `WebSocket error` 在 `1,084,911` 和 `546,416` 字节完整 body 上都发生过，且均为 `eventsEmitted=true / after_message_stream_start`。generic WebSocket error 不能归类为大小错误。
5. Pi `0.80.7`、npm 最新 `0.82.1` 和当前 upstream main 都仍保留上述观察边界；单纯升级依赖不能修复。
6. Pi 官方 Codex provider 已支持显式 `transport: "sse"`，Node 端会对 SSE 请求使用 zstd；Pi Web 的 Node 最低版本为 22.19。

## 架构决定

### 选择

当且仅当会话固定模型满足：

```text
provider = openai-codex
api = openai-codex-responses
settings transport = auto
```

Pi Web 对该 session 的内存 SettingsManager 应用 `transport: "sse"` override，再创建 AgentSession。

这是一条稳定、provider-scoped 的可靠性策略：不用字节启发式，不修改 provider payload，不伪造 overflow，不触发 compaction，不在响应开始后重放。显式配置的 `sse | websocket | websocket-cached` 必须原样保留。

### 不选择

- 不恢复 raw AgentContext 或 provider JSON 字节阈值。
- 不安装 `onPayload` hard gate。
- 不把 `WebSocket error`、`1009` 或 request buffer error 改写成 `context_length_exceeded`。
- 不静默删除图片、tool result 或 tool-call arguments。
- 不修改 durable JSONL、compaction 边界或用户 token 阈值。
- 不复制/分叉 Codex provider 私有实现到 Pi Web。

### 边界

本轮修复只改变 Pi Web 在 Codex `auto` 模式下的传输选择。若 zstd SSE 仍被真实上游拒绝，必须保留独立的 transport error；后续 artifact 工作集必须另立设计，要求 exact payload inclusion receipt、成功 assistant 消费证明、未消费批次整体保留、深拷贝、tool call/result 配对不变以及可恢复原始 artifact，不能与本修复捆绑。

---

## Task 1：锁定回归与错误分类

**新增：**

- `src/server/codex-transport-policy.ts`
- `src/server/codex-transport-policy.test.ts`

**步骤：**

1. 先写失败测试覆盖：
   - Codex Responses + `auto` 选择 `sse`；
   - 非 Codex provider 不变；
   - 显式 `sse`、`websocket`、`websocket-cached` 全部不被覆盖；
   - `WebSocket error` 与 `exceeded request buffer limit while retrying upstream` 不属于 context overflow；
   - `context_length_exceeded` 仍由 Pi 原生识别为真正的模型 overflow。
2. 实现一个纯、同步、无持久写的 policy 函数，只通过 `SettingsManager.applyOverrides()` 修改当前 session 的内存 overlay。
3. 运行 focused tests、typecheck 和 `git diff --check`。

**成功标准：** 传输错误与 token overflow 在测试中是两个互斥类别；策略无字节常量、无 payload 检查。

---

## Task 2：接入两条 AgentSession 创建路径

**修改：**

- `src/server/pi-runtime.ts`
- `src/server/pi-runtime.test.ts`
- `src/server/compaction-thinking.ts`
- `src/server/compaction-thinking.test.ts`

**步骤：**

1. 在 direct session factory 与 two-phase services factory 中，均先解析 fixed model，再对该 session 的 SettingsManager 应用 policy，最后创建 AgentSession。
2. Pi 的 compaction summary 直接调用 `agent.streamFn`，不读取 Agent 的普通 turn transport；在现有 compaction-only stream wrapper 中传入同一个已解析 transport。该 wrapper 继续只在 `compaction_start/end` 窗口安装，不能破坏 SDK 的 `streamSimple` auth identity check。
3. 增加集成测试证明：
   - 两条 factory 路径收到的 settings transport 都是 `sse`；
   - 正常 Agent turn 与 compaction summary 都使用同一 effective transport；
   - 显式 WebSocket 配置仍传入 AgentSession 和 compaction；
   - 非 Codex 固定模型仍为 `auto`；
   - override 不写入用户或项目 settings 文件。
4. 不对无 fixed model 的 catalog/临时路径猜测 provider；生产 ConversationActor 已由角色快照提供 fixed model。
5. 运行 `pi-runtime`、`compaction-thinking` focused tests、typecheck 和 `git diff --check`。

**成功标准：** 正常 prompt、SDK retry、同一 AgentSession 后续 turn 和 compaction summary 都稳定使用同一个 resolved transport；compaction 临时 wrapper 的安装/恢复与 auth identity 不变量保持不变。

---

## Task 3：系统扫描与知识同步

**修改：**

- `.knowledge/kb-server-runtime.md`

**步骤：**

1. 全仓扫描 `transport`、`streamFn`、`onPayload`、`context_length_exceeded` 和 compaction 触发点。
2. 分类所有 structurally identical 风险：
   - 是否仍有 transport error → token compaction 的映射；
   - 是否有 provider body 字节启发式；
   - 是否有未经用户选择的 WebSocket 强制覆盖；
   - 是否有响应开始后的自动重放。
3. 记录长期决策：Codex auto 使用 zstd SSE；显式 transport 被尊重；token compaction 只由 token/真实 provider overflow 驱动。
4. 若扫描发现独立 P0/P1，先写反例并单独提交；不得混入当前 transport commit。

**成功标准：** 项目中不存在第二条隐式字节压缩路径；知识页与源码一致。

---

## Task 4：完整验证与独立复审

执行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

独立 reviewer 必须重点反驳：

- Settings override 是否可能持久化；
- explicit transport 是否被覆盖；
- direct/two-phase factory 是否语义分裂；
- compaction、retry、steer 是否可能重新选择 WebSocket；
- 非 Codex provider 是否受影响；
- 是否重新引入 token 阈值绕过或隐藏 payload 修改。

**最终成功标准：**

1. 用户的 compaction percentage 不因请求字节数提前触发；
2. Codex auto 不再走 outbound WebSocket，因此不再产生该路径的 after-start WebSocket failure 或 uncompressed WS request buffer 问题；
3. 请求过大若仍失败，保持 transport error，不 durable compact、不盲重放；
4. 所有自动测试、构建、静态检查与 reviewer 通过；
5. 每个接受的子任务都有独立 Git 还原点；
6. 不自动重启 Pi Web，不打断现有 Agent。
