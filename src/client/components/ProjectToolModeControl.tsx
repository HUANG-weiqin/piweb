import type { ToolMode } from "../../shared/protocol";

export interface ProjectToolModeControlProps {
  mode: ToolMode;
  disabled: boolean;
  onChange(mode: ToolMode): void;
}

function modeDescription(mode: ToolMode): string {
  return mode === "read_only"
    ? "只允许读取项目；命令、写入和扩展工具会被阻止。"
    : "允许 Agent 直接执行工具和命令，包括修改项目外文件。";
}

export function ProjectToolModeControl({
  mode,
  disabled,
  onChange,
}: ProjectToolModeControlProps) {
  return <label
    className="project-tool-mode-control"
    title={modeDescription(mode)}
  >
    <span>项目权限</span>
    <select
      aria-label="项目工具权限"
      value={mode}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as ToolMode)}
    >
      <option value="full_access">全部授权</option>
      <option value="read_only">只读</option>
    </select>
  </label>;
}
