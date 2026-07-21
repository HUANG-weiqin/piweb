import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from "react";
import {
  MAX_COMPACTION_THRESHOLD_PERCENT,
  MIN_COMPACTION_THRESHOLD_PERCENT,
  type ConversationCompactionMarker,
  type ConversationMessageCard,
  type ConversationRoleSnapshot,
  type PublicState,
  type RoleTemplate,
  type ThinkingLevel,
  type TokenUsage,
} from "../../shared/protocol";
import type {
  ChatItem,
  ChatMessage,
  ChatState,
} from "../chat/reducer";
import { THINKING_LEVEL_LABELS } from "../lib/thinking-level";
import { ConversationRoleDialog } from "./ConversationRoleDialog";
import { Message } from "./Message";
import { SessionMessageCard } from "./SessionMessageCard";

type QueuedPromptStatus = "queued" | "submitting" | "attention";

const FOLLOW_COMFORT_LIMIT_PX = 96;
const FOLLOW_COMFORT_TARGET_PX = 32;
const FOLLOW_REATTACH_LIMIT_PX = 2;
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

function distanceFromBottom(transcript: HTMLElement): number {
  return Math.max(
    0,
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
  );
}

function sameChatFocus(
  left: ChatState["focus"],
  right: ChatState["focus"],
): boolean {
  return left?.sessionId === right?.sessionId
    && left?.conversationId === right?.conversationId
    && left?.focusId === right?.focusId;
}

function queuedPromptStatusLabel(status: QueuedPromptStatus): string {
  switch (status) {
    case "submitting": return "正在提交";
    case "attention": return "需要确认";
    case "queued": return "等待中";
  }
}

interface ChatProps {
  chat: ChatState;
  historyTruncated: boolean;
  busy: boolean;
  activeRun?: PublicState["activeRun"];
  sessionTokenUsage?: TokenUsage;
  contextTokenCount: number | null | undefined;
  contextWindow: number | null | undefined;
  contextPercent: number | null | undefined;
  contextSource: "measured" | "estimated" | "unknown" | undefined;
  model?: { provider: string; id: string };
  role?: ConversationRoleSnapshot;
  roles: RoleTemplate[];
  roleSwitchDisabled: boolean;
  roleSwitching: boolean;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels?: ThinkingLevel[];
  compactionThresholdPercent: number;
  compactionThresholdBusy: boolean;
  compacting?: boolean;
  cwd: string;
  online: boolean;
  conversationReady: boolean;
  draft: string;
  submitting: boolean;
  queuedPrompts: Array<{
    id: string;
    text: string;
    status: QueuedPromptStatus;
  }>;
  promptNotice?: string;
  onDraftChange(text: string): void;
  onSend(text: string): boolean;
  onRemoveQueuedPrompt(id: string): void;
  onRetryQueuedPrompt(id: string): void;
  onAbort(): void;
  onSettings(): void;
  onThinking(level: ThinkingLevel): void;
  onCompactionThreshold(percent: number): boolean;
  onCompact(): boolean;
  onSwitchRole(roleId: string): boolean;
  onChangeCwd(): void;
  onOpenConversation?(conversationId: string): void;
  onRewind(messageId: string, text: string): boolean;
  rewindingMessageId?: string;
}

function formatCompactTokens(tokens: number): string {
  const format = (value: number) => COMPACT_NUMBER_FORMAT.format(value);
  if (tokens >= 1_000_000) return `${format(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${format(tokens / 1_000)}k`;
  return Math.round(tokens).toLocaleString("zh-CN");
}

type TranscriptBlock =
  | {
      kind: "message";
      message: ChatMessage;
      sessionCards: ConversationMessageCard[];
    }
  | ConversationCompactionMarker
  | ConversationMessageCard;

function transcriptBlocks(items: ChatItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    if (item.kind === "session_message") {
      const previous = blocks.at(-1);
      if (previous?.kind === "message" && previous.message.role === "assistant") {
        previous.sessionCards.push(item);
        continue;
      }
    }
    if (item.kind === "message") {
      blocks.push({ kind: "message", message: item, sessionCards: [] });
    } else {
      blocks.push(item);
    }
  }
  return blocks;
}

