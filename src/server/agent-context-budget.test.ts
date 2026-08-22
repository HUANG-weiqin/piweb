import type {
  AgentSession,
  ContextUsage,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_CONTEXT_BUDGET_CUSTOM_TYPE,
  installAgentContextBudget,
} from "./agent-context-budget.js";

type TransformContext = NonNullable<AgentSession["agent"]["transformContext"]>;
type AgentMessage = Parameters<TransformContext>[0][number];

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

function contextBudgetMessage(content: string): AgentMessage {
  return message({
    role: "custom",
    customType: AGENT_CONTEXT_BUDGET_CUSTOM_TYPE,
    content,
    display: false,
    timestamp: 1,
  });
}

function fakeSession({
  original = async (messages) => messages,
  getContextUsage = () => ({
    tokens: 10_000,
    contextWindow: 100_000,
    percent: 10,
  }),
  agent,
}: {
  original?: TransformContext;
  getContextUsage?: () => ContextUsage | undefined;
  agent?: AgentSession["agent"];
} = {}) {
  const sessionMessages = [userMessage("persisted session message")];
  const managerMessages = [userMessage("persisted manager message")];
  const session = {
    agent: agent ?? {
      transformContext: original,
      state: { messages: sessionMessages },
    },
    getContextUsage,
    messages: sessionMessages,
    sessionManager: { messages: managerMessages },
  } as unknown as AgentSession;
  return { session, sessionMessages, managerMessages };
}

function telemetry(messages: AgentMessage[]) {
  const result = messages.at(-1);
  if (!result || result.role !== "custom") {
    throw new Error("Expected final custom telemetry message");
  }
  return result;
}

