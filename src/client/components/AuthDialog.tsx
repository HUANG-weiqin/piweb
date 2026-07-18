import { useEffect, useState, type FormEvent } from "react";
import type { AuthRequest } from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

export function AuthDialog({ requestId, request, progress, onRespond, onCancel }: {
  requestId?: string;
  request?: AuthRequest;
  progress?: string;
  onRespond(requestId: string, response: { value?: string; selectedId?: string }): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => setValue(""), [requestId]);
  const visible = Boolean(request || progress);
  const focusRef = useModalFocus<HTMLElement>(
    visible,
    requestId ?? `progress:${progress ?? ""}`,
    onCancel,
  );
  if (!request && !progress) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (requestId) onRespond(requestId, { value });
  };

  return <div className="modal-backdrop" role="presentation">
    <section ref={focusRef} className="modal" role="dialog" aria-modal="true" aria-label="订阅登录" tabIndex={-1}>
      <h2>订阅登录</h2>
      {progress && <p className="progress">{progress}</p>}
      {request?.kind === "auth" && <>
        <p>{request.instructions ?? "在浏览器中完成授权，然后返回这里。"}</p>
        <a className="primary-link" href={request.url} target="_blank" rel="noreferrer">打开授权页面</a>
      </>}
      {request?.kind === "device" && <>
        <p>输入设备验证码：</p><code className="device-code">{request.userCode}</code>
        <a className="primary-link" href={request.verificationUri} target="_blank" rel="noreferrer">打开验证页面</a>
      </>}
      {(request?.kind === "prompt" || request?.kind === "manual") && <form onSubmit={submit}>
        <label>{request.message}</label>
        <input value={value} placeholder={request.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus />
        <button disabled={!request.allowEmpty && !value}>继续</button>
      </form>}
      {request?.kind === "select" && <div className="auth-options">
        <p>{request.message}</p>
        {request.options.map((option) => <button key={option.id} onClick={() => requestId && onRespond(requestId, { selectedId: option.id })}>{option.label}</button>)}
      </div>}
      <button className="ghost danger" onClick={onCancel}>取消登录</button>
    </section>
  </div>;
}
