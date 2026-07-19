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
    <summary>工具调用（{tools.length}）</summary>
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
}: {
  message: ChatMessage;
  sessionCards?: ConversationMessageCard[];
  onOpenConversation?(conversationId: string): void;
}) {
  if (message.role === "user") return <article className="message user">{message.text}</article>;
  if (message.role === "error") return <article className="message error">{message.text}</article>;
  const hasActivity = message.tools.length > 0 || sessionCards.length > 0;
  const html = DOMPurify.sanitize(marked.parse(
    message.text || (hasActivity ? "" : "…"),
    { async: false },
  ) as string);
  return <article className="message assistant">
    {message.thinking && <details className="thinking"><summary>思考过程</summary><div>{message.thinking}</div></details>}
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
  </article>;
}
