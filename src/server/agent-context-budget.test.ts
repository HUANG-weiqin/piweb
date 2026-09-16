import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopList } from "../shared/protocol.js";
import {
  CONTEXT_HINT_MIN_INTERVAL_MS,
  installAgentContextBudget,
} from "./agent-context-budget.js";
import { CONTEXT_HINT_CUSTOM_TYPE } from "./conversation-meta.js";

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
  streaming = true,
}: {
  original?: ConvertToLlm;
  getContextUsage?: () => ContextUsage | undefined;
  agent?: AgentSession["agent"];
  streaming?: boolean;
} = {}) {
  const sessionMessages = [userMessage("persisted session message")];
  const managerMessages = [userMessage("persisted manager message")];
  const injections: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  lastInjections = injections;
  const session = {
    agent: agent ?? {
      convertToLlm: original,
      state: { messages: sessionMessages },
    },
    getContextUsage,
    messages: sessionMessages,
    sessionManager: { messages: managerMessages },
    isStreaming: streaming,
    async sendCustomMessage(message: Record<string, unknown>, options?: unknown) {
      injections.push({ message, options });
    },
  } as unknown as AgentSession;
  return { session, sessionMessages, managerMessages, injections };
}

let lastInjections: Array<{ message: Record<string, unknown>; options: unknown }> = [];

function hintAt(index: number): string {
  const content = lastInjections[index]?.message.content;
  if (typeof content !== "string") throw new Error(`No injected context hint at ${index}`);
  return content;
}

function telemetryAt(index: number): string {
  return hintAt(index).split("\n", 1)[0]!;
}

function providerTailText(_messages: LlmMessages): string {
  return hintAt(lastInjections.length - 1);
}

function telemetryText(messages: LlmMessages): string {
  return providerTailText(messages).split("\n", 1)[0]!;
}

async function withFakeClock<T>(
  run: (advance: (ms: number) => void) => Promise<T>,
): Promise<T> {
  const advance = (ms: number): void => {
    vi.setSystemTime(new Date(Date.now() + ms));
  };
  return await run(advance);
}

