import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatState } from "../chat/reducer";
import { Message } from "./Message";

export function Chat({ chat, model, cwd, online, onSend, onAbort, onSettings, onChangeCwd }: {
  chat: ChatState;
  model?: { provider: string; id: string };
  cwd: string;
  online: boolean;
  onSend(text: string): boolean;
  onAbort(): void;
  onSettings(): void;
  onChangeCwd(): void;
}) {
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
    if (!value || chat.busy || !model) return;
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
      {!chat.messages.length && <div className="empty"><div>π</div><h1>想做点什么？</h1><p>Pi 可以读取、修改文件并执行命令。</p></div>}
      {chat.messages.map((message) => <Message key={message.id} message={message} />)}
      <div ref={endRef} />
    </section>
    <div className="composer-wrap"><div className="composer">
      <textarea aria-label="给 Pi 发送消息" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} placeholder={model ? "给 Pi 发送消息…" : "请先登录并选择模型"} disabled={!online || !model} rows={1} />
      {chat.busy ? <button className="send stop" onClick={onAbort} aria-label="停止">■</button> : <button className="send" onClick={send} disabled={!online || !model || !text.trim()} aria-label="发送">↑</button>}
    </div><small>Enter 发送 · Shift+Enter 换行 · 对话不会保存</small></div>
  </main>;
}
