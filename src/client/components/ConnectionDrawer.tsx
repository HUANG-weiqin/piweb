import { useMemo, useState, type FormEvent } from "react";
import type { PublicProvider, PublicState, ThinkingLevel } from "../../shared/protocol";

export function ConnectionDrawer({ state, open, onClose, onKey, onOAuth, onLogout, onModel, onThinking }: {
  state: PublicState;
  open: boolean;
  onClose(): void;
  onKey(provider: string, key: string): void;
  onOAuth(provider: string): void;
  onLogout(provider: string): void;
  onModel(provider: string, modelId: string): void;
  onThinking(level: ThinkingLevel): void;
}) {
  const [keyProvider, setKeyProvider] = useState<PublicProvider>();
  const [key, setKey] = useState("");
  const [search, setSearch] = useState("");
  const models = useMemo(() => state.providers
    .flatMap((provider) => provider.models)
    .filter((model) => model.available)
    .filter((model) => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(search.toLowerCase())),
  [state.providers, search]);
  if (!open) return null;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (keyProvider && key) onKey(keyProvider.id, key);
    setKey("");
    setKeyProvider(undefined);
  };

  return <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <aside className="drawer" aria-label="模型与登录">
      <header><div><h2>模型与登录</h2><p>复用 Pi 原生配置</p></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      <section><h3>提供商</h3>
        <div className="provider-list">{state.providers.map((provider) => <div className="provider" key={provider.id}>
          <div><strong>{provider.name}</strong><small>{provider.configured ? provider.authLabel ?? provider.authSource ?? "已登录" : "未登录"}</small></div>
          <div className="provider-actions">
            {provider.oauth && <button onClick={() => onOAuth(provider.id)}>订阅登录</button>}
            {!provider.oauth && <button onClick={() => setKeyProvider(provider)}>填写 Key</button>}
            {provider.configured && <button className="ghost danger" onClick={() => onLogout(provider.id)}>退出</button>}
          </div>
        </div>)}</div>
      </section>
      <section><h3>模型</h3>
        <input className="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索模型" />
        <div className="model-list">{models.map((model) => {
          const selected = state.selectedModel?.provider === model.provider && state.selectedModel.id === model.id;
          return <button key={`${model.provider}/${model.id}`} disabled={!model.available} className={selected ? "model selected" : "model"} onClick={() => onModel(model.provider, model.id)}>
            <span>{model.id}<small>{model.provider}{model.reasoning ? " · reasoning" : ""}</small></span>{selected && <b>✓</b>}
          </button>;
        })}</div>
      </section>
      <section><h3>思考级别</h3><select value={state.thinkingLevel} onChange={(e) => onThinking(e.target.value as ThinkingLevel)}>
        {(state.availableThinkingLevels ?? [state.thinkingLevel]).map((level) => <option key={level}>{level}</option>)}
      </select></section>
    </aside>
    {keyProvider && <div className="modal-backdrop"><form className="modal" onSubmit={submitKey}>
      <h2>{keyProvider.name}</h2><label htmlFor="api-key">API Key</label>
      <input id="api-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus autoComplete="off" />
      <button disabled={!key}>保存到 Pi</button><button type="button" className="ghost" onClick={() => { setKey(""); setKeyProvider(undefined); }}>取消</button>
    </form></div>}
  </div>;
}
