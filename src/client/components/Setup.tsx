import { useEffect, useState, type FormEvent } from "react";

interface SetupProps {
  initialCwd: string;
  online: boolean;
  unavailableLabel?: string;
  onStart(cwd: string): void;
}

export function Setup({ initialCwd, online, unavailableLabel, onStart }: SetupProps) {
  const [cwd, setCwd] = useState(initialCwd);
  useEffect(() => {
    if (initialCwd) setCwd(initialCwd);
  }, [initialCwd]);
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
        <input
          id="cwd"
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="E:\\projects\\app"
          autoFocus
          spellCheck={false}
        />
      </div>
      <button disabled={!online || !cwd.trim()}>
        {online ? "进入项目" : unavailableLabel ?? "正在连接本地服务…"}
      </button>
      <p className="setup-footnote">
        <span className={online ? "status-dot online" : "status-dot"} />
        {online ? "本地服务已就绪" : "等待本地服务"}
      </p>
    </form>
  </main>;
}
