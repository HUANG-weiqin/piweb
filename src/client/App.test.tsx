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
  type ConversationHistoryItem,
  type ConversationHistoryMessage,
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type PublicState,
  type RoleTemplate,
  type ServerEvent,
} from "../shared/protocol";
import type { ConversationTitleLookup } from "./lib/conversation-display";
import {
  decodePhoneHistoryRoute,
  encodePhoneHistoryRoute,
  type PhoneHistoryRoute,
} from "./lib/phone-history-route";
import {
  App,
  MAX_CACHED_WORKSPACES,
  MAX_CACHED_CONVERSATION_PRESENTATIONS,
  getConversationPresentation,
  getWorkspaceProjection,
  rememberConversationPresentation,
  rememberWorkspaceProjection,
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
const SERVICE_TIER_PROVIDER: PublicState["providers"][number] = {
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
    serviceTiers: ["auto", "priority"],
  }],
};

type TestState = Omit<
  PublicState,
  "projectId" | "conversationId" | "selectedServiceTier"
> & Partial<Pick<
  PublicState,
  "projectId" | "conversationId" | "selectedServiceTier"
>>;
type RelaxedHello = Omit<
  Extract<ServerEvent, { type: "hello" }>,
  "uiPreferences"
> & { uiPreferences?: { colorScheme: "quiet-rebel" | "classic-rebel" } };
type RelaxedProjectSnapshot = Omit<
  Extract<ServerEvent, { type: "project_snapshot" }>,
  "coverage"
> & { coverage?: "complete" | "unknown" };
type RelaxedConversationSnapshot = Omit<
  Extract<ServerEvent, { type: "conversation_snapshot" }>,
  "focusId" | "projectionSeq" | "pendingPrompts"
> & {
  focusId?: string;
  projectionSeq?: number;
  pendingPrompts?: Extract<
    ServerEvent,
    { type: "conversation_snapshot" }
  >["pendingPrompts"];
};
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
  | { type: "hello" }
  | { type: "state" }
  | { type: "conversation_snapshot" }
  | { type: "session_event" }
  | { type: "conversation_item" }
>
  | RelaxedHello
  | { type: "state"; state: TestState }
  | RelaxedProjectSnapshot
  | RelaxedConversationSnapshot
  | RelaxedSessionEvent
  | RelaxedConversationItem;

type ConversationMessageItem = Extract<
  ConversationHistoryItem,
  { kind: "message" }
>;

function snapshotItems(
  messages: Array<Omit<ConversationHistoryMessage, "parts">>,
): ConversationMessageItem[] {
  return messages.map((message) => ({
    kind: "message",
    ...message,
    parts: [
      ...(message.thinking
        ? [{ kind: "thinking" as const, offset: 0, length: message.thinking.length }]
        : []),
      ...message.tools.map((tool) => ({
        kind: "tool" as const,
        toolCallId: tool.toolCallId,
      })),
      ...(message.text
        ? [{ kind: "text" as const, offset: 0, length: message.text.length }]
        : []),
    ],
  }));
}

