import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversation-meta.js";
import { MAX_ROLE_SYSTEM_PROMPT_BYTES } from "./role-store.js";

export interface MetaToolSessionRef {
  conversationId: string;
  runId?: string;
}

export type MetaToolSessionScope = "all" | "created_by_me";

export interface MetaToolService {
  listRoles(sourceConversationId: string): Promise<unknown>;
  readRole(
    sourceConversationId: string,
    input: { roleId: string },
  ): Promise<unknown>;
  proposeRoleRevision(
    sourceConversationId: string,
    input: {
      roleId: string;
      expectedRevision: number;
      newSystemPrompt: string;
      reason: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
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

function assertRoleSystemPrompt(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_ROLE_SYSTEM_PROMPT_BYTES) {
    throw new Error(
      `${field} exceeds ${MAX_ROLE_SYSTEM_PROMPT_BYTES} UTF-8 bytes`,
    );
  }
}

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function assertCanonicalRunId(runId: string): void {
  if (!CANONICAL_UUID_PATTERN.test(runId)) {
    throw new Error("runId must be a canonical UUID");
  }
}

function normalizeSessionScope(scope: string | undefined): MetaToolSessionScope | undefined {
  if (scope === undefined || scope === "all" || scope === "created_by_me") {
    return scope;
  }
  throw new Error("Invalid list_sessions scope");
}

const startSessionParameters = Type.Object({
  roleId: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({
    minLength: 1,
    maxLength: MAX_CONVERSATION_BODY_BYTES,
  }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });

const roleIdParameters = Type.Object({
  roleId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

const proposeRoleRevisionParameters = Type.Object({
  roleId: Type.String({ minLength: 1, maxLength: 128 }),
  expectedRevision: Type.Integer({ minimum: 1 }),
  newSystemPrompt: Type.String({
    maxLength: MAX_ROLE_SYSTEM_PROMPT_BYTES,
  }),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

export function createMetaTools(
  sourceConversationId: string,
  service: MetaToolService,
  canManageSessions = true,
): ToolDefinition[] {
  const roleTools = [
    defineTool({
      name: "list_roles",
      label: "List roles",
      description:
        "List all project workbench roles, including each role's revision, fixed model, and availability. Read the target role before proposing a revision.",
      promptSnippet: "List reusable workbench Agent roles and their revisions.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return result(await service.listRoles(sourceConversationId));
      },
    }),
    defineTool({
      name: "read_role",
      label: "Read role",
      description:
        "Read any existing role's complete current definition, including its full system prompt and revision. Use this before proposing a replacement.",
      promptSnippet: "Read one complete workbench Agent role.",
      parameters: roleIdParameters,
      async execute(_toolCallId, input) {
        return result(await service.readRole(sourceConversationId, input));
      },
    }),
    defineTool({
      name: "propose_role_revision",
      label: "Propose role revision",
      description:
        "After the user explicitly asks to change a role, open the human editor with a complete replacement system prompt. The user may cancel; existing conversations keep their role snapshot, and no field other than systemPrompt may change.",
      promptSnippet: "Ask the user to review a complete replacement for a role system prompt.",
      promptGuidelines: [
        "Only call this after the user explicitly requests the role change; the user can cancel the editor.",
        "First call read_role, then pass the complete replacement system prompt rather than a patch or diff.",
        "The proposal can target your own role or another role, including default. Existing conversations are not retroactively changed; only new conversations use the new revision.",
        "Do not attempt to change the role name, description, model, thinking level, tool mode, or session-management permission.",
      ],
      parameters: proposeRoleRevisionParameters,
      async execute(_toolCallId, input, signal) {
        assertRoleSystemPrompt(input.newSystemPrompt, "newSystemPrompt");
        return result(await service.proposeRoleRevision(
          sourceConversationId,
          input,
          signal,
        ));
      },
    }),
  ];
  if (!canManageSessions) return roleTools;
  return [
    ...roleTools,
    defineTool({
      name: "list_sessions",
      label: "List sessions",
      description:
        "List flat project sessions with stable handles, titles, roles, creator identity, createdByMe, last activity, attention, and exact active run identities. The current session is marked as self. Use scope=created_by_me to list only sessions started by this Agent.",
      promptSnippet: "Inspect all project session metadata.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        cursor: Type.Optional(Type.String({ maxLength: 512 })),
        scope: Type.Optional(Type.String({ enum: ["all", "created_by_me"] })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        const scope = normalizeSessionScope(input.scope);
        return result(await service.listSessions(sourceConversationId, {
          limit: input.limit ?? 50,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(scope === undefined ? {} : { scope }),
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
        "Read a bounded tail of user-visible messages and workbench session-message cards from another project session without changing its activity or focus. Usually inspect only the last one or two items; increase limit only when the recent tail is insufficient.",
      promptSnippet:
        "Read the last one or two visible items of a project session.",
      promptGuidelines: [
        "Use the default small peek first; pass limit=1 or limit=2 for ordinary recency checks, and request more only when you need extra surrounding context.",
      ],
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input) {
        return result(await service.peekSession(sourceConversationId, {
          conversationId: input.conversationId,
          limit: input.limit ?? 2,
        }));
      },
    }),
    defineTool({
      name: "start_session",
      label: "Start session",
      description:
        "Start a persistent peer Agent session for ongoing delegation or follow-up. Returns as soon as the initial task is durably accepted and scheduled; this operation never waits for completion.",
      promptSnippet: "Start a persistent peer Agent session.",
      promptGuidelines: [
        "Before starting a persistent session, first call list_sessions with scope=created_by_me. Reuse a suitable existing session with send_session_message, and create a new persistent session only when none fits the responsibility.",
        "After start_session, choose explicitly whether to keep working, call wait_for_session, or finish and receive a later session message.",
      ],
      parameters: startSessionParameters,
      async execute(toolCallId, input, signal) {
        assertConversationBody(input.task, "task");
        return result(await service.startSession(sourceConversationId, {
          roleId: input.roleId,
          task: input.task,
          ...(input.title === undefined ? {} : { title: input.title }),
          temporary: false,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "start_temporary_session",
      label: "Start temporary session",
      description:
        "Start a one-shot peer Agent session for audits, investigations, or quick reviews. Its successful initial final normally returns to the caller and the peer session is automatically deleted; an explicit peer message that resolves the caller's exact initial-run wait replaces that automatic return.",
      promptSnippet: "Start a one-shot Agent session that auto-deletes after success.",
      promptGuidelines: [
        "Use for throwaway work where you only need the initial final answer; use start_session instead when follow-up or later inspection is expected.",
        "This still runs asynchronously: call wait_for_session when the answer is needed in this turn. If an explicit peer message resolves that wait and you still need the final settlement, call wait_for_session again for the same run.",
      ],
      parameters: startSessionParameters,
      async execute(toolCallId, input, signal) {
        assertConversationBody(input.task, "task");
        return result(await service.startSession(sourceConversationId, {
          roleId: input.roleId,
          task: input.task,
          ...(input.title === undefined ? {} : { title: input.title }),
          temporary: true,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "send_session_message",
      label: "Send session message",
      description:
        "Durably send a first-class session message to a peer. A busy target receives it as steering after its current tool turn and before its next model request; it remains durable until Pi records the target message and the exact run settles. If that peer is waiting for this exact run, the message also resolves that wait immediately.",
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
        assertCanonicalRunId(input.runId);
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
        assertCanonicalRunId(input.runId);
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
        "Delete an idle peer session and its idle descendant sessions. This tool can never delete its own session and rejects, without aborting, when any cascade member is busy or compacting.",
      promptSnippet: "Delete an idle peer Agent session and its idle descendants other than this one; abort/wait busy members first.",
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
