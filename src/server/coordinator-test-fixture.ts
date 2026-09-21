import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
  type ConversationActorEvent,
} from "./conversation-actor.js";
import {
  CONVERSATION_CARD_CUSTOM_TYPE,
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createLoopListEntry,
  createMessageDeliveryReceiptEntry,
  createMetaOperationEntry,
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
  WAIT_POLL_DELAY_MS,
  type StartPeerSessionInput,
} from "./project-session-coordinator.js";
import { ProjectStore } from "./project-store.js";
import {
  ProjectStoreRegistry,
  type ConversationDeletionLease,
  type ConversationLease,
  type ConversationLeaseWaitOptions,
  type ProjectStoreHandle,
} from "./project-store-registry.js";
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
      sessionId: this.manager.getSessionId(),
      agent: {
        state: {
          messages,
        },
        transport: "sse",
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
        partial: {
          role: "assistant",
          content: [{ type: "text", text: delta }],
        },
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

interface BlockedSourceRun {
  runId: string;
  completion: Promise<RunSettlement>;
  release: Deferred<void>;
}

/** Run direct coordinator calls under the exact source-run admission boundary. */
async function startBlockedSourceRun(
  fixture: Fixture,
  sourceConversationId: string,
  promptText = "source work remains active",
): Promise<BlockedSourceRun> {
  const started = deferred();
  const release = deferred();
  fixture.runtime.control(sourceConversationId).enqueue(
    blocksUntil(started, release),
  );
  const runId = randomUUID();
  const completion = fixture.coordinator.prompt(
    fixture.handle,
    sourceConversationId,
    runId,
    promptText,
  );
  await started.promise;
  return { runId, completion, release };
}

/** Admit one peer while its source owns an exact active run, then settle it. */
async function startPeerFromActiveSource(
  fixture: Fixture,
  sourceConversationId: string,
  input: StartPeerSessionInput,
): Promise<{ conversationId: string; runId: string }> {
  const sourceRun = await startBlockedSourceRun(
    fixture,
    sourceConversationId,
    "admit one peer from an exact source run",
  );
  try {
    return await fixture.coordinator.startPeerSession(
      fixture.handle,
      sourceConversationId,
      { ...input, sourceRunId: sourceRun.runId },
    );
  } finally {
    sourceRun.release.resolve();
    await sourceRun.completion;
  }
}

type TitleStreamCall = Parameters<AgentSession["agent"]["streamFunction"]>;

class FakeRuntime implements PiRuntimeLike {
  readonly credentialStore = new InMemoryCredentialStore();
  titleImplementation: (...args: TitleStreamCall) => Promise<AssistantMessage> =
    async () => automaticTitleMessage("测试任务");
  readonly titleCalls: TitleStreamCall[] = [];
  readonly modelRuntime = {} as unknown as ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  sessionModelRegistry?: ModelRegistry;
  projectModelRegistry?: ModelRegistry;
  readonly controls = new Map<string, FakeSessionControl>();
  readonly createOptions = new Map<string, CreatePiSessionOptions>();
  readonly modelListeners = new Set<() => void>();
  readonly createConversationIds: string[] = [];
  readonly availableModels: RoleCatalogModel[] = [
    {
      provider: "test",
      id: "model-a",
      reasoning: true,
      contextWindow: 200_000,
    },
    {
      provider: "test",
      id: "model-b",
      reasoning: true,
      contextWindow: 200_000,
    },
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
    // The actor issues the isolated title request through the public session
    // stream function, so capture calls at that boundary.
    control.session.agent.streamFunction = ((
      model: TitleStreamCall[0],
      context: TitleStreamCall[1],
      options_: TitleStreamCall[2],
    ) => {
      this.titleCalls.push([model, context, options_]);
      return {
        result: () => this.titleImplementation(model, context, options_),
      };
    }) as unknown as AgentSession["agent"]["streamFunction"];
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
  const sessionMessageInput = name === "send_session_message"
    && typeof input === "object"
    && input !== null
    && !Array.isArray(input)
    && !("summary" in input);
  const normalizedInput = sessionMessageInput
    ? {
        ...input,
        summary: "Test user summary",
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
      compactionModel: defaultRole.compactionModel,
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
  const handle = await coordinator.acquireProject(cwd);
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
      removeTemporaryDirectory(directory),
    ),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
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

export {
  RUN_A,
  RUN_B,
  getRoleTemplate,
  deferred,
  agentMessage,
  automaticTitleMessage,
  FakeSessionControl,
  blocksUntil,
  startBlockedSourceRun,
  startPeerFromActiveSource,
  FakeRuntime,
  executeTool,
  waitUntil,
  createFixture,
  coordinatorInbox,
  defaultProfile,
  startInput,
  deterministicTestUuid,
  completesWith,
  failsWith,
  fixtures,
  temporaryDirectories,
};
export type {
  Deferred,
  SessionBehavior,
  ReceivedCustomMessage,
  BlockedSourceRun,
  ToolResult,
  Fixture,
};
