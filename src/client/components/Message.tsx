import {
  Fragment,
  memo,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  orderedMessageParts,
  type ChatMessage,
  type ChatMessagePart,
  type ToolItem,
} from "../chat/reducer";
import { ToolCard, toolPresentation } from "./ToolCard";

const TOOL_PREVIEW_LIMIT = 4;

function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

interface StreamingMarkdownParts {
  stableBlocks: string[];
  tail: string;
}

class StreamingMarkdownSplitter {
  private sourceText = "";
  private scanPosition = 0;
  private blockStart = 0;
  private fenceCharacter: "`" | "~" | undefined;
  private fenceLength = 0;
  private readonly stableBlocks: string[] = [];
  private parts: StreamingMarkdownParts = {
    stableBlocks: this.stableBlocks,
    tail: "",
  };

  update(markdown: string): StreamingMarkdownParts {
    if (markdown === this.sourceText) return this.parts;
    if (!markdown.startsWith(this.sourceText)) this.reset();

    this.sourceText = markdown;
    this.consumeCompleteLines();
    this.parts = {
      stableBlocks: this.stableBlocks,
      tail: markdown.slice(this.blockStart),
    };
    return this.parts;
  }

  private reset(): void {
    this.sourceText = "";
    this.scanPosition = 0;
    this.blockStart = 0;
    this.fenceCharacter = undefined;
    this.fenceLength = 0;
    this.stableBlocks.length = 0;
  }

  private consumeCompleteLines(): void {
    while (true) {
      const newlineIndex = this.sourceText.indexOf("\n", this.scanPosition);
      if (newlineIndex < 0) return;

      const lineEnd = newlineIndex + 1;
      const line = this.sourceText.slice(this.scanPosition, newlineIndex)
        .replace(/\r$/, "");
      this.consumeLine(line, lineEnd);
      this.scanPosition = lineEnd;
    }
  }

  private consumeLine(line: string, lineEnd: number): void {
    const openingFence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);

    if (this.fenceCharacter) {
      const closingFence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (
        closingFence
        && closingFence[1][0] === this.fenceCharacter
        && closingFence[1].length >= this.fenceLength
      ) {
        this.stableBlocks.push(this.sourceText.slice(this.blockStart, lineEnd));
        this.blockStart = lineEnd;
        this.fenceCharacter = undefined;
        this.fenceLength = 0;
      }
      return;
    }

    if (openingFence) {
      this.fenceCharacter = openingFence[1][0] as "`" | "~";
      this.fenceLength = openingFence[1].length;
      return;
    }

    if (/^\s*$/.test(line)) {
      const block = this.sourceText.slice(this.blockStart, lineEnd);
      if (block.trim()) this.stableBlocks.push(block);
      this.blockStart = lineEnd;
    }
  }
}

function useStreamingMarkdownParts(text: string): StreamingMarkdownParts {
  const splitterRef = useRef<StreamingMarkdownSplitter | null>(null);
  if (!splitterRef.current) splitterRef.current = new StreamingMarkdownSplitter();
  const splitter = splitterRef.current;
  return useMemo(() => splitter.update(text), [splitter, text]);
}

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  markdown,
}: {
  markdown: string;
}) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown]);
  return <div
    className="markdown streaming-stable"
    dangerouslySetInnerHTML={{ __html: html }}
  />;
});

