import { z } from "zod";

/** Complete client JSON frames, including Base64 images and escaped text. */
export const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
export const MAX_SERVER_EVENT_BYTES = 64 * 1024 * 1024;
export const MAX_ROLE_COUNT = 64;
export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;
export const MAX_MODEL_REFERENCE_BYTES = 1024;
const MAX_ROLE_UNAVAILABLE_REASON_CHARACTERS = 4096;
export const MAX_PROJECT_CONVERSATIONS = 100;
export const MAX_PROJECT_ACTIVITY_SUMMARIES = 100;
export const MAX_WORKSPACE_SESSION_REPAIR_FILES = 100;
export const MAX_PROJECT_CONVERSATION_NAME_CHARACTERS = 24;
export const MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS = 500;
/** 用户可见的跨会话消息摘要：有界载荷，但可写成短段落。 */
export const MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS = 500;
export const MAX_SESSION_MESSAGE_SUMMARY_BYTES = 2 * 1024;
export const MAX_PROMPT_CHARACTERS = 200_000;
/** 浏览器 prompt/steer 最多四张原图；解码后单张 8 MiB、合计 16 MiB。 */
export const MAX_PROMPT_IMAGE_COUNT = 4;
export const MAX_PROMPT_IMAGE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024;
/** One-shot durable images cover the full bounded desktop-capture payload. */
export const MAX_CONVERSATION_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CONVERSATION_IMAGE_DATA_CHARACTERS =
  Math.ceil(MAX_CONVERSATION_IMAGE_BYTES / 3) * 4;
/** Durable history renders image input as this marker; image bytes stay out of snapshots. */
export const PROMPT_IMAGE_PLACEHOLDER = "[图片]";
export const MAX_PENDING_PROMPTS_PER_CONVERSATION = 64;
export const MAX_BASH_TASK_NOTIFICATION_TASKS = 4;
export const MAX_BASH_TASK_COMMAND_BYTES = 256;
export const MAX_BASH_TASK_NOTIFICATION_TEXT_BYTES = 8 * 1024;
export const MAX_BASH_TASK_NOTIFICATION_OUTPUT_TAIL_BYTES = 1024;
export const MAX_BASH_TASK_OUTPUT_FILE_BYTES = 4096;
export const MAX_LOOP_LIST_ITEMS = 100;
export const MAX_LOOP_LIST_ITEM_ID_CHARACTERS = 128;
export const MAX_LOOP_LIST_ITEM_TEXT_CHARACTERS = 512;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;
export const MIN_COMPACTION_THRESHOLD_PERCENT = 20;
export const MAX_COMPACTION_THRESHOLD_PERCENT = 90;
export const MAX_TRANSITION_DIAGNOSTIC_PHASE_MS = 60 * 60 * 1_000;
// v68: admissions carry their actual runId; exact queue removals distinguish
// manual withdrawal from abort so browsers can retain original input for recovery.
// v67: admitted browser prompts may be withdrawn by exact run/prompt identity;
// successful withdrawals broadcast an exact-focus prompt_withdrawn event.
// v66: original prompt/steer images are bounded at 8 MiB each, 16 MiB total
// and four images; complete client JSON frames allow 24 MiB for Base64 and text.
// v65: Bash task completion notifications are bounded durable history items;
// focused activity is session-scoped and no longer carries a runId.
// v64: Bash cleanup notices are no longer written or projected; run-scoped
// activity remains an aggregate focused snapshot/event only.
// v63: focused snapshots and low-frequency exact-focus events project only
// aggregate run-scoped Bash activity, with no individual job rows.
// v62: output-rate timing is measured at the server's first-token/completion
// boundary and the latest settled run is recoverable from focused snapshots.
// v58: rename commands are command-correlated and settle through the existing
// command completion/error envelope.
// v57: focused conversation snapshots always carry their transcript checkpoint
// and complete admitted-but-undelivered prompt FIFO.
// v56: project conversation summaries carry required compacting state, projected
// independently from activity and focused runtime state.
// v55: session-message cards carry a required tri-state peer-presence
// projection derived from a stable complete session-header census.
// v54: durable user and tool-result images share an exact physical-entry
// locator while placement remains specific to message text or tool content.
// v53: process-global UI preferences travel in hello and converge through a
// durable, command-correlated color-scheme update.
// v52: durable user-image placeholders carry bounded references; image bytes
// travel only in a correlated one-shot response.
// v51: wait-for-session activity always projects a target count; the legacy
// single-target activity shape is no longer accepted.
// v50: session-message cards project a bounded user-facing summary; legacy
// durable messages project an empty summary.
// v49: browser prompts may carry bounded local raster image attachments.
// v48: project conversation summaries no longer expose a peer lifecycle flag;
// all Agent-created peer sessions are persistent.
// v46: live assistant output estimates use Pi's base message estimator and
// remain distinct from final provider usage and all durable projections.
// v45: the browser derives the latest settled run's average output rate from
// final assistant usage; no intermediate usage projection crosses the wire.
// v44: live assistant output progress was a non-persistent stream projection
// for deriving a current output token rate in the focused browser.
// v43: project snapshots identify whether absent conversation rows are
// authoritative membership evidence or merely an incomplete observation.
// v42: successful workspace and conversation switches may carry bounded host
// phase durations on their correlated authority snapshot (or empty attach).
// v41: default compaction attempts and successful durable provenance distinguish
// the requested model identity from built-in and custom summaries.
// v40: role templates and frozen conversation role snapshots carry a required
// nullable compaction model; null follows the frozen primary model.
// v39: LoopList items project explicit pending, active, or completed status;
// active is durable focus state and remains separate from the actor run state.
// v38: role templates and frozen conversation role snapshots carry a required
// nullable default service tier, applied when no conversation override exists.
// v37: focused conversations may select a model-advertised request service
// tier, persisted by the host and validated again at dispatch.
// v36: project conversation summaries optionally project their collaboration
// root so the browser can group descendants without receiving lineage details.
// v35: wait-for-session activity projects a bounded target count
// instead of exposing a single target from a target set.
// v34: focused snapshots and identity-bound live events project the bounded
// conversation-scoped LoopList without adding it to high-frequency state.
// v33: cold conversation navigation may emit a correlated read-only preview
// before executable focus ownership is attached.
// v61: probed custom provider models may carry the endpoint source of a
// detected context window; probing also reads generic model-item fields,
// llama.cpp `/props` and Ollama loaded-model metadata, not only LM Studio's
// native catalog.
// v60: process-global custom model providers are authored through
// models.json, projected as a bounded secret-free snapshot, and probed for
// their OpenAI-compatible model list before saving.
// v59: idle current-leaf fork copies LLM-effective context into a fresh host
// lifecycle via `fork_conversation`; history anchors stay unsupported.
// v69: connection-scoped session-file inspection and backed-up tail repair,
// available even when workspace initialization fails; no validation bypass.
export const PROTOCOL_VERSION = 69;
export const OBSERVATION_FATAL_CLOSE_CODE = 4002;
export const COLOR_SCHEMES = ["quiet-rebel", "classic-rebel"] as const;
export type ColorScheme = typeof COLOR_SCHEMES[number];
export interface UiPreferences {
  colorScheme: ColorScheme;
}
const colorSchemeSchema = z.enum(COLOR_SCHEMES);
const uiPreferencesSchema: z.ZodType<UiPreferences> = z.object({
  colorScheme: colorSchemeSchema,
}).strict();

/** models.json 允许的 API 类型；设置页只写入这四种之一。 */
export const CUSTOM_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];
const customProviderApiSchema = z.enum(CUSTOM_PROVIDER_APIS);

/**
 * 设置页可以写入的鉴权形态。密钥值永不进入浏览器协议：
 * literal/command 形态只能由手写文件产生，编辑时按 `keep` 原样保留。
 */
export const CUSTOM_PROVIDER_AUTH_KINDS = [
  /** 本地服务无需鉴权：写入占位值，Pi 才把 provider 视为已配置。 */
  "local",
  /** 写入 `$NAME`，由请求时的进程环境解析。 */
  "env",
  /** 不写入 apiKey，改用模型连接里保存的凭据（auth.json）。 */
  "credential",
  /** 保留文件中现有 apiKey 原值；仅对已有条目有效。 */
  "keep",
] as const;
export type CustomProviderAuthKind = typeof CUSTOM_PROVIDER_AUTH_KINDS[number];

/** models.json 中既有 apiKey 的形态；只报告形态，不回传值。 */
export type CustomProviderStoredAuthKind =
  | "none"
  | "literal"
  | "env"
  | "command";

export const MAX_CUSTOM_PROVIDERS = 32;
export const MAX_CUSTOM_PROVIDER_MODELS = 64;
export const MAX_CUSTOM_PROVIDER_ID_CHARACTERS = 128;
export const MAX_CUSTOM_PROVIDER_PROBED_MODELS = 256;
/** 设置页只能创建/编辑这个形状的 id；其余条目只能直接编辑文件。 */
export function isEditableCustomProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && value.length > 0
    && value.length <= MAX_CUSTOM_PROVIDER_ID_CHARACTERS;
}

