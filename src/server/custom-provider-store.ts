/**
 * Process-global custom provider authoring for Pi's user-level models.json.
 *
 * models.json stays Pi's single source of truth. This store reads the raw
 * bytes, projects a bounded secret-free snapshot for the settings page, and
 * writes back a surgical text edit that preserves comments, formatting, and
 * every field the form does not own. An edit reaches the disk only after the
 * result re-parses to exactly the intended provider structure under Pi's own
 * comment-stripping parser.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  CUSTOM_PROVIDER_APIS,
  isEditableCustomProviderId,
  MAX_CUSTOM_PROVIDER_MODELS,
  MAX_CUSTOM_PROVIDERS,
  type CustomProviderModelInput,
  type CustomProviderModelSnapshot,
  type CustomProviderSaveInput,
  type CustomProviderSnapshot,
  type CustomProviderStoredAuthKind,
} from "../shared/protocol.js";

export interface CustomProviderSnapshotView {
  revision: string;
  providers: CustomProviderSnapshot[];
  error?: string;
  truncated: boolean;
}

export interface CustomProviderStoreOptions {
  modelsPath: string;
  /** Pi 内置 provider id；调用方传入。 */
  builtinProviderIds?: ReadonlySet<string>;
}

/** models.json 的读取上限；超过即视为不可安全编辑。 */
const MAX_MODELS_FILE_BYTES = 4 * 1024 * 1024;
const REVISION_ABSENT = "absent";
const REVISION_ERROR = "error";
/** 线协议 snapshot schema 对字段名、模型 id 与列表长度的上限。 */
const MAX_FIELD_NAME_CHARACTERS = 128;
const MAX_MODEL_ID_CHARACTERS = 256;
const MAX_EXTRA_FIELDS = 64;
const MAX_ENV_NAMES = 64;
const MAX_MODEL_INPUT_ENTRIES = 8;
const PROVIDER_EXTRA_EXCLUDED = new Set([
  "name",
  "baseUrl",
  "api",
  "apiKey",
  "models",
]);
const MODEL_EXTRA_EXCLUDED = new Set([
  "id",
  "name",
  "api",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
]);
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*/;

interface LoadedModelsFile {
  /** 原始字节的 sha256 hex；缺失为 "absent"，读取或大小失败为 "error"。 */
  revision: string;
  /** 成功解析为对象文档时才存在。 */
  document?: {
    text: string;
    providers: Record<string, unknown>;
  };
  /** 文件存在但无法安全读取或编辑时的错误。 */
  error?: string;
}

let cachedBuiltinProviderIds: ReadonlySet<string> | undefined;

function builtinProviderIdSet(): ReadonlySet<string> {
  cachedBuiltinProviderIds ??= new Set(
    builtinProviders().map((provider) => provider.id),
  );
  return cachedBuiltinProviderIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** 与 Pi 的 ModelConfig.load 一致：支持 `//` 行注释与尾逗号，不支持块注释。 */
function stripJsonComments(input: string): string {
  return input
    .replace(
      /"(?:\\.|[^"\\])*"|\/\/[^\n]*/g,
      (match) => (match[0] === '"' ? match : ""),
    )
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""),
    );
}

/**
 * 与 Pi 的 resolveConfigValue 模板语法一致：`$$`/`$!` 是字面量转义，只有
 * 合法变量名的 `$NAME` / `${NAME}` 才是环境变量引用。
 */
function configValueEnvNames(value: string): string[] {
  const names: string[] = [];
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) break;
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end < 0) {
        index = dollar + 1;
        continue;
      }
      const name = value.slice(dollar + 2, end);
      if (ENV_VAR_NAME_PATTERN.test(name) && !names.includes(name)) {
        names.push(name);
      }
      index = end + 1;
      continue;
    }
    const match = value.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX_PATTERN);
    if (match) {
      if (!names.includes(match[0])) names.push(match[0]);
      index = dollar + 1 + match[0].length;
      continue;
    }
    index = dollar + 1;
  }
  return names;
}

