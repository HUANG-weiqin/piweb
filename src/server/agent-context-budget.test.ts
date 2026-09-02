import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { LoopList } from "../shared/protocol.js";
import { installAgentContextBudget } from "./agent-context-budget.js";

type ConvertToLlm = AgentSession["agent"]["convertToLlm"];
type AgentMessage = Parameters<ConvertToLlm>[0][number];
type LlmMessages = Awaited<ReturnType<ConvertToLlm>>;

const ACTIVE_LOOP_LIST: LoopList = {
  items: [{ id: "test", text: "Test active work", status: "active" }],
  armed: true,
};
const ACTIVE_WORK_HINT = "piweb_work={\"active\":[{\"id\":\"test\",\"text\":\"Test active work\"}]}";
const getActiveLoopList = (): LoopList => ACTIVE_LOOP_LIST;

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return message({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  });
}

function llmUser(text: string): LlmMessages[number] {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

function fakeSession({
  original = async () => [llmUser("converted")],
  getContextUsage = () => ({
    tokens: 10_000,
    contextWindow: 100_000,
    percent: 10,
  }),
  agent,
}: {
  original?: ConvertToLlm;
  getContextUsage?: () => ContextUsage | undefined;
  agent?: AgentSession["agent"];
} = {}) {
  const sessionMessages = [userMessage("persisted session message")];
  const managerMessages = [userMessage("persisted manager message")];
  const session = {
    agent: agent ?? {
      convertToLlm: original,
      state: { messages: sessionMessages },
    },
    getContextUsage,
    messages: sessionMessages,
    sessionManager: { messages: managerMessages },
  } as unknown as AgentSession;
  return { session, sessionMessages, managerMessages };
}

function providerTailText(messages: LlmMessages): string {
  const last = messages.at(-1);
  if (!last || (last.role !== "user" && last.role !== "toolResult")) {
    throw new Error("Expected a final user or tool-result message");
  }
  const content = typeof last.content === "string"
    ? [{ type: "text" as const, text: last.content }]
    : last.content;
  const providerTail = content.at(-1);
  if (providerTail?.type !== "text") throw new Error("Expected provider-tail text");
  return providerTail.text;
}

function telemetryText(messages: LlmMessages): string {
  return providerTailText(messages).split("\n", 1)[0]!;
}

describe("installAgentContextBudget", () => {
  it("calls the original converter first with its receiver and preserves message order", async () => {
    const events: string[] = [];
    const first = {
      role: "assistant" as const,
      content: [],
      api: "openai-responses" as const,
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const second = llmUser("latest task");
    const originalResult: LlmMessages = [first, second];
    let receiver: unknown;
    let receivedMessages: AgentMessage[] | undefined;
    const original: ConvertToLlm = async function (messages) {
      events.push("original");
      receiver = this;
      receivedMessages = messages;
      return originalResult;
    };
    const getContextUsage = vi.fn(() => {
      events.push("usage");
      return { tokens: 10_000, contextWindow: 100_000, percent: 10 };
    });
    const getThreshold = vi.fn(() => {
      events.push("threshold");
      return 70;
    });
    const { session } = fakeSession({ original, getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, getThreshold);
    const input = [userMessage("input")];

    const result = await session.agent.convertToLlm(input);

    expect(events).toEqual(["original", "usage", "threshold"]);
    expect(receiver).toBe(session.agent);
    expect(receivedMessages).toBe(input);
    expect(result).toHaveLength(originalResult.length);
    expect(result[0]).toBe(first);
    expect(result[1]).not.toBe(second);
    expect(result[1]).toMatchObject({ role: "user" });
  });

  it("appends exact telemetry after the final user content without creating a new turn", async () => {
    const originalMessage = llmUser("continue the long task");
    const originalResult = [originalMessage];
    const { session } = fakeSession({
      original: async () => originalResult,
      getContextUsage: () => ({
        tokens: 51_900,
        contextWindow: 272_000,
        percent: (51_900 / 272_000) * 100,
      }),
    });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const result = await session.agent.convertToLlm([userMessage("input")]);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "continue the long task" },
        {
          type: "text",
          text: [
            "<piweb_ctx used=\"51.9k/272k\" auto_compact=\"70%\" remaining=\"138.5k\" />",
            ACTIVE_WORK_HINT,
          ].join("\n"),
        },
      ],
      timestamp: 1,
    }]);
    expect(result).toHaveLength(originalResult.length);
    expect(originalResult).toEqual([originalMessage]);
  });

  it("keeps string content before the appended telemetry", async () => {
    const originalMessage: LlmMessages[number] = {
      role: "user",
      content: "plain context",
      timestamp: 1,
    };
    const { session } = fakeSession({ original: async () => [originalMessage] });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...originalMessage,
      content: [
        { type: "text", text: "plain context" },
        {
          type: "text",
          text: [
            "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
            ACTIVE_WORK_HINT,
          ].join("\n"),
        },
      ],
    }]);
    expect(originalMessage.content).toBe("plain context");
  });

  it("keeps mixed content before one combined provider-tail part", async () => {
    const originalMessage: LlmMessages[number] = {
      role: "user",
      content: [
        { type: "text", text: "inspect this image" },
        { type: "image", data: "image-data", mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const originalSnapshot = structuredClone(originalMessage);
    const { session } = fakeSession({ original: async () => [originalMessage] });
    installAgentContextBudget(
      session,
      () => ({
        items: [{ id: "inspect", text: "Inspect image", status: "active" }],
        armed: true,
      }),
      () => 70,
      () => 0,
      () => ({ activeMin: 3, listMin: 11 }),
    );

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...originalMessage,
      content: [
        { type: "text", text: "inspect this image" },
        { type: "image", data: "image-data", mimeType: "image/png" },
        {
          type: "text",
          text: [
            "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
            "piweb_work={\"active\":[{\"id\":\"inspect\",\"text\":\"Inspect image\"}],\"activeMin\":3,\"listMin\":11,\"editLeft\":0}",
          ].join("\n"),
        },
      ],
    }]);
    expect(originalMessage).toEqual(originalSnapshot);
  });

  it("preserves a final tool-result role and protocol position for a work-only tail", async () => {
    const toolResult: LlmMessages[number] = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: 1,
    };
    const { session } = fakeSession({ original: async () => [toolResult] });
    installAgentContextBudget(session, () => ({
      items: [{ id: "verify", text: "Verify output", status: "active" }],
      armed: true,
    }));

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...toolResult,
      content: [
        { type: "text", text: "tool output" },
        {
          type: "text",
          text: "piweb_work={\"active\":[{\"id\":\"verify\",\"text\":\"Verify output\"}]}",
        },
      ],
    }]);
    expect(result).toHaveLength(1);
  });

  it("escapes active work as canonical JSON after telemetry", async () => {
    const loopList: LoopList = {
      items: [
        { id: "later", text: "Not current", status: "pending" },
        { id: "active\"\\", text: "line\n雪", status: "active" },
        { id: "done", text: "Already done", status: "completed" },
      ],
      armed: true,
    };
    const before = structuredClone(loopList);
    const { session } = fakeSession();
    installAgentContextBudget(session, () => loopList, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(providerTailText(result)).toBe([
      "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
      "piweb_work={\"active\":[{\"id\":\"active\\\"\\\\\",\"text\":\"line\\n雪\"}]}",
    ].join("\n"));
    expect(loopList).toEqual(before);
  });

  it("reads the latest LoopList on every conversion when usage is unavailable", async () => {
    const originalResult = [llmUser("converted")];
    const getContextUsage = vi.fn<() => ContextUsage | undefined>(() => undefined);
    const getLoopList = vi.fn<() => LoopList>()
      .mockReturnValueOnce({
        items: [{ id: "first", text: "First snapshot", status: "active" }],
        armed: true,
      })
      .mockReturnValueOnce({
        items: [{ id: "second", text: "Latest snapshot", status: "active" }],
        armed: true,
      })
      .mockReturnValue({
        items: [{ id: "waiting", text: "No active work", status: "pending" }],
        armed: true,
      });
    const getElapsedMinutes = vi.fn()
      .mockReturnValueOnce({ activeMin: 2, listMin: 10 })
      .mockReturnValueOnce({ activeMin: 3, listMin: 11 });
    const { session } = fakeSession({
      original: async () => originalResult,
      getContextUsage,
    });
    installAgentContextBudget(
      session,
      getLoopList,
      () => 70,
      undefined,
      getElapsedMinutes,
    );

    const first = await session.agent.convertToLlm([]);
    const second = await session.agent.convertToLlm([]);
    const neither = await session.agent.convertToLlm([]);

    expect(telemetryText(first)).toBe(
      "piweb_work={\"active\":[{\"id\":\"first\",\"text\":\"First snapshot\"}],\"activeMin\":2,\"listMin\":10}",
    );
    expect(telemetryText(second)).toBe(
      "piweb_work={\"active\":[{\"id\":\"second\",\"text\":\"Latest snapshot\"}],\"activeMin\":3,\"listMin\":11}",
    );
    expect(neither).toBe(originalResult);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(getLoopList).toHaveBeenCalledTimes(3);
    expect(getElapsedMinutes).toHaveBeenCalledTimes(2);
  });

  it("omits the whole transient tail when no work is active", async () => {
    const originalResult = [llmUser("converted")];
    const getContextUsage = vi.fn(() => ({
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    }));
    const getEditBudgetRemainingFiles = vi.fn(() => 3);
    const getElapsedMinutes = vi.fn(() => ({ activeMin: 2, listMin: 10 }));
    const { session } = fakeSession({
      original: async () => originalResult,
      getContextUsage,
    });
    installAgentContextBudget(
      session,
      () => ({
        items: [{ id: "waiting", text: "Not active", status: "pending" }],
        armed: true,
      }),
      () => 70,
      getEditBudgetRemainingFiles,
      getElapsedMinutes,
    );

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getEditBudgetRemainingFiles).not.toHaveBeenCalled();
    expect(getElapsedMinutes).not.toHaveBeenCalled();
  });

  it("keeps the complete work record within its UTF-8 budget", async () => {
    const items: LoopList["items"] = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      text: "界".repeat(512),
      status: "active",
    }));
    const { session } = fakeSession();
    installAgentContextBudget(
      session,
      () => ({ items, armed: true }),
      undefined,
      () => 7,
      () => ({ activeMin: 9, listMin: 42 }),
    );

    const result = await session.agent.convertToLlm([]);
    const record = providerTailText(result);
    const payload = JSON.parse(record.slice("piweb_work=".length)) as {
      active: Array<{ id: string; text: string }>;
      omitted: number;
      activeMin: number;
      listMin: number;
      editLeft: number;
    };

    expect(Buffer.byteLength(record, "utf8")).toBeLessThanOrEqual(4096);
    expect(Object.keys(payload)).toEqual([
      "active",
      "omitted",
      "activeMin",
      "listMin",
      "editLeft",
    ]);
    expect(payload.active).toEqual(
      items.slice(0, payload.active.length).map(({ id, text }) => ({ id, text })),
    );
    expect(payload.omitted).toBe(items.length - payload.active.length);
    expect(payload.omitted).toBeGreaterThan(0);
    expect(payload.activeMin).toBe(9);
    expect(payload.listMin).toBe(42);
    expect(payload.editLeft).toBe(7);

    const next = items[payload.active.length]!;
    const oneMore = `piweb_work=${JSON.stringify({
      active: [...payload.active, { id: next.id, text: next.text }],
      ...(payload.omitted > 1 ? { omitted: payload.omitted - 1 } : {}),
      activeMin: payload.activeMin,
      listMin: payload.listMin,
      editLeft: payload.editLeft,
    })}`;
    expect(Buffer.byteLength(oneMore, "utf8")).toBeGreaterThan(4096);
  });

  it("uses the unrounded usage percentage at the exact warning boundary", async () => {
    const getContextUsage = vi.fn<() => ContextUsage | undefined>()
      .mockReturnValueOnce({
        tokens: 64_999,
        contextWindow: 100_000,
        percent: 64.999,
      })
      .mockReturnValueOnce({
        tokens: 65_000,
        contextWindow: 100_000,
        percent: 65,
      });
    const { session } = fakeSession({ getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const below = await session.agent.convertToLlm([]);
    const at = await session.agent.convertToLlm([]);

    expect(telemetryText(below)).toBe(
      "<piweb_ctx used=\"65k/100k\" auto_compact=\"70%\" remaining=\"5k\" />",
    );
    expect(telemetryText(at)).toBe(
      "<piweb_ctx used=\"65k/100k\" auto_compact=\"70%\" remaining=\"5k\" warning=\"Compaction soon; consider updating Agent Notebook.\" />",
    );
  });

  it("drops the warning after compaction lowers context usage", async () => {
    const getContextUsage = vi.fn<() => ContextUsage | undefined>()
      .mockReturnValueOnce({
        tokens: 66_000,
        contextWindow: 100_000,
        percent: 66,
      })
      .mockReturnValueOnce({
        tokens: 10_000,
        contextWindow: 100_000,
        percent: 10,
      });
    const { session } = fakeSession({ getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const beforeCompaction = await session.agent.convertToLlm([]);
    const afterCompaction = await session.agent.convertToLlm([]);

    expect(telemetryText(beforeCompaction)).toContain(
      "warning=\"Compaction soon; consider updating Agent Notebook.\"",
    );
    expect(telemetryText(afterCompaction)).toBe(
      "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
    );
  });

  it("recalculates usage and a changing threshold on every conversion", async () => {
    const getContextUsage = vi.fn(() => ({
      tokens: 60_000,
      contextWindow: 100_000,
      percent: 60,
    }));
    const getThreshold = vi.fn()
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(80);
    const { session } = fakeSession({ getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, getThreshold);

    const first = await session.agent.convertToLlm([]);
    const second = await session.agent.convertToLlm([]);

    expect(telemetryText(first)).toBe(
      "<piweb_ctx used=\"60k/100k\" auto_compact=\"70%\" remaining=\"10k\" />",
    );
    expect(telemetryText(second)).toBe(
      "<piweb_ctx used=\"60k/100k\" auto_compact=\"80%\" remaining=\"20k\" />",
    );
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(getThreshold).toHaveBeenCalledTimes(2);
  });

  it("reports unknown tokens without remaining budget or a warning", async () => {
    const { session } = fakeSession({
      getContextUsage: () => ({
        tokens: null,
        contextWindow: 272_000,
        percent: null,
      }),
    });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(telemetryText(result)).toBe(
      "<piweb_ctx used=\"unknown/272k\" auto_compact=\"70%\" />",
    );
  });

  it("fails open for unavailable usage, invalid values, and telemetry getter failures", async () => {
    const originalResult = [llmUser("converted")];
    const original = vi.fn<ConvertToLlm>(async () => originalResult);
    const getContextUsage = vi.fn<() => ContextUsage | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ tokens: 10, contextWindow: 0, percent: 10 })
      .mockReturnValue({ tokens: 10, contextWindow: 100, percent: 10 });
    const getThreshold = vi.fn<() => number>()
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(70)
      .mockReturnValueOnce(Number.NaN)
      .mockImplementationOnce(() => {
        throw new Error("threshold unavailable");
      });
    const { session } = fakeSession({ original, getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, getThreshold);

    for (let index = 0; index < 4; index += 1) {
      const result = await session.agent.convertToLlm([]);
      expect(providerTailText(result)).toBe(ACTIVE_WORK_HINT);
    }
    expect(getContextUsage).toHaveBeenCalledTimes(4);
    expect(getThreshold).toHaveBeenCalledTimes(4);
  });

  it("propagates an original-converter rejection without reading telemetry", async () => {
    const failure = new Error("original failed");
    const original = vi.fn<ConvertToLlm>(async () => {
      throw failure;
    });
    const getContextUsage = vi.fn<() => ContextUsage | undefined>();
    const getThreshold = vi.fn(() => 70);
    const { session } = fakeSession({ original, getContextUsage });
    installAgentContextBudget(session, getActiveLoopList, getThreshold);

    await expect(session.agent.convertToLlm([])).rejects.toBe(failure);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getThreshold).not.toHaveBeenCalled();
  });

  it("does not mutate input, converted output, or session-owned messages", async () => {
    const inputMessage = userMessage("input");
    const input = Object.freeze([inputMessage]) as unknown as AgentMessage[];
    const convertedMessage = llmUser("converted");
    const converted = Object.freeze([convertedMessage]) as unknown as LlmMessages;
    const original: ConvertToLlm = async () => converted;
    const { session, sessionMessages, managerMessages } = fakeSession({ original });
    const loopList: LoopList = {
      items: [{ id: "active", text: "Current work", status: "active" }],
      armed: true,
    };
    const inputBefore = structuredClone(input);
    const convertedBefore = structuredClone(converted);
    const sessionBefore = structuredClone(sessionMessages);
    const managerBefore = structuredClone(managerMessages);
    const loopListBefore = structuredClone(loopList);
    installAgentContextBudget(session, () => loopList, () => 70);

    const result = await session.agent.convertToLlm(input);

    expect(input).toEqual(inputBefore);
    expect(converted).toEqual(convertedBefore);
    expect(result).not.toBe(converted);
    expect(sessionMessages).toEqual(sessionBefore);
    expect(managerMessages).toEqual(managerBefore);
    expect(loopList).toEqual(loopListBefore);
  });

  it("fails open when the converted context has no safe final input role", async () => {
    const assistant = {
      role: "assistant" as const,
      content: [],
      api: "openai-responses" as const,
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: 1,
    };
    const originalResult: LlmMessages = [assistant];
    const { session } = fakeSession({ original: async () => originalResult });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
  });

  it("disposes idempotently and restores own and inherited property shapes", () => {
    const ownOriginal: ConvertToLlm = async () => [];
    const own = fakeSession({ original: ownOriginal });
    const ownController = installAgentContextBudget(
      own.session,
      getActiveLoopList,
      () => 70,
    );
    expect(Object.hasOwn(own.session.agent, "convertToLlm")).toBe(true);
    expect(own.session.agent.convertToLlm).not.toBe(ownOriginal);

    ownController.dispose();
    ownController.dispose();
    expect(Object.hasOwn(own.session.agent, "convertToLlm")).toBe(true);
    expect(own.session.agent.convertToLlm).toBe(ownOriginal);

    const inheritedOriginal: ConvertToLlm = async () => [];
    const prototype = { convertToLlm: inheritedOriginal };
    const inheritedAgent = Object.create(prototype) as AgentSession["agent"];
    const inherited = fakeSession({ agent: inheritedAgent });
    expect(Object.hasOwn(inherited.session.agent, "convertToLlm")).toBe(false);

    const inheritedController = installAgentContextBudget(
      inherited.session,
      getActiveLoopList,
      () => 70,
    );
    expect(Object.hasOwn(inherited.session.agent, "convertToLlm")).toBe(true);
    inheritedController.dispose();
    inheritedController.dispose();
    expect(Object.hasOwn(inherited.session.agent, "convertToLlm")).toBe(false);
    expect(inherited.session.agent.convertToLlm).toBe(inheritedOriginal);
  });

  it("fails closed when the Agent does not expose convertToLlm", () => {
    const agent = Object.create(null) as AgentSession["agent"];
    const { session } = fakeSession({ agent });

    expect(() => installAgentContextBudget(
      session,
      getActiveLoopList,
      () => 70,
    )).toThrow("Pi Agent does not expose convertToLlm");
  });

  it("does not restore over a converter installed after its wrapper", () => {
    const original: ConvertToLlm = async () => [];
    const foreign: ConvertToLlm = async () => [];
    const { session } = fakeSession({ original });
    const controller = installAgentContextBudget(
      session,
      getActiveLoopList,
      () => 70,
    );
    session.agent.convertToLlm = foreign;

    controller.dispose();
    controller.dispose();

    expect(session.agent.convertToLlm).toBe(foreign);
  });
});