export interface CustomProviderModelInput {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export type CustomProviderAuthInput =
  | { kind: "local" }
  | { kind: "env"; envName: string }
  | { kind: "credential" }
  | { kind: "keep" };

export interface CustomProviderSaveInput {
  id: string;
  name?: string;
  baseUrl: string;
  api: CustomProviderApi;
  auth: CustomProviderAuthInput;
  models: CustomProviderModelInput[];
}

/** 表单不管理但必须原样保留的字段名，用于如实告知用户。 */
export interface CustomProviderModelSnapshot {
  id: string;
  name?: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  extraFields: string[];
}

export interface CustomProviderSnapshot {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  storedAuth: CustomProviderStoredAuthKind;
  authEnvNames: string[];
  models: CustomProviderModelSnapshot[];
  extraFields: string[];
  /** false 表示该条目含表单无法忠实表示的形态，只能直接编辑文件。 */
  editable: boolean;
  /** 该 id 同时是内置提供商：覆盖内置提供商只能直接编辑文件。 */
  builtinOverride: boolean;
}

/** 端点探测结果：只有 id 必然存在，其余字段是最佳努力的补充。 */
export interface CustomProviderProbedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  /** contextWindow 的端点来源（路径或字段名），供用户判断是否可信；缺失即没有探测到。 */
  contextSource?: string;
}

const customProviderIdSchema = z.string().trim()
  .min(1)
  .max(MAX_CUSTOM_PROVIDER_ID_CHARACTERS)
  .refine(
    isEditableCustomProviderId,
    "provider id must be a simple ASCII identifier",
  );
const customProviderEnvNameSchema = z.string().trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "envName must be a shell variable name");
const customProviderRevisionSchema = z.string().min(1).max(128);
const customProviderBaseUrlSchema = z.string().trim().min(1)
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:")
        && url.hostname.length > 0;
    } catch {
      return false;
    }
  }, "baseUrl must be an absolute http or https URL");
const customProviderModelInputSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(256).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  maxTokens: z.number().int().positive().max(100_000_000).optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
}).strict();
const customProviderAuthInputSchema: z.ZodType<CustomProviderAuthInput> =
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }).strict(),
    z.object({ kind: z.literal("env"), envName: customProviderEnvNameSchema }).strict(),
    z.object({ kind: z.literal("credential") }).strict(),
    z.object({ kind: z.literal("keep") }).strict(),
  ]);
const customProviderSaveInputSchema: z.ZodType<CustomProviderSaveInput> = z.object({
  id: customProviderIdSchema,
  name: z.string().trim().min(1).max(256).optional(),
  baseUrl: customProviderBaseUrlSchema,
  api: customProviderApiSchema,
  auth: customProviderAuthInputSchema,
  models: z.array(customProviderModelInputSchema)
    .min(1)
    .max(MAX_CUSTOM_PROVIDER_MODELS),
}).strict();
const customProviderModelSnapshotSchema: z.ZodType<CustomProviderModelSnapshot> = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  api: z.string().max(128).optional(),
  contextWindow: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string().max(32)).max(8).optional(),
  extraFields: z.array(z.string().max(128)).max(64),
}).strict();
const customProviderSnapshotSchema: z.ZodType<CustomProviderSnapshot> = z.object({
  id: z.string().min(1).max(MAX_CUSTOM_PROVIDER_ID_CHARACTERS),
  name: z.string().max(256).optional(),
  baseUrl: z.string().max(4096).optional(),
  api: z.string().max(128).optional(),
  storedAuth: z.enum(["none", "literal", "env", "command"]),
  authEnvNames: z.array(z.string().max(128)).max(64),
  models: z.array(customProviderModelSnapshotSchema)
    .max(MAX_CUSTOM_PROVIDER_MODELS),
  extraFields: z.array(z.string().max(128)).max(64),
  editable: z.boolean(),
  builtinOverride: z.boolean(),
}).strict();
const customProviderProbedModelSchema: z.ZodType<CustomProviderProbedModel> = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
  contextWindow: z.number().int().positive().max(100_000_000).optional(),
  maxTokens: z.number().int().positive().max(100_000_000).optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
  contextSource: z.string().min(1).max(64).optional(),
}).strict();

const required = z.string().trim().min(1);
const sessionIdSchema = z.string().uuid();
const conversationIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    "conversationId must be a valid Pi session id",
  );
const runIdSchema = z.string().uuid();
const focusIdSchema = z.string().uuid();
const authFlowIdSchema = z.string().uuid();
const extensionUIRequestIdSchema = z.string().uuid();
const commandIdSchema = z.string().uuid();
const conversationMessageIdSchema = z.string().min(1).max(256).refine(
  (value) => {
    const anchor = value.startsWith("assistant:")
      ? value.slice("assistant:".length)
      : value;
    return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(anchor);
  },
  "messageId must identify a durable conversation message",
);
const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
const boundedUtf8String = (
  maximumBytes: number,
  field: string,
) => z.string().superRefine((value, context) => {
  if (utf8Bytes(value) <= maximumBytes) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `${field} must be at most ${maximumBytes} UTF-8 bytes`,
  });
});
const modelReferenceString = (field: string) => boundedUtf8String(
  MAX_MODEL_REFERENCE_BYTES,
  field,
).refine(
  (value) => value.trim().length > 0,
  `${field} must not be blank`,
);

export const PROMPT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export type PromptImageMimeType = (typeof PROMPT_IMAGE_MIME_TYPES)[number];
export function promptImageMimeType(
  value: string,
): PromptImageMimeType | undefined {
  return PROMPT_IMAGE_MIME_TYPES.find((mimeType) => mimeType === value);
}
const promptImageMimeTypeSchema = z.enum(PROMPT_IMAGE_MIME_TYPES);
const MAX_PROMPT_IMAGE_DATA_CHARACTERS =
  Math.ceil(MAX_PROMPT_IMAGE_FILE_BYTES / 3) * 4;
function isCanonicalBase64(data: string): boolean {
  if (data.length % 4 !== 0) return false;
  let paddingLength = 0;
  if (data.endsWith("==")) paddingLength = 2;
  else if (data.endsWith("=")) paddingLength = 1;
  const contentLength = data.length - paddingLength;
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const isAlphabet = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!isAlphabet) return false;
  }
  return !data.slice(contentLength).includes("=")
    || data.slice(contentLength) === "="
    || data.slice(contentLength) === "==";
}
export function decodedPromptImageBytes(data: string): number {
  return (data.length / 4) * 3
    - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
function imagePayloadSchema(
  maximumDataCharacters: number,
  maximumDecodedBytes: number,
) {
  return z.object({
    mimeType: promptImageMimeTypeSchema,
    data: z.string().superRefine((data, context) => {
      if (data.length < 4) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "image data is too short",
        });
        return;
      }
      if (data.length > maximumDataCharacters) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "image data exceeds its bounded payload",
        });
        return;
      }
      if (!isCanonicalBase64(data)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "image data must be canonical base64",
        });
        return;
      }
      if (decodedPromptImageBytes(data) > maximumDecodedBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "decoded image data exceeds its bounded payload",
        });
      }
    }),
  }).strict();
}

const promptImageSchema = imagePayloadSchema(
  MAX_PROMPT_IMAGE_DATA_CHARACTERS,
  MAX_PROMPT_IMAGE_FILE_BYTES,
);
const conversationImageSchema = imagePayloadSchema(
  MAX_CONVERSATION_IMAGE_DATA_CHARACTERS,
  MAX_CONVERSATION_IMAGE_BYTES,
);
export type PromptImage = z.infer<typeof promptImageSchema>;
export type ConversationImage = z.infer<typeof conversationImageSchema>;

/** Parses one uploaded image without retaining unknown fields. */
export function parsePromptImage(value: unknown): PromptImage | undefined {
  const parsed = promptImageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Parses one stored image for a bounded, one-shot durable response. */
export function parseConversationImage(
  value: unknown,
): ConversationImage | undefined {
  const parsed = conversationImageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const promptImagesSchema = z.array(promptImageSchema)
  .max(MAX_PROMPT_IMAGE_COUNT)
  .superRefine((images, context) => {
    const bytes = images.reduce((total, image) => (
      total + decodedPromptImageBytes(image.data)
    ), 0);
    if (bytes <= MAX_PROMPT_IMAGE_BYTES) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `prompt images must be at most ${MAX_PROMPT_IMAGE_BYTES} bytes in total`,
    });
  });
const promptTextSchema = z.string().trim().max(MAX_PROMPT_CHARACTERS);
const boundedCharactersString = (
  maximumCharacters: number,
  field: string,
) => z.string().superRefine((value, context) => {
  if ([...value].length <= maximumCharacters) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `${field} must be at most ${maximumCharacters} characters`,
  });
});
const requiredBoundedCharactersString = (
  maximumCharacters: number,
  field: string,
) => z.string().trim().min(1).superRefine((value, context) => {
  if ([...value].length <= maximumCharacters) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `${field} must be at most ${maximumCharacters} characters`,
  });
});
const roleIdSchema = required.max(128).refine(
  (value) => value === "default" || z.string().uuid().safeParse(value).success,
  'roleId must be "default" or a UUID',
);
const roleModelSchema = z.object({
  provider: modelReferenceString("role.model.provider"),
  id: modelReferenceString("role.model.id"),
});
const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export const serviceTierSchema = z.enum([
  "auto",
  "default",
  "flex",
  "scale",
  "priority",
]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;
const toolModeSchema = z.enum(["read_only", "full_access"]);
export type ToolMode = z.infer<typeof toolModeSchema>;
const roleInputSchema = z.object({
  name: requiredBoundedCharactersString(
    MAX_ROLE_NAME_CHARACTERS,
    "role.name",
  ),
  description: boundedCharactersString(
    MAX_ROLE_DESCRIPTION_CHARACTERS,
    "role.description",
  ),
  systemPrompt: boundedUtf8String(
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
    "role.systemPrompt",
  ),
  model: roleModelSchema.nullable(),
  compactionModel: roleModelSchema.nullable(),
  defaultThinkingLevel: thinkingLevelSchema,
  defaultServiceTier: serviceTierSchema.nullable(),
  toolMode: toolModeSchema,
  canManageSessions: z.boolean(),
});

export const extensionUIRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("select"),
    title: z.string().max(500),
    options: z.array(z.string().max(500)).max(100),
  }),
  z.object({
    kind: z.literal("confirm"),
    title: z.string().max(500),
    message: z.string().max(20_000),
  }),
  z.object({
    kind: z.literal("input"),
    title: z.string().max(500),
    placeholder: z.string().max(2_000).optional(),
  }),
  z.object({
    kind: z.literal("editor"),
    title: z.string().max(500),
    prefill: z.string().max(200_000).optional(),
  }),
]);

const extensionUIResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel") }),
  z.object({ kind: z.literal("select"), value: z.string().max(500) }),
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ kind: z.literal("input"), value: z.string().max(200_000) }),
  z.object({ kind: z.literal("editor"), value: z.string().max(200_000) }),
]);

export type ExtensionUIRequest = z.infer<typeof extensionUIRequestSchema>;
export type ExtensionUIResponse = z.infer<typeof extensionUIResponseSchema>;

const sessionRepairFileNameSchema = z.string().min(1).max(255)
  .regex(/^[^/\\\x00]+\.jsonl$/);
const sessionRepairRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionRepairRequestSchema = z.object({
  fileName: sessionRepairFileNameSchema,
  expectedRevision: sessionRepairRevisionSchema,
}).strict();
export type WorkspaceSessionRepairRequest = z.infer<typeof sessionRepairRequestSchema>;

const sessionRepairPlanSchema = z.object({
  kind: z.enum(["remove_zero_tail", "append_newline", "discard_incomplete_tail"]),
  removedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retainedEntries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const sessionRepairIssueSchema = z.object({
  fileName: sessionRepairFileNameSchema,
  conversationId: conversationIdSchema.nullable(),
  revision: sessionRepairRevisionSchema,
  error: z.string().max(4096),
  repair: sessionRepairPlanSchema.nullable(),
}).strict();
export type WorkspaceSessionRepairIssue = z.infer<typeof sessionRepairIssueSchema>;
const sessionRepairBackupSchema = z.object({
  fileName: sessionRepairFileNameSchema,
  backupPath: z.string().min(1).max(4096),
}).strict();
export type WorkspaceSessionRepairBackup = z.infer<typeof sessionRepairBackupSchema>;
export interface WorkspaceSessionRepairReport {
  cwd: string;
  checkedFiles: number;
  issues: WorkspaceSessionRepairIssue[];
  truncated: boolean;
  recoveryError?: string;
}
export interface WorkspaceSessionRepairResult {
  cwd: string;
  backups: WorkspaceSessionRepairBackup[];
  /** Files already committed remain repaired and backed up when a later step fails. */
  error?: string;
}

const clientCommandUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inspect_workspace_sessions"),
    commandId: commandIdSchema,
    cwd: required.max(4096),
  }).strict(),
  z.object({
    type: z.literal("repair_workspace_sessions"),
    commandId: commandIdSchema,
    cwd: required.max(4096),
    files: z.array(sessionRepairRequestSchema).max(MAX_WORKSPACE_SESSION_REPAIR_FILES)
      .refine((files) => new Set(files.map(({ fileName }) => fileName)).size === files.length,
        "Repair file names must be unique"),
    allowDiscardIncompleteTail: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("browse_directory"),
    commandId: commandIdSchema,
    path: required.max(4096).optional(),
  }),
  z.object({
    type: z.literal("set_color_scheme"),
    commandId: commandIdSchema,
    colorScheme: colorSchemeSchema,
  }).strict(),
  z.object({
    type: z.literal("save_custom_provider"),
    commandId: commandIdSchema,
    /** 上一次快照的 revision；期间被外部改动时拒绝写入。 */
    expectedRevision: customProviderRevisionSchema,
    provider: customProviderSaveInputSchema,
  }).strict(),
  z.object({
    type: z.literal("refresh_custom_providers"),
    commandId: commandIdSchema,
  }).strict(),
  z.object({
    type: z.literal("delete_custom_provider"),
    commandId: commandIdSchema,
    expectedRevision: customProviderRevisionSchema,
    providerId: customProviderIdSchema,
  }).strict(),
  z.object({
    type: z.literal("probe_custom_provider_models"),
    commandId: commandIdSchema,
    baseUrl: customProviderBaseUrlSchema,
  }).strict(),
  z.object({
    type: z.literal("initialize"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    cwd: required.max(4096),
    conversation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("recent") }),
      z.object({
        kind: z.literal("new"),
        roleId: roleIdSchema.optional(),
      }),
      z.object({ kind: z.literal("open"), conversationId: conversationIdSchema }),
    ]),
  }),
  z.object({
    type: z.literal("focus_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
  }),
  z.object({
    type: z.literal("refresh_view"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema.optional(),
    focusId: focusIdSchema.optional(),
  }),
  z.object({
    type: z.literal("create_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    roleId: roleIdSchema,
    title: requiredBoundedCharactersString(
      MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
      "createConversation.title",
    ).optional(),
  }),
  z.object({
    type: z.literal("fork_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
  }),
  z.object({
    type: z.literal("prompt"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: commandIdSchema,
    runId: runIdSchema,
    /** 客户端生成的消息身份；busy 时用于 prompt_admitted/prompt_delivered 关联。 */
    promptId: z.string().uuid(),
    /** 图片可单独构成一条消息；空文本由 actor 与图片一并校验。 */
    text: promptTextSchema,
    images: promptImagesSchema.optional(),
  }),
  z.object({
    type: z.literal("steer"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    runId: runIdSchema,
    text: promptTextSchema,
    images: promptImagesSchema.optional(),
  }),
  z.object({
    type: z.literal("withdraw_prompt"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    runId: runIdSchema,
    promptId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("abort"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: commandIdSchema,
    runId: runIdSchema,
  }),
  z.object({
    type: z.literal("extension_ui_response"),
    sessionId: sessionIdSchema,
    requestId: extensionUIRequestIdSchema,
    response: extensionUIResponseSchema,
  }),
  z.object({
    type: z.literal("set_thinking"),
    sessionId: sessionIdSchema,
    level: thinkingLevelSchema,
  }),
  z.object({
    type: z.literal("set_compaction_threshold"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    percent: z.number().int()
      .min(MIN_COMPACTION_THRESHOLD_PERCENT)
      .max(MAX_COMPACTION_THRESHOLD_PERCENT),
  }),
  z.object({
    type: z.literal("set_service_tier"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    serviceTier: serviceTierSchema.nullable(),
  }),
  z.object({
    type: z.literal("compact_context"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
  }),
  z.object({
    type: z.literal("switch_conversation_role"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    roleId: roleIdSchema,
  }),
  z.object({
    type: z.literal("rename_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    name: requiredBoundedCharactersString(
      MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
      "renameConversation.name",
    ),
  }),
  z.object({
    type: z.literal("delete_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
  }),
  z.object({
    type: z.literal("truncate_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    messageId: conversationMessageIdSchema,
  }),
  z.object({
    type: z.literal("open_image"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    messageId: conversationMessageIdSchema,
    imageOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.object({
    type: z.literal("create_role"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    role: roleInputSchema,
  }),
  z.object({
    type: z.literal("update_role"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    roleId: roleIdSchema,
    expectedRevision: z.number().int().positive(),
    expectedSystemPrompt: boundedUtf8String(
      MAX_ROLE_SYSTEM_PROMPT_BYTES,
      "expectedSystemPrompt",
    ),
    role: roleInputSchema,
  }),
  z.object({
    type: z.literal("delete_role"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    roleId: roleIdSchema,
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("set_api_key"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    provider: required,
    key: required.max(32_768),
  }),
  z.object({ type: z.literal("login_oauth"), authFlowId: authFlowIdSchema, provider: required }),
  z.object({ type: z.literal("logout"), provider: required }),
  z.object({ type: z.literal("auth_response"), authFlowId: authFlowIdSchema, requestId: required, value: z.string().optional(), selectedId: z.string().optional(), cancelled: z.boolean().optional() }),
  z.object({ type: z.literal("cancel_auth"), authFlowId: authFlowIdSchema }),
  z.object({
    type: z.literal("refresh_models"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
  }),
  z.object({ type: z.literal("close_session"), sessionId: sessionIdSchema }),
]);

const clientCommandSchema = clientCommandUnionSchema.superRefine(
  (command, context) => {
    if (
      command.type === "initialize"
      && command.conversation?.kind === "new"
      && command.conversation.roleId === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A role must be selected before creating a conversation",
        path: ["conversation", "roleId"],
      });
    }
    if (
      command.type === "refresh_view"
      && ((command.conversationId === undefined)
        !== (command.focusId === undefined))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focusId and conversationId must either both be present or both be absent",
        path: ["focusId"],
      });
    }
  },
);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type AcknowledgedSettingOperation = "set_api_key" | "refresh_models";
const ACKNOWLEDGED_COMMAND_OPERATIONS = [
  "set_api_key",
  "refresh_models",
  "steer",
  "withdraw_prompt",
  "set_compaction_threshold",
  "set_service_tier",
  "compact_context",
  "switch_conversation_role",
  "rename_conversation",
  "delete_conversation",
  "truncate_conversation",
  "create_role",
  "update_role",
  "delete_role",
] as const;
export type AcknowledgedCommandOperation =
  typeof ACKNOWLEDGED_COMMAND_OPERATIONS[number];
interface PublicModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  serviceTiers?: ServiceTier[];
  input: string[];
  contextWindow: number;
  available: boolean;
}

export interface PublicProvider {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  authLabel?: string;
  oauth: boolean;
  models: PublicModel[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface PublicContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
  source: "measured" | "estimated" | "unknown";
}

export interface PublicCompactionAttempt {
  id: string;
  generator: "default";
  policy: "follow_primary" | "explicit";
  requestTarget: {
    provider: string;
    id: string;
  };
}

export type ConversationCompactionProvenance =
  | {
      generator: "default";
      attemptId: string;
      policy: "follow_primary" | "explicit";
      requestTarget: {
        provider: string;
        id: string;
      };
    }
  | { generator: "custom" };

export interface PublicState {
  sessionId: string;
  projectId: string;
  conversationId?: string;
  focusId?: string;
  conversationName?: string;
  cwd: string;
  busy: boolean;
  compacting?: boolean;
  compactionAttempt?: PublicCompactionAttempt;
  activeRun?: {
    id: string;
    phase: "queued" | "running" | "waiting" | "cancelling";
  };
  selectedModel?: { provider: string; id: string };
  selectedServiceTier: ServiceTier | null;
  thinkingLevel: ThinkingLevel;
  toolMode: ToolMode;
  availableThinkingLevels: ThinkingLevel[];
  providers: PublicProvider[];
  registryError?: string;
  /** 累计计费 token（跨整会话） */
  sessionTokenUsage?: TokenUsage;
  /** 当前上下文 token；compaction 后无可靠 usage 时显式保留 unknown。 */
  contextUsage?: PublicContextUsage;
  /** 当前会话自动压缩触发阈值。 */
  compactionThresholdPercent?: number;
}

export type AuthRequest =
  | { kind: "auth"; url: string; instructions?: string }
  | { kind: "device"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: "prompt"; message: string; placeholder?: string; allowEmpty?: boolean; secret?: boolean }
  | { kind: "manual"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: "select"; message: string; options: Array<{ id: string; label: string }> };

export interface ConversationImageLocator {
  /** Exact physical Pi JSONL message entry on the currently active branch. */
  messageId: string;
  /** Ordinal among top-level image content blocks in that durable message. */
  imageOrdinal: number;
}

export interface ConversationHistoryToolImageReference {
  /** Position of the data-free image marker in the projected result content. */
  contentIndex: number;
  source: ConversationImageLocator;
}

export interface ConversationHistoryTool {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  /** Metadata only; tool-result image bytes are fetched on demand. */
  resultImageRefs?: ConversationHistoryToolImageReference[];
  status: "pending" | "running" | "done" | "error";
}

export type ConversationHistoryMessagePart =
  | { kind: "text" | "thinking"; offset: number; length: number }
  | { kind: "tool"; toolCallId: string };

export interface ConversationHistoryImageReference {
  /** UTF-16 offset of the matching PROMPT_IMAGE_PLACEHOLDER in text. */
  offset: number;
  source: ConversationImageLocator;
}

export interface ConversationHistoryMessage {
  id: string;
  runId?: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ConversationHistoryTool[];
  parts: ConversationHistoryMessagePart[];
  /** Metadata only; durable image bytes are fetched on demand. */
  imageRefs?: ConversationHistoryImageReference[];
  usage?: TokenUsage;
}

export interface AverageOutputRate {
  runId: string;
  outputTokens: number;
  outputElapsedMs: number;
  tokensPerSecond: number;
}

/** busy 时已接受、尚未投递的浏览器 prompt（服务端内存态）。 */
export interface PendingPromptAdmissionSnapshot {
  promptId: string;
  text: string;
}

export type LoopListItemStatus = "pending" | "active" | "completed";

export interface LoopListItem {
  id: string;
  text: string;
  status: LoopListItemStatus;
}

export interface LoopList {
  items: LoopListItem[];
  armed: boolean;
}

export interface RoleModelSelection {
  provider: string;
  id: string;
}

export interface RoleTemplate {
  id: string;
  revision: number;
  name: string;
  description: string;
  systemPrompt: string;
  model: RoleModelSelection | null;
  compactionModel: RoleModelSelection | null;
  defaultThinkingLevel: ThinkingLevel;
  defaultServiceTier: ServiceTier | null;
  toolMode: ToolMode;
  canManageSessions: boolean;
  createdAt: string;
  updatedAt: string;
  available: boolean;
  unavailableReason?: string;
}

export interface ConversationRoleSnapshot {
  id: string;
  revision: number;
  name: string;
  description: string;
  systemPrompt: string;
  model: RoleModelSelection;
  compactionModel: RoleModelSelection | null;
  defaultThinkingLevel: ThinkingLevel;
  defaultServiceTier: ServiceTier | null;
  toolMode: ToolMode;
  canManageSessions: boolean;
}

export type ConversationActivity =
  | { kind: "idle" }
  | { kind: "queued" | "running" | "cancelling"; runId: string }
  | {
      kind: "waiting";
      runId: string;
      targetCount: number;
    };

export interface SessionMessageEndpoint {
  conversationId: string;
  title?: string;
  role: {
    id: string;
    name: string;
  };
}

export interface ConversationMessageCard {
  kind: "session_message";
  id: string;
  cardId: string;
  direction: "incoming" | "outgoing";
  state:
    | "sending"
    | "queued"
    | "delivered"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "aborted";
  body: string;
  /** 用户可见的发送方摘要；旧持久消息投影为空字符串。 */
  summary: string;
  from: SessionMessageEndpoint;
  to: SessionMessageEndpoint;
  sentAt: string;
  updatedAt: string;
  messageId?: string;
  delegationId?: string;
  runId?: string;
  result?: string;
  /**
   * Browser projection only. Durable cards do not own peer lifecycle state.
   */
  peerPresence: PeerPresence;
}

export type PeerPresence = "present" | "absent" | "unknown";
export type PeerPresenceResolution = Exclude<PeerPresence, "unknown">;

export interface ConversationCompactionMarker {
  kind: "compaction";
  id: string;
  timestamp: string;
  tokensBefore: number;
  provenance?: ConversationCompactionProvenance;
}

/** Bounded durable facts for one completed or killed background Bash task. */
export interface ConversationBashTask {
  taskId: string;
  command: string;
  status: "completed" | "failed" | "killed";
  exitCode: number | null;
  durationMs: number;
  stopReason?: "manual" | "timeout" | "output_limit" | "reload" | "dispose";
  partial?: boolean;
  outputFile?: string;
}

export interface ConversationBashTaskNotification {
  kind: "bash_task_notification";
  id: string;
  timestamp: string;
  text: string;
  tasks: ConversationBashTask[];
}

/** Focused aggregate only; never identifies individual background commands. */
export interface ConversationBashActivity {
  running: number;
  stopping: number;
  cleanupUnknown: boolean;
}

export type ConversationHistoryItem =
  | ({ kind: "message" } & ConversationHistoryMessage)
  | ConversationCompactionMarker
  | ConversationMessageCard
  | ConversationBashTaskNotification;

export interface ConversationWindowCoverage {
  omittedBefore: boolean;
  startsMidTurn: boolean;
  /**
   * Display-only bounding: this window dropped older items *or* clipped some
   * field text. Only `omittedBefore` describes window coverage, so this flag
   * must never gate an authority decision.
   */
  contentTruncated: boolean;
}

type ConversationCreatedBy =
  | { kind: "user" }
  | { kind: "conversation"; conversationId: string };

export interface ConversationSummary {
  id: string;
  rootConversationId?: string;
  name?: string;
  /** Volatile generated title for an active, not-yet-durable first run. */
  autoTitlePreview?: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  role?: Omit<ConversationRoleSnapshot, "systemPrompt">;
  activity?: ConversationActivity;
  /** Whether this conversation is currently compacting context. */
  compacting: boolean;
  attention?: boolean;
  unread?: boolean;
  createdBy?: ConversationCreatedBy;
}

/**
 * Complete means fresh, stable project membership, not a full transcript audit.
 * Cached or partial membership remains unknown; only complete, untruncated
 * snapshots may establish that a previously displayed conversation is absent.
 */
export type ProjectSnapshotCoverage = "complete" | "unknown";

export interface ProjectActivitySummary {
  projectId: string;
  cwd: string;
  busyConversationCount: number;
  attentionConversationCount: number;
}

export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  directories: Array<{
    name: string;
    path: string;
  }>;
  truncated: boolean;
}

/**
 * Stable workbench events consumed by the browser.
 * Pi SDK events are projected into this small contract on the server.
 */
export type SessionEvent =
  | { type: "run_queued" }
  | { type: "run_started" }
  | { type: "run_finished"; outcome: "completed" | "aborted" | "failed" }
  | { type: "user_message"; projectionId: string; text: string }
  | { type: "assistant_message_started"; projectionId: string }
  | { type: "text_delta"; delta: string }
  | { type: "text_replaced"; text: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_prepared"; toolCallId: string; args?: unknown }
  | { type: "tool_updated"; toolCallId: string; result?: unknown }
  | { type: "tool_finished"; toolCallId: string; result?: unknown; isError: boolean }
  | {
      type: "output_estimate";
      estimatedOutputTokens: number;
      /** Server-observed decode time for the open assistant segment. */
      outputElapsedMs: number;
    }
  | {
      type: "usage";
      usage: TokenUsage;
      /** Present only when a successful segment had an observable token delta. */
      outputElapsedMs?: number;
    };

type ErrorScope = "auth" | "command" | "protocol" | "session" | "settings";
const FOCUS_ATTACHED_OPERATIONS = [
  "initialize",
  "focus_conversation",
  "create_conversation",
  "fork_conversation",
] as const;
export type FocusAttachedOperation =
  typeof FOCUS_ATTACHED_OPERATIONS[number];

export type TransitionDiagnosticOperation =
  | "initialize"
  | "focus_conversation";

export interface TransitionDiagnostics {
  version: 1;
  commandId: string;
  operation: TransitionDiagnosticOperation;
  validationMs: number;
  contextOrCatalogMs: number;
  presentationOrTargetReadMs: number;
  actorActivationOrLeaseMs: number;
  snapshotProjectionMs: number | null;
}

export type ServerEvent =
  | {
      type: "hello";
      protocolVersion: number;
      startupCwd: string;
      uiPreferences: UiPreferences;
    }
  | {
      type: "ui_preferences_changed";
      uiPreferences: UiPreferences;
      /** Present only for the browser whose command durably committed. */
      commandId?: string;
    }
  | {
      type: "custom_providers_snapshot";
      /** 文件内容版本；写入必须回传同一值。 */
      revision: string;
      providers: CustomProviderSnapshot[];
      /** models.json 读取或校验失败时的诊断；此时 providers 为空。 */
      error?: string;
      /** 文件中的条目多于有界投影上限。 */
      truncated: boolean;
      /** Present only for the browser whose command durably committed. */
      commandId?: string;
    }
  | {
      type: "custom_provider_models_probe";
      commandId: string;
      baseUrl: string;
      models: CustomProviderProbedModel[];
      /** 端点返回的模型多于有界上限。 */
      truncated: boolean;
    }
  | ({ type: "workspace_sessions_inspected"; commandId: string } & WorkspaceSessionRepairReport)
  | ({ type: "workspace_sessions_repaired"; commandId: string } & WorkspaceSessionRepairResult)
  | ({ type: "directory_listing"; commandId: string } & DirectoryListing)
  | { type: "state"; state: PublicState }
  | {
      type: "focus_attached";
      operation: FocusAttachedOperation;
      commandId: string;
      sessionId: string;
      projectId: string;
      focusId?: string;
      conversationId?: string;
      transitionDiagnostics?: TransitionDiagnostics;
    }
  | {
      type: "focus_invalidated";
      sessionId: string;
      projectId: string;
      conversationId: string;
      focusId: string;
      reason: "deleted";
    }
  | {
      type: "role_catalog_snapshot";
      sessionId: string;
      projectId: string;
      roles: RoleTemplate[];
    }
  | {
      type: "project_snapshot";
      sessionId: string;
      projectId: string;
      conversationId?: string;
      conversations: ConversationSummary[];
      /**
       * The conversation list may be clipped (count, byte, or whole-group
       * budget). Field-value clipping of preview/name must not set it: the
       * browser only accepts an absent conversation as deleted when the
       * snapshot is `complete` and not truncated.
       */
      truncated: boolean;
      coverage: ProjectSnapshotCoverage;
    }
  | {
      type: "project_activity_snapshot";
      projects: ProjectActivitySummary[];
      /** Only the shared activity catalog may be clipped, never one project's counters. */
      truncated: boolean;
    }
  | {
      /** Correlated read-only display data; never executable focus authority. */
      type: "conversation_preview";
      sessionId: string;
      commandId: string;
      projectId: string;
      conversationId: string;
      cwd: string;
      toolMode: ToolMode;
      role?: ConversationRoleSnapshot;
      items: ConversationHistoryItem[];
      window: ConversationWindowCoverage;
    }
  | {
      /** 浏览器 prompt 已被服务端接受（busy 时进入 SDK steering 队列，尚未投递）。 */
      type: "prompt_admitted";
      sessionId: string;
      conversationId: string;
      focusId: string;
      promptId: string;
      /** The actual accepting run, not the prompt command's disposable runId. */
      runId: string;
      text: string;
    }
  | {
      /** 已接受的 prompt 已被 SDK 投递为真实 user message（JSONL entry）。 */
      type: "prompt_delivered";
      sessionId: string;
      conversationId: string;
      focusId: string;
      promptId: string;
      runId: string;
    }
  | {
      /** The exact queued browser prompt was removed before SDK delivery began. */
      type: "prompt_withdrawn";
      sessionId: string;
      conversationId: string;
      focusId: string;
      promptId: string;
      runId: string;
      reason: "manual" | "abort";
    }
  | {
      type: "conversation_image";
      sessionId: string;
      conversationId: string;
      focusId: string;
      commandId: string;
      messageId: string;
      imageOrdinal: number;
      mimeType: PromptImageMimeType;
      /** One-shot response only; never included in a history or state snapshot. */
      data: string;
    }
  | {
      type: "conversation_snapshot";
      sessionId: string;
      conversationId: string;
      focusId: string;
      role?: ConversationRoleSnapshot;
      /** Transcript checkpoint; it advances only with session events. */
      projectionSeq: number;
      items: ConversationHistoryItem[];
      /** Latest settled run; omitted while a run is active or timing was unavailable. */
      completedOutputRate?: AverageOutputRate;
      /** Aggregate activity owned by the focused conversation actor; null means none. */
      bashActivity?: ConversationBashActivity | null;
      /** busy 时已接受、尚未投递的浏览器 prompt（服务端内存态，重启丢失为接受项）。 */
      pendingPrompts: PendingPromptAdmissionSnapshot[];
      loopList?: LoopList;
      window: ConversationWindowCoverage;
      transitionDiagnostics?: TransitionDiagnostics;
    }
  | {
      type: "loop_list_update";
      sessionId: string;
      conversationId: string;
      focusId: string;
      loopList: LoopList;
    }
  | {
      type: "bash_activity";
      sessionId: string;
      conversationId: string;
      focusId: string;
      activity: ConversationBashActivity | null;
    }
  | {
      type: "session_event";
      sessionId: string;
      runId: string;
      conversationId: string;
      focusId: string;
      projectionSeq?: number;
      event: SessionEvent;
    }
  | {
      type: "conversation_run_settled";
      sessionId: string;
      projectId: string;
      conversationId: string;
      runId: string;
      outcome: "completed" | "aborted" | "failed";
      createdBy: ConversationCreatedBy;
    }
  | {
      type: "conversation_item";
      sessionId: string;
      conversationId: string;
      focusId: string;
      projectionSeq?: number;
      item: ConversationHistoryItem;
    }
  | {
      type: "extension_ui_request";
      sessionId: string;
      requestId: string;
      request: ExtensionUIRequest;
    }
  | { type: "extension_ui_closed"; sessionId: string; requestId: string }
  | {
      type: "extension_ui_notification";
      sessionId: string;
      level: "info" | "warning" | "error";
      message: string;
    }
  | { type: "auth_request"; authFlowId: string; requestId: string; request: AuthRequest }
  | { type: "auth_progress"; authFlowId: string; message: string }
  | { type: "auth_complete"; authFlowId: string; provider: string }
  | {
      type: "command_complete";
      operation: AcknowledgedCommandOperation;
      commandId: string;
      sessionId: string;
    }
  | {
      type: "error";
      message: string;
      scope: ErrorScope;
      operation?: ClientCommand["type"];
      sessionId?: string;
      runId?: string;
      conversationId?: string;
      focusId?: string;
      authFlowId?: string;
      commandId?: string;
    };

const tokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  input: z.number().finite(),
  output: z.number().finite(),
  cacheRead: z.number().finite(),
  cacheWrite: z.number().finite(),
  total: z.number().finite(),
});
const publicModelSchema: z.ZodType<PublicModel> = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  thinkingLevels: z.array(thinkingLevelSchema).min(1),
  serviceTiers: z.array(serviceTierSchema)
    .max(serviceTierSchema.options.length)
    .optional(),
  input: z.array(z.string()),
  contextWindow: z.number().finite(),
  available: z.boolean(),
});
const publicProviderSchema: z.ZodType<PublicProvider> = z.object({
  id: z.string(),
  name: z.string(),
  configured: z.boolean(),
  authSource: z.string().optional(),
  authLabel: z.string().optional(),
  oauth: z.boolean(),
  models: z.array(publicModelSchema),
});
const publicContextUsageSchema: z.ZodType<PublicContextUsage> = z.object({
  tokens: z.number().finite().nullable(),
  contextWindow: z.number().finite().nullable(),
  percent: z.number().finite().nullable(),
  source: z.enum(["measured", "estimated", "unknown"]),
});
const compactionRequestTargetSchema = z.object({
  provider: modelReferenceString("compaction request target provider"),
  id: modelReferenceString("compaction request target id"),
}).strict();
const publicCompactionAttemptSchema: z.ZodType<PublicCompactionAttempt> = z.object({
  id: z.string().uuid(),
  generator: z.literal("default"),
  policy: z.enum(["follow_primary", "explicit"]),
  requestTarget: compactionRequestTargetSchema,
}).strict();
const conversationCompactionProvenanceSchema: z.ZodType<ConversationCompactionProvenance> =
  z.discriminatedUnion("generator", [
    z.object({
      generator: z.literal("default"),
      attemptId: z.string().uuid(),
      policy: z.enum(["follow_primary", "explicit"]),
      requestTarget: compactionRequestTargetSchema,
    }).strict(),
    z.object({ generator: z.literal("custom") }).strict(),
  ]);
const publicStateSchema: z.ZodType<PublicState> = z.object({
  sessionId: sessionIdSchema,
  projectId: z.string().uuid(),
  conversationId: conversationIdSchema.optional(),
  focusId: focusIdSchema.optional(),
  conversationName: z.string().optional(),
  cwd: z.string(),
  busy: z.boolean(),
  compacting: z.boolean().optional(),
  compactionAttempt: publicCompactionAttemptSchema.optional(),
  activeRun: z.object({
    id: runIdSchema,
    phase: z.enum(["queued", "running", "waiting", "cancelling"]),
  }).strict().optional(),
  selectedModel: z.object({ provider: z.string(), id: z.string() }).optional(),
  selectedServiceTier: serviceTierSchema.nullable(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: toolModeSchema,
  availableThinkingLevels: z.array(thinkingLevelSchema),
  providers: z.array(publicProviderSchema),
  registryError: z.string().optional(),
  sessionTokenUsage: tokenUsageSchema.optional(),
  contextUsage: publicContextUsageSchema.optional(),
  compactionThresholdPercent: z.number().int()
    .min(MIN_COMPACTION_THRESHOLD_PERCENT)
    .max(MAX_COMPACTION_THRESHOLD_PERCENT)
    .optional(),
});
const authRequestSchema: z.ZodType<AuthRequest> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth"), url: z.string(), instructions: z.string().optional() }),
  z.object({
    kind: z.literal("device"),
    userCode: z.string(),
    verificationUri: z.string(),
    expiresInSeconds: z.number().finite().optional(),
  }),
  z.object({
    kind: z.literal("prompt"),
    message: z.string(),
    placeholder: z.string().optional(),
    allowEmpty: z.boolean().optional(),
    secret: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("manual"),
    message: z.string(),
    placeholder: z.string().optional(),
    allowEmpty: z.boolean().optional(),
  }).strict(),
  z.object({
    kind: z.literal("select"),
    message: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
]);
const sessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_queued") }),
  z.object({ type: z.literal("run_started") }),
  z.object({
    type: z.literal("run_finished"),
    outcome: z.enum(["completed", "aborted", "failed"]),
  }),
  z.object({
    type: z.literal("user_message"),
    projectionId: z.string().uuid(),
    text: z.string().max(MAX_PROMPT_CHARACTERS),
  }),
  z.object({
    type: z.literal("assistant_message_started"),
    projectionId: z.string().uuid(),
  }),
  z.object({ type: z.literal("text_delta"), delta: z.string() }),
  z.object({ type: z.literal("text_replaced"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), delta: z.string() }),
  z.object({
    type: z.literal("tool_started"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_prepared"),
    toolCallId: z.string(),
    args: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_updated"),
    toolCallId: z.string(),
    result: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("tool_finished"),
    toolCallId: z.string(),
    result: z.unknown().optional(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal("output_estimate"),
    estimatedOutputTokens: z.number().int().nonnegative(),
    outputElapsedMs: z.number().finite().nonnegative(),
  }),
  z.object({
    type: z.literal("usage"),
    usage: tokenUsageSchema,
    outputElapsedMs: z.number().finite().positive().optional(),
  }),
]);
const commandTypeSchema = z.enum([
  "inspect_workspace_sessions",
  "repair_workspace_sessions",
  "browse_directory",
  "set_color_scheme",
  "save_custom_provider",
  "refresh_custom_providers",
  "delete_custom_provider",
  "probe_custom_provider_models",
  "initialize",
  "focus_conversation",
  "refresh_view",
  "create_conversation",
  "fork_conversation",
  "prompt",
  "steer",
  "withdraw_prompt",
  "abort",
  "extension_ui_response",
  "set_thinking",
  "set_compaction_threshold",
  "set_service_tier",
  "compact_context",
  "switch_conversation_role",
  "rename_conversation",
  "delete_conversation",
  "truncate_conversation",
  "open_image",
  "create_role",
  "update_role",
  "delete_role",
  "set_api_key",
  "login_oauth",
  "logout",
  "auth_response",
  "cancel_auth",
  "refresh_models",
  "close_session",
]);
const roleTemplateSchema: z.ZodType<RoleTemplate> = z.object({
  id: roleIdSchema,
  revision: z.number().int().positive(),
  name: requiredBoundedCharactersString(
    MAX_ROLE_NAME_CHARACTERS,
    "role.name",
  ),
  description: boundedCharactersString(
    MAX_ROLE_DESCRIPTION_CHARACTERS,
    "role.description",
  ),
  systemPrompt: boundedUtf8String(
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
    "role.systemPrompt",
  ),
  model: roleModelSchema.nullable(),
  compactionModel: roleModelSchema.nullable(),
  defaultThinkingLevel: thinkingLevelSchema,
  defaultServiceTier: serviceTierSchema.nullable(),
  toolMode: toolModeSchema,
  canManageSessions: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  available: z.boolean(),
  unavailableReason: z.string()
    .max(MAX_ROLE_UNAVAILABLE_REASON_CHARACTERS)
    .optional(),
});
const conversationRoleSnapshotSchema: z.ZodType<ConversationRoleSnapshot> = z.object({
  id: roleIdSchema,
  revision: z.number().int().positive(),
  name: requiredBoundedCharactersString(
    MAX_ROLE_NAME_CHARACTERS,
    "role.name",
  ),
  description: boundedCharactersString(
    MAX_ROLE_DESCRIPTION_CHARACTERS,
    "role.description",
  ),
  systemPrompt: boundedUtf8String(
    MAX_ROLE_SYSTEM_PROMPT_BYTES,
    "role.systemPrompt",
  ),
  model: roleModelSchema,
  compactionModel: roleModelSchema.nullable(),
  defaultThinkingLevel: thinkingLevelSchema,
  defaultServiceTier: serviceTierSchema.nullable(),
  toolMode: toolModeSchema,
  canManageSessions: z.boolean(),
});
const conversationRoleSummarySchema: z.ZodType<
  Omit<ConversationRoleSnapshot, "systemPrompt">
> = z.object({
  id: roleIdSchema,
  revision: z.number().int().positive(),
  name: requiredBoundedCharactersString(
    MAX_ROLE_NAME_CHARACTERS,
    "role.name",
  ),
  description: boundedCharactersString(
    MAX_ROLE_DESCRIPTION_CHARACTERS,
    "role.description",
  ),
  model: roleModelSchema,
  compactionModel: roleModelSchema.nullable(),
  defaultThinkingLevel: thinkingLevelSchema,
  defaultServiceTier: serviceTierSchema.nullable(),
  toolMode: toolModeSchema,
  canManageSessions: z.boolean(),
});
const conversationActivitySchema: z.ZodType<ConversationActivity> = z.union([
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("queued"), runId: runIdSchema }),
  z.object({ kind: z.literal("running"), runId: runIdSchema }),
  z.object({ kind: z.literal("cancelling"), runId: runIdSchema }),
  z.object({
    kind: z.literal("waiting"),
    runId: runIdSchema,
    targetCount: z.number().int().min(1).max(32),
  }).strict(),
]);
const sessionMessageEndpointSchema: z.ZodType<SessionMessageEndpoint> = z.object({
  conversationId: conversationIdSchema,
  title: boundedCharactersString(
    MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
    "sessionMessageEndpoint.title",
  ).optional(),
  role: z.object({
    id: roleIdSchema,
    name: requiredBoundedCharactersString(
      MAX_ROLE_NAME_CHARACTERS,
      "role.name",
    ),
  }),
});
const conversationImageLocatorSchema: z.ZodType<ConversationImageLocator> =
  z.object({
    messageId: conversationMessageIdSchema,
    imageOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict();
const conversationImageReferenceSchema: z.ZodType<ConversationHistoryImageReference> =
  z.object({
    offset: z.number().int().nonnegative(),
    source: conversationImageLocatorSchema,
  }).strict();
const conversationToolImageReferenceSchema: z.ZodType<ConversationHistoryToolImageReference> =
  z.object({
    contentIndex: z.number().int().nonnegative().max(1_999),
    source: conversationImageLocatorSchema,
  }).strict();
const conversationHistoryMessageSchema = z.object({
  id: z.string(),
  runId: runIdSchema.optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  thinking: z.string(),
  tools: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    resultImageRefs: z.array(conversationToolImageReferenceSchema)
      .max(2_000)
      .optional(),
    status: z.enum(["pending", "running", "done", "error"]),
  })),
  parts: z.array(z.discriminatedUnion("kind", [
    z.object({
      kind: z.enum(["text", "thinking"]),
      offset: z.number().int().nonnegative(),
      length: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal("tool"),
      toolCallId: z.string(),
    }),
  ])).max(200),
  imageRefs: z.array(conversationImageReferenceSchema)
    .max(MAX_PROMPT_IMAGE_COUNT)
    .optional(),
  usage: tokenUsageSchema.optional(),
});
export const conversationBashTaskSchema: z.ZodType<ConversationBashTask> = z.object({
  taskId: z.string().uuid(),
  command: boundedUtf8String(
    MAX_BASH_TASK_COMMAND_BYTES,
    "Bash task command",
  ).refine((value) => value.trim().length > 0, "command must not be blank"),
  status: z.enum(["completed", "failed", "killed"]),
  exitCode: z.number().finite().nullable(),
  durationMs: z.number().finite().nonnegative(),
  stopReason: z.enum([
    "manual",
    "timeout",
    "output_limit",
    "reload",
    "dispose",
  ]).optional(),
  partial: z.boolean().optional(),
  outputFile: boundedUtf8String(
    MAX_BASH_TASK_OUTPUT_FILE_BYTES,
    "Bash task outputFile",
  ).refine((value) => value.trim().length > 0, "outputFile must not be blank")
    .optional(),
}).strict().superRefine((task, context) => {
  if (task.status === "completed") {
    if (task.exitCode !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed Bash tasks require exitCode 0",
        path: ["exitCode"],
      });
    }
    if (task.partial === true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "partial Bash task results cannot be completed",
        path: ["partial"],
      });
    }
    if (task.stopReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed Bash tasks cannot have a stopReason",
        path: ["stopReason"],
      });
    }
  } else if (task.status === "killed") {
    if (task.stopReason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "killed Bash tasks require a stopReason",
        path: ["stopReason"],
      });
    }
  } else if (task.stopReason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bash tasks with a stopReason must be killed",
      path: ["stopReason"],
    });
  }
});

