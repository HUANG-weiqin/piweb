import type { FormEvent } from "react";

interface SetupProps {
  cwd: string;
  online: boolean;
  pickingDirectory: boolean;
  unavailableLabel?: string;
  onCwdChange(cwd: string): void;
  onPickDirectory(): void;
  onStart(cwd: string): void;
}

export function Setup({
  cwd,
  online,
  pickingDirectory,
  unavailableLabel,
  onCwdChange,
  onPickDirectory,
  onStart,
}: SetupProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cwd.trim()) onStart(cwd.trim());
  };
  return <main className="setup-shell">
    <form className="setup-card" onSubmit={submit}>
      <div className="setup-brand">
        <div className="logo">π</div>
        <div>
          <p className="eyebrow">PI WEB</p>
          <h1>打开工作台</h1>
        </div>
      </div>
      <p className="setup-intro">
        选择一个项目。Agent 的会话与状态会跟随项目保存在 <code>.piweb</code> 中。
      </p>
      <div className="field">
        <label htmlFor="cwd">项目目录</label>
        <div className="setup-directory-row">
          <input
            id="cwd"
            value={cwd}
            onChange={(event) => onCwdChange(event.target.value)}
            placeholder="E:\\projects\\app"
            autoFocus
            spellCheck={false}
          />
          <button
            type="button"
            className="ghost setup-directory-button"
            disabled={!online || pickingDirectory}
            aria-busy={pickingDirectory}
            aria-haspopup="dialog"
            aria-expanded={pickingDirectory}
            onClick={onPickDirectory}
          >
            {pickingDirectory ? "正在选择…" : "选择文件夹"}
          </button>
        </div>
        <span className="setup-directory-hint">
          浏览文件夹，或直接粘贴绝对路径
        </span>
      </div>
      <button disabled={!online || pickingDirectory || !cwd.trim()}>
        {online ? "进入项目" : unavailableLabel ?? "正在连接本地服务…"}
      </button>
      <p className="setup-footnote">
        <span className={online ? "status-dot online" : "status-dot"} />
        {online ? "本地服务已就绪" : "等待本地服务"}
      </p>
    </form>
  </main>;
}
