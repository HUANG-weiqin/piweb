import {
  Fragment,
  memo,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  orderedMessageParts,
  type ChatMessage,
  type ChatMessagePart,
  type ToolItem,
} from "../chat/reducer";
import type { ConversationTitleLookup } from "../lib/conversation-display";
import { ActivitySpinner } from "./ActivitySpinner";
import { CommitmentCard, isCommitmentTool } from "./CommitmentCard";
import {
  getMermaidSourceAnalysis,
  MarkdownContent,
  MERMAID_MAX_BLOCKS_PER_CONTENT,
  MERMAID_MAX_TOTAL_SOURCE_LENGTH,
} from "./MarkdownContent";
import { ToolCard, toolPresentation } from "./ToolCard";

const TOOL_PREVIEW_LIMIT = 4;
const ACTIVITY_TIMELINE_LIMIT = 16;
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

type MermaidSourceAnalysis = ReturnType<typeof getMermaidSourceAnalysis>;

function getCachedMermaidAnalysis(
  cache: Map<string, MermaidSourceAnalysis>,
  text: string,
): MermaidSourceAnalysis {
  const cached = cache.get(text);
  if (cached) return cached;
  const analysis = getMermaidSourceAnalysis(text);
  if (cache.size >= 16) cache.clear();
  cache.set(text, analysis);
  return analysis;
}

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  markdown,
  renderMermaid,
  mermaidMaxBlocks,
  mermaidMaxTotalSourceLength,
  onRenderSettled,
}: {
  markdown: string;
  renderMermaid: boolean;
  mermaidMaxBlocks: number;
  mermaidMaxTotalSourceLength: number;
  onRenderSettled?(): void;
}) {
  return <MarkdownContent
    className="markdown streaming-stable"
    markdown={markdown}
    renderMermaid={renderMermaid}
    mermaidMaxBlocks={mermaidMaxBlocks}
    mermaidMaxTotalSourceLength={mermaidMaxTotalSourceLength}
    onRenderSettled={onRenderSettled}
  />;
});

function StreamingMarkdown({
  text,
  placeholder,
  renderMermaid,
  mermaidMaxBlocks,
  mermaidMaxTotalSourceLength,
  onRenderSettled,
}: {
  text: string;
  placeholder?: string;
  renderMermaid: boolean;
  mermaidMaxBlocks: number;
  mermaidMaxTotalSourceLength: number;
  onRenderSettled?(): void;
}) {
  const { stableBlocks, tail } = useStreamingMarkdownParts(text);
  const analysisCacheRef = useRef(new Map<
    string,
    ReturnType<typeof getMermaidSourceAnalysis>
  >());
  const pendingText = tail || placeholder;
  let mermaidBlockCount = 0;
  let mermaidSourceLength = 0;

  return <div className="markdown streaming-markdown">
    {stableBlocks.map((block, index) => {
      const analysis = renderMermaid
        ? getCachedMermaidAnalysis(analysisCacheRef.current, block)
        : undefined;
      const mermaidMaxBlocksForBlock = Math.max(
        0,
        mermaidMaxBlocks - mermaidBlockCount,
      );
      const mermaidMaxSourceLengthForBlock = Math.max(
        0,
        mermaidMaxTotalSourceLength - mermaidSourceLength,
      );
      for (const sourceLength of analysis?.sourceLengths ?? []) {
        if (
          mermaidBlockCount >= mermaidMaxBlocks
          || mermaidSourceLength + sourceLength > mermaidMaxTotalSourceLength
        ) continue;
        mermaidBlockCount += 1;
        mermaidSourceLength += sourceLength;
      }
      return <StreamingMarkdownBlock
        key={`streaming-block:${index}`}
        markdown={block}
        renderMermaid={renderMermaid && !!analysis?.hasMermaidFence}
        mermaidMaxBlocks={mermaidMaxBlocksForBlock}
        mermaidMaxTotalSourceLength={mermaidMaxSourceLengthForBlock}
        onRenderSettled={onRenderSettled}
      />;
    })}
    {pendingText ? <div className="streaming-tail">{pendingText}</div> : null}
  </div>;
}

