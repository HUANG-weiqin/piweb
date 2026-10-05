import { useState } from "react";
import type { PromptImage } from "../../shared/protocol";

export interface RetainedPromptInput {
  key: string;
  scopeKey: string;
  workspaceKey: string;
  projectId: string;
  conversationId: string;
  sessionId: string;
  focusId: string;
  /** Disposable browser prompt run candidate, not the SDK admission run. */
  runId: string;
  actualRunId?: string;
  receiptFocus?: { sessionId: string; focusId: string };
  promptId: string;
  text: string;
  images: PromptImage[];
  bytes: number;
  status: "reserved" | "admitted" | "unknown" | "cancelled";
}

export interface RetainedInputsProps {
  inputs: RetainedPromptInput[];
  currentScopeKey?: string;
  canRestore: boolean;
  restoreDisabledReason?: string;
  /** The mobile sheet already owns the disclosure and heading. */
  inline?: boolean;
  onRestore(key: string): void;
  onDiscard(key: string): void;
}

function RetainedInputRow({
  input, currentScopeKey, canRestore, restoreDisabledReason, onRestore, onDiscard,
}: Omit<RetainedInputsProps, "inputs" | "inline"> & { input: RetainedPromptInput }) {
  const [originalOpen, setOriginalOpen] = useState(false);
  const otherScope = input.scopeKey !== currentScopeKey;
  const restorable = canRestore && !otherScope
    && (input.status === "cancelled" || input.status === "unknown");
  const reason = otherScope
    ? "请先打开这条输入所在的会话"
    : restoreDisabledReason ?? "请先返回原会话，等待切换完成";
  const preview = input.text.slice(0, 160).replace(/\s+/g, " ").trim();
  return <article className="retained-input">
    <details className="retained-input-original" onToggle={(event) => setOriginalOpen(event.currentTarget.open)}>
      <summary className="retained-input-summary" title="展开原文和图片">
        <span className="retained-input-text">{preview || "[图片]"}{input.text.length > 160 ? "…" : ""}</span>
        {input.images.length > 0 && <span className="retained-input-image-count">{input.images.length} 张图片</span>}
        <span className="retained-input-state">{input.status === "cancelled" ? "已停止" : "需核对"}</span>
      </summary>
      {originalOpen && <div className="retained-input-original-content">
        <pre>{input.text}</pre>
        <div className="retained-input-images">{input.images.map((image, index) =>
          <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`保留的原图 ${index + 1}`} />
        )}</div>
      </div>}
    </details>
    {otherScope && <p className="retained-input-scope"
      title={`${input.workspaceKey}\n项目 ${input.projectId}\n会话 ${input.conversationId}`}>
      原会话 · {input.workspaceKey} · #{input.conversationId.slice(0, 8)}
    </p>}
    <div className="retained-input-actions">
      <button type="button" disabled={!restorable} title={restorable ? undefined : reason}
        onClick={() => onRestore(input.key)}>恢复到输入框</button>
      <button type="button" onClick={() => onDiscard(input.key)} title="只丢弃这条本地副本">丢弃</button>
      {!restorable && <span className="retained-input-reason">{reason}</span>}
    </div>
  </article>;
}

export function RetainedInputs({
  inputs, currentScopeKey, canRestore, restoreDisabledReason, inline = false, onRestore, onDiscard,
}: RetainedInputsProps) {
  if (inputs.length === 0) return null;
  const current = inputs.filter((input) => input.scopeKey === currentScopeKey);
  const other = inputs.filter((input) => input.scopeKey !== currentScopeKey);
  const content = <section className="retained-inputs-content" aria-label="恢复输入">
    <p className="retained-inputs-help">恢复只填入空输入框，不会发送。</p>
    {inputs.some((input) => input.status === "unknown") && <p className="retained-inputs-warning">
      需核对的输入可能已投递，请先查看对话。
    </p>}
    {[...current, ...other].map((input) => <RetainedInputRow key={input.key} input={input}
      currentScopeKey={currentScopeKey} canRestore={canRestore} restoreDisabledReason={restoreDisabledReason}
      onRestore={onRestore} onDiscard={onDiscard} />)}
    <small className="retained-inputs-lifetime" title="副本只保存在当前标签页，刷新或关闭页面不保证保留。">仅当前标签页保留</small>
  </section>;
  return inline ? <div className="retained-inputs retained-inputs-inline">{content}</div>
    : <details className="retained-inputs">
      <summary className="retained-inputs-toggle" title="副本只保存在当前标签页，刷新或关闭页面不保证保留。">恢复输入 · {inputs.length} 条</summary>
      {content}
    </details>;
}
