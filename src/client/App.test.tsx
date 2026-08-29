// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, type ComponentProps } from "react";
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
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type PublicState,
  type RoleTemplate,
  type ServerEvent,
} from "../shared/protocol";
import {
  App,
  MAX_CACHED_WORKSPACES,
  MAX_CACHED_CONVERSATION_PRESENTATIONS,
  forgetConversationPresentation,
  getConversationPresentation,
  getWorkspaceProjection,
  rememberConversationPresentation,
  rememberWorkspaceProjection,
  forgetWorkspaceProjection,
} from "./App";

const RUN_ID = "13f17393-974b-49a0-9c6a-3176f775912a";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
const PROJECT_ID = "f25ee8d8-34f0-4c30-a045-b2a69f2e28bd";
const CONVERSATION_ID = "0198f775-88f3-7af1-9c6a-3176f775912a";
const CONVERSATION_B = "6a04656b-72d9-43ae-b1a8-5754cfa2b7cf";
const CONVERSATION_C = "a11981c1-172f-4377-a082-3fb0f8c87519";
const CONVERSATION_D = "7ed35f55-20e8-46f2-badc-6404f34f8b4a";
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

const completionSoundMock = vi.hoisted(() => ({
  instances: [] as Array<{
    unlock: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./lib/completion-sound", () => ({
  createCompletionSound: () => {
    const sound = {
      unlock: vi.fn(async () => undefined),
      play: vi.fn(),
      dispose: vi.fn(),
    };
    completionSoundMock.instances.push(sound);
    return sound;
  },
}));

const renderIsolationMock = vi.hoisted(() => ({
  chat: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./components/Message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/Message")>();
  const { createElement, memo } = await import("react");
  function MessageRenderProbe(props: ComponentProps<typeof actual.Message>) {
    renderIsolationMock.message(props.message.id);
    return createElement(actual.Message, props);
  }
  return { ...actual, Message: memo(MessageRenderProbe) };
});

vi.mock("./components/Chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/Chat")>();
  const { createElement, memo } = await import("react");
  function ChatRenderProbe(props: ComponentProps<typeof actual.Chat>) {
    renderIsolationMock.chat();
    return createElement(actual.Chat, props);
  }
  return { ...actual, Chat: memo(ChatRenderProbe) };
});

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
            `${completed.state.sessionId}:${completed.state.conversationId}:${completed.state.focusId}`;
          if (snapshottedConversations.has(snapshotKey)) return;
          snapshottedConversations.add(snapshotKey);
          if (!completed.state.focusId) return;
          onEvent({
            type: "conversation_snapshot",
            sessionId: completed.state.sessionId,
            conversationId: completed.state.conversationId,
            focusId: completed.state.focusId,
            messages: [],
            window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
  completionSoundMock.instances.splice(0);
  renderIsolationMock.chat.mockClear();
  renderIsolationMock.message.mockClear();
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

function conversationSummary(
  id: string,
  name: string,
  updatedAt = "2026-07-19T08:00:00.000Z",
): ConversationSummary {
  return {
    id,
    name,
    preview: name,
    createdAt: "2026-07-19T08:00:00.000Z",
    updatedAt,
    messageCount: 1,
    activity: { kind: "idle" },
  };
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

function defaultConversationRole(
  overrides: Partial<ConversationRoleSnapshot> = {},
): ConversationRoleSnapshot {
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
    ...overrides,
  };
}

type ConversationPreviewEvent = Extract<
  ServerEvent,
  { type: "conversation_preview" }
>;

function conversationPreview(
  identity: Pick<ConversationPreviewEvent, "sessionId" | "commandId">,
  conversationId: string,
  text: string,
  overrides: Partial<Pick<
    ConversationPreviewEvent,
    "projectId" | "cwd" | "toolMode" | "role" | "window"
  >> = {},
): ConversationPreviewEvent {
  return {
    type: "conversation_preview",
    projectId: PROJECT_ID,
    conversationId,
    cwd: "E:\\work",
    toolMode: "read_only",
    role: defaultConversationRole(),
    items: [{
      kind: "message",
      id: `preview-${text}`,
      role: "user",
      text,
      thinking: "",
      tools: [],
    }],
    window: {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    },
    ...identity,
    ...overrides,
  };
}

const completeConversationWindow = {
  omittedBefore: false,
  startsMidTurn: false,
  contentTruncated: false,
};

function startFocusReplacementProject(
  extraConversations: ConversationSummary[] = [
    conversationSummary(CONVERSATION_B, "B", "2026-07-19T09:00:00.000Z"),
    conversationSummary(CONVERSATION_C, "C", "2026-07-19T10:00:00.000Z"),
  ],
): string {
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
        toolMode: "read_only",
        availableThinkingLevels: ["off", "high"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    });
    socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [
        conversationSummary(CONVERSATION_ID, "A"),
        ...extraConversations,
      ],
      truncated: false,
    });
    socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messages: [{
        id: "focus-replacement-source-a",
        role: "user",
        text: "focus replacement source A",
        thinking: "",
        tools: [],
      }],
      window: completeConversationWindow,
    });
  });
  socketMock.autoFocus = false;
  return sessionId;
}

