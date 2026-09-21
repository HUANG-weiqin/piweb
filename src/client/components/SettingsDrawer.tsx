import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type {
  AcknowledgedSettingOperation,
  ColorScheme,
  CustomProviderSaveInput,
  PublicState,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";
import { AppearanceSettingsPage } from "./settings/AppearanceSettingsPage";
import {
  CustomProvidersSettingsPage,
  type CustomProviderMutationResult,
  type CustomProviderProbeResult,
  type CustomProvidersView,
} from "./settings/CustomProvidersSettingsPage";
import { ModelConnectionsSettingsPage } from "./settings/ModelConnectionsSettingsPage";
import {
  SettingsHome,
  appearanceSummary,
  customProvidersSummary,
  modelConnectionsSummary,
} from "./settings/SettingsHome";

export type {
  CustomProviderMutationResult,
  CustomProviderProbeResult,
  CustomProvidersView,
} from "./settings/CustomProvidersSettingsPage";

type SettingsRoute = "home" | "appearance" | "model-connections" | "custom-providers";
type SettingsPageRoute = Exclude<SettingsRoute, "home">;

export interface SettingOperationResult {
  operation: AcknowledgedSettingOperation;
  sessionId: string;
  commandId: string;
  ok: boolean;
  message: string;
}

export type SettingOperationResults = Readonly<Partial<Record<
  AcknowledgedSettingOperation,
  SettingOperationResult
>>>;

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
  settingResults: SettingOperationResults;
  customProviders: CustomProvidersView | undefined;
  customProvidersRefreshing: boolean;
  customProvidersRefreshError: string;
  customProviderMutationPending: boolean;
  customProviderMutationResult: CustomProviderMutationResult | undefined;
  customProviderProbePending: boolean;
  customProviderProbeResult: CustomProviderProbeResult | undefined;
  onClose(): void;
  onColorSchemeChange(colorScheme: ColorScheme): void;
  onRetryColorScheme(): void;
  onRefreshCustomProviders(): void;
  onSaveCustomProvider(provider: CustomProviderSaveInput): string | undefined;
  onDeleteCustomProvider(providerId: string): string | undefined;
  onProbeCustomProviderModels(baseUrl: string): string | undefined;
  onKey(provider: string, key: string): string | undefined;
  onOAuth(provider: string): void;
  onLogout(provider: string): void;
  onRefresh(): string | undefined;
  onConsumeSettingResult(result: SettingOperationResult): void;
  onKeyDialogChange(open: boolean): void;
}

