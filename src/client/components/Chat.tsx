import {
  memo,
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
  type ConversationWindowCoverage,
  type PendingPromptAdmissionSnapshot as PendingAdmission,
  type LoopList,
  type LoopListItemStatus,
  type PublicState,
  type RoleTemplate,
  type ServiceTier,
  type ThinkingLevel,
  type TokenUsage,
} from "../../shared/protocol";
import {
  orderedMessageParts,
  type ChatItem,
  type ChatMessage,
  type ChatState,
} from "../chat/reducer";
import { THINKING_LEVEL_LABELS } from "../lib/thinking-level";
import { ActivitySpinner } from "./ActivitySpinner";
import { editBudgetRemainingFiles } from "./CommitmentCard";
import { ConversationRoleDialog } from "./ConversationRoleDialog";
import { Message } from "./Message";
import { SessionMessageCard } from "./SessionMessageCard";

const FOLLOW_COMFORT_LIMIT_PX = 96;
const FOLLOW_COMFORT_TARGET_PX = 32;
const FOLLOW_REATTACH_LIMIT_PX = 2;

const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  auto: "自动",
  default: "默认",
  flex: "弹性",
  scale: "扩展",
  priority: "快速",
};

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

const LOOP_LIST_ITEM_STATUS_LABELS: Record<LoopListItemStatus, string> = {
  pending: "待处理",
  active: "进行中",
  completed: "已完成",
};

const LOOP_LIST_ITEM_STATUS_SYMBOLS: Record<LoopListItemStatus, string> = {
  pending: "○",
  active: "•",
  completed: "✓",
};

interface ChatProps {
  chat: ChatState;
  observationSessionId: string;
  busy: boolean;
  activeRun?: PublicState["activeRun"];
  loopList?: LoopList;
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
  serviceTiers: readonly ServiceTier[];
  selectedServiceTier: ServiceTier | null;
  serviceTierBusy: boolean;
  compactionThresholdPercent: number;
  compactionThresholdBusy: boolean;
  compacting?: boolean;
  cwd: string;
  conversationContext?: {
    rootTitle: string;
    currentTitle?: string;
  };
  online: boolean;
  /** Transport is online, but focus-bound server controls may be frozen. */
  interactive?: boolean;
  conversationReady: boolean;
  historyWindow: ConversationWindowCoverage;
  draft: string;
  submitting: boolean;
  /** busy 时已接受、尚未投递的浏览器 prompt（显示为对话流中的等待中消息）。 */
  pendingAdmissions: PendingAdmission[];
  promptNotice?: string;
  onDraftChange(text: string): void;
  onSend(text: string): void;
  onAbort(): void;
  onSettings(): void;
  onThinking(level: ThinkingLevel): void;
  onServiceTier(serviceTier: ServiceTier | null): void;
  onCompactionThreshold(percent: number): boolean;
  onCompact(): void;
  onSwitchRole(roleId: string): void;
  onChangeCwd(): void;
  onOpenConversation?(conversationId: string): void;
  onRewind(messageId: string, text: string): void;
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
    }
  | ConversationCompactionMarker
  | ConversationMessageCard;

function appendParagraph(current: string, next: string): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

function mergeUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  };
}

function mergeAssistantMessages(
  left: ChatMessage,
  right: ChatMessage,
): ChatMessage {
  return {
    ...left,
    runId: right.runId,
    text: appendParagraph(left.text, right.text),
    thinking: appendParagraph(left.thinking, right.thinking),
    tools: [...left.tools, ...right.tools],
    parts: [
      ...orderedMessageParts(left),
      ...orderedMessageParts(right),
    ],
    usage: mergeUsage(left.usage, right.usage),
  };
}

function transcriptBlocks(items: ChatItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      const previous = blocks.at(-1);
      if (
        item.role === "assistant"
        && previous?.kind === "message"
        && previous.message.role === "assistant"
        && previous.message.runId === item.runId
      ) {
        previous.message = mergeAssistantMessages(previous.message, item);
        continue;
      }
      blocks.push({ kind: "message", message: item });
    } else {
      blocks.push(item);
    }
  }
  return blocks;
}

