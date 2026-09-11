import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentMessage,
  ExtensionError,
  ModelRuntime,
  ModelRegistry,
  PromptOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, type CredentialStore } from "@earendil-works/pi-ai";
import {
  MAX_PROJECT_CONVERSATIONS,
  MAX_TRANSITION_DIAGNOSTIC_PHASE_MS,
  parseServerEvent,
  type ConversationSummary,
  type ServerEvent,
} from "../shared/protocol.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
  CredentialChangeIntent,
  PiRuntimeLike,
  ToolCallGate,
} from "./pi-runtime.js";
import {
  MAX_PROJECT_SNAPSHOT_BYTES,
  PiConnection,
} from "./pi-service.js";
import {
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createLoopListEntry,
} from "./conversation-meta.js";
import { ProjectStoreRegistry } from "./project-store.js";
import { ProjectSessionCoordinator } from "./project-session-coordinator.js";
import { RoleCatalog } from "./role-catalog.js";

const SESSION_A = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const SESSION_B = "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const SESSION_C = "b87435ff-2e88-41eb-8c09-694327af6270";
const RUN_A = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
const AUTH_A = "00000000-0000-4000-8000-0000000000a1";
const AUTH_B = "00000000-0000-4000-8000-0000000000b2";
const COMMAND_A = "b55e4225-e07f-4874-b760-015f7982d999";
const COMMAND_B = "8ee64aa3-c8a8-4e21-b521-66029ce3673b";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      removeTemporaryDirectory(directory),
    ),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (
        (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM")
        || attempt >= 4
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

interface FakeSession extends AgentSession {
  abortCalls: number;
  compactCalls: number;
  disposed: boolean;
  eventListener?: (event: AgentSessionEvent) => void;
  steerCalls: string[];
  steeringAgentMessages: AgentMessage[];
  toolCallGate?: ToolCallGate;
  persistentManager?: SessionManager;
}

type FakeCreatedSession = Pick<CreatedPiSession, "session" | "settings">;

function fakeSettings(): SettingsManager {
  return {
    applyOverrides: () => undefined,
    flush: async () => undefined,
    drainErrors: () => [],
  } as unknown as SettingsManager;
}

function fakeSession(settings = fakeSettings()): FakeSession {
  const session = {
    abortCalls: 0,
    compactCalls: 0,
    disposed: false,
    steerCalls: [],
    steeringAgentMessages: [],
    isStreaming: false,
    model: { provider: "test", id: "model", contextWindow: 1000 },
    messages: [],
    agent: {
      state: {
        messages: [],
      },
    },
    thinkingLevel: "off",
    settingsManager: settings,
    extensionRunner: {
      getCommand: () => undefined,
    },
    subscribe: function (listener: (event: AgentSessionEvent) => void) {
      this.eventListener = listener;
      return () => {
        if (this.eventListener === listener) this.eventListener = undefined;
      };
    },
    prompt: async () => undefined,
    sendCustomMessage: async function (
      message: Parameters<AgentSession["sendCustomMessage"]>[0],
      sendOptions: Parameters<AgentSession["sendCustomMessage"]>[1],
    ) {
      this.persistentManager?.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      if (sendOptions?.triggerTurn === true) await this.prompt("");
    },
    steeringMessages: [],
    getSteeringMessages: function () {
      return this.steeringMessages;
    },
    hasExtensionHandlers: () => false,
    steer: async function (text: string) {
      this.steerCalls.push(text);
      this.steeringMessages.push(text);
      this.steeringAgentMessages.push({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      } as AgentMessage);
    },
    clearQueue: function () {
      this.steeringMessages.splice(0);
      this.steeringAgentMessages.splice(0);
      return { steering: [], followUp: [] };
    },
    abort: async function () {
      this.abortCalls++;
      this.isStreaming = false;
    },
    compact: async function () {
      this.compactCalls++;
      return {};
    },
    dispose: function () {
      this.disposed = true;
    },
    setModel: async () => undefined,
    setThinkingLevel: function (level: string) {
      Object.assign(this, { thinkingLevel: level });
    },
    setSessionName: function (name: string) {
      this.persistentManager?.appendSessionInfo(name);
    },
    getAvailableThinkingLevels: () => ["off"],
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextUsage: { tokens: 0, contextWindow: 1000, percent: 0 },
    }),
  };
  return session as unknown as FakeSession;
}

class FakeRuntime implements PiRuntimeLike {
  credentialStore: CredentialStore = new InMemoryCredentialStore();
  readonly modelRuntime = {
    getProviders: () => [],
    getProvider: () => undefined,
  } as unknown as ModelRuntime;

  readonly modelRegistry = {
    getAll: () => [],
    getRegisteredProviderIds: () => [],
    getAvailable: () => [],
    getError: () => undefined,
    getProviderDisplayName: (provider: string) => provider,
    getProviderAuthStatus: () => ({ configured: false }),
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;

  readonly createCalls: string[] = [];
  readonly created: FakeSession[] = [];
  projectCatalogCreations = 0;
  beforeCreateProjectModelCatalog?: () => Promise<void>;
  sessionModelRegistry?: ModelRegistry;
  projectModelRegistry?: ModelRegistry;
  lastCreateOptions?: CreatePiSessionOptions;
  create: (cwd: string) => Promise<FakeCreatedSession> = async () => {
    const settings = fakeSettings();
    const session = fakeSession(settings);
    this.created.push(session);
    return { session, settings };
  };
  activate: (options: CreatePiSessionOptions) => Promise<void> = async () => undefined;
  refresh: () => Promise<void> = async () => undefined;
  extensionErrorHandler?: (error: ExtensionError) => void;
  readonly startupExtensionErrors: ExtensionError[] = [];

  private readonly listeners = new Set<() => void>();
  private readonly credentialRevisions = new Map<string, number>();

  async createProjectModelCatalog() {
    this.projectCatalogCreations++;
    await this.beforeCreateProjectModelCatalog?.();
    return {
      modelRuntime: this.modelRuntime,
      modelRegistry: this.projectModelRegistry ?? this.modelRegistry,
      dynamicProviderNames: () => new Set<string>(),
      dispose: async () => undefined,
    };
  }

  async createSession(
    cwd: string,
    options: CreatePiSessionOptions = {},
  ): Promise<CreatedPiSession> {
    this.createCalls.push(cwd);
    this.lastCreateOptions = options;
    const created = await this.create(cwd);
    created.session.toolCallGate = options.toolCallGate;
    created.session.persistentManager = options.sessionManager;
    let disposePromise: Promise<void> | undefined;
    let activatedHandler: ((error: ExtensionError) => void) | undefined;
    return {
      ...created,
      modelRuntime: this.modelRuntime,
      modelRegistry: this.sessionModelRegistry ?? this.modelRegistry,
      captureSteeringMessage: (operation) => {
        const before = created.session.steeringAgentMessages.length;
        const result = operation();
        const message = created.session.steeringAgentMessages[before];
        return {
          result,
          ...(message === undefined ? {} : { message }),
        };
      },
      activateExtensions: () => this.activate(options),
      activateExtensionErrors: (handler) => {
        activatedHandler = handler;
        this.extensionErrorHandler = handler;
        return this.startupExtensionErrors.splice(0);
      },
      dynamicProviderNames: () => new Set(),
      dispose: () => {
        disposePromise ??= (async () => {
          if (created.session.isStreaming) await created.session.abort();
          created.session.dispose();
          if (this.extensionErrorHandler === activatedHandler) {
            this.extensionErrorHandler = undefined;
          }
        })();
        return disposePromise;
      },
    };
  }

  beginCredentialChange(provider: string): CredentialChangeIntent {
    const revision = (this.credentialRevisions.get(provider) ?? 0) + 1;
    this.credentialRevisions.set(provider, revision);
    return { provider, revision };
  }

  commitCredentialChange(
    intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    return this.updateConfiguration(async () => {
      if (this.credentialRevisions.get(intent.provider) !== intent.revision) {
        return false;
      }
      this.credentialRevisions.set(intent.provider, intent.revision + 1);
      await change();
      return true;
    });
  }

  async updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    const value = await change();
    for (const listener of this.listeners) listener();
    return value;
  }

  async refreshConfiguration(): Promise<void> {
    await this.refresh();
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitExtensionError(error: ExtensionError): void {
    if (this.extensionErrorHandler) this.extensionErrorHandler(error);
    else this.startupExtensionErrors.push(error);
  }
}

function agentMessage(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeEvent(value: unknown): AgentSessionEvent {
  const event = value as {
    type?: string;
    assistantMessageEvent?: {
      type?: string;
      delta?: unknown;
      partial?: unknown;
    };
  };
  const update = event.assistantMessageEvent;
  if (
    event.type === "message_update"
    && update?.partial === undefined
    && (update?.type === "text_delta" || update?.type === "thinking_delta")
  ) {
    update.partial = {
      role: "assistant",
      content: [update.type === "text_delta"
        ? { type: "text", text: String(update.delta ?? "") }
        : { type: "thinking", thinking: String(update.delta ?? "") }],
    };
  }
  return event as AgentSessionEvent;
}

function latestState(events: ServerEvent[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "state") return event.state;
  }
  throw new Error("state not published");
}

function configureOAuth(
  runtime: FakeRuntime,
  login: (provider: string, interaction: { signal: AbortSignal }) => Promise<void>,
): void {
  const provider = {
    id: "oauth",
    name: "OAuth",
    auth: {
      oauth: {
        name: "OAuth",
        login: async (interaction: { signal: AbortSignal }) => {
          await login("oauth", interaction);
          return {
            type: "oauth" as const,
            access: "test access",
            refresh: "test refresh",
            expires: Date.now() + 60_000,
          };
        },
        refresh: async () => ({
          type: "oauth" as const,
          access: "refreshed",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
        toAuth: async () => ({ apiKey: "test" }),
      },
    },
  } as never;
  Object.assign(runtime.modelRuntime, {
    getProviders: () => [provider],
    getProvider: (id: string) => id === "oauth" ? provider : undefined,
  });
}

async function coordinatedConnectionHarness(
  runtime = new FakeRuntime(),
  monotonicNow?: () => number,
) {
  const cwd = await realpath(
    await temporaryDirectory("piweb-coordinated-"),
  );
  const model = {
    provider: "test",
    id: "model",
    name: "Test model",
    reasoning: false,
    input: ["text"],
    contextWindow: 1_000,
  };
  Object.assign(runtime.modelRegistry, {
    getAll: () => [model],
    getRegisteredProviderIds: () => [],
    getAvailable: () => [model],
    getError: () => undefined,
    getProviderDisplayName: (provider: string) => provider,
    getProviderAuthStatus: () => ({ configured: true }),
    hasConfiguredAuth: () => true,
  });
  const roles = await RoleCatalog.open(
    runtime,
    join(cwd, "roles.json"),
  );
  const projects = new ProjectStoreRegistry();
  const coordinator = new ProjectSessionCoordinator(
    runtime,
    roles,
    projects,
  );
  const events: ServerEvent[] = [];
  const connection = new PiConnection(
    (event) => events.push(event),
    runtime,
    async () => ({ coordinator, roles }),
    monotonicNow,
  );
  const cleanup = async () => {
    await connection.dispose();
    await coordinator.close();
    roles.dispose();
  };
  return {
    cwd,
    runtime,
    coordinator,
    roles,
    events,
    connection,
    cleanup,
  };
}

type CoordinatedHarness = Awaited<
  ReturnType<typeof coordinatedConnectionHarness>
>;

async function initializeNewConversation(
  harness: CoordinatedHarness,
  sessionId = SESSION_A,
) {
  await harness.connection.handle({
    type: "initialize",
    commandId: randomUUID(),
    sessionId,
    cwd: harness.cwd,
    conversation: { kind: "new", roleId: "default" },
  });
  return latestState(harness.events);
}

async function pauseCommittedCatalogFailure(
  harness: CoordinatedHarness,
  focused: ReturnType<typeof latestState>,
): Promise<{
  retainedId: string;
  selectedId: string;
  recoveryStarted: Promise<void>;
  releaseRecovery(): void;
}> {
  const manager = harness.runtime.created[0]?.persistentManager;
  if (!manager) throw new Error("persistent SessionManager was not provided");
  const retainedId = manager.appendMessage({
    role: "user",
    content: "retained",
    timestamp: 1,
  });
  const selectedId = manager.appendMessage({
    role: "user",
    content: "rewind from here",
    timestamp: 2,
  });
  await harness.connection.handle({
    type: "refresh_view",
    sessionId: SESSION_A,
    projectId: focused.projectId,
    conversationId: focused.conversationId!,
    focusId: focused.focusId!,
  });
  await vi.waitFor(() => {
    expect(harness.events.findLast(
      (event) => event.type === "project_snapshot",
    )).toMatchObject({ coverage: "complete" });
  });

  const handle = await harness.coordinator.acquireProject(harness.cwd, "read_only");
  const project = handle.project;
  const internals = project as unknown as {
    scanConversations(): Promise<unknown>;
  };
  vi.spyOn(internals, "scanConversations").mockRejectedValueOnce(
    new Error("catalog refresh failed"),
  );
  const openConversation = project.openConversation.bind(project);
  const recoveryStarted = deferred();
  const releaseRecovery = deferred();
  vi.spyOn(project, "openConversation").mockImplementationOnce(
    async (...args) => {
      recoveryStarted.resolve();
      await releaseRecovery.promise;
      return openConversation(...args);
    },
  );
  handle.release();
  return {
    retainedId,
    selectedId,
    recoveryStarted: recoveryStarted.promise,
    releaseRecovery: releaseRecovery.resolve,
  };
}

function exposeModelProvider(
  runtime: FakeRuntime,
  provider: string,
): void {
  const models = runtime.modelRegistry.getAll();
  const available = runtime.modelRegistry.getAvailable();
  const model = {
    provider,
    id: "credential-model",
    name: "Credential model",
    reasoning: false,
    input: ["text"],
    contextWindow: 1_000,
  };
  Object.assign(runtime.modelRegistry, {
    getAll: () => [...models, model],
    getAvailable: () => [...available, model],
    getRegisteredProviderIds: () => [provider],
  });
}

async function createColdConversation(
  harness: CoordinatedHarness,
  text: string,
  cwd = harness.cwd,
): Promise<string> {
  const handle = await harness.coordinator.acquireProject(cwd, "read_only");
  try {
    const conversationId = randomUUID();
    const manager = await handle.project.createConversation(
      conversationId,
      {
        role: harness.roles.getConversationRole("default"),
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
      },
      { updateRecent: false },
    );
    manager.appendMessage(agentMessage({
      role: "user",
      content: text,
      timestamp: 1,
    }));
    return conversationId;
  } finally {
    handle.release();
  }
}

async function createWarmConversation(
  harness: CoordinatedHarness,
  cwd: string,
  text: string,
): Promise<string> {
  const conversationId = await createColdConversation(harness, text, cwd);
  const handle = await harness.coordinator.acquireProject(cwd, "read_only");
  try {
    await harness.coordinator.ensureProjectModelCatalog(handle);
    await harness.coordinator.openConversation(handle, conversationId, {
      updateRecent: false,
    });
    return conversationId;
  } finally {
    handle.release();
  }
}

function projectReferenceState(handle: unknown): {
  attention: Set<string>;
  listeners: Set<unknown>;
  references: number;
} {
  return (handle as {
    context: {
      attention: Set<string>;
      listeners: Set<unknown>;
      references: number;
    };
  }).context;
}

async function replaceCoordinatedInitialization(
  harness: CoordinatedHarness,
  staleStarted: Promise<void>,
  staleConversation: { kind: "recent" } | {
    kind: "open";
    conversationId: string;
  },
  currentCwd: string,
  currentConversationId: string,
  operations: Promise<void>[],
): Promise<void> {
  const staleCommandId = randomUUID();
  operations.push(harness.connection.handle({
    type: "initialize",
    commandId: staleCommandId,
    sessionId: SESSION_B,
    cwd: harness.cwd,
    conversation: staleConversation,
  }));
  await staleStarted;

  const currentCommandId = randomUUID();
  operations.push(harness.connection.handle({
    type: "initialize",
    commandId: currentCommandId,
    sessionId: SESSION_C,
    cwd: currentCwd,
    conversation: {
      kind: "open",
      conversationId: currentConversationId,
    },
  }));
  await vi.waitFor(() => {
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: "focus_attached",
      commandId: currentCommandId,
      conversationId: currentConversationId,
    }));
  });
  await Promise.all(operations);

  expect(harness.events).not.toContainEqual(expect.objectContaining({
    type: "focus_attached",
    commandId: staleCommandId,
  }));
  expect(harness.events).not.toContainEqual(expect.objectContaining({
    transitionDiagnostics: expect.objectContaining({
      commandId: staleCommandId,
    }),
  }));
  expect(latestState(harness.events).conversationId).toBe(
    currentConversationId,
  );
}

