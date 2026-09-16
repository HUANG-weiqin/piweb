import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_AUTH_KINDS,
  MAX_CUSTOM_PROVIDER_ID_CHARACTERS,
  MAX_CUSTOM_PROVIDER_MODELS,
  MAX_CUSTOM_PROVIDERS,
  isEditableCustomProviderId,
  type AcknowledgedSettingOperation,
  type ColorScheme,
  type CustomProviderApi,
  type CustomProviderAuthInput,
  type CustomProviderAuthKind,
  type CustomProviderModelInput,
  type CustomProviderProbedModel,
  type CustomProviderSaveInput,
  type CustomProviderSnapshot,
  type PublicState,
} from "../../shared/protocol";
import { useModalFocus } from "../lib/use-modal-focus";

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

/** App 投影的本机 models.json 快照；error 非空表示读取或解析失败。 */
export interface CustomProvidersView {
  revision: string;
  providers: CustomProviderSnapshot[];
  error: string;
  truncated: boolean;
}

/** 保存或删除命令的终态；页面据此保留或关闭表单。 */
export interface CustomProviderMutationResult {
  ok: boolean;
  message: string;
}

/** 端点探测终态；error 非空时 models 必然为空。 */
export interface CustomProviderProbeResult {
  commandId: string;
  baseUrl: string;
  models: CustomProviderProbedModel[];
  truncated: boolean;
  error: string;
}

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
  refreshing: boolean,
): string {
  let summary: string;
  if (!preferencesOnline) {
    summary = state ? `离线 · ${modelStateSummary(state)}` : "离线 · 无可管理会话";
  } else if (!state) {
    summary = "当前会话未就绪";
  } else if (!online) {
    summary = `当前会话暂不可管理 · ${modelStateSummary(state)}`;
  } else if (state.busy) {
    summary = `会话运行中 · ${modelStateSummary(state)}`;
  } else {
    summary = modelStateSummary(state);
  }
  return refreshing ? `正在刷新模型 · ${summary}` : summary;
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

const CUSTOM_PROVIDER_AUTH_LABELS: Record<CustomProviderAuthKind, string> = {
  local: "本地服务无需鉴权（写入占位值）",
  env: "环境变量",
  credential: "不写入，改用模型连接里保存的 Key",
  keep: "保持不变",
};

interface CustomProviderModelDraft {
  key: string;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  imageInput: boolean;
}

interface CustomProviderEditor {
  creating: boolean;
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  authKind: CustomProviderAuthKind;
  envName: string;
  models: CustomProviderModelDraft[];
}

let customProviderModelKeySeed = 0;
function nextCustomProviderModelKey(): string {
  customProviderModelKeySeed += 1;
  return `custom-provider-model-${customProviderModelKeySeed}`;
}

function emptyCustomProviderModelDraft(): CustomProviderModelDraft {
  return {
    key: nextCustomProviderModelKey(),
    id: "",
    name: "",
    contextWindow: "",
    maxTokens: "",
    reasoning: false,
    imageInput: false,
  };
}

function isBlankCustomProviderModelDraft(row: CustomProviderModelDraft): boolean {
  return !row.id.trim()
    && !row.name.trim()
    && !row.contextWindow.trim()
    && !row.maxTokens.trim()
    && !row.reasoning
    && !row.imageInput;
}

function customProviderApiValue(api: string | undefined): CustomProviderApi {
  return CUSTOM_PROVIDER_APIS.find((candidate) => candidate === api)
    ?? "openai-completions";
}

function newCustomProviderEditor(): CustomProviderEditor {
  return {
    creating: true,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    authKind: "local",
    envName: "",
    models: [emptyCustomProviderModelDraft()],
  };
}

function editCustomProviderEditor(
  provider: CustomProviderSnapshot,
): CustomProviderEditor {
  return {
    creating: false,
    id: provider.id,
    name: provider.name ?? "",
    baseUrl: provider.baseUrl ?? "",
    api: customProviderApiValue(provider.api),
    authKind: "keep",
    envName: provider.authEnvNames[0] ?? "",
    models: provider.models.length > 0
      ? provider.models.map((model) => ({
          key: nextCustomProviderModelKey(),
          id: model.id,
          name: model.name ?? "",
          contextWindow: model.contextWindow === undefined
            ? ""
            : String(model.contextWindow),
          maxTokens: model.maxTokens === undefined ? "" : String(model.maxTokens),
          reasoning: model.reasoning === true,
          imageInput: model.input?.includes("image") === true,
        }))
      : [emptyCustomProviderModelDraft()],
  };
}

/** 返回 undefined 表示留空，null 表示非法，数字表示合法值。 */
function customProviderInteger(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000_000
    ? parsed
    : null;
}

function isCustomProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0;
  } catch {
    return false;
  }
}

