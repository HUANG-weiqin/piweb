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
  type ConversationSummary,
} from "../../shared/protocol";
import { conversationDisplayTitle } from "../lib/conversation-display";
import {
  groupConversations,
  isConversationActive,
  type ConversationGroup,
} from "../lib/conversation-grouping";
import { useModalFocus } from "../lib/use-modal-focus";
import {
  ConversationRow,
  type ConversationRowRenamePresentation,
} from "./ConversationSidebarRow";

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

type RenamePresentation = ConversationRowRenamePresentation;

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  truncated: boolean;
  currentConversationId?: string;
  focusedConversationId?: string;
  scopeKey?: string;
  busyConversationId?: string;
  /** Exact rename command settlement owns this local presentation, not a catalog snapshot. */
  renamePresentations?: ReadonlyMap<string, RenamePresentation>;
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
  onRename(conversationId: string, name: string): boolean;
  onDelete(conversationId: string): boolean;
  onFork?(conversationId: string): boolean;
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

function latestTimestamp(conversations: readonly ConversationSummary[]): number {
  return Math.max(...conversations.map(({ updatedAt }) => Date.parse(updatedAt)));
}

function ConversationGroupCard({
  group,
  ordinal,
  expanded,
  idleRevealed,
  currentConversationId,
  busyConversationId,
  renamePresentations,
  navigationEnabled,
  actionsEnabled,
  deletionBlocked,
  onSelect,
  onToggleExpanded,
  onRevealIdle,
  onRequestRename,
  onRequestDelete,
  onRequestFork,
}: {
  group: ConversationGroup;
  ordinal: string;
  expanded: boolean;
  idleRevealed: boolean;
  currentConversationId?: string;
  busyConversationId?: string;
  renamePresentations?: ReadonlyMap<string, RenamePresentation>;
  navigationEnabled: boolean;
  actionsEnabled: boolean;
  deletionBlocked: boolean;
  onSelect(conversationId: string): void;
  onToggleExpanded(rootConversationId: string): void;
  onRevealIdle(rootConversationId: string): void;
  onRequestRename(conversation: ConversationSummary): void;
  onRequestDelete(conversationId: string): void;
  onRequestFork?(conversationId: string): void;
}) {
  const { root, members } = group;
  const conversations = [root, ...members];
  const controlsId = `conversation-group-${root.id}`;
  const summaryId = `${controlsId}-summary`;
  const ordinaryIdle = members.filter((conversation) =>
    conversation.id !== currentConversationId
    && !isConversationActive(conversation, busyConversationId)
    && !conversation.compacting
    && !conversation.attention
    && !conversation.unread
  );
  const visibleIds = new Set(
    (idleRevealed
      ? members
      : [
          ...members.filter((conversation) =>
            conversation.id === currentConversationId
            || isConversationActive(conversation, busyConversationId)
            || conversation.compacting
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
  const compactingCount = conversations.filter(({ compacting }) => compacting).length;
  const attentionCount = conversations.filter(({ attention }) => attention).length;
  const unreadCount = conversations.filter(({ unread }) => unread).length;
  const summaryParts = [`${members.length} 个 Agent`];
  if (runningCount > 0) summaryParts.push(`${runningCount} 运行`);
  if (waitingCount > 0) summaryParts.push(`${waitingCount} 等待`);
  if (compactingCount > 0) summaryParts.push(`${compactingCount} 压缩`);
  if (attentionCount > 0) summaryParts.push(`${attentionCount} 需处理`);
  if (unreadCount > 0) summaryParts.push(`${unreadCount} 未读`);
  summaryParts.push(`最近 ${formatLastActive(
    new Date(latestTimestamp(conversations)).toISOString(),
  )}`);
  const summary = summaryParts.join(" · ");
  const title = renamePresentations?.get(root.id)?.name
    ?? conversationDisplayTitle(root);

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
          cascadeDeleteBlocked={conversations.some((conversation) => (
            conversation.id !== root.id
            && (
              conversation.compacting
              || isConversationActive(conversation, busyConversationId)
            )
          ))}
          renamePresentation={renamePresentations?.get(root.id)}
          busy={root.id === busyConversationId}
          formatLastActive={formatLastActive}
          onSelect={onSelect}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          onRequestFork={onRequestFork}
        />
      </ul>
      <button
        type="button"
        className="conversation-group-disclosure"
        aria-label={`${expanded ? "收起" : "展开"}协作组 ${title}`}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-describedby={summaryId}
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
              renamePresentation={renamePresentations?.get(conversation.id)}
              busy={conversation.id === busyConversationId}
              formatLastActive={formatLastActive}
              onSelect={onSelect}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              onRequestFork={onRequestFork}
            />
          ))}
        </ul>
        {hiddenIdleCount > 0 && <button
          type="button"
          className="conversation-group-reveal ghost"
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
  renamePresentations,
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
  onFork,
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
    () => groupConversations(conversations, busyConversationId),
    [conversations, busyConversationId],
  );
  const deleteCandidate = conversations.find(
    ({ id }) => id === confirmDeleteConversationId,
  );
  const deleteCandidateActive = deleteCandidate !== undefined
    && isConversationActive(deleteCandidate, busyConversationId);
  const deleteCandidateCompacting = deleteCandidate?.compacting === true;
  const deleteCandidateCascadeBlocked = deleteCandidate !== undefined
    && grouped.entries.some((entry) =>
      entry.kind === "group"
      && entry.group.root.id === deleteCandidate.id
      && entry.group.members.some((conversation) => (
        conversation.compacting
        || isConversationActive(conversation, busyConversationId)
      ))
    );
  const renameCandidate = conversations.find(
    ({ id }) => id === renameConversationId,
  );
  const renameCandidateActive = renameCandidate !== undefined
    && isConversationActive(renameCandidate, busyConversationId);
  const renameCandidateCompacting = renameCandidate?.compacting === true;
  const renameName = renameDraft.trim();
  const renameBlocked = !actionsEnabled || renameCandidateActive || renameCandidateCompacting;
  const renameUnchanged = renameCandidate
    ? renameName === conversationDisplayTitle(renameCandidate)
    : false;
  const compactingCount = conversations.filter(({ compacting }) => compacting).length;
  const sidebarStyle = {
    "--conversation-sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    resizeState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    event.preventDefault();
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
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
    if (sidebarCollapsed) resizeState.current = undefined;
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (!renameConversationId || renameCandidate) return;
    setRenameConversationId("");
  }, [renameConversationId, renameCandidate]);

  const requestRename = useCallback((conversation: ConversationSummary) => {
    setRenameDraft(
      renamePresentations?.get(conversation.id)?.name
      ?? conversationDisplayTitle(conversation),
    );
    setRenameConversationId(conversation.id);
  }, [renamePresentations]);
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
        {!sidebarCollapsed && compactingCount > 0 && (
          <span
            className="conversation-sidebar-compacting-count"
            role="status"
            aria-label={`正在压缩上下文：${compactingCount} 个会话`}
          >
            {compactingCount} 压缩
          </span>
        )}
        <button
          type="button"
          className="conversation-sidebar-toggle"
          aria-label={sidebarCollapsed ? "展开会话栏" : "收起会话栏"}
          aria-expanded={!sidebarCollapsed}
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
                  renamePresentations={renamePresentations}
                  navigationEnabled={navigationEnabled}
                  actionsEnabled={actionsEnabled}
                  deletionBlocked={deletionBlocked}
                  onSelect={onSelect}
                  onToggleExpanded={toggleExpanded}
                  onRevealIdle={revealIdle}
                  onRequestRename={requestRename}
                  onRequestDelete={requestDelete}
                  onRequestFork={onFork}
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
                renamePresentation={renamePresentations?.get(entry.conversation.id)}
                busy={entry.conversation.id === busyConversationId}
                formatLastActive={formatLastActive}
                onSelect={onSelect}
                onRequestRename={requestRename}
                onRequestDelete={requestDelete}
                onRequestFork={onFork}
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
          disabled={!actionsEnabled}
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
        aria-disabled="false"
        tabIndex={0}
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
            disabled={
              !actionsEnabled
              || deletionBlocked
              || deleteCandidateActive
              || deleteCandidateCompacting
              || deleteCandidateCascadeBlocked
            }
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
          if (onRename(renameCandidate.id, renameName)) closeRenameDialog();
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