const conversationBashTaskNotificationSchema = z.object({
  kind: z.literal("bash_task_notification"),
  id: z.string().min(1).max(256),
  timestamp: z.string().datetime(),
  text: boundedUtf8String(
    MAX_BASH_TASK_NOTIFICATION_TEXT_BYTES,
    "Bash task notification text",
  ).refine((value) => value.trim().length > 0, "text must not be blank"),
  tasks: z.array(conversationBashTaskSchema)
    .min(1)
    .max(MAX_BASH_TASK_NOTIFICATION_TASKS),
}).strict() satisfies z.ZodType<ConversationBashTaskNotification>;

const conversationHistoryItemSchema: z.ZodType<ConversationHistoryItem> =
  z.discriminatedUnion("kind", [
    conversationHistoryMessageSchema.extend({ kind: z.literal("message") }),
    z.object({
      kind: z.literal("compaction"),
      id: z.string(),
      timestamp: z.string().datetime(),
      tokensBefore: z.number().finite().nonnegative(),
      provenance: conversationCompactionProvenanceSchema.optional(),
    }),
    conversationBashTaskNotificationSchema,
    z.object({
      kind: z.literal("session_message"),
      id: z.string(),
      cardId: z.string().uuid(),
      direction: z.enum(["incoming", "outgoing"]),
      state: z.enum([
        "sending",
        "queued",
        "delivered",
        "running",
        "waiting",
        "completed",
        "failed",
        "aborted",
      ]),
      body: z.string().max(200_000),
      summary: z.string().superRefine((value, context) => {
        if ([...value].length > MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `summary must be at most ${MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS} characters`,
          });
        }
        if (utf8Bytes(value) > MAX_SESSION_MESSAGE_SUMMARY_BYTES) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `summary must be at most ${MAX_SESSION_MESSAGE_SUMMARY_BYTES} UTF-8 bytes`,
          });
        }
      }),
      from: sessionMessageEndpointSchema,
      to: sessionMessageEndpointSchema,
      sentAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageId: z.string().uuid().optional(),
      delegationId: z.string().uuid().optional(),
      runId: runIdSchema.optional(),
      result: z.string().max(200_000).optional(),
      peerPresence: z.enum(["present", "absent", "unknown"]),
    }),
  ]);
