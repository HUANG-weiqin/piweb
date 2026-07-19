import { z } from "zod";

export const MAX_MESSAGE_BYTES = 1_000_000;
export const MAX_SERVER_EVENT_BYTES = 64 * 1024 * 1024;
export const MAX_ROLE_COUNT = 64;
export const MAX_ROLE_NAME_CHARACTERS = 80;
export const MAX_ROLE_DESCRIPTION_CHARACTERS = 1_000;
export const MAX_ROLE_SYSTEM_PROMPT_BYTES = 128 * 1024;
export const MAX_PROJECT_CONVERSATIONS = 100;
export const MAX_PROJECT_CONVERSATION_NAME_CHARACTERS = 120;
export const MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS = 500;
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;
export const MIN_COMPACTION_THRESHOLD_PERCENT = 20;
export const MAX_COMPACTION_THRESHOLD_PERCENT = 90;
export const PROTOCOL_VERSION = 14;
const required = z.string().trim().min(1);
const sessionIdSchema = z.string().uuid();
const conversationIdSchema = z.string().uuid();
const runIdSchema = z.string().uuid();
const focusIdSchema = z.string().uuid();
const authFlowIdSchema = z.string().uuid();
const extensionUIRequestIdSchema = z.string().uuid();
const commandIdSchema = z.string().uuid();
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
  provider: required.max(200),
  id: required.max(500),
});
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

