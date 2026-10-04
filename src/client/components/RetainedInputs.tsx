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
  onRestore(key: string): void;
  onDiscard(key: string): void;
}

function RetainedInputRow({
  input, currentScopeKey, canRestore, onRestore, onDiscard,
}: Omit<RetainedInputsProps, "inputs"> & { input: RetainedPromptInput }) {
  const [originalOpen, setOriginalOpen] = useState(false);
  return <article className="retained-input">
    <div className="retained-input-summary">
      <span className="retained-input-text" title={input.text}>{input.text || "[图片]"}</span>
      <span>{input.images.length > 0 ? `${input.images.length} 张图片 · ` : ""}{
        input.status === "cancelled" ? "已停止，待恢复"
          : input.status === "admitted" ? "已接收，投递待确认"
          : "发送状态未确认/请核对历史"
      }</span>
    </div>
    {input.scopeKey !== currentScopeKey && <p className="retained-input-scope"
      title={`${input.workspaceKey}\n项目 ${input.projectId}\n会话 ${input.conversationId}`}>
      {input.workspaceKey} · 会话 #{input.conversationId.slice(0, 8)}
    </p>}
    <div className="retained-input-actions">
      <button type="button" disabled={!canRestore || input.scopeKey !== currentScopeKey
        || (input.status !== "cancelled" && input.status !== "unknown")}
        onClick={() => onRestore(input.key)}>恢复到输入框</button>
      <button type="button" onClick={() => onDiscard(input.key)}
        title="只丢弃本地副本，不撤回等待中的消息">丢弃副本</button>
    </div>
    <details className="retained-input-original" onToggle={(event) => setOriginalOpen(event.currentTarget.open)}>
      <summary>查看原输入</summary>
      {originalOpen && <>
        <pre>{input.text}</pre>
        <div className="retained-input-images">{input.images.map((image, index) =>
          <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`保留的原图 ${index + 1}`} />
        )}</div>
      </>}
    </details>
  </article>;
}

export function RetainedInputs({
  inputs, currentScopeKey, canRestore, onRestore, onDiscard,
}: RetainedInputsProps) {
  if (inputs.length === 0) return null;
  const current = inputs.filter((input) => input.scopeKey === currentScopeKey);
  const other = inputs.filter((input) => input.scopeKey !== currentScopeKey);
  const row = (input: RetainedPromptInput) => <RetainedInputRow key={input.key} input={input}
    currentScopeKey={currentScopeKey} canRestore={canRestore} onRestore={onRestore} onDiscard={onDiscard} />;
  return <section className="retained-inputs" aria-label="保留的原输入">
    <h2>保留的原输入 <span>{inputs.length}</span></h2>
    <p>仅保存在此标签页；刷新或关闭后丢失。恢复只填入空草稿，不会发送。</p>
    {current.map(row)}
    {other.length > 0 && <details className="retained-inputs-other">
      <summary>其他会话的副本（{other.length}）</summary>
      {other.map(row)}
    </details>}
  </section>;
}
