import type { ToolItem } from "../chat/reducer";

function printable(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function statusIcon(status: ToolItem["status"]): string {
  if (status === "pending") return "○";
  if (status === "running") return "●";
  if (status === "done") return "✓";
  return "!";
}

function compactLabel(name: string): string {
  const content = ` ${name} `;
  const width = 38;
  if (content.length >= width) return content;
  const side = Math.max(0, Math.floor((width - content.length) / 2));
  const left = "-".repeat(side);
  const right = "-".repeat(Math.max(0, width - content.length - side));
  return `${left}${content}${right}`;
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  return <details className={`tool tool-${tool.status}`}>
    <summary><span>{statusIcon(tool.status)}</span> <span className="tool-title">{compactLabel(tool.name)}</span></summary>
    {tool.args !== undefined && <pre>{printable(tool.args)}</pre>}
    {tool.result !== undefined && <pre>{printable(tool.result)}</pre>}
  </details>;
}
