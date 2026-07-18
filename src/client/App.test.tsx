// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type PublicState,
  type ServerEvent,
} from "../shared/protocol";
import { App } from "./App";

const RUN_ID = "13f17393-974b-49a0-9c6a-3176f775912a";
const APPROVAL_A = "8f310256-f2ab-481d-8ca2-f20a43392ba3";
const APPROVAL_B = "68aaf24e-0bb5-4e64-ad5f-fffe4503324e";
const PROJECT_ID = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";
const CONVERSATION_ID = "0198f775-88f3-7af1-9c6a-3176f775912a";
const CONVERSATION_B = "6a04656b-72d9-43ae-b1a8-5754cfa2b7cf";
const EXTENSION_REQUEST_A = "a81ab25f-041e-4559-b890-04c0eeb476e4";

type TestState = Omit<PublicState, "projectId" | "conversationId">
  & Partial<Pick<PublicState, "projectId" | "conversationId">>;
type TestServerEvent = Exclude<ServerEvent, { type: "state" }>
  | { type: "state"; state: TestState };

function completeEvent(event: TestServerEvent): ServerEvent {
  if (event.type !== "state") return event;
  return {
    ...event,
    state: {
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      ...event.state,
    },
  };
}

const socketMock = vi.hoisted(() => ({
  instances: [] as Array<{
    emit(event: TestServerEvent): void;
    rawEmit(event: TestServerEvent): void;
    status(online: boolean): void;
  }>,
  emit: undefined as ((event: TestServerEvent) => void) | undefined,
  rawEmit: undefined as ((event: TestServerEvent) => void) | undefined,
  status: undefined as ((online: boolean) => void) | undefined,
  send: vi.fn((_command: ClientCommand) => true),
  close: vi.fn(),
  helloVersion: 0,
}));

vi.mock("./lib/socket", () => ({
  PiSocket: class {
    constructor(onEvent: (event: ServerEvent) => void, onStatus: (online: boolean) => void) {
      const snapshottedConversations = new Set<string>();
      const rawEmit = (event: TestServerEvent) => onEvent(completeEvent(event));
      const emit = (event: TestServerEvent) => {
        const completed = completeEvent(event);
        onEvent(completed);
        if (completed.type === "state") {
          const snapshotKey =
            `${completed.state.sessionId}:${completed.state.conversationId}`;
          if (snapshottedConversations.has(snapshotKey)) return;
          snapshottedConversations.add(snapshotKey);
          onEvent({
            type: "conversation_snapshot",
            sessionId: completed.state.sessionId,
            conversationId: completed.state.conversationId,
            messages: [],
            truncated: false,
          });
        }
      };
      socketMock.instances.push({ emit, rawEmit, status: onStatus });
      socketMock.emit = emit;
      socketMock.rawEmit = rawEmit;
      socketMock.status = onStatus;
    }

    connect() {
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: socketMock.helloVersion,
        startupCwd: "E:\\default",
      });
    }

    send(command: ClientCommand) {
      return socketMock.send(command);
    }

    close() {
      socketMock.close();
    }
  },
}));
socketMock.helloVersion = PROTOCOL_VERSION;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  socketMock.emit = undefined;
  socketMock.rawEmit = undefined;
  socketMock.status = undefined;
  socketMock.instances.splice(0);
  socketMock.send.mockReset();
  socketMock.send.mockReturnValue(true);
  socketMock.close.mockReset();
  socketMock.helloVersion = PROTOCOL_VERSION;
});

function latestSessionId(): string {
  for (let index = socketMock.send.mock.calls.length - 1; index >= 0; index--) {
    const command = socketMock.send.mock.calls[index]?.[0];
    if (command?.type === "initialize") return command.sessionId;
  }
  throw new Error("initialize command not sent");
}