function formatContextUsage({
  contextTokenCount,
  contextWindow,
  contextPercent,
  contextSource,
}: Pick<
  ChatProps,
  "contextTokenCount" | "contextWindow" | "contextPercent" | "contextSource"
>): string {
  if (contextTokenCount == null) return "未知，将在下一轮更新";
  const prefix = contextSource === "estimated" ? "估算 " : "";
  const tokens = formatCompactTokens(contextTokenCount);
  const window = contextWindow == null ? "?" : formatCompactTokens(contextWindow);
  const percent = contextPercent == null ? "" : `（${Math.round(contextPercent)}%）`;
  return `${prefix}${tokens} / ${window}${percent}`;
}

function getSessionTokenUsage(chat: ChatState, usage?: TokenUsage): TokenUsage {
  if (usage) return usage;
  const aggregate = chat.messages.reduce<TokenUsage>((total, message) => ({
    input: total.input + (message.usage?.input ?? 0),
    output: total.output + (message.usage?.output ?? 0),
    cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (message.usage?.cacheWrite ?? 0),
    total: total.total + (message.usage?.total ?? 0),
  }), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
  return {
    ...aggregate,
    total: aggregate.total || chat.sessionTokens,
  };
}

export function Chat({
  chat,
  historyTruncated,
  busy,
  activeRun,
  sessionTokenUsage,
  contextTokenCount,
  contextWindow,
  contextPercent,
  contextSource,
  model,
  role,
  roles,
  roleSwitchDisabled,
  roleSwitching,
  thinkingLevel,
  availableThinkingLevels,
  compactionThresholdPercent,
  compactionThresholdBusy,
  compacting = false,
  cwd,
  online,
  conversationReady,
  draft,
  submitting,
  queuedPrompts,
  promptNotice,
  onDraftChange,
  onSend,
  onRemoveQueuedPrompt,
  onRetryQueuedPrompt,
  onAbort,
  onSettings,
  onThinking,
  onCompactionThreshold,
  onCompact,
  onSwitchRole,
  onChangeCwd,
  onOpenConversation,
  onRewind,
  rewindingMessageId,
}: ChatProps) {
  let composerPlaceholder = "给 Pi 发送消息…";
  if (!conversationReady) composerPlaceholder = "正在恢复项目对话…";
  else if (rewindingMessageId) composerPlaceholder = "正在回到所选消息…";
  else if (compacting) composerPlaceholder = "正在压缩上下文…";
  else if (!model) composerPlaceholder = "请先登录并选择模型";
  else if (busy) composerPlaceholder = "发送后将引导当前任务…";
  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const positionedFocusRef = useRef<ChatState["focus"]>(undefined);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [roleDetailsOpen, setRoleDetailsOpen] = useState(false);
  const [compactionThresholdOpen, setCompactionThresholdOpen] = useState(false);
  const [compactionThresholdDraft, setCompactionThresholdDraft] =
    useState(compactionThresholdPercent);
  const requestedCompactionThreshold = useRef(compactionThresholdPercent);
  useEffect(() => {
    if (compactionThresholdBusy) return;
    setCompactionThresholdDraft(compactionThresholdPercent);
    requestedCompactionThreshold.current = compactionThresholdPercent;
  }, [compactionThresholdBusy, compactionThresholdPercent]);
  const contextTokenText = useMemo(() => formatContextUsage({
    contextTokenCount,
    contextWindow,
    contextPercent,
    contextSource,
  }), [contextPercent, contextSource, contextTokenCount, contextWindow]);
  const tokenUsage = useMemo(
    () => getSessionTokenUsage(chat, sessionTokenUsage),
    [chat, sessionTokenUsage],
  );
  const items = useMemo(
    () => chat.items ?? chat.messages.map((message) => ({
      kind: "message" as const,
      ...message,
    })),
    [chat.items, chat.messages],
  );
  const blocks = useMemo(() => transcriptBlocks(items), [items]);
  const activeRunId = activeRun?.id;
  const expandedAssistantMessageIds = useMemo(() => {
    const assistantMessages = blocks.flatMap((block) => (
      block.kind === "message" && block.message.role === "assistant"
        ? [block.message]
        : []
    ));
    const latestMessage = assistantMessages.at(-1);
    if (!latestMessage) return new Set<string>();

    const activeMessageIndex = activeRunId
      ? assistantMessages.findIndex((message) => message.runId === activeRunId)
      : -1;
    if (activeMessageIndex < 0) return new Set([latestMessage.id]);

    const expandedIds = new Set(
      assistantMessages
        .filter((message) => message.runId === activeRunId)
        .map((message) => message.id),
    );
    const previousMessage = assistantMessages[activeMessageIndex - 1];
    if (previousMessage) expandedIds.add(previousMessage.id);
    return expandedIds;
  }, [activeRunId, blocks]);
  const openConversationRef = useRef(onOpenConversation);
  const rewindRef = useRef(onRewind);
  useLayoutEffect(() => {
    openConversationRef.current = onOpenConversation;
    rewindRef.current = onRewind;
  }, [onOpenConversation, onRewind]);
  const handleOpenConversation = useCallback((conversationId: string) => {
    openConversationRef.current?.(conversationId);
  }, []);
  const handleRewind = useCallback((messageId: string, text: string) => {
    rewindRef.current(messageId, text);
  }, []);
  const scrollTranscript = useCallback((top: number, behavior?: ScrollBehavior) => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({
        top,
        ...(behavior ? { behavior } : {}),
      });
    } else {
      transcript.scrollTop = top;
    }
  }, []);
  const scrollToLatest = useCallback((behavior?: ScrollBehavior) => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    scrollTranscript(transcript.scrollHeight, behavior);
  }, [scrollTranscript]);
  const followLatest = useCallback(() => {
    const transcript = transcriptRef.current;
    if (
      !transcript
      || distanceFromBottom(transcript) <= FOLLOW_COMFORT_LIMIT_PX
    ) return;
    scrollTranscript(
      Math.max(
        0,
        transcript.scrollHeight
          - transcript.clientHeight
          - FOLLOW_COMFORT_TARGET_PX,
      ),
      "smooth",
    );
  }, [scrollTranscript]);
  useLayoutEffect(() => {
    const focusNeedsInitialPosition = chat.focus
      && !sameChatFocus(positionedFocusRef.current, chat.focus);
    if (focusNeedsInitialPosition) {
      followOutputRef.current = true;
      setShowJumpToLatest(false);
      if (conversationReady) {
        scrollToLatest();
        positionedFocusRef.current = chat.focus;
      }
    } else if (followOutputRef.current) {
      followLatest();
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
    if (transcriptRef.current) {
      lastScrollTopRef.current = transcriptRef.current.scrollTop;
    }
  }, [chat, compacting, conversationReady, followLatest, scrollToLatest]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 180)}px`;
  }, [draft]);
  const stopFollowingOutput = () => {
    followOutputRef.current = false;
    setShowJumpToLatest(true);
  };
  const handleTranscriptWheel = (event: WheelEvent<HTMLElement>) => {
    if (event.deltaY < 0) stopFollowingOutput();
  };
  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const scrollTop = transcript.scrollTop;
    const movedUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    if (movedUp) {
      stopFollowingOutput();
      return;
    }
    if (
      !followOutputRef.current
      && distanceFromBottom(transcript) <= FOLLOW_REATTACH_LIMIT_PX
    ) {
      followOutputRef.current = true;
      setShowJumpToLatest(false);
    }
  };
  const jumpToLatest = () => {
    followOutputRef.current = true;
    setShowJumpToLatest(false);
    scrollToLatest();
  };
  const send = () => {
    const value = draft.trim();
    if (
      !value
      || submitting
      || compacting
      || rewindingMessageId
      || !model
      || !online
      || !conversationReady
    ) return;
    onSend(value);
  };
  const commitCompactionThreshold = () => {
    if (
      compactionThresholdBusy
      || compactionThresholdDraft === requestedCompactionThreshold.current
    ) return;
    if (onCompactionThreshold(compactionThresholdDraft)) {
      requestedCompactionThreshold.current = compactionThresholdDraft;
    } else {
      setCompactionThresholdDraft(compactionThresholdPercent);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  };

  return <main className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={onChangeCwd}><span>π</span><span>Pi Web<small title={cwd}>{cwd}</small></span></button>
      <div className="topbar-controls">
        <button
          className="model-button"
          title="模型连接"
          onClick={onSettings}
        >
          {model?.id ?? "模型连接"}<span>⌄</span>
        </button>
      </div>
    </header>
    {!online && <div className="banner">本地服务已断开，正在重连…</div>}
    <section
      ref={transcriptRef}
      className={`transcript${blocks.length ? " has-content" : ""}`}
      aria-live="polite"
      onScroll={handleTranscriptScroll}
      onWheel={handleTranscriptWheel}
    >
      {historyTruncated && <div className="history-note">
        较早或过长的显示内容已省略；完整记录仍保存在项目中。
      </div>}
      {!blocks.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {blocks.map((block) => {
        if (block.kind === "compaction") return <div
          key={`compaction:${block.id}`}
          className="compaction-marker"
          role="separator"
          aria-label="上下文已压缩"
        >
          <span>上下文已压缩</span>
        </div>;
        if (block.kind === "session_message") return <SessionMessageCard
          key={`card:${block.cardId}`}
          card={block}
          onOpenConversation={handleOpenConversation}
        />;
        const isActiveMessage = activeRun?.id === block.message.runId;
        const hasActiveTool = block.message.tools.some((tool) => (
          tool.status === "pending" || tool.status === "running"
        ));
        const isStreamingMessage = isActiveMessage
          && activeRun?.phase === "running";
        return <Message
          key={`message:${block.message.id}`}
          message={block.message}
          sessionCards={block.sessionCards}
          onOpenConversation={handleOpenConversation}
          onRewind={block.message.role === "user" ? handleRewind : undefined}
          rewindDisabled={
            busy
            || submitting
            || !online
            || !conversationReady
            || Boolean(rewindingMessageId)
          }
          rewinding={rewindingMessageId === block.message.id}
          activeThinking={isStreamingMessage && !hasActiveTool}
          streamingText={isStreamingMessage}
          collapsed={
            block.message.role === "assistant"
            && !expandedAssistantMessageIds.has(block.message.id)
          }
        />;
      })}
      {compacting && <div
        className="compaction-progress"
        role="status"
        aria-label="正在压缩上下文"
      >
        <span className="compaction-spinner" aria-hidden="true" />
        <span className="compaction-progress-copy">
          <strong>正在压缩上下文</strong>
          <small>整理较早消息并保留关键信息…</small>
        </span>
      </div>}
    </section>
    <div className="composer-wrap">
      {showJumpToLatest && <button
        type="button"
        className="jump-latest"
        onClick={jumpToLatest}
      >
        ↓ 回到最新消息
      </button>}
      {queuedPrompts.length > 0 && <section
        className="prompt-queue"
        aria-label="待发送消息"
      >
        <header>
          <span>接下来处理 {queuedPrompts.length} 条</span>
          <small>可接收时合并为一次引导</small>
        </header>
        <ol>
          {queuedPrompts.map((prompt) => <li
            key={prompt.id}
            className={`prompt-queue-item ${prompt.status}`}
          >
            <span className="prompt-queue-text" title={prompt.text}>
              {prompt.text}
            </span>
            <span className="prompt-queue-status">
              {queuedPromptStatusLabel(prompt.status)}
            </span>
            <span className="prompt-queue-actions">
              {prompt.status === "attention" && <button
                type="button"
                aria-label={`重试排队消息 ${prompt.text}`}
                onClick={() => onRetryQueuedPrompt(prompt.id)}
              >
                重试
              </button>}
              <button
                type="button"
                aria-label={`移除排队消息 ${prompt.text}`}
                disabled={prompt.status === "submitting"}
                onClick={() => onRemoveQueuedPrompt(prompt.id)}
              >
                ×
              </button>
            </span>
          </li>)}
        </ol>
      </section>}
      {submitting && !promptNotice && <div
        className="composer-notice pending"
        role="status"
      >
        正在确认服务端已接收…
      </div>}
      {rewindingMessageId && <div
        className="composer-notice pending"
        role="status"
      >
        正在彻底删除所选消息及之后的内容…
      </div>}
      {promptNotice && <div className="composer-notice" role="alert">{promptNotice}</div>}
      <div className="composer">
        <textarea ref={textareaRef} aria-label="给 Pi 发送消息" value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={keyDown} placeholder={composerPlaceholder} disabled={!online || !conversationReady || !model || submitting || compacting || roleSwitching || Boolean(rewindingMessageId)} rows={1} />
        <div className="composer-actions">
          {busy && <button
            className="send stop"
            onClick={onAbort}
            aria-label="停止"
            disabled={!online || !conversationReady}
          >■</button>}
          <button className="send" onClick={send} disabled={!online || !conversationReady || !model || submitting || compacting || roleSwitching || Boolean(rewindingMessageId) || !draft.trim()} aria-label="发送">↑</button>
        </div>
      </div>
      <div className="composer-meta">
        {role && <button
          type="button"
          className="conversation-role-pill"
          aria-label={`查看会话角色 ${role.name}`}
          onClick={() => setRoleDetailsOpen(true)}
        >
          <span>{role.name}</span>
          <small>{role.model.id}</small>
        </button>}
        <label className="thinking-level-control">
          <span>思考</span>
          <select
            aria-label="思考级别"
            value={thinkingLevel}
            disabled={!online}
            onChange={(event) =>
              onThinking(event.target.value as ThinkingLevel)}
          >
            {(availableThinkingLevels ?? [thinkingLevel]).map((level) => (
              <option key={level} value={level}>
                {THINKING_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
        </label>
        <div
          className="context-management"
          role="group"
          aria-label="上下文管理"
        >
          <div className="context-management-actions">
            <small
              className="session-stats context-stat"
              tabIndex={0}
              aria-describedby="token-usage-tooltip"
            >
              <span className="context-summary">上下文：{contextTokenText}</span>
              <span className="token-tooltip" id="token-usage-tooltip" role="tooltip">
                <span>上下文：{contextTokenText}</span>
                <span>累计处理：{formatCompactTokens(tokenUsage.total)}</span>
                <span>普通输入：{formatCompactTokens(tokenUsage.input)}</span>
                <span>缓存读取：{formatCompactTokens(tokenUsage.cacheRead)}</span>
                {tokenUsage.cacheWrite > 0 && (
                  <span>缓存写入：{formatCompactTokens(tokenUsage.cacheWrite)}</span>
                )}
                <span>输出：{formatCompactTokens(tokenUsage.output)}</span>
              </span>
            </small>
            <button
              type="button"
              className="compaction-threshold-toggle"
              aria-expanded={compactionThresholdOpen}
              aria-controls="compaction-threshold-panel"
              title={`上下文达到 ${compactionThresholdDraft}% 时自动压缩`}
              onClick={() => setCompactionThresholdOpen((open) => !open)}
            >
              <span>自动压缩 {compactionThresholdDraft}%</span>
              <span aria-hidden="true">{compactionThresholdOpen ? "⌃" : "⌄"}</span>
            </button>
            <button
              type="button"
              className="compaction-threshold-toggle"
              aria-label="手动压缩上下文"
              disabled={!online || !conversationReady || busy || compacting}
              onClick={onCompact}
            >
              {compacting ? "正在压缩…" : "手动压缩"}
            </button>
          </div>
          {compactionThresholdOpen && <label
            id="compaction-threshold-panel"
            className="compaction-threshold-control"
            title={`上下文达到 ${compactionThresholdDraft}% 时自动压缩`}
          >
            <span>自动压缩阈值</span>
            <input
              type="range"
              aria-label="会话自动压缩阈值"
              min={MIN_COMPACTION_THRESHOLD_PERCENT}
              max={MAX_COMPACTION_THRESHOLD_PERCENT}
              step={1}
              value={compactionThresholdDraft}
              disabled={!online || !conversationReady || compactionThresholdBusy}
              onChange={(event) =>
                setCompactionThresholdDraft(Number(event.target.value))}
              onPointerUp={commitCompactionThreshold}
              onKeyUp={commitCompactionThreshold}
              onBlur={commitCompactionThreshold}
            />
            <span className="compaction-threshold-value">
              {compactionThresholdDraft}%
            </span>
          </label>}
        </div>
        <small className="composer-tip">Enter 发送 · Shift+Enter 换行 · 对话随项目自动保存</small>
      </div>
    </div>
    {role && <ConversationRoleDialog
      open={roleDetailsOpen}
      role={role}
      roles={roles}
      switchDisabled={roleSwitchDisabled}
      switching={roleSwitching}
      onSwitch={onSwitchRole}
      onClose={() => setRoleDetailsOpen(false)}
    />}
  </main>;
}
