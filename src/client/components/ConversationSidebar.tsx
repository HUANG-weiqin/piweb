import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  type ConversationActivity,
  type ConversationSummary,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";
import { ActivitySpinner } from "./ActivitySpinner";

const DEFAULT_SIDEBAR_WIDTH = 286;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 640;
const SIDEBAR_KEYBOARD_STEP = 16;
const RECENT_IDLE_MEMBER_LIMIT = 3;
const LAST_ACTIVE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function clampSidebarWidth(width: number): number {
  return Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, width),
  );
}

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  truncated: boolean;
  currentConversationId?: string;
  focusedConversationId?: string;
  scopeKey?: string;
  busyConversationId?: string;
  collapsed: boolean;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  pendingDeletionId?: string;
  onToggleCollapsed(collapsed: boolean): void;
  onSelect(conversationId: string): void;
  onCreate(): void;
  onRename(conversationId: string, name: string): void;
  onDelete(conversationId: string): boolean;
}

function shortHandle(conversationId: string): string {
  return `#${conversationId.slice(0, 8)}`;
}

function titleOf(conversation: ConversationSummary): string {
  const title = conversation.name?.trim()
    || conversation.preview.trim()
    || "新会话";
  const characters = [...title];
  if (characters.length <= MAX_PROJECT_CONVERSATION_NAME_CHARACTERS) {
    return title;
  }
  return `${characters
    .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS - 1)
    .join("")}…`;
}

function clipTitleInput(value: string): string {
  return [...value]
    .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS)
    .join("");
}

function formatLastActive(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return LAST_ACTIVE_FORMATTER.format(date);
}

function activityRank(activity: ConversationActivity | undefined): number {
  switch (activity?.kind) {
    case "running": return 0;
    case "queued": return 1;
    case "cancelling": return 2;
    case "waiting": return 3;
    default: return 4;
  }
}

function isActive(
  conversation: ConversationSummary,
  busyConversationId?: string,
): boolean {
  return conversation.id === busyConversationId
    || activityRank(conversation.activity) < 4;
}

function latestTimestamp(conversations: readonly ConversationSummary[]): number {
  return Math.max(...conversations.map(({ updatedAt }) => Date.parse(updatedAt)));
}

interface ConversationGroup {
  root: ConversationSummary;
  members: ConversationSummary[];
  conversations: ConversationSummary[];
}

type GroupedEntry =
  | { kind: "group"; group: ConversationGroup; index: number }
  | { kind: "conversation"; conversation: ConversationSummary; index: number };