const loopListItemSchema = z.object({
  id: boundedCharactersString(
    MAX_LOOP_LIST_ITEM_ID_CHARACTERS,
    "loopList.items.id",
  ).refine((value) => value.trim().length > 0, "item id must not be blank"),
  text: boundedCharactersString(
    MAX_LOOP_LIST_ITEM_TEXT_CHARACTERS,
    "loopList.items.text",
  ).refine((value) => value.trim().length > 0, "item text must not be blank"),
  status: z.enum(["pending", "active", "completed"]),
}).strict();

export const loopListSchema = z.object({
  items: z.array(loopListItemSchema)
    .max(MAX_LOOP_LIST_ITEMS)
    .superRefine((items, context) => {
      const ids = new Set<string>();
      for (let index = 0; index < items.length; index += 1) {
        const id = items[index]!.id;
        if (ids.has(id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "LoopList item IDs must be unique",
            path: [index, "id"],
          });
        }
        ids.add(id);
      }
    }),
  armed: z.boolean(),
}).strict() satisfies z.ZodType<LoopList>;

const conversationWindowCoverageSchema: z.ZodType<ConversationWindowCoverage> = z.object({
  omittedBefore: z.boolean(),
  startsMidTurn: z.boolean(),
  contentTruncated: z.boolean(),
});

