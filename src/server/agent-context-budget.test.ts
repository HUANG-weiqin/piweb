import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installAgentContextBudget } from "./agent-context-budget.js";

type ConvertToLlm = AgentSession["agent"]["convertToLlm"];
type AgentMessage = Parameters<ConvertToLlm>[0][number];
type LlmMessages = Awaited<ReturnType<ConvertToLlm>>;

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

function telemetryText(messages: LlmMessages): string {
  const last = messages.at(-1);
  if (!last || (last.role !== "user" && last.role !== "toolResult")) {
    throw new Error("Expected a final user or tool-result message");
  }
  const content = typeof last.content === "string"
    ? [{ type: "text" as const, text: last.content }]
    : last.content;
  const telemetry = content.at(-1);
  if (telemetry?.type !== "text") throw new Error("Expected telemetry text");
  return telemetry.text;
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
    installAgentContextBudget(session, getThreshold);
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
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.convertToLlm([userMessage("input")]);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "continue the long task" },
        {
          type: "text",
          text: "<piweb_ctx used=\"51.9k/272k\" auto_compact=\"70%\" remaining=\"138.5k\" />",
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
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...originalMessage,
      content: [
        { type: "text", text: "plain context" },
        {
          type: "text",
          text: "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
        },
      ],
    }]);
    expect(originalMessage.content).toBe("plain context");
  });

  it("keeps every mixed content part before the appended telemetry", async () => {
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
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...originalMessage,
      content: [
        { type: "text", text: "inspect this image" },
        { type: "image", data: "image-data", mimeType: "image/png" },
        {
          type: "text",
          text: "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
        },
      ],
    }]);
    expect(originalMessage).toEqual(originalSnapshot);
  });

  it("preserves a final tool-result role and protocol position", async () => {
    const toolResult: LlmMessages[number] = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: 1,
    };
    const { session } = fakeSession({ original: async () => [toolResult] });
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.convertToLlm([]);

    expect(result).toEqual([{
      ...toolResult,
      content: [
        { type: "text", text: "tool output" },
        {
          type: "text",
          text: "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
        },
      ],
    }]);
    expect(result).toHaveLength(1);
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
    installAgentContextBudget(session, () => 70);

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
    installAgentContextBudget(session, () => 70);

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
    installAgentContextBudget(session, getThreshold);

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
    installAgentContextBudget(session, () => 70);

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
    installAgentContextBudget(session, getThreshold);

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
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
    installAgentContextBudget(session, getThreshold);

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
    const inputBefore = structuredClone(input);
    const convertedBefore = structuredClone(converted);
    const sessionBefore = structuredClone(sessionMessages);
    const managerBefore = structuredClone(managerMessages);
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.convertToLlm(input);

    expect(input).toEqual(inputBefore);
    expect(converted).toEqual(convertedBefore);
    expect(result).not.toBe(converted);
    expect(sessionMessages).toEqual(sessionBefore);
    expect(managerMessages).toEqual(managerBefore);
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
    installAgentContextBudget(session, () => 70);

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
  });

  it("disposes idempotently and restores own and inherited property shapes", () => {
    const ownOriginal: ConvertToLlm = async () => [];
    const own = fakeSession({ original: ownOriginal });
    const ownController = installAgentContextBudget(own.session, () => 70);
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

    expect(() => installAgentContextBudget(session, () => 70)).toThrow(
      "Pi Agent does not expose convertToLlm",
    );
  });

  it("does not restore over a converter installed after its wrapper", () => {
    const original: ConvertToLlm = async () => [];
    const foreign: ConvertToLlm = async () => [];
    const { session } = fakeSession({ original });
    const controller = installAgentContextBudget(session, () => 70);
    session.agent.convertToLlm = foreign;

    controller.dispose();
    controller.dispose();

    expect(session.agent.convertToLlm).toBe(foreign);
  });
});
