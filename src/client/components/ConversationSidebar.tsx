import {
  useEffect,
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

const DEFAULT_SIDEBAR_WIDTH = 286;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 640;
const SIDEBAR_KEYBOARD_STEP = 16;

function clampSidebarWidth(width: number): number {
  return Math.min(
    MAX_SIDEBAR_WIDTH,
    Math.max(MIN_SIDEBAR_WIDTH, width),
  );
}

export interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  truncated: boolean;
  currentConversationId?: string;
  busyConversationId?: string;
  collapsed: boolean;
  online: boolean;
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
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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

function orderedConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  return conversations
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      const activeDifference =
        Number(activityRank(right.conversation.activity) < 4)
        - Number(activityRank(left.conversation.activity) < 4);
      if (activeDifference !== 0) return activeDifference;

      const attentionDifference =
        Number(Boolean(right.conversation.attention))
        - Number(Boolean(left.conversation.attention));
      if (attentionDifference !== 0) return attentionDifference;

      const activityDifference =
        activityRank(left.conversation.activity)
        - activityRank(right.conversation.activity);
      if (activityDifference !== 0) return activityDifference;

      const updatedDifference =
        Date.parse(right.conversation.updatedAt)
        - Date.parse(left.conversation.updatedAt);
      if (Number.isFinite(updatedDifference) && updatedDifference !== 0) {
        return updatedDifference;
      }
      return left.index - right.index;
    })
    .map(({ conversation }) => conversation);
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
        <span className="conversation-activity-spinner" aria-hidden="true" />
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

function ConversationRow({
  conversation,
  selected,
  online,
  deletionPending,
  deletionBlocked,
  busy,
  onSelect,
  onRequestRename,
  onRequestDelete,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  online: boolean;
  deletionPending: boolean;
  deletionBlocked: boolean;
  busy: boolean;
  onSelect(conversationId: string): void;
  onRequestRename(conversationId: string): void;
  onRequestDelete(conversationId: string): void;
}) {
  const title = titleOf(conversation);
  const active = busy || (conversation.activity?.kind ?? "idle") !== "idle";
  const classes = [
    "conversation-sidebar-item",
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
        disabled={!online || deletionBlocked}
        onClick={() => onSelect(conversation.id)}
      >
        <span className="conversation-sidebar-primary">
          <span className="conversation-sidebar-title">{title}</span>
          <span className="conversation-sidebar-indicators">
            {conversation.createdBy?.kind === "conversation" && (
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
          disabled={!online || deletionBlocked || active}
          title={active ? "活跃会话结算后可以重命名" : "重命名会话"}
          onClick={() => onRequestRename(conversation.id)}
        >
          改名
        </button>
        <button
          type="button"
          className="conversation-sidebar-delete ghost danger"
          aria-label={`删除会话 ${title}`}
          disabled={!online || deletionBlocked || active}
          title={active ? "活跃会话需先终止并等待结算" : "删除会话"}
          onClick={() => onRequestDelete(conversation.id)}
        >
          {deletionPending ? "删除中" : "删除"}
        </button>
      </div>
    </li>
  );
}

export function ConversationSidebar({
  conversations,
  truncated,
  currentConversationId,
  busyConversationId,
  collapsed,
  online,
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
  const deleteCandidate = conversations.find(
    ({ id }) => id === confirmDeleteConversationId,
  );
  const deleteCandidateActive =
    deleteCandidate?.id === busyConversationId
    || (deleteCandidate?.activity?.kind ?? "idle") !== "idle";
  const renameCandidate = conversations.find(
    ({ id }) => id === renameConversationId,
  );
  const renameCandidateActive =
    renameCandidate?.id === busyConversationId
    || (renameCandidate?.activity?.kind ?? "idle") !== "idle";
  const renameName = renameDraft.trim();
  const renameBlocked = !online || renameCandidateActive;
  const renameUnchanged =
    renameCandidate ? renameName === titleOf(renameCandidate) : false;
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

  useEffect(() => {
    if (!confirmDeleteConversationId || deleteCandidate) return;
    setConfirmDeleteConversationId("");
  }, [confirmDeleteConversationId, deleteCandidate]);
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
    if (collapsed) resizeState.current = undefined;
  }, [collapsed]);
  useEffect(() => {
    if (!renameConversationId || renameCandidate) return;
    setRenameConversationId("");
  }, [renameConversationId, renameCandidate]);

  const requestRename = (conversationId: string) => {
    const conversation = conversations.find(({ id }) => id === conversationId);
    if (!conversation) return;
    setRenameDraft(titleOf(conversation));
    setRenameConversationId(conversationId);
  };

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
          onClick={() => onToggleCollapsed(!collapsed)}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </header>

      {!collapsed && (
        <nav className="conversation-sidebar-navigation" aria-label="项目会话">
          <ul className="conversation-sidebar-list">
            {orderedConversations(conversations).map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === currentConversationId}
                online={online}
                deletionPending={pendingDeletionId === conversation.id}
                deletionBlocked={Boolean(pendingDeletionId)}
                busy={conversation.id === busyConversationId}
                onSelect={onSelect}
                onRequestRename={requestRename}
                onRequestDelete={setConfirmDeleteConversationId}
              />
            ))}
          </ul>
          {truncated && <p className="conversation-sidebar-truncated">
            仅显示最近会话
          </p>}
        </nav>
      )}

      <footer className="conversation-sidebar-footer">
        <button
          type="button"
          className="conversation-sidebar-create"
          aria-label="新建会话"
          disabled={!online || Boolean(pendingDeletionId)}
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
        tabIndex={0}
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
            disabled={!online || Boolean(pendingDeletionId) || deleteCandidateActive}
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