function groupProjection(
  conversations: ConversationSummary[],
  currentConversationId?: string,
  busyConversationId?: string,
): {
  entries: GroupedEntry[];
  rootByConversationId: Map<string, string>;
} {
  const summariesById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const descendantsByRoot = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations) {
    const rootConversationId = conversation.rootConversationId;
    if (
      rootConversationId === undefined
      || rootConversationId === conversation.id
      || !summariesById.has(rootConversationId)
    ) {
      continue;
    }
    const descendants = descendantsByRoot.get(rootConversationId);
    if (descendants === undefined) {
      descendantsByRoot.set(rootConversationId, [conversation]);
    } else {
      descendants.push(conversation);
    }
  }

  const rootByConversationId = new Map<string, string>();
  const groups: ConversationGroup[] = [];
  for (const [rootConversationId, descendants] of descendantsByRoot) {
    const root = summariesById.get(rootConversationId);
    if (root === undefined) continue;
    const members = descendants
      .map((conversation, index) => ({ conversation, index }))
      .sort((left, right) => {
        const currentDifference =
          Number(right.conversation.id === currentConversationId)
          - Number(left.conversation.id === currentConversationId);
        if (currentDifference !== 0) return currentDifference;
        const attentionDifference =
          Number(Boolean(right.conversation.attention))
          - Number(Boolean(left.conversation.attention));
        if (attentionDifference !== 0) return attentionDifference;
        const activeDifference =
          Number(isActive(right.conversation, busyConversationId))
          - Number(isActive(left.conversation, busyConversationId));
        if (activeDifference !== 0) return activeDifference;
        const activityDifference =
          activityRank(left.conversation.activity)
          - activityRank(right.conversation.activity);
        if (activityDifference !== 0) return activityDifference;
        const unreadDifference =
          Number(Boolean(right.conversation.unread))
          - Number(Boolean(left.conversation.unread));
        if (unreadDifference !== 0) return unreadDifference;
        const updatedDifference =
          Date.parse(right.conversation.updatedAt)
          - Date.parse(left.conversation.updatedAt);
        return Number.isFinite(updatedDifference) && updatedDifference !== 0
          ? updatedDifference
          : left.index - right.index;
      })
      .map(({ conversation }) => conversation);
    const groupedConversations = [root, ...members];
    rootByConversationId.set(root.id, root.id);
    for (const member of members) {
      rootByConversationId.set(member.id, root.id);
    }
    groups.push({ root, members, conversations: groupedConversations });
  }

  const entries: GroupedEntry[] = [
    ...groups.map((group, index) => ({ kind: "group" as const, group, index })),
    ...conversations
      .filter(({ id }) => !rootByConversationId.has(id))
      .map((conversation, index) => ({
        kind: "conversation" as const,
        conversation,
        index: groups.length + index,
      })),
  ];
  entries.sort((left, right) => {
    const leftConversations = left.kind === "group"
      ? left.group.conversations
      : [left.conversation];
    const rightConversations = right.kind === "group"
      ? right.group.conversations
      : [right.conversation];
    const leftCurrent = leftConversations.some(({ id }) => id === currentConversationId);
    const rightCurrent = rightConversations.some(({ id }) => id === currentConversationId);
    const currentDifference = Number(rightCurrent) - Number(leftCurrent);
    if (currentDifference !== 0) return currentDifference;
    const leftAttention = leftConversations.some(({ attention }) => attention === true);
    const rightAttention = rightConversations.some(({ attention }) => attention === true);
    const attentionDifference = Number(rightAttention) - Number(leftAttention);
    if (attentionDifference !== 0) return attentionDifference;
    const leftActive = leftConversations.some((conversation) =>
      isActive(conversation, busyConversationId)
    );
    const rightActive = rightConversations.some((conversation) =>
      isActive(conversation, busyConversationId)
    );
    const activeDifference = Number(rightActive) - Number(leftActive);
    if (activeDifference !== 0) return activeDifference;
    const leftUnread = leftConversations.some(({ unread }) => unread === true);
    const rightUnread = rightConversations.some(({ unread }) => unread === true);
    const unreadDifference = Number(rightUnread) - Number(leftUnread);
    if (unreadDifference !== 0) return unreadDifference;
    const updatedDifference = latestTimestamp(rightConversations)
      - latestTimestamp(leftConversations);
    return Number.isFinite(updatedDifference) && updatedDifference !== 0
      ? updatedDifference
      : left.index - right.index;
  });
  return { entries, rootByConversationId };
}

function ActivityIndicator({
  activity,
}: {
  activity: ConversationActivity | undefined;
}) {
  if (activity?.kind === "queued" || activity?.kind === "running") {
    const label = activity.kind === "queued" ? "排队中" : "运行中";
    return (
      <span
        className={`conversation-activity-indicator activity-${activity.kind}`}
        role="status"
        aria-label={label}
        title={label}
      >
        <ActivitySpinner className="conversation-activity-spinner" />
      </span>
    );
  }

  switch (activity?.kind) {
    case "waiting":
      return (
        <span
          className="conversation-activity-indicator activity-waiting"
          role="status"
          aria-label="等待其他会话"
          title="等待其他会话"
        >
          ⌛
        </span>
      );
    case "cancelling":
      return (
        <span
          className="conversation-activity-indicator activity-cancelling"
          role="status"
          aria-label="正在终止"
          title="正在终止"
        >
          ■
        </span>
      );
    default:
      return null;
  }
}

