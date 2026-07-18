import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  if (contextTokenCount == null) return "当前上下文：未知（compaction 后需新回合刷新）";
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
  onSend,
  onAbort,
  onSettings,
  onChangeCwd,
}: ChatProps) {
  const contextTokenText = formatContextUsage({ contextTokenCount, contextWindow, contextSource });
  let composerPlaceholder = "给 Pi 发送消息…";
  if (!conversationReady) composerPlaceholder = "正在恢复项目对话…";
  else if (!model) composerPlaceholder = "请先登录并选择模型";
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = endRef.current;
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth" });
    }
  }, [chat.messages]);
  const send = () => {
    const value = text.trim();
    if (!value || busy || !model || !online || !conversationReady) return;
    const accepted = onSend(value);
    if (accepted) setText("");
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
    <section className="transcript" aria-live="polite">
      {historyTruncated && <div className="history-note">
        较早或过长的显示内容已省略；完整记录仍保存在项目中。
      </div>}
      {!chat.messages.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {chat.messages.map((message) => <Message key={message.id} message={message} />)}
      <div ref={endRef} />
    </section>
    <div className="composer-wrap"><div className="composer">
      <textarea aria-label="给 Pi 发送消息" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} placeholder={composerPlaceholder} disabled={!online || !conversationReady || !model} rows={1} />
      {busy ? <button className="send stop" onClick={onAbort} aria-label="停止">■</button> : <button className="send" onClick={send} disabled={!online || !conversationReady || !model || !text.trim()} aria-label="发送">↑</button>}
    </div>
    <div className="composer-meta">
      <small className="session-stats">累计计费 token：{billedTokenCount.toLocaleString("zh-CN")}</small>
      <small className="session-stats">上下文 token：{contextTokenText}</small>
      <small className="composer-tip">Enter 发送 · Shift+Enter 换行 · 对话随项目自动保存</small>
    </div></div>
  </main>;
}