function describeStoredAuth(provider: Record<string, unknown>): {
  storedAuth: CustomProviderStoredAuthKind;
  authEnvNames: string[];
} {
  const apiKey = provider.apiKey;
  if (apiKey === undefined) return { storedAuth: "none", authEnvNames: [] };
  if (typeof apiKey !== "string") return { storedAuth: "literal", authEnvNames: [] };
  if (apiKey.startsWith("!")) return { storedAuth: "command", authEnvNames: [] };
  const names = configValueEnvNames(apiKey);
  if (names.length > 0) {
    return {
      storedAuth: "env",
      authEnvNames: names
        .filter((name) => name.length <= MAX_FIELD_NAME_CHARACTERS)
        .slice(0, MAX_ENV_NAMES),
    };
  }
  return { storedAuth: "literal", authEnvNames: [] };
}

function collectExtraFields(
  value: Record<string, unknown>,
  excluded: ReadonlySet<string>,
): string[] {
  return Object.keys(value)
    .filter((key) => !excluded.has(key) && key.length <= MAX_FIELD_NAME_CHARACTERS)
    .sort()
    .slice(0, MAX_EXTRA_FIELDS);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function projectModelSnapshot(value: unknown): CustomProviderModelSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string"
    || value.id.length === 0
    || value.id.length > MAX_MODEL_ID_CHARACTERS
  ) {
    return undefined;
  }
  const snapshot: CustomProviderModelSnapshot = {
    id: value.id,
    extraFields: collectExtraFields(value, MODEL_EXTRA_EXCLUDED),
  };
  if (typeof value.name === "string" && value.name.length <= 256) {
    snapshot.name = value.name;
  }
  if (typeof value.api === "string" && value.api.length <= MAX_FIELD_NAME_CHARACTERS) {
    snapshot.api = value.api;
  }
  if (isNonNegativeInteger(value.contextWindow)) snapshot.contextWindow = value.contextWindow;
  if (isNonNegativeInteger(value.maxTokens)) snapshot.maxTokens = value.maxTokens;
  if (typeof value.reasoning === "boolean") snapshot.reasoning = value.reasoning;
  if (Array.isArray(value.input)) {
    const input = value.input
      .filter((entry): entry is string => typeof entry === "string" && entry.length <= 32)
      .slice(0, MAX_MODEL_INPUT_ENTRIES);
    if (input.length > 0) snapshot.input = input;
  }
  return snapshot;
}

function isEditableProvider(
  provider: Record<string, unknown>,
  id: string,
  builtinProviderIds: ReadonlySet<string>,
): boolean {
  if (!isEditableCustomProviderId(id) || builtinProviderIds.has(id)) return false;
  if (Object.prototype.hasOwnProperty.call(provider, "oauth")) return false;
  if (!isAbsoluteHttpUrl(provider.baseUrl)) return false;
  if (
    typeof provider.api !== "string"
    || !(CUSTOM_PROVIDER_APIS as readonly string[]).includes(provider.api)
  ) {
    return false;
  }
  const models = provider.models;
  if (!Array.isArray(models) || models.length === 0) return false;
  return models.every((model) => (
    isRecord(model) && typeof model.id === "string" && model.id.length > 0
  ));
}

function projectProviderSnapshot(
  id: string,
  value: unknown,
  builtinProviderIds: ReadonlySet<string>,
): CustomProviderSnapshot {
  const provider = isRecord(value) ? value : {};
  const auth = describeStoredAuth(provider);
  const models = Array.isArray(provider.models) ? provider.models : [];
  const snapshot: CustomProviderSnapshot = {
    id,
    storedAuth: auth.storedAuth,
    authEnvNames: auth.authEnvNames,
    models: models
      .slice(0, MAX_CUSTOM_PROVIDER_MODELS)
      .map(projectModelSnapshot)
      .filter((model): model is CustomProviderModelSnapshot => model !== undefined),
    extraFields: collectExtraFields(provider, PROVIDER_EXTRA_EXCLUDED),
    editable: isEditableProvider(provider, id, builtinProviderIds),
    builtinOverride: builtinProviderIds.has(id),
  };
  if (typeof provider.name === "string" && provider.name.length <= 256) {
    snapshot.name = provider.name;
  }
  if (typeof provider.baseUrl === "string" && provider.baseUrl.length <= 4096) {
    snapshot.baseUrl = provider.baseUrl;
  }
  if (typeof provider.api === "string" && provider.api.length <= MAX_FIELD_NAME_CHARACTERS) {
    snapshot.api = provider.api;
  }
  return snapshot;
}

