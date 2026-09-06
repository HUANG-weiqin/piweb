# 角色级上下文压缩模型设计

日期：2026-09-06
状态：实现合同已冻结，尚未修改生产代码

## 1. 问题与目标

Pi Web 当前把 conversation 冻结角色的主模型交给一个 `AgentSession`。普通 Agent turn、手动压缩、Pi 自动阈值/溢出压缩都因此使用同一模型。对于昂贵主模型，压缩会产生明显成本与延迟；但压缩又必须保留长期约束、已有结论、split-turn 前缀和文件跟踪，不能用一个另起炉灶的简化摘要替代 Pi 的标准 compaction。

本次目标是在**角色模板及其 conversation 冻结快照**中配置一个可选的专用压缩模型，同时满足：

1. 普通 Agent turn 永远继续使用冻结的角色主模型。
2. 只有 Pi 默认的 context-compaction 摘要请求使用专用模型。
3. 项目 `session_before_compact` 返回的 custom compaction 始终优先。
4. 专用模型的模型对象和凭据均来自当前 session-local `ModelRuntime`。
5. 显式配置失败时明确失败，绝不静默回退主模型。
6. Pi 继续拥有 cut point、previous summary、split-turn、file tracking、usage、abort、retry、持久化和 overflow continuation。
7. 原 JSONL 历史不删除；成功压缩仍只追加 Pi 标准 `compaction` entry。

## 2. 决策摘要

### 2.1 领域字段

新增必填 nullable 字段：

```ts
compactionModel: RoleModelSelection | null
```

它进入用户级 `RoleTemplate`、conversation-scoped `ConversationRoleSnapshot`、role create/update payload，以及 role catalog、conversation snapshot 和相关持久化投影。

- `null`：压缩跟随**该 conversation 已冻结的 `role.model`**；不是全局默认模型，也不是以后变更的角色模板。
- `{ provider, id }`：Pi 默认 context compaction 使用该模型；普通 turn 仍使用 `role.model`。

角色模板后续编辑不改变已有 conversation。只有新建 conversation 或用户显式切换角色时，当前模板的完整字段才复制成新快照。

### 2.2 失败合同

显式压缩模型在默认压缩请求发生时若缺失、无认证、容量不合法或 provider 请求失败：

- manual compaction 沿 Pi 原语义失败并返回明确错误；
- auto compaction 沿 Pi 原语义发出失败事件并停止本次恢复/续跑；
- 不调用主模型作为 fallback；
- 不追加 `compaction` entry，也不执行成功压缩后的 `buildSessionContext()` 重建；原 JSONL 保持完整。

这里不承诺恢复 Pi 在接点之前已经做出的 transient overflow-recovery 修改。Pi 0.84.4 会在可恢复 overflow 后、进入 `_runDefaultCompaction` 前设置 recovery-attempt 标记，并从内存 `agent.state.messages` 移除末尾失败 assistant；默认压缩随后失败时 Pi 不恢复这两项。宿主保留这一本来就存在的 Pi 失败语义，不把它误写成“内存 context 完全不变”，也不扩大接点去复制/回滚 SDK 私有状态。manual 和普通 threshold 路径没有这项 overflow 前置修改。

已有 frozen conversation 不因压缩模型后来从目录消失而无法打开。它仍能使用主模型工作；只有真正进入 **Pi 默认压缩生成器**时才 lazy resolve 并失败。用户可恢复模型配置，或在会话空闲后切换到一个有效角色。

如果项目 `session_before_compact` 取消压缩或返回 custom compaction，则不解析、不验证、不调用专用模型；即使专用模型已失效，custom compaction 仍可成功。

### 2.3 容量合同

第一版不实现分块摘要。角色的显式压缩模型只有在以下条件成立时才属于受支持配置：

```text
compactionModel.contextWindow >= role.model.contextWindow
```

原因不是模型标签，而是最坏输入规模：压缩通常在主模型接近其 context 上限时发生；若角色级配置允许更小窗口模型，则同一配置会在短会话工作、长会话必然失效。静态相等/更大检查虽是保守上界，但比在临界压缩时才发现不可用更符合角色配置的稳定合同。未来若要支持更小窗口模型，应单独设计分块/递归摘要，而不能静默截断输入。

此检查由服务端 `RoleCatalog` 在模板 create/update/apply 边界权威执行，UI 只提供提示和提前禁用。主模型尚未选择时保留当前“可保存不完整角色”的行为；该角色本身仍不可应用。主模型和显式压缩模型都可解析时必须执行容量检查。

