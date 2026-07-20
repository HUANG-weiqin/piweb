import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  MAX_ROLE_COUNT,
  MAX_ROLE_DESCRIPTION_CHARACTERS,
  MAX_ROLE_NAME_CHARACTERS,
  MAX_ROLE_SYSTEM_PROMPT_BYTES,
  MAX_SERVER_EVENT_BYTES,
  parseClientCommand,
  parseServerEvent,
  PROTOCOL_VERSION,
} from "./protocol.js";

const sessionId = "88f3af1d-d21d-40a0-b3c3-0f27593f274a";
const runId = "6ff77ba8-6c29-45a7-9851-e9054d706df2";
const authFlowId = "597eb8f8-2aa8-444a-ac04-681a3c483fac";
const extensionRequestId = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const commandId = "b55e4225-e07f-4874-b760-015f7982d999";
const conversationId = "0198f775-88f3-7af1-9c6a-3176f775912a";
const projectId = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";
const focusId = "ef01fdc2-8f55-4125-a22d-b0b764b4546b";
const targetConversationId = "cbcd831e-599b-40d6-9252-e79939ca49f4";
const roleId = "f23db1e6-c657-4dac-8b7e-a14fdecc5f21";
const messageId = "assistant:96b960be-b6bb-4a19-9cf2-78e77cb69425";