const conversationBashActivitySchema: z.ZodType<ConversationBashActivity> =
  z.object({
    running: z.number().int().min(0).max(4),
    stopping: z.number().int().min(0).max(4),
    cleanupUnknown: z.boolean(),
  }).strict().superRefine((activity, context) => {
    if (activity.running + activity.stopping > 8) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bash activity total must be at most 8",
        path: ["stopping"],
      });
    }
  });

const transitionDiagnosticDurationSchema = z.number()
  .finite()
  .int()
  .nonnegative()
  .max(MAX_TRANSITION_DIAGNOSTIC_PHASE_MS);

const transitionDiagnosticsSchema: z.ZodType<TransitionDiagnostics> = z.object({
  version: z.literal(1),
  commandId: commandIdSchema,
  operation: z.enum(["initialize", "focus_conversation"]),
  validationMs: transitionDiagnosticDurationSchema,
  contextOrCatalogMs: transitionDiagnosticDurationSchema,
  presentationOrTargetReadMs: transitionDiagnosticDurationSchema,
  actorActivationOrLeaseMs: transitionDiagnosticDurationSchema,
  snapshotProjectionMs: transitionDiagnosticDurationSchema.nullable(),
}).strict();

const serverEventUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workspace_sessions_inspected"),
    commandId: commandIdSchema,
    cwd: required.max(4096),
    checkedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    issues: z.array(sessionRepairIssueSchema).max(MAX_WORKSPACE_SESSION_REPAIR_FILES),
    truncated: z.boolean(),
    recoveryError: z.string().max(4096).optional(),
  }).strict(),
  z.object({
    type: z.literal("workspace_sessions_repaired"),
    commandId: commandIdSchema,
    cwd: required.max(4096),
    backups: z.array(sessionRepairBackupSchema).max(MAX_WORKSPACE_SESSION_REPAIR_FILES),
    error: z.string().max(4096).optional(),
  }).strict(),
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().nonnegative(),
    startupCwd: z.string(),
    uiPreferences: uiPreferencesSchema,
  }).strict(),
  z.object({
    type: z.literal("ui_preferences_changed"),
    uiPreferences: uiPreferencesSchema,
    commandId: commandIdSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("custom_providers_snapshot"),
    revision: customProviderRevisionSchema,
    providers: z.array(customProviderSnapshotSchema).max(MAX_CUSTOM_PROVIDERS),
    error: z.string().max(20_000).optional(),
    truncated: z.boolean(),
    commandId: commandIdSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("custom_provider_models_probe"),
    commandId: commandIdSchema,
    baseUrl: required.max(4096),
    models: z.array(customProviderProbedModelSchema)
      .max(MAX_CUSTOM_PROVIDER_PROBED_MODELS),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("directory_listing"),
    commandId: commandIdSchema,
    path: required.max(4096),
    parentPath: required.max(4096).nullable(),
    directories: z.array(z.object({
      name: z.string().min(1).max(1024),
      path: required.max(4096),
    })).max(500),
    truncated: z.boolean(),
  }),
  z.object({ type: z.literal("state"), state: publicStateSchema }),
  z.object({
    type: z.literal("focus_attached"),
    operation: z.enum(FOCUS_ATTACHED_OPERATIONS),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    focusId: focusIdSchema.optional(),
    conversationId: conversationIdSchema.optional(),
    transitionDiagnostics: transitionDiagnosticsSchema.optional(),
  }),
  z.object({
    type: z.literal("focus_invalidated"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    reason: z.literal("deleted"),
  }),
  z.object({
    type: z.literal("role_catalog_snapshot"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    roles: z.array(roleTemplateSchema).max(MAX_ROLE_COUNT),
  }),
  z.object({
    type: z.literal("project_snapshot"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema.optional(),
    conversations: z.array(z.object({
      id: conversationIdSchema,
      rootConversationId: conversationIdSchema.optional(),
      name: boundedCharactersString(
        MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
        "conversation.name",
      ).optional(),
      autoTitlePreview: boundedCharactersString(
        MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
        "conversation.autoTitlePreview",
      ).optional(),
      preview: z.string()
        .max(MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageCount: z.number().int().nonnegative(),
      role: conversationRoleSummarySchema.optional(),
      activity: conversationActivitySchema.optional(),
      compacting: z.boolean(),
      attention: z.boolean().optional(),
      unread: z.boolean().optional(),
      createdBy: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("user"),
        }),
        z.object({
          kind: z.literal("conversation"),
          conversationId: conversationIdSchema,
        }),
      ]).optional(),
    })).max(MAX_PROJECT_CONVERSATIONS),
    truncated: z.boolean(),
    coverage: z.enum(["complete", "unknown"]),
  }),
  z.object({
    type: z.literal("project_activity_snapshot"),
    projects: z.array(z.object({
      projectId: z.string().uuid(),
      cwd: required.max(4096),
      busyConversationCount: z.number().int().nonnegative(),
      attentionConversationCount: z.number().int().nonnegative(),
    })).max(MAX_PROJECT_ACTIVITY_SUMMARIES),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("conversation_preview"),
    sessionId: sessionIdSchema,
    commandId: commandIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema,
    cwd: required.max(4096),
    toolMode: toolModeSchema,
    role: conversationRoleSnapshotSchema.optional(),
    items: z.array(conversationHistoryItemSchema),
    window: conversationWindowCoverageSchema,
  }).strict(),
  z.object({
    type: z.literal("prompt_admitted"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    promptId: z.string().uuid(),
    runId: runIdSchema,
    text: required.max(MAX_PROMPT_CHARACTERS),
  }).strict(),
  z.object({
    type: z.literal("prompt_delivered"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    promptId: z.string().uuid(),
    runId: runIdSchema,
  }).strict(),
  z.object({
    type: z.literal("prompt_withdrawn"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    promptId: z.string().uuid(),
    runId: runIdSchema,
    reason: z.enum(["manual", "abort"]),
  }).strict(),
  conversationImageSchema.extend({
    type: z.literal("conversation_image"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    commandId: commandIdSchema,
    messageId: conversationMessageIdSchema,
    imageOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    type: z.literal("conversation_snapshot"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    role: conversationRoleSnapshotSchema.optional(),
    projectionSeq: z.number().int().nonnegative(),
    items: z.array(conversationHistoryItemSchema),
    completedOutputRate: z.object({
      runId: runIdSchema,
      outputTokens: z.number().finite().nonnegative(),
      outputElapsedMs: z.number().finite().positive(),
      tokensPerSecond: z.number().finite().nonnegative(),
    }).strict().optional(),
    bashActivity: conversationBashActivitySchema.nullable().optional(),
    pendingPrompts: z.array(z.object({
      promptId: z.string().uuid(),
      text: required.max(MAX_PROMPT_CHARACTERS),
    }).strict()).max(MAX_PENDING_PROMPTS_PER_CONVERSATION),
    loopList: loopListSchema.optional(),
    window: conversationWindowCoverageSchema,
    transitionDiagnostics: transitionDiagnosticsSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("loop_list_update"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    loopList: loopListSchema,
  }).strict(),
  z.object({
    type: z.literal("bash_activity"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    activity: conversationBashActivitySchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("session_event"),
    sessionId: sessionIdSchema,
    runId: runIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    projectionSeq: z.number().int().nonnegative().optional(),
    event: sessionEventSchema,
  }),
  z.object({
    type: z.literal("conversation_run_settled"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema,
    runId: runIdSchema,
    outcome: z.enum(["completed", "aborted", "failed"]),
    createdBy: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("user"),
      }).strict(),
      z.object({
        kind: z.literal("conversation"),
        conversationId: conversationIdSchema,
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("conversation_item"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    projectionSeq: z.number().int().nonnegative().optional(),
    item: conversationHistoryItemSchema,
  }),
  z.object({
    type: z.literal("extension_ui_request"),
    sessionId: sessionIdSchema,
    requestId: extensionUIRequestIdSchema,
    request: extensionUIRequestSchema,
  }),
  z.object({
    type: z.literal("extension_ui_closed"),
    sessionId: sessionIdSchema,
    requestId: extensionUIRequestIdSchema,
  }),
  z.object({
    type: z.literal("extension_ui_notification"),
    sessionId: sessionIdSchema,
    level: z.enum(["info", "warning", "error"]),
    message: z.string().max(20_000),
  }),
  z.object({
    type: z.literal("auth_request"),
    authFlowId: authFlowIdSchema,
    requestId: z.string(),
    request: authRequestSchema,
  }),
  z.object({ type: z.literal("auth_progress"), authFlowId: authFlowIdSchema, message: z.string() }),
  z.object({ type: z.literal("auth_complete"), authFlowId: authFlowIdSchema, provider: z.string() }),
  z.object({
    type: z.literal("command_complete"),
    operation: z.enum(ACKNOWLEDGED_COMMAND_OPERATIONS),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    scope: z.enum(["auth", "command", "protocol", "session", "settings"]),
    operation: commandTypeSchema.optional(),
    sessionId: sessionIdSchema.optional(),
    runId: runIdSchema.optional(),
    conversationId: conversationIdSchema.optional(),
    focusId: focusIdSchema.optional(),
    authFlowId: authFlowIdSchema.optional(),
    commandId: commandIdSchema.optional(),
  }),
]);

export const serverEventSchema: z.ZodType<ServerEvent> = serverEventUnionSchema.superRefine(
  (event, context) => {
    if (
      (event.type === "conversation_snapshot"
        || event.type === "conversation_preview")
      && event.window.startsMidTurn
      && !event.window.omittedBefore
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${event.type} window startsMidTurn requires omittedBefore`,
        path: ["window", "startsMidTurn"],
      });
    }
    if (
      event.type === "focus_attached"
      && ((event.focusId === undefined) !== (event.conversationId === undefined))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focusId and conversationId must either both be present or both be absent",
        path: ["focusId"],
      });
    }
    if (
      event.type === "focus_attached"
      && event.operation !== "initialize"
      && (event.focusId === undefined || event.conversationId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${event.operation} must attach an exact conversation focus`,
        path: ["focusId"],
      });
    }
    if (event.type === "focus_attached" && event.transitionDiagnostics) {
      const diagnostics = event.transitionDiagnostics;
      if (
        event.operation !== "initialize"
        || event.focusId !== undefined
        || event.conversationId !== undefined
        || diagnostics.operation !== event.operation
        || diagnostics.commandId !== event.commandId
        || diagnostics.snapshotProjectionMs !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "transition diagnostics on focus_attached require the matching empty initialize",
          path: ["transitionDiagnostics"],
        });
      }
    }
    if (
      event.type === "conversation_snapshot"
      && event.transitionDiagnostics?.snapshotProjectionMs === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "conversation snapshot transition diagnostics require a projection duration",
        path: ["transitionDiagnostics", "snapshotProjectionMs"],
      });
    }
    if (event.type === "state") {
      const state = event.state;
      const hasFocus = state.focusId !== undefined && state.conversationId !== undefined;
      if ((state.focusId === undefined) !== (state.conversationId === undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "state focusId and conversationId must either both be present or both be absent",
          path: ["state", "focusId"],
        });
      }
      if (state.busy !== (state.activeRun !== undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "state busy must exactly match activeRun presence",
          path: ["state", "activeRun"],
        });
      }
      if (state.activeRun !== undefined && !hasFocus) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "state activeRun requires a complete conversation focus",
          path: ["state", "activeRun"],
        });
      }
      if (
        !hasFocus
        && (
          state.conversationName !== undefined
          || state.selectedModel !== undefined
          || state.compacting !== undefined
          || state.compactionAttempt !== undefined
          || state.sessionTokenUsage !== undefined
          || state.contextUsage !== undefined
          || state.compactionThresholdPercent !== undefined
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "state actor-scoped fields require a complete conversation focus",
          path: ["state", "conversationId"],
        });
      }
      if (state.compactionAttempt !== undefined && state.compacting !== true) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "state compactionAttempt requires compacting",
          path: ["state", "compactionAttempt"],
        });
      }
    }
    if (
      event.type === "error"
      && (
        (event.focusId === undefined)
        !== (event.conversationId === undefined)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "error focusId and conversationId must either both be present or both be absent",
        path: ["focusId"],
      });
    }
    if (
      event.type === "error"
      && event.scope === "command"
      && (event.operation === "prompt" || event.operation === "abort")
      && (
        event.sessionId === undefined
        || event.runId === undefined
        || event.conversationId === undefined
        || event.focusId === undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `${event.operation} command errors require the complete run focus identity`,
        path: ["focusId"],
      });
    }
    if (
      event.type === "error"
      && event.scope === "command"
      && (event.operation === "steer" || event.operation === "withdraw_prompt")
      && (
        event.sessionId === undefined
        || event.commandId === undefined
        || event.runId === undefined
        || event.conversationId === undefined
        || event.focusId === undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${event.operation} command errors require the complete command and run focus identity`,
        path: ["focusId"],
      });
    }
    if (
      event.type === "error"
      && event.scope === "command"
      && (
        event.operation === "set_service_tier"
        || event.operation === "open_image"
      )
      && (
        event.sessionId === undefined
        || event.commandId === undefined
        || event.conversationId === undefined
        || event.focusId === undefined
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Service tier command errors require the complete command focus identity",
        path: ["focusId"],
      });
    }
    if (
      event.type === "error"
      && event.commandId
      && (
        event.operation === "steer"
        || event.operation === "withdraw_prompt"
        || event.operation === "set_api_key"
        || event.operation === "refresh_models"
        || event.operation === "rename_conversation"
        || event.operation === "delete_conversation"
        || event.operation === "truncate_conversation"
        || event.operation === "open_image"
      )
      && !event.sessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Acknowledged command errors require a sessionId",
        path: ["sessionId"],
      });
    }
    if (
      event.type === "error"
      && event.operation === "rename_conversation"
      && (event.sessionId === undefined || event.commandId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rename command errors require a sessionId and commandId",
        path: [event.sessionId === undefined ? "sessionId" : "commandId"],
      });
    }
  },
);

function parseMessage(input: unknown, maximumBytes: number): unknown {
  if (typeof input !== "string") return input;
  if (utf8Bytes(input) > maximumBytes) throw new Error("Message is too large");
  return JSON.parse(input);
}

export function parseClientCommand(input: unknown): ClientCommand {
  return clientCommandSchema.parse(parseMessage(input, MAX_MESSAGE_BYTES));
}

export function parseServerEvent(input: unknown): ServerEvent {
  return serverEventSchema.parse(parseMessage(input, MAX_SERVER_EVENT_BYTES));
}