冻结快照只保存 identity，catalog refresh 可能替换模型对象或改变窗口。因此 runtime 在**每一次默认压缩、调用原方法和任何 provider stream 之前**还要用本次 main request model 与 fresh compaction model 重验：两个 `contextWindow` 都是有限正数，且目标窗口不小于主窗口。失败明确报配置容量错误；不把静态 RoleCatalog 校验当成永久证明。

说明：Pi 默认 `keepRecentTokens = 20_000` 表示保留的近期原文，不是摘要输出长度。默认 `reserveTokens = 16_384` 时，普通摘要上限约为 `floor(0.8 × 16_384) = 13_107` tokens；split-turn 前缀摘要上限约为 `8_192`。把目标模型传给 Pi 原生 `compact()` 后，Pi 还会按目标模型的 `maxTokens` 继续取最小值。

### 2.4 service tier

- `compactionModel === null`：压缩就是主模型请求，继续使用 conversation 当前选中的 service tier。
- 显式 `compactionModel`：该次请求使用目标 provider 的默认 tier，不继承 conversation 主模型 tier。
- 即使显式模型 identity 恰好等于主模型，也按“显式专用压缩请求”处理，不投影 conversation tier。这允许同模型压缩使用 provider 默认队列。
- 第一版不增加 `compactionServiceTier` 字段。

### 2.5 非目标

本次不做：第二个 `AgentSession`；自定义 compaction entry 或删除/改写旧 JSONL；重新实现 Pi 摘要 prompt、cut point、split-turn、file tracking、retry 或 usage；为小 context 模型做分块压缩；改变 branch/tree summarization、标题生成、工具结果压缩或其他摘要请求；conversation 级临时压缩模型命令；压缩 thinking level/service tier 的额外配置；在 usage breakdown 中新增压缩 provider/model 维度。

## 3. 所有权与不变量

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 角色压缩模型配置 | `RoleStore` / `RoleCatalog` | 用户级模板 revision |
| 实际压缩模型 identity | `ConversationRoleSnapshot` | conversation 冻结快照 |
| 当前模型目录与认证 | session-local `ModelRuntime` | runtime session |
| 当前主 service tier | `ConversationActor` | conversation live selection |
| 是否正在压缩及 abort/retry | Pi `AgentSession` + actor 投影 | 单次 compaction |
| 压缩后的 context | Pi `SessionManager` / `AgentSession` | JSONL branch + runtime projection |

必须始终成立：

1. `AgentSession.model` 不因压缩而改变。
2. 一个 conversation 只有一个 `AgentSession` 和一个 session-local `ModelRuntime`。
3. 专用模型只在一次 Pi 默认 compaction 的 request scope 内存在。
4. 显式请求不能携带主模型解析出的 `apiKey`、认证 headers、`env` 或 conversation service tier。
5. provider attribution 和项目 `before_provider_headers` 仍在目标模型的已解析 headers 上执行。
6. custom compaction 不依赖专用模型可用性。
7. model catalog refresh 后下一次压缩重新按 identity 解析，不能保留陈旧 `Model` 对象。
8. failure 不产生部分 compaction persistence；Pi 在接点前形成的 transient overflow-recovery state 除外，不由宿主伪造回滚。

## 4. 持久化与协议

### 4.1 RoleStore v7

`ROLE_STORE_VERSION` 从 6 升到 7。v7 每个 role metadata 必须显式包含 `"compactionModel": null` 或合法 `{ "provider": "...", "id": "..." }`。

迁移规则：

- v1–v4 inline roles：缺失字段归一化为 `null`，然后走现有 prompt-file migration。
- v5 metadata roles：现有 `defaultServiceTier` 迁移保持不变，同时补 `compactionModel: null`。
- v6 metadata roles：补 `compactionModel: null`，原子重写为 v7。
- 所有格式迁移都保留原 role revision；schema rewrite 不是用户语义编辑，不能制造 CAS revision。
- v7：字段必填，未知字段继续 fail closed。
- 新安装创建的默认角色写入 `compactionModel: null`。

必须同步更新 parse、exact-key allowlist、clone、hydrate、serialize、equality。只修改压缩模型必须被视为 role draft 变化并令 revision +1。

### 4.2 旧 conversation JSONL

不升级 `piweb.conversation_meta.v1` 和 `piweb.conversation_role_change.v1`。二者共用的 `roleSnapshotSchema` 增加：

```ts
compactionModel: roleModelSchema.nullable().default(null)
```

旧 base metadata、旧 role-change 和旧 conversation card 的 `requestedRole` 均解析成 `null`；旧 JSONL 不物理重写；replay/aggregate 后的内存快照字段完整；历史行为等价于“压缩跟随主模型”。不能只给 base metadata 加默认而遗漏 role-change，否则切换过角色的旧 conversation 会无法打开。

### 4.3 Wire protocol v40