describe("parseClientCommand", () => {
  it("uses the run-correlated protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(17);
  });

  it("accepts supported commands", () => {
    expect(parseClientCommand({
      type: "browse_directory",
      commandId,
      path: "E:\\work",
    }).type).toBe("browse_directory");
    expect(parseClientCommand({
      type: "initialize",
      commandId,
      sessionId,
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId },
    })).toMatchObject({ type: "initialize" });
    expect(parseClientCommand({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId,
      title: "Review the runtime",
    }).type).toBe("create_conversation");
    expect(parseClientCommand({
      type: "focus_conversation",
      commandId,
      sessionId,
      conversationId,
    }).type).toBe("focus_conversation");
    expect(parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: "Reviewer",
        description: "Finds lifecycle bugs",
        systemPrompt: "Review the implementation.",
        model: { provider: "openai", id: "gpt" },
        toolMode: "read_only",
        canManageSessions: false,
      },
    }).type).toBe("create_role");
    expect(parseClientCommand({
      type: "update_role",
      commandId,
      sessionId,
      roleId,
      expectedRevision: 1,
      role: {
        name: "Reviewer",
        description: "",
        systemPrompt: "",
        model: null,
        toolMode: "full_access",
        canManageSessions: true,
      },
    }).type).toBe("update_role");
    expect(parseClientCommand({
      type: "delete_role",
      commandId,
      sessionId,
      roleId,
      expectedRevision: 2,
    }).type).toBe("delete_role");
    expect(parseClientCommand({
      type: "prompt",
      sessionId,
      conversationId,
      focusId: commandId,
      runId,
      text: "hello",
    }).type).toBe("prompt");
    expect(parseClientCommand({
      type: "steer",
      commandId,
      sessionId,
      conversationId,
      focusId,
      runId,
      text: "change direction",
    }).type).toBe("steer");
    expect(parseClientCommand({
      type: "abort",
      sessionId,
      conversationId,
      focusId: commandId,
      runId,
    }).type).toBe("abort");
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
      type: "set_compaction_threshold",
      commandId,
      sessionId,
      conversationId,
      focusId,
      percent: 70,
    }).type).toBe("set_compaction_threshold");
    expect(parseClientCommand({
      type: "compact_context",
      commandId,
      sessionId,
      conversationId,
      focusId,
    }).type).toBe("compact_context");
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
      type: "truncate_conversation",
      commandId,
      sessionId,
      conversationId,
      focusId,
      messageId,
    }).type).toBe("truncate_conversation");
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
      type: "set_compaction_threshold",
      commandId,
      sessionId,
      conversationId,
      focusId,
      percent: 19,
    })).toThrow();
    expect(() => parseClientCommand({
      type: "set_compaction_threshold",
      commandId,
      sessionId,
      conversationId,
      focusId,
      percent: 91,
    })).toThrow();
    expect(() => parseClientCommand({
      type: "compact_context",
      commandId,
      sessionId,
      conversationId,
      focusId: "not-a-uuid",
    })).toThrow();
    expect(() => parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId: "not-a-uuid" },
    })).toThrow();
    expect(() => parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      conversation: { kind: "recent" },
    })).toThrow("commandId");
    expect(() => parseClientCommand({
      type: "initialize",
      sessionId,
      cwd: "E:\\work",
      conversation: { kind: "new" },
    })).toThrow("role");
    expect(() => parseClientCommand({
      type: "create_conversation",
      commandId,
      sessionId,
      roleId: " ",
    })).toThrow();
    expect(() => parseClientCommand({
      type: "update_role",
      commandId,
      sessionId,
      roleId,
      expectedRevision: 0,
      role: {
        name: "Reviewer",
        description: "",
        systemPrompt: "",
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
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
    expect(() => parseClientCommand({
      type: "truncate_conversation",
      commandId,
      sessionId,
      conversationId,
      focusId,
      messageId: "assistant:",
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
    expect(() => parseClientCommand({
      type: "set_tool_mode",
      sessionId,
      mode: "full_access",
    })).toThrow();
  });

  it("rejects oversized socket messages", () => {
    expect(() => parseClientCommand("x".repeat(1_000_001))).toThrow("too large");
  });

  it("aligns role prompts with the durable 128 KiB UTF-8 boundary", () => {
    const exactPrompt = "é".repeat(MAX_ROLE_SYSTEM_PROMPT_BYTES / 2);
    expect(parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: "Reviewer",
        description: "",
        systemPrompt: exactPrompt,
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
    })).toMatchObject({
      type: "create_role",
      role: { systemPrompt: exactPrompt },
    });
    expect(() => parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: "Reviewer",
        description: "",
        systemPrompt: `${exactPrompt}é`,
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
    })).toThrow("UTF-8");
  });

  it("aligns role name and description character limits with durable storage", () => {
    const exactUnicodeName = "😀".repeat(MAX_ROLE_NAME_CHARACTERS);
    expect(parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: exactUnicodeName,
        description: "d".repeat(MAX_ROLE_DESCRIPTION_CHARACTERS),
        systemPrompt: "",
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
    })).toMatchObject({
      type: "create_role",
      role: { name: exactUnicodeName },
    });
    expect(() => parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: `${exactUnicodeName}😀`,
        description: "",
        systemPrompt: "",
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
    })).toThrow("80 characters");
    expect(() => parseClientCommand({
      type: "create_role",
      commandId,
      sessionId,
      role: {
        name: "Reviewer",
        description: "d".repeat(MAX_ROLE_DESCRIPTION_CHARACTERS + 1),
        systemPrompt: "",
        model: null,
        toolMode: "read_only",
        canManageSessions: false,
      },
    })).toThrow("1000 characters");
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
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }).type).toBe("state");
    expect(parseServerEvent({
      type: "state",
      state: {
        sessionId,
        projectId,
        conversationId,
        focusId,
        cwd: "E:\\work",
        busy: true,
        activeRun: {
          id: runId,
          phase: "waiting",
          waitingFor: {
            conversationId: targetConversationId,
            runId: "e509167a-1cc3-4bb9-bb0d-845bf94d9c99",
          },
        },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }).type).toBe("state");
    expect(parseServerEvent({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId,
      sessionId,
      projectId,
      focusId,
      conversationId,
    }).type).toBe("focus_attached");
    expect(parseServerEvent({
      type: "focus_attached",
      operation: "initialize",
      commandId,
      sessionId,
      projectId,
    }).type).toBe("focus_attached");
    expect(parseServerEvent({
      type: "focus_invalidated",
      sessionId,
      projectId,
      conversationId,
      focusId,
      reason: "deleted",
    }).type).toBe("focus_invalidated");
    expect(() => parseServerEvent({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId,
      sessionId,
      projectId,
      focusId,
    })).toThrow();
    expect(parseServerEvent({
      type: "role_catalog_snapshot",
      sessionId,
      projectId,
      roles: [{
        id: "default",
        revision: 1,
        name: "Default",
        description: "",
        systemPrompt: "",
        model: { provider: "openai", id: "gpt" },
        toolMode: "read_only",
        canManageSessions: true,
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
        available: true,
      }],
    }).type).toBe("role_catalog_snapshot");
    const projectSnapshot = parseServerEvent({
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
          role: {
            id: "default",
            revision: 1,
            name: "Default",
            description: "",
            model: { provider: "openai", id: "gpt" },
            toolMode: "read_only",
            canManageSessions: true,
          },
          activity: { kind: "running", runId },
          attention: false,
          unread: true,
          temporary: false,
          createdBy: {
            kind: "conversation",
            conversationId: targetConversationId,
          },
      }],
      truncated: false,
    });
    expect(projectSnapshot.type).toBe("project_snapshot");
    if (projectSnapshot.type !== "project_snapshot") {
      throw new Error("project snapshot not parsed");
    }
    expect(projectSnapshot.conversations[0]?.createdBy).toEqual({
      kind: "conversation",
      conversationId: targetConversationId,
    });
    expect(parseServerEvent({
      type: "conversation_snapshot",
      sessionId,
      conversationId,
      focusId,
      role: {
        id: "default",
        revision: 1,
        name: "Default",
        description: "",
        systemPrompt: "",
        model: { provider: "openai", id: "gpt" },
        toolMode: "read_only",
        canManageSessions: true,
      },
      items: [
        {
          kind: "session_message",
          id: "card-entry-1",
          cardId: "6790e721-6f5c-4692-8949-4d3fd2cf0dfc",
          direction: "incoming",
          state: "queued",
          body: "Please review the actor.",
          from: {
            conversationId: targetConversationId,
            title: "Coordinator",
            role: { id: "default", name: "Default" },
          },
          to: {
            conversationId,
            role: { id: roleId, name: "Reviewer" },
          },
          sentAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:00:01.000Z",
          peerExists: true,
        },
        {
          kind: "compaction",
          id: "compaction-entry-1",
          timestamp: "2026-07-18T12:01:00.000Z",
          tokensBefore: 63_771,
        },
      ],
      truncated: false,
    }).type).toBe("conversation_snapshot");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      conversationId,
      focusId,
      event: { type: "run_queued" },
    }).type).toBe("session_event");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      conversationId,
      focusId,
      event: {
        type: "user_message",
        projectionId: commandId,
        text: "change direction",
      },
    }).type).toBe("session_event");
    expect(parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      conversationId,
      focusId,
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
      conversationId,
      focusId,
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
      operation: "steer",
      commandId,
      sessionId,
    }).type).toBe("command_complete");
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
      conversationId,
      focusId,
      commandId,
    }).type).toBe("error");
    expect(parseServerEvent({
      type: "error",
      message: "stale run",
      scope: "command",
      operation: "steer",
      sessionId,
      runId,
      conversationId,
      focusId,
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
      runId,
    })).toThrow();
    expect(() => parseServerEvent({
      type: "error",
      message: "failed",
      scope: "command",
      operation: "steer",
      sessionId,
      runId,
      conversationId,
      focusId,
    })).toThrow();
    expect(() => parseServerEvent({
      type: "session_event",
      sessionId,
      runId,
      conversationId,
      event: { type: "run_started" },
    })).toThrow();
    expect(() => parseServerEvent({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId,
      sessionId,
      projectId,
    })).toThrow();
    expect(() => parseServerEvent({
      type: "focus_invalidated",
      sessionId,
      projectId,
      conversationId,
      reason: "deleted",
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

  it("keeps client frames at 1 MB while accepting a bounded full role catalog", () => {
    const systemPrompt = "x".repeat(MAX_ROLE_SYSTEM_PROMPT_BYTES);
    const roles = Array.from({ length: MAX_ROLE_COUNT }, (_, index) => ({
      id: index === 0
        ? "default"
        : `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      revision: 1,
      name: `Role ${index}`,
      description: "",
      systemPrompt,
      model: { provider: "openai", id: "gpt" },
      toolMode: "read_only",
      canManageSessions: index === 0,
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:00:00.000Z",
      available: true,
    }));
    const payload = JSON.stringify({
      type: "role_catalog_snapshot",
      sessionId,
      projectId,
      roles,
    });

    expect(new TextEncoder().encode(payload).byteLength)
      .toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(new TextEncoder().encode(payload).byteLength)
      .toBeLessThan(MAX_SERVER_EVENT_BYTES);
    expect(parseServerEvent(payload)).toMatchObject({
      type: "role_catalog_snapshot",
      roles: { length: MAX_ROLE_COUNT },
    });
    expect(() => parseClientCommand("x".repeat(MAX_MESSAGE_BYTES + 1)))
      .toThrow("too large");
  });

  it("requires exactly one focused history projection and bounded project fields", () => {
    const message = {
      id: "message-1",
      role: "user" as const,
      text: "hello",
      thinking: "",
      tools: [],
    };
    expect(() => parseServerEvent({
      type: "conversation_snapshot",
      sessionId,
      conversationId,
      focusId,
      messages: [message],
      items: [{ kind: "message", ...message }],
      truncated: false,
    })).toThrow("exactly one");
    expect(() => parseServerEvent({
      type: "conversation_snapshot",
      sessionId,
      conversationId,
      focusId,
      truncated: false,
    })).toThrow("exactly one");
    expect(() => parseServerEvent({
      type: "project_snapshot",
      sessionId,
      projectId,
      conversations: Array.from({ length: 101 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        preview: "",
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
        messageCount: 0,
      })),
      truncated: true,
    })).toThrow();
    expect(() => parseServerEvent({
      type: "project_snapshot",
      sessionId,
      projectId,
      conversations: [{
        id: conversationId,
        name: "n".repeat(121),
        preview: "",
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
        messageCount: 0,
      }],
      truncated: true,
    })).toThrow();
  });
});
