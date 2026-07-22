import type { ToolMode } from "../shared/protocol.js";

export interface ToolPolicyContext {
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
export const READ_ONLY_TOOL_NAME_CEILING = [
  ...PI_READ_ONLY_TOOLS,
  "git_inspect",
] as const;

export function isReadOnlyToolIdentity(
  toolName: string,
  toolSource: string,
): boolean {
  return (toolSource === "builtin" && PI_READ_ONLY_TOOLS.has(toolName))
    || (toolSource === "sdk" && toolName === "git_inspect");
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
    reason: "只读模式仅允许 Pi 原生 read、grep、find、ls 和宿主 git_inspect；命令、写入及扩展工具均被禁止。",
  };
};