function ToolsPanel({
  tools,
  conversationTitleLookup,
}: {
  tools: ChatMessage["tools"];
  conversationTitleLookup?: ConversationTitleLookup;
}) {
  const [showAllTools, setShowAllTools] = useState(false);
  const hasOverflow = tools.length > TOOL_PREVIEW_LIMIT;
  const recentTools = tools.slice(-ACTIVITY_TIMELINE_LIMIT);
  const visibleTools = showAllTools
    ? recentTools
    : recentTools.slice(-TOOL_PREVIEW_LIMIT);
  const hiddenToolsCount = tools.length - visibleTools.length;
  const expandLabel = tools.length > ACTIVITY_TIMELINE_LIMIT
    ? `展开最近 ${ACTIVITY_TIMELINE_LIMIT} 条`
    : `展开全部 ${tools.length} 条`;

  return <details className="tools">
    <summary>
      <span className="tools-title">工具调用（{Math.min(tools.length, ACTIVITY_TIMELINE_LIMIT)}）</span>
      <span className="tools-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="tool-stack">
      {!!hiddenToolsCount && <p className="tool-stack-note">已折叠 {hiddenToolsCount} 条更早工具调用</p>}
      {visibleTools.slice().reverse().map((tool) => <ToolCard
        key={tool.id}
        tool={tool}
        conversationTitleLookup={conversationTitleLookup}
      />)}
      {hasOverflow ? <button className="ghost tool-toggle" type="button" onClick={() => setShowAllTools((current) => !current)}>{showAllTools ? `收起到最近 ${TOOL_PREVIEW_LIMIT} 条` : expandLabel}</button> : null}
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
            <ActivitySpinner className="thinking-spinner" />
          </span>
        : <span className="thinking-complete" aria-hidden="true">✓</span>}
      <span>{active ? "正在思考" : "思考过程"}</span>
      <span className="thinking-chevron" aria-hidden="true">⌄</span>
    </summary>
    {open && <MarkdownContent
      className="thinking-body markdown"
      markdown={text}
    />}
  </details>;
}

type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "activity"; parts: ChatMessagePart[] }
  | { kind: "commitment"; tool: ToolItem };

