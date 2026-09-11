import { useId, useState } from "react";
import type {
  ConversationMessageCard,
  SessionMessageEndpoint,
} from "../../shared/protocol";
import { shortConversationHandle } from "../lib/conversation-display";

const STATE_LABELS: Record<ConversationMessageCard["state"], string> = {
  sending: "发送中",
  queued: "已排队",
  delivered: "已送达",
  running: "处理中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  aborted: "已终止",
};

function Endpoint({
  endpoint,
  kind,
}: {
  endpoint: SessionMessageEndpoint;
  kind: "from" | "to";
}) {
  const label = kind === "from" ? "来源会话" : "目标会话";
  return (
    <section className={`session-message-endpoint endpoint-${kind}`} aria-label={label}>
      <strong className="session-message-endpoint-title">
        {endpoint.title?.trim() || "未命名会话"}
      </strong>
      <span className="session-message-endpoint-role">{endpoint.role.name}</span>
      <span
        className="session-message-endpoint-handle"
        title={endpoint.conversationId}
      >
        {shortConversationHandle(endpoint.conversationId)}
      </span>
    </section>
  );
}

export function SessionMessageCard({
  card,
  onOpenConversation,
}: {
  card: ConversationMessageCard;
  onOpenConversation?(conversationId: string): void;
}) {
  const directionLabel = card.direction === "incoming" ? "收到" : "发出";
  const statusLabel = STATE_LABELS[card.state];
  const peer = card.direction === "incoming" ? card.from : card.to;
  const canOpen = onOpenConversation !== undefined
    && card.peerPresence !== "absent";
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const peerTitle = peer.title?.trim() || "未命名会话";
  const summary = card.summary ?? "";
  const hasSummary = summary.length > 0;
  const summaryPreview = summary.replace(/\s+/gu, " ").trim();

  return (
    <article
      className={[
        "session-message-card",
        `direction-${card.direction}`,
        `state-${card.state}`,
        expanded ? "is-expanded" : "is-collapsed",
      ].join(" ")}
      aria-label={`${directionLabel}的会话消息`}
    >
      <header className="session-message-header">
        <button
          type="button"
          className="session-message-toggle"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? "收起" : "展开"}${directionLabel}的会话消息：${peerTitle}`}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="session-message-direction">{directionLabel}</span>
          <span className="session-message-peer">
            {card.direction === "incoming" ? "来自" : "发给"} {peerTitle}
          </span>
          <span
            className="session-message-status"
            role="status"
            aria-label={`消息状态：${statusLabel}`}
          >
            {statusLabel}
          </span>
          <span className="session-message-chevron" aria-hidden="true">⌄</span>
        </button>
      </header>

      {!expanded && hasSummary && summaryPreview && (
        <p className="session-message-summary-preview" aria-label="给你的摘要预览">
          {summaryPreview}
        </p>
      )}

      {expanded && (
        <div id={detailsId} className="session-message-details">
          <div className="session-message-route">
            <Endpoint endpoint={card.from} kind="from" />
            <span className="session-message-route-arrow" aria-hidden="true">→</span>
            <Endpoint endpoint={card.to} kind="to" />
          </div>

          {hasSummary && (
            <section
              className="session-message-summary"
              aria-labelledby={`${detailsId}-summary-label`}
            >
              <strong
                id={`${detailsId}-summary-label`}
                className="session-message-summary-label"
              >
                给你的摘要
              </strong>
              <p className="session-message-summary-copy">{summary}</p>
            </section>
          )}

          <p className="session-message-body">{card.body}</p>

          {card.result !== undefined && (
            <section className="session-message-result" aria-label="会话消息结果">
              <strong>结果</strong>
              <p>{card.result}</p>
            </section>
          )}

          <footer className="session-message-footer">
            <time className="session-message-updated" dateTime={card.updatedAt}>
              {card.updatedAt}
            </time>
            {canOpen && (
              <button
                type="button"
                className="session-message-open"
                onClick={() => onOpenConversation(peer.conversationId)}
              >
                打开会话
              </button>
            )}
          </footer>
        </div>
      )}
    </article>
  );
}
