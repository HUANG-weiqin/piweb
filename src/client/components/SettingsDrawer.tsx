import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type {
  AcknowledgedSettingOperation,
  ColorScheme,
  PublicState,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

type SettingsRoute = "home" | "appearance" | "model-connections";
type SettingsPageRoute = Exclude<SettingsRoute, "home">;

interface SettingsDrawerProps {
  state?: PublicState;
  open: boolean;
  /** The drawer remains live beneath a higher-priority modal. */
  covered?: boolean;
  /** Resolves the visible launcher even if a responsive layout replaced its DOM node. */
  resolveReturnFocus?: () => HTMLElement | null;
  /** Whether conversation-scoped connection controls can mutate runtime state. */
  online: boolean;
  /** Whether process-global preferences can be persisted. */
  preferencesOnline: boolean;
  colorScheme: ColorScheme;
  colorSchemePending: boolean;
  colorSchemeUnsaved: boolean;
  colorSchemeError: string;
  settingResult?: {
    operation: AcknowledgedSettingOperation;
    commandId: string;
    ok: boolean;
    message: string;
  };
  onClose(): void;
  onColorSchemeChange(colorScheme: ColorScheme): void;
  onRetryColorScheme(): void;
  onKey(provider: string, key: string): string | undefined;
  onOAuth(provider: string): void;
  onLogout(provider: string): void;
  onRefresh(): string | undefined;
  onClearSettingResult(): void;
  onKeyDialogChange(open: boolean): void;
}

const EMPTY_PROVIDERS: PublicState["providers"] = [];
const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  "quiet-rebel": "Quiet Rebel",
  "classic-rebel": "Classic Rebel",
};

