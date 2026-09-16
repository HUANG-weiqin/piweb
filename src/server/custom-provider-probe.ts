/**
 * Best-effort model-list probing for OpenAI-compatible custom providers.
 *
 * The probe reads `${baseUrl}/models` without credentials, accepts both the
 * OpenAI `{data:[...]}` and the LM Studio native `{models:[...]}` shapes, and
 * bounds every response to 1 MiB by streaming and aborting early. Enrichment
 * fields (context window, display name, capabilities) come from a separate
 * best-effort call to the LM Studio native endpoint at the URL origin; any
 * failure there is silently ignored.
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

interface ProbedEntry {
  id: string;
  name?: string;
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

function normalizedName(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_MODEL_NAME_CHARACTERS
    ? value
    : undefined;
}

function parseOpenAiEntry(value: unknown): ProbedEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (isNonLlmType(value.type)) return undefined;
  return { id: value.id, name: normalizedName(value.name) };
}

function parseNativeEntry(value: unknown): ProbedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.key === "string" && value.key.length > 0
    ? value.key
    : typeof value.id === "string" && value.id.length > 0
      ? value.id
      : undefined;
  if (id === undefined || isNonLlmType(value.type)) return undefined;
  return {
    id,
    name: normalizedName(value.display_name) ?? normalizedName(value.name),
  };
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
    models.push(entry.name === undefined ? { id: entry.id } : { id: entry.id, name: entry.name });
  }
  return { models, truncated };
}

function isRepresentableContextWindow(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= MAX_CONTEXT_WINDOW;
}

function nativeContextWindow(entry: Record<string, unknown>): number | undefined {
  const loaded = Array.isArray(entry.loaded_instances) ? entry.loaded_instances[0] : undefined;
  if (isRecord(loaded) && isRecord(loaded.config)) {
    if (isRepresentableContextWindow(loaded.config.context_length)) {
      return loaded.config.context_length;
    }
  }
  return isRepresentableContextWindow(entry.max_context_length)
    ? entry.max_context_length
    : undefined;
}

/** 失败静默忽略：探测结果只允许被补充，不允许被富化请求破坏。 */
async function enrichProbedModels(
  fetchImpl: typeof fetch,
  baseUrl: string,
  models: CustomProviderProbedModel[],
  signal: AbortSignal,
): Promise<void> {
  if (models.length === 0) return;
  let payload: unknown;
  try {
    payload = await fetchJson(fetchImpl, `${new URL(baseUrl).origin}/api/v1/models`, signal);
  } catch {
    return;
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) return;
  const nativeById = new Map<string, Record<string, unknown>>();
  for (const value of payload.models) {
    if (!isRecord(value)) continue;
    const id = typeof value.key === "string" && value.key.length > 0
      ? value.key
      : typeof value.id === "string" && value.id.length > 0
        ? value.id
        : undefined;
    if (id !== undefined && !nativeById.has(id)) nativeById.set(id, value);
  }
  for (const model of models) {
    const native = nativeById.get(model.id);
    if (native === undefined) continue;
    const contextWindow = nativeContextWindow(native);
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const name = normalizedName(native.display_name);
    if (name !== undefined) model.name = name;
    const capabilities = isRecord(native.capabilities) ? native.capabilities : undefined;
    if (capabilities?.reasoning === true) model.reasoning = true;
    model.input = capabilities?.vision === true ? ["text", "image"] : ["text"];
  }
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
