interface WorkspaceRailProps {
  workspaces: string[];
  activeCwd: string;
  unavailable: ReadonlySet<string>;
  onSelect(cwd: string): void;
  onAdd(): void;
}

function workspaceKey(cwd: string): string {
  const slashed = cwd.trim().replace(/\\/g, "/");
  const normalized = slashed.length > 1
    ? slashed.replace(/\/+$/, "")
    : slashed;
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function workspaceName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || cwd;
}

function workspaceTone(cwd: string): number {
  let hash = 0;
  for (const character of workspaceKey(cwd)) {
    hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  }
  return hash % 8;
}

export function WorkspaceRail({
  workspaces,
  activeCwd,
  unavailable,
  onSelect,
  onAdd,
}: WorkspaceRailProps) {
  const activeKey = workspaceKey(activeCwd);
  return <nav className="workspace-rail" aria-label="工作区">
    <div className="workspace-rail-brand" aria-hidden="true">π</div>
    <div className="workspace-rail-list">
      {workspaces.map((cwd) => {
        const name = workspaceName(cwd);
        const active = workspaceKey(cwd) === activeKey;
        const missing = unavailable.has(workspaceKey(cwd));
        return <button
          key={workspaceKey(cwd)}
          type="button"
          className={`workspace-rail-item tone-${workspaceTone(cwd)}${active ? " active" : ""}${missing ? " unavailable" : ""}`}
          aria-label={`打开工作区 ${name}${missing ? "（不可用）" : ""}`}
          aria-current={active ? "true" : undefined}
          title={`${name}\n${cwd}${missing ? "\n目录当前不可用" : ""}`}
          onClick={() => onSelect(cwd)}
        >
          <span aria-hidden="true">{name.slice(0, 1).toLocaleUpperCase()}</span>
          {missing && <i className="workspace-rail-warning" aria-hidden="true">!</i>}
        </button>;
      })}
    </div>
    <button
      type="button"
      className="workspace-rail-add"
      aria-label="添加工作区"
      title="添加工作区"
      onClick={onAdd}
    >＋</button>
  </nav>;
}

export { workspaceKey, workspaceName };
