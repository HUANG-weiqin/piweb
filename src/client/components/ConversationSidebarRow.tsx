import { memo } from "react";
import {
  type ConversationActivity,
  type ConversationSummary,
} from "../../shared/protocol";
import {
  conversationDisplayTitle,
  shortConversationHandle,
} from "../lib/conversation-display";
import { isConversationActive } from "../lib/conversation-grouping";
import { ActivitySpinner } from "./ActivitySpinner";

type ConversationRowHierarchy = "root" | "member" | "standalone";

export interface ConversationRowRenamePresentation {
  name: string;
  status: "syncing" | "unknown" | "committed";
}

interface ConversationRowProps {
  conversation: ConversationSummary;
  hierarchy: ConversationRowHierarchy;
  ordinal?: string;
  selected: boolean;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  deletionBlocked: boolean;
  cascadeDeleteBlocked?: boolean;
  renamePresentation?: ConversationRowRenamePresentation;
  busy: boolean;
  formatLastActive(value: string): string;
  onSelect(conversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
  onRequestFork?(conversationId: string): void;
}

function ActivityIndicator({
  activity,
}: {
  activity: ConversationActivity | undefined;
}) {
  if (activity?.kind === "queued" || activity?.kind === "running") {
    const label = activity.kind === "queued" ? "排队中" : "运行中";
    return (
      <span
        className={`conversation-activity-indicator activity-${activity.kind}`}
        role="status"
        aria-label={label}
        title={label}
      >
        <ActivitySpinner className="conversation-activity-spinner" />
      </span>
    );
  }

  switch (activity?.kind) {
    case "waiting":
      return (
        <span
          className="conversation-activity-indicator activity-waiting"
          role="status"
          aria-label="等待其他会话"
          title="等待其他会话"
        >
          ⌛
        </span>
      );
    case "cancelling":
      return (
        <span
          className="conversation-activity-indicator activity-cancelling"
          role="status"
          aria-label="正在终止"
          title="正在终止"
        >
          ■
        </span>
      );
    default:
      return null;
  }
}

export const ConversationRow = memo(function ConversationRow({
  conversation,
  hierarchy,
  ordinal,
  selected,
  navigationEnabled,
  actionsEnabled,
  deletionBlocked,
  cascadeDeleteBlocked = false,
  renamePresentation,
  busy,
  formatLastActive,
  onSelect,
  onRequestRename,
  onRequestDelete,
  onRequestFork,
}: ConversationRowProps) {
  const title = renamePresentation?.name ?? conversationDisplayTitle(conversation);
  const active = isConversationActive(
    conversation,
    busy ? conversation.id : undefined,
  );
  const compacting = conversation.compacting;
  const actionBlocked = active || compacting;
  const renameUnresolved = renamePresentation?.status === "syncing"
    || renamePresentation?.status === "unknown";
  const classes = [
    "conversation-sidebar-item",
    `hierarchy-${hierarchy}`,
    `activity-${conversation.activity?.kind ?? "idle"}`,
    selected ? "selected" : "",
    conversation.attention ? "needs-attention" : "",
    conversation.unread ? "has-unread" : "",
  ].filter(Boolean).join(" ");

  return (
    <li className={classes} data-conversation-id={conversation.id}>
      <button
        type="button"
        className="conversation-sidebar-conversation"
        aria-current={selected ? "page" : undefined}
        aria-label={selected ? `当前会话 ${title}` : `打开会话 ${title}`}
        disabled={!navigationEnabled}
        onClick={() => onSelect(conversation.id)}
      >
        {ordinal && (
          <span className="conversation-sidebar-ordinal" aria-hidden="true">
            {ordinal}
          </span>
        )}
        {hierarchy !== "member" && (
          <span className="conversation-sidebar-kind">
            {hierarchy === "root" ? "主任务" : "主会话"}
          </span>
        )}
        <span className="conversation-sidebar-primary">
          <span className="conversation-sidebar-title">{title}</span>
          <span className="conversation-sidebar-indicators">
            {hierarchy !== "member"
              && conversation.createdBy?.kind === "conversation"
              && (
                <span
                  className="conversation-agent-badge"
                  title="由 Agent 创建"
                >
                  Agent
                </span>
              )}
            <ActivityIndicator activity={conversation.activity} />
            {compacting && (
              <span
                className="conversation-compacting-indicator"
                role="status"
                aria-label="正在压缩上下文"
                title="正在压缩上下文"
              >
                压缩
              </span>
            )}
            {conversation.attention && (
              <span
                className="conversation-attention-indicator"
                role="status"
                aria-label="需要处理"
                title="需要处理"
              >
                !
              </span>
            )}
            {renamePresentation?.status === "syncing" && (
              <span
                className="conversation-activity-indicator activity-waiting"
                role="status"
                aria-label="名称同步中"
                title="名称同步中"
              >⌛</span>
            )}
            {renamePresentation?.status === "unknown" && (
              <span
                className="conversation-attention-indicator"
                role="status"
                aria-label="名称保存状态未确认；点击会话重新检查"
                title="名称保存状态未确认；点击会话重新检查"
              >!</span>
            )}
            {conversation.unread && (
              <span
                className="conversation-unread-indicator"
                role="status"
                aria-label="未读消息"
                title="未读消息"
              />
            )}
          </span>
        </span>
        <span className="conversation-sidebar-identity">
          <span className="conversation-sidebar-role">
            {conversation.role?.name ?? "角色加载中"}
          </span>
          <span
            className="conversation-sidebar-handle"
            title={conversation.id}
          >
            {shortConversationHandle(conversation.id)}
          </span>
          {hierarchy === "member"
            && conversation.createdBy?.kind === "conversation"
            && (
              <span
                className="conversation-agent-badge"
                title="由 Agent 创建"
              >
                Agent
              </span>
            )}
        </span>
        <time
          className="conversation-sidebar-updated"
          dateTime={conversation.updatedAt}
        >
          最后活跃 {formatLastActive(conversation.updatedAt)}
        </time>
      </button>
      <div className="conversation-sidebar-actions">
        <button
          type="button"
          className="conversation-sidebar-fork ghost"
          aria-label={`分支会话 ${title}`}
          disabled={
            !actionsEnabled
            || !onRequestFork
            || actionBlocked
          }
          title={active
            ? "活跃会话结算后可以分支"
            : compacting
            ? "上下文压缩完成后可以分支"
            : "分支当前上下文为新会话"}
          onClick={() => onRequestFork?.(conversation.id)}
        >
          分支
        </button>
        <button
          type="button"
          className="conversation-sidebar-rename ghost"
          aria-label={`重命名会话 ${title}`}
          disabled={
            !actionsEnabled
            || actionBlocked
            || renameUnresolved
          }
          title={active
            ? "活跃会话结算后可以重命名"
            : compacting
            ? "上下文压缩完成后可以重命名"
            : renameUnresolved
            ? "名称状态确定后可以重命名"
            : "重命名会话"}
          onClick={() => onRequestRename(conversation)}
        >
          改名
        </button>
        <button
          type="button"
          className="conversation-sidebar-delete ghost danger"
          aria-label={`删除会话 ${title}`}
          disabled={
            !actionsEnabled
            || deletionBlocked
            || cascadeDeleteBlocked
            || actionBlocked
            || renameUnresolved
          }
          title={active
            ? "活跃会话需先终止并等待结算"
            : compacting || cascadeDeleteBlocked
            ? "上下文压缩完成后可以删除"
            : renameUnresolved
            ? "名称状态确定后可以删除"
            : "删除会话"}
          onClick={() => onRequestDelete(conversation.id)}
        >
          删除
        </button>
      </div>
    </li>
  );
});