describe("installAgentContextBudget", () => {
  it("calls the original first with its receiver and AbortSignal, then preserves its result order", async () => {
    const events: string[] = [];
    const first = userMessage("first");
    const second = userMessage("second");
    const originalResult = [first, second];
    let receiver: unknown;
    let receivedMessages: AgentMessage[] | undefined;
    let receivedSignal: AbortSignal | undefined;
    const original: TransformContext = async function (messages, signal) {
      events.push("original");
      receiver = this;
      receivedMessages = messages;
      receivedSignal = signal;
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
    const controller = new AbortController();

    const result = await session.agent.transformContext!(
      input,
      controller.signal,
    );

    expect(events).toEqual(["original", "usage", "threshold"]);
    expect(receiver).toBe(session.agent);
    expect(receivedMessages).toBe(input);
    expect(receivedSignal).toBe(controller.signal);
    expect(result.slice(0, -1)).toEqual(originalResult);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  it("appends the exact normal payload as one hidden final custom message", async () => {
    const { session } = fakeSession({
      getContextUsage: () => ({
        tokens: 51_900,
        contextWindow: 272_000,
        percent: (51_900 / 272_000) * 100,
      }),
    });
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.transformContext!([userMessage("input")]);

    expect(telemetry(result)).toEqual({
      role: "custom",
      customType: AGENT_CONTEXT_BUDGET_CUSTOM_TYPE,
      content: "<piweb_ctx used=\"51.9k/272k\" auto_compact=\"70%\" remaining=\"138.5k\" />",
      display: false,
      timestamp: expect.any(Number),
    });
    expect(result.filter((item) => (
      item.role === "custom"
      && item.customType === AGENT_CONTEXT_BUDGET_CUSTOM_TYPE
    ))).toHaveLength(1);
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

    const below = await session.agent.transformContext!([]);
    const at = await session.agent.transformContext!([]);

    expect(telemetry(below).content).toBe(
      "<piweb_ctx used=\"65k/100k\" auto_compact=\"70%\" remaining=\"5k\" />",
    );
    expect(telemetry(at).content).toBe(
      "<piweb_ctx used=\"65k/100k\" auto_compact=\"70%\" remaining=\"5k\" warning=\"Compaction soon; consider updating Agent Notebook.\" />",
    );
  });

  it("recalculates usage and a changing threshold on every transform", async () => {
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

    const first = await session.agent.transformContext!([]);
    const second = await session.agent.transformContext!([]);

    expect(telemetry(first).content).toBe(
      "<piweb_ctx used=\"60k/100k\" auto_compact=\"70%\" remaining=\"10k\" />",
    );
    expect(telemetry(second).content).toBe(
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

    const result = await session.agent.transformContext!([]);

    expect(telemetry(result).content).toBe(
      "<piweb_ctx used=\"unknown/272k\" auto_compact=\"70%\" />",
    );
  });

  it("fails open for unavailable usage, invalid windows or thresholds, and telemetry getter failures", async () => {
    const originalResult = [userMessage("transformed")];
    const original = vi.fn<TransformContext>(async () => originalResult);
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

    await expect(session.agent.transformContext!([])).resolves.toBe(originalResult);
    await expect(session.agent.transformContext!([])).resolves.toBe(originalResult);
    await expect(session.agent.transformContext!([])).resolves.toBe(originalResult);
    await expect(session.agent.transformContext!([])).resolves.toBe(originalResult);
    expect(getContextUsage).toHaveBeenCalledTimes(4);
    expect(getThreshold).toHaveBeenCalledTimes(4);
  });

  it("propagates an original-transform rejection without reading telemetry", async () => {
    const failure = new Error("original failed");
    const original = vi.fn<TransformContext>(async () => {
      throw failure;
    });
    const getContextUsage = vi.fn<() => ContextUsage | undefined>();
    const getThreshold = vi.fn(() => 70);
    const { session } = fakeSession({ original, getContextUsage });
    installAgentContextBudget(session, getThreshold);

    await expect(session.agent.transformContext!([])).rejects.toBe(failure);
    expect(getContextUsage).not.toHaveBeenCalled();
    expect(getThreshold).not.toHaveBeenCalled();
  });

  it("replaces every prior reserved marker and leaves exactly one at the end", async () => {
    const first = userMessage("first");
    const otherCustom = message({
      role: "custom",
      customType: "example.other.v1",
      content: "other",
      display: false,
      timestamp: 1,
    });
    const staleOne = contextBudgetMessage("stale one");
    const staleTwo = contextBudgetMessage("stale two");
    const originalResult = [
      staleOne,
      first,
      staleTwo,
      otherCustom,
    ];
    const original = vi.fn<TransformContext>(async () => originalResult);
    const { session } = fakeSession({ original });
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.transformContext!([]);

    expect(result.slice(0, -1)).toEqual([first, otherCustom]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(otherCustom);
    expect(result.filter((item) => (
      item.role === "custom"
      && item.customType === AGENT_CONTEXT_BUDGET_CUSTOM_TYPE
    ))).toHaveLength(1);
    expect(originalResult).toEqual([staleOne, first, staleTwo, otherCustom]);
  });

  it("does not mutate transform input or session-owned message arrays", async () => {
    const inputMessage = userMessage("input");
    const input = Object.freeze([inputMessage]) as unknown as AgentMessage[];
    const original: TransformContext = async (messages) => messages;
    const { session, sessionMessages, managerMessages } = fakeSession({ original });
    const sessionBefore = [...sessionMessages];
    const managerBefore = [...managerMessages];
    installAgentContextBudget(session, () => 70);

    const result = await session.agent.transformContext!(input);

    expect(input).toEqual([inputMessage]);
    expect(result).not.toBe(input);
    expect(sessionMessages).toEqual(sessionBefore);
    expect(managerMessages).toEqual(managerBefore);
  });

  it("disposes idempotently and restores own and inherited property shapes", () => {
    const ownOriginal: TransformContext = async (messages) => messages;
    const own = fakeSession({ original: ownOriginal });
    const ownController = installAgentContextBudget(own.session, () => 70);
    expect(Object.hasOwn(own.session.agent, "transformContext")).toBe(true);
    expect(own.session.agent.transformContext).not.toBe(ownOriginal);

    ownController.dispose();
    ownController.dispose();
    expect(Object.hasOwn(own.session.agent, "transformContext")).toBe(true);
    expect(own.session.agent.transformContext).toBe(ownOriginal);

    const inheritedOriginal: TransformContext = async (messages) => messages;
    const prototype = { transformContext: inheritedOriginal };
    const inheritedAgent = Object.create(prototype) as AgentSession["agent"];
    const inherited = fakeSession({ agent: inheritedAgent });
    expect(Object.hasOwn(inherited.session.agent, "transformContext")).toBe(false);

    const inheritedController = installAgentContextBudget(
      inherited.session,
      () => 70,
    );
    expect(Object.hasOwn(inherited.session.agent, "transformContext")).toBe(true);
    inheritedController.dispose();
    inheritedController.dispose();
    expect(Object.hasOwn(inherited.session.agent, "transformContext")).toBe(false);
    expect(inherited.session.agent.transformContext).toBe(inheritedOriginal);
  });

  it("does not restore over a transform installed after its wrapper", () => {
    const original: TransformContext = async (messages) => messages;
    const foreign: TransformContext = async (messages) => [...messages];
    const { session } = fakeSession({ original });
    const controller = installAgentContextBudget(session, () => 70);
    session.agent.transformContext = foreign;

    controller.dispose();
    controller.dispose();

    expect(session.agent.transformContext).toBe(foreign);
  });
});