function mergeProviderValue(
  base: Record<string, unknown> | undefined,
  input: CustomProviderSaveInput,
): Record<string, unknown> {
  const merged: Record<string, unknown> = base === undefined ? {} : structuredClone(base);
  if (input.name === undefined) delete merged.name;
  else merged.name = input.name;
  merged.baseUrl = input.baseUrl;
  merged.api = input.api;
  switch (input.auth.kind) {
    case "local":
      merged.apiKey = "piweb-local";
      break;
    case "env":
      merged.apiKey = `$${input.auth.envName}`;
      break;
    case "credential":
      delete merged.apiKey;
      break;
    case "keep":
      break;
  }
  merged.models = mergeModelValues(base?.models, input.models);
  return merged;
}

function mergeModelValues(
  baseModels: unknown,
  inputModels: readonly CustomProviderModelInput[],
): Record<string, unknown>[] {
  const existingById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(baseModels)) {
    for (const model of baseModels) {
      if (!isRecord(model) || typeof model.id !== "string") continue;
      if (!existingById.has(model.id)) existingById.set(model.id, model);
    }
  }
  return inputModels.map((input) => {
    const base = existingById.get(input.id);
    const merged: Record<string, unknown> = base === undefined
      ? { id: input.id }
      : structuredClone(base);
    if (input.name === undefined) delete merged.name;
    else merged.name = input.name;
    if (input.contextWindow === undefined) delete merged.contextWindow;
    else merged.contextWindow = input.contextWindow;
    if (input.maxTokens === undefined) delete merged.maxTokens;
    else merged.maxTokens = input.maxTokens;
    if (input.reasoning === undefined) delete merged.reasoning;
    else merged.reasoning = input.reasoning;
    if (input.input === undefined) delete merged.input;
    else merged.input = input.input;
    return merged;
  });
}

interface JsonMember {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  commaAfter?: number;
  commaBefore?: number;
}

interface ScannedObject {
  members: JsonMember[];
  close: number;
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const character = text[cursor];
    if (
      character === " "
      || character === "\t"
      || character === "\n"
      || character === "\r"
      || character === "\uFEFF"
    ) {
      cursor++;
      continue;
    }
    if (character === "/" && text[cursor + 1] === "/") {
      const newline = text.indexOf("\n", cursor);
      cursor = newline < 0 ? text.length : newline + 1;
      continue;
    }
    break;
  }
  return cursor;
}

function skipString(text: string, index: number): number {
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === '"') return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipValue(text: string, index: number): number {
  const character = text[index];
  if (character === '"') return skipString(text, index);
  if (character === "{" || character === "[") {
    let depth = 0;
    let cursor = index;
    while (cursor < text.length) {
      const current = text[cursor];
      if (current === '"') {
        cursor = skipString(text, cursor);
        continue;
      }
      if (current === "/" && text[cursor + 1] === "/") {
        const newline = text.indexOf("\n", cursor);
        cursor = newline < 0 ? text.length : newline + 1;
        continue;
      }
      if (current === "{" || current === "[") depth++;
      else if (current === "}" || current === "]") depth--;
      cursor++;
      if (depth === 0) return cursor;
    }
    return cursor;
  }
  let cursor = index;
  while (cursor < text.length) {
    const current = text[cursor];
    if (
      current === ","
      || current === "}"
      || current === "]"
      || current === " "
      || current === "\t"
      || current === "\n"
      || current === "\r"
    ) {
      break;
    }
    if (current === "/" && text[cursor + 1] === "/") break;
    cursor++;
  }
  return cursor;
}

