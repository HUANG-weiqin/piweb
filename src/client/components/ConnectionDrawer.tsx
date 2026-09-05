import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AcknowledgedSettingOperation,
  PublicState,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

interface ConnectionDrawerProps {
  state: PublicState;
  open: boolean;
  online: boolean;
  settingResult?: {
    operation: AcknowledgedSettingOperation;
    commandId: string;
    ok: boolean;
    message: string;
  };
  onClose(): void;
  onKey(provider: string, key: string): string | undefined;
  onOAuth(provider: string): void;
  onLogout(provider: string): void;
  onRefresh(): string | undefined;
  onClearSettingResult(): void;
  onKeyDialogChange(open: boolean): void;
}

function initialProviderId(state: PublicState): string {
  if (
    state.selectedModel?.provider
    && state.providers.some((provider) => provider.id === state.selectedModel?.provider)
  ) {
    return state.selectedModel.provider;
  }
  const configured = state.providers.find((provider) => provider.configured);
  if (configured) return configured.id;
  return state.providers.length === 1 ? state.providers[0]?.id ?? "" : "";
}

function formatContextWindow(tokens: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M 上下文`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K 上下文`;
  return `${tokens} 上下文`;
}

function modelActionLabel(selected: boolean): string {
  return selected ? "当前会话" : "在角色中选择";
}