export const extensionUIResponseSchema = z.discriminatedUnion("kind", [
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
    type: z.literal("initialize"),
    commandId: commandIdSchema.optional(),
    sessionId: sessionIdSchema,
    cwd: required.max(4096),
    toolMode: z.enum(["read_only", "full_access"]).optional(),
    conversation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("recent") }),
      z.object({
        kind: z.literal("new"),
        roleId: roleIdSchema.optional(),
      }),
      z.object({ kind: z.literal("open"), conversationId: conversationIdSchema }),
    ]).optional(),
  }),
  z.object({
    type: z.literal("focus_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
  }),
  z.object({
    type: z.literal("create_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    roleId: roleIdSchema,
    title: required.max(120).optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: commandIdSchema,
    runId: runIdSchema,
    text: required.max(200_000),
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
    type: z.literal("select_model"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    provider: required,
    modelId: required,
  }),
  z.object({
    type: z.literal("set_thinking"),
    sessionId: sessionIdSchema,
    level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
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
    type: z.literal("set_tool_mode"),
    sessionId: sessionIdSchema,
    mode: z.enum(["read_only", "full_access"]),
  }),
  z.object({
    type: z.literal("rename_conversation"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    name: required.max(120),
  }),
  z.object({
    type: z.literal("delete_conversation"),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
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
  z.object({ type: z.literal("refresh_models") }),
  z.object({ type: z.literal("close_session"), sessionId: sessionIdSchema }),
]);

export const clientCommandSchema = clientCommandUnionSchema.superRefine(
  (command, context) => {
    if (command.type === "initialize" && command.commandId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "initialize requires an exact commandId",
        path: ["commandId"],
      });
    }
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
  },
);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type AcknowledgedSettingOperation = "select_model" | "set_api_key";
export type AcknowledgedCommandOperation =
  | AcknowledgedSettingOperation
  | "set_compaction_threshold"
  | "delete_conversation"
  | "create_role"
  | "update_role"
  | "delete_role";
export type ThinkingLevel = Extract<ClientCommand, { type: "set_thinking" }>["level"];
export type ToolMode = Extract<ClientCommand, { type: "set_tool_mode" }>["mode"];

export interface PublicModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
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

export interface PublicState {
  sessionId: string;
  projectId: string;
  conversationId?: string;
  focusId?: string;
  conversationName?: string;
  cwd: string;
  busy: boolean;
  activeRun?: {
    id: string;
    phase: "queued" | "running" | "waiting" | "cancelling";
    waitingFor?: {
      conversationId: string;
      runId: string;
    };
  };
  selectedModel?: { provider: string; id: string };
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
  | { kind: "prompt" | "manual"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: "select"; message: string; options: Array<{ id: string; label: string }> };

export interface ConversationHistoryTool {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  status: "done" | "error";
}

export interface ConversationHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  tools: ConversationHistoryTool[];
  usage?: TokenUsage;
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
  canManageSessions: boolean;
}

export type ConversationActivity =
  | { kind: "idle" }
  | { kind: "queued" | "running" | "cancelling"; runId: string }
  | {
      kind: "waiting";
      runId: string;
      targetConversationId: string;
      targetRunId: string;
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
  peerExists?: boolean;
}

export interface ConversationCompactionMarker {
  kind: "compaction";
  id: string;
  timestamp: string;
  tokensBefore: number;
}

export type ConversationHistoryItem =
  | ({ kind: "message" } & ConversationHistoryMessage)
  | ConversationCompactionMarker
  | ConversationMessageCard;

export type ConversationCreatedBy =
  | { kind: "user" }
  | { kind: "conversation"; conversationId: string };

export interface ConversationSummary {
  id: string;
  name?: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  role?: Omit<ConversationRoleSnapshot, "systemPrompt">;
  activity?: ConversationActivity;
  attention?: boolean;
  unread?: boolean;
  temporary?: boolean;
  createdBy?: ConversationCreatedBy;
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
  | { type: "text_delta"; delta: string }
  | { type: "text_replaced"; text: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_started"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_prepared"; toolCallId: string; args?: unknown }
  | { type: "tool_updated"; toolCallId: string; result?: unknown }
  | { type: "tool_finished"; toolCallId: string; result?: unknown; isError: boolean }
  | { type: "usage"; usage: TokenUsage };

export type ErrorScope = "auth" | "command" | "protocol" | "session" | "settings";

export type ServerEvent =
  | { type: "hello"; protocolVersion: number; startupCwd: string }
  | ({ type: "directory_listing"; commandId: string } & DirectoryListing)
  | { type: "state"; state: PublicState }
  | {
      type: "focus_attached";
      operation: "initialize" | "focus_conversation" | "create_conversation";
      commandId: string;
      sessionId: string;
      projectId: string;
      focusId?: string;
      conversationId?: string;
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
    }
  | {
      type: "conversation_snapshot";
      sessionId: string;
      conversationId: string;
      focusId: string;
      role?: ConversationRoleSnapshot;
      messages?: ConversationHistoryMessage[];
      items?: ConversationHistoryItem[];
      truncated: boolean;
    }
  | {
      type: "session_event";
      sessionId: string;
      runId: string;
      conversationId: string;
      focusId: string;
      event: SessionEvent;
    }
  | {
      type: "conversation_item";
      sessionId: string;
      conversationId: string;
      focusId: string;
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

const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
const publicStateSchema: z.ZodType<PublicState> = z.object({
  sessionId: sessionIdSchema,
  projectId: z.string().uuid(),
  conversationId: conversationIdSchema.optional(),
  focusId: focusIdSchema.optional(),
  conversationName: z.string().optional(),
  cwd: z.string(),
  busy: z.boolean(),
  activeRun: z.object({
    id: runIdSchema,
    phase: z.enum(["queued", "running", "waiting", "cancelling"]),
    waitingFor: z.object({
      conversationId: conversationIdSchema,
      runId: runIdSchema,
    }).optional(),
  }).optional(),
  selectedModel: z.object({ provider: z.string(), id: z.string() }).optional(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: z.enum(["read_only", "full_access"]),
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
  }),
  z.object({
    kind: z.literal("manual"),
    message: z.string(),
    placeholder: z.string().optional(),
    allowEmpty: z.boolean().optional(),
  }),
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
  z.object({ type: z.literal("usage"), usage: tokenUsageSchema }),
]);
const commandTypeSchema = z.enum([
  "browse_directory",
  "initialize",
  "focus_conversation",
  "create_conversation",
  "prompt",
  "abort",
  "extension_ui_response",
  "select_model",
  "set_thinking",
  "set_compaction_threshold",
  "set_tool_mode",
  "rename_conversation",
  "delete_conversation",
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
  canManageSessions: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  available: z.boolean(),
  unavailableReason: z.string().max(2_000).optional(),
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
  canManageSessions: z.boolean(),
});
const conversationActivitySchema: z.ZodType<ConversationActivity> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("idle") }),
    z.object({ kind: z.literal("queued"), runId: runIdSchema }),
    z.object({ kind: z.literal("running"), runId: runIdSchema }),
    z.object({ kind: z.literal("cancelling"), runId: runIdSchema }),
    z.object({
      kind: z.literal("waiting"),
      runId: runIdSchema,
      targetConversationId: conversationIdSchema,
      targetRunId: runIdSchema,
    }),
  ],
);
const sessionMessageEndpointSchema: z.ZodType<SessionMessageEndpoint> = z.object({
  conversationId: conversationIdSchema,
  title: z.string().max(120).optional(),
  role: z.object({
    id: roleIdSchema,
    name: requiredBoundedCharactersString(
      MAX_ROLE_NAME_CHARACTERS,
      "role.name",
    ),
  }),
});
const conversationHistoryMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  thinking: z.string(),
  tools: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    status: z.enum(["done", "error"]),
  })),
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
      from: sessionMessageEndpointSchema,
      to: sessionMessageEndpointSchema,
      sentAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageId: z.string().uuid().optional(),
      delegationId: z.string().uuid().optional(),
      runId: runIdSchema.optional(),
      result: z.string().max(200_000).optional(),
      peerExists: z.boolean(),
    }),
  ]);
const serverEventUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().nonnegative(),
    startupCwd: z.string(),
  }),
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
    operation: z.enum(["initialize", "focus_conversation", "create_conversation"]),
    commandId: commandIdSchema,
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    focusId: focusIdSchema.optional(),
    conversationId: conversationIdSchema.optional(),
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
      name: z.string()
        .max(MAX_PROJECT_CONVERSATION_NAME_CHARACTERS)
        .optional(),
      preview: z.string()
        .max(MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageCount: z.number().int().nonnegative(),
      role: conversationRoleSummarySchema.optional(),
      activity: conversationActivitySchema.optional(),
      attention: z.boolean().optional(),
      unread: z.boolean().optional(),
      temporary: z.boolean().optional(),
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
  }),
  z.object({
    type: z.literal("conversation_snapshot"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    role: conversationRoleSnapshotSchema.optional(),
    messages: z.array(conversationHistoryMessageSchema).optional(),
    items: z.array(conversationHistoryItemSchema).optional(),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("session_event"),
    sessionId: sessionIdSchema,
    runId: runIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
    event: sessionEventSchema,
  }),
  z.object({
    type: z.literal("conversation_item"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    focusId: focusIdSchema,
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
    operation: z.enum([
      "select_model",
      "set_api_key",
      "set_compaction_threshold",
      "delete_conversation",
      "create_role",
      "update_role",
      "delete_role",
    ]),
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
      event.type === "conversation_snapshot"
      && (
        (event.messages === undefined)
        === (event.items === undefined)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "conversation_snapshot requires exactly one of messages or items",
        path: ["items"],
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
    if (
      event.type === "state"
      && (
        (event.state.focusId === undefined)
        !== (event.state.conversationId === undefined)
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "state focusId and conversationId must either both be present or both be absent",
        path: ["state", "focusId"],
      });
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
      && event.commandId
      && (
        event.operation === "select_model"
        || event.operation === "set_api_key"
        || event.operation === "delete_conversation"
      )
      && !event.sessionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Setting command errors require a sessionId",
        path: ["sessionId"],
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