describe("installAgentContextBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
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
    expect(result[1]).toBe(second);
    expect(result).toBe(originalResult);
  });

  it("injects exact telemetry as a hidden history hint without touching the converted context", async () => {
    const originalMessage = llmUser("continue the long task");
    const originalResult = [originalMessage];
    const { session, injections } = fakeSession({
      original: async () => originalResult,
      getContextUsage: () => ({
        tokens: 51_900,
        contextWindow: 272_000,
        percent: (51_900 / 272_000) * 100,
      }),
    });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    const result = await session.agent.convertToLlm([userMessage("input")]);

    expect(result).toBe(originalResult);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.message).toEqual({
      customType: CONTEXT_HINT_CUSTOM_TYPE,
      content: [
        "<piweb_ctx used=\"51.9k/272k\" auto_compact=\"70%\" remaining=\"138.5k\" />",
        ACTIVE_WORK_HINT,
      ].join("\n"),
      display: false,
    });
    expect(injections[0]!.options).toEqual({ triggerTurn: true });
    expect(originalResult).toEqual([originalMessage]);
  });

  it("injects at most one hint per minute", async () => {
    await withFakeClock(async (advance) => {
      const { session, injections } = fakeSession();
      installAgentContextBudget(session, getActiveLoopList, () => 70);

      await session.agent.convertToLlm([]);
      advance(59_000);
      await session.agent.convertToLlm([]);
      expect(injections).toHaveLength(1);

      advance(1_000);
      await session.agent.convertToLlm([]);
      expect(injections).toHaveLength(2);

      advance(600_000);
      await session.agent.convertToLlm([]);
      expect(injections).toHaveLength(3);
    });
  });

  it("keeps a non-streaming session on the append-only hint path", async () => {
    const { session, injections } = fakeSession({ streaming: false });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    await session.agent.convertToLlm([]);

    expect(injections).toHaveLength(1);
    expect(injections[0]!.options).toEqual({ triggerTurn: false });
  });

  it("fails open when the hint cannot be persisted", async () => {
    const originalResult = [llmUser("converted")];
    const { session, injections } = fakeSession({ original: async () => originalResult });
    session.sendCustomMessage = async () => {
      throw new Error("history unavailable");
    };
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    expect(injections).toHaveLength(0);
  });

  it("combines telemetry and elapsed work into one hidden hint", async () => {
    const originalMessage: LlmMessages[number] = {
      role: "user",
      content: [
        { type: "text", text: "inspect this image" },
        { type: "image", data: "image-data", mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const originalSnapshot = structuredClone(originalMessage);
    const originalResult = [originalMessage];
    const { session } = fakeSession({ original: async () => originalResult });
    installAgentContextBudget(
      session,
      () => ({
        items: [{ id: "inspect", text: "Inspect image", status: "active" }],
        armed: true,
      }),
      () => 70,
      () => ({ activeMin: 3, listMin: 11 }),
    );

    const result = await session.agent.convertToLlm([]);

    expect(result).toBe(originalResult);
    expect(providerTailText(result)).toBe([
      "<piweb_ctx used=\"10k/100k\" auto_compact=\"70%\" remaining=\"60k\" />",
      "piweb_work={\"active\":[{\"id\":\"inspect\",\"text\":\"Inspect image\"}],\"activeElapsedMinutes\":3,\"loopListElapsedMinutes\":11}",
    ].join("\n"));
    expect(originalMessage).toEqual(originalSnapshot);
  });

  it("leaves a final tool-result message untouched for a work-only hint", async () => {
    const toolResult: LlmMessages[number] = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: 1,
    };
    const originalResult = [toolResult];
    const { session } = fakeSession({ original: async () => originalResult });
    installAgentContextBudget(session, () => ({
      items: [{ id: "verify", text: "Verify output", status: "active" }],
      armed: true,
    }));

    const result = await session.agent.convertToLlm([]);

    expect(result).toBe(originalResult);
    expect(providerTailText(result)).toBe(
      "piweb_work={\"active\":[{\"id\":\"verify\",\"text\":\"Verify output\"}]}",
    );
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
      getElapsedMinutes,
    );

    const first = await session.agent.convertToLlm([]);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await session.agent.convertToLlm([]);
    const neither = await session.agent.convertToLlm([]);

    expect(hintAt(0)).toBe(
      "piweb_work={\"active\":[{\"id\":\"first\",\"text\":\"First snapshot\"}],\"activeElapsedMinutes\":2,\"loopListElapsedMinutes\":10}",
    );
    expect(hintAt(1)).toBe(
      "piweb_work={\"active\":[{\"id\":\"second\",\"text\":\"Latest snapshot\"}],\"activeElapsedMinutes\":3,\"loopListElapsedMinutes\":11}",
    );
    expect(neither).toBe(originalResult);
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(getLoopList).toHaveBeenCalledTimes(3);
    expect(getElapsedMinutes).toHaveBeenCalledTimes(2);
  });

  it("omits the hint when no work is active", async () => {
    const originalResult = [llmUser("converted")];
    const getContextUsage = vi.fn(() => ({
      tokens: 10_000,
      contextWindow: 100_000,
      percent: 10,
    }));
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
      getElapsedMinutes,
    );

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    expect(lastInjections).toHaveLength(0);
    expect(getContextUsage).not.toHaveBeenCalled();
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
      () => ({ activeMin: 9, listMin: 42 }),
    );

    const result = await session.agent.convertToLlm([]);
    const record = providerTailText(result);
    const payload = JSON.parse(record.slice("piweb_work=".length)) as {
      active: Array<{ id: string; text: string }>;
      omitted: number;
      activeElapsedMinutes: number;
      loopListElapsedMinutes: number;
    };

    expect(Buffer.byteLength(record, "utf8")).toBeLessThanOrEqual(4096);
    expect(Object.keys(payload)).toEqual([
      "active",
      "omitted",
      "activeElapsedMinutes",
      "loopListElapsedMinutes",
    ]);
    expect(payload.active).toEqual(
      items.slice(0, payload.active.length).map(({ id, text }) => ({ id, text })),
    );
    expect(payload.omitted).toBe(items.length - payload.active.length);
    expect(payload.omitted).toBeGreaterThan(0);
    expect(payload.activeElapsedMinutes).toBe(9);
    expect(payload.loopListElapsedMinutes).toBe(42);

    const next = items[payload.active.length]!;
    const oneMore = `piweb_work=${JSON.stringify({
      active: [...payload.active, { id: next.id, text: next.text }],
      ...(payload.omitted > 1 ? { omitted: payload.omitted - 1 } : {}),
      activeElapsedMinutes: payload.activeElapsedMinutes,
      loopListElapsedMinutes: payload.loopListElapsedMinutes,
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
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const at = await session.agent.convertToLlm([]);

    expect(telemetryAt(0)).toBe(
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
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const afterCompaction = await session.agent.convertToLlm([]);

    expect(telemetryAt(0)).toContain(
      "warning=\"Compaction soon; consider updating Agent Notebook.\"",
    );
    expect(telemetryAt(1)).toBe(
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
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const second = await session.agent.convertToLlm([]);

    expect(telemetryAt(0)).toBe(
      "<piweb_ctx used=\"60k/100k\" auto_compact=\"70%\" remaining=\"10k\" />",
    );
    expect(telemetryAt(1)).toBe(
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
      expect(result).toBe(originalResult);
      expect(hintAt(index)).toBe(ACTIVE_WORK_HINT);
      vi.setSystemTime(new Date(Date.now() + 60_000));
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
    expect(result).toBe(converted);
    expect(sessionMessages).toEqual(sessionBefore);
    expect(managerMessages).toEqual(managerBefore);
    expect(loopList).toEqual(loopListBefore);
  });

  it("injects the hint even when the final converted message has no user role", async () => {
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
    const { session, injections } = fakeSession({ original: async () => originalResult });
    installAgentContextBudget(session, getActiveLoopList, () => 70);

    await expect(session.agent.convertToLlm([])).resolves.toBe(originalResult);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.message).toMatchObject({
      customType: CONTEXT_HINT_CUSTOM_TYPE,
      display: false,
    });
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