function assistantBlocks(
  parts: ChatMessagePart[],
  tools: ToolItem[],
): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
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
    if (part.kind === "tool") {
      const tool = toolsById.get(part.toolId);
      if (tool && isCommitmentTool(tool)) {
        blocks.push({ kind: "commitment", tool });
        continue;
      }
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
  conversationTitleLookup?: ConversationTitleLookup,
): ActivitySummary {
  const latestRun = runs.at(-1);
  const activeTool = findLatestTool(runs, (tool) => (
    tool.status === "pending" || tool.status === "running"
  ));
  if (activeTool) {
    const presentation = toolPresentation(activeTool, conversationTitleLookup);
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
  if (latestRun?.kind === "tools") {
    const latestTool = latestRun.tools.at(-1);
    if (latestTool) {
      const presentation = toolPresentation(latestTool, conversationTitleLookup);
      if (latestTool.status === "error") {
        return {
          tone: "error",
          label: "工具执行失败",
          detail: [presentation.label, presentation.target].filter(Boolean).join(" · "),
        };
      }
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
  conversationTitleLookup,
}: {
  parts: ChatMessagePart[];
  tools: ToolItem[];
  activeThinking: boolean;
  conversationTitleLookup?: ConversationTitleLookup;
}) {
  const runs = activityRuns(parts, tools);
  const summary = activitySummary(
    runs,
    activeThinking,
    conversationTitleLookup,
  );
  const lastThinkingIndex = findLastIndex(
    runs,
    (run) => run.kind === "thinking",
  );
  const latestThinking = lastThinkingIndex >= 0
    ? runs[lastThinkingIndex]
    : undefined;
  const visibleRuns = runs
    .slice(-ACTIVITY_TIMELINE_LIMIT)
    .reverse();
  const visibleToolCount = visibleRuns.reduce(
    (count, run) => count + (
      run.kind === "tools"
        ? Math.min(run.tools.length, ACTIVITY_TIMELINE_LIMIT)
        : 0
    ),
    0,
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
          ? <ActivitySpinner className="thinking-spinner" />
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
        {visibleRuns.length} 步 · {visibleToolCount} 次工具调用
      </span>
      <span className="activity-group-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="activity-timeline">
      {visibleRuns.map((run, index) => run.kind === "thinking"
        ? <ThinkingPanel
            key={`thinking:${index}`}
            text={run.text}
            active={activeThinking && run === latestThinking}
          />
        : <ToolsPanel
            key={`tools:${index}`}
            tools={run.tools}
            conversationTitleLookup={conversationTitleLookup}
          />)}
    </div>
  </details>;
}

const MarkdownBlock = memo(function MarkdownBlock({
  text,
  renderMermaid,
  mermaidMaxBlocks,
  mermaidMaxTotalSourceLength,
  onRenderSettled,
}: {
  text: string;
  renderMermaid: boolean;
  mermaidMaxBlocks: number;
  mermaidMaxTotalSourceLength: number;
  onRenderSettled?(): void;
}) {
  return <MarkdownContent
    className="markdown"
    markdown={text}
    renderMermaid={renderMermaid}
    mermaidMaxBlocks={mermaidMaxBlocks}
    mermaidMaxTotalSourceLength={mermaidMaxTotalSourceLength}
    onRenderSettled={onRenderSettled}
  />;
});

interface MessageProps {
  message: ChatMessage;
  onRewind?(messageId: string, text: string): void;
  rewindDisabled?: boolean;
  rewinding?: boolean;
  activeThinking?: boolean;
  streamingText?: boolean;
  collapsed?: boolean;
  observedEditBudgetRemainingFiles?: number | null;
  assistantActor?: string;
  assistantState?: string;
  conversationTitleLookup?: ConversationTitleLookup;
  onContentSettled?(): void;
}

function MessageView({
  message,
  onRewind,
  rewindDisabled = false,
  rewinding = false,
  activeThinking = false,
  streamingText = false,
  collapsed = false,
  observedEditBudgetRemainingFiles,
  assistantActor,
  assistantState,
  conversationTitleLookup,
  onContentSettled,
}: MessageProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [enhancedResponseIndexes, setEnhancedResponseIndexes] = useState(
    () => new Set<number>(),
  );
  const mermaidSourceCacheRef = useRef(new Map<
    string,
    ReturnType<typeof getMermaidSourceAnalysis>
  >());

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
  const messageRunning = !isUser && assistantState !== undefined;
  const eventHeader = <header
    className={`message-event-header${messageRunning ? " is-running" : ""}`}
  >
    <span className="message-event-kind">{isUser ? "COMMAND" : "AGENT"}</span>
    <strong className="message-event-actor">
      {isUser ? "USER" : assistantActor?.trim() || "Agent"}
    </strong>
    <span className="message-event-state">
      {isUser ? "SENT" : assistantState ?? "LOGGED"}
    </span>
  </header>;
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
      {eventHeader}
      {message.text}
      {actions}
    </article>;
  }
  const blocks = assistantBlocks(orderedMessageParts(message), message.tools);
  const hasActivity = blocks.some((block) => block.kind === "activity");
  if (blocks.length === 0) blocks.push({ kind: "text", text: "" });
  const lastTextIndex = findLastIndex(blocks, (block) => block.kind === "text");
  const lastActivityIndex = findLastIndex(
    blocks,
    (block) => block.kind === "activity",
  );
  let remainingMermaidBlocks = MERMAID_MAX_BLOCKS_PER_CONTENT;
  let remainingMermaidSourceLength = MERMAID_MAX_TOTAL_SOURCE_LENGTH;

  function renderResponseBody(text: string, index: number): ReactNode {
    const showingStreamingText = streamingText && index === lastTextIndex;
    const renderMermaid = !collapsed || enhancedResponseIndexes.has(index);
    const mermaidMaxBlocks = remainingMermaidBlocks;
    const mermaidMaxTotalSourceLength = remainingMermaidSourceLength;
    if (!showingStreamingText) {
      let usedBlocks = 0;
      let usedSourceLength = 0;
      for (const sourceLength of getCachedMermaidAnalysis(
        mermaidSourceCacheRef.current,
        text,
      ).sourceLengths) {
        if (
          usedBlocks >= mermaidMaxBlocks
          || usedSourceLength + sourceLength > mermaidMaxTotalSourceLength
        ) continue;
        usedBlocks += 1;
        usedSourceLength += sourceLength;
      }
      remainingMermaidBlocks -= usedBlocks;
      remainingMermaidSourceLength -= usedSourceLength;
    }
    const body = showingStreamingText
      ? <StreamingMarkdown
          text={text}
          placeholder={hasActivity ? undefined : "…"}
          renderMermaid={renderMermaid}
          mermaidMaxBlocks={mermaidMaxBlocks}
          mermaidMaxTotalSourceLength={mermaidMaxTotalSourceLength}
          onRenderSettled={onContentSettled}
        />
      : <MarkdownBlock
          text={text || (hasActivity ? "" : "…")}
          renderMermaid={renderMermaid}
          mermaidMaxBlocks={mermaidMaxBlocks}
          mermaidMaxTotalSourceLength={mermaidMaxTotalSourceLength}
          onRenderSettled={onContentSettled}
        />;
    return collapsed && text ? <details
      className="assistant-response"
      onToggle={(event) => {
        if (!event.currentTarget.open || enhancedResponseIndexes.has(index)) return;
        setEnhancedResponseIndexes((current) => {
          const next = new Set(current);
          next.add(index);
          return next;
        });
      }}
    >
      <summary>
        <span className="assistant-response-title">回复正文</span>
        <span className="assistant-response-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="assistant-response-body">{body}</div>
    </details> : body;
  }

  return <article className="message assistant">
    {eventHeader}
    {blocks.map((block, index) => {
      if (block.kind === "text") {
        return <Fragment key={`text:${index}`}>
          {renderResponseBody(block.text, index)}
        </Fragment>;
      }
      if (block.kind === "commitment") {
        return <CommitmentCard
          key={`commitment:${block.tool.id}`}
          tool={block.tool}
          observedEditBudgetRemainingFiles={observedEditBudgetRemainingFiles}
        />;
      }
      return <ActivityGroup
        key={`activity:${index}`}
        parts={block.parts}
        tools={message.tools}
        activeThinking={activeThinking && index === lastActivityIndex}
        conversationTitleLookup={conversationTitleLookup}
      />;
    })}
    {actions}
  </article>;
}

export const Message = memo(MessageView);
