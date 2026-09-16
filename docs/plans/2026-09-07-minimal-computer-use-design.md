# 最小 Computer Use 设计稿（历史基线）

日期：2026-09-07
归档修订：2026-09-16
状态：**已被升级合同完整取代，仅保留设计沿革**

当前实现与验收合同以 [Computer Use 观察与输入能力升级设计稿](2026-09-07-computer-use-observation-input-upgrade-design.md) 为唯一依据。不要从本文恢复 provider-only 图片、单图内存槽或图片消费窗口。

## 历史目标

最初版本验证了一个最小本机闭环：

```text
观察主显示器
→ 模型决定一个有界动作批
→ Windows adapter 顺序派发
→ 工具如实报告 sent / unknown / not_started
```

它建立的下列边界仍然有效：

- `computer` 只属于 `full_access` conversation，并要求 exact active run ownership。
- `DesktopController` 进程级惰性拥有 Windows adapter，以 owner identity 串行 desktop lease。
- schema、权限和坐标校验必须在桌面副作用前完成。
- 坐标来自一次明确观察对应的 image-local frame；持久图片本身不是输入授权。
- abort、reload、compaction、terminal 与 dispose 必须清理瞬态 frame，并在 native primitive settle 后释放 lease。
- `sent` 只证明宿主完成派发，不证明应用处理或业务成功。
- 不做 OS sandbox、远程访问、DOM/可访问性树、OCR、后台窗口控制或跨调用裸 key/button down 状态。

## 已废弃的历史假设

原最小稿曾假设：

- PNG 只存在于一个 controller 内存槽；
- 图片由 `convertToLlm` provider-only 注入，成功 decision 后消费；
- tool result、SessionManager/JSONL 和 history 都不含 image；
- 浏览器不能通过持久引用打开截图；
- `agent-context-budget.ts` 参与 computer image 生命周期。

这些假设会让后续 provider request 删除或改写前一请求中的 image block，破坏 Codex append-only prompt/KV cache 前缀，因此已经全部删除。

## 当前替代合同摘要

- 每次成功 capture 在 provider 边界归一化后，直接在对应 tool result 中持久化 `[JSON text, 安全 label text, image/png|image/jpeg]`。
- initial observe 只产生 `current`；action observe 只产生新的 `after action batch`。旧图已在 transcript 中，不复制成 before，也不存在 `(A,B) → (B,C)` 滑动窗口。
- Pi JSONL 和 provider history保留标准 image content；普通 wire/history snapshot 删除 base64，只投影 marker 与 `(messageId,imageOrdinal)` ref，`open_image` 按需读取。
- controller 只保存无图片字节的 pending/authorized frame、owner、exact tool-call IDs、交付摘要与 single-decision latch。
- provider retry 和后续 turn 重放同一 image block，直到 compaction 把旧 entry 排除出有效模型上下文；持久 JSONL 不因 compaction 物理删除。
- 非 vision model 或 `images.blockImages=true` 在 adapter 创建和桌面副作用前拒绝。
- raw desktop PNG 和通用 durable image read 共用 16 MiB decoded-byte 上限；computer 持久结果另受最大 2000×2000、base64 小于 4.5 MiB 的更严边界。
- 当前 action 集、foreground-window crop、长按/拖拽、settle、状态机和测试矩阵都只在升级设计稿中维护。
