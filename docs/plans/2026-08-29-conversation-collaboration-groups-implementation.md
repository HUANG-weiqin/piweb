# 会话协作组实现计划

`status: completed`

## 交付范围

实现已批准的“按任务协作组”侧栏：服务端投影根会话事实并按组安全截断，客户端提供唯一的协作组列表、折叠成员、状态摘要、低干扰动作和当前会话面包屑。

预计影响 owner：

- 线协议：`src/shared/protocol.ts`
- 项目 summary 与有界快照：`src/server/project-session-coordinator.ts`、`src/server/project-snapshot.ts`、`src/server/pi-service.ts`
- 浏览器导航：`src/client/components/ConversationSidebar.tsx`、`src/client/App.tsx`
- 当前上下文：`src/client/components/Chat.tsx`
- 视觉：`src/client/styles.css`
- 对应协议、server、component、App 测试
- `.knowledge/kb-agent-collaboration.md`、`.knowledge/kb-client-state.md`

不新增持久类型或运行时实体。唯一新 wire 事实是可选 `rootConversationId`。

## Task 1：线协议与根事实投影

### 改动

1. 将协议版本从 35 升至 36，并记录变更。
2. 给 `ConversationSummary` 与 `project_snapshot` schema 增加可选、遵循现有 conversation ID 语法的 `rootConversationId`。
3. `ProjectSessionCoordinator.listSessions()` 在 summary 投影前保证 cold profile 已 hydrate。
4. 使用现有 orchestration resolver 投影根；无 metadata 的 legacy conversation 以自身为根。
5. 不投影 `depth` 或 `sourceRunId`。

### 验证

- 协议接受合法根并拒绝非法 ID。
- 用户根、一层/多层 descendant 和 legacy chain 得到稳定根。
- 不创建 AgentSession，不改变 recent/focus/run。

## Task 2：按组有界项目快照

### 改动

1. `projectConversationIndex()` 先按 `rootConversationId ?? id` 建组。
2. 组优先级保持现有语义：current、active、attention、unread、updatedAt。
3. 组内 root 与成员一起装入 `MAX_PROJECT_CONVERSATIONS`；省略组时设置 `truncated`。
4. `boundedProjectSnapshotEvent()` 超过 JSON byte budget 时按最后一个完整组移除，而不是逐 conversation `pop()`。
5. 单组超过硬预算时保留 root/current/最高优先成员并明确截断，绝不突破 wire budget。

### 验证

- 高优先 child 不会脱离 root。
- 当前 child 提升整个组。
- count/byte 两个截断边界都不拆支持范围内的组。
- 现有 singleton 会话排序与限制保持兼容。

## Task 3：协作组 Sidebar

### 改动

1. 在 `ConversationSidebar` 内派生 group projection，不进入 App 或持久状态。
2. 增加本地展开组集合和“显示全部空闲成员”集合；不维护第二种扁平视图。
3. 只为拥有 Agent descendant 的根渲染卡片；其余放入独立会话区。
4. 组摘要聚合 activity、waiting、attention、unread 与 latest update。
5. 当前组按 focus 变化自动展开一次；背景更新不改变 focus/展开意图。
6. 展开控制与会话导航分离；root、成员与独立会话统一复用改版前的 conversation row 与现有生命周期 gate。
7. 保留改版前每行直接显示的改名/删除按钮，继续复用现有 modal，不增加动作菜单。

### 验证

- 两个根及多层 descendants 正确分组。
- 折叠、展开和空闲成员 reveal 都可键盘操作，且不渲染模式切换。
- 点击 root/child 只调用原 `onSelect`。
- focus 同步可导航但禁止 lifecycle action；离线全部冻结。
- 当前、active、attention、unread 排序和语义状态正确。

## Task 4：视觉与当前上下文

### 改动

1. 使用现有 token 实现中性组摘要与连接线；组容器不增加身份色、卡片背景或会话状态覆盖，完整保留改版前行样式与暗色模式。
2. 保持 240–640px 可调桌面宽度和现有移动 overlay；不增加横向滚动。
3. App 从当前项目 summary 派生根/当前标题，传给 Chat。
4. Chat 顶栏显示只读、可截断面包屑；事实缺失时不渲染。
5. 尊重 reduced motion；移动端动作不依赖 hover。

### 验证

- 当前 child 的 breadcrumb 与 sidebar group 一致。
- transition/cache/focus 尚未 ready 时不展示错误来源。
- 组件测试覆盖 ARIA；App 测试覆盖真实 focus command 接线。

## Task 5：知识、完整门槛与审查

1. 更新 Agent collaboration 与 client state 知识页，替换“UI 永远扁平”的旧事实。
2. 运行聚焦测试，再运行：

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

3. 检查完整 diff 与工作树状态并提交 checkpoint。
4. 进行一次独立 correctness review；只修复有可达反例、违反本设计验收的 finding。
5. 若 diff 引入明显概念表面，进行一次 bounded simplify review，拒绝无事实依据的扩展。

## 停止条件

- 设计文档六项验收全部满足；
- 四项项目 gate 全部通过；
- 无 in-scope blocking review finding；
- 不继续追加搜索、archive、批量 team 命令或其它可选能力。
