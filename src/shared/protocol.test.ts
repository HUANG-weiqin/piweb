import { describe, expect, it } from "vitest";
import { parseClientCommand, parseServerEvent, PROTOCOL_VERSION } from "./protocol.js";

const sessionId = "88f3af1d-d21d-40a0-b3c3-0f27593f274a";
const runId = "6ff77ba8-6c29-45a7-9851-e9054d706df2";
const authFlowId = "597eb8f8-2aa8-444a-ac04-681a3c483fac";
const extensionRequestId = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const commandId = "b55e4225-e07f-4874-b760-015f7982d999";
const conversationId = "0198f775-88f3-7af1-9c6a-3176f775912a";
const projectId = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";

describe("parseClientCommand", () => {
  it("uses the run-correlated protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(10);
  });

  it("accepts supported commands", () => {
    expect(parseClientCommand({
      type: "browse_directory",
      commandId,
      path: "E:\\work",
    }).type).toBe("browse_directory");
    expect(parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      toolMode: "full_access",
      conversation: { kind: "open", conversationId },
    })).toMatchObject({ type: "initialize", toolMode: "full_access" });
    expect(parseClientCommand({ type: "prompt", sessionId, runId, text: "hello" }).type).toBe("prompt");
    expect(parseClientCommand({ type: "abort", sessionId, runId }).type).toBe("abort");
    expect(parseClientCommand({
      type: "extension_ui_response",
      sessionId,
      requestId: extensionRequestId,
      response: { kind: "confirm", confirmed: true },
    }).type).toBe("extension_ui_response");
    expect(parseClientCommand({
      type: "select_model",
      commandId,
      sessionId,
      provider: "openai",
      modelId: "gpt",
    }).type).toBe("select_model");
    expect(parseClientCommand({ type: "set_thinking", sessionId, level: "high" }).type).toBe("set_thinking");
    expect(parseClientCommand({
      type: "set_tool_mode",
      sessionId,
      mode: "full_access",
    }).type).toBe("set_tool_mode");
    expect(parseClientCommand({
      type: "rename_conversation",
      sessionId,
      conversationId,
      name: "Architecture",
    }).type).toBe("rename_conversation");
    expect(parseClientCommand({
      type: "delete_conversation",
      commandId,
      sessionId,
      conversationId,
    }).type).toBe("delete_conversation");
    expect(parseClientCommand({
      type: "set_api_key",
      commandId,
      sessionId,
      provider: "openai",
      key: "secret",
    }).type).toBe("set_api_key");
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
      type: "extension_ui_response",
      sessionId,
      requestId: extensionRequestId,
      response: { kind: "select", value: "x".repeat(501) },
    })).toThrow();
    expect(() => parseClientCommand({ type: "select_model", provider: "openai", modelId: "gpt" })).toThrow();
    expect(() => parseClientCommand({
      type: "set_api_key",
      commandId: "not-a-uuid",
      sessionId,
      provider: "openai",
      key: "secret",
    })).toThrow();
    expect(() => parseClientCommand({
      type: "set_api_key",
      commandId,
      provider: "openai",
      key: "secret",
    })).toThrow();
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
    expect(() => parseClientCommand({
      type: "delete_conversation",
      commandId: "not-a-uuid",
      sessionId,
      conversationId,
    })).toThrow();
    expect(() => parseClientCommand({ type: "close_session" })).toThrow();
    expect(() => parseClientCommand({ type: "login_oauth", provider: "openai" })).toThrow();
    expect(() => parseClientCommand({ type: "invented" })).toThrow();
  });

  it("rejects the removed workspace mode", () => {
    expect(() => parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      toolMode: "workspace_write",
    })).toThrow();
    expect(() => parseClientCommand({
      type: "set_tool_mode",
      sessionId,
      mode: "workspace_write",
    })).toThrow();
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
    expect(parseServerEvent({
      type: "directory_listing",
      commandId,
      path: "E:\\work",
      parentPath: "E:\\",
      directories: [{
        name: "project",
        path: "E:\\work\\project",
      }],
      truncated: false,
    }).type).toBe("directory_listing");
    expect(() => parseServerEvent({
      type: "directory_listing",
      commandId: "not-a-uuid",
      path: "E:\\work",
      parentPath: null,
      directories: [],
      truncated: false,
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
        },
        thinkingLevel: "off",
        toolMode: "full_access",
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
      type: "extension_ui_request",
      sessionId,
      requestId: extensionRequestId,
      request: {
        kind: "select",
        title: "Choose",
        options: ["one", "two"],
      },
    }).type).toBe("extension_ui_request");
    expect(parseServerEvent({
      type: "extension_ui_closed",
      sessionId,
      requestId: extensionRequestId,
    }).type).toBe("extension_ui_closed");
    expect(parseServerEvent({
      type: "extension_ui_notification",
      sessionId,
      level: "info",
      message: "ready",
    }).type).toBe("extension_ui_notification");
    expect(parseServerEvent({
      type: "command_complete",
      operation: "select_model",
      commandId,
      sessionId,
    }).type).toBe("command_complete");
    expect(parseServerEvent({
      type: "command_complete",
      operation: "delete_conversation",
      commandId,
      sessionId,
    }).type).toBe("command_complete");
    expect(parseServerEvent({
      type: "error",
      message: "failed",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId,
      commandId,
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
      type: "command_complete",
      operation: "select_model",
      commandId,
    })).toThrow();
    expect(() => parseServerEvent({
      type: "error",
      scope: "command",
      operation: "set_api_key",
      commandId,
      message: "failed",
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
        activeRun: { id: runId, phase: "invented" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    })).toThrow();
    expect(() => parseServerEvent({
      type: "state",
      state: {
        sessionId,
        projectId,
        conversationId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    })).toThrow();
  });
});