function editBudgetRemainingFilesByRun(
  blocks: TranscriptBlock[],
): Map<string, number | null> {
  const remainingByRun = new Map<string, number | null>();
  for (const block of blocks) {
    if (block.kind !== "message" || block.message.role !== "assistant") continue;
    for (const tool of block.message.tools) {
      const remainingFiles = editBudgetRemainingFiles(tool);
      if (remainingFiles !== undefined) {
        remainingByRun.set(block.message.runId, remainingFiles);
      } else if (
        (tool.name === "request_edit_budget"
          || tool.name === "edit"
          || tool.name === "write")
        && (tool.status === "done" || tool.status === "error")
      ) {
        remainingByRun.set(block.message.runId, null);
      }
    }
  }
  return remainingByRun;
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
  return chat.items.reduce<TokenUsage>((total, item) => {
    if (item.kind !== "message") return total;
    return {
      input: total.input + (item.usage?.input ?? 0),
      output: total.output + (item.usage?.output ?? 0),
      cacheRead: total.cacheRead + (item.usage?.cacheRead ?? 0),
      cacheWrite: total.cacheWrite + (item.usage?.cacheWrite ?? 0),
      total: total.total + (item.usage?.total ?? 0),
    };
  }, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  });
}

function ChatView({
  chat,
  observationSessionId,
  busy,
  activeRun,
  loopList = { items: [], armed: false },
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
  serviceTiers,
  selectedServiceTier,
  serviceTierBusy,
  compactionThresholdPercent,
  compactionThresholdBusy,
  compacting = false,
  cwd,
  conversationContext,
  online,
  interactive = true,
  conversationReady,
  historyWindow,
  draft,
  submitting,
  pendingAdmissions,
  promptNotice,
  onDraftChange,
  onSend,
  onAbort,
  onSettings,
  onThinking,
  onServiceTier,
  onCompactionThreshold,
  onCompact,
  onSwitchRole,
  onChangeCwd,
  onOpenConversation,
  onRewind,
  rewindingMessageId,
}: ChatProps) {
  const controlsEnabled = online && interactive;
  const selectedServiceTierUnavailable = selectedServiceTier !== null
    && !serviceTiers.includes(selectedServiceTier);
  const showServiceTierControl = serviceTiers.length > 0
    || selectedServiceTier !== null;
  let composerPlaceholder = "给 Pi 发送消息…";
  if (!conversationReady) composerPlaceholder = "正在恢复项目对话…";
  else if (rewindingMessageId) composerPlaceholder = "正在回到所选消息…";
  else if (compacting) composerPlaceholder = "正在压缩上下文…";
  else if (!model) composerPlaceholder = "请先登录并选择模型";
  else if (busy) composerPlaceholder = "发送后将排队等待处理…";
  const transcriptRef = useRef<HTMLElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const observedTranscriptKeyRef = useRef<string | undefined>(undefined);
  const positionedTranscriptKeyRef = useRef<string | undefined>(undefined);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [loopListExpanded, setLoopListExpanded] = useState(false);
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
  const items = chat.items;
  const blocks = useMemo(() => transcriptBlocks(items), [items]);
  const editBudgetRemainingByRun = useMemo(
    () => editBudgetRemainingFilesByRun(blocks),
    [blocks],
  );
  const transcriptFocusKey = chat.focus
    ? `${chat.focus.sessionId}:${chat.focus.conversationId}:${chat.focus.focusId}`
    : "unfocused";
  const transcriptRenderScopeKey = chat.focus
    ? `${observationSessionId}:${chat.focus.conversationId}`
    : "unfocused";
  const loopListItems = loopList.items;
  const loopListEmpty = loopListItems.length === 0;
  const completedLoopListItems = loopListItems.filter(
    (item) => item.status === "completed",
  ).length;
  const loopListCompleted = !loopListEmpty
    && completedLoopListItems === loopListItems.length;
  const remainingLoopListItems = loopListItems.length - completedLoopListItems;
  let loopListStatusKey = "paused";
  let loopListStatusLabel = "已暂停";
  if (loopListCompleted) {
    loopListStatusKey = "completed";
    loopListStatusLabel = "已完成";
  } else if (loopList.armed && busy) {
    loopListStatusKey = "executing";
    loopListStatusLabel = "执行中";
  }
  useEffect(() => {
    setLoopListExpanded(false);
  }, [transcriptFocusKey, loopListCompleted, loopListEmpty]);
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
  const handleMessageContentSettled = useCallback(() => {
    if (followOutputRef.current) followLatest();
  }, [followLatest]);
  useLayoutEffect(() => {
    if (observedTranscriptKeyRef.current !== transcriptRenderScopeKey) {
      observedTranscriptKeyRef.current = transcriptRenderScopeKey;
      positionedTranscriptKeyRef.current = undefined;
    }
    const transcriptNeedsInitialPosition = chat.focus
      && positionedTranscriptKeyRef.current !== transcriptRenderScopeKey;
    if (transcriptNeedsInitialPosition) {
      followOutputRef.current = true;
      setShowJumpToLatest(false);
      if (conversationReady || blocks.length > 0) {
        scrollToLatest();
        positionedTranscriptKeyRef.current = transcriptRenderScopeKey;
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
  }, [
    chat,
    compacting,
    conversationReady,
    followLatest,
    loopListExpanded,
    scrollToLatest,
    transcriptRenderScopeKey,
  ]);

  useLayoutEffect(() => {
    const composerWrap = composerWrapRef.current;
    const shell = composerWrap?.parentElement;
    if (!composerWrap || !shell) return;
    let followFrame: number | undefined;
    const updateInset = () => {
      shell.style.setProperty("--composer-inset", `${composerWrap.getBoundingClientRect().height}px`);
      if (!followOutputRef.current) return;
      if (followFrame !== undefined) cancelAnimationFrame(followFrame);
      followFrame = requestAnimationFrame(() => {
        followFrame = undefined;
        if (followOutputRef.current) scrollToLatest();
      });
    };
    updateInset();
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updateInset);
    observer?.observe(composerWrap);
    return () => {
      observer?.disconnect();
      if (followFrame !== undefined) cancelAnimationFrame(followFrame);
    };
  }, [scrollToLatest]);

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
    const transcript = transcriptRef.current;
    if (!transcript) return;
    followOutputRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    lastScrollTopRef.current = transcript.scrollTop;
    setShowJumpToLatest(false);
  };
  const send = () => {
    const value = draft.trim();
    if (
      !value
      || submitting
      || compacting
      || rewindingMessageId
      || !model
      || !controlsEnabled
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
  const historyNotices = [
    historyWindow.omittedBefore && !historyWindow.startsMidTurn
      ? "较早的对话记录未加载，当前仅显示最近内容。"
      : undefined,
    historyWindow.startsMidTurn
      ? "当前可见记录从一轮对话的中间开始。"
      : undefined,
    historyWindow.contentTruncated
      ? "较长消息或工具详情已缩短显示。"
      : undefined,
  ].filter((notice): notice is string => notice !== undefined);

  return <main className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={onChangeCwd}><span>π</span><span>Pi Web<small title={cwd}>{cwd}</small></span></button>
      {conversationContext && <nav
        className={`topbar-conversation-context${
          conversationContext.currentTitle ? " has-current" : ""
        }`}
        aria-label="协作路径"
      >
        <span
          className="topbar-conversation-root"
          title={conversationContext.rootTitle}
          aria-current={conversationContext.currentTitle ? undefined : "page"}
        >
          {conversationContext.rootTitle}
        </span>
        {conversationContext.currentTitle && <>
          <span className="topbar-conversation-separator" aria-hidden="true">›</span>
          <span
            className="topbar-conversation-current"
            title={conversationContext.currentTitle}
            aria-current="page"
          >
            {conversationContext.currentTitle}
          </span>
        </>}
      </nav>}
      <div className="topbar-controls">
        <button
          className="model-button"
          title="模型连接"
          disabled={!controlsEnabled}
          onClick={onSettings}
        >
          {model?.id ?? "模型连接"}<span>⌄</span>
        </button>
      </div>
    </header>
    {!online && <div className="banner">本地服务已断开，正在重连…</div>}
    {historyNotices.length > 0 && <div
      className="banner"
      role="note"
      aria-label="历史记录不完整"
    >
      {historyNotices.map((notice) => <div key={notice}>{notice}</div>)}
    </div>}
    <section
      ref={transcriptRef}
      className={`transcript${blocks.length ? " has-content" : ""}`}
      aria-live="polite"
      onScroll={handleTranscriptScroll}
      onWheel={handleTranscriptWheel}
    >
      {conversationReady && !blocks.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {blocks.map((block) => {
        if (block.kind === "compaction") return <div
          key={`${transcriptRenderScopeKey}:compaction:${block.id}`}
          className="compaction-marker"
          role="separator"
          aria-label="上下文已压缩"
        >
          <span>上下文已压缩</span>
        </div>;
        if (block.kind === "session_message") return <SessionMessageCard
          key={`${transcriptRenderScopeKey}:card:${block.cardId}`}
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
          key={`${transcriptRenderScopeKey}:message:${block.message.id}`}
          message={block.message}
          onRewind={block.message.role === "user" ? handleRewind : undefined}
          rewindDisabled={
            busy
            || submitting
            || !controlsEnabled
            || !conversationReady
            || Boolean(rewindingMessageId)
          }
          rewinding={rewindingMessageId === block.message.id}
          activeThinking={isStreamingMessage && !hasActiveTool}
          streamingText={isStreamingMessage}
          observedEditBudgetRemainingFiles={
            editBudgetRemainingByRun.get(block.message.runId)
          }
          onContentSettled={handleMessageContentSettled}
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
        <ActivitySpinner className="compaction-spinner" />
        <span className="compaction-progress-copy">
          <strong>正在压缩上下文</strong>
          <small>整理较早消息并保留关键信息…</small>
        </span>
      </div>}
    </section>
    <div className="composer-wrap" ref={composerWrapRef}>
      {showJumpToLatest && <button
        type="button"
        className="jump-latest"
        onClick={jumpToLatest}
      >
        ↓ 回到最新消息
      </button>}
      {pendingAdmissions.length > 0 && <section
        className="pending-admissions"
        aria-label="等待处理的消息"
      >
        {pendingAdmissions.map((admission) => (
          <div
            key={admission.promptId}
            className="pending-admission-item"
            role="status"
          >
            <span className="pending-admission-text">{admission.text}</span>
            <span className="pending-admission-status">等待中</span>
          </div>
        ))}
      </section>}
      {loopListItems.length > 0 && <section
        className="loop-list"
        aria-label="Tasks"
      >
        <button
          type="button"
          className="loop-list-toggle"
          aria-expanded={loopListExpanded}
          onClick={() => setLoopListExpanded((expanded) => !expanded)}
        >
          <span className="loop-list-title">Tasks</span>
          <span className={`loop-list-status ${loopListStatusKey}`}>
            {loopListStatusLabel}
          </span>
          <span className="loop-list-count">
            {completedLoopListItems}/{loopListItems.length}
            {remainingLoopListItems > 0 && ` · ${remainingLoopListItems} 项未完成`}
          </span>
          <span aria-hidden="true">{loopListExpanded ? "⌃" : "⌄"}</span>
        </button>
        {loopListExpanded && <ul className="loop-list-items">
          {loopListItems.map((item) => <li
            key={item.id}
            className={`loop-list-item ${item.status}`}
          >
            <span
              className="loop-list-item-marker"
              role="img"
              aria-label={LOOP_LIST_ITEM_STATUS_LABELS[item.status]}
            >
              {LOOP_LIST_ITEM_STATUS_SYMBOLS[item.status]}
            </span>
            <span className="loop-list-item-text">{item.text}</span>
          </li>)}
        </ul>}
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
        <textarea ref={textareaRef} aria-label="给 Pi 发送消息" value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={keyDown} placeholder={composerPlaceholder} disabled={!controlsEnabled || !conversationReady || !model || submitting || compacting || roleSwitching || Boolean(rewindingMessageId)} rows={1} />
        <div className="composer-actions">
          {busy && <button
            className="send stop"
            onClick={onAbort}
            aria-label="停止"
            disabled={!controlsEnabled || !conversationReady}
          >■</button>}
          <button className="send" onClick={send} disabled={!controlsEnabled || !conversationReady || !model || submitting || compacting || roleSwitching || Boolean(rewindingMessageId) || !draft.trim()} aria-label="发送">↑</button>
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
            disabled={!controlsEnabled || !conversationReady}
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
        {showServiceTierControl && <label className="service-tier-control">
          <span>服务</span>
          <select
            aria-label="服务层级"
            value={selectedServiceTier ?? ""}
            disabled={
              !controlsEnabled
              || !conversationReady
              || busy
              || compacting
              || serviceTierBusy
            }
            onChange={(event) => onServiceTier(
              event.target.value
                ? event.target.value as ServiceTier
                : null,
            )}
          >
            <option value="">供应商默认</option>
            {selectedServiceTierUnavailable && (
              <option value={selectedServiceTier} disabled>
                {SERVICE_TIER_LABELS[selectedServiceTier]}（不可用）
              </option>
            )}
            {serviceTiers.map((serviceTier) => <option
              key={serviceTier}
              value={serviceTier}
            >
              {SERVICE_TIER_LABELS[serviceTier]}
            </option>)}
          </select>
        </label>}
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
              disabled={!controlsEnabled || !conversationReady}
              onClick={() => setCompactionThresholdOpen((open) => !open)}
            >
              <span>自动压缩 {compactionThresholdDraft}%</span>
              <span aria-hidden="true">{compactionThresholdOpen ? "⌃" : "⌄"}</span>
            </button>
            <button
              type="button"
              className="compaction-threshold-toggle"
              aria-label="手动压缩上下文"
              disabled={!controlsEnabled || !conversationReady || busy || compacting}
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
              disabled={!controlsEnabled || !conversationReady || compactionThresholdBusy}
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

export const Chat = memo(ChatView);