`PROTOCOL_VERSION` 从 39 升到 40。`roleInputSchema`、`RoleTemplate`、`ConversationRoleSnapshot` 和 conversation role summary 都把 `compactionModel` 作为**必填 nullable**字段。不使用 optional 字段，避免“缺失”和 `null` 两套 follow 语义。只含 id/name 的轻量 role reference 不扩展。

## 5. 角色目录与应用规则

`RoleCatalog` 同时查找主模型和显式压缩模型：主模型缺失/不可用、thinking/tier 不兼容沿用当前错误；显式压缩模型缺失则角色 unavailable；两者存在但压缩模型 context window 更小则 unavailable；`null` 不增加第二个条件。

create/update 的服务端校验是权威边界。update 触发重新校验的条件必须包含主模型 identity、压缩模型 identity、默认 thinking、默认 service tier。主模型改变也必须重验压缩模型容量。模板因目录漂移而不可用时，单纯修改 prompt/名称等非模型字段仍可保存；它不能被应用，直到模型配置修复。

`cloneConversationRole()` 深复制两个 model reference。所有新建 user conversation、peer/temporary conversation 和显式 role switch 都冻结完整字段。peer start 的 persisted `requestedRole` 与幂等 identity 比较自然包含新字段。

## 6. 最窄运行时接点

锁定 `@earendil-works/pi-coding-agent@0.84.4`：manual 与 SDK auto 在 `session_before_compact` 后，custom result 直接采用，只有无 custom result 时共同进入 `_runDefaultCompaction(...)`。它继续调用 Pi 原生 `compact()`。

这是私有但精确的 pinned-version seam。安装 adapter 时必须检查该方法存在且为函数；不匹配时 session 创建 fail closed。现有 `compaction-thinking.ts` 重命名为 `compaction-request.ts`，event-window adapter 改为 `installDefaultCompactionRequestOverride(session, transport, resolveCompactionModel?)`，resolver 缺席表示 `null`。

每次 `_runDefaultCompaction`：

1. 先检查 session-local `activeDefaultCompaction`；已有 attempt 未结算时，第二次调用在解析/修改 identity 前失败。
2. 记录当前 SDK session request decorator `session.agent.streamFunction`。
3. `null` 使用原 request model/auth。
4. 显式配置在 hook 完成后调用 resolver 一次，按 identity 从当前 session-local runtime取 fresh `Model`，并立即重验 A/B 窗口是有限正数且 B>=A。
5. 改写当前 8 positional 参数：`requestModel=B`，`apiKey/headers/env=undefined`；preparation、custom instructions、signal、reason 原位保留。
6. request-local stream wrapper 按实际模型 clamp `minimal` reasoning；Codex target 采用会话 transport，auto 规范为 sse；显式配置加入 service-tier suppression marker；其余 options spread 保留，并调用 captured SDK decorator。
7. 只为让原方法同步读取 wrapper 并按值传给 Pi `compact()`，临时替换 `agent.streamFunction`。用 `Reflect.apply(original, session, rewrittenArgs)` 保留 receiver/参数；取得 original 返回 Promise 后在同步 `finally` 立即恢复 stream identity，不等 provider 结算。
8. 在恢复后的普通 stream identity 下 await 已捕获 wrapper 的 Promise；最外层 finally 清 active guard。

这种同步捕获比跨 await 修改共享函数更窄：普通 turn、branch summary 或第二操作看不到临时 wrapper，不形成 wrapper 链。目标 model 传给 Pi 原生 `compact()`，使 Pi 按目标 `maxTokens` 计算普通/split-turn 限额；split-turn 两请求共用一个本次解析对象，下一次 attempt fresh resolve。

不得直连全局 `streamSimple`、baseline runtime 或 provider transport；否则绕过 session-local auth、SDK timeout/retry、attribution 和 header hook。

### 6.1 认证与 tier 隔离

Captured SDK decorator 最终调用当前 session 的 `ModelRuntime.streamSimple(B, ...)`。主模型三个 auth override 置 `undefined`，由 runtime 为 B 重解 API key、OAuth/provider headers、auth-derived base URL 与 env，随后仍加 B attribution 并运行项目 `before_provider_headers`。Pi 在 hook/default 分支前仍可能预读主 auth；合同只保证实际 provider request provenance，不保证不读取主 credential。

`service-tier.ts` 增加模块内部 enumerable `Symbol` marker/helper。显式 compaction options 带 marker；service-tier wrapper 在 provider dispatch 前读取并删除 marker，确保 `Reflect.ownKeys(providerOptions)` 不含它。marker 请求 tier=null、不做主 tier capability assertion；first-party Codex hint 保留 `model=B` 但无 tier；sessionId socket fence 保留。无 marker 行为不变。禁止 async 全局 flag/counter。

