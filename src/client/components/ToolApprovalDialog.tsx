import { useReducer, useRef } from "react";
import type { ToolApprovalRequest } from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

function formatArgs(args: unknown): string {
  if (args === undefined) return "无参数";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function ToolApprovalDialog({
  request,
  pendingCount,
  online,
  cancelling,
  submitting,
  onDecision,
  onAbort,
}: {
  request?: ToolApprovalRequest;
  pendingCount: number;
  online: boolean;
  cancelling: boolean;
  submitting: boolean;
  onDecision(decision: "allow" | "deny"): boolean;
  onAbort(): void;
}) {
  const decidedApprovalIdRef = useRef("");
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  if (!request) decidedApprovalIdRef.current = "";

  const transitioned = Boolean(
    request
    && decidedApprovalIdRef.current
    && decidedApprovalIdRef.current !== request.approvalId,
  );
  const submittedLocally = request?.approvalId === decidedApprovalIdRef.current;
  const disabled = !online || cancelling || submitting || submittedLocally || transitioned;
  const decide = (decision: "allow" | "deny") => {
    if (!request || disabled) return;
    if (onDecision(decision)) {
      decidedApprovalIdRef.current = request.approvalId;
      rerender();
    }
  };
  const focusRef = useModalFocus<HTMLElement>(
    Boolean(request),
    request?.approvalId ?? "",
    request && !disabled ? () => decide("deny") : undefined,
  );

  if (!request) return null;

  return <div className="modal-backdrop" role="presentation">
    <section
      ref={focusRef}
      className="modal approval-modal"
      role="dialog"
      aria-modal="true"
      aria-label="工具执行审批"
      tabIndex={-1}
    >
      <header>
        <div>
          <h2>允许执行工具？</h2>
          <p className="progress"><code>{request.toolName}</code>{pendingCount > 1 ? ` · 另有 ${pendingCount - 1} 项等待` : ""}</p>
        </div>
      </header>
      {request.reason && <p>{request.reason}</p>}
      <pre className="approval-args">{formatArgs(request.args)}</pre>
      {transitioned && <>
        <p className="progress" role="status">上一项已提交。请明确打开下一项，避免连续点击误批。</p>
        <button onClick={() => {
          decidedApprovalIdRef.current = "";
          rerender();
        }}>
          处理下一项
        </button>
      </>}
      <div className="approval-actions">
        <button
          className="ghost danger"
          disabled={disabled}
          onClick={() => decide("deny")}
        >
          拒绝
        </button>
        <button disabled={disabled} onClick={() => decide("allow")}>
          {submitting ? "正在提交…" : "允许一次"}
        </button>
      </div>
      <button className="ghost" disabled={!online || cancelling} onClick={onAbort}>
        {cancelling ? "正在停止…" : "停止本次运行"}
      </button>
    </section>
  </div>;
}
