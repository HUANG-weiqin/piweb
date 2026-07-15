import type { ToolItem } from "../chat/reducer";

function printable(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function statusIcon(status: ToolItem["status"]): string {
  if (status === "running") return "●";
  if (status === "done") return "✓";
  return "!";
}

export function ToolCard({ tool }: { tool: ToolItem }) {
  return <details className={`tool tool-${tool.status}`}>
    <summary><span>{statusIcon(tool.status)}</span> {tool.name}</summary>
    {tool.args !== undefined && <pre>{printable(tool.args)}</pre>}
    {tool.result !== undefined && <pre>{printable(tool.result)}</pre>}
  </details>;
}
