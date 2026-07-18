import { types as nodeTypes } from "node:util";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import { SerialTaskQueue } from "./serial-task-queue.js";

type SessionFactory = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

export interface ToolCallGateInput {
  toolCallId: string;
  toolName: string;
  toolSource: string;
  args: unknown;
  signal?: AbortSignal;
}

export type ToolCallGate = (
  input: ToolCallGateInput,
) => Promise<{ block?: boolean; reason?: string } | undefined>;

export interface CreatePiSessionOptions {
  toolCallGate?: ToolCallGate;
  sessionManager?: SessionManager;
}

export interface CreatedPiSession {
  session: AgentSession;
  settings: SettingsManager;
  modelRegistry: ModelRegistry;
  activateExtensions(): Promise<void>;
  activateExtensionErrors(handler: (error: ExtensionError) => void): readonly ExtensionError[];
  dynamicProviderNames(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export interface PiRuntimeLike {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  createSession(cwd: string, options?: CreatePiSessionOptions): Promise<CreatedPiSession>;
  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T>;
  refreshConfiguration(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface PiRuntimeOptions {
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  createModelRegistry?: (authStorage: AuthStorage) => ModelRegistry;
  createSettings?: (cwd: string) => SettingsManager;
  createSession?: SessionFactory;
  createServices?: typeof createAgentSessionServices;
  createSessionFromServices?: typeof createAgentSessionFromServices;
}

function freezeStableJsonValue(value: unknown): void {
  const visiting = new WeakSet<object>();
  const visited = new WeakSet<object>();

  function visit(current: unknown): void {
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Non-finite number");
      return;
    }
    if (typeof current !== "object") throw new Error("Non-JSON value");
    if (nodeTypes.isProxy(current)) throw new Error("Proxy value");
    if (visited.has(current)) return;
    if (visiting.has(current)) throw new Error("Circular value");

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      (array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new Error("Non-plain object");
    }

    visiting.add(current);
    try {
      if (array) {
        const keys = Reflect.ownKeys(current);
        if (
          keys.length !== current.length + 1
          || keys.some((key) => typeof key !== "string")
          || !keys.includes("length")
        ) {
          throw new Error("Non-JSON array");
        }
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("Non-JSON array entry");
          }
          visit(descriptor.value);
        }
      } else {
        for (const key of Reflect.ownKeys(current)) {
          if (typeof key !== "string") throw new Error("Symbol property");
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("Accessor or hidden property");
          }
          visit(descriptor.value);
        }
      }
      Object.freeze(current);
      if (!Object.isFrozen(current)) throw new Error("Could not freeze value");
      visited.add(current);
    } finally {
      visiting.delete(current);
    }
  }

  visit(value);
  structuredClone(value);
}

class SessionModelRegistry {
  readonly registry: ModelRegistry;
  private readonly providers = new Set<string>();
  private readonly startupProviderErrors: Error[] = [];
  private readonly nativeRegister: ModelRegistry["registerProvider"];
  private readonly nativeUnregister: ModelRegistry["unregisterProvider"];
  private captureStartupErrors = true;
  private session?: AgentSession;

