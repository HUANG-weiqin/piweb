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
import { afterEach, describe, expect, it } from "vitest";
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
import { RoleCatalog } from "./role-catalog.js";
import type { RoleModelReference } from "./role-store.js";

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
      model: options.model === undefined
        ? { provider: "test", id: "model-a" }
        : { ...options.model },
      thinkingLevel: "off",
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
  readonly availableModels: RoleModelReference[] = [
    { provider: "test", id: "model-a" },
    { provider: "test", id: "model-b" },
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
    });
    expect(
      fixture.runtime.createOptions.get(first.conversationId)
        ?.workbenchCustomTools,
    ).toEqual([]);
    expect(second.profile.role).toMatchObject({
      revision: 2,
      name: "Senior reviewer",
      systemPrompt: "Review the second revision.",
      model: { provider: "test", id: "model-b" },
      canManageSessions: true,
    });
    expect(
      fixture.runtime.createOptions.get(second.conversationId)
        ?.workbenchCustomTools?.map(({ name }) => name),
    ).toEqual([
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
