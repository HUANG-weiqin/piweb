import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../../shared/protocol";
import { chatReducer, initialChatState } from "./reducer";

const RUN_1 = "run-1";
const RUN_2 = "run-2";

function usage(total: number): TokenUsage {
  return {
    input: total,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total,
  };
}

describe("chatReducer", () => {
  it("hydrates a detached persistent history snapshot", () => {
    const state = chatReducer(initialChatState, {
      type: "hydrate",
      messages: [{
        id: "user-1",
        role: "user",
        text: "inspect",
        thinking: "",
        tools: [],
      }, {
        id: "assistant-1",
        role: "assistant",
        text: "done",
        thinking: "checking",
        tools: [{
          toolCallId: "tool-1",
          toolName: "read",
          args: { path: "README.md" },
          result: "ok",
          status: "done",
        }],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 4,
          cacheWrite: 0,
          total: 9,
        },
      }],
    });

    expect(state.sessionTokens).toBe(9);
    expect(state.messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "inspect" }),
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        text: "done",
        tools: [expect.objectContaining({ id: "tool-1", status: "done" })],
      }),
    ]);
  });

  it("streams assistant text", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "text_delta", delta: "hi" } });
    expect(state.messages.at(-1)?.text).toBe("hi");
  });

  it("tracks tool lifecycle", () => {
    let state = chatReducer(initialChatState, { type: "session", runId: RUN_1, event: { type: "tool_started", toolCallId: "1", toolName: "read", args: { path: "a" } } });
    expect(state.messages.at(-1)?.tools[0]).toMatchObject({
      args: { path: "a" },
      status: "pending",
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: {
        type: "tool_prepared",
        toolCallId: "1",
        args: { path: "changed-by-extension.ts" },
      },
    });
    expect(state.messages.at(-1)?.tools[0]).toMatchObject({
      args: { path: "changed-by-extension.ts" },
      status: "pending",
    });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "tool_finished", toolCallId: "1", result: { content: [] }, isError: false } });
    expect(state.messages.at(-1)?.tools[0].status).toBe("done");
  });

  it("accumulates assistant total token usage as session tokens", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "usage", usage: usage(25) } });

    state = chatReducer(state, { type: "sent", runId: RUN_2, text: "hello again" });
    state = chatReducer(state, { type: "session", runId: RUN_2, event: { type: "run_started" } });
    state = chatReducer(state, { type: "session", runId: RUN_2, event: { type: "usage", usage: usage(23) } });

    expect(state.sessionTokens).toBe(48);
    expect(state.messages.at(-1)?.usage?.total).toBe(23);
  });

  it("accumulates usage from multiple assistant calls in one agent run", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "use a tool" });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "run_started" } });

    for (const total of [25, 23]) {
      state = chatReducer(state, {
        type: "session",
        runId: RUN_1,
        event: { type: "usage", usage: usage(total) },
      });
    }

    expect(state.sessionTokens).toBe(48);
    expect(state.messages.at(-1)?.usage?.total).toBe(48);
  });

  it("uses the final assistant message when no streaming delta arrived", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "hello" });
    state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "run_started" } });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "text_replaced", text: "final-only response" },
    });

    expect(state.messages.at(-1)?.text).toBe("final-only response");
  });

  it("does not depend on Array.prototype.at being available", () => {
    const originalAt = Array.prototype.at;
    Object.defineProperty(Array.prototype, "at", { configurable: true, writable: true, value: undefined });

    try {
      let state = chatReducer(initialChatState, { type: "session", runId: RUN_1, event: { type: "run_started" } });
      state = chatReducer(state, { type: "session", runId: RUN_1, event: { type: "text_delta", delta: "hi" } });

      expect(state.messages[state.messages.length - 1]?.text).toBe("hi");
    } finally {
      Object.defineProperty(Array.prototype, "at", { configurable: true, writable: true, value: originalAt });
    }
  });

  it("routes interleaved text to the assistant for each run", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "first" });
    state = chatReducer(state, { type: "sent", runId: RUN_2, text: "second" });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_2,
      event: { type: "text_delta", delta: "second answer" },
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "text_delta", delta: "first answer" },
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_2,
      event: { type: "text_delta", delta: "!" },
    });

    expect(state.messages.map(({ role, runId, text }) => ({ role, runId, text }))).toEqual([
      { role: "user", runId: RUN_1, text: "first" },
      { role: "assistant", runId: RUN_1, text: "first answer" },
      { role: "user", runId: RUN_2, text: "second" },
      { role: "assistant", runId: RUN_2, text: "second answer!" },
    ]);
  });

  it("routes interleaved tools and usage even when tool call ids overlap", () => {
    let state = chatReducer(initialChatState, { type: "sent", runId: RUN_1, text: "first" });
    state = chatReducer(state, { type: "sent", runId: RUN_2, text: "second" });
    for (const runId of [RUN_2, RUN_1]) {
      state = chatReducer(state, {
        type: "session",
        runId,
        event: { type: "tool_started", toolCallId: "shared", toolName: "read" },
      });
    }
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "tool_finished", toolCallId: "shared", result: "first result", isError: false },
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_2,
      event: { type: "tool_finished", toolCallId: "shared", result: "second result", isError: true },
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_2,
      event: { type: "usage", usage: usage(20) },
    });
    state = chatReducer(state, {
      type: "session",
      runId: RUN_1,
      event: { type: "usage", usage: usage(10) },
    });

    const assistants = state.messages.filter((message) => message.role === "assistant");
    expect(assistants.find((message) => message.runId === RUN_1)).toMatchObject({
      usage: { total: 10 },
      tools: [{ result: "first result", status: "done" }],
    });
    expect(assistants.find((message) => message.runId === RUN_2)).toMatchObject({
      usage: { total: 20 },
      tools: [{ result: "second result", status: "error" }],
    });
    expect(state.sessionTokens).toBe(30);
  });
});
