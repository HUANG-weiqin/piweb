# 会话协作组视觉与交互设计

`status: approved`

## 目标

当两个或更多用户任务分别派生一组 Agent 会话时，侧栏仍以用户任务为主要导航单位，而不是让每个执行会话占据同一级视觉位置。

核心公式：

```text
侧栏一级导航 = 根会话协作组 + 独立会话
组内成员 = 同一 orchestration root 下的平级 conversation
```

这只改变浏览器投影。`ConversationActor`、run、inbox、writer lease、跨会话通信和删除级联仍按现有平级 conversation 语义运行。

## 观察边界

- 运行时需要观察每个独立 conversation；它们继续平级存在。
- 删除与预算需要观察持久来源谱系；现有 metadata 已保存 `rootConversationId`。
- 浏览器导航需要观察“根任务 + 成员活动摘要”，不需要重建父子执行树。

因此浏览器只新增一个已由服务端解析的 `rootConversationId` 投影，不新增持久 `Team` 实体、team 命令或 team 生命周期。

## 默认视觉

侧栏保持当前暖灰、低饱和、轻边框风格。会话始终按根任务聚合，不显示“按任务 / 全部”模式切换。

```text
┌────────────────────────────┐
│ 会话                    ‹   │
│ ╭────────────────────────╮ │
│ │   修复登录偶发失效 改名 删除│
│ │   2 运行 · 1 等待      ⌄│ │
│ ├────────────────────────┤ │
│ │  ┊ ● 回归 WebSocket     │ │
│ │  ┊   Tester · #9f31     │ │
│ │  ┊ ! 检查并发竞态       │ │
│ │  ┊   Reviewer · #0a72   │ │
│ │  └─ 查看其余 3 个空闲   │ │
│ ╰────────────────────────╯ │
│                            │
│ ╭────────────────────────╮ │
│ │›  重构模型缓存       4  │ │
│ │   ● 1 运行 · 最近 14:20 │ │
│ ╰────────────────────────╯ │
│                            │
│ 独立会话                   │
│   日常问答                 │
│                            │
│ ────────────────────────── │
│ ＋ 新建会话                │
└────────────────────────────┘
```

实际状态图标使用现有 `ActivitySpinner` 与 CSS 图形，不依赖 emoji。

## 信息层级

### 协作组卡片

只有至少包含一个 Agent 派生成员的根会话形成协作组卡片。没有成员的根会话进入“独立会话”。

卡片收起时展示：

- 根会话标题；
- 可见 Agent 数量；
- 运行、等待、attention 和 unread 摘要；
- 最新活动时间。

卡片展开时：

- 根标题区域本身可打开根会话；
- 根行下方的整条低强调状态摘要作为 disclosure，只控制展开；右侧 CSS chevron 在收起时向右、展开时向下，不使用孤立字符按钮；
- 成员使用一条轻量垂直连接线，不按 depth 绘制多层树；
- 当前、活跃、attention、unread 成员优先；
- 其余空闲成员只显示最近三项，剩余项通过“查看其余 N 个空闲会话”展开。

根会话、成员与独立会话统一复用改版前的会话行 DOM 和样式。组容器只增加摘要、展开按钮与中性连接线，不增加身份色卡片、专用背景或第二套状态投影；running/waiting 等状态继续完全使用既有 success/warning/danger 语义色、图标和 `aria-label`。

### 当前上下文

打开组内 Agent 后，Chat 顶栏显示只读面包屑：

```text
根任务标题 / 当前 Agent 会话标题
```

若当前就是根会话，只显示根标题。面包屑只从当前项目 snapshot 的摘要派生；事实缺失时省略，不猜测。

## 交互

- 首次显示列表时，只自动展开当前会话所属组。
- 用户可显式收起当前组；后台状态更新不得重新展开或抢焦点。
- focus 切换到另一个组时，新组自动展开一次。
- 新 Agent 创建只更新组摘要，不自动展开。
- 组排序：当前组 → 含 attention → 含活跃成员 → 含 unread → 最新活动。
- 组内排序：当前成员 → attention → 活跃 → unread → 最新活动。
- 点击根标题或成员仍只调用现有 `onSelect(conversationId)`。
- focus 同步期间仍可替换导航目标；新建、改名、删除继续遵守现有 `actionsEnabled` gate。
- workspace 同步、离线或删除 pending 时，展开控制遵守现有导航冻结语义。
- 每条会话行继续直接显示改版前的“改名 / 删除”操作并复用现有对话框与 gate；协作组不改写这套行内交互。

## 有界项目快照

浏览器不能从 `createdBy` 链自行求根，因为 `project_snapshot` 会截断，父节点可能缺席。服务端必须投影已验证的：

```ts
rootConversationId?: string
```

- 新版根会话：值等于自身 ID。
- Agent descendant：值等于持久 orchestration root。
- 无 metadata 的旧会话：按独立根投影自身 ID。
- 字段暂时缺失时，客户端按独立会话显示，不递归猜测。

`project_snapshot` 在 count 和 JSON byte 两个边界都以协作组为优先装载单位，保证受支持的最多 32 个 live descendants 不会只留下 child 而丢掉 root。省略任一整组都设置 `truncated=true`；极端旧数据中单组自身超过硬预算时，只保留 root/current 与最高优先成员，并继续明确显示截断提示。

## 可访问性与响应式

- 组展开按钮使用 `aria-expanded` 与 `aria-controls`。
- 根会话按钮和展开按钮分开，禁止嵌套 button。
- 当前会话行继续使用 `aria-current="page"`。
- 收起成员从 DOM/tab 顺序移除。
- 不给整个导航加 `aria-live`，避免后台 activity 反复播报。
- 所有触控目标至少 40px；移动端不依赖 hover。
- 标题使用 ellipsis，组内不产生横向滚动。
- 动画只包括 120–160ms 的淡入、箭头旋转和背景过渡，并尊重 `prefers-reduced-motion`。
- 暗色模式只复用现有 token，不创建第二套颜色真相。

## 不做

- 不做递归 tree/treegrid、拖拽排序、Kanban 或多栏 Agent dashboard。
- 不新增 team 持久文件、team ID、team abort/delete 命令或权限边界。
- 不把展开状态写入 localStorage。
- 不改变 transcript、跨会话卡片或 Agent 工具语义。
- 不在本次引入搜索、分页、archive 或虚拟列表。

## 验收

1. 两个根任务各自派生多层 Agent 时，默认侧栏只占两个协作组一级位置。
2. 收起组仍诚实显示运行、等待、attention 与 unread。
3. 任意 root/child 仍能通过原 conversationId 导航，后台更新不改变 focus。
4. 唯一的按任务投影仍能管理所有已投影会话。
5. 截断不能在受支持组规模内留下无根 child。
6. 桌面、窄栏、移动端、键盘与暗色模式均不产生溢出或不可达动作。
