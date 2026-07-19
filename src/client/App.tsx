import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  PROTOCOL_VERSION,
  type AcknowledgedSettingOperation,
  type AuthRequest,
  type ClientCommand,
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type DirectoryListing,
  type PublicState,
  type RoleTemplate,
  type ServerEvent,
  type ThinkingLevel,
  type ToolMode,
} from "../shared/protocol";
import { isToolModeRestriction } from "../shared/tool-mode";
import { chatReducer, initialChatState } from "./chat/reducer";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import { ConnectionDrawer } from "./components/ConnectionDrawer";
import { ConversationSidebar } from "./components/ConversationSidebar";
import { DirectoryBrowserDialog } from "./components/DirectoryBrowserDialog";
import {
  ExtensionDialog,
  type PendingExtensionUI,
} from "./components/ExtensionDialog";
import { Setup } from "./components/Setup";
import {
  RoleManagerDialog,
  type PendingRoleOperation,
  type RoleDraft,
  type RoleOperationResult,
} from "./components/RoleManagerDialog";
import { RoleSelectionPage } from "./components/RoleSelectionPage";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";

const CWD_KEY = "piweb.lastCwd";
const TOOL_MODE_KEY = "piweb.toolMode";

interface PendingPrompt {
  sessionId: string;
  runId: string;
  text: string;
  conversationId?: string;
  focusId?: string;
}

interface PendingConversationDeletion {
  commandId: string;
  conversationId: string;
}

interface PendingConversationTruncation {
  commandId: string;
  conversationId: string;
  messageId: string;
}

interface PendingCompactionThreshold {
  commandId: string;
}

interface DirectoryBrowserState {
  commandId: string;
  listing?: DirectoryListing;
  error: string;
}

interface ActiveFocus {
  sessionId: string;
  projectId: string;
  conversationId: string;
  focusId: string;
}

interface PendingFocus {
  commandId: string;
  operation: "initialize" | "focus_conversation" | "create_conversation";
}

type RoleCommandInput =
  | { type: "create_role"; role: RoleDraft }
  | {
      type: "update_role";
      roleId: string;
      expectedRevision: number;
      role: RoleDraft;
    }
  | {
      type: "delete_role";
      roleId: string;
      expectedRevision: number;
    };

function storedToolMode(): ToolMode {
  return readStoredString(TOOL_MODE_KEY) === "read_only"
    ? "read_only"
    : "full_access";
}

