import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type WheelEvent,
} from "react";
import {
  decodedPromptImageBytes,
  MAX_COMPACTION_THRESHOLD_PERCENT,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_COUNT,
  MIN_COMPACTION_THRESHOLD_PERCENT,
  promptImageMimeType,
  type ConversationCompactionMarker,
  type ConversationImageLocator,
  type ConversationRoleSnapshot,
  type PendingPromptAdmissionSnapshot as PendingAdmission,
  type LoopList,
  type LoopListItemStatus,
  type PublicState,
  type PromptImage,
  type RoleTemplate,
  type ServiceTier,
  type ThinkingLevel,
  type TokenUsage,
} from "../../shared/protocol";
import { type ChatState } from "../chat/reducer";
import {
  projectTranscriptBlocks,
  type TranscriptBlock,
} from "../chat/transcript-blocks";
import type { ConversationTitleLookup } from "../lib/conversation-display";
import { THINKING_LEVEL_LABELS } from "../lib/thinking-level";
import { useModalFocus } from "../lib/use-modal-focus";
import { ActivitySpinner } from "./ActivitySpinner";
import { BashTaskNotificationCard } from "./BashTaskNotificationCard";
import { editBudgetRemainingFiles } from "./CommitmentCard";
import { ConversationRoleDialog } from "./ConversationRoleDialog";
import { Message } from "./Message";
import { RetainedInputs, type RetainedPromptInput } from "./RetainedInputs";
import {
  MissionCommandSurface,
  type MissionCommandStatus,
} from "./MissionCommandSurface";
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
const TIMELINE_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function modelIdentityLabel(model: { provider: string; id: string }): string {
  return `${model.provider} / ${model.id}`;
}

function compactionPolicyLabel(
  policy: "follow_primary" | "explicit",
): string {
  return policy === "follow_primary" ? "跟随角色模型" : "专用配置";
}

function compactionMarkerLabel(
  provenance: ConversationCompactionMarker["provenance"],
): string {
  if (provenance === undefined) return "模型未记录";
  if (provenance.generator === "custom") {
    return "自定义摘要 · 模型归因未记录";
  }
  return `Pi 默认摘要 · 请求目标：${
    modelIdentityLabel(provenance.requestTarget)
  } · ${compactionPolicyLabel(provenance.policy)}`;
}

function liveCompactionAttemptLabel(
  attempt: NonNullable<PublicState["compactionAttempt"]>,
): string {
  return `Pi 默认摘要请求管线目标：${
    modelIdentityLabel(attempt.requestTarget)
  } · ${compactionPolicyLabel(attempt.policy)}`;
}

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
  roleSwitchFocusKey?: string;
  roleDialogCovered?: boolean;
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
  compactionAttempt?: PublicState["compactionAttempt"];
  cwd: string;
  conversationContext?: {
    rootTitle: string;
    currentTitle?: string;
    ordinal?: number;
    agentCount?: number;
  };
  conversationTitleLookup?: ConversationTitleLookup;
  mobile?: {
    active?: boolean;
    title: string;
    onBack(): void;
  };
  online: boolean;
  /** Transport is online, but focus-bound server controls may be frozen. */
  interactive?: boolean;
  conversationReady: boolean;
  draft: string;
  draftImages: PromptImage[];
  /** A frozen conversation scope may accept local draft edits before send authority returns. */
  draftEditable: boolean;
  draftScopeKey?: string;
  submitting: boolean;
  /** busy 时已接受、尚未投递的浏览器 prompt（显示为对话流中的等待中消息）。 */
  pendingAdmissions: PendingAdmission[];
  retainedInputs: RetainedPromptInput[];
  retainedInputScopeKey?: string;
  canRestoreRetainedInput: boolean;
  onRestoreRetainedInput(key: string): void;
  onDiscardRetainedInput(key: string): void;
  withdrawingPromptId?: string;
  onWithdrawPrompt(promptId: string): void;
  promptNotice?: string;
  onDraftChange(text: string): void;
  onImagesChange(images: PromptImage[]): void;
  onSend(text: string, images: PromptImage[]): void;
  onAbort(): void;
  stopping?: boolean;
  onSettings(resolveReturnFocus?: () => HTMLElement | null): void;
  onThinking(level: ThinkingLevel): void;
  onServiceTier(serviceTier: ServiceTier | null): void;
  onCompactionThreshold(percent: number): boolean;
  onCompact(): void;
  onSwitchRole(roleId: string, focusKey: string): void;
  onChangeCwd(): void;
  onOpenConversation?(conversationId: string): void;
  onBlockingModalChange?(blocking: boolean): void;
  onOpenImage?(source: ConversationImageLocator): void;
  onRewind(messageId: string, text: string): void;
  rewindingMessageId?: string;
}

