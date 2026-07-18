import { useEffect, useState, type FormEvent } from "react";
import type {
  ExtensionUIRequest,
  ExtensionUIResponse,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export interface PendingExtensionUI {
  requestId: string;
  request: ExtensionUIRequest;
}

export function ExtensionDialog({
  pending,
  pendingCount,
  online,
  visible = true,
  onRespond,
}: {
  pending?: PendingExtensionUI;
  pendingCount: number;
  online: boolean;
  visible?: boolean;
  onRespond(requestId: string, response: ExtensionUIResponse): boolean;
}) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setValue(pending?.request.kind === "editor" ? pending.request.prefill ?? "" : "");
    setSubmitted(false);
  }, [pending?.requestId]);

  const respond = (response: ExtensionUIResponse) => {
    if (!pending || !online || submitted) return;
    if (onRespond(pending.requestId, response)) setSubmitted(true);
  };
  const focusRef = useModalFocus<HTMLElement>(
    Boolean(visible && pending),
    pending?.requestId ?? "",
    pending && online && !submitted
      ? () => respond({ kind: "cancel" })
      : undefined,
  );

  if (!pending || !visible) return null;
  const { request } = pending;
  const titleId = `extension-title-${pending.requestId}`;
  const descriptionId = request.kind === "confirm"
    ? `extension-description-${pending.requestId}`
    : undefined;
  const submitValue = (event: FormEvent) => {
    event.preventDefault();
    if (request.kind === "input" || request.kind === "editor") {
      respond({ kind: request.kind, value });
    }
  };

  return <div className="modal-backdrop" role="presentation">
    <section
      ref={focusRef}
      className="modal extension-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={submitted}
      tabIndex={-1}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">PI EXTENSION</p>
          <h2 id={titleId}>{request.title}</h2>
        </div>
        {pendingCount > 1 && <span className="status-badge">{pendingCount - 1} 项等待</span>}
      </header>

      {request.kind === "select" && <div className="extension-options">
        {request.options.map((option, index) => <button
          className="option-button"
          key={`${index}:${option}`}
          disabled={!online || submitted}
          onClick={() => respond({ kind: "select", value: option })}
        >
          {option}
        </button>)}
        {request.options.length === 0 && <p className="progress">扩展没有提供可选项。</p>}
      </div>}

      {request.kind === "confirm" && <>
        <p id={descriptionId} className="extension-message">{request.message}</p>
        <div className="approval-actions">
          <button
            className="ghost"
            disabled={!online || submitted}
            onClick={() => respond({ kind: "confirm", confirmed: false })}
          >
            否
          </button>
          <button
            disabled={!online || submitted}
            onClick={() => respond({ kind: "confirm", confirmed: true })}
          >
            是
          </button>
        </div>
      </>}

      {(request.kind === "input" || request.kind === "editor") && <form className="modal-form" onSubmit={submitValue}>
        {request.kind === "editor"
          ? <textarea
              className="extension-editor"
              aria-label={request.title}
              value={value}
              maxLength={200_000}
              disabled={!online || submitted}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              data-modal-autofocus
            />
          : <input
              aria-label={request.title}
              value={value}
              placeholder={request.placeholder}
              maxLength={200_000}
              disabled={!online || submitted}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              data-modal-autofocus
            />}
        <button disabled={!online || submitted} type="submit">
          {submitted ? "正在提交…" : "完成"}
        </button>
      </form>}

      {submitted && <p className="progress" role="status">
        正在提交，等待扩展确认…
      </p>}

      <button
        className="ghost"
        disabled={!online || submitted}
        onClick={() => respond({ kind: "cancel" })}
      >
        取消
      </button>
    </section>
  </div>;
}
