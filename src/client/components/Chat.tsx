import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ChatState } from "../chat/reducer";
import { Message } from "./Message";

interface ChatProps {
  chat: ChatState;
  historyTruncated: boolean;
  busy: boolean;
  billedTokenCount: number;
  contextTokenCount: number | null | undefined;
  contextWindow: number | null | undefined;
  contextSource: "measured" | "estimated" | "unknown" | undefined;
  model?: { provider: string; id: string };
  cwd: string;
  online: boolean;
  conversationReady: boolean;
  draft: string;
  submitting: boolean;
  promptNotice?: string;
  onDraftChange(text: string): void;
  onSend(text: string): boolean;
  onAbort(): void;
  onSettings(): void;
  onChangeCwd(): void;
}

function formatContextUsage({
  contextTokenCount,
  contextWindow,
  contextSource,
}: Pick<ChatProps, "contextTokenCount" | "contextWindow" | "contextSource">): string {
  if (contextTokenCount == null) return "未知，将在下一轮更新";
  const prefix = contextSource === "estimated" ? "估算 " : "";
  const window = contextWindow?.toLocaleString("zh-CN") ?? "?";
  return `${prefix}${contextTokenCount.toLocaleString("zh-CN")} / ${window}`;
}

export function Chat({
  chat,
  historyTruncated,
  busy,
  billedTokenCount,
  contextTokenCount,
  contextWindow,
  contextSource,
  model,
  cwd,
  online,
  conversationReady,
  draft,
  submitting,
  promptNotice,
  onDraftChange,
  onSend,
  onAbort,
  onSettings,
  onChangeCwd,
}: ChatProps) {
  const bottomThreshold = 96;
  const contextTokenText = formatContextUsage({ contextTokenCount, contextWindow, contextSource });
  let composerPlaceholder = "给 Pi 发送消息…";
  if (!conversationReady) composerPlaceholder = "正在恢复项目对话…";
  else if (!model) composerPlaceholder = "请先登录并选择模型";
  const transcriptRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const followOutputRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const scrollToLatest = (behavior?: ScrollBehavior) => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({
        top: transcript.scrollHeight,
        ...(behavior ? { behavior } : {}),
      });
    } else {
      transcript.scrollTop = transcript.scrollHeight;
    }
  };
  useLayoutEffect(() => {
    if (followOutputRef.current) {
      scrollToLatest();
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [chat.messages]);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 180)}px`;
  }, [draft]);
  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const distanceFromBottom =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    followOutputRef.current = distanceFromBottom <= bottomThreshold;
    if (followOutputRef.current) setShowJumpToLatest(false);
  };
  const jumpToLatest = () => {
    followOutputRef.current = true;
    setShowJumpToLatest(false);
    scrollToLatest("smooth");
  };
  const send = () => {
    const value = draft.trim();
    if (!value || busy || submitting || !model || !online || !conversationReady) return;
    onSend(value);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
  };

  return <main className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={onChangeCwd}><span>π</span><span>Pi Web<small title={cwd}>{cwd}</small></span></button>
      <button className="model-button" onClick={onSettings}>{model ? `${model.provider} / ${model.id}` : "选择模型"}<span>⌄</span></button>
    </header>
    {!online && <div className="banner">本地服务已断开，正在重连…</div>}
    <section
      ref={transcriptRef}
      className="transcript"
      aria-live="polite"
      onScroll={handleTranscriptScroll}
    >
      {historyTruncated && <div className="history-note">
        较早或过长的显示内容已省略；完整记录仍保存在项目中。
      </div>}
      {!chat.messages.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {chat.messages.map((message) => <Message key={message.id} message={message} />)}
    </section>
    <div className="composer-wrap">
      {showJumpToLatest && <button
        type="button"
        className="jump-latest"
        onClick={jumpToLatest}
      >
        ↓ 回到最新消息
      </button>}
      {submitting && !promptNotice && <div
        className="composer-notice pending"
        role="status"
      >
        正在确认服务端已接收…
      </div>}
      {promptNotice && <div className="composer-notice" role="alert">{promptNotice}</div>}
      <div className="composer">
        <textarea ref={textareaRef} aria-label="给 Pi 发送消息" value={draft} onChange={(e) => onDraftChange(e.target.value)} onKeyDown={keyDown} placeholder={composerPlaceholder} disabled={!online || !conversationReady || !model || submitting} rows={1} />
        {busy ? <button className="send stop" onClick={onAbort} aria-label="停止">■</button> : <button className="send" onClick={send} disabled={!online || !conversationReady || !model || submitting || !draft.trim()} aria-label="发送">↑</button>}
      </div>
      <div className="composer-meta">
        <small className="session-stats billed-stat">累计 Token：{billedTokenCount.toLocaleString("zh-CN")}</small>
        <small className="session-stats context-stat">上下文：{contextTokenText}</small>
        <small className="composer-tip">Enter 发送 · Shift+Enter 换行 · 对话随项目自动保存</small>
      </div>
    </div>
  </main>;
}
