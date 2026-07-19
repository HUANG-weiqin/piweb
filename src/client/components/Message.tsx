import { useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ConversationMessageCard } from "../../shared/protocol";
import type { ChatMessage } from "../chat/reducer";
import { SessionMessageCard } from "./SessionMessageCard";
import { ToolCard } from "./ToolCard";

const TOOL_PREVIEW_LIMIT = 4;

function ToolsPanel({ tools }: { tools: ChatMessage["tools"] }) {
  const [showAllTools, setShowAllTools] = useState(false);
  const hasOverflow = tools.length > TOOL_PREVIEW_LIMIT;
  const visibleTools = showAllTools ? tools : tools.slice(Math.max(0, tools.length - TOOL_PREVIEW_LIMIT));
  const hiddenToolsCount = hasOverflow && !showAllTools ? tools.length - visibleTools.length : 0;

  return <details className="tools">
    <summary>
      <span className="tools-title">工具调用（{tools.length}）</span>
      <span className="tools-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="tool-stack">
      {!!hiddenToolsCount && <p className="tool-stack-note">已折叠 {hiddenToolsCount} 条更早工具调用</p>}
      {visibleTools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
      {hasOverflow ? <button className="ghost tool-toggle" type="button" onClick={() => setShowAllTools((current) => !current)}>{showAllTools ? `收起到最近 ${TOOL_PREVIEW_LIMIT} 条` : `展开全部 ${tools.length} 条`}</button> : null}
    </div>
  </details>;
}

export function Message({
  message,
  sessionCards = [],
  onOpenConversation,
  onRewind,
  rewindDisabled = false,
  rewinding = false,
  activeThinking = false,
}: {
  message: ChatMessage;
  sessionCards?: ConversationMessageCard[];
  onOpenConversation?(conversationId: string): void;
  onRewind?(messageId: string): void;
  rewindDisabled?: boolean;
  rewinding?: boolean;
  activeThinking?: boolean;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  if (message.role === "error") return <article className="message error">{message.text}</article>;
  const isUser = message.role === "user";
  const hasActivity = message.tools.length > 0 || sessionCards.length > 0;
  let copyLabel = isUser ? "复制用户消息" : "复制 Agent 回复";
  let copyTitle = isUser ? "复制用户原文" : "复制原始 Markdown";
  let copyText = "复制";
  let copySymbol = "⧉";
  if (copyState === "copied") {
    copyLabel = isUser ? "已复制用户消息" : "已复制 Agent 回复";
    copyTitle = "已复制";
    copyText = "已复制";
    copySymbol = "✓";
  } else if (copyState === "failed") {
    copyLabel = isUser ? "复制用户消息失败" : "复制 Agent 回复失败";
    copyTitle = "复制失败，请重试";
    copyText = "重试";
    copySymbol = "!";
  }
  const actions = (message.text || onRewind) ? <div className="message-actions">
    {message.text ? <button
      type="button"
      className={`message-action message-copy ${copyState}`}
      aria-label={copyLabel}
      title={copyTitle}
      onClick={() => void copyMessage()}
      onBlur={() => setCopyState("idle")}
      onMouseLeave={() => setCopyState("idle")}
    >
      <span aria-hidden="true">{copySymbol}</span>
      {copyText}
    </button> : null}
    {onRewind ? <button
      type="button"
      className="message-action message-rewind"
      aria-label="回到此处，删除这条及之后的消息"
      title="彻底删除这条消息以及之后的所有消息"
      disabled={rewindDisabled || rewinding}
      onClick={() => {
        if (!window.confirm(
          "将彻底删除这条消息以及之后的所有消息，且无法恢复。确定回到此处吗？",
        )) return;
        onRewind(message.id);
      }}
    >
      <span aria-hidden="true">↶</span>
      {rewinding ? "处理中…" : "回到此处"}
    </button> : null}
  </div> : null;
  if (isUser) {
    return <article className="message user">
      {message.text}
      {actions}
    </article>;
  }
  const html = DOMPurify.sanitize(marked.parse(
    message.text || (hasActivity ? "" : "…"),
    { async: false },
  ) as string);
  return <article className="message assistant">
    {message.thinking && <details className={`thinking${activeThinking ? " is-active" : ""}`}>
      <summary>
        {activeThinking
          ? <span
              className="thinking-live"
              role="status"
              aria-label="Agent 正在思考"
            >
              <span className="thinking-spinner" aria-hidden="true" />
            </span>
          : <span className="thinking-complete" aria-hidden="true">✓</span>}
        <span>{activeThinking ? "正在思考" : "思考过程"}</span>
        <span className="thinking-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div>{message.thinking}</div>
    </details>}
    {message.tools.length ? <ToolsPanel tools={message.tools} /> : null}
    {sessionCards.length > 0 && <section
      className="session-message-stack"
      aria-label="会话协作"
    >
      {sessionCards.map((card) => <SessionMessageCard
        key={card.cardId}
        card={card}
        onOpenConversation={onOpenConversation}
      />)}
    </section>}
    {message.text || !hasActivity ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    {actions}
  </article>;
}