/** 扫描一个已知合法的对象文本；位置以 UTF-16 单元计。 */
function scanObject(text: string, open: number): ScannedObject {
  const members: JsonMember[] = [];
  let index = skipWhitespace(text, open + 1);
  while (index < text.length && text[index] !== "}") {
    if (text[index] !== '"') {
      throw new Error("models.json is not structurally editable");
    }
    const keyStart = index;
    const keyEnd = skipString(text, index);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ":") {
      throw new Error("models.json is not structurally editable");
    }
    index = skipWhitespace(text, index + 1);
    const valueStart = index;
    const valueEnd = skipValue(text, index);
    index = skipWhitespace(text, valueEnd);
    let commaAfter: number | undefined;
    if (text[index] === ",") {
      commaAfter = index;
      index = skipWhitespace(text, index + 1);
    }
    members.push({
      key,
      keyStart,
      valueStart,
      valueEnd,
      commaAfter,
      commaBefore: members[members.length - 1]?.commaAfter,
    });
  }
  if (index >= text.length) {
    throw new Error("models.json is not structurally editable");
  }
  return { members, close: index };
}

function lineIndent(text: string, index: number): string | undefined {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

function detectIndentUnit(text: string): string {
  for (const line of text.split("\n")) {
    const match = /^([ \t]+)(?=\S)/.exec(line);
    if (match) return match[1];
  }
  return "  ";
}

function serializeMember(
  id: string,
  value: Record<string, unknown>,
  entryIndent: string,
  unit: string,
): string {
  const lines = JSON.stringify(value, null, unit).split("\n");
  const shifted = lines.length === 1
    ? lines[0]
    : [lines[0], ...lines.slice(1).map((line) => entryIndent + line)].join("\n");
  return `${entryIndent}${JSON.stringify(id)}: ${shifted}`;
}

function insertMember(
  text: string,
  providers: ScannedObject,
  providersMember: JsonMember,
  memberText: string,
  providersIndent: string,
): string {
  if (providers.members.length > 0) {
    const last = providers.members[providers.members.length - 1];
    if (last.commaAfter !== undefined) {
      const insertAt = last.commaAfter + 1;
      return `${text.slice(0, insertAt)}\n${memberText}${text.slice(insertAt)}`;
    }
    return `${text.slice(0, last.valueEnd)},\n${memberText}${text.slice(last.valueEnd)}`;
  }
  const open = providersMember.valueStart;
  const region = text.slice(open + 1, providers.close);
  const lastNewline = region.lastIndexOf("\n");
  if (lastNewline >= 0) {
    const insertAt = open + 1 + lastNewline + 1;
    return `${text.slice(0, insertAt)}${memberText}\n${text.slice(insertAt)}`;
  }
  return `${text.slice(0, open + 1)}\n${memberText}\n${providersIndent}${text.slice(open + 1)}`;
}

function consumeLineEnd(text: string, index: number): number {
  let cursor = index;
  while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  if (text[cursor] === "\r") cursor++;
  if (text[cursor] === "\n") cursor++;
  return cursor;
}

function removeMember(text: string, member: JsonMember): string {
  const lineStart = text.lastIndexOf("\n", member.keyStart - 1) + 1;
  const atLineStart = /^[ \t]*$/.test(text.slice(lineStart, member.keyStart));
  let start = member.keyStart;
  let end = member.valueEnd;
  if (member.commaAfter !== undefined) {
    end = member.commaAfter + 1;
    if (atLineStart) {
      start = lineStart;
      end = consumeLineEnd(text, end);
    } else {
      while (text[end] === " " || text[end] === "\t") end++;
    }
  } else if (member.commaBefore !== undefined) {
    start = member.commaBefore;
  } else if (atLineStart) {
    start = lineStart;
    end = consumeLineEnd(text, end);
  }
  return text.slice(0, start) + text.slice(end);
}

/** 只替换/插入/删除 `providers` 下的目标成员，其余文本逐字节保留。 */
function editProviderMember(
  text: string,
  id: string,
  value: Record<string, unknown> | null,
  unit: string,
): string {
  const root = scanObject(text, skipWhitespace(text, 0));
  const providersMember = root.members.find((member) => member.key === "providers");
  if (providersMember === undefined || text[providersMember.valueStart] !== "{") {
    throw new Error("models.json does not contain a providers object");
  }
  const providers = scanObject(text, providersMember.valueStart);
  const existing = providers.members.find((member) => member.key === id);
  const providersIndent = lineIndent(text, providersMember.keyStart) ?? "";
  const firstMemberIndent = providers.members.length > 0
    ? lineIndent(text, providers.members[0].keyStart)
    : undefined;
  const entryIndent = firstMemberIndent ?? providersIndent + unit;
  if (value !== null) {
    if (existing !== undefined) {
      const targetIndent = lineIndent(text, existing.keyStart) ?? entryIndent;
      const memberText = serializeMember(id, value, targetIndent, unit);
      return text.slice(0, existing.keyStart)
        + memberText.slice(targetIndent.length)
        + text.slice(existing.valueEnd);
    }
    const memberText = serializeMember(id, value, entryIndent, unit);
    return insertMember(text, providers, providersMember, memberText, providersIndent);
  }
  if (existing === undefined) {
    throw new Error(`Provider "${id}" is not present in models.json`);
  }
  return removeMember(text, existing);
}

function createNewDocument(id: string, value: Record<string, unknown>): string {
  const unit = "  ";
  const member = serializeMember(id, value, unit + unit, unit);
  return `{\n${unit}"providers": {\n${member}\n${unit}}\n}\n`;
}

/** 落盘前的唯一真相复核：strip + parse 后必须与内存期望完全一致。 */
function verifyDocument(text: string, expectedProviders: Record<string, unknown>): void {
  let providers: unknown;
  try {
    const parsed = JSON.parse(stripJsonComments(stripBom(text))) as unknown;
    providers = isRecord(parsed) ? parsed.providers : undefined;
  } catch (error) {
    throw new Error(`models.json self-check failed: ${formatError(error)}`);
  }
  if (!isRecord(providers)) {
    throw new Error("models.json self-check failed: providers object missing");
  }
  if (JSON.stringify(providers) !== JSON.stringify(expectedProviders)) {
    throw new Error("models.json self-check failed: the file was left unchanged");
  }
}

export class CustomProviderStore {
  private readonly modelsPath: string;
  private readonly builtinProviderIds: ReadonlySet<string>;
  private writeTail: Promise<void> = Promise.resolve();
  private memoryOnly = false;

  /** 纯内存实例（无文件，初始 revision "absent"）；socket-server 测试用。 */
  static memory(): CustomProviderStore {
    const store = new CustomProviderStore({
      modelsPath: "",
      builtinProviderIds: new Set<string>(),
    });
    store.memoryOnly = true;
    return store;
  }

  constructor(options: CustomProviderStoreOptions) {
    this.modelsPath = options.modelsPath;
    this.builtinProviderIds = options.builtinProviderIds ?? builtinProviderIdSet();
  }

  async read(): Promise<CustomProviderSnapshotView> {
    if (this.memoryOnly) {
      return { revision: REVISION_ABSENT, providers: [], truncated: false };
    }
    const loaded = await this.load();
    if (loaded.error !== undefined) {
      return {
        revision: loaded.revision,
        providers: [],
        error: loaded.error,
        truncated: false,
      };
    }
    if (loaded.document === undefined) {
      return { revision: REVISION_ABSENT, providers: [], truncated: false };
    }
    const entries = Object.entries(loaded.document.providers);
    const providers: CustomProviderSnapshot[] = [];
    let truncated = false;
    for (const [id, value] of entries) {
      if (providers.length >= MAX_CUSTOM_PROVIDERS) {
        truncated = true;
        break;
      }
      if (id.length === 0 || id.length > MAX_FIELD_NAME_CHARACTERS) {
        truncated = true;
        continue;
      }
      const models = isRecord(value) && Array.isArray(value.models) ? value.models : [];
      if (models.length > MAX_CUSTOM_PROVIDER_MODELS) truncated = true;
      providers.push(projectProviderSnapshot(id, value, this.builtinProviderIds));
    }
    return { revision: loaded.revision, providers, truncated };
  }

  async save(
    input: CustomProviderSaveInput,
    expectedRevision: string,
  ): Promise<CustomProviderSnapshotView> {
    return this.enqueueWrite(async () => {
      this.assertWritable();
      const loaded = await this.load();
      this.assertRevisionCurrent(loaded, expectedRevision);
      if (loaded.error !== undefined) throw new Error(loaded.error);
      const document = loaded.document;
      const providers = document?.providers ?? {};
      const base = providers[input.id];
      const baseRecord = isRecord(base) ? base : undefined;
      if (input.auth.kind === "keep" && baseRecord === undefined) {
        throw new Error(
          `Cannot keep the existing apiKey for provider "${input.id}": it is not present in models.json`,
        );
      }
      const merged = mergeProviderValue(baseRecord, input);
      const expectedProviders = { ...providers, [input.id]: merged };
      const edited = document === undefined
        ? createNewDocument(input.id, merged)
        : editProviderMember(document.text, input.id, merged, detectIndentUnit(document.text));
      verifyDocument(edited, expectedProviders);
      await this.writeAtomically(edited);
      return this.read();
    });
  }

  async delete(
    providerId: string,
    expectedRevision: string,
  ): Promise<CustomProviderSnapshotView> {
    return this.enqueueWrite(async () => {
      this.assertWritable();
      const loaded = await this.load();
      this.assertRevisionCurrent(loaded, expectedRevision);
      if (loaded.error !== undefined) throw new Error(loaded.error);
      const document = loaded.document;
      if (document === undefined || !(providerId in document.providers)) {
        throw new Error(`Provider "${providerId}" is not present in models.json`);
      }
      const expectedProviders = { ...document.providers };
      delete expectedProviders[providerId];
      const edited = editProviderMember(
        document.text,
        providerId,
        null,
        detectIndentUnit(document.text),
      );
      verifyDocument(edited, expectedProviders);
      await this.writeAtomically(edited);
      return this.read();
    });
  }

  private assertWritable(): void {
    if (this.memoryOnly) {
      throw new Error(
        "Custom provider store has no models.json file; changes cannot be saved",
      );
    }
  }

  private assertRevisionCurrent(loaded: LoadedModelsFile, expectedRevision: string): void {
    if (loaded.revision !== expectedRevision) {
      throw new Error("models.json 已被外部修改，请刷新后重试");
    }
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(task, task);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<LoadedModelsFile> {
    try {
      const stats = await stat(this.modelsPath);
      if (stats.size > MAX_MODELS_FILE_BYTES) {
        return {
          revision: REVISION_ERROR,
          error: `Failed to load models.json: file exceeds ${MAX_MODELS_FILE_BYTES} bytes`,
        };
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { revision: REVISION_ABSENT };
      return {
        revision: REVISION_ERROR,
        error: `Failed to load models.json: ${formatError(error)}`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(this.modelsPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { revision: REVISION_ABSENT };
      return {
        revision: REVISION_ERROR,
        error: `Failed to load models.json: ${formatError(error)}`,
      };
    }
    if (bytes.byteLength > MAX_MODELS_FILE_BYTES) {
      return {
        revision: REVISION_ERROR,
        error: `Failed to load models.json: file exceeds ${MAX_MODELS_FILE_BYTES} bytes`,
      };
    }
    const revision = createHash("sha256").update(bytes).digest("hex");
    const text = bytes.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(stripBom(text))) as unknown;
    } catch (error) {
      return {
        revision,
        error: `Failed to parse models.json: ${formatError(error)}`,
      };
    }
    if (!isRecord(parsed)) {
      return {
        revision,
        error: "Failed to parse models.json: expected a top-level JSON object",
      };
    }
    if (!isRecord(parsed.providers)) {
      return {
        revision,
        error: 'Failed to parse models.json: "providers" must be an object',
      };
    }
    return { revision, document: { text, providers: parsed.providers } };
  }

  private async writeAtomically(text: string): Promise<void> {
    const directory = dirname(this.modelsPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${basename(this.modelsPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const mode = await stat(this.modelsPath).then(
      (stats) => stats.mode & 0o777,
      () => undefined,
    );
    try {
      await writeFile(temporaryPath, text, {
        encoding: "utf8",
        flag: "wx",
        ...(mode === undefined ? {} : { mode }),
      });
      await rename(temporaryPath, this.modelsPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
