import { z } from "zod";

export const MAX_MESSAGE_BYTES = 1_000_000;
export const MAX_SERVER_EVENT_BYTES = 64 * 1024 * 1024;
export const MAX_ROLE_COUNT = 64;
export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;
export const MAX_MODEL_REFERENCE_BYTES = 1024;
const MAX_ROLE_UNAVAILABLE_REASON_CHARACTERS = 4096;
export const MAX_PROJECT_CONVERSATIONS = 100;
export const MAX_PROJECT_ACTIVITY_SUMMARIES = 100;
export const MAX_PROJECT_CONVERSATION_NAME_CHARACTERS = 24;
export const MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS = 500;
/** 用户可见的跨会话消息摘要：有界载荷，但可写成短段落。 */
export const MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS = 500;
export const MAX_SESSION_MESSAGE_SUMMARY_BYTES = 2 * 1024;
export const MAX_PROMPT_CHARACTERS = 200_000;
/** 每条浏览器 prompt 最多携带四张小型本地图片，合计解码后不超过 512 KiB。 */
export const MAX_PROMPT_IMAGE_COUNT = 4;
export const MAX_PROMPT_IMAGE_BYTES = 512 * 1024;
/** One-shot durable image responses are bounded independently from prompt uploads. */
export const MAX_CONVERSATION_IMAGE_DATA_CHARACTERS = 5 * 1024 * 1024;
/** Durable history renders image input as this marker; image bytes stay out of snapshots. */
export const PROMPT_IMAGE_PLACEHOLDER = "[图片]";
export const MAX_PENDING_PROMPTS_PER_CONVERSATION = 64;
export const MAX_LOOP_LIST_ITEMS = 100;
export const MAX_LOOP_LIST_ITEM_ID_CHARACTERS = 128;
export const MAX_LOOP_LIST_ITEM_TEXT_CHARACTERS = 512;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;
export const MIN_COMPACTION_THRESHOLD_PERCENT = 20;
export const MAX_COMPACTION_THRESHOLD_PERCENT = 90;
export const MAX_TRANSITION_DIAGNOSTIC_PHASE_MS = 60 * 60 * 1_000;
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
// v59: idle current-leaf fork copies LLM-effective context into a fresh host
// lifecycle via `fork_conversation`; history anchors stay unsupported.
export const PROTOCOL_VERSION = 59;
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
  Math.ceil(MAX_PROMPT_IMAGE_BYTES / 3) * 4;
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
function imagePayloadSchema(maximumDataCharacters: number) {
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
      }
    }),
  }).strict();
}

const promptImageSchema = imagePayloadSchema(MAX_PROMPT_IMAGE_DATA_CHARACTERS);
const conversationImageSchema = imagePayloadSchema(
  MAX_CONVERSATION_IMAGE_DATA_CHARACTERS,
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

const clientCommandUnionSchema = z.discriminatedUnion("type", [
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

export type ConversationHistoryItem =
  | ({ kind: "message" } & ConversationHistoryMessage)
  | ConversationCompactionMarker
  | ConversationMessageCard;

export interface ConversationWindowCoverage {
  omittedBefore: boolean;
  startsMidTurn: boolean;
  contentTruncated: boolean;
}

type ConversationCreatedBy =
  | { kind: "user" }
  | { kind: "conversation"; conversationId: string };

export interface ConversationSummary {
  id: string;
  rootConversationId?: string;
  name?: string;
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
  | { type: "output_estimate"; estimatedOutputTokens: number }
  | { type: "usage"; usage: TokenUsage };

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
      truncated: boolean;
      coverage: ProjectSnapshotCoverage;
    }
  | {
      type: "project_activity_snapshot";
      projects: ProjectActivitySummary[];
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
  }),
  z.object({ type: z.literal("usage"), usage: tokenUsageSchema }),
]);
const commandTypeSchema = z.enum([
  "browse_directory",
  "set_color_scheme",
  "initialize",
  "focus_conversation",
  "refresh_view",
  "create_conversation",
  "fork_conversation",
  "prompt",
  "steer",
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
      && event.operation === "steer"
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
        message: "steer command errors require the complete command and run focus identity",
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
