# 项目启动的会话发现与完整证明分离

## 目标与范围

打开项目不再反复读取没有变化的历史会话正文；启动成本主要随目录项、变更文件和实际待恢复工作增长，而不是随全部历史 JSONL 字节增长。

本次不改变 Pi JSONL、压缩语义或 SDK 的单会话加载方式。一个超大会话自身的 cold open 仍完整读取历史。保留全部历史与恢复账本，不物理删除压缩前记录。完成后不 reload 当前实例。

## 观察边界

| 消费者 | 所需证据 | 不需要的工作 |
|---|---|---|
| 浏览器项目导航 | 新鲜、安全、稳定、唯一 header 的完整成员集合，加文件版本绑定的展示摘要 | 全部正文的当次完整证明 |
| 启动恢复发现 | 每个文件版本是否可能有未完成工作 | 每次重读已知未变且无工作的正文 |
| 恢复执行 | 候选会话的 fresh exact inspection，精确 message/card/run identity | 信任缓存中的可执行 payload |
| exact open / preview | header census + 目标完整 payload/tree 证明 | 无关文件正文证明 |
| Agent 完整列表、audit、cascade delete | 既有全目录完整正文与 SDK 对照证明 | 无契约削减 |

`project_snapshot.coverage=complete` 证明完整成员集合，不声称全部历史正文已重新校验。仅当前索引/缓存的无扫描投影仍为 `unknown`。不新增线协议字段。

## 最小实现

复用 ProjectStore 的 `conversation-catalog.json`，将发现观察升级为 v3：

- 键为受控相对路径，观察绑定 canonical path、dev、ino、size、mtimeNs、ctimeNs 与合法 header claim。
- 只保存有界展示摘要（包括无 systemPrompt 的 role、createdBy、root）与一个 `recoveryNeeded` 候选标记。不持久化全文、完整 profile 或另一份消息账本。
- 每次 discovery 重新确认安全命名空间及稳定唯一的 header claims。只有完整 fingerprint 相等的宿主观察可以跨重启免读正文。
- 缺失、旧版、损坏的观察，以及发生变化的文件，保守重读对应 JSONL。旧项目首次建立索引有一次全文成本。
- 发现回执不能填充进程内完整证明缓存，不能授权 open、delete、lease 或推断持久操作成功。
- cache 写入失败只损失加速；不允许把失败或不确定性记为没有工作。持续变化的文件重试或明确失败。
- 保留既有 4 MiB 持久 cache 预算。超限时只持久化可容纳的稳定观察前缀并标 `coverage: unknown`，内存仍保留完整观察；下次进程只重读未缓存行，不能因超限丢弃所有行的加速。本轮不引入分片、无界缓存或新配置。

跨进程负向发现有明确假设：catalog 是宿主产生且未被其他写入者改成格式合法的假阴性；完整 fingerprint 能标识文件版本。伪造同 fingerprint 的 ABA 与格式合法的 cache 篡改不在保证内。缓存可以删除，删除只触发重建。

## 恢复工作集合

文件有下列任一状态即为候选：

1. `abort_session` 的 `started` 且 `result.aborted=true`；
2. delivery receipt 对应的 exact target run 尚无 settlement；
3. 来源卡片仍待交付或结算投影修复。普通消息的 `delivered` 已完成交付投影，不是待修状态；委派需要 terminal outcome。

候选必须 fresh inspect 后分类。先发现并落实所有 abort intent，再允许 pump、idle prompt、直接 dispatch 或 reload continuation 启动 run；无法完成发现时不宣告 foundation ready。已定位但落实失败的 abort 继续按精确 target fence 封锁。精确只读 open/preview 不因恢复未就绪而失效。

receipt-only abort 也必须持久写 aborted settlement，不能因为 sidecar 已删除就完成来源 intent 后重新 resume 目标。

已结算目标只因来源卡片待修而被定位时，用 raw manager/receipt/settlement 修复现存卡片，不启动 AgentSession；不重建 rewind 已删除的卡片。正常无工作的历史 delegation receipt 不再触发 actor fanout。inbox tombstone 的破坏性恢复仍沿用完整证明。

## 所有权与验收

- ProjectStore：文件观察、v3 cache、目录成员证明与变更文件 inspection。
- Coordinator：恢复发现顺序、候选执行、启动门、live actor 展示覆盖。
- PiConnection：recent 与浏览器 refresh 使用发现投影；不以展示代替 focus authority。
- ConversationActor：结算复用自身 session 的摘要投影，不再用全目录 refresh 更新一个 actor，避免启动恢复完成时重新触发全部历史扫描。

回归至少证明：跨进程未变历史免全文读；追加一个文件只重读该文件；cache 丢失/旧版/损坏重建；路径替换、重复 header 与读取期变化不产生阴性；full audit/exact open 保留原证明；receipt-only、abort-before-pump、未完成来源卡片及发现失败 run-start 门正确。

最终执行 `npm test`、`npm run test:slow`、`npm run typecheck`、`npm run build`、`git diff --check`，并在隔离服务和真实浏览器输入路径验证项目打开。禁止 reload 当前实例。
