import { useEffect, useState } from "react";
import type {
  WorkspaceSessionRepairBackup,
  WorkspaceSessionRepairIssue,
  WorkspaceSessionRepairReport,
  WorkspaceSessionRepairRequest,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export type WorkspaceSessionRepairPending = "inspect" | "repair";

function repairImpact(issue: WorkspaceSessionRepairIssue): string {
  const repair = issue.repair;
  if (!repair) return "不支持自动修复；完整原件保持不变，请人工处理。";
  if (repair.kind === "remove_zero_tail") {
    return `移除 ${repair.removedBytes} 个尾随零字节；保留 ${repair.retainedEntries} 条记录。`;
  }
  if (repair.kind === "append_newline") {
    return `仅补齐末尾换行；保留 ${repair.retainedEntries} 条记录，不丢弃正文。`;
  }
  return `将丢弃 ${repair.removedBytes} 字节的不完整尾部；保留 ${repair.retainedEntries} 条记录。`;
}

export function WorkspaceSessionRepairDialog({
  open,
  cwd,
  online,
  covered = false,
  report,
  reportFresh,
  backups,
  pending,
  phase,
  error,
  repairError,
  needsRecheck = false,
  onInspect,
  onRepair,
  onRetryRecovery,
  onRevalidateAndEnter,
  onClose,
}: {
  open: boolean;
  cwd: string;
  online: boolean;
  covered?: boolean;
  report?: WorkspaceSessionRepairReport;
  reportFresh: boolean;
  backups: WorkspaceSessionRepairBackup[];
  pending?: WorkspaceSessionRepairPending;
  phase?: "report" | "entering" | "ready";
  error?: string;
  repairError?: string;
  needsRecheck?: boolean;
  onInspect(): void;
  onRepair(files: WorkspaceSessionRepairRequest[], allowDiscardIncompleteTail: boolean): void;
  onRetryRecovery(): void;
  onRevalidateAndEnter(): void;
  onClose(): void;
}) {
  const [allowDiscard, setAllowDiscard] = useState(false);
  useEffect(() => setAllowDiscard(false), [cwd, report]);
  const destructiveIssues = report?.issues.filter(
    (issue) => issue.repair?.kind === "discard_incomplete_tail",
  ) ?? [];
  const losslessIssues = report?.issues.filter(
    (issue) => issue.repair?.kind === "remove_zero_tail"
      || issue.repair?.kind === "append_newline",
  ) ?? [];
  const supportedIssues = report?.issues.filter((issue) => issue.repair !== null) ?? [];
  const reportIsClean = Boolean(
    report
    && reportFresh
    && !needsRecheck
    && report.issues.length === 0
    && !report.truncated
    && !report.recoveryError,
  );
  const closeBlocked = pending === "repair";
  const close = () => {
    if (!closeBlocked) onClose();
  };
  const focusRef = useModalFocus<HTMLElement>(open, `workspace-session-repair:${cwd}`, close);

  if (!open) return null;

  const requestFor = (issues: WorkspaceSessionRepairIssue[]) => issues.map(
    ({ fileName, revision }) => ({ fileName, expectedRevision: revision }),
  );

  return <div
    className="modal-backdrop"
    role="presentation"
    onMouseDown={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      close();
    }}
  >
    <section
      ref={focusRef}
      className="modal workspace-session-repair-dialog"
      role={covered ? undefined : "dialog"}
      aria-modal={covered ? undefined : "true"}
      aria-hidden={covered ? "true" : undefined}
      aria-labelledby="workspace-session-repair-title"
      aria-busy={Boolean(pending || phase === "entering")}
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">WORKSPACE SESSION DATA</p>
          <h2 id="workspace-session-repair-title">检查与修复会话数据</h2>
          <p className="modal-description">只检查此工作区的会话文件；检查不会修改正文。可修复项会先生成服务端精确备份。</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭会话数据检查"
          disabled={closeBlocked}
          onClick={close}
        >×</button>
      </header>

      <div className="workspace-session-repair-cwd">
        <span>工作区</span>
        <code title={cwd}>{cwd}</code>
      </div>

      {error && <p className="workspace-session-repair-error" role="alert">{error}</p>}
      {repairError && <p className="workspace-session-repair-error" role="alert">
        修复未能全部完成：{repairError}。已提交项目仍可能已变更；下面的备份清单保留本次已确认回执，请依据重新检查结果决定下一步。
      </p>}
      {needsRecheck && <p className="workspace-session-repair-warning" role="status">
        修复结果尚未确认。请重新检查；不会自动重试修复或进入工作区。
      </p>}

      {pending && <p className="workspace-session-repair-progress" role="status">
        {pending === "inspect" ? "正在检查会话数据…" : "正在备份并修复…"}
      </p>}
      {phase === "entering" && <p className="workspace-session-repair-progress" role="status">
        正在重试服务端恢复并进入工作区…
      </p>}
      {phase === "ready" && <p className="workspace-session-repair-success" role="status">
        工作区已重新打开。备份位置仍保留在下方。
      </p>}

      {report && <section className="workspace-session-repair-report" aria-label="会话检查报告">
        <div className="workspace-session-repair-summary">
          <strong>{reportFresh ? "最近一次检查" : "上次检查（可能已过期）"}</strong>
          <span>已检查 {report.checkedFiles} 个文件 · {report.issues.length} 个问题</span>
        </div>
        {report.recoveryError && <p className="workspace-session-repair-error" role="alert">
          服务端恢复检查失败：{report.recoveryError}
        </p>}
        {report.truncated && <p className="workspace-session-repair-warning" role="status">
          尚有未展示的问题；先修复列出的可修复项，再重新检查。报告完整且无问题前不能进入工作区。
        </p>}
        {report.issues.length === 0 && reportFresh && !report.truncated && !report.recoveryError
          ? <p className="workspace-session-repair-success" role="status">
              未发现会话文件问题；进入时将重新校验服务端恢复状态。
            </p>
          : report.issues.length === 0 && reportFresh && !report.truncated
            ? <p className="workspace-session-repair-warning" role="status">
                会话文件未报告问题，但服务端恢复状态尚未确认。
              </p>
            : report.issues.length === 0
              ? <p className="workspace-session-repair-note">尚未收到可用于进入工作区的完整、最新检查结果。</p>
              : <ul className="workspace-session-repair-issues">
                  {report.issues.map((issue) => <li key={`${issue.fileName}:${issue.revision}`}>
                    <div className="workspace-session-repair-issue-heading">
                      <code title={issue.fileName}>{issue.fileName}</code>
                      <span>{issue.conversationId ?? "会话身份无法确认"}</span>
                    </div>
                    <p>{issue.error}</p>
                    <small>{repairImpact(issue)}</small>
                  </li>)}
                </ul>}
      </section>}

      {destructiveIssues.length > 0 && <label className="workspace-session-repair-consent">
        <input
          type="checkbox"
          checked={allowDiscard}
          disabled={!online || pending !== undefined || !reportFresh}
          onChange={(event) => setAllowDiscard(event.target.checked)}
        />
        <span>
          我确认允许丢弃所列文件的不完整尾记录；仅影响不完整尾部，完整记录与原文件备份保留。
        </span>
      </label>}

      {backups.length > 0 && <section className="workspace-session-repair-backups" aria-label="原件备份位置">
        <h3>已生成的原件备份</h3>
        <p>备份由服务端按文件精确生成；修复失败或部分提交时，下面列出的已确认备份仍保留。</p>
        <ul>
          {backups.map((backup, index) => <li key={`${backup.fileName}:${backup.backupPath}:${index}`}>
            <strong>{backup.fileName}</strong>
            <code title={backup.backupPath}>{backup.backupPath}</code>
          </li>)}
        </ul>
      </section>}

      <div className="workspace-session-repair-actions">
        <button
          type="button"
          className="ghost"
          data-modal-autofocus={!report ? true : undefined}
          disabled={!online || pending !== undefined || phase === "entering"}
          onClick={onInspect}
        >{pending === "inspect" ? "正在检查…" : "重新检查"}</button>
        {losslessIssues.length > 0 && <button
          type="button"
          disabled={!online || pending !== undefined || !reportFresh}
          onClick={() => onRepair(requestFor(losslessIssues), false)}
        >备份并修复无损项（{losslessIssues.length} 项）</button>}
        {destructiveIssues.length > 0 && <button
          type="button"
          className="danger-action"
          disabled={!online || pending !== undefined || !reportFresh || !allowDiscard}
          onClick={() => onRepair(requestFor(supportedIssues), true)}
        >备份并修复（含丢弃不完整尾记录）</button>}
        {reportFresh
          && report
          && report.issues.length === 0
          && !report.truncated
          && report.recoveryError
          && <button
              type="button"
              disabled={!online || pending !== undefined}
              onClick={onRetryRecovery}
            >仅重试服务端恢复并重新检查</button>}
        {reportIsClean && <button
          type="button"
          disabled={!online || pending !== undefined}
          onClick={onRevalidateAndEnter}
        >重新校验并进入工作区</button>}
        {!closeBlocked && <button type="button" className="ghost" onClick={onClose}>关闭</button>}
        {closeBlocked && <button type="button" className="ghost" disabled>
          {pending === "repair" ? "修复结果待确认" : needsRecheck ? "重新检查后可关闭" : "正在重新校验…"}
        </button>}
      </div>
    </section>
  </div>;
}
