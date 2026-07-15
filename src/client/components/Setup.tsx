import { useEffect, useState, type FormEvent } from "react";

export function Setup({ initialCwd, online, onStart }: { initialCwd: string; online: boolean; onStart(cwd: string): void }) {
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
      <div className="logo">π</div>
      <h1>Pi Web</h1>
      <p>选择 Agent 的工作目录。对话仅保存在内存中。</p>
      <label htmlFor="cwd">工作目录</label>
      <input id="cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="E:\\projects\\app" autoFocus spellCheck={false} />
      <button disabled={!online || !cwd.trim()}>{online ? "开始" : "正在连接本地服务…"}</button>
    </form>
  </main>;
}
