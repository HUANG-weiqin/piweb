import { workspaceName } from "./WorkspaceRail";

interface WorkspacePlaceholderProps {
  cwd: string;
  unavailable: boolean;
  onOpen(): void;
  onRemove(): void;
  onRetry(): void;
}

export function WorkspacePlaceholder({
  cwd,
  unavailable,
  onOpen,
  onRemove,
  onRetry,
}: WorkspacePlaceholderProps) {
  if (!cwd) {
    return <main className="workspace-placeholder">
      <div className="workspace-placeholder-content">
        <div className="workspace-placeholder-mark">π</div>
        <p className="eyebrow">PI WEB</p>
        <h1>还没有打开工作区</h1>
        <p>打开一个本地项目后，就能在左侧快速切换工作区和会话。</p>
        <button type="button" onClick={onOpen}>开启工作区</button>
      </div>
    </main>;
  }

  if (unavailable) {
    return <main className="workspace-placeholder">
      <div className="workspace-placeholder-content">
        <div className="workspace-placeholder-mark warning">!</div>
        <p className="eyebrow">WORKSPACE UNAVAILABLE</p>
        <h1>工作区不可用</h1>
        <p>
          <strong>{workspaceName(cwd)}</strong> 的目录可能已移动、重命名或删除。
        </p>
        <code>{cwd}</code>
        <div className="workspace-placeholder-actions">
          <button type="button" onClick={onRetry}>重试打开工作区</button>
          <button type="button" className="ghost" onClick={onOpen}>
            选择其它目录
          </button>
          <button type="button" className="ghost danger" onClick={onRemove}>
            从列表移除
          </button>
        </div>
      </div>
    </main>;
  }

  return <main className="workspace-placeholder">
    <div className="workspace-placeholder-content">
      <span className="workspace-opening-spinner" aria-hidden="true" />
      <p className="eyebrow">OPENING WORKSPACE</p>
      <h1>正在打开工作区</h1>
      <p>{workspaceName(cwd)}</p>
      <code>{cwd}</code>
    </div>
  </main>;
}
