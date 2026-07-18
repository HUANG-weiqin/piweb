import { z } from "zod";

export const MAX_MESSAGE_BYTES = 1_000_000;
export const PROTOCOL_VERSION = 5;
const required = z.string().trim().min(1);
const sessionIdSchema = z.string().uuid();
const conversationIdSchema = z.string().uuid();
const runIdSchema = z.string().uuid();
const authFlowIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const extensionUIRequestIdSchema = z.string().uuid();
const commandIdSchema = z.string().uuid();

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

export const clientCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("initialize"),
    sessionId: sessionIdSchema,
    cwd: required.max(4096),
    toolMode: z.enum(["read_only", "workspace_write"]).optional(),
    conversation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("recent") }),
      z.object({ kind: z.literal("new") }),
      z.object({ kind: z.literal("open"), conversationId: conversationIdSchema }),
    ]).optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    sessionId: sessionIdSchema,
    runId: runIdSchema,
    text: required.max(200_000),
  }),
  z.object({ type: z.literal("abort"), sessionId: sessionIdSchema, runId: runIdSchema }),
  z.object({
    type: z.literal("tool_approval_response"),
    sessionId: sessionIdSchema,
    runId: runIdSchema,
    approvalId: approvalIdSchema,
    decision: z.enum(["allow", "deny"]),
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
    type: z.literal("set_tool_mode"),
    sessionId: sessionIdSchema,
    mode: z.enum(["read_only", "workspace_write"]),
  }),
  z.object({
    type: z.literal("rename_conversation"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    name: required.max(120),
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

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type AcknowledgedSettingOperation = "select_model" | "set_api_key";
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
  conversationId: string;
  conversationName?: string;
  cwd: string;
  busy: boolean;
  activeRun?: {
    id: string;
    phase: "queued" | "running" | "cancelling";
    pendingApprovals: ToolApprovalRequest[];
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
}

export type AuthRequest =
  | { kind: "auth"; url: string; instructions?: string }
  | { kind: "device"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: "prompt" | "manual"; message: string; placeholder?: string; allowEmpty?: boolean }
  | { kind: "select"; message: string; options: Array<{ id: string; label: string }> };

export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  reason?: string;
}

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

export interface ConversationSummary {
  id: string;
  name?: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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
  | { type: "state"; state: PublicState }
  | {
      type: "project_snapshot";
      sessionId: string;
      projectId: string;
      conversationId: string;
      conversations: ConversationSummary[];
      truncated: boolean;
    }
  | {
      type: "conversation_snapshot";
      sessionId: string;
      conversationId: string;
      messages: ConversationHistoryMessage[];
      truncated: boolean;
    }
  | { type: "session_event"; sessionId: string; runId: string; event: SessionEvent }
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
      operation: AcknowledgedSettingOperation;
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
  conversationId: conversationIdSchema,
  conversationName: z.string().optional(),
  cwd: z.string(),
  busy: z.boolean(),
  activeRun: z.object({
    id: runIdSchema,
    phase: z.enum(["queued", "running", "cancelling"]),
    pendingApprovals: z.array(z.object({
      approvalId: approvalIdSchema,
      toolCallId: z.string(),
      toolName: z.string(),
      args: z.unknown().optional(),
      reason: z.string().optional(),
    })),
  }).optional(),
  selectedModel: z.object({ provider: z.string(), id: z.string() }).optional(),
  thinkingLevel: thinkingLevelSchema,
  toolMode: z.enum(["read_only", "workspace_write"]),
  availableThinkingLevels: z.array(thinkingLevelSchema),
  providers: z.array(publicProviderSchema),
  registryError: z.string().optional(),
  sessionTokenUsage: tokenUsageSchema.optional(),
  contextUsage: publicContextUsageSchema.optional(),
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
  "initialize",
  "prompt",
  "abort",
  "tool_approval_response",
  "extension_ui_response",
  "select_model",
  "set_thinking",
  "set_tool_mode",
  "rename_conversation",
  "set_api_key",
  "login_oauth",
  "logout",
  "auth_response",
  "cancel_auth",
  "refresh_models",
  "close_session",
]);
const serverEventUnionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number().int().nonnegative(),
    startupCwd: z.string(),
  }),
  z.object({ type: z.literal("state"), state: publicStateSchema }),
  z.object({
    type: z.literal("project_snapshot"),
    sessionId: sessionIdSchema,
    projectId: z.string().uuid(),
    conversationId: conversationIdSchema,
    conversations: z.array(z.object({
      id: conversationIdSchema,
      name: z.string().optional(),
      preview: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      messageCount: z.number().int().nonnegative(),
    })),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("conversation_snapshot"),
    sessionId: sessionIdSchema,
    conversationId: conversationIdSchema,
    messages: z.array(z.object({
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
    })),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("session_event"),
    sessionId: sessionIdSchema,
    runId: runIdSchema,
    event: sessionEventSchema,
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
    operation: z.enum(["select_model", "set_api_key"]),
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
    authFlowId: authFlowIdSchema.optional(),
    commandId: commandIdSchema.optional(),
  }),
]);

export const serverEventSchema: z.ZodType<ServerEvent> = serverEventUnionSchema.superRefine(
  (event, context) => {
    if (
      event.type === "error"
      && event.commandId
      && (event.operation === "select_model" || event.operation === "set_api_key")
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

function parseMessage(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (new TextEncoder().encode(input).byteLength > MAX_MESSAGE_BYTES) throw new Error("Message is too large");
  return JSON.parse(input);
}

export function parseClientCommand(input: unknown): ClientCommand {
  return clientCommandSchema.parse(parseMessage(input));
}

export function parseServerEvent(input: unknown): ServerEvent {
  return serverEventSchema.parse(parseMessage(input));
}
