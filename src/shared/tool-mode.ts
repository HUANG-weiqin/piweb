import type { ToolMode } from "./protocol.js";

export function mostRestrictiveToolMode(first: ToolMode, second: ToolMode): ToolMode {
  return first === "read_only" || second === "read_only"
    ? "read_only"
    : "full_access";
}
