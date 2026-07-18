import { describe, expect, it } from "vitest";
import { parseClientCommand, parseServerEvent, PROTOCOL_VERSION } from "./protocol.js";

const sessionId = "88f3af1d-d21d-40a0-b3c3-0f27593f274a";
const runId = "6ff77ba8-6c29-45a7-9851-e9054d706df2";
const authFlowId = "597eb8f8-2aa8-444a-ac04-681a3c483fac";
const approvalId = "86de79b8-0a40-4644-a0c2-49e2aa3e1baa";
const conversationId = "0198f775-88f3-7af1-9c6a-3176f775912a";
const projectId = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";

describe("parseClientCommand", () => {
  it("uses the run-correlated protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it("accepts supported commands", () => {
    expect(parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      toolMode: "read_only",
      conversation: { kind: "open", conversationId },
    })).toMatchObject({ type: "initialize", toolMode: "read_only" });
    expect(parseClientCommand({ type: "prompt", sessionId, runId, text: "hello" }).type).toBe("prompt");
    expect(parseClientCommand({ type: "abort", sessionId, runId }).type).toBe("abort");
    expect(parseClientCommand({
      type: "tool_approval_response",
      sessionId,
      runId,
      approvalId,
      decision: "allow",
    }).type).toBe("tool_approval_response");
    expect(parseClientCommand({
      type: "select_model",
      sessionId,
      provider: "openai",
      modelId: "gpt",
    }).type).toBe("select_model");
    expect(parseClientCommand({ type: "set_thinking", sessionId, level: "high" }).type).toBe("set_thinking");
    expect(parseClientCommand({
      type: "set_tool_mode",
      sessionId,
      mode: "read_only",
    }).type).toBe("set_tool_mode");
    expect(parseClientCommand({
      type: "rename_conversation",
      sessionId,
      conversationId,
      name: "Architecture",
    }).type).toBe("rename_conversation");
    expect(parseClientCommand({ type: "set_api_key", provider: "openai", key: "secret" }).type).toBe("set_api_key");
    expect(parseClientCommand({ type: "login_oauth", authFlowId, provider: "openai" }).type).toBe("login_oauth");
    expect(parseClientCommand({ type: "auth_response", authFlowId, requestId: "1", value: "code" }).type).toBe("auth_response");
    expect(parseClientCommand({ type: "cancel_auth", authFlowId }).type).toBe("cancel_auth");
    expect(parseClientCommand({ type: "close_session", sessionId }).type).toBe("close_session");
  });

  it("requires valid session and run ids on session-scoped commands", () => {
    expect(() => parseClientCommand({ type: "prompt", sessionId, runId, text: "  " })).toThrow();
    expect(() => parseClientCommand({ type: "prompt", text: "hello" })).toThrow();
    expect(() => parseClientCommand({ type: "abort", sessionId, runId: "not-a-uuid" })).toThrow();
    expect(() => parseClientCommand({
      type: "tool_approval_response",
      sessionId,
      runId,
      approvalId: "not-a-uuid",
      decision: "allow",
    })).toThrow();
    expect(() => parseClientCommand({ type: "select_model", provider: "openai", modelId: "gpt" })).toThrow();
    expect(() => parseClientCommand({ type: "set_thinking", level: "high" })).toThrow();
    expect(() => parseClientCommand({
      type: "set_tool_mode",
      sessionId,
      mode: "unrestricted",
    })).toThrow();
    expect(() => parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId: "not-a-uuid" },
    })).toThrow();
    expect(() => parseClientCommand({
      type: "rename_conversation",
      sessionId,
      conversationId,
      name: " ",
    })).toThrow();
    expect(() => parseClientCommand({ type: "close_session" })).toThrow();
    expect(() => parseClientCommand({ type: "login_oauth", provider: "openai" })).toThrow();
    expect(() => parseClientCommand({ type: "invented" })).toThrow();
  });

  it("rejects oversized socket messages", () => {
    expect(() => parseClientCommand("x".repeat(1_000_001))).toThrow("too large");
  });

  it("validates server events at the browser boundary", () => {
    expect(parseServerEvent({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\work",
    }).type).toBe("hello");
    expect(() => parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      event: { type: "invented" },
    })).toThrow();
  });

  it("validates run correlation on state, events, outcomes, and errors", () => {
    expect(parseServerEvent({
      type: "state",
      state: {
        sessionId,
        projectId,
        conversationId,
        cwd: "E:\\work",
        busy: true,
        activeRun: {
          id: runId,
          phase: "running",
          pendingApprovals: [{
            approvalId,
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "npm test" },
          }],
        },
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }).type).toBe("state");
    expect(parseServerEvent({
      type: "project_snapshot",
      sessionId,
      projectId,
      conversationId,
      conversations: [{
          id: conversationId,
          preview: "hello",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 1,
      }],
      truncated: false,
    }).type).toBe("project_snapshot");
    expect(parseServerEvent({
      type: "conversation_snapshot",
      sessionId,
      conversationId,
      messages: [{
        id: "message-1",
        role: "user",
        text: "hello",
        thinking: "",
        tools: [],
      }],
      truncated: false,
    }).type).toBe("conversation_snapshot");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      event: { type: "run_queued" },
    }).type).toBe("session_event");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      event: {
        type: "tool_prepared",
        toolCallId: "tool-1",
        args: { path: "changed-by-extension.ts" },
      },
    }).type).toBe("session_event");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      event: { type: "run_finished", outcome: "aborted" },
    }).type).toBe("session_event");
    expect(parseServerEvent({
      type: "error",
      message: "failed",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId,
    }).type).toBe("error");
    expect(parseServerEvent({
      type: "auth_progress",
      authFlowId,
      message: "waiting",
    }).type).toBe("auth_progress");

    expect(() => parseServerEvent({
      type: "session_event",
      sessionId,
      event: { type: "run_started" },
    })).toThrow();
    expect(() => parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      event: { type: "run_finished" },
    })).toThrow();
    expect(() => parseServerEvent({
      type: "error",
      message: "failed",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId: "not-a-uuid",
    })).toThrow();
    expect(() => parseServerEvent({
      type: "auth_complete",
      provider: "openai",
    })).toThrow();
    expect(() => parseServerEvent({
      type: "state",
      state: {
        sessionId,
        projectId,
        conversationId,
        cwd: "E:\\work",
        busy: true,
        activeRun: { id: runId, phase: "invented", pendingApprovals: [] },
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    })).toThrow();
  });
});
