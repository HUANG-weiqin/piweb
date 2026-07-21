import type { ProjectActivitySummary } from "../../shared/protocol";

interface WorkspaceRailProps {
  workspaces: string[];
  activeCwd: string;
  unavailable: ReadonlySet<string>;
  activityByWorkspace: ReadonlyMap<string, ProjectActivitySummary>;
  activityCatalogTruncated: boolean;
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

function workspaceActivityLabel(
  busyConversationCount: number,
  attentionConversationCount: number,
): string {
  const labels: string[] = [];
  if (busyConversationCount > 0) {
    labels.push(`${busyConversationCount} 个会话忙碌中`);
  }
  if (attentionConversationCount > 0) {
    labels.push(`${attentionConversationCount} 个会话需要注意`);
  }
  return labels.join("，");
}

export function WorkspaceRail({
  workspaces,
  activeCwd,
  unavailable,
  activityByWorkspace,
  activityCatalogTruncated,
  onSelect,
  onAdd,
}: WorkspaceRailProps) {
  const activeKey = workspaceKey(activeCwd);
  return <nav className="workspace-rail" aria-label="工作区">
    <div className="workspace-rail-brand" aria-hidden="true">π</div>
    <div className="workspace-rail-list">
      {workspaces.map((cwd) => {
        const name = workspaceName(cwd);
        const key = workspaceKey(cwd);
        const active = key === activeKey;
        const missing = unavailable.has(key);
        const activity = activityByWorkspace.get(key);
        const activityUnknown = activityCatalogTruncated && !activity;
        const busyCount = activity?.busyConversationCount ?? 0;
        const attentionCount = activity?.attentionConversationCount ?? 0;
        const activityLabel = workspaceActivityLabel(
          busyCount,
          attentionCount,
        );
        const unavailableLabel = missing ? "（不可用）" : "";
        let statusLabel = "";
        if (activityLabel) {
          statusLabel = `（${activityLabel}）`;
        } else if (activityUnknown) {
          statusLabel = "（活动状态未知）";
        }
        const titleLines = [name, cwd];
        if (missing) titleLines.push("目录当前不可用");
        if (activityLabel) titleLines.push(activityLabel);
        if (activityUnknown) titleLines.push("全局活动目录已截断，状态未知");
        return <button
          key={key}
          type="button"
          className={`workspace-rail-item tone-${workspaceTone(cwd)}${active ? " active" : ""}${missing ? " unavailable" : ""}`}
          aria-label={`打开工作区 ${name}${unavailableLabel}${statusLabel}`}
          aria-current={active ? "true" : undefined}
          title={titleLines.join("\n")}
          onClick={() => onSelect(cwd)}
        >
          <span aria-hidden="true">{name.slice(0, 1).toLocaleUpperCase()}</span>
          {missing && <i className="workspace-rail-warning" aria-hidden="true">!</i>}
          {!missing && busyCount > 0 && <i
            className="workspace-rail-busy"
            aria-hidden="true"
          />}
          {!missing && attentionCount > 0 && <i
            className="workspace-rail-attention"
            aria-hidden="true"
          >{attentionCount > 9 ? "9+" : attentionCount}</i>}
          {!missing && activityUnknown && <i
            className="workspace-rail-unknown"
            aria-hidden="true"
          >?</i>}
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