type ConversationRowHierarchy = "root" | "member" | "standalone";

const ConversationRow = memo(function ConversationRow({
  conversation,
  hierarchy,
  selected,
  navigationEnabled,
  actionsEnabled,
  deletionPending,
  deletionBlocked,
  busy,
  onSelect,
  onRequestRename,
  onRequestDelete,
}: {
  conversation: ConversationSummary;
  hierarchy: ConversationRowHierarchy;
  selected: boolean;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  deletionPending: boolean;
  deletionBlocked: boolean;
  busy: boolean;
  onSelect(conversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
}) {
  const title = titleOf(conversation);
  const active = busy || (conversation.activity?.kind ?? "idle") !== "idle";
  const classes = [
    "conversation-sidebar-item",
    `hierarchy-${hierarchy}`,
    `activity-${conversation.activity?.kind ?? "idle"}`,
    selected ? "selected" : "",
    conversation.attention ? "needs-attention" : "",
    conversation.unread ? "has-unread" : "",
    conversation.temporary ? "is-temporary" : "",
  ].filter(Boolean).join(" ");

  return (
    <li className={classes} data-conversation-id={conversation.id}>
      <button
        type="button"
        className="conversation-sidebar-conversation"
        aria-current={selected ? "page" : undefined}
        aria-label={selected ? `当前会话 ${title}` : `打开会话 ${title}`}
        disabled={!navigationEnabled || deletionBlocked}
        onClick={() => onSelect(conversation.id)}
      >
        {hierarchy !== "member" && (
          <span className="conversation-sidebar-kind">
            {hierarchy === "root" ? "主任务" : "主会话"}
          </span>
        )}
        <span className="conversation-sidebar-primary">
          <span className="conversation-sidebar-title">{title}</span>
          <span className="conversation-sidebar-indicators">
            {hierarchy !== "member"
              && conversation.createdBy?.kind === "conversation"
              && (
                <span
                  className="conversation-agent-badge"
                  title="由 Agent 创建"
                >
                  Agent
                </span>
              )}
            <ActivityIndicator activity={conversation.activity} />
            {conversation.attention && (
              <span
                className="conversation-attention-indicator"
                role="status"
                aria-label="需要处理"
                title="需要处理"
              >
                !
              </span>
            )}
            {conversation.unread && (
              <span
                className="conversation-unread-indicator"
                role="status"
                aria-label="未读消息"
                title="未读消息"
              />
            )}
          </span>
        </span>
        <span className="conversation-sidebar-identity">
          <span className="conversation-sidebar-role">
            {conversation.role?.name ?? "角色加载中"}
          </span>
          <span
            className="conversation-sidebar-handle"
            title={conversation.id}
          >
            {shortHandle(conversation.id)}
          </span>
          {hierarchy === "member"
            && conversation.createdBy?.kind === "conversation"
            && (
              <span
                className="conversation-agent-badge"
                title="由 Agent 创建"
              >
                Agent
              </span>
            )}
          {conversation.temporary && (
            <span className="conversation-temporary-badge">临时</span>
          )}
        </span>
        <time
          className="conversation-sidebar-updated"
          dateTime={conversation.updatedAt}
        >
          最后活跃 {formatLastActive(conversation.updatedAt)}
        </time>
      </button>
      <div className="conversation-sidebar-actions">
        <button
          type="button"
          className="conversation-sidebar-rename ghost"
          aria-label={`重命名会话 ${title}`}
          disabled={!actionsEnabled || deletionBlocked || active}
          title={active ? "活跃会话结算后可以重命名" : "重命名会话"}
          onClick={() => onRequestRename(conversation)}
        >
          改名
        </button>
        <button
          type="button"
          className="conversation-sidebar-delete ghost danger"
          aria-label={`删除会话 ${title}`}
          disabled={!actionsEnabled || deletionBlocked || active}
          title={active ? "活跃会话需先终止并等待结算" : "删除会话"}
          onClick={() => onRequestDelete(conversation.id)}
        >
          {deletionPending ? "删除中" : "删除"}
        </button>
      </div>
    </li>
  );
});

function ConversationGroupCard({
  group,
  expanded,
  idleRevealed,
  currentConversationId,
  busyConversationId,
  navigationEnabled,
  actionsEnabled,
  pendingDeletionId,
  onSelect,
  onToggleExpanded,
  onRevealIdle,
  onRequestRename,
  onRequestDelete,
}: {
  group: ConversationGroup;
  expanded: boolean;
  idleRevealed: boolean;
  currentConversationId?: string;
  busyConversationId?: string;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  pendingDeletionId?: string;
  onSelect(conversationId: string): void;
  onToggleExpanded(rootConversationId: string): void;
  onRevealIdle(rootConversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
}) {
  const { root, members, conversations } = group;
  const deletionBlocked = Boolean(pendingDeletionId);
  const controlsId = `conversation-group-${root.id}`;
  const summaryId = `${controlsId}-summary`;
  const ordinaryIdle = members.filter((conversation) =>
    conversation.id !== currentConversationId
    && !isActive(conversation, busyConversationId)
    && !conversation.attention
    && !conversation.unread
  );
  const visibleIds = new Set(
    (idleRevealed
      ? members
      : [
          ...members.filter((conversation) =>
            conversation.id === currentConversationId
            || isActive(conversation, busyConversationId)
            || conversation.attention
            || conversation.unread
          ),
          ...ordinaryIdle.slice(0, RECENT_IDLE_MEMBER_LIMIT),
        ]).map(({ id }) => id),
  );
  const visibleMembers = members.filter(({ id }) => visibleIds.has(id));
  const hiddenIdleCount = ordinaryIdle.filter(({ id }) => !visibleIds.has(id)).length;
  const runningCount = conversations.filter((conversation) => (
    conversation.id === busyConversationId
    || conversation.activity?.kind === "running"
    || conversation.activity?.kind === "queued"
    || conversation.activity?.kind === "cancelling"
  )).length;
  const waitingCount = conversations.filter(
    ({ activity }) => activity?.kind === "waiting",
  ).length;
  const attentionCount = conversations.filter(({ attention }) => attention).length;
  const unreadCount = conversations.filter(({ unread }) => unread).length;
  const summaryParts = [`${members.length} 个 Agent`];
  if (runningCount > 0) summaryParts.push(`${runningCount} 运行`);
  if (waitingCount > 0) summaryParts.push(`${waitingCount} 等待`);
  if (attentionCount > 0) summaryParts.push(`${attentionCount} 需处理`);
  if (unreadCount > 0) summaryParts.push(`${unreadCount} 未读`);
  summaryParts.push(`最近 ${formatLastActive(
    new Date(latestTimestamp(conversations)).toISOString(),
  )}`);
  const summary = summaryParts.join(" · ");
  const title = titleOf(root);

  return (
    <li
      className="conversation-group-card"
      data-root-conversation-id={root.id}
    >
      <ul className="conversation-sidebar-list conversation-group-root-list">
        <ConversationRow
          conversation={root}
          hierarchy="root"
          selected={root.id === currentConversationId}
          navigationEnabled={navigationEnabled}
          actionsEnabled={actionsEnabled}
          deletionPending={pendingDeletionId === root.id}
          deletionBlocked={deletionBlocked}
          busy={root.id === busyConversationId}
          onSelect={onSelect}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
        />
      </ul>
      <button
        type="button"
        className="conversation-group-disclosure"
        aria-label={`${expanded ? "收起" : "展开"}协作组 ${title}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-describedby={summaryId}
        disabled={!navigationEnabled || deletionBlocked}
        onClick={() => onToggleExpanded(root.id)}
      >
        <span id={summaryId} className="conversation-group-summary">
          {summary}
        </span>
        <span className="conversation-group-chevron" aria-hidden="true" />
      </button>
      {expanded && <div id={controlsId} className="conversation-group-members">
        <p className="conversation-group-members-label">协作 Agent</p>
        <ul className="conversation-sidebar-list">
          {visibleMembers.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              hierarchy="member"
              selected={conversation.id === currentConversationId}
              navigationEnabled={navigationEnabled}
              actionsEnabled={actionsEnabled}
              deletionPending={pendingDeletionId === conversation.id}
              deletionBlocked={deletionBlocked}
              busy={conversation.id === busyConversationId}
              onSelect={onSelect}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </ul>
        {hiddenIdleCount > 0 && <button
          type="button"
          className="conversation-group-reveal ghost"
          disabled={!navigationEnabled || deletionBlocked}
          onClick={() => onRevealIdle(root.id)}
        >
          显示其余 {hiddenIdleCount} 个空闲 Agent
        </button>}
      </div>}
    </li>
  );
}

function ConversationSidebarView({
  conversations,
  truncated,
  currentConversationId,
  focusedConversationId,
  scopeKey = "",
  busyConversationId,
  collapsed,
  navigationEnabled,
  actionsEnabled,
  pendingDeletionId,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: ConversationSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const resizeState = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | undefined>(undefined);
  const [confirmDeleteConversationId, setConfirmDeleteConversationId] = useState("");
  const [renameConversationId, setRenameConversationId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() => new Set());
  const [revealedIdleRoots, setRevealedIdleRoots] = useState<Set<string>>(
    () => new Set(),
  );
  const observedScopeKey = useRef(scopeKey);
  const observedFocusedConversationId = useRef<string | undefined>(undefined);
  const lastFocusedRoot = useRef<string | undefined>(undefined);
  const grouped = useMemo(
    () => groupProjection(
      conversations,
      currentConversationId,
      busyConversationId,
    ),
    [conversations, currentConversationId, busyConversationId],
  );
  const deleteCandidate = conversations.find(
    ({ id }) => id === confirmDeleteConversationId,
  );
  const deleteCandidateActive = deleteCandidate !== undefined
    && isActive(deleteCandidate, busyConversationId);
  const renameCandidate = conversations.find(
    ({ id }) => id === renameConversationId,
  );
  const renameCandidateActive = renameCandidate !== undefined
    && isActive(renameCandidate, busyConversationId);
  const renameName = renameDraft.trim();
  const renameBlocked = !actionsEnabled || renameCandidateActive;
  const renameUnchanged =
    renameCandidate ? renameName === titleOf(renameCandidate) : false;
  const sidebarStyle = {
    "--conversation-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!navigationEnabled || event.button !== 0) return;
    resizeState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    event.preventDefault();
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!navigationEnabled) return;
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") {
      nextWidth = sidebarWidth - SIDEBAR_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = sidebarWidth + SIDEBAR_KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = MIN_SIDEBAR_WIDTH;
    } else if (event.key === "End") {
      nextWidth = MAX_SIDEBAR_WIDTH;
    }
    if (nextWidth === undefined) return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(nextWidth));
  };
  const closeDeleteDialog = () => {
    if (!pendingDeletionId) setConfirmDeleteConversationId("");
  };
  const closeRenameDialog = () => setRenameConversationId("");
  const deleteFocusRef = useModalFocus<HTMLDivElement>(
    Boolean(deleteCandidate),
    confirmDeleteConversationId,
    closeDeleteDialog,
  );
  const renameFocusRef = useModalFocus<HTMLFormElement>(
    Boolean(renameCandidate),
    renameConversationId,
    closeRenameDialog,
  );

  useLayoutEffect(() => {
    if (observedScopeKey.current === scopeKey) return;
    observedScopeKey.current = scopeKey;
    resizeState.current = undefined;
    observedFocusedConversationId.current = undefined;
    lastFocusedRoot.current = undefined;
    setConfirmDeleteConversationId("");
    setRenameConversationId("");
    setRenameDraft("");
    setExpandedRoots(new Set());
    setRevealedIdleRoots(new Set());
  }, [scopeKey]);
  useEffect(() => {
    if (!confirmDeleteConversationId || deleteCandidate) return;
    setConfirmDeleteConversationId("");
  }, [confirmDeleteConversationId, deleteCandidate]);
  useEffect(() => {
    if (
      focusedConversationId !== undefined
      && !conversations.some(({ id }) => id === focusedConversationId)
    ) {
      return;
    }
    if (observedFocusedConversationId.current === focusedConversationId) return;
    observedFocusedConversationId.current = focusedConversationId;
    const rootConversationId = focusedConversationId === undefined
      ? undefined
      : grouped.rootByConversationId.get(focusedConversationId);
    if (
      rootConversationId !== undefined
      && rootConversationId !== lastFocusedRoot.current
    ) {
      setExpandedRoots((current) => {
        const next = new Set(current);
        next.add(rootConversationId);
        return next;
      });
    }
    lastFocusedRoot.current = rootConversationId;
  }, [
    conversations,
    focusedConversationId,
    grouped.rootByConversationId,
    scopeKey,
  ]);
  useEffect(() => {
    const continueResize = (event: globalThis.PointerEvent) => {
      const resize = resizeState.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      setSidebarWidth(clampSidebarWidth(
        resize.startWidth + event.clientX - resize.startX,
      ));
    };
    const finishResize = (event: globalThis.PointerEvent) => {
      if (resizeState.current?.pointerId === event.pointerId) {
        resizeState.current = undefined;
      }
    };
    window.addEventListener("pointermove", continueResize);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", continueResize);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, []);
  useEffect(() => {
    if (collapsed || !navigationEnabled) resizeState.current = undefined;
  }, [collapsed, navigationEnabled]);
  useEffect(() => {
    if (!renameConversationId || renameCandidate) return;
    setRenameConversationId("");
  }, [renameConversationId, renameCandidate]);

  const requestRename = useCallback((conversation: ConversationSummary) => {
    setRenameDraft(titleOf(conversation));
    setRenameConversationId(conversation.id);
  }, []);
  const requestDelete = useCallback((conversationId: string) => {
    setConfirmDeleteConversationId(conversationId);
  }, []);
  const toggleExpanded = useCallback((rootConversationId: string) => {
    setExpandedRoots((current) => {
      const next = new Set(current);
      if (next.has(rootConversationId)) next.delete(rootConversationId);
      else next.add(rootConversationId);
      return next;
    });
  }, []);
  const revealIdle = useCallback((rootConversationId: string) => {
    setRevealedIdleRoots((current) => {
      const next = new Set(current);
      next.add(rootConversationId);
      return next;
    });
  }, []);

  return <>
    <aside
      className={`conversation-sidebar${collapsed ? " collapsed" : ""}`}
      aria-label="项目会话栏"
      style={sidebarStyle}
    >
      <header className="conversation-sidebar-header">
        {!collapsed && <h2>会话</h2>}
        <button
          type="button"
          className="conversation-sidebar-toggle"
          aria-label={collapsed ? "展开会话栏" : "收起会话栏"}
          aria-expanded={!collapsed}
          disabled={!navigationEnabled}
          onClick={() => onToggleCollapsed(!collapsed)}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </header>

      {!collapsed && (
        <nav className="conversation-sidebar-navigation" aria-label="项目会话">
          <ul className="conversation-sidebar-list">
            {grouped.entries.map((entry) => entry.kind === "group"
              ? <ConversationGroupCard
                  key={`group:${entry.group.root.id}`}
                  group={entry.group}
                  expanded={expandedRoots.has(entry.group.root.id)}
                  idleRevealed={revealedIdleRoots.has(entry.group.root.id)}
                  currentConversationId={currentConversationId}
                  busyConversationId={busyConversationId}
                  navigationEnabled={navigationEnabled}
                  actionsEnabled={actionsEnabled}
                  pendingDeletionId={pendingDeletionId}
                  onSelect={onSelect}
                  onToggleExpanded={toggleExpanded}
                  onRevealIdle={revealIdle}
                  onRequestRename={requestRename}
                  onRequestDelete={requestDelete}
                />
              : <ConversationRow
                  key={entry.conversation.id}
                  conversation={entry.conversation}
                  hierarchy="standalone"
                  selected={entry.conversation.id === currentConversationId}
                  navigationEnabled={navigationEnabled}
                  actionsEnabled={actionsEnabled}
                  deletionPending={pendingDeletionId === entry.conversation.id}
                  deletionBlocked={Boolean(pendingDeletionId)}
                  busy={entry.conversation.id === busyConversationId}
                  onSelect={onSelect}
                  onRequestRename={requestRename}
                  onRequestDelete={requestDelete}
                />)}
          </ul>
          {truncated && <p className="conversation-sidebar-truncated">
            仅显示最近协作组和会话
          </p>}
        </nav>
      )}

      <footer className="conversation-sidebar-footer">
        <button
          type="button"
          className="conversation-sidebar-create"
          aria-label="新建会话"
          disabled={!actionsEnabled || Boolean(pendingDeletionId)}
          onClick={onCreate}
        >
          <span aria-hidden="true">＋</span>
          {!collapsed && <span>新建会话</span>}
        </button>
      </footer>
      {!collapsed && <div
        className="conversation-sidebar-resize-handle"
        role="separator"
        aria-label="调整会话栏宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} 像素`}
        aria-disabled={!navigationEnabled}
        tabIndex={navigationEnabled ? 0 : -1}
        title="拖动调整会话栏宽度"
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />}
    </aside>
    {deleteCandidate && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDeleteDialog();
      }}
    >
      <div
        ref={deleteFocusRef}
        className="modal conversation-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="确认删除会话"
        tabIndex={-1}
      >
        <h2>永久删除会话？</h2>
        <p>
          “{titleOf(deleteCandidate)}”及其历史，以及由它派生的空闲子孙会话，
          将被永久删除，此操作无法撤销。
        </p>
        <div className="provider-actions">
          <button
            type="button"
            className="ghost"
            data-modal-autofocus
            disabled={Boolean(pendingDeletionId)}
            onClick={() => setConfirmDeleteConversationId("")}
          >
            保留
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!actionsEnabled || Boolean(pendingDeletionId) || deleteCandidateActive}
            onClick={() => {
              if (onDelete(deleteCandidate.id)) {
                setConfirmDeleteConversationId("");
              }
            }}
          >
            永久删除
          </button>
        </div>
      </div>
    </div>}
    {renameCandidate && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRenameDialog();
      }}
    >
      <form
        ref={renameFocusRef}
        className="modal conversation-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="重命名会话"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault();
          if (renameBlocked || !renameName || renameUnchanged) return;
          onRename(renameCandidate.id, renameName);
          closeRenameDialog();
        }}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">CONVERSATION</p>
            <h2>重命名会话</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭重命名"
            onClick={closeRenameDialog}
          >
            ×
          </button>
        </header>
        <label htmlFor="conversation-rename">会话名称</label>
        <input
          id="conversation-rename"
          value={renameDraft}
          disabled={renameBlocked}
          data-modal-autofocus
          onChange={(event) => setRenameDraft(
            clipTitleInput(event.target.value),
          )}
        />
        <div className="provider-actions">
          <button
            type="button"
            className="ghost"
            onClick={closeRenameDialog}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={renameBlocked || !renameName || renameUnchanged}
          >
            保存名称
          </button>
        </div>
      </form>
    </div>}
  </>;
}

export const ConversationSidebar = memo(ConversationSidebarView);