### 6.2 生命周期

adapter 记录 private method 原来是 own 还是 inherited：dispose 时仅 identity 仍匹配才恢复；inherited 用 delete。临时 stream 只跨同步 original invocation且 identity 匹配才恢复。active guard 持续到 original Promise settlement。resolver、容量检查、同步 original、provider、abort、dispose 均走 finally。resolver closure 只保存深复制 identity，不保存 Model；role switch/rollback/rewind 重建 runtime时自然使用对应 frozen identity。

## 7. UI

`RoleManagerDialog` 在角色模型后增加“上下文压缩模型”：首项“跟随角色模型（默认）”映射 null；其余复用 configured+available provider/model；展示 context window；小于主模型窗口的候选不可新选并解释 v1 不支持。已保存但当前缺失/不兼容的显式模型仍 disabled 展示，不静默变 null。切换主模型不自动清空显式值，若不兼容显示提示。无新 conversation command。

`RoleDraft` 的 empty/hydrate/deep-copy/sameDraft/submit 均含字段。`list_roles`/`read_role` 投影字段；`propose_role_revision` 只改 prompt，但完整 update draft 原样复制压缩模型。

## 8. 文件与测试

生产文件：

- `src/shared/protocol.ts`
- `src/server/role-store.ts`
- `src/server/conversation-meta.ts`
- `src/server/role-catalog.ts`
- `src/server/compaction-thinking.ts` → `compaction-request.ts`
- `src/server/service-tier.ts`
- `src/server/pi-runtime.ts`
- `src/server/project-session-coordinator.ts`
- `src/client/components/RoleManagerDialog.tsx`
- typed client fixtures

实现后同步：`.knowledge/kb-agent-collaboration.md`、`kb-server-runtime.md`、`kb-project-sessions.md`、`kb-wire-protocol.md`、`kb-client-state.md` 与 `AGENTS.md`；无新知识页，不改 INDEX。

最小测试矩阵：

1. RoleStore v1/v5/v6 缺字段迁移 null且 revision 不变；v7 round-trip/strict；仅改字段 revision+1。
2. 旧 base metadata、role-change、card requestedRole 缺字段归一化；peer 幂等 replay不分叉。
3. RoleCatalog missing/small window/主模型变化/null/目录漂移 prompt-only update。
4. user/peer 创建、switch、rollback/reopen runtime option 使用冻结字段；meta tools 保留。
5. adapter null、A→B、B thinking/transport、模拟 split、同步 restore、overlap guard、fresh model、missing/shrunk、throw/abort/dispose、pinned shape、真实 manual/auto receiver与8参数。
6. custom hook 返回 result 时 resolver/provider 零调用。
7. provider 边界验证 B apiKey/baseUrl/headers/env，A 各种大小写哨兵均不泄漏；tier marker 剥离、hint/socket/retry/options保留。
8. UI default null、explicit、main switch保留、small禁选、retired/incompatible保留、dirty/CAS/deep copy、无新command。

## 9. 实施顺序与验收

顺序：先反例；领域/持久化/protocol；typed fixtures；runtime adapter与service-tier marker（同一可发布单位）；coordinator/meta-tools；UI；manual/auto/custom/refresh integration；知识页；完整 gates。

建议提交：

1. `role compaction model schema and migration`
2. `route default compaction through frozen model`
3. `expose role compaction model in UI and docs`

实现完成仅当：

- 普通 turn model/auth/tier 不变；null compaction行为不变。
- explicit 实际 provider request 只含目标凭据且无主 tier。
- manual、SDK auto、split-turn 用目标；custom hook不用。
- missing或refresh缩窗无fallback/append；已有 conversation 可打开；不做成功 rebuild，同时保留 seam 前 Pi transient overflow state。
- v1-v6 stores与旧 conversation JSONL兼容，新格式strict。
- revision、freeze、switch/rollback、peer replay均保留字段。
- UI不静默改写 unavailable/incompatible selection。
- 最终通过：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

## 10. 已知边界

1. 私有 SDK seam 由 pinned 0.84.4、shape assertion与测试约束；升级时优先推动公开 default-compaction request hook。
2. Pi 仍预读主 auth，但实际 B request不继承。
3. overflow失败时 seam前已形成的 transient recovery state不回滚；JSONL不因压缩失败增删entry。
4. 小窗口模型不支持，未来另做 chunked summarization。
5. catalog漂移时 runtime fresh resolve并重验。
6. usage总数准确，但不新增B identity breakdown。
7. 项目 hook主动调用 `ctx.modelRegistry.complete()` 自己负责其模型/headers；default adapter不重路由。
