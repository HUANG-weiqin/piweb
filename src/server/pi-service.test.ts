import { randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentMessage,
  AuthStorage,
  ExtensionError,
  ModelRegistry,
  PromptOptions,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PROJECT_CONVERSATIONS,
  type ConversationSummary,
  type ServerEvent,
} from "../shared/protocol.js";
import type {
  CreatedPiSession,
  CreatePiSessionOptions,
  PiRuntimeLike,
  ToolCallGate,
} from "./pi-runtime.js";
import { ProjectRunCoordinator } from "./project-run-coordinator.js";
import {
  MAX_PROJECT_SNAPSHOT_BYTES,
  PiConnection,
} from "./pi-service.js";
import {
  appendReservedCustomEntry,
  createConversationCardEntry,
} from "./conversation-meta.js";
import { ProjectStoreRegistry } from "./project-store.js";
import { ProjectSessionCoordinator } from "./project-session-coordinator.js";
import { RoleCatalog } from "./role-catalog.js";

const SESSION_A = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const SESSION_B = "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const SESSION_C = "b87435ff-2e88-41eb-8c09-694327af6270";
const RUN_A = "ba39f161-b67f-47c9-9285-e391427ed7d0";
const RUN_B = "65feacc3-00b4-45bd-80ee-5e18bc32f7dc";
const AUTH_A = "597eb8f8-2aa8-444a-ac04-681a3c483fac";
const AUTH_B = "2dfbf332-bc37-44f8-8af8-d497976a8a30";
const COMMAND_A = "b55e4225-e07f-4874-b760-015f7982d999";
const COMMAND_B = "8ee64aa3-c8a8-4e21-b521-66029ce3673b";

interface FakeSession extends AgentSession {
  abortCalls: number;
  disposed: boolean;
  eventListener?: (event: AgentSessionEvent) => void;
  toolCallGate?: ToolCallGate;
  persistentManager?: SessionManager;
}

type FakeCreatedSession = Pick<CreatedPiSession, "session" | "settings">;

function fakeSettings(): SettingsManager {
  return {
    flush: async () => undefined,
    drainErrors: () => [],
  } as unknown as SettingsManager;
}

