import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  MAX_PROMPT_CHARACTERS,
  type ProjectActivitySummary,
  type RoleTemplate,
} from "../shared/protocol.js";
import {
  ConversationActor,
  WAIT_CACHE_CHECKPOINT_DELAY_MS,
  type ConversationActorEvent,
} from "./conversation-actor.js";
import {
  CONVERSATION_CARD_CUSTOM_TYPE,
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createLoopListEntry,
  createMetaOperationEntry,
  createPendingPromptBatchEntry,
  createPendingPromptDeliveryEntry,
  createRunSettlementEntry,
  MAX_CONVERSATION_BODY_BYTES,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  type ConversationMeta,
  type RunSettlement,
} from "./conversation-meta.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
  CredentialChangeIntent,
  PiRuntimeLike,
} from "./pi-runtime.js";
import type { PortableExtensionUI } from "./extension-ui.js";
import { ProjectInbox } from "./project-inbox.js";
import {
  MAX_DELEGATION_DEPTH,
  MAX_LIVE_DELEGATION_DESCENDANTS,
  MAX_PEER_SESSIONS_PER_RUN,
  ProjectSessionCoordinator,
  type StartPeerSessionInput,
} from "./project-session-coordinator.js";
import {
  ProjectStore,
  ProjectStoreRegistry,
  type ConversationDeletionLease,
  type ConversationLease,
  type ConversationLeaseWaitOptions,
  type ProjectStoreHandle,
} from "./project-store.js";
import type { SerialTaskQueue } from "./serial-task-queue.js";
import {
  RoleCatalog,
  type RoleCatalogModel,
} from "./role-catalog.js";

const RUN_A = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";

function getRoleTemplate(catalog: RoleCatalog, roleId: string): RoleTemplate {
  const role = catalog.listRoles().find(({ id }) => id === roleId);
  if (role === undefined) throw new Error(`Role not found: ${roleId}`);
  return role;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function agentMessage(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function automaticTitleMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "model-a",
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
  };
}

type SessionBehavior = (control: FakeSessionControl) => Promise<void>;

interface ReceivedCustomMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
  triggerTurn: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

function fakeSettings(): SettingsManager {
  return {
    applyOverrides: () => undefined,
    flush: async () => undefined,
    drainErrors: () => [],
  } as unknown as SettingsManager;
}

class FakeSessionControl {
  readonly received: ReceivedCustomMessage[] = [];
  readonly promptTexts: string[] = [];
  readonly steerTexts: string[] = [];
  steerImplementation: (text: string) => Promise<void> | void = () => undefined;
  readonly behaviors: SessionBehavior[] = [];
  readonly continuationBehaviors: SessionBehavior[] = [];
  readonly pendingSteers: ReceivedCustomMessage[] = [];
  readonly modelRequestCustomMessages: ReceivedCustomMessage[][] = [];
  steerContinuationCalls = 0;
  abortCalls = 0;
  disposeCalls = 0;
  skipNextCustomMessagePersistence = false;
  /**
   * Real text steering queue mirroring the SDK; admissions must verify a
   * queue entry actually appeared. Raw deliveries never drain it in the fake
   * (the actor only reads length/indices), matching the SDK's append order.
   */
  readonly steeringMessages: string[] = [];
  /** Exact user message objects queued at the simulated SDK steering boundary. */
  readonly steeringAgentMessages: AgentMessage[] = [];
  /** Simulated SDK preflight result for busy browser steer prompts. */
  steerPromptPreflightResult?: boolean;
  /** Simulated SDK queued text (may differ from the submitted prompt text). */
  steerPromptExpandedText?: string;
  /** Simulated SDK queued text for steers (may differ from the submitted text). */
  steerExpandedText?: string;
  /** Simulated extension-handled input: preflight true but NO queue entry. */
  steerPromptHandled?: boolean;
  /** Simulated input-extension handlers (admission precheck). */
  hasInputExtensionHandlers?: boolean;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  listener?: (event: AgentSessionEvent) => void;
  abortCurrent?: () => void;
  readonly session: AgentSession;

  constructor(
    readonly manager: SessionManager,
    readonly options: CreatePiSessionOptions,
    initialBehaviors: SessionBehavior[],
  ) {
    this.behaviors.push(...initialBehaviors);
    const control = this;
    const messages = manager.buildSessionContext().messages;
    this.session = {
      isStreaming: false,
      messages,
      agent: {
        state: {
          messages,
        },
      },
      model: options.model === undefined
        ? { provider: "test", id: "model-a" }
        : { ...options.model },
      thinkingLevel: options.thinkingLevel ?? "off",
      setThinkingLevel: (level: Parameters<AgentSession["setThinkingLevel"]>[0]) => {
        control.session.agent.state.thinkingLevel = level;
        Object.assign(control.session, { thinkingLevel: level });
        control.manager.appendThinkingLevelChange(level);
      },
      extensionRunner: {
        getCommand: () => undefined,
      },
      prompt: async (
        text: string,
        options?: {
          streamingBehavior?: "steer" | "followUp";
          preflightResult?: (ok: boolean) => void;
        },
      ) => {
        control.promptTexts.push(text);
        if (options?.streamingBehavior === "steer") {
          // Busy browser prompts queue into the SDK steering queue; they do
          // not start a turn. The raw user message_end arrives later via
          // emitUserMessage. Mirror the SDK: queue first, then preflight.
          const ok = control.steerPromptPreflightResult ?? true;
          if (ok && !control.steerPromptHandled) {
            const queuedText = control.steerPromptExpandedText ?? text;
            control.steeringMessages.push(queuedText);
            control.steeringAgentMessages.push(agentMessage({
              role: "user",
              content: queuedText,
              timestamp: Date.now(),
            }));
          }
          options.preflightResult?.(ok);
          return;
        }
        await control.runNext();
      },
      getSteeringMessages: () => control.steeringMessages.slice(),
      hasExtensionHandlers: (eventType: string) =>
        eventType === "input" && control.hasInputExtensionHandlers === true,
      steer: (text: string) => {
        control.steerTexts.push(text);
        const result = control.steerImplementation(text);
        const queuedText = control.steerExpandedText ?? text;
        control.steeringMessages.push(queuedText);
        control.steeringAgentMessages.push(agentMessage({
          role: "user",
          content: queuedText,
          timestamp: Date.now(),
        }));
        return result;
      },
      clearQueue: () => {
        control.pendingSteers.splice(0);
        control.steeringMessages.splice(0);
        control.steeringAgentMessages.splice(0);
      },
      sendCustomMessage: async (
        message: Parameters<AgentSession["sendCustomMessage"]>[0],
        sendOptions: Parameters<AgentSession["sendCustomMessage"]>[1],
      ) => {
        const received = {
          customType: message.customType,
          content: String(message.content),
          display: message.display,
          details: message.details,
          triggerTurn: sendOptions?.triggerTurn === true,
          deliverAs: sendOptions?.deliverAs,
        };
        control.received.push(received);
        if (
          received.deliverAs === "steer"
          && control.session.isStreaming
          && sendOptions?.triggerTurn !== false
        ) {
          control.pendingSteers.push(received);
          return;
        }
        control.persistCustomMessage(received);
        if (received.triggerTurn) await control.runNext();
      },
      abort: async () => {
        control.abortCalls++;
        control.abortCurrent?.();
      },
      dispose: () => {
        control.disposeCalls++;
      },
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        control.listener = listener;
        return () => {
          if (control.listener === listener) control.listener = undefined;
        };
      },
      setSessionName: (name: string) => {
        control.manager.appendSessionInfo(name);
      },
      getContextUsage: () => control.contextUsage,
    } as unknown as AgentSession;
  }

  enqueue(...behaviors: SessionBehavior[]): void {
    this.behaviors.push(...behaviors);
  }

  enqueueContinuation(...behaviors: SessionBehavior[]): void {
    this.continuationBehaviors.push(...behaviors);
  }

  emitUserMessage(text: string): void {
    const queuedIndex = this.steeringAgentMessages.findIndex((message) =>
      message.role === "user" && message.content === text
    );
    const message = queuedIndex < 0
      ? agentMessage({
          role: "user",
          content: text,
          timestamp: Date.now(),
        })
      : this.steeringAgentMessages.splice(queuedIndex, 1)[0]!;
    this.manager.appendMessage(message);
    this.listener?.({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
  }

  emitFinal(text: string): void {
    this.listener?.({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
      },
    } as unknown as AgentSessionEvent);
    this.listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
      },
    } as unknown as AgentSessionEvent);
  }

  emitAssistantUsage(
    input: number,
    cacheRead: number,
    cacheWrite: number,
  ): void {
    this.listener?.({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "toolUse",
        usage: {
          input,
          output: 1,
          cacheRead,
          cacheWrite,
          totalTokens: input + cacheRead + cacheWrite + 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    } as unknown as AgentSessionEvent);
  }

  beginNextModelTurn(): void {
    this.consumePendingSteers();
  }

  emitTextDelta(delta: string): void {
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    } as unknown as AgentSessionEvent);
  }

  private persistCustomMessage(message: ReceivedCustomMessage): void {
    if (this.skipNextCustomMessagePersistence) {
      this.skipNextCustomMessagePersistence = false;
      return;
    }
    this.manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
  }

  private consumePendingSteers(): boolean {
    const pending = this.pendingSteers.splice(0);
    if (pending.length === 0) return false;
    this.steerContinuationCalls++;
    this.modelRequestCustomMessages.push(pending);
    for (const message of pending) this.persistCustomMessage(message);
    return true;
  }

  private async runNext(): Promise<void> {
    const behavior = this.behaviors.shift() ?? completesWith("ok");
    const session = this.session as unknown as { isStreaming: boolean };
    const wasStreaming = session.isStreaming;
    session.isStreaming = true;
    this.listener?.({ type: "agent_start" } as AgentSessionEvent);
    try {
      await behavior(this);
      while (this.consumePendingSteers()) {
        const continuation = this.continuationBehaviors.shift();
        if (continuation) await continuation(this);
      }
    } finally {
      session.isStreaming = wasStreaming;
      this.listener?.({ type: "agent_end", messages: [] } as AgentSessionEvent);
    }
  }
}

function completesWith(text: string): SessionBehavior {
  return async (control) => {
    control.emitFinal(text);
  };
}

function failsWith(message: string): SessionBehavior {
  return async () => {
    throw new Error(message);
  };
}

function blocksUntil(
  started: Deferred<void>,
  release: Deferred<void>,
  finalText = "released",
): SessionBehavior {
  return async (control) => {
    started.resolve();
    control.abortCurrent = () => release.resolve();
    try {
      await release.promise;
      control.emitFinal(finalText);
    } finally {
      control.abortCurrent = undefined;
    }
  };
}

class FakeRuntime implements PiRuntimeLike {
  readonly credentialStore = new InMemoryCredentialStore();
  titleImplementation: ModelRuntime["completeSimple"] = async () =>
    automaticTitleMessage("测试任务");
  readonly titleCalls: Array<Parameters<ModelRuntime["completeSimple"]>> = [];
  readonly modelRuntime = {
    completeSimple: (...args: Parameters<ModelRuntime["completeSimple"]>) => {
      this.titleCalls.push(args);
      return this.titleImplementation(...args);
    },
  } as unknown as ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  sessionModelRegistry?: ModelRegistry;
  projectModelRegistry?: ModelRegistry;
  readonly controls = new Map<string, FakeSessionControl>();
  readonly createOptions = new Map<string, CreatePiSessionOptions>();
  readonly modelListeners = new Set<() => void>();
  readonly createConversationIds: string[] = [];
  readonly availableModels: RoleCatalogModel[] = [
    { provider: "test", id: "model-a", reasoning: true },
    { provider: "test", id: "model-b", reasoning: true },
  ];
  readonly nextSessionBehaviors: SessionBehavior[][] = [];
  projectCatalogCreations = 0;
  projectCatalogDisposals = 0;
  beforeCreateSession?: (
    conversationId: string,
    options: CreatePiSessionOptions,
  ) => Promise<void>;
  beforeCreateProjectModelCatalog?: () => Promise<void>;
  beforeDisposeProjectModelCatalog?: () => Promise<void>;
  beforeDisposeSession?: (
    conversationId: string,
    control: FakeSessionControl,
  ) => Promise<void> | void;
  activateSession?: (
    conversationId: string,
    options: CreatePiSessionOptions,
  ) => Promise<void>;

  constructor() {
    this.modelRegistry = {
      getAvailable: () => this.availableModels,
    } as unknown as ModelRegistry;
  }

  async createProjectModelCatalog() {
    this.projectCatalogCreations++;
    await this.beforeCreateProjectModelCatalog?.();
    let disposed = false;
    return {
      modelRuntime: this.modelRuntime,
      modelRegistry: this.projectModelRegistry ?? this.modelRegistry,
      dynamicProviderNames: () => new Set<string>(),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.beforeDisposeProjectModelCatalog?.();
        this.projectCatalogDisposals++;
      },
    };
  }

  async createSession(
    _cwd: string,
    options: CreatePiSessionOptions = {},
  ): Promise<CreatedPiSession> {
    if (!options.sessionManager) {
      throw new Error("test runtime requires a session manager");
    }
    const conversationId = options.sessionManager.getSessionId();
    this.createConversationIds.push(conversationId);
    await this.beforeCreateSession?.(conversationId, options);
    const control = new FakeSessionControl(
      options.sessionManager,
      options,
      this.nextSessionBehaviors.shift() ?? [],
    );
    this.controls.set(conversationId, control);
    this.createOptions.set(conversationId, options);
    return {
      session: control.session,
      settings: fakeSettings(),
      modelRuntime: this.modelRuntime,
      modelRegistry: this.sessionModelRegistry ?? this.modelRegistry,
      captureSteeringMessage: (operation) => {
        const before = control.steeringAgentMessages.length;
        const result = operation();
        const message = control.steeringAgentMessages[before];
        return {
          result,
          ...(message === undefined ? {} : { message }),
        };
      },
      activateExtensions: () =>
        this.activateSession?.(conversationId, options)
        ?? Promise.resolve(),
      activateExtensionErrors: (
        _handler: (error: ExtensionError) => void,
      ) => [],
      dynamicProviderNames: () => new Set(),
      dispose: async () => {
        await this.beforeDisposeSession?.(conversationId, control);
        control.session.dispose();
      },
    };
  }

  beginCredentialChange(provider: string): CredentialChangeIntent {
    return { provider, revision: 1 };
  }

  async commitCredentialChange(
    _intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    await change();
    return true;
  }

  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    return Promise.resolve().then(change);
  }

  refreshConfiguration(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(listener: () => void): () => void {
    this.modelListeners.add(listener);
    return () => this.modelListeners.delete(listener);
  }

  control(conversationId: string): FakeSessionControl {
    const control = this.controls.get(conversationId);
    if (!control) {
      throw new Error(`Missing fake session control: ${conversationId}`);
    }
    return control;
  }
}

interface ToolResult {
  details: unknown;
}

async function executeTool(
  control: FakeSessionControl,
  name: string,
  toolCallId: string,
  input: unknown,
  signal?: AbortSignal,
  options: { omitSingleWaitCommitment?: boolean } = {},
): Promise<unknown> {
  const tool = control.options.workbenchCustomTools?.find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`Missing tool ${name}`);
  const executable = tool as ToolDefinition & {
    execute(
      toolCallId: string,
      input: unknown,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: unknown,
    ): Promise<ToolResult>;
  };
  const exactWaitInput = name === "wait_for_session"
    && typeof input === "object"
    && input !== null
    && !Array.isArray(input)
    && "conversationId" in input
    && !("targets" in input)
    && !("singleWaitCommitment" in input)
    && !options.omitSingleWaitCommitment;
  const normalizedInput = exactWaitInput
    ? {
        ...input,
        singleWaitCommitment:
          "This exact result is on the test's critical path and no independent local work remains.",
      }
    : input;
  const result = await executable.execute(
    toolCallId,
    normalizedInput,
    signal,
    undefined,
    {},
  );
  return result.details;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

interface Fixture {
  cwd: string;
  runtime: FakeRuntime;
  roles: RoleCatalog;
  registry: ProjectStoreRegistry;
  coordinator: ProjectSessionCoordinator;
  handle: Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>;
}

function coordinatorInbox(
  handle: Awaited<ReturnType<ProjectSessionCoordinator["acquireProject"]>>,
): ProjectInbox {
  return (handle as unknown as {
    context: { inbox: ProjectInbox };
  }).context.inbox;
}

const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];

