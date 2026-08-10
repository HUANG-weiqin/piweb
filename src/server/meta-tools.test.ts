import { describe, expect, it, vi } from "vitest";
import {
  createMetaTools,
  type MetaToolService,
} from "./meta-tools.js";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversation-meta.js";
import { MAX_ROLE_SYSTEM_PROMPT_BYTES } from "./role-store.js";

const sourceConversationId = "source-session";
const targetConversationId = "11111111-1111-4111-8111-111111111111";
const targetRunId = "22222222-2222-4222-8222-222222222222";

function service(): MetaToolService {
  return {
    listRoles: vi.fn(async () => ({ roles: [] })),
    readRole: vi.fn(async () => ({ roleId: "default" })),
    proposeRoleRevision: vi.fn(async () => ({ outcome: "cancelled" })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    currentSession: vi.fn(async () => ({ conversationId: sourceConversationId })),
    peekSession: vi.fn(async () => ({ items: [] })),
    startSession: vi.fn(async () => ({ conversationId: "target", runId: "run" })),
    sendSessionMessage: vi.fn(async () => ({ status: "queued" })),
    waitForSession: vi.fn(async () => ({ outcome: "completed" })),
    abortSession: vi.fn(async () => ({ aborted: true })),
    deleteSession: vi.fn(async () => ({ deleted: true })),
  };
}

function tool(
  tools: ReturnType<typeof createMetaTools>,
  name: string,
) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("createMetaTools", () => {
  it("exposes the fixed role and orchestration tool surface", () => {
    const tools = createMetaTools(sourceConversationId, service());

    expect(tools.map(({ name }) => name)).toEqual([
      "list_roles",
      "read_role",
      "propose_role_revision",
      "list_sessions",
      "current_session",
      "peek_session",
      "start_session",
      "start_temporary_session",
      "send_session_message",
      "wait_for_session",
      "abort_session",
      "delete_session",
    ]);
    expect(JSON.stringify(tools.map(({ parameters }) => parameters)))
      .not.toMatch(/anyOf|oneOf/);
  });

  it("guides Agents to choose persistent versus temporary sessions", () => {
    const tools = createMetaTools(sourceConversationId, service());
    const startSession = tool(tools, "start_session");
    const startTemporarySession = tool(tools, "start_temporary_session");

    expect(startSession.promptGuidelines).toContain(
      "Before starting a persistent session, first call list_sessions with scope=created_by_me. Reuse a suitable existing session with send_session_message, and create a new persistent session only when none fits the responsibility.",
    );
    expect(startTemporarySession.description).toContain("one-shot");
    expect(startTemporarySession.description).toContain(
      "replaces that automatic return",
    );
    expect(startTemporarySession.promptGuidelines).toContain(
      "Use for throwaway work where you only need the initial final answer; use start_session instead when follow-up or later inspection is expected.",
    );
    expect(startTemporarySession.promptGuidelines).toContain(
      "This still runs asynchronously: call wait_for_session when the answer is needed in this turn. If an explicit peer message resolves that wait and you still need the final settlement, call wait_for_session again for the same run.",
    );
  });

  it("guides Agents to peek the smallest useful session tail first", () => {
    const peekSession = tool(
      createMetaTools(sourceConversationId, service()),
      "peek_session",
    );

    expect(peekSession.description).toContain(
      "Usually inspect only the last one or two items",
    );
    expect(peekSession.promptSnippet).toBe(
      "Read the last one or two visible items of a project session.",
    );
    expect(peekSession.promptGuidelines).toContain(
      "Use the default small peek first; pass limit=1 or limit=2 for ordinary recency checks, and request more only when you need extra surrounding context.",
    );
  });

  it("keeps safe role tools when the frozen role disallows orchestration", () => {
    const fake = service();

    expect(createMetaTools(sourceConversationId, fake, false)
      .map(({ name }) => name)).toEqual([
        "list_roles",
        "read_role",
        "propose_role_revision",
      ]);
    expect(Object.values(fake).every((method) => (
      vi.mocked(method).mock.calls.length === 0
    ))).toBe(true);
  });

  it("binds role reads and proposals to the source conversation", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake, false);
    const signal = new AbortController().signal;
    const proposal = {
      roleId: "default",
      expectedRevision: 3,
      newSystemPrompt: "A complete replacement.",
      reason: "The user explicitly requested this change.",
    };

    await tool(tools, "read_role").execute(
      "read-role",
      { roleId: "default" },
      undefined,
      undefined,
      {} as never,
    );
    await tool(tools, "propose_role_revision").execute(
      "propose-role",
      proposal,
      signal,
      undefined,
      {} as never,
    );

    expect(fake.readRole).toHaveBeenCalledWith(
      sourceConversationId,
      { roleId: "default" },
    );
    expect(fake.proposeRoleRevision).toHaveBeenCalledWith(
      sourceConversationId,
      proposal,
      signal,
    );
  });

  it("binds source identity and starts persistent sessions without adding a wait", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const signal = new AbortController().signal;

    const value = await tool(tools, "start_session").execute(
      "tool-call-1",
      {
        roleId: "reviewer",
        task: "Review the actor",
      },
      signal,
      undefined,
      {} as never,
    );

    expect(fake.startSession).toHaveBeenCalledWith(
      sourceConversationId,
      {
        roleId: "reviewer",
        task: "Review the actor",
        temporary: false,
        idempotencyKey: `${sourceConversationId.length}:${sourceConversationId}:tool-call-1`,
      },
      signal,
    );
    expect(fake.waitForSession).not.toHaveBeenCalled();
    expect(value.content).toEqual([{
      type: "text",
      text: JSON.stringify({ conversationId: "target", runId: "run" }),
    }]);
  });

  it("binds source identity and starts temporary sessions without adding a wait", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const signal = new AbortController().signal;

    await tool(tools, "start_temporary_session").execute(
      "tool-call-2",
      {
        roleId: "reviewer",
        task: "Review the actor once",
      },
      signal,
      undefined,
      {} as never,
    );

    expect(fake.startSession).toHaveBeenCalledWith(
      sourceConversationId,
      {
        roleId: "reviewer",
        task: "Review the actor once",
        temporary: true,
        idempotencyKey: `${sourceConversationId.length}:${sourceConversationId}:tool-call-2`,
      },
      signal,
    );
    expect(fake.waitForSession).not.toHaveBeenCalled();
  });

  it("aligns task and message limits with the durable UTF-8 byte contract", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const largeLegalAscii = "a".repeat(220_000);

    await expect(tool(tools, "start_session").execute(
      "large-start",
      {
        roleId: "reviewer",
        task: largeLegalAscii,
      },
      undefined,
      undefined,
      {} as never,
    )).resolves.toBeDefined();
    await expect(tool(tools, "send_session_message").execute(
      "large-message",
      {
        conversationId: "target",
        message: largeLegalAscii,
      },
      undefined,
      undefined,
      {} as never,
    )).resolves.toBeDefined();

    const oversizedUtf8 = "界".repeat(
      Math.floor(MAX_CONVERSATION_BODY_BYTES / 3) + 1,
    );
    await expect(tool(tools, "start_session").execute(
      "oversized-start",
      {
        roleId: "reviewer",
        task: oversizedUtf8,
      },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/UTF-8 bytes/);
    await expect(tool(tools, "send_session_message").execute(
      "oversized-message",
      {
        conversationId: "target",
        message: oversizedUtf8,
      },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/UTF-8 bytes/);
  });

  it("enforces the role system prompt UTF-8 byte contract", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake, false);
    const oversizedUtf8 = "界".repeat(
      Math.floor(MAX_ROLE_SYSTEM_PROMPT_BYTES / 3) + 1,
    );

    await expect(tool(tools, "propose_role_revision").execute(
      "oversized-role-prompt",
      {
        roleId: "default",
        expectedRevision: 1,
        newSystemPrompt: oversizedUtf8,
        reason: "The user explicitly requested this change.",
      },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/UTF-8 bytes/);
    expect(fake.proposeRoleRevision).not.toHaveBeenCalled();
  });

  it("uses bounded defaults for list and peek operations", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);

    await tool(tools, "list_sessions").execute(
      "list-1",
      {},
      undefined,
      undefined,
      {} as never,
    );
    await tool(tools, "peek_session").execute(
      "peek-1",
      { conversationId: "target" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fake.listSessions).toHaveBeenCalledWith(
      sourceConversationId,
      { limit: 50 },
    );
    expect(fake.peekSession).toHaveBeenCalledWith(
      sourceConversationId,
      { conversationId: "target", limit: 2 },
    );
  });

  it("forwards the created-by-me session scope", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);

    await tool(tools, "list_sessions").execute(
      "list-created",
      { scope: "created_by_me" },
      undefined,
      undefined,
      {} as never,
    );

    expect(fake.listSessions).toHaveBeenCalledWith(
      sourceConversationId,
      { limit: 50, scope: "created_by_me" },
    );
  });

  it("passes exact wait and abort identities without inventing lifecycle behavior", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const signal = new AbortController().signal;
    const target = {
      conversationId: targetConversationId,
      runId: targetRunId,
    };

    await tool(tools, "wait_for_session").execute(
      "wait-1",
      target,
      signal,
      undefined,
      {} as never,
    );
    await tool(tools, "abort_session").execute(
      "abort-1",
      target,
      undefined,
      undefined,
      {} as never,
    );

    expect(fake.waitForSession).toHaveBeenCalledWith(
      sourceConversationId,
      target,
      signal,
    );
    expect(fake.abortSession).toHaveBeenCalledWith(
      sourceConversationId,
      {
        ...target,
        idempotencyKey:
          `${sourceConversationId.length}:${sourceConversationId}:abort-1`,
      },
    );
  });

  it("rejects malformed run identities before entering lifecycle services", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const malformedTarget = {
      conversationId: targetConversationId,
      runId: `${targetRunId}f6f`,
    };

    await expect(tool(tools, "wait_for_session").execute(
      "invalid-wait",
      malformedTarget,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/runId must be a canonical UUID/);
    await expect(tool(tools, "abort_session").execute(
      "invalid-abort",
      malformedTarget,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/runId must be a canonical UUID/);

    expect(fake.waitForSession).not.toHaveBeenCalled();
    expect(fake.abortSession).not.toHaveBeenCalled();
  });
});
