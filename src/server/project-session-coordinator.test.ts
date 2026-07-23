import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentMessage,
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ExtensionError,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectActivitySummary } from "../shared/protocol.js";
import { ConversationActor } from "./conversation-actor.js";
import {
  CONVERSATION_CARD_CUSTOM_TYPE,
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createMetaOperationEntry,
  createRunSettlementEntry,
  MAX_CONVERSATION_BODY_BYTES,
  type ConversationMeta,
  type RunSettlement,
} from "./conversation-meta.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
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
import {
  RoleCatalog,
  type RoleCatalogModel,
} from "./role-catalog.js";

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

type SessionBehavior = (control: FakeSessionControl) => Promise<void>;

interface ReceivedCustomMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
  triggerTurn: boolean;
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
  readonly behaviors: SessionBehavior[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  skipNextCustomMessagePersistence = false;
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
    this.session = {
      isStreaming: false,
      messages: [],
      agent: {
        state: {
          messages: [],
        },
      },
      model: options.model === undefined
        ? { provider: "test", id: "model-a" }
        : { ...options.model },
      thinkingLevel: options.thinkingLevel ?? "off",
      extensionRunner: {
        getCommand: () => undefined,
      },
      prompt: async (text: string) => {
        control.promptTexts.push(text);
        await control.runNext();
      },
      sendCustomMessage: async (
        message: Parameters<AgentSession["sendCustomMessage"]>[0],
        sendOptions: Parameters<AgentSession["sendCustomMessage"]>[1],
      ) => {
        if (control.skipNextCustomMessagePersistence) {
          control.skipNextCustomMessagePersistence = false;
          return;
        }
        const received = {
          customType: message.customType,
          content: String(message.content),
          display: message.display,
          details: message.details,
          triggerTurn: sendOptions?.triggerTurn === true,
        };
        control.received.push(received);
        control.manager.appendCustomMessageEntry(
          received.customType,
          received.content,
          received.display,
          received.details,
        );
        if (received.triggerTurn) await control.runNext();
      },
      abort: async () => {
        control.abortCalls++;
        control.abortCurrent?.();
      },
      clearQueue: () => undefined,
      dispose: () => {
        control.disposeCalls++;
      },
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        control.listener = listener;
        return () => {
          if (control.listener === listener) control.listener = undefined;
        };
      },
      setSessionName: (_name: string) => undefined,
    } as unknown as AgentSession;
  }

  enqueue(...behaviors: SessionBehavior[]): void {
    this.behaviors.push(...behaviors);
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

  emitTextDelta(delta: string): void {
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta,
      },
    } as unknown as AgentSessionEvent);
  }

  private async runNext(): Promise<void> {
    const behavior = this.behaviors.shift() ?? completesWith("ok");
    await behavior(this);
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
  readonly authStorage = {} as AuthStorage;
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
      modelRegistry: this.sessionModelRegistry ?? this.modelRegistry,
      activateExtensions: () =>
        this.activateSession?.(conversationId, options)
        ?? Promise.resolve(),
      activateExtensionErrors: (
        _handler: (error: ExtensionError) => void,
      ) => [],
      dynamicProviderNames: () => new Set(),
      dispose: async () => {
        control.session.dispose();
      },
    };
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
  const result = await executable.execute(
    toolCallId,
    input,
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
  const defaultRole = roles.getRoleTemplate("default");
  await roles.updateRole("default", defaultRole.revision, {
    name: defaultRole.name,
    description: defaultRole.description,
    systemPrompt: defaultRole.systemPrompt,
    model: defaultRole.model,
    defaultThinkingLevel: defaultRole.defaultThinkingLevel,
    toolMode: "full_access",
    canManageSessions: true,
  });
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

  it("singleflights and owns one project model catalog per context", async () => {
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

    const first = fixture.coordinator.ensureProjectModelCatalog(fixture.handle);
    await started.promise;
    const second = fixture.coordinator.ensureProjectModelCatalog(fixture.handle);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      catalogRegistry,
      catalogRegistry,
    ]);
    expect(fixture.runtime.projectCatalogCreations).toBe(1);
    expect(
      fixture.coordinator.modelRegistryForProject(fixture.handle),
    ).toBe(catalogRegistry);

    await fixture.coordinator.close();
    expect(fixture.runtime.projectCatalogDisposals).toBe(1);
  });

  it("prefers a live actor registry and falls back to the project catalog", async () => {
    const fixture = await createFixture();
    const catalogRegistry = {
      getAvailable: () => [{ provider: "project", id: "catalog" }],
    } as unknown as ModelRegistry;
    const actorRegistry = {
      getAvailable: () => [{ provider: "project", id: "actor" }],
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
      retainedId,
    ]);
    expect(actor.session.agent.state.messages).toEqual(
      actor.sessionManager.buildSessionContext().messages,
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
      toolMode: "read_only",
      canManageSessions: false,
    });

    const first = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: role.id, title: "First review" },
    );
    await fixture.roles.updateRole(role.id, role.revision, {
      name: "Senior reviewer",
      description: "Reviews concurrency",
      systemPrompt: "Review the second revision.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "high",
      toolMode: "full_access",
      canManageSessions: true,
    });
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
      "git_status",
      "git_diff",
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
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
      "git_status",
      "git_diff",
      "notebook_write",
      "notebook_list",
      "notebook_grep",
      "notebook_read",
      "list_roles",
      "list_sessions",
      "current_session",
      "peek_session",
      "start_session",
      "send_session_message",
      "wait_for_session",
      "abort_session",
      "delete_session",
    ]);
    expect(first.profile.role).not.toEqual(second.profile.role);
  });

  it("switches an idle conversation to a durable role snapshot and rebuilds its runtime", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Builder",
      description: "Builds the selected change",
      systemPrompt: "Implement the requested change.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "high",
      toolMode: "full_access",
      canManageSessions: true,
    });
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default", title: "Switch me" },
    );
    const previousRuntime = fixture.runtime.control(actor.conversationId);

    const switched = await fixture.coordinator.switchConversationRole(
      fixture.handle,
      actor.conversationId,
      role.id,
    );

    expect(switched).toBe(actor);
    expect(previousRuntime.disposeCalls).toBe(1);
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
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === actor.conversationId)?.role?.id,
    ).toBe(role.id);
  });

  it("rejects switching the role of a running conversation", async () => {
    const fixture = await createFixture();
    const role = await fixture.roles.createRole({
      name: "Builder",
      description: "",
      systemPrompt: "",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "off",
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
      toolMode: "full_access",
      canManageSessions: false,
    });
    const actor = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
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
    expect(
      aggregateReservedConversationEntries(
        actor.sessionManager.getEntries(),
      ).conversationMeta?.role.id,
    ).toBe("default");
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

  it("starts a peer without waiting and retries the same idempotency key without duplicate delivery", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
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

  it("returns a committed start_session even when a browser run wins the target immediately after inbox commit", async () => {
    const fixture = await createFixture();
    const source = await fixture.coordinator.createUserConversation(
      fixture.handle,
      { roleId: "default" },
    );
    const browserStarted = deferred();
    const releaseBrowser = deferred();
    fixture.runtime.nextSessionBehaviors.push([
      blocksUntil(browserStarted, releaseBrowser, "browser run complete"),
      completesWith("delegation handled after browser"),
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
        "browser work won the target first",
      );
      await browserStarted.promise;
      return committed;
    };

    let started;
    try {
      started = await fixture.coordinator.startPeerSession(
        fixture.handle,
        source.conversationId,
        startInput({
          task: "run after the browser without a false tool failure",
          idempotencyKey: "browser-wins-after-inbox-commit",
        }),
      );
    } finally {
      inbox.put = originalPut;
    }
    expect(started).toMatchObject({
      conversationId: expect.any(String),
      runId: expect.any(String),
    });
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === started.conversationId)?.activity,
    ).toEqual({ kind: "running", runId: browserRunId });

    releaseBrowser.resolve();
    await browserCompletion;
    await waitUntil(
      () =>
        fixture.runtime.control(started.conversationId).received.length === 1,
      "the committed delegation after the browser run",
    );
    expect(
      fixture.runtime.control(started.conversationId).received[0]?.content,
    ).toContain("run after the browser without a false tool failure");
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
    await fixture.roles.updateRole(role.id, role.revision, {
      name: "Rewritten worker",
      description: "A later role definition",
      systemPrompt: "Use the rewritten role prompt.",
      model: { provider: "test", id: "model-b" },
      defaultThinkingLevel: "off",
      toolMode: "full_access",
      canManageSessions: true,
    });
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

  it("captures the preview title when an unnamed conversation sends a message", async () => {
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
        title: "Investigate the rendering pipeline",
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
        title: "Investigate the rendering pipeline",
      },
    });
  });

  it("durably queues a message for a busy target without interrupting its current run", async () => {
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
    fixture.runtime.control(target.conversationId).enqueue(
      blocksUntil(busyStarted, releaseBusy, "busy run done"),
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
      activeRunId: string;
    };

    expect(sendResult).toMatchObject({
      status: "queued",
      activeRunId: busyRunId,
    });
    expect(fixture.runtime.control(target.conversationId).received).toEqual([]);
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
    await busyCompletion;
    await waitUntil(
      () => fixture.runtime.control(target.conversationId).received.length === 1,
      "the queued message to be delivered after the busy run",
    );
    expect(fixture.runtime.control(target.conversationId).received[0]).toMatchObject({
      content: expect.stringContaining("Handle this after the current task"),
      triggerTurn: true,
    });
    expect(
      fixture.runtime.control(target.conversationId).received[0]?.content,
    ).toContain("你负责管理自己创建的会话生命周期");
    expect(fixture.runtime.control(target.conversationId).abortCalls).toBe(0);
    expect(
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === target.conversationId)?.attention,
    ).toBe(false);
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
    let terminalAppendAttempted = false;
    manager.appendCustomEntry = (customType, data) => {
      if (
        !terminalAppendAttempted
        && customType === CONVERSATION_CARD_CUSTOM_TYPE
        && typeof data === "object"
        && data !== null
        && "state" in data
        && data.state === "completed"
      ) {
        terminalAppendAttempted = true;
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
        () => terminalAppendAttempted,
        "the simulated terminal sender-card append",
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
      control.emitFinal("caller resumed");
    });
    const callerCompletion = fixture.coordinator.prompt(
      fixture.handle,
      caller.conversationId,
      randomUUID(),
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

    await expect(callerCompletion).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(waited).toMatchObject({
      outcome: "message",
      conversationId: child.conversationId,
      runId: childRunId,
    });
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
      status: "queued",
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

  it("rejects a wait edge that would close a conversation cycle", async () => {
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
        conversationId: first.conversationId,
        runId: firstRunId,
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
    await expect(fixture.coordinator.prompt(
      fixture.handle,
      deletingTarget.conversationId,
      randomUUID(),
      "a prompt cannot cross a committed deletion fence",
    )).rejects.toThrow("being deleted");
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
        message: "queue behind the run before deletion can win",
      },
    ) as { status: string };
    expect(sentWhileBusy.status).toBe("queued");
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
      "the queued send after the prompt finishes",
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
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
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
        && pending.some(({ kind, body }) =>
          kind === "delegation_result" && body === "temporary success"
        );
    }, "temporary result commit followed by session deletion");

    const pending = await inbox.list({
      toConversationId: source.conversationId,
    });
    expect(pending).toContainEqual(expect.objectContaining({
      fromConversationId: started.conversationId,
      toConversationId: source.conversationId,
      kind: "delegation_result",
      body: "temporary success",
      state: "queued",
    }));
    expect(
      await readdir(fixture.handle.project.sessionDir),
    ).toHaveLength(1);

    releaseSource.resolve();
    await sourceCompletion;
  });

  it("does not let delayed initial temporary cleanup cancel a new active run", async () => {
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

    const secondRunStarted = deferred();
    const releaseSecondRun = deferred();
    fixture.runtime.control(temporary.conversationId).enqueue(
      blocksUntil(secondRunStarted, releaseSecondRun, "second run done"),
    );
    const secondRun = fixture.coordinator.prompt(
      fixture.handle,
      temporary.conversationId,
      randomUUID(),
      "new run before delayed temporary cleanup",
    );
    await secondRunStarted.promise;

    releaseDeletion.resolve();
    await blockingDeletion;
    await waitUntil(async () =>
      (await fixture.coordinator.listSessions(fixture.handle))
        .find(({ id }) => id === temporary.conversationId)
        ?.attention === true,
    "delayed cleanup rejected the busy temporary root");
    expect(fixture.runtime.control(temporary.conversationId).abortCalls)
      .toBe(0);

    releaseSecondRun.resolve();
    await secondRun;
    await waitUntil(async () =>
      !(await fixture.coordinator.listSessions(fixture.handle))
        .some(({ id }) => id === temporary.conversationId),
    "temporary cleanup after the second run settles");
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

  it("returns a temporary failure message and retains the failed session", async () => {
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
    const sourceCompletion = fixture.coordinator.prompt(
      fixture.handle,
      source.conversationId,
      randomUUID(),
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
      state: "queued",
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
      return failures.some(({ fromConversationId, body }) =>
        fromConversationId === aborted.conversationId
        && body.includes("aborted")
      ) && failures.some(({ fromConversationId, body }) =>
        fromConversationId === noReply.conversationId
        && body.includes("没有 Agent 回复")
      );
    }, "temporary abort and no-reply failure returns");
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

  it("fails messages queued behind a temporary run before deleting the target", async () => {
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
    "temporary deletion after terminalizing its pending inbox");

    const senderCard = aggregateReservedConversationEntries(
      sender.sessionManager.getEntries(),
    ).cards.find(({ body }) =>
      body === "arrived while temporary target was busy"
    );
    expect(senderCard).toMatchObject({
      state: "failed",
      result: "目标会话已删除，消息未被处理。",
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
    const seeded = roles.getRoleTemplate("default");
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

  it("treats a durable deletion tombstone as an immediate open and pump fence during restart", async () => {
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
    await store.createConversation(targetId, defaultProfile(roles));
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
    await store.createConversation(sourceId, defaultProfile(roles));
    const targetManager = await store.createConversation(
      targetId,
      defaultProfile(roles, {
        lifecycle: {
          kind: "temporary",
          callerConversationId: sourceId,
          delegationId: randomUUID(),
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
      const remainingIds = (await fixture.coordinator.listSessions(fixture.handle))
        .map(({ id }) => id);
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
    });

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
    });

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
    });

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
    });

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
      for (const [index, state] of legacyStates.entries()) {
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
            updatedAt: `2026-07-19T10:0${index + 1}:00.000Z`,
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