describe("PiConnection coordinated controls", () => {
  it("attributes successful initialize and focus phases only on their first authority envelope", async () => {
    let tick = 0;
    const harness = await coordinatedConnectionHarness(
      new FakeRuntime(),
      () => ++tick,
    );
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const emptyAttach = harness.events.find((event) =>
        event.type === "focus_attached" && event.commandId === COMMAND_A
      );
      expect(emptyAttach).toMatchObject({
        type: "focus_attached",
        operation: "initialize",
        transitionDiagnostics: {
          version: 1,
          commandId: COMMAND_A,
          operation: "initialize",
          validationMs: 1,
          contextOrCatalogMs: 3,
          presentationOrTargetReadMs: 1,
          actorActivationOrLeaseMs: 0,
          snapshotProjectionMs: null,
        },
      });

      const firstConversationId = await createColdConversation(harness, "first");
      const initializeStart = harness.events.length;
      await harness.connection.handle({
        type: "initialize",
        commandId: COMMAND_B,
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "open", conversationId: firstConversationId },
      });
      const initializedEvents = harness.events.slice(initializeStart);
      const initializedAttach = initializedEvents.find((event) =>
        event.type === "focus_attached" && event.commandId === COMMAND_B
      );
      if (
        initializedAttach?.type !== "focus_attached"
        || !initializedAttach.focusId
      ) throw new Error("initialized focus was not attached");
      expect(initializedAttach).not.toHaveProperty("transitionDiagnostics");
      const initializedSnapshot = initializedEvents.find((event) =>
        event.type === "conversation_snapshot"
        && event.focusId === initializedAttach.focusId
      );
      expect(initializedSnapshot).toMatchObject({
        transitionDiagnostics: {
          version: 1,
          commandId: COMMAND_B,
          operation: "initialize",
          validationMs: 1,
          contextOrCatalogMs: 3,
          presentationOrTargetReadMs: 1,
          actorActivationOrLeaseMs: 1,
          snapshotProjectionMs: 1,
        },
      });

      const secondConversationId = await createColdConversation(harness, "second");
      const coldFocusCommandId = randomUUID();
      const coldFocusStart = harness.events.length;
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: coldFocusCommandId,
        sessionId: SESSION_B,
        conversationId: secondConversationId,
      });
      const coldFocusSnapshot = harness.events.slice(coldFocusStart).find((event) =>
        event.type === "conversation_snapshot"
        && event.conversationId === secondConversationId
      );
      expect(coldFocusSnapshot).toMatchObject({
        transitionDiagnostics: {
          commandId: coldFocusCommandId,
          operation: "focus_conversation",
          validationMs: 1,
          contextOrCatalogMs: 1,
          presentationOrTargetReadMs: 1,
          actorActivationOrLeaseMs: 1,
          snapshotProjectionMs: 1,
        },
      });

      const warmFocusCommandId = randomUUID();
      const warmFocusStart = harness.events.length;
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: warmFocusCommandId,
        sessionId: SESSION_B,
        conversationId: firstConversationId,
      });
      const warmEvents = harness.events.slice(warmFocusStart);
      const warmAttach = warmEvents.find((event) =>
        event.type === "focus_attached" && event.commandId === warmFocusCommandId
      );
      if (warmAttach?.type !== "focus_attached" || !warmAttach.focusId) {
        throw new Error("warm focus was not attached");
      }
      expect(warmEvents.find((event) =>
        event.type === "conversation_snapshot"
        && event.focusId === warmAttach.focusId
      )).toMatchObject({
        transitionDiagnostics: {
          commandId: warmFocusCommandId,
          operation: "focus_conversation",
          validationMs: 1,
          contextOrCatalogMs: 1,
          presentationOrTargetReadMs: 1,
          actorActivationOrLeaseMs: 1,
          snapshotProjectionMs: 1,
        },
      });

      const refreshStart = harness.events.length;
      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_B,
        projectId: latestState(harness.events).projectId,
        conversationId: firstConversationId,
        focusId: warmAttach.focusId,
      });
      const refreshedSnapshots = harness.events.slice(refreshStart).filter(
        (event) => event.type === "conversation_snapshot",
      );
      expect(refreshedSnapshots).toHaveLength(1);
      expect(refreshedSnapshots[0]).not.toHaveProperty("transitionDiagnostics");
    } finally {
      await harness.cleanup();
    }
  });

  it.each([
    [
      "throwing",
      () => () => { throw new Error("clock unavailable"); },
      0,
    ],
    [
      "non-finite",
      () => {
        let call = 0;
        return () => call++ % 2 === 0
          ? Number.NaN
          : Number.POSITIVE_INFINITY;
      },
      0,
    ],
    [
      "backward",
      () => {
        let call = 0;
        return () => call++ % 2 === 0 ? 10 : 5;
      },
      0,
    ],
    [
      "over-cap",
      () => {
        let call = 0;
        return () => call++ % 2 === 0
          ? 0
          : MAX_TRANSITION_DIAGNOSTIC_PHASE_MS + 1;
      },
      MAX_TRANSITION_DIAGNOSTIC_PHASE_MS,
    ],
  ] as const)(
    "keeps transitions successful and diagnostics bounded for a %s clock",
    async (_label, createClock, expectedDuration) => {
      const harness = await coordinatedConnectionHarness(
        new FakeRuntime(),
        createClock(),
      );
      try {
        await expect(harness.connection.handle({
          type: "initialize",
          commandId: COMMAND_A,
          sessionId: SESSION_A,
          cwd: harness.cwd,
          conversation: { kind: "recent" },
        })).resolves.toBeUndefined();

        const attach = harness.events.find((event) =>
          event.type === "focus_attached" && event.commandId === COMMAND_A
        );
        if (
          attach?.type !== "focus_attached"
          || attach.transitionDiagnostics === undefined
        ) throw new Error("empty focus was not attached with diagnostics");
        expect(parseServerEvent(attach)).toEqual(attach);
        expect(attach.transitionDiagnostics).toEqual({
          version: 1,
          commandId: COMMAND_A,
          operation: "initialize",
          validationMs: expectedDuration,
          contextOrCatalogMs: expectedDuration,
          presentationOrTargetReadMs: expectedDuration,
          actorActivationOrLeaseMs: 0,
          snapshotProjectionMs: null,
        });
      } finally {
        await harness.cleanup();
      }
    },
  );

  it.each(["initialize", "focus_conversation"] as const)(
    "keeps %s authority ahead of a failing diagnostic snapshot projection",
    async (operation) => {
      const harness = await coordinatedConnectionHarness();
      let actorHandle: Awaited<ReturnType<
        typeof harness.coordinator.acquireProject
      >> | undefined;
      try {
        await harness.connection.handle({
          type: "initialize",
          commandId: COMMAND_A,
          sessionId: SESSION_A,
          cwd: harness.cwd,
          conversation: { kind: "recent" },
        });
        const targetConversationId = await createColdConversation(
          harness,
          "projection target",
        );
        actorHandle = await harness.coordinator.acquireProject(
          harness.cwd,
          "read_only",
        );
        await harness.coordinator.ensureProjectModelCatalog(actorHandle);
        const actor = await harness.coordinator.openConversation(
          actorHandle,
          targetConversationId,
          { updateRecent: false },
        );

        const transitionStart = harness.events.length;
        let eventsAtProjection: ServerEvent[] | undefined;
        vi.spyOn(actor, "projectConversationItems").mockImplementation(() => {
          eventsAtProjection ??= harness.events.slice(transitionStart);
          throw new Error("diagnostic projection failed");
        });

        if (operation === "initialize") {
          await harness.connection.handle({
            type: "initialize",
            commandId: COMMAND_B,
            sessionId: SESSION_B,
            cwd: harness.cwd,
            conversation: {
              kind: "open",
              conversationId: targetConversationId,
            },
          });
        } else {
          await harness.connection.handle({
            type: "focus_conversation",
            commandId: COMMAND_B,
            sessionId: SESSION_A,
            conversationId: targetConversationId,
          });
        }

        const transitionEvents = harness.events.slice(transitionStart);
        const attach = transitionEvents.find((event) =>
          event.type === "focus_attached" && event.commandId === COMMAND_B
        );
        if (attach?.type !== "focus_attached" || !attach.focusId) {
          throw new Error("focus was not attached before projection");
        }
        expect(eventsAtProjection).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: "focus_attached",
            commandId: COMMAND_B,
            focusId: attach.focusId,
          }),
          expect.objectContaining({
            type: "state",
            state: expect.objectContaining({ focusId: attach.focusId }),
          }),
        ]));
        const attachIndex = transitionEvents.indexOf(attach);
        const stateIndex = transitionEvents.findIndex((event) =>
          event.type === "state" && event.state.focusId === attach.focusId
        );
        const errorIndex = transitionEvents.findIndex((event) =>
          event.type === "error"
          && event.message.includes("diagnostic projection failed")
        );
        expect(attachIndex).toBeGreaterThanOrEqual(0);
        expect(stateIndex).toBeGreaterThan(attachIndex);
        expect(errorIndex).toBeGreaterThan(stateIndex);
        expect(transitionEvents).not.toContainEqual(expect.objectContaining({
          transitionDiagnostics: expect.objectContaining({
            commandId: COMMAND_B,
          }),
        }));
      } finally {
        actorHandle?.release();
        await harness.cleanup();
      }
    },
  );

  it("fails closed when the shared coordination provider cannot be acquired", async () => {
    const cwd = await realpath(
      await temporaryDirectory("piweb-coordination-failure-"),
    );
    const runtime = new FakeRuntime();
    const connection = new PiConnection(
      () => undefined,
      runtime,
      async () => { throw new Error("coordination unavailable"); },
    );

    await expect(connection.handle({
      type: "initialize",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "recent" },
    })).rejects.toThrow("coordination unavailable");
    expect(runtime.createCalls).toEqual([]);
    expect(connection.sessionId).toBeUndefined();
    await connection.dispose();
  });

  it("round-trips extension UI during activation before coordinated focus attaches", async () => {
    const runtime = new FakeRuntime();
    const interactionStarted = deferred();
    let confirmed: boolean | undefined;
    runtime.activate = async (options) => {
      if (!options.extensionUI) throw new Error("extension UI was not bound");
      const response = options.extensionUI.confirm("Trust helper", "Continue?");
      interactionStarted.resolve();
      confirmed = await response;
    };
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      const initialization = harness.connection.handle({
        type: "initialize",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      });
      await interactionStarted.promise;
      const request = harness.events.find((event) => event.type === "extension_ui_request");
      if (request?.type !== "extension_ui_request") throw new Error("extension UI request was not emitted");
      expect(harness.events.some((event) => event.type === "focus_attached")).toBe(false);

      await harness.connection.handle({
        type: "extension_ui_response",
        sessionId: SESSION_A,
        requestId: request.requestId,
        response: { kind: "confirm", confirmed: true },
      });
      await initialization;
      expect(confirmed).toBe(true);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: request.requestId,
      });
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "focus_attached",
        operation: "initialize",
        commandId: COMMAND_A,
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("only closes the focused actor extension dialog for an exact run abort", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const state = await initializeNewConversation(harness);
      const session = harness.runtime.created[0];
      if (!session) throw new Error("focused actor session was not created");
      const promptStarted = deferred();
      let confirmed: boolean | undefined;
      session.prompt = async () => {
        const ui = harness.runtime.lastCreateOptions?.extensionUI;
        if (!ui) throw new Error("extension UI was not bound");
        const response = ui.confirm("Blocking hook", "Continue?");
        promptStarted.resolve();
        confirmed = await response;
      };

      const prompt = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_A,
        promptId: randomUUID(),
        text: "work",
      });
      await promptStarted.promise;
      const request = harness.events.findLast((event) => event.type === "extension_ui_request");
      if (request?.type !== "extension_ui_request") throw new Error("run extension UI request was not emitted");
      await harness.connection.handle({
        type: "abort",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_B,
      });
      expect(confirmed).toBeUndefined();
      expect(harness.events).not.toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: request.requestId,
      });

      await harness.connection.handle({
        type: "abort",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_A,
      });
      await prompt;

      expect(confirmed).toBe(false);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: request.requestId,
      });
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "session_event",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_A,
        event: { type: "run_finished", outcome: "aborted" },
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps session, run, and credential command identities exact and non-reusable", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const state = await initializeNewConversation(harness);
      exposeModelProvider(harness.runtime, "provider");
      await expect(initializeNewConversation(harness)).rejects.toThrow("Session ID was already used");

      await harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_A,
        promptId: randomUUID(),
        text: "first",
      });
      await expect(harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        focusId: state.focusId,
        runId: RUN_A,
        promptId: randomUUID(),
        text: "reused",
      })).rejects.toThrow("Run ID was already used");

      await harness.connection.handle({
        type: "set_api_key",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        provider: "provider",
        key: "first",
      });
      await expect(harness.connection.handle({
        type: "set_api_key",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        provider: "provider",
        key: "second",
      })).rejects.toThrow("Command ID was already used");
      await expect(harness.runtime.credentialStore.read("provider")).resolves.toEqual({
        type: "api_key",
        key: "first",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects failed and stale API key commands without acknowledging them", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await initializeNewConversation(harness);
      exposeModelProvider(harness.runtime, "provider");
      const credentialStore = harness.runtime.credentialStore;
      const modify = credentialStore.modify.bind(credentialStore);
      vi.spyOn(credentialStore, "modify")
        .mockRejectedValueOnce(new Error("credential write failed"))
        .mockImplementation(modify);

      await expect(harness.connection.handle({
        type: "set_api_key",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        provider: "provider",
        key: "failed",
      })).rejects.toThrow("credential write failed");

      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "command_complete",
        commandId: COMMAND_A,
      }));

      await initializeNewConversation(harness, SESSION_B);
      await expect(harness.connection.handle({
        type: "set_api_key",
        commandId: COMMAND_B,
        sessionId: SESSION_A,
        provider: "provider",
        key: "stale",
      })).rejects.toThrow("Session was not initialized");
      await expect(harness.runtime.credentialStore.read("provider")).resolves.toBeUndefined();
      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "command_complete",
        commandId: COMMAND_B,
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects a manual model refresh while offline", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await initializeNewConversation(harness);
      vi.stubEnv("PI_OFFLINE", "1");
      await expect(harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      })).rejects.toThrow("Model refresh is unavailable while offline");
    } finally {
      vi.unstubAllEnvs();
      await harness.cleanup();
    }
  });

  it("maps a manual model refresh timeout and keeps correlation occupied until it drains", async () => {
    vi.useFakeTimers();
    const harness = await coordinatedConnectionHarness();
    let releaseRefresh = () => undefined;
    try {
      await initializeNewConversation(harness);
      const refresh = vi.spyOn(harness.runtime, "refreshConfiguration")
        .mockImplementation(() => new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }));

      const pending = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      const timedOut = expect(pending).rejects.toThrow("Model refresh timed out; please retry");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(refresh.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
      await timedOut;
      await expect(harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_B,
        sessionId: SESSION_A,
      })).rejects.toThrow("already pending");
    } finally {
      releaseRefresh();
      await Promise.resolve();
      await harness.cleanup();
      vi.useRealTimers();
    }
  });

  it("cancels active model refreshes before close, reinitialize, and dispose", async () => {
    const harness = await coordinatedConnectionHarness();
    const signals: AbortSignal[] = [];
    const releaseRefreshes: Array<() => void> = [];
    vi.spyOn(harness.runtime, "refreshConfiguration").mockImplementation((options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise<void>((resolve) => releaseRefreshes.push(resolve));
    });
    try {
      await initializeNewConversation(harness);
      const first = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      await Promise.resolve();
      await harness.connection.handle({ type: "close_session", sessionId: SESSION_B });
      expect(signals[0]?.aborted).toBe(false);

      const close = harness.connection.handle({ type: "close_session", sessionId: SESSION_A });
      await expect(first).rejects.toThrow("connection lifecycle");
      await close;
      expect(signals[0]?.aborted).toBe(true);
      releaseRefreshes[0]?.();
      await Promise.resolve();
      await Promise.resolve();

      await initializeNewConversation(harness, SESSION_B);
      const second = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_B,
        sessionId: SESSION_B,
      });
      await Promise.resolve();
      const reinitialize = initializeNewConversation(harness, SESSION_C);
      await expect(second).rejects.toThrow("connection lifecycle");
      await reinitialize;
      expect(signals[1]?.aborted).toBe(true);
      releaseRefreshes[1]?.();
      await Promise.resolve();
      await Promise.resolve();

      const third = harness.connection.handle({
        type: "refresh_models",
        commandId: randomUUID(),
        sessionId: SESSION_C,
      });
      await Promise.resolve();
      const disposing = harness.connection.dispose();
      await expect(third).rejects.toThrow("connection lifecycle");
      await disposing;
      expect(signals[2]?.aborted).toBe(true);
      releaseRefreshes[2]?.();
    } finally {
      for (const release of releaseRefreshes) release();
      await harness.cleanup();
    }
  });

  it("keeps an applied thinking level when its settings flush fails", async () => {
    const runtime = new FakeRuntime();
    const settingsErrors: Array<{ error: Error }> = [];
    let failFlush = false;
    const settings = {
      applyOverrides: () => undefined,
      flush: async () => {
        if (!failFlush) return;
        const item = { error: new Error("settings write failed") };
        settingsErrors.push(item);
        throw item.error;
      },
      drainErrors: () => settingsErrors.splice(0),
    } as unknown as SettingsManager;
    runtime.create = async () => {
      const session = fakeSession(settings);
      runtime.created.push(session);
      return { session, settings };
    };
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      failFlush = true;
      await expect(harness.connection.handle({
        type: "set_thinking",
        sessionId: SESSION_A,
        level: "high",
      })).resolves.toBeUndefined();
      expect(latestState(harness.events).thinkingLevel).toBe("high");
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "error",
        scope: "settings",
        sessionId: SESSION_A,
        message: "settings write failed",
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps an in-memory conversation name when its session entry cannot persist", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const state = await initializeNewConversation(harness);
      const manager = harness.runtime.created[0]?.persistentManager;
      if (!manager) throw new Error("persistent SessionManager was not provided");
      Object.assign(manager, {
        _persist: () => { throw new Error("session name entry could not be written"); },
      });

      await expect(harness.connection.handle({
        type: "rename_conversation",
        sessionId: SESSION_A,
        conversationId: state.conversationId,
        name: "Renamed in memory",
      })).resolves.toBeUndefined();
      expect(latestState(harness.events).conversationName).toBe("Renamed in memory");
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "error",
        scope: "settings",
        sessionId: SESSION_A,
        message: expect.stringContaining("对话名称已用于当前会话"),
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("waits for OAuth credentials before entering configuration serialization", async () => {
    const loginStarted = deferred();
    const loginGate = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => {
      loginStarted.resolve();
      await loginGate.promise;
    });
    let configurationChanges = 0;
    const order: string[] = [];
    runtime.updateConfiguration = async <T>(change: () => Promise<T> | T) => {
      configurationChanges++;
      const value = await change();
      order.push("configuration-refreshed");
      return value;
    };
    const harness = await coordinatedConnectionHarness(runtime);
    const connection = new PiConnection(
      (event) => { if (event.type === "auth_complete") order.push("auth-complete"); },
      runtime,
      async () => ({ coordinator: harness.coordinator, roles: harness.roles }),
    );
    try {
      const login = connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await loginStarted.promise;
      expect(configurationChanges).toBe(0);
      loginGate.resolve();
      await login;
      expect(configurationChanges).toBe(1);
      expect(order).toEqual(["configuration-refreshed", "auth-complete"]);
      await expect(runtime.credentialStore.read("oauth")).resolves.toEqual(
        expect.objectContaining({
          type: "oauth",
          access: "test access",
          refresh: "test refresh",
        }),
      );
      await expect(connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      })).rejects.toThrow("Auth flow ID was already used");
    } finally {
      loginGate.resolve();
      await connection.dispose();
      await harness.cleanup();
    }
  });

  it("sanitizes provider failures without putting OAuth secrets on the wire", async () => {
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => {
      throw new Error("provider body access_token=access-secret refresh_token=refresh-secret");
    });
    const harness = await coordinatedConnectionHarness(runtime);
    const events: ServerEvent[] = [];
    const connection = new PiConnection(
      (event) => events.push(event),
      runtime,
      async () => ({ coordinator: harness.coordinator, roles: harness.roles }),
    );
    try {
      let failure: unknown;
      try {
        await connection.handle({
          type: "login_oauth",
          authFlowId: AUTH_A,
          provider: "oauth",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("OAuth login failed");
      expect(JSON.stringify(events)).not.toContain("access-secret");
      expect(JSON.stringify(events)).not.toContain("refresh-secret");
    } finally {
      await connection.dispose();
      await harness.cleanup();
    }
  });

  it("lets an admitted API key supersede OAuth that is still waiting", async () => {
    const loginStarted = deferred();
    const loginGate = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => {
      loginStarted.resolve();
      await loginGate.promise;
    });
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      exposeModelProvider(runtime, "oauth");
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await loginStarted.promise;
      const setKey = harness.connection.handle({
        type: "set_api_key",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
        provider: "oauth",
        key: "new-api-key",
      });
      loginGate.resolve();

      await expect(login).rejects.toThrow(
        "OAuth credential change was superseded by a newer credential change",
      );
      await setKey;
      expect(harness.events.some((event) => event.type === "auth_complete")).toBe(false);
      await expect(runtime.credentialStore.read("oauth")).resolves.toEqual({
        type: "api_key",
        key: "new-api-key",
      });
    } finally {
      loginGate.resolve();
      await harness.cleanup();
    }
  });

  it("does not let an older OAuth result overwrite logout from another connection", async () => {
    const loginStarted = deferred();
    const loginGate = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => {
      loginStarted.resolve();
      await loginGate.promise;
    });
    await runtime.credentialStore.modify("oauth", async () => ({
      type: "api_key",
      key: "previous",
    }));
    const harness = await coordinatedConnectionHarness(runtime);
    const logout = new PiConnection(
      () => undefined,
      runtime,
      async () => ({ coordinator: harness.coordinator, roles: harness.roles }),
    );
    try {
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await loginStarted.promise;
      await logout.handle({ type: "logout", provider: "oauth" });
      await expect(runtime.credentialStore.read("oauth")).resolves.toBeUndefined();
      loginGate.resolve();
      await expect(login).rejects.toThrow(
        "OAuth credential change was superseded by a newer credential change",
      );
      await expect(runtime.credentialStore.read("oauth")).resolves.toBeUndefined();
    } finally {
      loginGate.resolve();
      await logout.dispose();
      await harness.cleanup();
    }
  });

  it("cancels active OAuth on lifecycle change without blocking the replacement session", async () => {
    const loginStarted = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async (_provider, interaction) => {
      loginStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => reject(new Error("Authentication cancelled"));
        if (interaction.signal.aborted) cancel();
        else interaction.signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await loginStarted.promise;
      const close = harness.connection.handle({ type: "close_session", sessionId: SESSION_A });
      const initialize = initializeNewConversation(harness, SESSION_B);
      await Promise.all([login, close, initialize]);
      expect(harness.connection.sessionId).toBe(SESSION_B);
      expect(harness.events.some((event) => event.type === "auth_complete")).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not commit OAuth cancelled while waiting for credential serialization", async () => {
    const commitStarted = deferred();
    const commitGate = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => undefined);
    await runtime.credentialStore.modify("oauth", async () => ({
      type: "api_key",
      key: "previous",
    }));
    const commitCredentialChange = runtime.commitCredentialChange.bind(runtime);
    runtime.commitCredentialChange = async (intent, change) => {
      commitStarted.resolve();
      await commitGate.promise;
      return commitCredentialChange(intent, change);
    };
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await commitStarted.promise;
      await harness.connection.handle({ type: "cancel_auth", authFlowId: AUTH_A });
      commitGate.resolve();
      await login;
      await expect(runtime.credentialStore.read("oauth")).resolves.toEqual({
        type: "api_key",
        key: "previous",
      });
      expect(harness.events.some((event) => event.type === "auth_complete")).toBe(false);
    } finally {
      commitGate.resolve();
      await harness.cleanup();
    }
  });

  it("preserves a concurrent credential refresh when cancelled OAuth resolves", async () => {
    const loginStarted = deferred();
    const loginGate = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async () => {
      loginStarted.resolve();
      await loginGate.promise;
    });
    await runtime.credentialStore.modify("oauth", async () => ({
      type: "api_key",
      key: "previous",
    }));
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await loginStarted.promise;
      await harness.connection.handle({ type: "cancel_auth", authFlowId: AUTH_A });
      await runtime.credentialStore.modify("oauth", async () => ({
        type: "oauth",
        access: "concurrently refreshed",
        refresh: "concurrently refreshed",
        expires: Date.now() + 60_000,
      }));
      loginGate.resolve();
      await login;
      await expect(runtime.credentialStore.read("oauth")).resolves.toEqual(
        expect.objectContaining({ type: "oauth", access: "concurrently refreshed" }),
      );
      expect(harness.events.some((event) => event.type === "auth_complete")).toBe(false);
    } finally {
      loginGate.resolve();
      await harness.cleanup();
    }
  });

  it("cancels an OAuth flow before its queued operation starts", async () => {
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const runtime = new FakeRuntime();
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => { loginCalls++; });
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      const refresh = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      await refreshStarted.promise;
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      await harness.connection.handle({ type: "cancel_auth", authFlowId: AUTH_A });
      refreshGate.resolve();
      await Promise.all([refresh, login]);
      expect(loginCalls).toBe(0);
    } finally {
      refreshGate.resolve();
      await harness.cleanup();
    }
  });

  it("lets a newer OAuth flow supersede one still queued behind refresh", async () => {
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const runtime = new FakeRuntime();
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => { loginCalls++; });
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      const refresh = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      await refreshStarted.promise;
      const first = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      const second = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_B,
        provider: "oauth",
      });
      refreshGate.resolve();
      await Promise.all([refresh, first, second]);
      expect(loginCalls).toBe(1);
      expect(harness.events.filter((event) => event.type === "auth_complete")).toEqual([
        expect.objectContaining({ authFlowId: AUTH_B }),
      ]);
    } finally {
      refreshGate.resolve();
      await harness.cleanup();
    }
  });

  it("drops OAuth queued before its coordinated view closes", async () => {
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const runtime = new FakeRuntime();
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => { loginCalls++; });
    const harness = await coordinatedConnectionHarness(runtime);
    try {
      await initializeNewConversation(harness);
      const refresh = harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      await refreshStarted.promise;
      const login = harness.connection.handle({
        type: "login_oauth",
        authFlowId: AUTH_A,
        provider: "oauth",
      });
      const close = harness.connection.handle({ type: "close_session", sessionId: SESSION_A });
      await expect(refresh).rejects.toThrow("connection lifecycle");
      await Promise.all([login, close]);
      expect(loginCalls).toBe(0);
    } finally {
      refreshGate.resolve();
      await harness.cleanup();
    }
  });

  it("publishes a waiting tool as pending on coordinated reconnect and done after settlement", async () => {
    const harness = await coordinatedConnectionHarness();
    const waitStarted = deferred();
    const targetStarted = deferred();
    const releaseTarget = deferred();
    const reconnectEvents: ServerEvent[] = [];
    let reconnect: PiConnection | undefined;
    let prompt: Promise<void> | undefined;
    let targetPrompt: Promise<unknown> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const orchestrationRole = await harness.roles.createRole({
        name: "Orchestrator",
        description: "Runs the wait_for_session integration scenario",
        systemPrompt: "",
        model: { provider: "test", id: "model" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "full_access",
        canManageSessions: true,
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: orchestrationRole.id,
      });
      const sourceState = latestState(harness.events);
      const sourceSession = harness.runtime.created[0];
      if (!sourceSession) throw new Error("source session was not created");
      const sourceManager = sourceSession.persistentManager;
      if (!sourceManager) throw new Error("source SessionManager was not bound");
      const sourceTools = harness.runtime.lastCreateOptions?.workbenchCustomTools;
      const waitTool = sourceTools?.find(
        (tool) => tool.name === "wait_for_session",
      );
      if (!waitTool) throw new Error("wait_for_session tool was not registered");

      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const targetState = latestState(harness.events);
      const targetSession = harness.runtime.created[1];
      if (!targetSession) throw new Error("target session was not created");
      const targetManager = targetSession.persistentManager;
      if (!targetManager) throw new Error("target SessionManager was not bound");

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: sourceState.conversationId,
      });
      const focusedSource = latestState(harness.events);
      sourceSession.prompt = async () => {
        sourceManager.appendMessage(agentMessage({
          role: "user",
          content: "wait for the peer",
          timestamp: 1,
        }));
        sourceManager.appendMessage(agentMessage({
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "wait-tool",
            name: "wait_for_session",
            arguments: {
              targets: [{
                conversationId: targetState.conversationId,
                runId: RUN_B,
              }],
            },
          }],
          stopReason: "toolUse",
          timestamp: 2,
        }));
        sourceSession.eventListener?.(nativeEvent({ type: "agent_start" }));
        sourceSession.eventListener?.(nativeEvent({
          type: "tool_execution_start",
          toolCallId: "wait-tool",
          toolName: "wait_for_session",
          args: {
            targets: [{
              conversationId: targetState.conversationId,
              runId: RUN_B,
            }],
          },
        }));
        const execute = (waitTool as unknown as {
          execute(...args: unknown[]): Promise<unknown>;
        }).execute;
        const waiting = execute.call(
          waitTool,
          "wait-tool",
          {
            targets: [{
              conversationId: targetState.conversationId,
              runId: RUN_B,
            }],
          },
          undefined,
          undefined,
          {},
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        waitStarted.resolve();
        await waiting;
        sourceManager.appendMessage(agentMessage({
          role: "toolResult",
          toolCallId: "wait-tool",
          toolName: "wait_for_session",
          content: [{ type: "text", text: "peer completed" }],
          details: { outcome: "completed" },
          isError: false,
          timestamp: 3,
        }));
        sourceManager.appendMessage(agentMessage({
          role: "assistant",
          content: [{ type: "text", text: "The peer completed." }],
          stopReason: "stop",
          timestamp: 4,
        }));
        sourceSession.eventListener?.(nativeEvent({
          type: "tool_execution_end",
          toolCallId: "wait-tool",
          result: {
            content: [{ type: "text", text: "peer completed" }],
            details: { outcome: "completed" },
          },
          isError: false,
        }));
        sourceSession.eventListener?.(nativeEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "The peer completed." }],
          },
        }));
        sourceSession.eventListener?.(nativeEvent({ type: "agent_settled" }));
      };
      targetSession.prompt = async () => {
        targetStarted.resolve();
        targetSession.eventListener?.(nativeEvent({ type: "agent_start" }));
        await releaseTarget.promise;
        targetSession.eventListener?.(nativeEvent({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "peer completed" }],
          },
        }));
        targetSession.eventListener?.(nativeEvent({ type: "agent_settled" }));
      };
      const coordinatedView = (harness.connection as unknown as {
        coordinatedView: { handle: Parameters<ProjectSessionCoordinator["prompt"]>[0] };
      }).coordinatedView;
      targetPrompt = harness.coordinator.prompt(
        coordinatedView.handle,
        targetState.conversationId,
        RUN_B,
        "finish the peer run",
      );
      await targetStarted.promise;

      prompt = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focusedSource.conversationId,
        focusId: focusedSource.focusId,
        runId: RUN_A,
        text: "wait for the peer",
      });
      await waitStarted.promise;
      await expect.poll(() => latestState(harness.events)).toMatchObject({
        sessionId: SESSION_A,
        conversationId: focusedSource.conversationId,
        focusId: focusedSource.focusId,
        busy: true,
        activeRun: { id: RUN_A, phase: "waiting" },
      });

      // Reconnects replace observers, not the coordinator-owned writer. The
      // existing actor and conversation lease continue the active wait.
      await harness.connection.dispose();
      reconnect = new PiConnection(
        (event) => reconnectEvents.push(event),
        harness.runtime,
        async () => ({
          coordinator: harness.coordinator,
          roles: harness.roles,
        }),
      );
      await reconnect.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "open", conversationId: focusedSource.conversationId },
      });

      const waitingSnapshot = reconnectEvents.findLast(
        (event) => event.type === "conversation_snapshot",
      );
      expect(waitingSnapshot).toMatchObject({
        type: "conversation_snapshot",
        sessionId: SESSION_B,
        conversationId: focusedSource.conversationId,
        items: expect.arrayContaining([expect.objectContaining({
          kind: "message",
          role: "assistant",
          tools: [expect.objectContaining({
            toolCallId: "wait-tool",
            status: "pending",
          })],
        })]),
      });

      releaseTarget.resolve();
      await targetPrompt;
      await prompt;

      const finishedSnapshot = reconnectEvents.findLast(
        (event) => event.type === "conversation_snapshot",
      );
      expect(finishedSnapshot).toMatchObject({
        type: "conversation_snapshot",
        sessionId: SESSION_B,
        conversationId: focusedSource.conversationId,
        items: expect.arrayContaining([expect.objectContaining({
          kind: "message",
          role: "assistant",
          tools: [expect.objectContaining({
            toolCallId: "wait-tool",
            status: "done",
          })],
        })]),
      });
      expect(reconnectEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "session_event",
          sessionId: SESSION_B,
          conversationId: focusedSource.conversationId,
          runId: RUN_A,
          event: expect.objectContaining({
            type: "tool_finished",
            toolCallId: "wait-tool",
            isError: false,
          }),
        }),
      ]));
    } finally {
      releaseTarget.resolve();
      await targetPrompt?.catch(() => undefined);
      await prompt?.catch(() => undefined);
      await reconnect?.dispose();
      await harness.cleanup();
    }
  });
});

