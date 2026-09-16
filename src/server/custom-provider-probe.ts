/**
 * Best-effort model-list probing for OpenAI-compatible custom providers.
 *
 * The probe reads `${baseUrl}/models` without credentials, accepts both the
 * OpenAI `{data:[...]}` and the LM Studio native `{models:[...]}` shapes, and
 * bounds every response to 1 MiB by streaming and aborting early.
 *
 * Context windows follow a fixed priority ladder. Every enrichment request is
 * serial, shares the probe's single deadline, and is silently ignored on
 * failure:
 *   1. the model item itself (`max_model_len`, then `context_length`, then
 *      `max_context_length`), reported as `models[].<field>`;
 *   2. the LM Studio native endpoint at the URL origin (`/api/v1/models`),
 *      which keeps its existing behavior and may override the item value;
 *   3. llama.cpp `/props` (`default_generation_settings.n_ctx`, then `n_ctx`);
 *   4. Ollama `/api/ps` for models that are currently loaded.
 * Levels 3-4 only fill a missing `contextWindow`. Ollama's `/api/ps` shape is
 * taken from its public API documentation and has not been verified against a
 * local Ollama; it is strictly shape-checked and never changes existing
 * behavior when the endpoint is absent or malformed.
 */
import {
  MAX_CUSTOM_PROVIDER_PROBED_MODELS,
  type CustomProviderProbedModel,
} from "../shared/protocol.js";

export interface OpenAiCompatibleModelsProbeResult {
  models: CustomProviderProbedModel[];
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONTEXT_WINDOW = 100_000_000;
const MAX_MODEL_NAME_CHARACTERS = 256;
/** 与 `customProviderProbedModelSchema` 的 id 上限一致：超出线协议的条目不能投影。 */
const MAX_MODEL_ID_CHARACTERS = 256;
const LM_STUDIO_CONTEXT_SOURCE = "/api/v1/models";
const LLAMA_CPP_CONTEXT_SOURCE = "/props";
const OLLAMA_CONTEXT_SOURCE = "/api/ps";
/** 最显式到最间接：命中第一个能用的字段。 */
const CONTEXT_WINDOW_ITEM_FIELDS = [
  "max_model_len",
  "context_length",
  "max_context_length",
] as const;
const MAX_TOKENS_ITEM_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
] as const;

interface ProbedEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  contextSource?: string;
  maxTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid custom provider base URL: ${value}`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.hostname.length === 0
  ) {
    throw new Error(`Custom provider base URL must be an absolute http(s) URL: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

async function readBoundedBody(response: Response, url: string): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(`Response from ${url} exceeds the ${MAX_RESPONSE_BYTES} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", signal });
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${formatError(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with HTTP ${response.status}`);
  }
  const bytes = await readBoundedBody(response, url);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new Error(`Response from ${url} is not valid JSON`, { cause: error });
  }
}

/** LM Studio 原生列表里的 `type` 可能标记 embedding 等非对话模型。 */
function isNonLlmType(value: unknown): boolean {
  return typeof value === "string" && value !== "llm";
}

function isBoundedPositiveInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= MAX_CONTEXT_WINDOW;
}

function normalizedName(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_MODEL_NAME_CHARACTERS
    ? value
    : undefined;
}

/** 通用 item 字段：返回第一个可用字段及其来源字符串。 */
function itemContextWindow(entry: Record<string, unknown>): {
  value: number;
  source: string;
} | undefined {
  for (const field of CONTEXT_WINDOW_ITEM_FIELDS) {
    const value = entry[field];
    if (isBoundedPositiveInteger(value)) {
      return { value, source: `models[].${field}` };
    }
  }
  return undefined;
}

function itemMaxTokens(entry: Record<string, unknown>): number | undefined {
  for (const field of MAX_TOKENS_ITEM_FIELDS) {
    const value = entry[field];
    if (isBoundedPositiveInteger(value)) return value;
  }
  return undefined;
}

function withItemFields(entry: ProbedEntry, value: Record<string, unknown>): ProbedEntry {
  const contextWindow = itemContextWindow(value);
  if (contextWindow !== undefined) {
    entry.contextWindow = contextWindow.value;
    entry.contextSource = contextWindow.source;
  }
  const maxTokens = itemMaxTokens(value);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  return entry;
}

function parseOpenAiEntry(value: unknown): ProbedEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (isNonLlmType(value.type)) return undefined;
  const entry: ProbedEntry = { id: value.id };
  const name = normalizedName(value.name);
  if (name !== undefined) entry.name = name;
  return withItemFields(entry, value);
}