export function App() {
  const [transportOnline, setTransportOnline] = useState(false);
  const [protocolReady, setProtocolReady] = useState(false);
  const [protocolError, setProtocolError] = useState("");
  const [setupCwd, setSetupCwd] = useState(() => readStoredString(CWD_KEY));
  const [activeCwd, setActiveCwd] = useState("");
  const activeCwdRef = useRef("");
  const sessionIdRef = useRef("");
  const projectIdRef = useRef("");
  const conversationIdRef = useRef("");
  const focusRef = useRef<ActiveFocus | undefined>(undefined);
  const pendingFocusRef = useRef<PendingFocus | undefined>(undefined);
  const pendingFocusedStateRef = useRef<PublicState | undefined>(undefined);
  const toolModeRef = useRef<ToolMode>(storedToolMode());
  const confirmedToolModeRef = useRef<ToolMode>(toolModeRef.current);
  const pendingToolModeRef = useRef<ToolMode | undefined>(undefined);
  const authFlowIdRef = useRef("");
  const [draft, setDraft] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt>();
  const pendingPromptRef = useRef<PendingPrompt | undefined>(undefined);
  const [pendingConversationDeletion, setPendingConversationDeletionState] =
    useState<PendingConversationDeletion>();
  const pendingConversationDeletionRef =
    useRef<PendingConversationDeletion | undefined>(undefined);
  const [pendingConversationTruncation, setPendingConversationTruncationState] =
    useState<PendingConversationTruncation>();
  const pendingConversationTruncationRef =
    useRef<PendingConversationTruncation | undefined>(undefined);
  const [pendingCompactionThreshold, setPendingCompactionThresholdState] =
    useState<PendingCompactionThreshold>();
  const pendingCompactionThresholdRef =
    useRef<PendingCompactionThreshold | undefined>(undefined);
  const [directoryBrowser, setDirectoryBrowserState] = useState<DirectoryBrowserState>();
  const directoryBrowserRef = useRef<DirectoryBrowserState | undefined>(undefined);
  const [promptNotice, setPromptNotice] = useState("");
  const [outstandingRunId, setOutstandingRunId] = useState("");
  const outstandingRunIdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [conversationRole, setConversationRole] =
    useState<ConversationRoleSnapshot>();
  const [conversationIndexTruncated, setConversationIndexTruncated] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  const conversationReadyRef = useRef(false);
  const [drawer, setDrawer] = useState(false);
  const [roleManagerOpen, setRoleManagerOpen] = useState(false);
  const [selectingRole, setSelectingRole] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingRoleOperation, setPendingRoleOperation] =
    useState<PendingRoleOperation>();
  const pendingRoleOperationRef = useRef<PendingRoleOperation | undefined>(undefined);
  const [roleOperationResult, setRoleOperationResult] =
    useState<RoleOperationResult>();
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [settingResult, setSettingResult] = useState<{
    operation: AcknowledgedSettingOperation;
    commandId: string;
    ok: boolean;
    message: string;
  }>();
  const [auth, setAuth] = useState<{ requestId?: string; request?: AuthRequest; progress?: string }>({});
  const [extensionUI, setExtensionUI] = useState<PendingExtensionUI[]>([]);
  const [notification, setNotification] = useState<{
    id: number;
    level: "info" | "warning" | "error";
    message: string;
  }>();
  const notificationIdRef = useRef(0);
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const socketRef = useRef<PiSocket | undefined>(undefined);
  const socketEpochRef = useRef(0);
  const autoOpened = useRef(false);

  const updateOutstandingRunId = (runId: string) => {
    outstandingRunIdRef.current = runId;
    setOutstandingRunId(runId);
  };
  const updatePendingPrompt = (prompt: PendingPrompt | undefined) => {
    pendingPromptRef.current = prompt;
    setPendingPrompt(prompt);
  };
  const updatePendingConversationDeletion = (
    pending: PendingConversationDeletion | undefined,
  ) => {
    pendingConversationDeletionRef.current = pending;
    setPendingConversationDeletionState(pending);
  };
  const updatePendingConversationTruncation = (
    pending: PendingConversationTruncation | undefined,
  ) => {
    pendingConversationTruncationRef.current = pending;
    setPendingConversationTruncationState(pending);
  };
  const updatePendingCompactionThreshold = (
    pending: PendingCompactionThreshold | undefined,
  ) => {
    pendingCompactionThresholdRef.current = pending;
    setPendingCompactionThresholdState(pending);
  };
  const updateDirectoryBrowser = (next: DirectoryBrowserState | undefined) => {
    directoryBrowserRef.current = next;
    setDirectoryBrowserState(next);
  };
  const updatePendingFocus = (pending: PendingFocus | undefined) => {
    if (pending) pendingFocusedStateRef.current = undefined;
    pendingFocusRef.current = pending;
    setCreatingConversation(pending?.operation === "create_conversation");
  };
  const updatePendingRoleOperation = (
    pending: PendingRoleOperation | undefined,
  ) => {
    pendingRoleOperationRef.current = pending;
    setPendingRoleOperation(pending);
  };
  const matchesFocus = (
    sessionId: string,
    conversationId: string | undefined,
    focusId: string | undefined,
  ) => {
    const focus = focusRef.current;
    if (!focus) {
      return sessionId === sessionIdRef.current
        && conversationId === conversationIdRef.current
        && focusId === undefined;
    }
    return sessionId === focus.sessionId
      && conversationId === focus.conversationId
      && focusId === focus.focusId;
  };
  const attachFocus = (
    sessionId: string,
    projectId: string,
    conversationId: string | undefined,
    focusId: string | undefined,
  ) => {
    updatePendingCompactionThreshold(undefined);
    updatePendingConversationTruncation(undefined);
    projectIdRef.current = projectId;
    if (!conversationId || !focusId) {
      focusRef.current = undefined;
      conversationIdRef.current = "";
      setConversationRole(undefined);
      setHistoryTruncated(false);
      updateConversationReady(false);
      setSelectingRole(true);
      dispatch({ type: "reset" });
      return;
    }
    const changedConversation = conversationIdRef.current !== conversationId;
    const focus = { sessionId, projectId, conversationId, focusId };
    focusRef.current = focus;
    conversationIdRef.current = conversationId;
    setConversationRole(undefined);
    setHistoryTruncated(false);
    updateConversationReady(false);
    setSelectingRole(false);
    if (changedConversation) {
      setDraft("");
      setPromptNotice("");
      updatePendingPrompt(undefined);
    }
    updateOutstandingRunId("");
    dispatch({ type: "focus_changed", ...focus });
  };
  const acceptPendingPrompt = (sessionId: string, runId: string) => {
    const pending = pendingPromptRef.current;
    if (
      !pending
      || pending.sessionId !== sessionId
      || pending.runId !== runId
      || pending.conversationId !== focusRef.current?.conversationId
      || pending.focusId !== focusRef.current?.focusId
    ) return;
    dispatch({
      type: "prompt_accepted",
      runId,
      text: pending.text,
      ...(focusRef.current ?? {}),
    });
    setDraft("");
    setPromptNotice("");
    updatePendingPrompt(undefined);
  };
  const markPendingPromptUnconfirmed = () => {
    if (!pendingPromptRef.current) return;
    updatePendingPrompt(undefined);
    setPromptNotice(
      "发送状态未确认。内容已保留；请先查看恢复后的对话，确认没有出现后再重试。",
    );
  };
  const updateConversationReady = (ready: boolean) => {
    conversationReadyRef.current = ready;
    setConversationReady(ready);
  };
  const clearSessionProjection = () => {
    setState(undefined);
    setConversations([]);
    setRoles([]);
    setConversationRole(undefined);
    setConversationIndexTruncated(false);
    setHistoryTruncated(false);
    setExtensionUI([]);
    setNotification(undefined);
    setSettingResult(undefined);
    updatePendingCompactionThreshold(undefined);
    updatePendingConversationTruncation(undefined);
    setRoleOperationResult(undefined);
    updatePendingRoleOperation(undefined);
    setSettingsDialogOpen(false);
    setRoleManagerOpen(false);
    setSelectingRole(false);
    updatePendingFocus(undefined);
    pendingFocusedStateRef.current = undefined;
    focusRef.current = undefined;
    projectIdRef.current = "";
    updateConversationReady(false);
  };
  const applyPublicState = (nextState: PublicState) => {
    const currentFocus = focusRef.current;
    if (nextState.conversationId !== conversationIdRef.current) {
      updateConversationReady(false);
    }
    setState(nextState);
    projectIdRef.current = nextState.projectId;
    if (!currentFocus) {
      conversationIdRef.current = nextState.conversationId ?? "";
      setSelectingRole(!nextState.conversationId);
    }
    if (nextState.activeRun?.id === outstandingRunIdRef.current) {
      updateOutstandingRunId("");
    }
    setActiveCwd(nextState.cwd);
    activeCwdRef.current = nextState.cwd;
    setSetupCwd(nextState.cwd);
    writeStoredString(CWD_KEY, nextState.cwd);
    confirmedToolModeRef.current = nextState.toolMode;
    if (pendingToolModeRef.current === nextState.toolMode) {
      pendingToolModeRef.current = undefined;
    }
    const pendingToolMode = pendingToolModeRef.current;
    const reconnectMode = pendingToolMode
      && isToolModeRestriction(nextState.toolMode, pendingToolMode)
      ? pendingToolMode
      : nextState.toolMode;
    toolModeRef.current = reconnectMode;
    writeStoredString(TOOL_MODE_KEY, reconnectMode);
    setError(nextState.registryError ?? "");
    if (
      nextState.conversationId
      && !nextState.selectedModel
      && !autoOpened.current
    ) {
      autoOpened.current = true;
      setDrawer(true);
    }
  };

  useEffect(() => {
    const epoch = ++socketEpochRef.current;
    const isCurrentSocket = () => socketEpochRef.current === epoch;
    const socket = new PiSocket((event: ServerEvent) => {
      if (!isCurrentSocket()) return;
      if (event.type === "hello") {
        if (event.protocolVersion !== PROTOCOL_VERSION) {
          const message = `协议版本不兼容：服务端 ${event.protocolVersion}，客户端 ${PROTOCOL_VERSION}`;
          setProtocolReady(false);
          setTransportOnline(false);
          setProtocolError(message);
          sessionIdRef.current = "";
          projectIdRef.current = "";
          conversationIdRef.current = "";
          focusRef.current = undefined;
          authFlowIdRef.current = "";
          updateDirectoryBrowser(undefined);
          markPendingPromptUnconfirmed();
          updatePendingConversationDeletion(undefined);
          updatePendingConversationTruncation(undefined);
          updateOutstandingRunId("");
          setAuth({});
          clearSessionProjection();
          dispatch({ type: "reset" });
          setError(message);
          socket.close();
          return;
        }
        setProtocolError("");
        setProtocolReady(true);
        setSetupCwd((current) => current || event.startupCwd);
        if (activeCwdRef.current) {
          const sessionId = crypto.randomUUID();
          const commandId = crypto.randomUUID();
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          updateOutstandingRunId("");
          setAuth({});
          dispatch({ type: "reset" });
          clearSessionProjection();
          updatePendingFocus({ commandId, operation: "initialize" });
          socket.send({
            type: "initialize",
            commandId,
            sessionId,
            cwd: activeCwdRef.current,
            toolMode: toolModeRef.current,
            conversation: conversationIdRef.current
              ? { kind: "open", conversationId: conversationIdRef.current }
              : { kind: "recent" },
          });
        }
      } else if (event.type === "directory_listing") {
        const current = directoryBrowserRef.current;
        if (!current || event.commandId !== current.commandId) return;
        updateDirectoryBrowser({
          commandId: "",
          error: "",
          listing: {
            path: event.path,
            parentPath: event.parentPath,
            directories: event.directories,
            truncated: event.truncated,
          },
        });
      } else if (event.type === "state") {
        if (!sessionIdRef.current || event.state.sessionId !== sessionIdRef.current) return;
        const currentFocus = focusRef.current;
        if (
          currentFocus
          && (
            event.state.conversationId !== currentFocus.conversationId
            || event.state.focusId !== currentFocus.focusId
          )
        ) {
          if (pendingFocusRef.current && event.state.conversationId && event.state.focusId) {
            pendingFocusedStateRef.current = event.state;
          }
          return;
        }
        if (
          !currentFocus
          && event.state.focusId
          && event.state.conversationId
        ) {
          if (pendingFocusRef.current) pendingFocusedStateRef.current = event.state;
          return;
        }
        applyPublicState(event.state);
      } else if (event.type === "focus_attached") {
        if (event.sessionId !== sessionIdRef.current) return;
        const pending = pendingFocusRef.current;
        if (
          !pending
          || pending.commandId !== event.commandId
          || pending.operation !== event.operation
        ) return;
        updatePendingFocus(undefined);
        attachFocus(
          event.sessionId,
          event.projectId,
          event.conversationId,
          event.focusId,
        );
        const pendingState = pendingFocusedStateRef.current;
        pendingFocusedStateRef.current = undefined;
        if (
          pendingState
          && pendingState.sessionId === event.sessionId
          && pendingState.projectId === event.projectId
          && pendingState.conversationId === event.conversationId
          && pendingState.focusId === event.focusId
        ) {
          applyPublicState(pendingState);
        } else {
          setState((current) => current
            ? {
                ...current,
                projectId: event.projectId,
                ...(event.conversationId && event.focusId
                  ? {
                      conversationId: event.conversationId,
                      focusId: event.focusId,
                    }
                  : {
                      conversationId: undefined,
                      focusId: undefined,
                      conversationName: undefined,
                      selectedModel: undefined,
                      activeRun: undefined,
                      busy: false,
                    }),
              }
            : current);
        }
      } else if (event.type === "focus_invalidated") {
        const focus = focusRef.current;
        if (
          !focus
          || event.sessionId !== sessionIdRef.current
          || event.sessionId !== focus.sessionId
          || event.projectId !== focus.projectId
          || event.conversationId !== focus.conversationId
          || event.focusId !== focus.focusId
        ) return;
        attachFocus(
          event.sessionId,
          event.projectId,
          undefined,
          undefined,
        );
        setState((current) => current
          ? {
              ...current,
              conversationId: undefined,
              focusId: undefined,
              conversationName: undefined,
              selectedModel: undefined,
              activeRun: undefined,
              busy: false,
            }
          : current);
        setDraft("");
        setPromptNotice("");
        updatePendingPrompt(undefined);
        updateOutstandingRunId("");
        setExtensionUI([]);
      } else if (event.type === "role_catalog_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || (projectIdRef.current && event.projectId !== projectIdRef.current)
        ) return;
        projectIdRef.current = event.projectId;
        setRoles(event.roles);
      } else if (event.type === "project_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || (projectIdRef.current && event.projectId !== projectIdRef.current)
        ) return;
        projectIdRef.current = event.projectId;
        setConversations(event.conversations);
        setConversationIndexTruncated(event.truncated);
      } else if (event.type === "conversation_snapshot") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (focus) {
          dispatch({
            type: "hydrate",
            sessionId: focus.sessionId,
            conversationId: focus.conversationId,
            focusId: focus.focusId,
            items: event.items
              ?? (event.messages ?? []).map((message) => ({
                kind: "message" as const,
                ...message,
              })),
          });
        } else {
          dispatch({ type: "hydrate", messages: event.messages ?? [] });
        }
        setConversationRole(event.role);
        setHistoryTruncated(event.truncated);
        updateConversationReady(true);
      } else if (event.type === "session_event") {
        if (!matchesFocus(
          event.sessionId,
          event.conversationId,
          event.focusId,
        )) return;
        if (event.event.type === "run_queued") {
          acceptPendingPrompt(event.sessionId, event.runId);
        }
        if (event.event.type === "run_finished" && event.runId === outstandingRunIdRef.current) {
          updateOutstandingRunId("");
        }
        dispatch({
          type: "session",
          runId: event.runId,
          event: event.event,
          ...(focusRef.current ?? {}),
        });
      } else if (event.type === "conversation_item") {
        if (!matchesFocus(event.sessionId, event.conversationId, event.focusId)) return;
        const focus = focusRef.current;
        if (!focus) return;
        dispatch({
          type: "conversation_item",
          sessionId: focus.sessionId,
          conversationId: focus.conversationId,
          focusId: focus.focusId,
          item: event.item,
        });
      } else if (event.type === "extension_ui_request") {
        if (event.sessionId !== sessionIdRef.current) return;
        setExtensionUI((current) => (
          current.some(({ requestId }) => requestId === event.requestId)
            ? current
            : [...current, { requestId: event.requestId, request: event.request }]
        ));
      } else if (event.type === "extension_ui_closed") {
        if (event.sessionId !== sessionIdRef.current) return;
        setExtensionUI((current) => current.filter(
          ({ requestId }) => requestId !== event.requestId,
        ));
      } else if (event.type === "extension_ui_notification") {
        if (event.sessionId !== sessionIdRef.current) return;
        setNotification({
          id: ++notificationIdRef.current,
          level: event.level,
          message: event.message,
        });
      } else if (event.type === "auth_request") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        setAuth((current) => ({ ...current, requestId: event.requestId, request: event.request }));
      } else if (event.type === "auth_progress") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        setAuth((current) => ({ ...current, progress: event.message }));
      } else if (event.type === "auth_complete") {
        if (event.authFlowId !== authFlowIdRef.current) return;
        authFlowIdRef.current = "";
        setAuth({});
      } else if (event.type === "command_complete") {
        if (event.sessionId !== sessionIdRef.current) return;
        if (event.operation === "set_compaction_threshold") {
          const pending = pendingCompactionThresholdRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCompactionThreshold(undefined);
          return;
        }
        if (event.operation === "delete_conversation") {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          if (focusRef.current?.conversationId === pending.conversationId) {
            attachFocus(
              event.sessionId,
              projectIdRef.current,
              undefined,
              undefined,
            );
            setState((current) => current
              ? {
                  ...current,
                  conversationId: undefined,
                  focusId: undefined,
                  conversationName: undefined,
                  selectedModel: undefined,
                  activeRun: undefined,
                  busy: false,
                }
              : current);
            setDraft("");
            setPromptNotice("");
            updatePendingPrompt(undefined);
            setExtensionUI([]);
          }
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "对话已删除",
          });
          return;
        }
        if (event.operation === "truncate_conversation") {
          const pending = pendingConversationTruncationRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationTruncation(undefined);
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "已回到所选消息之前",
          });
          return;
        }
        if (
          event.operation === "create_role"
          || event.operation === "update_role"
          || event.operation === "delete_role"
        ) {
          const pending = pendingRoleOperationRef.current;
          if (
            !pending
            || pending.operation !== event.operation
            || pending.commandId !== event.commandId
          ) return;
          pendingRoleOperationRef.current = undefined;
          setRoleOperationResult({
            ...pending,
            ok: true,
            message: event.operation === "delete_role"
              ? "角色已删除"
              : "角色已保存",
          });
          return;
        }
        setSettingResult({
          operation: event.operation,
          commandId: event.commandId,
          ok: true,
          message: "",
        });
      } else if (event.type === "error") {
        if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
        if (
          (event.conversationId !== undefined || event.focusId !== undefined)
          && (
            event.sessionId === undefined
            || !matchesFocus(
              event.sessionId,
              event.conversationId,
              event.focusId,
            )
          )
        ) return;
        if (event.authFlowId && event.authFlowId !== authFlowIdRef.current) return;
        if (event.operation === "browse_directory") {
          const current = directoryBrowserRef.current;
          if (!current || event.commandId !== current.commandId) return;
          updateDirectoryBrowser({
            ...current,
            commandId: "",
            error: event.message,
          });
          return;
        }
        if (
          event.operation === "set_compaction_threshold"
          && event.commandId
        ) {
          const pending = pendingCompactionThresholdRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingCompactionThreshold(undefined);
          setError(`修改自动压缩阈值失败：${event.message}`);
          return;
        }
        if (
          event.operation === "delete_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          setError(`删除对话失败：${event.message}`);
          return;
        }
        if (
          event.operation === "truncate_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationTruncationRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationTruncation(undefined);
          setError(`回到此处失败：${event.message}`);
          return;
        }
        if (
          (event.operation === "initialize"
            || event.operation === "focus_conversation"
            || event.operation === "create_conversation")
          && event.commandId
        ) {
          const pending = pendingFocusRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.operation !== event.operation
          ) return;
          updatePendingFocus(undefined);
          setError(event.message);
          return;
        }
        if (
          (event.operation === "create_role"
            || event.operation === "update_role"
            || event.operation === "delete_role")
          && event.commandId
        ) {
          const pending = pendingRoleOperationRef.current;
          if (
            !pending
            || pending.commandId !== event.commandId
            || pending.operation !== event.operation
          ) return;
          pendingRoleOperationRef.current = undefined;
          setRoleOperationResult({
            ...pending,
            ok: false,
            message: event.message,
          });
          return;
        }
        let promptRejectedBeforeAcceptance = false;
        if (
          event.scope === "command"
          && event.operation === "prompt"
          && event.runId
        ) {
          const pending = pendingPromptRef.current;
          if (
            pending
            && pending.sessionId === sessionIdRef.current
            && pending.runId === event.runId
            && pending.conversationId === event.conversationId
            && pending.focusId === event.focusId
          ) {
            promptRejectedBeforeAcceptance = true;
            updatePendingPrompt(undefined);
            setPromptNotice(
              `消息未被服务端接收：${event.message}。内容已保留，可以修改后重试。`,
            );
          }
        }
        if (
          event.commandId
          && (event.operation === "set_api_key" || event.operation === "select_model")
        ) {
          if (!event.sessionId) {
            setError("设置命令响应缺少会话标识");
            return;
          }
          setSettingResult({
            operation: event.operation,
            commandId: event.commandId,
            ok: false,
            message: event.message,
          });
        } else {
          setError(event.message);
        }
        if (event.operation === "login_oauth" && event.authFlowId === authFlowIdRef.current) {
          authFlowIdRef.current = "";
          setAuth({});
        }
        if (event.scope === "command" && event.operation === "prompt" && activeCwdRef.current) {
          if (event.runId === outstandingRunIdRef.current) updateOutstandingRunId("");
          if (
            event.runId
            && event.sessionId
            && event.conversationId
            && event.focusId
            && !promptRejectedBeforeAcceptance
          ) {
            dispatch({
              type: "error",
              runId: event.runId,
              message: event.message,
              sessionId: event.sessionId,
              conversationId: event.conversationId,
              focusId: event.focusId,
            });
          }
        }
      }
    }, (connected) => {
      if (!isCurrentSocket()) return;
      setTransportOnline(connected);
      if (!connected) {
        setProtocolReady(false);
        setSettingResult(undefined);
        updateDirectoryBrowser(undefined);
        markPendingPromptUnconfirmed();
        if (pendingConversationDeletionRef.current) {
          updatePendingConversationDeletion(undefined);
          setError("删除状态未确认，请检查项目对话列表后重试。");
        }
        if (pendingConversationTruncationRef.current) {
          updatePendingConversationTruncation(undefined);
          setError("回到此处的状态未确认，请检查恢复后的对话再重试。");
        }
        updateOutstandingRunId("");
        authFlowIdRef.current = "";
        setAuth({});
        setExtensionUI([]);
        setNotification(undefined);
        updateConversationReady(false);
      }
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      if (socketEpochRef.current === epoch) socketEpochRef.current++;
      socket.close();
    };
  }, []);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => {
      setNotification((current) => current?.id === notification.id ? undefined : current);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [notification]);

  const send = (command: ClientCommand): boolean => {
    if (!protocolReady) {
      setError("本地服务尚未完成协议握手");
      return false;
    }
    const ok = socketRef.current?.send(command) ?? false;
    if (!ok) setError("本地服务未连接");
    return ok;
  };
  const clearSettingResult = useCallback(() => setSettingResult(undefined), []);
  const browseDirectory = (path?: string) => {
    const current = directoryBrowserRef.current;
    const commandId = crypto.randomUUID();
    const next: DirectoryBrowserState = {
      commandId,
      listing: current?.listing,
      error: "",
    };
    updateDirectoryBrowser(next);
    setError("");
    if (!send({
      type: "browse_directory",
      commandId,
      ...(path ? { path } : {}),
    })) {
      updateDirectoryBrowser({
        ...next,
        commandId: "",
        error: "本地服务未连接",
      });
    }
  };
  const openDirectoryBrowser = () => {
    const path = setupCwd.trim();
    browseDirectory(path || undefined);
  };
  const initialize = (
    cwd: string,
    conversation: Extract<ClientCommand, { type: "initialize" }>["conversation"] = {
      kind: "recent",
    },
  ) => {
    const sessionId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    setError("");
    setDraft("");
    setPromptNotice("");
    updatePendingPrompt(undefined);
    clearSessionProjection();
    setActiveCwd(cwd);
    activeCwdRef.current = cwd;
    sessionIdRef.current = sessionId;
    projectIdRef.current = "";
    focusRef.current = undefined;
    conversationIdRef.current = conversation?.kind === "open"
      ? conversation.conversationId
      : "";
    authFlowIdRef.current = "";
    updateOutstandingRunId("");
    setAuth({});
    autoOpened.current = false;
    dispatch({ type: "reset" });
    updatePendingFocus({ commandId, operation: "initialize" });
    send({
      type: "initialize",
      commandId,
      sessionId,
      cwd,
      toolMode: toolModeRef.current,
      conversation,
    });
  };
  const sendPrompt = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!conversationReadyRef.current) return false;
    if (pendingConversationTruncationRef.current) return false;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (!sessionId || !focus) return false;
    if (focus && focus.sessionId !== sessionId) return false;
    const runId = crypto.randomUUID();
    const pending = {
      sessionId,
      runId,
      text: trimmed,
      conversationId: focus?.conversationId,
      focusId: focus?.focusId,
    };
    setPromptNotice("");
    updatePendingPrompt(pending);
    updateOutstandingRunId(runId);
    const ok = send({
      type: "prompt",
      sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      runId,
      text: trimmed,
    });
    if (!ok) {
      updatePendingPrompt(undefined);
      updateOutstandingRunId("");
      setPromptNotice("消息未发送，内容已保留，可以重试。");
    }
    return ok;
  };
  const abortCurrentRun = () => {
    const runId = outstandingRunIdRef.current || state?.activeRun?.id;
    const sessionId = sessionIdRef.current;
    const focus = focusRef.current;
    if (sessionId && runId && focus) {
      send({
        type: "abort",
        sessionId,
        conversationId: focus.conversationId,
        focusId: focus.focusId,
        runId,
      });
    }
  };
  const focusConversation = (conversationId: string) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || pendingFocusRef.current
      || pendingConversationTruncationRef.current
    ) return;
    if (focusRef.current?.conversationId === conversationId) {
      setSelectingRole(false);
      return;
    }
    const commandId = crypto.randomUUID();
    updatePendingFocus({ commandId, operation: "focus_conversation" });
    setError("");
    if (!send({
      type: "focus_conversation",
      commandId,
      sessionId,
      conversationId,
    })) {
      updatePendingFocus(undefined);
    }
  };
  const createConversation = (roleId: string) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || pendingFocusRef.current
      || pendingConversationTruncationRef.current
    ) return;
    const commandId = crypto.randomUUID();
    updatePendingFocus({ commandId, operation: "create_conversation" });
    setError("");
    if (!send({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId,
    })) {
      updatePendingFocus(undefined);
    }
  };
  const deleteConversation = (conversationId: string): boolean => {
    const sessionId = sessionIdRef.current;
    const conversation = conversations.find(({ id }) => id === conversationId);
    const deletingFocusedConversation =
      focusRef.current?.conversationId === conversationId;
    if (
      !sessionId
      || !conversation
      || (conversation.activity?.kind ?? "idle") !== "idle"
      || (
        deletingFocusedConversation
        && (Boolean(state?.busy) || Boolean(outstandingRunIdRef.current))
      )
      || pendingConversationDeletionRef.current
      || pendingConversationTruncationRef.current
    ) {
      return false;
    }
    const commandId = crypto.randomUUID();
    const pending = { commandId, conversationId };
    updatePendingConversationDeletion(pending);
    setError("");
    if (send({
      type: "delete_conversation",
      commandId,
      sessionId,
      conversationId,
    })) {
      return true;
    }
    updatePendingConversationDeletion(undefined);
    return false;
  };
  const renameConversation = (conversationId: string, name: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    send({
      type: "rename_conversation",
      sessionId,
      conversationId,
      name,
    });
  };
  const truncateConversation = (messageId: string): boolean => {
    const focus = focusRef.current;
    if (
      !focus
      || !conversationReadyRef.current
      || Boolean(state?.busy)
      || Boolean(outstandingRunIdRef.current)
      || Boolean(pendingPromptRef.current)
      || Boolean(pendingConversationTruncationRef.current)
      || Boolean(pendingConversationDeletionRef.current)
    ) {
      return false;
    }
    const commandId = crypto.randomUUID();
    const pending = {
      commandId,
      conversationId: focus.conversationId,
      messageId,
    };
    updatePendingConversationTruncation(pending);
    setError("");
    if (send({
      type: "truncate_conversation",
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      messageId,
    })) {
      return true;
    }
    updatePendingConversationTruncation(undefined);
    return false;
  };
  const setThinkingLevel = (level: ThinkingLevel) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "set_thinking", sessionId, level });
  };
  const setCompactionThreshold = (percent: number): boolean => {
    const focus = focusRef.current;
    if (!focus || pendingCompactionThresholdRef.current) return false;
    const commandId = crypto.randomUUID();
    updatePendingCompactionThreshold({
      commandId,
    });
    if (send({
      type: "set_compaction_threshold",
      commandId,
      sessionId: focus.sessionId,
      conversationId: focus.conversationId,
      focusId: focus.focusId,
      percent,
    })) return true;
    updatePendingCompactionThreshold(undefined);
    return false;
  };
  const setProjectToolMode = (mode: ToolMode) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    pendingToolModeRef.current = mode;
    const restrictive = isToolModeRestriction(
      confirmedToolModeRef.current,
      mode,
    );
    if (restrictive) {
      toolModeRef.current = mode;
      writeStoredString(TOOL_MODE_KEY, mode);
    }
    if (!send({ type: "set_tool_mode", sessionId, mode }) && !restrictive) {
      pendingToolModeRef.current = undefined;
    }
  };
  const beginRoleOperation = (
    operation: PendingRoleOperation["operation"],
    command: RoleCommandInput,
  ) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || pendingRoleOperationRef.current) return;
    const commandId = crypto.randomUUID();
    const pending = { operation, commandId };
    updatePendingRoleOperation(pending);
    setRoleOperationResult(undefined);
    setError("");
    if (!send({ ...command, commandId, sessionId } as ClientCommand)) {
      updatePendingRoleOperation(undefined);
    }
  };
  const closeProject = () => {
    const sessionId = sessionIdRef.current;
    if (sessionId) send({ type: "close_session", sessionId });
    activeCwdRef.current = "";
    sessionIdRef.current = "";
    projectIdRef.current = "";
    conversationIdRef.current = "";
    focusRef.current = undefined;
    authFlowIdRef.current = "";
    setDraft("");
    setPromptNotice("");
    updatePendingPrompt(undefined);
    updatePendingConversationDeletion(undefined);
    updatePendingConversationTruncation(undefined);
    updateOutstandingRunId("");
    setAuth({});
    setActiveCwd("");
    clearSessionProjection();
    autoOpened.current = false;
    dispatch({ type: "reset" });
  };
  const online = transportOnline && protocolReady;
  const authModalVisible = Boolean(auth.request || auth.progress);
  const extensionPending = online
    && !authModalVisible
    && !settingsDialogOpen
    ? extensionUI[0]
    : undefined;
  const blockingModalVisible = Boolean(
    authModalVisible
    || extensionPending,
  );
  const extensionDialog = <ExtensionDialog
    pending={extensionUI[0]}
    pendingCount={extensionUI.length}
    online={online}
    visible={Boolean(extensionPending)}
    onRespond={(requestId, response) => {
      const sessionId = sessionIdRef.current;
      return Boolean(
        sessionId
        && send({
          type: "extension_ui_response",
          sessionId,
          requestId,
          response,
        }),
      );
    }}
  />;
  const feedback = (notification || error) && <div className="toast-stack">
    {notification && <div
      className={`toast notice-toast ${notification.level}`}
      role="status"
    >
      {notification.message}
    </div>}
    {error && <div className="toast error-toast" role="alert">
      <span>{error}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭错误"
        onClick={() => setError("")}
      >×</button>
    </div>}
  </div>;

  if (!activeCwd || !state) return <>
    <Setup
      cwd={setupCwd}
      online={online}
      pickingDirectory={Boolean(directoryBrowser)}
      unavailableLabel={protocolError ? "协议不兼容" : undefined}
      onCwdChange={setSetupCwd}
      onPickDirectory={openDirectoryBrowser}
      onStart={initialize}
    />
    {directoryBrowser && <DirectoryBrowserDialog
      listing={directoryBrowser.listing}
      loading={Boolean(directoryBrowser.commandId)}
      error={directoryBrowser.error || undefined}
      online={online}
      onNavigate={browseDirectory}
      onOpenStartup={() => browseDirectory()}
      onSelect={(path) => {
        setSetupCwd(path);
        updateDirectoryBrowser(undefined);
      }}
      onClose={() => updateDirectoryBrowser(undefined)}
    />}
    {extensionDialog}
    {feedback}
  </>;

  const showRoleSelection = selectingRole || !state.conversationId;

  return <>
    <div className="workbench">
      <ConversationSidebar
        conversations={conversations}
        truncated={conversationIndexTruncated}
        currentConversationId={showRoleSelection
          ? undefined
          : state.conversationId}
        busyConversationId={
          state.busy || outstandingRunId ? state.conversationId : undefined
        }
        collapsed={sidebarCollapsed}
        online={online}
        pendingDeletionId={pendingConversationDeletion?.conversationId}
        onToggleCollapsed={setSidebarCollapsed}
        onSelect={focusConversation}
        onCreate={() => setSelectingRole(true)}
        onRename={renameConversation}
        onDelete={deleteConversation}
      />
      <div className="workbench-main">
        {showRoleSelection
          ? <RoleSelectionPage
              roles={roles}
              pending={creatingConversation}
              toolMode={state.toolMode}
              toolModeBusy={state.busy || Boolean(outstandingRunId)}
              onStart={createConversation}
              onManageRoles={() => setRoleManagerOpen(true)}
              onSettings={() => setDrawer(true)}
              onToolMode={setProjectToolMode}
              onChangeProject={closeProject}
            />
          : <Chat
              chat={chat}
              historyTruncated={historyTruncated}
              busy={state.busy || Boolean(outstandingRunId)}
              sessionTokenUsage={state.sessionTokenUsage}
              contextTokenCount={state.contextUsage?.tokens}
              contextWindow={state.contextUsage?.contextWindow}
              contextPercent={state.contextUsage?.percent}
              contextSource={state.contextUsage?.source}
              model={state.selectedModel}
              role={conversationRole}
              thinkingLevel={state.thinkingLevel}
              availableThinkingLevels={state.availableThinkingLevels}
              compactionThresholdPercent={
                state.compactionThresholdPercent
                ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT
              }
              compactionThresholdBusy={Boolean(pendingCompactionThreshold)}
              toolMode={state.toolMode}
              toolModeBusy={state.busy || Boolean(outstandingRunId)}
              cwd={state.cwd}
              online={online}
              conversationReady={conversationReady}
              draft={draft}
              submitting={Boolean(pendingPrompt)}
              promptNotice={promptNotice || undefined}
              onDraftChange={(text) => {
                setDraft(text);
                if (promptNotice) setPromptNotice("");
              }}
              onSend={sendPrompt}
              onAbort={abortCurrentRun}
              onSettings={() => setDrawer(true)}
              onThinking={setThinkingLevel}
              onCompactionThreshold={setCompactionThreshold}
              onToolMode={setProjectToolMode}
              onChangeCwd={closeProject}
              onOpenConversation={focusConversation}
              onRewind={truncateConversation}
              rewindingMessageId={pendingConversationTruncation?.messageId}
            />}
      </div>
    </div>
    <ConnectionDrawer
      state={state}
      open={drawer && !blockingModalVisible}
      online={online}
      settingResult={settingResult}
      onClose={() => setDrawer(false)}
      onKey={(provider, key) => {
        const commandId = crypto.randomUUID();
        const sessionId = sessionIdRef.current;
        if (!sessionId) return undefined;
        setSettingResult(undefined);
        return send({ type: "set_api_key", commandId, sessionId, provider, key })
          ? commandId
          : undefined;
      }}
      onOAuth={(provider) => {
        const authFlowId = crypto.randomUUID();
        authFlowIdRef.current = authFlowId;
        setAuth({ progress: "正在启动登录…" });
        if (!send({ type: "login_oauth", authFlowId, provider })) {
          authFlowIdRef.current = "";
          setAuth({});
        }
      }}
      onLogout={(provider) => send({ type: "logout", provider })}
      onRefresh={() => send({ type: "refresh_models" })}
      onClearSettingResult={clearSettingResult}
      onKeyDialogChange={setSettingsDialogOpen}
    />
    <RoleManagerDialog
      open={roleManagerOpen && !blockingModalVisible}
      roles={roles}
      providers={state.providers}
      pending={pendingRoleOperation}
      result={roleOperationResult}
      onClose={() => {
        setRoleManagerOpen(false);
        updatePendingRoleOperation(undefined);
        setRoleOperationResult(undefined);
      }}
      onCreate={(role: RoleDraft) => beginRoleOperation(
        "create_role",
        { type: "create_role", role },
      )}
      onUpdate={(roleId, expectedRevision, role: RoleDraft) =>
        beginRoleOperation("update_role", {
          type: "update_role",
          roleId,
          expectedRevision,
          role,
        })}
      onDelete={(roleId, expectedRevision) =>
        beginRoleOperation("delete_role", {
          type: "delete_role",
          roleId,
          expectedRevision,
        })}
    />
    <AuthDialog {...auth} visible={authModalVisible} onRespond={(requestId, response) => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "auth_response", authFlowId, requestId, ...response });
    }} onCancel={() => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "cancel_auth", authFlowId });
      authFlowIdRef.current = "";
      setAuth({});
    }} />
    {extensionDialog}
    {feedback}
  </>;
}
