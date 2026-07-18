import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ConversationSummary,
  PublicProvider,
  PublicState,
  ThinkingLevel,
  ToolMode,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

interface ConnectionDrawerProps {
  state: PublicState;
  conversations: ConversationSummary[];
  conversationIndexTruncated: boolean;
  open: boolean;
  toolModeBusy: boolean;
  conversationBusy: boolean;
  onClose(): void;
  onNewConversation(): void;
  onOpenConversation(conversationId: string): void;
  onRenameConversation(name: string): void;
  onKey(provider: string, key: string): void;
  onOAuth(provider: string): void;
  onLogout(provider: string): void;
  onModel(provider: string, modelId: string): void;
  onThinking(level: ThinkingLevel): void;
  onToolMode(mode: ToolMode): void;
}

export function ConnectionDrawer({
  state,
  conversations,
  conversationIndexTruncated,
  open,
  toolModeBusy,
  conversationBusy,
  onClose,
  onNewConversation,
  onOpenConversation,
  onRenameConversation,
  onKey,
  onOAuth,
  onLogout,
  onModel,
  onThinking,
  onToolMode,
}: ConnectionDrawerProps) {
  const [keyProvider, setKeyProvider] = useState<PublicProvider>();
  const [key, setKey] = useState("");
  const [search, setSearch] = useState("");
  const [conversationName, setConversationName] = useState(state.conversationName ?? "");
  useEffect(() => {
    setConversationName(state.conversationName ?? "");
  }, [state.conversationId, state.conversationName]);
  const models = useMemo(() => state.providers
    .flatMap((provider) => provider.models)
    .filter((model) => model.available)
    .filter((model) => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(search.toLowerCase())),
  [state.providers, search]);
  const closeKeyDialog = () => {
    setKey("");
    setKeyProvider(undefined);
  };
  const drawerFocusRef = useModalFocus<HTMLElement>(
    open && !keyProvider,
    "connection-drawer",
    onClose,
  );
  const keyFocusRef = useModalFocus<HTMLFormElement>(
    Boolean(open && keyProvider),
    keyProvider?.id ?? "",
    closeKeyDialog,
  );
  if (!open) return null;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    if (keyProvider && key) onKey(keyProvider.id, key);
    setKey("");
    setKeyProvider(undefined);
  };
  const submitConversationName = (event: FormEvent) => {
    event.preventDefault();
    const name = conversationName.trim();
    if (name && name !== state.conversationName) onRenameConversation(name);
  };

  return <div className="drawer-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <aside
      ref={drawerFocusRef}
      className="drawer"
      role="dialog"
      aria-modal="true"
      aria-label="工作台设置"
      tabIndex={-1}
    >
      <header><div><h2>工作台设置</h2><p>项目状态与 Pi 原生配置</p></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
      <section><div className="section-heading"><h3>项目对话</h3>
        <button type="button" disabled={conversationBusy} onClick={onNewConversation}>新建对话</button>
      </div>
        <form className="conversation-name" onSubmit={submitConversationName}>
          <input
            aria-label="当前对话名称"
            value={conversationName}
            disabled={conversationBusy}
            maxLength={120}
            placeholder="给当前对话命名"
            onChange={(event) => setConversationName(event.target.value)}
          />
          <button
            type="submit"
            disabled={
              conversationBusy
              || !conversationName.trim()
              || conversationName.trim() === state.conversationName
            }
          >保存名称</button>
        </form>
        <div className="conversation-list">
          {conversations.map((conversation) => {
            const selected = conversation.id === state.conversationId;
            const label = conversation.name || conversation.preview || "新对话";
            return <button
              type="button"
              key={conversation.id}
              className={selected ? "conversation selected" : "conversation"}
              disabled={conversationBusy || selected}
              onClick={() => onOpenConversation(conversation.id)}
            >
              <span>{label}<small>{conversation.messageCount} 条消息</small></span>
              {selected && <b>当前</b>}
            </button>;
          })}
        </div>
        {conversationIndexTruncated && <p className="setting-note">
          当前仅显示最近的对话，较旧或过长的索引内容已省略。
        </p>}
      </section>
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
      <section><h3>工具权限</h3>
        <select
          aria-label="工具权限"
          value={state.toolMode}
          disabled={toolModeBusy}
          onChange={(e) => onToolMode(e.target.value as ToolMode)}
        >
          <option value="workspace_write">工作区可写</option>
          <option value="read_only">只读</option>
        </select>
        <p className="setting-note">
          {state.toolMode === "read_only"
            ? "仅允许读取与搜索；写入、命令和未知工具会被阻止。"
            : "项目内写入自动允许；项目外写入、命令和未知工具需要审批。"}
        </p>
      </section>
    </aside>
    {keyProvider && <div className="modal-backdrop" role="presentation"><form
      ref={keyFocusRef}
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${keyProvider.name} API Key`}
      tabIndex={-1}
      onSubmit={submitKey}
    >
      <h2>{keyProvider.name}</h2><label htmlFor="api-key">API Key</label>
      <input id="api-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoFocus autoComplete="off" />
      <button disabled={!key}>保存到 Pi</button><button type="button" className="ghost" onClick={closeKeyDialog}>取消</button>
    </form></div>}
  </div>;
}