function parseNativeEntry(value: unknown): ProbedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.key === "string" && value.key.length > 0
    ? value.key
    : typeof value.id === "string" && value.id.length > 0
      ? value.id
      : undefined;
  if (id === undefined || isNonLlmType(value.type)) return undefined;
  const entry: ProbedEntry = { id };
  const name = normalizedName(value.display_name) ?? normalizedName(value.name);
  if (name !== undefined) entry.name = name;
  return withItemFields(entry, value);
}

function extractProbedEntries(payload: unknown): ProbedEntry[] {
  if (!isRecord(payload)) {
    throw new Error("Model list response must be a JSON object");
  }
  if (Array.isArray(payload.data)) {
    return payload.data
      .map(parseOpenAiEntry)
      .filter((entry): entry is ProbedEntry => entry !== undefined);
  }
  if (Array.isArray(payload.models)) {
    return payload.models
      .map(parseNativeEntry)
      .filter((entry): entry is ProbedEntry => entry !== undefined);
  }
  throw new Error('Model list response has neither a "data" nor a "models" array');
}

function limitProbedModels(entries: readonly ProbedEntry[]): {
  models: CustomProviderProbedModel[];
  truncated: boolean;
} {
  const models: CustomProviderProbedModel[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    // 线协议硬边界：过长的 id 无法作为有效模型 id 使用，宁可丢弃也不能发出
    // 一个会被 `safeSend` 判定非法并关闭连接的探测结果。
    if (entry.id.length > MAX_MODEL_ID_CHARACTERS) continue;
    if (models.length >= MAX_CUSTOM_PROVIDER_PROBED_MODELS) {
      truncated = true;
      break;
    }
    seen.add(entry.id);
    const model: CustomProviderProbedModel = { id: entry.id };
    if (entry.name !== undefined) model.name = entry.name;
    if (entry.contextWindow !== undefined) model.contextWindow = entry.contextWindow;
    if (entry.contextSource !== undefined) model.contextSource = entry.contextSource;
    if (entry.maxTokens !== undefined) model.maxTokens = entry.maxTokens;
    models.push(model);
  }
  return { models, truncated };
}

/**
 * 只采信**已加载实例**的上下文：LM Studio 的 `max_context_length` 是模型架构上限，
 * 与实际分配无关（同一个模型重新加载后可能是 29696，也可能是 182272），先报大了
 * 反而会造成运行时溢出。未加载的模型宁可没有数值，由用户手填或等加载后再探测。
 */
function nativeLoadedContextWindow(entry: Record<string, unknown>): number | undefined {
  const loaded = Array.isArray(entry.loaded_instances) ? entry.loaded_instances[0] : undefined;
  if (isRecord(loaded) && isRecord(loaded.config)) {
    if (isBoundedPositiveInteger(loaded.config.context_length)) {
      return loaded.config.context_length;
    }
  }
  return undefined;
}

/** 原生列表里显式标记为 embedding 的条目不能作为聊天模型提供。 */
function isNonChatNativeType(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "embedding";
}

/** LM Studio 的 `capabilities.reasoning` 是对象（含 allowed_options/default），不能按布尔判断。 */
function reportsReasoningCapability(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "object" && value !== null;
}

/** LM Studio 原生端点：命中时以已加载上下文覆盖通用 item 值。 */
async function applyLmStudioContext(
  fetchImpl: typeof fetch,
  url: string,
  models: CustomProviderProbedModel[],
  signal: AbortSignal,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await fetchJson(fetchImpl, url, signal);
  } catch {
    return;
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) return;
  const nativeById = new Map<string, Record<string, unknown>>();
  const nonChatIds = new Set<string>();
  for (const value of payload.models) {
    if (!isRecord(value)) continue;
    const id = typeof value.key === "string" && value.key.length > 0
      ? value.key
      : typeof value.id === "string" && value.id.length > 0
        ? value.id
        : undefined;
    if (id === undefined) continue;
    if (isNonChatNativeType(value.type)) {
      nonChatIds.add(id);
      continue;
    }
    if (!nativeById.has(id)) nativeById.set(id, value);
  }
  if (nonChatIds.size > 0) {
    for (let index = models.length - 1; index >= 0; index -= 1) {
      const candidate = models[index];
      if (candidate !== undefined && nonChatIds.has(candidate.id)) {
        models.splice(index, 1);
      }
    }
  }
  for (const model of models) {
    const native = nativeById.get(model.id);
    if (native === undefined) continue;
    const contextWindow = nativeLoadedContextWindow(native);
    if (contextWindow !== undefined) {
      model.contextWindow = contextWindow;
      model.contextSource = LM_STUDIO_CONTEXT_SOURCE;
    }
    const name = normalizedName(native.display_name);
    if (name !== undefined) model.name = name;
    const capabilities = isRecord(native.capabilities) ? native.capabilities : undefined;
    if (reportsReasoningCapability(capabilities?.reasoning)) model.reasoning = true;
    model.input = capabilities?.vision === true ? ["text", "image"] : ["text"];
  }
}

