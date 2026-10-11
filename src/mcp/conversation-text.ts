import type {
  ConversationHistoryItem,
  RoleTemplate,
} from "../shared/protocol.js";

type SessionMessageItem = Extract<ConversationHistoryItem, { kind: "session_message" }>;
type ProjectConversation = {
  id: string;
  name?: string;
  autoTitlePreview?: string;
  preview: string;
  updatedAt: string;
  messageCount: number;
  role?: { name: string; model: { provider: string; id: string } };
  activity?: { kind: string; runId?: string };
  compacting: boolean;
  attention?: boolean;
  createdBy?: { kind: "user" } | { kind: "conversation"; conversationId: string };
};

/** 本桥写入 Pi Web 的每条消息都带此前缀，让对方 Agent 知道说话的是 Claude Code。 */
export const CLAUDE_MESSAGE_PREFIX = "[Claude Code] ";

/** 按 Unicode 码点截断，避免把超长历史整段塞进调用方上下文。 */
export function clip(text: string, maxCharacters: number): string {
  const characters = [...text];
  if (characters.length <= maxCharacters) return text;
  return `${characters.slice(0, maxCharacters).join("")}…（已截断，共 ${characters.length} 字）`;
}

function compactJson(value: unknown, maxCharacters: number): string {
  if (value === undefined) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clip(text.replace(/\s+/g, " ").trim(), maxCharacters);
}

const TOOL_STATUS = {
  pending: "等待",
  running: "运行中",
  done: "完成",
  error: "出错",
} as const;

const CARD_STATE: Record<SessionMessageItem["state"], string> = {
  sending: "发送中",
  queued: "排队中",
  delivered: "已送达",
  running: "运行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
};

function endpointText(endpoint: SessionMessageItem["from"]): string {
  return `${endpoint.title ?? "未命名"}（${endpoint.role.name}，${endpoint.conversationId}）`;
}

export function formatHistoryItem(
  item: ConversationHistoryItem,
  maxCharacters: number,
): string {
  switch (item.kind) {
    case "message": {
      const speaker = item.role === "user" ? "用户" : "Agent";
      const lines = [`[${speaker}]${item.runId === undefined ? "" : ` run=${item.runId}`}`];
      const text = item.text.trim();
      if (text) lines.push(clip(text, maxCharacters));
      if (item.imageRefs?.length) {
        lines.push(`（附图 ${item.imageRefs.length} 张，未展示）`);
      }
      for (const tool of item.tools) {
        const args = compactJson(tool.args, 200);
        const result = tool.status === "error"
          ? ` → ${compactJson(tool.result, 300)}`
          : "";
        lines.push(
          `  · 工具 ${tool.toolName}${args ? ` ${args}` : ""}：${TOOL_STATUS[tool.status]}${result}`,
        );
      }
      if (!text && item.tools.length === 0 && item.thinking.trim()) {
        lines.push("（只有思考内容，未展示）");
      }
      return lines.join("\n");
    }
    case "compaction":
      return `[系统] 上下文已压缩（压缩前约 ${Math.round(item.tokensBefore)} tokens）`;
    case "bash_task_notification":
      return `[后台命令通知]\n${clip(item.text, maxCharacters)}`;
    case "session_message": {
      const direction = item.direction === "incoming" ? "收到" : "发出";
      const lines = [
        `[会话消息·${direction}] ${endpointText(item.from)} → ${endpointText(item.to)}（${CARD_STATE[item.state]}）`,
      ];
      if (item.summary.trim()) lines.push(`摘要：${clip(item.summary, 500)}`);
      if (item.body.trim()) lines.push(clip(item.body, maxCharacters));
      if (item.result?.trim()) lines.push(`结果：${clip(item.result, maxCharacters)}`);
      return lines.join("\n");
    }
  }
}

/** 最后一条 Agent 回复正文；没有则返回 undefined。 */
export function lastAgentReply(
  items: readonly ConversationHistoryItem[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "message" && item.role === "assistant" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return undefined;
}

export function conversationTitle(conversation: {
  name?: string;
  autoTitlePreview?: string;
} | undefined): string {
  return conversation?.name ?? conversation?.autoTitlePreview ?? "未命名";
}

export function activityText(
  activity: { kind: string; runId?: string } | undefined,
): string {
  if (activity === undefined) return "空闲";
  switch (activity.kind) {
    case "idle":
      return "空闲";
    case "queued":
      return `排队中（run=${activity.runId}）`;
    case "running":
      return `运行中（run=${activity.runId}）`;
    case "waiting":
      return `等待其它会话（run=${activity.runId}）`;
    case "cancelling":
      return `正在停止（run=${activity.runId}）`;
    default:
      return activity.kind;
  }
}

export function formatConversationList(
  cwd: string,
  conversations: readonly ProjectConversation[],
  truncated: boolean,
): string {
  if (conversations.length === 0) return `项目 ${cwd} 还没有会话。`;
  const lines = [`项目 ${cwd} 共 ${conversations.length} 个会话${truncated ? "（列表已截断）" : ""}：`];
  for (const conversation of conversations) {
    const role = conversation.role === undefined
      ? "未知角色"
      : `${conversation.role.name}（${conversation.role.model.provider}/${conversation.role.model.id}）`;
    const createdBy = conversation.createdBy?.kind === "conversation"
      ? `，由会话 ${conversation.createdBy.conversationId} 创建`
      : "";
    const flags = [
      conversation.compacting ? "正在压缩" : "",
      conversation.attention ? "需要处理" : "",
    ].filter(Boolean).join("、");
    lines.push(
      `- ${conversation.id}｜${conversationTitle(conversation)}｜${role}｜${activityText(conversation.activity)}${flags ? `｜${flags}` : ""}｜${conversation.messageCount} 条消息｜更新于 ${conversation.updatedAt}${createdBy}`,
    );
  }
  return lines.join("\n");
}

export function formatRoleList(roles: readonly RoleTemplate[]): string {
  if (roles.length === 0) return "没有可用角色。";
  const lines = [`共 ${roles.length} 个角色：`];
  for (const role of roles) {
    const model = role.model === null ? "未设置模型" : `${role.model.provider}/${role.model.id}`;
    const access = role.toolMode === "full_access" ? "完全权限" : "只读";
    const manage = role.canManageSessions ? "，可管理会话" : "";
    const availability = role.available
      ? ""
      : `｜不可用：${role.unavailableReason ?? "原因未知"}`;
    const description = role.description.trim()
      ? `｜${clip(role.description.trim(), 200)}`
      : "";
    lines.push(`- ${role.id}｜${role.name}｜${model}｜${access}${manage}${availability}${description}`);
  }
  return lines.join("\n");
}