  constructor(
    authStorage: AuthStorage,
    createRegistry: (authStorage: AuthStorage) => ModelRegistry,
  ) {
    this.registry = createRegistry(authStorage);
    this.nativeRegister = this.registry.registerProvider.bind(this.registry);
    this.nativeUnregister = this.registry.unregisterProvider.bind(this.registry);
    this.registry.registerProvider = (provider, config) => {
      try {
        if (config.streamSimple || config.oauth) {
          throw new Error(
            `Extension provider "${provider}" uses process-global streamSimple or OAuth registration, which this workbench does not support safely`,
          );
        }
        let snapshot: typeof config;
        try {
          snapshot = structuredClone(config);
        } catch (error) {
          throw new Error(
            `Extension provider "${provider}" configuration is not safely cloneable`,
            { cause: error },
          );
        }
        if (snapshot.streamSimple || snapshot.oauth) {
          throw new Error(
            `Extension provider "${provider}" uses process-global streamSimple or OAuth registration, which this workbench does not support safely`,
          );
        }
        this.nativeRegister(provider, snapshot);
        this.providers.add(provider);
      } catch (error) {
        if (this.captureStartupErrors) {
          this.startupProviderErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      }
    };
    this.registry.unregisterProvider = (provider) => {
      this.providers.delete(provider);
      this.nativeUnregister(provider);
    };
  }

  names(): ReadonlySet<string> {
    return new Set(this.providers);
  }

  takeStartupProviderErrors(): readonly Error[] {
    this.captureStartupErrors = false;
    return this.startupProviderErrors.splice(0);
  }

  bindSession(session: AgentSession): void {
    this.session = session;
    this.reconcileSelectedModel();
  }

  refresh(): void {
    this.registry.refresh();
    this.reconcileSelectedModel();
  }

  private reconcileSelectedModel(): void {
    const session = this.session;
    const current = session?.model;
    if (!current) return;
    const replacement = this.registry.find(current.provider, current.id)
      ?? this.registry.getAvailable()[0]
      ?? this.registry.getAll()[0];
    if (replacement && replacement !== current) {
      session.agent.state.model = replacement;
    }
  }
}

/**
 * Process-scoped owner of Pi's shared credential and model state.
 * Individual sessions get an isolated model catalog so project extensions cannot
 * mutate another cwd's visible providers.
 */
export class PiRuntime implements PiRuntimeLike {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;

  private readonly configurationQueue = new SerialTaskQueue();
  private readonly listeners = new Set<() => void>();
  private readonly sessionRegistries = new Set<SessionModelRegistry>();
  private readonly createModelRegistry: (authStorage: AuthStorage) => ModelRegistry;
  private readonly createSettings: (cwd: string) => SettingsManager;
  private readonly sessionFactory?: SessionFactory;
  private readonly servicesFactory: typeof createAgentSessionServices;
  private readonly sessionFromServicesFactory: typeof createAgentSessionFromServices;

  constructor(options: PiRuntimeOptions = {}) {
    this.authStorage = options.authStorage ?? AuthStorage.create();
    this.modelRegistry = options.modelRegistry ?? ModelRegistry.create(this.authStorage);
    this.createModelRegistry = options.createModelRegistry ?? ((authStorage) => ModelRegistry.create(authStorage));
    this.createSettings = options.createSettings ?? ((cwd) => SettingsManager.create(cwd, getAgentDir()));
    this.sessionFactory = options.createSession;
    this.servicesFactory = options.createServices ?? createAgentSessionServices;
    this.sessionFromServicesFactory = options.createSessionFromServices ?? createAgentSessionFromServices;
  }