/** llama.cpp /props：形状不符则整级放弃，只填空缺。 */
function llamaCppContextWindow(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const generation = isRecord(payload.default_generation_settings)
    ? payload.default_generation_settings
    : undefined;
  if (isBoundedPositiveInteger(generation?.n_ctx)) return generation.n_ctx;
  return isBoundedPositiveInteger(payload.n_ctx) ? payload.n_ctx : undefined;
}

async function applyLlamaCppContext(
  fetchImpl: typeof fetch,
  url: string,
  models: CustomProviderProbedModel[],
  signal: AbortSignal,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await fetchJson(fetchImpl, url, signal);
  } catch {
    return;
  }
  const contextWindow = llamaCppContextWindow(payload);
  if (contextWindow === undefined) return;
  for (const model of models) {
    if (model.contextWindow !== undefined) continue;
    model.contextWindow = contextWindow;
    model.contextSource = LLAMA_CPP_CONTEXT_SOURCE;
  }
}

interface OllamaLoadedContext {
  id: string;
  contextWindow: number;
}

/** Ollama /api/ps 严格形状：任一条目不符即整级放弃。 */
function ollamaLoadedContexts(payload: unknown): OllamaLoadedContext[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;
  const loaded: OllamaLoadedContext[] = [];
  for (const value of payload.models) {
    if (!isRecord(value)) return undefined;
    const id = typeof value.name === "string" && value.name.length > 0
      ? value.name
      : typeof value.model === "string" && value.model.length > 0
        ? value.model
        : undefined;
    if (id === undefined || !isBoundedPositiveInteger(value.context_length)) {
      return undefined;
    }
    loaded.push({ id, contextWindow: value.context_length });
  }
  return loaded;
}

function matchesLoadedModelId(candidate: string, modelId: string): boolean {
  return candidate === modelId
    || (candidate.endsWith(":latest") && candidate.slice(0, -":latest".length) === modelId)
    || `${candidate}:latest` === modelId;
}

async function applyOllamaContext(
  fetchImpl: typeof fetch,
  url: string,
  models: CustomProviderProbedModel[],
  signal: AbortSignal,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await fetchJson(fetchImpl, url, signal);
  } catch {
    return;
  }
  const loaded = ollamaLoadedContexts(payload);
  if (loaded === undefined) return;
  for (const model of models) {
    if (model.contextWindow !== undefined) continue;
    const match = loaded.find((entry) => matchesLoadedModelId(entry.id, model.id));
    if (match === undefined) continue;
    model.contextWindow = match.contextWindow;
    model.contextSource = OLLAMA_CONTEXT_SOURCE;
  }
}

/**
 * 失败静默忽略：探测结果只允许被补充，不允许被富化请求破坏。
 * 三级请求串行共用同一 deadline，某级失败不阻止后续级继续尝试。
 */
async function enrichProbedModels(
  fetchImpl: typeof fetch,
  baseUrl: string,
  models: CustomProviderProbedModel[],
  signal: AbortSignal,
): Promise<void> {
  if (models.length === 0) return;
  const origin = new URL(baseUrl).origin;
  await applyLmStudioContext(fetchImpl, `${origin}/api/v1/models`, models, signal);
  await applyLlamaCppContext(fetchImpl, `${origin}/props`, models, signal);
  await applyOllamaContext(fetchImpl, `${origin}/api/ps`, models, signal);
}

export async function probeOpenAiCompatibleModels(
  baseUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<OpenAiCompatibleModelsProbeResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`Model list request exceeded ${timeoutMs} ms`)),
    timeoutMs,
  );
  const signal = options.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([timeoutController.signal, options.signal]);
  try {
    const payload = await fetchJson(fetchImpl, `${normalizedBaseUrl}/models`, signal);
    const { models, truncated } = limitProbedModels(extractProbedEntries(payload));
    await enrichProbedModels(fetchImpl, normalizedBaseUrl, models, signal);
    return { models, truncated };
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error(
        `Probing model list at ${normalizedBaseUrl} timed out after ${timeoutMs} ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
