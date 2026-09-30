import type { ToolMode } from "../shared/protocol.js";

interface ToolPolicyContext {
  mode: ToolMode;
  toolName: string;
  toolSource: string;
}

export type ToolPolicyDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string };

export type ToolPolicy = (
  context: ToolPolicyContext,
) => ToolPolicyDecision | Promise<ToolPolicyDecision>;

const PI_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SDK_READ_ONLY_TOOLS = new Set([
  "bash",
  "bash_poll",
  "bash_stop",
  "notebook_write",
  "notebook_list",
  "notebook_grep",
  "notebook_read",
  "list_roles",
  "read_role",
  "propose_role_revision",
  "current_time",
  "lsp_symbols",
  "lsp_definition",
  "lsp_references",
  "todo_read",
  "todo_write",
  "todo_pause",
  "request_context_compaction",
]);
export const READ_ONLY_TOOL_NAME_CEILING = [
  ...PI_READ_ONLY_TOOLS,
  ...SDK_READ_ONLY_TOOLS,
] as const;

export function isReadOnlyToolIdentity(
  toolName: string,
  toolSource: string,
): boolean {
  return (toolSource === "builtin" && PI_READ_ONLY_TOOLS.has(toolName))
    || (toolSource === "sdk" && SDK_READ_ONLY_TOOLS.has(toolName));
}

export const defaultToolPolicy: ToolPolicy = ({
  mode,
  toolName,
  toolSource,
}) => {
  if (mode === "full_access") return { action: "allow" };
  if (isReadOnlyToolIdentity(toolName, toolSource)) {
    return { action: "allow" };
  }
  return {
    action: "deny",
    reason: "只读模式仅允许 Pi 原生 read、grep、find、ls、宿主受审查 bash 及其 run-scoped bash_poll/bash_stop、conversation notebook、本机时间 current_time、只读 LSP lsp_symbols/lsp_definition/lsp_references、LoopList todo_read/todo_write/todo_pause、上下文压缩请求 request_context_compaction 和安全角色查看/提议工具 list_roles/read_role/propose_role_revision；其它会话编排、未受审查命令、项目写入及扩展工具均被禁止。",
  };
};
