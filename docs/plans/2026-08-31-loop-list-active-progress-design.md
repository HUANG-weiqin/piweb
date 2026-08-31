# LoopList 活跃进度与瞬时提醒设计

日期：2026-08-31

状态：讨论确认，尚未实现

## 1. 问题

当前 LoopList 每项只有 `checked`，只能表达完成与未完成。实际使用中出现两个问题：

1. Agent 可能完全不建立列表；
2. Agent 即使建立列表，也常在工作结束时一次性更新，用户无法及时看到当前工作焦点。

工作台需要在不引入审批流、定时刷表或第二份进度真相的前提下，提高计划建立率和更新可见性。

## 2. 目标与边界

### 目标

- full-access Agent 在取得 builtin `edit` / `write` 额度前，conversation 必须已有至少一个 `active` 项；
- LoopList 能区分待处理、当前活跃和已完成，并允许多个任务同时活跃；
- 每次模型请求能看到当前活跃任务的极简提醒；
- 提醒不进入 AgentSession messages、SessionManager、Pi JSONL 或浏览器 transcript；
- 动态提醒位于既有最后输入消息的末尾，尽量保留稳定上下文的 provider 前缀缓存。

### 非目标

- 不宣称宿主可以保证“实时更新”；只有 Agent 调用 `todo_write` 才会产生新的用户可见进度；
- 不按工具调用数或时间间隔强迫无意义更新；
- 不把 LoopList 变成用户审批、安全凭证或通用工作流引擎；
- 不扩大 edit budget 对 `bash`、脚本或扩展工具的保护范围；
- 不强制纯分析、read-only 或完全不申请编辑额度的 run 建立列表。

## 3. 状态模型

每项从 boolean 提升为单一状态：

```ts
interface LoopListItem {
  id: string;
  text: string;
  status: "pending" | "active" | "completed";
}
```

选择 `active` 而不是 `in_progress`：LoopList 是 conversation-scoped 持久声明；在 abort、失败、暂停、八次续跑上限或进程重启后，actor 可能没有运行，但任务仍可保持为 Agent 当前关注项。实际运行仍只由 `ConversationActor.activeRun` 证明。

三个状态维度必须分开：

| 状态 | 所有者 | 含义 |
|---|---|---|
| `item.status` | durable LoopList | 任务是待处理、当前关注或完成 |
| `loopList.armed` | ConversationActor / durable LoopList | 是否允许自然结束后的自动续跑 |
| `activeRun` | ConversationActor 易失运行态 | Agent 此刻是否实际执行 |

因此 `status=active + armed=false + no activeRun` 是合法的“当前工作被暂停”状态。

规则：

- 可以同时存在多个 `active`；
- 数组顺序只用于稳定展示，不定义执行顺序；
- 未完成任务是 `status !== "completed"`；
- `todo_write` 在存在未完成任务时 armed；
- `todo_pause` 只改变 armed，不改任务状态；
- 自动续跑仍以 `armed && any(status !== "completed")` 为条件。

## 4. 编辑承诺边界

`request_edit_budget` 在授予额度前读取 ConversationActor 的权威 LoopList：

```text
至少一个 item.status === "active"
  → 授予本 run 的 distinct-file edit budget
否则
  → 不授予额度，明确要求先调用 todo_write 建立 active 项
```

检查不能只要求列表非空：全 completed 或全部 pending 都没有可注入的当前工作焦点。

该检查只证明授予额度这一时点存在活跃关注项，不证明本轮创建了新计划，也不保证后续及时更新。conversation-scoped 的旧 active 项允许跨 run 延续；若未来需要“每个 run 必须重申计划”，应另行定义 run revision 契约，不能悄悄改变此语义。

## 5. 瞬时模型提醒

每次调用 provider 前，在 SDK extension context transform 之后、LLM dispatch 之前，从 ConversationActor 读取当前 active 项并构造一个有界尾部块：

```text
<piweb_ctx ... />
piweb_work={"active":[{"id":"protocol","text":"更新协议"},{"id":"tests","text":"补充反例"}],"omitted":0}
```

约束：

- 复用现有 `agent.convertToLlm()` 包装边界；
- 追加为最后一条既有 `user` / `toolResult` provider message 的最后一个 text part；
- 绝不新增独立 user/custom turn；
- 不修改 converter 输入、原始转换结果或 session-owned messages；
- 上下文 telemetry 与 active 提醒合并在同一个动态尾部，避免多个动态边界；
- `piweb_work=` 后使用固定字段顺序的 `JSON.stringify` 结果，不使用可被任务文本伪造的 XML closing tag 或自定义分隔符；换行、引号和控制字符均由 JSON 编码；
- 对完整 UTF-8 编码结果设置严格字节预算，只追加能完整放入的 item，不能在字符串或多字节字符中间截断；`omitted` 是未输出 active 项的精确数量，非零时再包含固定字段 `"moreVia":"todo_read"`；
- 每个已输出 item 都包含稳定 ID；没有 active 项时不输出工作提醒；
- provider 会看到该提醒；“不留历史”仅指不进入 Pi Web 的 durable transcript。

尾部位置用于保护前缀缓存：

```text
request N:   durable_context_N + transient_hint_N
request N+1: durable_context_N + new_messages + transient_hint_N+1
```

稳定的 `durable_context_N` 仍可作为共同前缀。提示本身及 provider 的末尾缓存分块仍会产生少量 uncached token，这是动态提醒不可避免的成本。

## 6. 持久兼容

当前 `piweb.loop_list.v1` 与 `piweb.loop_list_continue.v1` 是严格 persisted schema，不能原地扩义。

实现时应新增对应 v2 entry，并兼容读取 v1：

```text
checked=true  → completed
checked=false → pending
```

`armed` 不能推导 `active`。旧会话第一次写入新格式后再持久化 v2；严格 session scan 仍需验证 active branch 的列表快照、continuation 编号和最近祖先一致性。

浏览器线协议应同步升级为三态 item。UI 可把 `active` 显示为“进行中”，但必须继续从 `activeRun` 单独显示 Agent 是否真的运行，不能把 task status 与 runtime activity 合并。

## 7. 可观察效果与限制

该设计能够：

- 阻止正常 builtin 文件修改在没有活跃计划时取得额度；
- 让用户立即看到 pending / active / completed；
- 在后续模型请求中持续提醒当前工作焦点；
- 保持提醒不污染持久历史和稳定上下文前缀。

它不能保证：

- 长时间单个工具调用中途更新；
- 一次模型响应预先发出的批量工具调用之间更新；
- Agent 不会保留陈旧 active 项；
- `bash`、扩展工具或 read-only 工作遵守同一门槛；
- 用户一定在语义步骤完成的瞬间看到新状态。

产品文案应描述为“编辑前必须存在 active 项、进度实时可见、模型持续收到提醒”，而不是“每个 run 强制重新初始化”或“宿主保证实时进度”。

## 8. 最小验证集合

后续实现至少覆盖：

1. 无 active 项时 edit budget 不授予；一个或多个 active 时授予；
2. pending / active / completed 的 armed、pause、续跑与完成判定；
3. v1 严格读取与无损映射，v2 严格写入和 active-branch 恢复；
4. active 摘要使用规范 JSON、有界且带稳定 ID；包含换行、引号、伪分隔符的文本不能破坏结构，截断后 `omitted` 必须精确；
5. 瞬时提示位于最后输入消息末尾，不新增消息且不修改 SessionManager/JSONL；
6. focused snapshot 与 live update 正确投影三态，UI 不把 active task 冒充 active run；
7. `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。