function completeEvent(event: TestServerEvent): TestServerEvent {
  if (event.type === "hello") {
    return {
      ...event,
      uiPreferences: event.uiPreferences ?? { colorScheme: "quiet-rebel" },
    };
  }
  if (event.type === "project_snapshot") {
    return { ...event, coverage: event.coverage ?? "complete" };
  }
  if (event.type === "conversation_snapshot") {
    return {
      ...event,
      pendingPrompts: event.pendingPrompts ?? [],
    };
  }
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
  chat: vi.fn((_lookup?: unknown) => undefined),
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
    renderIsolationMock.chat(props.conversationTitleLookup);
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
          onEvent(completeEvent({
            type: "conversation_snapshot",
            sessionId: completed.state.sessionId,
            conversationId: completed.state.conversationId,
            focusId: completed.state.focusId,
            items: [],
            window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
          }) as ServerEvent);
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
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState(null, "");
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

function mockPhoneViewport(initiallyPhone = true): {
  setPhoneViewport(phone: boolean): void;
} {
  let phoneViewport = initiallyPhone;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    get matches() {
      return phoneViewport;
    },
    media: "(max-width: 600px)",
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "change" && typeof listener === "function") {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "change" && typeof listener === "function") {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: vi.fn(() => true),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    setPhoneViewport(phone: boolean) {
      phoneViewport = phone;
      const event = { matches: phone, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function phoneRoute(route: PhoneHistoryRoute): PhoneHistoryRoute {
  history.replaceState(encodePhoneHistoryRoute(route), "");
  return route;
}

function currentPhoneRoute(): PhoneHistoryRoute | undefined {
  return decodePhoneHistoryRoute(history.state);
}

function popPhoneRoute(route: PhoneHistoryRoute): void {
  history.replaceState(encodePhoneHistoryRoute(route), "");
  window.dispatchEvent(new PopStateEvent("popstate", {
    state: encodePhoneHistoryRoute(route),
  }));
}

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
    compacting: false,
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
    compactionModel: null,
    defaultThinkingLevel: "off",
    defaultServiceTier: null,
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
    compactionModel: null,
    defaultThinkingLevel: "off",
    defaultServiceTier: null,
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
    items: snapshotItems([{
      id: `preview-${text}`,
      role: "user",
      text,
      thinking: "",
      tools: [],
    }]),
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
      items: snapshotItems([{
        id: "focus-replacement-source-a",
        role: "user",
        text: "focus replacement source A",
        thinking: "",
        tools: [],
      }]),
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

async function pasteDraftImage(name = "draft.png"): Promise<void> {
  fireEvent.paste(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
    clipboardData: {
      files: [new File(["draft-image"], name, { type: "image/png" })],
    },
  });
  await waitFor(() => expect(screen.getByRole("img", {
    name: "待发送图片 1",
  })).toBeVisible());
}

describe("App", () => {
  it("sends an exact durable image request from a clicked placeholder", () => {
    const target = {
      close: vi.fn(),
      location: { replace: vi.fn() },
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(target);
    const sessionId = startFocusReplacementProject();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      items: snapshotItems([{
        id: "durable-image-message",
        role: "user",
        text: "[图片]",
        thinking: "",
        tools: [],
        imageRefs: [{
          offset: 0,
          source: {
            messageId: "durable-image-message",
            imageOrdinal: 0,
          },
        }],
      }]),
      window: completeConversationWindow,
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "在新标签页中打开图片 1",
    }));

    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(latestCommand("open_image")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      messageId: "durable-image-message",
      imageOrdinal: 0,
    });
  });

  it("opens an initial phone chat route with an exact conversation open", () => {
    mockPhoneViewport();
    phoneRoute({
      screen: "chat",
      cwd: "E:\\route-workspace",
      conversationId: CONVERSATION_B,
    });
    render(<App />);

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\route-workspace",
      conversation: { kind: "open", conversationId: CONVERSATION_B },
    });
  });

  it("fails closed before protocol readiness when selecting a workspace", () => {
    socketMock.helloVersion = PROTOCOL_VERSION + 1;
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));

    render(<App />);

    const target = screen.getByRole("button", { name: "打开工作区 second" });
    expect(target).toBeDisabled();
    fireEvent.click(target);

    expect(socketMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "initialize",
      cwd: "E:\\second",
    }));
    expect(screen.getByRole("button", { name: "打开工作区 first" }))
      .toHaveAttribute("aria-current", "true");
    expect(target).not.toHaveClass("unavailable");
  });

  it("previews, durably confirms, and follows broadcast color schemes", () => {
    startFocusReplacementProject();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开外观设置" }));

    fireEvent.click(screen.getByRole("radio", { name: /Classic Rebel/ }));
    expect(document.documentElement).toHaveAttribute(
      "data-color-scheme",
      "classic-rebel",
    );
    const command = latestCommand("set_color_scheme");
    expect(command.colorScheme).toBe("classic-rebel");
    expect(screen.getByRole("radio", { name: /Quiet Rebel/ })).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "ui_preferences_changed",
      uiPreferences: { colorScheme: "classic-rebel" },
      commandId: command.commandId,
    }));
    expect(screen.queryByRole("button", { name: "重试保存" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Classic Rebel/ })).toBeEnabled();

    act(() => socketMock.rawEmit?.({
      type: "ui_preferences_changed",
      uiPreferences: { colorScheme: "quiet-rebel" },
    }));
    expect(document.documentElement).toHaveAttribute(
      "data-color-scheme",
      "quiet-rebel",
    );
    expect(screen.getByRole("radio", { name: /Quiet Rebel/ })).toBeChecked();
  });

  it("keeps an offline color preview unsaved until an explicit retry is confirmed", () => {
    startFocusReplacementProject();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开外观设置" }));
    act(() => socketMock.status?.(false));

    fireEvent.click(screen.getByRole("radio", { name: /Classic Rebel/ }));
    expect(document.documentElement).toHaveAttribute(
      "data-color-scheme",
      "classic-rebel",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("尚未保存");
    expect(screen.getByRole("button", { name: "重试保存" })).toBeDisabled();

    act(() => {
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
        uiPreferences: { colorScheme: "quiet-rebel" },
      });
    });
    expect(document.documentElement).toHaveAttribute(
      "data-color-scheme",
      "classic-rebel",
    );
    const retry = screen.getByRole("button", { name: "重试保存" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    const command = latestCommand("set_color_scheme");
    act(() => socketMock.rawEmit?.({
      type: "ui_preferences_changed",
      uiPreferences: { colorScheme: "classic-rebel" },
      commandId: command.commandId,
    }));
    expect(screen.queryByRole("button", { name: "重试保存" }))
      .not.toBeInTheDocument();
  });

  it("keeps the current workspace projection when rail navigation is offline", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    render(<App />);
    const sessionId = latestSessionId();
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
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: snapshotItems([{
          id: "offline-source",
          role: "assistant",
          text: "offline source projection",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });
    const initializeCount = socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    ).length;

    act(() => socketMock.status?.(false));
    const target = screen.getByRole("button", { name: "打开工作区 second" });
    expect(target).toBeDisabled();
    fireEvent.click(target);

    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(initializeCount);
    expect(screen.getByText("offline source projection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开工作区 first" }))
      .toHaveAttribute("aria-current", "true");
    expect(target).not.toHaveClass("unavailable");
  });

  it("does not write or subscribe to Browser History outside the phone breakpoint", () => {
    mockPhoneViewport(false);
    const pushState = vi.spyOn(history, "pushState");
    const replaceState = vi.spyOn(history, "replaceState");
    const addEventListener = vi.spyOn(window, "addEventListener");
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));

    render(<App />);

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(addEventListener.mock.calls.some(([type]) => type === "popstate"))
      .toBe(false);
  });

  it("enters phone from desktop from current authority without replaying stale history", () => {
    const viewport = mockPhoneViewport(false);
    phoneRoute({
      screen: "chat",
      cwd: "E:\\stale",
      conversationId: CONVERSATION_B,
    });
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));

    render(<App />);
    const sentBeforePhone = socketMock.send.mock.calls.length;
    act(() => viewport.setPhoneViewport(true));

    expect(currentPhoneRoute()).toEqual({
      screen: "conversations",
      cwd: "E:\\work",
    });
    expect(socketMock.send).toHaveBeenCalledTimes(sentBeforePhone);
  });

  it("defers the latest phone pop until an open workspace dialog is explicitly closed", async () => {
    mockPhoneViewport();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "添加工作区" }));
    expect(screen.getByRole("dialog", { name: "开启工作区" }))
      .toBeInTheDocument();

    act(() => popPhoneRoute({ screen: "conversations", cwd: "E:\\work" }));
    expect(screen.getByRole("dialog", { name: "开启工作区" }))
      .toBeInTheDocument();
    expect(socketMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "initialize",
      cwd: "E:\\work",
    }));

    fireEvent.click(screen.getByRole("button", { name: "关闭开启工作区" }));
    await waitFor(() => expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "recent" },
    }));
  });

  it("drops a deferred phone pop when resizing away from phone", () => {
    const viewport = mockPhoneViewport();
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "添加工作区" }));
    act(() => popPhoneRoute({ screen: "conversations", cwd: "E:\\work" }));

    act(() => viewport.setPhoneViewport(false));
    fireEvent.click(screen.getByRole("button", { name: "关闭开启工作区" }));
    act(() => viewport.setPhoneViewport(true));

    expect(currentPhoneRoute()).toEqual({ screen: "workspaces" });
    expect(socketMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "initialize",
      cwd: "E:\\work",
    }));
  });

  it("pushes only accepted phone navigation and keeps a popped list visible after late focus events", () => {
    mockPhoneViewport();
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    render(<App />);
    const sessionId = latestSessionId();

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

    expect(currentPhoneRoute()).toEqual({ screen: "conversations", cwd: "E:\\work" });
    socketMock.send.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(currentPhoneRoute()).toEqual({ screen: "conversations", cwd: "E:\\work" });

    socketMock.send.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(currentPhoneRoute()).toEqual({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });

    act(() => popPhoneRoute({ screen: "conversations", cwd: "E:\\work" }));
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_B,
      focusId: FOCUS_A_SECOND,
      items: snapshotItems([{
        id: "late-popped-focus",
        role: "assistant",
        text: "late focus",
        thinking: "",
        tools: [],
      }]),
      window: completeConversationWindow,
    }));
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
  });

  it("replaces a failed phone chat route and only treats a complete project snapshot as absence", () => {
    mockPhoneViewport();
    socketMock.autoFocus = false;
    phoneRoute({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });
    render(<App />);
    const failedSessionId = latestSessionId();
    const failedInitialize = latestCommand("initialize");

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: failedInitialize.commandId,
      sessionId: failedSessionId,
      conversationId: CONVERSATION_B,
      message: "conversation is gone",
    }));
    expect(currentPhoneRoute()).toEqual({ screen: "conversations", cwd: "E:\\work" });
    expect(latestCommand("initialize").conversation).toEqual({ kind: "recent" });

    cleanup();
    socketMock.instances.splice(0);
    socketMock.send.mockClear();
    socketMock.autoFocus = true;
    phoneRoute({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });
    render(<App />);
    const sessionId = latestSessionId();
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
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationSummary(CONVERSATION_ID, "A")],
        truncated: true,
      });
    });
    expect(currentPhoneRoute()).toEqual({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });

    act(() => socketMock.emit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationSummary(CONVERSATION_ID, "A")],
      truncated: false,
    }));
    expect(currentPhoneRoute()).toEqual({ screen: "conversations", cwd: "E:\\work" });
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
  });

  it("pushes a durable chat route only after a desktop-to-phone role creation attaches its conversation", () => {
    const viewport = mockPhoneViewport(false);
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    render(<App />);
    const sessionId = latestSessionId();
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
          toolMode: "read_only",
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
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByRole("button", { name: "使用 Default 开始会话" }));
    const create = latestCommand("create_conversation");

    act(() => viewport.setPhoneViewport(true));
    expect(screen.getByRole("main")).toHaveClass("role-selection-page");
    expect(currentPhoneRoute()).toEqual({
      screen: "conversations",
      cwd: "E:\\work",
    });

    act(() => socketMock.emit?.({
      type: "focus_attached",
      operation: "create_conversation",
      commandId: create.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: FOCUS_A_SECOND,
    }));

    expect(currentPhoneRoute()).toEqual({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });
    expect(screen.getByRole("heading", { name: "正在同步会话" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });

  it("projects phone navigation locally without duplicating Chat or following late events", async () => {
    const viewport = mockPhoneViewport();
    localStorage.setItem(
      "piweb.workspaces",
      JSON.stringify(["E:\\work", "E:\\other"]),
    );
    const rendered = render(<App />);
    const sessionId = latestSessionId();

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
          conversationSummary(CONVERSATION_B, "B"),
        ],
        truncated: false,
      });
    });

    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "工作区" }))
      .not.toBeInTheDocument();
    expect(rendered.container.querySelectorAll(".app-shell")).toHaveLength(1);
    expect(document.body).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "当前会话 A" }));
    expect(screen.getByRole("main")).toHaveClass("app-shell");
    expect(screen.queryByRole("complementary", { name: "项目会话栏" }))
      .not.toBeInTheDocument();

    const settingsLauncher = screen.getByRole("button", { name: "打开设置" });
    expect(settingsLauncher).toHaveTextContent("设置");
    expect(screen.queryByRole("button", { name: "打开会话列表" }))
      .not.toBeInTheDocument();
    settingsLauncher.focus();
    fireEvent.click(settingsLauncher);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" }))
      .toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(settingsLauncher).toHaveFocus());

    fireEvent.click(settingsLauncher);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" }))
      .toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "打开外观设置" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "外观" }))
      .toHaveFocus());
    act(() => viewport.setPhoneViewport(false));
    const desktopSettingsLauncher = screen.getByRole("button", { name: "设置" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "打开外观设置" }))
      .toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(desktopSettingsLauncher).toHaveFocus());

    fireEvent.click(desktopSettingsLauncher);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭" }))
      .toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "模型连接" }))
      .toHaveFocus());
    act(() => viewport.setPhoneViewport(true));
    const responsiveSettingsLauncher = screen.getByRole("button", { name: "打开设置" });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(responsiveSettingsLauncher).toHaveFocus());

    const sentBeforeBack = socketMock.send.mock.calls.length;
    const chatBack = screen.getByRole("button", { name: "返回会话列表" });
    chatBack.focus();
    fireEvent.click(chatBack);
    await waitFor(() => expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "会话" }).closest("header"))
      .toHaveFocus();
    expect(socketMock.send).toHaveBeenCalledTimes(sentBeforeBack);

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      items: snapshotItems([{
        id: "late-phone-message",
        role: "assistant",
        text: "late phone event",
        thinking: "",
        tools: [],
      }]),
      window: completeConversationWindow,
    }));
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();

    const newConversation = screen.getByRole("button", { name: "新建会话" });
    newConversation.focus();
    fireEvent.click(newConversation);
    expect(screen.getByRole("main")).toHaveClass("role-selection-page");
    expect(screen.getByRole("heading", { name: "新建会话" }).closest("header"))
      .toHaveFocus();
    const sentBeforeRoleBack = socketMock.send.mock.calls.length;
    const roleBack = screen.getByRole("button", { name: "返回会话列表" });
    roleBack.focus();
    fireEvent.click(roleBack);
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "会话" }).closest("header"))
      .toHaveFocus();
    expect(socketMock.send).toHaveBeenCalledTimes(sentBeforeRoleBack);

    socketMock.send.mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument();
    expect(rendered.container.querySelectorAll(".app-shell")).toHaveLength(1);

    socketMock.send.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.getByRole("main")).toHaveClass("app-shell");
    const focusCommandsAfterAcceptedSelection = sentFocusCommandCount();
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "当前会话 B" }));
    expect(screen.getByRole("main")).toHaveClass("app-shell");
    expect(sentFocusCommandCount()).toBe(focusCommandsAfterAcceptedSelection);
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    await waitFor(() => expect(screen.getByRole("complementary", { name: "项目会话栏" }))
      .toBeInTheDocument());

    socketMock.send.mockReturnValue(false);
    const sentBeforeWorkspaceBack = socketMock.send.mock.calls.length;
    const workspaceLauncher = screen.getByRole("button", { name: "显示工作区" });
    workspaceLauncher.focus();
    fireEvent.click(workspaceLauncher);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "工作区" }))
      .toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "工作区" }).closest("header"))
      .toHaveFocus();
    expect(screen.queryByRole("complementary", { name: "项目会话栏" }))
      .not.toBeInTheDocument();
    expect(socketMock.send).toHaveBeenCalledTimes(sentBeforeWorkspaceBack);

    fireEvent.click(screen.getByRole("button", {
      name: "打开工作区 other",
    }));
    expect(screen.getByRole("navigation", { name: "工作区" }))
      .toBeInTheDocument();
    expect(latestCommand("initialize").cwd).toBe("E:\\other");
  });

  it("keeps one text-and-image draft while phone scenes hide and reveal the mounted chat", async () => {
    mockPhoneViewport();
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    render(<App />);
    const sessionId = latestCommand("initialize").sessionId;
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
          conversationSummary(CONVERSATION_B, "B"),
        ],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "当前会话 A" }));
    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "phone draft for A" } });
    await pasteDraftImage("phone-a.png");
    const focusCommandsBeforeNavigation = sentFocusCommandCount();

    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    await waitFor(() => expect(screen.getByRole("complementary", {
      name: "项目会话栏",
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "显示工作区" }));
    await waitFor(() => expect(screen.getByRole("navigation", {
      name: "工作区",
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 work" }));
    fireEvent.click(screen.getByRole("button", { name: "当前会话 A" }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("phone draft for A");
    expect(screen.getByRole("img", { name: "待发送图片 1" })).toBeVisible();
    expect(sentFocusCommandCount()).toBe(focusCommandsBeforeNavigation);
    expect(latestSessionId()).toBe(sessionId);
  });

  it("leaves initial phone focus alone until an empty project opens role selection", () => {
    mockPhoneViewport();
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    render(<App />);
    const sessionId = latestSessionId();
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
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          providers: [],
        },
      });
      socketMock.emit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [],
        truncated: false,
      });
    });

    expect(document.body).toHaveFocus();
    const newConversation = screen.getByRole("button", { name: "新建会话" });
    newConversation.focus();
    fireEvent.click(newConversation);
    expect(screen.getByRole("heading", { name: "新建会话" }).closest("header"))
      .toHaveFocus();
  });

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

  it("restores the exact empty-workbench launcher after closing Setup", async () => {
    render(<App />);

    const launcher = screen.getByRole("button", { name: "开启工作区" });
    expect(launcher.isConnected).toBe(true);
    launcher.focus();
    expect(launcher).toHaveFocus();
    fireEvent.click(launcher);

    const cwd = screen.getByRole("textbox", { name: "项目目录" });
    expect(cwd).toHaveAttribute("data-modal-autofocus");
    await waitFor(() => expect(cwd).toHaveFocus());

    const close = screen.getByRole("button", { name: "关闭开启工作区" });
    close.focus();
    fireEvent.click(close);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "开启工作区" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
  });

  it("restores exact focus owners through nested directory browsing", async () => {
    render(<App />);

    const launcher = screen.getByRole("button", { name: "开启工作区" });
    launcher.focus();
    fireEvent.click(launcher);
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "项目目录",
    })).toHaveFocus());

    const picker = screen.getByRole("button", { name: "选择文件夹" });
    picker.focus();
    expect(picker).toHaveFocus();
    fireEvent.click(picker);

    const directoryDialog = screen.getByRole("dialog", { name: "选择项目目录" });
    const directoryClose = screen.getByRole("button", { name: "关闭目录选择" });
    await waitFor(() => expect(directoryClose).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(directoryDialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "选择项目目录" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "开启工作区" }))
        .toBeInTheDocument();
      expect(picker.isConnected).toBe(true);
      expect(picker).toHaveFocus();
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭开启工作区" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "开启工作区" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "browse_directory",
    )).toHaveLength(1);
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize" }),
    );
  });

  it("keeps only the top modal accessible while extension UI covers nested directory browsing", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const directoryClose = screen.getByRole("button", { name: "关闭目录选择" });
    directoryClose.focus();
    expect(screen.queryByRole("dialog", { name: "开启工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Extension question", message: "Continue?" },
    }));

    expect(screen.getByRole("dialog", { name: "Extension question" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "开启工作区" })).not.toBeInTheDocument();
    expect(document.querySelector(".directory-browser-modal"))
      .toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
      expect(directoryClose).toHaveFocus();
    });
  });

  it("invalidates directory responses when initialize replaces its control scope", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
    const input = screen.getByRole("textbox", { name: "项目目录" });
    fireEvent.change(input, { target: { value: "E:\\next" } });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const browse = latestCommand("browse_directory");
    const form = input.closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    expect(latestCommand("initialize").cwd).toBe("E:\\next");
    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();

    act(() => {
      socketMock.emit?.({
        type: "directory_listing",
        commandId: browse.commandId,
        path: "E:\\late",
        parentPath: "E:\\",
        directories: [{ name: "late child", path: "E:\\late\\child" }],
        truncated: false,
      });
      socketMock.emit?.({
        type: "error",
        scope: "command",
        operation: "browse_directory",
        commandId: browse.commandId,
        message: "late listing error",
      });
    });

    expect(screen.queryByRole("dialog", { name: "选择项目目录" })).not.toBeInTheDocument();
    expect(screen.queryByText("E:\\late")).not.toBeInTheDocument();
    expect(screen.queryByText("late listing error")).not.toBeInTheDocument();
  });

  it("dismisses Setup only from the exact backdrop and restores its launcher", async () => {
    render(<App />);

    const launcher = screen.getByRole("button", { name: "开启工作区" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = screen.getByRole("dialog", { name: "开启工作区" });
    const backdrop = dialog.parentElement!;
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "项目目录",
    })).toHaveFocus());

    const interiorMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(dialog, interiorMouseDown);
    expect(interiorMouseDown.defaultPrevented).toBe(false);
    expect(dialog).toBeInTheDocument();

    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(backdrop, backdropMouseDown);
    expect(backdropMouseDown.defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "开启工作区" }))
        .not.toBeInTheDocument();
      expect(launcher.isConnected).toBe(true);
      expect(launcher).toHaveFocus();
    });
    expect(socketMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "initialize" }),
    );
  });

  it("shows ready conversation identity without inventing a missing root", () => {
    const { container } = render(<App />);
    const sessionId = startFromSetup();
    const root = {
      ...conversationSummary(CONVERSATION_B, "根任务"),
      rootConversationId: CONVERSATION_B,
    };
    const child = {
      ...conversationSummary(CONVERSATION_ID, "测试 Agent"),
      rootConversationId: CONVERSATION_B,
      createdBy: {
        kind: "conversation" as const,
        conversationId: CONVERSATION_B,
      },
    };
    const attentionConversation = {
      ...conversationSummary(CONVERSATION_C, "需处理会话"),
      attention: true,
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
        conversations: [root, child, attentionConversation],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [],
        window: completeConversationWindow,
      });
    });

    const collaborationPath = screen.getByRole("navigation", { name: "协作路径" });
    expect(collaborationPath).toHaveTextContent("根任务›测试 Agent");
    expect(collaborationPath.querySelector(".topbar-session-ordinal"))
      .toHaveTextContent("01");
    expect(container.querySelector(
      `[data-root-conversation-id="${CONVERSATION_B}"] .conversation-sidebar-ordinal`,
    )).toHaveTextContent("01");
    expect(collaborationPath).toHaveTextContent("2 AGENTS");

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
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
          { ...root, updatedAt: "2026-07-19T13:00:00.000Z" },
          { ...child, updatedAt: "2026-07-19T13:00:00.000Z" },
          {
            ...attentionConversation,
            attention: false,
            activity: { kind: "running", runId: RUN_B },
            updatedAt: "2026-07-19T14:00:00.000Z",
          },
        ],
        truncated: false,
      });
    });
    expect(collaborationPath.querySelector(".topbar-session-ordinal"))
      .toHaveTextContent("01");
    expect(container.querySelector(
      `[data-root-conversation-id="${CONVERSATION_B}"] .conversation-sidebar-ordinal`,
    )).toHaveTextContent("01");

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [root, {
        ...conversationSummary(CONVERSATION_ID, "测试 Agent"),
        createdBy: child.createdBy,
      }],
      truncated: false,
    }));
    const standalonePath = screen.getByRole("navigation", { name: "协作路径" });
    expect(standalonePath).toHaveTextContent("测试 Agent");
    expect(standalonePath).not.toHaveTextContent("根任务›");
    expect(standalonePath.querySelector(".topbar-session-ordinal"))
      .toHaveTextContent("01");
    expect(standalonePath).toHaveTextContent("1 AGENTS");

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [root, {
        ...conversationSummary(CONVERSATION_ID, "测试 Agent"),
        createdBy: child.createdBy,
      }],
      truncated: true,
    }));
    expect(screen.getByRole("navigation", { name: "协作路径" }))
      .not.toHaveTextContent("AGENTS");
  });

  it("stabilizes project title lookup and fails it closed during deletion and focus transition", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const current = conversationSummary(CONVERSATION_ID, "Current");
    const target = conversationSummary(CONVERSATION_B, "审查 Agent");
    const targetMessage = {
      kind: "message" as const,
      id: "assistant-target",
      runId: RUN_ID,
      role: "assistant" as const,
      text: "",
      thinking: "",
      tools: [{
        toolCallId: "send-target",
        toolName: "send_session_message",
        args: { conversationId: CONVERSATION_B, message: "请核对。" },
        status: "done" as const,
      }],
      parts: [{ kind: "tool" as const, toolCallId: "send-target" }],
    };
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\default",
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
        conversations: [current, target],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [targetMessage],
        window: completeConversationWindow,
      });
    });
    expect(screen.getByText("审查 Agent", { selector: ".activity-group-detail" }))
      .toBeInTheDocument();
    const initialLookup = renderIsolationMock.chat.mock.calls.at(-1)?.[0] as
      ConversationTitleLookup;

    renderIsolationMock.chat.mockClear();
    renderIsolationMock.message.mockClear();
    const updatedCurrent = {
      ...current,
      updatedAt: "2026-07-19T10:00:00.000Z",
    };
    const updatedTarget = {
      ...target,
      updatedAt: "2026-07-19T11:00:00.000Z",
    };
    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [updatedCurrent, updatedTarget],
      truncated: false,
    }));
    expect(renderIsolationMock.chat).not.toHaveBeenCalled();
    expect(renderIsolationMock.message).not.toHaveBeenCalled();

    const activeTarget = {
      ...updatedTarget,
      activity: { kind: "running" as const, runId: RUN_B },
    };
    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [updatedCurrent, activeTarget],
      truncated: false,
    }));
    expect(renderIsolationMock.chat).not.toHaveBeenCalled();
    expect(renderIsolationMock.message).not.toHaveBeenCalled();

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [updatedCurrent, activeTarget],
      truncated: true,
    }));
    const truncatedLookup = renderIsolationMock.chat.mock.calls.at(-1)?.[0] as
      ConversationTitleLookup;
    expect(truncatedLookup).not.toBe(initialLookup);
    expect(truncatedLookup.get(CONVERSATION_B)).toBe("审查 Agent #6a04656b");
    expect(screen.getByText("审查 Agent #6a04656b", {
      selector: ".activity-group-detail",
    })).toBeInTheDocument();

    const added = conversationSummary(
      "33333333-3333-4333-8333-333333333333",
      "新增 Agent",
    );
    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [updatedCurrent, activeTarget, added],
      truncated: false,
    }));
    const addedLookup = renderIsolationMock.chat.mock.calls.at(-1)?.[0] as
      ConversationTitleLookup;
    expect(addedLookup).not.toBe(initialLookup);
    expect(addedLookup.get(added.id)).toBe("新增 Agent");

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [
        current,
        { ...target, name: "已改名审查 Agent" },
        added,
      ],
      truncated: false,
    }));
    const renamedLookup = renderIsolationMock.chat.mock.calls.at(-1)?.[0] as
      ConversationTitleLookup;
    expect(renamedLookup).not.toBe(addedLookup);
    expect(screen.getByText("已改名审查 Agent", {
      selector: ".activity-group-detail",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "删除会话 已改名审查 Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    const deletionLookup = renderIsolationMock.chat.mock.calls.at(-1)?.[0] as
      ConversationTitleLookup;
    expect(deletionLookup.has(CONVERSATION_B)).toBe(false);
    expect(screen.getByText("未知会话 #6a04656b", {
      selector: ".activity-group-detail",
    })).toBeInTheDocument();

    const deleteCommand = latestCommand("delete_conversation");
    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "delete_conversation",
      commandId: deleteCommand.commandId,
      sessionId,
      message: "blocked",
    }));
    renderIsolationMock.chat.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "打开会话 已改名审查 Agent" }));
    expect(screen.getByRole("heading", { name: "正在同步会话" }))
      .toBeInTheDocument();
    expect(renderIsolationMock.chat).not.toHaveBeenCalled();
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
          items: [{ id: "focused", text: "Focused item", status: "pending" }],
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
          items: [{ id: "focused", text: "Focused item", status: "completed" }],
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
          items: [{ id: "focused", text: "Focused item", status: "completed" }],
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

  it("does not apply App state from stale same-focus snapshots", async () => {
    render(<App />);
    const sessionId = startFromSetup();
    const currentPromptId = "10000000-0000-4000-8000-000000000001";
    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
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
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        projectionSeq: 5,
        role: defaultConversationRole({ name: "Current role" }),
        items: [],
        loopList: {
          items: [{ id: "current", text: "Current task", status: "active" }],
          armed: true,
        },
        pendingPrompts: [{ promptId: currentPromptId, text: "Current waiting" }],
        window: completeConversationWindow,
      });
      socketMock.rawEmit?.({
        type: "session_event",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        runId: RUN_ID,
        projectionSeq: 6,
        event: { type: "run_queued" },
      });
    });
    expect(screen.getByRole("button", { name: "查看会话角色 Current role" }))
      .toBeInTheDocument();
    expect(screen.getByText("Current task")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("Current waiting");

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      projectionSeq: 5,
      role: defaultConversationRole({ name: "Watermark stale role" }),
      items: [],
      loopList: {
        items: [{ id: "watermark", text: "Watermark stale task", status: "completed" }],
        armed: false,
      },
      pendingPrompts: [{
        promptId: "10000000-0000-4000-8000-000000000002",
        text: "Watermark stale waiting",
      }],
      window: completeConversationWindow,
    }));
    expect(screen.queryByRole("button", { name: "查看会话角色 Watermark stale role" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("Watermark stale task")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("Current waiting");

    act(() => socketMock.rawEmit?.({
      type: "session_event",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      runId: RUN_ID,
      projectionSeq: 8,
      event: { type: "run_queued" },
    }));
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "给 Pi 发送消息",
    })).toBeEnabled());

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      projectionSeq: 6,
      role: defaultConversationRole({ name: "Gap stale role" }),
      items: [],
      loopList: {
        items: [{ id: "gap", text: "Gap stale task", status: "completed" }],
        armed: false,
      },
      pendingPrompts: [{
        promptId: "10000000-0000-4000-8000-000000000003",
        text: "Gap stale waiting",
      }],
      window: completeConversationWindow,
    }));
    expect(screen.getByRole("button", { name: "查看会话角色 Current role" }))
      .toBeInTheDocument();
    expect(screen.queryByText("Gap stale task")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("Current waiting");
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
  });

  it("rejects a foreign-project state for the current focus", () => {
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
        selectedModel: { provider: "provider", id: "current-model" },
        providers: [],
      },
    }));
    expect(screen.getByTitle("设置")).toHaveTextContent("current-model");

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: "8177b28d-c21d-40c2-b45f-6714ae096421",
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        cwd: "E:\\foreign",
        busy: true,
        thinkingLevel: "high",
        toolMode: "full_access",
        availableThinkingLevels: ["off", "high"],
        selectedModel: { provider: "foreign", id: "foreign-model" },
        providers: [],
      },
    }));
    expect(screen.getByTitle("设置")).toHaveTextContent("current-model");
    expect(screen.getByTitle("设置")).not.toHaveTextContent("foreign-model");
  });

  it("applies a matching target state deferred while conversation focus is pending", () => {
    const sessionId = startFocusReplacementProject();
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focus = latestCommand("focus_conversation");
    const targetFocusId = "ae301850-745d-44dd-a30f-000000000711";

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: targetFocusId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "deferred-model" },
        providers: [],
      },
    }));
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: focus.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: targetFocusId,
    }));

    expect(screen.getByTitle("设置")).toHaveTextContent("deferred-model");
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

  it("restores the most recently saved workspace on startup", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\last",
      "E:\\first",
    ]));

    render(<App />);

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\last",
      conversation: { kind: "recent" },
    });
    expect(screen.getByRole("button", { name: "打开工作区 last" }))
      .toHaveAttribute("aria-current", "true");
  });

  it("switches workspaces through the left rail without reordering them", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    const { container } = render(<App />);
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
    expect(Array.from(
      container.querySelectorAll<HTMLButtonElement>(".workspace-rail-item"),
      ({ ariaLabel }) => ariaLabel,
    )).toEqual(["打开工作区 first", "打开工作区 second"]);
    expect(JSON.parse(localStorage.getItem("piweb.workspaces") ?? "[]"))
      .toEqual(["E:\\first", "E:\\second"]);
  });

  it("closes the current workspace without opening another until the next startup", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    const view = render(<App />);
    const firstSessionId = latestCommand("initialize").sessionId;

    fireEvent.click(screen.getByRole("button", {
      name: "关闭工作区 first",
    }));

    expect(socketMock.send).toHaveBeenCalledWith({
      type: "close_session",
      sessionId: firstSessionId,
    });
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("piweb.workspaces") ?? "[]"))
      .toEqual(["E:\\second"]);
    expect(screen.getByRole("heading", { name: "还没有打开工作区" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开工作区 second" }))
      .not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("button", { name: /关闭工作区/ }))
      .not.toBeInTheDocument();

    view.unmount();
    render(<App />);
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(2);
    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\second",
      conversation: { kind: "recent" },
    });
  });

  it("reopens a visited workspace with its cached conversation while syncing", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
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
        items: snapshotItems([{
          id: "cached-user",
          runId: RUN_ID,
          role: "user",
          text: "缓存中的 A 对话",
          thinking: "",
          tools: [],
        }]),
        window: snapshotWindow,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\first",
      conversation: { kind: "open", conversationId: CONVERSATION_ID },
    });
    const initializeCount = socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    ).length;
    fireEvent.click(screen.getByRole("button", {
      name: "打开工作区 first",
    }));
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(initializeCount);
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
      .toBeEnabled();
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
        items: snapshotItems([{
          id: "stale-user",
          runId: RUN_ID,
          role: "user",
          text: "不应覆盖缓存",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "fresh-user",
          runId: RUN_B,
          role: "user",
          text: "新的权威 A 对话",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "cached-before-empty",
          runId: RUN_ID,
          role: "user",
          text: "cached conversation before empty project",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "reconnect-authoritative",
          role: "user",
          text: "exact reconnect authoritative",
          thinking: "",
          tools: [],
        }]),
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

  it("keeps a correlated recent-initialize draft editable while awaiting the exact snapshot", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
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
    expect(screen.queryByRole("note", { name: "历史记录不完整" })).toBeNull();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看会话角色 Preview Reader" }))
      .toBeInTheDocument();
    expect(screen.getByTitle("设置")).toBeEnabled();
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
    fireEvent.click(screen.getByTitle("设置"));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
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
    expect(screen.queryByRole("note", { name: "历史记录不完整" })).toBeNull();
    expect(screen.getByRole("status", { name: "正在同步工作区…" }))
      .toBeInTheDocument();
    const draftInput = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    expect(draftInput).toBeEnabled();
    fireEvent.change(draftInput, { target: { value: "draft while syncing" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

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
        items: snapshotItems([{
          id: "fresh-authoritative-b",
          role: "user",
          text: "fresh authoritative conversation",
          thinking: "",
          tools: [],
        }]),
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
      .toHaveValue("draft while syncing");
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
        items: snapshotItems([{
          id: "source-a-before-rapid-navigation",
          role: "user",
          text: "source A before rapid navigation",
          thinking: "",
          tools: [],
        }]),
        window,
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    expect(screen.getByRole("button", { name: "打开会话 C" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "收起会话栏" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", {
      name: /^(重命名|删除)会话 /,
    })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

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
        items: snapshotItems([{
          id: "late-a-snapshot",
          role: "assistant",
          text: "late A snapshot",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "late-b-snapshot-before-c-attach",
          role: "assistant",
          text: "late B snapshot before C attach",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "late-b-snapshot-after-c-attach",
          role: "assistant",
          text: "late B snapshot after C attach",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "authoritative-c-after-replacement",
          role: "assistant",
          text: "authoritative C after replacement",
          thinking: "",
          tools: [],
        }]),
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
    expect(screen.getByRole("button", { name: "收起会话栏" })).toBeEnabled();
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
    expect(screen.getByRole("status", { name: /正在同步会话/ }))
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
        items: snapshotItems([{
          id: "late-authoritative-b",
          role: "assistant",
          text: "late authoritative B",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "fresh-authoritative-c-after-attached-b",
          role: "assistant",
          text: "fresh authoritative C after attached B",
          thinking: "",
          tools: [],
        }]),
        window,
      });
    });

    expect(screen.queryByText("late authoritative B")).not.toBeInTheDocument();
    expect(screen.getByText("fresh authoritative C after attached B"))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
  });

  it("treats a throwing focus replacement send as rejected without cancelling the active transition", async () => {
    const measure = vi.spyOn(performance, "measure");
    const sessionId = startFocusReplacementProject();
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    measure.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    socketMock.send.mockImplementationOnce(() => {
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationSummary(CONVERSATION_D, "buffered throw event")],
        truncated: false,
      });
      throw new Error("synchronous send failure");
    });

    expect(() => fireEvent.click(
      screen.getByRole("button", { name: "打开会话 C" }),
    )).not.toThrow();
    expect(latestCommand("focus_conversation").conversationId).toBe(CONVERSATION_C);
    expect(screen.getByRole("alert")).toHaveTextContent("本地服务未连接");
    expect(screen.getByRole("button", { name: "当前会话 B" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "打开会话 C" }))
      .toBeInTheDocument();
    expect(screen.queryByText("buffered throw event")).not.toBeInTheDocument();

    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        items: snapshotItems([{
          id: "focus-b-after-send-throw",
          role: "assistant",
          text: "focus B remained authoritative",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });

    await waitFor(() => {
      const details = measure.mock.calls
        .filter(([name]) => name === "piweb.transition")
        .map(([, options]) => (options as PerformanceMeasureOptions).detail);
      expect(details).toHaveLength(2);
      expect(details.map(({ termination }) => termination)).toEqual([
        { kind: "failure", reason: "send-failed" },
        { kind: "success" },
      ]);
    });
    expect(screen.queryByText("focus replacement source A"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off", "high"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByText("focus B remained authoritative"))
      .toBeInTheDocument();
  });

  it("keeps a deferred fallback locally editable while refresh restores send readiness", () => {
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
        items: snapshotItems([{
          id: "deferred-authoritative-b",
          role: "assistant",
          text: "deferred authoritative B",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });

    expect(screen.queryByText("deferred authoritative B")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: /正在同步会话/ }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "conversation_item",
      sessionId,
      conversationId: CONVERSATION_B,
      focusId: focusBId,
      item: snapshotItems([{
        id: "live-suffix-before-fallback-refresh",
        runId: RUN_B,
        role: "assistant",
        text: "live suffix recovered by refresh",
        thinking: "",
        tools: [],
      }])[0] !,
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
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
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
      items: snapshotItems([{
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
      }]),
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
    expect(screen.getByRole("heading", { name: "正在同步会话" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(screen.queryByTitle("设置")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", {
      name: /^(重命名|删除)会话 /,
    })) {
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
        items: snapshotItems([{
          id: "late-fallback-b-snapshot",
          role: "assistant",
          text: "late fallback B snapshot",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });

    expect(screen.getByText("late fallback B snapshot")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在同步会话…" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    expect(screen.getByTitle("设置")).toBeEnabled();
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
        items: snapshotItems([{
          id: "multi-hop-b",
          role: "assistant",
          text: "multi-hop fallback B",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "multi-hop-c",
          role: "assistant",
          text: "multi-hop fallback C",
          thinking: "",
          tools: [],
        }]),
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
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
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
        items: snapshotItems([{
          id: "stale-c-after-d-success",
          role: "assistant",
          text: "stale C after D success",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "latest-d-authoritative",
          role: "assistant",
          text: "latest D authoritative",
          thinking: "",
          tools: [],
        }]),
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
    expect(screen.getByRole("status", { name: /正在同步会话/ }))
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
          compacting: false,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 1,
          compacting: false,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        role: defaultConversationRole(),
        items: snapshotItems([{
          id: "source-a",
          role: "user",
          text: "source A authoritative",
          thinking: "",
          tools: [],
        }]),
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
      .toBeEnabled();
    expect(screen.getByRole("button", { name: "重命名会话 B" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除会话 B" })).toBeDisabled();
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
      .toBeEnabled();

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
        items: snapshotItems([{
          id: "fresh-b",
          role: "user",
          text: "B authoritative snapshot",
          thinking: "",
          tools: [],
        }]),
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
      compacting: false,
    };
    const conversationB = {
      id: CONVERSATION_B,
      name: "B",
      preview: "B",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
      compacting: false,
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
        items: snapshotItems([{
          id: "source-before-deletion",
          role: "user",
          text: "source before deletion",
          thinking: "",
          tools: [],
        }]),
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

    expect(screen.getByRole("status", { name: /正在同步会话/ }))
      .toBeInTheDocument();
    expect(screen.queryByText("late deleted B preview"))
      .not.toBeInTheDocument();
    expect(screen.queryByText("source before deletion", { selector: "article" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("preserves absent conversation rows from an unknown-coverage snapshot", () => {
    const sessionId = startFocusReplacementProject([
      conversationSummary(CONVERSATION_B, "B"),
    ]);

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationSummary(CONVERSATION_ID, "A")],
      truncated: false,
      coverage: "unknown",
    }));

    expect(screen.getByRole("button", { name: "打开会话 B" }))
      .toBeInTheDocument();
  });

  it("keeps a truncated-absence preview locally editable and records it after paint", async () => {
    const measure = vi.spyOn(performance, "measure");
    render(<App />);
    const sessionId = startFromSetup();
    const conversationA = {
      id: CONVERSATION_ID,
      name: "A",
      preview: "A",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T08:00:00.000Z",
      messageCount: 1,
      compacting: false,
    };
    const conversationB = {
      id: CONVERSATION_B,
      name: "B",
      preview: "B",
      createdAt: "2026-07-19T08:00:00.000Z",
      updatedAt: "2026-07-19T09:00:00.000Z",
      messageCount: 1,
      compacting: false,
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
    expect(screen.getByRole("status", { name: /正在同步会话/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
    });
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focus.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
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
          conversationId: CONVERSATION_B,
          focusId: FOCUS_A_SECOND,
        },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        items: [],
        window: completeConversationWindow,
      });
    });
    await waitFor(() => expect(measure.mock.calls.some(([, options]) => (
      (options as PerformanceMeasureOptions).detail?.firstPresentation?.source === "preview"
    ))).toBe(true));
  });

  it("copies exact host phase diagnostics into transition detail without retaining wire identities", async () => {
    const measure = vi.spyOn(performance, "measure");
    socketMock.autoFocus = false;
    render(<App />);
    const sessionId = startFromSetup();
    const initialize = latestCommand("initialize");
    const transitionDiagnostics = {
      version: 1 as const,
      commandId: initialize.commandId!,
      operation: "initialize" as const,
      validationMs: 1,
      contextOrCatalogMs: 2,
      presentationOrTargetReadMs: 3,
      actorActivationOrLeaseMs: 4,
      snapshotProjectionMs: 5,
    };

    act(() => {
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
        items: [],
        window: completeConversationWindow,
        transitionDiagnostics,
      });
    });

    await waitFor(() => expect(measure).toHaveBeenCalled());
    const detail = (measure.mock.calls.find(
      ([name]) => name === "piweb.transition",
    )?.[1] as PerformanceMeasureOptions | undefined)?.detail;
    expect(detail).toMatchObject({
      host: {
        version: 1,
        validationMs: 1,
        contextOrCatalogMs: 2,
        presentationOrTargetReadMs: 3,
        actorActivationOrLeaseMs: 4,
        snapshotProjectionMs: 5,
      },
      termination: { kind: "success" },
    });
    expect(JSON.stringify(detail)).not.toContain(initialize.commandId);
    expect(JSON.stringify(detail)).not.toContain(sessionId);
    expect(JSON.stringify(detail)).not.toContain(CONVERSATION_ID);
  });

  it("consumes empty initialize host diagnostics from the correlated attach", async () => {
    const measure = vi.spyOn(performance, "measure");
    socketMock.autoFocus = false;
    render(<App />);
    const sessionId = startFromSetup();
    const initialize = latestCommand("initialize");

    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "initialize",
      commandId: initialize.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      transitionDiagnostics: {
        version: 1,
        commandId: initialize.commandId!,
        operation: "initialize",
        validationMs: 1,
        contextOrCatalogMs: 2,
        presentationOrTargetReadMs: 3,
        actorActivationOrLeaseMs: 0,
        snapshotProjectionMs: null,
      },
    }));

    await waitFor(() => expect(measure).toHaveBeenCalledWith(
      "piweb.transition",
      expect.objectContaining({
        detail: expect.objectContaining({
          host: expect.objectContaining({
            snapshotProjectionMs: null,
          }),
          interactiveMs: expect.any(Number),
          termination: { kind: "success" },
        }),
      }),
    ));
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
          compacting: false,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 1,
          compacting: false,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: snapshotItems([{
          id: "source-before-stale-preview",
          role: "user",
          text: "source before stale preview",
          thinking: "",
          tools: [],
        }]),
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
          compacting: false,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "B",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
        }],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: snapshotItems([{
          id: "source-history",
          runId: RUN_ID,
          role: "user",
          text: "source A",
          thinking: "",
          tools: [],
        }]),
        window,
      });
    });
    const composer = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(composer, { target: { value: "source A draft" } });
    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByText("source A")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    const transitionStatuses = screen.getAllByRole("status");
    expect(transitionStatuses).toHaveLength(1);
    expect(transitionStatuses[0]).toHaveAccessibleName(
      "正在同步会话…；正在打开会话 B",
    );
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeDisabled();

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
        items: snapshotItems([{
          id: "late-source",
          runId: RUN_ID,
          role: "user",
          text: "late source snapshot",
          thinking: "",
          tools: [],
        }]),
        window,
      });
      socketMock.rawEmit?.({
        type: "conversation_item",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        item: snapshotItems([{
          id: "late-source-live",
          runId: RUN_B,
          role: "assistant",
          text: "late source live",
          thinking: "",
          tools: [],
        }])[0] !,
      });
    });
    expect(screen.getByRole("status", { name: /正在同步会话/ })).toBeInTheDocument();
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
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("source A draft");
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

    socketMock.send.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByRole("status", { name: "正在同步会话…" })).not.toBeInTheDocument();
    expect(screen.getByText("source A")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("source A draft");
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    socketMock.send.mockReturnValue(true);
  });

  it("hot-switches A to B to A with a locally editable cached conversation presentation", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const window = {
      omittedBefore: true,
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
        compacting: false,
      }, {
        id: CONVERSATION_B,
        name: "B",
        preview: "B",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T09:00:00.000Z",
        messageCount: 1,
        compacting: false,
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
      items: snapshotItems([{
        id: `${conversationId}-history`,
        runId: RUN_ID,
        role: "user",
        text,
        thinking: "",
        tools: [],
      }]),
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
        item: snapshotItems([{
          id: "a-live-item",
          runId: RUN_B,
          role: "assistant",
          text: "A live card",
          thinking: "",
          tools: [],
        }])[0] !,
      });
    });
    expect(screen.getByRole("note", { name: "历史记录不完整" }))
      .toBeInTheDocument();
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
    expect(screen.queryByRole("note", { name: "历史记录不完整" })).toBeNull();
    expect(screen.getByRole("status", { name: /正在同步会话/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
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
    expect(screen.queryByRole("note", { name: "历史记录不完整" })).toBeNull();
    expect(screen.getByRole("status", { name: /正在同步会话/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();

    act(() => socketMock.rawEmit?.(snapshotFor(
      CONVERSATION_ID,
      focusA,
      "fresh A history",
    )));
    expect(screen.queryByRole("status", { name: "正在同步会话…" })).not.toBeInTheDocument();
    expect(screen.getByText("fresh A history")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "历史记录不完整" }))
      .toBeInTheDocument();
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
    expect(screen.getByRole("status", { name: /正在同步会话/ })).toBeInTheDocument();
  });

  it("reconnects a pending phone focus to its durable chat route", () => {
    mockPhoneViewport();
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
    render(<App />);
    const initial = latestCommand("initialize");

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: initial.sessionId,
          projectId: PROJECT_ID,
          cwd: "E:\\work",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
        },
      });
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId: initial.sessionId,
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
    expect(latestCommand("focus_conversation")).toMatchObject({
      conversationId: CONVERSATION_B,
    });
    expect(currentPhoneRoute()).toEqual({
      screen: "chat",
      cwd: "E:\\work",
      conversationId: CONVERSATION_B,
    });

    act(() => {
      socketMock.status?.(false);
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });

    expect(latestCommand("initialize")).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "open", conversationId: CONVERSATION_B },
    });
  });

  it("reconnects from the active workspace cache and waits for a fresh snapshot", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
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
        items: snapshotItems([{
          id: "first-cache",
          runId: RUN_ID,
          role: "user",
          text: "first cache",
          thinking: "",
          tools: [],
        }]),
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
        items: snapshotItems([{
          id: "second-cache",
          runId: RUN_B,
          role: "user",
          text: "second cache",
          thinking: "",
          tools: [],
        }]),
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
        items: [],
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
      .toBeEnabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId: reconnect.sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
      items: snapshotItems([{
        id: "fresh-second",
        runId: RUN_ID,
        role: "user",
        text: "fresh second",
        thinking: "",
        tools: [],
      }]),
      window,
    }));
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("fresh second", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
  });

  it("automatically falls back to recent when a cached conversation disappears in another workspace", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\work",
      "E:\\other",
    ]));
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
        items: [],
        window: {
          omittedBefore: false,
          startsMidTurn: false,
          contentTruncated: false,
        },
      });
    });

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 other" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 work" }));
    const staleRestore = latestCommand("initialize");
    expect(staleRestore).toMatchObject({
      cwd: "E:\\work",
      conversation: {
        kind: "open",
        conversationId: CONVERSATION_ID,
      },
    });

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: staleRestore.commandId,
      sessionId: staleRestore.sessionId,
      message: `Conversation not found: ${CONVERSATION_ID}`,
    }));

    expect(screen.queryByRole("heading", { name: "工作区不可用" }))
      .not.toBeInTheDocument();
    const fallback = latestCommand("initialize");
    expect(fallback).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "recent" },
    });
    expect(fallback.sessionId).not.toBe(staleRestore.sessionId);
    expect(screen.queryByText(/Conversation not found/)).not.toBeInTheDocument();

    const initializeCount = socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    ).length;
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: fallback.commandId,
      sessionId: fallback.sessionId,
      message: "workspace unavailable",
    }));
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "initialize",
    )).toHaveLength(initializeCount);
    expect(screen.queryByRole("heading", { name: "工作区不可用" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("workspace unavailable");
  });

  it("keeps a reconnect fallback send failure non-destructive and preserves its timing origin", async () => {
    const measure = vi.spyOn(performance, "measure");
    localStorage.setItem("piweb.workspaces", JSON.stringify(["E:\\work"]));
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
        items: [],
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
    const staleRestore = latestCommand("initialize");
    expect(staleRestore.conversation).toEqual({
      kind: "open",
      conversationId: CONVERSATION_ID,
    });

    socketMock.send.mockReturnValueOnce(false);
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "initialize",
      commandId: staleRestore.commandId,
      sessionId: staleRestore.sessionId,
      message: `Conversation not found: ${CONVERSATION_ID}`,
    }));

    const fallback = latestCommand("initialize");
    expect(fallback).toMatchObject({
      cwd: "E:\\work",
      conversation: { kind: "recent" },
    });
    expect(fallback.sessionId).not.toBe(staleRestore.sessionId);
    expect(screen.queryByRole("heading", { name: "工作区不可用" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("本地服务未连接");
    await waitFor(() => expect(measure.mock.calls.some(([, options]) => {
      const detail = (options as PerformanceMeasureOptions).detail;
      return detail?.origin === "reconnect"
        && detail.termination?.reason === "send-failed";
    })).toBe(true));
  });

  it("shows an explicit opening target for a phone workspace cache miss", () => {
    mockPhoneViewport();
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    render(<App />);
    const sessionId = latestSessionId();
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
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: snapshotItems([{
          id: "phone-source",
          role: "assistant",
          text: "phone source projection",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });
    socketMock.autoFocus = false;

    act(() => popPhoneRoute({ screen: "workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));

    const opening = screen.getByRole("status", { name: "正在打开工作区 second" });
    expect(opening).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(opening);
    expect(screen.queryByText("phone source projection")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" })).not.toBeInTheDocument();
  });

  it("preserves the current workspace projection when a rail switch cannot send", async () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\default",
      "E:\\other",
    ]));
    const measure = vi.spyOn(performance, "measure");
    socketMock.autoFocus = false;
    render(<App />);
    const sessionId = latestSessionId();
    const initialize = latestCommand("initialize");
    act(() => {
      socketMock.emit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: initialize.commandId!,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
      });
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\default",
          busy: false,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: { provider: "provider", id: "model" },
          providers: [],
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
        },
      });
    });
    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      items: snapshotItems([{
        id: "preserved-source",
        role: "user",
        text: "preserved workspace transcript",
        thinking: "",
        tools: [],
      }]),
      window: completeConversationWindow,
    }));

    socketMock.send.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 other" }));

    expect(latestCommand("initialize")).toMatchObject({ cwd: "E:\\other" });
    expect(screen.getByRole("button", { name: "打开工作区 default" }))
      .toHaveAttribute("aria-current", "true");
    expect(screen.getByText("preserved workspace transcript", { selector: "article" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeEnabled();
    expect(screen.queryByRole("status", { name: "正在同步工作区…" }))
      .not.toBeInTheDocument();

    await waitFor(() => expect(measure).toHaveBeenCalledWith(
      "piweb.transition",
      expect.objectContaining({
        detail: expect.objectContaining({
          termination: { kind: "failure", reason: "send-failed" },
        }),
      }),
    ));
  });

  it("recovers from a cached workspace initialize failure", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
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
        items: [],
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

    expect(screen.queryByRole("heading", { name: "工作区不可用" }))
      .not.toBeInTheDocument();
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
        items: snapshotItems([{
          id: "mismatch-cache",
          runId: RUN_ID,
          role: "user",
          text: "旧项目画面",
          thinking: "",
          tools: [],
        }]),
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

    const conversationCache = new Map<string, number>();
    for (let index = 0; index < MAX_CACHED_CONVERSATION_PRESENTATIONS; index += 1) {
      rememberConversationPresentation(conversationCache, `scope-${index}`, index);
    }
    expect(getConversationPresentation(conversationCache, "scope-0")).toBe(0);
    rememberConversationPresentation(conversationCache, "scope-new", 8);
    expect(conversationCache.size).toBe(MAX_CACHED_CONVERSATION_PRESENTATIONS);
    expect(conversationCache.has("scope-0")).toBe(true);
    expect(conversationCache.has("scope-1")).toBe(false);
  });

  it("keeps global project activity visible across workspace switches", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
      "E:\\omitted",
    ]));
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

  it("keeps a workspace with a generic initialize failure visible and allows switching away", () => {
    socketMock.autoFocus = false;
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\missing",
      "E:\\other",
    ]));
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

    expect(screen.queryByRole("heading", { name: "工作区不可用" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Directory does not exist");
    expect(screen.getByRole("button", { name: "打开工作区 missing" }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: "打开工作区 other",
    }));
    expect(latestCommand("initialize").cwd).toBe("E:\\other");
    expect(JSON.parse(localStorage.getItem("piweb.workspaces") ?? "[]"))
      .toEqual(["E:\\missing", "E:\\other"]);
  });

  it("keeps a newer directory request authoritative over stale listing outcomes", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
    const input = screen.getByRole("textbox", { name: "项目目录" });
    fireEvent.change(input, { target: { value: "E:\\typed" } });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    const commandA = latestCommand("browse_directory");
    expect(commandA.path).toBe("E:\\typed");
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    const commandB = latestCommand("browse_directory");
    expect(commandB.path).toBe("E:\\typed");
    expect(commandB.commandId).not.toBe(commandA.commandId);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取目录…");

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: commandA.commandId,
      path: "E:\\stale",
      parentPath: "E:\\",
      directories: [{ name: "stale child", path: "E:\\stale\\child" }],
      truncated: false,
    }));
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
    expect(screen.queryByText("E:\\stale")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开文件夹 stale child" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取目录…");

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "browse_directory",
      commandId: commandA.commandId,
      message: "stale listing error",
    }));
    expect(screen.getByRole("dialog", { name: "选择项目目录" })).toBeInTheDocument();
    expect(screen.queryByText("stale listing error")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取目录…");

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: commandB.commandId,
      path: "E:\\typed",
      parentPath: "E:\\",
      directories: [{
        name: "child",
        path: "E:\\typed\\child",
      }],
      truncated: false,
    }));
    expect(screen.queryByText("正在读取目录…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开文件夹 child" }));
    const childCommand = latestCommand("browse_directory");
    expect(childCommand.commandId).not.toBe(commandB.commandId);
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

  it("dismisses nested directory browsing without changing Setup authority", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "开启工作区" }));
    const input = screen.getByRole("textbox", { name: "项目目录" });
    const draft = "  E:\\typed folder  ";
    fireEvent.change(input, { target: { value: draft } });

    const picker = screen.getByRole("button", { name: "选择文件夹" });
    picker.focus();
    fireEvent.click(picker);
    const command = latestCommand("browse_directory");
    expect(command.path).toBe("E:\\typed folder");
    const browseCount = socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "browse_directory",
    ).length;
    const initializeCount = socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "initialize",
    ).length;
    expect(browseCount).toBe(1);
    expect(initializeCount).toBe(0);

    const directoryDialog = screen.getByRole("dialog", { name: "选择项目目录" });
    const backdropMouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(directoryDialog.parentElement!, backdropMouseDown);
    expect(backdropMouseDown.defaultPrevented).toBe(true);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "选择项目目录" }))
        .not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "开启工作区" }))
        .toBeInTheDocument();
      expect(input).toHaveValue(draft);
      expect(picker.isConnected).toBe(true);
      expect(picker).toHaveFocus();
    });
    expect(socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "browse_directory",
    )).toHaveLength(browseCount);
    expect(socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "initialize",
    )).toHaveLength(initializeCount);

    act(() => socketMock.emit?.({
      type: "directory_listing",
      commandId: command.commandId,
      path: "E:\\late-closed",
      parentPath: "E:\\",
      directories: [{ name: "late child", path: "E:\\late-closed\\child" }],
      truncated: false,
    }));
    expect(screen.queryByRole("dialog", { name: "选择项目目录" }))
      .not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "browse_directory",
      commandId: command.commandId,
      message: "late closed listing error",
    }));
    expect(screen.queryByRole("dialog", { name: "选择项目目录" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("late closed listing error"))
      .not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "开启工作区" }))
      .toBeInTheDocument();
    expect(input).toHaveValue(draft);
    expect(picker).toHaveFocus();
    expect(socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "browse_directory",
    )).toHaveLength(browseCount);
    expect(socketMock.send.mock.calls.filter(
      ([sent]) => sent.type === "initialize",
    )).toHaveLength(initializeCount);
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

  it("sets the service tier for the exact focus without optimistically changing server state", () => {
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
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    const selector = screen.getByRole("combobox", { name: "服务层级" });

    fireEvent.change(selector, { target: { value: "priority" } });
    const command = latestCommand("set_service_tier");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      serviceTier: "priority",
    });
    expect(selector).toHaveValue("");
    expect(selector).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "set_service_tier",
      commandId: "3d227a2c-2f51-4811-8844-e8e566b09f05",
      sessionId,
    }));
    expect(selector).toBeDisabled();

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
          selectedServiceTier: "priority",
          providers: [SERVICE_TIER_PROVIDER],
        },
      });
      socketMock.emit?.({
        type: "command_complete",
        operation: "set_service_tier",
        commandId: command.commandId,
        sessionId,
      });
    });
    expect(selector).toHaveValue("priority");
    expect(selector).toBeEnabled();
  });

  it("clears service-tier pending state on focus changes and rejects stale ABA completion", () => {
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
          selectedServiceTier: null,
          providers: [SERVICE_TIER_PROVIDER],
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

    fireEvent.change(screen.getByRole("combobox", { name: "服务层级" }), {
      target: { value: "priority" },
    });
    const firstACommand = latestCommand("set_service_tier");

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
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    expect(screen.getByRole("combobox", { name: "服务层级" })).toBeEnabled();

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
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    const selector = screen.getByRole("combobox", { name: "服务层级" });
    fireEvent.change(selector, { target: { value: "priority" } });
    const secondACommand = latestCommand("set_service_tier");
    expect(secondACommand.focusId).toBe(FOCUS_A_SECOND);
    expect(selector).toBeDisabled();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "set_service_tier",
      commandId: firstACommand.commandId,
      sessionId,
    }));
    expect(selector).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "set_service_tier",
      commandId: secondACommand.commandId,
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
      message: "tier rejected",
    }));
    expect(selector).toBeEnabled();
    expect(screen.getByRole("alert"))
      .toHaveTextContent("修改服务层级失败：tier rejected");
  });

  it("keeps the authoritative tier and reports a failed service-tier send", () => {
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
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    socketMock.send.mockReturnValueOnce(false);
    const selector = screen.getByRole("combobox", { name: "服务层级" });

    fireEvent.change(selector, { target: { value: "priority" } });

    expect(selector).toHaveValue("");
    expect(selector).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("本地服务未连接");
  });

  it("clears an unconfirmed service-tier command when the connection drops", () => {
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
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    fireEvent.change(screen.getByRole("combobox", { name: "服务层级" }), {
      target: { value: "priority" },
    });

    act(() => socketMock.status?.(false));
    expect(screen.getByRole("alert"))
      .toHaveTextContent("服务层级修改状态未确认");

    act(() => {
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    const reconnectedSessionId = latestSessionId();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: reconnectedSessionId,
        cwd: "E:\\work",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        selectedServiceTier: null,
        providers: [SERVICE_TIER_PROVIDER],
      },
    }));
    expect(screen.getByRole("combobox", { name: "服务层级" })).toBeEnabled();
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

  it("projects only the exact focused compaction attempt without changing the primary model", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const firstAttempt = {
      id: "549d0646-12f1-44fa-a620-85b860808ae4",
      generator: "default" as const,
      policy: "explicit" as const,
      requestTarget: { provider: "summary-provider", id: "summary-model" },
    };
    const primaryModel = { provider: "primary-provider", id: "primary-model" };

    act(() => {
      socketMock.emit?.({
        type: "state",
        state: {
          sessionId,
          cwd: "E:\\work",
          busy: true,
          compacting: true,
          compactionAttempt: firstAttempt,
          thinkingLevel: "off",
          toolMode: "read_only",
          availableThinkingLevels: ["off"],
          selectedModel: primaryModel,
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

    expect(screen.getByRole("status", { name: "正在压缩上下文" }))
      .toHaveTextContent(
        "Pi 默认摘要请求管线目标：summary-provider / summary-model · 专用配置",
      );
    expect(screen.getByTitle("设置")).toHaveTextContent("primary-model");

    socketMock.autoFocus = false;
    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.queryByText(/summary-provider \/ summary-model/))
      .not.toBeInTheDocument();

    const focus = latestCommand("focus_conversation");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focus.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        items: [],
        window: completeConversationWindow,
      });
    });
    expect(screen.queryByText(/summary-provider \/ summary-model/))
      .not.toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        cwd: "E:\\work",
        busy: false,
        compacting: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: primaryModel,
        providers: [],
      },
    }));
    expect(screen.getByTitle("设置")).toHaveTextContent("primary-model");

    const secondAttempt = {
      ...firstAttempt,
      id: "4765925b-b4d3-4233-915d-17dd27fd2898",
      requestTarget: { provider: "second-provider", id: "second-summary" },
    };
    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        cwd: "E:\\work",
        busy: true,
        compacting: true,
        compactionAttempt: secondAttempt,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: primaryModel,
        providers: [],
      },
    }));
    expect(screen.getByRole("status", { name: "正在压缩上下文" }))
      .toHaveTextContent("second-provider / second-summary");
    expect(screen.getByTitle("设置")).toHaveTextContent("primary-model");

    act(() => socketMock.rawEmit?.({
      type: "state",
      state: {
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        cwd: "E:\\work",
        busy: false,
        compacting: false,
        thinkingLevel: "off",
        toolMode: "read_only",
        availableThinkingLevels: ["off"],
        selectedModel: primaryModel,
        providers: [],
      },
    }));
    expect(screen.queryByRole("status", { name: "正在压缩上下文" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/second-provider \/ second-summary/))
      .not.toBeInTheDocument();
  });

  it("switches an idle focused conversation role with exact command correlation", async () => {
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
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "read_only",
          canManageSessions: true,
        },
        items: [],
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });

    fireEvent.click(screen.getByRole("button", {
      name: "查看会话角色 Default",
    }));
    const roleDialog = screen.getByRole("dialog", { name: "更换会话角色" });
    const roleClose = screen.getByRole("button", { name: "关闭" });
    roleClose.focus();
    fireEvent.change(screen.getByRole("combobox", {
      name: "选择新的会话角色",
    }), {
      target: { value: nextRole.id },
    });

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Extension question", message: "Continue?" },
    }));
    expect(screen.queryByRole("dialog", { name: "更换会话角色" }))
      .not.toBeInTheDocument();
    expect(roleDialog).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Extension question" }))
      .toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "更换会话角色" }))
        .toBe(roleDialog);
      expect(roleClose).toHaveFocus();
    });
    expect(screen.getByRole("combobox", {
      name: "选择新的会话角色",
    })).toHaveValue(nextRole.id);
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
      .toBeEnabled();

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
          compactionModel: nextRole.compactionModel,
          defaultThinkingLevel: nextRole.defaultThinkingLevel,
          defaultServiceTier: nextRole.defaultServiceTier,
          toolMode: nextRole.toolMode,
          canManageSessions: nextRole.canManageSessions,
        },
        items: [],
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

  it("retires a role-switch pending intent when its focus is invalidated", () => {
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
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "read_only",
          canManageSessions: true,
        },
        items: [],
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

    act(() => socketMock.emit?.({
      type: "focus_invalidated",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      reason: "deleted",
    }));
    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "switch_conversation_role",
      commandId: command.commandId,
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      message: "The deleted conversation cannot change roles",
    }));

    expect(screen.queryByText(/更换会话角色失败/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用 Default 开始会话" }));
    expect(latestCommand("create_conversation")).toMatchObject({ sessionId });
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
        items: snapshotItems([{
          id: userMessageId,
          role: "user",
          text: "需要保留吗？",
          thinking: "",
          tools: [],
        }, {
          id: `assistant:${assistantEntryId}`,
          role: "assistant",
          text: "**Agent 原文**",
          thinking: "",
          tools: [],
        }]),
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

  it("correlates extension UI by session and request and clears it on disconnect", () => {
    render(<App />);
    const sessionId = startFromSetup();
    const otherSessionId = "e15c861c-e18f-4290-bc22-8932f3caaf4e";

    act(() => {
      socketMock.emit?.({
        type: "extension_ui_request",
        sessionId: otherSessionId,
        requestId: EXTENSION_REQUEST_A,
        request: { kind: "confirm", title: "Wrong session", message: "Ignore me" },
      });
      socketMock.emit?.({
        type: "extension_ui_notification",
        sessionId,
        level: "info",
        message: "Current notification",
      });
      socketMock.emit?.({
        type: "extension_ui_notification",
        sessionId: otherSessionId,
        level: "error",
        message: "Wrong notification",
      });
    });
    expect(screen.queryByText("Wrong session")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong notification")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Current notification");

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "input", title: "Current request", placeholder: "Type here" },
    }));
    const currentInput = screen.getByRole("textbox", { name: "Current request" });
    fireEvent.change(currentInput, { target: { value: "local draft" } });

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Duplicate request", message: "Replace?" },
    }));
    expect(screen.getAllByRole("dialog", { name: "Current request" }))
      .toHaveLength(1);
    expect(screen.queryByText("Duplicate request")).not.toBeInTheDocument();
    expect(currentInput).toHaveValue("local draft");
    expect(screen.getByRole("status")).toHaveTextContent("Current notification");

    act(() => {
      socketMock.emit?.({
        type: "extension_ui_closed",
        sessionId: otherSessionId,
        requestId: EXTENSION_REQUEST_A,
      });
      socketMock.emit?.({
        type: "extension_ui_closed",
        sessionId,
        requestId: RUN_B,
      });
    });
    expect(screen.getByRole("dialog", { name: "Current request" })).toBeInTheDocument();
    expect(currentInput).toHaveValue("local draft");
    expect(screen.getByRole("status")).toHaveTextContent("Current notification");

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    expect(screen.queryByRole("dialog", { name: "Current request" }))
      .not.toBeInTheDocument();
    expect(screen.queryByText("Duplicate request")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Current notification");

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: RUN_B,
      request: { kind: "confirm", title: "Disconnect cleanup", message: "Wait" },
    }));
    expect(screen.getByRole("dialog", { name: "Disconnect cleanup" }))
      .toBeInTheDocument();
    act(() => socketMock.status?.(false));
    expect(screen.queryByRole("dialog", { name: "Disconnect cleanup" }))
      .not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));

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

  it("settles concurrent exact model refresh and API Key acknowledgements independently", () => {
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
          configured: true,
          oauth: false,
          models: [],
        }],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));

    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    const refreshCommand = latestCommand("refresh_models");
    fireEvent.click(screen.getByRole("button", { name: "更新 API Key" }));
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "replacement-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存 API Key" }));
    const keyCommand = latestCommand("set_api_key");

    act(() => {
      socketMock.rawEmit?.({
        type: "command_complete",
        operation: "refresh_models",
        commandId: refreshCommand.commandId,
        sessionId,
      });
      socketMock.rawEmit?.({
        type: "command_complete",
        operation: "set_api_key",
        commandId: keyCommand.commandId,
        sessionId,
      });
    });

    expect(screen.queryByRole("dialog", { name: "Provider API Key" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();
    expect(screen.getAllByRole("status").map((status) => status.textContent))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("API Key 已保存"),
        expect.stringContaining("远程供应商模型目录已刷新"),
      ]));
  });

  it("ignores an unmatched stale setting completion without displacing the exact owner result", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }));
    const refreshCommand = latestCommand("refresh_models");

    act(() => {
      socketMock.rawEmit?.({
        type: "command_complete",
        operation: "refresh_models",
        commandId: refreshCommand.commandId,
        sessionId,
      });
      socketMock.rawEmit?.({
        type: "command_complete",
        operation: "refresh_models",
        commandId: "8ee64aa3-c8a8-4e21-b521-66029ce3673b",
        sessionId,
      });
    });

    expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled();
    expect(screen.getByRole("status"))
      .toHaveTextContent("远程供应商模型目录已刷新");
  });

  it("keeps the model drawer live but covered while extension UI owns focus", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const drawerClose = screen.getByRole("button", { name: "关闭" });
    drawerClose.focus();
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_request",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
      request: { kind: "confirm", title: "Extension question", message: "Continue?" },
    }));
    expect(screen.queryByRole("dialog", { name: "设置" })).not.toBeInTheDocument();
    expect(drawerClose).toBeInTheDocument();
    expect(drawerClose.closest(".drawer")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("dialog", { name: "Extension question" })).toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "extension_ui_closed",
      sessionId,
      requestId: EXTENSION_REQUEST_A,
    }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
      expect(drawerClose).toHaveFocus();
    });
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
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
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
    render(<App />);
    const sessionId = startFromSetup();
    socketMock.send.mockReturnValue(false);

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
    expect(input).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("正在确认服务端已接收");
    expect(screen.queryByText("keep this prompt", { selector: "article" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "next local draft" } });

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: RUN_ID,
      event: { type: "run_queued" },
    }));
    expect(input).toHaveValue("next local draft");

    act(() => socketMock.emit?.({
      type: "session_event",
      sessionId,
      runId: prompt.runId,
      event: { type: "run_queued" },
    }));
    expect(input).toHaveValue("next local draft");
    expect(screen.getByText("keep this prompt", { selector: "article" })).toBeInTheDocument();
  });

  function beginUnsentDraftReconnect(draft: string) {
    render(<App />);
    const originalSessionId = startFromSetup();
    act(() => socketMock.emit?.({
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
    }));
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: draft },
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
    expect(reconnect.sessionId).not.toBe(originalSessionId);
    return reconnect;
  }

  function replaceUnsentDraftReconnect(
    previous: Extract<ClientCommand, { type: "initialize" }>,
  ) {
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
    expect(reconnect.sessionId).not.toBe(previous.sessionId);
    expect(reconnect.commandId).not.toBe(previous.commandId);
    expect(reconnect.conversation).toEqual({
      kind: "open",
      conversationId: CONVERSATION_ID,
    });
    return reconnect;
  }

  it("retains an unsent draft after an exact reconnect attachment and snapshot", () => {
    const reconnect = beginUnsentDraftReconnect("unsent reconnect draft");
    const reconnectFocusId = "ae301850-745d-44dd-a30f-000000000099";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: reconnect.sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: reconnectFocusId,
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
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("unsent reconnect draft");
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(0);
  });

  it("carries an unsent draft owner across a second disconnect before attachment", () => {
    const firstReconnect = beginUnsentDraftReconnect("draft across two reconnects");
    const reconnect = replaceUnsentDraftReconnect(firstReconnect);
    const reconnectFocusId = "ae301850-745d-44dd-a30f-000000000103";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: reconnect.sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: reconnectFocusId,
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
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("draft across two reconnects");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(0);
  });

  it.each([
    ["project", "project-other", CONVERSATION_ID],
    ["conversation", PROJECT_ID, CONVERSATION_B],
  ])("clears a carried draft when the second reconnect attachment has a different %s", (
    _identity,
    attachedProjectId,
    attachedConversationId,
  ) => {
    const firstReconnect = beginUnsentDraftReconnect("carried draft must not leak");
    const reconnect = replaceUnsentDraftReconnect(firstReconnect);
    const mismatchedFocusId = "ae301850-745d-44dd-a30f-000000000104";
    const settledFocusId = _identity === "conversation"
      ? "ae301850-745d-44dd-a30f-000000000105"
      : mismatchedFocusId;
    const settledProjectId = _identity === "project"
      ? attachedProjectId
      : PROJECT_ID;
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: reconnect.sessionId,
        projectId: attachedProjectId,
        conversationId: attachedConversationId,
        focusId: mismatchedFocusId,
      });
      if (_identity === "conversation") {
        socketMock.rawEmit?.({
          type: "focus_attached",
          operation: "initialize",
          commandId: reconnect.commandId!,
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: settledFocusId,
        });
      }
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: settledProjectId,
          conversationId: CONVERSATION_ID,
          focusId: settledFocusId,
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
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: settledFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(0);
  });

  it.each([
    ["project", "project-other", CONVERSATION_ID],
    ["conversation", PROJECT_ID, CONVERSATION_B],
  ])("clears an unsent draft when the reconnect attachment has a different %s", (
    _identity,
    attachedProjectId,
    attachedConversationId,
  ) => {
    const reconnect = beginUnsentDraftReconnect("must not cross focus authority");
    const mismatchedFocusId = "ae301850-745d-44dd-a30f-000000000100";
    const settledFocusId = _identity === "conversation"
      ? "ae301850-745d-44dd-a30f-000000000101"
      : mismatchedFocusId;
    const settledProjectId = _identity === "project"
      ? attachedProjectId
      : PROJECT_ID;
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: reconnect.sessionId,
        projectId: attachedProjectId,
        conversationId: attachedConversationId,
        focusId: mismatchedFocusId,
      });
      if (_identity === "conversation") {
        socketMock.rawEmit?.({
          type: "focus_attached",
          operation: "initialize",
          commandId: reconnect.commandId!,
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: settledFocusId,
        });
      }
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: settledProjectId,
          conversationId: CONVERSATION_ID,
          focusId: settledFocusId,
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
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: settledFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(0);
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

    socketMock.autoFocus = false;
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
    const reconnect = latestCommand("initialize");
    const reconnectFocusId = "ae301850-745d-44dd-a30f-000000000102";
    expect(reconnect.sessionId).not.toBe(sessionId);
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: reconnect.commandId!,
        sessionId: reconnect.sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: reconnect.sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: reconnectFocusId,
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
        sessionId: reconnect.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: reconnectFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("uncertain prompt");
    expect(screen.getByRole("alert")).toHaveTextContent("发送状态未确认");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);
  });

  it("isolates and restores an ordinary text-and-image draft across workspace A-B-A", async () => {
    const firstProjectId = "f25ee8d8-34f0-4c30-a045-000000000201";
    const secondProjectId = "f25ee8d8-34f0-4c30-a045-000000000202";
    const secondFocusId = "ae301850-745d-44dd-a30f-000000000203";
    const returnedFocusId = "ae301850-745d-44dd-a30f-000000000204";
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
    socketMock.autoFocus = false;
    render(<App />);
    const firstInitialize = latestCommand("initialize");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: firstInitialize.commandId!,
        sessionId: firstInitialize.sessionId,
        projectId: firstProjectId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: firstInitialize.sessionId,
          projectId: firstProjectId,
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
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
        type: "project_snapshot",
        sessionId: firstInitialize.sessionId,
        projectId: firstProjectId,
        conversations: [conversationSummary(CONVERSATION_ID, "Shared ID in first")],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: firstInitialize.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: [],
        window: completeConversationWindow,
      });
    });

    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "ordinary draft in first" },
    });
    await pasteDraftImage("first.png");

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    // A cache miss owns no target composer before attach; the source draft must
    // not remain visible in the opening placeholder.
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();
    const secondInitialize = latestCommand("initialize");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: secondInitialize.commandId!,
        sessionId: secondInitialize.sessionId,
        projectId: secondProjectId,
        conversationId: CONVERSATION_ID,
        focusId: secondFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: secondInitialize.sessionId,
          projectId: secondProjectId,
          conversationId: CONVERSATION_ID,
          focusId: secondFocusId,
          cwd: "E:\\second",
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
        sessionId: secondInitialize.sessionId,
        projectId: secondProjectId,
        conversations: [conversationSummary(CONVERSATION_ID, "Shared ID in second")],
        truncated: false,
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId: secondInitialize.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: secondFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "ordinary draft in second" },
    });

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("ordinary draft in first");
    expect(screen.getByRole("img", { name: "待发送图片 1" })).toBeVisible();
    const returnedInitialize = latestCommand("initialize");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "initialize",
        commandId: returnedInitialize.commandId!,
        sessionId: returnedInitialize.sessionId,
        projectId: firstProjectId,
        conversationId: CONVERSATION_ID,
        focusId: returnedFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId: returnedInitialize.sessionId,
          projectId: firstProjectId,
          conversationId: CONVERSATION_ID,
          focusId: returnedFocusId,
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
        sessionId: returnedInitialize.sessionId,
        conversationId: CONVERSATION_ID,
        focusId: returnedFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("ordinary draft in first");
    expect(screen.getByRole("img", { name: "待发送图片 1" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores an unacknowledged prompt after switching projects without leaking it", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
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

    const restored = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    expect(restored).toHaveValue("pending across projects");
    expect(screen.getByRole("alert")).toHaveTextContent("发送状态未确认");
    expect(socketMock.send.mock.calls.filter(
      ([command]) => command.type === "prompt",
    )).toHaveLength(1);

    fireEvent.change(restored, { target: { value: "edited after unknown outcome" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开工作区 second" }));
    const editedSecondSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: editedSecondSessionId,
        cwd: "E:\\second",
        busy: false,
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作区 first" }));
    const editedFirstSessionId = latestCommand("initialize").sessionId;
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId: editedFirstSessionId,
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
      .toHaveValue("edited after unknown outcome");
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
      items: [],
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
        items: snapshotItems([{
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
        }]),
        window: { omittedBefore: true, startsMidTurn: true, contentTruncated: true },
      });
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_B,
        items: snapshotItems([{
          id: "stale",
          role: "assistant",
          text: "wrong conversation",
          thinking: "",
          tools: [],
        }]),
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
    });

    expect(screen.getByText("persisted question", { selector: "article" })).toBeInTheDocument();
    expect(screen.getByText("persisted answer").closest("article")).toBeInTheDocument();
    expect(screen.queryByText("wrong conversation")).not.toBeInTheDocument();
    const marker = screen.getByRole("note", { name: "历史记录不完整" });
    expect(marker).toHaveTextContent("较早的历史记录未显示");
    expect(marker).toHaveTextContent("当前窗口从一轮对话中间开始");
    expect(marker).toHaveTextContent("过大的消息内容已截断");
  });

  it("waits for the matching conversation snapshot before enabling prompt submission", () => {
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
    const send = screen.getByRole("button", { name: "发送" });
    expect(input).toBeEnabled();
    expect(send).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "正在恢复项目对话…");

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_B,
      focusId: FOCUS_A,
      items: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    expect(input).toBeEnabled();
    expect(send).toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      items: [],
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

  it("optimistically hides a non-current deletion and restores the latest snapshot on error", () => {
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
    const conversations: ConversationSummary[] = [{
      id: CONVERSATION_ID,
      name: "Current",
      preview: "current",
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:01:00.000Z",
      messageCount: 2,
      compacting: false,
    }, {
      id: CONVERSATION_B,
      name: "Older work",
      preview: "older",
      createdAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:01:00.000Z",
      messageCount: 4,
      compacting: false,
    }];
    act(() => socketMock.emit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      conversations,
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
    expect(screen.queryByRole("button", {
      name: "删除会话 Older work",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在删除对话…" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建会话" })).toBeEnabled();

    act(() => socketMock.emit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      conversations: conversations.map((conversation) => (
        conversation.id === CONVERSATION_B
          ? { ...conversation, name: "Older work refreshed" }
          : conversation
      )),
      truncated: false,
    }));
    expect(screen.queryByRole("button", {
      name: "删除会话 Older work refreshed",
    })).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "delete_conversation",
      commandId: CONVERSATION_C,
      sessionId,
      message: "stale deletion error",
    }));
    expect(screen.queryByText("删除对话失败：stale deletion error"))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "删除会话 Older work refreshed",
    })).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "error",
      scope: "command",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
      message: "delete blocked",
    }));
    expect(screen.queryByRole("status", { name: "正在删除对话…" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: "删除会话 Older work refreshed",
    })).toBeEnabled();
    expect(screen.getByText("删除对话失败：delete blocked"))
      .toBeInTheDocument();
  });

  it("keeps unrelated conversations operable while a deletion is in flight", () => {
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
        compacting: false,
      }, {
        id: CONVERSATION_B,
        name: "Older work",
        preview: "older",
        createdAt: "2026-07-17T12:00:00.000Z",
        updatedAt: "2026-07-17T12:01:00.000Z",
        messageCount: 4,
        compacting: false,
      }],
      truncated: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "删除会话 Current" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(latestCommand("delete_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
    });
    expect(screen.getByRole("status", { name: "正在删除对话…" }))
      .toBeInTheDocument();

    // The deleting conversation owns the workspace pane, but unrelated rows
    // stay fully usable.
    const unrelatedRow = screen.getByRole("button", {
      name: "打开会话 Older work",
    });
    expect(unrelatedRow).toBeEnabled();
    fireEvent.click(unrelatedRow);
    expect(latestCommand("focus_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
  });

  it("does not carry a pending deletion into another workspace", () => {
    localStorage.setItem("piweb.workspaces", JSON.stringify([
      "E:\\first",
      "E:\\second",
    ]));
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "Delete me",
          preview: "",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z",
          messageCount: 0,
          compacting: false,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Delete me" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(screen.queryByRole("button", { name: "删除会话 Delete me" }))
      .not.toBeInTheDocument();

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
          compacting: false,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
    });

    expect(screen.getByRole("button", { name: "删除会话 Second project" }))
      .toBeEnabled();
  });

  it("keeps deletion progress visible when deleting a focused group", () => {
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
          id: CONVERSATION_B,
          name: "Root task",
          preview: "root",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-18T12:02:00.000Z",
          messageCount: 2,
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_ID,
          name: "Current agent",
          preview: "current",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 2,
          compacting: false,
          activity: { kind: "idle" },
          rootConversationId: CONVERSATION_B,
        }],
        truncated: false,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除会话 Root task" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    const command = latestCommand("delete_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_B,
    });
    expect(screen.queryByRole("button", { name: "删除会话 Root task" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开会话 Current agent" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在删除对话…" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "选择这个会话的角色" }))
      .not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "focus_invalidated",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      reason: "deleted",
    }));
    expect(screen.getByRole("status", { name: "正在删除对话…" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "选择这个会话的角色" }))
      .not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
    }));

    expect(screen.getByRole("heading", { name: "选择这个会话的角色" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 Default 开始会话" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除会话 Root task" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开会话 Current agent" }))
      .not.toBeInTheDocument();
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

  it("latches deletion progress when invalidation reveals a deeper cascade", () => {
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
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [{
          id: CONVERSATION_B,
          name: "Root task",
          preview: "root",
          createdAt: "2026-07-17T12:00:00.000Z",
          updatedAt: "2026-07-18T12:03:00.000Z",
          messageCount: 3,
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_C,
          name: "Parent agent",
          preview: "parent",
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:02:00.000Z",
          messageCount: 2,
          compacting: false,
          activity: { kind: "idle" },
          rootConversationId: CONVERSATION_B,
        }, {
          id: CONVERSATION_ID,
          name: "Focused descendant",
          preview: "current",
          createdAt: "2026-07-18T12:01:00.000Z",
          updatedAt: "2026-07-18T12:01:00.000Z",
          messageCount: 2,
          compacting: false,
          activity: { kind: "idle" },
          rootConversationId: CONVERSATION_B,
        }],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", {
      name: "删除会话 Parent agent",
    }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    const command = latestCommand("delete_conversation");
    expect(command).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_C,
    });
    expect(screen.queryByRole("button", { name: "删除会话 Parent agent" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 Focused descendant" }))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "focus_invalidated",
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      reason: "deleted",
    }));

    expect(screen.getByRole("status", { name: "正在删除对话…" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "打开会话 Focused descendant",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "选择这个会话的角色" }))
      .not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: command.commandId,
      sessionId,
    }));

    expect(screen.getByRole("heading", { name: "选择这个会话的角色" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除会话 Root task" }))
      .toBeEnabled();
    expect(screen.queryByRole("button", { name: "删除会话 Parent agent" }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: "打开会话 Focused descendant",
    })).not.toBeInTheDocument();
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
          activity: { kind: "idle" },
        }],
        truncated: false,
      });
      socketMock.emit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        items: snapshotItems([{
          id: "assistant-a",
          role: "assistant",
          text: "A still working",
          thinking: "",
          tools: [],
        }]),
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
      items: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
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
    expect(screen.getByRole("heading", { name: "正在同步会话" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "给 Pi 发送消息" }))
      .not.toBeInTheDocument();
  });

  it("requires a new exact state when reopening the same conversation with a new focus", () => {
    const sessionId = startFocusReplacementProject();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    const focusB = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: focusB.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_B,
      focusId: "ae301850-745d-44dd-a30f-000000000401",
    }));

    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    const reopenedA = latestCommand("focus_conversation");
    act(() => socketMock.rawEmit?.({
      type: "focus_attached",
      operation: "focus_conversation",
      commandId: reopenedA.commandId!,
      sessionId,
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A_SECOND,
    }));

    expect(screen.getByText("focus replacement source A"))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();

    act(() => {
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A_SECOND,
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
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        items: snapshotItems([{
          id: "reopened-a-snapshot",
          role: "assistant",
          text: "new A focus runtime",
          thinking: "",
          tools: [],
        }]),
        window: completeConversationWindow,
      });
    });

    expect(screen.getByText("new A focus runtime")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toBeEnabled();
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
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
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
    fireEvent.click(screen.getByRole("button", { name: "登录订阅账户" }));
    const first = latestCommand("login_oauth");
    fireEvent.keyDown(document, { key: "Escape" });
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
    fireEvent.click(screen.getByRole("button", { name: "打开模型连接设置" }));
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
    expect(screen.getByRole("button", { name: "设置" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("dialog", { name: "设置" })).toBeInTheDocument();
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
      .toBeEnabled();
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
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
          compacting: false,
          activity: { kind: "idle" },
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
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
    expect(screen.getByRole("navigation", { name: "协作路径" }))
      .toHaveTextContent("Updated A");
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
        compacting: false,
        activity: { kind: "idle" },
      }, {
        id: CONVERSATION_B,
        name: "B",
        preview: "",
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T09:00:00.000Z",
        messageCount: 0,
        compacting: false,
        attention: true,
        activity: { kind: "running", runId: RUN_ID },
      }],
      truncated: false,
    }));

    expect(input).toHaveValue("draft for A");
    expect(screen.getByRole("status", { name: "运行中" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "需要处理" })).toBeInTheDocument();
  });

  it("isolates and restores text-and-image drafts across an A-B-A focus change", async () => {
    const sessionId = startFocusReplacementProject([
      conversationSummary(CONVERSATION_B, "B"),
    ]);
    const input = screen.getByRole("textbox", { name: "给 Pi 发送消息" });
    fireEvent.change(input, { target: { value: "draft for A" } });
    await pasteDraftImage("a.png");

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();
    const focusB = latestCommand("focus_conversation");
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusB.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: FOCUS_A_SECOND,
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
        conversationId: CONVERSATION_B,
        focusId: FOCUS_A_SECOND,
        items: [],
        window: completeConversationWindow,
      });
    });
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: "draft for B" },
    });

    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("draft for A");
    expect(screen.getByRole("img", { name: "待发送图片 1" })).toBeVisible();
    const focusA = latestCommand("focus_conversation");
    const returnedFocusId = "ae301850-745d-44dd-a30f-000000000104";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusA.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_ID,
        focusId: returnedFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          focusId: returnedFocusId,
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
        focusId: returnedFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("draft for A");
    expect(screen.getByRole("img", { name: "待发送图片 1" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const acceptedPrompt = latestCommand("prompt");
    act(() => socketMock.rawEmit?.({
      type: "session_event",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: returnedFocusId,
      runId: acceptedPrompt.runId,
      event: { type: "run_queued" },
    }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开会话 B" }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("draft for B");
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();
    const focusBAgain = latestCommand("focus_conversation");
    const returnedBFocusId = "ae301850-745d-44dd-a30f-000000000105";
    act(() => {
      socketMock.rawEmit?.({
        type: "focus_attached",
        operation: "focus_conversation",
        commandId: focusBAgain.commandId,
        sessionId,
        projectId: PROJECT_ID,
        conversationId: CONVERSATION_B,
        focusId: returnedBFocusId,
      });
      socketMock.rawEmit?.({
        type: "state",
        state: {
          sessionId,
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_B,
          focusId: returnedBFocusId,
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
        conversationId: CONVERSATION_B,
        focusId: returnedBFocusId,
        items: [],
        window: completeConversationWindow,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "打开会话 A" }));
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByRole("img", { name: "待发送图片 1" }))
      .not.toBeInTheDocument();
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
          compacting: false,
        }, {
          id: CONVERSATION_B,
          name: "B",
          preview: "",
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          messageCount: 0,
          compacting: false,
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
        items: snapshotItems([{
          id: "stale-a",
          role: "assistant",
          text: "late from first A focus",
          thinking: "",
          tools: [],
        }]),
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
      socketMock.rawEmit?.({
        type: "conversation_snapshot",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A_SECOND,
        items: snapshotItems([{
          id: "fresh-a",
          role: "assistant",
          text: "fresh second A focus",
          thinking: "",
          tools: [],
        }]),
        window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
      });
      socketMock.rawEmit?.({
        type: "conversation_item",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        item: snapshotItems([{
          id: "stale-live-a",
          role: "assistant",
          text: "late live item",
          thinking: "",
          tools: [],
        }])[0] !,
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
      summary: "Review the implementation.",
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
      peerPresence: "present" as const,
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
        peerPresence: "absent",
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
    const commandCountBeforeSave = socketMock.send.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(socketMock.send.mock.calls).toHaveLength(commandCountBeforeSave + 1);
    const update = latestCommand("update_role");
    expect(update).toMatchObject({
      expectedSystemPrompt: "Be useful.",
      role: { compactionModel: null },
    });

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

  it("settles a pending role update as unknown on disconnect and clears it on reconnect", () => {
    render(<App />);
    const emitRoleReady = (
      sessionId: string,
      catalogRole: RoleTemplate = defaultRole(),
    ) => act(() => {
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
          providers: [SERVICE_TIER_PROVIDER],
        },
      });
      socketMock.emit?.({
        type: "role_catalog_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        roles: [catalogRole],
      });
    });
    const sessionId = startFromSetup();
    emitRoleReady(sessionId);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByRole("button", { name: "管理角色 Default" }));
    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Disconnected dirty name" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "角色简介" }), {
      target: { value: "Disconnected dirty description" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "专属提示词" }), {
      target: { value: "Disconnected dirty prompt" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "工具权限" }), {
      target: { value: "full_access" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    const pendingUpdate = latestCommand("update_role");
    const updateCount = () => socketMock.send.mock.calls.filter(
      ([command]) => command.type === "update_role",
    ).length;
    expect(updateCount()).toBe(1);

    act(() => socketMock.status?.(false));

    expect(screen.getByRole("alert")).toHaveTextContent("角色操作结果未确认");
    expect(screen.getByRole("dialog", { name: "管理角色" }))
      .not.toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "关闭角色管理" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Disconnected dirty name");
    expect(screen.getByRole("textbox", { name: "角色简介" }))
      .toHaveValue("Disconnected dirty description");
    expect(screen.getByRole("textbox", { name: "专属提示词" }))
      .toHaveValue("Disconnected dirty prompt");
    expect(screen.getByRole("combobox", { name: "工具权限" }))
      .toHaveValue("full_access");
    expect(screen.getByRole("switch", { name: /允许管理会话/ })).toBeChecked();
    expect(updateCount()).toBe(1);

    act(() => socketMock.emit?.({
      type: "command_complete",
      operation: "update_role",
      commandId: pendingUpdate.commandId,
      sessionId,
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("角色操作结果未确认");

    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    expect(updateCount()).toBe(1);
    expect(screen.getByText(/角色操作未发送/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Disconnected dirty name");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "管理角色" }))
      .not.toBeInTheDocument();
    const updatesBeforeReconnect = updateCount();
    act(() => {
      socketMock.status?.(true);
      socketMock.emit?.({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        startupCwd: "E:\\default",
      });
    });
    expect(updateCount()).toBe(updatesBeforeReconnect);
    expect(screen.queryByText(/角色操作(结果未确认|未发送)/)).not.toBeInTheDocument();

    const reconnectSessionId = latestSessionId();
    const authoritativeRole = defaultRole({
      revision: 2,
      name: "Default N+1",
      description: "Authoritative N+1 description",
      systemPrompt: "Authoritative prompt N+1",
      toolMode: "read_only",
      canManageSessions: false,
    });
    emitRoleReady(reconnectSessionId, authoritativeRole);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    fireEvent.click(screen.getByRole("button", { name: "管理角色 Default N+1" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "角色名称" }))
      .toHaveValue("Default N+1");
    expect(screen.getByRole("textbox", { name: "角色简介" }))
      .toHaveValue("Authoritative N+1 description");
    expect(screen.getByRole("textbox", { name: "专属提示词" }))
      .toHaveValue("Authoritative prompt N+1");
    expect(screen.getByRole("combobox", { name: "工具权限" }))
      .toHaveValue("read_only");
    expect(screen.getByRole("switch", { name: /允许管理会话/ })).not.toBeChecked();

    fireEvent.change(screen.getByRole("textbox", { name: "角色名称" }), {
      target: { value: "Fresh independent update" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存角色" }));
    const freshUpdate = latestCommand("update_role");
    expect(freshUpdate).toMatchObject({
      roleId: "default",
      expectedRevision: 2,
      expectedSystemPrompt: "Authoritative prompt N+1",
      role: {
        name: "Fresh independent update",
        description: "Authoritative N+1 description",
        systemPrompt: "Authoritative prompt N+1",
        toolMode: "read_only",
        canManageSessions: false,
      },
    });
    expect(freshUpdate.commandId).not.toBe(pendingUpdate.commandId);
    expect(updateCount()).toBe(updatesBeforeReconnect + 1);
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

  it("keeps an unsent rename draft open without creating an optimistic title", () => {
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationSummary(CONVERSATION_ID, "A")],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "重命名会话 A" }));
    const nameInput = screen.getByRole("textbox", { name: "会话名称" });
    fireEvent.change(nameInput, { target: { value: "Unsent rename" } });
    socketMock.send.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));

    expect(screen.getByRole("dialog", { name: "重命名会话" })).toBeInTheDocument();
    expect(nameInput).toHaveValue("Unsent rename");
    expect(latestCommand("rename_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
      name: "Unsent rename",
    });
    expect(screen.queryByText("Unsent rename", { selector: ".conversation-sidebar-title" }))
      .not.toBeInTheDocument();
  });

  it("clears a rename overlay only when an authoritative snapshot matches its title", () => {
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationSummary(CONVERSATION_ID, "A")],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "重命名会话 A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), {
      target: { value: "Renamed A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    const rename = latestCommand("rename_conversation");
    expect(screen.getByRole("status", { name: "名称同步中" })).toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationSummary(CONVERSATION_ID, "A")],
      truncated: false,
    }));
    expect(screen.getByRole("status", { name: "名称同步中" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 Renamed A" }))
      .toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationSummary(CONVERSATION_ID, "Renamed A")],
      truncated: false,
    }));
    expect(screen.queryByRole("status", { name: "名称同步中" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 Renamed A" }))
      .toBeInTheDocument();
    expect(rename.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rechecks an unknown rename through an explicit reopen before restoring its durable title", () => {
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
      socketMock.rawEmit?.({
        type: "project_snapshot",
        sessionId,
        projectId: PROJECT_ID,
        conversations: [conversationSummary(CONVERSATION_ID, "A")],
        truncated: false,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "重命名会话 A" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), {
      target: { value: "Renamed A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    const rename = latestCommand("rename_conversation");
    const persistenceFailure = "对话名称已用于当前会话，但可能未保存到项目历史：模拟写入失败";

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "settings",
      operation: "rename_conversation",
      sessionId,
      commandId: rename.commandId,
      conversationId: CONVERSATION_ID,
      message: persistenceFailure,
    }));
    expect(screen.getByRole("status", {
      name: "名称保存状态未确认；点击会话重新检查",
    })).toBeInTheDocument();
    expect(screen.getByText(persistenceFailure)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除会话 Renamed A" }))
      .toBeDisabled();

    act(() => socketMock.rawEmit?.({
      type: "project_snapshot",
      sessionId,
      projectId: PROJECT_ID,
      conversations: [conversationSummary(CONVERSATION_ID, "A")],
      truncated: false,
    }));
    expect(screen.getByRole("button", { name: "当前会话 Renamed A" }))
      .toBeInTheDocument();

    const focusCount = sentFocusCommandCount();
    fireEvent.click(screen.getByRole("button", { name: "当前会话 Renamed A" }));
    expect(sentFocusCommandCount()).toBe(focusCount + 1);
    expect(latestCommand("focus_conversation")).toMatchObject({
      sessionId,
      conversationId: CONVERSATION_ID,
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
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.queryByRole("status", {
      name: "名称保存状态未确认；点击会话重新检查",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前会话 A" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重命名会话 A" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "删除会话 A" })).toBeEnabled();
  });

  it("settles a non-current conversation rename error by its exact command", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "重命名会话 B" }));
    fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), {
      target: { value: "Renamed B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    const rename = latestCommand("rename_conversation");
    expect(screen.getByRole("status", { name: "名称同步中" })).toBeInTheDocument();

    act(() => socketMock.rawEmit?.({
      type: "error",
      scope: "command",
      operation: "rename_conversation",
      sessionId,
      commandId: rename.commandId,
      conversationId: CONVERSATION_B,
      message: "rename denied",
    }));

    expect(screen.queryByRole("status", { name: "名称同步中" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重命名会话 B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "当前会话 Renamed B" }))
      .not.toBeInTheDocument();
  });

  function startRunOwnershipCase(activeRunId?: string): string {
    render(<App />);
    const sessionId = startFromSetup();
    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: Boolean(activeRunId),
        ...(activeRunId
          ? { activeRun: { id: activeRunId, phase: "running" as const } }
          : {}),
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    return sessionId;
  }

  function sendRunOwnershipPrompt(text: string) {
    fireEvent.change(screen.getByRole("textbox", { name: "给 Pi 发送消息" }), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const prompt = latestCommand("prompt");
    if (!prompt.promptId) throw new Error("promptId missing");
    return { ...prompt, promptId: prompt.promptId };
  }

  it("keeps the active run as the STOP target and prevents duplicate aborts", () => {
    const sessionId = startRunOwnershipCase(RUN_ID);
    const followUp = sendRunOwnershipPrompt("busy follow-up");

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(latestCommand("abort").runId).toBe(RUN_ID);
    expect(screen.getByRole("button", { name: "停止请求已发送" })).toBeDisabled();
    expect(screen.getByText("停止请求已发送，正在等待运行状态更新…"))
      .toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "state",
      state: {
        sessionId,
        cwd: "E:\\work",
        busy: true,
        activeRun: { id: RUN_ID, phase: "cancelling" },
        thinkingLevel: "off",
        toolMode: "full_access",
        availableThinkingLevels: ["off"],
        selectedModel: { provider: "provider", id: "model" },
        providers: [],
      },
    }));
    expect(screen.getByRole("button", { name: "停止请求已发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止请求已发送" }));
    expect(socketMock.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "abort"))
      .toHaveLength(1);

    act(() => socketMock.emit?.({
      type: "prompt_admitted",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      promptId: followUp.promptId,
      text: followUp.text,
    }));
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("busy follow-up");

    expect(screen.getByRole("button", { name: "停止请求已发送" })).toBeDisabled();
    expect(socketMock.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "abort")
      .map((command) => command.runId))
      .toEqual([RUN_ID]);

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

  it.each(["admission", "send failure"])(
    "does not let a later follow-up replace a queued-only run owner after %s",
    (outcome) => {
      const sessionId = startRunOwnershipCase();
      const initial = sendRunOwnershipPrompt("queued owner");
      act(() => socketMock.emit?.({
        type: "session_event",
        sessionId,
        runId: initial.runId,
        event: { type: "run_queued" },
      }));

      if (outcome === "send failure") {
        socketMock.send.mockReturnValueOnce(false);
      }
      const followUp = sendRunOwnershipPrompt("later follow-up");
      if (outcome === "admission") {
        act(() => socketMock.emit?.({
          type: "prompt_admitted",
          sessionId,
          conversationId: CONVERSATION_ID,
          focusId: FOCUS_A,
          promptId: followUp.promptId,
          text: followUp.text,
        }));
      }

      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      expect(latestCommand("abort").runId).toBe(initial.runId);
    },
  );

  it("uses the initial idle prompt as the STOP target before any run state acknowledgement", () => {
    startRunOwnershipCase();
    const initial = sendRunOwnershipPrompt("initial before state");

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(latestCommand("abort").runId).toBe(initial.runId);
  });

  it("promotes an exact run_queued identity after the authoritative actor turns idle", () => {
    const sessionId = startRunOwnershipCase(RUN_ID);
    const promoted = sendRunOwnershipPrompt("promoted follow-up");
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
        type: "session_event",
        sessionId,
        runId: promoted.runId,
        event: { type: "run_queued" },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(latestCommand("abort").runId).toBe(promoted.runId);
  });

  it("keeps pending and run ownership through a stale admission", () => {
    const sessionId = startRunOwnershipCase(RUN_ID);
    const followUp = sendRunOwnershipPrompt("pending after stale admit");
    act(() => socketMock.emit?.({
      type: "prompt_admitted",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      promptId: "c6716d07-bbc8-407d-8947-e777f41773ac",
      text: "stale admitted row",
    }));

    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("pending after stale admit");
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("stale admitted row");
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(latestCommand("abort").runId).toBe(RUN_ID);

    act(() => {
      socketMock.emit?.({
        type: "prompt_admitted",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        promptId: followUp.promptId,
        text: followUp.text,
      });
      socketMock.emit?.({
        type: "session_event",
        sessionId,
        conversationId: CONVERSATION_ID,
        focusId: FOCUS_A,
        runId: RUN_ID,
        event: { type: "run_finished", outcome: "aborted" },
      });
    });
    expect(screen.getByRole("textbox", { name: "给 Pi 发送消息" }))
      .toHaveValue("");
    expect(screen.queryByRole("region", { name: "等待处理的消息" }))
      .not.toBeInTheDocument();
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

  it("replaces waiting prompts from each accepted conversation snapshot", () => {
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
      projectionSeq: 0,
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
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      projectionSeq: 0,
      items: [],
      pendingPrompts: [{
        promptId: "f3c5b3e7a-1f2a-4b6e-8d0c-9a1b2c3d4e5f",
        text: "replacement waiting",
      }],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    expect(screen.getByRole("region", { name: "等待处理的消息" }))
      .toHaveTextContent("replacement waiting");
    expect(screen.queryByText("still waiting")).not.toBeInTheDocument();

    act(() => socketMock.emit?.({
      type: "conversation_snapshot",
      sessionId,
      conversationId: CONVERSATION_ID,
      focusId: FOCUS_A,
      projectionSeq: 0,
      items: [],
      pendingPrompts: [],
      window: { omittedBefore: false, startsMidTurn: false, contentTruncated: false },
    }));
    expect(screen.queryByRole("region", { name: "等待处理的消息" }))
      .not.toBeInTheDocument();
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
