import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { installAgentTurnBoundaryCheck } from "./agent-turn-boundary.js";

type PrepareRequest = NonNullable<AgentSession["agent"]["prepareRequest"]>;
type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;

function fixture() {
  const manager = SessionManager.inMemory("/test");
  const queued = [{ role: "user", content: "queued guidance", timestamp: 1 }];
  const agent = {
    hasQueuedMessages: vi.fn(function () { return queued.length > 0; }),
  } as unknown as AgentSession["agent"];
  const usage = { tokens: 850, contextWindow: 1_000, percent: 85 };
  const session = {
    agent, sessionManager: manager, getContextUsage: vi.fn(() => usage),
  } as unknown as AgentSession;
  const handler = vi.fn(() => true);
  const request: Parameters<PrepareRequest>[0] = {
    context: { messages: [], tools: [] },
    model: { provider: "test", id: "model" } as Parameters<PrepareRequest>[0]["model"],
    thinkingLevel: "off",
  };
  return { session, agent, manager, queued, usage, handler, request };
}

function turn(stopReason: AssistantMessage["stopReason"] = "toolUse", withResult = true): Parameters<FinishTurn>[0] {
  const message: AssistantMessage = {
    role: "assistant", content: [{ type: "toolCall", id: "reset-call", name: "reset_context", arguments: { handoff: "Continue" } }],
    api: "test", provider: "test", model: "model", timestamp: 1, stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  return {
    message, toolResults: withResult ? [{ role: "toolResult", toolCallId: "reset-call", toolName: "reset_context",
      content: [{ type: "text", text: "accepted" }], isError: false, timestamp: 2 }] : [],
    context: { messages: [], tools: [] }, newMessages: [],
  };
}

describe("Agent turn boundary adapter", () => {
  it("awaits the prior prepareRequest, preserves its update and captures the post-hook leaf before the response", async () => {
    const { session, agent, manager, handler, request } = fixture();
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    let controller: ReturnType<typeof installAgentTurnBoundaryCheck>;
    const update = { context: request.context, model: request.model, thinkingLevel: "off" as const };
    const previousPrepareRequest = vi.fn<PrepareRequest>(async function (this: typeof agent, input, signal) {
      expect(this).toBe(agent);
      expect(input).toBe(request);
      expect(signal).toBe(abort.signal);
      expect(controller.observedLeafId()).toBeUndefined();
      await ready;
      manager.appendCustomMessageEntry("extension-note", "Flushed by the prior request hook", false);
      return update;
    });
    agent.prepareRequest = previousPrepareRequest;
    const abort = new AbortController();
    const getLeaf = vi.spyOn(manager, "getLeafId");
    controller = installAgentTurnBoundaryCheck(session, handler);
    expect(controller.observedLeafId()).toBeUndefined();
    const preparing = agent.prepareRequest!(request, abort.signal);
    expect(getLeaf).not.toHaveBeenCalled();
    finish();
    expect(await preparing).toBe(update);
    expect(getLeaf).toHaveBeenCalledTimes(1);
    const captured = manager.getLeafId();
    expect(controller.observedLeafId()).toBe(captured);
    manager.appendMessage(turn().message);
    expect(manager.getLeafId()).not.toBe(captured);
    expect(controller.observedLeafId()).toBe(captured);
    controller.dispose();
    expect(agent.prepareRequest).toBe(previousPrepareRequest);
    expect(controller.observedLeafId()).toBeUndefined();
  });

  it("distinguishes the known empty frontier and recaptures each request", async () => {
    const { session, agent, manager, handler, request } = fixture();
    const controller = installAgentTurnBoundaryCheck(session, handler);
    expect(await agent.prepareRequest!(request)).toBeUndefined();
    expect(controller.observedLeafId()).toBeNull();
    manager.appendMessage({ role: "user", content: "Next request", timestamp: 1 });
    await agent.prepareRequest!(request);
    expect(controller.observedLeafId()).toBe(manager.getLeafId());
    controller.dispose();
    expect(Object.hasOwn(agent, "prepareRequest")).toBe(false);
  });

  it.each(["abort", "failure"])("invalidates the previous frontier on prepareRequest %s", async (mode) => {
    const { session, agent, manager, handler, request } = fixture();
    const abort = new AbortController();
    let failed = false;
    agent.prepareRequest = async () => {
      if (!failed) return;
      manager.appendCustomMessageEntry("note", "not observed", false);
      if (mode === "abort") abort.abort();
      else throw new Error("prepare failed");
    };
    const controller = installAgentTurnBoundaryCheck(session, handler);
    await agent.prepareRequest(request);
    expect(controller.observedLeafId()).toBeNull();
    failed = true;
    const preparing = agent.prepareRequest(request, abort.signal);
    if (mode === "failure") await expect(preparing).rejects.toThrow("prepare failed");
    else await preparing;
    expect(controller.observedLeafId()).toBeUndefined();
    controller.dispose();
  });

  it.each(["continue", "end"] as const)("preserves the prior finishTurn %s decision without calling the host or pausing queues", async (action) => {
    const { session, agent, handler, queued } = fixture();
    const decision = { action };
    const previousFinishTurn = vi.fn<FinishTurn>(async function (this: typeof agent) {
      expect(this).toBe(agent);
      return decision;
    });
    agent.finishTurn = previousFinishTurn;
    const previousQueue = agent.hasQueuedMessages;
    const controller = installAgentTurnBoundaryCheck(session, handler);
    const completed = turn();
    const signal = new AbortController().signal;
    expect(await agent.finishTurn!(completed, signal)).toBe(decision);
    expect(previousFinishTurn).toHaveBeenCalledWith(completed, signal);
    expect(handler).not.toHaveBeenCalled();
    expect(agent.hasQueuedMessages()).toBe(true);
    expect(queued).toHaveLength(1);
    controller.dispose();
    expect(agent.finishTurn).toBe(previousFinishTurn);
    expect(agent.hasQueuedMessages).toBe(previousQueue);
  });

  it("preserves a prior finishTurn rejection", async () => {
    const { session, agent, handler } = fixture();
    agent.finishTurn = async () => { throw new Error("prior hook failed"); };
    const controller = installAgentTurnBoundaryCheck(session, handler);
    await expect(agent.finishTurn!(turn())).rejects.toThrow("prior hook failed");
    expect(handler).not.toHaveBeenCalled();
    expect(agent.hasQueuedMessages()).toBe(true);
    controller.dispose();
  });

  it.each(["stop", "length", "error", "aborted", "pending", "deferred"] as const)("does not pause a %s response", async (reason) => {
    const { session, agent, handler } = fixture();
    const controller = installAgentTurnBoundaryCheck(session, handler);
    expect(await agent.finishTurn!(turn(reason))).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(agent.hasQueuedMessages()).toBe(true);
    controller.dispose();
  });

  it("only pauses after a complete toolUse turn and hides rather than drains queued messages", async () => {
    const { session, agent, handler, usage, queued } = fixture();
    const previousQueue = agent.hasQueuedMessages;
    const controller = installAgentTurnBoundaryCheck(session, handler);
    expect(await agent.finishTurn!(turn("toolUse", false))).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(await agent.finishTurn!(turn())).toEqual({ action: "end" });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ contextUsage: usage });
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(queued).toHaveLength(1);
    controller.releaseQueuePause();
    expect(agent.hasQueuedMessages()).toBe(true);
    await agent.finishTurn!(turn());
    controller.dispose();
    controller.dispose();
    expect(agent.hasQueuedMessages).toBe(previousQueue);
    expect(Object.hasOwn(agent, "finishTurn")).toBe(false);
    expect(queued).toHaveLength(1);
  });

  it("keeps scheduling unchanged when the advisory host check refuses or throws", async () => {
    const { session, agent, handler } = fixture();
    const controller = installAgentTurnBoundaryCheck(session, handler);
    handler.mockReturnValueOnce(false).mockImplementationOnce(() => { throw new Error("advisory failure"); });
    expect(await agent.finishTurn!(turn())).toBeUndefined();
    expect(await agent.finishTurn!(turn())).toBeUndefined();
    expect(agent.hasQueuedMessages()).toBe(true);
    controller.dispose();
  });

  it("restores inherited hooks by deleting wrappers without clobbering later replacements", async () => {
    const { session, agent, handler } = fixture();
    const prototype = {
      prepareRequest: vi.fn<PrepareRequest>(), finishTurn: vi.fn<FinishTurn>(),
      hasQueuedMessages: () => true,
    };
    delete (agent as Partial<typeof agent>).hasQueuedMessages;
    Object.setPrototypeOf(agent, prototype);
    const controller = installAgentTurnBoundaryCheck(session, handler);
    controller.dispose();
    for (const name of ["prepareRequest", "finishTurn", "hasQueuedMessages"]) {
      expect(Object.hasOwn(agent, name)).toBe(false);
    }
    const second = installAgentTurnBoundaryCheck(session, handler);
    const newerPrepare = vi.fn<PrepareRequest>();
    const newerFinish = vi.fn<FinishTurn>();
    const newerQueue = () => false;
    agent.prepareRequest = newerPrepare;
    agent.finishTurn = newerFinish;
    agent.hasQueuedMessages = newerQueue;
    second.dispose();
    expect(agent.prepareRequest).toBe(newerPrepare);
    expect(agent.finishTurn).toBe(newerFinish);
    expect(agent.hasQueuedMessages).toBe(newerQueue);
  });
});