async function createFixture(
  registry: ProjectStoreRegistry = new ProjectStoreRegistry(),
  runtime: FakeRuntime = new FakeRuntime(),
): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "piweb-session-coordinator-"));
  temporaryDirectories.push(cwd);
  const roles = await RoleCatalog.open(
    runtime,
    join(cwd, "user", "roles.json"),
  );
  const defaultRole = getRoleTemplate(roles, "default");
  await roles.updateRole(
    "default",
    defaultRole.revision,
    defaultRole.systemPrompt,
    {
      name: defaultRole.name,
      description: defaultRole.description,
      systemPrompt: defaultRole.systemPrompt,
      model: defaultRole.model,
      defaultThinkingLevel: defaultRole.defaultThinkingLevel,
      defaultServiceTier: defaultRole.defaultServiceTier,
      toolMode: "full_access",
      canManageSessions: true,
    },
  );
  const coordinator = new ProjectSessionCoordinator(
    runtime,
    roles,
    registry,
  );
  const handle = await coordinator.acquireProject(cwd, "full_access");
  const fixture = {
    cwd,
    runtime,
    roles,
    registry,
    coordinator,
    handle,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.coordinator.close().catch(() => undefined);
    fixture.roles.dispose();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function defaultProfile(
  roles: RoleCatalog,
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  return {
    role: roles.getConversationRole("default"),
    lifecycle: { kind: "normal" },
    createdBy: { kind: "user" },
    ...overrides,
  };
}

function startInput(
  overrides: Partial<StartPeerSessionInput> = {},
): StartPeerSessionInput {
  return {
    roleId: "default",
    task: "Review the coordinator",
    temporary: false,
    idempotencyKey: "stable-start-key",
    ...overrides,
  };
}

function deterministicTestUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(value)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

describe("ProjectSessionCoordinator", () => {
  it("prepares bounded cold history and role without executable resources", async () => {
    const fixture = await createFixture();
    const conversationId = randomUUID();
    const manager = await fixture.handle.project.createConversation(
      conversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    for (let index = 0; index < 12; index += 1) {
      manager.appendMessage(agentMessage({
        role: "user",
        content: `${index}:${"x".repeat(80_000)}`,
        timestamp: index,
      }));
    }
    const acquireWriter = vi.spyOn(
      fixture.registry,
      "acquireConversationWhenAvailable",
    );

    const presentation = await fixture.coordinator
      .prepareConversationPresentation(fixture.handle, conversationId);

    expect(presentation).toMatchObject({
      cwd: fixture.cwd,
      toolMode: "full_access",
      role: expect.objectContaining({
        id: "default",
        toolMode: "full_access",
      }),
      window: {
        omittedBefore: true,
        startsMidTurn: false,
        contentTruncated: true,
      },
    });
    expect(presentation?.items.at(-1)).toMatchObject({
      kind: "message",
      role: "user",
      text: expect.stringMatching(/^11:/),
    });
    expect(acquireWriter).not.toHaveBeenCalled();
    expect(fixture.runtime.createConversationIds).toEqual([]);
    expect(fixture.runtime.projectCatalogCreations).toBe(0);
  });

  it("skips disk presentation for warm/opening actors and aborts stale reads", async () => {
    const fixture = await createFixture();
    const warm = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const inspect = vi.spyOn(
      fixture.handle.project,
      "inspectConversationPresentation",
    );

    await expect(fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      warm.conversationId,
    )).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();

    const openingId = randomUUID();
    await fixture.handle.project.createConversation(
      openingId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    const actorOpeningStarted = deferred();
    const releaseActorOpening = deferred();
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId !== openingId) return;
      actorOpeningStarted.resolve();
      await releaseActorOpening.promise;
    };
    const actorOpening = fixture.coordinator.openConversation(
      fixture.handle,
      openingId,
      { updateRecent: false },
    );
    await actorOpeningStarted.promise;
    await expect(fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      openingId,
    )).resolves.toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    releaseActorOpening.resolve();
    await actorOpening;
    fixture.runtime.beforeCreateSession = undefined;

    const coldId = randomUUID();
    await fixture.handle.project.createConversation(
      coldId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    const inspectionCompleted = deferred();
    const inspectConversationPresentation = fixture.handle.project
      .inspectConversationPresentation.bind(fixture.handle.project);
    inspect.mockImplementationOnce(async (conversationId) => {
      inspectionStarted.resolve();
      await releaseInspection.promise;
      const result = await inspectConversationPresentation(conversationId);
      inspectionCompleted.resolve();
      return result;
    });
    const controller = new AbortController();
    const preparing = fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      coldId,
      controller.signal,
    );
    await inspectionStarted.promise;
    controller.abort();

    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    releaseInspection.resolve();
    await inspectionCompleted.promise;
    expect(fixture.runtime.createConversationIds).toEqual([
      warm.conversationId,
      openingId,
    ]);
  });

  it("cancels only the caller wait while a shared actor opening completes", async () => {
    const fixture = await createFixture();
    const conversationId = randomUUID();
    await fixture.handle.project.createConversation(
      conversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    const openingStarted = deferred();
    const releaseOpening = deferred();
    fixture.runtime.beforeCreateSession = async (id) => {
      if (id !== conversationId) return;
      openingStarted.resolve();
      await releaseOpening.promise;
    };
    const controller = new AbortController();
    const cancelled = fixture.coordinator.openConversation(
      fixture.handle,
      conversationId,
      { updateRecent: false, signal: controller.signal },
    );
    await openingStarted.promise;
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const shared = fixture.coordinator.openConversation(
      fixture.handle,
      conversationId,
      { updateRecent: false },
    );
    releaseOpening.resolve();
    const actor = await shared;

    expect(actor.conversationId).toBe(conversationId);
    expect(fixture.runtime.createConversationIds).toEqual([conversationId]);
  });

  it("skips projection failures but propagates presentation integrity failures", async () => {
    const fixture = await createFixture();
    const conversationId = randomUUID();
    await fixture.handle.project.createConversation(
      conversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    const inspected = await fixture.handle.project
      .inspectConversationPresentation(conversationId);
    const brokenEntry = new Proxy(inspected.entries[0]!, {
      get(target, property, receiver) {
        if (property === "type") throw new Error("projection failed");
        return Reflect.get(target, property, receiver);
      },
    });
    const inspect = vi.spyOn(
      fixture.handle.project,
      "inspectConversationPresentation",
    );
    inspect.mockResolvedValueOnce({
      ...inspected,
      entries: [brokenEntry],
    });

    await expect(fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      conversationId,
    )).resolves.toBeUndefined();

    inspect.mockRejectedValueOnce(new Error("integrity proof failed"));
    await expect(fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      conversationId,
    )).rejects.toThrow("integrity proof failed");
  });

  it("rechecks actor openings synchronously before publishing a prepared presentation", async () => {
    const fixture = await createFixture();
    const conversationId = randomUUID();
    await fixture.handle.project.createConversation(
      conversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    await expect(fixture.coordinator.prepareConversationPresentation(
      fixture.handle,
      conversationId,
    )).resolves.toBeDefined();
    expect(fixture.coordinator.canPublishConversationPresentation(
      fixture.handle,
      conversationId,
    )).toBe(true);

    const openingStarted = deferred();
    const releaseOpening = deferred();
    fixture.runtime.beforeCreateSession = async (id) => {
      if (id !== conversationId) return;
      openingStarted.resolve();
      await releaseOpening.promise;
    };
    const opening = fixture.coordinator.openConversation(
      fixture.handle,
      conversationId,
      { updateRecent: false },
    );
    expect(fixture.coordinator.canPublishConversationPresentation(
      fixture.handle,
      conversationId,
    )).toBe(false);
    await openingStarted.promise;
    releaseOpening.resolve();
    await opening;
  });

  it("starts focus recent writes immediately and orders a later awaited open behind them", async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "first" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "second" },
    );
    const firstActor = await fixture.coordinator.openConversation(
      fixture.handle,
      first.conversationId,
      { updateRecent: false },
    );
    await fixture.coordinator.openConversation(
      fixture.handle,
      second.conversationId,
      { updateRecent: false },
    );
    const gate = deferred();
    let firstWriteStarted = false;
    const store = fixture.handle.project as unknown as {
      enqueueWrite(task: () => Promise<void>): Promise<void>;
    };
    const persistWrite = store.enqueueWrite.bind(store);
    let firstWrite = true;
    const enqueueWrite = vi.spyOn(store, "enqueueWrite")
      .mockImplementation((task) => {
        if (firstWrite) {
          firstWrite = false;
          return persistWrite(async () => {
            firstWriteStarted = true;
            await gate.promise;
            await task();
          });
        }
        return persistWrite(task);
      });

    const firstRecent = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      firstActor,
    );
    await waitUntil(() => firstWriteStarted, "the immediate focus recent write");
    let secondOpenSettled = false;
    const secondOpen = fixture.coordinator.openConversation(
      fixture.handle,
      second.conversationId,
    ).then(() => {
      secondOpenSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondOpenSettled).toBe(false);

    gate.resolve();
    await expect(firstRecent).resolves.toBeUndefined();
    await expect(secondOpen).resolves.toBeUndefined();
    expect(fixture.handle.project.lastConversationId).toBe(
      second.conversationId,
    );
    enqueueWrite.mockRestore();
  });

  it("serializes background recent focus updates in focus order", async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "first" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "second" },
    );
    const firstActor = await fixture.coordinator.openConversation(
      fixture.handle,
      first.conversationId,
      { updateRecent: false },
    );
    const secondActor = await fixture.coordinator.openConversation(
      fixture.handle,
      second.conversationId,
      { updateRecent: false },
    );
    const writes: string[] = [];
    const persistRecent = fixture.handle.project.setLastConversation.bind(
      fixture.handle.project,
    );
    const setLastConversation = vi.spyOn(
      fixture.handle.project,
      "setLastConversation",
    ).mockImplementation(async (conversationId) => {
      writes.push(conversationId);
      await persistRecent(conversationId);
    });

    const firstWrite = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      firstActor,
    );
    const secondWrite = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      secondActor,
    );
    const firstWriteAgain = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      firstActor,
    );
    await Promise.all([firstWrite, secondWrite, firstWriteAgain]);

    expect(writes).toEqual([
      first.conversationId,
      second.conversationId,
      first.conversationId,
    ]);
    expect(fixture.handle.project.lastConversationId).toBe(
      first.conversationId,
    );
    setLastConversation.mockRestore();
  });

  it("drains a pending background recent focus update during close", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const gate = deferred();
    let started = false;
    const setLastConversation = vi.spyOn(
      fixture.handle.project,
      "setLastConversation",
    ).mockImplementation(async () => {
      started = true;
      await gate.promise;
    });

    const recent = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      actor,
    );
    await waitUntil(() => started, "background recent write");
    let closed = false;
    const closing = fixture.coordinator.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    gate.resolve();
    await expect(recent).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(closed).toBe(true);
    setLastConversation.mockRestore();
  });

  it("does not let a delayed recent write clear newer attention", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const gate = deferred();
    let started = false;
    const setLastConversation = vi.spyOn(
      fixture.handle.project,
      "setLastConversation",
    ).mockImplementation(async () => {
      started = true;
      await gate.promise;
    });

    fixture.handle.context.attention.add(actor.conversationId);
    const recent = fixture.coordinator.markConversationRecentInBackground(
      fixture.handle,
      actor,
    );
    try {
      await waitUntil(() => started, "background recent write");
      expect(fixture.handle.context.attention.has(actor.conversationId)).toBe(false);

      fixture.handle.context.attention.add(actor.conversationId);
      gate.resolve();
      await expect(recent).resolves.toBeUndefined();
      expect(fixture.handle.context.attention.has(actor.conversationId)).toBe(true);
    } finally {
      gate.resolve();
      await recent.catch(() => undefined);
      setLastConversation.mockRestore();
    }
  });

  it("migrates legacy queued pending prompts on reopen and drops attention records", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const conversationId = actor.conversationId;
    await fixture.coordinator.close();

    const queueDir = join(fixture.cwd, ".piweb", "pending-prompts");
    await mkdir(queueDir, { recursive: true });
    const queuedId = randomUUID();
    await writeFile(
      join(queueDir, `${queuedId}.json`),
      JSON.stringify({
        version: 1,
        promptId: queuedId,
        conversationId,
        text: "legacy queued message",
        createdAt: "2026-07-01T10:00:00.000Z",
        state: "queued",
      }),
    );
    const attentionId = randomUUID();
    await writeFile(
      join(queueDir, `${attentionId}.json`),
      JSON.stringify({
        version: 1,
        promptId: attentionId,
        conversationId,
        text: "legacy attention message",
        createdAt: "2026-07-01T10:01:00.000Z",
        state: "attention",
        reason: "uncertain delivery",
      }),
    );
    await writeFile(
      join(queueDir, "corrupt.json"),
      "{not-json",
    );

    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixture.coordinator = restarted;
    fixture.handle = restartedHandle;

    await waitUntil(
      () => fixture.runtime.control(conversationId)
        .promptTexts.includes("legacy queued message"),
      "legacy queued message redelivery",
    );
    expect(fixture.runtime.control(conversationId).promptTexts)
      .not.toContain("legacy attention message");
    await waitUntil(
      async () => {
        try {
          await readdir(queueDir);
          return false;
        } catch {
          return true;
        }
      },
      "legacy queue directory removal",
    );
  });

  it("acknowledges a first browser prompt before its automatic title finishes", async () => {
    const fixture = await createFixture();
    const titleResult = deferred<AssistantMessage>();
    fixture.runtime.titleImplementation = async () => titleResult.promise;
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    let persistedAtAcknowledgement: Promise<boolean> | undefined;
    actor.subscribe((event) => {
      if (
        event.type === "session_event"
        && event.event.type === "run_queued"
      ) {
        persistedAtAcknowledgement = fixture.handle.project
          .hasPersistedConversationNameIntent(
            actor.conversationId,
            actor.sessionManager.getSessionFile(),
          );
      }
    });
    fixture.runtime.control(actor.conversationId).enqueue(
      completesWith("done"),
    );

    const running = fixture.coordinator.prompt(
      fixture.handle,
      actor.conversationId,
      randomUUID(),
      "实现新会话首次运行前自动命名",
    );

    await vi.waitFor(() => expect(fixture.runtime.titleCalls).toHaveLength(1));
    expect(fixture.runtime.titleCalls[0]?.[1]).toMatchObject({
      messages: [{
        role: "user",
        content: "实现新会话首次运行前自动命名",
      }],
    });
    expect(persistedAtAcknowledgement).toBeDefined();
    await expect(persistedAtAcknowledgement).resolves.toBe(false);
    expect(fixture.runtime.control(actor.conversationId).promptTexts).toEqual([]);

    titleResult.resolve(automaticTitleMessage("自动生成标题"));
    await running;
    expect(actor.sessionManager.getSessionName()).toBe("自动生成标题");
    await waitUntil(
      () => fixture.handle.project.listConversations()
        .find(({ id }) => id === actor.conversationId)?.name === "自动生成标题",
      "the automatic title catalog projection",
    );

    const explicitlyNamed = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "人工标题" },
    );
    await fixture.coordinator.prompt(
      fixture.handle,
      explicitlyNamed.conversationId,
      randomUUID(),
      "保留人工标题",
    );
    expect(fixture.runtime.titleCalls).toHaveLength(1);
    expect(explicitlyNamed.sessionManager.getSessionName()).toBe("人工标题");
  });

  it("does not rescan project activity for streaming session deltas", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(actor.conversationId).enqueue(
      blocksUntil(started, release),
    );
    const run = fixture.coordinator.prompt(
      fixture.handle,
      actor.conversationId,
      randomUUID(),
      "stream without rescanning the global project catalog",
    );
    await started.promise;
    const internals = fixture.coordinator as unknown as {
      projectActivitySummary(context: unknown): unknown;
    };
    const summary = vi.spyOn(internals, "projectActivitySummary");

    fixture.runtime.control(actor.conversationId).emitTextDelta("delta");

    expect(summary).not.toHaveBeenCalled();
    release.resolve();
    await run;
  });

  it("bounds the global activity catalog and prioritizes actionable projects", async () => {
    const fixture = await createFixture();
    const internals = fixture.coordinator as unknown as {
      updateProjectActivitySummary(
        key: string,
        summary: ProjectActivitySummary,
        touchCatalog?: boolean,
      ): boolean;
    };
    for (let index = 0; index < 101; index++) {
      internals.updateProjectActivitySummary(`project-${index}`, {
        projectId: `project-${index}`,
        cwd: `E:\\project-${index.toString().padStart(3, "0")}`,
        busyConversationCount: index === 100 ? 1 : 0,
        attentionConversationCount: index === 99 ? 1 : 0,
      });
    }

    const snapshot = fixture.coordinator.projectActivitySnapshot();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.projects).toHaveLength(100);
    expect(snapshot.projects[0]).toMatchObject({
      projectId: "project-100",
      busyConversationCount: 1,
    });
    expect(snapshot.projects[1]).toMatchObject({
      projectId: "project-99",
      attentionConversationCount: 1,
    });

    const omitted = {
      projectId: "project-0",
      cwd: "E:\\project-000",
      busyConversationCount: 0,
      attentionConversationCount: 0,
    };
    expect(snapshot.projects).not.toContainEqual(omitted);
    expect(internals.updateProjectActivitySummary(
      "project-0",
      omitted,
      true,
    )).toBe(true);
    expect(fixture.coordinator.projectActivitySnapshot().projects)
      .toContainEqual(omitted);
  });

  it("singleflights concurrent acquireProject calls for the same canonical cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-project-singleflight-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const registry = new ConcurrentProjectOpenRegistry();
    const coordinator = new ProjectSessionCoordinator(
      runtime,
      roles,
      registry,
    );
    let handles: Awaited<
      ReturnType<ProjectSessionCoordinator["acquireProject"]>
    >[] = [];
    try {
      const acquisitions = [
        coordinator.acquireProject(cwd, "full_access"),
        coordinator.acquireProject(cwd, "full_access"),
      ];
      await registry.firstAcquireStarted.promise;
      await waitUntil(
        () => registry.acquireCalls >= 2,
        "a second registry acquire in the vulnerable implementation",
        100,
      ).catch(() => undefined);
      registry.releaseAcquires.resolve();
      handles = await Promise.all(acquisitions);
      const contexts = handles.map((handle) =>
        (handle as unknown as { context: object }).context
      );

      expect(contexts[0]).toBe(contexts[1]);
      await expect(coordinator.listSessions(handles[0]!)).resolves.toEqual([]);
      await expect(coordinator.listSessions(handles[1]!)).resolves.toEqual([]);
    } finally {
      registry.releaseAcquires.resolve();
      for (const handle of handles) handle.release();
      await coordinator.close().catch(() => undefined);
      for (const handle of handles) {
        const context = (handle as unknown as {
          context: { projectHandle: ProjectStoreHandle };
        }).context;
        context.projectHandle.release();
      }
      roles.dispose();
    }
  });

  it("keeps close behind a project acquisition that started before shutdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-project-close-acquire-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const registry = new ConcurrentProjectOpenRegistry();
    const coordinator = new ProjectSessionCoordinator(
      runtime,
      roles,
      registry,
    );
    try {
      const acquisition = coordinator.acquireProject(cwd, "full_access");
      await registry.firstAcquireStarted.promise;
      let closeSettled = false;
      const closing = coordinator.close().finally(() => {
        closeSettled = true;
      });

      await Promise.resolve();
      expect(closeSettled).toBe(false);
      registry.releaseAcquires.resolve();

      await expect(acquisition).rejects.toThrow(
        "Project session coordinator is closed",
      );
      await expect(closing).resolves.toBeUndefined();
      expect(registry.releaseCalls).toBe(1);
    } finally {
      registry.releaseAcquires.resolve();
      await coordinator.close().catch(() => undefined);
      roles.dispose();
    }
  });

  it("rejects and drains a queued start_session without mutating after shutdown begins", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const input = startInput({
      task: "finish the accepted delegation before shutdown",
      idempotencyKey: "close-after-accepted-start",
    });

    const starting = fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    );
    const closing = fixture.coordinator.close();

    await expect(starting).rejects.toThrow(/closed|closing/i);
    await expect(closing).resolves.toBeUndefined();
    const card = aggregateReservedConversationEntries(
      source.sessionManager.getEntries(),
    ).cards.find(({ body }) => body === input.task);
    expect(card).toBeUndefined();
  });

  it("keeps a project model catalog singleflight after one caller cancels", async () => {
    const fixture = await createFixture();
    const catalogRegistry = {
      getAvailable: () => [{ provider: "project", id: "catalog" }],
    } as unknown as ModelRegistry;
    fixture.runtime.projectModelRegistry = catalogRegistry;
    const started = deferred();
    const release = deferred();
    fixture.runtime.beforeCreateProjectModelCatalog = async () => {
      started.resolve();
      await release.promise;
    };
    const controller = new AbortController();

    const cancelled = fixture.coordinator.ensureProjectModelCatalog(
      fixture.handle,
      undefined,
      controller.signal,
    );
    await started.promise;
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const shared = fixture.coordinator.ensureProjectModelCatalog(fixture.handle);
    expect(fixture.runtime.projectCatalogCreations).toBe(1);
    release.resolve();
    await expect(shared).resolves.toBe(catalogRegistry);
    expect(
      fixture.coordinator.modelRegistryForProject(fixture.handle),
    ).toBe(catalogRegistry);

    await fixture.coordinator.close();
    expect(fixture.runtime.projectCatalogDisposals).toBe(1);
  });

  it("prefers a live actor registry and falls back to the project catalog", async () => {
    const fixture = await createFixture();
    const catalogRegistry = {
      getAvailable: () => [
        { provider: "test", id: "model-a" },
        { provider: "project", id: "catalog" },
      ],
    } as unknown as ModelRegistry;
    const actorRegistry = {
      getAvailable: () => [
        { provider: "test", id: "model-a" },
        { provider: "project", id: "actor" },
      ],
    } as unknown as ModelRegistry;
    fixture.runtime.projectModelRegistry = catalogRegistry;
    fixture.runtime.sessionModelRegistry = actorRegistry;
    await fixture.coordinator.ensureProjectModelCatalog(fixture.handle);

    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    expect(
      fixture.coordinator.modelRegistryForProject(fixture.handle),
    ).toBe(actorRegistry);

    await expect(fixture.coordinator.deleteConversation(
      fixture.handle,
      actor.conversationId,
    )).resolves.toBe(true);
    expect(
      fixture.coordinator.modelRegistryForProject(fixture.handle),
    ).toBe(catalogRegistry);
  });

  it("rewinds the live actor and durable session from the selected message", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const branchRootId = actor.sessionManager.getLeafId()!;
    const activeLoopListId = appendReservedCustomEntry(
      actor.sessionManager,
      createLoopListEntry({
        items: [{ id: "active", text: "Retained work", status: "active" }],
        armed: true,
        updatedAt: "2026-07-19T10:00:00.000Z",
      }),
    );
    actor.sessionManager.branch(branchRootId);
    const inactiveLoopListId = appendReservedCustomEntry(
      actor.sessionManager,
      createLoopListEntry({
        items: [{ id: "inactive", text: "Discarded branch", status: "pending" }],
        armed: true,
        updatedAt: "2026-07-19T10:01:00.000Z",
      }),
    );
    actor.sessionManager.branch(activeLoopListId);
    const retainedId = actor.sessionManager.appendMessage({
      role: "user",
      content: "retained",
      timestamp: 1,
    });
    const selectedId = actor.sessionManager.appendMessage({
      role: "user",
      content: "selected",
      timestamp: 2,
    });
    actor.sessionManager.appendMessage({
      role: "user",
      content: "later",
      timestamp: 3,
    });

    await fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      selectedId,
    );

    expect(actor.sessionManager.getEntries().map(({ id }) => id)).toEqual([
      expect.any(String),
      activeLoopListId,
      inactiveLoopListId,
      retainedId,
    ]);
    expect(actor.session.agent.state.messages).toEqual(
      actor.sessionManager.buildSessionContext().messages,
    );
    expect(actor.getLoopList()).toEqual({
      items: [{ id: "active", text: "Retained work", status: "active" }],
      armed: true,
    });
  });



  it("distinguishes a removed tier entry from a retained explicit null after rewind", async () => {
    const fixture = await createFixture();
    Object.assign(fixture.runtime.availableModels[0]!, {
      api: "openai-codex-responses",
    });
    const defaultRole = getRoleTemplate(fixture.roles, "default");
    await fixture.roles.updateRole(
      defaultRole.id,
      defaultRole.revision,
      defaultRole.systemPrompt,
      {
        name: defaultRole.name,
        description: defaultRole.description,
        systemPrompt: defaultRole.systemPrompt,
        model: defaultRole.model,
        defaultThinkingLevel: defaultRole.defaultThinkingLevel,
        defaultServiceTier: "priority",
        toolMode: defaultRole.toolMode,
        canManageSessions: defaultRole.canManageSessions,
      },
    );
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    expect(actor.getServiceTier()).toBe("priority");

    const removedNullAnchor = actor.sessionManager.appendMessage({
      role: "user",
      content: "remove the following null override",
      timestamp: 1,
    });
    actor.setServiceTier(null);
    actor.sessionManager.appendMessage({
      role: "user",
      content: "later",
      timestamp: 2,
    });
    await fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      removedNullAnchor,
    );
    expect(actor.getServiceTier()).toBe("priority");
    expect(aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    ).serviceTier).toBeUndefined();

    actor.setServiceTier(null);
    const retainedNullAnchor = actor.sessionManager.appendMessage({
      role: "user",
      content: "retain the preceding null override",
      timestamp: 3,
    });
    actor.sessionManager.appendMessage({
      role: "user",
      content: "later again",
      timestamp: 4,
    });
    await fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      retainedNullAnchor,
    );
    expect(actor.getServiceTier()).toBeNull();
    expect(aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    ).serviceTier?.tier).toBeNull();
  });

  it("serializes a service tier update after an in-flight rewind", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    Object.assign(actor.session.model!, {
      api: "openai-codex-responses",
    });
    await fixture.coordinator.setServiceTier(
      fixture.handle,
      actor.conversationId,
      "priority",
    );
    const selectedId = actor.sessionManager.appendMessage({
      role: "user",
      content: "rewind here",
      timestamp: 1,
    });
    const inbox = coordinatorInbox(fixture.handle);
    const listInbox = inbox.list.bind(inbox);
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    vi.spyOn(inbox, "list").mockImplementation(async (options) => {
      inspectionStarted.resolve();
      await releaseInspection.promise;
      return listInbox(options);
    });

    const truncating = fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      selectedId,
    );
    await inspectionStarted.promise;
    let tierSettled = false;
    const updatingTier = fixture.coordinator.setServiceTier(
      fixture.handle,
      actor.conversationId,
      null,
    ).finally(() => {
      tierSettled = true;
    });
    await Promise.resolve();
    expect(tierSettled).toBe(false);

    releaseInspection.resolve();
    await truncating;
    await updatingTier;
    expect(actor.getServiceTier()).toBeNull();
    expect(aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    ).serviceTier?.tier).toBeNull();
  });

  it("rejects a queued service tier write after deletion reservation", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    Object.assign(actor.session.model!, {
      api: "openai-codex-responses",
    });
    const context = (fixture.handle as unknown as {
      context: {
        lifecycle: SerialTaskQueue;
        deleting: Set<string>;
      };
    }).context;
    const gateStarted = deferred();
    const releaseGate = deferred();
    const gateTask = context.lifecycle.run(async () => {
      gateStarted.resolve();
      await releaseGate.promise;
    });
    await gateStarted.promise;

    const updatingTier = fixture.coordinator.setServiceTier(
      fixture.handle,
      actor.conversationId,
      "priority",
    );
    const updateRejection = expect(updatingTier).rejects.toThrow(
      `Conversation is being deleted: ${actor.conversationId}`,
    );
    const deleting = fixture.coordinator.deleteConversation(
      fixture.handle,
      actor.conversationId,
    );
    expect(context.deleting.has(actor.conversationId)).toBe(true);

    releaseGate.resolve();
    await gateTask;
    await updateRejection;
    await expect(deleting).resolves.toBe(true);
    expect(actor.getServiceTier()).toBeNull();
    expect(aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    ).serviceTier).toBeUndefined();
  });

  it("serializes threshold and thinking writes after an in-flight rewind", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const selectedId = actor.sessionManager.appendMessage({
      role: "user",
      content: "rewind here",
      timestamp: 1,
    });
    const inbox = coordinatorInbox(fixture.handle);
    const listInbox = inbox.list.bind(inbox);
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    vi.spyOn(inbox, "list").mockImplementation(async (options) => {
      inspectionStarted.resolve();
      await releaseInspection.promise;
      return listInbox(options);
    });

    const truncating = fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      selectedId,
    );
    await inspectionStarted.promise;
    let updatesSettled = false;
    const updating = Promise.all([
      fixture.coordinator.setCompactionThreshold(
        fixture.handle,
        actor.conversationId,
        55,
      ),
      fixture.coordinator.setThinkingLevel(
        fixture.handle,
        actor.conversationId,
        "high",
      ),
    ]).finally(() => {
      updatesSettled = true;
    });
    await Promise.resolve();
    expect(updatesSettled).toBe(false);

    releaseInspection.resolve();
    await truncating;
    await updating;
    expect(actor.getCompactionThresholdPercent()).toBe(55);
    expect(actor.session.thinkingLevel).toBe("high");
    const branch = actor.sessionManager.getBranch();
    expect(aggregateReservedConversationEntries(
      branch,
    ).compactionThreshold?.percent).toBe(55);
    expect(branch.at(-1)).toMatchObject({
      type: "thinking_level_change",
      thinkingLevel: "high",
    });
  });

  it("rejects queued threshold and thinking writes after deletion reservation", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const context = (fixture.handle as unknown as {
      context: {
        lifecycle: SerialTaskQueue;
        deleting: Set<string>;
      };
    }).context;
    const gateStarted = deferred();
    const releaseGate = deferred();
    const gateTask = context.lifecycle.run(async () => {
      gateStarted.resolve();
      await releaseGate.promise;
    });
    await gateStarted.promise;

    const updatingThreshold = fixture.coordinator.setCompactionThreshold(
      fixture.handle,
      actor.conversationId,
      55,
    );
    const updatingThinking = fixture.coordinator.setThinkingLevel(
      fixture.handle,
      actor.conversationId,
      "high",
    );
    const thresholdRejection = expect(updatingThreshold).rejects.toThrow(
      `Conversation is being deleted: ${actor.conversationId}`,
    );
    const thinkingRejection = expect(updatingThinking).rejects.toThrow(
      `Conversation is being deleted: ${actor.conversationId}`,
    );
    const deleting = fixture.coordinator.deleteConversation(
      fixture.handle,
      actor.conversationId,
    );
    expect(context.deleting.has(actor.conversationId)).toBe(true);

    releaseGate.resolve();
    await gateTask;
    await thresholdRejection;
    await thinkingRejection;
    await expect(deleting).resolves.toBe(true);
    expect(actor.getCompactionThresholdPercent())
      .toBe(DEFAULT_COMPACTION_THRESHOLD_PERCENT);
    expect(actor.sessionManager.getEntries()).not.toContainEqual(
      expect.objectContaining({
        type: "thinking_level_change",
        thinkingLevel: "high",
      }),
    );
  });

  it("rejects rewind while the selected conversation is running", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const selectedId = actor.sessionManager.appendMessage({
      role: "user",
      content: "do not remove while running",
      timestamp: 1,
    });
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(actor.conversationId).enqueue(
      blocksUntil(started, release),
    );
    const completion = fixture.coordinator.prompt(
      fixture.handle,
      actor.conversationId,
      randomUUID(),
      "run",
    );
    await started.promise;

    await expect(fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      selectedId,
    )).rejects.toThrow(/busy/i);
    expect(actor.sessionManager.getEntries().some(
      ({ id }) => id === selectedId,
    )).toBe(true);

    release.resolve();
    await completion;
  });

  it("settles and disposes a model catalog that finishes during close", async () => {
    const fixture = await createFixture();
    const started = deferred();
    const release = deferred();
    const disposeStarted = deferred();
    const releaseDispose = deferred();
    fixture.runtime.beforeCreateProjectModelCatalog = async () => {
      started.resolve();
      await release.promise;
    };
    fixture.runtime.beforeDisposeProjectModelCatalog = async () => {
      disposeStarted.resolve();
      await releaseDispose.promise;
    };
    const opening = fixture.coordinator.ensureProjectModelCatalog(
      fixture.handle,
    );
    await started.promise;

    let closeSettled = false;
    const closing = fixture.coordinator.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    release.resolve();
    await disposeStarted.promise;
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseDispose.resolve();

    await expect(opening).rejects.toThrow(
      "Project context closed while its model catalog was opening",
    );
    await expect(closing).resolves.toBeUndefined();
    expect(fixture.runtime.projectCatalogDisposals).toBe(1);
  });

  it("creates from an explicitly selected role and freezes its prompt/model snapshot", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Reviewer",
      description: "Reviews lifecycle code",
      systemPrompt: "Review the first revision.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });

    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: role.id, title: "First review" },
    );
    await fixture.roles.updateRole(
      role.id,
      role.revision,
      role.systemPrompt,
      {
        name: "Senior reviewer",
        description: "Reviews concurrency",
        systemPrompt: "Review the second revision.",
        model: { provider: "test", id: "model-b" },
        defaultThinkingLevel: "high",
        defaultServiceTier: null,
        toolMode: "full_access",
        canManageSessions: true,
      },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: role.id, title: "Second review" },
    );

    expect(first.profile.role).toMatchObject({
      revision: 1,
      name: "Reviewer",
      systemPrompt: "Review the first revision.",
      model: { provider: "test", id: "model-a" },
      canManageSessions: false,
    });
    expect(fixture.runtime.createOptions.get(first.conversationId)).toMatchObject({
      roleSystemPrompt: "Review the first revision.",
      model: { provider: "test", id: "model-a" },
      toolMode: "read_only",
    });
    expect(
      fixture.runtime.createOptions.get(first.conversationId)
        ?.workbenchCustomTools?.map(({ name }) => name),
    ).toEqual([
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
      "current_time",
      "list_roles",
      "read_role",
      "propose_role_revision",
      "todo_read",
      "todo_write",
      "todo_pause",
      "request_context_compaction",
    ]);
    expect(second.profile.role).toMatchObject({
      revision: 2,
      name: "Senior reviewer",
      systemPrompt: "Review the second revision.",
      model: { provider: "test", id: "model-b" },
      canManageSessions: true,
    });
    expect(fixture.runtime.createOptions.get(second.conversationId)).toMatchObject({
      toolMode: "full_access",
    });
    expect(
      fixture.runtime.createOptions.get(second.conversationId)
        ?.workbenchCustomTools?.map(({ name }) => name),
    ).toEqual([
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
      "current_time",
      "list_roles",
      "read_role",
      "propose_role_revision",
      "list_sessions",
      "current_session",
      "peek_session",
      "start_session",
      "start_temporary_session",
      "send_session_message",
      "wait_for_session",
      "abort_session",
      "delete_session",
      "todo_read",
      "todo_write",
      "todo_pause",
      "request_edit_budget",
      "request_context_compaction",
    ]);
    expect(first.profile.role).not.toEqual(second.profile.role);
  });

  it("rejects user creation before opening an unavailable default-tier role", async () => {
    const fixture = await createFixture();
    Object.assign(fixture.runtime.availableModels[0]!, {
      api: "openai-codex-responses",
    });
    const role = await fixture.roles.createRole({
      name: "Priority user role",
      description: "Becomes unavailable after route drift",
      systemPrompt: "",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: "priority",
      toolMode: "read_only",
      canManageSessions: false,
    });
    Object.assign(fixture.runtime.availableModels[0]!, {
      api: "openai-responses",
    });
    await expect(fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: role.id },
    )).rejects.toThrow("模型不支持默认服务层级：priority");
    await expect(fixture.coordinator.listSessions(fixture.handle))
      .resolves.toEqual([]);
  });

  it("switches an idle conversation to a durable role snapshot and rebuilds its runtime", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Builder",
      description: "Builds the selected change",
      systemPrompt: "Implement the requested change.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "high",
      defaultServiceTier: null,
      toolMode: "full_access",
      canManageSessions: true,
    });
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "Switch me" },
    );
    Object.assign(actor.session.model!, {
      api: "openai-codex-responses",
    });
    actor.setServiceTier("priority");
    await fixture.coordinator.setThinkingLevel(
      fixture.handle,
      actor.conversationId,
      "medium",
    );
    const previousRuntime = fixture.runtime.control(actor.conversationId);

    const switched = await fixture.coordinator.switchConversationRole(
      fixture.handle,
      actor.conversationId,
      role.id,
    );

    expect(switched).toBe(actor);
    expect(previousRuntime.disposeCalls).toBe(1);
    expect(actor.getServiceTier()).toBeNull();
    expect(actor.session.thinkingLevel).toBe("high");
    expect(actor.profile.role).toMatchObject({
      id: role.id,
      revision: role.revision,
      name: "Builder",
      model: { provider: "test", id: "model-b" },
      toolMode: "full_access",
      canManageSessions: true,
    });
    expect(fixture.runtime.createOptions.get(actor.conversationId))
      .toMatchObject({
        model: { provider: "test", id: "model-b" },
        thinkingLevel: "high",
        roleSystemPrompt: "Implement the requested change.",
      });
    expect(
      aggregateReservedConversationEntries(
        actor.sessionManager.getEntries(),
      ).conversationMeta?.role.id,
    ).toBe(role.id);
    expect(
      aggregateReservedConversationEntries(
        actor.sessionManager.getEntries(),
      ).serviceTier?.tier,
    ).toBeNull();
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === actor.conversationId)?.role?.id,
    ).toBe(role.id);
  });

  it("restores the retained role runtime and thinking level after rewind", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Builder",
      description: "Builds the selected change",
      systemPrompt: "Implement the requested change.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "high",
      defaultServiceTier: null,
      toolMode: "full_access",
      canManageSessions: true,
    });
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const rewindEntryId = actor.sessionManager.appendMessage({
      role: "user",
      content: "rewind before the role change",
      timestamp: 1,
    });
    await fixture.coordinator.switchConversationRole(
      fixture.handle,
      actor.conversationId,
      role.id,
    );
    const switchedRuntime = fixture.runtime.control(actor.conversationId);
    expect(actor.profile.role.id).toBe(role.id);
    expect(actor.session.thinkingLevel).toBe("high");
    let shutdownMutations = 0;
    fixture.runtime.beforeDisposeSession = (conversationId, control) => {
      if (
        conversationId !== actor.conversationId
        || control !== switchedRuntime
      ) return;
      shutdownMutations++;
      fixture.runtime.beforeDisposeSession = undefined;
      control.session.setThinkingLevel("medium");
    };

    await fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      rewindEntryId,
    );

    expect(switchedRuntime.disposeCalls).toBe(1);
    expect(shutdownMutations).toBe(1);
    expect(actor.profile.role.id).toBe("default");
    expect(actor.session.model?.id).toBe("model-a");
    expect(actor.session.thinkingLevel).toBe("off");
    expect(actor.sessionManager.getBranch()).not.toContainEqual(
      expect.objectContaining({
        type: "thinking_level_change",
        thinkingLevel: "medium",
      }),
    );
    expect(fixture.runtime.createOptions.get(actor.conversationId)).toMatchObject({
      model: { provider: "test", id: "model-a" },
      thinkingLevel: "off",
      toolMode: actor.profile.role.toolMode,
    });
    expect(aggregateReservedConversationEntries(
      actor.sessionManager.getBranch(),
    ).conversationMeta?.role.id).toBe("default");
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === actor.conversationId)?.role?.id,
    ).toBe("default");
  });

  it("restores the stopped runtime when durable rewind is rejected", async () => {
    const fixture = await createFixture();
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const previousRuntime = fixture.runtime.control(actor.conversationId);

    await expect(fixture.coordinator.truncateConversation(
      fixture.handle,
      actor.conversationId,
      randomUUID(),
    )).rejects.toThrow(/message not found/i);

    expect(previousRuntime.disposeCalls).toBe(1);
    expect(fixture.runtime.control(actor.conversationId)).not.toBe(
      previousRuntime,
    );
    expect(actor.getState().fatalError).toBeUndefined();
    expect(actor.profile.role.id).toBe("default");
    expect(actor.session.model?.id).toBe("model-a");
  });

  it("rejects switching the role of a running conversation", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Builder",
      description: "",
      systemPrompt: "",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const started = deferred();
    const release = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(started, release),
    ]);
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const running = fixture.coordinator.prompt(
      fixture.handle,
      actor.conversationId,
      randomUUID(),
      "keep running",
    );
    await started.promise;

    await expect(fixture.coordinator.switchConversationRole(
      fixture.handle,
      actor.conversationId,
      role.id,
    )).rejects.toThrow(/busy conversation/i);
    expect(actor.profile.role.id).toBe("default");

    release.resolve();
    await running;
  });

  it("restores the previous role when the replacement runtime cannot open", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Unavailable at activation",
      description: "",
      systemPrompt: "This runtime will fail.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "full_access",
      canManageSessions: false,
    });
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    Object.assign(actor.session.model!, {
      api: "openai-codex-responses",
    });
    actor.setServiceTier("priority");
    actor.session.setThinkingLevel("medium");
    expect(
      fixture.runtime.createOptions.get(actor.conversationId)?.thinkingLevel,
    ).toBe("off");
    fixture.runtime.beforeCreateSession = async (_conversationId, options) => {
      if (options.model?.id === "model-b") {
        throw new Error("replacement activation failed");
      }
    };

    await expect(fixture.coordinator.switchConversationRole(
      fixture.handle,
      actor.conversationId,
      role.id,
    )).rejects.toThrow("replacement activation failed");

    expect(actor.profile.role.id).toBe("default");
    expect(actor.session.model?.id).toBe("model-a");
    expect(actor.getServiceTier()).toBe("priority");
    expect(actor.session.thinkingLevel).toBe("medium");
    expect(actor.sessionManager.getBranch().at(-1)).toMatchObject({
      type: "thinking_level_change",
      thinkingLevel: "medium",
    });
    const restored = aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    );
    expect(restored.conversationMeta?.role.id).toBe("default");
    expect(restored.serviceTier?.tier).toBe("priority");
  });

  it("removes the durable conversation when fixed-model session creation fails", async () => {
    const fixture = await createFixture();
    fixture.runtime.beforeCreateSession = async () => {
      throw new Error("configured model is no longer authenticated");
    };

    await expect(
      fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default", title: "must not become an orphan" },
      ),
    ).rejects.toThrow("no longer authenticated");
    await expect(
      fixture.coordinator.listSessions(fixture.handle),
    ).resolves.toEqual([]);
    await expect(readdir(fixture.handle.project.sessionDir))
      .resolves.toEqual([]);

    const failedConversationId =
      fixture.runtime.createConversationIds.at(-1);
    expect(failedConversationId).toBeDefined();
    const lease = fixture.registry.acquireConversation(
      fixture.cwd,
      failedConversationId!,
    );
    lease.release();
  });

  it("lists project-extension role models from the source actor registry", async () => {
    const runtime = new FakeRuntime();
    const projectModel = { provider: "extension", id: "project-model" };
    runtime.sessionModelRegistry = {
      getAvailable: () => [...runtime.availableModels, projectModel],
    } as unknown as ModelRegistry;
    const fixture = await createFixture(new ProjectStoreRegistry(), runtime);
    const projectRole = await fixture.roles.createRole({
      name: "Project specialist",
      description: "Uses a project extension provider",
      systemPrompt: "Use the project provider.",
      model: projectModel,
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    }, runtime.sessionModelRegistry);
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );

    expect(fixture.coordinator.listRoles()).toContainEqual(
      expect.objectContaining({
        id: projectRole.id,
        available: false,
      }),
    );
    await expect(executeTool(
      runtime.control(source.conversationId),
      "list_roles",
      "list-project-roles",
      {},
    )).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: projectRole.id,
        available: true,
        model: projectModel,
      }),
    ]));
  });

  it("lets a read-only Agent propose a gated prompt-only role revision", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "Prompt reviewer",
      description: "Reviews prompts",
      systemPrompt: "The original prompt.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "high",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const sourceRole = await fixture.roles.createRole({
      name: "Restricted prompt editor",
      description: "May only inspect project files and propose role prompts",
      systemPrompt: "Improve roles only when the user asks.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const existingTarget = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: targetRole.id, title: "Existing target" },
    );
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: sourceRole.id },
    );
    const sourceTools = fixture.runtime.createOptions
      .get(source.conversationId)?.workbenchCustomTools
      ?.map(({ name }) => name);
    expect(sourceTools).toEqual(expect.arrayContaining([
      "list_roles",
      "read_role",
      "propose_role_revision",
    ]));
    expect(sourceTools).not.toContain("list_sessions");

    const before = getRoleTemplate(fixture.roles, targetRole.id);
    const listed = await executeTool(
      fixture.runtime.control(source.conversationId),
      "list_roles",
      "list-role-revision",
      {},
    );
    expect(listed).toContainEqual(expect.objectContaining({
      id: targetRole.id,
      revision: before.revision,
    }));
    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "read_role",
      "read-role-complete",
      { roleId: targetRole.id },
    )).resolves.toEqual({
      id: before.id,
      revision: before.revision,
      name: before.name,
      description: before.description,
      systemPrompt: before.systemPrompt,
      model: before.model,
      defaultThinkingLevel: before.defaultThinkingLevel,
      defaultServiceTier: before.defaultServiceTier,
      toolMode: before.toolMode,
      canManageSessions: before.canManageSessions,
      available: before.available,
    });

    const replacement = "The reviewed replacement prompt.";
    let editorResult: string | undefined = replacement;
    const editorCalls: Array<{ title: string; prefill: string }> = [];
    const detach = fixture.coordinator.attachExtensionUI(
      fixture.handle,
      source.conversationId,
      {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async (title, prefill) => {
          editorCalls.push({ title, prefill });
          return editorResult;
        },
        notify: () => undefined,
      } satisfies PortableExtensionUI,
    );
    try {
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-applied",
        {
          roleId: targetRole.id,
          expectedRevision: before.revision,
          newSystemPrompt: replacement,
          reason: "The user explicitly requested a reviewed prompt.",
        },
      )).resolves.toEqual({
        outcome: "applied",
        roleId: targetRole.id,
        previousRevision: before.revision,
        revision: before.revision + 1,
        userEdited: false,
      });
      expect(editorCalls).toHaveLength(1);
      expect(editorCalls[0]).toMatchObject({
        title: expect.stringContaining(before.name),
        prefill: replacement,
      });
      expect(editorCalls[0]?.title).toContain(`修订 ${before.revision}`);

      const after = getRoleTemplate(fixture.roles, targetRole.id);
      expect(after).toMatchObject({
        id: before.id,
        revision: before.revision + 1,
        name: before.name,
        description: before.description,
        systemPrompt: replacement,
        model: before.model,
        defaultThinkingLevel: before.defaultThinkingLevel,
        defaultServiceTier: before.defaultServiceTier,
        toolMode: before.toolMode,
        canManageSessions: before.canManageSessions,
        createdAt: before.createdAt,
      });
      expect(existingTarget.profile.role).toMatchObject({
        revision: before.revision,
        systemPrompt: before.systemPrompt,
      });

      const appliedEditorCallCount = editorCalls.length;
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-replay",
        {
          roleId: targetRole.id,
          expectedRevision: before.revision,
          newSystemPrompt: replacement,
          reason: "Replay the already applied proposal.",
        },
      )).resolves.toEqual({
        outcome: "already_current",
        roleId: targetRole.id,
        revision: before.revision + 1,
      });
      expect(editorCalls).toHaveLength(appliedEditorCallCount);

      editorResult = replacement;
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-unchanged",
        {
          roleId: targetRole.id,
          expectedRevision: before.revision + 1,
          newSystemPrompt: "A replacement edited back to the base.",
          reason: "The editor can return the original prompt.",
        },
      )).resolves.toEqual({
        outcome: "unchanged",
        roleId: targetRole.id,
        previousRevision: before.revision + 1,
        revision: before.revision + 1,
        userEdited: true,
      });
      expect(editorCalls).toHaveLength(appliedEditorCallCount + 1);

      editorResult = undefined;
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-cancelled",
        {
          roleId: targetRole.id,
          expectedRevision: after.revision,
          newSystemPrompt: "A cancelled replacement.",
          reason: "The user can still cancel this editor.",
        },
      )).resolves.toEqual({ outcome: "cancelled" });
      expect(getRoleTemplate(fixture.roles, targetRole.id).systemPrompt)
        .toBe(replacement);

      const editorCallCount = editorCalls.length;
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-stale",
        {
          roleId: targetRole.id,
          expectedRevision: before.revision,
          newSystemPrompt: "A stale replacement.",
          reason: "This must not open the editor.",
        },
      )).resolves.toEqual({
        outcome: "stale",
        roleId: targetRole.id,
        expectedRevision: before.revision,
        revision: after.revision,
      });
      expect(editorCalls).toHaveLength(editorCallCount);

      const newTarget = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: targetRole.id, title: "New target" },
      );
      expect(newTarget.profile.role).toMatchObject({
        revision: after.revision,
        systemPrompt: replacement,
      });
      expect(fixture.runtime.createOptions.get(newTarget.conversationId))
        .toMatchObject({ roleSystemPrompt: replacement });
    } finally {
      detach();
    }
  });

  it("cancels a role proposal through the router when no UI delegate is attached", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "No delegate target",
      description: "",
      systemPrompt: "Keep this prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const controller = new AbortController();
    const proposal = executeTool(
      fixture.runtime.control(source.conversationId),
      "propose_role_revision",
      "propose-role-no-delegate-abort",
      {
        roleId: targetRole.id,
        expectedRevision: targetRole.revision,
        newSystemPrompt: "This must not be written.",
        reason: "Abort while waiting for the missing UI delegate.",
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();

    await expect(proposal).resolves.toEqual({ outcome: "cancelled" });
    expect(getRoleTemplate(fixture.roles, targetRole.id)).toMatchObject({
      revision: targetRole.revision,
      systemPrompt: targetRole.systemPrompt,
    });
  });

  it("cancels a proposal after the editor before RoleStore precommit", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "Abort target",
      description: "",
      systemPrompt: "Keep this prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const updateStarted = deferred();
    const updateGate = deferred();
    const controller = new AbortController();
    const originalUpdateRole = fixture.roles.updateRole.bind(fixture.roles);
    const updateRole = vi.spyOn(fixture.roles, "updateRole")
      .mockImplementation(async (...args) => {
        updateStarted.resolve();
        await updateGate.promise;
        return originalUpdateRole(...args);
      });
    const detach = fixture.coordinator.attachExtensionUI(
      fixture.handle,
      source.conversationId,
      {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => "A cancelled prompt.",
        notify: () => undefined,
      } satisfies PortableExtensionUI,
    );
    try {
      const proposal = executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-abort-before-commit",
        {
          roleId: targetRole.id,
          expectedRevision: targetRole.revision,
          newSystemPrompt: "A cancelled prompt.",
          reason: "Cancel after the editor has returned.",
        },
        controller.signal,
      );
      await updateStarted.promise;
      controller.abort();
      updateGate.resolve();

      await expect(proposal).resolves.toEqual({ outcome: "cancelled" });
      expect(updateRole).toHaveBeenCalledTimes(1);
      expect(getRoleTemplate(fixture.roles, targetRole.id)).toMatchObject({
        revision: targetRole.revision,
        systemPrompt: targetRole.systemPrompt,
      });
    } finally {
      updateGate.resolve();
      detach();
    }
  });

  it("returns stale when a CAS race changes a role after the editor", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "CAS target",
      description: "Before concurrent edit",
      systemPrompt: "The captured base prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const originalUpdateRole = fixture.roles.updateRole.bind(fixture.roles);
    let proposalUpdate = false;
    const updateRole = vi.spyOn(fixture.roles, "updateRole")
      .mockImplementation(async (...args) => {
        if (!proposalUpdate) {
          proposalUpdate = true;
          const current = getRoleTemplate(fixture.roles, targetRole.id);
          await originalUpdateRole(
            current.id,
            current.revision,
            current.systemPrompt,
            {
              name: current.name,
              description: current.description,
              systemPrompt: "Concurrent revision",
              model: current.model,
              defaultThinkingLevel: current.defaultThinkingLevel,
              defaultServiceTier: current.defaultServiceTier,
              toolMode: current.toolMode,
              canManageSessions: current.canManageSessions,
            },
          );
        }
        return originalUpdateRole(...args);
      });
    const detach = fixture.coordinator.attachExtensionUI(
      fixture.handle,
      source.conversationId,
      {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => "The proposed revision.",
        notify: () => undefined,
      } satisfies PortableExtensionUI,
    );
    try {
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-cas-race",
        {
          roleId: targetRole.id,
          expectedRevision: targetRole.revision,
          newSystemPrompt: "The proposed revision.",
          reason: "Race the role CAS after editor acceptance.",
        },
      )).resolves.toEqual({
        outcome: "stale",
        roleId: targetRole.id,
        expectedRevision: targetRole.revision,
        revision: targetRole.revision + 1,
      });
      expect(updateRole).toHaveBeenCalledTimes(1);
      expect(getRoleTemplate(fixture.roles, targetRole.id)).toMatchObject({
        revision: targetRole.revision + 1,
        systemPrompt: "Concurrent revision",
      });
    } finally {
      detach();
    }
  });

  it("rethrows a post-commit proposal error instead of reporting stale", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "Post-commit target",
      description: "",
      systemPrompt: "The captured base prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const originalUpdateRole = fixture.roles.updateRole.bind(fixture.roles);
    const postCommitError = new Error("post-commit readback failed");
    vi.spyOn(fixture.roles, "updateRole")
      .mockImplementation(async (...args) => {
        await originalUpdateRole(...args);
        throw postCommitError;
      });
    const detach = fixture.coordinator.attachExtensionUI(
      fixture.handle,
      source.conversationId,
      {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => "The applied prompt.",
        notify: () => undefined,
      } satisfies PortableExtensionUI,
    );
    try {
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-post-commit-error",
        {
          roleId: targetRole.id,
          expectedRevision: targetRole.revision,
          newSystemPrompt: "The applied prompt.",
          reason: "Expose a post-commit readback failure.",
        },
      )).rejects.toBe(postCommitError);

      expect(getRoleTemplate(fixture.roles, targetRole.id)).toMatchObject({
        revision: targetRole.revision + 1,
        systemPrompt: "The applied prompt.",
      });
      const persisted = JSON.parse(await readFile(
        join(fixture.cwd, "user", "roles.json"),
        "utf8",
      )) as { roles: Array<{ id: string; revision: number }> };
      expect(persisted.roles).toContainEqual(expect.objectContaining({
        id: targetRole.id,
        revision: targetRole.revision + 1,
      }));
    } finally {
      detach();
    }
  });

  it("returns stale when a role changes while the editor is open", async () => {
    const fixture = await createFixture();
    const targetRole = await fixture.roles.createRole({
      name: "Concurrent target",
      description: "Before concurrent edit",
      systemPrompt: "The captured base prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const editorStarted = deferred();
    const releaseEditor = deferred<string>();
    const detach = fixture.coordinator.attachExtensionUI(
      fixture.handle,
      source.conversationId,
      {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => {
          editorStarted.resolve();
          return releaseEditor.promise;
        },
        notify: () => undefined,
      } satisfies PortableExtensionUI,
    );
    try {
      const proposal = executeTool(
        fixture.runtime.control(source.conversationId),
        "propose_role_revision",
        "propose-role-concurrent-edit",
        {
          roleId: targetRole.id,
          expectedRevision: targetRole.revision,
          newSystemPrompt: "A proposed prompt.",
          reason: "The user requested a prompt revision.",
        },
      );
      await editorStarted.promise;

      const current = getRoleTemplate(fixture.roles, targetRole.id);
      const concurrentlyUpdated = await fixture.roles.updateRole(
        targetRole.id,
        current.revision,
        current.systemPrompt,
        {
          name: current.name,
          description: "Changed while the editor was open",
          systemPrompt: current.systemPrompt,
          model: current.model,
          defaultThinkingLevel: current.defaultThinkingLevel,
          defaultServiceTier: current.defaultServiceTier,
          toolMode: current.toolMode,
          canManageSessions: current.canManageSessions,
        },
      );
      releaseEditor.resolve(current.systemPrompt);

      await expect(proposal).resolves.toEqual({
        outcome: "stale",
        roleId: targetRole.id,
        expectedRevision: targetRole.revision,
        revision: concurrentlyUpdated.revision,
      });
      expect(getRoleTemplate(fixture.roles, targetRole.id)).toMatchObject({
        revision: concurrentlyUpdated.revision,
        description: "Changed while the editor was open",
        systemPrompt: current.systemPrompt,
      });
    } finally {
      detach();
    }
  });

  it("shares an actor opening when openConversation races an unfinished create", async () => {
    const runtime = new FakeRuntime();
    const createStarted = deferred<string>();
    const releaseCreate = deferred();
    let blockNextCreate = true;
    runtime.beforeCreateSession = async (conversationId) => {
      if (!blockNextCreate) return;
      blockNextCreate = false;
      createStarted.resolve(conversationId);
      await releaseCreate.promise;
    };
    const registry = new ShortConversationWaitRegistry();
    const fixture = await createFixture(registry, runtime);

    const creating = fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "opening once" },
    );
    const conversationId = await createStarted.promise;
    const opening = fixture.coordinator.openConversation(
      fixture.handle,
      conversationId,
      { updateRecent: false },
    );
    releaseCreate.resolve();

    const created = await creating;
    await expect(opening).resolves.toBe(created);
    expect(
      runtime.createConversationIds.filter((id) => id === conversationId),
    ).toHaveLength(1);
  });

  it("reuses the same running actor and writer when a browser focuses it", async () => {
    const fixture = await createFixture();
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "focused run complete"),
    );
    const runId = randomUUID();
    const completion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      runId,
      "keep running while the browser focuses this actor",
    );
    await started.promise;

    const focused = await fixture.coordinator.openConversation(
      fixture.handle,
      target.conversationId,
    );
    expect(focused).toBe(target);
    expect(focused.getActivity()).toEqual({ kind: "running", runId });
    expect(
      fixture.runtime.createConversationIds.filter(
        (conversationId) => conversationId === target.conversationId,
      ),
    ).toHaveLength(1);

    release.resolve();
    await completion;
  });

  it("settles detached extension UI and disposes a late actor while closing", async () => {
    const runtime = new FakeRuntime();
    const activationStarted = deferred<string>();
    const activationSettled = deferred<boolean>();
    runtime.activateSession = async (conversationId, options) => {
      activationStarted.resolve(conversationId);
      const confirmed = await options.extensionUI!.confirm(
        "Background startup",
        "Coordinator close must settle this detached request",
      );
      activationSettled.resolve(confirmed);
    };
    const fixture = await createFixture(
      new ProjectStoreRegistry(),
      runtime,
    );
    const creating = fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "closing during activation" },
    );
    const conversationId = await activationStarted.promise;

    const closing = fixture.coordinator.close();
    await expect(activationSettled.promise).resolves.toBe(false);
    await expect(creating).rejects.toThrow(/closed|closing/i);
    await expect(closing).resolves.toBeUndefined();

    expect(runtime.control(conversationId).disposeCalls).toBe(1);
    const lease = fixture.registry.acquireConversation(
      fixture.cwd,
      conversationId,
    );
    lease.release();
  });

  it("settles an in-flight delegated extension UI request while closing", async () => {
    const runtime = new FakeRuntime();
    const delegatedRequestStarted = deferred();
    const releaseDelegate = deferred<boolean>();
    const activationSettled = deferred<boolean>();
    const extensionUI = {
      select: async () => undefined,
      confirm: async () => {
        delegatedRequestStarted.resolve();
        return releaseDelegate.promise;
      },
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => undefined,
    } satisfies PortableExtensionUI;
    runtime.activateSession = async (_conversationId, options) => {
      const confirmed = await options.extensionUI!.confirm(
        "Attached startup",
        "Coordinator close must settle an already delegated request",
      );
      activationSettled.resolve(confirmed);
    };
    const fixture = await createFixture(
      new ProjectStoreRegistry(),
      runtime,
    );
    const creating = fixture.coordinator.createUserConversation(
      fixture.handle,
      {
        roleId: "default",
        title: "closing with delegated UI",
        extensionUI,
      },
    );
    await delegatedRequestStarted.promise;

    const closing = fixture.coordinator.close();
    await expect(activationSettled.promise).resolves.toBe(false);
    await expect(creating).rejects.toThrow(/closed|closing/i);
    await expect(closing).resolves.toBeUndefined();

    releaseDelegate.resolve(true);
  });

  it.each([
    { label: "persistent", temporary: false },
    { label: "temporary", temporary: true },
  ] as const)(
    "rejects an unavailable default-tier role before a $label Agent start",
    async ({ temporary }) => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      Object.assign(fixture.runtime.availableModels[0]!, {
        api: "openai-codex-responses",
      });
      const role = await fixture.roles.createRole({
        name: `Priority ${temporary ? "temporary" : "persistent"} worker`,
        description: "Becomes unavailable after route drift",
        systemPrompt: "",
        model: { provider: "test", id: "model-a" },
        defaultThinkingLevel: "off",
        defaultServiceTier: "priority",
        toolMode: "read_only",
        canManageSessions: false,
      });
      Object.assign(fixture.runtime.availableModels[0]!, {
        api: "openai-responses",
      });
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          roleId: role.id,
          temporary,
          idempotencyKey: `unavailable-tier-${temporary}`,
        }),
      )).rejects.toThrow("模型不支持默认服务层级：priority");
      expect(aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards).toEqual([]);
      expect((await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id)).toEqual([source.conversationId]);
    },
  );

  it("starts a peer without waiting and retries the same idempotency key without duplicate delivery", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    Object.assign(fixture.runtime.availableModels[0]!, {
      api: "openai-codex-responses",
    });
    const targetRole = getRoleTemplate(fixture.roles, "default");
    await fixture.roles.updateRole(
      targetRole.id,
      targetRole.revision,
      targetRole.systemPrompt,
      {
        name: targetRole.name,
        description: targetRole.description,
        systemPrompt: targetRole.systemPrompt,
        model: targetRole.model,
        defaultThinkingLevel: targetRole.defaultThinkingLevel,
        defaultServiceTier: "priority",
        toolMode: targetRole.toolMode,
        canManageSessions: targetRole.canManageSessions,
      },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(started, release, "peer result"),
    ]);
    const input = startInput();

    const first = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    );
    await started.promise;
    expect((await fixture.coordinator.openConversation(
      fixture.handle,
      first.conversationId,
      { updateRecent: false },
    )).getServiceTier()).toBe("priority");
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === first.conversationId)?.activity,
    ).toEqual({ kind: "running", runId: first.runId });
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === first.conversationId),
    ).toMatchObject({
      attention: false,
      createdBy: {
        kind: "conversation",
        conversationId: source.conversationId,
      },
    });
    expect(
      aggregateReservedConversationEntries(
        fixture.runtime.control(source.conversationId).manager.getEntries(),
      ).cards.find(({ kind }) => kind === "delegation_task"),
    ).toMatchObject({
      state: "running",
      runId: first.runId,
    });

    const retry = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    );
    expect(retry).toEqual(first);
    expect(fixture.runtime.control(first.conversationId).received).toHaveLength(1);

    release.resolve();
    await waitUntil(
      async () =>
        (await fixture.coordinator.listSessions(fixture.handle))
          .find(({ id }) => id === first.conversationId)?.activity?.kind
          === "idle",
      "the non-blocking peer run to settle",
    );
    const settledRetry = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    );
    expect(settledRetry).toEqual(first);
    expect(fixture.runtime.control(first.conversationId).received).toHaveLength(1);
    expect(fixture.runtime.control(first.conversationId).abortCalls).toBe(0);
  });

  it("starts a peer from inside an active source turn without suspending the caller", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(targetStarted, releaseTarget, "peer eventually finished"),
    ]);
    let started:
      | { conversationId: string; runId: string; temporary: boolean }
      | undefined;
    fixture.runtime.control(source.conversationId).enqueue(
      async (control) => {
        started = await executeTool(
          control,
          "start_session",
          "active-source-start",
          {
            roleId: "default",
            task: "work independently while the source keeps running",
            temporary: false,
          },
        ) as typeof started;
        control.emitFinal("source continued immediately");
      },
    );

    const sourceSettlement = await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "delegate without waiting",
    );
    await targetStarted.promise;
    expect(sourceSettlement).toMatchObject({
      outcome: "completed",
      finalText: "source continued immediately",
    });
    expect(started).toMatchObject({
      conversationId: expect.any(String),
      runId: expect.any(String),
      temporary: false,
    });
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === started!.conversationId)?.activity,
    ).toEqual({ kind: "running", runId: started!.runId });

    releaseTarget.resolve();
    await waitUntil(
      async () =>
        (await fixture.coordinator.listSessions(fixture.handle))
          .find(({ id }) => id === started!.conversationId)?.activity.kind
          === "idle",
      "the independent target cleanup",
    );
  });

  it("shows which sessions the current Agent created and filters them explicitly", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "Coordinator" },
    );
    const userSession = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "User session" },
    );
    const otherAgent = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "Other coordinator" },
    );
    const ownTarget = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        title: "Owned target",
        idempotencyKey: "owned-target",
      }),
    );
    const otherTarget = await fixture.coordinator.startPeerSession(
      fixture.handle,
      otherAgent.conversationId,
      startInput({
        title: "Other target",
        idempotencyKey: "other-target",
      }),
    );
    const sourceControl = fixture.runtime.control(source.conversationId);

    const all = await executeTool(
      sourceControl,
      "list_sessions",
      "list-all-origins",
      { limit: 20 },
    ) as {
      sessions: Array<{
        conversationId: string;
        createdBy: unknown;
        createdByMe: boolean;
      }>;
    };
    const byId = new Map(
      all.sessions.map((session) => [session.conversationId, session]),
    );

    expect(byId.get(source.conversationId)).toMatchObject({
      createdBy: { kind: "user" },
      createdByMe: false,
    });
    expect(byId.get(userSession.conversationId)).toMatchObject({
      createdBy: { kind: "user" },
      createdByMe: false,
    });
    expect(byId.get(ownTarget.conversationId)).toMatchObject({
      createdBy: {
        kind: "conversation",
        conversationId: source.conversationId,
      },
      createdByMe: true,
    });
    expect(byId.get(otherTarget.conversationId)).toMatchObject({
      createdBy: {
        kind: "conversation",
        conversationId: otherAgent.conversationId,
      },
      createdByMe: false,
    });

    const owned = await executeTool(
      sourceControl,
      "list_sessions",
      "list-owned-only",
      { limit: 20, scope: "created_by_me" },
    ) as { sessions: Array<{ conversationId: string }> };
    expect(owned.sessions.map(({ conversationId }) => conversationId))
      .toEqual([ownTarget.conversationId]);

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixture.coordinator = restarted;
    fixture.handle = restartedHandle;
    await restarted.openConversation(
      restartedHandle,
      source.conversationId,
      { updateRecent: false },
    );
    const restartedContext = (restartedHandle as unknown as {
      context: { profiles: Map<string, ConversationMeta> };
    }).context;
    restartedContext.profiles.delete(ownTarget.conversationId);

    const recoveredOwned = await executeTool(
      fixture.runtime.control(source.conversationId),
      "list_sessions",
      "list-owned-after-restart",
      { limit: 20, scope: "created_by_me" },
    ) as { sessions: Array<{ conversationId: string }> };
    expect(
      recoveredOwned.sessions.map(({ conversationId }) => conversationId),
    ).toEqual([ownTarget.conversationId]);
  });

  it("keeps a start_session committed while target creation is finishing after source cancellation", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetCreationStarted = deferred<string>();
    const releaseTargetCreation = deferred();
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId === source.conversationId) return;
      targetCreationStarted.resolve(conversationId);
      await releaseTargetCreation.promise;
    };
    const abort = new AbortController();
    const starting = fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "finish the durable delegation despite caller cancellation",
        idempotencyKey: "cancel-after-start-intent",
      }),
      abort.signal,
    );
    const targetConversationId = await targetCreationStarted.promise;

    abort.abort();
    releaseTargetCreation.resolve();

    await expect(starting).resolves.toMatchObject({
      conversationId: targetConversationId,
      runId: expect.any(String),
    });
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toContain(targetConversationId);
    expect(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find(({ body }) =>
        body === "finish the durable delegation despite caller cancellation"
      ),
    ).toMatchObject({
      state: expect.stringMatching(/running|completed/),
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("creates an initial start_session inbox envelope already processing", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const inbox = coordinatorInbox(fixture.handle);
    const replace = vi.spyOn(
      inbox as unknown as {
        replaceAtomically(path: string, content: string): Promise<void>;
      },
      "replaceAtomically",
    ).mockRejectedValue(new Error("processing state rewrite must not occur"));

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "atomically create processing inbox envelope",
        idempotencyKey: "initial-processing-create",
      }),
    );

    expect(replace).not.toHaveBeenCalled();
    await expect(coordinatorInbox(fixture.handle).list({
      toConversationId: started.conversationId,
    })).resolves.toEqual([
      expect.objectContaining({
        state: "processing",
        processingRunId: started.runId,
        body: "atomically create processing inbox envelope",
      }),
    ]);
  });

  it("rolls back a new start_session target when inbox admission fails", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const inbox = coordinatorInbox(fixture.handle);
    inbox.put = async () => {
      throw new Error("inbox admission rejected");
    };

    await expect(fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "must not leave an orphan target",
        idempotencyKey: "failed-inbox-admission",
      }),
    )).rejects.toThrow("inbox admission rejected");

    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual([source.conversationId]);
    expect(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find(({ body }) => body === "must not leave an orphan target"),
    ).toMatchObject({
      state: "failed",
      result: expect.stringContaining("inbox admission rejected"),
    });
    await expect(fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "must not leave an orphan target",
        idempotencyKey: "failed-inbox-admission",
      }),
    )).rejects.toThrow(/start_session inbox admission failed/i);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual([source.conversationId]);
  });

  it("allows a browser run after a committed start_session inbox entry settles", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.nextSessionBehaviors.push([
      completesWith("delegation handled before browser admission"),
    ]);
    const inbox = coordinatorInbox(fixture.handle);
    const originalPut = inbox.put.bind(inbox);
    const browserRunId = randomUUID();
    let browserCompletion: Promise<RunSettlement> | undefined;
    inbox.put = async (input) => {
      const committed = await originalPut(input);
      browserCompletion = fixture.coordinator.prompt(
        fixture.handle,
        input.toConversationId,
        browserRunId,
        "browser work cannot overtake durable inbox",
      );
      return committed;
    };

    let started;
    try {
      started = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "run before the browser admission",
          idempotencyKey: "browser-after-inbox-commit",
        }),
      );
    } finally {
      inbox.put = originalPut;
    }
    expect(started).toMatchObject({
      conversationId: expect.any(String),
      runId: expect.any(String),
    });
    await expect(browserCompletion).resolves.toMatchObject({
      runId: browserRunId,
      outcome: "completed",
    });
    await waitUntil(
      () =>
        fixture.runtime.control(started.conversationId).received.length === 1,
      "the committed delegation before browser admission",
    );
    expect(
      fixture.runtime.control(started.conversationId).received[0]?.content,
    ).toContain("run before the browser admission");
  });

  it("rejects start_session replays that change role, temporary mode, or title under the same idempotency key", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const otherRole = await fixture.roles.createRole({
      name: "Different worker",
      description: "Must not replace the frozen start request",
      systemPrompt: "Use a different role.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const original = startInput({
      task: "Keep this request stable",
      title: "Stable delegated title",
      idempotencyKey: "conflicting-start-replay",
    });
    await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      original,
    );

    const replays = await Promise.allSettled([
      fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        { ...original, roleId: otherRole.id },
      ),
      fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        { ...original, temporary: true },
      ),
      fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        { ...original, title: "A different delegated title" },
      ),
    ]);

    expect(replays.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    for (const replay of replays) {
      if (replay.status === "fulfilled") continue;
      expect(replay.reason).toMatchObject({
        message: expect.stringContaining(
          "start_session idempotency key conflicts",
        ),
      });
    }
  });

  it("replays a failed start after restart with the precommitted role snapshot", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const role = await fixture.roles.createRole({
      name: "Frozen worker",
      description: "The originally selected role",
      systemPrompt: "Use the original role prompt.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const input = startInput({
      roleId: role.id,
      task: "Resume this exact delegated start after restart",
      idempotencyKey: "frozen-role-start-recovery",
    });
    let failTargetCreation = true;
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (
        conversationId !== source.conversationId
        && failTargetCreation
      ) {
        failTargetCreation = false;
        throw new Error("simulated crash after start precommit");
      }
    };

    await expect(fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    )).rejects.toThrow("simulated crash after start precommit");
    const precommitted = aggregateReservedConversationEntries(
      source.sessionManager.getEntries(),
    ).cards.find(({ body }) => body === input.task);
    expect(precommitted).toMatchObject({
      state: "sending",
      requestedRole: {
        id: role.id,
        revision: role.revision,
        name: "Frozen worker",
        systemPrompt: "Use the original role prompt.",
        model: { provider: "test", id: "model-a" },
      },
    });

    await fixture.coordinator.close();
    await fixture.roles.updateRole(
      role.id,
      role.revision,
      role.systemPrompt,
      {
        name: "Rewritten worker",
        description: "A later role definition",
        systemPrompt: "Use the rewritten role prompt.",
        model: { provider: "test", id: "model-b" },
        defaultThinkingLevel: "off",
        defaultServiceTier: null,
        toolMode: "full_access",
        canManageSessions: true,
      },
    );
    fixture.runtime.beforeCreateSession = undefined;
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.coordinator = restarted;
    fixture.handle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    await restarted.openConversation(
      fixture.handle,
      source.conversationId,
      { updateRecent: false },
    );

    const replay = await restarted.startPeerSession(
      fixture.handle,
      source.conversationId,
      input,
    );
    const target = await restarted.openConversation(
      fixture.handle,
      replay.conversationId,
      { updateRecent: false },
    );
    expect(target.profile.role).toMatchObject({
      id: role.id,
      revision: role.revision,
      name: role.name,
      description: role.description,
      systemPrompt: role.systemPrompt,
      model: role.model,
    });
    expect(
      fixture.runtime.createOptions.get(replay.conversationId),
    ).toMatchObject({
      roleSystemPrompt: "Use the original role prompt.",
      model: { provider: "test", id: "model-a" },
    });
    expect(
      aggregateReservedConversationEntries(
        fixture.runtime.control(source.conversationId).manager.getEntries(),
      ).cards.find(({ cardId }) => cardId === precommitted!.cardId),
    ).toMatchObject({
      requestedRole: {
        id: role.id,
        revision: role.revision,
        name: role.name,
        systemPrompt: role.systemPrompt,
        model: role.model,
      },
      state: expect.stringMatching(/running|completed/),
    });
  });

  it("keeps the user's durable recent conversation unchanged when an Agent starts a background session", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "user focus" },
    );
    expect(fixture.handle.project.lastConversationId).toBe(
      source.conversationId,
    );

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "work in the background without stealing future focus",
        title: "background worker",
        idempotencyKey: "background-recent",
      }),
    );
    expect(started.conversationId).not.toBe(source.conversationId);
    expect(fixture.handle.project.lastConversationId).toBe(
      source.conversationId,
    );

    const reopened = await ProjectStore.open(fixture.cwd, "full_access");
    expect(reopened.lastConversationId).toBe(source.conversationId);
  });

  it("captures a bounded preview title when an unnamed conversation sends a message", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    source.sessionManager.appendMessage({
      role: "user",
      content: "Investigate the rendering pipeline",
      timestamp: 1,
    });
    await fixture.handle.project.refreshConversations();
    expect(
      fixture.handle.project.listConversations()
        .find(({ id }) => id === source.conversationId)?.preview,
    ).toBe("Investigate the rendering pipeline");
    const displayTitle = "Investigate the renderi…";
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("message handled"),
    );

    await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-with-preview-title",
      {
        conversationId: target.conversationId,
        message: "Keep the source title on this card",
      },
    );
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 1,
      "the titled message to be delivered",
    );

    expect(
      fixture.runtime.control(target.conversationId).received[0]?.details,
    ).toMatchObject({
      fromSnapshot: {
        conversationId: source.conversationId,
        title: displayTitle,
      },
      toSnapshot: {
        conversationId: target.conversationId,
      },
    });
    expect(
      aggregateReservedConversationEntries(source.sessionManager.getEntries())
        .cards.find(({ body }) => body === "Keep the source title on this card"),
    ).toMatchObject({
      fromSnapshot: {
        conversationId: source.conversationId,
        title: displayTitle,
      },
    });
  });

  it("steers a durable message into a busy target's current run", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const busyStarted = deferred();
    const releaseBusy = deferred();
    fixture.runtime.control(target.conversationId).enqueue(async (control) => {
      busyStarted.resolve();
      control.abortCurrent = () => releaseBusy.resolve();
      try {
        await releaseBusy.promise;
      } finally {
        control.abortCurrent = undefined;
      }
    });
    fixture.runtime.control(target.conversationId).enqueueContinuation(
      completesWith("message handled"),
    );
    const busyRunId = randomUUID();
    const busyCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      busyRunId,
      "stay busy",
    );
    await busyStarted.promise;

    const sendResult = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-busy",
      {
        conversationId: target.conversationId,
        message: "Handle this after the current task",
      },
    ) as {
      status: string;
      runId: string;
    };

    expect(sendResult).toMatchObject({
      status: "processing",
      runId: busyRunId,
    });
    expect(fixture.runtime.control(target.conversationId).received).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Handle this after the current task"),
        triggerTurn: true,
        deliverAs: "steer",
      }),
    ]);
    expect(
      aggregateReservedConversationEntries(target.sessionManager.getEntries())
        .deliveredMessageIds,
    ).toHaveLength(0);
    expect(fixture.runtime.control(target.conversationId).pendingSteers)
      .toHaveLength(1);
    expect(fixture.runtime.control(target.conversationId).abortCalls).toBe(0);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === target.conversationId)?.activity,
    ).toEqual({ kind: "running", runId: busyRunId });
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === target.conversationId)?.attention,
    ).toBe(false);

    releaseBusy.resolve();
    const busySettlement = await busyCompletion;
    await waitUntil(
      async () => (
        await coordinatorInbox(fixture.handle).list({
          toConversationId: target.conversationId,
        })
      ).length === 0,
      "the steered message to settle with its current run",
    );
    expect(fixture.runtime.control(target.conversationId).promptTexts).toEqual([
      "stay busy",
    ]);
    expect(fixture.runtime.control(target.conversationId).steerContinuationCalls)
      .toBe(1);
    expect(
      fixture.runtime.control(target.conversationId).modelRequestCustomMessages,
    ).toEqual([[expect.objectContaining({
      content: expect.stringContaining("Handle this after the current task"),
      deliverAs: "steer",
    })]]);
    expect(busySettlement).toMatchObject({
      finalText: "message handled",
    });
    expect(
      aggregateReservedConversationEntries(target.sessionManager.getEntries())
        .deliveredMessageIds,
    ).toHaveLength(1);
    expect(
      fixture.runtime.control(target.conversationId).received[0]?.content,
    ).toContain("你负责管理自己创建的会话生命周期");
    expect(fixture.runtime.control(target.conversationId).abortCalls).toBe(0);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === target.conversationId)?.attention,
    ).toBe(false);
  });

  it("does not hold project lifecycle shutdown on pre-stream steering", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const preflightStarted = deferred();
    const releasePreflight = deferred();
    const control = fixture.runtime.control(target.conversationId);
    const originalPrompt = control.session.prompt.bind(control.session);
    control.session.prompt = async (...args) => {
      preflightStarted.resolve();
      control.abortCurrent = () => releasePreflight.resolve();
      await releasePreflight.promise;
      control.abortCurrent = undefined;
      return originalPrompt(...args);
    };

    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      randomUUID(),
      "pause before Pi streaming starts",
    );
    await preflightStarted.promise;
    const sending = executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "pre-stream-steer",
      {
        conversationId: target.conversationId,
        message: "Persist this without blocking coordinator close.",
      },
    );
    await waitUntil(
      async () => (await coordinatorInbox(fixture.handle).list({
        toConversationId: target.conversationId,
      }))[0]?.state === "processing",
      "the pre-stream envelope claim",
    );

    let closeSettled = false;
    const closing = fixture.coordinator.close().then(() => {
      closeSettled = true;
    });
    let closeError: unknown;
    try {
      await waitUntil(
        () => closeSettled,
        "coordinator close to cancel a pre-stream run",
        500,
      );
    } catch (error) {
      closeError = error;
    } finally {
      releasePreflight.resolve();
    }
    await Promise.allSettled([sending, targetCompletion, closing]);
    expect(closeError).toBeUndefined();
  });

  it("recovers a rejected pre-stream steer after actor infrastructure failure", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const preflightStarted = deferred();
    const releasePreflight = deferred();
    const control = fixture.runtime.control(target.conversationId);
    const originalPrompt = control.session.prompt.bind(control.session);
    control.session.prompt = async (...args) => {
      preflightStarted.resolve();
      control.abortCurrent = () => releasePreflight.resolve();
      await releasePreflight.promise;
      control.abortCurrent = undefined;
      return originalPrompt(...args);
    };
    fixture.runtime.nextSessionBehaviors.push([
      completesWith("recovered durable steer"),
    ]);
    const manager = target.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let rejectSettlement = true;
    manager.appendCustomEntry = (customType, data) => {
      if (rejectSettlement && customType === RUN_SETTLEMENT_CUSTOM_TYPE) {
        rejectSettlement = false;
        throw new Error("simulated settlement infrastructure failure");
      }
      return originalAppend(customType, data);
    };

    const failedRunId = randomUUID();
    const failedCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      failedRunId,
      "fail before Pi can accept steering",
    );
    await preflightStarted.promise;
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "recover-rejected-pre-stream-steer",
      {
        conversationId: target.conversationId,
        message: "recover this rejected in-memory delivery",
      },
    ) as { messageId: string; status: string };
    expect(sent.status).toBe("processing");

    await fixture.coordinator.abort(
      fixture.handle,
      target.conversationId,
      failedRunId,
    );
    await expect(failedCompletion).rejects.toThrow(
      "simulated settlement infrastructure failure",
    );
    await waitUntil(
      async () => (await coordinatorInbox(fixture.handle).get(sent.messageId))
        === undefined,
      "the rejected steer to recover without a process restart",
    );
    const recoveredActor = (fixture.handle as unknown as {
      context: { actors: Map<string, ConversationActor> };
    }).context.actors.get(target.conversationId);
    expect(
      aggregateReservedConversationEntries(
        recoveredActor!.sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toHaveLength(1);

    await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-after-rejected-steer-recovery",
      {
        conversationId: target.conversationId,
        message: "a later message must not be FIFO-blocked",
      },
    );
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.some(
        ({ content }) => content.includes("a later message must not be FIFO-blocked"),
      ),
      "a later message after rejected steer recovery",
    );
  });

  it("requeues a steered envelope when Pi settles before recording its marker", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "first run settled"),
      completesWith("replayed durable message"),
    );
    const busyRunId = randomUUID();
    const busyCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      busyRunId,
      "work while receiving supervision",
    );
    await started.promise;
    fixture.runtime.control(target.conversationId)
      .skipNextCustomMessagePersistence = true;

    const result = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "steer-marker-retry",
      {
        conversationId: target.conversationId,
        message: "Do not lose this durable supervision message.",
      },
    ) as { status: string; runId: string };
    expect(result).toMatchObject({
      status: "processing",
      runId: busyRunId,
    });
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: target.conversationId,
    }))[0]).toMatchObject({
      state: "processing",
      processingRunId: busyRunId,
      processingDelivery: "steer",
    });

    release.resolve();
    await busyCompletion;
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.some(
        ({ triggerTurn }) => triggerTurn,
      ),
      "the unmarked steering message to replay from its durable inbox",
    );
    expect(fixture.runtime.control(target.conversationId).received)
      .toContainEqual(expect.objectContaining({
        content: expect.stringContaining(
          "Do not lose this durable supervision message.",
        ),
        triggerTurn: true,
      }));
    await waitUntil(
      async () => (
        await coordinatorInbox(fixture.handle).list({
          toConversationId: target.conversationId,
        })
      ).length === 0,
      "the replayed message to receive a durable marker and settle",
    );
    expect(
      aggregateReservedConversationEntries(target.sessionManager.getEntries())
        .deliveredMessageIds,
    ).toHaveLength(1);
  });

  it("continues pumping after the sender is aborted immediately after the durable inbox commit", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("committed message handled"),
    );
    const abort = new AbortController();
    const inbox = coordinatorInbox(fixture.handle);
    const originalPut = inbox.put.bind(inbox);
    inbox.put = async (input) => {
      const committed = await originalPut(input);
      abort.abort();
      return committed;
    };

    const result = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "abort-after-commit",
      {
        conversationId: target.conversationId,
        message: "This message is already durable",
      },
      abort.signal,
    ) as { status: string; runId?: string };

    expect(result).toMatchObject({
      status: "processing",
      runId: expect.any(String),
    });
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 1,
      "the committed message to continue after sender abort",
    );
    expect(
      fixture.runtime.control(target.conversationId).received[0]?.content,
    ).toContain("This message is already durable");
  });

  it("does not mention session tools in messages delivered to a role without session management", async () => {
    const fixture = await createFixture();
    const restrictedRole = await fixture.roles.createRole({
      name: "Focused worker",
      description: "Works only in its own session",
      systemPrompt: "Complete the assigned work.",
      model: { provider: "test", id: "model-a" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: restrictedRole.id },
    );
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("handled without orchestration"),
    );

    await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-restricted",
      {
        conversationId: target.conversationId,
        message: "Handle this locally",
      },
    );
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 1,
      "the restricted target to receive its message",
    );

    const content =
      fixture.runtime.control(target.conversationId).received[0]?.content;
    expect(content).toContain("Handle this locally");
    expect(content).not.toContain("send_session_message");
    expect(content).not.toContain("生命周期提醒");
  });

  it("retries one synchronous inbox dispatch failure without requiring a restart", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("retry handled"),
    );
    const originalStartMessages = target.startMessages.bind(target);
    let dispatchAttempts = 0;
    target.startMessages = (input) => {
      dispatchAttempts++;
      if (dispatchAttempts === 1) {
        throw new Error("transient synchronous dispatch failure");
      }
      return originalStartMessages(input);
    };

    await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "retry-sync-dispatch",
      {
        conversationId: target.conversationId,
        message: "Retry this durable message",
      },
    );

    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 1,
      "the synchronous dispatch retry",
    );
    expect(dispatchAttempts).toBe(2);
    expect(
      fixture.runtime.control(target.conversationId).received[0]?.content,
    ).toContain("Retry this durable message");
  });

  it("rolls back an idle inbox batch when its second claim fails and retries the full FIFO batch", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const inbox = coordinatorInbox(fixture.handle);
    const firstMessageId = randomUUID();
    const secondMessageId = randomUUID();
    const commonEnvelope = {
      cardId: randomUUID(),
      fromConversationId: source.conversationId,
      toConversationId: target.conversationId,
      kind: "message" as const,
      fromSnapshot: {
        conversationId: source.conversationId,
        role: { id: "default", name: "Default" },
      },
      toSnapshot: {
        conversationId: target.conversationId,
        role: { id: "default", name: "Default" },
      },
    };
    await inbox.put({
      ...commonEnvelope,
      messageId: firstMessageId,
      sentAt: "2026-07-24T12:00:00.000Z",
      body: "first idle batch message",
    });
    await inbox.put({
      ...commonEnvelope,
      cardId: randomUUID(),
      messageId: secondMessageId,
      sentAt: "2026-07-24T12:00:01.000Z",
      body: "second idle batch message",
    });

    const originalStartMessages = target.startMessages.bind(target);
    let starts = 0;
    target.startMessages = (input) => {
      starts++;
      return originalStartMessages(input);
    };
    const originalUpdateState = inbox.updateState.bind(inbox);
    const retryClaimStarted = deferred();
    const releaseRetryClaim = deferred();
    let processingClaims = 0;
    inbox.updateState = async (messageId, update) => {
      if (update.state === "processing") {
        processingClaims++;
        if (processingClaims === 2) {
          throw new Error("second idle batch claim fails once");
        }
        if (processingClaims === 3) {
          retryClaimStarted.resolve();
          await releaseRetryClaim.promise;
        }
      }
      return originalUpdateState(messageId, update);
    };

    await expect(fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      randomUUID(),
      "must wait behind the durable inbox batch",
    )).rejects.toThrow("Durable conversation work was admitted");
    await retryClaimStarted.promise;

    expect(starts).toBe(0);
    await expect(inbox.get(firstMessageId)).resolves.toMatchObject({
      state: "queued",
    });
    await expect(inbox.get(secondMessageId)).resolves.toMatchObject({
      state: "queued",
    });

    releaseRetryClaim.resolve();
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 2,
      "the retried full idle inbox batch",
    );
    await waitUntil(
      async () => (await inbox.list({
        toConversationId: target.conversationId,
      })).length === 0,
      "the retried batch sidecar cleanup",
    );
    inbox.updateState = originalUpdateState;

    expect(starts).toBe(1);
    expect(processingClaims).toBe(4);
    expect(fixture.runtime.control(target.conversationId).received.map(
      ({ content }) => content.includes("first idle batch message")
        ? "first"
        : content.includes("second idle batch message")
          ? "second"
          : "unexpected",
    )).toEqual(["first", "second"]);
  });

  it("preserves a recovered steering claim across synchronous dispatch rollback", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "original run settled"),
    );
    const busyRunId = randomUUID();
    const completion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      busyRunId,
      "accept a steering claim before restart",
    );
    await started.promise;
    const control = fixture.runtime.control(target.conversationId);
    control.skipNextCustomMessagePersistence = true;
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "recovered-steer-dispatch-rollback",
      {
        conversationId: target.conversationId,
        message: "retain the durable steering discriminator",
      },
    ) as { messageId: string };

    const recoveryRunId = randomUUID();
    const inbox = coordinatorInbox(fixture.handle);
    await inbox.updateState(sent.messageId, {
      state: "processing",
      processingRunId: recoveryRunId,
      processingDelivery: "steer",
    });
    const internal = fixture.handle as unknown as {
      context: { processingBatches: Map<string, unknown> };
    };
    internal.context.processingBatches.clear();
    let dispatchAttempts = 0;
    target.startMessages = () => {
      dispatchAttempts++;
      throw new Error("recovered dispatch fails synchronously");
    };

    release.resolve();
    await completion;
    await waitUntil(
      () => dispatchAttempts >= 2,
      "the bounded recovered dispatch retry",
    );
    await expect(inbox.get(sent.messageId)).resolves.toMatchObject({
      state: "processing",
      processingRunId: recoveryRunId,
      processingDelivery: "steer",
    });
  });

  it("retries one send_session_message tool call while running and after settlement without duplicate delivery", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "idempotent delivery complete"),
    );
    const input = {
      conversationId: target.conversationId,
      message: "Deliver this exactly once",
    };

    const first = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "stable-send-tool-call",
      input,
    ) as {
      status: string;
      messageId: string;
      conversationId: string;
      runId: string;
    };
    await started.promise;
    expect(first).toMatchObject({
      status: "processing",
      conversationId: target.conversationId,
    });

    const runningRetry = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "stable-send-tool-call",
      input,
    );
    expect(runningRetry).toEqual(first);
    expect(fixture.runtime.control(target.conversationId).received).toHaveLength(1);

    release.resolve();
    await waitUntil(
      async () =>
        (await fixture.coordinator.listSessions(fixture.handle))
          .find(({ id }) => id === target.conversationId)?.activity?.kind
          === "idle",
      "the idempotent message run to settle",
    );
    await waitUntil(
      async () =>
        (await coordinatorInbox(fixture.handle).get(first.messageId))
        === undefined,
      "the settled message sidecar to be removed",
    );

    const settledRetry = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "stable-send-tool-call",
      input,
    ) as {
      status: string;
      messageId: string;
      conversationId: string;
      runId: string;
    };
    expect(settledRetry).toEqual({
      status: "completed",
      messageId: first.messageId,
      conversationId: target.conversationId,
      runId: first.runId,
    });
    expect(fixture.runtime.control(target.conversationId).received).toHaveLength(1);
    expect(
      aggregateReservedConversationEntries(
        fixture.runtime.control(target.conversationId).manager.getEntries(),
      ).deliveredMessageIds,
    ).toEqual([first.messageId]);
  });

  it("keeps the remaining processing batch and retries a failed terminal sidecar delete once", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "the original run settled"),
      completesWith("the later inbox pump settled"),
    );
    const runId = randomUUID();
    const completion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      runId,
      "keep this run active while three peer messages arrive",
    );
    await started.promise;

    const messages = await Promise.all(["first", "second", "third"].map(
      async (ordinal) => await executeTool(
        fixture.runtime.control(source.conversationId),
        "send_session_message",
        `finish-batch-${ordinal}`,
        {
          conversationId: target.conversationId,
          message: `${ordinal} processing envelope`,
        },
      ) as { messageId: string },
    ));
    const [first, second, third] = messages;
    const inbox = coordinatorInbox(fixture.handle);
    const originalDelete = inbox.delete.bind(inbox);
    const retrySecondDeleteStarted = deferred();
    const releaseRetrySecondDelete = deferred();
    let secondDeleteAttempts = 0;
    inbox.delete = async (messageId) => {
      if (messageId === second!.messageId) {
        secondDeleteAttempts++;
        if (secondDeleteAttempts === 1) {
          throw new Error("second terminal sidecar delete fails once");
        }
        retrySecondDeleteStarted.resolve();
        await releaseRetrySecondDelete.promise;
      }
      await originalDelete(messageId);
    };

    release.resolve();
    await completion;
    await retrySecondDeleteStarted.promise;

    expect(await inbox.get(first!.messageId)).toBeUndefined();
    await expect(inbox.get(second!.messageId)).resolves.toMatchObject({
      state: "processing",
      processingRunId: runId,
    });
    await expect(inbox.get(third!.messageId)).resolves.toMatchObject({
      state: "processing",
      processingRunId: runId,
    });
    const context = (fixture.handle as unknown as {
      context: {
        processingBatches: Map<string, Array<{ messageId: string }>>;
      };
    }).context;
    expect([...context.processingBatches.values()].flat().map(
      ({ messageId }) => messageId,
    )).toEqual([second!.messageId, third!.messageId]);
    expect(
      aggregateReservedConversationEntries(source.sessionManager.getEntries())
        .cards.filter(({ messageId }) => messageId === first!.messageId),
    ).toEqual([expect.objectContaining({
      state: "completed",
      runId,
      result: "the original run settled",
    })]);

    releaseRetrySecondDelete.resolve();
    await waitUntil(
      async () => (await inbox.list({
        toConversationId: target.conversationId,
      })).length === 0,
      "the retried terminal sidecar cleanup",
    );
    inbox.delete = originalDelete;

    expect(secondDeleteAttempts).toBe(2);
    expect(
      aggregateReservedConversationEntries(source.sessionManager.getEntries())
        .cards.filter(({ messageId }) => (
          messageId === second!.messageId || messageId === third!.messageId
        )),
    ).toEqual([
      expect.objectContaining({
        messageId: second!.messageId,
        state: "completed",
        runId,
        result: "the original run settled",
      }),
      expect.objectContaining({
        messageId: third!.messageId,
        state: "completed",
        runId,
        result: "the original run settled",
      }),
    ]);

    await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "finish-batch-later-pump",
      {
        conversationId: target.conversationId,
        message: "later work must not remain FIFO-blocked",
      },
    );
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.some(
        ({ content }) => content.includes("later work must not remain FIFO-blocked"),
      ),
      "a later inbox pump after the retry",
    );
  });

  it("persists the terminal sender card before deleting its sidecar so restart can repair an append failure", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("durable terminal result"),
    );

    const manager = source.sessionManager;
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let terminalAppendFailures = 0;
    manager.appendCustomEntry = (customType, data) => {
      if (
        terminalAppendFailures < 2
        && customType === CONVERSATION_CARD_CUSTOM_TYPE
        && typeof data === "object"
        && data !== null
        && "state" in data
        && data.state === "completed"
      ) {
        terminalAppendFailures++;
        throw new Error("simulated terminal card append failure");
      }
      return originalAppend(customType, data);
    };

    let sent!: {
      status: string;
      messageId: string;
      conversationId: string;
      runId: string;
    };
    try {
      sent = await executeTool(
        fixture.runtime.control(source.conversationId),
        "send_session_message",
        "terminal-card-before-delete",
        {
          conversationId: target.conversationId,
          message: "preserve this sidecar until sender state is durable",
        },
      ) as typeof sent;
      await waitUntil(
        () => terminalAppendFailures === 2,
        "the exhausted terminal sender-card append retry",
      );
    } finally {
      manager.appendCustomEntry = originalAppend;
    }

    expect(await coordinatorInbox(fixture.handle).get(sent.messageId))
      .toMatchObject({
        messageId: sent.messageId,
        state: "processing",
        processingRunId: sent.runId,
      });

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixture.coordinator = restarted;
    fixture.handle = restartedHandle;

    await waitUntil(async () => {
      const inspection = await restartedHandle.project.inspectConversation(
        source.conversationId,
      );
      const terminal = inspection.cards.find(
        ({ cardId }) =>
          cardId
          === aggregateReservedConversationEntries(
            source.sessionManager.getEntries(),
          ).cards.find(({ messageId }) => messageId === sent.messageId)?.cardId,
      );
      return terminal?.state === "completed"
        && terminal.runId === sent.runId
        && await coordinatorInbox(restartedHandle).get(sent.messageId)
          === undefined;
    }, "restart repair of the terminal sender card");
  });

  it("writes the terminal sender card without starting an unavailable source model", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(
        targetStarted,
        releaseTarget,
        "terminal state survives an unavailable source model",
      ),
    );
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "source-model-unavailable-at-finish",
      {
        conversationId: target.conversationId,
        message: "finish this after my source actor is detached",
      },
    ) as {
      messageId: string;
      runId: string;
    };
    await targetStarted.promise;

    const context = (fixture.handle as unknown as {
      context: {
        actors: Map<string, typeof source>;
        actorUnsubscribes: Map<string, () => void>;
      };
    }).context;
    context.actorUnsubscribes.get(source.conversationId)?.();
    context.actorUnsubscribes.delete(source.conversationId);
    context.actors.delete(source.conversationId);
    await source.dispose();
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId === source.conversationId) {
        throw new Error("source model cannot start");
      }
    };

    releaseTarget.resolve();
    await waitUntil(
      async () =>
        await coordinatorInbox(fixture.handle).get(sent.messageId)
          === undefined,
      "terminal sender state before inbox cleanup",
    );
    const inspection = await fixture.handle.project.inspectConversation(
      source.conversationId,
    );
    expect(
      inspection.cards.find(({ messageId }) =>
        messageId === sent.messageId
      ),
    ).toMatchObject({
      state: "completed",
      runId: sent.runId,
      result: "terminal state survives an unavailable source model",
    });
    expect(
      fixture.runtime.createConversationIds.filter(
        (conversationId) => conversationId === source.conversationId,
      ),
    ).toHaveLength(1);
  });

  it("repairs the same sender card after inbox commit wins over the queued-card append", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const manager = source.sessionManager;
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let queuedAppendFailed = false;
    manager.appendCustomEntry = (customType, data) => {
      if (
        !queuedAppendFailed
        && customType === CONVERSATION_CARD_CUSTOM_TYPE
        && typeof data === "object"
        && data !== null
        && "state" in data
        && data.state === "queued"
      ) {
        queuedAppendFailed = true;
        throw new Error("simulated queued-card append failure");
      }
      return originalAppend(customType, data);
    };
    try {
      await expect(executeTool(
        fixture.runtime.control(source.conversationId),
        "send_session_message",
        "repair-sender-card-after-inbox-commit",
        {
          conversationId: target.conversationId,
          message: "repair this exact durable card after restart",
        },
      )).rejects.toThrow("queued-card append failure");
    } finally {
      manager.appendCustomEntry = originalAppend;
    }
    expect(queuedAppendFailed).toBe(true);
    const [pending] = await coordinatorInbox(fixture.handle).list({
      toConversationId: target.conversationId,
    });
    expect(pending).toBeDefined();
    expect(
      aggregateReservedConversationEntries(manager.getEntries())
        .cards.find(({ cardId }) => cardId === pending!.cardId),
    ).toMatchObject({ state: "sending" });

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.coordinator = restarted;
    fixture.handle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    await waitUntil(
      async () =>
        await coordinatorInbox(fixture.handle).get(pending!.messageId)
          === undefined,
      "recovered inbox delivery and sender card",
    );
    const inspection = await fixture.handle.project.inspectConversation(
      source.conversationId,
    );
    expect(
      inspection.cards.find(({ cardId }) => cardId === pending!.cardId),
    ).toMatchObject({
      cardId: pending!.cardId,
      state: "completed",
      result: "ok",
    });
    expect(
      inspection.cards.filter(({ cardId }) => cardId === pending!.cardId),
    ).toHaveLength(1);
  });

  it("waits for the exact durable settlement first and does not enter waiting for an already-settled run", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    fixture.runtime.control(target.conversationId).enqueue(
      completesWith("first exact result"),
      completesWith("second result"),
    );
    await fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      firstRunId,
      "first",
    );
    await fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      secondRunId,
      "second",
    );

    const sourceActivities: string[] = [];
    const unsubscribe = fixture.coordinator.subscribe(
      fixture.handle,
      (event) => {
        if (
          event.type === "activity"
          && event.conversationId === source.conversationId
        ) {
          sourceActivities.push(event.activity.kind);
        }
      },
    );
    let waited: RunSettlement | undefined;
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      waited = await executeTool(
        control,
        "wait_for_session",
        "wait-durable",
        {
          conversationId: target.conversationId,
          runId: firstRunId,
        },
        undefined,
        { omitSingleWaitCommitment: true },
      ) as RunSettlement;
      control.emitFinal("observed");
    });

    await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "observe the exact run",
    );
    unsubscribe();

    expect(waited).toMatchObject({
      runId: firstRunId,
      outcome: "completed",
      finalText: "first exact result",
    });
    expect(waited?.runId).not.toBe(secondRunId);
    expect(sourceActivities).not.toContain("waiting");
  });

  it("returns a settlement that races the final pre-commitment scan", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    const targetRunId = randomUUID();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "raced target result"),
    );
    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      targetRunId,
      "settle during the immediate wait scan",
    );
    await targetStarted.promise;

    let waitResult: unknown;
    let listCalls = 0;
    const sourceActivities: string[] = [];
    const unsubscribe = fixture.coordinator.subscribe(fixture.handle, (event) => {
      if (event.type === "activity" && event.conversationId === source.conversationId) {
        sourceActivities.push(event.activity.kind);
      }
    });
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      const inbox = coordinatorInbox(fixture.handle);
      const originalList = inbox.list.bind(inbox);
      inbox.list = async (...args) => {
        listCalls += 1;
        if (listCalls === 4) {
          releaseTarget.resolve();
          await waitUntil(
            () => target.getActivity().kind === "idle",
            "target settlement during the final commitment scan",
          );
        }
        return originalList(...args);
      };
      try {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "raced-uncommitted-exact-wait",
          { conversationId: target.conversationId, runId: targetRunId },
          undefined,
          { omitSingleWaitCommitment: true },
        );
      } finally {
        inbox.list = originalList;
      }
      control.emitFinal("observed the raced settlement");
    });

    await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "wait only if the target is still running",
    );
    unsubscribe();
    await targetCompletion;

    expect(listCalls).toBeGreaterThanOrEqual(4);
    expect(waitResult).toMatchObject({
      runId: targetRunId,
      outcome: "completed",
      finalText: "raced target result",
    });
    expect(sourceActivities).not.toContain("waiting");
  });

  it("requires a commitment before an exact wait would block", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    const targetRunId = randomUUID();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target result"),
    );
    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      targetRunId,
      "keep running",
    );
    await targetStarted.promise;

    let waitResult: unknown;
    const sourceActivities: string[] = [];
    const unsubscribe = fixture.coordinator.subscribe(fixture.handle, (event) => {
      if (event.type === "activity" && event.conversationId === source.conversationId) {
        sourceActivities.push(event.activity.kind);
      }
    });
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "uncommitted-exact-wait",
        { conversationId: target.conversationId, runId: targetRunId },
        undefined,
        { omitSingleWaitCommitment: true },
      );
      control.emitFinal("continued without blocking");
    });

    await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "try to wait without a reason",
    );
    unsubscribe();

    expect(waitResult).toMatchObject({
      outcome: "single_wait_commitment_required",
      message: expect.stringContaining("No wait was started"),
    });
    expect(sourceActivities).not.toContain("waiting");
    const internal = fixture.handle as unknown as {
      context: { waiters: Map<string, Set<unknown>> };
    };
    expect(internal.context.waiters.size).toBe(0);
    expect(target.getActivity()).toEqual({ kind: "running", runId: targetRunId });

    releaseTarget.resolve();
    await targetCompletion;
  });

  it("resumes an aggregate wait when the second target settles and unregisters the first", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    fixture.runtime.control(first.conversationId).enqueue(
      blocksUntil(firstStarted, releaseFirst, "first result"),
    );
    fixture.runtime.control(second.conversationId).enqueue(
      blocksUntil(secondStarted, releaseSecond, "second result"),
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstCompletion = fixture.coordinator.prompt(
      fixture.handle,
      first.conversationId,
      firstRunId,
      "keep the first target running",
    );
    const secondCompletion = fixture.coordinator.prompt(
      fixture.handle,
      second.conversationId,
      secondRunId,
      "release this target first",
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    let waitResult: (RunSettlement & { conversationId: string }) | undefined;
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-for-any-second-target",
        {
          targets: [{
            conversationId: first.conversationId,
            runId: firstRunId,
          }, {
            conversationId: second.conversationId,
            runId: secondRunId,
          }],
        },
      ) as RunSettlement & { conversationId: string };
      control.emitFinal("source resumed from wait-any");
    });
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "wait for either target",
    );
    await waitUntil(
      () => source.getActivity().kind === "waiting",
      "the aggregate wait registration",
    );
    expect(source.getActivity()).toEqual({
      kind: "waiting",
      runId: expect.any(String),
      targetCount: 2,
    });

    releaseSecond.resolve();
    await expect(secondCompletion).resolves.toMatchObject({
      runId: secondRunId,
      outcome: "completed",
    });
    await expect(sourceCompletion).resolves.toMatchObject({
      outcome: "completed",
    });

    expect(waitResult).toMatchObject({
      conversationId: second.conversationId,
      runId: secondRunId,
      outcome: "completed",
      finalText: "second result",
    });
    expect(first.getActivity()).toEqual({
      kind: "running",
      runId: firstRunId,
    });
    const internal = fixture.handle as unknown as {
      context: { waiters: Map<string, Set<unknown>> };
    };
    expect(internal.context.waiters.size).toBe(0);

    releaseFirst.resolve();
    await expect(firstCompletion).resolves.toMatchObject({
      runId: firstRunId,
      outcome: "completed",
    });
  });

  it("returns a settled aggregate winner without opening a later inactive target", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const settledConversationId = randomUUID();
    const settledRunId = randomUUID();
    const settledManager = await fixture.handle.project.createConversation(
      settledConversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    appendReservedCustomEntry(
      settledManager,
      createRunSettlementEntry({
        runId: settledRunId,
        outcome: "completed",
        finalText: "durable winner",
        settledAt: "2026-08-27T12:00:00.000Z",
      }),
    );
    const inactiveConversationId = randomUUID();
    await fixture.handle.project.createConversation(
      inactiveConversationId,
      defaultProfile(fixture.roles),
      { updateRecent: false },
    );
    let inactiveOpenAttempts = 0;
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId !== inactiveConversationId) return;
      inactiveOpenAttempts++;
      throw new Error("inactive target model is unavailable");
    };

    let waitResult: unknown;
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-any-durable-before-unavailable",
        {
          targets: [{
            conversationId: settledConversationId,
            runId: settledRunId,
          }, {
            conversationId: inactiveConversationId,
            runId: randomUUID(),
          }],
        },
      );
      control.emitFinal("used the durable winner");
    });

    await expect(fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "return the already-settled target",
    )).resolves.toMatchObject({ outcome: "completed" });
    expect(waitResult).toMatchObject({
      conversationId: settledConversationId,
      runId: settledRunId,
      outcome: "completed",
      finalText: "durable winner",
    });
    expect(inactiveOpenAttempts).toBe(0);
  });

  it.each([
    ["completed", "target completed while observed"],
    ["failed", null],
  ] as const)(
    "restores the source run after a genuinely waiting target %s settlement",
    async (outcome, expectedFinalText) => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const target = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const targetStarted = deferred();
      const releaseTarget = deferred();
      fixture.runtime.control(target.conversationId).enqueue(
        async (control) => {
          targetStarted.resolve();
          await releaseTarget.promise;
          if (outcome === "failed") {
            throw new Error("target failed while observed");
          }
          control.emitFinal(expectedFinalText!);
        },
      );
      const targetRunId = randomUUID();
      const targetCompletion = fixture.coordinator.prompt(
        fixture.handle,
        target.conversationId,
        targetRunId,
        "settle only after the source is genuinely waiting",
      );
      await targetStarted.promise;

      const sourceActivities: string[] = [];
      const unsubscribe = fixture.coordinator.subscribe(
        fixture.handle,
        (event) => {
          if (
            event.type === "activity"
            && event.conversationId === source.conversationId
          ) {
            sourceActivities.push(event.activity.kind);
          }
        },
      );
      let waited: RunSettlement | undefined;
      let restoredInsideRun: string | undefined;
      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          waited = await executeTool(
            control,
            "wait_for_session",
            `wait-for-${outcome}`,
            {
              conversationId: target.conversationId,
              runId: targetRunId,
            },
          ) as RunSettlement;
          restoredInsideRun = source.getActivity().kind;
          control.emitFinal("source resumed after observing the target");
        },
      );
      const sourceCompletion = fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "wait for the exact target run",
      );
      await waitUntil(
        () => source.getActivity().kind === "waiting",
        "source waiting projection",
      );
      releaseTarget.resolve();

      await expect(targetCompletion).resolves.toMatchObject({
        runId: targetRunId,
        outcome,
        finalText: expectedFinalText,
      });
      await expect(sourceCompletion).resolves.toMatchObject({
        outcome: "completed",
      });
      unsubscribe();

      expect(waited).toMatchObject({
        runId: targetRunId,
        outcome,
        finalText: expectedFinalText,
      });
      expect(restoredInsideRun).toBe("running");
      expect(sourceActivities).toContain("waiting");
      expect(sourceActivities).toContain("running");
      expect(source.getActivity()).toEqual({ kind: "idle" });
    },
  );

  it("observes a correlated durable message committed before wait registration", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const callerStarted = deferred();
    const beginWait = deferred();
    let peerRunId = "";
    let waitResult: RunSettlement | undefined;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerStarted.resolve();
      await beginWait.promise;
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-after-correlated-message",
        {
          conversationId: peer.conversationId,
          runId: peerRunId,
        },
      ) as RunSettlement;
      control.emitFinal("caller observed the committed reply");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "begin waiting after the peer message commits",
    );
    await callerStarted.promise;

    const peerStarted = deferred();
    const releasePeer = deferred();
    fixture.runtime.control(peer.conversationId).enqueue(
      blocksUntil(peerStarted, releasePeer, "peer completed later"),
    );
    peerRunId = randomUUID();
    const peerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peer.conversationId,
      peerRunId,
      "send before the caller registers its wait",
    );
    await peerStarted.promise;
    await executeTool(
      fixture.runtime.control(peer.conversationId),
      "send_session_message",
      "message-before-wait-registration",
      {
        conversationId: caller.conversationId,
        message: "durable reply committed before subscription",
      },
    );
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))[0]).toMatchObject({
      fromConversationId: peer.conversationId,
      fromRunId: peerRunId,
      state: "processing",
    });

    beginWait.resolve();
    await callerCompletion;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: peer.conversationId,
      runId: peerRunId,
    });
    releasePeer.resolve();
    await peerCompletion;
  });

  it("preserves inbox FIFO when an exact wait reply follows a full steer batch", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const child = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const backlogSender = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.control(child.conversationId).enqueue(
      blocksUntil(childStarted, releaseChild, "child completed"),
    );
    const childRunId = randomUUID();
    const childCompletion = fixture.coordinator.prompt(
      fixture.handle,
      child.conversationId,
      childRunId,
      "prepare the ordered reply",
    );
    await childStarted.promise;

    const waitResolved = deferred();
    const releaseCaller = deferred();
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      await executeTool(
        control,
        "wait_for_session",
        "wait-behind-backlog",
        {
          conversationId: child.conversationId,
          runId: childRunId,
        },
      );
      waitResolved.resolve();
      await releaseCaller.promise;
      control.emitFinal("caller processed ordered messages");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while other peer messages arrive",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait before the ordered backlog",
    );

    const batchSize = 8;
    for (let index = 1; index <= batchSize + 1; index++) {
      await executeTool(
        fixture.runtime.control(backlogSender.conversationId),
        "send_session_message",
        `ordered-backlog-${index}`,
        {
          conversationId: caller.conversationId,
          message: `ordered backlog ${index}`,
        },
      );
    }
    await expect(executeTool(
      fixture.runtime.control(child.conversationId),
      "send_session_message",
      "ordered-exact-reply",
      {
        conversationId: caller.conversationId,
        message: "ordered exact wait reply",
      },
    )).resolves.toMatchObject({ status: "delivered_to_wait" });
    await waitResolved.promise;

    const steers = fixture.runtime.control(caller.conversationId).pendingSteers;
    expect(steers).toHaveLength(batchSize + 2);
    expect(steers[batchSize]?.content)
      .toContain(`ordered backlog ${batchSize + 1}`);
    expect(steers[batchSize + 1]?.content)
      .toContain("ordered exact wait reply");
    expect(await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: `ordered backlog ${batchSize + 1}`,
        state: "processing",
        processingRunId: callerRunId,
      }),
      expect.objectContaining({
        body: "ordered exact wait reply",
        state: "processing",
        processingRunId: callerRunId,
      }),
    ]));

    releaseCaller.resolve();
    await callerCompletion;
    releaseChild.resolve();
    await childCompletion;
  });

  it("delivers a child message directly into an exact caller wait", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const child = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.control(child.conversationId).enqueue(
      blocksUntil(childStarted, releaseChild, "reply through the awaited run"),
    );
    const childRunId = randomUUID();
    const childCompletion = fixture.coordinator.prompt(
      fixture.handle,
      child.conversationId,
      childRunId,
      "prepare a reply",
    );
    await childStarted.promise;

    let waited: RunSettlement | undefined;
    const callerMessageDelivered = deferred();
    const releaseCaller = deferred();
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waited = await executeTool(
        control,
        "wait_for_session",
        "wait-for-child-reply",
        {
          conversationId: child.conversationId,
          runId: childRunId,
        },
      ) as RunSettlement;
      control.beginNextModelTurn();
      callerMessageDelivered.resolve();
      await releaseCaller.promise;
      control.emitFinal("caller resumed");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait for the child",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller to enter its exact wait",
    );

    await expect(executeTool(
      fixture.runtime.control(child.conversationId),
      "send_session_message",
      "circular-child-reply",
      {
        conversationId: caller.conversationId,
        message: "Reply while the child keeps working.",
      },
    )).resolves.toMatchObject({
      status: "delivered_to_wait",
      conversationId: caller.conversationId,
    });
    await callerMessageDelivered.promise;
    await expect(coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    })).resolves.toEqual([
      expect.objectContaining({
        state: "processing",
        processingRunId: callerRunId,
        processingDelivery: "steer",
      }),
    ]);
    releaseCaller.resolve();

    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(waited).toMatchObject({
      outcome: "message",
      conversationId: child.conversationId,
      runId: childRunId,
    });
    expect(
      fixture.runtime.control(caller.conversationId)
        .modelRequestCustomMessages,
    ).toEqual([[expect.objectContaining({
      content: expect.stringContaining("Reply while the child keeps working."),
      deliverAs: "steer",
    })]]);
    expect(child.getActivity()).toMatchObject({
      kind: "running",
      runId: childRunId,
    });
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toHaveLength(1);
    expect(
      fixture.runtime.control(caller.conversationId).received[0]?.content,
    ).toContain("Reply while the child keeps working.");
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))).toHaveLength(0);

    releaseChild.resolve();
    await expect(childCompletion).resolves.toMatchObject({
      runId: childRunId,
      outcome: "completed",
    });
  });

  it("ends a wait for a canonical but wrong runId when the peer's real active run sends", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerStarted = deferred();
    const releasePeer = deferred();
    fixture.runtime.control(peer.conversationId).enqueue(
      blocksUntil(peerStarted, releasePeer, "peer real run completed"),
    );
    const peerRunId = randomUUID();
    const peerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peer.conversationId,
      peerRunId,
      "send from the real active run",
    );
    await peerStarted.promise;

    const waitResolved = deferred();
    const releaseCaller = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-for-wrong-run",
        {
          conversationId: peer.conversationId,
          runId: RUN_A,
        },
      );
      control.beginNextModelTurn();
      waitResolved.resolve();
      await releaseCaller.promise;
      control.emitFinal("caller resumed after the real peer message");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait for a run that never settles",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait on the canonical-but-wrong runId",
    );

    await expect(executeTool(
      fixture.runtime.control(peer.conversationId),
      "send_session_message",
      "real-run-wake-up",
      {
        conversationId: caller.conversationId,
        message: "Wake the caller from its unmatched wait.",
      },
    )).resolves.toMatchObject({
      status: "delivered_to_wait",
      conversationId: caller.conversationId,
    });
    await waitResolved.promise;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: peer.conversationId,
      runId: peerRunId,
      messageId: expect.any(String),
      sentAt: expect.any(String),
    });
    expect(peer.getActivity()).toMatchObject({
      kind: "running",
      runId: peerRunId,
    });
    expect(
      fixture.runtime.control(caller.conversationId)
        .modelRequestCustomMessages,
    ).toEqual([[expect.objectContaining({
      content: expect.stringContaining("Wake the caller from its unmatched wait."),
      deliverAs: "steer",
    })]]);
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toHaveLength(1);
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))).toContainEqual(expect.objectContaining({
      fromConversationId: peer.conversationId,
      fromRunId: peerRunId,
      state: "processing",
      processingRunId: callerRunId,
    }));

    releaseCaller.resolve();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    releasePeer.resolve();
    await expect(peerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: peerRunId,
    });
  });

  it("keeps inbox FIFO when a wait resolves at registration from the claimed backlog", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const backlogStarted = deferred();
    const releaseBacklog = deferred();
    const backlogSender = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(backlogSender.conversationId).enqueue(
      blocksUntil(backlogStarted, releaseBacklog, "backlog sender completed"),
    );
    const backlogRunId = randomUUID();
    const backlogCompletion = fixture.coordinator.prompt(
      fixture.handle,
      backlogSender.conversationId,
      backlogRunId,
      "send the ordered backlog",
    );
    await backlogStarted.promise;
    const messengerStarted = deferred();
    const releaseMessenger = deferred();
    const messenger = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(messenger.conversationId).enqueue(
      blocksUntil(messengerStarted, releaseMessenger, "messenger completed"),
    );
    const messengerRunId = randomUUID();
    const messengerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      messenger.conversationId,
      messengerRunId,
      "send after the wait registered",
    );
    await messengerStarted.promise;

    const callerAtGate = deferred();
    const beginWait = deferred();
    const waitResolved = deferred();
    const releaseCaller = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerAtGate.resolve();
      await beginWait.promise;
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-behind-pre-registration-backlog",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      control.beginNextModelTurn();
      waitResolved.resolve();
      await releaseCaller.promise;
      control.emitFinal("caller processed the ordered messages");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait behind a pre-registration backlog",
    );
    await callerAtGate.promise;

    const batchSize = 8;
    for (let index = 1; index <= batchSize + 1; index++) {
      await executeTool(
        fixture.runtime.control(backlogSender.conversationId),
        "send_session_message",
        `pre-registration-backlog-${index}`,
        {
          conversationId: caller.conversationId,
          message: `pre-registration backlog ${index}`,
        },
      );
    }
    beginWait.resolve();

    // The wait registers and immediately resolves with the FIRST message
    // already durably claimed into the current run's steering queue: real
    // source metadata, no separate re-injection, no settlement required.
    await waitResolved.promise;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: backlogSender.conversationId,
      runId: backlogRunId,
      messageId: expect.any(String),
    });
    const firstBatch = fixture.runtime.control(caller.conversationId)
      .modelRequestCustomMessages[0];
    expect(firstBatch).toHaveLength(batchSize);
    expect(firstBatch?.[0]?.content)
      .toContain("pre-registration backlog 1");
    expect(firstBatch?.[batchSize - 1]?.content)
      .toContain(`pre-registration backlog ${batchSize}`);
    const claimedInbox = await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    });
    expect(claimedInbox[0]).toMatchObject({
      body: "pre-registration backlog 1",
      state: "processing",
      processingRunId: callerRunId,
      waitedByRunId: callerRunId,
    });
    expect(claimedInbox[1]).toMatchObject({
      body: "pre-registration backlog 2",
      state: "processing",
      processingRunId: callerRunId,
    });

    // A later message must still not overtake the queued 9th predecessor.
    await expect(executeTool(
      fixture.runtime.control(messenger.conversationId),
      "send_session_message",
      "unmatched-wake-behind-backlog",
      {
        conversationId: caller.conversationId,
        message: "unmatched wake-up behind the backlog",
      },
    )).resolves.toMatchObject({ status: "processing" });
    const steers = fixture.runtime.control(caller.conversationId).pendingSteers;
    expect(steers).toHaveLength(2);
    expect(steers[0]?.content)
      .toContain(`pre-registration backlog ${batchSize + 1}`);
    expect(steers[1]?.content)
      .toContain("unmatched wake-up behind the backlog");

    releaseCaller.resolve();
    await callerCompletion;
    releaseBacklog.resolve();
    await backlogCompletion;
    releaseMessenger.resolve();
    await messengerCompletion;
  });

  it("resolves a wait at registration from a message already claimed into the current run's queue", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const messengerStarted = deferred();
    const releaseMessenger = deferred();
    const messenger = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(messenger.conversationId).enqueue(
      blocksUntil(messengerStarted, releaseMessenger, "messenger completed"),
    );
    const messengerRunId = randomUUID();
    const messengerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      messenger.conversationId,
      messengerRunId,
      "send before the caller waits",
    );
    await messengerStarted.promise;

    const callerAtGate = deferred();
    const beginWait = deferred();
    const waitResolved = deferred();
    const releaseCaller = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerAtGate.resolve();
      await beginWait.promise;
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-after-pre-claimed-message",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
        undefined,
        { omitSingleWaitCommitment: true },
      );
      control.beginNextModelTurn();
      waitResolved.resolve();
      await releaseCaller.promise;
      control.emitFinal("caller consumed the pre-claimed message");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait after an unrelated message was already claimed",
    );
    await callerAtGate.promise;

    // B's message is durably claimed into the caller's CURRENT run queue
    // while the run is still active but before any wait is registered.
    await expect(executeTool(
      fixture.runtime.control(messenger.conversationId),
      "send_session_message",
      "pre-registration-claim",
      {
        conversationId: caller.conversationId,
        message: "claimed into the queue before the wait registered",
      },
    )).resolves.toMatchObject({ status: "processing" });
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))[0]).toMatchObject({
      state: "processing",
      processingRunId: callerRunId,
    });

    // No further message arrives; the wait must still end immediately with
    // B's real source metadata and inject the message exactly once.
    beginWait.resolve();
    await waitResolved.promise;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: messenger.conversationId,
      runId: messengerRunId,
      messageId: expect.any(String),
      sentAt: expect.any(String),
    });
    expect(
      fixture.runtime.control(caller.conversationId)
        .modelRequestCustomMessages,
    ).toEqual([[expect.objectContaining({
      content: expect.stringContaining(
        "claimed into the queue before the wait registered",
      ),
      deliverAs: "steer",
    })]]);
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toHaveLength(1);
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))[0]).toMatchObject({
      waitedByRunId: callerRunId,
    });

    releaseCaller.resolve();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    releaseMessenger.resolve();
    await expect(messengerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: messengerRunId,
    });
  });

  it("latches user guidance admitted before the wait registration", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitStarted = deferred();
    const guidanceResolved = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waitStarted.resolve();
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-while-registration-is-gated",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      guidanceResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance");
      control.beginNextModelTurn();
      control.emitFinal("caller resumed after latched guidance");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while its registration is gated",
    );
    await waitStarted.promise;

    // Hold the project lifecycle so the waiter registration task cannot run.
    // The wait tool's preliminary lifecycle work is already queued ahead of
    // this gate; by the time the gate is released the wait has passed
    // enterWaiting (phase=waiting) and the registration task is queued behind
    // the gate, where the steer admission must be latched.
    const context = (fixture.handle as unknown as {
      context: { lifecycle: SerialTaskQueue };
    }).context;
    const gate = deferred();
    const gateTask = context.lifecycle.run(() => gate.promise);
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the wait phase before its registration task runs",
    );

    const guidance = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance",
    );
    gate.resolve();
    await gateTask;
    await expect(Promise.race([
      guidanceResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1500)
      ),
    ])).resolves.toBe("resolved");
    expect(waitResult).toEqual({ outcome: "guidance" });
    await expect(guidance).resolves.toBeUndefined();
    expect(fixture.runtime.control(caller.conversationId).steerTexts)
      .toEqual(["user guidance"]);
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    expect(waitedPeer.getActivity()).toMatchObject({ kind: "idle" });
  });

  it("does not establish a temporary return receipt when an unrelated message ends a temporary wait", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "temporary final answer"),
    ]);
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "unrelated-wake-up-has-no-receipt",
      }),
    );
    await temporaryStarted.promise;
    const messengerStarted = deferred();
    const releaseMessenger = deferred();
    const messenger = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(messenger.conversationId).enqueue(
      blocksUntil(messengerStarted, releaseMessenger, "messenger completed"),
    );
    const messengerRunId = randomUUID();
    const messengerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      messenger.conversationId,
      messengerRunId,
      "send unrelated progress",
    );
    await messengerStarted.promise;

    const waitResolved = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "temporary-unrelated-wake-up",
        {
          conversationId: temporary.conversationId,
          runId: temporary.runId,
        },
      );
      control.beginNextModelTurn();
      waitResolved.resolve();
      control.emitFinal("caller consumed the unrelated wake-up");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for the temporary run while an unrelated peer sends",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's exact temporary wait",
    );

    await expect(executeTool(
      fixture.runtime.control(messenger.conversationId),
      "send_session_message",
      "unrelated-temporary-wake-up-message",
      {
        conversationId: caller.conversationId,
        message: "Unrelated progress while the temporary run is pending.",
      },
    )).resolves.toMatchObject({ status: "delivered_to_wait" });
    await waitResolved.promise;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: messenger.conversationId,
      runId: messengerRunId,
    });
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toEqual([]);
    await callerCompletion;

    releaseTemporary.resolve();
    await waitUntil(() =>
      fixture.runtime.control(caller.conversationId).received.some((message) =>
        (message.details as { kind?: string } | undefined)?.kind
          === "delegation_result"
      ),
    "automatic delegation result after the unrelated wake-up");
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toEqual([]);
    releaseMessenger.resolve();
    await messengerCompletion;
  });

  it("ends a waiting run when user guidance is accepted into its steering queue", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitResolved = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-for-guidance",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      waitResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance");
      control.beginNextModelTurn();
      control.emitFinal("caller resumed after user guidance");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while the user steers",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait that user guidance must end",
    );

    const guidance = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance",
    );
    await waitResolved.promise;
    expect(waitResult).toEqual({ outcome: "guidance" });
    await expect(guidance).resolves.toBeUndefined();
    expect(fixture.runtime.control(caller.conversationId).steerTexts)
      .toEqual(["user guidance"]);
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    expect(waitedPeer.getActivity()).toMatchObject({ kind: "idle" });
  });

  it("wakes a waiting run when a browser busy prompt is accepted and settles its raw delivery once", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitResolved = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-for-browser-prompt",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      waitResolved.resolve();
      // Real SDK order: the initial prompt's raw end comes first, then the
      // busy admission's delivery.
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("browser guidance");
      control.beginNextModelTurn();
      control.emitFinal("caller resumed after browser guidance");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while the user sends a browser message",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait that the browser prompt must end",
    );

    await expect(fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "browser guidance",
      "browser-guidance-prompt-1",
    )).resolves.toEqual({ outcome: "admitted" });
    await expect(Promise.race([
      waitResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1500)
      ),
    ])).resolves.toBe("resolved");
    expect(waitResult).toEqual({ outcome: "guidance" });
    expect(caller.pendingPromptAdmissions()).toEqual([]);
    // The guidance body is injected exactly once via its raw user message.
    const userTexts = caller.sessionManager.getEntries()
      .map((entry) => (entry as { message?: unknown }).message)
      .filter((message): message is { role: string; content: string } =>
        message !== undefined
        && typeof message === "object"
        && (message as { role?: unknown }).role === "user"
        && typeof (message as { content?: unknown }).content === "string"
      )
      .map((message) => message.content);
    expect(userTexts.filter((text) => text === "browser guidance"))
      .toHaveLength(1);
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    expect(waitedPeer.getActivity()).toMatchObject({ kind: "idle" });
  });

  it("rejects a busy prompt whose preflight passed but added no steering entry", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitResolved = deferred();
    const abort = new AbortController();
    let waitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "wait-behind-ghost-admission",
          {
            conversationId: waitedPeer.conversationId,
            runId: RUN_A,
          },
          abort.signal,
        );
      } catch (error) {
        waitError = error;
      }
      waitResolved.resolve();
      control.emitFinal("caller resumed after the ghost rejection");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while an extension consumes a prompt",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait",
    );

    // Extension-handled input: the SDK preflights true but never queues a
    // steering entry. Fail closed: reject, no admission, no wait wake.
    const control = fixture.runtime.control(caller.conversationId);
    control.steerPromptHandled = true;
    await expect(fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "handled prompt",
      "handled-prompt-1",
    )).rejects.toThrow("handled without being queued for steering");
    control.steerPromptHandled = undefined;
    expect(caller.pendingPromptAdmissions()).toEqual([]);
    await expect(Promise.race([
      waitResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 300)
      ),
    ])).resolves.toBe("timeout");

    abort.abort();
    await waitResolved.promise;
    expect(waitError).toMatchObject({ name: "AbortError" });
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("settles an expanded browser delivery by the SDK queued text and retires the record", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const delivered: Array<{ promptId: string }> = [];
    const unsubscribe = fixture.coordinator.subscribe(fixture.handle, (event) => {
      if (event.type === "prompt_delivered") delivered.push(event);
    });
    const firstResolved = deferred();
    const secondAttempted = deferred();
    const secondResolved = deferred();
    let firstResult: unknown;
    let secondResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      firstResult = await executeTool(
        control,
        "wait_for_session",
        "wait-for-expanded-delivery",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      firstResolved.resolve();
      // Real SDK order: the initial prompt's raw end comes first, then the
      // expanded browser delivery.
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("EXPANDED guidance");
      secondAttempted.resolve();
      secondResult = await executeTool(
        control,
        "wait_for_session",
        "wait-after-expanded-delivery",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      secondResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance two");
      control.beginNextModelTurn();
      control.emitFinal("caller consumed the expanded guidance");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while the SDK expands a browser prompt",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the first wait",
    );

    // The SDK queues the EXPANDED text; the admission must record it and the
    // raw transformed delivery must settle the ORIGINAL promptId.
    const control = fixture.runtime.control(caller.conversationId);
    control.steerPromptExpandedText = "EXPANDED guidance";
    await expect(fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "browser guidance",
      "expanded-prompt-1",
    )).resolves.toEqual({ outcome: "admitted" });
    control.steerPromptExpandedText = undefined;
    await firstResolved.promise;
    expect(firstResult).toEqual({ outcome: "guidance" });
    await secondAttempted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the second wait after the expanded raw delivery",
    );
    expect(delivered).toEqual([{
      type: "prompt_delivered",
      conversationId: caller.conversationId,
      promptId: "expanded-prompt-1",
      runId: callerRunId,
    }]);
    expect(caller.pendingPromptAdmissions()).toEqual([]);
    // The retired record must not wake the later wait.
    await expect(Promise.race([
      secondResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 300)
      ),
    ])).resolves.toBe("timeout");
    unsubscribe();

    const secondSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance two",
    );
    await secondResolved.promise;
    expect(secondResult).toEqual({ outcome: "guidance" });
    await expect(secondSteer).resolves.toBeUndefined();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("wakes at wait registration from guidance accepted before waitForSession started", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const callerAtGate = deferred();
    const beginWait = deferred();
    const waitResolved = deferred();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerAtGate.resolve();
      await beginWait.promise;
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-after-accepted-guidance",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      waitResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance");
      control.beginNextModelTurn();
      control.emitFinal("caller resumed after pre-wait guidance");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait after guidance was accepted",
    );
    await callerAtGate.promise;

    // Guidance is SDK-accepted while the run is still active but before the
    // wait tool is even called; no raw user message_end has been observed.
    // The later wait registration must consume it immediately.
    const guidance = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance",
    );
    beginWait.resolve();
    await expect(Promise.race([
      waitResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1500)
      ),
    ])).resolves.toBe("resolved");
    expect(waitResult).toEqual({ outcome: "guidance" });
    await expect(guidance).resolves.toBeUndefined();
    expect(fixture.runtime.control(caller.conversationId).steerTexts)
      .toEqual(["user guidance"]);
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
    expect(waitedPeer.getActivity()).toMatchObject({ kind: "idle" });
  });

  it("never wakes a later wait from rejected guidance", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitResolved = deferred();
    const abort = new AbortController();
    let waitResult: unknown;
    let waitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "wait-after-rejected-guidance",
          {
            conversationId: waitedPeer.conversationId,
            runId: RUN_A,
          },
          abort.signal,
        );
      } catch (error) {
        waitError = error;
      }
      waitResolved.resolve();
      control.emitFinal("caller resumed after abort");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait after rejected guidance",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait after the rejected steer",
    );

    const control = fixture.runtime.control(caller.conversationId);
    control.steerImplementation = () => {
      throw new Error("SDK steer rejected");
    };
    await expect(fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "rejected steer",
    )).rejects.toMatchObject({
      message: expect.stringContaining("SDK steer rejected"),
    });
    control.steerImplementation = () => undefined;
    control.steerPromptPreflightResult = false;
    await expect(fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "rejected prompt",
      "rejected-prompt-1",
    )).rejects.toThrow("Prompt preflight rejected");
    control.steerPromptPreflightResult = undefined;
    expect(caller.pendingPromptAdmissions()).toEqual([]);

    // Neither rejection may leave accepted guidance behind or wake the wait.
    await expect(Promise.race([
      waitResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 300)
      ),
    ])).resolves.toBe("timeout");

    abort.abort();
    await waitResolved.promise;
    expect(waitResult).toBeUndefined();
    expect(waitError).toMatchObject({ name: "AbortError" });
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("wakes two sequential waits on two distinct accepted guidance records", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstResolved = deferred();
    const secondAttempted = deferred();
    const secondResolved = deferred();
    let firstResult: unknown;
    let secondResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      firstResult = await executeTool(
        control,
        "wait_for_session",
        "fifo-first-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      firstResolved.resolve();
      secondAttempted.resolve();
      secondResult = await executeTool(
        control,
        "wait_for_session",
        "fifo-second-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
        undefined,
        { omitSingleWaitCommitment: true },
      );
      secondResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance one");
      control.emitUserMessage("user guidance two");
      control.beginNextModelTurn();
      control.emitFinal("caller observed both guidance messages");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait twice while two guidance messages are accepted",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the first wait",
    );

    // Two guidance records are accepted while the first wait is pending. The
    // first wait is woken exactly once; the second wait must be woken by the
    // second record, never re-woken by the one the first wait claimed.
    const firstSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance one",
    );
    const secondSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance two",
    );
    await firstResolved.promise;
    expect(firstResult).toEqual({ outcome: "guidance" });
    await secondAttempted.promise;
    await secondResolved.promise;
    expect(secondResult).toEqual({ outcome: "guidance" });
    await expect(firstSteer).resolves.toBeUndefined();
    await expect(secondSteer).resolves.toBeUndefined();
    expect(fixture.runtime.control(caller.conversationId).steerTexts)
      .toEqual(["user guidance one", "user guidance two"]);
    const userTexts = caller.sessionManager.getEntries()
      .map((entry) => (entry as { message?: unknown }).message)
      .filter((message): message is { role: string; content: string } =>
        message !== undefined
        && typeof message === "object"
        && (message as { role?: unknown }).role === "user"
        && typeof (message as { content?: unknown }).content === "string"
      )
      .map((message) => message.content);
    expect(userTexts.filter((text) => text === "user guidance one"))
      .toHaveLength(1);
    expect(userTexts.filter((text) => text === "user guidance two"))
      .toHaveLength(1);
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("does not re-wake a later wait on guidance already claimed by an earlier wait", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstResolved = deferred();
    const secondAttempted = deferred();
    const secondResolved = deferred();
    let firstResult: unknown;
    let secondResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      firstResult = await executeTool(
        control,
        "wait_for_session",
        "claimed-first-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      firstResolved.resolve();
      secondAttempted.resolve();
      secondResult = await executeTool(
        control,
        "wait_for_session",
        "claimed-second-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      secondResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("user guidance one");
      control.emitUserMessage("user guidance two");
      control.beginNextModelTurn();
      control.emitFinal("caller observed both guidance messages");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait twice while one guidance is still unobserved",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the first wait",
    );

    const firstSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance one",
    );
    await firstResolved.promise;
    expect(firstResult).toEqual({ outcome: "guidance" });
    await secondAttempted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the second wait to register before the raw observation",
    );

    // The first guidance is still unobserved (no raw user message_end yet) but
    // already claimed by the first wait: it must not wake the second wait.
    await expect(Promise.race([
      secondResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 300)
      ),
    ])).resolves.toBe("timeout");
    const secondSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance two",
    );
    await secondResolved.promise;
    expect(secondResult).toEqual({ outcome: "guidance" });
    await expect(firstSteer).resolves.toBeUndefined();
    await expect(secondSteer).resolves.toBeUndefined();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("does not wake a later wait from browser guidance whose raw delivery was already observed", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstResolved = deferred();
    const secondAttempted = deferred();
    const secondResolved = deferred();
    let firstResult: unknown;
    let secondResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      firstResult = await executeTool(
        control,
        "wait_for_session",
        "browser-observed-first-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      firstResolved.resolve();
      control.emitUserMessage("initial prompt settlement");
      control.emitUserMessage("browser guidance");
      secondAttempted.resolve();
      secondResult = await executeTool(
        control,
        "wait_for_session",
        "browser-observed-second-wait",
        {
          conversationId: waitedPeer.conversationId,
          runId: RUN_A,
        },
      );
      secondResolved.resolve();
      control.emitUserMessage("user guidance two");
      control.beginNextModelTurn();
      control.emitFinal("caller observed the browser guidance once");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait twice around an observed browser prompt",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the first wait",
    );

    await expect(fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "browser guidance",
      "browser-guidance-prompt-2",
    )).resolves.toEqual({ outcome: "admitted" });
    await firstResolved.promise;
    expect(firstResult).toEqual({ outcome: "guidance" });
    await secondAttempted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the second wait after the browser raw delivery",
    );

    // The browser guidance was raw-delivered before the second wait started:
    // its accepted record must have been retired, so the second wait stays
    // pending until a NEW guidance arrives.
    await expect(Promise.race([
      secondResolved.promise.then(() => "resolved"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 300)
      ),
    ])).resolves.toBe("timeout");
    const secondSteer = fixture.coordinator.steer(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "user guidance two",
    );
    await secondResolved.promise;
    expect(secondResult).toEqual({ outcome: "guidance" });
    await expect(secondSteer).resolves.toBeUndefined();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: callerRunId,
    });
  });

  it("fails closed when a through-drain predecessor steer is SDK-rejected", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const waitedPeer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const backlogSender = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const messengerStarted = deferred();
    const releaseMessenger = deferred();
    const messenger = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.control(messenger.conversationId).enqueue(
      blocksUntil(messengerStarted, releaseMessenger, "messenger completed"),
    );
    const messengerRunId = randomUUID();
    const messengerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      messenger.conversationId,
      messengerRunId,
      "wake the waiting caller",
    );
    await messengerStarted.promise;

    const callerAtGate = deferred();
    const beginWait = deferred();
    const waitResolved = deferred();
    const releaseCaller = deferred();
    let waitResult: unknown;
    let waitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerAtGate.resolve();
      await beginWait.promise;
      // Consume the backlog steers so their durable markers persist; the 9th
      // message stays queued behind the batch cap.
      control.beginNextModelTurn();
      try {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "wait-behind-failed-predecessor",
          {
            conversationId: waitedPeer.conversationId,
            runId: RUN_A,
          },
        );
      } catch (error) {
        waitError = error;
      }
      waitResolved.resolve();
      control.beginNextModelTurn();
      await releaseCaller.promise;
      control.emitFinal("caller released after the failed through drain");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait behind a failed predecessor",
    );
    await callerAtGate.promise;

    // Step 1: a full backlog batch is claimed into the caller's current run
    // while it is active but not waiting; the 9th message stays durably
    // queued as the through drain's FIFO predecessor.
    const batchSize = 8;
    for (let index = 1; index <= batchSize + 1; index++) {
      await executeTool(
        fixture.runtime.control(backlogSender.conversationId),
        "send_session_message",
        `through-predecessor-${index}`,
        {
          conversationId: caller.conversationId,
          message: `through predecessor ${index}`,
        },
      );
    }
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))[batchSize]).toMatchObject({
      body: `through predecessor ${batchSize + 1}`,
      state: "queued",
    });
    beginWait.resolve();
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller wait behind the queued predecessor",
    );

    // Step 2: the wake message's through drain claims the queued predecessor
    // and the SDK rejects that steer. Fail closed: the send and the wait must
    // both reject, leaving both envelopes queued.
    let rejectSteer = true;
    const callerSession = caller.session as unknown as {
      sendCustomMessage: typeof caller.session.sendCustomMessage;
    };
    const originalSend = callerSession.sendCustomMessage.bind(caller.session);
    callerSession.sendCustomMessage = async (message, options) => {
      if (rejectSteer && options?.deliverAs === "steer") {
        rejectSteer = false;
        throw new Error("simulated SDK steer rejection");
      }
      return originalSend(message, options);
    };
    const wakeSend = executeTool(
      fixture.runtime.control(messenger.conversationId),
      "send_session_message",
      "wake-behind-failed-predecessor",
      {
        conversationId: caller.conversationId,
        message: "wake message",
      },
    );
    await expect(wakeSend).rejects.toThrow("simulated SDK steer rejection");
    await waitResolved.promise;
    expect(waitResult).toBeUndefined();
    expect(waitError).toMatchObject({
      message: expect.stringContaining("simulated SDK steer rejection"),
    });
    expect(caller.getActivity()).toMatchObject({
      kind: "running",
      runId: callerRunId,
    });
    // Nothing was claimed into the waiting run: the failed predecessor and
    // the wake envelope stay queued and no waiter remains registered.
    expect(
      fixture.runtime.control(caller.conversationId).pendingSteers,
    ).toHaveLength(0);
    const inboxAfter = await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    });
    expect(inboxAfter[batchSize]).toMatchObject({
      body: `through predecessor ${batchSize + 1}`,
      state: "queued",
    });
    expect(inboxAfter[batchSize + 1]).toMatchObject({
      body: "wake message",
      state: "queued",
    });
    expect(
      (fixture.handle as unknown as {
        context: { waiters: Map<string, unknown> };
      }).context.waiters.size,
    ).toBe(0);

    // Step 3: releasing the run lets the durable pump deliver the remaining
    // messages in FIFO order without loss.
    releaseCaller.resolve();
    await callerCompletion;
    await waitUntil(async () =>
      (await coordinatorInbox(fixture.handle).list({
        toConversationId: caller.conversationId,
      })).length === 0,
    "the durable pump to drain the remaining messages");
    const received = fixture.runtime.control(caller.conversationId).received;
    expect(
      received.findIndex(({ content }) =>
        content.includes(`through predecessor ${batchSize + 1}`)
      ),
    ).toBeLessThan(
      received.findIndex(({ content }) => content.includes("wake message")),
    );
    callerSession.sendCustomMessage = originalSend;

    releaseMessenger.resolve();
    await expect(messengerCompletion).resolves.toMatchObject({
      outcome: "completed",
      runId: messengerRunId,
    });
  });

  it("does not return one correlated message from two waits in the same run", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerStarted = deferred();
    const releasePeer = deferred();
    fixture.runtime.control(peer.conversationId).enqueue(
      blocksUntil(peerStarted, releasePeer, "peer final settlement"),
    );
    const peerRunId = randomUUID();
    const peerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peer.conversationId,
      peerRunId,
      "send once and remain active",
    );
    await peerStarted.promise;

    const firstWaitResolved = deferred();
    const secondWaitStarted = deferred();
    let firstResult: RunSettlement | undefined;
    let secondResult: RunSettlement | undefined;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      firstResult = await executeTool(
        control,
        "wait_for_session",
        "first-wait-for-one-message",
        {
          conversationId: peer.conversationId,
          runId: peerRunId,
        },
      ) as RunSettlement;
      control.beginNextModelTurn();
      firstWaitResolved.resolve();
      secondWaitStarted.resolve();
      secondResult = await executeTool(
        control,
        "wait_for_session",
        "second-wait-after-one-message",
        {
          conversationId: peer.conversationId,
          runId: peerRunId,
        },
      ) as RunSettlement;
      control.emitFinal("caller observed message then settlement");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait twice without replaying one message",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the first exact wait",
    );

    await executeTool(
      fixture.runtime.control(peer.conversationId),
      "send_session_message",
      "one-message-for-two-waits",
      {
        conversationId: caller.conversationId,
        message: "observe this correlated message only once",
      },
    );
    await firstWaitResolved.promise;
    await secondWaitStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the second wait to remain pending",
    );
    expect(firstResult).toMatchObject({
      outcome: "message",
      messageId: expect.any(String),
    });
    expect(secondResult).toBeUndefined();
    expect((await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    }))[0]).toMatchObject({
      waitedByRunId: expect.any(String),
    });

    releasePeer.resolve();
    await peerCompletion;
    await callerCompletion;
    expect(secondResult).toMatchObject({
      outcome: "completed",
      runId: peerRunId,
    });
  });

  it("rejects an exact wait if its sender-card projection cannot be appended", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerStarted = deferred();
    const releasePeer = deferred();
    fixture.runtime.control(peer.conversationId).enqueue(
      blocksUntil(peerStarted, releasePeer, "peer finished"),
    );
    const peerRunId = randomUUID();
    const peerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peer.conversationId,
      peerRunId,
      "send a reply whose card projection fails",
    );
    await peerStarted.promise;

    const waitRejected = deferred();
    const releaseCaller = deferred();
    let waitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "wait-for-card-append-failure",
          {
            conversationId: peer.conversationId,
            runId: peerRunId,
          },
        );
      } catch (error) {
        waitError = error;
        waitRejected.resolve();
      }
      await releaseCaller.promise;
      control.emitFinal("caller recovered from projection failure");
    });
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait for a projection failure",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the wait before sender-card append failure",
    );

    const manager = peer.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let rejectDeliveredCard = true;
    manager.appendCustomEntry = (customType, data) => {
      if (
        rejectDeliveredCard
        && customType === CONVERSATION_CARD_CUSTOM_TYPE
        && (data as { state?: string }).state === "delivered"
      ) {
        rejectDeliveredCard = false;
        throw new Error("simulated delivered-card append failure");
      }
      return originalAppend(customType, data);
    };

    await expect(executeTool(
      fixture.runtime.control(peer.conversationId),
      "send_session_message",
      "reply-with-card-append-failure",
      {
        conversationId: caller.conversationId,
        message: "the wait must settle even if projection fails",
      },
    )).rejects.toThrow("simulated delivered-card append failure");
    await waitRejected.promise;
    expect(waitError).toMatchObject({
      message: expect.stringContaining("delivered-card append failure"),
    });
    expect(caller.getActivity().kind).toBe("running");
    expect(await coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    })).toContainEqual(expect.objectContaining({
      waitedByRunId: callerRunId,
    }));

    const retryAbort = new AbortController();
    const retryWait = executeTool(
      fixture.runtime.control(caller.conversationId),
      "wait_for_session",
      "retry-after-card-append-failure",
      {
        conversationId: peer.conversationId,
        runId: peerRunId,
      },
      retryAbort.signal,
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "a retry to skip the already consumed message",
    );
    const retryRejected = expect(retryWait).rejects.toMatchObject({
      name: "AbortError",
    });
    retryAbort.abort();
    await retryRejected;

    releaseCaller.resolve();
    await callerCompletion;
    releasePeer.resolve();
    await peerCompletion;
  });

  it("requeues a rendezvous message until the target records its delivery marker", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const child = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.control(child.conversationId).enqueue(
      blocksUntil(childStarted, releaseChild, "child finished later"),
    );
    const childRunId = randomUUID();
    const childCompletion = fixture.coordinator.prompt(
      fixture.handle,
      child.conversationId,
      childRunId,
      "prepare a recoverable reply",
    );
    await childStarted.promise;

    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      await executeTool(
        control,
        "wait_for_session",
        "wait-before-delivery-marker",
        {
          conversationId: child.conversationId,
          runId: childRunId,
        },
      );
      control.emitFinal("caller settled before the steering marker");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for a steering reply",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the recoverable caller wait",
    );
    fixture.runtime.control(caller.conversationId)
      .skipNextCustomMessagePersistence = true;

    await expect(executeTool(
      fixture.runtime.control(child.conversationId),
      "send_session_message",
      "message-before-marker",
      {
        conversationId: caller.conversationId,
        message: "Do not lose this before its delivery marker.",
      },
    )).resolves.toMatchObject({ status: "delivered_to_wait" });
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
    });
    await waitUntil(
      async () => (
        await coordinatorInbox(fixture.handle).list({
          toConversationId: caller.conversationId,
        })
      ).length === 0,
      "the unmarked rendezvous message to be requeued and delivered",
    );
    expect(
      fixture.runtime.control(caller.conversationId).received[0]?.content,
    ).toContain("Do not lose this before its delivery marker.");
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toHaveLength(1);

    releaseChild.resolve();
    await expect(childCompletion).resolves.toMatchObject({
      runId: childRunId,
      outcome: "completed",
    });
  });

  it("falls back to the durable inbox when a wait is cancelled during delivery", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const child = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.control(child.conversationId).enqueue(
      blocksUntil(childStarted, releaseChild, "child done"),
    );
    const childRunId = randomUUID();
    const childCompletion = fixture.coordinator.prompt(
      fixture.handle,
      child.conversationId,
      childRunId,
      "prepare a cancellable reply",
    );
    await childStarted.promise;

    const waitAbort = new AbortController();
    const keepCallerRunning = deferred();
    let waitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "cancelled-wait",
          {
            conversationId: child.conversationId,
            runId: childRunId,
          },
          waitAbort.signal,
        );
      } catch (error) {
        waitError = error;
      }
      await keepCallerRunning.promise;
      control.emitFinal("caller handled cancellation");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait until cancelled",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the cancellable wait",
    );

    const inbox = coordinatorInbox(fixture.handle);
    waitAbort.abort();
    await waitUntil(
      () => caller.getActivity().kind === "running",
      "the cancelled wait to restore its caller",
    );
    const sending = executeTool(
      fixture.runtime.control(child.conversationId),
      "send_session_message",
      "cancelled-rendezvous-message",
      {
        conversationId: caller.conversationId,
        message: "Preserve this after the wait cancellation.",
      },
    );

    await expect(sending).resolves.toMatchObject({
      status: "processing",
      conversationId: caller.conversationId,
    });
    expect(waitError).toMatchObject({ name: "AbortError" });
    expect(caller.getActivity().kind).toBe("running");
    expect((await inbox.list({
      toConversationId: caller.conversationId,
    }))).toHaveLength(1);

    keepCallerRunning.resolve();
    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
    });
    releaseChild.resolve();
    await expect(childCompletion).resolves.toMatchObject({
      outcome: "completed",
    });
  });

  it("removes a registered wait edge when durable reconciliation fails", async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    fixture.runtime.control(first.conversationId).enqueue(
      blocksUntil(firstStarted, releaseFirst, "first done"),
    );
    fixture.runtime.control(second.conversationId).enqueue(
      blocksUntil(secondStarted, releaseSecond, "second done"),
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstCompletion = fixture.coordinator.prompt(
      fixture.handle,
      first.conversationId,
      firstRunId,
      "first remains active after wait failure",
    );
    const secondCompletion = fixture.coordinator.prompt(
      fixture.handle,
      second.conversationId,
      secondRunId,
      "second tests the reverse wait edge",
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const inbox = coordinatorInbox(fixture.handle);
    const originalList = inbox.list.bind(inbox);
    let listCalls = 0;
    inbox.list = async (...args) => {
      listCalls++;
      if (listCalls === 2) {
        throw new Error("simulated wait reconciliation scan failure");
      }
      return originalList(...args);
    };
    await expect(executeTool(
      fixture.runtime.control(first.conversationId),
      "wait_for_session",
      "wait-with-reconciliation-failure",
      {
        conversationId: second.conversationId,
        runId: secondRunId,
      },
    )).rejects.toThrow("wait reconciliation scan failure");
    inbox.list = originalList;
    expect(first.getActivity().kind).toBe("running");

    const reverseAbort = new AbortController();
    const reverseWait = executeTool(
      fixture.runtime.control(second.conversationId),
      "wait_for_session",
      "reverse-wait-after-reconciliation-failure",
      {
        conversationId: first.conversationId,
        runId: firstRunId,
      },
      reverseAbort.signal,
    );
    await waitUntil(
      () => second.getActivity().kind === "waiting",
      "the reverse wait without a ghost cycle edge",
    );
    const reverseRejected = expect(reverseWait).rejects.toMatchObject({
      name: "AbortError",
    });
    reverseAbort.abort();
    await reverseRejected;

    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all([firstCompletion, secondCompletion]);
  });

  it("rejects and removes an exact waiter when its durable receipt write fails", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peer = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const peerRunId = randomUUID();
    const callerWaitRejected = deferred();
    const releaseCaller = deferred();
    let callerWaitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "wait-before-receipt-write-failure",
          {
            conversationId: peer.conversationId,
            runId: peerRunId,
          },
        );
      } catch (error) {
        callerWaitError = error;
        callerWaitRejected.resolve();
      }
      await releaseCaller.promise;
      control.emitFinal("caller recovered after receipt failure");
    });
    const peerStarted = deferred();
    const releasePeer = deferred();
    fixture.runtime.control(peer.conversationId).enqueue(
      blocksUntil(peerStarted, releasePeer, "peer completed"),
    );
    const callerRunId = randomUUID();
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      callerRunId,
      "wait while the exact receipt write fails",
    );
    const peerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      peer.conversationId,
      peerRunId,
      "send the exact reply",
    );
    await peerStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the exact waiter before receipt failure",
    );

    const inbox = coordinatorInbox(fixture.handle);
    const originalUpdateState = inbox.updateState.bind(inbox);
    let failReceiptWrite = true;
    inbox.updateState = async (messageId, update) => {
      if (
        failReceiptWrite
        && update.state === "processing"
        && update.waitedByRunId !== undefined
      ) {
        failReceiptWrite = false;
        throw new Error("simulated exact receipt write failure");
      }
      return originalUpdateState(messageId, update);
    };
    await expect(executeTool(
      fixture.runtime.control(peer.conversationId),
      "send_session_message",
      "send-with-receipt-write-failure",
      {
        conversationId: caller.conversationId,
        message: "this receipt write fails once",
      },
    )).rejects.toThrow("exact receipt write failure");
    await callerWaitRejected.promise;
    inbox.updateState = originalUpdateState;
    expect(callerWaitError).toMatchObject({
      message: expect.stringContaining("exact receipt write failure"),
    });
    expect(caller.getActivity().kind).toBe("running");
    const pendingAfterFailure = await inbox.list({
      toConversationId: caller.conversationId,
    });
    expect(pendingAfterFailure).toContainEqual(expect.objectContaining({
      state: "queued",
    }));
    expect(pendingAfterFailure[0]).not.toHaveProperty("waitedByRunId");

    const reverseAbort = new AbortController();
    const reverseWait = executeTool(
      fixture.runtime.control(peer.conversationId),
      "wait_for_session",
      "reverse-wait-after-receipt-write-failure",
      {
        conversationId: caller.conversationId,
        runId: callerRunId,
      },
      reverseAbort.signal,
    );
    await waitUntil(
      () => peer.getActivity().kind === "waiting",
      "the reverse wait without a ghost exact edge",
    );
    const reverseRejected = expect(reverseWait).rejects.toMatchObject({
      name: "AbortError",
    });
    reverseAbort.abort();
    await reverseRejected;

    releaseCaller.resolve();
    releasePeer.resolve();
    await Promise.all([callerCompletion, peerCompletion]);
  });

  it("rejects exact waiters when target settlement persistence becomes fatal", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target settlement will fail"),
    );
    const targetRunId = randomUUID();
    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      targetRunId,
      "fail settlement persistence after a caller waits",
    );
    await targetStarted.promise;

    const callerWaitRejected = deferred();
    const releaseCaller = deferred();
    let callerWaitError: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "wait-for-fatal-settlement-persistence",
          {
            conversationId: target.conversationId,
            runId: targetRunId,
          },
        );
      } catch (error) {
        callerWaitError = error;
        callerWaitRejected.resolve();
      }
      await releaseCaller.promise;
      control.emitFinal("caller recovered from target fatal state");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for a target that becomes fatal",
    );
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the exact waiter before target infrastructure failure",
    );

    const manager = target.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let failSettlement = true;
    manager.appendCustomEntry = (customType, data) => {
      if (failSettlement && customType === RUN_SETTLEMENT_CUSTOM_TYPE) {
        failSettlement = false;
        throw new Error("simulated fatal settlement persistence failure");
      }
      return originalAppend(customType, data);
    };
    releaseTarget.resolve();
    await expect(targetCompletion).rejects.toThrow(
      "fatal settlement persistence failure",
    );
    await callerWaitRejected.promise;
    expect(callerWaitError).toMatchObject({
      message: expect.stringContaining("fatal settlement persistence failure"),
    });
    expect(caller.getActivity().kind).toBe("running");
    const internal = fixture.handle as unknown as {
      context: { waiters: Map<string, Set<unknown>> };
    };
    expect(internal.context.waiters.size).toBe(0);

    releaseCaller.resolve();
    await callerCompletion;
  });

  it("rejects a wait edge when any aggregate target would close a conversation cycle", async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const unrelated = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    fixture.runtime.control(first.conversationId).enqueue(
      blocksUntil(firstStarted, releaseFirst, "first completed"),
    );
    fixture.runtime.control(second.conversationId).enqueue(
      blocksUntil(secondStarted, releaseSecond, "second completed"),
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstCompletion = fixture.coordinator.prompt(
      fixture.handle,
      first.conversationId,
      firstRunId,
      "first work",
    );
    const secondCompletion = fixture.coordinator.prompt(
      fixture.handle,
      second.conversationId,
      secondRunId,
      "second work",
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const firstWait = executeTool(
      fixture.runtime.control(first.conversationId),
      "wait_for_session",
      "first-waits-second",
      {
        conversationId: second.conversationId,
        runId: secondRunId,
      },
    );
    await waitUntil(
      () => first.getActivity().kind === "waiting",
      "the first wait edge",
    );
    await expect(executeTool(
      fixture.runtime.control(second.conversationId),
      "wait_for_session",
      "second-waits-first",
      {
        targets: [{
          conversationId: unrelated.conversationId,
          runId: randomUUID(),
        }, {
          conversationId: first.conversationId,
          runId: firstRunId,
        }],
      },
    )).rejects.toThrow("would create a conversation wait cycle");

    releaseSecond.resolve();
    await expect(secondCompletion).resolves.toMatchObject({
      runId: secondRunId,
      outcome: "completed",
    });
    await expect(firstWait).resolves.toMatchObject({
      runId: secondRunId,
      outcome: "completed",
    });
    releaseFirst.resolve();
    await expect(firstCompletion).resolves.toMatchObject({
      runId: firstRunId,
      outcome: "completed",
    });
  });

  it("atomically rejects one of two concurrently registered reverse waits", async () => {
    const fixture = await createFixture();
    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const second = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    fixture.runtime.control(first.conversationId).enqueue(
      blocksUntil(firstStarted, releaseFirst, "first settled"),
    );
    fixture.runtime.control(second.conversationId).enqueue(
      blocksUntil(secondStarted, releaseSecond, "second settled"),
    );
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const firstCompletion = fixture.coordinator.prompt(
      fixture.handle,
      first.conversationId,
      firstRunId,
      "first concurrent wait",
    );
    const secondCompletion = fixture.coordinator.prompt(
      fixture.handle,
      second.conversationId,
      secondRunId,
      "second concurrent wait",
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const internal = fixture.handle as unknown as {
      context: { lifecycle: { run<T>(task: () => Promise<T>): Promise<T> } };
    };
    const lifecycleHeld = deferred();
    const releaseLifecycle = deferred();
    const blocker = internal.context.lifecycle.run(async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;
    const firstWaitAbort = new AbortController();
    const secondWaitAbort = new AbortController();
    let firstError: unknown;
    let secondError: unknown;
    const firstWait = executeTool(
      fixture.runtime.control(first.conversationId),
      "wait_for_session",
      "concurrent-first-waits-second",
      { conversationId: second.conversationId, runId: secondRunId },
      firstWaitAbort.signal,
    );
    const secondWait = executeTool(
      fixture.runtime.control(second.conversationId),
      "wait_for_session",
      "concurrent-second-waits-first",
      { conversationId: first.conversationId, runId: firstRunId },
      secondWaitAbort.signal,
    );
    void firstWait.catch((error) => {
      firstError = error;
    });
    void secondWait.catch((error) => {
      secondError = error;
    });
    await Promise.resolve();
    releaseLifecycle.resolve();
    await blocker;
    await waitUntil(
      () => firstError !== undefined || secondError !== undefined,
      "one concurrent reverse wait to reject its cycle",
    );
    expect([firstError, secondError].filter(Boolean)).toHaveLength(1);
    expect(firstError ?? secondError).toMatchObject({
      message: expect.stringContaining("wait cycle"),
    });

    firstWaitAbort.abort();
    secondWaitAbort.abort();
    await Promise.allSettled([firstWait, secondWait]);
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.all([firstCompletion, secondCompletion]);
  });

  it("aborts wait_for_session while the target actor is still opening without leaking waiting state", async () => {
    const runtime = new FakeRuntime();
    const fixture = await createFixture(
      new ProjectStoreRegistry(),
      runtime,
    );
    const targetConversationId = randomUUID();
    const targetRunId = randomUUID();
    await fixture.handle.project.createConversation(
      targetConversationId,
      defaultProfile(fixture.roles),
    );
    const targetOpenStarted = deferred();
    const releaseTargetOpen = deferred();
    runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId !== targetConversationId) return;
      targetOpenStarted.resolve();
      await releaseTargetOpen.promise;
    };
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const abort = new AbortController();
    let waitError: unknown;
    let waitResult: unknown;
    runtime.control(source.conversationId).enqueue(async (control) => {
      try {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "abort-during-target-open",
          {
            conversationId: targetConversationId,
            runId: targetRunId,
          },
          abort.signal,
        );
      } catch (error) {
        waitError = error;
      }
      control.emitFinal("wait abort observed");
    });

    let sourceSettled = false;
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "wait, but honour cancellation while opening the target",
    );
    void sourceCompletion.finally(() => {
      sourceSettled = true;
    }).catch(() => undefined);
    await targetOpenStarted.promise;
    abort.abort();

    try {
      const settledPromptly = await Promise.race([
        sourceCompletion.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 200)
        ),
      ]);
      expect(settledPromptly).toBe(true);
      expect(waitResult).toBeUndefined();
      expect(waitError).toMatchObject({ name: "AbortError" });
      expect(
        (await fixture.coordinator.listSessions(fixture.handle))
          .find(({ id }) => id === source.conversationId)?.activity,
      ).toEqual({ kind: "idle" });
      expect(
        (fixture.handle as unknown as {
          context: { waiters: Map<string, unknown> };
        }).context.waiters.size,
      ).toBe(0);
    } finally {
      releaseTargetOpen.resolve();
      await waitUntil(
        () => runtime.controls.has(targetConversationId),
        "the target actor cleanup opening",
      );
      if (!sourceSettled) {
        let targetCompletion: Promise<RunSettlement> | undefined;
        await waitUntil(() => {
          try {
            targetCompletion = fixture.coordinator.prompt(
              fixture.handle,
              targetConversationId,
              targetRunId,
              "settle the leaked waiter for cleanup",
            );
            return true;
          } catch {
            return false;
          }
        }, "the target actor to become owned by the coordinator");
        await targetCompletion;
      }
      await sourceCompletion.catch(() => undefined);
    }
  });

  it("waits and peeks from durable target inspection even when the target model cannot start", async () => {
    const runtime = new FakeRuntime();
    const fixture = await createFixture(
      new ProjectStoreRegistry(),
      runtime,
    );
    const targetConversationId = randomUUID();
    const targetRunId = randomUUID();
    const targetManager = await fixture.handle.project.createConversation(
      targetConversationId,
      {
        role: {
          ...fixture.roles.getConversationRole("default"),
          model: {
            provider: "unavailable-provider",
            id: "unavailable-model",
          },
        },
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
      },
    );
    targetManager.appendMessage(agentMessage({
      role: "user",
      content: "durable target context remains inspectable",
      timestamp: 1,
    }));
    appendReservedCustomEntry(
      targetManager,
      createRunSettlementEntry({
        runId: targetRunId,
        outcome: "completed",
        finalText: "durable result without a live target model",
        settledAt: "2026-07-19T12:02:00.000Z",
      }),
    );
    runtime.beforeCreateSession = async (conversationId) => {
      if (conversationId === targetConversationId) {
        throw new Error("target model is unavailable");
      }
    };
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sourceControl = runtime.control(source.conversationId);

    let peek: unknown;
    let peekError: unknown;
    try {
      peek = await executeTool(
        sourceControl,
        "peek_session",
        "peek-unstartable-target",
        {
          conversationId: targetConversationId,
          limit: 6,
        },
      );
    } catch (error) {
      peekError = error;
    }

    let waited: unknown;
    let waitError: unknown;
    sourceControl.enqueue(async (control) => {
      try {
        waited = await executeTool(
          control,
          "wait_for_session",
          "wait-unstartable-target",
          {
            conversationId: targetConversationId,
            runId: targetRunId,
          },
        );
      } catch (error) {
        waitError = error;
      }
      control.emitFinal("durable inspection complete");
    });
    await fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "inspect the durable target without starting its model",
    );

    expect(peekError).toBeUndefined();
    expect(peek).toMatchObject({
      conversationId: targetConversationId,
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          text: "durable target context remains inspectable",
        }),
      ]),
    });
    expect(waitError).toBeUndefined();
    expect(waited).toMatchObject({
      runId: targetRunId,
      outcome: "completed",
      finalText: "durable result without a live target model",
    });
    expect(
      runtime.createConversationIds.filter(
        (conversationId) => conversationId === targetConversationId,
      ),
    ).toHaveLength(0);
  });

  it("serializes an inactive peek lease before deleting the same conversation", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    await fixture.coordinator.close();

    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.coordinator = restarted;
    fixture.handle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    await restarted.openConversation(
      fixture.handle,
      source.conversationId,
      { updateRecent: false },
    );
    const project = fixture.handle.project;
    const openConversation = project.openConversation.bind(project);
    const peekOwnsLease = deferred();
    const releasePeek = deferred();
    project.openConversation = async (...args) => {
      if (args[0] === target.conversationId) {
        peekOwnsLease.resolve();
        await releasePeek.promise;
      }
      return openConversation(...args);
    };
    const inbox = coordinatorInbox(fixture.handle);
    const markTargetDeleted = inbox.markTargetDeleted.bind(inbox);
    let deletionIntentStarted = false;
    inbox.markTargetDeleted = async (...args) => {
      deletionIntentStarted = true;
      return markTargetDeleted(...args);
    };

    const peeking = executeTool(
      fixture.runtime.control(source.conversationId),
      "peek_session",
      "peek-before-delete",
      {
        conversationId: target.conversationId,
        limit: 6,
      },
    );
    await peekOwnsLease.promise;
    const deleting = restarted.deleteConversation(
      fixture.handle,
      target.conversationId,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deletionIntentStarted).toBe(false);
    releasePeek.resolve();

    await expect(peeking).resolves.toMatchObject({
      conversationId: target.conversationId,
    });
    await expect(deleting).resolves.toBe(true);
    expect(
      (await restarted.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).not.toContain(target.conversationId);
  });

  it("durably replays exact abort_session results across settlement and restart", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const started = deferred();
    const release = deferred();
    const runId = randomUUID();
    const wrongRunId = randomUUID();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(started, release, "abort acknowledged"),
    );
    const targetCompletion = fixture.coordinator.prompt(
      fixture.handle,
      target.conversationId,
      runId,
      "remain active until the peer aborts this exact run",
    );
    await started.promise;

    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "abort_session",
      "self-abort-is-always-rejected",
      {
        conversationId: source.conversationId,
        runId: randomUUID(),
      },
    )).rejects.toThrow("cannot abort its own current run");

    const wrongInput = {
      conversationId: target.conversationId,
      runId: wrongRunId,
    };
    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "abort_session",
      "stable-wrong-abort",
      wrongInput,
    )).resolves.toEqual({
      aborted: false,
      reason: "run_not_active",
    });
    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "abort_session",
      "stable-wrong-abort",
      wrongInput,
    )).resolves.toEqual({
      aborted: false,
      reason: "run_not_active",
    });
    expect(fixture.runtime.control(target.conversationId).abortCalls).toBe(0);

    const exactInput = {
      conversationId: target.conversationId,
      runId,
    };
    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "abort_session",
      "stable-exact-abort",
      exactInput,
    )).resolves.toEqual({ aborted: true });
    await expect(targetCompletion).resolves.toMatchObject({
      runId,
      outcome: "aborted",
    });
    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "abort_session",
      "stable-exact-abort",
      exactInput,
    )).resolves.toEqual({ aborted: true });
    expect(fixture.runtime.control(target.conversationId).abortCalls).toBe(1);

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixture.coordinator = restarted;
    fixture.handle = restartedHandle;
    await restarted.openConversation(
      restartedHandle,
      source.conversationId,
      { updateRecent: false },
    );
    const restartedSource = fixture.runtime.control(source.conversationId);

    await expect(executeTool(
      restartedSource,
      "abort_session",
      "stable-exact-abort",
      exactInput,
    )).resolves.toEqual({ aborted: true });
    await expect(executeTool(
      restartedSource,
      "abort_session",
      "stable-wrong-abort",
      wrongInput,
    )).resolves.toEqual({
      aborted: false,
      reason: "run_not_active",
    });
    await expect(executeTool(
      restartedSource,
      "abort_session",
      "stable-exact-abort",
      {
        conversationId: target.conversationId,
        runId: randomUUID(),
      },
    )).rejects.toThrow("idempotency key conflicts");
    expect(
      fixture.runtime.createConversationIds.filter(
        (conversationId) => conversationId === target.conversationId,
      ),
    ).toHaveLength(1);
  });

  it("rejects self-delete and upgrades the target writer lease atomically for deletion", async () => {
    const registry = new TrackingProjectStoreRegistry();
    const fixture = await createFixture(registry);
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );

    await expect(executeTool(
      fixture.runtime.control(source.conversationId),
      "delete_session",
      "delete-self",
      { conversationId: source.conversationId },
    )).rejects.toThrow("cannot delete its own session");
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toContain(source.conversationId);

    const child = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        task: "child must not delete its ancestor and itself by cascade",
        idempotencyKey: "delete-ancestor-would-delete-self",
      }),
    );
    const childActor = await fixture.coordinator.openConversation(
      fixture.handle,
      child.conversationId,
      { updateRecent: false },
    );
    await expect(executeTool(
      fixture.runtime.control(child.conversationId),
      "delete_session",
      "delete-ancestor-would-delete-self",
      { conversationId: source.conversationId },
    )).rejects.toThrow("cannot delete its own session");
    expect(
      aggregateReservedConversationEntries(childActor.sessionManager.getEntries())
        .metaOperations.find(({ kind }) => kind === "delete_session"),
    ).toBeUndefined();
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining([
      source.conversationId,
      child.conversationId,
    ]));

    registry.events.length = 0;
    await expect(
      fixture.coordinator.deleteConversation(
        fixture.handle,
        target.conversationId,
      ),
    ).resolves.toBe(true);
    expect(
      registry.events.filter(({ conversationId }) =>
        conversationId === target.conversationId
      ),
    ).toEqual([
      { conversationId: target.conversationId, kind: "upgrade" },
      { conversationId: target.conversationId, kind: "deletion_release" },
    ]);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).not.toContain(target.conversationId);

    const reacquired = registry.acquireConversation(
      fixture.handle.project.cwd,
      target.conversationId,
    );
    reacquired.release();
  });

  it("linearizes send/delete and rejects prompt/delete while the target owns a run", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const deletingTarget = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const inbox = coordinatorInbox(fixture.handle);
    const originalMarkDeleted = inbox.markTargetDeleted.bind(inbox);
    const deletionMarked = deferred();
    const releaseDeletion = deferred();
    inbox.markTargetDeleted = async (...args) => {
      await originalMarkDeleted(...args);
      if (args[0] === deletingTarget.conversationId) {
        deletionMarked.resolve();
        await releaseDeletion.promise;
      }
    };
    const deleting = fixture.coordinator.deleteConversation(
      fixture.handle,
      deletingTarget.conversationId,
    );
    await deletionMarked.promise;
    const rejectedDeletionPrompt = fixture.coordinator.prompt(
      fixture.handle,
      deletingTarget.conversationId,
      randomUUID(),
      "a prompt cannot cross a committed deletion fence",
    );
    const lateSend = executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-after-delete-linearization",
      {
        conversationId: deletingTarget.conversationId,
        message: "this cannot enter a target whose deletion already committed",
      },
    );
    releaseDeletion.resolve();
    await expect(rejectedDeletionPrompt).rejects.toThrow(
      /(being deleted|not active)/i,
    );
    await expect(deleting).resolves.toBe(true);
    await expect(lateSend).rejects.toThrow(/not found/i);
    inbox.markTargetDeleted = originalMarkDeleted;
    expect(
      await inbox.list({
        toConversationId: deletingTarget.conversationId,
      }),
    ).toEqual([]);

    const busyTarget = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const runStarted = deferred();
    const releaseRun = deferred();
    fixture.runtime.control(busyTarget.conversationId).enqueue(
      blocksUntil(runStarted, releaseRun, "busy work done"),
    );
    const promptCompletion = fixture.coordinator.prompt(
      fixture.handle,
      busyTarget.conversationId,
      randomUUID(),
      "own the target while deletion races",
    );
    await runStarted.promise;
    await expect(
      fixture.coordinator.deleteConversation(
        fixture.handle,
        busyTarget.conversationId,
      ),
    ).rejects.toThrow("busy conversation");

    const sentWhileBusy = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "send-before-delete-linearization",
      {
        conversationId: busyTarget.conversationId,
        message: "steer into the run before deletion can win",
      },
    ) as { status: string };
    expect(sentWhileBusy.status).toBe("processing");
    await expect(
      fixture.coordinator.deleteConversation(
        fixture.handle,
        busyTarget.conversationId,
      ),
    ).rejects.toThrow("busy conversation");
    releaseRun.resolve();
    await promptCompletion;
    await waitUntil(
      () =>
        fixture.runtime.control(busyTarget.conversationId)
          .received.length === 1,
      "the steered send to settle with the prompt",
    );
  });

  it("retries a durable ancestor tombstone after a descendant deletion releases its reservation", async () => {
    const fixture = await createFixture();
    const root = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const child = await fixture.coordinator.startPeerSession(
      fixture.handle,
      root.conversationId,
      startInput({
        task: "child with deletion reservation",
        idempotencyKey: "durable-root-retry-child",
      }),
    );
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === child.conversationId)
        ?.activity.kind === "idle",
    "child initial run to settle");
    const inbox = coordinatorInbox(fixture.handle);
    await inbox.markTargetDeleted(
      root.conversationId,
      "2026-07-19T12:00:03.000Z",
    );

    const context = (fixture.handle as unknown as {
      context: {
        lifecycle: {
          run<T>(task: () => Promise<T> | T): Promise<T>;
        };
      };
    }).context;
    const lifecycleBlocked = deferred();
    const releaseLifecycle = deferred();
    const lifecycleBlock = context.lifecycle.run(async () => {
      lifecycleBlocked.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleBlocked.promise;

    const childDeletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      child.conversationId,
    );
    await (fixture.coordinator as unknown as {
      retryDurableDeletions(context: unknown): Promise<void>;
    }).retryDurableDeletions(context);
    let ids = (await fixture.coordinator.listSessions(fixture.handle))
      .map(({ id }) => id);
    expect(ids).toEqual(expect.arrayContaining([
      root.conversationId,
      child.conversationId,
    ]));

    releaseLifecycle.resolve();
    await lifecycleBlock;
    await childDeletion;
    await waitUntil(async () => {
      ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(root.conversationId)
        && !ids.includes(child.conversationId)
        && (await inbox.listDeletedTargets()).length === 0;
    }, "durable ancestor retry after child deletion");
  });

  it("retries a durable ancestor tombstone after a busy descendant turns fatal", async () => {
    const fixture = await createFixture();
    const root = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(childStarted, releaseChild, "child done"),
    ]);
    const child = await fixture.coordinator.startPeerSession(
      fixture.handle,
      root.conversationId,
      startInput({
        task: "busy child that will fail settlement persistence",
        idempotencyKey: "durable-root-retry-fatal-child",
      }),
    );
    await childStarted.promise;
    const childActor = await fixture.coordinator.openConversation(
      fixture.handle,
      child.conversationId,
      { updateRecent: false },
    );
    const appender = childActor.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = appender.appendCustomEntry.bind(appender);
    appender.appendCustomEntry = (customType, data) => {
      if (customType === "piweb.run_settlement.v1") {
        throw new Error("settlement persistence failed");
      }
      return originalAppend(customType, data);
    };
    const inbox = coordinatorInbox(fixture.handle);
    await inbox.markTargetDeleted(
      root.conversationId,
      "2026-07-19T12:00:04.000Z",
    );
    const context = (fixture.handle as unknown as {
      context: { backgroundTasks: Set<Promise<void>> };
    }).context;
    await (fixture.coordinator as unknown as {
      retryDurableDeletions(context: unknown): Promise<void>;
    }).retryDurableDeletions(context);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining([
      root.conversationId,
      child.conversationId,
    ]));

    releaseChild.resolve();
    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(root.conversationId)
        && !ids.includes(child.conversationId)
        && (await inbox.listDeletedTargets()).length === 0;
    }, "durable ancestor retry after fatal descendant run");
    await waitUntil(
      () => context.backgroundTasks.size === 0,
      "fatal descendant background tasks to settle",
    );
    const activity = fixture.coordinator.projectActivitySnapshot().projects
      .find(({ cwd }) => cwd === fixture.cwd);
    expect(activity?.attentionConversationCount).toBe(0);
  });

  it("does not drop failed inbox recovery for a transient delete reservation", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(childStarted, releaseChild, "child done"),
    ]);
    const child = await fixture.coordinator.startPeerSession(
      fixture.handle,
      target.conversationId,
      startInput({
        task: "busy descendant keeps delete transient",
        idempotencyKey: "failed-batch-transient-delete-child",
      }),
    );
    await childStarted.promise;

    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target first run done"),
    );
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "failed-batch-transient-delete",
      {
        conversationId: target.conversationId,
        message: "recover after transient delete reservation",
      },
    ) as { messageId: string; runId: string };
    await targetStarted.promise;

    const appender = target.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = appender.appendCustomEntry.bind(appender);
    appender.appendCustomEntry = (customType, data) => {
      if (customType === "piweb.run_settlement.v1") {
        throw new Error("target settlement persistence failed");
      }
      return originalAppend(customType, data);
    };
    const context = (fixture.handle as unknown as {
      context: {
        backgroundTasks: Set<Promise<void>>;
        lifecycle: {
          run<T>(task: () => Promise<T> | T): Promise<T>;
        };
      };
    }).context;
    const lifecycleBlocked = deferred();
    const releaseLifecycle = deferred();
    const lifecycleBlock = context.lifecycle.run(async () => {
      lifecycleBlocked.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleBlocked.promise;

    releaseTarget.resolve();
    await waitUntil(
      () => target.getState().fatalError !== undefined,
      "target inbox run to become fatal",
    );
    await Promise.resolve();
    const deletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      target.conversationId,
    );

    releaseLifecycle.resolve();
    await lifecycleBlock;
    await expect(deletion).rejects.toThrow("busy conversation");
    await waitUntil(
      async () => await coordinatorInbox(fixture.handle).get(sent.messageId)
        === undefined,
      "failed inbox batch to recover after transient delete failure",
    );
    const recovered = await fixture.coordinator.openConversation(
      fixture.handle,
      target.conversationId,
      { updateRecent: false },
    );
    expect(recovered.getState().fatalError).toBeUndefined();
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining([
      target.conversationId,
      child.conversationId,
    ]));

    releaseChild.resolve();
    await waitUntil(
      () => context.backgroundTasks.size === 0,
      "transient delete failed-batch background tasks to settle",
    );
  });

  it("continues failed inbox recovery when delete reserves during reopen", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(childStarted, releaseChild, "child done"),
    ]);
    const child = await fixture.coordinator.startPeerSession(
      fixture.handle,
      target.conversationId,
      startInput({
        task: "busy descendant blocks racing delete",
        idempotencyKey: "failed-batch-reopen-delete-child",
      }),
    );
    await childStarted.promise;

    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target first run done"),
    );
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "failed-batch-reopen-delete",
      {
        conversationId: target.conversationId,
        message: "recover after delete races reopen",
      },
    ) as { messageId: string };
    await targetStarted.promise;

    const appender = target.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = appender.appendCustomEntry.bind(appender);
    appender.appendCustomEntry = (customType, data) => {
      if (customType === "piweb.run_settlement.v1") {
        throw new Error("target settlement persistence failed");
      }
      return originalAppend(customType, data);
    };
    const context = (fixture.handle as unknown as {
      context: { backgroundTasks: Set<Promise<void>> };
    }).context;
    const reopenStarted = deferred();
    const releaseReopen = deferred();
    let blockTargetReopen = true;
    fixture.runtime.beforeCreateSession = async (conversationId) => {
      if (blockTargetReopen && conversationId === target.conversationId) {
        blockTargetReopen = false;
        reopenStarted.resolve();
        await releaseReopen.promise;
      }
    };

    releaseTarget.resolve();
    await reopenStarted.promise;
    const deletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      target.conversationId,
    );
    releaseReopen.resolve();
    await expect(deletion).rejects.toThrow("busy conversation");
    await waitUntil(
      async () => await coordinatorInbox(fixture.handle).get(sent.messageId)
        === undefined,
      "failed inbox batch to recover after delete raced reopen",
    );
    const recovered = await fixture.coordinator.openConversation(
      fixture.handle,
      target.conversationId,
      { updateRecent: false },
    );
    expect(recovered.getState().fatalError).toBeUndefined();
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toEqual(expect.arrayContaining([
      target.conversationId,
      child.conversationId,
    ]));

    releaseChild.resolve();
    await waitUntil(
      () => context.backgroundTasks.size === 0,
      "reopen race failed-batch background tasks to settle",
    );
  });

  it("does not retry failed inbox recovery indefinitely", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target first run done"),
    );
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "failed-batch-bounded-retry",
      {
        conversationId: target.conversationId,
        message: "recovery should not loop forever",
      },
    ) as { messageId: string; runId: string };
    await targetStarted.promise;

    let settlementFailures = 0;
    const wrapFailingSettlement = (manager: unknown) => {
      const appender = manager as {
        appendCustomEntry(customType: string, data: unknown): string;
      };
      const originalAppend = appender.appendCustomEntry.bind(appender);
      appender.appendCustomEntry = (customType, data) => {
        if (customType === "piweb.run_settlement.v1") {
          settlementFailures++;
          throw new Error("settlement persistence keeps failing");
        }
        return originalAppend(customType, data);
      };
    };
    wrapFailingSettlement(target.sessionManager);
    fixture.runtime.beforeCreateSession = async (conversationId, options) => {
      if (conversationId === target.conversationId) {
        wrapFailingSettlement(options.sessionManager);
      }
    };
    const context = (fixture.handle as unknown as {
      context: { backgroundTasks: Set<Promise<void>> };
    }).context;

    releaseTarget.resolve();
    await waitUntil(
      () => settlementFailures === 2 && context.backgroundTasks.size === 0,
      "bounded failed inbox recovery attempts",
    );
    expect(
      fixture.runtime.createConversationIds.filter(
        (id) => id === target.conversationId,
      ),
    ).toHaveLength(2);
    expect(await coordinatorInbox(fixture.handle).get(sent.messageId))
      .toMatchObject({
        state: "processing",
        processingRunId: sent.runId,
      });
  });

  it("does not abort a recovered run when delete reserves after dispatch", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(targetStarted, releaseTarget, "target first run done"),
    );
    const sent = await executeTool(
      fixture.runtime.control(source.conversationId),
      "send_session_message",
      "failed-batch-dispatch-delete",
      {
        conversationId: target.conversationId,
        message: "delete races after recovered dispatch",
      },
    ) as { messageId: string };
    await targetStarted.promise;

    const appender = target.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = appender.appendCustomEntry.bind(appender);
    appender.appendCustomEntry = (customType, data) => {
      if (customType === "piweb.run_settlement.v1") {
        throw new Error("target settlement persistence failed");
      }
      return originalAppend(customType, data);
    };
    const recoveredStarted = deferred();
    const releaseRecovered = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(recoveredStarted, releaseRecovered, "recovered run done"),
    ]);
    const originalResume = ConversationActor.prototype.resumeMessages;
    let deletion: Promise<boolean> | undefined;
    let deleteOnRecoveredResume = true;
    const resumeSpy = vi.spyOn(ConversationActor.prototype, "resumeMessages")
      .mockImplementation(function (
        this: ConversationActor,
        input: Parameters<ConversationActor["resumeMessages"]>[0],
      ) {
        const result = originalResume.call(this, input);
        if (
          deleteOnRecoveredResume
          && this.conversationId === target.conversationId
        ) {
          deleteOnRecoveredResume = false;
          deletion = fixture.coordinator.deleteConversation(
            fixture.handle,
            target.conversationId,
          );
        }
        return result;
      });

    releaseTarget.resolve();
    await recoveredStarted.promise;
    resumeSpy.mockRestore();
    const recoveredControl = fixture.runtime.control(target.conversationId);
    expect(deletion).toBeDefined();
    await expect(deletion!).rejects.toThrow("busy conversation");
    expect(recoveredControl.abortCalls).toBe(0);

    releaseRecovered.resolve();
    await waitUntil(
      async () => await coordinatorInbox(fixture.handle).get(sent.messageId)
        === undefined,
      "recovered run to finish after racing delete",
    );
    expect(recoveredControl.abortCalls).toBe(0);
  });

  it("does not clear a descendant deletion reservation when an ancestor cascade races it", async () => {
    const fixture = await createFixture();
    const root = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childConversationId = randomUUID();
    await fixture.handle.project.createConversation(
      childConversationId,
      defaultProfile(fixture.roles, {
        createdBy: {
          kind: "conversation",
          conversationId: root.conversationId,
        },
        orchestration: {
          rootConversationId: root.conversationId,
          depth: 1,
        },
      }),
    );
    await fixture.handle.project.refreshConversations();

    const project = fixture.handle.project;
    const originalInspectConversations = project.inspectConversations
      .bind(project);
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    let blocked = false;
    project.inspectConversations = async (...args) => {
      if (!blocked) {
        blocked = true;
        inspectionStarted.resolve();
        await releaseInspection.promise;
      }
      return originalInspectConversations(...args);
    };

    const rootDeletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      root.conversationId,
    );
    await inspectionStarted.promise;
    const childDeletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      childConversationId,
    );
    releaseInspection.resolve();

    await expect(rootDeletion).rejects.toThrow("being deleted");
    await expect(childDeletion).resolves.toBe(true);
    project.inspectConversations = originalInspectConversations;

    const remainingIds = (await fixture.coordinator.listSessions(fixture.handle))
      .map(({ id }) => id);
    expect(remainingIds).toContain(root.conversationId);
    expect(remainingIds).not.toContain(childConversationId);
  });

  it("does not let one delete_session tool call idempotency key delete a different replay target", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const firstTarget = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const secondTarget = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sourceControl = fixture.runtime.control(source.conversationId);

    await expect(executeTool(
      sourceControl,
      "delete_session",
      "stable-delete-tool-call",
      { conversationId: firstTarget.conversationId },
    )).resolves.toEqual({ deleted: true });

    let replayError: unknown;
    try {
      await executeTool(
        sourceControl,
        "delete_session",
        "stable-delete-tool-call",
        { conversationId: secondTarget.conversationId },
      );
    } catch (error) {
      replayError = error;
    }
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id),
    ).toContain(secondTarget.conversationId);
    expect(replayError).toMatchObject({
      message: expect.stringContaining("idempotency key conflicts"),
    });
  });

  it.each(["exact", "aggregate"] as const)(
    "returns a waited temporary result only through its incoming message (%s)",
    async (waitMode) => {
      const fixture = await createFixture();
      const caller = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const temporaryStarted = deferred();
      const releaseTemporary = deferred();
      fixture.runtime.nextSessionBehaviors.push([
        blocksUntil(
          temporaryStarted,
          releaseTemporary,
          "one temporary answer",
        ),
      ]);
      const callerStarted = deferred();
      const targetKnown = deferred<{
        conversationId: string;
        runId: string;
      }>();
      let waitResult: RunSettlement | undefined;
      fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
        callerStarted.resolve();
        const target = await targetKnown.promise;
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "wait-for-one-temporary-return",
          waitMode === "exact" ? target : { targets: [target] },
        ) as RunSettlement;
        control.emitFinal("caller handled one message-owned answer");
      });
      const callerCompletion = fixture.coordinator.prompt(
        fixture.handle,
        caller.conversationId,
        randomUUID(),
        "start and wait for one temporary result",
      );
      await callerStarted.promise;

      const temporary = await fixture.coordinator.startPeerSession(
        fixture.handle,
        caller.conversationId,
        startInput({
          temporary: true,
          idempotencyKey: "waited-temporary-single-input",
        }),
      );
      targetKnown.resolve(temporary);
      await temporaryStarted.promise;
      await waitUntil(
        () => caller.getActivity().kind === "waiting",
        "the caller to wait for its temporary initial run",
      );

      releaseTemporary.resolve();
      await callerCompletion;
      expect(waitResult).toMatchObject({
        outcome: "message",
        conversationId: temporary.conversationId,
        runId: temporary.runId,
        messageId: expect.any(String),
        fulfillsTemporaryReturn: true,
      });
      expect(waitResult).not.toHaveProperty("finalText");
      const returnedMessages = fixture.runtime.control(caller.conversationId)
        .received.filter(({ content }) =>
          content.includes("one temporary answer")
        );
      expect(returnedMessages).toHaveLength(1);
      expect(returnedMessages[0]).toMatchObject({
        deliverAs: "steer",
        triggerTurn: true,
      });
    },
  );

  it("lets a temporary explicit wait reply replace its successful automatic return", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "final temporary answer"),
    ]);
    const callerStarted = deferred();
    const targetKnown = deferred<{
      conversationId: string;
      runId: string;
    }>();
    const firstWaitResolved = deferred();
    const secondWaitResolved = deferred();
    let firstWait: unknown;
    let secondWait: unknown;
    let thirdWait: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerStarted.resolve();
      const target = await targetKnown.promise;
      firstWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-explicit-first-wait",
        target,
      );
      control.beginNextModelTurn();
      firstWaitResolved.resolve();
      secondWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-explicit-second-wait",
        target,
      );
      control.beginNextModelTurn();
      secondWaitResolved.resolve();
      thirdWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-explicit-third-wait",
        target,
      );
      control.emitFinal("caller observed explicit messages then settlement");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for temporary progress and then its settlement",
    );
    await callerStarted.promise;

    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-explicit-wait-replaces-return",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    const initialTask = fixture.runtime.control(temporary.conversationId)
      .received[0]?.content;
    expect(initialTask).toContain(
      "请直接将最终答复作为 assistant final；宿主会自动回传给调用者。",
    );
    expect(initialTask).toContain("仅在需要提前唤醒调用者时，才调用 send_session_message");
    expect(initialTask).not.toContain("如需回复，请调用 send_session_message");
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's first temporary wait",
    );

    await expect(executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-explicit-wait-message",
      {
        conversationId: caller.conversationId,
        message: "The explicit temporary conclusion.",
      },
    )).resolves.toMatchObject({ status: "delivered_to_wait" });
    await firstWaitResolved.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's second temporary wait",
    );
    await expect(executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-second-explicit-wait-message",
      {
        conversationId: caller.conversationId,
        message: "A later temporary progress message.",
      },
    )).resolves.toMatchObject({ status: "delivered_to_wait" });
    await secondWaitResolved.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's third temporary wait",
    );

    releaseTemporary.resolve();
    await callerCompletion;
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary cleanup after its claimed explicit return");

    expect(firstWait).toMatchObject({
      outcome: "message",
      conversationId: temporary.conversationId,
      runId: temporary.runId,
      messageId: expect.any(String),
      fulfillsTemporaryReturn: true,
    });
    expect(secondWait).toMatchObject({
      outcome: "message",
      conversationId: temporary.conversationId,
      runId: temporary.runId,
    });
    expect(secondWait).not.toHaveProperty("fulfillsTemporaryReturn");
    expect(thirdWait).toMatchObject({
      outcome: "completed",
      runId: temporary.runId,
      finalText: "final temporary answer",
    });
    const received = fixture.runtime.control(caller.conversationId).received;
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      content: expect.stringContaining("The explicit temporary conclusion."),
      details: expect.objectContaining({ kind: "message" }),
    });
    expect(received[1]).toMatchObject({
      content: expect.stringContaining("A later temporary progress message."),
      details: expect.objectContaining({ kind: "message" }),
    });
    expect(received).not.toContainEqual(expect.objectContaining({
      details: expect.objectContaining({ kind: "delegation_result" }),
    }));
  });

  it("returns a settled caller receipt after temporary cleanup and coordinator restart", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "durable final answer"),
    ]);
    const targetKnown = deferred<{ conversationId: string; runId: string }>();
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      await executeTool(
        control,
        "wait_for_session",
        "temporary-receipt-first-wait",
        await targetKnown.promise,
      );
      control.beginNextModelTurn();
      control.emitFinal("caller consumed the explicit message");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for the temporary explicit message",
    );
    await waitUntil(
      () => caller.getActivity().kind === "running",
      "the caller run before temporary creation",
    );
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-receipt-survives-cleanup",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's initial wait",
    );
    await executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-receipt-explicit-message",
      {
        conversationId: caller.conversationId,
        message: "Durably receipt this explicit result.",
      },
    );
    await callerCompletion;
    releaseTemporary.resolve();
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary deletion after the caller receipt settles");

    await fixture.coordinator.close();
    fixture.coordinator = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.handle = await fixture.coordinator.acquireProject(
      fixture.cwd,
      "full_access",
    );
    const reopened = await fixture.coordinator.openConversation(
      fixture.handle,
      caller.conversationId,
      { updateRecent: false },
    );
    let repeatedWait: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      repeatedWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-receipt-after-restart",
        temporary,
      );
      control.emitFinal("caller recovered the durable temporary settlement");
    });
    await fixture.coordinator.prompt(
      fixture.handle,
      reopened.conversationId,
      randomUUID(),
      "read the settled caller receipt",
    );

    expect(repeatedWait).toMatchObject({
      outcome: "completed",
      runId: temporary.runId,
      finalText: "durable final answer",
    });
    expect(
      aggregateReservedConversationEntries(
        fixture.runtime.control(caller.conversationId).manager.getEntries(),
      ).temporaryReturnReceipts,
    ).toContainEqual(expect.objectContaining({
      temporaryConversationId: temporary.conversationId,
      initialRunId: temporary.runId,
      state: "settled",
    }));
  });

  it("materializes a caller receipt from an assigned envelope after restart loss", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(
        temporaryStarted,
        releaseTemporary,
        "final after receipt projection loss",
      ),
    ]);
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-assigned-envelope-repairs-receipt",
      }),
    );
    await temporaryStarted.promise;

    const role = fixture.roles.getConversationRole("default");
    const messageId = randomUUID();
    const assignedAt = new Date().toISOString();
    await coordinatorInbox(fixture.handle).put({
      messageId,
      cardId: randomUUID(),
      fromConversationId: temporary.conversationId,
      toConversationId: caller.conversationId,
      sentAt: assignedAt,
      kind: "message",
      body: "Explicit result committed before the caller receipt projection.",
      fromRunId: temporary.runId,
      temporaryReturnAssignment: {
        initialRunId: temporary.runId,
        callerRunId: randomUUID(),
        assignedAt,
      },
      fromSnapshot: {
        conversationId: temporary.conversationId,
        role: { id: role.id, name: role.name },
      },
      toSnapshot: {
        conversationId: caller.conversationId,
        role: { id: role.id, name: role.name },
      },
    });
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toEqual([]);

    releaseTemporary.resolve();
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary cleanup after repairing the caller receipt");
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toContainEqual(expect.objectContaining({
      temporaryConversationId: temporary.conversationId,
      initialRunId: temporary.runId,
      messageId,
      state: "settled",
      settlement: expect.objectContaining({
        finalText: "final after receipt projection loss",
      }),
    }));
    expect(fixture.runtime.control(caller.conversationId).received)
      .not.toContainEqual(expect.objectContaining({
        details: expect.objectContaining({ kind: "delegation_result" }),
      }));
  });

  it("reuses a settled caller receipt after B reported-settlement append fails", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "receipt survives B append failure"),
    ]);
    const targetKnown = deferred<{ conversationId: string; runId: string }>();
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      await executeTool(
        control,
        "wait_for_session",
        "receipt-before-B-report-failure",
        await targetKnown.promise,
      );
      control.beginNextModelTurn();
      control.emitFinal("caller received the explicit message");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for a receipt before B report persistence fails",
    );
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "receipt-before-B-report-append-failure",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the receipt-owning caller wait",
    );
    await executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "receipt-before-B-report-failure-message",
      {
        conversationId: caller.conversationId,
        message: "Explicit message owns the return receipt.",
      },
    );
    await callerCompletion;

    const temporaryActor = await fixture.coordinator.openConversation(
      fixture.handle,
      temporary.conversationId,
      { updateRecent: false },
    );
    const manager = temporaryActor.sessionManager as unknown as {
      appendCustomEntry(customType: string, data: unknown): string;
    };
    const originalAppend = manager.appendCustomEntry.bind(manager);
    let failReportedAppend = true;
    manager.appendCustomEntry = (customType, data) => {
      if (
        failReportedAppend
        && customType === RUN_SETTLEMENT_CUSTOM_TYPE
        && (data as { reportedAt?: string }).reportedAt !== undefined
      ) {
        failReportedAppend = false;
        throw new Error("simulated B reported settlement append failure");
      }
      return originalAppend(customType, data);
    };
    releaseTemporary.resolve();
    await waitUntil(() =>
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts.some((receipt) =>
        receipt.temporaryConversationId === temporary.conversationId
        && receipt.state === "settled"
      ),
    "caller receipt to settle before B report append");
    manager.appendCustomEntry = originalAppend;

    await fixture.coordinator.close();
    fixture.coordinator = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.handle = await fixture.coordinator.acquireProject(
      fixture.cwd,
      "full_access",
    );
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "recovered temporary deletion after B report append failure");
    const inspection = await fixture.handle.project.inspectConversation(
      caller.conversationId,
    );
    const receipt = inspection.temporaryReturnReceipts.find((candidate) =>
      candidate.temporaryConversationId === temporary.conversationId
    );
    expect(receipt).toMatchObject({ state: "settled" });
    expect(receipt?.state === "settled" && receipt.settlement).toMatchObject({
      runId: temporary.runId,
      finalText: "receipt survives B append failure",
    });
    expect(
      inspection.cards.filter(({ kind }) => kind === "delegation_result"),
    ).toHaveLength(0);
  });

  it("does not claim a temporary message committed before its caller starts waiting", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const callerStarted = deferred();
    const beginWait = deferred();
    const targetKnown = deferred<{ conversationId: string; runId: string }>();
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerStarted.resolve();
      await beginWait.promise;
      await executeTool(
        control,
        "wait_for_session",
        "temporary-wait-after-committed-message",
        await targetKnown.promise,
      );
      control.beginNextModelTurn();
      control.emitFinal("caller consumed the precommitted message");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait only after the temporary message commits",
    );
    await callerStarted.promise;
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "automatic final return"),
    ]);
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-message-before-wait-has-no-receipt",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    await executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-message-before-wait",
      {
        conversationId: caller.conversationId,
        message: "This message predates the exact wait.",
      },
    );

    beginWait.resolve();
    await callerCompletion;
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toEqual([]);
    releaseTemporary.resolve();
    await waitUntil(() =>
      fixture.runtime.control(caller.conversationId).received.some((message) =>
        (message.details as { kind?: string } | undefined)?.kind
          === "delegation_result"
      ),
    "automatic delegation result after an unclaimed message");
  });

  it("keeps a caller receipt when SDK steering rejects and later skips automatic result", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(temporaryStarted, releaseTemporary, "final after retry"),
    ]);
    const targetKnown = deferred<{ conversationId: string; runId: string }>();
    let waitError: unknown;
    let requeuedWait: unknown;
    let finalWait: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      try {
        await executeTool(
          control,
          "wait_for_session",
          "temporary-receipt-before-steer-rejection",
          await targetKnown.promise,
        );
      } catch (error) {
        waitError = error;
      }
      control.beginNextModelTurn();
      requeuedWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-receipt-requeued-message",
        await targetKnown.promise,
      );
      control.beginNextModelTurn();
      finalWait = await executeTool(
        control,
        "wait_for_session",
        "temporary-receipt-final-after-message",
        await targetKnown.promise,
      );
      control.emitFinal("caller recovered from rejected steering");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait until steering rejects",
    );
    await waitUntil(
      () => caller.getActivity().kind === "running",
      "the caller run before temporary creation",
    );
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-receipt-before-sdk-rejection",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's receipt-claiming wait",
    );

    const callerSession = caller.session as unknown as {
      sendCustomMessage: typeof caller.session.sendCustomMessage;
    };
    const originalSend = callerSession.sendCustomMessage.bind(caller.session);
    let rejectSteer = true;
    callerSession.sendCustomMessage = async (message, options) => {
      if (rejectSteer && options?.deliverAs === "steer") {
        rejectSteer = false;
        throw new Error("simulated SDK steer rejection");
      }
      return originalSend(message, options);
    };
    await expect(executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-receipt-sdk-rejection-message",
      {
        conversationId: caller.conversationId,
        message: "Deliver after the injected SDK rejection.",
      },
    )).rejects.toThrow("simulated SDK steer rejection");
    callerSession.sendCustomMessage = originalSend;

    expect(waitError).toMatchObject({
      message: expect.stringContaining("simulated SDK steer rejection"),
    });
    expect(
      aggregateReservedConversationEntries(
        caller.sessionManager.getEntries(),
      ).temporaryReturnReceipts,
    ).toContainEqual(expect.objectContaining({
      temporaryConversationId: temporary.conversationId,
      initialRunId: temporary.runId,
      state: "claimed",
    }));
    await expect(coordinatorInbox(fixture.handle).list({
      toConversationId: caller.conversationId,
    })).resolves.toContainEqual(expect.objectContaining({ state: "queued" }));

    await waitUntil(() =>
      fixture.runtime.control(caller.conversationId).received.some(({ content }) =>
        content.includes("Deliver after the injected SDK rejection.")
      ),
    "the requeued explicit message to deliver");
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's completion wait after requeued message",
    );
    releaseTemporary.resolve();
    await callerCompletion;
    expect(requeuedWait).toMatchObject({
      outcome: "message",
      messageId: expect.any(String),
    });
    expect(finalWait).toMatchObject({
      outcome: "completed",
      runId: temporary.runId,
      finalText: "final after retry",
    });
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary cleanup after the retried explicit message");
    expect(fixture.runtime.control(caller.conversationId).received)
      .not.toContainEqual(expect.objectContaining({
        details: expect.objectContaining({ kind: "delegation_result" }),
      }));
  });

  it("still automatically returns temporary failures after an explicit wait reply", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const temporaryStarted = deferred();
    const releaseTemporary = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      async () => {
        temporaryStarted.resolve();
        await releaseTemporary.promise;
        throw new Error("temporary final failure");
      },
    ]);
    const callerStarted = deferred();
    const targetKnown = deferred<{
      conversationId: string;
      runId: string;
    }>();
    let waitResult: unknown;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerStarted.resolve();
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "temporary-failure-after-explicit-wait",
        await targetKnown.promise,
      );
      control.beginNextModelTurn();
      control.emitFinal("caller handled explicit temporary progress");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "wait for temporary progress before its failure",
    );
    await callerStarted.promise;

    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-failure-after-explicit-wait",
      }),
    );
    targetKnown.resolve(temporary);
    await temporaryStarted.promise;
    await waitUntil(
      () => caller.getActivity().kind === "waiting",
      "the caller's temporary failure wait",
    );
    await executeTool(
      fixture.runtime.control(temporary.conversationId),
      "send_session_message",
      "temporary-failure-explicit-message",
      {
        conversationId: caller.conversationId,
        message: "Temporary progress before the failure.",
      },
    );
    await callerCompletion;

    releaseTemporary.resolve();
    await waitUntil(() =>
      fixture.runtime.control(caller.conversationId).received.some((message) =>
        (message.details as { kind?: string } | undefined)?.kind
          === "delegation_failure"
      ),
    "automatic temporary failure return");

    expect(waitResult).toMatchObject({ outcome: "message" });
    expect(
      aggregateReservedConversationEntries(
        fixture.runtime.control(caller.conversationId).manager.getEntries(),
      ).temporaryReturnReceipts,
    ).toHaveLength(1);
    expect(
      fixture.runtime.control(caller.conversationId).received,
    ).toContainEqual(expect.objectContaining({
      details: expect.objectContaining({ kind: "delegation_failure" }),
    }));
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId),
    ).toMatchObject({ temporary: true, attention: true });
  });

  it("prefers a pending temporary return after its session was deleted", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.nextSessionBehaviors.push([
      completesWith("temporary answer committed before wait"),
    ]);
    const callerStarted = deferred();
    const beginWait = deferred();
    const targetKnown = deferred<{
      conversationId: string;
      runId: string;
    }>();
    let waitResult: RunSettlement | undefined;
    fixture.runtime.control(caller.conversationId).enqueue(async (control) => {
      callerStarted.resolve();
      const target = await targetKnown.promise;
      await beginWait.promise;
      waitResult = await executeTool(
        control,
        "wait_for_session",
        "wait-after-temporary-deletion",
        target,
      ) as RunSettlement;
      control.emitFinal("caller consumed the pending return once");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
      "delay wait until temporary cleanup",
    );
    await callerStarted.promise;
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-delete-before-wait",
      }),
    );
    targetKnown.resolve(temporary);
    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      const pending = await coordinatorInbox(fixture.handle).list({
        toConversationId: caller.conversationId,
      });
      return !ids.includes(temporary.conversationId)
        && pending.some(({ fromRunId, waitedByRunId }) =>
          fromRunId === temporary.runId && waitedByRunId === undefined
        );
    }, "temporary deletion with its return still pending");

    beginWait.resolve();
    await callerCompletion;
    expect(waitResult).toMatchObject({
      outcome: "message",
      conversationId: temporary.conversationId,
      runId: temporary.runId,
    });
    expect(waitResult).not.toHaveProperty("finalText");
  });

  it("durably returns a temporary success before deleting its session", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sourceStarted = deferred();
    const releaseSource = deferred();
    fixture.runtime.control(source.conversationId).enqueue(
      blocksUntil(sourceStarted, releaseSource, "source done"),
    );
    const sourceRunId = randomUUID();
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      sourceRunId,
      "remain busy while the result is committed",
    );
    await sourceStarted.promise;
    fixture.runtime.nextSessionBehaviors.push([
      completesWith("temporary success"),
    ]);
    const inbox = coordinatorInbox(fixture.handle);
    const tombstoneTarget = inbox.tombstoneTarget.bind(inbox);
    inbox.tombstoneTarget = async (...args) => {
      const delegation = aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find(({ kind }) => kind === "delegation_task");
      expect(delegation).toMatchObject({
        state: "completed",
        result: "temporary success",
      });
      return tombstoneTarget(...args);
    };

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-success",
      }),
    );
    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      const pending = await inbox.list({
        toConversationId: source.conversationId,
      });
      return !ids.includes(started.conversationId)
        && pending.some(({ kind, body, state }) =>
          kind === "delegation_result"
          && body === "temporary success"
          && state === "processing"
        );
    }, "temporary result steering followed by session deletion");

    const pending = await inbox.list({
      toConversationId: source.conversationId,
    });
    expect(pending).toContainEqual(expect.objectContaining({
      fromConversationId: started.conversationId,
      toConversationId: source.conversationId,
      kind: "delegation_result",
      body: "temporary success",
      state: "processing",
      processingRunId: sourceRunId,
      processingDelivery: "steer",
    }));
    expect(fixture.runtime.control(source.conversationId).received)
      .toContainEqual(expect.objectContaining({
        content: expect.stringContaining("temporary success"),
        deliverAs: "steer",
        triggerTurn: true,
      }));
    expect(
      aggregateReservedConversationEntries(source.sessionManager.getEntries())
        .deliveredMessageIds,
    ).toHaveLength(0);
    expect(
      await readdir(fixture.handle.project.sessionDir),
    ).toHaveLength(1);

    releaseSource.resolve();
    await sourceCompletion;
    await waitUntil(
      async () => (await inbox.list({
        toConversationId: source.conversationId,
      })).length === 0,
      "the steered temporary result to settle durably",
    );
    expect(
      aggregateReservedConversationEntries(source.sessionManager.getEntries())
        .deliveredMessageIds,
    ).toHaveLength(1);
  });

  it("runs delayed temporary cleanup before a browser prompt admitted behind it", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const blocker = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const initialRunStarted = deferred();
    const releaseInitialRun = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(
        initialRunStarted,
        releaseInitialRun,
        "temporary initial result",
      ),
    ]);
    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "temporary cleanup waits behind lifecycle queue",
        idempotencyKey: "temporary-cleanup-races-new-run",
      }),
    );
    await initialRunStarted.promise;

    const inbox = coordinatorInbox(fixture.handle);
    const originalMarkDeleted = inbox.markTargetDeleted.bind(inbox);
    const deletionMarked = deferred();
    const releaseDeletion = deferred();
    inbox.markTargetDeleted = async (...args) => {
      await originalMarkDeleted(...args);
      if (args[0] === blocker.conversationId) {
        deletionMarked.resolve();
        await releaseDeletion.promise;
      }
    };
    const blockingDeletion = fixture.coordinator.deleteConversation(
      fixture.handle,
      blocker.conversationId,
    );
    await deletionMarked.promise;

    releaseInitialRun.resolve();
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId)
        ?.activity.kind === "idle",
    "temporary initial run settled before queued cleanup");

    const secondRun = fixture.coordinator.prompt(
      fixture.handle,
      temporary.conversationId,
      randomUUID(),
      "browser prompt behind delayed temporary cleanup",
    );
    releaseDeletion.resolve();
    await blockingDeletion;
    await expect(secondRun).rejects.toThrow(/not active/i);
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary cleanup before browser admission");
    inbox.markTargetDeleted = originalMarkDeleted;
  });

  it("retries temporary auto-deletion after a busy descendant settles", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    let childConversationId: string | undefined;
    fixture.runtime.nextSessionBehaviors.push([
      async (control) => {
        fixture.runtime.nextSessionBehaviors.push([
          blocksUntil(childStarted, releaseChild, "child done"),
        ]);
        const child = await executeTool(
          control,
          "start_session",
          "temporary-parent-starts-child",
          startInput({
            task: "busy descendant of temporary parent",
            idempotencyKey: "temporary-parent-starts-child",
          }),
        ) as { conversationId: string };
        childConversationId = child.conversationId;
        control.emitFinal("temporary parent result");
      },
    ]);

    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "temporary parent",
        idempotencyKey: "temporary-parent-with-busy-child",
      }),
    );
    await childStarted.promise;
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId)
        ?.attention === true,
    "temporary deletion blocked by a busy descendant");
    expect(childConversationId).toBeDefined();

    releaseChild.resolve();
    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(temporary.conversationId)
        && !ids.includes(childConversationId!);
    }, "temporary cascade deletion retry after descendant settlement");
  });

  it("retries temporary auto-deletion after descendant compaction fails", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childCreated = deferred();
    const releaseParent = deferred();
    let childConversationId: string | undefined;
    fixture.runtime.nextSessionBehaviors.push([
      async (control) => {
        fixture.runtime.nextSessionBehaviors.push([
          completesWith("child idle"),
        ]);
        const child = await executeTool(
          control,
          "start_session",
          "temporary-parent-starts-compacting-child",
          startInput({
            task: "compacting descendant of temporary parent",
            idempotencyKey: "temporary-parent-starts-compacting-child",
          }),
        ) as { conversationId: string };
        childConversationId = child.conversationId;
        childCreated.resolve();
        await releaseParent.promise;
        control.emitFinal("temporary parent result");
      },
    ]);

    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "temporary parent with compacting child",
        idempotencyKey: "temporary-parent-with-compacting-child",
      }),
    );
    await childCreated.promise;
    expect(childConversationId).toBeDefined();
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === childConversationId)
        ?.activity.kind === "idle",
    "compacting child initial run to settle");
    const childActor = await fixture.coordinator.openConversation(
      fixture.handle,
      childConversationId!,
      { updateRecent: false },
    );
    let compacting = true;
    childActor.isCompacting = () => compacting;
    childActor.compactContext = async () => {
      compacting = false;
      throw new Error("compaction failed after clearing state");
    };

    releaseParent.resolve();
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId)
        ?.attention === true,
    "temporary deletion blocked by a compacting descendant");

    await expect(fixture.coordinator.compactContext(
      fixture.handle,
      childConversationId!,
    )).rejects.toThrow("compaction failed");
    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(temporary.conversationId)
        && !ids.includes(childConversationId!);
    }, "temporary cascade deletion retry after failed compaction");
  });

  it("does not retry temporary cascade deletion through a new active run", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const childStarted = deferred();
    const releaseChild = deferred();
    let childConversationId: string | undefined;
    fixture.runtime.nextSessionBehaviors.push([
      async (control) => {
        fixture.runtime.nextSessionBehaviors.push([
          blocksUntil(childStarted, releaseChild, "child done"),
        ]);
        const child = await executeTool(
          control,
          "start_session",
          "temporary-parent-starts-child-before-new-run",
          startInput({
            task: "busy descendant before parent gets a new run",
            idempotencyKey: "temporary-parent-starts-child-before-new-run",
          }),
        ) as { conversationId: string };
        childConversationId = child.conversationId;
        control.emitFinal("temporary parent result");
      },
    ]);

    const temporary = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "temporary parent that will receive another prompt",
        idempotencyKey: "temporary-parent-new-run-before-retry",
      }),
    );
    await childStarted.promise;
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId)
        ?.attention === true,
    "temporary deletion initially blocked");
    expect(childConversationId).toBeDefined();

    const secondRunStarted = deferred();
    const releaseSecondRun = deferred();
    fixture.runtime.control(temporary.conversationId).enqueue(
      blocksUntil(secondRunStarted, releaseSecondRun, "second run done"),
    );
    const secondRun = fixture.coordinator.prompt(
      fixture.handle,
      temporary.conversationId,
      randomUUID(),
      "new work must not be cancelled by a delayed cleanup retry",
    );
    await secondRunStarted.promise;

    releaseChild.resolve();
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === childConversationId)
        ?.activity.kind === "idle",
    "busy descendant settled while temporary parent stayed running");
    let ids = (await fixture.coordinator.listSessions(fixture.handle))
      .map(({ id }) => id);
    expect(ids).toContain(temporary.conversationId);
    expect(ids).toContain(childConversationId);

    releaseSecondRun.resolve();
    await secondRun;
    await waitUntil(async () => {
      ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(temporary.conversationId)
        && !ids.includes(childConversationId!);
    }, "temporary cascade deletion after the new run settles");
  });

  it("returns a retained temporary failure settlement after restart and return cleanup", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sourceStarted = deferred();
    const releaseSource = deferred();
    fixture.runtime.control(source.conversationId).enqueue(
      blocksUntil(sourceStarted, releaseSource, "source done"),
    );
    const sourceRunId = randomUUID();
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      sourceRunId,
      "remain busy while failure is committed",
    );
    await sourceStarted.promise;
    fixture.runtime.nextSessionBehaviors.push([
      failsWith("target exploded"),
    ]);

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-failure",
      }),
    );
    const inbox = coordinatorInbox(fixture.handle);
    await waitUntil(async () =>
      (await inbox.list({ toConversationId: source.conversationId }))
        .some(({ kind }) => kind === "delegation_failure"),
    "temporary failure message");

    const retained = (await fixture.coordinator.listSessions(fixture.handle))
      .find(({ id }) => id === started.conversationId);
    expect(retained).toMatchObject({
      id: started.conversationId,
      temporary: true,
      activity: { kind: "idle" },
      attention: true,
    });
    expect(
      await inbox.list({ toConversationId: source.conversationId }),
    ).toContainEqual(expect.objectContaining({
      fromConversationId: started.conversationId,
      kind: "delegation_failure",
      body: expect.stringContaining("failed"),
      state: "processing",
      processingRunId: sourceRunId,
      processingDelivery: "steer",
    }));

    fixture.runtime.control(started.conversationId).enqueue(
      completesWith("a later manual success"),
    );
    await fixture.coordinator.prompt(
      fixture.handle,
      started.conversationId,
      randomUUID(),
      "retry manually after the initial temporary failure",
    );
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === started.conversationId),
    ).toMatchObject({
      temporary: true,
      activity: { kind: "idle" },
      attention: true,
    });

    releaseSource.resolve();
    await sourceCompletion;
    await waitUntil(
      async () => (await inbox.list({
        toConversationId: source.conversationId,
      })).length === 0,
      "the retained temporary failure return to finish delivery",
    );

    await fixture.coordinator.close();
    fixture.coordinator = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.handle = await fixture.coordinator.acquireProject(
      fixture.cwd,
      "full_access",
    );
    const reopenedSource = await fixture.coordinator.openConversation(
      fixture.handle,
      source.conversationId,
      { updateRecent: false },
    );

    let repeatedWait: RunSettlement | undefined;
    fixture.runtime.control(source.conversationId).enqueue(async (control) => {
      repeatedWait = await executeTool(
        control,
        "wait_for_session",
        "wait-after-retained-return-cleanup-restart",
        {
          conversationId: started.conversationId,
          runId: started.runId,
        },
      ) as RunSettlement;
      control.emitFinal("caller observed the retained settlement");
    });
    await fixture.coordinator.prompt(
      fixture.handle,
      reopenedSource.conversationId,
      randomUUID(),
      "wait after restart and return sidecar cleanup",
    );
    expect(repeatedWait).toMatchObject({
      runId: started.runId,
      outcome: "failed",
    });
  });

  it("returns bounded failures and retains temporary sessions for abort and missing replies", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sourceStarted = deferred();
    const releaseSource = deferred();
    fixture.runtime.control(source.conversationId).enqueue(
      blocksUntil(sourceStarted, releaseSource, "caller idle again"),
    );
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
      "hold returned failures in the inbox",
    );
    await sourceStarted.promise;

    const abortedStarted = deferred();
    const releaseAborted = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(abortedStarted, releaseAborted, "ignored final text"),
    ]);
    const aborted = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "abort this initial temporary run",
        idempotencyKey: "temporary-aborted",
      }),
    );
    await abortedStarted.promise;
    await fixture.coordinator.abort(
      fixture.handle,
      aborted.conversationId,
      aborted.runId,
    );

    fixture.runtime.nextSessionBehaviors.push([
      async () => undefined,
    ]);
    const noReply = await fixture.coordinator.startPeerSession(
      fixture.handle,
      source.conversationId,
      startInput({
        temporary: true,
        task: "complete without an assistant reply",
        idempotencyKey: "temporary-no-reply",
      }),
    );

    const inbox = coordinatorInbox(fixture.handle);
    await waitUntil(async () => {
      const failures = (await inbox.list({
        toConversationId: source.conversationId,
      })).filter(({ kind }) => kind === "delegation_failure");
      const retained = await fixture.coordinator.listSessions(fixture.handle);
      return failures.some(({ fromConversationId, body }) =>
        fromConversationId === aborted.conversationId
        && body.includes("aborted")
      ) && failures.some(({ fromConversationId, body }) =>
        fromConversationId === noReply.conversationId
        && body.includes("没有 Agent 回复")
      ) && [aborted.conversationId, noReply.conversationId].every(
        (conversationId) =>
          retained.find(({ id }) => id === conversationId)?.attention === true,
      );
    }, "temporary abort and no-reply failure returns with attention");
    const retained = await fixture.coordinator.listSessions(fixture.handle);
    expect(
      retained.find(({ id }) => id === aborted.conversationId),
    ).toMatchObject({ temporary: true, attention: true });
    expect(
      retained.find(({ id }) => id === noReply.conversationId),
    ).toMatchObject({ temporary: true, attention: true });

    releaseSource.resolve();
    await sourceCompletion;
  });

  it("settles messages steered into a temporary run before deleting its target", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const sender = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const targetStarted = deferred();
    const releaseTarget = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(targetStarted, releaseTarget, "temporary result"),
    ]);

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-with-late-message",
      }),
    );
    await targetStarted.promise;
    await executeTool(
      fixture.runtime.control(sender.conversationId),
      "send_session_message",
      "late-message-tool-call",
      {
        conversationId: started.conversationId,
        message: "arrived while temporary target was busy",
      },
    );

    releaseTarget.resolve();
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === started.conversationId),
    "temporary deletion after settling its steered inbox message");

    const senderCard = aggregateReservedConversationEntries(
      sender.sessionManager.getEntries(),
    ).cards.find(({ body }) =>
      body === "arrived while temporary target was busy"
    );
    expect(senderCard).toMatchObject({
      state: "completed",
      result: "temporary result",
    });
  });

  it("returns a bounded failure and durably retains an oversized temporary result", async () => {
    const fixture = await createFixture();
    const caller = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    fixture.runtime.nextSessionBehaviors.push([
      completesWith("x".repeat(MAX_CONVERSATION_BODY_BYTES + 1)),
    ]);

    const started = await fixture.coordinator.startPeerSession(
      fixture.handle,
      caller.conversationId,
      startInput({
        temporary: true,
        idempotencyKey: "temporary-oversized-result",
      }),
    );
    const callerControl = fixture.runtime.control(caller.conversationId);
    await waitUntil(() =>
      callerControl.received.some((message) =>
        (message.details as { kind?: string } | undefined)?.kind
          === "delegation_failure"
      ),
    "bounded oversized-result failure");
    const failure = callerControl.received.find((message) =>
      (message.details as { kind?: string } | undefined)?.kind
        === "delegation_failure"
    );
    expect(failure?.content).toContain("超过");
    expect(Buffer.byteLength(failure?.content ?? "", "utf8"))
      .toBeLessThan(MAX_CONVERSATION_BODY_BYTES);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === started.conversationId),
    ).toMatchObject({
      temporary: true,
      attention: true,
    });

    await fixture.coordinator.close();
    const restarted = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    const restartedHandle = await restarted.acquireProject(
      fixture.cwd,
      "full_access",
    );
    fixtures.push({
      ...fixture,
      coordinator: restarted,
      handle: restartedHandle,
    });
    await waitUntil(async () =>
      (await restarted.listSessions(restartedHandle))
        .some(({ id, attention }) =>
          id === started.conversationId && attention === true
        ),
    "retained temporary attention after restart");
  });

  it("recovers an exact processing inbox run without redelivery or a new run id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-session-recovery-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const targetId = randomUUID();
    await store.createConversation(sourceId, defaultProfile(roles));
    await store.createConversation(targetId, defaultProfile(roles));
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    const messageId = randomUUID();
    const processingRunId = randomUUID();
    await inbox.put({
      messageId,
      cardId: randomUUID(),
      fromConversationId: sourceId,
      toConversationId: targetId,
      sentAt: "2026-07-19T12:00:00.000Z",
      kind: "message",
      body: "recover this exact delivery",
      fromSnapshot: {
        conversationId: sourceId,
        role: { id: "default", name: "Default" },
      },
      toSnapshot: {
        conversationId: targetId,
        role: { id: "default", name: "Default" },
      },
    });
    await inbox.updateState(messageId, {
      state: "processing",
      processingRunId,
    });

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    const liveInbox = coordinatorInbox(handle);
    const fixture = {
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    };
    fixtures.push(fixture);
    await waitUntil(
      () => runtime.controls.get(targetId)?.received.length === 1,
      "processing inbox recovery",
    );
    await waitUntil(
      async () => (await liveInbox.list()).length === 0,
      "recovered sidecar cleanup",
    );
    const target = await coordinator.openConversation(
      handle,
      targetId,
      { updateRecent: false },
    );
    const settlements = aggregateReservedConversationEntries(
      target.sessionManager.getEntries(),
    ).runSettlements;

    expect(runtime.control(targetId).received).toHaveLength(1);
    expect(runtime.control(targetId).received[0]?.content).toContain(
      "recover this exact delivery",
    );
    expect(settlements).toContainEqual(expect.objectContaining({
      runId: processingRunId,
      outcome: "completed",
    }));
  });

  it("migrates a legacy conversation after the seeded role was deleted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-legacy-without-role-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const seeded = getRoleTemplate(roles, "default");
    await roles.deleteRole(seeded.id, seeded.revision);
    expect(roles.listRoles()).toEqual([]);

    const store = await ProjectStore.open(cwd, "full_access");
    const conversationId = randomUUID();
    const legacy = await store.createConversation(conversationId);
    legacy.appendModelChange("test", "model-a");

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    fixtures.push({
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    });

    const opened = await coordinator.openConversation(
      handle,
      conversationId,
      { updateRecent: false },
    );
    expect(
      aggregateReservedConversationEntries(
        opened.sessionManager.getEntries(),
      ).conversationMeta,
    ).toMatchObject({
      role: {
        id: "default",
        name: "旧会话",
        model: { provider: "test", id: "model-a" },
        canManageSessions: false,
      },
    });
  });

  it("recovers a processing start_session with its exact task, role, and run only once", async () => {
    const cwd = await mkdtemp(join(
      tmpdir(),
      "piweb-start-session-processing-recovery-",
    ));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const roleTemplate = await roles.createRole({
      name: "Frozen recovery role",
      description: "Must survive the processing crash boundary",
      systemPrompt: "Use the frozen processing recovery prompt.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "off",
      defaultServiceTier: null,
      toolMode: "read_only",
      canManageSessions: false,
    });
    const role = roles.getConversationRole(roleTemplate.id);
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const idempotencyKey = "processing-start-recovery-key";
    const input = startInput({
      roleId: role.id,
      task: "recover this exact delegated task",
      temporary: false,
      idempotencyKey,
    });
    const targetId = deterministicTestUuid(
      "piweb.start.conversation",
      idempotencyKey,
    );
    const runId = deterministicTestUuid(
      "piweb.start.run",
      idempotencyKey,
    );
    const delegationId = deterministicTestUuid(
      "piweb.start.delegation",
      idempotencyKey,
    );
    const messageId = deterministicTestUuid(
      "piweb.start.message",
      idempotencyKey,
    );
    const cardId = deterministicTestUuid(
      "piweb.start.card",
      idempotencyKey,
    );
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify([
        input.roleId,
        input.task,
        null,
        input.temporary,
      ]))
      .digest("hex");
    const sourceManager = await store.createConversation(
      sourceId,
      defaultProfile(roles),
    );
    await store.createConversation(targetId, {
      role,
      lifecycle: { kind: "normal" },
      createdBy: {
        kind: "conversation",
        conversationId: sourceId,
      },
    });
    const sentAt = "2020-01-01T00:00:00.000Z";
    const fromSnapshot = {
      conversationId: sourceId,
      role: { id: "default", name: "Default" },
    };
    const toSnapshot = {
      conversationId: targetId,
      title: input.task,
      role: { id: role.id, name: role.name },
    };
    appendReservedCustomEntry(
      sourceManager,
      createConversationCardEntry({
        cardId,
        kind: "delegation_task",
        body: input.task,
        fromSnapshot,
        toSnapshot,
        state: "queued",
        messageId,
        delegationId,
        requestFingerprint,
        requestedRole: role,
        updatedAt: sentAt,
      }),
    );
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    await inbox.put({
      messageId,
      cardId,
      fromConversationId: sourceId,
      toConversationId: targetId,
      sentAt,
      kind: "delegation_task",
      body: input.task,
      delegationId,
      requestFingerprint,
      fromSnapshot,
      toSnapshot,
    });
    await inbox.updateState(messageId, {
      state: "processing",
      processingRunId: runId,
    });

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    fixtures.push({
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    });
    await waitUntil(async () =>
      (await coordinatorInbox(handle).list()).length === 0,
    "processing start_session recovery");
    const source = await coordinator.openConversation(
      handle,
      sourceId,
      { updateRecent: false },
    );
    const target = await coordinator.openConversation(
      handle,
      targetId,
      { updateRecent: false },
    );

    expect(runtime.control(targetId).received).toHaveLength(1);
    expect(runtime.control(targetId).received[0]?.content).toContain(
      input.task,
    );
    expect(runtime.createOptions.get(targetId)).toMatchObject({
      model: role.model,
      roleSystemPrompt: role.systemPrompt,
    });
    expect(
      aggregateReservedConversationEntries(
        target.sessionManager.getEntries(),
      ).runSettlements,
    ).toContainEqual(expect.objectContaining({
      runId,
      outcome: "completed",
    }));
    expect(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find(({ cardId: id }) => id === cardId),
    ).toMatchObject({
      state: "completed",
      runId,
      requestedRole: role,
    });

    await expect(coordinator.startPeerSession(
      handle,
      sourceId,
      input,
    )).resolves.toEqual({
      conversationId: targetId,
      runId,
      temporary: false,
    });
    expect(runtime.control(targetId).received).toHaveLength(1);
  });

  it("keeps an unlink-race replacement tombstoned until restart deletes it", async () => {
    const fixture = await createFixture();
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const conversationId = target.conversationId;
    const sessionFile = target.sessionManager.getSessionFile()!;
    const replacementPath = join(
      fixture.handle.project.sessionDir,
      ".replacement-at-unlink.tmp",
    );
    const replacementRaw = await readFile(sessionFile, "utf8");
    await writeFile(replacementPath, replacementRaw);
    const internals = fixture.handle.project as unknown as {
      unlinkSessionFile(path: string): Promise<void>;
    };
    const originalUnlinkSessionFile =
      internals.unlinkSessionFile.bind(fixture.handle.project);
    vi.spyOn(internals, "unlinkSessionFile").mockImplementationOnce(
      async (path) => {
        await rename(replacementPath, sessionFile);
        await originalUnlinkSessionFile(path);
      },
    );

    await expect(fixture.coordinator.deleteConversation(
      fixture.handle,
      conversationId,
    )).rejects.toThrow("Conversation reappeared during deletion");

    await expect(readFile(sessionFile, "utf8")).resolves.toBe(replacementRaw);
    expect(await coordinatorInbox(fixture.handle).listDeletedTargets())
      .toContain(conversationId);

    await fixture.coordinator.close();
    fixture.registry = new ProjectStoreRegistry();
    fixture.coordinator = new ProjectSessionCoordinator(
      fixture.runtime,
      fixture.roles,
      fixture.registry,
    );
    fixture.handle = await fixture.coordinator.acquireProject(
      fixture.cwd,
      "full_access",
    );

    await waitUntil(async () => {
      const ids = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      return !ids.includes(conversationId)
        && (await coordinatorInbox(fixture.handle).listDeletedTargets())
          .length === 0;
    }, "replacement deletion and tombstone cleanup after restart");
    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a leftover quarantine before a same-process durable deletion retry", async () => {
    const fixture = await createFixture();
    const retained = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const target = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const conversationId = target.conversationId;
    const sessionFile = target.sessionManager.getSessionFile()!;
    let obstacleCreated = false;
    const unsubscribe = fixture.handle.project.subscribe(() => {
      if (
        fixture.handle.project.lastConversationId !== undefined
        || obstacleCreated
      ) return;
      mkdirSync(sessionFile);
      obstacleCreated = true;
    });

    try {
      await expect(fixture.coordinator.deleteConversation(
        fixture.handle,
        conversationId,
      )).rejects.toThrow(
        "Conversation deletion failed and recovery could not be completed",
      );
    } finally {
      unsubscribe();
    }

    expect(obstacleCreated).toBe(true);
    await expect(readdir(sessionFile)).resolves.toEqual([]);
    expect((await readdir(fixture.handle.project.sessionDir)).filter((name) =>
      name.endsWith(".delete-quarantine")
    )).toHaveLength(1);
    expect(await coordinatorInbox(fixture.handle).listDeletedTargets())
      .toContain(conversationId);

    await rm(sessionFile, { recursive: true });
    vi.spyOn(retained, "compactContext").mockResolvedValueOnce();
    await fixture.coordinator.compactContext(
      fixture.handle,
      retained.conversationId,
    );

    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(fixture.handle.project.sessionDir)).filter((name) =>
      name.endsWith(".delete-quarantine")
    )).toEqual([]);
    expect(await coordinatorInbox(fixture.handle).listDeletedTargets())
      .not.toContain(conversationId);
    expect((await fixture.coordinator.listSessions(fixture.handle))
      .map(({ id }) => id)).not.toContain(conversationId);
  });

  it("restores an abandoned quarantine before a durable tombstone resumes deletion", async () => {
    const cwd = await mkdtemp(join(
      tmpdir(),
      "piweb-session-deletion-fence-recovery-",
    ));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const targetId = randomUUID();
    await store.createConversation(sourceId, defaultProfile(roles));
    const target = await store.createConversation(
      targetId,
      defaultProfile(roles),
    );
    const targetPath = target.getSessionFile()!;
    const quarantinePath = join(
      store.sessionDir,
      `.${basename(targetPath)}.${randomUUID()}.delete-quarantine`,
    );
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    const messageId = randomUUID();
    const cardId = randomUUID();
    await inbox.put({
      messageId,
      cardId,
      fromConversationId: sourceId,
      toConversationId: targetId,
      sentAt: "2026-07-19T12:00:00.000Z",
      kind: "message",
      body: "this message must never cross the deletion fence",
      fromSnapshot: {
        conversationId: sourceId,
        role: { id: "default", name: "Default" },
      },
      toSnapshot: {
        conversationId: targetId,
        role: { id: "default", name: "Default" },
      },
    });
    await inbox.markTargetDeleted(
      targetId,
      "2026-07-19T12:00:01.000Z",
    );
    await rename(targetPath, quarantinePath);

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    fixtures.push({
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    });

    await expect(coordinator.openConversation(
      handle,
      targetId,
      { updateRecent: false },
    )).rejects.toThrow("being deleted");
    await waitUntil(async () =>
      !(await coordinator.listSessions(handle))
        .some(({ id }) => id === targetId),
    "tombstoned target deletion recovery");
    await waitUntil(async () =>
      (await coordinatorInbox(handle).list()).length === 0
      && (await coordinatorInbox(handle).listDeletedTargets()).length === 0,
    "deletion sidecar and tombstone cleanup");

    expect(runtime.createConversationIds).not.toContain(targetId);
    await expect(readFile(targetPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(quarantinePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const source = await coordinator.openConversation(
      handle,
      sourceId,
      { updateRecent: false },
    );
    expect(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards,
    ).toContainEqual(expect.objectContaining({
      cardId,
      state: "failed",
      result: expect.stringContaining("已删除"),
    }));
  });

  it("recovers a root deletion tombstone by cascading to descendants", async () => {
    const cwd = await mkdtemp(join(
      tmpdir(),
      "piweb-session-cascade-deletion-recovery-",
    ));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const rootId = "00000000-0000-4000-8000-000000000001";
    const childId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await store.createConversation(rootId, defaultProfile(roles, {
      orchestration: { rootConversationId: rootId, depth: 0 },
    }));
    await store.createConversation(childId, defaultProfile(roles, {
      createdBy: { kind: "conversation", conversationId: rootId },
      orchestration: { rootConversationId: rootId, depth: 1 },
    }));
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    await inbox.markTargetDeleted(
      rootId,
      "2026-07-19T12:00:01.000Z",
    );
    await inbox.markTargetDeleted(
      childId,
      "2026-07-19T12:00:02.000Z",
    );

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    fixtures.push({
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    });

    await waitUntil(async () => {
      const ids = (await coordinator.listSessions(handle)).map(({ id }) => id);
      return !ids.includes(rootId) && !ids.includes(childId);
    }, "cascade deletion recovery");
    await waitUntil(async () =>
      (await coordinatorInbox(handle).listDeletedTargets()).length === 0,
    "cascade tombstone cleanup");
  });

  it("recovers a started abort intent before a processing inbox run can restart", async () => {
    const cwd = await mkdtemp(join(
      tmpdir(),
      "piweb-session-abort-intent-recovery-",
    ));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const sourceManager = await store.createConversation(
      sourceId,
      defaultProfile(roles),
    );
    await store.createConversation(targetId, defaultProfile(roles));
    const runId = randomUUID();
    const operationId = randomUUID();
    appendReservedCustomEntry(
      sourceManager,
      createMetaOperationEntry({
        operationId,
        kind: "abort_session",
        targetConversationId: targetId,
        runId,
        result: { aborted: true },
        state: "started",
        updatedAt: "2020-01-01T00:00:01.000Z",
      }),
    );
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    const messageId = randomUUID();
    await inbox.put({
      messageId,
      cardId: randomUUID(),
      fromConversationId: sourceId,
      toConversationId: targetId,
      sentAt: "2026-07-19T12:00:00.000Z",
      kind: "message",
      body: "this interrupted run must be cancelled before recovery dispatch",
      fromSnapshot: {
        conversationId: sourceId,
        role: { id: "default", name: "Default" },
      },
      toSnapshot: {
        conversationId: targetId,
        role: { id: "default", name: "Default" },
      },
    });
    await inbox.updateState(messageId, {
      state: "processing",
      processingRunId: runId,
    });

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    fixtures.push({
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    });
    await waitUntil(async () =>
      (await coordinatorInbox(handle).list()).length === 0,
    "started abort recovery to consume the interrupted batch");
    const target = await coordinator.openConversation(
      handle,
      targetId,
      { updateRecent: false },
    );
    const source = await coordinator.openConversation(
      handle,
      sourceId,
      { updateRecent: false },
    );

    expect(runtime.control(targetId).received).toEqual([]);
    expect(
      aggregateReservedConversationEntries(
        target.sessionManager.getEntries(),
      ).runSettlements,
    ).toContainEqual(expect.objectContaining({
      runId,
      outcome: "aborted",
      finalText: null,
    }));
    expect(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).metaOperations,
    ).toContainEqual(expect.objectContaining({
      operationId,
      state: "completed",
      result: { aborted: true },
    }));
  });

  it("resumes a processing inbox run from its delivery marker without appending the conversation message twice", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-session-resume-marker-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const targetId = randomUUID();
    await store.createConversation(sourceId, defaultProfile(roles));
    const targetManager = await store.createConversation(
      targetId,
      defaultProfile(roles),
    );
    const inbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    const messageId = randomUUID();
    const cardId = randomUUID();
    const processingRunId = randomUUID();
    const sentAt = "2026-07-19T12:00:00.000Z";
    const fromSnapshot = {
      conversationId: sourceId,
      role: { id: "default", name: "Default" },
    };
    const toSnapshot = {
      conversationId: targetId,
      role: { id: "default", name: "Default" },
    };
    await inbox.put({
      messageId,
      cardId,
      fromConversationId: sourceId,
      toConversationId: targetId,
      sentAt,
      kind: "message",
      body: "resume this already-delivered message",
      fromSnapshot,
      toSnapshot,
    });
    await inbox.updateState(messageId, {
      state: "processing",
      processingRunId,
    });
    const delivered = createConversationMessageEntry({
      content: [
        "来自会话：未命名会话",
        "来源角色：Default",
        `来源句柄：${sourceId}`,
        "",
        "resume this already-delivered message",
      ].join("\n"),
      display: true,
      details: {
        messageId,
        cardId,
        sentAt,
        kind: "message",
        body: "resume this already-delivered message",
        fromSnapshot,
        toSnapshot,
      },
    });
    targetManager.appendCustomMessageEntry(
      delivered.customType,
      delivered.content,
      delivered.display,
      delivered.details,
    );

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    const fixture = {
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    };
    fixtures.push(fixture);
    await waitUntil(
      () => runtime.controls.get(targetId)?.received.length === 1,
      "the hidden inbox resume trigger",
    );
    await waitUntil(
      async () => (await coordinatorInbox(handle).list()).length === 0,
      "the resumed inbox sidecar cleanup",
    );

    const resumed = runtime.control(targetId).received;
    expect(resumed).toEqual([{
      customType: "workbench.inbox_resume.v1",
      content: expect.stringContaining("恢复此前未结算"),
      display: false,
      details: { runId: processingRunId },
      triggerTurn: true,
    }]);
    const aggregate = aggregateReservedConversationEntries(
      (await coordinator.openConversation(
        handle,
        targetId,
        { updateRecent: false },
      )).sessionManager.getEntries(),
    );
    expect(aggregate.deliveredMessageIds).toEqual([messageId]);
    expect(aggregate.runSettlements).toContainEqual(expect.objectContaining({
      runId: processingRunId,
      outcome: "completed",
    }));
  });

  it("recovers an unreported temporary settlement, returns it once, and deletes the temporary session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-temporary-recovery-"));
    temporaryDirectories.push(cwd);
    const runtime = new FakeRuntime();
    const roles = await RoleCatalog.open(
      runtime,
      join(cwd, "user", "roles.json"),
    );
    const store = await ProjectStore.open(cwd, "full_access");
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const initialRunId = randomUUID();
    const returnMessageId = randomUUID();
    const delegationId = randomUUID();
    await store.createConversation(sourceId, defaultProfile(roles));
    const targetManager = await store.createConversation(
      targetId,
      defaultProfile(roles, {
        lifecycle: {
          kind: "temporary",
          callerConversationId: sourceId,
          delegationId,
          returnMessageId,
          initialRunId,
        },
        createdBy: {
          kind: "conversation",
          conversationId: sourceId,
        },
      }),
    );
    appendReservedCustomEntry(
      targetManager,
      createRunSettlementEntry({
        runId: initialRunId,
        outcome: "completed",
        finalText: "result recovered after restart",
        settledAt: "2026-07-19T12:01:00.000Z",
      }),
    );
    const legacyInbox = await ProjectInbox.open(join(store.stateDir, "inbox"));
    const role = roles.getConversationRole("default");
    await legacyInbox.put({
      messageId: returnMessageId,
      cardId: deterministicTestUuid("piweb.return.card", returnMessageId),
      fromConversationId: targetId,
      toConversationId: sourceId,
      sentAt: "2026-07-19T12:01:01.000Z",
      kind: "delegation_result",
      body: "result recovered after restart",
      delegationId,
      fromSnapshot: {
        conversationId: targetId,
        role: { id: role.id, name: role.name },
      },
      toSnapshot: {
        conversationId: sourceId,
        role: { id: role.id, name: role.name },
      },
    });

    const coordinator = new ProjectSessionCoordinator(runtime, roles);
    const handle = await coordinator.acquireProject(cwd, "full_access");
    const fixture = {
      cwd,
      runtime,
      roles,
      registry: new ProjectStoreRegistry(),
      coordinator,
      handle,
    };
    fixtures.push(fixture);
    await waitUntil(async () =>
      !(await coordinator.listSessions(handle))
        .some(({ id }) => id === targetId),
    "temporary settlement recovery and deletion");
    await waitUntil(
      () => runtime.controls.get(sourceId)?.received.length === 1,
      "recovered result delivery",
    );

    expect(runtime.control(sourceId).received).toHaveLength(1);
    expect(runtime.control(sourceId).received[0]).toMatchObject({
      customType: "piweb.conversation_message.v1",
      content: expect.stringContaining("result recovered after restart"),
      triggerTurn: true,
    });
    expect(
      aggregateReservedConversationEntries(
        (await coordinator.openConversation(
          handle,
          sourceId,
          { updateRecent: false },
        )).sessionManager.getEntries(),
      ).deliveredMessageIds,
    ).toContain(returnMessageId);
  });

  describe("orchestration lineage", () => {
    it("writes root+depth 0 for user-created conversations", async () => {
      const fixture = await createFixture();
      const actor = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      const profile = actor.profile;
      expect(profile.orchestration).toBeDefined();
      expect(profile.orchestration).toMatchObject({
        rootConversationId: actor.conversationId,
        depth: 0,
      });
      expect(profile.orchestration!.sourceRunId).toBeUndefined();
    });

    it("projects stable roots for cold implicit chains and no-metadata legacy sessions", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");
      const rootId = randomUUID();
      const childId = randomUUID();
      const grandchildId = randomUUID();
      const legacyId = randomUUID();
      await fixture.handle.project.createConversation(rootId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
      });
      await fixture.handle.project.createConversation(childId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: rootId },
      });
      await fixture.handle.project.createConversation(grandchildId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: childId },
      });
      await fixture.handle.project.createConversation(legacyId);

      const summaries = await fixture.coordinator.listSessions(fixture.handle);
      const roots = new Map(summaries.map(({ id, rootConversationId }) => [
        id,
        rootConversationId,
      ]));

      expect(roots.get(rootId)).toBe(rootId);
      expect(roots.get(childId)).toBe(rootId);
      expect(roots.get(grandchildId)).toBe(rootId);
      expect(roots.get(legacyId)).toBe(legacyId);
      expect(fixture.runtime.createConversationIds).toEqual([]);
    });

    it("inherits root+depth 1 from a user parent without sourceRunId when idle", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      expect(source.profile.orchestration).toMatchObject({
        rootConversationId: source.conversationId,
        depth: 0,
      });

      // Source is idle, so no sourceRunId.
      const peer = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "orchestration depth check",
          idempotencyKey: "orchestration-peer-1",
        }),
      );
      const peerActor = await fixture.coordinator.openConversation(
        fixture.handle,
        peer.conversationId,
        { updateRecent: false },
      );
      const profile = peerActor.profile;
      expect(profile.orchestration).toBeDefined();
      expect(profile.orchestration).toMatchObject({
        rootConversationId: source.conversationId,
        depth: 1,
      });
      expect(profile.orchestration!.sourceRunId).toBeUndefined();
    });

    it("propagates same root and depth 2 through two-level peer chain", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      const first = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "first level",
          idempotencyKey: "chain-peer-1",
        }),
      );
      const second = await fixture.coordinator.startPeerSession(
        fixture.handle,
        first.conversationId,
        startInput({
          task: "second level",
          idempotencyKey: "chain-peer-2",
        }),
      );

      const firstActor = await fixture.coordinator.openConversation(
        fixture.handle,
        first.conversationId,
        { updateRecent: false },
      );
      const secondActor = await fixture.coordinator.openConversation(
        fixture.handle,
        second.conversationId,
        { updateRecent: false },
      );

      expect(firstActor.profile.orchestration).toMatchObject({
        rootConversationId: source.conversationId,
        depth: 1,
      });
      expect(secondActor.profile.orchestration).toMatchObject({
        rootConversationId: source.conversationId,
        depth: 2,
      });
    });

    it("records sourceRunId from a running source", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      const sourceRunId = randomUUID();
      let peer: { conversationId: string; runId: string; temporary: boolean } | undefined;
      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          peer = await executeTool(
            control,
            "start_session",
            "source-run-peer",
            {
              roleId: "default",
              task: "started from active source run",
              temporary: false,
            },
          ) as typeof peer;
          control.emitFinal("done");
        },
      );

      await fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        sourceRunId,
        "start a peer while running",
      );

      expect(peer).toBeDefined();
      const peerActor = await fixture.coordinator.openConversation(
        fixture.handle,
        peer!.conversationId,
        { updateRecent: false },
      );
      expect(peerActor.profile.orchestration).toMatchObject({
        rootConversationId: source.conversationId,
        depth: 1,
        sourceRunId,
      });
      await waitUntil(() => (
        aggregateReservedConversationEntries(
          source.sessionManager.getEntries(),
        ).cards.find(({ body }) => body === "started from active source run")
          ?.state === "completed"
      ), "the delegation card to reach its terminal state");
      expect(
        aggregateReservedConversationEntries(
          source.sessionManager.getEntries(),
        ).cards.find(({ body }) => body === "started from active source run"),
      ).toMatchObject({
        orchestration: {
          rootConversationId: source.conversationId,
          depth: 1,
          sourceRunId,
        },
      });
    });

    it("replays a sending card with its original orchestration snapshot", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const input = startInput({
        task: "replay the recorded lineage",
        idempotencyKey: "recorded-lineage-replay",
      });
      const targetId = deterministicTestUuid(
        "piweb.start.conversation",
        input.idempotencyKey,
      );
      const messageId = deterministicTestUuid(
        "piweb.start.message",
        input.idempotencyKey,
      );
      const recordedSourceRunId = randomUUID();
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId: deterministicTestUuid(
            "piweb.start.card",
            input.idempotencyKey,
          ),
          kind: "delegation_task",
          body: input.task,
          fromSnapshot: {
            conversationId: source.conversationId,
            role: {
              id: source.profile.role.id,
              name: source.profile.role.name,
            },
          },
          toSnapshot: {
            conversationId: targetId,
            title: input.task,
            role: {
              id: source.profile.role.id,
              name: source.profile.role.name,
            },
          },
          state: "sending",
          messageId,
          delegationId: deterministicTestUuid(
            "piweb.start.delegation",
            input.idempotencyKey,
          ),
          requestFingerprint: createHash("sha256")
            .update(JSON.stringify([
              input.roleId,
              input.task,
              null,
              input.temporary,
            ]))
            .digest("hex"),
          requestedRole: source.profile.role,
          orchestration: {
            rootConversationId: source.conversationId,
            depth: 1,
            sourceRunId: recordedSourceRunId,
          },
          updatedAt: "2026-07-19T10:00:00.000Z",
        }),
      );

      const replay = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        input,
      );
      const target = await fixture.coordinator.openConversation(
        fixture.handle,
        replay.conversationId,
        { updateRecent: false },
      );

      expect(target.profile.orchestration).toEqual({
        rootConversationId: source.conversationId,
        depth: 1,
        sourceRunId: recordedSourceRunId,
      });
    });

    it("resolves implicit lineage from legacy conversations without orchestration", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");

      // A: user-created, no orchestration (pre-feature legacy).
      const aId = randomUUID();
      await fixture.handle.project.createConversation(aId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
      });

      // B: created by A, no orchestration (legacy peer).
      const bId = randomUUID();
      await fixture.handle.project.createConversation(bId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: aId },
      });

      // Open B so its profile is loaded and create a peer C.
      const bActor = await fixture.coordinator.openConversation(
        fixture.handle,
        bId,
        { updateRecent: false },
      );
      const c = await fixture.coordinator.startPeerSession(
        fixture.handle,
        bId,
        startInput({
          task: "legacy-lineage-child",
          idempotencyKey: "legacy-lineage-c",
        }),
      );

      const cActor = await fixture.coordinator.openConversation(
        fixture.handle,
        c.conversationId,
        { updateRecent: false },
      );
      expect(cActor.profile.orchestration).toMatchObject({
        rootConversationId: aId,
        depth: 2,
      });
    });

    it("rejects start when the createdBy parent is missing and there is no orchestration", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");

      // B references a non-existent parent A.
      const bId = randomUUID();
      await fixture.handle.project.createConversation(bId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: randomUUID() },
      });

      const bActor = await fixture.coordinator.openConversation(
        fixture.handle,
        bId,
        { updateRecent: false },
      );
      const input = startInput({
        task: "missing-parent",
        idempotencyKey: "missing-parent-test",
      });
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle,
        bId,
        input,
      )).rejects.toThrow(/parent.*not found|orchestration/i);

      // Verify no card was written.
      const bCards = aggregateReservedConversationEntries(
        bActor.sessionManager.getEntries(),
      ).cards;
      expect(
        bCards.find(({ body }) => body === input.task),
      ).toBeUndefined();
    });

    it("rejects a createdBy cycle before writing a sending card", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");

      // A createdBy B, B createdBy A (cycle).
      const aId = randomUUID();
      const bId = randomUUID();
      await fixture.handle.project.createConversation(aId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: bId },
      });
      await fixture.handle.project.createConversation(bId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: aId },
      });

      const bActor = await fixture.coordinator.openConversation(
        fixture.handle,
        bId,
        { updateRecent: false },
      );
      const input = startInput({
        task: "cycle-test",
        idempotencyKey: "cycle-test-input",
      });
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle,
        bId,
        input,
      )).rejects.toThrow(/cycle/i);

      // Verify no card was written.
      const bCards = aggregateReservedConversationEntries(
        bActor.sessionManager.getEntries(),
      ).cards;
      expect(
        bCards.find(({ body }) => body === input.task),
      ).toBeUndefined();
    });

    it("cascades deletion through legacy implicit children", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");
      const parentId = randomUUID();
      const childId = randomUUID();
      await fixture.handle.project.createConversation(parentId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
      });
      await fixture.handle.project.createConversation(childId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: {
          kind: "conversation",
          conversationId: parentId,
        },
      });

      await expect(fixture.coordinator.deleteConversation(
        fixture.handle,
        parentId,
      )).resolves.toBe(true);
      const remainingIds = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      expect(remainingIds).not.toContain(parentId);
      expect(remainingIds).not.toContain(childId);
    });

    it("cascades deletion through explicit orchestration descendants", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      const unrelated = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const child = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "cascade-child",
          idempotencyKey: "cascade-child",
        }),
      );
      const grandchild = await fixture.coordinator.startPeerSession(
        fixture.handle,
        child.conversationId,
        startInput({
          task: "cascade-grandchild",
          idempotencyKey: "cascade-grandchild",
        }),
      );

      await expect(fixture.coordinator.deleteConversation(
        fixture.handle,
        source.conversationId,
      )).resolves.toBe(true);

      const remainingIds = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
      expect(remainingIds).toContain(unrelated.conversationId);
      expect(remainingIds).not.toContain(source.conversationId);
      expect(remainingIds).not.toContain(child.conversationId);
      expect(remainingIds).not.toContain(grandchild.conversationId);
    });

    it("rejects malformed lineage before destructive cascade deletion", async () => {
      const fixture = await createFixture();
      const firstId = randomUUID();
      const secondId = randomUUID();
      await fixture.handle.project.createConversation(
        firstId,
        defaultProfile(fixture.roles, {
          createdBy: { kind: "conversation", conversationId: secondId },
        }),
      );
      await fixture.handle.project.createConversation(
        secondId,
        defaultProfile(fixture.roles, {
          createdBy: { kind: "conversation", conversationId: firstId },
        }),
      );
      await fixture.handle.project.refreshConversations();

      await expect(fixture.coordinator.deleteConversation(
        fixture.handle,
        firstId,
      )).rejects.toThrow("cycle detected");
      const remainingIds = (
        await fixture.handle.project.refreshConversations()
      ).map(({ id }) => id);
      expect(remainingIds).toContain(firstId);
      expect(remainingIds).toContain(secondId);
    });

    it("rejects cascade deletion while any descendant is busy", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const child = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "busy cascade child",
          idempotencyKey: "busy-cascade-child",
        }),
      );
      await waitUntil(async () =>
        (await fixture.coordinator.listSessions(fixture.handle))
          .find(({ id }) => id === child.conversationId)
          ?.activity.kind === "idle",
      "cascade child initial run to settle");
      const started = deferred();
      const release = deferred();
      fixture.runtime.control(child.conversationId).enqueue(
        blocksUntil(started, release, "child done"),
      );
      const childRun = fixture.coordinator.prompt(
        fixture.handle,
        child.conversationId,
        randomUUID(),
        "keep the child busy",
      );
      await started.promise;

      await expect(fixture.coordinator.deleteConversation(
        fixture.handle,
        source.conversationId,
      )).rejects.toThrow("busy conversation");
      expect(
        (await fixture.coordinator.listSessions(fixture.handle))
          .map(({ id }) => id),
      ).toEqual(expect.arrayContaining([
        source.conversationId,
        child.conversationId,
      ]));

      release.resolve();
      await childRun;
    });

    it("treats an existing parent without conversationMeta as user root for implicit child", async () => {
      const fixture = await createFixture();
      const role = fixture.roles.getConversationRole("default");

      // Parent file exists but has no conversationMeta (pre-feature legacy).
      const parentId = randomUUID();
      // Create a minimal session file without any custom entries.
      await fixture.handle.project.createConversation(parentId);

      // Child references the parent via createdBy, no orchestration.
      const childId = randomUUID();
      await fixture.handle.project.createConversation(childId, {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "conversation", conversationId: parentId },
      });

      // Open child and create a peer — resolveOrchestration should treat
      // the no-meta parent as a user root.
      const childActor = await fixture.coordinator.openConversation(
        fixture.handle,
        childId,
        { updateRecent: false },
      );
      const peer = await fixture.coordinator.startPeerSession(
        fixture.handle,
        childId,
        startInput({
          task: "legacy-no-meta-parent",
          idempotencyKey: "legacy-no-meta-parent",
        }),
      );

      const peerActor = await fixture.coordinator.openConversation(
        fixture.handle,
        peer.conversationId,
        { updateRecent: false },
      );
      expect(peerActor.profile.orchestration).toMatchObject({
        rootConversationId: parentId,
        depth: 2,
      });
    });
  });

  describe("session budget limits", () => {
    it("permits depth up to MAX_DELEGATION_DEPTH and rejects deeper", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      let parentId = source.conversationId;
      let deepest: { conversationId: string; runId: string } | undefined;
      for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth++) {
        const peer = await fixture.coordinator.startPeerSession(
          fixture.handle,
          parentId,
          startInput({
            task: `depth level ${depth + 1}`,
            idempotencyKey: `budget-depth-${depth}`,
          }),
        );
        deepest = peer;
        parentId = peer.conversationId;
      }

      const exceeded = startInput({
        task: "one level too deep",
        idempotencyKey: "budget-depth-exceeded",
      });
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle,
        parentId,
        exceeded,
      )).rejects.toThrow(/depth|maximum/i);

      // No card on deepest parent.
      const deepestActor = await fixture.coordinator.openConversation(
        fixture.handle,
        deepest!.conversationId,
        { updateRecent: false },
      );
      expect(aggregateReservedConversationEntries(
        deepestActor.sessionManager.getEntries(),
      ).cards.find(({ body }) => body === exceeded.task)).toBeUndefined();

      // No target conversation created.
      const expectedId = deterministicTestUuid(
        "piweb.start.conversation",
        exceeded.idempotencyKey,
      );
      expect((await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === expectedId)).toBeUndefined();
    });

    it("enforces MAX_PEER_SESSIONS_PER_RUN within one run; delete doesn't free slot", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const peerIds: string[] = [];
      let fifthError: unknown;
      let retriedConversationId: string | undefined;

      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          for (let index = 0; index < MAX_PEER_SESSIONS_PER_RUN; index++) {
            const peer = await executeTool(
              control,
              "start_session",
              `budget-run-${index}`,
              {
                roleId: "default",
                task: `peer-${index}`,
                temporary: false,
              },
            ) as { conversationId: string };
            peerIds.push(peer.conversationId);
          }
          await waitUntil(async () => (
            (await fixture.coordinator.listSessions(fixture.handle))
              .find(({ id }) => id === peerIds[0])?.activity?.kind === "idle"
          ), "the first budget peer to become idle");
          await fixture.coordinator.deleteConversation(
            fixture.handle,
            peerIds[0]!,
          );
          try {
            await executeTool(
              control,
              "start_session",
              "budget-run-exceeded",
              {
                roleId: "default",
                task: "deletion must not free the run budget",
                temporary: false,
              },
            );
          } catch (error) {
            fifthError = error;
          }
          const retry = await executeTool(
            control,
            "start_session",
            "budget-run-0",
            {
              roleId: "default",
              task: "peer-0",
              temporary: false,
            },
          ) as { conversationId: string };
          retriedConversationId = retry.conversationId;
          control.emitFinal("same-run budget checked");
        },
      );

      const settlement = await fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "exercise one run budget",
      );
      expect(settlement.outcome).toBe("completed");
      expect(fifthError).toBeInstanceOf(Error);
      expect((fifthError as Error).message).toMatch(/limit|maximum/i);
      expect(retriedConversationId).toBe(peerIds[0]);

      let freshConversationId: string | undefined;
      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          const fresh = await executeTool(
            control,
            "start_session",
            "fresh-run-peer",
            {
              roleId: "default",
              task: "a fresh run has a fresh budget",
              temporary: false,
            },
          ) as { conversationId: string };
          freshConversationId = fresh.conversationId;
          control.emitFinal("fresh run accepted");
        },
      );
      const freshSettlement = await fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "exercise a fresh run budget",
      );
      expect(freshSettlement.outcome).toBe("completed");
      expect(freshConversationId).toEqual(expect.any(String));
    }, 15_000);

    it("enforces MAX_LIVE_DELEGATION_DESCENDANTS and allows creation after deletion", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      const peerIds: string[] = [];
      for (let i = 0; i < MAX_LIVE_DELEGATION_DESCENDANTS; i++) {
        const peer = await fixture.coordinator.startPeerSession(
          fixture.handle,
          source.conversationId,
          startInput({
            task: `live-descendant-${i}`,
            idempotencyKey: `live-descendant-${i}`,
          }),
        );
        peerIds.push(peer.conversationId);
      }

      const exceeded = startInput({
        task: "too many descendants",
        idempotencyKey: "live-descendant-exceeded",
      });
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        exceeded,
      )).rejects.toThrow(/limit|maximum/i);

      // Delete one descendant → now creation succeeds.
      await fixture.coordinator.deleteConversation(
        fixture.handle,
        peerIds[0]!,
      );
      const afterDeletion = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "after descendant deletion",
          idempotencyKey: "live-descendant-after-delete",
        }),
      );
      expect(afterDeletion).toMatchObject({ conversationId: expect.any(String) });
    }, 15_000);

    it("keeps a reserved but failed deletion in the live descendant count", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const peerIds: string[] = [];
      for (let index = 0; index < MAX_LIVE_DELEGATION_DESCENDANTS; index++) {
        const peer = await fixture.coordinator.startPeerSession(
          fixture.handle,
          source.conversationId,
          startInput({
            task: `reserved-delete-peer-${index}`,
            idempotencyKey: `reserved-delete-peer-${index}`,
          }),
        );
        peerIds.push(peer.conversationId);
      }
      const busyStarted = deferred();
      const releaseBusy = deferred();
      fixture.runtime.control(peerIds[0]!).enqueue(
        blocksUntil(busyStarted, releaseBusy, "busy descendant finished"),
      );
      const busyCompletion = fixture.coordinator.prompt(
        fixture.handle,
        peerIds[0]!,
        randomUUID(),
        "stay busy during deletion",
      );
      await busyStarted.promise;

      const exceededInput = startInput({
        task: "reservation must not free a slot",
        idempotencyKey: "reserved-delete-exceeded",
      });
      const results = await Promise.allSettled([
        fixture.coordinator.startPeerSession(
          fixture.handle,
          source.conversationId,
          exceededInput,
        ),
        fixture.coordinator.deleteConversation(
          fixture.handle,
          peerIds[0]!,
        ),
      ]);
      expect(results.map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(
        results[0]?.status === "rejected"
          ? String(results[0].reason)
          : "",
      ).toMatch(/limit|maximum/i);
      expect(
        results[1]?.status === "rejected"
          ? String(results[1].reason)
          : "",
      ).toMatch(/busy|compacting/i);
      const exceededId = deterministicTestUuid(
        "piweb.start.conversation",
        exceededInput.idempotencyKey,
      );
      expect((await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === exceededId)).toBe(false);

      releaseBusy.resolve();
      await busyCompletion;
    }, 15_000);

    it("rejects a failed sending precommit that would exceed the live cap on replay after restart", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );

      // Precommit: write sending card for K, crash before target creation.
      let failNextTarget = true;
      const precommitInput = startInput({
        task: "precommit-K",
        idempotencyKey: "precommit-K-replay",
      });
      fixture.runtime.beforeCreateSession = async (conversationId) => {
        if (conversationId !== source.conversationId && failNextTarget) {
          failNextTarget = false;
          throw new Error("simulated crash after precommit");
        }
      };
      await expect(fixture.coordinator.startPeerSession(
        fixture.handle, source.conversationId, precommitInput,
      )).rejects.toThrow("simulated crash after precommit");

      await fixture.coordinator.close();

      // Re-create coordinator and fill MAX_LIVE_DELEGATION_DESCENDANTS.
      const restarted = new ProjectSessionCoordinator(
        fixture.runtime, fixture.roles, fixture.registry,
      );
      const handle = await restarted.acquireProject(fixture.cwd, "full_access");
      await restarted.openConversation(handle, source.conversationId, { updateRecent: false });

      for (let i = 0; i < MAX_LIVE_DELEGATION_DESCENDANTS; i++) {
        await restarted.startPeerSession(
          handle, source.conversationId,
          startInput({ task: `filler-${i}`, idempotencyKey: `filler-${i}` }),
        );
      }

      // Replay K — must be rejected (live cap exceeded).
      await expect(restarted.startPeerSession(
        handle, source.conversationId, precommitInput,
      )).rejects.toThrow(/limit|maximum/i);

      // No second card was created.
      const sourceActor = await restarted.openConversation(
        handle, source.conversationId, { updateRecent: false },
      );
      const sendingCards = aggregateReservedConversationEntries(
        sourceActor.sessionManager.getEntries(),
      ).cards.filter(({ body }) => body === precommitInput.task);
      expect(sendingCards).toHaveLength(1);

      await restarted.close();
    }, 15_000);

    it("charges terminal legacy cards to a recovered source run after restart", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const runId = randomUUID();
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId: randomUUID(),
          kind: "delegation_task",
          body: "run-correlated delegation",
          fromSnapshot: {
            conversationId: source.conversationId,
            role: { id: "default", name: "Default" },
          },
          toSnapshot: {
            conversationId: randomUUID(),
            role: { id: "default", name: "Default" },
          },
          state: "completed",
          messageId: randomUUID(),
          delegationId: randomUUID(),
          orchestration: {
            rootConversationId: source.conversationId,
            depth: 1,
            sourceRunId: runId,
          },
          updatedAt: "2026-07-19T10:00:00.000Z",
        }),
      );
      const legacyStates = ["completed", "failed", "aborted"] as const;
      const legacyCount = MAX_PEER_SESSIONS_PER_RUN - 1;
      for (let index = 0; index < legacyCount; index++) {
        const state = legacyStates[index % legacyStates.length]!;
        appendReservedCustomEntry(
          source.sessionManager,
          createConversationCardEntry({
            cardId: randomUUID(),
            kind: "delegation_task",
            body: `legacy ${state} delegation`,
            fromSnapshot: {
              conversationId: source.conversationId,
              role: { id: "default", name: "Default" },
            },
            toSnapshot: {
              conversationId: randomUUID(),
              role: { id: "default", name: "Default" },
            },
            state,
            messageId: randomUUID(),
            delegationId: randomUUID(),
            updatedAt: `2026-07-19T10:${String(index).padStart(2, "0")}:00.000Z`,
          }),
        );
      }

      await fixture.coordinator.close();
      const restarted = new ProjectSessionCoordinator(
        fixture.runtime,
        fixture.roles,
        fixture.registry,
      );
      const handle = await restarted.acquireProject(fixture.cwd, "full_access");
      const sourceActor = await restarted.openConversation(
        handle,
        source.conversationId,
        { updateRecent: false },
      );

      let journalOutcome: string | undefined;
      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          const exceeded = executeTool(
            control,
            "start_session",
            "journal-exceeded",
            {
              roleId: "default",
              task: "journal limit",
              temporary: false,
            },
          );
          await expect(exceeded).rejects.toThrow(/limit|maximum/i);
          journalOutcome = "blocked";
          control.emitFinal("journal recovery verified");
        },
      );
      expect((await sourceActor.resumeMessages({ runId })).outcome)
        .toBe("completed");
      expect(journalOutcome).toBe("blocked");

      let freshConversationId: string | undefined;
      fixture.runtime.control(source.conversationId).enqueue(
        async (control) => {
          const fresh = await executeTool(
            control,
            "start_session",
            "post-recovery-fresh-run",
            {
              roleId: "default",
              task: "legacy cards do not poison future runs",
              temporary: false,
            },
          ) as { conversationId: string };
          freshConversationId = fresh.conversationId;
          control.emitFinal("fresh run accepted");
        },
      );
      expect((await restarted.prompt(
        handle,
        source.conversationId,
        randomUUID(),
        "start a fresh run",
      )).outcome).toBe("completed");
      expect(freshConversationId).toEqual(expect.any(String));
      await restarted.close();
    });
  });

  describe("wait cache checkpoints", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uses a four-minute checkpoint delay", () => {
      expect(WAIT_CACHE_CHECKPOINT_DELAY_MS).toBe(4 * 60 * 1_000);
    });

    function makeWaitCacheEligible(control: FakeSessionControl): void {
      control.contextUsage = {
        tokens: 50_000,
        contextWindow: 200_000,
        percent: 25,
      };
      const model = control.session.model;
      if (!model) throw new Error("Expected a test model");
      model.cost = { input: 10, output: 1, cacheRead: 1, cacheWrite: 1 };
    }

    function observeWaitCacheTimers() {
      const spy = vi.spyOn(global, "setTimeout");
      return () => spy.mock.calls.flatMap((call, index) => {
        const [callback, delay] = call;
        if (
          delay !== WAIT_CACHE_CHECKPOINT_DELAY_MS
          || typeof callback !== "function"
        ) {
          return [];
        }
        const result = spy.mock.results[index];
        if (!result || result.type !== "return") {
          throw new Error("Expected wait-cache timer handle");
        }
        return [{
          fire: () => callback(),
          handle: result.value as ReturnType<typeof setTimeout>,
        }];
      });
    }

    it("returns a checkpoint without fabricating target completion", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const target = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      makeWaitCacheEligible(
        fixture.runtime.control(source.conversationId),
      );

      const targetStarted = deferred();
      const releaseTarget = deferred();
      fixture.runtime.control(target.conversationId).enqueue(
        blocksUntil(targetStarted, releaseTarget),
      );
      const targetRunId = randomUUID();
      const targetCompletion = fixture.coordinator.prompt(
        fixture.handle,
        target.conversationId,
        targetRunId,
        "hold target",
      );
      await targetStarted.promise;

      const timers = observeWaitCacheTimers();
      const waitReturned = deferred();
      const releaseSource = deferred();
      let waitResult: unknown;
      fixture.runtime.control(source.conversationId).enqueue(async (control) => {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "checkpoint-wait",
          { conversationId: target.conversationId, runId: targetRunId },
        );
        waitReturned.resolve();
        await releaseSource.promise;
        control.emitFinal("source finished");
      });
      const sourceCompletion = fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "wait for target",
      );
      await waitUntil(
        () => source.getActivity().kind === "waiting",
        "checkpoint waiter registration",
      );
      await waitUntil(
        () => timers().length === 1,
        "wait-cache timer registration",
      );

      const timer = timers()[0];
      if (!timer) throw new Error("Expected wait-cache timer");
      clearTimeout(timer.handle);
      timer.fire();
      await waitReturned.promise;

      expect(waitResult).toEqual({ outcome: "checkpoint" });
      expect(source.getActivity().kind).toBe("running");
      expect(target.getActivity().kind).toBe("running");

      releaseSource.resolve();
      releaseTarget.resolve();
      await expect(sourceCompletion).resolves.toMatchObject({
        outcome: "completed",
      });
      await expect(targetCompletion).resolves.toMatchObject({
        outcome: "completed",
        runId: targetRunId,
      });
    });

    it("lets a durable settlement win and clears its checkpoint timer", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const target = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      makeWaitCacheEligible(
        fixture.runtime.control(source.conversationId),
      );

      const targetStarted = deferred();
      const releaseTarget = deferred();
      fixture.runtime.control(target.conversationId).enqueue(
        blocksUntil(targetStarted, releaseTarget),
      );
      const targetRunId = randomUUID();
      const targetCompletion = fixture.coordinator.prompt(
        fixture.handle,
        target.conversationId,
        targetRunId,
        "settle before timer",
      );
      await targetStarted.promise;

      const timers = observeWaitCacheTimers();
      const clearTimer = vi.spyOn(global, "clearTimeout");
      const waitReturned = deferred();
      let waitResult: unknown;
      fixture.runtime.control(source.conversationId).enqueue(async (control) => {
        waitResult = await executeTool(
          control,
          "wait_for_session",
          "settlement-wait",
          { conversationId: target.conversationId, runId: targetRunId },
        );
        waitReturned.resolve();
        control.emitFinal("settlement observed");
      });
      const sourceCompletion = fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "wait for settlement",
      );
      await waitUntil(
        () => source.getActivity().kind === "waiting",
        "settlement waiter registration",
      );
      await waitUntil(
        () => timers().length === 1,
        "settlement wait-cache timer registration",
      );
      const timer = timers()[0];
      if (!timer) throw new Error("Expected wait-cache timer");
      const claim = vi.spyOn(source, "claimWaitCacheCheckpoint");

      releaseTarget.resolve();
      await targetCompletion;
      await waitReturned.promise;

      expect(waitResult).toMatchObject({
        outcome: "completed",
        runId: targetRunId,
      });
      expect(clearTimer).toHaveBeenCalledWith(timer.handle);
      timer.fire();
      expect(claim).not.toHaveBeenCalled();
      await sourceCompletion;
    });

    it("uses positive cache feedback but never installs a ninth timer", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const target = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      makeWaitCacheEligible(
        fixture.runtime.control(source.conversationId),
      );

      const targetStarted = deferred();
      const releaseTarget = deferred();
      fixture.runtime.control(target.conversationId).enqueue(
        blocksUntil(targetStarted, releaseTarget),
      );
      const targetRunId = randomUUID();
      const targetCompletion = fixture.coordinator.prompt(
        fixture.handle,
        target.conversationId,
        targetRunId,
        "hold target through eight checkpoints",
      );
      await targetStarted.promise;

      const timers = observeWaitCacheTimers();
      const abortNinthWait = new AbortController();
      const ninthWaitStarted = deferred();
      const waitResults: unknown[] = [];
      let ninthWaitError: unknown;
      fixture.runtime.control(source.conversationId).enqueue(async (control) => {
        for (let checkpoint = 1; checkpoint <= 8; checkpoint += 1) {
          waitResults.push(await executeTool(
            control,
            "wait_for_session",
            `checkpoint-${checkpoint}`,
            { conversationId: target.conversationId, runId: targetRunId },
          ));
          control.emitAssistantUsage(20, 80, 10);
        }
        ninthWaitStarted.resolve();
        try {
          await executeTool(
            control,
            "wait_for_session",
            "checkpoint-nine",
            { conversationId: target.conversationId, runId: targetRunId },
            abortNinthWait.signal,
          );
        } catch (error) {
          ninthWaitError = error;
        }
        control.emitFinal("checkpoint cap observed");
      });
      const sourceCompletion = fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "wait repeatedly",
      );

      for (let index = 0; index < 8; index += 1) {
        await waitUntil(
          () => timers().length === index + 1,
          `checkpoint timer ${index + 1}`,
        );
        const timer = timers()[index];
        if (!timer) throw new Error("Expected checkpoint timer");
        clearTimeout(timer.handle);
        timer.fire();
      }

      await ninthWaitStarted.promise;
      await waitUntil(
        () => source.getActivity().kind === "waiting",
        "ninth wait without a checkpoint timer",
      );
      expect(timers()).toHaveLength(8);
      expect(waitResults).toEqual(
        Array.from({ length: 8 }, () => ({ outcome: "checkpoint" })),
      );

      abortNinthWait.abort();
      await sourceCompletion;
      expect(ninthWaitError).toMatchObject({ name: "AbortError" });
      releaseTarget.resolve();
      await targetCompletion;
    });

    it("clears an aborted wait timer and ignores its stale callback", async () => {
      const fixture = await createFixture();
      const source = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      const target = await fixture.coordinator.createUserConversation(
        fixture.handle,
        { roleId: "default" },
      );
      makeWaitCacheEligible(
        fixture.runtime.control(source.conversationId),
      );

      const timers = observeWaitCacheTimers();
      const clearTimer = vi.spyOn(global, "clearTimeout");
      const abort = new AbortController();
      const waitReturned = deferred();
      let waitError: unknown;
      fixture.runtime.control(source.conversationId).enqueue(async (control) => {
        try {
          await executeTool(
            control,
            "wait_for_session",
            "aborted-checkpoint-wait",
            { conversationId: target.conversationId, runId: RUN_A },
            abort.signal,
          );
        } catch (error) {
          waitError = error;
        }
        waitReturned.resolve();
        control.emitFinal("aborted wait handled");
      });
      const sourceCompletion = fixture.coordinator.prompt(
        fixture.handle,
        source.conversationId,
        randomUUID(),
        "abort this wait",
      );
      await waitUntil(
        () => source.getActivity().kind === "waiting",
        "aborted waiter registration",
      );
      await waitUntil(
        () => timers().length === 1,
        "aborted wait-cache timer registration",
      );
      const timer = timers()[0];
      if (!timer) throw new Error("Expected wait-cache timer");
      const claim = vi.spyOn(source, "claimWaitCacheCheckpoint");

      abort.abort();
      await waitReturned.promise;

      expect(waitError).toMatchObject({ name: "AbortError" });
      expect(clearTimer).toHaveBeenCalledWith(timer.handle);
      timer.fire();
      expect(claim).not.toHaveBeenCalled();
      await sourceCompletion;
    });
  });
});