describe("PiConnection coordinated project view", () => {
  it("projects LoopList snapshots and focus-correlated low-frequency updates", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      });
      const focused = latestState(harness.events);
      expect(harness.events.findLast(
        (event) => event.type === "conversation_snapshot",
      )).toMatchObject({
        sessionId: SESSION_A,
        conversationId: focused.conversationId,
        focusId: focused.focusId,
        loopList: { items: [], armed: false },
      });

      const todoWrite = harness.runtime.lastCreateOptions?.workbenchCustomTools?.find(
        ({ name }) => name === "todo_write",
      );
      const todoPause = harness.runtime.lastCreateOptions?.workbenchCustomTools?.find(
        ({ name }) => name === "todo_pause",
      );
      expect(todoWrite).toBeDefined();
      expect(todoPause).toBeDefined();
      harness.runtime.created.at(-1)!.prompt = async () => {
        await todoWrite?.execute("write", {
          items: [{ id: "event", text: "Project this", status: "active" }],
        });
        await todoPause?.execute("pause", {});
      };

      await harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        runId: RUN_A,
        text: "write a list",
      });

      const updates = harness.events.filter(
        (event): event is Extract<ServerEvent, { type: "loop_list_update" }> =>
          event.type === "loop_list_update",
      );
      expect(updates).toHaveLength(2);
      for (const event of updates) {
        expect(event).toMatchObject({
          sessionId: SESSION_A,
          conversationId: focused.conversationId,
          focusId: focused.focusId,
        });
      }
      expect(updates.at(-1)).toMatchObject({
        loopList: {
          items: [{ id: "event", text: "Project this", status: "active" }],
          armed: false,
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it.each(["open", "recent"] as const)(
    "emits a cold %s preview before model catalog and AgentSession readiness",
    async (kind) => {
      const harness = await coordinatedConnectionHarness();
      const catalogStarted = deferred();
      const releaseCatalog = deferred();
      try {
        const conversationId = await createColdConversation(
          harness,
          `cold ${kind} history`,
        );
        const canPublish = vi.spyOn(
          harness.coordinator,
          "canPublishConversationPresentation",
        );
        let previewExistedAtCatalogStart = false;
        harness.runtime.beforeCreateProjectModelCatalog = async () => {
          previewExistedAtCatalogStart = harness.events.some(
            (event) => event.type === "conversation_preview",
          );
          catalogStarted.resolve();
          await releaseCatalog.promise;
        };
        const commandId = randomUUID();
        const initializing = harness.connection.handle({
          type: "initialize",
          commandId,
          sessionId: SESSION_A,
          cwd: harness.cwd,
          conversation: kind === "open"
            ? { kind: "open", conversationId }
            : { kind: "recent" },
        });

        await catalogStarted.promise;
        expect(previewExistedAtCatalogStart).toBe(true);
        expect(canPublish).toHaveBeenCalledWith(
          expect.anything(),
          conversationId,
        );
        expect(harness.runtime.createCalls).toEqual([]);
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "conversation_preview",
          sessionId: SESSION_A,
          commandId,
          conversationId,
          cwd: harness.cwd,
          toolMode: "read_only",
          role: expect.objectContaining({ id: "default" }),
          items: [expect.objectContaining({
            kind: "message",
            role: "user",
            text: `cold ${kind} history`,
          })],
        }));

        releaseCatalog.resolve();
        await initializing;
        const previewIndex = harness.events.findIndex(
          (event) => event.type === "conversation_preview"
            && event.commandId === commandId,
        );
        const attachedIndex = harness.events.findIndex(
          (event) => event.type === "focus_attached"
            && event.commandId === commandId,
        );
        const snapshotIndex = harness.events.findIndex(
          (event) => event.type === "conversation_snapshot"
            && event.conversationId === conversationId,
        );
        expect(previewIndex).toBeGreaterThanOrEqual(0);
        expect(attachedIndex).toBeGreaterThan(previewIndex);
        expect(snapshotIndex).toBeGreaterThan(attachedIndex);
      } finally {
        releaseCatalog.resolve();
        await harness.cleanup();
      }
    },
  );

  it("continues cold initialization when optional preview projection fails", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const conversationId = await createColdConversation(
        harness,
        "history remains authoritative",
      );
      const handle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const inspected = await handle.project.inspectConversationPresentation(
        conversationId,
      );
      const brokenEntry = new Proxy(inspected.entries[0]!, {
        get(target, property, receiver) {
          if (property === "type") throw new Error("preview projection failed");
          return Reflect.get(target, property, receiver);
        },
      });
      vi.spyOn(handle.project, "inspectConversationPresentation")
        .mockResolvedValueOnce({ ...inspected, entries: [brokenEntry] });
      handle.release();
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "initialize",
        commandId,
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "open", conversationId },
      });

      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "conversation_preview",
        commandId,
      }));
      expect(harness.runtime.projectCatalogCreations).toBe(1);
      expect(harness.runtime.createCalls).toEqual([harness.cwd]);
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "focus_attached",
        commandId,
        conversationId,
      }));
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "conversation_snapshot",
        conversationId,
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("suppresses a focus preview when an actor opening starts after preparation", async () => {
    const harness = await coordinatedConnectionHarness();
    let racingOpen: Promise<unknown> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const conversationId = await createColdConversation(
        harness,
        "racing actor history",
      );
      const prepare = harness.coordinator.prepareConversationPresentation
        .bind(harness.coordinator);
      vi.spyOn(harness.coordinator, "prepareConversationPresentation")
        .mockImplementationOnce(async (handle, id, signal) => {
          const presentation = await prepare(handle, id, signal);
          racingOpen = harness.coordinator.openConversation(handle, id, {
            updateRecent: false,
          });
          return presentation;
        });
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "focus_conversation",
        commandId,
        sessionId: SESSION_A,
        conversationId,
      });
      await racingOpen;

      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "conversation_preview",
        commandId,
      }));
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "focus_attached",
        commandId,
        conversationId,
      }));
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "conversation_snapshot",
        conversationId,
      }));
    } finally {
      await racingOpen?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("previews cold focus before extension attach and actor open, but skips warm disk preview", async () => {
    const harness = await coordinatedConnectionHarness();
    const actorCreateStarted = deferred();
    const releaseActorCreate = deferred();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const conversationId = await createColdConversation(
        harness,
        "cold focused history",
      );
      const attachExtensionUI = vi.spyOn(
        harness.coordinator,
        "attachExtensionUI",
      );
      const originalCreate = harness.runtime.create;
      harness.runtime.create = async (cwd) => {
        actorCreateStarted.resolve();
        await releaseActorCreate.promise;
        return originalCreate(cwd);
      };
      const commandId = randomUUID();
      const focusing = harness.connection.handle({
        type: "focus_conversation",
        commandId,
        sessionId: SESSION_A,
        conversationId,
      });

      await actorCreateStarted.promise;
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "conversation_preview",
        commandId,
        conversationId,
      }));
      expect(attachExtensionUI).toHaveBeenCalledTimes(1);
      releaseActorCreate.resolve();
      await focusing;

      const previewIndex = harness.events.findIndex(
        (event) => event.type === "conversation_preview"
          && event.commandId === commandId,
      );
      const attachedIndex = harness.events.findIndex(
        (event) => event.type === "focus_attached"
          && event.commandId === commandId,
      );
      const snapshotIndex = harness.events.findIndex(
        (event, index) => index > attachedIndex
          && event.type === "conversation_snapshot"
          && event.conversationId === conversationId,
      );
      expect(attachedIndex).toBeGreaterThan(previewIndex);
      expect(snapshotIndex).toBeGreaterThan(attachedIndex);

      const handle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const inspect = vi.spyOn(
        handle.project,
        "inspectConversationPresentation",
      );
      handle.release();
      harness.events.splice(0);
      const warmCommandId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: warmCommandId,
        sessionId: SESSION_A,
        conversationId,
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "conversation_preview",
        commandId: warmCommandId,
      }));
    } finally {
      releaseActorCreate.resolve();
      await harness.cleanup();
    }
  });

  it("lets a newer focus attach while a stale cold inspection continues", async () => {
    const harness = await coordinatedConnectionHarness();
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    const inspectionCompleted = deferred();
    let stale: Promise<void> | undefined;
    let current: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstId = await createColdConversation(harness, "first cold");
      const secondId = await createColdConversation(harness, "second cold");
      const handle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const inspectConversationPresentation = handle.project
        .inspectConversationPresentation.bind(handle.project);
      vi.spyOn(handle.project, "inspectConversationPresentation")
        .mockImplementation(async (conversationId) => {
          if (conversationId !== firstId) {
            return inspectConversationPresentation(conversationId);
          }
          inspectionStarted.resolve();
          await releaseInspection.promise;
          const result = await inspectConversationPresentation(conversationId);
          inspectionCompleted.resolve();
          return result;
        });
      handle.release();

      const staleCommandId = randomUUID();
      stale = harness.connection.handle({
        type: "focus_conversation",
        commandId: staleCommandId,
        sessionId: SESSION_A,
        conversationId: firstId,
      });
      await inspectionStarted.promise;
      const currentCommandId = randomUUID();
      current = harness.connection.handle({
        type: "focus_conversation",
        commandId: currentCommandId,
        sessionId: SESSION_A,
        conversationId: secondId,
      });

      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "focus_attached",
          commandId: currentCommandId,
          conversationId: secondId,
        }));
      });
      await Promise.all([stale, current]);
      releaseInspection.resolve();
      await inspectionCompleted.promise;

      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "conversation_preview",
        commandId: staleCommandId,
      }));
      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "focus_attached",
        commandId: staleCommandId,
      }));
      expect(latestState(harness.events).conversationId).toBe(secondId);
    } finally {
      releaseInspection.resolve();
      await Promise.allSettled([stale, current].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      ));
      await harness.cleanup();
    }
  });

  it("lets a warm focus attach while a stale actor activation continues", async () => {
    const harness = await coordinatedConnectionHarness();
    const activationStarted = deferred();
    const releaseActivation = deferred();
    const activationCompleted = deferred();
    let staleExtensionUI: NonNullable<
      CreatePiSessionOptions["extensionUI"]
    > | undefined;
    let stale: Promise<void> | undefined;
    let current: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const staleConversationId = await createColdConversation(
        harness,
        "stale activation",
      );
      const currentConversationId = await createColdConversation(
        harness,
        "warm target",
      );
      const handle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      await harness.coordinator.openConversation(
        handle,
        currentConversationId,
        { updateRecent: false },
      );
      handle.release();

      const activate = harness.runtime.activate;
      harness.runtime.activate = async (options) => {
        if (
          options.sessionManager?.getSessionId() !== staleConversationId
        ) {
          return activate(options);
        }
        if (!options.extensionUI) {
          throw new Error("stale actor extension UI was not bound");
        }
        staleExtensionUI = options.extensionUI;
        activationStarted.resolve();
        await releaseActivation.promise;
        activationCompleted.resolve();
      };

      const staleCommandId = randomUUID();
      stale = harness.connection.handle({
        type: "focus_conversation",
        commandId: staleCommandId,
        sessionId: SESSION_A,
        conversationId: staleConversationId,
      });
      await activationStarted.promise;
      const currentCommandId = randomUUID();
      current = harness.connection.handle({
        type: "focus_conversation",
        commandId: currentCommandId,
        sessionId: SESSION_A,
        conversationId: currentConversationId,
      });

      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "focus_attached",
          commandId: currentCommandId,
          conversationId: currentConversationId,
        }));
      });
      await Promise.all([stale, current]);
      const extensionUI = staleExtensionUI;
      if (!extensionUI) throw new Error("stale actor did not start activation");
      const requestCount = harness.events.filter(
        (event) => event.type === "extension_ui_request",
      ).length;
      const dialogAbort = new AbortController();
      const detachedDialog = extensionUI.confirm(
        "Detached stale focus",
        "This request must not reach the current browser route",
        { signal: dialogAbort.signal },
      );
      expect(harness.events.filter(
        (event) => event.type === "extension_ui_request",
      )).toHaveLength(requestCount);
      dialogAbort.abort();
      await expect(detachedDialog).resolves.toBe(false);

      releaseActivation.resolve();
      await activationCompleted.promise;
      const reopenedHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const reopened = await harness.coordinator.openConversation(
        reopenedHandle,
        staleConversationId,
        { updateRecent: false },
      );
      reopenedHandle.release();

      expect(reopened.conversationId).toBe(staleConversationId);
      expect(harness.runtime.createCalls).toHaveLength(2);
      expect(latestState(harness.events).conversationId).toBe(
        currentConversationId,
      );
      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "focus_attached",
        commandId: staleCommandId,
      }));
    } finally {
      releaseActivation.resolve();
      await Promise.allSettled([stale, current].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      ));
      await harness.cleanup();
    }
  });

  it("lets a newer initialize attach while a stale recent scan continues", async () => {
    const harness = await coordinatedConnectionHarness();
    const currentCwd = await realpath(
      await temporaryDirectory("piweb-current-initialize-scan-"),
    );
    const scanStarted = deferred();
    const releaseScan = deferred();
    const scanCompleted = deferred();
    const operations: Promise<void>[] = [];
    try {
      const currentConversationId = await createWarmConversation(
        harness,
        currentCwd,
        "current initialize after stale scan",
      );
      const staleHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const staleContext = projectReferenceState(staleHandle);
      const refreshConversations = staleHandle.project.refreshConversations
        .bind(staleHandle.project);
      vi.spyOn(staleHandle.project, "refreshConversations")
        .mockImplementationOnce(async () => {
          scanStarted.resolve();
          await releaseScan.promise;
          const result = await refreshConversations();
          scanCompleted.resolve();
          return result;
        });
      staleHandle.release();

      await replaceCoordinatedInitialization(
        harness,
        scanStarted.promise,
        { kind: "recent" },
        currentCwd,
        currentConversationId,
        operations,
      );
      expect(staleContext.listeners.size).toBe(0);

      releaseScan.resolve();
      await scanCompleted.promise;
    } finally {
      releaseScan.resolve();
      await Promise.allSettled(operations);
      await harness.cleanup();
    }
  });

  it("lets a newer initialize attach while a stale model catalog opens", async () => {
    const harness = await coordinatedConnectionHarness();
    const currentCwd = await realpath(
      await temporaryDirectory("piweb-current-initialize-catalog-"),
    );
    const catalogStarted = deferred();
    const releaseCatalog = deferred();
    const catalogCompleted = deferred();
    const operations: Promise<void>[] = [];
    try {
      const currentConversationId = await createWarmConversation(
        harness,
        currentCwd,
        "current initialize after stale catalog",
      );
      const staleHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const staleContext = projectReferenceState(staleHandle);
      staleHandle.release();
      harness.runtime.beforeCreateProjectModelCatalog = async () => {
        catalogStarted.resolve();
        await releaseCatalog.promise;
        catalogCompleted.resolve();
      };

      await replaceCoordinatedInitialization(
        harness,
        catalogStarted.promise,
        { kind: "recent" },
        currentCwd,
        currentConversationId,
        operations,
      );
      expect(staleContext.listeners.size).toBe(0);

      releaseCatalog.resolve();
      await catalogCompleted.promise;
      const reopened = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      await expect(
        harness.coordinator.ensureProjectModelCatalog(reopened),
      ).resolves.toBe(harness.runtime.modelRegistry);
      reopened.release();
      expect(harness.runtime.projectCatalogCreations).toBe(2);
    } finally {
      releaseCatalog.resolve();
      await Promise.allSettled(operations);
      await harness.cleanup();
    }
  });

  it("lets a newer initialize attach while a stale actor activation continues", async () => {
    const harness = await coordinatedConnectionHarness();
    const currentCwd = await realpath(
      await temporaryDirectory("piweb-current-initialize-actor-"),
    );
    const activationStarted = deferred();
    const releaseActivation = deferred();
    const activationCompleted = deferred();
    const operations: Promise<void>[] = [];
    let staleExtensionUI: NonNullable<
      CreatePiSessionOptions["extensionUI"]
    > | undefined;
    try {
      const currentConversationId = await createWarmConversation(
        harness,
        currentCwd,
        "current initialize after stale actor",
      );
      const staleConversationId = await createColdConversation(
        harness,
        "stale initialize actor",
      );
      const staleHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      await harness.coordinator.ensureProjectModelCatalog(staleHandle);
      const staleContext = projectReferenceState(staleHandle);
      staleHandle.release();

      const activate = harness.runtime.activate;
      harness.runtime.activate = async (options) => {
        if (options.sessionManager?.getSessionId() !== staleConversationId) {
          return activate(options);
        }
        if (!options.extensionUI) {
          throw new Error("stale initialize extension UI was not bound");
        }
        staleExtensionUI = options.extensionUI;
        activationStarted.resolve();
        await releaseActivation.promise;
        activationCompleted.resolve();
      };

      await replaceCoordinatedInitialization(
        harness,
        activationStarted.promise,
        { kind: "open", conversationId: staleConversationId },
        currentCwd,
        currentConversationId,
        operations,
      );
      expect(staleContext.listeners.size).toBe(0);

      const extensionUI = staleExtensionUI;
      if (!extensionUI) {
        throw new Error("stale initialize did not start actor activation");
      }
      const requestCount = harness.events.filter(
        (event) => event.type === "extension_ui_request",
      ).length;
      const dialogAbort = new AbortController();
      const detachedDialog = extensionUI.confirm(
        "Detached stale initialize",
        "This request must not reach the current browser route",
        { signal: dialogAbort.signal },
      );
      expect(harness.events.filter(
        (event) => event.type === "extension_ui_request",
      )).toHaveLength(requestCount);
      dialogAbort.abort();
      await expect(detachedDialog).resolves.toBe(false);

      releaseActivation.resolve();
      await activationCompleted.promise;
      const reopenedHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const reopened = await harness.coordinator.openConversation(
        reopenedHandle,
        staleConversationId,
        { updateRecent: false },
      );
      reopenedHandle.release();
      expect(reopened.conversationId).toBe(staleConversationId);
      expect(harness.runtime.createCalls).toHaveLength(2);
    } finally {
      releaseActivation.resolve();
      await Promise.allSettled(operations);
      await harness.cleanup();
    }
  });

  it("lets a newer initialize attach while a stale recent write continues", async () => {
    const harness = await coordinatedConnectionHarness();
    const currentCwd = await realpath(
      await temporaryDirectory("piweb-current-initialize-recent-write-"),
    );
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const writeCompleted = deferred();
    const operations: Promise<void>[] = [];
    try {
      const currentConversationId = await createWarmConversation(
        harness,
        currentCwd,
        "current initialize after stale recent write",
      );
      const staleConversationId = await createWarmConversation(
        harness,
        harness.cwd,
        "stale initialize resolved actor",
      );
      const staleHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const staleProject = staleHandle.project;
      const staleContext = projectReferenceState(staleHandle);
      staleContext.attention.add(staleConversationId);
      const setLastConversation = staleProject.setLastConversation
        .bind(staleProject);
      vi.spyOn(staleProject, "setLastConversation")
        .mockImplementationOnce(async (conversationId) => {
          writeStarted.resolve();
          await releaseWrite.promise;
          await setLastConversation(conversationId);
          writeCompleted.resolve();
        });
      staleHandle.release();

      await replaceCoordinatedInitialization(
        harness,
        writeStarted.promise,
        { kind: "open", conversationId: staleConversationId },
        currentCwd,
        currentConversationId,
        operations,
      );
      expect(staleContext.listeners.size).toBe(0);
      expect(staleContext.attention.has(staleConversationId)).toBe(true);

      releaseWrite.resolve();
      await writeCompleted.promise;
      expect(staleProject.lastConversationId).toBe(staleConversationId);
      expect(staleContext.attention.has(staleConversationId)).toBe(true);
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled(operations);
      await harness.cleanup();
    }
  });

  it("acknowledges and deduplicates a coordinated model refresh", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });

      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      });
      await expect(harness.connection.handle({
        type: "refresh_models",
        commandId: COMMAND_A,
        sessionId: SESSION_A,
      })).rejects.toThrow("already used");
    } finally {
      await harness.cleanup();
    }
  });

  it("stops projecting a fixed role model after the session runtime unsets it", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      });
      expect(latestState(harness.events).selectedModel).toEqual({
        provider: "test",
        id: "model",
      });

      const actor = (harness.connection as unknown as {
        coordinatedView?: { actor?: { session: AgentSession } };
      }).coordinatedView?.actor;
      if (!actor) throw new Error("coordinated actor was not attached");
      Object.assign(actor.session, { model: undefined });
      await harness.runtime.refreshConfiguration();

      expect(latestState(harness.events).selectedModel).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("attaches focus before the first project refresh and does not await recent manifest writes", async () => {
    const harness = await coordinatedConnectionHarness();
    const recentWriteGate = deferred();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const first = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === firstCommandId,
      );
      if (first?.type !== "focus_attached" || !first.conversationId) {
        throw new Error("first conversation was not focused");
      }
      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const second = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === secondCommandId,
      );
      if (second?.type !== "focus_attached" || !second.conversationId) {
        throw new Error("second conversation was not focused");
      }
      const projectHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const project = projectHandle.project;
      projectHandle.release();
      const persistRecent = project.setLastConversation.bind(project);
      vi.spyOn(project, "setLastConversation").mockImplementation(async (conversationId) => {
        if (conversationId === first.conversationId) {
          await recentWriteGate.promise;
        }
        await persistRecent(conversationId);
      });
      const start = harness.events.length;
      let firstListSessionsSawConversationSnapshot: boolean | undefined;
      let listSessionsCalls = 0;
      const listSessions = harness.coordinator.listSessions.bind(
        harness.coordinator,
      );
      vi.spyOn(harness.coordinator, "listSessions").mockImplementation(async (handle) => {
        if (listSessionsCalls++ === 0) {
          firstListSessionsSawConversationSnapshot = harness.events.some(
            (event) => event.type === "conversation_snapshot"
              && event.conversationId === first.conversationId,
          );
        }
        return listSessions(handle);
      });
      const focus = harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      await focus;
      const attachedIndex = harness.events.findIndex(
        (event, index) => index >= start && event.type === "focus_attached",
      );
      const stateIndex = harness.events.findIndex(
        (event, index) => index >= start && event.type === "state",
      );
      const conversationIndex = harness.events.findIndex(
        (event, index) => index >= start
          && event.type === "conversation_snapshot"
          && event.conversationId === first.conversationId,
      );
      expect(attachedIndex).toBeGreaterThanOrEqual(start);
      expect(stateIndex).toBeGreaterThan(attachedIndex);
      expect(conversationIndex).toBeGreaterThan(stateIndex);
      await vi.waitFor(() => {
        expect(firstListSessionsSawConversationSnapshot).toBe(true);
      });
      await vi.waitFor(() => {
        expect(harness.events.some(
          (event, index) => index >= start && event.type === "project_snapshot",
        )).toBe(true);
      });
      const projectIndex = harness.events.findIndex(
        (event, index) => index >= start && event.type === "project_snapshot",
      );
      expect(projectIndex).toBeGreaterThan(conversationIndex);
      recentWriteGate.resolve();
    } finally {
      recentWriteGate.resolve();
      await harness.cleanup();
    }
  });

  it("warns only the current focus when a background recent manifest write fails", async () => {
    const harness = await coordinatedConnectionHarness();
    const recentWriteGate = deferred();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const first = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === firstCommandId,
      );
      if (first?.type !== "focus_attached" || !first.conversationId) {
        throw new Error("first conversation was not focused");
      }
      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const second = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === secondCommandId,
      );
      if (second?.type !== "focus_attached" || !second.conversationId) {
        throw new Error("second conversation was not focused");
      }
      const projectHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const project = projectHandle.project;
      projectHandle.release();
      const persistRecent = project.setLastConversation.bind(project);
      let firstWrite = true;
      const setLastConversation = vi.spyOn(project, "setLastConversation")
        .mockImplementation(async (conversationId) => {
          const write = persistRecent(conversationId);
          if (conversationId === first.conversationId && firstWrite) {
            firstWrite = false;
            await recentWriteGate.promise;
            throw new Error("recent manifest write failed");
          }
          await write;
        });
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const oldFocusId = latestState(harness.events).focusId;
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: second.conversationId,
      });
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const newFocusId = latestState(harness.events).focusId;
      expect(newFocusId).not.toBe(oldFocusId);
      recentWriteGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.events.filter(
        (event) => event.type === "error"
          && event.scope === "session"
          && event.message.includes("recent manifest write failed"),
      )).toHaveLength(0);

      setLastConversation.mockImplementation(async (conversationId) => {
        if (conversationId === first.conversationId) {
          throw new Error("current recent manifest write failed");
        }
        await persistRecent(conversationId);
      });
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: second.conversationId,
      });
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual({
          type: "error",
          scope: "session",
          sessionId: SESSION_A,
          message: "会话已切换，但最近会话位置未保存：current recent manifest write failed",
        });
      });
    } finally {
      recentWriteGate.resolve();
      await harness.cleanup();
    }
  });

  it("uses the validated recent seed for one initial project snapshot", async () => {
    const harness = await coordinatedConnectionHarness();
    const warmHandle = await harness.coordinator.acquireProject(
      harness.cwd,
      "read_only",
    );
    await Promise.allSettled([...warmHandle.context.backgroundTasks]);
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      });
      await vi.waitFor(() => {
        expect(harness.events.some((event) => event.type === "project_snapshot"))
          .toBe(true);
      });

      const listSessions = vi.spyOn(harness.coordinator, "listSessions");
      harness.events.splice(0);
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });

      expect(listSessions).toHaveBeenCalledTimes(1);
      const snapshots = harness.events.filter(
        (event): event is Extract<ServerEvent, { type: "project_snapshot" }> =>
          event.type === "project_snapshot",
      );
      expect(snapshots).toHaveLength(1);
      const conversation = snapshots[0]!.conversations.find(
        ({ id }) => id === snapshots[0]!.conversationId,
      );
      expect(conversation).toMatchObject({
        role: expect.objectContaining({ id: "default" }),
        activity: { kind: "idle" },
        createdBy: { kind: "user" },
        attention: false,
      });
    } finally {
      warmHandle.release();
      await harness.cleanup();
    }
  });

  it("refreshes a recent seed after an actor mutation at the scan handoff", async () => {
    const harness = await coordinatedConnectionHarness();
    const warmHandle = await harness.coordinator.acquireProject(
      harness.cwd,
      "read_only",
    );
    const seedMutated = deferred();
    const refreshGate = deferred();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      });
      await vi.waitFor(() => {
        expect(harness.events.some((event) => event.type === "project_snapshot"))
          .toBe(true);
      });
      const conversationId = latestState(harness.events).conversationId;
      if (!conversationId) throw new Error("conversation was not created");
      const manager = harness.runtime.created[0]?.persistentManager;
      if (!manager) throw new Error("persistent SessionManager was not provided");

      const listSessionsImplementation = harness.coordinator.listSessions.bind(
        harness.coordinator,
      );
      const listSessions = vi.spyOn(harness.coordinator, "listSessions");
      listSessions.mockImplementation(async (handle) => {
        if (listSessions.mock.calls.length === 2) await refreshGate.promise;
        const sessions = await listSessionsImplementation(handle);
        if (listSessions.mock.calls.length === 1) {
          manager.appendMessage(agentMessage({
            role: "user",
            content: "fresh preview",
            timestamp: 1,
          }));
          (harness.coordinator as unknown as {
            emit(context: unknown, event: unknown): void;
          }).emit(handle.context, {
            type: "context_usage",
            conversationId,
          });
          seedMutated.resolve();
        }
        return sessions;
      });

      harness.events.splice(0);
      const initialization = harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await seedMutated.promise;
      expect(listSessions).toHaveBeenCalledTimes(1);
      await initialization;
      expect(listSessions).toHaveBeenCalledTimes(2);
      refreshGate.resolve();

      await vi.waitFor(() => {
        const snapshots = harness.events.filter(
          (event): event is Extract<ServerEvent, { type: "project_snapshot" }> =>
            event.type === "project_snapshot",
        );
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]!.conversations).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: conversationId,
            preview: "fresh preview",
            messageCount: 1,
          }),
        ]));
      });
    } finally {
      refreshGate.resolve();
      warmHandle.release();
      await harness.cleanup();
    }
  });

  it("acknowledges guidance only after the exact active run accepts it", async () => {
    const harness = await coordinatedConnectionHarness();
    const promptStarted = deferred();
    const promptGate = deferred();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      const session = harness.runtime.created[0]!;
      session.prompt = async () => {
        session.isStreaming = true;
        session.eventListener?.(nativeEvent({ type: "agent_start" }));
        session.eventListener?.(nativeEvent({
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text: "initial" }],
          },
        }));
        promptStarted.resolve();
        await promptGate.promise;
        session.isStreaming = false;
      };
      const running = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        runId: RUN_A,
        text: "initial",
      });
      await promptStarted.promise;
      const initialUserMessage = {
        role: "user",
        content: [{ type: "text", text: "initial" }],
      } as AgentMessage;
      session.persistentManager?.appendMessage(initialUserMessage);
      session.eventListener?.(nativeEvent({
        type: "message_end",
        message: initialUserMessage,
      }));
      await Promise.resolve();
      const commandId = randomUUID();

      const guiding = harness.connection.handle({
        type: "steer",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        runId: RUN_A,
        text: "change direction",
      });

      await vi.waitFor(() => {
        expect(session.steerCalls).toEqual(["change direction"]);
      });
      expect(harness.events).not.toContainEqual(
        expect.objectContaining({
          type: "command_complete",
          operation: "steer",
          commandId,
        }),
      );
      const steeredUserMessage = session.steeringAgentMessages.shift()!;
      session.persistentManager?.appendMessage(steeredUserMessage);
      session.eventListener?.(nativeEvent({
        type: "message_end",
        message: steeredUserMessage,
      }));
      await guiding;
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "steer",
        commandId,
        sessionId: SESSION_A,
      });

      promptGate.resolve();
      await running;
    } finally {
      promptGate.resolve();
      await harness.cleanup();
    }
  });









  it("persists and acknowledges the focused conversation compaction threshold", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      expect(focused.compactionThresholdPercent).toBe(70);
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "set_compaction_threshold",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        percent: 55,
      });

      expect(latestState(harness.events).compactionThresholdPercent).toBe(55);
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "set_compaction_threshold",
        commandId,
        sessionId: SESSION_A,
      });
      expect(aggregateReservedConversationEntries(
        harness.runtime.created[0]!.persistentManager!.getEntries(),
      ).compactionThreshold?.percent).toBe(55);
    } finally {
      await harness.cleanup();
    }
  });

  it("persists and acknowledges the focused conversation service tier", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      expect(focused.selectedServiceTier).toBeNull();
      Object.assign(harness.runtime.created[0]!.model!, {
        api: "openai-codex-responses",
      });
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "set_service_tier",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        serviceTier: "priority",
      });

      expect(latestState(harness.events).selectedServiceTier).toBe("priority");
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "set_service_tier",
        commandId,
        sessionId: SESSION_A,
      });
      expect(aggregateReservedConversationEntries(
        harness.runtime.created[0]!.persistentManager!.getEntries(),
      ).serviceTier?.tier).toBe("priority");
    } finally {
      await harness.cleanup();
    }
  });

  it("publishes recalculated context usage during an active run", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      const session = harness.runtime.created[0]!;
      session.getSessionStats = () => ({
        tokens: {
          input: 600,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          total: 640,
        },
        contextUsage: {
          tokens: 640,
          contextWindow: 1_000,
          percent: 64,
        },
      });
      session.prompt = async () => {
        expect(harness.runtime.lastCreateOptions?.turnBoundaryCheck?.({
          contextUsage: {
            tokens: 640,
            contextWindow: 1_000,
            percent: 64,
          },
          hasToolResults: false,
        })).toBe(false);
      };

      await harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        runId: RUN_A,
        text: "refresh context usage",
      });

      expect(harness.events).toContainEqual({
        type: "state",
        state: expect.objectContaining({
          busy: true,
          contextUsage: {
            tokens: 640,
            contextWindow: 1_000,
            percent: 64,
            source: "measured",
          },
        }),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("manually compacts the exact focused conversation and acknowledges it", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "compact_context",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
      });

      expect(harness.runtime.created[0]!.compactCalls).toBe(1);
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "compact_context",
        commandId,
        sessionId: SESSION_A,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("switches focus without waiting for another conversation to compact", async () => {
    const harness = await coordinatedConnectionHarness();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    let compacting: Promise<void> | undefined;
    let focusing: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "first",
      });
      const first = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === firstCommandId,
      );
      if (
        first?.type !== "focus_attached"
        || !first.conversationId
        || !first.focusId
      ) throw new Error("first conversation was not focused");

      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "second",
      });
      const second = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === secondCommandId,
      );
      if (second?.type !== "focus_attached" || !second.conversationId) {
        throw new Error("second conversation was not focused");
      }

      const refocusFirstId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: refocusFirstId,
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const refocusedFirst = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === refocusFirstId,
      );
      if (
        refocusedFirst?.type !== "focus_attached"
        || !refocusedFirst.focusId
      ) throw new Error("first conversation was not refocused");

      const firstSession = harness.runtime.created[0]!;
      firstSession.compact = async () => {
        firstSession.compactCalls++;
        compactionStarted.resolve();
        await finishCompaction.promise;
        return {};
      };
      const compactCommandId = randomUUID();
      compacting = harness.connection.handle({
        type: "compact_context",
        commandId: compactCommandId,
        sessionId: SESSION_A,
        conversationId: first.conversationId,
        focusId: refocusedFirst.focusId,
      });
      await compactionStarted.promise;
      expect(harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      )).toMatchObject({
        type: "project_activity_snapshot",
        projects: [expect.objectContaining({
          cwd: harness.cwd,
          busyConversationCount: 1,
        })],
      });

      const focusSecondId = randomUUID();
      focusing = harness.connection.handle({
        type: "focus_conversation",
        commandId: focusSecondId,
        sessionId: SESSION_A,
        conversationId: second.conversationId,
      });
      const focusedPromptly = await Promise.race([
        focusing.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 500);
        }),
      ]);
      expect(focusedPromptly).toBe(true);
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "focus_attached",
        commandId: focusSecondId,
        conversationId: second.conversationId,
      }));

      await expect(harness.connection.handle({
        type: "delete_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      })).rejects.toThrow("compacting");
      expect(firstSession.disposed).toBe(false);

      const refocusFirstAgainId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: refocusFirstAgainId,
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const refocusedFirstAgain = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === refocusFirstAgainId,
      );
      if (
        refocusedFirstAgain?.type !== "focus_attached"
        || !refocusedFirstAgain.focusId
      ) throw new Error("first conversation was not focused again");
      const snapshotsBeforeCompletion = harness.events.filter(
        (event) => event.type === "conversation_snapshot",
      ).length;

      finishCompaction.resolve();
      await compacting;
      expect(harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      )).toMatchObject({
        type: "project_activity_snapshot",
        projects: [expect.objectContaining({
          cwd: harness.cwd,
          busyConversationCount: 0,
        })],
      });
      expect(harness.events.filter(
        (event) => event.type === "conversation_snapshot",
      ).length).toBeGreaterThan(snapshotsBeforeCompletion);
      expect(harness.events.findLast(
        (event) => event.type === "conversation_snapshot",
      )).toMatchObject({
        type: "conversation_snapshot",
        conversationId: first.conversationId,
        focusId: refocusedFirstAgain.focusId,
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "compact_context",
        commandId: compactCommandId,
        sessionId: SESSION_A,
      });
    } finally {
      finishCompaction.resolve();
      await compacting?.catch(() => undefined);
      await focusing?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("switches the exact focused conversation role before acknowledging it", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const role = await harness.roles.createRole({
        name: "Reviewer",
        description: "Reviews the current conversation",
        systemPrompt: "Review carefully.",
        model: { provider: "test", id: "model" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "full_access",
        canManageSessions: false,
      });
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      const commandId = randomUUID();

      await harness.connection.handle({
        type: "switch_conversation_role",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        roleId: role.id,
      });

      expect(latestState(harness.events).toolMode).toBe("full_access");
      expect(harness.events.findLast(
        (event) => event.type === "conversation_snapshot",
      )).toMatchObject({
        type: "conversation_snapshot",
        role: {
          id: role.id,
          revision: role.revision,
          name: "Reviewer",
        },
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "switch_conversation_role",
        commandId,
        sessionId: SESSION_A,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("switches projects without waiting for a conversation role rebuild", async () => {
    const harness = await coordinatedConnectionHarness();
    const cwdB = await realpath(
      await temporaryDirectory("piweb-role-switch-second-"),
    );
    const activationStarted = deferred();
    const finishActivation = deferred();
    let switching: Promise<void> | undefined;
    try {
      const role = await harness.roles.createRole({
        name: "Background reviewer",
        description: "Rebuild this conversation in the background",
        systemPrompt: "Review carefully.",
        model: { provider: "test", id: "model" },
        compactionModel: null,
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "full_access",
        canManageSessions: false,
      });
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      harness.runtime.activate = async () => {
        activationStarted.resolve();
        await finishActivation.promise;
      };

      switching = harness.connection.handle({
        type: "switch_conversation_role",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        roleId: role.id,
      });
      await activationStarted.promise;

      const projectSwitch = harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: cwdB,
        conversation: { kind: "recent" },
      });
      const switchedPromptly = await Promise.race([
        projectSwitch.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 500);
        }),
      ]);
      expect(switchedPromptly).toBe(true);

      finishActivation.resolve();
      await switching;
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_C,
        cwd: harness.cwd,
        conversation: {
          kind: "open",
          conversationId: focused.conversationId!,
        },
      });
      expect(harness.events.findLast(
        (event) => event.type === "conversation_snapshot",
      )).toMatchObject({
        type: "conversation_snapshot",
        sessionId: SESSION_C,
        conversationId: focused.conversationId,
        role: { id: role.id },
      });
    } finally {
      finishActivation.resolve();
      await switching?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("keeps the focused view quiet while rewind replaces its runtime, then publishes the durable result", async () => {
    const harness = await coordinatedConnectionHarness();
    const replacementStarted = deferred();
    const finishReplacement = deferred();
    let rewinding: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focused = latestState(harness.events);
      const manager = harness.runtime.created[0]!.persistentManager!;
      const loopListId = appendReservedCustomEntry(
        manager,
        createLoopListEntry({
          items: [{ id: "retained", text: "Retained work", status: "active" }],
          armed: true,
          updatedAt: "2026-07-19T10:00:00.000Z",
        }),
      );
      const retainedId = manager.appendMessage({
        role: "user",
        content: "retained",
        timestamp: 1,
      });
      const selectedId = manager.appendMessage({
        role: "user",
        content: "selected",
        timestamp: 2,
      });
      manager.appendMessage({
        role: "user",
        content: "later",
        timestamp: 3,
      });

      const create = harness.runtime.create;
      harness.runtime.create = async (cwd) => {
        replacementStarted.resolve();
        await finishReplacement.promise;
        return create(cwd);
      };
      const commandId = randomUUID();
      const eventStart = harness.events.length;
      const exactRefresh = {
        type: "refresh_view" as const,
        sessionId: SESSION_A,
        projectId: focused.projectId,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
      };

      rewinding = harness.connection.handle({
        type: "truncate_conversation",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        messageId: selectedId,
      });
      await replacementStarted.promise;

      await expect(harness.connection.handle(exactRefresh)).resolves
        .toBeUndefined();
      await expect(harness.runtime.updateConfiguration(() => undefined))
        .resolves.toBeUndefined();
      await Promise.resolve();

      const gapEvents = harness.events.slice(eventStart);
      expect(gapEvents).toContainEqual({
        type: "loop_list_update",
        sessionId: SESSION_A,
        conversationId: focused.conversationId,
        focusId: focused.focusId,
        loopList: {
          items: [{ id: "retained", text: "Retained work", status: "active" }],
          armed: true,
        },
      });
      expect(gapEvents.some((event) =>
        event.type === "state"
        || event.type === "role_catalog_snapshot"
        || event.type === "conversation_snapshot"
        || event.type === "command_complete"
        || event.type === "error"
      )).toBe(false);

      finishReplacement.resolve();
      await rewinding;
      rewinding = undefined;

      const commandEvents = harness.events.slice(eventStart);
      const snapshotIndex = commandEvents.findIndex(
        (event) => event.type === "conversation_snapshot",
      );
      const completionIndex = commandEvents.findIndex(
        (event) => event.type === "command_complete",
      );
      expect(snapshotIndex).toBeGreaterThanOrEqual(0);
      expect(completionIndex).toBeGreaterThan(snapshotIndex);
      expect(commandEvents[snapshotIndex]).toMatchObject({
        type: "conversation_snapshot",
        items: [
          expect.objectContaining({
            kind: "message",
            id: retainedId,
            role: "user",
            text: "retained",
          }),
        ],
      });
      expect(commandEvents[completionIndex]).toEqual({
        type: "command_complete",
        operation: "truncate_conversation",
        commandId,
        sessionId: SESSION_A,
      });
      expect(manager.getEntries().map(({ id }) => id)).toEqual([
        expect.any(String),
        loopListId,
        retainedId,
      ]);
    } finally {
      finishReplacement.resolve();
      await rewinding?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("projects unknown catalog coverage and the rewound snapshot after a committed catalog failure", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const focused = await initializeNewConversation(harness);
      const manager = harness.runtime.created[0]?.persistentManager;
      if (!manager) throw new Error("persistent SessionManager was not provided");
      const retainedId = manager.appendMessage({
        role: "user",
        content: "retained",
        timestamp: 1,
      });
      const selectedId = manager.appendMessage({
        role: "user",
        content: "rewind from here",
        timestamp: 2,
      });
      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: focused.projectId,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
      });
      await vi.waitFor(() => {
        expect(harness.events.findLast(
          (event) => event.type === "project_snapshot",
        )).toMatchObject({ coverage: "complete" });
      });
      const handle = await harness.coordinator.acquireProject(
        harness.cwd,
        "read_only",
      );
      const projectInternals = handle.project as unknown as {
        scanConversations(): Promise<unknown>;
      };
      vi.spyOn(projectInternals, "scanConversations").mockRejectedValueOnce(
        new Error("catalog refresh failed"),
      );
      handle.release();

      const eventStart = harness.events.length;
      const commandId = randomUUID();
      await harness.connection.handle({
        type: "truncate_conversation",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        messageId: selectedId,
      });

      const commandEvents = harness.events.slice(eventStart);
      const unknownIndex = commandEvents.findIndex(
        (event) => event.type === "project_snapshot"
          && event.coverage === "unknown",
      );
      const snapshotIndex = commandEvents.findIndex(
        (event) => event.type === "conversation_snapshot"
          && event.conversationId === focused.conversationId,
      );
      expect(unknownIndex).toBeGreaterThanOrEqual(0);
      expect(snapshotIndex).toBeGreaterThan(unknownIndex);
      expect(commandEvents[snapshotIndex]).toMatchObject({
        type: "conversation_snapshot",
        conversationId: focused.conversationId,
        items: expect.arrayContaining([
          expect.objectContaining({ id: retainedId, text: "retained" }),
        ]),
      });
      expect((commandEvents[snapshotIndex] as Extract<
        ServerEvent,
        { type: "conversation_snapshot" }
      >).items.some(({ id }) => id === selectedId)).toBe(false);
      const commandCompleteIndex = commandEvents.findIndex(
        (event) => event.type === "command_complete"
          && event.operation === "truncate_conversation"
          && event.commandId === commandId,
      );
      expect(commandCompleteIndex).toBeGreaterThan(snapshotIndex);
      expect(commandEvents[commandCompleteIndex]).toEqual({
        type: "command_complete",
        operation: "truncate_conversation",
        commandId,
        sessionId: SESSION_A,
      });
      await vi.waitFor(() => {
        expect(harness.events.slice(eventStart).some(
          (event) => event.type === "project_snapshot"
            && event.coverage === "complete",
        )).toBe(true);
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("suppresses a committed catalog-failure rewind after reinitialize supersedes its view", async () => {
    const harness = await coordinatedConnectionHarness();
    const releaseRecovery: Array<() => void> = [];
    let rewinding: Promise<void> | undefined;
    let reinitializing: Promise<void> | undefined;
    try {
      const focused = await initializeNewConversation(harness);
      const paused = await pauseCommittedCatalogFailure(harness, focused);
      releaseRecovery.push(paused.releaseRecovery);
      const eventStart = harness.events.length;
      const commandId = randomUUID();
      rewinding = harness.connection.handle({
        type: "truncate_conversation",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        messageId: paused.selectedId,
      });
      await paused.recoveryStarted;

      reinitializing = harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: {
          kind: "open",
          conversationId: focused.conversationId!,
        },
      });
      paused.releaseRecovery();
      await Promise.all([rewinding, reinitializing]);
      rewinding = undefined;
      reinitializing = undefined;

      const supersededEvents = harness.events.slice(eventStart).filter(
        (event) => "sessionId" in event && event.sessionId === SESSION_A,
      );
      expect(supersededEvents).toEqual([]);
      const currentSnapshot = harness.events.findLast((event) =>
        event.type === "conversation_snapshot" && event.sessionId === SESSION_B
      );
      expect(currentSnapshot).toMatchObject({
        type: "conversation_snapshot",
        conversationId: focused.conversationId,
        items: expect.arrayContaining([
          expect.objectContaining({ id: paused.retainedId, text: "retained" }),
        ]),
      });
      expect((currentSnapshot as Extract<
        ServerEvent,
        { type: "conversation_snapshot" }
      >).items.some(({ id }) => id === paused.selectedId)).toBe(false);
    } finally {
      for (const release of releaseRecovery) release();
      await rewinding?.catch(() => undefined);
      await reinitializing?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("suppresses a committed catalog-failure rewind after close supersedes its view", async () => {
    const harness = await coordinatedConnectionHarness();
    const releaseRecovery: Array<() => void> = [];
    let rewinding: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const focused = await initializeNewConversation(harness);
      const paused = await pauseCommittedCatalogFailure(harness, focused);
      releaseRecovery.push(paused.releaseRecovery);
      const eventStart = harness.events.length;
      rewinding = harness.connection.handle({
        type: "truncate_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        messageId: paused.selectedId,
      });
      await paused.recoveryStarted;

      closing = harness.connection.handle({
        type: "close_session",
        sessionId: SESSION_A,
      });
      paused.releaseRecovery();
      await Promise.all([rewinding, closing]);
      rewinding = undefined;
      closing = undefined;

      expect(harness.events.slice(eventStart).filter(
        (event) => "sessionId" in event && event.sessionId === SESSION_A,
      )).toEqual([]);
      const handle = await harness.coordinator.acquireProject(harness.cwd, "read_only");
      try {
        const manager = await handle.project.openConversation(
          focused.conversationId!,
          { updateRecent: false },
        );
        expect(manager.getEntries().some(({ id }) => id === paused.selectedId))
          .toBe(false);
        expect(manager.getEntries().some(({ id }) => id === paused.retainedId))
          .toBe(true);
      } finally {
        handle.release();
      }
    } finally {
      for (const release of releaseRecovery) release();
      await rewinding?.catch(() => undefined);
      await closing?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("opens an empty project without implicitly creating a conversation", async () => {
    const harness = await coordinatedConnectionHarness();
    const commandId = randomUUID();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId,
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "project_snapshot",
          sessionId: SESSION_A,
          conversations: [],
        }));
      });

      expect(harness.runtime.createCalls).toEqual([]);
      const state = latestState(harness.events);
      expect(state).toMatchObject({
        sessionId: SESSION_A,
        busy: false,
      });
      expect(state).not.toHaveProperty("conversationId");
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "focus_attached",
        operation: "initialize",
        commandId,
        sessionId: SESSION_A,
        projectId: latestState(harness.events).projectId,
        transitionDiagnostics: expect.objectContaining({
          commandId,
          operation: "initialize",
          snapshotProjectionMs: null,
        }),
      }));
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "role_catalog_snapshot",
        sessionId: SESSION_A,
        roles: [
          expect.objectContaining({
            id: "default",
            available: true,
          }),
        ],
      }));
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the project model catalog before the first conversation exists", async () => {
    const harness = await coordinatedConnectionHarness();
    const baselineModel = harness.runtime.modelRegistry.getAvailable()[0]!;
    const projectModel = {
      provider: "project-only",
      id: "project-model",
      name: "Project-only model",
      reasoning: false,
      input: ["text"],
      contextWindow: 1_000,
    };
    const projectModels = [baselineModel, projectModel];
    harness.runtime.projectModelRegistry = {
      getAll: () => projectModels,
      getRegisteredProviderIds: () => [],
      getAvailable: () => projectModels,
      getError: () => undefined,
      getProviderDisplayName: (provider: string) => provider,
      getProviderAuthStatus: () => ({ configured: true }),
      hasConfiguredAuth: () => true,
    } as unknown as ModelRegistry;
    harness.runtime.sessionModelRegistry = harness.runtime.projectModelRegistry;

    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });

      expect(harness.runtime.created).toHaveLength(0);
      expect(latestState(harness.events).providers).toContainEqual(
        expect.objectContaining({
          id: projectModel.provider,
          models: expect.arrayContaining([
            expect.objectContaining({ id: projectModel.id, available: true }),
          ]),
        }),
      );

      const createRoleCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_role",
        commandId: createRoleCommandId,
        sessionId: SESSION_A,
        role: {
          name: "Empty-project specialist",
          description: "Available before any conversation is opened",
          systemPrompt: "Use the project-only model.",
          model: {
            provider: projectModel.provider,
            id: projectModel.id,
          },
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "read_only",
          canManageSessions: false,
        },
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "create_role",
        commandId: createRoleCommandId,
        sessionId: SESSION_A,
      });
      const roleSnapshot = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      if (roleSnapshot?.type !== "role_catalog_snapshot") {
        throw new Error("project role catalog was not published");
      }
      const projectRole = roleSnapshot.roles.find(
        ({ name }) => name === "Empty-project specialist",
      );
      expect(projectRole).toMatchObject({
        available: true,
        model: {
          provider: projectModel.provider,
          id: projectModel.id,
        },
      });

      const keyCommandId = randomUUID();
      await harness.connection.handle({
        type: "set_api_key",
        commandId: keyCommandId,
        sessionId: SESSION_A,
        provider: projectModel.provider,
        key: "project-secret",
      });
      await expect(harness.runtime.credentialStore.read(projectModel.provider)).resolves.toEqual({
        type: "api_key",
        key: "project-secret",
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "set_api_key",
        commandId: keyCommandId,
        sessionId: SESSION_A,
      });

      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: projectRole!.id,
      });
      expect(harness.runtime.lastCreateOptions).toMatchObject({
        model: {
          provider: projectModel.provider,
          id: projectModel.id,
        },
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("invalidates the exact browser focus when another Agent deletes it", async () => {
    const harness = await coordinatedConnectionHarness();
    let externalHandle:
      Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>
      | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const attached = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === createCommandId,
      );
      if (
        attached?.type !== "focus_attached"
        || attached.conversationId === undefined
        || attached.focusId === undefined
      ) {
        throw new Error("conversation focus was not attached");
      }

      externalHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "full_access",
      );
      await expect(harness.coordinator.deleteConversation(
        externalHandle,
        attached.conversationId,
      )).resolves.toBe(true);

      expect(harness.events.filter(
        (event) => event.type === "focus_invalidated",
      )).toEqual([{
        type: "focus_invalidated",
        sessionId: SESSION_A,
        projectId: latestState(harness.events).projectId,
        conversationId: attached.conversationId,
        focusId: attached.focusId,
        reason: "deleted",
      }]);
      expect(latestState(harness.events)).not.toHaveProperty(
        "conversationId",
      );
    } finally {
      externalHandle?.release();
      await harness.cleanup();
    }
  });

  it("publishes a prioritized project index within its count and frame budgets", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const attached = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === createCommandId,
      );
      if (
        attached?.type !== "focus_attached"
        || attached.conversationId === undefined
      ) {
        throw new Error("conversation focus was not attached");
      }
      const summaries: ConversationSummary[] = Array.from(
        { length: MAX_PROJECT_CONVERSATIONS + 40 },
        (_, index) => ({
          id: `00000000-0000-4000-8000-${
            index.toString(16).padStart(12, "0")
          }`,
          name: "n".repeat(500),
          preview: "p".repeat(20_000),
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: new Date(
            Date.UTC(2026, 6, 18, 12, index),
          ).toISOString(),
          messageCount: index,
          role: {
            id: "default",
            revision: 1,
            name: "Default",
            description: "d".repeat(1_000),
            model: { provider: "test", id: "model" },
          },
          activity: { kind: "idle" },
          compacting: false,
        }),
      );
      const current: ConversationSummary = {
        ...summaries.at(-1)!,
        id: attached.conversationId,
      };
      summaries[summaries.length - 1] = current;
      summaries[summaries.length - 2] = {
        ...summaries.at(-2)!,
        activity: { kind: "running", runId: RUN_A },
      };
      summaries[summaries.length - 3] = {
        ...summaries.at(-3)!,
        attention: true,
      };
      vi.spyOn(harness.coordinator, "listSessions")
        .mockResolvedValue(summaries);
      const eventCount = harness.events.length;

      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: latestState(harness.events).projectId,
      });
      await vi.waitFor(() => {
        expect(harness.events.slice(eventCount).some(
          (event) => event.type === "project_snapshot",
        )).toBe(true);
      });
      const snapshot = harness.events.findLast(
        (event) => event.type === "project_snapshot",
      );
      if (snapshot?.type !== "project_snapshot") {
        throw new Error("project snapshot was not published");
      }

      expect(snapshot.conversations.length)
        .toBeLessThanOrEqual(MAX_PROJECT_CONVERSATIONS);
      expect(snapshot.conversations[0]?.id).toBe(current.id);
      expect(snapshot.conversations).toEqual(expect.arrayContaining([
        expect.objectContaining({ activity: { kind: "running", runId: RUN_A } }),
        expect.objectContaining({ attention: true }),
      ]));
      expect(snapshot.conversations.every(
        ({ name, preview }) =>
          [...(name ?? "")].length <= 24 && preview.length <= 500,
      )).toBe(true);
      expect(snapshot.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8"))
        .toBeLessThanOrEqual(MAX_PROJECT_SNAPSHOT_BYTES);
    } finally {
      await harness.cleanup();
    }
  });

  it("removes complete collaboration groups at the project snapshot byte budget", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const attached = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === createCommandId,
      );
      if (
        attached?.type !== "focus_attached"
        || attached.conversationId === undefined
      ) {
        throw new Error("conversation focus was not attached");
      }

      let nextConversationId = 1;
      const generatedConversationId = () =>
        `00000000-0000-4000-8000-${
          (nextConversationId++).toString(16).padStart(12, "0")
        }`;
      const summaries: ConversationSummary[] = [];
      const groupRoots: string[] = [];
      for (let groupIndex = 0; groupIndex < 4; groupIndex++) {
        const rootConversationId = groupIndex === 0
          ? attached.conversationId
          : generatedConversationId();
        groupRoots.push(rootConversationId);
        for (let memberIndex = 0; memberIndex < 25; memberIndex++) {
          summaries.push({
            id: memberIndex === 0
              ? rootConversationId
              : generatedConversationId(),
            rootConversationId,
            name: `Group ${groupIndex} member ${memberIndex}`,
            preview: "界".repeat(500),
            createdAt: "2026-07-18T12:00:00.000Z",
            updatedAt: new Date(Date.UTC(
              2026,
              6,
              18,
              12,
              groupIndex,
              memberIndex,
            )).toISOString(),
            messageCount: memberIndex,
            role: {
              id: "default",
              revision: 1,
              name: "😀".repeat(80),
              description: "😀".repeat(1_000),
              model: {
                provider: "😀".repeat(256),
                id: "😀".repeat(256),
              },
              compactionModel: null,
              defaultThinkingLevel: "off",
              defaultServiceTier: null,
              toolMode: "read_only",
              canManageSessions: false,
            },
            activity: { kind: "idle" },
            compacting: false,
          });
        }
      }
      vi.spyOn(harness.coordinator, "listSessions")
        .mockResolvedValue(summaries);
      const eventCount = harness.events.length;

      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: latestState(harness.events).projectId,
      });
      await vi.waitFor(() => {
        expect(harness.events.slice(eventCount).some(
          (event) => event.type === "project_snapshot",
        )).toBe(true);
      });
      const snapshot = harness.events.findLast(
        (event) => event.type === "project_snapshot",
      );
      if (snapshot?.type !== "project_snapshot") {
        throw new Error("project snapshot was not published");
      }

      const retainedByRoot = new Map<string, number>();
      for (const conversation of snapshot.conversations) {
        const rootConversationId = conversation.rootConversationId
          ?? conversation.id;
        retainedByRoot.set(
          rootConversationId,
          (retainedByRoot.get(rootConversationId) ?? 0) + 1,
        );
      }
      expect(snapshot.conversations.length).toBeLessThan(summaries.length);
      expect(snapshot.conversations).toContainEqual(expect.objectContaining({
        id: attached.conversationId,
        rootConversationId: attached.conversationId,
      }));
      expect([...retainedByRoot.values()].every((count) => count === 25))
        .toBe(true);
      expect(groupRoots.some((root) => !retainedByRoot.has(root))).toBe(true);
      expect(snapshot.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8"))
        .toBeLessThanOrEqual(MAX_PROJECT_SNAPSHOT_BYTES);
      expect(() => parseServerEvent(snapshot)).not.toThrow();
    } finally {
      await harness.cleanup();
    }
  });

  it("bounds durable card titles and reprojects peer presence for the wire", async () => {
    const harness = await coordinatedConnectionHarness();
    let externalHandle:
      Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>
      | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const sourceCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: sourceCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "source",
      });
      const sourceAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === sourceCommandId,
      );
      const targetCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: targetCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "target",
      });
      const targetAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === targetCommandId,
      );
      if (
        sourceAttach?.type !== "focus_attached"
        || sourceAttach.conversationId === undefined
        || targetAttach?.type !== "focus_attached"
        || targetAttach.conversationId === undefined
      ) {
        throw new Error("source and target focuses were not attached");
      }

      externalHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "full_access",
      );
      const source = await harness.coordinator.openConversation(
        externalHandle,
        sourceAttach.conversationId,
        { updateRecent: false },
      );
      const target = await harness.coordinator.openConversation(
        externalHandle,
        targetAttach.conversationId,
        { updateRecent: false },
      );
      const cardId = randomUUID();
      const cardMessageId = randomUUID();
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId,
          kind: "message",
          body: "review this",
          fromSnapshot: {
            conversationId: source.conversationId,
            title: "😀".repeat(121),
            role: {
              id: source.profile.role.id,
              name: source.profile.role.name,
            },
          },
          toSnapshot: {
            conversationId: target.conversationId,
            role: {
              id: target.profile.role.id,
              name: target.profile.role.name,
            },
          },
          state: "queued",
          messageId: cardMessageId,
          updatedAt: "2026-07-19T12:00:00.000Z",
        }),
      );
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId: randomUUID(),
          kind: "message",
          body: "\u0000".repeat(80_000),
          fromSnapshot: {
            conversationId: source.conversationId,
            role: { id: source.profile.role.id, name: source.profile.role.name },
          },
          toSnapshot: {
            conversationId: target.conversationId,
            role: { id: target.profile.role.id, name: target.profile.role.name },
          },
          state: "queued",
          messageId: randomUUID(),
          updatedAt: "2026-07-19T12:00:01.000Z",
        }),
      );
      const focusCommandId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: focusCommandId,
        sessionId: SESSION_A,
        conversationId: source.conversationId,
      });
      const snapshot = harness.events.findLast(
        (event) =>
          event.type === "conversation_snapshot"
          && event.conversationId === source.conversationId,
      );
      if (
        snapshot?.type !== "conversation_snapshot"
        || snapshot.items === undefined
      ) {
        throw new Error("source snapshot was not published");
      }
      const card = snapshot.items.find((item) =>
        item.kind === "session_message" && item.cardId === cardId
      );
      expect(card).toMatchObject({
        kind: "session_message",
        peerPresence: "unknown",
      });
      if (card?.kind !== "session_message") {
        throw new Error("source card was not projected");
      }
      expect([...card.from.title!]).toHaveLength(24);
      expect(card.from.title?.endsWith("…")).toBe(true);
      expect(card.to.title).toBe("target");
      expect(parseServerEvent(JSON.stringify(snapshot))).toMatchObject({
        type: "conversation_snapshot",
        conversationId: source.conversationId,
      });
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "conversation_item",
          conversationId: source.conversationId,
          item: expect.objectContaining({
            kind: "session_message",
            cardId,
            peerPresence: "present",
          }),
        }));
      });

      const itemCount = harness.events.filter(
        (event) => event.type === "conversation_item",
      ).length;
      await harness.coordinator.deleteConversation(
        externalHandle,
        target.conversationId,
      );
      await vi.waitFor(() => {
        const peerUpdates = harness.events.filter(
          (event) => event.type === "conversation_item",
        ).slice(itemCount);
        expect(peerUpdates).toContainEqual(expect.objectContaining({
          conversationId: source.conversationId,
          item: expect.objectContaining({
            kind: "session_message",
            cardId,
            peerPresence: "absent",
          }),
        }));
      });
      const peerUpdates = harness.events.filter(
        (event) => event.type === "conversation_item",
      ).slice(itemCount);
      expect(peerUpdates).toContainEqual(expect.objectContaining({
        conversationId: source.conversationId,
        item: expect.objectContaining({
          kind: "session_message",
          cardId,
          peerPresence: "unknown",
        }),
      }));

      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId,
          kind: "message",
          body: "review this",
          fromSnapshot: {
            conversationId: source.conversationId,
            title: "😀".repeat(121),
            role: { id: source.profile.role.id, name: source.profile.role.name },
          },
          toSnapshot: {
            conversationId: target.conversationId,
            role: { id: target.profile.role.id, name: target.profile.role.name },
          },
          state: "completed",
          messageId: cardMessageId,
          result: "\u0000".repeat(80_000),
          updatedAt: "2026-07-19T12:00:02.000Z",
        }),
      );
      const snapshotCount = harness.events.filter(
        (event) => event.type === "conversation_snapshot",
      ).length;
      await harness.connection.handle({
        type: "rename_conversation",
        sessionId: SESSION_A,
        conversationId: source.conversationId,
        name: "source renamed",
      });
      await vi.waitFor(() => {
        expect(harness.events.filter(
          (event) => event.type === "conversation_snapshot",
        ).length).toBeGreaterThan(snapshotCount);
      });
      const membershipSnapshot = harness.events.findLast(
        (event) => event.type === "conversation_snapshot",
      );
      expect(membershipSnapshot).toMatchObject({
        type: "conversation_snapshot",
        conversationId: source.conversationId,
        window: { omittedBefore: true },
      });
      if (membershipSnapshot?.type !== "conversation_snapshot") {
        throw new Error("card growth snapshot was not published");
      }
      expect(membershipSnapshot.items?.some((item) => item.id === `session-message:${cardId}`))
        .toBe(false);
    } finally {
      externalHandle?.release();
      await harness.cleanup();
    }
  });

  it("drops a completed stale peer-presence census after focus switches", async () => {
    const harness = await coordinatedConnectionHarness();
    let externalHandle:
      Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>
      | undefined;
    const releaseSourceCensus = deferred();
    const releaseTargetCensus = deferred();
    try {
      const sourceState = await initializeNewConversation(harness);
      if (
        sourceState.conversationId === undefined
        || sourceState.projectId === undefined
        || sourceState.focusId === undefined
      ) {
        throw new Error("source conversation was not attached");
      }
      externalHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "full_access",
      );
      const source = await harness.coordinator.openConversation(
        externalHandle,
        sourceState.conversationId,
        { updateRecent: false },
      );
      const target = await harness.coordinator.createUserConversation(
        externalHandle,
        { roleId: "default", title: "target" },
      );
      const peer = await harness.coordinator.createUserConversation(
        externalHandle,
        { roleId: "default", title: "shared peer" },
      );
      const cardId = randomUUID();
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId,
          kind: "message",
          body: "wait for the census",
          fromSnapshot: {
            conversationId: source.conversationId,
            role: { id: source.profile.role.id, name: source.profile.role.name },
          },
          toSnapshot: {
            conversationId: peer.conversationId,
            role: { id: peer.profile.role.id, name: peer.profile.role.name },
          },
          state: "queued",
          messageId: randomUUID(),
          updatedAt: "2026-07-19T12:00:00.000Z",
        }),
      );
      const targetCardId = randomUUID();
      appendReservedCustomEntry(
        target.sessionManager,
        createConversationCardEntry({
          cardId: targetCardId,
          kind: "message",
          body: "current focus must not receive stale proof",
          fromSnapshot: {
            conversationId: target.conversationId,
            role: { id: target.profile.role.id, name: target.profile.role.name },
          },
          toSnapshot: {
            conversationId: peer.conversationId,
            role: { id: peer.profile.role.id, name: peer.profile.role.name },
          },
          state: "queued",
          messageId: randomUUID(),
          updatedAt: "2026-07-19T12:00:00.000Z",
        }),
      );
      let sourceCensus: Promise<ReadonlyMap<string, "present">> | undefined;
      let targetCensus: Promise<ReadonlyMap<string, "present">> | undefined;
      vi.spyOn(harness.coordinator, "resolveConversationPeerPresence")
        .mockImplementation((_handle, actor, peerIds) => {
          const release = actor.conversationId === source.conversationId
            ? releaseSourceCensus
            : releaseTargetCensus;
          const result = release.promise.then(() => new Map(
            [...peerIds].map((peerId) => [peerId, "present" as const]),
          ));
          if (actor.conversationId === source.conversationId) {
            sourceCensus = result;
          } else if (actor.conversationId === target.conversationId) {
            targetCensus = result;
          }
          return result;
        });

      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: sourceState.projectId,
        conversationId: source.conversationId,
        focusId: sourceState.focusId,
      });
      await vi.waitFor(() => expect(sourceCensus).toBeDefined());
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: target.conversationId,
      });
      releaseSourceCensus.resolve();
      await sourceCensus;
      await vi.waitFor(() => expect(targetCensus).toBeDefined());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(harness.events).not.toContainEqual(expect.objectContaining({
        type: "conversation_item",
        conversationId: target.conversationId,
        item: expect.objectContaining({
          kind: "session_message",
          cardId: targetCardId,
          peerPresence: "present",
        }),
      }));
      releaseTargetCensus.resolve();
      await targetCensus;
    } finally {
      releaseSourceCensus.resolve();
      releaseTargetCensus.resolve();
      externalHandle?.release();
      await harness.cleanup();
    }
  });

  it("coalesces peer-presence refreshes into active and latest censuses", async () => {
    const harness = await coordinatedConnectionHarness();
    let externalHandle:
      Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>
      | undefined;
    try {
      const sourceState = await initializeNewConversation(harness);
      if (
        sourceState.conversationId === undefined
        || sourceState.projectId === undefined
        || sourceState.focusId === undefined
      ) {
        throw new Error("source conversation was not attached");
      }
      externalHandle = await harness.coordinator.acquireProject(
        harness.cwd,
        "full_access",
      );
      const source = await harness.coordinator.openConversation(
        externalHandle,
        sourceState.conversationId,
        { updateRecent: false },
      );
      const firstTarget = await harness.coordinator.createUserConversation(
        externalHandle,
        { roleId: "default", title: "first target" },
      );
      const secondTarget = await harness.coordinator.createUserConversation(
        externalHandle,
        { roleId: "default", title: "second target" },
      );
      const appendCard = (target: typeof firstTarget) => {
        appendReservedCustomEntry(
          source.sessionManager,
          createConversationCardEntry({
            cardId: randomUUID(),
            kind: "message",
            body: "coalesce",
            fromSnapshot: {
              conversationId: source.conversationId,
              role: { id: source.profile.role.id, name: source.profile.role.name },
            },
            toSnapshot: {
              conversationId: target.conversationId,
              role: { id: target.profile.role.id, name: target.profile.role.name },
            },
            state: "queued",
            messageId: randomUUID(),
            updatedAt: "2026-07-19T12:00:00.000Z",
          }),
        );
      };
      appendCard(firstTarget);
      const releaseFirst = deferred();
      const calls: string[][] = [];
      let firstCensus: Promise<ReadonlyMap<string, "present">> | undefined;
      vi.spyOn(harness.coordinator, "resolveConversationPeerPresence")
        .mockImplementation((_handle, _actor, peerIds) => {
          const request = [...peerIds];
          calls.push(request);
          const result = calls.length === 1
            ? releaseFirst.promise.then(() => new Map(
              request.map((peerId) => [peerId, "present" as const]),
            ))
            : Promise.resolve(new Map(
              request.map((peerId) => [peerId, "present" as const]),
            ));
          if (calls.length === 1) firstCensus = result;
          return result;
        });

      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: sourceState.projectId,
        conversationId: source.conversationId,
        focusId: sourceState.focusId,
      });
      await vi.waitFor(() => expect(firstCensus).toBeDefined());
      appendCard(secondTarget);
      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: sourceState.projectId,
        conversationId: source.conversationId,
        focusId: sourceState.focusId,
      });
      expect(calls).toHaveLength(1);
      releaseFirst.resolve();
      await firstCensus;
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[0]).toEqual([firstTarget.conversationId]);
      expect(calls[1]).toEqual([
        firstTarget.conversationId,
        secondTarget.conversationId,
      ]);
    } finally {
      externalHandle?.release();
      await harness.cleanup();
    }
  });

  it("settles startup extension UI when coordinated initialization fails", async () => {
    const harness = await coordinatedConnectionHarness();
    let startupDialog: Promise<boolean> | undefined;
    try {
      harness.runtime.activate = async (options) => {
        if (!options.extensionUI) {
          throw new Error("extension UI was not bound");
        }
        startupDialog = options.extensionUI.confirm(
          "Failing initialization",
          "This request must not outlive initialization",
        );
        throw new Error("extension startup failed");
      };

      await expect(harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "new", roleId: "default" },
      })).rejects.toThrow("extension startup failed");

      const request = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Failing initialization",
      );
      if (request?.type !== "extension_ui_request" || !startupDialog) {
        throw new Error("startup extension dialog was not requested");
      }
      await expect(startupDialog).resolves.toBe(false);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: request.requestId,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("settles startup extension UI when conversation creation fails", async () => {
    const harness = await coordinatedConnectionHarness();
    let startupDialog: Promise<boolean> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      harness.runtime.activate = async (options) => {
        if (!options.extensionUI) {
          throw new Error("extension UI was not bound");
        }
        startupDialog = options.extensionUI.confirm(
          "Failing conversation",
          "This request must not outlive conversation creation",
        );
        throw new Error("conversation startup failed");
      };

      await expect(harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      })).rejects.toThrow("conversation startup failed");

      const request = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Failing conversation",
      );
      if (request?.type !== "extension_ui_request" || !startupDialog) {
        throw new Error("conversation extension dialog was not requested");
      }
      await expect(startupDialog).resolves.toBe(false);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: request.requestId,
      });
      expect(latestState(harness.events)).not.toHaveProperty(
        "conversationId",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("collapses project snapshot refresh bursts into one trailing scan", async () => {
    const harness = await coordinatedConnectionHarness();
    const warmHandle = await harness.coordinator.acquireProject(
      harness.cwd,
      "read_only",
    );
    await Promise.allSettled([...warmHandle.context.backgroundTasks]);
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await vi.waitFor(() => {
        expect(harness.events.some(
          (event) => event.type === "project_snapshot",
        )).toBe(true);
      });

      let resolveFirst!: (summaries: ConversationSummary[]) => void;
      let resolveTrailing!: (summaries: ConversationSummary[]) => void;
      const first = new Promise<ConversationSummary[]>((resolve) => {
        resolveFirst = resolve;
      });
      const trailing = new Promise<ConversationSummary[]>((resolve) => {
        resolveTrailing = resolve;
      });
      const listSessions = vi.spyOn(harness.coordinator, "listSessions")
        .mockImplementationOnce(() => first)
        .mockImplementationOnce(() => trailing);
      const projectId = latestState(harness.events).projectId;
      const initialSnapshots = harness.events.filter(
        (event) => event.type === "project_snapshot",
      ).length;
      const refresh = {
        type: "refresh_view" as const,
        sessionId: SESSION_A,
        projectId,
      };

      await harness.connection.handle(refresh);
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
      await Promise.all([
        harness.connection.handle(refresh),
        harness.connection.handle(refresh),
        harness.connection.handle(refresh),
      ]);
      expect(listSessions).toHaveBeenCalledTimes(1);

      resolveFirst([]);
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
      resolveTrailing([]);
      await vi.waitFor(() => {
        expect(harness.events.filter(
          (event) => event.type === "project_snapshot",
        )).toHaveLength(initialSnapshots + 1);
      });
      expect(listSessions).toHaveBeenCalledTimes(2);
    } finally {
      warmHandle.release();
      await harness.cleanup();
    }
  });

  it("projects only the focused actor attempt and rebuilds it on refocus and reconnect", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const initial = await initializeNewConversation(harness);
      if (!initial.conversationId) throw new Error("Initial conversation was not focused");
      const firstConversationId = initial.conversationId;
      const firstSession = harness.runtime.created.at(-1);
      const firstObserver = harness.runtime.lastCreateOptions?.compactionAttemptObserver;
      if (!firstSession || !firstObserver) throw new Error("Missing first runtime observer");
      const firstAttempt = {
        id: "8d7fae9f-71db-4c54-9ee1-d7185b2fdb9c",
        generator: "default" as const,
        policy: "explicit" as const,
        requestTarget: { provider: "summary-provider", id: "summary-model" },
      };

      firstSession.eventListener?.(nativeEvent({
        type: "compaction_start",
        reason: "manual",
      }));
      firstObserver({ type: "started", attempt: firstAttempt });
      expect(latestState(harness.events)).toMatchObject({
        conversationId: firstConversationId,
        compacting: true,
        compactionAttempt: firstAttempt,
      });

      const secondConversationId = await createColdConversation(harness, "second");
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: secondConversationId,
      });
      expect(latestState(harness.events)).toMatchObject({
        conversationId: secondConversationId,
        compacting: false,
      });
      expect(latestState(harness.events)).not.toHaveProperty("compactionAttempt");

      const stateCount = harness.events.filter((event) => event.type === "state").length;
      const replacementAttempt = {
        ...firstAttempt,
        id: "68f4fa0f-4f72-4b66-ad49-55312d9e6d2f",
        requestTarget: { provider: "test", id: "model" },
      };
      firstSession.eventListener?.(nativeEvent({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
      }));
      firstSession.eventListener?.(nativeEvent({
        type: "compaction_start",
        reason: "manual",
      }));
      firstObserver({ type: "started", attempt: replacementAttempt });
      expect(harness.events.filter((event) => event.type === "state")).toHaveLength(stateCount);
      expect(latestState(harness.events)).toMatchObject({
        conversationId: secondConversationId,
        compacting: false,
      });
      expect(latestState(harness.events)).not.toHaveProperty("compactionAttempt");

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: firstConversationId,
      });
      expect(latestState(harness.events)).toMatchObject({
        conversationId: firstConversationId,
        compacting: true,
        compactionAttempt: replacementAttempt,
      });

      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "open", conversationId: firstConversationId },
      });
      expect(latestState(harness.events)).toMatchObject({
        sessionId: SESSION_B,
        conversationId: firstConversationId,
        compacting: true,
        compactionAttempt: replacementAttempt,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("refreshes only the exact settled browser view", async () => {
    const harness = await coordinatedConnectionHarness();
    const started = deferred();
    const finish = deferred();
    const compactionStarted = deferred();
    const finishCompaction = deferred();
    const releaseStaleRefresh = deferred();
    let run: Promise<void> | undefined;
    let compacting: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const attached = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === createCommandId,
      );
      if (
        attached?.type !== "focus_attached"
        || !attached.conversationId
        || !attached.focusId
      ) throw new Error("conversation focus was not attached");

      const exactRefresh = {
        type: "refresh_view" as const,
        sessionId: SESSION_A,
        projectId: attached.projectId,
        conversationId: attached.conversationId,
        focusId: attached.focusId,
      };
      await vi.waitFor(() => {
        expect(harness.events.findLast(
          (event) => event.type === "project_snapshot",
        )).toMatchObject({
          type: "project_snapshot",
          conversationId: attached.conversationId,
        });
      });
      const staleStart = harness.events.length;
      await harness.connection.handle({
        ...exactRefresh,
        focusId: randomUUID(),
      });
      expect(harness.events).toHaveLength(staleStart);

      const idleRefreshStart = harness.events.length;
      await harness.connection.handle(exactRefresh);
      await vi.waitFor(() => {
        expect(harness.events.slice(idleRefreshStart).some(
          (event) => event.type === "project_snapshot",
        )).toBe(true);
      });
      expect(harness.events.slice(idleRefreshStart)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "state" }),
          expect.objectContaining({ type: "role_catalog_snapshot" }),
          expect.objectContaining({ type: "project_snapshot" }),
          expect.objectContaining({
            type: "conversation_snapshot",
            conversationId: attached.conversationId,
            focusId: attached.focusId,
          }),
        ]),
      );

      const session = harness.runtime.created[0]!;
      session.prompt = async () => {
        started.resolve();
        await finish.promise;
      };
      run = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: attached.conversationId,
        focusId: attached.focusId,
        runId: RUN_A,
        text: "keep running",
      });
      await started.promise;
      const refreshStart = harness.events.length;

      await harness.connection.handle(exactRefresh);
      await vi.waitFor(() => {
        expect(harness.events.slice(refreshStart).some(
          (event) => event.type === "project_snapshot",
        )).toBe(true);
      });
      expect(harness.events.slice(refreshStart)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "state",
            state: expect.objectContaining({
              sessionId: SESSION_A,
              busy: true,
            }),
          }),
          expect.objectContaining({ type: "role_catalog_snapshot" }),
          expect.objectContaining({ type: "project_snapshot" }),
          expect.objectContaining({
            type: "conversation_snapshot",
            conversationId: attached.conversationId,
            focusId: attached.focusId,
          }),
        ]),
      );

      finish.resolve();
      await run;
      run = undefined;
      session.compact = async () => {
        session.compactCalls++;
        compactionStarted.resolve();
        await finishCompaction.promise;
        return {};
      };
      const staleRefreshStarted = deferred();
      const originalListSessions = harness.coordinator.listSessions.bind(
        harness.coordinator,
      );
      let holdStaleRefresh = true;
      const listSessions = vi.spyOn(harness.coordinator, "listSessions")
        .mockImplementation(async (handle, signal) => {
          const summaries = await originalListSessions(handle, signal);
          if (holdStaleRefresh) {
            holdStaleRefresh = false;
            staleRefreshStarted.resolve();
            await releaseStaleRefresh.promise;
          }
          return summaries;
        });
      (harness.connection as unknown as {
        publishProjectSnapshotCoordinated(): void;
      }).publishProjectSnapshotCoordinated();
      await staleRefreshStarted.promise;

      const compactionRefreshStart = harness.events.length;
      compacting = harness.connection.handle({
        type: "compact_context",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: attached.conversationId,
        focusId: attached.focusId,
      });
      await compactionStarted.promise;
      await vi.waitFor(() => {
        expect(harness.events.slice(compactionRefreshStart)).toContainEqual(
          expect.objectContaining({
            type: "project_snapshot",
            conversations: expect.arrayContaining([
              expect.objectContaining({
                id: attached.conversationId,
                compacting: true,
              }),
            ]),
          }),
        );
      });
      const compactionStartEvents = harness.events.slice(
        compactionRefreshStart,
      );
      const firstCompactingProjectSnapshot = compactionStartEvents.findIndex(
        (event) => event.type === "project_snapshot"
          && event.conversations.some((conversation) =>
            conversation.id === attached.conversationId && conversation.compacting
          ),
      );
      expect(firstCompactingProjectSnapshot).toBeGreaterThanOrEqual(0);
      expect(compactionStartEvents.slice(0, firstCompactingProjectSnapshot + 1))
        .not.toContainEqual(expect.objectContaining({
          type: "conversation_snapshot",
        }));
      expect(compactionStartEvents.filter(
        (event) => event.type === "state",
      )).toHaveLength(1);
      expect(harness.events.slice(compactionRefreshStart)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "state",
            state: expect.objectContaining({ compacting: true }),
          }),
        ]),
      );
      releaseStaleRefresh.resolve();
      await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
      const projectSnapshotsDuringCompaction = harness.events
        .slice(compactionRefreshStart)
        .filter((event) => event.type === "project_snapshot");
      const compactingSnapshotIndex = projectSnapshotsDuringCompaction.findIndex(
        (event) => event.conversations.some((conversation) =>
          conversation.id === attached.conversationId && conversation.compacting
        ),
      );
      expect(compactingSnapshotIndex).toBeGreaterThanOrEqual(0);
      expect(projectSnapshotsDuringCompaction.slice(compactingSnapshotIndex + 1))
        .not.toContainEqual(expect.objectContaining({
          conversations: expect.arrayContaining([
            expect.objectContaining({
              id: attached.conversationId,
              compacting: false,
            }),
          ]),
        }));

      finishCompaction.resolve();
      await compacting;
      compacting = undefined;
      await vi.waitFor(() => {
        expect(harness.events.slice(compactionRefreshStart)).toContainEqual(
          expect.objectContaining({
            type: "project_snapshot",
            conversations: expect.arrayContaining([
              expect.objectContaining({
                id: attached.conversationId,
                compacting: false,
              }),
            ]),
          }),
        );
      });
    } finally {
      finish.resolve();
      finishCompaction.resolve();
      releaseStaleRefresh.resolve();
      await run?.catch(() => undefined);
      await compacting?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("keeps the current conversation UI live when a new focus creation fails", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const firstAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === firstCommandId,
      );
      const firstUI = harness.runtime.lastCreateOptions?.extensionUI;
      if (
        firstAttach?.type !== "focus_attached"
        || !firstAttach.conversationId
        || !firstUI
      ) {
        throw new Error("first conversation was not attached");
      }

      harness.runtime.activate = async () => {
        throw new Error("next conversation startup failed");
      };
      await expect(harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      })).rejects.toThrow("next conversation startup failed");

      const dialog = firstUI.confirm(
        "Still focused after failure",
        "The previous conversation must keep its UI route",
      );
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "extension_ui_request",
          sessionId: SESSION_A,
          request: expect.objectContaining({
            kind: "confirm",
            title: "Still focused after failure",
          }),
        }));
      });
      const request = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Still focused after failure",
      );
      if (request?.type !== "extension_ui_request") {
        throw new Error("current conversation UI route was not preserved");
      }
      await harness.connection.handle({
        type: "extension_ui_response",
        sessionId: SESSION_A,
        requestId: request.requestId,
        response: { kind: "confirm", confirmed: true },
      });
      await expect(dialog).resolves.toBe(true);
      expect(latestState(harness.events)).toMatchObject({
        conversationId: firstAttach.conversationId,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("cancels extension UI that blocks a focus transition before close queues", async () => {
    const harness = await coordinatedConnectionHarness();
    let create: Promise<void> | undefined;
    let close: Promise<void> | undefined;
    let requestId: string | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      harness.runtime.activate = async (options) => {
        if (!options.extensionUI) {
          throw new Error("extension UI was not bound");
        }
        await options.extensionUI.confirm(
          "Blocking focus startup",
          "Closing the view must cancel this request before the actor queue",
        );
      };

      create = harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });
      await vi.waitFor(() => {
        const request = harness.events.findLast(
          (event) =>
            event.type === "extension_ui_request"
            && event.request.kind === "confirm"
            && event.request.title === "Blocking focus startup",
        );
        expect(request?.type).toBe("extension_ui_request");
        if (request?.type === "extension_ui_request") {
          requestId = request.requestId;
        }
      });

      close = harness.connection.handle({
        type: "close_session",
        sessionId: SESSION_A,
      });
      const closedPromptly = await Promise.race([
        close.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 500);
        }),
      ]);
      expect(closedPromptly).toBe(true);
      await create;
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await vi.waitFor(() => {
        expect(harness.events.findLast(
          (event) =>
            event.type === "project_snapshot"
            && event.sessionId === SESSION_B,
        )).toMatchObject({
          type: "project_snapshot",
          sessionId: SESSION_B,
          conversations: [],
        });
      });
    } finally {
      if (requestId) {
        await harness.connection.handle({
          type: "extension_ui_response",
          sessionId: SESSION_A,
          requestId,
          response: { kind: "cancel" },
        });
      }
      await create?.catch(() => undefined);
      await close?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("keeps runs self-contained while switching between projects", async () => {
    const harness = await coordinatedConnectionHarness();
    const cwdB = await realpath(
      await temporaryDirectory("piweb-coordinated-second-"),
    );
    const startedA = deferred();
    const finishA = deferred();
    const startedB = deferred();
    const finishB = deferred();
    let runA: Promise<void> | undefined;
    let runB: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createA = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createA,
        sessionId: SESSION_A,
        roleId: "default",
      });
      const focusA = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === createA,
      );
      if (
        focusA?.type !== "focus_attached"
        || !focusA.conversationId
        || !focusA.focusId
      ) throw new Error("project A conversation was not focused");
      const sessionA = harness.runtime.created[0]!;
      sessionA.prompt = async () => {
        startedA.resolve();
        await finishA.promise;
      };
      runA = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focusA.conversationId,
        focusId: focusA.focusId,
        runId: RUN_A,
        text: "work in project A",
      });
      await startedA.promise;
      expect(harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      )).toMatchObject({
        type: "project_activity_snapshot",
        projects: [expect.objectContaining({
          cwd: harness.cwd,
          busyConversationCount: 1,
        })],
      });

      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_B,
        cwd: cwdB,
        conversation: { kind: "recent" },
      });
      expect(sessionA.abortCalls).toBe(0);
      expect(sessionA.disposed).toBe(false);

      const createB = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: createB,
        sessionId: SESSION_B,
        roleId: "default",
      });
      const focusB = harness.events.findLast(
        (event) => event.type === "focus_attached" && event.commandId === createB,
      );
      if (
        focusB?.type !== "focus_attached"
        || !focusB.conversationId
        || !focusB.focusId
      ) throw new Error("project B conversation was not focused");
      const sessionB = harness.runtime.created[1]!;
      sessionB.prompt = async () => {
        startedB.resolve();
        await finishB.promise;
      };
      runB = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_B,
        conversationId: focusB.conversationId,
        focusId: focusB.focusId,
        runId: RUN_B,
        text: "work in project B",
      });
      await startedB.promise;
      const bothProjectsActive = harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      );
      if (bothProjectsActive?.type !== "project_activity_snapshot") {
        throw new Error("global project activity was not published");
      }
      expect(bothProjectsActive.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          cwd: harness.cwd,
          busyConversationCount: 1,
        }),
        expect.objectContaining({
          cwd: cwdB,
          busyConversationCount: 1,
        }),
      ]));

      const reopenA = randomUUID();
      await harness.connection.handle({
        type: "initialize",
        commandId: reopenA,
        sessionId: SESSION_C,
        cwd: harness.cwd,
        conversation: {
          kind: "open",
          conversationId: focusA.conversationId,
        },
      });
      expect(harness.runtime.created).toHaveLength(2);
      expect(sessionA.abortCalls).toBe(0);
      expect(sessionB.abortCalls).toBe(0);
      expect(latestState(harness.events)).toMatchObject({
        sessionId: SESSION_C,
        conversationId: focusA.conversationId,
        busy: true,
        activeRun: { id: RUN_A },
      });

      finishA.resolve();
      await runA;
      await vi.waitFor(() => {
        expect(latestState(harness.events)).toMatchObject({
          sessionId: SESSION_C,
          conversationId: focusA.conversationId,
          busy: false,
        });
      });
      const projectASettled = harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      );
      if (projectASettled?.type !== "project_activity_snapshot") {
        throw new Error("settled project activity was not published");
      }
      expect(projectASettled.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          cwd: harness.cwd,
          busyConversationCount: 0,
        }),
        expect.objectContaining({
          cwd: cwdB,
          busyConversationCount: 1,
        }),
      ]));

      const sessionD = randomUUID();
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: sessionD,
        cwd: cwdB,
        conversation: {
          kind: "open",
          conversationId: focusB.conversationId,
        },
      });
      expect(harness.runtime.created).toHaveLength(2);
      expect(latestState(harness.events)).toMatchObject({
        sessionId: sessionD,
        conversationId: focusB.conversationId,
        busy: true,
        activeRun: { id: RUN_B },
      });

      finishB.resolve();
      await runB;
      await vi.waitFor(() => {
        expect(latestState(harness.events)).toMatchObject({
          sessionId: sessionD,
          conversationId: focusB.conversationId,
          busy: false,
        });
      });
    } finally {
      finishA.resolve();
      finishB.resolve();
      await runA?.catch(() => undefined);
      await runB?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("restores a running background conversation from the server-owned live projection", async () => {
    const harness = await coordinatedConnectionHarness();
    const started = deferred();
    const emitBackgroundProgress = deferred();
    const finish = deferred();
    let run: Promise<void> | undefined;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "first",
      });
      const first = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === firstCommandId,
      );
      if (
        first?.type !== "focus_attached"
        || !first.conversationId
        || !first.focusId
      ) throw new Error("first conversation was not focused");

      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "second",
      });
      const second = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === secondCommandId,
      );
      if (second?.type !== "focus_attached" || !second.conversationId) {
        throw new Error("second conversation was not focused");
      }

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const focusedFirst = latestState(harness.events);
      if (!focusedFirst.focusId) throw new Error("first focusId missing");
      const firstSession = harness.runtime.created[0]!;
      firstSession.prompt = async () => {
        started.resolve();
        await emitBackgroundProgress.promise;
        firstSession.eventListener?.(nativeEvent({ type: "agent_start" }));
        firstSession.eventListener?.(nativeEvent({
          type: "message_start",
          message: { role: "assistant" },
        }));
        firstSession.eventListener?.(nativeEvent({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
        }));
        firstSession.eventListener?.(nativeEvent({
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read",
          args: { path: "a.ts" },
        }));
        firstSession.eventListener?.(nativeEvent({
          type: "tool_execution_end",
          toolCallId: "read-1",
          result: { ok: true },
          isError: false,
        }));
        firstSession.eventListener?.(nativeEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "background text" },
        }));
        await finish.promise;
        firstSession.eventListener?.(nativeEvent({ type: "agent_settled" }));
      };
      run = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: first.conversationId,
        focusId: focusedFirst.focusId,
        runId: RUN_A,
        text: "continue while unfocused",
      });
      await started.promise;

      const focusSecondId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: focusSecondId,
        sessionId: SESSION_A,
        conversationId: second.conversationId,
      });
      const eventCountAtSwitch = harness.events.length;
      emitBackgroundProgress.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => {
        expect(harness.events.slice(eventCountAtSwitch).some(
          (event) =>
            event.type === "session_event"
            && event.conversationId === first.conversationId,
        )).toBe(false);
      });

      const refocusCommandId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: refocusCommandId,
        sessionId: SESSION_A,
        conversationId: first.conversationId,
      });
      const refocused = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === refocusCommandId,
      );
      if (
        refocused?.type !== "focus_attached"
        || !refocused.focusId
      ) throw new Error("first conversation was not refocused");
      const snapshot = harness.events.findLast((event) => (
        event.type === "conversation_snapshot"
        && event.conversationId === first.conversationId
        && event.focusId === refocused.focusId
      ));
      if (snapshot?.type !== "conversation_snapshot") {
        throw new Error("refocus snapshot was not published");
      }
      const assistant = snapshot.items?.find((item) => (
        item.kind === "message"
        && item.role === "assistant"
        && item.runId === RUN_A
      ));
      expect(snapshot.projectionSeq).toBeGreaterThan(0);
      expect(assistant).toMatchObject({
        kind: "message",
        runId: RUN_A,
        thinking: "thinking",
        text: "background text",
        tools: [expect.objectContaining({
          toolCallId: "read-1",
          toolName: "read",
          status: "done",
          result: { ok: true },
        })],
      });
    } finally {
      emitBackgroundProgress.resolve();
      finish.resolve();
      await run?.catch(() => undefined);
      await harness.cleanup();
    }
  });

  it("switches focus without cancelling the background actor and rejects stale focus commands", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "first",
      });
      const firstAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === firstCommandId,
      );
      if (
        firstAttach?.type !== "focus_attached"
        || !firstAttach.conversationId
        || !firstAttach.focusId
      ) {
        throw new Error("first focus was not attached");
      }
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "conversation_snapshot",
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
        focusId: firstAttach.focusId,
        role: expect.objectContaining({ id: "default" }),
        items: [],
      }));
      const initialSnapshot = harness.events.find(
        (event) =>
          event.type === "conversation_snapshot"
          && event.conversationId === firstAttach.conversationId
          && event.focusId === firstAttach.focusId,
      );
      expect(initialSnapshot).not.toHaveProperty("messages");
      expect(harness.events.filter(
        (event) => event.type === "conversation_run_settled",
      )).toHaveLength(0);
      await harness.connection.handle({
        type: "refresh_view",
        sessionId: SESSION_A,
        projectId: firstAttach.projectId,
        conversationId: firstAttach.conversationId,
        focusId: firstAttach.focusId,
      });
      expect(harness.events.filter(
        (event) => event.type === "conversation_run_settled",
      )).toHaveLength(0);
      const firstAttachIndex = harness.events.indexOf(firstAttach);
      const firstSnapshotIndex = harness.events.findIndex(
        (event) =>
          event.type === "conversation_snapshot"
          && event.conversationId === firstAttach.conversationId
          && event.focusId === firstAttach.focusId,
      );
      expect(firstAttachIndex).toBeGreaterThanOrEqual(0);
      expect(firstSnapshotIndex).toBeGreaterThan(firstAttachIndex);

      const started = deferred();
      const finish = deferred();
      const firstSession = harness.runtime.created[0]!;
      firstSession.prompt = async () => {
        started.resolve();
        await finish.promise;
        firstSession.persistentManager?.appendMessage(agentMessage({
          role: "assistant",
          content: [{ type: "text", text: "background result" }],
          api: "test-api",
          provider: "test",
          model: "model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        }));
      };
      const firstRunId = randomUUID();
      const firstRun = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
        focusId: firstAttach.focusId,
        runId: firstRunId,
        text: "continue in background",
      });
      await started.promise;

      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "second",
      });
      const secondAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === secondCommandId,
      );
      if (
        secondAttach?.type !== "focus_attached"
        || !secondAttach.conversationId
        || !secondAttach.focusId
      ) {
        throw new Error("second focus was not attached");
      }
      expect(secondAttach.conversationId).not.toBe(
        firstAttach.conversationId,
      );
      expect(firstSession.abortCalls).toBe(0);

      await expect(harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
        focusId: firstAttach.focusId,
        runId: randomUUID(),
        text: "stale",
      })).rejects.toThrow("focus is stale");
      await expect(harness.connection.handle({
        type: "abort",
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
        focusId: firstAttach.focusId,
        runId: firstRunId,
      })).rejects.toThrow("focus is stale");

      const eventCountAtSwitch = harness.events.length;
      finish.resolve();
      await firstRun;
      expect(firstSession.abortCalls).toBe(0);
      expect(harness.events).toContainEqual({
        type: "conversation_run_settled",
        sessionId: SESSION_A,
        projectId: firstAttach.projectId,
        conversationId: firstAttach.conversationId,
        runId: firstRunId,
        outcome: "completed",
        createdBy: { kind: "user" },
      });
      await vi.waitFor(() => {
        const snapshot = harness.events.findLast(
          (event) => event.type === "project_snapshot",
        );
        expect(snapshot).toMatchObject({
          type: "project_snapshot",
          conversations: expect.arrayContaining([
            expect.objectContaining({
              id: firstAttach.conversationId,
              unread: true,
            }),
          ]),
        });
      });
      expect(
        harness.events.slice(eventCountAtSwitch).some(
          (event) =>
            event.type === "session_event"
            && event.conversationId === firstAttach.conversationId,
        ),
      ).toBe(false);

      const coordinatedView = (harness.connection as unknown as {
        coordinatedView: {
          handle: Parameters<
            ProjectSessionCoordinator["startPeerSession"]
          >[0];
        };
      }).coordinatedView;
      const peerSourceStarted = deferred();
      const releasePeerSource = deferred();
      firstSession.prompt = async () => {
        peerSourceStarted.resolve();
        await releasePeerSource.promise;
      };
      const peerSourceCompletion = harness.coordinator.prompt(
        coordinatedView.handle,
        firstAttach.conversationId,
        randomUUID(),
        "start exact background peer work",
      );
      await peerSourceStarted.promise;
      const peer = await harness.coordinator.startPeerSession(
        coordinatedView.handle,
        firstAttach.conversationId,
        {
          roleId: "default",
          task: "agent-created background work",
          idempotencyKey: randomUUID(),
        },
      );
      releasePeerSource.resolve();
      await peerSourceCompletion;

      await vi.waitFor(() => {
        const settlement = harness.events.find((event) => (
          event.type === "conversation_run_settled"
          && event.conversationId === peer.conversationId
          && event.runId === peer.runId
        ));
        expect(settlement).toMatchObject({
          type: "conversation_run_settled",
          sessionId: SESSION_A,
          projectId: firstAttach.projectId,
          conversationId: peer.conversationId,
          runId: peer.runId,
          createdBy: {
            kind: "conversation",
            conversationId: firstAttach.conversationId,
          },
        });
        if (settlement?.type === "conversation_run_settled") {
          expect(["completed", "aborted", "failed"]).toContain(
            settlement.outcome,
          );
        }
      });
      await vi.waitFor(async () => {
        const inspection = await coordinatedView.handle.project
          .inspectConversation(firstAttach.conversationId);
        expect(inspection.cards.some((card) =>
          card.toSnapshot.conversationId === peer.conversationId
          && ["completed", "failed", "aborted"].includes(card.state)
        )).toBe(true);
      });

      const refocusCommandId = randomUUID();
      await harness.connection.handle({
        type: "focus_conversation",
        commandId: refocusCommandId,
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
      });
      const refocused = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === refocusCommandId,
      );
      expect(refocused).toMatchObject({
        type: "focus_attached",
        conversationId: firstAttach.conversationId,
      });
      if (refocused?.type !== "focus_attached") {
        throw new Error("first conversation was not refocused");
      }
      expect(refocused.focusId).not.toBe(firstAttach.focusId);
      expect(harness.runtime.created).toHaveLength(3);
      await vi.waitFor(() => {
        const snapshot = harness.events.findLast(
          (event) => event.type === "project_snapshot",
        );
        expect(snapshot).toMatchObject({
          type: "project_snapshot",
          conversations: expect.arrayContaining([
            expect.objectContaining({
              id: firstAttach.conversationId,
              unread: false,
            }),
          ]),
        });
      });

      const deleteCommandId = randomUUID();
      await harness.connection.handle({
        type: "delete_conversation",
        commandId: deleteCommandId,
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "delete_conversation",
        commandId: deleteCommandId,
        sessionId: SESSION_A,
      });
      expect(latestState(harness.events)).not.toHaveProperty(
        "conversationId",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("routes extension UI only for the focused actor and settles it when the view closes", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const firstCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: firstCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "first extension actor",
      });
      const firstAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === firstCommandId,
      );
      if (
        firstAttach?.type !== "focus_attached"
        || !firstAttach.conversationId
      ) {
        throw new Error("first extension actor was not attached");
      }
      const firstUI = harness.runtime.lastCreateOptions?.extensionUI;
      if (!firstUI) throw new Error("first actor extension UI was not bound");

      const firstDialog = firstUI.confirm(
        "Focused actor dialog",
        "Route this through the current browser focus",
      );
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "extension_ui_request",
          sessionId: SESSION_A,
          request: expect.objectContaining({
            kind: "confirm",
            title: "Focused actor dialog",
          }),
        }));
      });
      const firstRequest = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Focused actor dialog",
      );
      if (firstRequest?.type !== "extension_ui_request") {
        throw new Error("focused actor dialog was not requested");
      }
      await harness.connection.handle({
        type: "extension_ui_response",
        sessionId: SESSION_A,
        requestId: firstRequest.requestId,
        response: { kind: "confirm", confirmed: true },
      });
      await expect(firstDialog).resolves.toBe(true);

      const cancelledOnFocusChange = firstUI.confirm(
        "Old focus dialog",
        "Changing focus must settle this request",
      );
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "extension_ui_request",
          sessionId: SESSION_A,
          request: expect.objectContaining({
            kind: "confirm",
            title: "Old focus dialog",
          }),
        }));
      });
      const oldFocusRequest = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Old focus dialog",
      );
      if (oldFocusRequest?.type !== "extension_ui_request") {
        throw new Error("old focus dialog was not requested");
      }

      const secondCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_conversation",
        commandId: secondCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        title: "second extension actor",
      });
      const secondAttach = harness.events.findLast(
        (event) =>
          event.type === "focus_attached"
          && event.commandId === secondCommandId,
      );
      if (
        secondAttach?.type !== "focus_attached"
        || !secondAttach.conversationId
      ) {
        throw new Error("second extension actor was not attached");
      }
      const secondUI = harness.runtime.lastCreateOptions?.extensionUI;
      if (!secondUI) throw new Error("second actor extension UI was not bound");
      await expect(cancelledOnFocusChange).resolves.toBe(false);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: oldFocusRequest.requestId,
      });

      const requestCountBeforeDetachedActor = harness.events.filter(
        ({ type }) => type === "extension_ui_request",
      ).length;
      const detachedAbort = new AbortController();
      const abortedDialog = firstUI.confirm(
        "Aborted detached dialog",
        "This must settle without a browser delegate",
        { signal: detachedAbort.signal },
      );
      detachedAbort.abort();
      await expect(abortedDialog).resolves.toBe(false);
      const detachedDialog = firstUI.confirm(
        "Detached actor dialog",
        "Keep this request pending until the user focuses the actor",
      );
      expect(
        harness.events.filter(({ type }) => type === "extension_ui_request"),
      ).toHaveLength(requestCountBeforeDetachedActor);
      await vi.waitFor(() => {
        const snapshot = harness.events.findLast(
          (event) => event.type === "project_snapshot",
        );
        expect(snapshot).toMatchObject({
          type: "project_snapshot",
          conversations: expect.arrayContaining([
            expect.objectContaining({
              id: firstAttach.conversationId,
              attention: true,
            }),
          ]),
        });
      });
      expect(harness.events.findLast(
        (event) => event.type === "project_activity_snapshot",
      )).toMatchObject({
        type: "project_activity_snapshot",
        projects: [expect.objectContaining({
          cwd: harness.cwd,
          attentionConversationCount: 1,
        })],
      });

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
      });
      await vi.waitFor(() => {
        expect(harness.events.findLast(
          (event) => event.type === "project_activity_snapshot",
        )).toMatchObject({
          type: "project_activity_snapshot",
          projects: [expect.objectContaining({
            cwd: harness.cwd,
            attentionConversationCount: 0,
          })],
        });
      });
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "extension_ui_request",
          sessionId: SESSION_A,
          request: expect.objectContaining({
            kind: "confirm",
            title: "Detached actor dialog",
          }),
        }));
      });
      const detachedRequest = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Detached actor dialog",
      );
      if (detachedRequest?.type !== "extension_ui_request") {
        throw new Error("detached actor dialog was not restored on focus");
      }
      await harness.connection.handle({
        type: "extension_ui_response",
        sessionId: SESSION_A,
        requestId: detachedRequest.requestId,
        response: { kind: "confirm", confirmed: true },
      });
      await expect(detachedDialog).resolves.toBe(true);

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: secondAttach.conversationId,
      });
      const closingDialog = secondUI.confirm(
        "Current actor dialog",
        "Closing the project view must settle this request",
      );
      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(expect.objectContaining({
          type: "extension_ui_request",
          sessionId: SESSION_A,
          request: expect.objectContaining({
            kind: "confirm",
            title: "Current actor dialog",
          }),
        }));
      });
      const closingRequest = harness.events.findLast(
        (event) =>
          event.type === "extension_ui_request"
          && event.request.kind === "confirm"
          && event.request.title === "Current actor dialog",
      );
      if (closingRequest?.type !== "extension_ui_request") {
        throw new Error("current actor dialog was not requested");
      }

      await harness.connection.handle({
        type: "close_session",
        sessionId: SESSION_A,
      });
      await expect(closingDialog).resolves.toBe(false);
      expect(harness.events).toContainEqual({
        type: "extension_ui_closed",
        sessionId: SESSION_A,
        requestId: closingRequest.requestId,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("detaches the browser without disposing its persistent actor", async () => {
    const harness = await coordinatedConnectionHarness();
    await harness.connection.handle({
      type: "initialize",
      commandId: randomUUID(),
      sessionId: SESSION_A,
      cwd: harness.cwd,
      conversation: { kind: "recent" },
    });
    await harness.connection.handle({
      type: "create_conversation",
      commandId: randomUUID(),
      sessionId: SESSION_A,
      roleId: "default",
    });
    const session = harness.runtime.created[0]!;

    await harness.connection.dispose();
    expect(session.disposed).toBe(false);

    await harness.coordinator.close();
    expect(session.disposed).toBe(true);
    harness.roles.dispose();
  });

  it("validates role model changes against the focused project registry", async () => {
    const harness = await coordinatedConnectionHarness();
    const baselineModel = harness.runtime.modelRegistry.getAvailable()[0]!;
    const projectModel = {
      provider: "project-extension",
      id: "project-model",
      name: "Project model",
      reasoning: false,
      input: ["text"] as const,
      contextWindow: 1_000,
    };
    let projectAvailable = [baselineModel, projectModel];
    harness.runtime.sessionModelRegistry = {
      getAll: () => [baselineModel, projectModel],
      getRegisteredProviderIds: () => [],
      getAvailable: () => projectAvailable,
      getError: () => undefined,
      getProviderDisplayName: (provider: string) => provider,
      getProviderAuthStatus: () => ({ configured: true }),
      hasConfiguredAuth: () => true,
    } as unknown as ModelRegistry;
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      await harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
      });

      await harness.connection.handle({
        type: "create_role",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        role: {
          name: "Project specialist",
          description: "Uses a project extension provider",
          systemPrompt: "Use the project model.",
          model: {
            provider: projectModel.provider,
            id: projectModel.id,
          },
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "read_only",
          canManageSessions: false,
        },
      });
      await vi.waitFor(() => {
        const snapshot = harness.events.findLast(
          (event) => event.type === "role_catalog_snapshot",
        );
        expect(snapshot).toMatchObject({
          type: "role_catalog_snapshot",
          roles: expect.arrayContaining([
            expect.objectContaining({
              name: "Project specialist",
              available: true,
            }),
          ]),
        });
      });
      const createdSnapshot = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      if (createdSnapshot?.type !== "role_catalog_snapshot") {
        throw new Error("role catalog was not published");
      }
      const projectRole = createdSnapshot.roles.find(
        ({ name }) => name === "Project specialist",
      );
      if (!projectRole) throw new Error("project role was not created");

      await expect(harness.connection.handle({
        type: "create_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: projectRole.id,
      })).resolves.toBeUndefined();
      expect(harness.runtime.lastCreateOptions).toMatchObject({
        model: {
          provider: projectModel.provider,
          id: projectModel.id,
        },
      });

      projectAvailable = [baselineModel];
      await expect(harness.connection.handle({
        type: "update_role",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: projectRole.id,
        expectedRevision: projectRole.revision,
        expectedSystemPrompt: "Use the project model.",
        role: {
          name: "Renamed project specialist",
          description: "The provider may be temporarily unavailable.",
          systemPrompt: "Keep the frozen project model.",
          model: {
            provider: projectModel.provider,
            id: projectModel.id,
          },
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "full_access",
          canManageSessions: true,
        },
      })).resolves.toBeUndefined();

      const renamedSnapshot = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      if (renamedSnapshot?.type !== "role_catalog_snapshot") {
        throw new Error("renamed role catalog was not published");
      }
      const renamedRole = renamedSnapshot.roles.find(
        ({ id }) => id === projectRole.id,
      );
      expect(renamedRole).toMatchObject({
        name: "Renamed project specialist",
        available: false,
        model: {
          provider: projectModel.provider,
          id: projectModel.id,
        },
      });

      await expect(harness.connection.handle({
        type: "update_role",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: projectRole.id,
        expectedRevision: renamedRole!.revision,
        expectedSystemPrompt: "Keep the frozen project model.",
        role: {
          name: "Invalid model change",
          description: "",
          systemPrompt: "",
          model: {
            provider: projectModel.provider,
            id: "missing",
          },
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "full_access",
          canManageSessions: true,
        },
      })).rejects.toThrow("unavailable in the current project");
    } finally {
      await harness.cleanup();
    }
  });

  it("publishes a durable image snapshot as soon as the initial prompt persists", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const focused = await initializeNewConversation(harness);
      const session = harness.runtime.created[0]!;
      const manager = session.persistentManager!;
      session.model = {
        ...session.model,
        input: ["text", "image"],
      } as typeof session.model;
      const promptStarted = deferred();
      const promptFinished = deferred();
      session.prompt = async () => {
        promptStarted.resolve();
        await promptFinished.promise;
      };

      const running = harness.connection.handle({
        type: "prompt",
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        runId: RUN_A,
        promptId: randomUUID(),
        text: "",
        images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
      });
      await promptStarted.promise;
      const raw = agentMessage({
        role: "user",
        content: [{
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        }],
        timestamp: 1,
      });
      session.eventListener?.(nativeEvent({ type: "message_start", message: raw }));
      const messageId = manager.appendMessage(raw);
      const eventStart = harness.events.length;
      session.eventListener?.(nativeEvent({ type: "message_end", message: raw }));

      await vi.waitFor(() => expect(harness.events.slice(eventStart)).toContainEqual(
        expect.objectContaining({
          type: "conversation_snapshot",
          conversationId: focused.conversationId,
          focusId: focused.focusId,
          items: expect.arrayContaining([
            expect.objectContaining({
              kind: "message",
              id: messageId,
              role: "user",
              text: "[图片]",
              imageRefs: [{
                offset: 0,
                source: { messageId, imageOrdinal: 0 },
              }],
            }),
          ]),
        }),
      ));
      const snapshot = harness.events.findLast((event) => (
        event.type === "conversation_snapshot"
        && event.conversationId === focused.conversationId
      ));
      expect(JSON.stringify(snapshot)).not.toContain("iVBORw0KGgo=");

      promptFinished.resolve();
      await running;
    } finally {
      await harness.cleanup();
    }
  });

  it("reads exactly one durable user image through a one-shot response", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      const focused = await initializeNewConversation(harness);
      const manager = harness.runtime.created[0]!.persistentManager!;
      const messageId = manager.appendMessage({
        role: "user",
        content: [{
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        }],
        timestamp: 1,
      });
      const commandId = randomUUID();
      const eventStart = harness.events.length;

      await harness.connection.handle({
        type: "open_image",
        commandId,
        sessionId: SESSION_A,
        conversationId: focused.conversationId!,
        focusId: focused.focusId!,
        messageId,
        imageOrdinal: 0,
      });

      expect(harness.events.slice(eventStart)).toContainEqual({
        type: "conversation_image",
        sessionId: SESSION_A,
        conversationId: focused.conversationId,
        focusId: focused.focusId,
        commandId,
        messageId,
        imageOrdinal: 0,
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      });
      expect(harness.events.slice(eventStart)).not.toContainEqual(
        expect.objectContaining({ type: "command_complete", commandId }),
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("settles role CRUD with the exact command identity", async () => {
    const harness = await coordinatedConnectionHarness();
    try {
      await harness.connection.handle({
        type: "initialize",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        cwd: harness.cwd,
        conversation: { kind: "recent" },
      });
      const createCommandId = randomUUID();
      await harness.connection.handle({
        type: "create_role",
        commandId: createCommandId,
        sessionId: SESSION_A,
        role: {
          name: "Reviewer",
          description: "Reviews changes",
          systemPrompt: "Review carefully.",
          model: { provider: "test", id: "model" },
          compactionModel: null,
          defaultThinkingLevel: "off",
          defaultServiceTier: null,
          toolMode: "read_only",
          canManageSessions: false,
        },
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "create_role",
        commandId: createCommandId,
        sessionId: SESSION_A,
      });

      const catalog = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      if (catalog?.type !== "role_catalog_snapshot") {
        throw new Error("role catalog was not published");
      }
      const reviewer = catalog.roles.find(({ name }) => name === "Reviewer");
      expect(reviewer).toBeDefined();

      const deleteCommandId = randomUUID();
      await harness.connection.handle({
        type: "delete_role",
        commandId: deleteCommandId,
        sessionId: SESSION_A,
        roleId: reviewer!.id,
        expectedRevision: reviewer!.revision,
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "delete_role",
        commandId: deleteCommandId,
        sessionId: SESSION_A,
      });
      const afterReviewerDelete = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      if (afterReviewerDelete?.type !== "role_catalog_snapshot") {
        throw new Error("role catalog after delete was not published");
      }
      const seededRole = afterReviewerDelete.roles.find(
        ({ id }) => id === "default",
      );
      expect(seededRole).toBeDefined();

      const deleteSeededCommandId = randomUUID();
      await harness.connection.handle({
        type: "delete_role",
        commandId: deleteSeededCommandId,
        sessionId: SESSION_A,
        roleId: "default",
        expectedRevision: seededRole!.revision,
      });
      expect(harness.events).toContainEqual({
        type: "command_complete",
        operation: "delete_role",
        commandId: deleteSeededCommandId,
        sessionId: SESSION_A,
      });
      const emptyCatalog = harness.events.findLast(
        (event) => event.type === "role_catalog_snapshot",
      );
      expect(emptyCatalog).toMatchObject({
        type: "role_catalog_snapshot",
        roles: [],
      });
    } finally {
      await harness.cleanup();
    }
  });
});
