import { useEffect, useReducer, useRef, useState } from "react";
import type { AuthRequest, ClientCommand, PublicState, ServerEvent, ThinkingLevel } from "../shared/protocol";
import { chatReducer, initialChatState } from "./chat/reducer";
import { AuthDialog } from "./components/AuthDialog";
import { Chat } from "./components/Chat";
import { ConnectionDrawer } from "./components/ConnectionDrawer";
import { Setup } from "./components/Setup";
import { PiSocket } from "./lib/socket";
import { readStoredString, writeStoredString } from "./lib/storage";

const CWD_KEY = "piweb.lastCwd";

export function App() {
  const [online, setOnline] = useState(false);
  const [startupCwd, setStartupCwd] = useState(() => readStoredString(CWD_KEY));
  const [activeCwd, setActiveCwd] = useState("");
  const activeCwdRef = useRef("");
  const [state, setState] = useState<PublicState>();
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState("");
  const [auth, setAuth] = useState<{ requestId?: string; request?: AuthRequest; progress?: string }>({});
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const socketRef = useRef<PiSocket | undefined>(undefined);
  const autoOpened = useRef(false);

  useEffect(() => {
    const socket = new PiSocket((event: ServerEvent) => {
      if (event.type === "hello") {
        setStartupCwd((current) => current || event.startupCwd);
        if (activeCwdRef.current) {
          dispatch({ type: "reset" });
          socket.send({ type: "initialize", cwd: activeCwdRef.current });
        }
      } else if (event.type === "state") {
        setState(event.state);
        setActiveCwd(event.state.cwd);
        activeCwdRef.current = event.state.cwd;
        writeStoredString(CWD_KEY, event.state.cwd);
        setError("");
        if (!event.state.selectedModel && !autoOpened.current) {
          autoOpened.current = true;
          setDrawer(true);
        }
      } else if (event.type === "session_event") {
        dispatch({ type: "pi", event: event.event });
      } else if (event.type === "auth_request") {
        setAuth((current) => ({ ...current, requestId: event.requestId, request: event.request }));
      } else if (event.type === "auth_progress") {
        setAuth((current) => ({ ...current, progress: event.message }));
      } else if (event.type === "auth_complete") {
        setAuth({});
      } else if (event.type === "error") {
        setError(event.message);
        if (activeCwdRef.current) dispatch({ type: "error", message: event.message });
      }
    }, setOnline);
    socketRef.current = socket;
    socket.connect();
    return () => socket.close();
  }, []);

  const send = (command: ClientCommand) => {
    if (!socketRef.current?.send(command)) setError("本地服务未连接");
  };
  const initialize = (cwd: string) => {
    setError("");
    setState(undefined);
    setActiveCwd(cwd);
    activeCwdRef.current = cwd;
    dispatch({ type: "reset" });
    send({ type: "initialize", cwd });
  };
  const sendPrompt = (text: string) => {
    dispatch({ type: "sent", text });
    send({ type: "prompt", text });
  };

  if (!activeCwd || !state) return <>
    <Setup initialCwd={startupCwd} online={online} onStart={initialize} />
    {error && <div className="toast error-toast">{error}</div>}
  </>;

  return <>
    <Chat chat={chat} model={state.selectedModel} cwd={state.cwd} online={online} onSend={sendPrompt} onAbort={() => send({ type: "abort" })} onSettings={() => setDrawer(true)} onChangeCwd={() => {
      activeCwdRef.current = "";
      setActiveCwd("");
      setState(undefined);
      dispatch({ type: "reset" });
    }} />
    <ConnectionDrawer state={state} open={drawer} onClose={() => setDrawer(false)}
      onKey={(provider, key) => send({ type: "set_api_key", provider, key })}
      onOAuth={(provider) => { setAuth({ progress: "正在启动登录…" }); send({ type: "login_oauth", provider }); }}
      onLogout={(provider) => send({ type: "logout", provider })}
      onModel={(provider, modelId) => send({ type: "select_model", provider, modelId })}
      onThinking={(level: ThinkingLevel) => send({ type: "set_thinking", level })} />
    <AuthDialog {...auth} onRespond={(requestId, response) => send({ type: "auth_response", requestId, ...response })} onCancel={() => {
      send({ type: "cancel_auth" });
      setAuth({});
    }} />
  </>;
}
