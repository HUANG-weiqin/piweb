import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ConversationMessageCard } from "../../shared/protocol";
import type { ChatMessage } from "../chat/reducer";
import { SessionMessageCard } from "./SessionMessageCard";
import { ToolCard } from "./ToolCard";

const TOOL_PREVIEW_LIMIT = 4;
const STREAMING_TEXT_GRAPHEME_INTERVAL_MS = 14;
const STREAMING_TEXT_MAX_GRAPHEMES_PER_FRAME = 2;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function advanceGraphemeOffset(
  text: string,
  offset: number,
  count: number,
): number {
  let nextOffset = offset;
  const segments = GRAPHEME_SEGMENTER.segment(text);
  for (let index = 0; index < count && nextOffset < text.length; index += 1) {
    const segment = segments.containing(nextOffset);
    if (!segment) break;
    nextOffset = segment.index + segment.segment.length;
  }
  return nextOffset;
}

class StreamingTextAnimator {
  private animationFrame: number | undefined;
  private lastUpdateTime: number | undefined;

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
    this.lastUpdateTime = undefined;
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

  private animate = (currentTime: number) => {
    this.animationFrame = undefined;
    if (!this.targetText.startsWith(this.currentText)) {
      this.snapTo(this.targetText);
      return;
    }
    if (this.currentText.length >= this.targetText.length) return;

    this.lastUpdateTime ??=
      currentTime - STREAMING_TEXT_GRAPHEME_INTERVAL_MS;
    const elapsed = Math.max(0, currentTime - this.lastUpdateTime);
    const graphemesToAdd = Math.min(
      STREAMING_TEXT_MAX_GRAPHEMES_PER_FRAME,
      Math.floor(elapsed / STREAMING_TEXT_GRAPHEME_INTERVAL_MS),
    );
    if (graphemesToAdd > 0) {
      const nextOffset = advanceGraphemeOffset(
        this.targetText,
        this.currentText.length,
        graphemesToAdd,
      );
      this.currentText = this.targetText.slice(0, nextOffset);
      this.lastUpdateTime +=
        graphemesToAdd * STREAMING_TEXT_GRAPHEME_INTERVAL_MS;
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

interface MessageProps {
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
}

function sameSessionCards(
  previous: ConversationMessageCard[] | undefined,
  next: ConversationMessageCard[] | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next || previous.length !== next.length) return false;
  return previous.every((card, index) => card === next[index]);
}

function sameMessageProps(previous: MessageProps, next: MessageProps): boolean {
  return previous.message === next.message
    && sameSessionCards(previous.sessionCards, next.sessionCards)
    && previous.onOpenConversation === next.onOpenConversation
    && previous.onRewind === next.onRewind
    && previous.rewindDisabled === next.rewindDisabled
    && previous.rewinding === next.rewinding
    && previous.activeThinking === next.activeThinking
    && previous.smoothStreamingText === next.smoothStreamingText
    && previous.flushStreamingText === next.flushStreamingText
    && previous.onStreamingTextReveal === next.onStreamingTextReveal;
}

function MessageView({
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
}: MessageProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [thinkingOpen, setThinkingOpen] = useState(false);
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
  const showingStreamingText = message.role === "assistant"
    && !prefersReducedMotion()
    && (smoothStreamingText || displayedText !== message.text);
  const html = useMemo(
    () => message.role === "assistant" && !showingStreamingText
      ? renderMarkdown(displayedText || (hasActivity ? "" : "…"))
      : "",
    [displayedText, hasActivity, message.role, showingStreamingText],
  );
  const thinkingHtml = useMemo(
    () => thinkingOpen && message.thinking ? renderMarkdown(message.thinking) : "",
    [message.thinking, thinkingOpen],
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
  let responseBody: ReactNode = null;
  if (displayedText || !hasActivity) {
    responseBody = showingStreamingText
      ? <div className="markdown streaming-markdown">
          {displayedText || (hasActivity ? "" : "…")}
        </div>
      : <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <article className="message assistant">
    {message.thinking && <details
      className={`thinking${activeThinking ? " is-active" : ""}`}
      open={thinkingOpen}
    >
      <summary onClick={(event) => {
        event.preventDefault();
        setThinkingOpen((open) => !open);
      }}>
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
      {thinkingOpen && <div
        className="thinking-body markdown"
        dangerouslySetInnerHTML={{ __html: thinkingHtml }}
      />}
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
    {responseBody}
    {actions}
  </article>;
}

export const Message = memo(MessageView, sameMessageProps);
