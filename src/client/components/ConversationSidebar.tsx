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
import {
  conversationDisplayTitle,
  shortConversationHandle,
} from "../lib/conversation-display";
import { useModalFocus } from "../lib/use-modal-focus";
import { ActivitySpinner } from "./ActivitySpinner";

const DEFAULT_SIDEBAR_WIDTH = 306;
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
  deletionBlocked?: boolean;
  mobile?: {
    hidden: boolean;
    onShowWorkspaces(): void;
    onShowCurrentConversation?: () => void;
  };
  onToggleCollapsed(collapsed: boolean): void;
  onSelect(conversationId: string): void;
  onCreate(): void;
  onRename(conversationId: string, name: string): void;
  onDelete(conversationId: string): boolean;
  onBlockingModalChange?(blocking: boolean): void;
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
  | { kind: "group"; group: ConversationGroup }
  | { kind: "conversation"; conversation: ConversationSummary };

function groupProjection(
  conversations: ConversationSummary[],
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
      .map((conversation) => ({ conversation }))
      .sort((left, right) => {
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
          : left.conversation.id.localeCompare(right.conversation.id);
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
    ...groups.map((group) => ({ kind: "group" as const, group })),
    ...conversations
      .filter(({ id }) => !rootByConversationId.has(id))
      .map((conversation) => ({
        kind: "conversation" as const,
        conversation,
      })),
  ];
  entries.sort((left, right) => {
    const leftRoot = left.kind === "group" ? left.group.root : left.conversation;
    const rightRoot = right.kind === "group" ? right.group.root : right.conversation;
    const createdDifference = Date.parse(rightRoot.createdAt)
      - Date.parse(leftRoot.createdAt);
    if (createdDifference !== 0) return createdDifference;
    if (leftRoot.id === rightRoot.id) return 0;
    return leftRoot.id < rightRoot.id ? -1 : 1;
  });
  return { entries, rootByConversationId };
}

export function conversationDisplayOrdinal(
  conversations: ConversationSummary[],
  conversationId: string,
): number | undefined {
  const grouped = groupProjection(conversations);
  const rootConversationId = grouped.rootByConversationId.get(conversationId)
    ?? conversationId;
  const index = grouped.entries.findIndex((entry) => entry.kind === "group"
    ? entry.group.root.id === rootConversationId
    : entry.conversation.id === rootConversationId
  );
  return index < 0 ? undefined : index + 1;
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
  ordinal,
  selected,
  navigationEnabled,
  actionsEnabled,
  deletionBlocked,
  busy,
  onSelect,
  onRequestRename,
  onRequestDelete,
}: {
  conversation: ConversationSummary;
  hierarchy: ConversationRowHierarchy;
  ordinal?: string;
  selected: boolean;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  deletionBlocked: boolean;
  busy: boolean;
  onSelect(conversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
}) {
  const title = conversationDisplayTitle(conversation);
  const active = busy || (conversation.activity?.kind ?? "idle") !== "idle";
  const classes = [
    "conversation-sidebar-item",
    `hierarchy-${hierarchy}`,
    `activity-${conversation.activity?.kind ?? "idle"}`,
    selected ? "selected" : "",
    conversation.attention ? "needs-attention" : "",
    conversation.unread ? "has-unread" : "",
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
        {ordinal && (
          <span className="conversation-sidebar-ordinal" aria-hidden="true">
            {ordinal}
          </span>
        )}
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
            {shortConversationHandle(conversation.id)}
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
          删除
        </button>
      </div>
    </li>
  );
});