function fakeSession(settings = fakeSettings()): FakeSession {
  const session = {
    abortCalls: 0,
    disposed: false,
    isStreaming: false,
    model: { provider: "test", id: "model", contextWindow: 1000 },
    messages: [],
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
    abort: async function () {
      this.abortCalls++;
      this.isStreaming = false;
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
  readonly authStorage = {
    getOAuthProviders: () => [],
    drainErrors: () => [],
  } as unknown as AuthStorage;

  readonly modelRegistry = {
    getAll: () => [],
    getAvailable: () => [],
    getError: () => undefined,
    getProviderDisplayName: (provider: string) => provider,
    getProviderAuthStatus: () => ({ configured: false }),
    hasConfiguredAuth: () => true,
  } as unknown as ModelRegistry;

  readonly createCalls: string[] = [];
  readonly created: FakeSession[] = [];
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

  async createProjectModelCatalog() {
    return {
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
      modelRegistry: this.sessionModelRegistry ?? this.modelRegistry,
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

function nativeEvent(event: unknown): AgentSessionEvent {
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
  login: (provider: string, callbacks: { signal: AbortSignal }) => Promise<void>,
): void {
  Object.assign(runtime.authStorage, {
    getOAuthProviders: () => [{ id: "oauth", name: "OAuth" }],
    login,
  });
}

async function coordinatedConnectionHarness() {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "piweb-coordinated-")),
  );
  const runtime = new FakeRuntime();
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
  const projectRuns = new ProjectRunCoordinator();
  const coordinator = new ProjectSessionCoordinator(
    runtime,
    roles,
    projects,
    projectRuns,
  );
  const events: ServerEvent[] = [];
  const connection = new PiConnection(
    (event) => events.push(event),
    runtime,
    undefined,
    projects,
    projectRuns,
    async () => ({ coordinator, roles }),
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

describe("PiConnection lifecycle", () => {
  it("serializes initialization and commits only the latest session bundle", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-b-"));
    const firstGate = deferred();
    const firstStarted = deferred();
    const runtime = new FakeRuntime();
    runtime.create = async (cwd) => {
      if (cwd === cwdA) {
        firstStarted.resolve();
        await firstGate.promise;
      }
      const settings = fakeSettings();
      const session = fakeSession(settings);
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);

    const first = connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    await firstStarted.promise;
    const second = connection.handle({ type: "initialize", sessionId: SESSION_B, cwd: cwdB });

    expect(runtime.createCalls).toEqual([cwdA]);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(runtime.createCalls).toEqual([cwdA, cwdB]);
    expect(runtime.created[0]?.disposed).toBe(true);
    const states = events.filter((event) => event.type === "state");
    expect(states).toHaveLength(1);
    expect(states.at(-1)?.state).toMatchObject({ sessionId: SESSION_B, cwd: cwdB });
  });

  it("treats initialize as a lifecycle transition and cancels the previous run", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-reinit-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-reinit-b-"));
    const promptStarted = deferred();
    const promptGate = deferred();
    const runtime = new FakeRuntime();
    const settingsA = fakeSettings();
    const sessionA = fakeSession(settingsA);
    const lifecycleOrder: string[] = [];
    const disposeA = sessionA.dispose.bind(sessionA);
    sessionA.dispose = () => {
      lifecycleOrder.push("dispose-a");
      disposeA();
    };
    sessionA.prompt = async () => {
      promptStarted.resolve();
      await promptGate.promise;
    };
    sessionA.abort = async () => {
      sessionA.abortCalls++;
      promptGate.resolve();
    };
    const settingsB = fakeSettings();
    const sessionB = fakeSession(settingsB);
    runtime.create = async (cwd) => {
      if (cwd === cwdB) lifecycleOrder.push("create-b");
      const created = cwd === cwdA
        ? { session: sessionA, settings: settingsA }
        : { session: sessionB, settings: settingsB };
      runtime.created.push(created.session);
      return created;
    };
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "work",
    });
    await promptStarted.promise;

    const initialize = connection.handle({ type: "initialize", sessionId: SESSION_B, cwd: cwdB });
    await Promise.all([prompt, initialize]);

    expect(sessionA.abortCalls).toBe(1);
    expect(sessionA.disposed).toBe(true);
    expect(lifecycleOrder).toEqual(["dispose-a", "create-b"]);
    expect(connection.sessionId).toBe(SESSION_B);
  });

  it("shuts down the old workspace before creating a replacement runtime", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-switch-failure-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-switch-failure-b-"));
    const runtime = new FakeRuntime();
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    const sessionA = runtime.created[0]!;
    runtime.create = async () => {
      expect(sessionA.disposed).toBe(true);
      throw new Error("replacement failed");
    };

    await expect(connection.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd: cwdB,
    })).rejects.toThrow("replacement failed");

    expect(sessionA.disposed).toBe(true);
    expect(connection.sessionId).toBeUndefined();
  });

  it("does not leave the old project hidden after a replacement cwd is invalid", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-invalid-switch-"));
    const projects = new ProjectStoreRegistry();
    const runtime = new FakeRuntime();
    const events: ServerEvent[] = [];
    const connection = new PiConnection(
      (event) => events.push(event),
      runtime,
      undefined,
      projects,
    );
    await connection.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const conversationId = latestState(events).conversationId;

    await expect(connection.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd: join(cwd, "missing"),
    })).rejects.toThrow();

    expect(runtime.created[0]?.disposed).toBe(true);
    expect(connection.sessionId).toBeUndefined();

    const reopened = new PiConnection(
      () => undefined,
      new FakeRuntime(),
      undefined,
      projects,
    );
    await expect(reopened.handle({
      type: "initialize",
      sessionId: SESSION_C,
      cwd,
      conversation: { kind: "open", conversationId },
    })).resolves.toBeUndefined();
    await Promise.all([connection.dispose(), reopened.dispose()]);
  });

  it("queues a prompt addressed to an initialization that has not committed yet", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-init-prompt-"));
    const createStarted = deferred();
    const createGate = deferred();
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    let promptCalls = 0;
    session.prompt = async () => {
      promptCalls++;
    };
    runtime.create = async () => {
      createStarted.resolve();
      await createGate.promise;
      runtime.created.push(session);
      return { session, settings };
    };
    const connection = new PiConnection(() => undefined, runtime);

    const initialize = connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });
    await createStarted.promise;
    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "pipelined",
    });
    createGate.resolve();
    await Promise.all([initialize, prompt]);

    expect(promptCalls).toBe(1);
  });

  it("publishes startup extension errors after committing session state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-startup-extension-error-"));
    const runtime = new FakeRuntime();
    runtime.startupExtensionErrors.push({
      extensionPath: "broken-extension.ts",
      event: "load",
      error: "module could not be loaded",
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);

    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    expect(events.map((event) => event.type)).toEqual([
      "state",
      "project_snapshot",
      "conversation_snapshot",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      scope: "session",
      sessionId: SESSION_A,
      message: expect.stringContaining("module could not be loaded"),
    });
  });

  it("round-trips extension UI during activation before committing public state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-extension-ui-activation-"));
    const runtime = new FakeRuntime();
    const interactionStarted = deferred();
    let confirmed: boolean | undefined;
    runtime.activate = async (options) => {
      if (!options.extensionUI) throw new Error("extension UI was not bound");
      const response = options.extensionUI.confirm("Trust helper", "Continue?");
      interactionStarted.resolve();
      confirmed = await response;
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);

    const initialization = connection.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
    });
    await interactionStarted.promise;

    const request = events.find(
      (event) => event.type === "extension_ui_request",
    );
    if (!request || request.type !== "extension_ui_request") {
      throw new Error("extension UI request was not emitted");
    }
    expect(events.some((event) => event.type === "state")).toBe(false);

    await connection.handle({
      type: "extension_ui_response",
      sessionId: SESSION_A,
      requestId: request.requestId,
      response: { kind: "confirm", confirmed: true },
    });
    await initialization;

    expect(confirmed).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "extension_ui_request",
      "extension_ui_closed",
      "state",
      "project_snapshot",
      "conversation_snapshot",
    ]);
    await connection.dispose();
  });

  it("closes a run-owned extension dialog when the run is aborted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-extension-ui-abort-"));
    const runtime = new FakeRuntime();
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });
    const promptStarted = deferred();
    let confirmed: boolean | undefined;
    runtime.created[0]!.prompt = async () => {
      const ui = runtime.lastCreateOptions?.extensionUI;
      if (!ui) throw new Error("extension UI was not bound");
      const response = ui.confirm("Blocking hook", "Continue?");
      promptStarted.resolve();
      confirmed = await response;
    };

    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "work",
    });
    await promptStarted.promise;
    await connection.handle({
      type: "abort",
      sessionId: SESSION_A,
      runId: RUN_A,
    });
    await prompt;

    expect(confirmed).toBe(false);
    expect(events.some((event) => event.type === "extension_ui_closed")).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_event",
      sessionId: SESSION_A,
      runId: RUN_A,
      conversationId: latestState(events).conversationId,
      focusId: latestState(events).focusId,
      event: { type: "run_finished", outcome: "aborted" },
    }));
    await connection.dispose();
  });

  it("rejects extension slash commands before they can escape run ownership", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-extension-command-"));
    const runtime = new FakeRuntime();
    let promptCalls = 0;
    runtime.create = async () => {
      const settings = fakeSettings();
      const session = fakeSession(settings);
      session.prompt = async () => {
        promptCalls++;
      };
      Object.assign(session.extensionRunner, {
        getCommand: (name: string) => name === "detached"
          ? { invocationName: "detached" }
          : undefined,
      });
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "/detached",
    })).rejects.toThrow("Extension slash commands are not supported");

    expect(promptCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: "session_event",
      sessionId: SESSION_A,
      runId: RUN_A,
      conversationId: latestState(events).conversationId,
      focusId: latestState(events).focusId,
      event: { type: "run_finished", outcome: "failed" },
    }));
    await connection.dispose();
  });

  it("disposes a session that finishes creating after close_session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-close-"));
    const createGate = deferred();
    const createStarted = deferred();
    const runtime = new FakeRuntime();
    runtime.create = async () => {
      createStarted.resolve();
      await createGate.promise;
      const settings = fakeSettings();
      const session = fakeSession(settings);
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);

    const initialize = connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });
    await createStarted.promise;
    const close = connection.handle({ type: "close_session", sessionId: SESSION_A });
    createGate.resolve();
    await Promise.all([initialize, close]);

    expect(runtime.created[0]?.disposed).toBe(true);
    expect(events.some((event) => event.type === "state")).toBe(false);
    expect(connection.sessionId).toBeUndefined();
  });

  it("lets abort interrupt a running prompt instead of waiting in the queue", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-abort-"));
    const promptGate = deferred();
    const promptStarted = deferred();
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      session.isStreaming = true;
      promptStarted.resolve();
      await promptGate.promise;
    };
    session.abort = async () => {
      session.abortCalls++;
      session.isStreaming = false;
      promptGate.resolve();
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "hello",
    });
    await promptStarted.promise;
    await connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_B });
    await connection.handle({ type: "abort", sessionId: SESSION_B, runId: RUN_A });
    expect(session.abortCalls).toBe(0);

    await Promise.all([
      connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_A }),
      connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_A }),
    ]);
    await prompt;

    expect(session.abortCalls).toBe(1);
  });

  it("prevents an aborted prompt from starting the agent after async preflight", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-preflight-abort-"));
    const preflightStarted = deferred();
    const preflightGate = deferred();
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    let agentStarts = 0;
    session.prompt = async (_text: string, options?: PromptOptions) => {
      preflightStarted.resolve();
      await preflightGate.promise;
      options?.preflightResult?.(true);
      agentStarts++;
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "do not start",
    });
    await preflightStarted.promise;
    await connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_A });
    preflightGate.resolve();
    await prompt;

    expect(session.abortCalls).toBe(1);
    expect(agentStarts).toBe(0);
    expect(events.filter((event) => (
      event.type === "session_event" && event.event.type === "run_finished"
    ))).toEqual([
      expect.objectContaining({
        runId: RUN_A,
        event: { type: "run_finished", outcome: "aborted" },
      }),
    ]);
  });

  it("cancels a queued prompt without aborting the idle SDK session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-queued-"));
    const refreshGate = deferred();
    const refreshStarted = deferred();
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    const prompts: string[] = [];
    session.prompt = async (text) => {
      prompts.push(String(text));
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const refresh = connection.handle({ type: "refresh_models" });
    await refreshStarted.promise;
    const first = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "first",
    });
    await connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_A });
    const second = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_B,
      text: "second",
    });
    refreshGate.resolve();
    await Promise.all([refresh, first, second]);

    expect(prompts).toEqual(["second"]);
    expect(session.abortCalls).toBe(0);
    const terminals = events.filter((event) => (
      event.type === "session_event" && event.event.type === "run_finished"
    ));
    expect(terminals).toEqual([
      expect.objectContaining({ runId: RUN_A, event: { type: "run_finished", outcome: "aborted" } }),
      expect.objectContaining({ runId: RUN_B, event: { type: "run_finished", outcome: "completed" } }),
    ]);
  });

  it("ignores commands addressed to an old session after a new session is active", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-stale-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-stale-b-"));
    const runtime = new FakeRuntime();
    const connection = new PiConnection(() => undefined, runtime);

    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    const oldSession = runtime.created[0]!;
    await connection.handle({ type: "initialize", sessionId: SESSION_B, cwd: cwdB });
    const currentSession = runtime.created[1]!;
    let currentPromptCalls = 0;
    currentSession.prompt = async () => {
      currentPromptCalls++;
    };

    await connection.handle({ type: "close_session", sessionId: SESSION_A });
    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "stale",
    });
    await connection.handle({ type: "abort", sessionId: SESSION_A, runId: RUN_A });

    expect(connection.sessionId).toBe(SESSION_B);
    expect(currentSession.disposed).toBe(false);
    expect(currentPromptCalls).toBe(0);
    expect(oldSession.disposed).toBe(true);
  });

  it("routes one run's SDK events through its runId and synthesizes one terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-run-events-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      session.eventListener?.(nativeEvent({ type: "agent_start" }));
      session.eventListener?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { totalTokens: 3 },
        },
      }));
      session.eventListener?.(nativeEvent({ type: "agent_settled" }));
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "hello",
    });

    const runEvents = events.filter((event) => (
      event.type === "session_event" && event.runId === RUN_A
    ));
    expect(runEvents.map((event) => event.type === "session_event" ? event.event.type : "")).toEqual([
      "run_queued",
      "run_started",
      "text_replaced",
      "usage",
      "run_finished",
    ]);
    expect(runEvents.at(-1)).toMatchObject({
      event: { type: "run_finished", outcome: "completed" },
    });
  });

  it("maps a resolved SDK error message to a failed workbench run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-sdk-error-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      session.eventListener?.(nativeEvent({ type: "agent_start" }));
      session.eventListener?.(nativeEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider unavailable",
          usage: { totalTokens: 0 },
        },
      }));
      session.eventListener?.(nativeEvent({ type: "agent_settled" }));
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "fail",
    })).rejects.toThrow("provider unavailable");
    expect(events.filter((event) => (
      event.type === "session_event"
      && event.runId === RUN_A
      && event.event.type === "run_finished"
    ))).toEqual([
      expect.objectContaining({ event: { type: "run_finished", outcome: "failed" } }),
    ]);
  });

  it("fails the active run when a bound extension reports a handler error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-extension-error-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      runtime.emitExtensionError({
        extensionPath: "project-extension.ts",
        event: "command:boom",
        error: "extension exploded",
      });
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "/boom",
    })).rejects.toThrow("Extension error in command:boom");

    expect(events.filter((event) => (
      event.type === "session_event" && event.event.type === "run_finished"
    ))).toEqual([
      expect.objectContaining({
        runId: RUN_A,
        event: { type: "run_finished", outcome: "failed" },
      }),
    ]);
  });

  it("rejects reused session and run IDs instead of allowing ABA identity", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-aba-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-aba-b-"));
    const runtime = new FakeRuntime();
    const connection = new PiConnection(() => undefined, runtime);

    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    await expect(connection.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd: cwdB,
    })).rejects.toThrow("already used");

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "first",
    });
    await expect(connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "duplicate",
    })).rejects.toThrow("already used");

    expect(runtime.createCalls).toEqual([cwdA]);
    expect(connection.sessionId).toBe(SESSION_A);
  });

  it("returns to idle and emits one failed terminal when prompt throws", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-prompt-error-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      throw new Error("prompt failed");
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "fail",
    })).rejects.toThrow("prompt failed");

    const terminals = events.filter((event) => (
      event.type === "session_event"
      && event.runId === RUN_A
      && event.event.type === "run_finished"
    ));
    expect(terminals).toEqual([
      expect.objectContaining({ event: { type: "run_finished", outcome: "failed" } }),
    ]);
    expect(events.filter((event) => event.type === "state").at(-1)).toMatchObject({
      state: { busy: false, activeRun: undefined },
    });
  });

  it("drains a native auth error on the operation that produced it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-api-key-error-"));
    const runtime = new FakeRuntime();
    const nativeErrors: Error[] = [];
    Object.assign(runtime.modelRegistry, {
      getAll: () => [{ provider: "provider" }],
    });
    Object.assign(runtime.authStorage, {
      set: () => {
        const error = new Error("credential write failed");
        nativeErrors.push(error);
        throw error;
      },
      drainErrors: () => nativeErrors.splice(0),
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "set_api_key",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      provider: "provider",
      key: "secret",
    })).rejects.toThrow("credential write failed");
    await connection.handle({ type: "refresh_models" });

    expect(events.filter((event) => event.type === "error" && event.scope === "auth")).toEqual([
      expect.objectContaining({ message: "credential write failed" }),
    ]);
    expect(events.some((event) => event.type === "command_complete")).toBe(false);
  });

  it("acknowledges an API Key command only after it completes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-api-key-complete-"));
    const runtime = new FakeRuntime();
    Object.assign(runtime.modelRegistry, {
      getAll: () => [{ provider: "provider" }],
    });
    Object.assign(runtime.authStorage, {
      set: () => undefined,
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "set_api_key",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      provider: "provider",
      key: "secret",
    });

    expect(events).toContainEqual({
      type: "command_complete",
      operation: "set_api_key",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
    });
  });

  it("does not apply API Key commands from stale or unknown sessions", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-api-key-session-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-api-key-session-b-"));
    const runtime = new FakeRuntime();
    const credentials: unknown[] = [];
    Object.assign(runtime.modelRegistry, {
      getAll: () => [{ provider: "provider" }],
    });
    Object.assign(runtime.authStorage, {
      set: (_provider: string, credential: unknown) => credentials.push(credential),
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    await connection.handle({ type: "initialize", sessionId: SESSION_B, cwd: cwdB });

    await connection.handle({
      type: "set_api_key",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      provider: "provider",
      key: "from-stale-session",
    });
    await connection.handle({
      type: "set_api_key",
      commandId: COMMAND_B,
      sessionId: SESSION_C,
      provider: "provider",
      key: "from-unknown-session",
    });

    expect(credentials).toEqual([]);
    expect(events.some((event) => event.type === "command_complete")).toBe(false);
    await connection.dispose();
  });

  it("acknowledges a model selection only after the matching session is updated", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-select-model-"));
    const runtime = new FakeRuntime();
    const model = {
      provider: "provider",
      id: "model-2",
      name: "Model 2",
      contextWindow: 4_096,
    };
    Object.assign(runtime.modelRegistry, {
      getAll: () => [model],
      getAvailable: () => [model],
      find: (provider: string, modelId: string) => (
        provider === model.provider && modelId === model.id ? model : undefined
      ),
    });
    let selectedModel: unknown;
    runtime.create = async () => {
      const settings = fakeSettings();
      const session = fakeSession(settings);
      session.setModel = async (selected) => {
        selectedModel = selected;
      };
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "select_model",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      provider: model.provider,
      modelId: model.id,
    });

    expect(events.at(-1)).toEqual({
      type: "command_complete",
      operation: "select_model",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
    });
    expect(selectedModel).toBe(model);
  });

  it("reports a partially persisted model switch as applied to the active session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-select-model-partial-"));
    const runtime = new FakeRuntime();
    const model = {
      provider: "provider",
      id: "model-2",
      name: "Model 2",
      contextWindow: 4_096,
    };
    Object.assign(runtime.modelRegistry, {
      getAll: () => [model],
      getAvailable: () => [model],
      find: () => model,
    });
    runtime.create = async () => {
      const settings = fakeSettings();
      const session = fakeSession(settings);
      session.setModel = async (selected) => {
        Object.assign(session, { model: selected });
        throw new Error("session model entry could not be written");
      };
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "select_model",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
      provider: model.provider,
      modelId: model.id,
    })).resolves.toBeUndefined();

    expect(events).toContainEqual({
      type: "command_complete",
      operation: "select_model",
      commandId: COMMAND_A,
      sessionId: SESSION_A,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      scope: "settings",
      sessionId: SESSION_A,
      message: expect.stringContaining("模型已用于当前会话"),
    }));
  });

  it("rejects a reused setting command ID without applying it twice", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-api-key-command-id-"));
    const runtime = new FakeRuntime();
    const credentials: unknown[] = [];
    Object.assign(runtime.modelRegistry, {
      getAll: () => [{ provider: "provider" }],
    });
    Object.assign(runtime.authStorage, {
      set: (_provider: string, credential: unknown) => credentials.push(credential),
    });
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "set_api_key",
      commandId: COMMAND_B,
      sessionId: SESSION_A,
      provider: "provider",
      key: "first",
    });
    await expect(connection.handle({
      type: "set_api_key",
      commandId: COMMAND_B,
      sessionId: SESSION_A,
      provider: "provider",
      key: "second",
    })).rejects.toThrow("already used");

    expect(credentials).toEqual([{ type: "api_key", key: "first" }]);
  });

  it("keeps an applied thinking level when its default setting cannot be flushed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-settings-error-"));
    const runtime = new FakeRuntime();
    const settingsErrors: Array<{ error: Error }> = [];
    const settings = {
      flush: async () => {
        const item = { error: new Error("settings write failed") };
        settingsErrors.push(item);
        throw item.error;
      },
      drainErrors: () => settingsErrors.splice(0),
    } as unknown as SettingsManager;
    const session = fakeSession(settings);
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await expect(connection.handle({
      type: "set_thinking",
      sessionId: SESSION_A,
      level: "high",
    })).resolves.toBeUndefined();

    expect(events.at(-1)).toMatchObject({
      type: "error",
      scope: "settings",
      sessionId: SESSION_A,
      message: "settings write failed",
    });

    await connection.handle({ type: "refresh_models" });

    expect(latestState(events).thinkingLevel).toBe("high");
    expect(events.filter((event) => event.type === "error" && event.scope === "settings")).toEqual([
      expect.objectContaining({ sessionId: SESSION_A, message: "settings write failed" }),
    ]);
  });

  it("keeps an in-memory conversation name when its session entry cannot be persisted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-rename-partial-"));
    const runtime = new FakeRuntime();
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const initial = latestState(events);
    const manager = runtime.created[0]?.persistentManager;
    if (!manager) throw new Error("persistent SessionManager was not provided");
    Object.assign(manager, {
      _persist: () => {
        throw new Error("session name entry could not be written");
      },
    });

    await expect(connection.handle({
      type: "rename_conversation",
      sessionId: SESSION_A,
      conversationId: initial.conversationId,
      name: "Renamed in memory",
    })).resolves.toBeUndefined();

    expect(latestState(events).conversationName).toBe("Renamed in memory");
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      scope: "settings",
      sessionId: SESSION_A,
      message: expect.stringContaining("对话名称已用于当前会话"),
    }));
  });

  it("cancels an active OAuth flow so a new session is not blocked", async () => {
    const cwdA = await mkdtemp(join(tmpdir(), "piweb-oauth-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "piweb-oauth-b-"));
    const loginStarted = deferred();
    const runtime = new FakeRuntime();
    configureOAuth(runtime, async (_provider, callbacks) => {
      loginStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => reject(new Error("Authentication cancelled"));
        if (callbacks.signal.aborted) cancel();
        else callbacks.signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd: cwdA });
    expect(events.find((event) => event.type === "state")?.state.providers).toEqual([
      expect.objectContaining({ id: "oauth", oauth: true, models: [] }),
    ]);

    const login = connection.handle({ type: "login_oauth", authFlowId: AUTH_A, provider: "oauth" });
    await loginStarted.promise;
    const close = connection.handle({ type: "close_session", sessionId: SESSION_A });
    const initialize = connection.handle({ type: "initialize", sessionId: SESSION_B, cwd: cwdB });
    await Promise.all([login, close, initialize]);

    expect(connection.sessionId).toBe(SESSION_B);
    expect(events.some((event) => event.type === "auth_complete")).toBe(false);
  });

  it("cancels an OAuth flow before its queued operation starts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-oauth-cancel-queued-"));
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const runtime = new FakeRuntime();
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => {
      loginCalls++;
    });
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const refresh = connection.handle({ type: "refresh_models" });
    await refreshStarted.promise;
    const login = connection.handle({
      type: "login_oauth",
      authFlowId: AUTH_B,
      provider: "oauth",
    });
    await connection.handle({ type: "cancel_auth", authFlowId: AUTH_B });
    refreshGate.resolve();
    await Promise.all([refresh, login]);

    expect(loginCalls).toBe(0);
  });

  it("lets a newer OAuth flow supersede one that is still queued", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-oauth-supersede-"));
    const refreshStarted = deferred();
    const refreshGate = deferred();
    const runtime = new FakeRuntime();
    runtime.refresh = async () => {
      refreshStarted.resolve();
      await refreshGate.promise;
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => {
      loginCalls++;
    });
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const refresh = connection.handle({ type: "refresh_models" });
    await refreshStarted.promise;
    const first = connection.handle({
      type: "login_oauth",
      authFlowId: AUTH_A,
      provider: "oauth",
    });
    const second = connection.handle({
      type: "login_oauth",
      authFlowId: AUTH_B,
      provider: "oauth",
    });
    refreshGate.resolve();
    await Promise.all([refresh, first, second]);

    expect(loginCalls).toBe(1);
    expect(events.filter((event) => event.type === "auth_complete")).toEqual([
      expect.objectContaining({ authFlowId: AUTH_B }),
    ]);
  });

  it("drops an OAuth flow that was queued before close_session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-oauth-queued-"));
    const promptStarted = deferred();
    const promptGate = deferred();
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    session.prompt = async () => {
      session.isStreaming = true;
      promptStarted.resolve();
      await promptGate.promise;
    };
    session.abort = async () => {
      session.isStreaming = false;
      promptGate.resolve();
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    let loginCalls = 0;
    configureOAuth(runtime, async () => {
      loginCalls++;
    });
    const connection = new PiConnection(() => undefined, runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    const prompt = connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "first",
    });
    await promptStarted.promise;
    const login = connection.handle({ type: "login_oauth", authFlowId: AUTH_A, provider: "oauth" });
    const close = connection.handle({ type: "close_session", sessionId: SESSION_A });
    await Promise.all([prompt, login, close]);

    expect(loginCalls).toBe(0);
  });

  it("runs commands directly in full access and blocks them in read-only mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-mode-command-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    const decisions: Array<{ block?: boolean; reason?: string } | undefined> = [];
    session.prompt = async () => {
      decisions.push(await session.toolCallGate?.({
        toolCallId: `tool-bash-${decisions.length}`,
        toolName: "bash",
        toolSource: "builtin",
        args: { command: "npm test" },
        signal: new AbortController().signal,
      }));
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "run a command",
    });
    await connection.handle({
      type: "set_tool_mode",
      sessionId: SESSION_A,
      mode: "read_only",
    });
    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_B,
      text: "try the command again",
    });

    expect(decisions[0]).toBeUndefined();
    expect(decisions[1]).toMatchObject({
      block: true,
      reason: expect.stringContaining("Pi 原生"),
    });
  });

  it("emits exact detached arguments when a tool call is prepared", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-prepared-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    const args = {
      command: "npm test",
      nested: { flags: ["--run", "--reporter=verbose"] },
    };
    session.prompt = async () => {
      await session.toolCallGate?.({
        toolCallId: "tool-prepared",
        toolName: "bash",
        toolSource: "builtin",
        args,
        signal: new AbortController().signal,
      });
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection(
      (event) => events.push(event),
      runtime,
      () => ({ action: "deny", reason: "test complete" }),
    );
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "prepare a command",
    });

    const prepared = events.find((event) => (
      event.type === "session_event"
      && event.runId === RUN_A
      && event.event.type === "tool_prepared"
    ));
    if (
      !prepared
      || prepared.type !== "session_event"
      || prepared.event.type !== "tool_prepared"
    ) {
      throw new Error("tool_prepared event not emitted");
    }
    args.command = "changed after projection";

    expect(prepared.event).toEqual({
      type: "tool_prepared",
      toolCallId: "tool-prepared",
      args: {
        command: "npm test",
        nested: { flags: ["--run", "--reporter=verbose"] },
      },
    });
  });

  it("does not block full access when arguments are too large for the wire preview", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-preview-oversized-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    const args = {
      command: "x".repeat(200_001),
    };
    let gateDecision: Awaited<ReturnType<ToolCallGate>>;
    let executions = 0;
    session.prompt = async () => {
      gateDecision = await session.toolCallGate?.({
        toolCallId: "tool-oversized",
        toolName: "bash",
        toolSource: "builtin",
        args,
        signal: new AbortController().signal,
      });
      if (!gateDecision?.block) executions++;
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "run an oversized command",
    });

    expect(events.find((event) => (
      event.type === "session_event"
      && event.event.type === "tool_prepared"
    ))).toMatchObject({
      event: {
        type: "tool_prepared",
        toolCallId: "tool-oversized",
      },
    });
    expect(gateDecision).toBeUndefined();
    expect(executions).toBe(1);
  });

  it("allows writes in full access and blocks them after switching to read-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-mode-"));
    const runtime = new FakeRuntime();
    const settings = fakeSettings();
    const session = fakeSession(settings);
    const decisions: Array<{ block?: boolean; reason?: string } | undefined> = [];
    session.prompt = async () => {
      decisions.push(await session.toolCallGate?.({
        toolCallId: `tool-${decisions.length}`,
        toolName: "write",
        toolSource: "builtin",
        args: { path: "src/generated.ts", content: "content" },
        signal: new AbortController().signal,
      }));
    };
    runtime.create = async () => {
      runtime.created.push(session);
      return { session, settings };
    };
    const events: ServerEvent[] = [];
    const connection = new PiConnection((event) => events.push(event), runtime);
    await connection.handle({ type: "initialize", sessionId: SESSION_A, cwd });
    expect(latestState(events).toolMode).toBe("full_access");

    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "write inside",
    });
    await connection.handle({
      type: "set_tool_mode",
      sessionId: SESSION_A,
      mode: "read_only",
    });
    await connection.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_B,
      text: "try writing again",
    });

    expect(decisions[0]).toBeUndefined();
    expect(decisions[1]).toMatchObject({
      block: true,
      reason: expect.stringContaining("只读模式"),
    });
    expect(latestState(events).toolMode).toBe("read_only");
  });

  it("cancels project runs before acknowledging read-only on another connection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-mode-shared-"));
    const projects = new ProjectStoreRegistry();
    const projectRuns = new ProjectRunCoordinator();
    const firstRuntime = new FakeRuntime();
    const firstSession = fakeSession();
    const promptStarted = deferred();
    const abortCalled = deferred();
    const finishPrompt = deferred();
    firstSession.prompt = async () => {
      firstSession.isStreaming = true;
      promptStarted.resolve();
      await finishPrompt.promise;
      firstSession.isStreaming = false;
    };
    firstSession.abort = async () => {
      firstSession.abortCalls++;
      firstSession.isStreaming = false;
      abortCalled.resolve();
    };
    firstRuntime.create = async () => {
      firstRuntime.created.push(firstSession);
      return { session: firstSession, settings: firstSession.settingsManager };
    };
    const firstEvents: ServerEvent[] = [];
    const first = new PiConnection(
      (event) => firstEvents.push(event),
      firstRuntime,
      undefined,
      projects,
      projectRuns,
    );
    const secondEvents: ServerEvent[] = [];
    const second = new PiConnection(
      (event) => secondEvents.push(event),
      new FakeRuntime(),
      undefined,
      projects,
      projectRuns,
    );
    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    await second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "new" },
    });

    const prompt = first.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "run a command",
    });
    await promptStarted.promise;

    let modeSettled = false;
    const modeChange = second.handle({
      type: "set_tool_mode",
      sessionId: SESSION_B,
      mode: "read_only",
    }).then(() => {
      modeSettled = true;
    });
    await abortCalled.promise;

    expect(firstSession.abortCalls).toBe(1);
    expect(modeSettled).toBe(false);
    expect(latestState(firstEvents).toolMode).toBe("full_access");

    finishPrompt.resolve();
    await Promise.all([prompt, modeChange]);

    expect(latestState(firstEvents).toolMode).toBe("read_only");
    expect(latestState(secondEvents).toolMode).toBe("read_only");
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("does not expand the permission snapshot of an already running turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-tool-mode-snapshot-"));
    const projects = new ProjectStoreRegistry();
    const projectRuns = new ProjectRunCoordinator();
    const firstRuntime = new FakeRuntime();
    const firstSession = fakeSession();
    const promptStarted = deferred();
    const runTool = deferred();
    let gateDecision: Awaited<ReturnType<ToolCallGate>>;
    firstSession.prompt = async () => {
      promptStarted.resolve();
      await runTool.promise;
      gateDecision = await firstSession.toolCallGate?.({
        toolCallId: "tool-snapshot-bash",
        toolName: "bash",
        toolSource: "builtin",
        args: { command: "npm test" },
        signal: new AbortController().signal,
      });
    };
    firstRuntime.create = async () => {
      firstRuntime.created.push(firstSession);
      return { session: firstSession, settings: firstSession.settingsManager };
    };
    const first = new PiConnection(
      () => undefined,
      firstRuntime,
      undefined,
      projects,
      projectRuns,
    );
    const second = new PiConnection(
      () => undefined,
      new FakeRuntime(),
      undefined,
      projects,
      projectRuns,
    );
    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      toolMode: "read_only",
      conversation: { kind: "new" },
    });
    await second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "new" },
    });

    const prompt = first.handle({
      type: "prompt",
      sessionId: SESSION_A,
      runId: RUN_A,
      text: "run later",
    });
    await promptStarted.promise;
    await second.handle({
      type: "set_tool_mode",
      sessionId: SESSION_B,
      mode: "full_access",
    });
    runTool.resolve();
    await prompt;

    expect(gateDecision).toMatchObject({
      block: true,
      reason: expect.stringContaining("Pi 原生"),
    });
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("restores project-local history, name, and tool mode on a fresh connection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-persistent-session-"));
    const projects = new ProjectStoreRegistry();
    const firstRuntime = new FakeRuntime();
    const firstEvents: ServerEvent[] = [];
    const first = new PiConnection(
      (event) => firstEvents.push(event),
      firstRuntime,
      undefined,
      projects,
    );

    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const firstState = latestState(firstEvents);
    const manager = firstRuntime.created[0]?.persistentManager;
    if (!manager) throw new Error("persistent SessionManager was not provided");
    manager.appendMessage(agentMessage({
      role: "user",
      content: "remember this project",
      timestamp: 1,
    }));
    manager.appendMessage(agentMessage({
      role: "assistant",
      content: [{ type: "text", text: "remembered" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    }));
    await first.handle({
      type: "rename_conversation",
      sessionId: SESSION_A,
      conversationId: firstState.conversationId,
      name: "Persistent work",
    });
    await first.handle({
      type: "set_tool_mode",
      sessionId: SESSION_A,
      mode: "read_only",
    });
    await first.handle({ type: "close_session", sessionId: SESSION_A });

    const secondRuntime = new FakeRuntime();
    const secondEvents: ServerEvent[] = [];
    const second = new PiConnection(
      (event) => secondEvents.push(event),
      secondRuntime,
      undefined,
      projects,
    );
    await second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      toolMode: "full_access",
      conversation: { kind: "recent" },
    });

    expect(latestState(secondEvents)).toMatchObject({
      projectId: firstState.projectId,
      conversationId: firstState.conversationId,
      conversationName: "Persistent work",
      toolMode: "read_only",
    });
    expect(secondEvents.find((event) => (
      event.type === "project_snapshot"
    ))).toMatchObject({
      type: "project_snapshot",
      projectId: firstState.projectId,
      conversationId: firstState.conversationId,
      conversations: [
        expect.objectContaining({
          id: firstState.conversationId,
          name: "Persistent work",
          preview: "remember this project",
        }),
      ],
      truncated: false,
    });
    expect(secondEvents.find((event) => (
      event.type === "conversation_snapshot"
    ))).toMatchObject({
      type: "conversation_snapshot",
      sessionId: SESSION_B,
      conversationId: firstState.conversationId,
      messages: [
        expect.objectContaining({ role: "user", text: "remember this project" }),
        expect.objectContaining({ role: "assistant", text: "remembered" }),
      ],
    });
    await second.dispose();
  });

  it("deletes an inactive conversation but refuses to delete the active writer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-delete-session-"));
    const projects = new ProjectStoreRegistry();
    const events: ServerEvent[] = [];
    const connection = new PiConnection(
      (event) => events.push(event),
      new FakeRuntime(),
      undefined,
      projects,
    );

    await connection.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const firstConversationId = latestState(events).conversationId;
    await connection.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "new" },
    });
    const activeConversationId = latestState(events).conversationId;

    await connection.handle({
      type: "delete_conversation",
      commandId: COMMAND_A,
      sessionId: SESSION_B,
      conversationId: firstConversationId,
    });

    expect(events).toContainEqual({
      type: "command_complete",
      operation: "delete_conversation",
      commandId: COMMAND_A,
      sessionId: SESSION_B,
    });
    const project = await projects.acquireProject(cwd, "full_access");
    expect(project.store.listConversations().map(({ id }) => id)).toEqual([
      activeConversationId,
    ]);
    await expect(
      project.store.openConversation(firstConversationId),
    ).rejects.toThrow("Conversation not found");
    project.release();

    await expect(connection.handle({
      type: "delete_conversation",
      commandId: COMMAND_B,
      sessionId: SESSION_B,
      conversationId: activeConversationId,
    })).rejects.toThrow("active");

    expect(latestState(events).conversationId).toBe(activeConversationId);
    await connection.dispose();
  });

  it("refuses to delete a conversation leased by another connection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-delete-leased-session-"));
    const projects = new ProjectStoreRegistry();
    const firstEvents: ServerEvent[] = [];
    const first = new PiConnection(
      (event) => firstEvents.push(event),
      new FakeRuntime(),
      undefined,
      projects,
    );
    const second = new PiConnection(
      () => undefined,
      new FakeRuntime(),
      undefined,
      projects,
    );

    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const leasedConversationId = latestState(firstEvents).conversationId;
    await second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "new" },
    });

    await expect(second.handle({
      type: "delete_conversation",
      commandId: COMMAND_A,
      sessionId: SESSION_B,
      conversationId: leasedConversationId,
    })).rejects.toThrow("already leased");

    await first.handle({ type: "close_session", sessionId: SESSION_A });
    await expect(second.handle({
      type: "delete_conversation",
      commandId: COMMAND_B,
      sessionId: SESSION_B,
      conversationId: leasedConversationId,
    })).resolves.toBeUndefined();
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("waits for the old conversation owner during reconnect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-conversation-lease-"));
    const projects = new ProjectStoreRegistry();
    const firstEvents: ServerEvent[] = [];
    const first = new PiConnection(
      (event) => firstEvents.push(event),
      new FakeRuntime(),
      undefined,
      projects,
    );
    const secondRuntime = new FakeRuntime();
    const second = new PiConnection(
      () => undefined,
      secondRuntime,
      undefined,
      projects,
    );

    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const conversationId = latestState(firstEvents).conversationId;
    let reconnected = false;
    const reconnect = second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "open", conversationId },
    }).then(() => {
      reconnected = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));

    expect(reconnected).toBe(false);
    expect(secondRuntime.createCalls).toHaveLength(0);

    await first.handle({ type: "close_session", sessionId: SESSION_A });
    await reconnect;

    expect(reconnected).toBe(true);
    expect(secondRuntime.createCalls).toEqual([await realpath(cwd)]);
    await second.dispose();
  });

  it("cancels a pending reconnect lease wait when its connection closes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "piweb-conversation-wait-close-"));
    const projects = new ProjectStoreRegistry();
    const firstEvents: ServerEvent[] = [];
    const first = new PiConnection(
      (event) => firstEvents.push(event),
      new FakeRuntime(),
      undefined,
      projects,
    );
    const secondRuntime = new FakeRuntime();
    const second = new PiConnection(
      () => undefined,
      secondRuntime,
      undefined,
      projects,
    );
    await first.handle({
      type: "initialize",
      sessionId: SESSION_A,
      cwd,
      conversation: { kind: "new" },
    });
    const conversationId = latestState(firstEvents).conversationId;

    const waiting = second.handle({
      type: "initialize",
      sessionId: SESSION_B,
      cwd,
      conversation: { kind: "open", conversationId },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    await expect(second.dispose()).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeUndefined();

    expect(secondRuntime.createCalls).toHaveLength(0);
    await first.dispose();
  });
});

