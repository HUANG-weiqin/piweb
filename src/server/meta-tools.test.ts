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
const secondTargetConversationId = "33333333-3333-4333-8333-333333333333";
const secondTargetRunId = "44444444-4444-4444-8444-444444444444";

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
    const tools = createMetaTools(sourceConversationId, service(), true);

    expect(tools.map(({ name }) => name)).toEqual([
      "current_time",
      "list_roles",
      "read_role",
      "propose_role_revision",
      "list_sessions",
      "current_session",
      "peek_session",
      "start_session",
      "send_session_message",
      "wait_for_session",
      "abort_session",
      "delete_session",
    ]);
    expect(JSON.stringify(tools.map(({ parameters }) => parameters)))
      .not.toMatch(/anyOf|oneOf/);
  });

  it("guides Agents on persistent sessions and waiting", () => {
    const tools = createMetaTools(sourceConversationId, service(), true);
    const startSession = tool(tools, "start_session");
    const waitForSession = tool(tools, "wait_for_session");

    expect(startSession.promptGuidelines).toContain(
      "Before starting a persistent session, first call list_sessions with scope=created_by_me. Reuse a suitable existing session with send_session_message, and create a new persistent session only when none fits the responsibility.",
    );
    expect(waitForSession.description).toContain(
      "the body has already been injected as a separate custom message into the same model request that receives this tool result",
    );
    expect(waitForSession.promptGuidelines).toContain(
      "A message outcome's body is already in the model context that receives the wait result; use it there, and do not wait or peek merely to fetch the body.",
    );
  });

  it("guides Agents to peek the smallest useful session tail first", () => {
    const peekSession = tool(
      createMetaTools(sourceConversationId, service(), true),
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
        "current_time",
        "list_roles",
        "read_role",
        "propose_role_revision",
      ]);
    expect(Object.values(fake).every((method) => (
      vi.mocked(method).mock.calls.length === 0
    ))).toBe(true);
  });

  it("returns the current local machine time with its time zone", async () => {
    const instant = new Date("2026-09-02T12:34:56.789Z");
    vi.useFakeTimers();
    vi.setSystemTime(instant);
    try {
      const currentTime = tool(
        createMetaTools(sourceConversationId, service(), false),
        "current_time",
      );
      const output = await currentTime.execute(
        "current-time",
        {},
        undefined,
        undefined,
        {} as never,
      );
      const value = JSON.parse(output.content[0]!.text) as {
        localTime: string;
        timeZone: string;
      };

      expect(Date.parse(value.localTime)).toBe(instant.getTime());
      expect(value.localTime).toMatch(/T\d{2}:\d{2}:\d{2}\.789(?:Z|[+-]\d{2}:\d{2})$/);
      expect(value.timeZone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    } finally {
      vi.useRealTimers();
    }
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
    const tools = createMetaTools(sourceConversationId, fake, true);
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
    const tools = createMetaTools(sourceConversationId, fake, true);
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
    const tools = createMetaTools(sourceConversationId, fake, true);

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
    const tools = createMetaTools(sourceConversationId, fake, true);

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
    const tools = createMetaTools(sourceConversationId, fake, true);
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

  it("trims and forwards a single-wait commitment", async () => {
    const fake = service();
    const wait = tool(
      createMetaTools(sourceConversationId, fake, true),
      "wait_for_session",
    );

    await wait.execute(
      "committed-wait",
      {
        conversationId: targetConversationId,
        runId: targetRunId,
        singleWaitCommitment: "  This review is on the critical path.  ",
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(fake.waitForSession).toHaveBeenCalledWith(
      sourceConversationId,
      {
        conversationId: targetConversationId,
        runId: targetRunId,
        singleWaitCommitment: "This review is on the critical path.",
      },
      undefined,
    );
  });

  it("forwards a bounded, de-duplicated aggregate wait set", async () => {
    const fake = service();
    const wait = tool(
      createMetaTools(sourceConversationId, fake, true),
      "wait_for_session",
    );
    const signal = new AbortController().signal;
    const first = {
      conversationId: targetConversationId,
      runId: targetRunId,
    };
    const second = {
      conversationId: secondTargetConversationId,
      runId: secondTargetRunId,
    };
    const parameters = wait.parameters as unknown as {
      properties: {
        targets: { minItems: number; maxItems: number };
      };
    };

    expect(parameters.properties.targets).toMatchObject({
      minItems: 1,
      maxItems: 32,
    });
    await wait.execute(
      "wait-any",
      { targets: [first, first, second] } as never,
      signal,
      undefined,
      {} as never,
    );

    expect(fake.waitForSession).toHaveBeenCalledWith(
      sourceConversationId,
      { targets: [first, second] },
      signal,
    );
    const forwarded = vi.mocked(fake.waitForSession).mock.calls[0]?.[1] as {
      targets: Array<{ conversationId: string; runId: string }>;
    };
    expect(Object.isFrozen(forwarded.targets)).toBe(true);
    expect(forwarded.targets.every(Object.isFrozen)).toBe(true);
  });

  it("rejects malformed or mixed aggregate waits before lifecycle services", async () => {
    const fake = service();
    const wait = tool(
      createMetaTools(sourceConversationId, fake, true),
      "wait_for_session",
    );

    await expect(wait.execute(
      "mixed-wait",
      {
        conversationId: targetConversationId,
        runId: targetRunId,
        targets: [{
          conversationId: secondTargetConversationId,
          runId: secondTargetRunId,
        }],
      } as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/cannot mix/i);
    await expect(wait.execute(
      "commitment-with-targets",
      {
        targets: [{
          conversationId: secondTargetConversationId,
          runId: secondTargetRunId,
        }],
        singleWaitCommitment: "not valid for aggregate waits",
      } as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/cannot mix/i);
    await expect(wait.execute(
      "empty-wait",
      { targets: [] } as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/1 to 32/);
    await expect(wait.execute(
      "invalid-target-wait",
      { targets: [{
        conversationId: targetConversationId,
        runId: `${targetRunId}f6f`,
      }] } as never,
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/runId must be a canonical UUID/);

    expect(fake.waitForSession).not.toHaveBeenCalled();
  });

  it("rejects malformed run identities before entering lifecycle services", async () => {
    const fake = service();
    const tools = createMetaTools(sourceConversationId, fake, true);
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

  it("documents checkpoints as not proof of completion", () => {
    const wait = tool(
      createMetaTools(sourceConversationId, service(), true),
      "wait_for_session",
    );
    expect(wait.description).toContain("{\"outcome\":\"checkpoint\"}");
    expect(wait.description).toContain("This is not target completion");
  });
});