function ConversationGroupCard({
  group,
  ordinal,
  expanded,
  idleRevealed,
  currentConversationId,
  busyConversationId,
  navigationEnabled,
  actionsEnabled,
  deletionBlocked,
  onSelect,
  onToggleExpanded,
  onRevealIdle,
  onRequestRename,
  onRequestDelete,
}: {
  group: ConversationGroup;
  ordinal: string;
  expanded: boolean;
  idleRevealed: boolean;
  currentConversationId?: string;
  busyConversationId?: string;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  deletionBlocked: boolean;
  onSelect(conversationId: string): void;
  onToggleExpanded(rootConversationId: string): void;
  onRevealIdle(rootConversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
}) {
  const { root, members, conversations } = group;
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
  const title = conversationDisplayTitle(root);

  return (
    <li
      className="conversation-group-card"
      data-root-conversation-id={root.id}
    >
      <ul className="conversation-sidebar-list conversation-group-root-list">
        <ConversationRow
          conversation={root}
          hierarchy="root"
          ordinal={ordinal}
          selected={root.id === currentConversationId}
          navigationEnabled={navigationEnabled}
          actionsEnabled={actionsEnabled}
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
        <p className="conversation-group-members-label">
          协作 Agent · 属于 {title}
        </p>
        <ul className="conversation-sidebar-list">
          {visibleMembers.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              hierarchy="member"
              selected={conversation.id === currentConversationId}
              navigationEnabled={navigationEnabled}
              actionsEnabled={actionsEnabled}
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
  deletionBlocked = false,
  mobile,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onBlockingModalChange,
}: ConversationSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const sidebarCollapsed = collapsed && !mobile;
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
    () => groupProjection(conversations, busyConversationId),
    [conversations, busyConversationId],
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
  const renameUnchanged = renameCandidate
    ? renameName === conversationDisplayTitle(renameCandidate)
    : false;
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
    if (!deletionBlocked) setConfirmDeleteConversationId("");
  };
  const closeRenameDialog = () => setRenameConversationId("");
  const deleteFocusRef = useModalFocus<HTMLDivElement>(
    Boolean(deleteCandidate) && !mobile?.hidden,
    confirmDeleteConversationId,
    closeDeleteDialog,
  );
  const renameFocusRef = useModalFocus<HTMLFormElement>(
    Boolean(renameCandidate) && !mobile?.hidden,
    renameConversationId,
    closeRenameDialog,
  );

  useEffect(() => {
    onBlockingModalChange?.(Boolean(
      (deleteCandidate || renameCandidate) && !mobile?.hidden,
    ));
    return () => onBlockingModalChange?.(false);
  }, [deleteCandidate, mobile?.hidden, onBlockingModalChange, renameCandidate]);

  useEffect(() => {
    if (!mobile?.hidden) return;
    setConfirmDeleteConversationId("");
    setRenameConversationId("");
  }, [mobile?.hidden]);

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
    if (sidebarCollapsed || !navigationEnabled) resizeState.current = undefined;
  }, [navigationEnabled, sidebarCollapsed]);
  useEffect(() => {
    if (!renameConversationId || renameCandidate) return;
    setRenameConversationId("");
  }, [renameConversationId, renameCandidate]);

  const requestRename = useCallback((conversation: ConversationSummary) => {
    setRenameDraft(conversationDisplayTitle(conversation));
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
      className={`conversation-sidebar${sidebarCollapsed ? " collapsed" : ""}`}
      aria-label="项目会话栏"
      style={sidebarStyle}
      hidden={mobile?.hidden}
    >
      {mobile && <header className="mobile-page-header">
        <button
          type="button"
          aria-label="显示工作区"
          onClick={mobile.onShowWorkspaces}
        >工作区</button>
        <div>
          <small>AGENTS</small>
          <h1>会话</h1>
        </div>
        {mobile.onShowCurrentConversation
          ? <button
              type="button"
              aria-label="打开当前会话"
              onClick={mobile.onShowCurrentConversation}
            >当前</button>
          : <span aria-hidden="true" />}
      </header>}
      <header className="conversation-sidebar-header">
        {!sidebarCollapsed && <h2>SESSIONS</h2>}
        <button
          type="button"
          className="conversation-sidebar-toggle"
          aria-label={sidebarCollapsed ? "展开会话栏" : "收起会话栏"}
          aria-expanded={!sidebarCollapsed}
          disabled={!navigationEnabled}
          onClick={() => onToggleCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
      </header>

      {!sidebarCollapsed && (
        <nav className="conversation-sidebar-navigation" aria-label="项目会话">
          <ul className="conversation-sidebar-list">
            {grouped.entries.map((entry, index) => {
              const ordinal = String(index + 1).padStart(2, "0");
              if (entry.kind === "group") {
                return <ConversationGroupCard
                  key={`group:${entry.group.root.id}`}
                  group={entry.group}
                  ordinal={ordinal}
                  expanded={expandedRoots.has(entry.group.root.id)}
                  idleRevealed={revealedIdleRoots.has(entry.group.root.id)}
                  currentConversationId={currentConversationId}
                  busyConversationId={busyConversationId}
                  navigationEnabled={navigationEnabled}
                  actionsEnabled={actionsEnabled}
                  deletionBlocked={deletionBlocked}
                  onSelect={onSelect}
                  onToggleExpanded={toggleExpanded}
                  onRevealIdle={revealIdle}
                  onRequestRename={requestRename}
                  onRequestDelete={requestDelete}
                />;
              }
              return <ConversationRow
                key={entry.conversation.id}
                conversation={entry.conversation}
                hierarchy="standalone"
                ordinal={ordinal}
                selected={entry.conversation.id === currentConversationId}
                navigationEnabled={navigationEnabled}
                actionsEnabled={actionsEnabled}
                deletionBlocked={deletionBlocked}
                busy={entry.conversation.id === busyConversationId}
                onSelect={onSelect}
                onRequestRename={requestRename}
                onRequestDelete={requestDelete}
              />;
            })}
          </ul>
          {truncated && <p className="conversation-sidebar-truncated">
            仅显示最近协作组和会话
          </p>}
        </nav>
      )}

      {!sidebarCollapsed && <footer className="conversation-sidebar-footer">
        <button
          type="button"
          className="conversation-sidebar-create"
          aria-label="新建会话"
          disabled={!actionsEnabled || deletionBlocked}
          onClick={onCreate}
        >
          <span aria-hidden="true">+</span>
          <span>新建会话</span>
        </button>
      </footer>}
      {!sidebarCollapsed && <div
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
    {deleteCandidate && !mobile?.hidden && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        closeDeleteDialog();
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
          “{conversationDisplayTitle(deleteCandidate)}”及其历史，以及由它派生的空闲子孙会话，
          将被永久删除，此操作无法撤销。
        </p>
        <div className="provider-actions">
          <button
            type="button"
            className="ghost"
            data-modal-autofocus
            disabled={deletionBlocked}
            onClick={() => setConfirmDeleteConversationId("")}
          >
            保留
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!actionsEnabled || deletionBlocked || deleteCandidateActive}
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
    {renameCandidate && !mobile?.hidden && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        closeRenameDialog();
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
