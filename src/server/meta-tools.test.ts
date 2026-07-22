import { describe, expect, it, vi } from "vitest";
import {
  createMetaTools,
  type MetaToolService,
} from "./meta-tools.js";
import { MAX_CONVERSATION_BODY_BYTES } from "./conversation-meta.js";

const sourceConversationId = "source-session";

function service(): MetaToolService {
  return {
    listRoles: vi.fn(async () => ({ roles: [] })),
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
  it("exposes the fixed nine-tool orchestration surface", () => {
    const tools = createMetaTools(sourceConversationId, service());

    expect(tools.map(({ name }) => name)).toEqual([
      "list_roles",
      "list_sessions",
      "current_session",
      "peek_session",
      "start_session",
      "send_session_message",
      "wait_for_session",
      "abort_session",
      "delete_session",
    ]);
  });

  it("guides Agents to reuse suitable normal sessions before creating duplicates", () => {
    const startSession = tool(
      createMetaTools(sourceConversationId, service()),
      "start_session",
    );

    expect(startSession.promptGuidelines).toContain(
      "Before starting a normal session, first call list_sessions with scope=created_by_me. Reuse a suitable existing session with send_session_message, and create a new normal session only when none fits the responsibility.",
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

  it("exposes no orchestration tool metadata when the frozen role disallows it", () => {
    const fake = service();

    expect(createMetaTools(sourceConversationId, fake, false)).toEqual([]);
    expect(Object.values(fake).every((method) => (
      vi.mocked(method).mock.calls.length === 0
    ))).toBe(true);
  });

  it("binds source identity and returns start_session without adding a wait", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake);
    const signal = new AbortController().signal;

    const value = await tool(tools, "start_session").execute(
      "tool-call-1",
      {
        roleId: "reviewer",
        task: "Review the actor",
        temporary: true,
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
        temporary: true,
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
    const target = { conversationId: "target", runId: "run-7" };

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
});
