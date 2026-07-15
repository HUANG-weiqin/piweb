import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "./reducer";

describe("chatReducer", () => {
  it("streams assistant text", () => {
    let state = chatReducer(initialChatState, { type: "sent", text: "hello" });
    state = chatReducer(state, { type: "pi", event: { type: "agent_start" } });
    state = chatReducer(state, { type: "pi", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } } });
    expect(state.messages.at(-1)?.text).toBe("hi");
  });

  it("tracks tool lifecycle", () => {
    let state = chatReducer(initialChatState, { type: "pi", event: { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "a" } } });
    state = chatReducer(state, { type: "pi", event: { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: [] }, isError: false } });
    expect(state.messages.at(-1)?.tools[0].status).toBe("done");
  });
});
