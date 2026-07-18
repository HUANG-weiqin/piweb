import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  PROTOCOL_VERSION,
  type AcknowledgedSettingOperation,
  type AuthRequest,
  type ClientCommand,
  type ConversationSummary,
  type DirectoryListing,
  type PublicState,
  type ServerEvent,
  type ThinkingLevel,
  type ToolMode,
} from "../shared/protocol";
import { isToolModeRestriction } from "../shared/tool-mode";
import { chatReducer, initialChatState } from "./chat/reducer";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import { ConnectionDrawer } from "./components/ConnectionDrawer";
import { DirectoryBrowserDialog } from "./components/DirectoryBrowserDialog";
import {
  ExtensionDialog,
  type PendingExtensionUI,
} from "./components/ExtensionDialog";
import { Setup } from "./components/Setup";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";

const CWD_KEY = "piweb.lastCwd";
const TOOL_MODE_KEY = "piweb.toolMode";

interface PendingPrompt {
  sessionId: string;
  runId: string;
  text: string;
}

interface PendingConversationDeletion {
  commandId: string;
  conversationId: string;
}

interface DirectoryBrowserState {
  commandId: string;
  listing?: DirectoryListing;
  error: string;
}

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
  const conversationIdRef = useRef("");
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
  const [directoryBrowser, setDirectoryBrowserState] = useState<DirectoryBrowserState>();
  const directoryBrowserRef = useRef<DirectoryBrowserState | undefined>(undefined);
  const [promptNotice, setPromptNotice] = useState("");
  const [outstandingRunId, setOutstandingRunId] = useState("");
  const outstandingRunIdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationIndexTruncated, setConversationIndexTruncated] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  const conversationReadyRef = useRef(false);
  const [drawer, setDrawer] = useState(false);
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
  const updateDirectoryBrowser = (next: DirectoryBrowserState | undefined) => {
    directoryBrowserRef.current = next;
    setDirectoryBrowserState(next);
  };
  const acceptPendingPrompt = (sessionId: string, runId: string) => {
    const pending = pendingPromptRef.current;
    if (
      !pending
      || pending.sessionId !== sessionId
      || pending.runId !== runId
    ) return;
    dispatch({ type: "prompt_accepted", runId, text: pending.text });
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
    setConversationIndexTruncated(false);
    setHistoryTruncated(false);
    setExtensionUI([]);
    setNotification(undefined);
    setSettingResult(undefined);
    setSettingsDialogOpen(false);
    updateConversationReady(false);
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
          conversationIdRef.current = "";
          authFlowIdRef.current = "";
          updateDirectoryBrowser(undefined);
          markPendingPromptUnconfirmed();
          updatePendingConversationDeletion(undefined);
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
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          updateOutstandingRunId("");
          setAuth({});
          dispatch({ type: "reset" });
          clearSessionProjection();
          socket.send({
            type: "initialize",
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
        if (event.state.conversationId !== conversationIdRef.current) {
          updateConversationReady(false);
        }
        setState(event.state);
        conversationIdRef.current = event.state.conversationId;
        if (event.state.activeRun?.id === outstandingRunIdRef.current) {
          updateOutstandingRunId("");
        }
        setActiveCwd(event.state.cwd);
        activeCwdRef.current = event.state.cwd;
        setSetupCwd(event.state.cwd);
        writeStoredString(CWD_KEY, event.state.cwd);
        confirmedToolModeRef.current = event.state.toolMode;
        if (pendingToolModeRef.current === event.state.toolMode) {
          pendingToolModeRef.current = undefined;
        }
        const pendingToolMode = pendingToolModeRef.current;
        const reconnectMode = pendingToolMode
          && isToolModeRestriction(event.state.toolMode, pendingToolMode)
          ? pendingToolMode
          : event.state.toolMode;
        toolModeRef.current = reconnectMode;
        writeStoredString(TOOL_MODE_KEY, reconnectMode);
        setError(event.state.registryError ?? "");
        if (!event.state.selectedModel && !autoOpened.current) {
          autoOpened.current = true;
          setDrawer(true);
        }
      } else if (event.type === "project_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || event.conversationId !== conversationIdRef.current
        ) return;
        setConversations(event.conversations);
        setConversationIndexTruncated(event.truncated);
      } else if (event.type === "conversation_snapshot") {
        if (
          event.sessionId !== sessionIdRef.current
          || event.conversationId !== conversationIdRef.current
        ) return;
        dispatch({ type: "hydrate", messages: event.messages });
        setHistoryTruncated(event.truncated);
        updateConversationReady(true);
      } else if (event.type === "session_event") {
        if (event.sessionId !== sessionIdRef.current) return;
        if (event.event.type === "run_queued") {
          acceptPendingPrompt(event.sessionId, event.runId);
        }
        if (event.event.type === "run_finished" && event.runId === outstandingRunIdRef.current) {
          updateOutstandingRunId("");
        }
        dispatch({ type: "session", runId: event.runId, event: event.event });
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
        if (event.operation === "delete_conversation") {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          setNotification({
            id: ++notificationIdRef.current,
            level: "info",
            message: "对话已删除",
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
          event.operation === "delete_conversation"
          && event.commandId
        ) {
          const pending = pendingConversationDeletionRef.current;
          if (!pending || pending.commandId !== event.commandId) return;
          updatePendingConversationDeletion(undefined);
          setError(`删除对话失败：${event.message}`);
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
          if (event.runId && !promptRejectedBeforeAcceptance) {
            dispatch({ type: "error", runId: event.runId, message: event.message });
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
    setError("");
    setDraft("");
    setPromptNotice("");
    updatePendingPrompt(undefined);
    clearSessionProjection();
    setActiveCwd(cwd);
    activeCwdRef.current = cwd;
    sessionIdRef.current = sessionId;
    conversationIdRef.current = conversation?.kind === "open"
      ? conversation.conversationId
      : "";
    authFlowIdRef.current = "";
    updateOutstandingRunId("");
    setAuth({});
    autoOpened.current = false;
    dispatch({ type: "reset" });
    send({
      type: "initialize",
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
    const sessionId = sessionIdRef.current;
    if (!sessionId) return false;
    const runId = crypto.randomUUID();
    const pending = { sessionId, runId, text: trimmed };
    setPromptNotice("");
    updatePendingPrompt(pending);
    updateOutstandingRunId(runId);
    const ok = send({ type: "prompt", sessionId, runId, text: trimmed });
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
    if (sessionId && runId) send({ type: "abort", sessionId, runId });
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

  return <>
    <Chat
      chat={chat}
      historyTruncated={historyTruncated}
      busy={state.busy || Boolean(outstandingRunId)}
      billedTokenCount={state.sessionTokenUsage?.total ?? chat.sessionTokens}
      contextTokenCount={state.contextUsage?.tokens}
      contextWindow={state.contextUsage?.contextWindow}
      contextSource={state.contextUsage?.source}
      model={state.selectedModel}
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
      onChangeCwd={() => {
        const sessionId = sessionIdRef.current;
        if (sessionId) send({ type: "close_session", sessionId });
        activeCwdRef.current = "";
        sessionIdRef.current = "";
        conversationIdRef.current = "";
        authFlowIdRef.current = "";
        setDraft("");
        setPromptNotice("");
        updatePendingPrompt(undefined);
        updatePendingConversationDeletion(undefined);
        updateOutstandingRunId("");
        setAuth({});
        setActiveCwd("");
        clearSessionProjection();
        autoOpened.current = false;
        dispatch({ type: "reset" });
      }} />
    <ConnectionDrawer
      state={state}
      conversations={conversations}
      conversationIndexTruncated={conversationIndexTruncated}
      open={drawer && !blockingModalVisible}
      online={online}
      toolModeBusy={state.busy || Boolean(outstandingRunId)}
      conversationBusy={
        state.busy
        || Boolean(outstandingRunId)
        || Boolean(pendingConversationDeletion)
      }
      settingResult={settingResult}
      onClose={() => setDrawer(false)}
      onNewConversation={() => initialize(state.cwd, { kind: "new" })}
      onOpenConversation={(conversationId) => {
        if (conversationId !== state.conversationId) {
          initialize(state.cwd, { kind: "open", conversationId });
        }
      }}
      onRenameConversation={(name) => {
        const sessionId = sessionIdRef.current;
        if (sessionId) {
          send({
            type: "rename_conversation",
            sessionId,
            conversationId: state.conversationId,
            name,
          });
        }
      }}
      onDeleteConversation={(conversationId) => {
        const sessionId = sessionIdRef.current;
        if (
          !sessionId
          || conversationId === state.conversationId
          || pendingConversationDeletionRef.current
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
      }}
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
      onModel={(provider, modelId) => {
        const commandId = crypto.randomUUID();
        setSettingResult(undefined);
        const sessionId = sessionIdRef.current;
        return sessionId
          && send({ type: "select_model", commandId, sessionId, provider, modelId })
          ? commandId
          : undefined;
      }}
      onClearSettingResult={clearSettingResult}
      onKeyDialogChange={setSettingsDialogOpen}
      onThinking={(level: ThinkingLevel) => {
        const sessionId = sessionIdRef.current;
        if (sessionId) send({ type: "set_thinking", sessionId, level });
      }}
      onToolMode={(mode: ToolMode) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        pendingToolModeRef.current = mode;
        const restrictive = isToolModeRestriction(confirmedToolModeRef.current, mode);
        if (restrictive) {
          toolModeRef.current = mode;
          writeStoredString(TOOL_MODE_KEY, mode);
        }
        if (!send({ type: "set_tool_mode", sessionId, mode }) && !restrictive) {
          pendingToolModeRef.current = undefined;
        }
      }} />
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
