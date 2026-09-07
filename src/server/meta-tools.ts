import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS,
} from "../shared/protocol.js";
import {
  MAX_CONVERSATION_BODY_BYTES,
  normalizeConversationMessageSummary,
} from "./conversation-meta.js";
import { MAX_ROLE_SYSTEM_PROMPT_BYTES } from "./role-store.js";

interface MetaToolSessionRef {
  conversationId: string;
  runId: string;
}

type MetaToolWaitInput = { targets: readonly MetaToolSessionRef[] };

function formatLocalTimestamp(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset();
  const local = new Date(value.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, -1);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const minutes = String(absoluteOffset % 60).padStart(2, "0");
  return `${local}${sign}${hours}:${minutes}`;
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
      idempotencyKey: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  sendSessionMessage(
    sourceConversationId: string,
    input: {
      conversationId: string;
      summary: string;
      message: string;
      idempotencyKey: string;
    },
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  waitForSession(
    sourceConversationId: string,
    input: MetaToolWaitInput,
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  abortSession(
    sourceConversationId: string,
    input: MetaToolSessionRef & { idempotencyKey: string },
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

function normalizeWaitInput(input: {
  targets?: Array<{ conversationId: string; runId: string }>;
}): MetaToolWaitInput {
  if (input.targets === undefined) {
    throw new Error("wait_for_session requires targets");
  }
  if (input.targets.length < 1 || input.targets.length > 32) {
    throw new Error("wait_for_session targets must contain 1 to 32 items");
  }
  const seen = new Set<string>();
  const targets: MetaToolSessionRef[] = [];
  for (const target of input.targets) {
    assertCanonicalRunId(target.runId);
    const key = `${target.conversationId.length}:${target.conversationId}:${target.runId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(Object.freeze({
      conversationId: target.conversationId,
      runId: target.runId,
    }));
  }
  return { targets: Object.freeze(targets) };
}

function normalizeSessionScope(scope: string | undefined): MetaToolSessionScope | undefined {
  if (scope === undefined || scope === "all" || scope === "created_by_me") {
    return scope;
  }
  throw new Error("Invalid list_sessions scope");
}

const sessionTargetParameters = Type.Object({
  conversationId: Type.String({ minLength: 1, maxLength: 256 }),
  runId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const startSessionParameters = Type.Object({
  roleId: Type.String({ minLength: 1, maxLength: 128 }),
  task: Type.String({
    minLength: 1,
    maxLength: MAX_CONVERSATION_BODY_BYTES,
  }),
  title: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  })),
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
  canManageSessions: boolean,
): ToolDefinition[] {
  const alwaysAvailableTools = [
    defineTool({
      name: "current_time",
      label: "Current time",
      description:
        "Return the current local machine time as an RFC 3339 timestamp with UTC offset and the local IANA time zone. Use this instead of inferring the current time from model knowledge.",
      promptSnippet: "Read the current local machine time and time zone.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const instant = new Date();
        return result({
          localTime: formatLocalTimestamp(instant),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      },
    }),
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
  if (!canManageSessions) return alwaysAvailableTools;
  return [
    ...alwaysAvailableTools,
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
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "send_session_message",
      label: "Send session message",
      description:
        "Durably send a first-class session message to a peer. A busy target receives it as steering after its current tool turn and before its next model request; it remains durable until Pi records the target message and the exact run settles. If that peer is currently waiting (wait_for_session), the delivered message also resolves that wait immediately, even when the wait targets a different conversation or run.",
      promptSnippet: "Send a durable message to another Agent session.",
      promptGuidelines: [
        "Always provide summary: a plain-language explanation for the user of what this message asks or reports. It appears on the collapsed message card; keep the full task or evidence in message.",
      ],
      parameters: Type.Object({
        conversationId: Type.String({ minLength: 1, maxLength: 256 }),
        summary: Type.String({
          minLength: 1,
          // TypeBox counts UTF-16 code units; the shared runtime validator
          // enforces the actual 500-Unicode-character contract.
          maxLength: MAX_SESSION_MESSAGE_SUMMARY_CHARACTERS * 2,
          description: "Plain-language user summary, at most 500 Unicode characters and 2 KiB UTF-8.",
        }),
        message: Type.String({
          minLength: 1,
          maxLength: MAX_CONVERSATION_BODY_BYTES,
        }),
      }, { additionalProperties: false }),
      async execute(toolCallId, input, signal) {
        assertConversationBody(input.message, "message");
        const summary = normalizeConversationMessageSummary(input.summary);
        return result(await service.sendSessionMessage(sourceConversationId, {
          conversationId: input.conversationId,
          summary,
          message: input.message,
          idempotencyKey: sideEffectKey(sourceConversationId, toolCallId),
        }, signal));
      },
    }),
    defineTool({
      name: "wait_for_session",
      label: "Wait for session",
      description:
        "Explicitly wait for the next relevant event while keeping the current turn responsive. Pass targets with 1-32 peer run identities to wait for the first listed durable settlement, which identifies its conversationId. The wait may instead return message metadata when a peer/inbox message is claimed into the current run's steering queue (delivered after the wait starts, or already claimed before it registered but not yet observed — from any conversation or run), or guidance metadata when user guidance is accepted into the current run's steering queue (an explicit steer or a busy browser message, accepted before or after the wait registered). When this call returns message metadata, the body has already been injected as a separate custom message into the same model request that receives this tool result; use that message now instead of calling wait_for_session or peek_session merely to obtain the body. Otherwise call again only when the message did not satisfy the dependency and final settlement still matters. A target without authoritative recovery or delivery reachability returns target_unreachable. There is no global cycle rejection. A silent wait may return {\"outcome\":\"checkpoint\"} after four minutes. This is not target completion; call wait again only if the result remains necessary.",
      promptSnippet: "Wait for the first durable settlement from a bounded target set.",
      promptGuidelines: [
        "A message outcome's body is already in the model context that receives the wait result; use it there, and do not wait or peek merely to fetch the body.",
      ],
      parameters: Type.Object({
        targets: Type.Array(sessionTargetParameters, {
          minItems: 1,
          maxItems: 32,
        }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, input, signal) {
        return result(await service.waitForSession(
          sourceConversationId,
          normalizeWaitInput(input),
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
      parameters: sessionTargetParameters,
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