function sentFocusCommandCount(): number {
  return socketMock.send.mock.calls.filter(
    ([command]) => command.type === "focus_conversation",
  ).length;
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

  it("hydrates LoopList from focused snapshots and ignores stale live identities", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off", "high"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [],
        loopList: {
          items: [{ id: "focused", text: "Focused item", checked: false }],
          armed: false,
        },
        window: completeConversationWindow,
      });
    });
    expect(screen.getByRole("region", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("已暂停")).toBeInTheDocument();

    act(() => {
      socketMock.rawEmit?.({
        type: "loop_list_update",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        loopList: {
          items: [{ id: "focused", text: "Focused item", checked: true }],
          armed: false,
        },
      });
    });
    expect(screen.getByText("已暂停")).toBeInTheDocument();

    act(() => {
      socketMock.rawEmit?.({
        type: "loop_list_update",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        loopList: {
          items: [{ id: "focused", text: "Focused item", checked: true }],
          armed: false,
        },
      });
    });
    expect(screen.getByText("已完成")).toBeInTheDocument();

    act(() => {
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [],
        loopList: { items: [], armed: false },
        window: completeConversationWindow,
      });
    });
    expect(screen.queryByRole("region", { name: "Tasks" })).not.toBeInTheDocument();
  });

  it("plays one project-scoped chime for a completed user run", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const sound = completionSoundMock.instances.at(-1)!;

    act(() => socketMock.rawEmit?.({
      type: "conversation_run_settled",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      runId: RUN_ID,
      outcome: "completed",
      createdBy: { kind: "user" },
    }));

    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  it("does not chime for replayable projections, non-user outcomes, or stale observations", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const sound = completionSoundMock.instances.at(-1)!;
    const snapshotWindow = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };

    act(() => {
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [],
        window: snapshotWindow,
      });
      socketMock.rawEmit?.({
        type: "conversation_run_settled",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        runId: RUN_ID,
        outcome: "completed",
        createdBy: { kind: "conversation", conversationId: CONVERSATION_ID },
      });
      socketMock.rawEmit?.({
        type: "conversation_run_settled",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        runId: RUN_B,
        outcome: "aborted",
        createdBy: { kind: "user" },
      });
      socketMock.rawEmit?.({
        type: "conversation_run_settled",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        runId: "4f9c2a19-4b9b-4f1b-9b3d-0f5e7c8a6d21",
        outcome: "failed",
        createdBy: { kind: "user" },
      });
      socketMock.rawEmit?.({
        type: "conversation_run_settled",
        sessionId: "00000000-0000-4000-8000-000000000001",
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        runId: "5f9c2a19-4b9b-4f1b-9b3d-0f5e7c8a6d21",
        outcome: "completed",
        createdBy: { kind: "user" },
      });
      socketMock.rawEmit?.({
        type: "conversation_run_settled",
        sessionId,
        projectId: "00000000-0000-4000-8000-000000000002",
        conversationId: CONVERSATION_B,
        runId: "6f9c2a19-4b9b-4f1b-9b3d-0f5e7c8a6d21",
        outcome: "completed",
        createdBy: { kind: "user" },
      });
    });

    expect(sound.play).not.toHaveBeenCalled();
  });

  it("cleans completion sound listeners and instances under StrictMode", () => {
    const view = render(<StrictMode><App /></StrictMode>);
    expect(completionSoundMock.instances).toHaveLength(2);
    const first = completionSoundMock.instances[0]!;
    const current = completionSoundMock.instances[1]!;
    expect(first.dispose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(window);
    fireEvent.keyDown(window);
    expect(first.unlock).not.toHaveBeenCalled();
    expect(current.unlock).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(current.dispose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(window);
    expect(current.unlock).toHaveBeenCalledTimes(2);
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

    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "close_session",
        sessionId: firstSessionId,
      }),
    );
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "recent" },
    });
    expect(localStorage.getItem("piweb.lastCwd")).toBe("E:\\second");
  });

  it("reopens a visited workspace with its cached conversation while syncing", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;
    const snapshotWindow = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };

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
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: firstSessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "cached-user",
          runId: RUN_ID,
          role: "user",
          text: "缓存中的 A 对话",
          thinking: "",
          tools: [],
        }],
        window: snapshotWindow,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\first",
      conversation: { kind: "open", conversationId: CONVERSATION_ID },
    });
    expect(socketMock.send.mock.calls.some(([command]) => (
      command.type === "close_session"
    ))).toBe(false);
    expect(screen.getByText("缓存中的 A 对话", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toHaveClass("transition-status-overlay");
    expect(screen.queryByText("本地服务已断开，正在重连…"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: firstSessionId,
          cwd: "E:\\first",
          busy: true,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: firstSessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "stale-user",
          runId: RUN_ID,
          role: "user",
          text: "不应覆盖缓存",
          thinking: "",
          tools: [],
        }],
        window: snapshotWindow,
      });
    });
    expect(screen.getByText("缓存中的 A 对话", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.queryByText("不应覆盖缓存", { selector: "article" }))
      .not.toBeInTheDocument();

    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId: latestCommand("initialize").sessionId,
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
        type: "conversation_snapshot",
        sessionId: latestCommand("initialize").sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "fresh-user",
          runId: RUN_B,
          role: "user",
          text: "新的权威 A 对话",
          thinking: "",
          tools: [],
        }],
        window: snapshotWindow,
      });
    });
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("新的权威 A 对话", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.queryByText("缓存中的 A 对话", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("ignores an empty attachment for an exact initialize until its target focus is ready", () => {
    render(<App />);
    const originalSessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };

    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId: originalSessionId,
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
        sessionId: originalSessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "cached-before-empty",
          runId: RUN_ID,
          role: "user",
          text: "cached conversation before empty project",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    socketMock.autoFocus = false;
    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    const reconnect = latestCommand("initialize");
    expect(reconnect).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId: CONVERSATION_ID },
    });
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByText("cached conversation before empty project"))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId: reconnect.sessionId, commandId: reconnect.commandId! },
      CONVERSATION_ID,
      "exact reconnect preview",
    )));
    expect(screen.getByText("exact reconnect preview", { selector: "article" }))
      .toBeInTheDocument();

    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: originalSessionId,
        projectId: PROJECT_ID,
      });
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: "00000000-0000-4000-8000-000000000099",
        sessionId: reconnect.sessionId,
        projectId: PROJECT_ID,
      });
    });
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByText("exact reconnect preview", { selector: "article" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: reconnect.commandId!,
      sessionId: reconnect.sessionId,
      projectId: PROJECT_ID,
    }));

    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByText("exact reconnect preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.queryByRole("heading", { name: "选择这个会话的角色" }))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: reconnect.commandId!,
      sessionId: reconnect.sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
    }));
    expect(screen.getByText("exact reconnect preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A_SECOND,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        role: defaultConversationRole(),
        messages: [{
          id: "reconnect-authoritative",
          role: "user",
          text: "exact reconnect authoritative",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("exact reconnect preview", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("exact reconnect authoritative", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("renders a correlated recent-initialize preview read-only until the exact snapshot", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    localStorage.setItem("piweb.lastCwd", "E:\\work");
    socketMock.autoFocus = false;
    render(<App />);

    const initialize = latestCommand("initialize");
    expect(initialize.conversation).toEqual({ kind: "recent" });
    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId: initialize.sessionId, commandId: initialize.commandId! },
      CONVERSATION_B,
      "cold recent preview",
      {
        role: defaultConversationRole({ name: "Preview Reader" }),
        window: {
          omittedBefore: true,
          startsMidTurn: false,
          contentTruncated: true,
        },
      },
    )));

    expect(screen.getByText("cold recent preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("note", { name: "历史记录不完整" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看会话角色 Preview Reader" }))
      .toBeInTheDocument();
    expect(screen.getByTitle("模型连接")).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "思考级别" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "手动压缩上下文" }))
      .toBeDisabled();
    expect(screen.getByRole("button", {
      name: "回到此处，删除这条及之后的消息",
    })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
    const commandCount = socketMock.send.mock.calls.length;
    fireEvent.click(screen.getByTitle("模型连接"));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: "手动压缩上下文" }));
    expect(socketMock.send).toHaveBeenCalledTimes(commandCount);

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: initialize.commandId!,
      sessionId: initialize.sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: FOCUS_A_SECOND,
    }));
    expect(screen.getByText("cold recent preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: initialize.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: FOCUS_A_SECOND,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: initialize.sessionId,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        role: defaultConversationRole(),
        messages: [{
          id: "fresh-authoritative-b",
          role: "user",
          text: "fresh authoritative conversation",
          thinking: "",
          tools: [],
        }],
        window: {
          omittedBefore: false,
          startsMidTurn: false,
          contentTruncated: false,
        },
      });
    });

    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("cold recent preview", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("fresh authoritative conversation", {
      selector: "article",
    })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("replaces an unacknowledged focus transition and ignores every stale target frame", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const initialize = latestCommand("initialize");
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [
          conversationSummary(CONVERSATION_ID, "A"),
          conversationSummary(CONVERSATION_B, "B", "2026-07-19T09:00:00.000Z"),
          conversationSummary(CONVERSATION_C, "C", "2026-07-19T10:00:00.000Z"),
        ],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "source-a-before-rapid-navigation",
          role: "user",
          text: "source A before rapid navigation",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    expect(screen.getByRole("button", { name: "打开会话 C" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "收起会话栏" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /会话操作/ })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();

    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: focusB.commandId },
      CONVERSATION_B,
      "B preview before replacement",
    )));
    expect(screen.getByText("B preview before replacement", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制用户消息" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(screen.getByRole("button", { name: "展开会话栏" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));

    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusC = latestCommand("focus_conversation");
    expect(focusC.commandId).not.toBe(focusB.commandId);
    expect(focusC.conversationId).toBe(CONVERSATION_C);
    expect(screen.queryByText("B preview before replacement", { selector: "article" }))
      .not.toBeInTheDocument();

    const staleBFocusId = "ae301850-745d-44dd-a30f-000000000301";
    act(() => {
      socketMock.rawEmit?.(conversationPreview(
        { sessionId, commandId: initialize.commandId! },
        CONVERSATION_ID,
        "late A preview",
      ));
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: initialize.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "late-a-snapshot",
          role: "assistant",
          text: "late A snapshot",
          thinking: "",
          tools: [],
        }],
        window,
      });
      socketMock.rawEmit?.({
        type: "error",
        scope: "command",
        operation: "initialize",
        commandId: initialize.commandId!,
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        message: "late A error",
      });
      socketMock.rawEmit?.(conversationPreview(
        { sessionId, commandId: focusB.commandId },
        CONVERSATION_B,
        "late B preview",
      ));
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: staleBFocusId,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: staleBFocusId,
        messages: [{
          id: "late-b-snapshot-before-c-attach",
          role: "assistant",
          text: "late B snapshot before C attach",
          thinking: "",
          tools: [],
        }],
        window,
      });
      socketMock.rawEmit?.({
        type: "error",
        scope: "command",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        conversationId: CONVERSATION_B,
        message: "late B error",
      });
      socketMock.rawEmit?.(conversationPreview(
        { sessionId, commandId: focusC.commandId },
        CONVERSATION_C,
        "C exact preview",
      ));
    });
    expect(screen.getByText("C exact preview", { selector: "article" }))
      .toBeInTheDocument();
    for (const staleText of [
      "late A preview",
      "late A snapshot",
      "late A error",
      "late B preview",
      "late B snapshot before C attach",
      "late B error",
    ]) {
      expect(screen.queryByText(staleText)).not.toBeInTheDocument();
    }

    const focusCId = "ae301850-745d-44dd-a30f-000000000302";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusC.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: staleBFocusId,
        messages: [{
          id: "late-b-snapshot-after-c-attach",
          role: "assistant",
          text: "late B snapshot after C attach",
          thinking: "",
          tools: [],
        }],
        window,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_C,
          focusId: focusCId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
        messages: [{
          id: "authoritative-c-after-replacement",
          role: "assistant",
          text: "authoritative C after replacement",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    expect(screen.getByText("authoritative C after replacement"))
      .toBeInTheDocument();
    expect(screen.queryByText("C exact preview", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("late B snapshot after C attach"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步会话…" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "当前会话 C" })).toBeEnabled();

    act(() => socketMock.status?.(false));
    expect(screen.getByRole("button", { name: "当前会话 C" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "收起会话栏" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
  });

  it("allows another navigation after attach while the authoritative snapshot is pending", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [
          conversationSummary(CONVERSATION_ID, "A"),
          conversationSummary(CONVERSATION_B, "B", "2026-07-19T09:00:00.000Z"),
          conversationSummary(CONVERSATION_C, "C", "2026-07-19T10:00:00.000Z"),
        ],
        truncated: false,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    const focusBId = "ae301850-745d-44dd-a30f-000000000311";
    act(() => {
      socketMock.rawEmit?.(conversationPreview(
        { sessionId, commandId: focusB.commandId },
        CONVERSATION_B,
        "B attached preview",
      ));
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
      });
    });
    expect(screen.getByText("B attached preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开会话 C" })).toBeEnabled();
    const focusCommandsBeforeCurrentClick = sentFocusCommandCount();
    fireEvent.click(screen.getByRole("button", { name: "当前会话 B" }));
    expect(sentFocusCommandCount()).toBe(focusCommandsBeforeCurrentClick);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusC = latestCommand("focus_conversation");
    expect(focusC.commandId).not.toBe(focusB.commandId);
    expect(focusC.conversationId).toBe(CONVERSATION_C);
    expect(screen.queryByText("B attached preview", { selector: "article" }))
      .not.toBeInTheDocument();

    const focusCId = "ae301850-745d-44dd-a30f-000000000312";
    act(() => {
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
        messages: [{
          id: "late-authoritative-b",
          role: "assistant",
          text: "late authoritative B",
          thinking: "",
          tools: [],
        }],
        window,
      });
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusC.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_C,
          focusId: focusCId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
        messages: [{
          id: "fresh-authoritative-c-after-attached-b",
          role: "assistant",
          text: "fresh authoritative C after attached B",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    expect(screen.queryByText("late authoritative B")).not.toBeInTheDocument();
    expect(screen.getByText("fresh authoritative C after attached B"))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
  });

  it("shows a deferred fallback read-only and refreshes before restoring readiness", () => {
    const sessionId = startFocusReplacementProject();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusC = latestCommand("focus_conversation");
    socketMock.send.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    socketMock.send.mockReturnValue(true);
    const focusBId = "ae301850-745d-44dd-a30f-000000000321";

    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: focusBId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "high",
          toolMode: "read_only",
          availableThinkingLevels: ["off", "high"],
          selectedModel: { provider: "provider", id: "fallback-model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
        role: defaultConversationRole({ name: "Fallback B" }),
        messages: [{
          id: "deferred-authoritative-b",
          role: "assistant",
          text: "deferred authoritative B",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
    });

    expect(screen.queryByText("deferred authoritative B")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "conversation_item",
      sessionId,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
      item: {
        kind: "message",
        id: "live-suffix-before-fallback-refresh",
        runId: RUN_B,
        role: "assistant",
        text: "live suffix recovered by refresh",
        thinking: "",
        tools: [],
      },
    }));
    expect(screen.queryByText("live suffix recovered by refresh"))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: focusC.commandId,
      sessionId,
      conversationId: CONVERSATION_C,
      message: "latest C failed",
    }));

    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByText("deferred authoritative B")).toBeInTheDocument();
    expect(screen.queryByText("live suffix recovered by refresh"))
      .not.toBeInTheDocument();
    expect(screen.queryByText("focus replacement source A"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 B" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "查看会话角色 Fallback B" }))
      .toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "思考级别" })).toHaveValue("high");
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();
    expect(latestCommand("refresh_view")).toEqual({
      type: "refresh_view",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
    });

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
      role: defaultConversationRole({ name: "Fallback B" }),
      messages: [{
        id: "refreshed-authoritative-b",
        role: "assistant",
        text: "deferred authoritative B",
        thinking: "",
        tools: [],
      }, {
        id: "refreshed-live-suffix-b",
        role: "assistant",
        text: "live suffix recovered by refresh",
        thinking: "",
        tools: [],
      }],
      window: completeConversationWindow,
    }));

    expect(screen.queryByRole("status", { name: "正在同步会话…" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("live suffix recovered by refresh"))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
  });

  it("keeps an attached fallback unready until its late snapshot and does not reopen it", () => {
    const sessionId = startFocusReplacementProject();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusC = latestCommand("focus_conversation");
    const focusBId = "ae301850-745d-44dd-a30f-000000000322";
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: focusB.commandId,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
    }));

    socketMock.send.mockReturnValueOnce(false);
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: focusC.commandId,
      sessionId,
      conversationId: CONVERSATION_C,
      message: "latest C failed before B snapshot",
    }));

    expect(screen.getByRole("alert"))
      .toHaveTextContent("恢复会话刷新请求发送失败");
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 B" })).toBeEnabled();
    expect(screen.queryByText("focus replacement source A"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();
    const settingsButton = screen.getByTitle("模型连接");
    expect(settingsButton).toBeDisabled();
    fireEvent.click(settingsButton);
    expect(screen.queryByRole("dialog", { name: "模型连接" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: /会话操作/ })) {
      expect(button).toBeDisabled();
    }
    expect(latestCommand("refresh_view")).toEqual({
      type: "refresh_view",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
    });

    const focusCommandsBeforeCurrentClick = sentFocusCommandCount();
    fireEvent.click(screen.getByRole("button", { name: "当前会话 B" }));
    expect(sentFocusCommandCount()).toBe(focusCommandsBeforeCurrentClick);

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: focusBId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off", "high"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
        messages: [{
          id: "late-fallback-b-snapshot",
          role: "assistant",
          text: "late fallback B snapshot",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByText("late fallback B snapshot")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步会话…" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    expect(screen.getByTitle("模型连接")).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
    expect(sentFocusCommandCount()).toBe(focusCommandsBeforeCurrentClick);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusCommandsBeforeReturningToB = sentFocusCommandCount();
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(sentFocusCommandCount()).toBe(focusCommandsBeforeReturningToB + 1);
    expect(latestCommand("focus_conversation").conversationId).toBe(CONVERSATION_B);
  });

  it("uses the newest multi-hop fallback once and ignores old attaches after latest success", () => {
    const sessionId = startFocusReplacementProject([
      conversationSummary(CONVERSATION_B, "B", "2026-07-19T09:00:00.000Z"),
      conversationSummary(CONVERSATION_C, "C", "2026-07-19T10:00:00.000Z"),
      conversationSummary(CONVERSATION_D, "D", "2026-07-19T11:00:00.000Z"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    fireEvent.click(screen.getByRole("button", { name: "打开会话 C" }));
    const focusC = latestCommand("focus_conversation");
    fireEvent.click(screen.getByRole("button", { name: "打开会话 D" }));
    const firstFocusD = latestCommand("focus_conversation");
    const focusBId = "ae301850-745d-44dd-a30f-000000000323";
    const focusCId = "ae301850-745d-44dd-a30f-000000000324";

    const attachB = {
      type: "focus_attached" as const,
      operation: "focus_conversation" as const,
      commandId: focusB.commandId,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
    };
    const attachC = {
      type: "focus_attached" as const,
      operation: "focus_conversation" as const,
      commandId: focusC.commandId,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_C,
      focusId: focusCId,
    };
    act(() => {
      socketMock.rawEmit?.(attachB);
      socketMock.rawEmit?.(attachB);
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
        messages: [{
          id: "multi-hop-b",
          role: "assistant",
          text: "multi-hop fallback B",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
      socketMock.rawEmit?.(attachC);
      socketMock.rawEmit?.(attachC);
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_C,
          focusId: focusCId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "high",
          toolMode: "read_only",
          availableThinkingLevels: ["off", "high"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
        role: defaultConversationRole({ name: "Newest Fallback C" }),
        messages: [{
          id: "multi-hop-c",
          role: "assistant",
          text: "multi-hop fallback C",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
      socketMock.rawEmit?.({
        type: "error",
        scope: "command",
        operation: "focus_conversation",
        commandId: firstFocusD.commandId,
        sessionId,
        conversationId: CONVERSATION_D,
        message: "first D failed",
      });
    });

    expect(screen.getByText("multi-hop fallback C")).toBeInTheDocument();
    expect(screen.queryByText("multi-hop fallback B"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 C" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "查看会话角色 Newest Fallback C" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();
    expect(latestCommand("refresh_view")).toMatchObject({
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_C,
      focusId: focusCId,
    });

    fireEvent.click(screen.getByRole("button", { name: "打开会话 D" }));
    const latestFocusD = latestCommand("focus_conversation");
    expect(latestFocusD.commandId).not.toBe(firstFocusD.commandId);
    const focusDId = "ae301850-745d-44dd-a30f-000000000325";
    const attachD = {
      type: "focus_attached" as const,
      operation: "focus_conversation" as const,
      commandId: latestFocusD.commandId,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_D,
      focusId: focusDId,
    };
    act(() => {
      socketMock.rawEmit?.(attachD);
      socketMock.rawEmit?.(attachD);
      socketMock.rawEmit?.(attachB);
      socketMock.rawEmit?.(attachC);
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_C,
        focusId: focusCId,
        messages: [{
          id: "stale-c-after-d-success",
          role: "assistant",
          text: "stale C after D success",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_D,
          focusId: focusDId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off", "high"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_D,
        focusId: focusDId,
        messages: [{
          id: "latest-d-authoritative",
          role: "assistant",
          text: "latest D authoritative",
          thinking: "",
          tools: [],
        }],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByText("latest D authoritative")).toBeInTheDocument();
    expect(screen.queryByText("stale C after D success"))
      .not.toBeInTheDocument();
    expect(screen.queryByText("multi-hop fallback C"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 D" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
  });

  it("keeps the workspace rail switchable during a conversation transition", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const sessionId = latestCommand("initialize").sessionId;
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\first",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [
          conversationSummary(CONVERSATION_ID, "A"),
          conversationSummary(CONVERSATION_B, "B"),
        ],
        truncated: false,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toHaveClass("transition-status-overlay");
    const secondWorkspace = screen.getByRole("button", { name: "打开工作区 second" });
    expect(secondWorkspace).toBeEnabled();
    fireEvent.click(secondWorkspace);

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "recent" },
    });
    expect(latestCommand("initialize").sessionId).not.toBe(sessionId);
  });

  it("keeps a focus preview through attach, replaces it on snapshot, and clears it on error", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "A",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 1,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 1,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        role: defaultConversationRole(),
        messages: [{
          id: "source-a",
          role: "user",
          text: "source A authoritative",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: focusB.commandId },
      CONVERSATION_B,
      "B prepared preview",
    )));
    expect(screen.getByText("B prepared preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.queryByText("source A authoritative", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "会话操作 B" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开会话 A" })).toBeEnabled();

    const focusBId = "ae301850-745d-44dd-a30f-000000000201";
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: focusB.commandId,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
    }));
    expect(screen.getByText("B prepared preview", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: focusBId,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: focusBId,
        role: defaultConversationRole(),
        messages: [{
          id: "fresh-b",
          role: "user",
          text: "B authoritative snapshot",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });
    expect(screen.queryByText("B prepared preview", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("B authoritative snapshot", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    const focusA = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: focusA.commandId },
      CONVERSATION_ID,
      "A preview that will fail",
    )));
    expect(screen.getByText("A preview that will fail", { selector: "article" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: focusA.commandId,
      sessionId,
      message: "focus failed after preview",
    }));
    expect(screen.queryByText("A preview that will fail", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("B authoritative snapshot", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("does not cache a late preview after complete membership confirms deletion", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
    const conversationA = {
      id: CONVERSATION_ID,
      name: "A",
      preview: "A",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T08:00:00.000Z",
      messageCount: 1,
    };
    const conversationB = {
      id: CONVERSATION_B,
      name: "B",
      preview: "B",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationA, conversationB],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "source-before-deletion",
          role: "user",
          text: "source before deletion",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const deletedFocus = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationA],
      truncated: false,
    }));
    expect(screen.queryByRole("button", { name: "打开会话 B" }))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: deletedFocus.commandId },
      CONVERSATION_B,
      "late deleted B preview",
    )));
    expect(screen.queryByText("late deleted B preview"))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: deletedFocus.commandId,
      sessionId,
      conversationId: CONVERSATION_B,
      message: "deleted while opening",
    }));
    expect(screen.getByText("source before deletion", { selector: "article" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationA, conversationB],
      truncated: false,
    }));
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));

    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.queryByText("late deleted B preview"))
      .not.toBeInTheDocument();
    expect(screen.queryByText("source before deletion", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
  });

  it("does not treat absence from a truncated project snapshot as deletion proof", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const conversationA = {
      id: CONVERSATION_ID,
      name: "A",
      preview: "A",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T08:00:00.000Z",
      messageCount: 1,
    };
    const conversationB = {
      id: CONVERSATION_B,
      name: "B",
      preview: "B",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationA, conversationB],
        truncated: false,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focus = latestCommand("focus_conversation");
    act(() => {
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationA],
        truncated: true,
      });
      socketMock.rawEmit?.(conversationPreview(
        { sessionId, commandId: focus.commandId },
        CONVERSATION_B,
        "preview absent only from truncated index",
      ));
    });

    expect(screen.getByText("preview absent only from truncated index", {
      selector: "article",
    })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
  });

  it("rejects mismatched previews and clears temporary previews on replacement and disconnect", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "A",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 1,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 1,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "source-before-stale-preview",
          role: "user",
          text: "source before stale preview",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focus = latestCommand("focus_conversation");
    const mismatches = [
      conversationPreview({
        sessionId: "00000000-0000-4000-8000-000000000001",
        commandId: focus.commandId,
      }, CONVERSATION_B, "wrong session preview"),
      conversationPreview({
        sessionId,
        commandId: "00000000-0000-4000-8000-000000000099",
      }, CONVERSATION_B, "wrong command preview"),
      conversationPreview(
        { sessionId, commandId: focus.commandId },
        CONVERSATION_B,
        "wrong project preview",
        { projectId: "00000000-0000-4000-8000-000000000002" },
      ),
      conversationPreview(
        { sessionId, commandId: focus.commandId },
        CONVERSATION_B,
        "wrong workspace preview",
        { cwd: "E:\\other" },
      ),
      conversationPreview(
        { sessionId, commandId: focus.commandId },
        CONVERSATION_ID,
        "wrong target preview",
      ),
    ];
    act(() => {
      for (const preview of mismatches) socketMock.rawEmit?.(preview);
    });
    for (const text of [
      "wrong session preview",
      "wrong command preview",
      "wrong project preview",
      "wrong workspace preview",
      "wrong target preview",
    ]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }

    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: focus.commandId },
      CONVERSATION_B,
      "exact preview before replacement",
    )));
    expect(screen.getByText("exact preview before replacement", {
      selector: "article",
    })).toBeInTheDocument();
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: focus.commandId,
      sessionId,
      conversationId: CONVERSATION_ID,
      message: "wrong focus target error",
    }));
    expect(screen.getByText("exact preview before replacement", {
      selector: "article",
    })).toBeInTheDocument();
    expect(screen.queryByText("wrong focus target error")).not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      startupCwd: "E:\\default",
    }));
    const replacement = latestCommand("initialize");
    expect(replacement.sessionId).not.toBe(sessionId);
    expect(screen.queryByText("exact preview before replacement"))
      .not.toBeInTheDocument();
    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId, commandId: focus.commandId },
      CONVERSATION_B,
      "stale preview after replacement",
    )));
    expect(screen.queryByText("stale preview after replacement"))
      .not.toBeInTheDocument();
    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId: replacement.sessionId, commandId: replacement.commandId! },
      CONVERSATION_B,
      "wrong exact-open target preview",
    )));
    expect(screen.queryByText("wrong exact-open target preview"))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.(conversationPreview(
      { sessionId: replacement.sessionId, commandId: replacement.commandId! },
      CONVERSATION_ID,
      "replacement preview before disconnect",
    )));
    expect(screen.getByText("replacement preview before disconnect", {
      selector: "article",
    })).toBeInTheDocument();
    act(() => socketMock.status?.(false));
    expect(screen.queryByText("replacement preview before disconnect"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
  });

  it("keeps a cache miss empty and restores the source focus on a matching focus error", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
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
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_ID,
          name: "A",
          preview: "A",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T08:00:00.000Z",
          messageCount: 1,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "source-history",
          runId: RUN_ID,
          role: "user",
          text: "source A",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByText("source A")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();

    const command = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: "00000000-0000-4000-8000-000000000099",
      sessionId,
      conversationId: CONVERSATION_B,
      message: "stale focus error",
    }));
    act(() => {
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "late-source",
          runId: RUN_ID,
          role: "user",
          text: "late source snapshot",
          thinking: "",
          tools: [],
        }],
        window,
      });
      socketMock.rawEmit?.({
        type: "conversation_item",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        item: {
          kind: "message",
          id: "late-source-live",
          runId: RUN_B,
          role: "assistant",
          text: "late source live",
          thinking: "",
          tools: [],
        },
      });
    });
    expect(screen.getByRole("status", { name: "正在同步会话…" })).toBeInTheDocument();
    expect(screen.queryByText("late source snapshot")).not.toBeInTheDocument();
    expect(screen.queryByText("late source live")).not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "focus_conversation",
      commandId: command.commandId!,
      sessionId,
      message: "focus failed",
    }));
    expect(screen.queryByRole("status", { name: "正在同步会话…" })).not.toBeInTheDocument();
    expect(screen.getByText("source A")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

    socketMock.send.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByRole("status", { name: "正在同步会话…" })).not.toBeInTheDocument();
    expect(screen.getByText("source A")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    socketMock.send.mockReturnValue(true);
  });

  it("hot-switches A to B to A with a read-only cached conversation presentation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };
    const projectSnapshot = {
      type: "project_snapshot" as const,
      sessionId,
      projectId: PROJECT_ID,
      conversations: [{
        id: CONVERSATION_ID,
        name: "A",
        preview: "A",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T08:00:00.000Z",
        messageCount: 1,
      }, {
        id: CONVERSATION_B,
        name: "B",
        preview: "B",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T09:00:00.000Z",
        messageCount: 1,
      }],
      truncated: false,
    };
    const stateFor = (conversationId: string, focusId: string): TestServerEvent => ({
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
        projectId: PROJECT_ID,
        conversationId,
        focusId,
      },
    });
    const snapshotFor = (
      conversationId: string,
      focusId: string,
      text: string,
    ): TestServerEvent => ({
      type: "conversation_snapshot",
      sessionId,
      conversationId,
      focusId,
      messages: [{
        id: `${conversationId}-history`,
        runId: RUN_ID,
        role: "user",
        text,
        thinking: "",
        tools: [],
      }],
      window,
    });

    act(() => {
      socketMock.emit?.(stateFor(CONVERSATION_ID, FOCUS_A));
      socketMock.rawEmit?.(projectSnapshot);
      socketMock.rawEmit?.(snapshotFor(CONVERSATION_ID, FOCUS_A, "A cached history"));
      socketMock.rawEmit?.({
        type: "conversation_item",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        item: {
          kind: "message",
          id: "a-live-item",
          runId: RUN_B,
          role: "assistant",
          text: "A live card",
          thinking: "",
          tools: [],
        },
      });
    });
    act(() => socketMock.rawEmit?.({
      ...projectSnapshot,
      conversations: [projectSnapshot.conversations[1]!],
      truncated: true,
    }));
    socketMock.autoFocus = false;
    const focusB = "ae301850-745d-44dd-a30f-000000000101";
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusBCommand = latestCommand("focus_conversation");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusBCommand.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: focusB,
      });
      socketMock.rawEmit?.(stateFor(CONVERSATION_B, focusB));
      socketMock.rawEmit?.(snapshotFor(CONVERSATION_B, focusB, "B history"));
      socketMock.rawEmit?.(projectSnapshot);
    });

    const focusA = "ae301850-745d-44dd-a30f-000000000102";
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    expect(screen.getByText("A cached history")).toBeInTheDocument();
    expect(screen.getByText("A live card")).toBeInTheDocument();
    expect(screen.queryByText("B history")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "当前会话 A" })).toBeEnabled();

    const focusACommand = latestCommand("focus_conversation");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusACommand.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: focusA,
      });
      socketMock.rawEmit?.(stateFor(CONVERSATION_ID, focusA));
    });
    expect(screen.getByText("A cached history")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeDisabled();

    act(() => socketMock.rawEmit?.(snapshotFor(
      CONVERSATION_ID,
      focusA,
      "fresh A history",
    )));
    expect(screen.queryByRole("status", { name: "正在同步会话…" })).not.toBeInTheDocument();
    expect(screen.getByText("fresh A history")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

    act(() => {
      socketMock.rawEmit?.({
        ...projectSnapshot,
        conversations: [projectSnapshot.conversations[1]!],
        truncated: false,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const secondBCommand = latestCommand("focus_conversation");
    const secondBFocus = "ae301850-745d-44dd-a30f-000000000103";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: secondBCommand.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: secondBFocus,
      });
      socketMock.rawEmit?.(stateFor(CONVERSATION_B, secondBFocus));
      socketMock.rawEmit?.(snapshotFor(CONVERSATION_B, secondBFocus, "B again"));
      socketMock.rawEmit?.(projectSnapshot);
    });
    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    expect(screen.queryByText("fresh A history")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步会话…" })).toBeInTheDocument();
  });

  it("reconnects from the active workspace cache and waits for a fresh snapshot", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    localStorage.setItem("piweb.lastCwd", "E:\\first");
    render(<App />);
    const first = latestCommand("initialize");
    const window = {
      omittedBefore: false,
      startsMidTurn: false,
      contentTruncated: false,
    };

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: first.sessionId,
          cwd: "E:\\first",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: first.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "first-cache",
          runId: RUN_ID,
          role: "user",
          text: "first cache",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    const second = latestCommand("initialize");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: second.commandId!,
        sessionId: second.sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: second.sessionId,
          cwd: "E:\\second",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A_SECOND,
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: second.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        messages: [{
          id: "second-cache",
          runId: RUN_B,
          role: "user",
          text: "second cache",
          thinking: "",
          tools: [],
        }],
        window,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const firstReturn = latestCommand("initialize");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: firstReturn.commandId!,
        sessionId: firstReturn.sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: firstReturn.sessionId,
          cwd: "E:\\first",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A_SECOND,
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: firstReturn.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        messages: [],
        window,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));

    expect(screen.getByText("second cache", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();

    socketMock.autoFocus = false;
    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    const reconnect = latestCommand("initialize");
    expect(reconnect).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "open", conversationId: CONVERSATION_ID },
    });
    expect(screen.getByText("second cache", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: reconnect.commandId!,
      sessionId: reconnect.sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
    }));
    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId: reconnect.sessionId,
        cwd: "E:\\second",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
      },
    }));
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId: reconnect.sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
      messages: [{
        id: "fresh-second",
        runId: RUN_ID,
        role: "user",
        text: "fresh second",
        thinking: "",
        tools: [],
      }],
      window,
    }));
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("fresh second", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("falls back to recent after a cached reconnect open fails", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    localStorage.setItem("piweb.lastCwd", "E:\\work");
    render(<App />);
    const first = latestCommand("initialize").sessionId;
    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: first,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: first,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [],
        window: {
          omittedBefore: false,
          startsMidTurn: false,
          contentTruncated: false,
        },
      });
    });
    socketMock.autoFocus = false;
    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    const reconnect = latestCommand("initialize");
    expect(reconnect.conversation).toEqual({
      kind: "open",
      conversationId: CONVERSATION_ID,
    });
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: reconnect.commandId,
      sessionId: reconnect.sessionId,
      message: "dead conversation",
    }));
    expect(screen.getByRole("heading", { name: "工作区不可用" }))
      .toBeInTheDocument();

    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    expect(latestCommand("initialize").conversation).toEqual({ kind: "recent" });
  });

  it("removes the last unavailable workspace and closes its session", () => {
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    localStorage.setItem("piweb.lastCwd", "E:\\work");
    render(<App />);
    const initializeCommand = latestCommand("initialize");
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: initializeCommand.commandId,
      sessionId: initializeCommand.sessionId,
      message: "workspace unavailable",
    }));

    fireEvent.click(screen.getByRole("button", { name: "从列表移除" }));
    expect(socketMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "close_session",
      sessionId: initializeCommand.sessionId,
    }));
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有打开工作区" }))
      .toBeInTheDocument();
  });

  it("recovers from a cached workspace initialize failure", () => {
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
        type: "conversation_snapshot",
        sessionId: firstSessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [],
        window: {
          omittedBefore: false,
          startsMidTurn: false,
          contentTruncated: false,
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    });
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const retry = latestCommand("initialize");
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: retry.commandId,
      sessionId: retry.sessionId,
      message: "无法打开项目",
    }));

    expect(screen.getByRole("heading", { name: "工作区不可用" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "recent" },
    });
  });

  it("drops a cached presentation on a mismatched project acknowledgement", () => {
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
        type: "conversation_snapshot",
        sessionId: firstSessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "mismatch-cache",
          runId: RUN_ID,
          role: "user",
          text: "旧项目画面",
          thinking: "",
          tools: [],
        }],
        window: {
          omittedBefore: false,
          startsMidTurn: false,
          contentTruncated: false,
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    });
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const initializeCommand = latestCommand("initialize");
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: initializeCommand.commandId!,
      sessionId: initializeCommand.sessionId,
      projectId: "8177b28d-c21d-40c2-b45f-6714ae096421",
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
    }));

    expect(screen.queryByText("旧项目画面", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });

  it("keeps workspace and conversation presentation LRU caches independent", () => {
    const workspaceCache = new Map<string, number>();
    for (let index = 0; index < MAX_CACHED_WORKSPACES; index += 1) {
      rememberWorkspaceProjection(workspaceCache, `workspace-${index}`, index);
    }
    expect(getWorkspaceProjection(workspaceCache, "workspace-0")).toBe(0);
    rememberWorkspaceProjection(workspaceCache, "workspace-new", 4);
    expect(workspaceCache.size).toBe(MAX_CACHED_WORKSPACES);
    expect(workspaceCache.has("workspace-0")).toBe(true);
    expect(workspaceCache.has("workspace-1")).toBe(false);
    forgetWorkspaceProjection(workspaceCache, "workspace-0");
    expect(workspaceCache.has("workspace-0")).toBe(false);

    const conversationCache = new Map<string, number>();
    for (let index = 0; index < MAX_CACHED_CONVERSATION_PRESENTATIONS; index += 1) {
      rememberConversationPresentation(conversationCache, `scope-${index}`, index);
    }
    expect(getConversationPresentation(conversationCache, "scope-0")).toBe(0);
    rememberConversationPresentation(conversationCache, "scope-new", 8);
    expect(conversationCache.size).toBe(MAX_CACHED_CONVERSATION_PRESENTATIONS);
    expect(conversationCache.has("scope-0")).toBe(true);
    expect(conversationCache.has("scope-1")).toBe(false);
    forgetConversationPresentation(conversationCache, "scope-0");
    expect(conversationCache.has("scope-0")).toBe(false);
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

  it("rejects a v24 server before enabling commands", () => {
    socketMock.helloVersion = 24;

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
    expect(screen.getByText(
      `协议版本不兼容：服务端 24，客户端 ${PROTOCOL_VERSION}`,
    )).toBeInTheDocument();
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
      socketMock.emit?.({
        type: "command_complete",
        operation: "switch_conversation_role",
        commandId: command.commandId,
        sessionId,
      });
    });

    expect(screen.getByText("会话角色已更换")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看会话角色 Builder" }))
      .toBeInTheDocument();
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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

  it("correlates model refresh commands and preserves unknown outcomes", () => {
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
            contextWindow: 1_000,
            available: true,
          }],
        }],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: /^model\s*⌄$/ }));

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    const command = latestCommand("refresh_models");
    expect(command.sessionId).toBe(sessionId);
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("button", { name: "正在刷新模型…" })).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "command_complete",
      operation: "refresh_models",
      commandId: "8ee64aa3-c8a8-4e21-b521-66029ce3673b",
      sessionId,
    }));
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "refresh_models",
      commandId: "8ee64aa3-c8a8-4e21-b521-66029ce3673b",
      sessionId,
      message: "stale refresh failure",
    }));
    expect(screen.getByRole("button", { name: "正在刷新模型…" })).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "command_complete",
      operation: "refresh_models",
      commandId: command.commandId,
      sessionId,
    }));
    expect(screen.getByRole("status")).toHaveTextContent("远程供应商模型目录已刷新");
    expect(screen.queryByText("stale refresh failure")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    const failedCommand = latestCommand("refresh_models");
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "refresh_models",
      commandId: failedCommand.commandId,
      sessionId,
      message: "远程刷新失败",
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("远程刷新失败");
    expect(screen.queryByText("stale refresh failure")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    act(() => socketMock.status?.(false));
    expect(screen.getByRole("alert")).toHaveTextContent("状态未确认");
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeDisabled();
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

  it("retries a projection-gap refresh after compaction finishes", async () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        compacting: true,
        activeRun: { id: RUN_ID, phase: "running" },
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
      focusId: FOCUS_A,
      projectionSeq: 1,
      messages: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    socketMock.send.mockClear();

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      runId: RUN_ID,
      projectionSeq: 3,
      event: { type: "text_delta", delta: "missed one" },
    }));

    await waitFor(() => {
      expect(socketMock.send.mock.calls.filter(
        ([command]) => command.type === "refresh_view",
      )).toHaveLength(1);
    });

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        compacting: false,
        activeRun: { id: RUN_ID, phase: "running" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    await waitFor(() => {
      expect(socketMock.send.mock.calls.filter(
        ([command]) => command.type === "refresh_view",
      )).toHaveLength(2);
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
        window: { omittedBefore: true, startsMidTurn: true, contentTruncated: true },
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });

    expect(screen.getByText("persisted question", { selector: "article" })).toBeInTheDocument();
    expect(screen.getByText("persisted answer").closest("article")).toBeInTheDocument();
    expect(screen.queryByText("wrong conversation")).not.toBeInTheDocument();
    const historyWindow = screen.getByRole("note", { name: "历史记录不完整" });
    expect(historyWindow).toHaveTextContent("当前可见记录从一轮对话的中间开始。");
    expect(historyWindow).toHaveTextContent("较长消息或工具详情已缩短显示。");
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
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    expect(input).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messages: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    expect(input).toBeEnabled();

    fireEvent.change(input, { target: { value: "safe after hydrate" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(latestCommand("prompt")).toMatchObject({
      sessionId,
      text: "safe after hydrate",
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
      name: "会话操作 Older work",
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    const command = latestCommand("delete_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
    expect(screen.getByRole("button", {
      name: "会话操作 Older work",
    })).toBeDisabled();
    expect(screen.getByRole("button", {
      name: "打开会话 Older work",
    })).toBeDisabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
    }));
    expect(screen.getByText("对话已删除")).toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "会话操作 Older work",
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
    fireEvent.click(screen.getByRole("button", { name: "会话操作 Delete me" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(screen.getByRole("button", { name: "会话操作 Delete me" }))
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

    expect(screen.getByRole("button", { name: "会话操作 Second project" }))
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
    fireEvent.click(screen.getByRole("button", { name: "会话操作 Current" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
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

    socketMock.autoFocus = false;
    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    expect(latestCommand("initialize").conversation).toEqual({ kind: "recent" });
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

  it("correlates prompt, abort, finish, and workspace switch with one session run", () => {
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
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "close_session", sessionId }),
    );
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\other",
      conversation: { kind: "recent" },
    });
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
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        messages: [{
          id: "assistant-a",
          role: "assistant",
          text: "A still working",
          thinking: "",
          tools: [],
        }],
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });
    expect(screen.getByText("A still working")).toBeInTheDocument();
    socketMock.autoFocus = false;

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByText("A still working")).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messages: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "手动压缩上下文" }))
      .toBeDisabled();
    expect(screen.queryByRole("button", { name: "停止" }))
      .not.toBeInTheDocument();
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "abort",
    )).toHaveLength(0);
  });

  it("keeps focus-owned busy state clear after a focus ack before matching state", () => {
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
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    socketMock.autoFocus = false;

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const command = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: command.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: FOCUS_A_SECOND,
    }));

    expect(screen.queryByRole("button", { name: "停止" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "会话操作 A" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
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
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "模型连接" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "模型连接" }));
    expect(screen.getByRole("dialog", { name: "模型连接" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

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

  it("isolates rail activity and streaming transcript renders in both directions", () => {
    const trackedConversation = conversationSummary(CONVERSATION_ID, "Tracked A");
    const readConversationName = vi.fn(() => "Tracked A");
    const readConversationTime = vi.fn(() => "2026-07-19T08:00:00.000Z");
    Object.defineProperties(trackedConversation, {
      name: { enumerable: true, get: readConversationName },
      updatedAt: { enumerable: true, get: readConversationTime },
    });
    const trackedConversations = [trackedConversation];
    const findConversations = vi.spyOn(trackedConversations, "find");
    const orderConversations = vi.spyOn(trackedConversations, "map");
    const activity = {
      projectId: PROJECT_ID,
      cwd: "E:\\default",
      busyConversationCount: 1,
      attentionConversationCount: 0,
    };
    const readWorkspaceBusyCount = vi.fn(() => 1);
    Object.defineProperty(activity, "busyConversationCount", {
      enumerable: true,
      get: readWorkspaceBusyCount,
    });

    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\default",
          busy: false,
          thinkingLevel: "off",
          toolMode: "full_access",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
        },
      });
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        conversations: trackedConversations,
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "project_activity_snapshot",
        projects: [activity],
        truncated: false,
      });
    });
    const initialFinds = findConversations.mock.calls.length;
    const initialOrderings = orderConversations.mock.calls.length;
    const initialNameReads = readConversationName.mock.calls.length;
    const initialTimeReads = readConversationTime.mock.calls.length;
    const initialActivityReads = readWorkspaceBusyCount.mock.calls.length;

    act(() => {
      socketMock.rawEmit?.({
        type: "session_event",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        runId: RUN_ID,
        event: {
          type: "assistant_message_started",
          projectionId: "streaming-render-isolation",
        },
      });
      socketMock.rawEmit?.({
        type: "session_event",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        runId: RUN_ID,
        event: { type: "text_delta", delta: "streaming transcript update" },
      });
    });

    expect(screen.getByText("streaming transcript update")).toBeInTheDocument();
    expect(findConversations).toHaveBeenCalledTimes(initialFinds);
    expect(orderConversations).toHaveBeenCalledTimes(initialOrderings);
    expect(readConversationName).toHaveBeenCalledTimes(initialNameReads);
    expect(readConversationTime).toHaveBeenCalledTimes(initialTimeReads);
    expect(readWorkspaceBusyCount).toHaveBeenCalledTimes(initialActivityReads);

    renderIsolationMock.chat.mockClear();
    renderIsolationMock.message.mockClear();
    act(() => socketMock.rawEmit?.({
      type: "project_activity_snapshot",
      projects: [{
        projectId: PROJECT_ID,
        cwd: "E:\\default",
        busyConversationCount: 0,
        attentionConversationCount: 2,
      }],
      truncated: false,
    }));
    expect(screen.getByRole("button", {
      name: "打开工作区 default（2 个会话需要注意）",
    })).toBeInTheDocument();
    expect(renderIsolationMock.chat).not.toHaveBeenCalled();
    expect(renderIsolationMock.message).not.toHaveBeenCalled();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\default",
        busy: false,
        thinkingLevel: "high",
        toolMode: "full_access",
        availableThinkingLevels: ["off", "high"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByRole("combobox", { name: "思考级别" })).toHaveValue("high");
    expect(renderIsolationMock.chat).toHaveBeenCalled();
    expect(renderIsolationMock.message).not.toHaveBeenCalled();

    renderIsolationMock.chat.mockClear();
    renderIsolationMock.message.mockClear();
    act(() => socketMock.rawEmit?.({
      type: "session_event",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      runId: RUN_ID,
      event: { type: "text_delta", delta: " and focused update" },
    }));
    expect(screen.getByText("streaming transcript update and focused update"))
      .toBeInTheDocument();
    expect(renderIsolationMock.chat).toHaveBeenCalled();
    expect(renderIsolationMock.message).toHaveBeenCalledWith(
      "streaming-render-isolation",
    );

    act(() => {
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        conversations: [{
          ...conversationSummary(CONVERSATION_ID, "Updated A"),
          activity: { kind: "running", runId: RUN_ID },
        }],
        truncated: false,
      });
    });
    expect(screen.getByText("Updated A")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "运行中" })).toBeInTheDocument();

    act(() => socketMock.status?.(false));
    expect(screen.getByRole("button", { name: "当前会话 Updated A" }))
      .toBeDisabled();
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

    socketMock.autoFocus = false;
    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    expect(latestCommand("initialize").conversation).toEqual({ kind: "recent" });
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
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
    expect(screen.getAllByRole("article", { name: "发出的会话消息" }))
      .toHaveLength(1);
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
    expect(update).toMatchObject({ expectedSystemPrompt: "Be useful." });

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

  it("admits a busy prompt with promptId and shows it as waiting until delivered", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\work",
        busy: true,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));

    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const prompt = latestCommand("prompt");

    expect(prompt.text).toBe("follow up");
    expect(prompt.promptId).toEqual(expect.any(String));
    const promptId = prompt.promptId;
    if (promptId === undefined) throw new Error("promptId missing");
    // 回执前草稿保留
    expect(input).toHaveValue("follow up");

    // busy 路径回执：已接受 → 清草稿 + 等待中显示
    act(() => socketMock.emit?.({
      type: "prompt_admitted",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      promptId,
      text: "follow up",
    }));
    expect(input).toHaveValue("");
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("follow up");

    // 投递确认 → 等待中消失（真实消息由 live projection 显示）
    act(() => socketMock.emit?.({
      type: "prompt_delivered",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      promptId,
      runId: prompt.runId,
    }));
    expect(screen.queryByRole("region", { name: "等待处理的消息" }))
      .not.toBeInTheDocument();
  });

  it("restores waiting prompts from the conversation snapshot", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\work",
          busy: true,
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
      focusId: FOCUS_A,
      items: [],
      pendingPrompts: [{
        promptId: "3c5b3e7a-1f2a-4b6e-8d0c-9a1b2c3d4e5f",
        text: "still waiting",
      }],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });

    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("still waiting");
  });

  it("clears waiting prompts when the run is aborted", () => {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\work",
          busy: true,
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
      focusId: FOCUS_A,
      items: [],
      pendingPrompts: [{
        promptId: "3c5b3e7a-1f2a-4b6e-8d0c-9a1b2c3d4e5f",
        text: "still waiting",
      }],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("still waiting");

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      runId: RUN_ID,
      event: { type: "run_finished", outcome: "aborted" },
    }));

    expect(screen.queryByRole("region", { name: "等待处理的消息" }))
      .not.toBeInTheDocument();
  });
});
