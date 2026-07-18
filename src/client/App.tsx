import { useEffect, useReducer, useRef, useState } from "react";
import {
  PROTOCOL_VERSION,
  type AuthRequest,
  type ClientCommand,
  type ConversationSummary,
  type PublicState,
  type ServerEvent,
  type ThinkingLevel,
  type ToolMode,
} from "../shared/protocol";
import { chatReducer, initialChatState } from "./chat/reducer";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import { ConnectionDrawer } from "./components/ConnectionDrawer";
import { Setup } from "./components/Setup";
import { ToolApprovalDialog } from "./components/ToolApprovalDialog";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";

const CWD_KEY = "piweb.lastCwd";
const TOOL_MODE_KEY = "piweb.toolMode";

export function App() {
  const [transportOnline, setTransportOnline] = useState(false);
  const [protocolReady, setProtocolReady] = useState(false);
  const [protocolError, setProtocolError] = useState("");
  const [startupCwd, setStartupCwd] = useState(() => readStoredString(CWD_KEY));
  const [activeCwd, setActiveCwd] = useState("");
  const activeCwdRef = useRef("");
  const sessionIdRef = useRef("");
  const conversationIdRef = useRef("");
  const toolModeRef = useRef<ToolMode>(
    readStoredString(TOOL_MODE_KEY) === "read_only" ? "read_only" : "workspace_write",
  );
  const confirmedToolModeRef = useRef<ToolMode>(toolModeRef.current);
  const pendingToolModeRef = useRef<ToolMode | "">("");
  const authFlowIdRef = useRef("");
  const [outstandingRunId, setOutstandingRunId] = useState("");
  const outstandingRunIdRef = useRef("");
  const [submittingApprovalId, setSubmittingApprovalId] = useState("");
  const submittingApprovalIdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationIndexTruncated, setConversationIndexTruncated] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  const conversationReadyRef = useRef(false);
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<{ requestId?: string; request?: AuthRequest; progress?: string }>({});
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const socketRef = useRef<PiSocket | undefined>(undefined);
  const socketEpochRef = useRef(0);
  const autoOpened = useRef(false);

  const updateOutstandingRunId = (runId: string) => {
    outstandingRunIdRef.current = runId;
    setOutstandingRunId(runId);
  };
  const updateSubmittingApprovalId = (approvalId: string) => {
    submittingApprovalIdRef.current = approvalId;
    setSubmittingApprovalId(approvalId);
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
          updateOutstandingRunId("");
          updateSubmittingApprovalId("");
          setAuth({});
          clearSessionProjection();
          dispatch({ type: "reset" });
          setError(message);
          socket.close();
          return;
        }
        setProtocolError("");
        setProtocolReady(true);
        setStartupCwd((current) => current || event.startupCwd);
        if (activeCwdRef.current) {
          const sessionId = crypto.randomUUID();
          sessionIdRef.current = sessionId;
          authFlowIdRef.current = "";
          updateOutstandingRunId("");
          updateSubmittingApprovalId("");
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
      } else if (event.type === "state") {
        if (!sessionIdRef.current || event.state.sessionId !== sessionIdRef.current) return;
        if (event.state.conversationId !== conversationIdRef.current) {
          updateConversationReady(false);
        }
        setState(event.state);
        conversationIdRef.current = event.state.conversationId;
        if (
          submittingApprovalIdRef.current
          && !event.state.activeRun?.pendingApprovals.some((approval) => (
            approval.approvalId === submittingApprovalIdRef.current
          ))
        ) {
          updateSubmittingApprovalId("");
        }
        setActiveCwd(event.state.cwd);
        activeCwdRef.current = event.state.cwd;
        writeStoredString(CWD_KEY, event.state.cwd);
        confirmedToolModeRef.current = event.state.toolMode;
        if (pendingToolModeRef.current === event.state.toolMode) {
          pendingToolModeRef.current = "";
        }
        const reconnectMode = pendingToolModeRef.current === "read_only"
          ? "read_only"
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
        if (event.event.type === "run_finished" && event.runId === outstandingRunIdRef.current) {
          updateOutstandingRunId("");
        }
        dispatch({ type: "session", runId: event.runId, event: event.event });
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
      } else if (event.type === "error") {
        if (event.sessionId && event.sessionId !== sessionIdRef.current) return;
        if (event.authFlowId && event.authFlowId !== authFlowIdRef.current) return;
        setError(event.message);
        if (event.operation === "login_oauth" && event.authFlowId === authFlowIdRef.current) {
          authFlowIdRef.current = "";
          setAuth({});
        }
        if (event.scope === "command" && event.operation === "prompt" && activeCwdRef.current) {
          if (event.runId === outstandingRunIdRef.current) updateOutstandingRunId("");
          if (event.runId) dispatch({ type: "error", runId: event.runId, message: event.message });
        }
      }
    }, (connected) => {
      if (!isCurrentSocket()) return;
      setTransportOnline(connected);
      if (!connected) {
        setProtocolReady(false);
        updateSubmittingApprovalId("");
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

  const send = (command: ClientCommand): boolean => {
    if (!protocolReady) {
      setError("本地服务尚未完成协议握手");
      return false;
    }
    const ok = socketRef.current?.send(command) ?? false;
    if (!ok) setError("本地服务未连接");
    return ok;
  };
  const initialize = (
    cwd: string,
    conversation: Extract<ClientCommand, { type: "initialize" }>["conversation"] = {
      kind: "recent",
    },
  ) => {
    const sessionId = crypto.randomUUID();
    setError("");
    clearSessionProjection();
    setActiveCwd(cwd);
    activeCwdRef.current = cwd;
    sessionIdRef.current = sessionId;
    conversationIdRef.current = conversation?.kind === "open"
      ? conversation.conversationId
      : "";
    authFlowIdRef.current = "";
    updateOutstandingRunId("");
    updateSubmittingApprovalId("");
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
    const ok = send({ type: "prompt", sessionId, runId, text: trimmed });
    if (ok) {
      updateOutstandingRunId(runId);
      dispatch({ type: "sent", runId, text: trimmed });
    }
    return ok;
  };
  const abortCurrentRun = () => {
    const runId = outstandingRunIdRef.current || state?.activeRun?.id;
    const sessionId = sessionIdRef.current;
    if (sessionId && runId) send({ type: "abort", sessionId, runId });
  };
  const online = transportOnline && protocolReady;

  if (!activeCwd || !state) return <>
    <Setup
      initialCwd={startupCwd}
      online={online}
      unavailableLabel={protocolError ? "协议不兼容" : undefined}
      onStart={initialize}
    />
    {error && <div className="toast error-toast">{error}</div>}
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
        updateOutstandingRunId("");
        updateSubmittingApprovalId("");
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
      open={drawer}
      toolModeBusy={state.busy || Boolean(outstandingRunId)}
      conversationBusy={state.busy || Boolean(outstandingRunId)}
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
      onKey={(provider, key) => send({ type: "set_api_key", provider, key })}
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
      onModel={(provider, modelId) => {
        const sessionId = sessionIdRef.current;
        if (sessionId) send({ type: "select_model", sessionId, provider, modelId });
      }}
      onThinking={(level: ThinkingLevel) => {
        const sessionId = sessionIdRef.current;
        if (sessionId) send({ type: "set_thinking", sessionId, level });
      }}
      onToolMode={(mode: ToolMode) => {
        const sessionId = sessionIdRef.current;
        if (!sessionId) return;
        pendingToolModeRef.current = mode;
        if (mode === "read_only") {
          toolModeRef.current = mode;
          writeStoredString(TOOL_MODE_KEY, mode);
        }
        if (!send({ type: "set_tool_mode", sessionId, mode }) && mode === "workspace_write") {
          pendingToolModeRef.current = "";
        }
      }} />
    <AuthDialog {...auth} onRespond={(requestId, response) => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "auth_response", authFlowId, requestId, ...response });
    }} onCancel={() => {
      const authFlowId = authFlowIdRef.current;
      if (authFlowId) send({ type: "cancel_auth", authFlowId });
      authFlowIdRef.current = "";
      setAuth({});
    }} />
    <ToolApprovalDialog
      request={online ? state.activeRun?.pendingApprovals[0] : undefined}
      pendingCount={state.activeRun?.pendingApprovals.length ?? 0}
      online={online}
      cancelling={state.activeRun?.phase === "cancelling"}
      submitting={submittingApprovalId === state.activeRun?.pendingApprovals[0]?.approvalId}
      onDecision={(decision) => {
        const sessionId = sessionIdRef.current;
        const activeRun = state.activeRun;
        const approval = activeRun?.pendingApprovals[0];
        if (
          sessionId
          && activeRun
          && approval
          && submittingApprovalIdRef.current !== approval.approvalId
        ) {
          updateSubmittingApprovalId(approval.approvalId);
          const accepted = send({
            type: "tool_approval_response",
            sessionId,
            runId: activeRun.id,
            approvalId: approval.approvalId,
            decision,
          });
          if (!accepted) updateSubmittingApprovalId("");
          return accepted;
        }
        return false;
      }}
      onAbort={abortCurrentRun}
    />
    {error && <div className="toast error-toast">{error}</div>}
  </>;
}
