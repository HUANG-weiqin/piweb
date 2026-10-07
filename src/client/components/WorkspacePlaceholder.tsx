import { ActivitySpinner } from "./ActivitySpinner";
import { workspaceName } from "./WorkspaceRail";

interface WorkspacePlaceholderProps {
  cwd: string;
  unavailable: boolean;
  hidden?: boolean;
  announceOpening?: boolean;
  initializationError?: string;
  repairUnknown?: boolean;
  onReviewRepair?(): void;
  onInspectSessions?(): void;
  onOpen(): void;
  onClose(): void;
  onRetry(): void;
}

export function WorkspacePlaceholder({
  cwd,
  unavailable,
  hidden,
  announceOpening,
  initializationError,
  repairUnknown,
  onReviewRepair,
  onInspectSessions,
  onOpen,
  onClose,
  onRetry,
}: WorkspacePlaceholderProps) {
  if (!cwd) {
    return <main className="workspace-placeholder" hidden={hidden}>
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
    return <main className="workspace-placeholder" hidden={hidden}>
      <div className="workspace-placeholder-content">
        <div className="workspace-placeholder-mark warning">!</div>
        <p className="eyebrow">WORKSPACE UNAVAILABLE</p>
        <h1>工作区不可用</h1>
        <p>
          <strong>{workspaceName(cwd)}</strong> 的目录可能已移动、重命名或删除。
        </p>
        <code>{cwd}</code>
        {repairUnknown && <div className="workspace-session-diagnostic" role="alert">
          <span>修复结果未知；不会自动重试或进入工作区。已确认备份仍可查看。</span>
          <button type="button" onClick={onReviewRepair}>查看备份并重新检查</button>
        </div>}
        <div className="workspace-placeholder-actions">
          <button type="button" onClick={onRetry}>重试打开工作区</button>
          <button type="button" className="ghost" onClick={onOpen}>
            选择其它目录
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            关闭工作区
          </button>
        </div>
      </div>
    </main>;
  }

  const name = workspaceName(cwd);
  if (initializationError) {
    return <main className="workspace-placeholder" hidden={hidden}>
      <div className="workspace-placeholder-content">
        <div className="workspace-placeholder-mark warning">!</div>
        <p className="eyebrow">WORKSPACE OPEN FAILED</p>
        <h1>工作区打开失败</h1>
        <p>{initializationError}</p>
        <code>{cwd}</code>
        {repairUnknown && <div className="workspace-session-diagnostic" role="alert">
          <span>修复结果未知；不会自动重试或进入工作区。已确认备份仍可查看。</span>
          <button type="button" onClick={onReviewRepair}>查看备份并重新检查</button>
        </div>}
        <div className="workspace-placeholder-actions">
          {onInspectSessions && <button type="button" onClick={onInspectSessions}>检查与修复</button>}
          <button type="button" className="ghost" onClick={onOpen}>选择其它目录</button>
          <button type="button" className="ghost" onClick={onRetry}>重试打开工作区</button>
        </div>
      </div>
    </main>;
  }
  return <main className="workspace-placeholder" hidden={hidden}>
    <div
      className="workspace-placeholder-content"
      role={announceOpening ? "status" : undefined}
      aria-label={announceOpening ? `正在打开工作区 ${name}` : undefined}
    >
      <ActivitySpinner className="workspace-opening-spinner" strokeWidth={1.2} />
      <p className="eyebrow">OPENING WORKSPACE</p>
      <h1>正在打开工作区</h1>
      <p>{name}</p>
      <code>{cwd}</code>
      {repairUnknown && <div className="workspace-session-diagnostic" role="alert">
        <span>修复结果未知；不会自动重试或进入工作区。已确认备份仍可查看。</span>
        <button type="button" onClick={onReviewRepair}>查看备份并重新检查</button>
      </div>}
    </div>
  </main>;
}