function formatCompactTokens(tokens: number): string {
  const format = (value: number) => COMPACT_NUMBER_FORMAT.format(value);
  if (tokens >= 1_000_000) return `${format(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${format(tokens / 1_000)}k`;
  return Math.round(tokens).toLocaleString("zh-CN");
}

function formatTimelineTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? timestamp
    : TIMELINE_TIME_FORMAT.format(date);
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

function readImage(file: File, mimeType: PromptImage["mimeType"]): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("无法读取图片"));
        return;
      }
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("图片编码无效"));
        return;
      }
      resolve({ mimeType, data: result.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
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
  roleSwitchFocusKey,
  roleDialogCovered,
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
  compactionAttempt,
  cwd,
  conversationContext,
  conversationTitleLookup,
  mobile,
  online,
  interactive = true,
  conversationReady,
  draft,
  draftImages,
  draftEditable,
  draftScopeKey,
  submitting,
  pendingAdmissions,
  retainedInputs,
  retainedInputScopeKey,
  canRestoreRetainedInput,
  onRestoreRetainedInput,
  onDiscardRetainedInput,
  withdrawingPromptId,
  onWithdrawPrompt,
  promptNotice,
  onDraftChange,
  onImagesChange,
  onSend,
  onAbort,
  stopping = false,
  onSettings,
  onThinking,
  onServiceTier,
  onCompactionThreshold,
  onCompact,
  onSwitchRole,
  onChangeCwd,
  onOpenConversation,
  onBlockingModalChange,
  onOpenImage,
  onRewind,
  rewindingMessageId,
}: ChatProps) {
  const mobileEnabled = mobile !== undefined;
  const mobileActive = mobile?.active ?? mobileEnabled;
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
  let conversationStatus = "IDLE";
  if (compacting) conversationStatus = "COMPACTING";
  else if (activeRun?.phase === "running") conversationStatus = "IN PROGRESS";
  else if (activeRun?.phase === "queued") conversationStatus = "QUEUED";
  else if (activeRun?.phase === "waiting") conversationStatus = "WAITING";
  else if (activeRun?.phase === "cancelling") conversationStatus = "CANCELLING";
  else if (busy) conversationStatus = "ACTIVE";
  const conversationStatusClass = `status-${conversationStatus.toLowerCase().replace(" ", "-")}`;
  const transcriptRef = useRef<HTMLElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mobileSettingsLauncherRef = useRef<HTMLButtonElement>(null);
  const desktopSettingsLauncherRef = useRef<HTMLButtonElement>(null);
  const resolveSettingsLauncher = useCallback(
    () => mobileSettingsLauncherRef.current ?? desktopSettingsLauncherRef.current,
    [],
  );
  const [attachmentError, setAttachmentError] = useState("");
  const attachmentScope = draftScopeKey
    ? `draft:${observationSessionId}:${draftScopeKey}`
    : chat.focus
    ? `${observationSessionId}:${chat.focus.sessionId}:${chat.focus.conversationId}:${chat.focus.focusId}`
    : `unfocused:${observationSessionId}`;
  const attachmentScopeRef = useRef(attachmentScope);
  const attachmentReadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const draftImagesRef = useRef(draftImages);
  const onImagesChangeRef = useRef(onImagesChange);
  const followOutputRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  const observedTranscriptKeyRef = useRef<string | undefined>(undefined);
  const positionedTranscriptKeyRef = useRef<string | undefined>(undefined);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [loopListExpanded, setLoopListExpanded] = useState(false);
  const [roleDetailsOpen, setRoleDetailsOpen] = useState(false);
  const [compactionThresholdOpen, setCompactionThresholdOpen] = useState(false);
  const [mobileSheet, setMobileSheet] = useState<"tasks" | "pending" | "controls" | "retained">();
  const visibleMobileSheet = mobileActive
    && (conversationReady || (mobileSheet === "retained" && retainedInputs.length > 0))
    ? mobileSheet
    : undefined;
  const closeMobileSheet = useCallback(() => setMobileSheet(undefined), []);
  const mobileSheetFocusRef = useModalFocus<HTMLDivElement>(
    visibleMobileSheet !== undefined,
    visibleMobileSheet ?? "",
    closeMobileSheet,
    composerWrapRef,
  );
  const [compactionThresholdDraft, setCompactionThresholdDraft] =
    useState(compactionThresholdPercent);
  const requestedCompactionThreshold = useRef(compactionThresholdPercent);
  useEffect(() => {
    if (compactionThresholdBusy) return;
    setCompactionThresholdDraft(compactionThresholdPercent);
    requestedCompactionThreshold.current = compactionThresholdPercent;
  }, [compactionThresholdBusy, compactionThresholdPercent]);
  useLayoutEffect(() => {
    if (attachmentScopeRef.current !== attachmentScope) {
      attachmentScopeRef.current = attachmentScope;
      attachmentReadQueueRef.current = Promise.resolve();
      setAttachmentError("");
    }
    draftImagesRef.current = draftImages;
    onImagesChangeRef.current = onImagesChange;
  }, [attachmentScope, draftImages, onImagesChange]);
  useLayoutEffect(() => () => {
    attachmentScopeRef.current = "";
  }, []);
  const contextTokenText = useMemo(() => formatContextUsage({
    contextTokenCount,
    contextWindow,
    contextPercent,
    contextSource,
  }), [contextPercent, contextSource, contextTokenCount, contextWindow]);
  const outputTokensPerSecond = chat.liveOutputRate?.tokensPerSecond
    ?? chat.completedOutputRate?.tokensPerSecond;
  const outputRateEstimated = chat.liveOutputRate !== undefined;
  const tokenUsage = useMemo(
    () => getSessionTokenUsage(chat, sessionTokenUsage),
    [chat, sessionTokenUsage],
  );
  const items = chat.items;
  const blocks = useMemo(() => projectTranscriptBlocks(items), [items]);
  const historyWindow = chat.historyWindow;
  const historyWindowIncomplete = Boolean(
    historyWindow?.omittedBefore
    || historyWindow?.startsMidTurn
    || historyWindow?.contentTruncated,
  );
  const activeAssistantMessageId = useMemo(() => {
    if (!activeRun) return undefined;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (
        block?.kind === "message"
        && block.message.role === "assistant"
        && block.message.runId === activeRun.id
      ) return block.message.id;
    }
    return undefined;
  }, [activeRun, blocks]);
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
  const bashActivity = chat.bashActivity;
  const showBashActivity = Boolean(
    conversationReady
    && chat.focus
    && bashActivity
    && (
      bashActivity.running > 0
      || bashActivity.stopping > 0
      || bashActivity.cleanupUnknown
    ),
  );
  const loopListEmpty = loopListItems.length === 0;
  const completedLoopListItems = loopListItems.filter(
    (item) => item.status === "completed",
  ).length;
  const loopListCompleted = !loopListEmpty
    && completedLoopListItems === loopListItems.length;
  const remainingLoopListItems = loopListItems.length - completedLoopListItems;
  let loopListStatusKey: MissionCommandStatus = "paused";
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
  useEffect(() => {
    closeMobileSheet();
  }, [closeMobileSheet, observationSessionId, transcriptFocusKey]);
  useEffect(() => {
    if ((!conversationReady && mobileSheet !== "retained") || !mobileActive) closeMobileSheet();
    if (!mobileActive) setRoleDetailsOpen(false);
  }, [closeMobileSheet, conversationReady, mobileActive, mobileSheet]);
  useEffect(() => {
    onBlockingModalChange?.(roleDetailsOpen);
    return () => onBlockingModalChange?.(false);
  }, [onBlockingModalChange, roleDetailsOpen]);
  useEffect(() => {
    if (
      (mobileSheet === "tasks" && loopListEmpty)
      || (mobileSheet === "pending" && pendingAdmissions.length === 0)
      || (mobileSheet === "retained" && retainedInputs.length === 0)
    ) closeMobileSheet();
  }, [closeMobileSheet, loopListEmpty, mobileSheet, pendingAdmissions.length, retainedInputs.length]);
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
  const addImages = (files: File[]): Promise<void> => {
    const scope = attachmentScopeRef.current;
    const queued = attachmentReadQueueRef.current.then(async () => {
      if (scope !== attachmentScopeRef.current) return;
      const accepted = files.flatMap((file) => {
        const mimeType = promptImageMimeType(file.type);
        return mimeType === undefined ? [] : [{ file, mimeType }];
      });
      if (accepted.length === 0) {
        setAttachmentError("只支持 PNG、JPEG、WebP 或 GIF 图片。");
        return;
      }
      if (accepted.length > MAX_PROMPT_IMAGE_COUNT) {
        setAttachmentError(`每条消息最多附加 ${MAX_PROMPT_IMAGE_COUNT} 张图片。`);
        return;
      }
      const incomingBytes = accepted.reduce((total, { file }) => total + file.size, 0);
      if (incomingBytes > MAX_PROMPT_IMAGE_BYTES) {
        setAttachmentError(`图片合计最多 ${Math.floor(MAX_PROMPT_IMAGE_BYTES / 1024)} KiB。`);
        return;
      }
      try {
        const images = await Promise.all(accepted.map(({ file, mimeType }) =>
          readImage(file, mimeType)));
        if (scope !== attachmentScopeRef.current) return;
        const currentImages = draftImagesRef.current;
        if (currentImages.length + images.length > MAX_PROMPT_IMAGE_COUNT) {
          setAttachmentError(`每条消息最多附加 ${MAX_PROMPT_IMAGE_COUNT} 张图片。`);
          return;
        }
        const totalBytes = currentImages.reduce(
          (total, image) => total + decodedPromptImageBytes(image.data),
          incomingBytes,
        );
        if (totalBytes > MAX_PROMPT_IMAGE_BYTES) {
          setAttachmentError(`图片合计最多 ${Math.floor(MAX_PROMPT_IMAGE_BYTES / 1024)} KiB。`);
          return;
        }
        const nextImages = [...currentImages, ...images];
        draftImagesRef.current = nextImages;
        onImagesChangeRef.current(nextImages);
        setAttachmentError("");
      } catch (error) {
        if (scope === attachmentScopeRef.current) {
          setAttachmentError(error instanceof Error ? error.message : "无法读取图片");
        }
      }
    });
    attachmentReadQueueRef.current = queued.catch(() => undefined);
    return queued;
  };
  const removeImage = (index: number) => {
    const nextImages = draftImagesRef.current.filter((_, current) => current !== index);
    draftImagesRef.current = nextImages;
    onImagesChangeRef.current(nextImages);
  };
  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!draftEditable) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };
  const send = () => {
    const value = draft.trim();
    if (
      (!value && draftImages.length === 0)
      || submitting
      || compacting
      || rewindingMessageId
      || !model
      || !controlsEnabled
      || !conversationReady
      || !draftEditable
    ) return;
    onSend(value, draftImages);
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
      {mobile && <div className="mobile-chat-header">
        <button
          type="button"
          aria-label="返回会话列表"
          onClick={() => {
            closeMobileSheet();
            mobile.onBack();
          }}
        >返回</button>
        <div className="mobile-chat-identity">
          <small className={conversationStatusClass}>{conversationStatus}</small>
          <strong>{mobile.title}</strong>
        </div>
        <button
          ref={mobileSettingsLauncherRef}
          type="button"
          className="mobile-settings-button"
          aria-label="打开设置"
          onClick={() => {
            closeMobileSheet();
            onSettings(resolveSettingsLauncher);
          }}
        ><span aria-hidden="true">⚙</span><span>设置</span></button>
      </div>}
      <button className="brand" onClick={onChangeCwd}><span>π</span><span>Pi Web<small title={cwd}>{cwd}</small></span></button>
      {conversationContext && <nav
        className={`topbar-conversation-context${
          conversationContext.currentTitle ? " has-current" : ""
        }${conversationContext.ordinal === undefined ? "" : " has-ordinal"}`}
        aria-label="协作路径"
      >
        {conversationContext.ordinal !== undefined && <span
          className="topbar-session-ordinal"
          aria-hidden="true"
        >
          {String(conversationContext.ordinal).padStart(2, "0")}
        </span>}
        <span className="topbar-conversation-copy">
          <span className="topbar-conversation-eyebrow">ACTIVE CONVERSATION</span>
          <span className="topbar-conversation-title">
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
          </span>
          {(role?.name || conversationContext.agentCount !== undefined) && <span
            className="topbar-conversation-metadata"
          >
            {conversationContext.agentCount !== undefined && <span>
              {conversationContext.agentCount} AGENTS
            </span>}
            {role?.name && <span>{role.name}</span>}
          </span>}
        </span>
        <span
          className={`topbar-conversation-status ${conversationStatusClass}`}
          aria-label={`会话状态：${conversationStatus}`}
        >
          <span>STATUS</span>
          <strong>{conversationStatus}</strong>
        </span>
      </nav>}
      <div className="topbar-controls">
        <button
          ref={desktopSettingsLauncherRef}
          className="model-button"
          title="设置"
          onClick={() => onSettings(resolveSettingsLauncher)}
        >
          设置<span hidden>{model?.id}</span><span aria-hidden="true">⌄</span>
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
      {conversationReady && historyWindowIncomplete && <div
        className="history-window-marker"
        role="note"
        aria-label="历史记录不完整"
      >
        <strong>历史记录不完整</strong>
        {historyWindow?.omittedBefore && <span>较早的历史记录未显示</span>}
        {historyWindow?.startsMidTurn && <span>当前窗口从一轮对话中间开始</span>}
        {historyWindow?.contentTruncated && <span>过大的消息内容已截断</span>}
      </div>}
      {conversationReady && !blocks.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {blocks.map((block) => {
        if (block.kind === "compaction") {
          const provenanceLabel = compactionMarkerLabel(block.provenance);
          return <div
            key={`${transcriptRenderScopeKey}:compaction:${block.id}`}
            className="compaction-marker"
            role="separator"
            aria-label={`上下文已压缩：${provenanceLabel}`}
          >
            <time className="compaction-time" dateTime={block.timestamp}>
              {formatTimelineTime(block.timestamp)}
            </time>
            <strong className="compaction-actor">SYSTEM</strong>
            <span className="compaction-label" title={provenanceLabel}>
              CONTEXT COMPACTION · {provenanceLabel}
            </span>
            <span className="compaction-metric">
              {formatCompactTokens(block.tokensBefore)} TOKENS
            </span>
            <span className="compaction-state">DONE</span>
          </div>;
        }
        if (block.kind === "bash_task_notification") return <BashTaskNotificationCard
          key={`${transcriptRenderScopeKey}:bash-task:${block.id}`}
          notification={block}
        />;
        if (block.kind === "session_message") return <SessionMessageCard
          key={`${transcriptRenderScopeKey}:card:${block.cardId}`}
          card={block}
          onOpenConversation={handleOpenConversation}
        />;
        const isActiveMessage = activeRun?.id === block.message.runId;
        const isCurrentAssistantMessage =
          block.message.id === activeAssistantMessageId;
        const hasActiveTool = block.message.tools.some((tool) => (
          tool.status === "pending" || tool.status === "running"
        ));
        const isStreamingMessage = isActiveMessage
          && activeRun?.phase === "running";
        return <Message
          key={`${transcriptRenderScopeKey}:message:${block.message.id}`}
          message={block.message}
          onOpenImage={onOpenImage}
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
          assistantActor={isCurrentAssistantMessage ? role?.name : undefined}
          assistantState={isCurrentAssistantMessage
            ? activeRun?.phase.toUpperCase()
            : undefined}
          conversationTitleLookup={conversationTitleLookup}
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
          <small>{compactionAttempt
            ? liveCompactionAttemptLabel(compactionAttempt)
            : "整理较早消息并保留关键信息…"}</small>
        </span>
      </div>}
    </section>
    <MissionCommandSurface
      loopListItems={loopListItems}
      completedItemCount={completedLoopListItems}
      remainingItemCount={remainingLoopListItems}
      loopListStatusKey={loopListEmpty ? undefined : loopListStatusKey}
      loopListStatusLabel={loopListEmpty ? undefined : loopListStatusLabel}
      contextTokenText={contextTokenText}
      outputTokensPerSecond={outputTokensPerSecond}
      outputRateEstimated={outputRateEstimated}
      contextPercent={contextPercent}
      contextSource={contextSource}
      compactionThresholdPercent={compactionThresholdPercent}
    />
    <div
      className="composer-wrap"
      ref={mobileSheetFocusRef}
      role={visibleMobileSheet ? "dialog" : undefined}
      aria-modal={visibleMobileSheet ? "true" : undefined}
      aria-label={visibleMobileSheet === "tasks"
        ? "任务"
        : visibleMobileSheet === "pending"
          ? "等待中"
          : visibleMobileSheet === "retained"
          ? "保留的原输入"
          : visibleMobileSheet === "controls"
            ? "控制"
            : undefined}
      tabIndex={visibleMobileSheet ? -1 : undefined}
    >
      {showJumpToLatest && <button
        type="button"
        className="jump-latest"
        onClick={jumpToLatest}
      >
        ↓ 回到最新消息
      </button>}
      {visibleMobileSheet && <div
        className="mobile-sheet-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          event.preventDefault();
          closeMobileSheet();
        }}
      />}
      {showBashActivity && bashActivity && <div
        className={`bash-activity-strip${bashActivity.cleanupUnknown ? " cleanup-unknown" : ""}`}
        role="status"
        aria-label="后台命令状态"
        aria-live="polite"
        aria-atomic="true"
      >
        <strong>后台 Bash</strong>
        <span>执行中 {bashActivity.running}</span>
        <span>停止中 {bashActivity.stopping}</span>
        {bashActivity.cleanupUnknown && <strong>停止状态未确认</strong>}
      </div>}
      {pendingAdmissions.length > 0 && <section
        className={`pending-admissions${mobile ? " mobile-sheet-surface" : ""}`}
        aria-label={mobile ? "等待中" : "等待处理的消息"}
        hidden={Boolean(mobile && visibleMobileSheet !== "pending")}
      >
        {visibleMobileSheet === "pending" && <header className="mobile-sheet-header">
          <h2>等待中</h2>
          <button
            type="button"
            data-modal-autofocus
            aria-label="关闭等待中"
            onClick={closeMobileSheet}
          >×</button>
        </header>}
        {pendingAdmissions.map((admission) => (
          <div
            key={admission.promptId}
            className="pending-admission-item"
            role="status"
          >
            <span className="pending-admission-text" title={admission.text}>{admission.text}</span>
            <span className="pending-admission-status">等待中</span>
            <button
              type="button"
              className="pending-admission-withdraw"
              disabled={!controlsEnabled || !conversationReady || Boolean(withdrawingPromptId)
                || stopping || (activeRun?.phase !== "running" && activeRun?.phase !== "waiting")}
              onClick={() => onWithdrawPrompt(admission.promptId)}
            >{withdrawingPromptId === admission.promptId ? "撤回中…" : "撤回"}</button>
          </div>
        ))}
      </section>}
      {retainedInputs.length > 0 && <div
        className={mobile ? "mobile-sheet-surface retained-inputs-surface" : "retained-inputs-surface"}
        hidden={Boolean(mobile && visibleMobileSheet !== "retained")}
      >
        {visibleMobileSheet === "retained" && <header className="mobile-sheet-header">
          <h2>保留的原输入</h2>
          <button type="button" data-modal-autofocus aria-label="关闭保留的原输入" onClick={closeMobileSheet}>×</button>
        </header>}
        <RetainedInputs inputs={retainedInputs} currentScopeKey={retainedInputScopeKey}
          canRestore={canRestoreRetainedInput && draft === "" && draftImages.length === 0 && !submitting}
          onRestore={onRestoreRetainedInput} onDiscard={onDiscardRetainedInput} />
      </div>}
      {loopListItems.length > 0 && <section
        className={`loop-list${mobile ? " mobile-sheet-surface" : ""}`}
        aria-label={visibleMobileSheet === "tasks" ? "任务" : "Tasks"}
        hidden={Boolean(mobile && visibleMobileSheet !== "tasks")}
      >
        {visibleMobileSheet === "tasks" && <header className="mobile-sheet-header">
          <h2>任务</h2>
          <button
            type="button"
            data-modal-autofocus
            aria-label="关闭任务"
            onClick={closeMobileSheet}
          >×</button>
        </header>}
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
      {stopping && <div className="composer-notice pending" role="status">
        停止请求已发送，正在等待运行状态更新…
      </div>}
      {promptNotice && <div className="composer-notice" role="alert">{promptNotice}</div>}
      {attachmentError && <div className="composer-notice" role="alert">{attachmentError}</div>}
      {draftImages.length > 0 && <div className="composer-attachments" aria-label="待发送图片">
        {draftImages.map((image, index) => <div className="composer-attachment" key={`${image.mimeType}:${image.data.slice(0, 32)}`}>
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`} />
          <button
            type="button"
            aria-label={`移除图片 ${index + 1}`}
            onClick={() => removeImage(index)}
            disabled={!draftEditable}
          >×</button>
        </div>)}
      </div>}
      <div className="composer">
        <span className="composer-command-label" aria-hidden="true">COMMAND</span>
        <textarea ref={textareaRef} aria-label="给 Pi 发送消息" value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={keyDown} onPaste={pasteImages} placeholder={composerPlaceholder} disabled={!draftEditable} rows={1} />
        <div className="composer-actions">
          {busy && <button
            className="send stop"
            onClick={onAbort}
            aria-label={stopping ? "停止请求已发送" : "停止"}
            disabled={!controlsEnabled || !conversationReady || stopping}
          >{stopping ? "STOPPING…" : "STOP"}</button>}
          <button className="send" onClick={send} disabled={!draftEditable || !controlsEnabled || !conversationReady || !model || submitting || compacting || roleSwitching || Boolean(rewindingMessageId) || (!draft.trim() && draftImages.length === 0)} aria-label="发送">SEND</button>
        </div>
      </div>
      {mobile && <div className="mobile-composer-launchers" aria-label="会话辅助面板">
        {retainedInputs.length > 0 && <button type="button" aria-label="打开保留的原输入"
          aria-expanded={visibleMobileSheet === "retained"} onClick={() => setMobileSheet("retained")}
        >保留输入 <span>{retainedInputs.length}</span></button>}
        {loopListItems.length > 0 && <button
          type="button"
          aria-label="打开任务"
          disabled={!conversationReady}
          aria-expanded={visibleMobileSheet === "tasks"}
          onClick={() => setMobileSheet("tasks")}
        >TASKS <span>{remainingLoopListItems}</span></button>}
        {pendingAdmissions.length > 0 && <button
          type="button"
          aria-label="打开等待中"
          disabled={!conversationReady}
          aria-expanded={visibleMobileSheet === "pending"}
          onClick={() => setMobileSheet("pending")}
        >WAIT <span>{pendingAdmissions.length}</span></button>}
        <button
          type="button"
          aria-label="打开控制"
          disabled={!conversationReady}
          aria-expanded={visibleMobileSheet === "controls"}
          onClick={() => setMobileSheet("controls")}
        >控制</button>
      </div>}
      <div
        className={`composer-meta${mobile ? " mobile-sheet-surface" : ""}`}
        hidden={Boolean(mobile && visibleMobileSheet !== "controls")}
      >
        {visibleMobileSheet === "controls" && <header className="mobile-sheet-header">
          <h2>控制</h2>
          <button
            type="button"
            data-modal-autofocus
            aria-label="关闭控制"
            onClick={closeMobileSheet}
          >×</button>
        </header>}
        {role && <button
          type="button"
          className="conversation-role-pill"
          aria-label={`查看会话角色 ${role.name}`}
          onClick={() => {
            closeMobileSheet();
            setRoleDetailsOpen(true);
          }}
        >
          <span className="composer-meta-key" aria-hidden="true">TO</span>
          <span className="composer-meta-value">{role.name}</span>
          <small><span className="composer-meta-key" aria-hidden="true">MODEL</span>{role.model.id}</small>
        </button>}
        <label className="thinking-level-control">
          <span className="composer-meta-key" aria-hidden="true">EFFORT</span>
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
          <span className="composer-meta-key" aria-hidden="true">SERVICE</span>
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
      </div>
    </div>
    {role && <ConversationRoleDialog
      open={roleDetailsOpen}
      role={role}
      roles={roles}
      focusKey={roleSwitchFocusKey}
      covered={roleDialogCovered}
      switchDisabled={roleSwitchDisabled}
      switching={roleSwitching}
      onSwitch={onSwitchRole}
      onClose={() => setRoleDetailsOpen(false)}
    />}
  </main>;
}

export const Chat = memo(ChatView);