describe("PiConnection coordinated project view", () => {
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
      expect(harness.events).toContainEqual({
        type: "focus_attached",
        operation: "initialize",
        commandId,
        sessionId: SESSION_A,
        projectId: latestState(harness.events).projectId,
      });
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
      getAvailable: () => projectModels,
      getError: () => undefined,
      getProviderDisplayName: (provider: string) => provider,
      getProviderAuthStatus: () => ({ configured: true }),
      hasConfiguredAuth: () => true,
    } as unknown as ModelRegistry;
    harness.runtime.sessionModelRegistry = harness.runtime.projectModelRegistry;
    const credentials: unknown[] = [];
    Object.assign(harness.runtime.authStorage, {
      set: (provider: string, credential: unknown) => {
        credentials.push({ provider, credential });
      },
    });
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
      expect(credentials).toEqual([{
        provider: projectModel.provider,
        credential: { type: "api_key", key: "project-secret" },
      }]);
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
        type: "set_tool_mode",
        sessionId: SESSION_A,
        mode: "full_access",
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
          (name?.length ?? 0) <= 120 && preview.length <= 500,
      )).toBe(true);
      expect(snapshot.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8"))
        .toBeLessThanOrEqual(MAX_PROJECT_SNAPSHOT_BYTES);
    } finally {
      await harness.cleanup();
    }
  });

  it("projects card peer existence from the complete durable project index", async () => {
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
      appendReservedCustomEntry(
        source.sessionManager,
        createConversationCardEntry({
          cardId,
          kind: "message",
          body: "review this",
          fromSnapshot: {
            conversationId: source.conversationId,
            title: "source",
            role: {
              id: source.profile.role.id,
              name: source.profile.role.name,
            },
          },
          toSnapshot: {
            conversationId: target.conversationId,
            title: "target",
            role: {
              id: target.profile.role.id,
              name: target.profile.role.name,
            },
          },
          state: "queued",
          messageId: randomUUID(),
          updatedAt: "2026-07-19T12:00:00.000Z",
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
      expect(snapshot.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "session_message",
          cardId,
          peerExists: true,
        }),
      ]));

      const itemCount = harness.events.filter(
        (event) => event.type === "conversation_item",
      ).length;
      await harness.coordinator.deleteConversation(
        externalHandle,
        target.conversationId,
      );
      await vi.waitFor(() => {
        expect(harness.events.filter(
          (event) => event.type === "conversation_item",
        ).length).toBeGreaterThan(itemCount);
      });
      expect(harness.events).toContainEqual(expect.objectContaining({
        type: "conversation_item",
        conversationId: source.conversationId,
        item: expect.objectContaining({
          kind: "session_message",
          cardId,
          peerExists: false,
        }),
      }));
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
      expect(harness.runtime.created).toHaveLength(2);
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

      await expect(harness.connection.handle({
        type: "select_model",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        provider: "test",
        modelId: "model",
      })).rejects.toThrow("fixed by its role");

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

      await harness.connection.handle({
        type: "focus_conversation",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        conversationId: firstAttach.conversationId,
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
        role: {
          name: "Renamed project specialist",
          description: "The provider may be temporarily unavailable.",
          systemPrompt: "Keep the frozen project model.",
          model: {
            provider: projectModel.provider,
            id: projectModel.id,
          },
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
        role: {
          name: "Invalid model change",
          description: "",
          systemPrompt: "",
          model: {
            provider: projectModel.provider,
            id: "missing",
          },
          canManageSessions: true,
        },
      })).rejects.toThrow("unavailable in the current project");
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
      await expect(harness.connection.handle({
        type: "delete_role",
        commandId: randomUUID(),
        sessionId: SESSION_A,
        roleId: "default",
        expectedRevision: 1,
      })).rejects.toThrow("default");
    } finally {
      await harness.cleanup();
    }
  });
});
