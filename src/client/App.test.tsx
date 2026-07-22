// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
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
  if (!screen.queryByRole("textbox", { name: "项目目录" })) {
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
  }
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
    defaultThinkingLevel: "off",
    toolMode: "read_only",
    canManageSessions: true,
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:00:00.000Z",
    available: true,
    ...overrides,
  };
}

describe("App", () => {
  it("shows an empty workbench before the first workspace is opened", () => {
    render(<App />);

    expect(screen.getByRole("navigation", { name: "工作区" }))
      .toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有打开工作区" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "项目目录" }))
      .not.toBeInTheDocument();
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize" }),
    );
  });

  it("remembers an opened workspace and restores the last one on startup", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\last",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\last");

    render(<App />);

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\last",
      conversation: { kind: "recent" },
    });
    expect(screen.getByRole("button", { name: "打开工作区 last" }))
      .toHaveAttribute("aria-current", "true");
  });

  it("switches workspaces through the left rail", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;

    fireEvent.click(screen.getByRole("button", {
      name: "打开工作区 second",
    }));

    expect(socketMock.send).toHaveBeenCalledWith({
      type: "close_session",
      sessionId: firstSessionId,
    });
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "recent" },
    });
    expect(localStorage.getItem("piweb.lastCwd")).toBe("E:\\second");
  });

  it("keeps global project activity visible across workspace switches", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
      "E:\\omitted",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);

    act(() => socketMock.emit?.({
      type: "project_activity_snapshot",
      projects: [{
        projectId: PROJECT_ID,
        cwd: "E:\\first",
        busyConversationCount: 1,
        attentionConversationCount: 0,
      }, {
        projectId: "8177b28d-c21d-40c2-b45f-6714ae096421",
        cwd: "E:\\second",
        busyConversationCount: 0,
        attentionConversationCount: 2,
      }],
      truncated: true,
    }));

    expect(screen.getByRole("button", {
      name: "打开工作区 first（1 个会话忙碌中）",
    })).toBeInTheDocument();
    const second = screen.getByRole("button", {
      name: "打开工作区 second（2 个会话需要注意）",
    });
    fireEvent.click(second);

    expect(screen.getByRole("button", {
      name: "打开工作区 first（1 个会话忙碌中）",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "打开工作区 second（2 个会话需要注意）",
    })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", {
      name: "打开工作区 omitted（活动状态未知）",
    })).toBeInTheDocument();

    act(() => socketMock.status?.(false));
    expect(screen.getByRole("button", { name: "打开工作区 first" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开工作区 second" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开工作区 omitted" }))
      .toBeInTheDocument();
  });

  it("keeps a missing workspace visible and allows switching away", () => {
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\missing",
      "E:\\other",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\missing");
    render(<App />);
    const missing = latestCommand("initialize");

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: missing.commandId,
      sessionId: missing.sessionId,
      message: "Directory does not exist",
    }));

    expect(screen.getByRole("heading", { name: "工作区不可用" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "打开工作区 missing（不可用）",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "打开工作区 other",
    }));
    expect(latestCommand("initialize").cwd).toBe("E:\\other");
    expect(JSON.parse(localStorage.getItem("piweb.workspaces") ?? "[]"))
      .toEqual(["E:\\missing", "E:\\other"]);
  });

  it("removes an unavailable workspace and opens the remaining workspace", () => {
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\other",
      "E:\\missing",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\missing");
    render(<App />);
    const missing = latestCommand("initialize");

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: missing.commandId,
      sessionId: missing.sessionId,
      message: "Directory does not exist",
    }));
    fireEvent.click(screen.getByRole("button", { name: "从列表移除" }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\other",
      conversation: { kind: "recent" },
    });
    expect(JSON.parse(localStorage.getItem("piweb.workspaces") ?? "[]"))
      .toEqual(["E:\\other"]);
    expect(localStorage.getItem("piweb.lastCwd")).toBe("E:\\other");
    expect(screen.queryByRole("button", {
      name: /打开工作区 missing/,
    })).not.toBeInTheDocument();
  });

  it("browses folders in-app and selects only from the matching listing", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
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
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
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
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
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
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
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

    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
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

    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
    expect(screen.getByRole("textbox", { name: "项目目录" })).toHaveValue("E:\\default");
  });

  it("starts projects without a global tool permission", () => {
    render(<App />);

    startFromSetup();

    expect(latestCommand("initialize")).not.toHaveProperty("toolMode");
  });

  it("ignores the removed global tool-mode preference", () => {
    localStorage.setItem("piweb.toolMode", "workspace_write");
    render(<App />);
    const sessionId = startFromSetup();

    expect(latestCommand("initialize")).not.toHaveProperty("toolMode");

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
    expect(localStorage.getItem("piweb.toolMode")).toBe("workspace_write");
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

  it("manually compacts only the exact focused conversation", () => {
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

    const button = screen.getByRole("button", { name: "手动压缩上下文" });
    fireEvent.click(button);
    const command = latestCommand("compact_context");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
    });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status", { name: "正在压缩上下文" }))
      .toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "compact_context",
      commandId: command.commandId,
      sessionId,
    }));
    expect(button).toBeEnabled();
    expect(screen.getByText("上下文已压缩")).toBeInTheDocument();
  });

  it("projects automatic compaction progress from focused state", () => {
    render(<App />);
    const sessionId = startFromSetup();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        compacting: true,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(screen.getByRole("status", { name: "正在压缩上下文" }))
      .toBeInTheDocument();
  });

  it("switches an idle focused conversation role with exact command correlation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const nextRole = defaultRole({
      id: "21f01ca1-e28e-4f5e-bb46-442a2fdadafd",
      revision: 2,
      name: "Builder",
      systemPrompt: "Build carefully.",
      toolMode: "full_access",
    });
    act(() => {
      socketMock.emit?.({
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
      });
      socketMock.emit?.({
        type: "role_catalog_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        roles: [defaultRole(), nextRole],
      });
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        role: {
          id: "default",
          revision: 1,
          name: "Default",
          description: "General purpose",
          systemPrompt: "Be useful.",
          model: { provider: "provider", id: "model" },
          defaultThinkingLevel: "off",
          toolMode: "read_only",
          canManageSessions: true,
        },
        messages: [],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", {
      name: "查看会话角色 Default",
    }));
    fireEvent.change(screen.getByRole("combobox", {
      name: "选择新的会话角色",
    }), {
      target: { value: nextRole.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用角色" }));

    const command = latestCommand("switch_conversation_role");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      roleId: nextRole.id,
    });
    expect(screen.getByRole("button", { name: "正在更换…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "switch_conversation_role",
      commandId: "3d227a2c-2f51-4811-8844-e8e566b09f05",
      sessionId,
    }));
    expect(screen.getByRole("button", { name: "正在更换…" })).toBeDisabled();

    act(() => {
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        role: {
          id: nextRole.id,
          revision: nextRole.revision,
          name: nextRole.name,
          description: nextRole.description,
          systemPrompt: nextRole.systemPrompt,
          model: nextRole.model!,
          defaultThinkingLevel: nextRole.defaultThinkingLevel,
          toolMode: nextRole.toolMode,
          canManageSessions: nextRole.canManageSessions,
        },
        messages: [],
        truncated: false,
      });
      socketMock.emit?.({
        type: "command_complete",
        operation: "switch_conversation_role",
        commandId: command.commandId,
        sessionId,
      });
    });

    expect(screen.getByText("会话角色已更换")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Builder" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("rewinds only a user message and restores its text over the current draft", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<App />);
    const sessionId = startFromSetup();
    const userMessageId = "91bbd4c8-29ff-4598-b672-e62354411398";
    const assistantEntryId = "323f17e4-4d9f-4642-a22d-b007ca75765a";
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
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        items: [{
          kind: "message",
          id: userMessageId,
          role: "user",
          text: "需要保留吗？",
          thinking: "",
          tools: [],
        }, {
          kind: "message",
          id: `assistant:${assistantEntryId}`,
          role: "assistant",
          text: "**Agent 原文**",
          thinking: "",
          tools: [],
        }],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "复制用户消息" }));
    expect(writeText).toHaveBeenCalledWith("需要保留吗？");
    expect(screen.getByRole("button", { name: "复制 Agent 回复" }))
      .toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "现有草稿会被覆盖" } });

    const rewind = screen.getByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    });
    fireEvent.click(rewind);
    const command = latestCommand("truncate_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messageId: userMessageId,
    });
    expect(screen.getByText("正在彻底删除所选消息及之后的内容…"))
      .toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(input).toHaveValue("需要保留吗？");

    act(() => {
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        items: [],
        truncated: false,
      });
      socketMock.emit?.({
        type: "command_complete",
        operation: "truncate_conversation",
        commandId: command.commandId,
        sessionId,
      });
    });

    expect(screen.queryByText("Agent 原文")).not.toBeInTheDocument();
    expect(screen.getByText("已回到所选消息之前")).toBeInTheDocument();
    const restoredInput = screen.getByRole("textbox", {
      name: "给 Pi 发送消息",
    });
    expect(restoredInput).toBeEnabled();
    expect(restoredInput).toHaveValue("需要保留吗？");
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

  it("restores an unacknowledged prompt after switching projects without leaking it", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: firstSessionId,
        cwd: "E:\\first",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "pending across projects" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在确认服务端已接收");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    const secondSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: secondSessionId,
        cwd: "E:\\second",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByText("pending across projects", { selector: "article" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const returnedSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: returnedSessionId,
        cwd: "E:\\first",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("pending across projects");
    expect(screen.getByRole("alert")).toHaveTextContent("发送状态未确认");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);
  });

  it("keeps queued prompts scoped while switching projects", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: firstSessionId,
        cwd: "E:\\first",
        busy: true,
        activeRun: { id: RUN_ID, phase: "queued" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "queued for first" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("queued for first");

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    const secondSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: secondSessionId,
        cwd: "E:\\second",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const returnedSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: returnedSessionId,
        cwd: "E:\\first",
        busy: true,
        activeRun: { id: RUN_ID, phase: "queued" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("queued for first");
  });

  it("coalesces browser resume signals into one exact view refresh", async () => {
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
    socketMock.send.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(socketMock.send).toHaveBeenCalledTimes(1);
    });
    expect(latestCommand("refresh_view")).toEqual({
      type: "refresh_view",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
    });
  });

  it("does not refresh while a prompt handoff is unacknowledged", async () => {
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
    fireEvent.change(screen.getByRole("textbox", {
      name: "给 Pi 发送消息",
    }), { target: { value: "keep this handoff stable" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(latestCommand("prompt").sessionId).toBe(sessionId);
    socketMock.send.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });

    expect(socketMock.send).not.toHaveBeenCalled();
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
    fireEvent.change(screen.getByRole("textbox", { name: "项目目录" }), {
      target: { value: "E:\\other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入项目" }));

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

    expect(screen.getByRole("heading", { name: "正在打开工作区" }))
      .toBeInTheDocument();
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

  it("does not carry a pending deletion into another workspace", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId: firstSessionId,
          cwd: "E:\\first",
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
        sessionId: firstSessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "Current",
          preview: "",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "Delete me",
          preview: "",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Delete me" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(screen.getByRole("button", { name: "删除会话 Delete me" }))
      .toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    const secondSessionId = latestCommand("initialize").sessionId;
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId: secondSessionId,
          cwd: "E:\\second",
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
        sessionId: secondSessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_B,
          name: "Second project",
          preview: "",
          createdAt: "2026-07-20T12:00:00.000Z",
          updatedAt: "2026-07-20T12:01:00.000Z",
          messageCount: 0,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });

    expect(screen.getByRole("button", { name: "删除会话 Second project" }))
      .toBeEnabled();
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
    expect(screen.getByRole("button", { name: "使用 Default 开始会话" }))
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
    fireEvent.change(screen.getByRole("textbox", { name: "项目目录" }), {
      target: { value: "E:\\other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入项目" }));
    expect(latestCommand("close_session")).toEqual({ type: "close_session", sessionId });
  });

  it("aggregates waiting messages into one guidance command as soon as the run can accept it", () => {
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
    fireEvent.change(input, { target: { value: "first task" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const first = latestCommand("prompt");
    act(() => {
      socketMock.emit?.({
        type: "session_event",
        sessionId,
        runId: first.runId,
        event: { type: "run_queued" },
      });
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          activeRun: { id: first.runId, phase: "queued" },
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
    });

    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "second task" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.change(input, { target: { value: "third task" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(input).toHaveValue("");
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("接下来处理 2 条");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "steer",
    )).toHaveLength(0);

    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          activeRun: { id: first.runId, phase: "running" },
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
    });

    const guidanceCommands = socketMock.send.mock.calls
      .map(([command]) => command)
      .filter((command): command is Extract<ClientCommand, { type: "steer" }> =>
        command.type === "steer"
      );
    expect(guidanceCommands).toHaveLength(1);
    const guidance = guidanceCommands[0]!;
    expect(guidance).toMatchObject({
      conversationId: CONVERSATION_ID,
      runId: first.runId,
      text: "second task\n\nthird task",
    });
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("正在提交");

    act(() => {
      socketMock.emit?.({
        type: "command_complete",
        operation: "steer",
        commandId: guidance.commandId,
        sessionId,
      });
    });
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();
  });

  it("keeps busy prompt queues isolated while switching conversations", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          activeRun: { id: RUN_ID, phase: "queued" },
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
          activity: { kind: "queued", runId: RUN_ID },
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

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "only for A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("only for A");

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
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
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
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      messages: [],
      truncated: false,
    }));

    expect(latestCommand("prompt")).toMatchObject({
      conversationId: CONVERSATION_ID,
      text: "only for A",
    });
  });

  it("allows switching conversations while guidance delivery is pending", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          activeRun: { id: RUN_ID, phase: "running" },
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
          activity: { kind: "running", runId: RUN_ID },
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

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "guide A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const guidance = latestCommand("steer");
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("正在提交");

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(latestCommand("focus_conversation").conversationId)
      .toBe(CONVERSATION_B);
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        activeRun: { id: RUN_B, phase: "running" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "guide B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const guidanceB = latestCommand("steer");
    expect(guidanceB).toMatchObject({
      conversationId: CONVERSATION_B,
      runId: RUN_B,
    });

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "steer",
      commandId: guidance.commandId,
      sessionId,
    }));
    expect(screen.getByRole("region", { name: "待发送消息" }))
      .toHaveTextContent("正在提交");
    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "steer",
      commandId: guidanceB.commandId,
      sessionId,
    }));
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        activeRun: { id: RUN_ID, phase: "running" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.queryByRole("region", { name: "待发送消息" }))
      .not.toBeInTheDocument();
  });

  it("freezes focus-bound controls as soon as a conversation switch starts", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          activeRun: { id: RUN_ID, phase: "running" },
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
    socketMock.autoFocus = false;

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));

    act(() => socketMock.emit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messages: [],
      truncated: false,
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "手动压缩上下文" }))
      .toBeDisabled();
    const abortCount = socketMock.send.mock.calls.filter(
      ([command]) => command.type === "abort",
    ).length;
    expect(screen.getByRole("button", { name: "停止" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "abort",
    )).toHaveLength(abortCount);
  });

  it("keeps a pending compaction scoped to its originating conversation", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "手动压缩上下文" }));
    const compaction = latestCommand("compact_context");
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

    expect(screen.getByRole("button", { name: "手动压缩上下文" }))
      .toHaveTextContent("手动压缩");
    const deletionCount = socketMock.send.mock.calls.filter(
      ([command]) => command.type === "delete_conversation",
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "删除会话 A" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "delete_conversation",
    )).toHaveLength(deletionCount);
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "compact_context",
      commandId: compaction.commandId,
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      message: "compaction failed",
    }));
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
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
    expect(screen.getByRole("button", { name: "手动压缩上下文" }))
      .toHaveTextContent("手动压缩");
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

    fireEvent.click(screen.getByRole("button", { name: "添加工作区" }));
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

    fireEvent.click(screen.getByRole("button", {
      name: "使用 Default 开始会话",
    }));

    expect(latestCommand("create_conversation")).toMatchObject({
      sessionId,
      roleId: "default",
    });
    expect(screen.getByRole("button", {
      name: "使用 Default 开始会话",
    })).toBeDisabled();
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
    expect(screen.getByRole("heading", { name: "正在打开工作区" }))
      .toBeInTheDocument();

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
              thinkingLevels: ["off"],
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
    fireEvent.click(screen.getByRole("button", { name: "管理角色 Default" }));
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

    expect(screen.getByRole("button", { name: "开启工作区" })).toBeEnabled();
    expect(screen.queryByText(/协议版本不兼容/)).not.toBeInTheDocument();
  });
});
