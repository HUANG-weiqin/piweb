import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversation-meta.js";

export interface MetaToolSessionRef {
  conversationId: string;
  runId?: string;
}

export type MetaToolSessionScope = "all" | "created_by_me";

export interface MetaToolService {
  listRoles(sourceConversationId: string): Promise<unknown>;
  listSessions(
    sourceConversationId: string,
    input: {
      limit: number;
      cursor?: string;
      scope?: MetaToolSessionScope;
    },
  ): Promise<unknown>;
  currentSession(sourceConversationId: string): Promise<unknown>;
  peekSession(
    sourceConversationId: string,
    input: { conversationId: string; limit: number },
  ): Promise<unknown>;
  startSession(
    sourceConversationId: string,
    input: {
      roleId: string;
      task: string;
      title?: string;
      temporary: boolean;
      idempotencyKey: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  sendSessionMessage(
    sourceConversationId: string,
    input: {
      conversationId: string;
      message: string;
      idempotencyKey: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  waitForSession(
    sourceConversationId: string,
    input: MetaToolSessionRef,
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  abortSession(
    sourceConversationId: string,
    input: Required<MetaToolSessionRef> & { idempotencyKey: string },
  ): Promise<unknown>;
  deleteSession(
    sourceConversationId: string,
    input: { conversationId: string; idempotencyKey: string },
  ): Promise<unknown>;
}

function result(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(value),
    }],
    details: value,
  };
}

function sideEffectKey(sourceConversationId: string, toolCallId: string): string {
  return `${sourceConversationId.length}:${sourceConversationId}:${toolCallId}`;
}

function assertConversationBody(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_CONVERSATION_BODY_BYTES) {
    throw new Error(
      `${field} exceeds ${MAX_CONVERSATION_BODY_BYTES} UTF-8 bytes`,
    );
  }
}

export function createMetaTools(
  sourceConversationId: string,
  service: MetaToolService,
  canManageSessions = true,
): ToolDefinition[] {
  if (!canManageSessions) return [];
  return [
    defineTool({
      name: "list_roles",
      label: "List roles",
      description:
        "List the project workbench roles that may be selected when starting another session, including their fixed model and availability.",
      promptSnippet: "List reusable workbench Agent roles.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return result(await service.listRoles(sourceConversationId));
      },
    }),
    defineTool({
      name: "list_sessions",
      label: "List sessions",
      description:
        "List flat project sessions with stable handles, titles, roles, creator identity, createdByMe, last activity, attention, and exact active run identities. The current session is marked as self. Use scope=created_by_me to list only sessions started by this Agent.",
      promptSnippet: "Inspect all project session metadata.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ maxLength: 512 })),
        scope: Type.Optional(Type.Union([
          Type.Literal("all"),
          Type.Literal("created_by_me"),
        ])),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        return result(await service.listSessions(sourceConversationId, {
          limit: input.limit ?? 50,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
        }));
      },
    }),
    defineTool({
      name: "current_session",
      label: "Current session",
      description:
        "Return this Agent's own session handle, frozen role/model, title, activity, and active run identity.",
      promptSnippet: "Inspect this Agent's own session identity.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return result(await service.currentSession(sourceConversationId));
      },
    }),
    defineTool({
      name: "peek_session",
      label: "Peek session",
      description:
        "Read a bounded tail of user-visible messages and workbench session-message cards from another project session without changing its activity or focus.",
      promptSnippet: "Read the recent visible items of a project session.",
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        return result(await service.peekSession(sourceConversationId, {
          conversationId: input.conversationId,
          limit: input.limit ?? 6,
        }));
      },
    }),
    defineTool({
      name: "start_session",
      label: "Start session",
      description:
        "Start a flat peer Agent session with a selected role and initial task. Returns as soon as the request is durably accepted and scheduled; another run may already own the target, and this operation never waits for completion. Set temporary only when a successful initial result should be returned and the target then deleted automatically.",
      promptSnippet: "Start another Agent session without blocking this run.",
      promptGuidelines: [
        "Before starting a normal session, first call list_sessions with scope=created_by_me. Reuse a suitable existing session with send_session_message, and create a new normal session only when none fits the responsibility.",
        "After start_session, choose explicitly whether to keep working, call wait_for_session, or finish and receive a later session message.",
      ],
      parameters: Type.Object({
        roleId: Type.String({ minLength: 1, maxLength: 128 }),
        task: Type.String({
          minLength: 1,
          maxLength: MAX_CONVERSATION_BODY_BYTES,
        }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        temporary: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      async execute(toolCallId, input, signal) {
        assertConversationBody(input.task, "task");
        return result(await service.startSession(sourceConversationId, {
          roleId: input.roleId,
          task: input.task,
          ...(input.title === undefined ? {} : { title: input.title }),
          temporary: input.temporary ?? false,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "send_session_message",
      label: "Send session message",
      description:
        "Durably send a first-class session message to a peer. A busy target normally processes it after its current run settles. If that peer is waiting for this exact run, the message resolves that wait immediately while this run may continue.",
      promptSnippet: "Send a durable message to another Agent session.",
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        message: Type.String({
          minLength: 1,
          maxLength: MAX_CONVERSATION_BODY_BYTES,
        }),
      }, { additionalProperties: false }),
      async execute(toolCallId, input, signal) {
        assertConversationBody(input.message, "message");
        return result(await service.sendSessionMessage(sourceConversationId, {
          conversationId: input.conversationId,
          message: input.message,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "wait_for_session",
      label: "Wait for session",
      description:
        "Explicitly wait for the next relevant event from one exact target conversationId and runId. Returns either that run's durable settlement or message metadata while the message itself is injected into the current turn; call again if a message arrives but final settlement is still required. Cyclic conversation waits are rejected.",
      promptSnippet: "Wait for one exact peer run when its result is required now.",
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        runId: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input, signal) {
        return result(await service.waitForSession(
          sourceConversationId,
          input,
          signal,
        ));
      },
    }),
    defineTool({
      name: "abort_session",
      label: "Abort session",
      description:
        "Abort one exact peer run. A stale or incorrect runId never aborts a later run.",
      promptSnippet: "Abort one exact peer Agent run.",
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        runId: Type.String({ minLength: 1, maxLength: 200 }),
      }, { additionalProperties: false }),
      async execute(toolCallId, input) {
        return result(await service.abortSession(sourceConversationId, {
          ...input,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }));
      },
    }),
    defineTool({
      name: "delete_session",
      label: "Delete session",
      description:
        "Delete an idle peer session. This tool can never delete its own session and never implicitly aborts a busy target.",
      promptSnippet: "Delete an idle peer Agent session other than this one.",
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
      }, { additionalProperties: false }),
      async execute(toolCallId, input) {
        return result(await service.deleteSession(sourceConversationId, {
          conversationId: input.conversationId,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }));
      },
    }),
  ];
}