function latestCommand<T extends ClientCommand["type"]>(
  type: T,
): Extract<ClientCommand, { type: T }> {
  for (let index = socketMock.send.mock.calls.length - 1; index >= 0; index--) {
    const command = socketMock.send.mock.calls[index]?.[0];
    if (command?.type === type) return command as Extract<ClientCommand, { type: T }>;
  }
  throw new Error(`${type} command not sent`);
}

function startFromSetup(): string {
  fireEvent.click(screen.getByRole("button", { name: "进入项目" }));
  return latestSessionId();
}

describe("App", () => {
  it("does not enable commands before a compatible protocol handshake", () => {
    socketMock.helloVersion = PROTOCOL_VERSION + 1;

    render(<App />);

    expect(screen.getByText(/协议版本不兼容/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "协议不兼容" })).toBeDisabled();
    expect(socketMock.send).not.toHaveBeenCalled();
    expect(socketMock.close).toHaveBeenCalledOnce();
  });

  it("still renders setup when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("localStorage blocked");
    });

    render(<App />);

    expect(screen.getByRole("textbox", { name: "项目目录" })).toHaveValue("E:\\default");
  });

  it("still enters chat when saving the last working directory fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("localStorage blocked");
    });

    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeInTheDocument();
  });

  it("answers extension UI requested during initialization before the first state", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: {
        kind: "select",
        title: "Choose a profile",
        options: ["safe", "fast"],
      },
    }));

    expect(screen.getByRole("dialog", { name: "Choose a profile" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "safe" }));
    expect(latestCommand("extension_ui_response")).toEqual({
      type: "extension_ui_response",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      response: { kind: "select", value: "safe" },
    });

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    expect(screen.queryByRole("dialog", { name: "Choose a profile" })).not.toBeInTheDocument();
  });

  it("drops stale extension UI on disconnect and ignores another session", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => {
      socketMock.emit?.({
        type: "extension_ui_request",
        sessionId: "e15c861c-e18f-4290-bc22-8932f3caaf4e",
        requestId: EXTENSION_REQUEST_A,
        request: { kind: "confirm", title: "Stale", message: "Ignore me" },
      });
    });
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Current", message: "Continue?" },
    }));
    expect(screen.getByText("Current")).toBeInTheDocument();

    act(() => socketMock.status?.(false));
    expect(screen.queryByRole("dialog", { name: "Current" })).not.toBeInTheDocument();
  });

  it("shows a session-correlated extension notification before state is ready", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "extension_ui_notification",
      sessionId,
      level: "warning",
      message: "项目资源已跳过",
    }));

    expect(screen.getByRole("status")).toHaveTextContent("项目资源已跳过");
  });

  it("temporarily hides the settings drawer while an extension interaction owns focus", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    expect(screen.getByRole("dialog", { name: "工作台设置" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Extension question", message: "Continue?" },
    }));
    expect(screen.queryByRole("dialog", { name: "工作台设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Extension question" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    expect(screen.getByRole("dialog", { name: "工作台设置" })).toBeInTheDocument();
  });

  it("does not discard a Key entry when an extension interaction arrives", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [{
          id: "provider",
          name: "Provider",
          configured: false,
          oauth: false,
          models: [],
        }],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "使用 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "draft-key" },
    });

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Queued extension", message: "Continue?" },
    }));
    expect(screen.getByRole("dialog", { name: "Provider API Key" })).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("draft-key");
    expect(screen.queryByRole("dialog", { name: "Queued extension" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("dialog", { name: "Queued extension" })).toBeInTheDocument();
  });

  it("does not add a message when prompt sending fails", () => {
    socketMock.send.mockReturnValue(false);

    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.queryAllByText("hello", { selector: "article" })).toHaveLength(0);
    expect(input).toHaveValue("hello");
  });

  it("commits a prompt to the transcript only after the server accepts its run", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "  keep this prompt  " } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const prompt = latestCommand("prompt");

    expect(prompt.text).toBe("keep this prompt");
    expect(input).toHaveValue("  keep this prompt  ");
    expect(input).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在确认服务端已接收");
    expect(screen.queryByText("keep this prompt", { selector: "article" })).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: RUN_ID,
      event: { type: "run_queued" },
    }));
    expect(input).toHaveValue("  keep this prompt  ");

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: prompt.runId,
      event: { type: "run_queued" },
    }));
    expect(input).toHaveValue("");
    expect(screen.getByText("keep this prompt", { selector: "article" })).toBeInTheDocument();
  });

  it("restores an unacknowledged prompt after reconnect without resending it", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "uncertain prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(latestCommand("prompt").sessionId).toBe(sessionId);

    act(() => socketMock.status?.(false));
    expect(input).toHaveValue("uncertain prompt");
    expect(screen.getByRole("alert")).toHaveTextContent("发送状态未确认");

    act(() => {
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    const reconnectSessionId = latestSessionId();
    expect(reconnectSessionId).not.toBe(sessionId);
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: reconnectSessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("uncertain prompt");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);
  });

  it("ignores state and events from a closed session epoch", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /Pi Web/ }));

    act(() => {
      socketMock.emit?.({
        type: "session_event",
        sessionId,
        runId: "fc134491-e5f2-44a8-973b-23364b6e3c1a",
        event: { type: "text_delta", delta: "stale response" },
      });
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "workspace_write",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
    });

    expect(screen.getByRole("textbox", { name: "项目目录" })).toBeInTheDocument();
    expect(screen.queryByText("stale response")).not.toBeInTheDocument();
  });

  it("hydrates persistent history and ignores a snapshot for another conversation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    act(() => {
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        messages: [{
          id: "persisted-user",
          role: "user",
          text: "persisted question",
          thinking: "",
          tools: [],
        }, {
          id: "persisted-assistant",
          role: "assistant",
          text: "persisted answer",
          thinking: "",
          tools: [],
        }],
        truncated: false,
      });
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        messages: [{
          id: "stale",
          role: "assistant",
          text: "wrong conversation",
          thinking: "",
          tools: [],
        }],
        truncated: false,
      });
    });

    expect(screen.getByText("persisted question", { selector: "article" })).toBeInTheDocument();
    expect(screen.getByText("persisted answer").closest("article")).toBeInTheDocument();
    expect(screen.queryByText("wrong conversation")).not.toBeInTheDocument();
  });

  it("waits for the matching conversation snapshot before enabling prompts", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "正在恢复项目对话…");

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_B,
      messages: [],
      truncated: false,
    }));
    expect(input).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      messages: [],
      truncated: false,
    }));
    expect(input).toBeEnabled();

    fireEvent.change(input, { target: { value: "safe after hydrate" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(latestCommand("prompt")).toMatchObject({
      sessionId,
      text: "safe after hydrate",
    });
  });

  it("opens a listed project conversation with a fresh connection epoch", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    act(() => socketMock.emit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      conversations: [{
          id: CONVERSATION_ID,
          name: "Current",
          preview: "current",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 2,
        }, {
          id: CONVERSATION_B,
          name: "Older work",
          preview: "older",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z",
          messageCount: 4,
      }],
      truncated: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    fireEvent.click(screen.getByRole("button", { name: /Older work/ }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId: CONVERSATION_B },
    });
    expect(latestCommand("initialize").sessionId).not.toBe(sessionId);
  });

  it("does not unlock a running prompt for an unrelated settings error", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    act(() => socketMock.emit?.({
      type: "error",
      scope: "settings",
      sessionId,
      message: "settings write failed",
    }));

    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(screen.queryByText("settings write failed", { selector: "article" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("settings write failed");
  });

  it("correlates prompt, abort, finish, and close with one session run", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const prompt = latestCommand("prompt");
    expect(prompt).toMatchObject({ sessionId, text: "hello" });
    expect(prompt.runId).toMatch(/^[0-9a-f-]{36}$/i);
    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: prompt.runId,
      event: { type: "run_queued" },
    }));
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(latestCommand("abort")).toEqual({
      type: "abort",
      sessionId,
      runId: prompt.runId,
    });

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: prompt.runId,
      event: { type: "run_finished", outcome: "aborted" },
    }));

    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Pi Web/ }));
    expect(latestCommand("close_session")).toEqual({ type: "close_session", sessionId });
  });

  it("only a matching prompt error clears the outstanding run", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const prompt = latestCommand("prompt");

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId: "00f4700e-0746-4c14-b453-aabf8f954413",
      message: "other run failed",
    }));
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId: prompt.runId,
      message: "prompt failed",
    }));
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toHaveValue("hello");
    expect(screen.getByText(/消息未被服务端接收/)).toBeInTheDocument();
    expect(screen.queryByText("hello", { selector: "article" })).not.toBeInTheDocument();
  });

  it("invalidates an active session when a reconnect negotiates another protocol", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    act(() => socketMock.emit?.({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION + 1,
      startupCwd: "E:\\default",
    }));

    expect(screen.getByRole("textbox", { name: "项目目录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "协议不兼容" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" })).not.toBeInTheDocument();
    expect(socketMock.close).toHaveBeenCalledOnce();
  });

  it("ignores auth frames from a cancelled or superseded OAuth flow", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [{
          id: "oauth",
          name: "OAuth",
          configured: false,
          oauth: true,
          models: [],
        }],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    fireEvent.click(screen.getByRole("button", { name: "登录订阅账户" }));
    const first = latestCommand("login_oauth");
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(latestCommand("cancel_auth")).toMatchObject({ authFlowId: first.authFlowId });

    act(() => {
      socketMock.emit?.({
        type: "auth_request",
        authFlowId: first.authFlowId,
        requestId: "late-request",
        request: { kind: "prompt", message: "late prompt" },
      });
      socketMock.emit?.({
        type: "auth_progress",
        authFlowId: first.authFlowId,
        message: "late progress",
      });
    });
    expect(screen.queryByRole("dialog", { name: "登录订阅账户" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "登录订阅账户" }));
    const second = latestCommand("login_oauth");
    expect(second.authFlowId).not.toBe(first.authFlowId);
    act(() => socketMock.emit?.({
      type: "auth_complete",
      authFlowId: first.authFlowId,
      provider: "oauth",
    }));
    expect(screen.getByRole("dialog", { name: "登录订阅账户" })).toHaveTextContent("正在启动登录");

    act(() => socketMock.emit?.({
      type: "auth_request",
      authFlowId: second.authFlowId,
      requestId: "current-request",
      request: { kind: "prompt", message: "Current code" },
    }));
    const authInput = screen.getByRole("dialog", { name: "登录订阅账户" }).querySelector("input");
    if (!authInput) throw new Error("auth input not rendered");
    fireEvent.change(authInput, {
      target: { value: "123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(latestCommand("auth_response")).toMatchObject({
      authFlowId: second.authFlowId,
      requestId: "current-request",
      value: "123",
    });
  });

  it("derives tool approval from current run state and sends an exactly scoped response", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const runId = "13f17393-974b-49a0-9c6a-3176f775912a";
    const approvalId = "8f310256-f2ab-481d-8ca2-f20a43392ba3";
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
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
            reason: "此工具将执行本地命令。",
          }],
        },
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(screen.getByRole("dialog", { name: "工具执行审批" })).toHaveTextContent("npm test");
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));

    expect(latestCommand("tool_approval_response")).toEqual({
      type: "tool_approval_response",
      sessionId,
      runId,
      approvalId,
      decision: "allow",
    });
    fireEvent.click(screen.getByRole("button", { name: "停止本次运行" }));
    expect(latestCommand("abort")).toEqual({ type: "abort", sessionId, runId });
  });

  it("changes the server-owned tool mode from the connection drawer", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "read_only" },
    });

    expect(latestCommand("set_tool_mode")).toEqual({
      type: "set_tool_mode",
      sessionId,
      mode: "read_only",
    });

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    act(() => socketMock.emit?.({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\default",
    }));
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      toolMode: "read_only",
      conversation: { kind: "open", conversationId: CONVERSATION_ID },
    });
  });

  it("does not mistake an unrelated state refresh for API Key success", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const provider = {
      id: "provider",
      name: "Provider",
      configured: true,
      oauth: false,
      models: [],
    };
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [provider],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));
    const command = latestCommand("set_api_key");
    expect(command.sessionId).toBe(sessionId);

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        providers: [{ ...provider }],
      },
    }));
    expect(screen.getByRole("dialog", { name: "Provider API Key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "set_api_key",
      commandId: command.commandId,
      sessionId,
      message: "credential write failed",
    }));
    expect(screen.getByRole("dialog", { name: "Provider API Key" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("credential write failed");
    expect(screen.queryByText(/API Key 已保存/)).not.toBeInTheDocument();
  });

  it("disables tool-mode changes immediately after a prompt is sent", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "start work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));

    expect(screen.getByRole("combobox", { name: "工具权限" })).toBeDisabled();
  });

  it("keeps restrictive mode intent across a lost acknowledgement and reconnect", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "read_only" },
    });
    expect(localStorage.getItem("piweb.toolMode")).toBe("read_only");

    act(() => socketMock.emit?.({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\default",
    }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      toolMode: "read_only",
    });
  });

  it("does not assume a permission expansion succeeded before acknowledgement", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /provider \/ model/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "workspace_write" },
    });

    act(() => socketMock.emit?.({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\default",
    }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      toolMode: "read_only",
    });
  });

  it("hides an invalid pending approval while the transport is offline", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        activeRun: {
          id: RUN_ID,
          phase: "running",
          pendingApprovals: [{
            approvalId: APPROVAL_A,
            toolCallId: "tool-a",
            toolName: "bash",
            args: { command: "npm test" },
          }],
        },
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByRole("dialog", { name: "工具执行审批" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

    act(() => socketMock.status?.(false));

    expect(screen.queryByRole("dialog", { name: "工具执行审批" })).not.toBeInTheDocument();
    expect(screen.getByText("本地服务已断开，正在重连…")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();
  });

  it("requires a fresh gesture before deciding the next queued approval", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const stateWith = (pendingApprovals: NonNullable<Extract<ServerEvent, { type: "state" }>["state"]["activeRun"]>["pendingApprovals"]): TestServerEvent => ({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        activeRun: {
          id: RUN_ID,
          phase: "running",
          pendingApprovals,
        },
        thinkingLevel: "off",
        toolMode: "workspace_write",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    });
    const approvalA = {
      approvalId: APPROVAL_A,
      toolCallId: "tool-a",
      toolName: "bash",
      args: { command: "first" },
    };
    const approvalB = {
      approvalId: APPROVAL_B,
      toolCallId: "tool-b",
      toolName: "bash",
      args: { command: "second" },
    };
    act(() => socketMock.emit?.(stateWith([approvalA, approvalB])));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    act(() => socketMock.emit?.(stateWith([approvalB])));

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(socketMock.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "tool_approval_response")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "处理下一项" }));
    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(latestCommand("tool_approval_response")).toMatchObject({
      approvalId: APPROVAL_B,
      runId: RUN_ID,
    });
  });

  it("ignores callbacks from a socket instance disposed by StrictMode", () => {
    render(<StrictMode><App /></StrictMode>);
    expect(socketMock.instances.length).toBeGreaterThanOrEqual(2);
    const stale = socketMock.instances[0]!;

    act(() => {
      stale.status(false);
      stale.emit({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION + 1,
        startupCwd: "E:\\stale",
      });
    });

    expect(screen.getByRole("button", { name: "进入项目" })).toBeEnabled();
    expect(screen.queryByText(/协议版本不兼容/)).not.toBeInTheDocument();
  });
});