function initialProviderId(state?: PublicState): string {
  if (
    state?.selectedModel?.provider
    && state.providers.some((provider) => provider.id === state.selectedModel?.provider)
  ) {
    return state.selectedModel.provider;
  }
  const providers = state?.providers ?? EMPTY_PROVIDERS;
  const configured = providers.find((provider) => provider.configured);
  if (configured) return configured.id;
  return providers.length === 1 ? providers[0]?.id ?? "" : "";
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

function appearanceSummary(
  colorScheme: ColorScheme,
  pending: boolean,
  unsaved: boolean,
): string {
  const status = pending ? "正在保存" : unsaved ? "尚未保存" : "已保存";
  return `${COLOR_SCHEME_LABELS[colorScheme]} · ${status}`;
}

function modelConnectionsSummary(
  state: PublicState | undefined,
  online: boolean,
  preferencesOnline: boolean,
): string {
  if (!preferencesOnline) {
    return state ? `离线 · ${modelStateSummary(state)}` : "离线 · 无可管理会话";
  }
  if (!state) return "当前会话未就绪";
  if (!online) return `当前会话暂不可管理 · ${modelStateSummary(state)}`;
  if (state.busy) return `会话运行中 · ${modelStateSummary(state)}`;
  return modelStateSummary(state);
}

function modelStateSummary(state: PublicState): string {
  const providers = state.providers;
  const selectedModel = state.selectedModel;
  const currentModel = providers
    .flatMap((provider) => provider.models)
    .find((model) => (
      model.provider === selectedModel?.provider
      && model.id === selectedModel.id
    ));
  const model = currentModel?.name ?? selectedModel?.id;
  const configuredCount = providers.filter((provider) => provider.configured).length;
  const providerSummary = configuredCount > 0
    ? `${configuredCount} 个提供商已配置`
    : "尚无提供商凭据";
  return `${model ? `当前 ${model}` : "尚未选择模型"} · ${providerSummary}`;
}

function AppearanceSettingsPage({
  colorScheme,
  colorSchemePending,
  colorSchemeUnsaved,
  colorSchemeError,
  preferencesOnline,
  onColorSchemeChange,
  onRetryColorScheme,
}: Pick<SettingsDrawerProps,
  | "colorScheme"
  | "colorSchemePending"
  | "colorSchemeUnsaved"
  | "colorSchemeError"
  | "preferencesOnline"
  | "onColorSchemeChange"
  | "onRetryColorScheme">) {
  return <section
    className="settings-section appearance-settings settings-page"
    aria-labelledby="appearance-settings-heading"
  >
    <div className="settings-section-heading">
      <p className="eyebrow">APPEARANCE</p>
      <h3 id="appearance-settings-heading">配色</h3>
      <p className="setting-note">只改变这个用户的 Pi Web 外观，不写入项目。</p>
    </div>
    <fieldset className="color-scheme-options" disabled={colorSchemePending}>
      <legend>选择配色</legend>
      <label className="color-scheme-option">
        <input
          type="radio"
          name="color-scheme"
          value="quiet-rebel"
          checked={colorScheme === "quiet-rebel"}
          onChange={() => onColorSchemeChange("quiet-rebel")}
        />
        <span className="color-scheme-swatch quiet-rebel-swatch" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span><strong>Quiet Rebel</strong><small>低对比深色，保留克制的氧化红强调</small></span>
      </label>
      <label className="color-scheme-option">
        <input
          type="radio"
          name="color-scheme"
          value="classic-rebel"
          checked={colorScheme === "classic-rebel"}
          onChange={() => onColorSchemeChange("classic-rebel")}
        />
        <span className="color-scheme-swatch classic-rebel-swatch" aria-hidden="true">
          <i /><i /><i />
        </span>
        <span><strong>Classic Rebel</strong><small>原有的高反差暗色与纸张色</small></span>
      </label>
    </fieldset>
    {colorSchemePending && <p className="inline-status" role="status">正在保存配色…</p>}
    {colorSchemeUnsaved && !colorSchemePending && <div className="preference-unsaved">
      <p className="inline-status error" role="alert">
        {colorSchemeError || "当前配色尚未保存。"}
      </p>
      <button
        type="button"
        className="ghost"
        disabled={!preferencesOnline}
        onClick={onRetryColorScheme}
      >重试保存</button>
    </div>}
  </section>;
}

interface ModelConnectionsPageProps {
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

function ModelConnectionsSettingsPage({
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
}: ModelConnectionsPageProps) {
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

interface SettingsHomeProps {
  appearance: string;
  modelConnections: string;
  rowRefs: Record<SettingsPageRoute, RefObject<HTMLButtonElement | null>>;
  onOpen(route: SettingsPageRoute): void;
}

function SettingsHome({
  appearance,
  modelConnections,
  rowRefs,
  onOpen,
}: SettingsHomeProps) {
  const menu = [{
    route: "appearance" as const,
    title: "外观",
    description: "调整 Pi Web 的配色与视觉偏好",
    summary: appearance,
  }, {
    route: "model-connections" as const,
    title: "模型连接",
    description: "管理本机凭据并查看可用模型",
    summary: modelConnections,
  }];

  return <nav className="settings-home" aria-label="设置分类">
    {menu.map((item) => <button
      key={item.route}
      ref={rowRefs[item.route]}
      type="button"
      className="settings-menu-row"
      aria-label={`打开${item.title}设置`}
      onClick={() => onOpen(item.route)}
    >
      <span className="settings-menu-copy">
        <strong>{item.title}</strong>
        <small>{item.description}</small>
        <span className="settings-menu-summary">{item.summary}</span>
      </span>
      <span className="settings-menu-chevron" aria-hidden="true">›</span>
    </button>)}
  </nav>;
}

export function SettingsDrawer({
  state,
  open,
  covered = false,
  resolveReturnFocus,
  online,
  preferencesOnline,
  colorScheme,
  colorSchemePending,
  colorSchemeUnsaved,
  colorSchemeError,
  settingResult,
  onClose,
  onColorSchemeChange,
  onRetryColorScheme,
  onKey,
  onOAuth,
  onLogout,
  onRefresh,
  onClearSettingResult,
  onKeyDialogChange,
}: SettingsDrawerProps) {
  const [route, setRoute] = useState<SettingsRoute>("home");
  const [providerId, setProviderId] = useState(() => initialProviderId(state));
  const [keyProviderId, setKeyProviderId] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [savingKey, setSavingKey] = useState<{
    providerId: string;
    sessionId: string;
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
  const drawerElementRef = useRef<HTMLElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const appearanceRowRef = useRef<HTMLButtonElement>(null);
  const modelConnectionsRowRef = useRef<HTMLButtonElement>(null);
  const returnToRowRef = useRef<SettingsPageRoute | undefined>(undefined);
  const rowRefs: Record<SettingsPageRoute, RefObject<HTMLButtonElement | null>> = {
    appearance: appearanceRowRef,
    "model-connections": modelConnectionsRowRef,
  };
  const providers = state?.providers ?? EMPTY_PROVIDERS;
  const sessionId = state?.sessionId ?? "";
  const keyProvider = providers.find((provider) => provider.id === keyProviderId);

  useEffect(() => {
    if (providerId && providers.some((provider) => provider.id === providerId)) return;
    setProviderId(initialProviderId(state));
  }, [providerId, providers, state]);

  useEffect(() => {
    if (
      !savingKey
      || savingKey.sessionId !== sessionId
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
  }, [onClearSettingResult, onKeyDialogChange, savingKey, settingResult, sessionId]);

  useEffect(() => {
    if (
      !refreshingModels
      || refreshingModels.sessionId !== sessionId
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
  }, [onClearSettingResult, refreshingModels, settingResult, sessionId]);

  useEffect(() => {
    if (!savingKey || savingKey.sessionId === sessionId) return;
    setSavingKey(undefined);
    setKey("");
    setShowKey(false);
    setKeyError("观察会话已更换，保存状态未确认；请重试。");
    onClearSettingResult();
  }, [onClearSettingResult, savingKey, sessionId]);

  useEffect(() => {
    if (!refreshingModels || refreshingModels.sessionId === sessionId) return;
    setRefreshingModels(undefined);
    setRefreshStatus({ ok: false, message: "观察会话已更换，刷新状态未确认；请重试。" });
    onClearSettingResult();
  }, [onClearSettingResult, refreshingModels, sessionId]);

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
      setRefreshStatus({ ok: false, message: "连接已断开，刷新状态未确认；请重连后重试。" });
    }
    onClearSettingResult();
  }, [online, onClearSettingResult, refreshingModels, savingKey]);

  useEffect(() => {
    if (!savedKeyProviderId) return;
    const timer = window.setTimeout(() => setSavedKeyProviderId(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [savedKeyProviderId]);

  useEffect(() => {
    if (!savedKeyProviderId) return;
    const provider = providers.find(({ id }) => id === savedKeyProviderId);
    if (!provider?.configured) setSavedKeyProviderId("");
  }, [providers, savedKeyProviderId]);

  useEffect(() => {
    if (!confirmLogoutProviderId) return;
    const provider = providers.find(({ id }) => id === confirmLogoutProviderId);
    if (!provider?.configured) setConfirmLogoutProviderId("");
  }, [confirmLogoutProviderId, providers]);

  useEffect(() => {
    if (!keyProviderId || keyProvider) return;
    setKeyProviderId("");
    setKey("");
    setSavingKey(undefined);
    onKeyDialogChange(false);
  }, [keyProvider, keyProviderId, onKeyDialogChange]);

  useEffect(() => {
    if (open) return;
    setRoute("home");
    returnToRowRef.current = undefined;
  }, [open]);

  const goHome = () => {
    if (route === "home") return;
    returnToRowRef.current = route;
    setRoute("home");
  };
  const handleEscape = () => {
    if (route === "home") onClose();
    else goHome();
  };
  const drawerFocusRef = useModalFocus<HTMLElement>(
    open,
    "settings-drawer",
    handleEscape,
    drawerElementRef,
    resolveReturnFocus,
  );

  useEffect(() => {
    if (!open) return;
    if (drawerElementRef.current) drawerElementRef.current.scrollTop = 0;
    if (route === "home") {
      const returnRoute = returnToRowRef.current;
      returnToRowRef.current = undefined;
      if (returnRoute) rowRefs[returnRoute].current?.focus();
      return;
    }
    pageHeadingRef.current?.focus();
  }, [open, route]);

  const closeKeyDialog = () => {
    if (savingKey) return;
    setKey("");
    setKeyError("");
    setKeyProviderId("");
    setShowKey(false);
    onKeyDialogChange(false);
  };
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
      setSavingKey({ providerId: keyProvider.id, sessionId, commandId });
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
  const openPage = (nextRoute: SettingsPageRoute) => {
    returnToRowRef.current = undefined;
    setRoute(nextRoute);
  };
  const pageTitle = route === "appearance" ? "外观" : "模型连接";
  const pageDescription = route === "appearance"
    ? "选择整个 Pi Web 使用的配色"
    : "管理本机凭据并检查模型目录";

  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    onClose();
  }}>
    <aside
      ref={drawerFocusRef}
      className="drawer settings-drawer"
      role={keyProvider || covered ? undefined : "dialog"}
      aria-modal={keyProvider || covered ? undefined : true}
      aria-hidden={keyProvider || covered ? true : undefined}
      aria-label="设置"
      tabIndex={-1}
      data-settings-route={route}
    >
      <header className="drawer-header settings-drawer-header">
        {route === "home" ? <div className="settings-header-copy">
          <p className="eyebrow">SETTINGS</p>
          <h2>设置</h2>
          <p>选择一个类别进行设置</p>
        </div> : <>
          <button
            type="button"
            className="settings-back"
            aria-label="返回设置"
            onClick={goHome}
          >
            <span aria-hidden="true">‹</span>
            <span>返回</span>
          </button>
          <div className="settings-header-copy">
            <p className="eyebrow">SETTINGS</p>
            <h2 ref={pageHeadingRef} tabIndex={-1}>{pageTitle}</h2>
            <p>{pageDescription}</p>
          </div>
        </>}
        <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
      </header>

      {route === "home" && <SettingsHome
        appearance={appearanceSummary(colorScheme, colorSchemePending, colorSchemeUnsaved)}
        modelConnections={modelConnectionsSummary(state, online, preferencesOnline)}
        rowRefs={rowRefs}
        onOpen={openPage}
      />}
      {route === "appearance" && <AppearanceSettingsPage
        colorScheme={colorScheme}
        colorSchemePending={colorSchemePending}
        colorSchemeUnsaved={colorSchemeUnsaved}
        colorSchemeError={colorSchemeError}
        preferencesOnline={preferencesOnline}
        onColorSchemeChange={onColorSchemeChange}
        onRetryColorScheme={onRetryColorScheme}
      />}
      {route === "model-connections" && <ModelConnectionsSettingsPage
        state={state}
        online={online}
        providerId={providerId}
        search={search}
        savedKeyProviderId={savedKeyProviderId}
        confirmLogoutProviderId={confirmLogoutProviderId}
        refreshing={Boolean(refreshingModels)}
        refreshStatus={refreshStatus}
        onChooseProvider={chooseProvider}
        onSearch={setSearch}
        onOpenKey={openKeyDialog}
        onOAuth={onOAuth}
        onRequestLogout={setConfirmLogoutProviderId}
        onCancelLogout={() => setConfirmLogoutProviderId("")}
        onConfirmLogout={(provider) => {
          setSavedKeyProviderId("");
          setConfirmLogoutProviderId("");
          onLogout(provider);
        }}
        onRefresh={() => {
          const commandId = onRefresh();
          if (!commandId) return;
          setRefreshingModels({ sessionId, commandId });
          setRefreshStatus(undefined);
        }}
      />}
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
      role={covered ? undefined : "dialog"}
      aria-modal={covered ? undefined : "true"}
      aria-hidden={covered ? "true" : undefined}
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