const EMPTY_PROVIDERS: PublicState["providers"] = [];

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
  settingResults,
  customProviders,
  customProvidersRefreshing,
  customProvidersRefreshError,
  customProviderMutationPending,
  customProviderMutationResult,
  customProviderProbePending,
  customProviderProbeResult,
  onClose,
  onColorSchemeChange,
  onRetryColorScheme,
  onRefreshCustomProviders,
  onSaveCustomProvider,
  onDeleteCustomProvider,
  onProbeCustomProviderModels,
  onKey,
  onOAuth,
  onLogout,
  onRefresh,
  onConsumeSettingResult,
  onKeyDialogChange,
}: SettingsDrawerProps) {
  const [route, setRoute] = useState<SettingsRoute>("home");
  const [providerId, setProviderId] = useState(() => initialProviderId(state));
  const [keyProvider, setKeyProvider] = useState<{
    id: string;
    name: string;
    sessionId: string;
  }>();
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
  const customProvidersRowRef = useRef<HTMLButtonElement>(null);
  const returnToRowRef = useRef<SettingsPageRoute | undefined>(undefined);
  const rowRefs: Record<SettingsPageRoute, RefObject<HTMLButtonElement | null>> = {
    appearance: appearanceRowRef,
    "model-connections": modelConnectionsRowRef,
    "custom-providers": customProvidersRowRef,
  };
  const providers = state?.providers ?? EMPTY_PROVIDERS;
  const sessionId = state?.sessionId ?? "";
  const keyProviderAvailable = keyProvider !== undefined
    && providers.some((provider) => provider.id === keyProvider.id);
  const keyCandidate = settingResults.set_api_key;
  const keyResult = savingKey
    && keyCandidate?.sessionId === savingKey.sessionId
    && keyCandidate.commandId === savingKey.commandId
    ? keyCandidate
    : undefined;
  const refreshCandidate = settingResults.refresh_models;
  const refreshResult = refreshingModels
    && refreshCandidate?.sessionId === refreshingModels.sessionId
    && refreshCandidate.commandId === refreshingModels.commandId
    ? refreshCandidate
    : undefined;
  const clearKeyDialogState = useCallback(() => {
    setKeyProvider(undefined);
    setKey("");
    setSavingKey(undefined);
    setShowKey(false);
    setKeyError("");
    onKeyDialogChange(false);
  }, [onKeyDialogChange]);

  useEffect(() => {
    if (providerId && providers.some((provider) => provider.id === providerId)) return;
    setProviderId(initialProviderId(state));
  }, [providerId, providers, state]);

  useEffect(() => {
    if (!keyProvider) return;
    if (open && online && keyProvider.sessionId === sessionId) return;
    clearKeyDialogState();
  }, [clearKeyDialogState, keyProvider, online, open, sessionId]);

  useEffect(() => {
    if (!keyProvider || keyProviderAvailable || savingKey) return;
    clearKeyDialogState();
  }, [clearKeyDialogState, keyProvider, keyProviderAvailable, savingKey]);

  useEffect(() => {
    if (!savingKey || savingKey.sessionId !== sessionId || !keyResult) return;
    if (!keyResult.ok) {
      setSavingKey(undefined);
      setKeyError(keyResult.message || "API Key 保存失败");
      onConsumeSettingResult(keyResult);
      return;
    }
    setSavedKeyProviderId(savingKey.providerId);
    setSavingKey(undefined);
    setKey("");
    setKeyProvider(undefined);
    setShowKey(false);
    onKeyDialogChange(false);
    onConsumeSettingResult(keyResult);
  }, [keyResult, onConsumeSettingResult, onKeyDialogChange, savingKey, sessionId]);

  useEffect(() => {
    if (!refreshingModels || refreshingModels.sessionId !== sessionId || !refreshResult) return;
    setRefreshingModels(undefined);
    setRefreshStatus({
      ok: refreshResult.ok,
      message: refreshResult.ok
        ? "远程供应商模型目录已刷新。"
        : refreshResult.message || "远程供应商模型目录刷新失败。",
    });
    onConsumeSettingResult(refreshResult);
  }, [onConsumeSettingResult, refreshResult, refreshingModels, sessionId]);

  useEffect(() => {
    if (!refreshingModels || refreshingModels.sessionId === sessionId) return;
    setRefreshingModels(undefined);
    setRefreshStatus({ ok: false, message: "观察会话已更换，刷新状态未确认；请重试。" });
  }, [refreshingModels, sessionId]);

  useEffect(() => {
    if (online || !refreshingModels) return;
    setRefreshingModels(undefined);
    setRefreshStatus({ ok: false, message: "连接已断开，刷新状态未确认；请重连后重试。" });
  }, [online, refreshingModels]);

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
    clearKeyDialogState();
  };
  const keyFocusRef = useModalFocus<HTMLFormElement>(
    Boolean(open && keyProvider),
    keyProvider?.id ?? "",
    closeKeyDialog,
  );

  if (!open) return null;

  const submitKey = (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!online || !keyProvider || !keyProviderAvailable || !value || savingKey) return;
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
  };
  const openKeyDialog = (nextProviderId: string) => {
    const provider = providers.find(({ id }) => id === nextProviderId);
    if (!provider) return;
    setProviderId(nextProviderId);
    setKeyProvider({ id: provider.id, name: provider.name, sessionId });
    setKey("");
    setShowKey(false);
    setKeyError("");
    setSavingKey(undefined);
    onKeyDialogChange(true);
  };
  const openPage = (nextRoute: SettingsPageRoute) => {
    returnToRowRef.current = undefined;
    setRoute(nextRoute);
    if (nextRoute === "custom-providers") onRefreshCustomProviders();
  };
  const pageTitle = route === "appearance"
    ? "外观"
    : route === "model-connections"
      ? "模型连接"
      : "自定义提供商";
  const pageDescription = route === "appearance"
    ? "选择整个 Pi Web 使用的配色"
    : route === "model-connections"
      ? "管理本机凭据并检查模型目录"
      : "管理写入本机 models.json 的提供商定义";

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
        modelConnections={modelConnectionsSummary(
          state,
          online,
          preferencesOnline,
          Boolean(refreshingModels),
        )}
        customProviders={customProvidersSummary(
          customProviders,
          preferencesOnline,
          customProvidersRefreshing,
          customProvidersRefreshError,
          customProviderMutationPending,
          customProviderMutationResult,
        )}
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
      {route === "custom-providers" && <CustomProvidersSettingsPage
        view={customProviders}
        online={preferencesOnline}
        refreshing={customProvidersRefreshing}
        refreshError={customProvidersRefreshError}
        mutationPending={customProviderMutationPending}
        mutationResult={customProviderMutationResult}
        probePending={customProviderProbePending}
        probeResult={customProviderProbeResult}
        onRefresh={onRefreshCustomProviders}
        onSave={onSaveCustomProvider}
        onDelete={onDeleteCustomProvider}
        onProbe={onProbeCustomProviderModels}
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
      <button disabled={!online || !keyProviderAvailable || !key.trim() || Boolean(savingKey)}>
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