  async createSession(cwd: string, options: CreatePiSessionOptions = {}): Promise<CreatedPiSession> {
    const owner = new SessionModelRegistry(
      this.authStorage,
      this.createModelRegistry,
    );
    this.sessionRegistries.add(owner);
    let settings: SettingsManager;
    let created: CreateAgentSessionResult;
    try {
      settings = this.createSettings(cwd);
      const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
      if (this.sessionFactory) {
        created = await this.sessionFactory({
          cwd,
          authStorage: this.authStorage,
          modelRegistry: owner.registry,
          settingsManager: settings,
          sessionManager,
        });
      } else {
        const services = await this.servicesFactory({
          cwd,
          agentDir: getAgentDir(),
          authStorage: this.authStorage,
          modelRegistry: owner.registry,
          settingsManager: settings,
        });
        settings = services.settingsManager;
        created = await this.sessionFromServicesFactory({
          services,
          sessionManager,
        });
      }
    } catch (error) {
      this.sessionRegistries.delete(owner);
      throw error;
    }
    const { session } = created;
    owner.bindSession(session);
    if (options.toolCallGate) {
      this.installToolCallGate(session, options.toolCallGate);
    }

    const startupProviderErrors = owner.takeStartupProviderErrors();
    if (startupProviderErrors.length > 0) {
      const failures: unknown[] = [...startupProviderErrors];
      try {
        await this.teardownAgentSession(session, false);
      } catch (error) {
        failures.push(error);
      }
      this.sessionRegistries.delete(owner);
      throw new AggregateError(
        failures,
        `Extension provider registration failed: ${startupProviderErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }

    const pendingExtensionErrors: ExtensionError[] = created.extensionsResult.errors.map((error) => ({
      extensionPath: error.path,
      event: "load",
      error: error.error,
    }));
    let extensionErrorHandler: ((error: ExtensionError) => void) | undefined;
    let activationAttempted = false;
    const dispose = this.createSessionDisposer(session, owner, () => activationAttempted);
    let activationPromise: Promise<void> | undefined;

    return {
      session,
      settings,
      modelRegistry: owner.registry,
      activateExtensions: () => {
        activationAttempted = true;
        activationPromise ??= session.bindExtensions({
          mode: "print",
          onError: (error) => {
            if (extensionErrorHandler) extensionErrorHandler(error);
            else pendingExtensionErrors.push(error);
          },
        }).catch(async (error) => {
          try {
            await dispose();
          } catch (teardownError) {
            throw new AggregateError(
              [error, teardownError],
              "Failed to initialize Pi session extensions",
            );
          }
          throw error;
        });
        return activationPromise;
      },
      activateExtensionErrors: (handler) => {
        extensionErrorHandler = handler;
        return pendingExtensionErrors.splice(0);
      },
      dynamicProviderNames: () => owner.names(),
      dispose,
    };
  }

  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    return this.configurationQueue.run(async () => {
      try {
        return await change();
      } finally {
        this.authStorage.reload();
        for (const owner of this.sessionRegistries) owner.refresh();
        this.modelRegistry.refresh();
        this.notify();
      }
    });
  }

  async refreshConfiguration(): Promise<void> {
    await this.updateConfiguration(() => undefined);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One disconnected or invalid connection must not block other listeners.
      }
    }
  }

  private installToolCallGate(session: AgentSession, gate: ToolCallGate): void {
    const extensionHook = session.agent.beforeToolCall;
    session.agent.toolExecution = "sequential";
    session.agent.beforeToolCall = async (context, signal) => {
      if (!signal) {
        return { block: true, reason: "Tool approval is unavailable" };
      }
      if (signal.aborted) {
        return { block: true, reason: "Run cancelled before tool execution" };
      }
      const extensionResult = await extensionHook?.(context, signal);
      if (signal.aborted) {
        return { block: true, reason: "Run cancelled before tool execution" };
      }
      if (extensionResult?.block) return extensionResult;
      try {
        freezeStableJsonValue(context.args);
      } catch {
        return {
          block: true,
          reason: "Tool arguments must be stable plain JSON data",
        };
      }
      return gate({
        toolCallId: String(context.toolCall.id),
        toolName: String(context.toolCall.name),
        toolSource: session.getAllTools().find((tool) => (
          tool.name === context.toolCall.name
        ))?.sourceInfo.source ?? "unknown",
        args: context.args,
        signal,
      });
    };
  }

  private createSessionDisposer(
    session: AgentSession,
    owner: SessionModelRegistry,
    shouldEmitShutdown: () => boolean,
  ): () => Promise<void> {
    let disposePromise: Promise<void> | undefined;
    return () => {
      disposePromise ??= (async () => {
        const failures: unknown[] = [];
        try {
          await this.teardownAgentSession(session, shouldEmitShutdown());
        } catch (error) {
          failures.push(error);
        }
        this.sessionRegistries.delete(owner);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to dispose Pi session");
        }
      })();
      return disposePromise;
    };
  }

  private async teardownAgentSession(session: AgentSession, emitShutdown: boolean): Promise<void> {
    const failures: unknown[] = [];
    const stopListening = session.extensionRunner.onError((error) => {
      failures.push(new Error(
        `Extension error in ${error.event} (${error.extensionPath}): ${error.error}`,
      ));
    });
    try {
      if (session.isStreaming) {
        try {
          await session.abort();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (emitShutdown && session.hasExtensionHandlers("session_shutdown")) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        session.dispose();
      } catch (error) {
        failures.push(error);
      }
    } finally {
      stopListening();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to tear down AgentSession");
    }
  }
}