function StreamingMarkdown({
  text,
  placeholder,
}: {
  text: string;
  placeholder?: string;
}) {
  const { stableBlocks, tail } = useStreamingMarkdownParts(text);
  const pendingText = tail || placeholder;

  return <div className="markdown streaming-markdown">
    {stableBlocks.map((block, index) => <StreamingMarkdownBlock
      key={`streaming-block:${index}`}
      markdown={block}
    />)}
    {pendingText ? <div className="streaming-tail">{pendingText}</div> : null}
  </div>;
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

function ThinkingPanel({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const html = useMemo(
    () => open ? renderMarkdown(text) : "",
    [open, text],
  );

  return <details className={`thinking${active ? " is-active" : ""}`} open={open}>
    <summary onClick={(event) => {
      event.preventDefault();
      setOpen((current) => !current);
    }}>
      {active
        ? <span
            className="thinking-live"
            role="status"
            aria-label="Agent 正在思考"
          >
            <span className="thinking-spinner" aria-hidden="true" />
          </span>
        : <span className="thinking-complete" aria-hidden="true">✓</span>}
      <span>{active ? "正在思考" : "思考过程"}</span>
      <span className="thinking-chevron" aria-hidden="true">⌄</span>
    </summary>
    {open && <div
      className="thinking-body markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />}
  </details>;
}

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "activity"; parts: ChatMessagePart[] };

function assistantBlocks(parts: ChatMessagePart[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const part of parts) {
    const previous = blocks[blocks.length - 1];
    if (part.kind === "text") {
      if (previous?.kind === "text") {
        previous.text = previous.text
          ? `${previous.text}\n\n${part.text}`
          : part.text;
      } else {
        blocks.push({ kind: "text", text: part.text });
      }
      continue;
    }
    if (previous?.kind === "activity") {
      previous.parts.push(part);
    } else {
      blocks.push({ kind: "activity", parts: [part] });
    }
  }
  return blocks;
}

type ActivityRun =
  | { kind: "thinking"; text: string }
  | { kind: "tools"; tools: ToolItem[] };

type ActivityTone = "active" | "complete" | "error";

interface ActivitySummary {
  tone: ActivityTone;
  label: string;
  detail: string;
}

function findLastIndex<T>(
  items: T[],
  predicate: (item: T) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function activityRuns(
  parts: ChatMessagePart[],
  tools: ToolItem[],
): ActivityRun[] {
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const runs: ActivityRun[] = [];
  for (const part of parts) {
    const previous = runs[runs.length - 1];
    if (part.kind === "thinking") {
      if (previous?.kind === "thinking") {
        previous.text = previous.text
          ? `${previous.text}\n\n${part.text}`
          : part.text;
      } else {
        runs.push({ kind: "thinking", text: part.text });
      }
      continue;
    }
    if (part.kind !== "tool") continue;
    const tool = toolsById.get(part.toolId);
    if (!tool) continue;
    if (previous?.kind === "tools") {
      previous.tools.push(tool);
    } else {
      runs.push({ kind: "tools", tools: [tool] });
    }
  }
  return runs;
}

function findLatestTool(
  runs: ActivityRun[],
  predicate: (tool: ToolItem) => boolean,
): ToolItem | undefined {
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex]!;
    if (run.kind !== "tools") continue;
    for (let toolIndex = run.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = run.tools[toolIndex]!;
      if (predicate(tool)) return tool;
    }
  }
  return undefined;
}

function thinkingPreview(text: string): string {
  const preview = text
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (preview.length <= 72) return preview;
  return `${preview.slice(0, 71)}…`;
}

function activitySummary(
  runs: ActivityRun[],
  activeThinking: boolean,
): ActivitySummary {
  const latestRun = runs.at(-1);
  const activeTool = findLatestTool(runs, (tool) => (
    tool.status === "pending" || tool.status === "running"
  ));
  if (activeTool) {
    const presentation = toolPresentation(activeTool);
    return {
      tone: "active",
      label: `正在${presentation.label}`,
      detail: presentation.target,
    };
  }
  if (activeThinking && latestRun?.kind === "thinking") {
    return {
      tone: "active",
      label: "正在思考",
      detail: thinkingPreview(latestRun.text),
    };
  }
  const failedTool = findLatestTool(runs, (tool) => tool.status === "error");
  if (failedTool) {
    const presentation = toolPresentation(failedTool);
    return {
      tone: "error",
      label: "工具执行失败",
      detail: [presentation.label, presentation.target].filter(Boolean).join(" · "),
    };
  }
  if (latestRun?.kind === "tools") {
    const latestTool = latestRun.tools.at(-1);
    if (latestTool) {
      const presentation = toolPresentation(latestTool);
      return {
        tone: "complete",
        label: `已完成${presentation.label}`,
        detail: presentation.target,
      };
    }
  }
  return {
    tone: "complete",
    label: "已完成思考",
    detail: latestRun?.kind === "thinking" ? thinkingPreview(latestRun.text) : "",
  };
}

function ActivityGroup({
  parts,
  tools,
  activeThinking,
}: {
  parts: ChatMessagePart[];
  tools: ToolItem[];
  activeThinking: boolean;
}) {
  const runs = activityRuns(parts, tools);
  const summary = activitySummary(runs, activeThinking);
  const toolCount = tools.length;
  const lastThinkingIndex = findLastIndex(
    runs,
    (run) => run.kind === "thinking",
  );
  return <details className={`assistant-activity-group is-${summary.tone}`}>
    <summary>
      <span
        className="activity-group-status"
        role={summary.tone === "active" ? "status" : undefined}
        aria-label={
          summary.tone === "active" ? "Agent 正在处理" : undefined
        }
      >
        {summary.tone === "active"
          ? <span className="thinking-spinner" aria-hidden="true" />
          : summary.tone === "error"
            ? <span aria-hidden="true">!</span>
            : <span aria-hidden="true">✓</span>}
      </span>
      <span className="activity-group-copy">
        <strong>工作过程</strong>
        <span className="activity-group-label">{summary.label}</span>
        {summary.detail && <span
          className="activity-group-detail"
          title={summary.detail}
        >
          {summary.detail}
        </span>}
      </span>
      <span className="activity-group-count">
        {runs.length} 步 · {toolCount} 次工具调用
      </span>
      <span className="activity-group-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="activity-timeline">
      {runs.map((run, index) => run.kind === "thinking"
        ? <ThinkingPanel
            key={`thinking:${index}`}
            text={run.text}
            active={activeThinking && index === lastThinkingIndex}
          />
        : <ToolsPanel key={`tools:${index}`} tools={run.tools} />)}
    </div>
  </details>;
}

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface MessageProps {
  message: ChatMessage;
  onRewind?(messageId: string, text: string): void;
  rewindDisabled?: boolean;
  rewinding?: boolean;
  activeThinking?: boolean;
  streamingText?: boolean;
  collapsed?: boolean;
}

function sameMessageProps(previous: MessageProps, next: MessageProps): boolean {
  return previous.message === next.message
    && previous.onRewind === next.onRewind
    && previous.rewindDisabled === next.rewindDisabled
    && previous.rewinding === next.rewinding
    && previous.activeThinking === next.activeThinking
    && previous.streamingText === next.streamingText
    && previous.collapsed === next.collapsed;
}

function MessageView({
  message,
  onRewind,
  rewindDisabled = false,
  rewinding = false,
  activeThinking = false,
  streamingText = false,
  collapsed = false,
}: MessageProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const isUser = message.role === "user";
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
  const actions = (message.text || rewindUserMessage) ? <div
    className={`message-actions${isUser ? "" : " assistant-message-actions"}`}
  >
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
  const blocks = assistantBlocks(orderedMessageParts(message));
  const hasActivity = blocks.some((block) => block.kind === "activity");
  if (blocks.length === 0) blocks.push({ kind: "text", text: "" });
  const lastTextIndex = findLastIndex(blocks, (block) => block.kind === "text");
  const lastActivityIndex = findLastIndex(
    blocks,
    (block) => block.kind === "activity",
  );

  function renderResponseBody(text: string, index: number): ReactNode {
    const showingStreamingText = streamingText && index === lastTextIndex;
    const body = showingStreamingText
      ? <StreamingMarkdown
          text={text}
          placeholder={hasActivity ? undefined : "…"}
        />
      : <MarkdownBlock text={text || (hasActivity ? "" : "…")} />;
    return collapsed && text ? <details className="assistant-response">
      <summary>
        <span className="assistant-response-title">回复正文</span>
        <span className="assistant-response-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="assistant-response-body">{body}</div>
    </details> : body;
  }

  return <article className="message assistant">
    {blocks.map((block, index) => block.kind === "text"
      ? <Fragment key={`text:${index}`}>
          {renderResponseBody(block.text, index)}
        </Fragment>
      : <ActivityGroup
          key={`activity:${index}`}
          parts={block.parts}
          tools={message.tools}
          activeThinking={activeThinking && index === lastActivityIndex}
        />)}
    {actions}
  </article>;
}

export const Message = memo(MessageView, sameMessageProps);
