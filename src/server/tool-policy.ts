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

export const defaultToolPolicy: ToolPolicy = ({
  mode,
  toolName,
  toolSource,
}) => {
  if (mode === "full_access") return { action: "allow" };
  if (toolSource === "builtin" && PI_READ_ONLY_TOOLS.has(toolName)) {
    return { action: "allow" };
  }
  return {
    action: "deny",
    reason: "只读模式仅允许 Pi 原生 read、grep、find 和 ls 工具；命令、写入及扩展工具均被禁止。",
  };
};
