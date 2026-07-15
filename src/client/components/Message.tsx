import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ChatMessage } from "../chat/reducer";
import { ToolCard } from "./ToolCard";

function ToolsPanel({ tools }: { tools: ChatMessage["tools"] }) {
  return <details className="tools">
    <summary>工具调用（{tools.length}）</summary>
    {tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
  </details>;
}

export function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") return <article className="message user">{message.text}</article>;
  if (message.role === "error") return <article className="message error">{message.text}</article>;
  const html = DOMPurify.sanitize(marked.parse(message.text || (message.tools.length ? "" : "…"), { async: false }) as string);
  return <article className="message assistant">
    {message.thinking && <details className="thinking"><summary>思考过程</summary><div>{message.thinking}</div></details>}
    {message.text || !message.tools.length ? <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} /> : null}
    {message.tools.length ? <ToolsPanel tools={message.tools} /> : null}
  </article>;
}
