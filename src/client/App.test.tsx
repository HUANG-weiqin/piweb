// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type PublicState,
  type RoleTemplate,
  type ServerEvent,
} from "../shared/protocol";
import { App } from "./App";

const RUN_ID = "13f17393-974b-49a0-9c6a-3176f775912a";
const PROJECT_ID = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";
const CONVERSATION_ID = "0198f775-88f3-7af1-9c6a-3176f775912a";
const CONVERSATION_B = "6a04656b-72d9-43ae-b1a8-5754cfa2b7cf";
const EXTENSION_REQUEST_A = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const FOCUS_A = "ae301850-745d-44dd-a30f-5e4b30fe44e1";
const FOCUS_A_SECOND = "ae301850-745d-44dd-a30f-000000000003";

type TestState = Omit<PublicState, "projectId" | "conversationId">
  & Partial<Pick<PublicState, "projectId" | "conversationId">>;
type RelaxedConversationSnapshot = Omit<
  Extract<ServerEvent, { type: "conversation_snapshot" }>,
  "focusId"
> & { focusId?: string };
type RelaxedSessionEvent = Omit<
  Extract<ServerEvent, { type: "session_event" }>,
  "conversationId" | "focusId"
> & { conversationId?: string; focusId?: string };
type RelaxedConversationItem = Omit<
  Extract<ServerEvent, { type: "conversation_item" }>,
  "focusId"
> & { focusId?: string };
type TestServerEvent = Exclude<
  ServerEvent,
  | { type: "state" }
  | { type: "conversation_snapshot" }
  | { type: "session_event" }
  | { type: "conversation_item" }
>
  | { type: "state"; state: TestState }
  | RelaxedConversationSnapshot
  | RelaxedSessionEvent
  | RelaxedConversationItem;

function completeEvent(event: TestServerEvent): TestServerEvent {
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
  autoFocus: true,
  focusSequence: 0,
}));

