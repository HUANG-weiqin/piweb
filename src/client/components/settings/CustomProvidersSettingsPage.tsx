import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  CUSTOM_PROVIDER_APIS,
  CUSTOM_PROVIDER_AUTH_KINDS,
  MAX_CUSTOM_PROVIDER_ID_CHARACTERS,
  MAX_CUSTOM_PROVIDER_MODELS,
  MAX_CUSTOM_PROVIDERS,
  isEditableCustomProviderId,
  type CustomProviderApi,
  type CustomProviderAuthInput,
  type CustomProviderAuthKind,
  type CustomProviderModelInput,
  type CustomProviderProbedModel,
  type CustomProviderSaveInput,
  type CustomProviderSnapshot,
} from "../../../shared/protocol";

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
  /** 当前 contextWindow 来自端点探测的路径；用户手改后立即清空。 */
  contextSource: string;
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
    contextSource: "",
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
          contextSource: "",
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

function customProviderContextHint(row: CustomProviderModelDraft): string {
  if (row.contextSource) return `自动探测：${row.contextSource}`;
  return row.contextWindow.trim()
    ? "留空则用 Pi 默认 128000"
    : "未探测到上下文（留空则用 Pi 默认 128000）";
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
        existing.contextSource = model.contextSource ?? "";
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
      contextSource: model.contextWindow === undefined
        ? ""
        : model.contextSource ?? "",
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

export function CustomProvidersSettingsPage({
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
            row.key === key
              ? {
                  ...row,
                  ...patch,
                  contextSource: patch.contextWindow === undefined
                    ? row.contextSource
                    : "",
                }
              : row
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
              <div className="setting-field">
                <label htmlFor={`custom-provider-context-${row.key}`}>
                  上下文窗口
                </label>
                <input
                  id={`custom-provider-context-${row.key}`}
                  value={row.contextWindow}
                  inputMode="numeric"
                  onChange={(event) => updateModel(row.key, {
                    contextWindow: event.target.value,
                  })}
                />
                <small className="custom-provider-context-hint">
                  {customProviderContextHint(row)}
                </small>
              </div>
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