class TrackingProjectStoreRegistry extends ProjectStoreRegistry {
  readonly events: Array<{
    conversationId: string;
    kind: "release" | "upgrade" | "deletion_release";
  }> = [];

  override acquireConversation(
    canonicalCwd: string,
    conversationId: string,
  ): ConversationLease {
    const lease = super.acquireConversation(canonicalCwd, conversationId);
    return this.trackLease(conversationId, lease);
  }

  private trackLease(
    conversationId: string,
    lease: ConversationLease,
  ): ConversationLease {
    return {
      release: () => {
        this.events.push({ conversationId, kind: "release" });
        lease.release();
      },
      upgradeToDeletion: (): ConversationDeletionLease => {
        this.events.push({ conversationId, kind: "upgrade" });
        const deletion = lease.upgradeToDeletion();
        return {
          release: () => {
            this.events.push({
              conversationId,
              kind: "deletion_release",
            });
            deletion.release();
          },
        };
      },
    };
  }
}

class ConcurrentProjectOpenRegistry extends ProjectStoreRegistry {
  readonly firstAcquireStarted = deferred();
  readonly releaseAcquires = deferred();
  acquireCalls = 0;
  releaseCalls = 0;

  override async acquireProject(
    cwd: string,
    seedToolMode: Parameters<
      ProjectStoreRegistry["acquireProject"]
    >[1],
  ): Promise<ProjectStoreHandle> {
    this.acquireCalls++;
    this.firstAcquireStarted.resolve();
    await this.releaseAcquires.promise;
    const handle = await super.acquireProject(cwd, seedToolMode);
    let released = false;
    return {
      store: handle.store,
      release: () => {
        if (released) return;
        released = true;
        this.releaseCalls++;
        handle.release();
      },
    };
  }
}

class ShortConversationWaitRegistry extends ProjectStoreRegistry {
  override acquireConversationWhenAvailable(
    canonicalCwd: string,
    conversationId: string,
    options: ConversationLeaseWaitOptions = {},
  ): Promise<ConversationLease> {
    return super.acquireConversationWhenAvailable(
      canonicalCwd,
      conversationId,
      {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 100, 100),
      },
    );
  }
}