export function ConnectionDrawer({
  state,
  open,
  online,
  settingResult,
  onClose,
  onKey,
  onOAuth,
  onLogout,
  onRefresh,
  onClearSettingResult,
  onKeyDialogChange,
}: ConnectionDrawerProps) {
  const [providerId, setProviderId] = useState(() => initialProviderId(state));
  const [keyProviderId, setKeyProviderId] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [savingKey, setSavingKey] = useState<{
    providerId: string;
    commandId: string;
  }>();
  const [savedKeyProviderId, setSavedKeyProviderId] = useState("");
  const [confirmLogoutProviderId, setConfirmLogoutProviderId] = useState("");
  const [search, setSearch] = useState("");
  const [refreshingModels, setRefreshingModels] = useState<{
    sessionId: string;
    commandId: string;
  }>();
  const [refreshStatus, setRefreshStatus] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (providerId && state.providers.some((provider) => provider.id === providerId)) return;
    setProviderId(initialProviderId(state));
  }, [providerId, state]);

  useEffect(() => {
    if (
      !savingKey
      || settingResult?.operation !== "set_api_key"
      || settingResult.commandId !== savingKey.commandId
    ) return;
    if (!settingResult.ok) {
      setSavingKey(undefined);
      setKeyError(settingResult.message || "API Key 保存失败");
      onClearSettingResult();
      return;
    }
    setSavedKeyProviderId(savingKey.providerId);
    setSavingKey(undefined);
    setKey("");
    setKeyProviderId("");
    setShowKey(false);
    onKeyDialogChange(false);
    onClearSettingResult();
  }, [
    onClearSettingResult,
    onKeyDialogChange,
    savingKey,
    settingResult,
  ]);

  useEffect(() => {
    if (
      !refreshingModels
      || refreshingModels.sessionId !== state.sessionId
      || settingResult?.operation !== "refresh_models"
      || settingResult.commandId !== refreshingModels.commandId
    ) return;
    setRefreshingModels(undefined);
    setRefreshStatus({
      ok: settingResult.ok,
      message: settingResult.ok
        ? "远程供应商模型目录已刷新。"
        : settingResult.message || "远程供应商模型目录刷新失败。",
    });
    onClearSettingResult();
  }, [onClearSettingResult, refreshingModels, settingResult, state.sessionId]);

  useEffect(() => {
    if (!refreshingModels || refreshingModels.sessionId === state.sessionId) return;
    setRefreshingModels(undefined);
    setRefreshStatus({
      ok: false,
      message: "观察会话已更换，刷新状态未确认；请重试。",
    });
    onClearSettingResult();
  }, [onClearSettingResult, refreshingModels, state.sessionId]);

  useEffect(() => {
    if (online) return;
    if (savingKey) {
      setSavingKey(undefined);
      setKey("");
      setShowKey(false);
      setKeyError("连接已断开，无法确认 Key 是否保存；请重连后重试。");
    }
    if (refreshingModels) {
      setRefreshingModels(undefined);
      setRefreshStatus({
        ok: false,
        message: "连接已断开，刷新状态未确认；请重连后重试。",
      });
    }
    onClearSettingResult();
  }, [online, onClearSettingResult, refreshingModels, savingKey]);

  const selectedProvider = state.providers.find((provider) => provider.id === providerId);
  const keyProvider = state.providers.find((provider) => provider.id === keyProviderId);
  const currentModel = state.providers
    .flatMap((provider) => provider.models)
    .find((model) => (
      model.provider === state.selectedModel?.provider
      && model.id === state.selectedModel.id
    ));
  const availableModels = useMemo(
    () => selectedProvider?.models.filter((model) => model.available) ?? [],
    [selectedProvider],
  );
  const models = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) => (
      `${model.name} ${model.id}`.toLowerCase().includes(query)
    ));
  }, [availableModels, search]);

  useEffect(() => {
    if (!savedKeyProviderId) return;
    const timer = window.setTimeout(() => setSavedKeyProviderId(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [savedKeyProviderId]);

  useEffect(() => {
    if (!savedKeyProviderId) return;
    const provider = state.providers.find(({ id }) => id === savedKeyProviderId);
    if (!provider?.configured) setSavedKeyProviderId("");
  }, [savedKeyProviderId, state.providers]);

  useEffect(() => {
    if (!confirmLogoutProviderId) return;
    const provider = state.providers.find(({ id }) => id === confirmLogoutProviderId);
    if (!provider?.configured) setConfirmLogoutProviderId("");
  }, [confirmLogoutProviderId, state.providers]);

  useEffect(() => {
    if (!keyProviderId || keyProvider) return;
    setKeyProviderId("");
    setKey("");
    setSavingKey(undefined);
    onKeyDialogChange(false);
  }, [keyProvider, keyProviderId, onKeyDialogChange]);

  const closeKeyDialog = () => {
    if (savingKey) return;
    setKey("");
    setKeyError("");
    setKeyProviderId("");
    setShowKey(false);
    onKeyDialogChange(false);
  };
  const drawerFocusRef = useModalFocus<HTMLElement>(
    open,
    "connection-drawer",
    onClose,
  );
  const keyFocusRef = useModalFocus<HTMLFormElement>(
    Boolean(open && keyProvider),
    keyProviderId,
    closeKeyDialog,
  );
  if (!open) return null;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!online || !keyProvider || !value || savingKey) return;
    setKeyError("");
    const commandId = onKey(keyProvider.id, value);
    if (commandId) {
      setSavingKey({ providerId: keyProvider.id, commandId });
      setKey("");
      setShowKey(false);
    }
  };
  const chooseProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setSearch("");
    setSavedKeyProviderId("");
    setConfirmLogoutProviderId("");
    setRefreshStatus(undefined);
    onClearSettingResult();
  };
  const openKeyDialog = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    setKeyProviderId(nextProviderId);
    setKey("");
    setShowKey(false);
    setKeyError("");
    setSavingKey(undefined);
    onKeyDialogChange(true);
    onClearSettingResult();
  };
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  }}>
    <aside
      ref={drawerFocusRef}
      className="drawer"
      role={keyProvider ? undefined : "dialog"}
      aria-modal={keyProvider ? undefined : true}
      aria-hidden={keyProvider ? true : undefined}
      aria-label="模型连接"
      tabIndex={-1}
    >
      <header className="drawer-header">
        <div>
          <p className="eyebrow">MODEL CONNECTIONS</p>
          <h2>模型连接</h2>
          <p>连接服务提供商并查看可用模型</p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>

      <section className="settings-section model-settings">
        <div className="current-model">
          <div>
            <span className="setting-label">当前模型</span>
            <strong>{currentModel?.name ?? state.selectedModel?.id ?? "尚未选择"}</strong>
            <small>
              {state.selectedModel
                ? state.selectedModel.id
                : "连接一个提供商，然后选择模型"}
            </small>
          </div>
          <span className={state.selectedModel ? "status-badge success" : "status-badge"}>
            {state.selectedModel ? "可用" : "待设置"}
          </span>
        </div>

        <div className="setting-step">
          <div className="step-heading">
            <span className="step-number">1</span>
            <div><h3>提供商</h3><p>凭据保存在本机，由所有项目共享</p></div>
          </div>
          <select
            aria-label="提供商"
            value={providerId}
            disabled={Boolean(savingKey)}
            onChange={(event) => chooseProvider(event.target.value)}
          >
            <option value="">选择提供商…</option>
            {state.providers.map((provider) => <option key={provider.id} value={provider.id}>
              {provider.name}{provider.configured ? " · 已配置" : ""}
            </option>)}
          </select>

          {selectedProvider && <div className="provider-summary">
            <div className="provider-identity">
              <div>
                <strong>{selectedProvider.name}</strong>
                <small>
                  {selectedProvider.configured
                    ? selectedProvider.authLabel ?? selectedProvider.authSource ?? "凭据已配置"
                    : "尚未配置凭据"}
                </small>
              </div>
              <span className={selectedProvider.configured ? "status-badge success" : "status-badge"}>
                {selectedProvider.configured ? "已配置" : "未配置"}
              </span>
            </div>
            <div className="provider-actions">
              {selectedProvider.oauth && <button
                type="button"
                disabled={!online || state.busy}
                onClick={() => onOAuth(selectedProvider.id)}
              >
                {selectedProvider.configured ? "重新登录" : "登录订阅账户"}
              </button>}
              {!selectedProvider.oauth && <button
                type="button"
                disabled={!online || state.busy}
                onClick={() => openKeyDialog(selectedProvider.id)}
              >
                {selectedProvider.configured ? "更新 API Key" : "使用 API Key"}
              </button>}
              {selectedProvider.configured
                && confirmLogoutProviderId !== selectedProvider.id
                && <button
                type="button"
                className="ghost danger"
                disabled={!online || state.busy}
                onClick={() => setConfirmLogoutProviderId(selectedProvider.id)}
              >
                移除本机凭据
              </button>}
            </div>
            {confirmLogoutProviderId === selectedProvider.id && <div
              className="credential-confirm"
              role="alert"
            >
              <p>这会从当前用户的 Pi 配置中移除凭据，并影响所有项目。</p>
              <div className="provider-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmLogoutProviderId("")}
                >
                  保留
                </button>
                <button
                  type="button"
                  className="danger-button"
                  disabled={!online || state.busy}
                  onClick={() => {
                    setSavedKeyProviderId("");
                    setConfirmLogoutProviderId("");
                    onLogout(selectedProvider.id);
                  }}
                >
                  确认移除
                </button>
              </div>
            </div>}
            {savedKeyProviderId === selectedProvider.id && <p className="inline-status success" role="status">
              API Key 已保存，模型列表已刷新。
            </p>}
          </div>}
        </div>

        <div className="setting-step">
          <div className="step-heading">
            <span className="step-number">2</span>
            <div>
              <h3>模型目录</h3>
              <p>会话模型由创建时的角色固定，这里只展示当前可用模型</p>
            </div>
          </div>
          {selectedProvider?.configured && availableModels.length > 0 && <input
            className="search"
            aria-label="搜索模型"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={`搜索 ${selectedProvider.name} 模型`}
          />}
          <div className="provider-actions model-refresh-actions">
            <button
              type="button"
              className="ghost"
              disabled={!online || state.busy || Boolean(refreshingModels)}
              onClick={() => {
                const commandId = onRefresh();
                if (!commandId) return;
                setRefreshingModels({ sessionId: state.sessionId, commandId });
                setRefreshStatus(undefined);
              }}
            >
              {refreshingModels ? "正在刷新模型…" : "刷新模型"}
            </button>
            {refreshStatus && <p
              className={`inline-status ${refreshStatus.ok ? "success" : "error"}`}
              role={refreshStatus.ok ? "status" : "alert"}
            >
              {refreshStatus.message}
            </p>}
          </div>
          <div className="model-list">
            {!selectedProvider && <div className="setting-empty">
              <strong>先选择提供商</strong>
              <p>这里只展示一个提供商的模型，避免在完整模型库里迷路。</p>
            </div>}
            {selectedProvider && !selectedProvider.configured && <div className="setting-empty">
              <strong>先配置 {selectedProvider.name}</strong>
              <p>凭据保存在本机 Pi 配置中，不会写入项目。</p>
            </div>}
            {selectedProvider?.configured && availableModels.length === 0 && <div className="setting-empty">
              <strong>暂无可用模型</strong>
              <p>检查凭据，或刷新远程供应商模型目录。</p>
            </div>}
            {selectedProvider?.configured && availableModels.length > 0 && models.length === 0 && <div className="setting-empty">
              <strong>没有匹配结果</strong>
              <p>换一个名称或模型 ID 试试。</p>
            </div>}
            {models.map((model) => {
              const modelKey = `${model.provider}/${model.id}`;
              const selected = state.selectedModel?.provider === model.provider
                && state.selectedModel.id === model.id;
              const metadata = [
                model.id === model.name ? "" : model.id,
                model.reasoning ? "支持推理" : "",
                formatContextWindow(model.contextWindow),
              ].filter(Boolean).join(" · ");
              return <button
                type="button"
                key={modelKey}
                aria-current={selected ? "true" : undefined}
                disabled
                className={selected ? "model selected" : "model"}
                title="请在角色管理中为新会话选择模型"
              >
                <span><strong>{model.name}</strong><small>{metadata}</small></span>
                <b>{modelActionLabel(selected)}</b>
              </button>;
            })}
          </div>
        </div>
      </section>
    </aside>
    {keyProvider && <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        closeKeyDialog();
      }}
    ><form
      ref={keyFocusRef}
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${keyProvider.name} API Key`}
      tabIndex={-1}
      onSubmit={submitKey}
    >
      <header className="modal-header">
        <div>
          <p className="eyebrow">API KEY</p>
          <h2>{keyProvider.name}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭 API Key 设置"
          disabled={Boolean(savingKey)}
          onClick={closeKeyDialog}
        >×</button>
      </header>
      <p className="modal-description">
        仅保存到当前用户的本机 Pi 配置，不写入项目或浏览器存储；保存后不会回显。
      </p>
      <label htmlFor="api-key">API Key</label>
      <div className="secret-field">
        <input
          id="api-key"
          type={showKey ? "text" : "password"}
          value={key}
          maxLength={32_768}
          disabled={Boolean(savingKey)}
          onChange={(event) => setKey(event.target.value)}
          data-modal-autofocus
          autoComplete="new-password"
          spellCheck={false}
        />
        <button
          type="button"
          className="ghost"
          disabled={Boolean(savingKey)}
          onClick={() => setShowKey((visible) => !visible)}
        >
          {showKey ? "隐藏" : "显示"}
        </button>
      </div>
      {keyError && <p className="inline-status error" role="alert">{keyError}</p>}
      <button disabled={!online || !key.trim() || Boolean(savingKey)}>
        {savingKey ? "正在保存…" : "保存 API Key"}
      </button>
      <button
        type="button"
        className="ghost"
        disabled={Boolean(savingKey)}
        onClick={closeKeyDialog}
      >
        取消
      </button>
    </form></div>}
  </div>;
}
