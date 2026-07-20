import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ConversationMessageCard } from "../../shared/protocol";
import type { ChatMessage } from "../chat/reducer";
import { SessionMessageCard } from "./SessionMessageCard";
import { ToolCard } from "./ToolCard";

const TOOL_PREVIEW_LIMIT = 4;
const STREAMING_TEXT_DRAIN_MS = 180;
const STREAMING_TEXT_MAX_CHAR_INTERVAL_MS = 10;
const STREAMING_TEXT_MAX_CHARS_PER_FRAME = 12;

function advanceTextOffset(text: string, offset: number, count: number): number {
  let nextOffset = offset;
  for (let index = 0; index < count && nextOffset < text.length; index += 1) {
    const codePoint = text.codePointAt(nextOffset);
    nextOffset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
  }
  return nextOffset;
}

class StreamingTextAnimator {
  private animationFrame: number | undefined;
  private lastUpdateTime = 0;

  public targetText: string;
  public currentText: string;

  constructor(
    text: string,
    private readonly setText: (text: string) => void,
  ) {
    this.targetText = text;
    this.currentText = text;
  }

  start(): void {
    if (
      this.animationFrame !== undefined
      || this.currentText === this.targetText
    ) return;
    this.lastUpdateTime = Date.now();
    this.animationFrame = window.requestAnimationFrame(this.animate);
  }

  stop(): void {
    if (this.animationFrame === undefined) return;
    window.cancelAnimationFrame(this.animationFrame);
    this.animationFrame = undefined;
  }

  snapTo(text: string): void {
    this.stop();
    this.targetText = text;
    this.currentText = text;
    this.setText(text);
  }

  private animate = () => {
    this.animationFrame = undefined;
    if (!this.targetText.startsWith(this.currentText)) {
      this.snapTo(this.targetText);
      return;
    }
    const remainingChars = this.targetText.length - this.currentText.length;
    if (remainingChars <= 0) return;

    const currentTime = Date.now();
    const elapsed = currentTime - this.lastUpdateTime;
    const timePerChar = Math.min(
      STREAMING_TEXT_MAX_CHAR_INTERVAL_MS,
      STREAMING_TEXT_DRAIN_MS / remainingChars,
    );
    const charsToAdd = Math.min(
      remainingChars,
      STREAMING_TEXT_MAX_CHARS_PER_FRAME,
      Math.floor(elapsed / timePerChar),
    );
    if (charsToAdd > 0) {
      const nextOffset = advanceTextOffset(
        this.targetText,
        this.currentText.length,
        charsToAdd,
      );
      this.currentText = this.targetText.slice(0, nextOffset);
      this.lastUpdateTime = currentTime - (elapsed - charsToAdd * timePerChar);
      this.setText(this.currentText);
    }
    if (this.currentText !== this.targetText) {
      this.animationFrame = window.requestAnimationFrame(this.animate);
    }
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ?? false;
}

function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  flush: boolean,
  onReveal?: () => void,
): string {
  const [displayedText, setDisplayedText] = useState(text);
  const animatorRef = useRef<StreamingTextAnimator | undefined>(undefined);
  const smoothingSession = useRef(streaming);
  const lastReportedText = useRef(text);
  if (!animatorRef.current) {
    animatorRef.current = new StreamingTextAnimator(text, setDisplayedText);
  }

  useLayoutEffect(() => {
    if (displayedText === lastReportedText.current) return;
    lastReportedText.current = displayedText;
    if (smoothingSession.current) onReveal?.();
  }, [displayedText, onReveal]);

  useLayoutEffect(() => {
    const animator = animatorRef.current;
    if (!animator) return;
    const previousTarget = animator.targetText;
    const appendOnly = text.startsWith(previousTarget)
      && text.startsWith(animator.currentText);
    animator.targetText = text;

    const reducedMotion = prefersReducedMotion();
    if (flush || reducedMotion || !appendOnly) {
      smoothingSession.current = streaming && !flush && !reducedMotion;
      animator.snapTo(text);
      return;
    }
    if (streaming) smoothingSession.current = true;
    if (smoothingSession.current) {
      animator.start();
    } else {
      animator.snapTo(text);
    }
    if (!streaming && animator.currentText === text) {
      smoothingSession.current = false;
    }
  }, [displayedText, flush, streaming, text]);

  useEffect(() => () => animatorRef.current?.stop(), []);

  return displayedText;
}

function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

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
  smoothStreamingText = false,
  flushStreamingText = false,
  onStreamingTextReveal,
}: {
  message: ChatMessage;
  sessionCards?: ConversationMessageCard[];
  onOpenConversation?(conversationId: string): void;
  onRewind?(messageId: string, text: string): void;
  rewindDisabled?: boolean;
  rewinding?: boolean;
  activeThinking?: boolean;
  smoothStreamingText?: boolean;
  flushStreamingText?: boolean;
  onStreamingTextReveal?(): void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const displayedText = useSmoothStreamingText(
    message.text,
    smoothStreamingText,
    flushStreamingText,
    onStreamingTextReveal,
  );

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const isUser = message.role === "user";
  const hasActivity = message.tools.length > 0 || sessionCards.length > 0;
  const html = useMemo(
    () => message.role === "assistant"
      ? renderMarkdown(displayedText || (hasActivity ? "" : "…"))
      : "",
    [displayedText, hasActivity, message.role],
  );
  const thinkingHtml = useMemo(
    () => message.thinking ? renderMarkdown(message.thinking) : "",
    [message.thinking],
  );
  if (message.role === "error") return <article className="message error">{message.text}</article>;
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
  const rewindUserMessage = isUser ? onRewind : undefined;
  const actions = (message.text || rewindUserMessage) ? <div className="message-actions">
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
    {rewindUserMessage ? <button
      type="button"
      className="message-action message-rewind"
      aria-label="回到此处，删除这条及之后的消息"
      title="彻底删除这条消息以及之后的所有消息"
      disabled={rewindDisabled || rewinding}
      onClick={() => {
        if (!window.confirm(
          "将彻底删除这条消息以及之后的所有消息，且无法恢复。确定回到此处吗？",
        )) return;
        rewindUserMessage(message.id, message.text);
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
      <div
        className="thinking-body markdown"
        dangerouslySetInnerHTML={{ __html: thinkingHtml }}
      />
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
    {displayedText || !hasActivity ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    {actions}
  </article>;
}