const CUSTOM_PROVIDER_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function customProviderAuthInput(
  editor: CustomProviderEditor,
): CustomProviderAuthInput | null {
  if (editor.authKind === "env") {
    const envName = editor.envName.trim();
    return CUSTOM_PROVIDER_ENV_NAME.test(envName) && envName.length <= 128
      ? { kind: "env", envName }
      : null;
  }
  return { kind: editor.authKind };
}

function customProviderExtraFields(provider: CustomProviderSnapshot): string[] {
  return [
    ...provider.extraFields,
    ...provider.models.flatMap((model) => (
      model.extraFields.map((field) => `${model.id}.${field}`)
    )),
  ];
}

function storedAuthLabel(provider: CustomProviderSnapshot): string {
  if (provider.storedAuth === "literal") return "文件内已写入字面量密钥";
  if (provider.storedAuth === "env") {
    return provider.authEnvNames.length > 0
      ? `环境变量 ${provider.authEnvNames.map((name) => `$${name}`).join("、")}`
      : "环境变量";
  }
  if (provider.storedAuth === "command") return "命令式密钥";
  return "未写入密钥";
}

function mergeProbedModels(
  rows: CustomProviderModelDraft[],
  probed: CustomProviderProbedModel[],
): { models: CustomProviderModelDraft[]; skipped: number } {
  const models = rows
    .filter((row) => !isBlankCustomProviderModelDraft(row))
    .map((row) => ({ ...row }));
  const byId = new Map(
    models.filter((row) => row.id.trim()).map((row) => [row.id.trim(), row]),
  );
  let skipped = 0;
  for (const model of probed) {
    const existing = byId.get(model.id);
    if (existing) {
      if (!existing.name.trim() && model.name) existing.name = model.name;
      if (!existing.contextWindow.trim() && model.contextWindow !== undefined) {
        existing.contextWindow = String(model.contextWindow);
      }
      if (!existing.maxTokens.trim() && model.maxTokens !== undefined) {
        existing.maxTokens = String(model.maxTokens);
      }
      if (!existing.reasoning && model.reasoning === true) {
        existing.reasoning = true;
      }
      if (!existing.imageInput && model.input?.includes("image")) {
        existing.imageInput = true;
      }
      continue;
    }
    if (models.length >= MAX_CUSTOM_PROVIDER_MODELS) {
      skipped += 1;
      continue;
    }
    const row: CustomProviderModelDraft = {
      key: nextCustomProviderModelKey(),
      id: model.id,
      name: model.name ?? "",
      contextWindow: model.contextWindow === undefined
        ? ""
        : String(model.contextWindow),
      maxTokens: model.maxTokens === undefined ? "" : String(model.maxTokens),
      reasoning: model.reasoning === true,
      imageInput: model.input?.includes("image") === true,
    };
    models.push(row);
    byId.set(model.id, row);
  }
  return { models, skipped };
}

interface CustomProvidersSettingsPageProps {
  view: CustomProvidersView | undefined;
  online: boolean;
  refreshing: boolean;
  refreshError: string;
  mutationPending: boolean;
  mutationResult: CustomProviderMutationResult | undefined;
  probePending: boolean;
  probeResult: CustomProviderProbeResult | undefined;
  onRefresh(): void;
  onSave(provider: CustomProviderSaveInput): string | undefined;
  onDelete(providerId: string): string | undefined;
  onProbe(baseUrl: string): string | undefined;
}

