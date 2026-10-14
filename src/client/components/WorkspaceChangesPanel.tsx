import type { WorkspaceChangesSnapshot, WorkspaceFileChange } from "../../shared/protocol";

const STATUS_LABELS: Record<WorkspaceFileChange["status"], string> = {
  modified: "MODIFIED",
  added: "ADDED",
  deleted: "DELETED",
  renamed: "RENAMED",
  copied: "COPIED",
  untracked: "UNTRACKED",
  conflicted: "CONFLICTED",
  type_changed: "TYPE CHANGED",
};

interface WorkspaceChangesPanelProps {
  snapshot?: WorkspaceChangesSnapshot;
  loading?: boolean;
  onRefresh?(): void;
}

export function WorkspaceChangesPanel({
  snapshot,
  loading = false,
  onRefresh,
}: WorkspaceChangesPanelProps) {
  return <section className="workspace-changes" aria-label="工作区改动">
    <header className="workspace-changes-header">
      <div className="workspace-changes-summary">
        {snapshot?.state === "ready" && <p className="workspace-changes-branch">
          当前分支 <span title={snapshot.branch ?? "分离 HEAD"}>{snapshot.branch ?? "分离 HEAD"}</span>
        </p>}
        <p className="workspace-changes-count">
          {snapshot?.state === "ready"
            ? <><strong>{snapshot.total}</strong> 个改动文件{loading && "（上次读取）"}</>
            : "文件状态"}
        </p>
      </div>
      {onRefresh && <button
        type="button"
        aria-label="刷新工作区改动"
        disabled={loading}
        onClick={onRefresh}
      >刷新</button>}
    </header>
    {loading && snapshot && <p className="workspace-changes-notice" role="status">
      刷新中，{snapshot.state === "ready" ? "显示上次结果。" : "正在重新读取。"}
    </p>}
    {snapshot?.state === "ready"
      ? <>
        {snapshot.truncated && <p className="workspace-changes-notice">
          仅显示前 {snapshot.files.length} 个文件（共 {snapshot.total} 个）。
        </p>}
        {snapshot.files.length === 0
          ? <p className="workspace-changes-empty">工作区没有文件改动。</p>
          : <ul className="workspace-changes-list">
            {snapshot.files.map((file) => <li key={file.path}>
              <small className={`workspace-change-status is-${file.status}`}>
                {STATUS_LABELS[file.status]}
              </small>
              <span className="workspace-change-path" title={file.path}>{file.path}</span>
            </li>)}
          </ul>}
      </>
      : <p className="workspace-changes-empty">
        {!snapshot
          ? loading ? "正在读取工作区改动…" : "尚未读取工作区改动。"
          : snapshot.state === "not_git"
            ? "当前目录没有 Git 工作树。"
            : `读取工作区改动失败：${snapshot.message}`}
      </p>}
  </section>;
}
