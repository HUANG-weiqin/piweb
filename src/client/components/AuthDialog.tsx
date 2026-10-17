import { useEffect, useState, type FormEvent } from "react";
import type { AuthRequest } from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export function AuthDialog({ requestId, request, notice, progress, visible = true, onRespond, onCancel }: {
  requestId?: string;
  request?: AuthRequest;
  notice?: AuthRequest;
  progress?: string;
  visible?: boolean;
  onRespond(requestId: string, response: { value?: string; selectedId?: string }): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [requestId]);
  const active = visible && Boolean(request || notice || progress);
  const focusRef = useModalFocus<HTMLElement>(
    active,
    requestId ?? `progress:${progress ?? ""}`,
    onCancel,
  );
  if (!active) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (requestId) {
      const responseValue = value;
      if (request?.kind === "prompt" && request.secret) setValue("");
      onRespond(requestId, { value: responseValue });
    }
  };

  return <div className="modal-backdrop" role="presentation">
    <section ref={focusRef} className="modal" role="dialog" aria-modal="true" aria-label="登录订阅账户" tabIndex={-1}>
      <header className="modal-header">
        <div>
          <p className="eyebrow">ACCOUNT</p>
          <h2>登录订阅账户</h2>
        </div>
      </header>
      {progress && <p className="progress">{progress}</p>}
      {/* Auth URL / device code are informational: they stay visible while a
          separate answerable request (paste code, etc.) is pending. */}
      {notice?.kind === "auth" && <>
        <p>{notice.instructions ?? "在浏览器中完成授权，然后返回这里。"}</p>
        <a className="primary-link" href={notice.url} target="_blank" rel="noreferrer">打开授权页面</a>
      </>}
      {notice?.kind === "device" && <>
        <p>输入设备验证码：</p><code className="device-code">{notice.userCode}</code>
        <a className="primary-link" href={notice.verificationUri} target="_blank" rel="noreferrer">打开验证页面</a>
      </>}
      {(request?.kind === "prompt" || request?.kind === "manual") && <form className="modal-form" onSubmit={submit}>
        <label>{request.message}</label>
        <input
          type={request.kind === "prompt" && request.secret ? "password" : "text"}
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          data-modal-autofocus
        />
        <button disabled={!request.allowEmpty && !value}>继续</button>
      </form>}
      {request?.kind === "select" && <div className="auth-options">
        <p>{request.message}</p>
        {request.options.map((option) => <button
          className="option-button"
          key={option.id}
          onClick={() => requestId && onRespond(requestId, { selectedId: option.id })}
        >
          {option.label}
        </button>)}
      </div>}
      <button className="ghost" onClick={onCancel}>取消登录</button>
    </section>
  </div>;
}