function CustomProvidersSettingsPage({
  view,
  online,
  refreshing,
  refreshError,
  mutationPending,
  mutationResult,
  probePending,
  probeResult,
  onRefresh,
  onSave,
  onDelete,
  onProbe,
}: CustomProvidersSettingsPageProps) {
  const [editor, setEditor] = useState<CustomProviderEditor>();
  const [editorError, setEditorError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const [probeError, setProbeError] = useState("");
  const [probeNotice, setProbeNotice] = useState("");
  const probeRequestRef = useRef<{ commandId: string } | undefined>(undefined);
  const providers = view?.providers ?? [];
  const busy = !online || refreshing || mutationPending || probePending;

  useEffect(() => {
    const request = probeRequestRef.current;
    if (!request) return;
    if (probeResult?.commandId === request.commandId) {
      probeRequestRef.current = undefined;
      if (probeResult.error) {
        setProbeError(`拉取模型列表失败：${probeResult.error}`);
        return;
      }
      if (!editor) return;
      const { models, skipped } = mergeProbedModels(
        editor.models,
        probeResult.models,
      );
      setEditor({ ...editor, models });
      const notices: string[] = [];
      if (probeResult.models.length === 0) notices.push("端点没有返回模型。");
      if (probeResult.truncated) {
        notices.push("端点返回的模型多于上限，只列出了前一部分。");
      }
      if (skipped > 0) {
        notices.push(
          `表单最多支持 ${MAX_CUSTOM_PROVIDER_MODELS} 个模型，已忽略 ${skipped} 个。`,
        );
      }
      setProbeNotice(notices.join(" "));
      return;
    }
    if (!probePending) probeRequestRef.current = undefined;
  }, [editor, probePending, probeResult]);

  useEffect(() => {
    if (!mutationResult?.ok) return;
    setEditor(undefined);
    setConfirmDeleteId("");
    setEditorError("");
    setProbeError("");
    setProbeNotice("");
    probeRequestRef.current = undefined;
  }, [mutationResult]);

  const resetEditorTransients = () => {
    setEditorError("");
    setProbeError("");
    setProbeNotice("");
    probeRequestRef.current = undefined;
  };
  const updateEditor = (patch: Partial<CustomProviderEditor>) => {
    setEditor((current) => current ? { ...current, ...patch } : current);
  };
  const updateModel = (
    key: string,
    patch: Partial<CustomProviderModelDraft>,
  ) => {
    setEditor((current) => current
      ? {
          ...current,
          models: current.models.map((row) => (
            row.key === key ? { ...row, ...patch } : row
          )),
        }
      : current);
  };
  const addModel = () => {
    setEditor((current) => current
      && current.models.length < MAX_CUSTOM_PROVIDER_MODELS
      ? { ...current, models: [...current.models, emptyCustomProviderModelDraft()] }
      : current);
  };
  const removeModel = (key: string) => {
    setEditor((current) => current
      ? { ...current, models: current.models.filter((row) => row.key !== key) }
      : current);
  };
  const openNewEditor = () => {
    if (busy) return;
    setEditor(newCustomProviderEditor());
    setConfirmDeleteId("");
    resetEditorTransients();
  };
  const openEditor = (provider: CustomProviderSnapshot) => {
    if (busy || !provider.editable || provider.builtinOverride) return;
    setEditor(editCustomProviderEditor(provider));
    setConfirmDeleteId("");
    resetEditorTransients();
  };
  const closeEditor = () => {
    setEditor(undefined);
    resetEditorTransients();
  };
  const probeModels = () => {
    if (!editor || busy) return;
    const baseUrl = editor.baseUrl.trim();
    if (!isCustomProviderBaseUrl(baseUrl)) {
      setEditorError("拉取模型列表前请先填写完整的 http:// 或 https:// Base URL。");
      return;
    }
    const commandId = onProbe(baseUrl);
    if (!commandId) return;
    setEditorError("");
    setProbeError("");
    setProbeNotice("");
    probeRequestRef.current = { commandId };
  };
  const submitEditor = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || busy) return;
    const id = editor.creating ? editor.id.trim() : editor.id;
    if (!isEditableCustomProviderId(id)) {
      setEditorError(
        "提供商 id 只能包含字母、数字、点、下划线和连字符，且需要以字母或数字开头。",
      );
      return;
    }
    const baseUrl = editor.baseUrl.trim();
    if (!isCustomProviderBaseUrl(baseUrl)) {
      setEditorError("Base URL 必须是完整的 http:// 或 https:// 地址。");
      return;
    }
    const auth = customProviderAuthInput(editor);
    if (!auth) {
      setEditorError("环境变量名只能包含字母、数字和下划线，且不能以数字开头。");
      return;
    }
    const models: CustomProviderModelInput[] = [];
    for (const row of editor.models) {
      if (isBlankCustomProviderModelDraft(row)) continue;
      const modelId = row.id.trim();
      if (!modelId) {
        setEditorError("每个模型都需要填写模型 id。");
        return;
      }
      const contextWindow = customProviderInteger(row.contextWindow);
      if (contextWindow === null) {
        setEditorError(`模型 ${modelId} 的上下文窗口必须是正整数。`);
        return;
      }
      const maxTokens = customProviderInteger(row.maxTokens);
      if (maxTokens === null) {
        setEditorError(`模型 ${modelId} 的最大输出必须是正整数。`);
        return;
      }
      models.push({
        id: modelId,
        ...(row.name.trim() ? { name: row.name.trim() } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        reasoning: row.reasoning,
        input: row.imageInput ? ["text", "image"] : ["text"],
      });
    }
    if (models.length === 0) {
      setEditorError("至少需要填写一个模型。");
      return;
    }
    setEditorError("");
    onSave({
      id,
      ...(editor.name.trim() ? { name: editor.name.trim() } : {}),
      baseUrl,
      api: editor.api,
      auth,
      models,
    });
  };
  const confirmDelete = (providerId: string) => {
    setConfirmDeleteId("");
    if (busy) return;
    onDelete(providerId);
  };
  const authKinds = editor?.creating
    ? CUSTOM_PROVIDER_AUTH_KINDS.filter((kind) => kind !== "keep")
    : CUSTOM_PROVIDER_AUTH_KINDS;

  return <section
    className="settings-section custom-providers-settings settings-page"
    aria-labelledby="custom-providers-settings-heading"
  >
    <div className="settings-section-heading">
      <p className="eyebrow">CUSTOM PROVIDERS</p>
      <h3 id="custom-providers-settings-heading">自定义提供商</h3>
      <p className="setting-note">
        这里的定义写入本机 Pi 配置 <code>models.json</code>，与
        <code>pi</code> CLI 共享；保存后可在「模型连接」里管理凭据，
        并在角色管理中为新会话选用其模型。
      </p>
    </div>
    {!online && <p className="inline-status" role="status">
      本机服务离线：只能查看已读取的配置；保存、删除与拉取模型已禁用，重连后可继续。
    </p>}
    {refreshing && <p className="inline-status" role="status">
      正在读取模型配置…
    </p>}
    {(refreshError || view?.error) && <div className="custom-provider-error">
      <p className="inline-status error" role="alert">
        {refreshError || `读取本机 models.json 失败：${view?.error ?? ""}`}
      </p>
      <button
        type="button"
        className="ghost"
        disabled={!online || refreshing}
        onClick={onRefresh}
      >重试读取</button>
    </div>}
    {view?.truncated && <p className="inline-status" role="status">
      本机 models.json 中的条目多于可展示上限，这里只列出前一部分；其余请直接查看文件。
    </p>}
    {mutationResult && <p
      className={`inline-status ${mutationResult.ok ? "success" : "error"}`}
      role={mutationResult.ok ? "status" : "alert"}
    >{mutationResult.message}</p>}
    <div className="custom-provider-toolbar">
      <button
        type="button"
        className="ghost"
        disabled={!online || refreshing || mutationPending || probePending}
        onClick={onRefresh}
      >读取最新配置</button>
      <button
        type="button"
        disabled={busy || !view || providers.length >= MAX_CUSTOM_PROVIDERS}
        onClick={openNewEditor}
      >新建提供商</button>
    </div>
    <div className="custom-provider-list">
      {!view && !refreshing && <div className="setting-empty">
        <strong>尚未读取本机模型配置</strong>
        <p>点击“读取最新配置”获取 models.json 的当前状态。</p>
      </div>}
      {view && providers.length === 0 && !view.error && <div className="setting-empty">
        <strong>还没有自定义提供商</strong>
        <p>新建条目后写入本机 models.json，与 pi CLI 共享。</p>
      </div>}
      {providers.map((provider) => {
        const extraFields = customProviderExtraFields(provider);
        const editable = provider.editable && !provider.builtinOverride;
        const deletable = isEditableCustomProviderId(provider.id);
        return <article className="custom-provider-entry" key={provider.id}>
          <div className="provider-identity">
            <div>
              <strong>{provider.name ?? provider.id}</strong>
              {provider.name !== undefined && <small>id：{provider.id}</small>}
            </div>
            {!editable && <span className="status-badge">只读</span>}
            {provider.builtinOverride && <span className="status-badge">内置覆盖</span>}
          </div>
          <div className="custom-provider-meta">
            <span>Base URL：{provider.baseUrl ?? "未设置"}</span>
            <span>模型：{provider.models.length} 个</span>
            <span>密钥：{storedAuthLabel(provider)}</span>
          </div>
          {provider.builtinOverride && <p className="setting-note">
            该 id 同时是内置提供商；表单不能覆盖它，请直接编辑文件。
          </p>}
          {!provider.builtinOverride && !provider.editable && <p className="setting-note">
            该条目含表单不支持的字段，请直接编辑文件。
          </p>}
          {extraFields.length > 0 && <p className="setting-note">
            表单未管理的字段：{extraFields.join("、")}
          </p>}
          <div className="provider-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy || !editable}
              onClick={() => openEditor(provider)}
            >编辑</button>
            <button
              type="button"
              className="ghost danger"
              disabled={busy || !deletable}
              onClick={() => setConfirmDeleteId(provider.id)}
            >删除</button>
          </div>
          {confirmDeleteId === provider.id && <div
            className="credential-confirm"
            role="alert"
          >
            <p>
              删除会从本机 models.json 移除「{provider.id}」，并影响所有项目；
              此操作无法撤销。
            </p>
            <div className="provider-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => setConfirmDeleteId("")}
              >保留</button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => confirmDelete(provider.id)}
              >确认删除</button>
            </div>
          </div>}
        </article>;
      })}
    </div>
    {editor && <form
      className="custom-provider-editor"
      aria-label={editor.creating ? "新建自定义提供商" : `编辑自定义提供商 ${editor.id}`}
      onSubmit={submitEditor}
    >
      <h4>{editor.creating ? "新建自定义提供商" : `编辑 ${editor.id}`}</h4>
      <fieldset className="custom-provider-fields" disabled={busy}>
        <label className="setting-field">
          提供商 id
          <input
            value={editor.id}
            disabled={!editor.creating}
            maxLength={MAX_CUSTOM_PROVIDER_ID_CHARACTERS}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => updateEditor({ id: event.target.value })}
          />
        </label>
        <label className="setting-field">
          显示名
          <input
            value={editor.name}
            maxLength={256}
            onChange={(event) => updateEditor({ name: event.target.value })}
          />
        </label>
        <label className="setting-field">
          Base URL
          <input
            value={editor.baseUrl}
            maxLength={4096}
            spellCheck={false}
            autoComplete="off"
            placeholder="http://127.0.0.1:8065/v1"
            onChange={(event) => updateEditor({ baseUrl: event.target.value })}
          />
        </label>
        <label className="setting-field">
          API 类型
          <select
            value={editor.api}
            onChange={(event) => updateEditor({
              api: event.target.value as CustomProviderApi,
            })}
          >
            {CUSTOM_PROVIDER_APIS.map((api) => (
              <option key={api} value={api}>{api}</option>
            ))}
          </select>
        </label>
        <fieldset className="custom-provider-auth">
          <legend>鉴权</legend>
          {authKinds.map((kind) => <label
            key={kind}
            className="custom-provider-auth-option"
          >
            <input
              type="radio"
              name="custom-provider-auth"
              value={kind}
              checked={editor.authKind === kind}
              onChange={() => updateEditor({ authKind: kind })}
            />
            <span>{CUSTOM_PROVIDER_AUTH_LABELS[kind]}</span>
          </label>)}
          {editor.authKind === "env" && <label className="setting-field">
            环境变量名
            <input
              value={editor.envName}
              maxLength={128}
              spellCheck={false}
              autoComplete="off"
              placeholder="OPENAI_API_KEY"
              onChange={(event) => updateEditor({ envName: event.target.value })}
            />
          </label>}
        </fieldset>
        <fieldset className="custom-provider-models">
          <legend>模型</legend>
          {editor.models.map((row) => <div
            className="custom-provider-model"
            key={row.key}
          >
            <div className="custom-provider-model-fields">
              <label className="setting-field">
                模型 id
                <input
                  value={row.id}
                  maxLength={256}
                  spellCheck={false}
                  onChange={(event) => updateModel(row.key, { id: event.target.value })}
                />
              </label>
              <label className="setting-field">
                模型名称
                <input
                  value={row.name}
                  maxLength={256}
                  onChange={(event) => updateModel(row.key, { name: event.target.value })}
                />
              </label>
              <label className="setting-field">
                上下文窗口
                <input
                  value={row.contextWindow}
                  inputMode="numeric"
                  onChange={(event) => updateModel(row.key, {
                    contextWindow: event.target.value,
                  })}
                />
              </label>
              <label className="setting-field">
                最大输出
                <input
                  value={row.maxTokens}
                  inputMode="numeric"
                  onChange={(event) => updateModel(row.key, {
                    maxTokens: event.target.value,
                  })}
                />
              </label>
            </div>
            <div className="custom-provider-model-actions">
              <label className="custom-provider-check">
                <input
                  type="checkbox"
                  checked={row.reasoning}
                  onChange={(event) => updateModel(row.key, {
                    reasoning: event.target.checked,
                  })}
                />
                支持推理
              </label>
              <label className="custom-provider-check">
                <input
                  type="checkbox"
                  checked={row.imageInput}
                  onChange={(event) => updateModel(row.key, {
                    imageInput: event.target.checked,
                  })}
                />
                图片输入
              </label>
              <button
                type="button"
                className="ghost danger"
                onClick={() => removeModel(row.key)}
              >移除模型</button>
            </div>
          </div>)}
          <div className="provider-actions">
            <button
              type="button"
              className="ghost"
              disabled={editor.models.length >= MAX_CUSTOM_PROVIDER_MODELS}
              onClick={addModel}
            >添加模型</button>
            <button
              type="button"
              className="ghost"
              onClick={probeModels}
            >{probePending ? "正在拉取模型列表…" : "从端点拉取模型列表"}</button>
          </div>
          {probeError && <p className="inline-status error" role="alert">
            {probeError}
          </p>}
          {probeNotice && <p className="inline-status" role="status">
            {probeNotice}
          </p>}
        </fieldset>
        {editorError && <p className="inline-status error" role="alert">
          {editorError}
        </p>}
        <div className="provider-actions custom-provider-editor-actions">
          <button type="submit">
            {mutationPending ? "正在保存…" : "保存"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={closeEditor}
          >取消</button>
        </div>
      </fieldset>
    </form>}
  </section>;
}

interface SettingsHomeProps {
  appearance: string;
  modelConnections: string;
  customProviders: string;
  rowRefs: Record<SettingsPageRoute, RefObject<HTMLButtonElement | null>>;
  onOpen(route: SettingsPageRoute): void;
}

function customProvidersSummary(
  view: CustomProvidersView | undefined,
  online: boolean,
  refreshing: boolean,
  refreshError: string,
  mutationPending: boolean,
  mutationResult: CustomProviderMutationResult | undefined,
): string {
  const count = view
    ? `${view.providers.length} 个自定义提供商`
    : "尚未读取本机配置";
  const status = mutationPending
    ? "正在保存"
    : mutationResult && !mutationResult.ok
      ? "最近一次操作失败"
      : refreshError || view?.error
        ? "读取失败"
        : refreshing
          ? "正在读取"
          : "已保存";
  return online ? `${count} · ${status}` : `离线 · ${count}`;
}

function SettingsHome({
  appearance,
  modelConnections,
  customProviders,
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
  }, {
    route: "custom-providers" as const,
    title: "自定义提供商",
    description: "编辑与 pi CLI 共享的 models.json",
    summary: customProviders,
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