vi.mock("./lib/socket", () => ({
  PiSocket: class {
    private readonly onEvent: (event: ServerEvent) => void;
    private activeFocus?: {
      conversationId: string;
      focusId: string;
    };

    constructor(onEvent: (event: ServerEvent) => void, onStatus: (online: boolean) => void) {
      this.onEvent = onEvent;
      const snapshottedConversations = new Set<string>();
      const rawEmit = (event: TestServerEvent) =>
        onEvent(completeEvent(event) as ServerEvent);
      const emit = (event: TestServerEvent) => {
        let completed = completeEvent(event);
        if (this.activeFocus && completed.type === "state") {
          completed = {
            ...completed,
            state: {
              ...completed.state,
              conversationId: this.activeFocus.conversationId,
              focusId: this.activeFocus.focusId,
            },
          };
        } else if (
          this.activeFocus
          && completed.type === "conversation_snapshot"
          && completed.conversationId === this.activeFocus.conversationId
        ) {
          completed = { ...completed, focusId: this.activeFocus.focusId };
        } else if (this.activeFocus && completed.type === "session_event") {
          completed = {
            ...completed,
            conversationId: this.activeFocus.conversationId,
            focusId: this.activeFocus.focusId,
          };
        } else if (
          this.activeFocus
          && completed.type === "conversation_item"
          && completed.conversationId === this.activeFocus.conversationId
        ) {
          completed = { ...completed, focusId: this.activeFocus.focusId };
        }
        onEvent(completed as ServerEvent);
        if (completed.type === "state") {
          if (!completed.state.conversationId) return;
          const snapshotKey =
            `${completed.state.sessionId}:${completed.state.conversationId}`;
          if (snapshottedConversations.has(snapshotKey)) return;
          snapshottedConversations.add(snapshotKey);
          if (!completed.state.focusId) return;
          onEvent({
            type: "conversation_snapshot",
            sessionId: completed.state.sessionId,
            conversationId: completed.state.conversationId,
            focusId: completed.state.focusId,
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
      const ok = socketMock.send(command);
      if (
        ok
        && socketMock.autoFocus
        && (
          command.type === "initialize"
          || command.type === "focus_conversation"
          || command.type === "create_conversation"
        )
      ) {
        const conversationId = command.type === "focus_conversation"
          ? command.conversationId
          : command.type === "initialize" && command.conversation?.kind === "open"
            ? command.conversation.conversationId
            : CONVERSATION_ID;
        const focusId = socketMock.focusSequence++ === 0
          ? FOCUS_A
          : `ae301850-745d-44dd-a30f-${String(socketMock.focusSequence).padStart(12, "0")}`;
        this.activeFocus = { conversationId, focusId };
        this.onEvent({
          type: "focus_attached",
          operation: command.type,
          commandId: command.commandId!,
          sessionId: command.sessionId,
          projectId: PROJECT_ID,
          conversationId,
          focusId,
        });
      }
      return ok;
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
  socketMock.autoFocus = true;
  socketMock.focusSequence = 0;
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

function defaultRole(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    id: "default",
    revision: 1,
    name: "Default",
    description: "General purpose",
    systemPrompt: "Be useful.",
    model: { provider: "provider", id: "model" },
    canManageSessions: true,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    available: true,
    ...overrides,
  };
}

describe("App", () => {
  it("browses folders in-app and selects only from the matching listing", () => {
    render(<App />);
    const input = screen.getByRole("textbox", { name: "项目目录" });
    fireEvent.change(input, { target: { value: "E:\\typed" } });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    const command = latestCommand("browse_directory");
    expect(command.path).toBe("E:\\typed");
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize" }),
    );

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: RUN_ID,
      path: "E:\\stale",
      parentPath: "E:\\",
      directories: [],
      truncated: false,
    }));
    expect(screen.queryByText("E:\\stale")).not.toBeInTheDocument();
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "browse_directory",
      commandId: RUN_ID,
      message: "stale listing error",
    }));
    expect(screen.queryByText("stale listing error")).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: command.commandId,
      path: "E:\\typed",
      parentPath: "E:\\",
      directories: [{
        name: "child",
        path: "E:\\typed\\child",
      }],
      truncated: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "打开文件夹 child" }));
    const childCommand = latestCommand("browse_directory");
    expect(childCommand.path).toBe("E:\\typed\\child");

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: childCommand.commandId,
      path: "E:\\typed\\child",
      parentPath: "E:\\typed",
      directories: [],
      truncated: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "选择当前文件夹" }));

    expect(input).toHaveValue("E:\\typed\\child");
    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize" }),
    );
  });

  it("keeps the typed setup path when in-app selection is cancelled", () => {
    render(<App />);
    const input = screen.getByRole("textbox", { name: "项目目录" });
    fireEvent.change(input, { target: { value: "E:\\typed" } });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(input).toHaveValue("E:\\typed");
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeEnabled();
    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();
  });

  it("keeps the directory browser usable after a correlated listing error", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const command = latestCommand("browse_directory");

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "browse_directory",
      commandId: command.commandId,
      message: "无法读取这个目录",
    }));

    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("无法读取这个目录");
    fireEvent.click(screen.getByRole("button", { name: "打开启动目录" }));
    const fallbackCommand = latestCommand("browse_directory");
    expect(fallbackCommand.commandId).not.toBe(command.commandId);
    expect(fallbackCommand.path).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "选择文件夹" })).toBeEnabled();
  });

  it("closes transient directory browsing when the socket disconnects", () => {
    render(<App />);
    const input = screen.getByRole("textbox", { name: "项目目录" });
    fireEvent.change(input, { target: { value: "E:\\typed" } });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();

    act(() => socketMock.status?.(false));

    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();
    expect(input).toHaveValue("E:\\typed");
  });

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

  it("starts new projects with full access by default", () => {
    render(<App />);

    startFromSetup();

    expect(latestCommand("initialize")).toMatchObject({
      toolMode: "full_access",
    });
  });

  it("migrates the removed workspace mode to full access", () => {
    localStorage.setItem("piweb.toolMode", "workspace_write");
    render(<App />);
    const sessionId = startFromSetup();

    expect(latestCommand("initialize")).toMatchObject({
      toolMode: "full_access",
    });

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }));
    expect(localStorage.getItem("piweb.toolMode")).toBe("full_access");
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
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        providers: [],
      },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeInTheDocument();
  });

  it("saves the focused conversation compaction threshold on slider release", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
        compactionThresholdPercent: 70,
      },
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "自动压缩 70%",
    }));
    const slider = screen.getByRole("slider", {
      name: "会话自动压缩阈值",
    });

    fireEvent.change(slider, { target: { value: "55" } });
    fireEvent.pointerUp(slider);
    const command = latestCommand("set_compaction_threshold");

    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      percent: 55,
    });
    expect(slider).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "set_compaction_threshold",
      commandId: "3d227a2c-2f51-4811-8844-e8e566b09f05",
      sessionId,
    }));
    expect(slider).toBeDisabled();

    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          compactionThresholdPercent: 55,
        },
      });
      socketMock.emit?.({
        type: "command_complete",
        operation: "set_compaction_threshold",
        commandId: command.commandId,
        sessionId,
      });
    });
    expect(slider).toBeEnabled();
    expect(screen.getByText("55%", {
      selector: ".compaction-threshold-value",
    }))
      .toBeInTheDocument();
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

  it("temporarily hides the model drawer while an extension interaction owns focus", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /^model\s*⌄$/ }));
    expect(screen.getByRole("dialog", { name: "模型连接" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Extension question", message: "Continue?" },
    }));
    expect(screen.queryByRole("dialog", { name: "模型连接" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Extension question" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    expect(screen.getByRole("dialog", { name: "模型连接" })).toBeInTheDocument();
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
          toolMode: "full_access",
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
        focusId: FOCUS_A,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
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
        focusId: FOCUS_A,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
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
      focusId: FOCUS_A,
      messages: [],
      truncated: false,
    }));
    expect(input).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
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
        toolMode: "full_access",
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
    fireEvent.click(screen.getByRole("button", {
      name: "打开会话 Older work",
    }));

    expect(latestCommand("focus_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
  });

  it("deletes a non-current project conversation with a correlated command", () => {
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
        toolMode: "full_access",
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

    fireEvent.click(screen.getByRole("button", {
      name: "删除会话 Older work",
    }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    const command = latestCommand("delete_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
    expect(screen.getByRole("button", {
      name: "删除会话 Older work",
    })).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
    }));
    expect(screen.getByText("对话已删除")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "删除会话 Older work",
    })).toBeEnabled();
  });

  it("deletes the focused idle conversation and returns to explicit role selection", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "role_catalog_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        roles: [defaultRole()],
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "Current",
          preview: "current",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 2,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Current" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    const command = latestCommand("delete_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
    });

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
    }));

    expect(screen.getByRole("heading", { name: "选择这个会话的角色" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择角色 Default" }))
      .toBeInTheDocument();
    expect(screen.getByText("对话已删除")).toBeInTheDocument();
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
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
        toolMode: "full_access",
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
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      message: "other run failed",
    }));
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "prompt",
      sessionId,
      runId: prompt.runId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
    fireEvent.click(screen.getByRole("button", { name: /^model\s*⌄$/ }));
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

  it("changes the server-owned project tool mode from the workspace header", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    fireEvent.change(screen.getByRole("combobox", { name: "项目工具权限" }), {
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

  it("persists full access only after the server confirms the expansion", () => {
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

    fireEvent.change(screen.getByRole("combobox", { name: "项目工具权限" }), {
      target: { value: "full_access" },
    });

    expect(latestCommand("set_tool_mode")).toEqual({
      type: "set_tool_mode",
      sessionId,
      mode: "full_access",
    });
    expect(localStorage.getItem("piweb.toolMode")).toBe("read_only");

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(localStorage.getItem("piweb.toolMode")).toBe("full_access");
  });

  it("keeps a full-access to read-only restriction across reconnect", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "项目工具权限" }), {
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
        toolMode: "full_access",
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
        toolMode: "full_access",
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
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "start work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByRole("combobox", { name: "项目工具权限" })).toBeDisabled();
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
    fireEvent.change(screen.getByRole("combobox", { name: "项目工具权限" }), {
      target: { value: "full_access" },
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

  it("opens an empty project on explicit role selection without exposing a composer", () => {
    socketMock.autoFocus = false;
    render(<App />);
    const sessionId = startFromSetup();
    const initialize = latestCommand("initialize");

    act(() => {
      socketMock.emit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: initialize.commandId!,
        sessionId,
        projectId: PROJECT_ID,
      });
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: undefined,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "role_catalog_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        roles: [defaultRole()],
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [],
        truncated: false,
      });
    });

    expect(screen.getByRole("heading", { name: "选择这个会话的角色" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(socketMock.send.mock.calls.some(
      ([command]) => command.type === "create_conversation",
    )).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "选择角色 Default" }));
    fireEvent.click(screen.getByRole("button", { name: "开始新会话" }));

    expect(latestCommand("create_conversation")).toMatchObject({
      sessionId,
      roleId: "default",
    });
    expect(screen.getByRole("button", { name: "正在创建会话…" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });

  it("buffers a focused state until the matching focus acknowledgement arrives", () => {
    socketMock.autoFocus = false;
    render(<App />);
    const sessionId = startFromSetup();
    const initialize = latestCommand("initialize");
    const focusId = "97fbb21a-6800-47eb-b78c-45c2d293b35e";

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByRole("textbox", { name: "项目目录" })).toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: initialize.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId,
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
  });

  it("switches a running peer from the flat sidebar without replacing the project session", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          activity: { kind: "running", runId: RUN_ID },
        }],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));

    expect(latestCommand("focus_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(1);
    expect(screen.getByRole("status", { name: "运行中" })).toBeInTheDocument();
  });

  it("drops a delayed prompt error from the previous conversation focus", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "work in A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const prompt = latestCommand("prompt");
    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: prompt.runId,
      event: { type: "run_queued" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "error",
        scope: "command",
        operation: "prompt",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        runId: prompt.runId,
        message: "late A failure",
      });
    });

    expect(screen.queryByText("late A failure")).not.toBeInTheDocument();
    expect(
      screen.queryByText("late A failure", { selector: "article" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the current draft while background activity updates the project list", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "draft for A" } });

    act(() => socketMock.emit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      conversations: [{
        id: CONVERSATION_ID,
        name: "A",
        preview: "",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T08:00:00.000Z",
        messageCount: 0,
        activity: { kind: "idle" },
      }, {
        id: CONVERSATION_B,
        name: "B",
        preview: "",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T09:00:00.000Z",
        messageCount: 0,
        attention: true,
        activity: { kind: "running", runId: RUN_ID },
      }],
      truncated: false,
    }));

    expect(input).toHaveValue("draft for A");
    expect(screen.getByRole("status", { name: "运行中" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "需要处理" })).toBeInTheDocument();
  });

  it("returns to role selection only for an exact focus invalidation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    const composer = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(composer, { target: { value: "do not leak me" } });

    act(() => socketMock.rawEmit?.({
      type: "focus_invalidated",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
      reason: "deleted",
    }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("do not leak me");

    act(() => socketMock.rawEmit?.({
      type: "focus_invalidated",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      reason: "deleted",
    }));
    expect(screen.getByRole("heading", {
      name: "选择这个会话的角色",
    })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });

  it("uses the focusId to reject late A frames across an A-B-A navigation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 0,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
        }],
        truncated: false,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "stale-a",
          role: "assistant",
          text: "late from first A focus",
          thinking: "",
          tools: [],
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        messages: [{
          id: "fresh-a",
          role: "assistant",
          text: "fresh second A focus",
          thinking: "",
          tools: [],
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_item",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        item: {
          kind: "message",
          id: "stale-live-a",
          role: "assistant",
          text: "late live item",
          thinking: "",
          tools: [],
        },
      });
    });

    expect(screen.getByText("fresh second A focus")).toBeInTheDocument();
    expect(screen.queryByText("late from first A focus")).not.toBeInTheDocument();
    expect(screen.queryByText("late live item")).not.toBeInTheDocument();
  });

  it("hydrates and updates a first-class session message card in place", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    const card = {
      kind: "session_message" as const,
      id: "card-item",
      cardId: "11c51221-a321-44d4-8f29-502f77f0a799",
      direction: "outgoing" as const,
      state: "queued" as const,
      body: "review this",
      from: {
        conversationId: CONVERSATION_ID,
        title: "A",
        role: { id: "default", name: "Default" },
      },
      to: {
        conversationId: CONVERSATION_B,
        title: "B",
        role: { id: "default", name: "Default" },
      },
      sentAt: "2026-07-19T09:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      peerExists: true,
    };
    act(() => socketMock.emit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      items: [card],
      truncated: false,
    }));
    expect(screen.getByRole("status", { name: "消息状态：已排队" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开会话" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {
      name: "展开发出的会话消息：B",
    }));
    expect(screen.getByRole("button", { name: "打开会话" }))
      .toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "conversation_item",
      sessionId,
      conversationId: CONVERSATION_ID,
      item: {
        ...card,
        state: "completed",
        result: "looks good",
        updatedAt: "2026-07-19T09:01:00.000Z",
        peerExists: false,
      },
    }));

    expect(screen.getByRole("status", { name: "消息状态：已完成" }))
      .toBeInTheDocument();
    expect(screen.getByText("looks good")).toBeInTheDocument();
    expect(document.querySelectorAll(
      "[data-card-id='11c51221-a321-44d4-8f29-502f77f0a799']",
    )).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "打开会话" }))
      .not.toBeInTheDocument();
  });

  it("opens role management and settles edits only for the exact command", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [{
            id: "provider",
            name: "Provider",
            configured: true,
            oauth: false,
            models: [{
              provider: "provider",
              id: "model",
              name: "Model",
              reasoning: false,
              input: ["text"],
              contextWindow: 100_000,
              available: true,
            }],
          }],
        },
      });
      socketMock.emit?.({
        type: "role_catalog_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        roles: [defaultRole()],
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByRole("button", { name: "管理角色" }));
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Edited default" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    const update = latestCommand("update_role");

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "update_role",
      commandId: "3d227a2c-2f51-4811-8844-e8e566b09f05",
      sessionId,
    }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "update_role",
      commandId: update.commandId,
      sessionId,
    }));
    expect(screen.getByRole("status")).toHaveTextContent("角色已保存");
    expect(screen.getByRole("button", { name: "删除角色" }))
      .toBeInTheDocument();
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
