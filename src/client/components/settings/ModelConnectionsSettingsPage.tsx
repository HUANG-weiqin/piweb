import { useMemo } from "react";
import type { PublicState } from "../../../shared/protocol";

const EMPTY_PROVIDERS: PublicState["providers"] = [];

function formatContextWindow(tokens: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M 上下文`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K 上下文`;
  return `${tokens} 上下文`;
}

function modelActionLabel(selected: boolean): string {
  return selected ? "当前会话" : "在角色中选择";
}

interface ModelConnectionsSettingsPageProps {
  state?: PublicState;
  online: boolean;
  providerId: string;
  search: string;
  savedKeyProviderId: string;
  confirmLogoutProviderId: string;
  refreshing: boolean;
  refreshStatus?: { ok: boolean; message: string };
  onChooseProvider(providerId: string): void;
  onSearch(search: string): void;
  onOpenKey(providerId: string): void;
  onOAuth(providerId: string): void;
  onRequestLogout(providerId: string): void;
  onCancelLogout(): void;
  onConfirmLogout(providerId: string): void;
  onRefresh(): void;
}

export function ModelConnectionsSettingsPage({
  state,
  online,
  providerId,
  search,
  savedKeyProviderId,
  confirmLogoutProviderId,
  refreshing,
  refreshStatus,
  onChooseProvider,
  onSearch,
  onOpenKey,
  onOAuth,
  onRequestLogout,
  onCancelLogout,
  onConfirmLogout,
  onRefresh,
}: ModelConnectionsSettingsPageProps) {
  const providers = state?.providers ?? EMPTY_PROVIDERS;
  const busy = state?.busy ?? true;
  const selectedModel = state?.selectedModel;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  const currentModel = providers
    .flatMap((provider) => provider.models)
    .find((model) => (
      model.provider === selectedModel?.provider
      && model.id === selectedModel.id
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

  return <section
    className="settings-section model-settings settings-page"
    aria-label="模型连接详情"
  >
    {!state ? <div className="setting-empty">
      <strong>当前没有可管理的会话</strong>
      <p>恢复工作区后可管理凭据和模型目录；外观设置仍可使用。</p>
    </div> : <>
      <div className="current-model">
        <div>
          <span className="setting-label">当前模型</span>
          <strong>{currentModel?.name ?? selectedModel?.id ?? "尚未选择"}</strong>
          <small>
            {selectedModel
              ? selectedModel.id
              : "连接一个提供商，然后选择模型"}
          </small>
        </div>
        <span className={selectedModel ? "status-badge success" : "status-badge"}>
          {selectedModel ? "可用" : "待设置"}
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
          onChange={(event) => onChooseProvider(event.target.value)}
        >
          <option value="">选择提供商…</option>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>
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
              disabled={!online || busy}
              onClick={() => onOAuth(selectedProvider.id)}
            >
              {selectedProvider.configured ? "重新登录" : "登录订阅账户"}
            </button>}
            {!selectedProvider.oauth && <button
              type="button"
              disabled={!online || busy}
              onClick={() => onOpenKey(selectedProvider.id)}
            >
              {selectedProvider.configured ? "更新 API Key" : "使用 API Key"}
            </button>}
            {selectedProvider.configured
              && confirmLogoutProviderId !== selectedProvider.id
              && <button
                type="button"
                className="ghost danger"
                disabled={!online || busy}
                onClick={() => onRequestLogout(selectedProvider.id)}
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
              <button type="button" className="ghost" onClick={onCancelLogout}>
                保留
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={!online || busy}
                onClick={() => onConfirmLogout(selectedProvider.id)}
              >
                确认移除
              </button>
            </div>
          </div>}
          {savedKeyProviderId === selectedProvider.id && <p
            className="inline-status success"
            role="status"
          >
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
          onChange={(event) => onSearch(event.target.value)}
          placeholder={`搜索 ${selectedProvider.name} 模型`}
        />}
        <div className="provider-actions model-refresh-actions">
          <button
            type="button"
            className="ghost"
            disabled={!online || busy || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? "正在刷新模型…" : "刷新模型"}
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
            const selected = selectedModel?.provider === model.provider
              && selectedModel.id === model.id;
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
    </>}
  </section>;
}