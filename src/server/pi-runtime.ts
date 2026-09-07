import { types as nodeTypes } from "node:util";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRegistry,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type CreateAgentSessionResult,
  type ExtensionContext,
  type ExtensionCommandContextActions,
  type ExtensionError,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  InMemoryModelsStore,
  type CredentialStore,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsStore,
} from "@earendil-works/pi-ai";
import type { LoopList, ServiceTier, ToolMode } from "../shared/protocol.js";
import type { PortableExtensionUI } from "./extension-ui.js";
import { applyCodexAutoTransportPolicy } from "./codex-transport-policy.js";
import {
  type AgentContextBudgetController,
  type ComputerProviderImageResolver,
  installAgentContextBudget,
  type LoopListElapsedMinutes,
} from "./agent-context-budget.js";
import {
  createWindowsDesktopAdapter,
  DesktopController,
  MAX_COMPUTER_DRAG_DURATION_MS,
  MAX_COMPUTER_HOLD_MS,
  MAX_COMPUTER_SCROLL_DELTA,
  MAX_COMPUTER_SETTLE_MS,
  MAX_COMPUTER_TYPE_BYTES,
  MAX_COMPUTER_WAIT_MS,
  SUPPORTED_DESKTOP_KEYS,
  type ComputerToolResult,
  type WindowsDesktopAdapter,
} from "./computer-use.js";
import { installToolResultCompression } from "./tool-result-compression.js";
import {
  type AgentTurnBoundaryCheck,
  type AgentTurnBoundaryController,
  installAgentTurnBoundaryCheck,
} from "./agent-turn-boundary.js";
import {
  type CompactionBoundaryAdapter,
  installCompactionBoundary,
} from "./compaction-boundary.js";
import {
  type DefaultCompactionRequestOverride,
  installDefaultCompactionRequestOverride,
} from "./compaction-request.js";
import type { DefaultCompactionAttemptObserver } from "./compaction-provenance.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import {
  installServiceTierOverride,
  type ServiceTierOverride,
} from "./service-tier.js";
import { clearCredentialCommandCache, FileCredentialStore } from "./credential-store.js";
import { createReadOnlyBashTool } from "./read-only-bash.js";
import {
  isReadOnlyToolIdentity,
  READ_ONLY_TOOL_NAME_CEILING,
} from "./tool-policy.js";

type AgentMessage = Extract<
  Parameters<AgentSession["agent"]["steer"]>[0],
  { role: "user" }
>;

interface ToolProjectionAdapter {
  dispose(): void;
}

function installReadOnlyToolProjection(
  session: AgentSession,
): ToolProjectionAdapter {
  const nativeSetActiveTools = session.setActiveToolsByName;
  const projectedSetActiveTools: AgentSession["setActiveToolsByName"] = (toolNames) => {
    const allowedNames = new Set(
      session.getAllTools()
        .filter((tool) => isReadOnlyToolIdentity(
          tool.name,
          tool.sourceInfo.source,
        ))
        .map((tool) => tool.name),
    );
    nativeSetActiveTools.call(
      session,
      toolNames.filter((toolName) => allowedNames.has(toolName)),
    );
  };
  session.setActiveToolsByName = projectedSetActiveTools;
  projectedSetActiveTools(session.getActiveToolNames());

  return {
    dispose(): void {
      if (session.setActiveToolsByName === projectedSetActiveTools) {
        session.setActiveToolsByName = nativeSetActiveTools;
      }
    },
  };
}

type ExtensionReadonlySessionManager = ExtensionContext["sessionManager"];

interface SessionBoundaryAdapter {
  dispose(): void;
}

interface SteeringCaptureAdapter extends SessionBoundaryAdapter {
  capture<T>(operation: () => T): {
    result: T;
    message?: AgentMessage;
  };
}

function cloneSessionManagerResult<T>(value: T): T {
  return structuredClone(value);
}

function createReadonlySessionManagerFacade(
  sessionManager: SessionManager,
): ExtensionReadonlySessionManager {
  return Object.freeze({
    getCwd: () => sessionManager.getCwd(),
    getSessionDir: () => sessionManager.getSessionDir(),
    getSessionId: () => sessionManager.getSessionId(),
    getSessionFile: () => sessionManager.getSessionFile(),
    getLeafId: () => sessionManager.getLeafId(),
    getLeafEntry: () => cloneSessionManagerResult(sessionManager.getLeafEntry()),
    getEntry: (id: string) => cloneSessionManagerResult(sessionManager.getEntry(id)),
    getLabel: (id: string) => sessionManager.getLabel(id),
    getBranch: (fromId?: string) => cloneSessionManagerResult(
      sessionManager.getBranch(fromId),
    ),
    buildContextEntries: () => cloneSessionManagerResult(
      sessionManager.buildContextEntries(),
    ),
    getHeader: () => cloneSessionManagerResult(sessionManager.getHeader()),
    getEntries: () => cloneSessionManagerResult(sessionManager.getEntries()),
    getTree: () => cloneSessionManagerResult(sessionManager.getTree()),
    getSessionName: () => sessionManager.getSessionName(),
  });
}

function installExtensionSessionManagerFacade(
  session: AgentSession,
  sessionManager: SessionManager,
): SessionBoundaryAdapter {
  const runner = session.extensionRunner as unknown as {
    sessionManager: ExtensionReadonlySessionManager;
  };
  const descriptor = Object.getOwnPropertyDescriptor(runner, "sessionManager");
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.writable !== true
    || descriptor.value !== sessionManager
  ) {
    throw new Error(
      "Pi extension runner cannot accept a readonly SessionManager facade",
    );
  }

  const originalSessionManager = runner.sessionManager;
  const facade = createReadonlySessionManagerFacade(sessionManager);
  runner.sessionManager = facade;
  if (runner.sessionManager !== facade) {
    throw new Error(
      "Pi extension runner did not retain its readonly SessionManager facade",
    );
  }

  return {
    dispose(): void {
      runner.sessionManager = originalSessionManager;
      if (runner.sessionManager !== originalSessionManager) {
        throw new Error(
          "Pi extension runner did not restore its original SessionManager",
        );
      }
    },
  };
}

function installSteeringCaptureBoundary(
  session: AgentSession,
): SteeringCaptureAdapter {
  const nativeSteer = session.agent.steer;
  let activeCapture: AgentMessage[] | undefined;
  const observedSteer: typeof session.agent.steer = (message) => {
    if (activeCapture !== undefined && message.role === "user") {
      activeCapture.push(message);
    }
    return nativeSteer.call(session.agent, message);
  };
  session.agent.steer = observedSteer;
  if (session.agent.steer !== observedSteer) {
    throw new Error("Pi Agent cannot accept a steering identity boundary");
  }

  return {
    capture<T>(operation: () => T) {
      if (activeCapture !== undefined) {
        throw new Error("Nested steering identity capture is not supported");
      }
      const messages: AgentMessage[] = [];
      activeCapture = messages;
      try {
        const result = operation();
        return {
          result,
          ...(messages.length === 1 ? { message: messages[0] } : {}),
        };
      } finally {
        activeCapture = undefined;
      }
    },
    dispose(): void {
      session.agent.steer = nativeSteer;
      if (session.agent.steer !== nativeSteer) {
        throw new Error("Pi Agent did not restore its original steering boundary");
      }
    },
  };
}

function installFixedModelBoundary(
  session: AgentSession,
  fixedModel: Readonly<{ provider: string; id: string }>,
): SessionBoundaryAdapter {
  const nativeSetModel = session.setModel;
  const guardedSetModel: AgentSession["setModel"] = async (model, options) => {
    if (model.provider !== fixedModel.provider || model.id !== fixedModel.id) {
      throw new Error(
        `Fixed model ${fixedModel.provider}/${fixedModel.id} cannot be changed to ${model.provider}/${model.id}`,
      );
    }
    return nativeSetModel.call(session, model, options);
  };
  session.setModel = guardedSetModel;
  if (session.setModel !== guardedSetModel) {
    throw new Error("Pi AgentSession cannot accept a fixed-model boundary");
  }

  return {
    dispose(): void {
      session.setModel = nativeSetModel;
      if (session.setModel !== nativeSetModel) {
        throw new Error("Pi AgentSession did not restore its original model boundary");
      }
    },
  };
}

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

export interface ToolCallCompletedInput extends ToolCallGateInput {
  isError: boolean;
  details: unknown;
}

export type ToolCallCompleted = (
  input: ToolCallCompletedInput,
) => Promise<{ details?: unknown } | undefined> | { details?: unknown } | undefined;

export interface ComputerUseSessionOptions {
  /** Returns the exact currently running conversation capability, if any. */
  getOwner(): object | undefined;
}

export interface ComputerUseSessionLifecycle {
  /** Grants a consumed frame to only the computer calls from this decision. */
  completeAssistantDecision(toolCallIds: readonly string[]): void;
  /** Drops transient pixels/frame without releasing the process desktop lease. */
  clearObservation(): void;
  /** Drops transient state and releases the exact run's lease after quiescence. */
  release(): Promise<void>;
}

export interface CreatePiSessionOptions {
  toolCallGate?: ToolCallGate;
  toolCallCompleted?: ToolCallCompleted;
  sessionManager?: SessionManager;
  extensionUI?: PortableExtensionUI;
  extensionAbort?: () => void;
  model?: {
    provider: string;
    id: string;
  };
  /** Omitted follows the conversation model; explicit references are normalized by the caller. */
  compactionModel?: {
    provider: string;
    id: string;
  };
  compactionAttemptObserver?: DefaultCompactionAttemptObserver;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  roleSystemPrompt?: string;
  workbenchCustomTools?: ToolDefinition[];
  toolMode?: ToolMode;
  turnBoundaryCheck?: (input: AgentTurnBoundaryCheck) => boolean;
  getCompactionThresholdPercent?: () => number;
  getLoopList?: () => LoopList;
  getEditBudgetRemainingFiles?: () => number | undefined;
  getLoopListElapsedMinutes?: () => LoopListElapsedMinutes | undefined;
  getServiceTier?: () => ServiceTier | null;
  /** Present only for a full-access actor that owns an exact active run. */
  computerUse?: ComputerUseSessionOptions;
}

export interface CreatedPiSession {
  session: AgentSession;
  settings: SettingsManager;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  releaseTurnBoundaryPause?(): void;
  captureSteeringMessage<T>(operation: () => T): {
    result: T;
    message?: AgentMessage;
  };
  activateExtensions(): Promise<void>;
  activateExtensionErrors(handler: (error: ExtensionError) => void): readonly ExtensionError[];
  dynamicProviderNames(): ReadonlySet<string>;
  computerUse?: ComputerUseSessionLifecycle;
  dispose(): Promise<void>;
}

export interface CreateProjectModelCatalogOptions {
  extensionUI?: PortableExtensionUI;
}

export interface CreatedProjectModelCatalog {
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  dynamicProviderNames(): ReadonlySet<string>;
  dispose(): Promise<void>;
}

export interface CredentialChangeIntent {
  readonly provider: string;
  readonly revision: number;
}

export interface PiRuntimeLike {
  readonly credentialStore: CredentialStore;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  createSession(cwd: string, options?: CreatePiSessionOptions): Promise<CreatedPiSession>;
  createProjectModelCatalog(
    cwd: string,
    options?: CreateProjectModelCatalogOptions,
  ): Promise<CreatedProjectModelCatalog>;
  beginCredentialChange(provider: string): CredentialChangeIntent;
  commitCredentialChange(
    intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean>;
  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T>;
  refreshConfiguration(options?: Pick<ModelsRefreshOptions, "allowNetwork" | "force" | "signal">): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface PiRuntimeOptions {
  credentialStore?: CredentialStore;
  modelsStore?: ModelsStore;
  createModelsStore?: () => ModelsStore;
  modelsPath?: string | null;
  allowModelNetwork?: boolean;
  createModelRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  createSettings?: (cwd: string) => SettingsManager;
  createServices?: typeof createAgentSessionServices;
  createSessionFromServices?: typeof createAgentSessionFromServices;
  projectTrustStore?: Pick<ProjectTrustStore, "get" | "set">;
  /** Test seam; production lazily creates the Koffi-backed Windows adapter. */
  createWindowsDesktopAdapter?: () => Promise<WindowsDesktopAdapter>;
}

const TRUST_PROJECT_AND_REMEMBER = "信任此项目并记住";
const TRUST_PROJECT_ONCE = "仅本次信任";
const DECLINE_PROJECT_AND_REMEMBER = "不信任此项目并记住";
const DECLINE_PROJECT_ONCE = "仅本次不信任";

function refreshResultErrors(result: ModelsRefreshResult): Error[] {
  const errors = [...result.errors].map(([provider, error]) => new Error(
    `Provider "${provider}" model refresh failed: ${error.message}`,
    { cause: error },
  ));
  if (result.aborted) {
    const error = new Error("Model refresh was aborted");
    error.name = "AbortError";
    errors.push(error);
  }
  return errors;
}

function throwRefreshResultErrors(result: ModelsRefreshResult): void {
  const errors = refreshResultErrors(result);
  if (errors.length === 0) return;
  throw new AggregateError(
    errors,
    errors.map((error) => error.message).join("; "),
  );
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

class SessionModelRuntime {
  readonly registry: ModelRegistry;
  readonly runtime: ModelRuntime;
  private readonly providers = new Set<string>();
  private readonly startupProviderErrors: Error[] = [];
  private readonly nativeRegisterProvider: ModelRuntime["registerProvider"];
  private readonly nativeUnregisterProvider: ModelRuntime["unregisterProvider"];
  private captureStartupErrors = true;
  private active = true;
  private session?: AgentSession;

  constructor(
    runtime: ModelRuntime,
    private readonly fixedModel?: Readonly<{ provider: string; id: string }>,
  ) {
    this.runtime = runtime;
    this.registry = new ModelRegistry(runtime);
    this.nativeRegisterProvider = runtime.registerProvider.bind(runtime);
    this.nativeUnregisterProvider = runtime.unregisterProvider.bind(runtime);
    runtime.registerProvider = (provider, config) => {
      try {
        if (config.streamSimple || config.oauth || config.refreshModels) {
          throw new Error(
            `Extension provider "${provider}" uses process-global streamSimple, OAuth, or refreshModels registration, which this workbench does not support safely`,
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
        this.nativeRegisterProvider(provider, snapshot);
        this.providers.add(provider);
      } catch (error) {
        if (this.captureStartupErrors) {
          this.startupProviderErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
        throw error;
      }
    };
    runtime.registerNativeProvider = (provider) => {
      const error = new Error(
        `Extension native provider "${provider.id}" is not supported by this workbench`,
      );
      if (this.captureStartupErrors) this.startupProviderErrors.push(error);
      throw error;
    };
    runtime.unregisterProvider = (provider) => {
      this.providers.delete(provider);
      this.nativeUnregisterProvider(provider);
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
    if (!this.active) throw new Error("Model runtime owner is no longer active");
    if (session.modelRuntime !== this.runtime) {
      throw new Error("Pi session was created with a different ModelRuntime");
    }
    if (
      this.fixedModel
      && (
        session.model?.provider !== this.fixedModel.provider
        || session.model.id !== this.fixedModel.id
      )
    ) {
      throw new Error(
        `Pi session did not retain its fixed model ${this.fixedModel.provider}/${this.fixedModel.id}`,
      );
    }
    this.session = session;
    this.reconcileSelectedModel();
  }

  async refresh(options?: ModelsRefreshOptions): Promise<void> {
    if (!this.active) return;
    const result = await this.runtime.refresh(options);
    if (!this.active) return;
    this.reconcileSelectedModel();
    throwRefreshResultErrors(result);
  }

  deactivate(): void {
    this.active = false;
    this.session = undefined;
  }

  private reconcileSelectedModel(): void {
    const session = this.session;
    if (!this.active || !session) return;
    if (this.fixedModel) {
      const replacement = this.runtime.getModel(this.fixedModel.provider, this.fixedModel.id);
      (session.agent.state as { model: typeof replacement }).model = replacement;
      return;
    }
    const current = session.model;
    const replacement = current
      ? this.runtime.getModel(current.provider, current.id)
        ?? this.runtime.getAvailableSnapshot().find((model) => model.provider === current.provider)
      : undefined;
    const fallback = replacement
      ?? this.runtime.getAvailableSnapshot()[0]
      ?? this.runtime.getModels()[0];
    (session.agent.state as { model: typeof fallback }).model = fallback;
  }
}

/**
 * Process-scoped owner of Pi's shared credential and model state.
 * Individual sessions get an isolated model catalog so project extensions cannot
 * mutate another cwd's visible providers.
 */
export class PiRuntime implements PiRuntimeLike {
  readonly credentialStore: CredentialStore;
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;

  private readonly configurationQueue = new SerialTaskQueue();
  private readonly credentialRevisions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly sessionRegistries = new Set<SessionModelRuntime>();
  private readonly createModelRuntime: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  private readonly createModelsStore?: () => ModelsStore;
  private readonly modelsPath: string | null | undefined;
  private readonly createSettings: (cwd: string) => SettingsManager;
  private readonly servicesFactory: typeof createAgentSessionServices;
  private readonly sessionFromServicesFactory: typeof createAgentSessionFromServices;
  private readonly projectTrustStore: Pick<ProjectTrustStore, "get" | "set">;
  private readonly createDesktopAdapter: () => Promise<WindowsDesktopAdapter>;
  private desktopControllerPromise?: Promise<DesktopController>;

  private constructor(
    options: PiRuntimeOptions,
    credentialStore: CredentialStore,
    modelRuntime: ModelRuntime,
  ) {
    this.credentialStore = credentialStore;
    this.modelRuntime = modelRuntime;
    this.modelRegistry = new ModelRegistry(modelRuntime);
    this.createModelRuntime = options.createModelRuntime ?? ((runtimeOptions) => (
      ModelRuntime.create(runtimeOptions)
    ));
    this.createModelsStore = options.createModelsStore
      ?? (options.modelsStore ? () => new InMemoryModelsStore() : undefined);
    this.modelsPath = options.modelsPath;
    this.createSettings = options.createSettings
      ?? ((cwd) => SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }));
    this.servicesFactory = options.createServices ?? createAgentSessionServices;
    this.sessionFromServicesFactory = options.createSessionFromServices ?? createAgentSessionFromServices;
    this.projectTrustStore = options.projectTrustStore ?? new ProjectTrustStore(getAgentDir());
    this.createDesktopAdapter = options.createWindowsDesktopAdapter
      ?? createWindowsDesktopAdapter;
  }

  static async create(options: PiRuntimeOptions = {}): Promise<PiRuntime> {
    const credentialStore = options.credentialStore ?? new FileCredentialStore();
    const createModelRuntime = options.createModelRuntime ?? ((runtimeOptions) => (
      ModelRuntime.create(runtimeOptions)
    ));
    const modelRuntime = await createModelRuntime({
      credentials: credentialStore,
      modelsPath: options.modelsPath,
      modelsStore: options.modelsStore,
      allowModelNetwork: options.allowModelNetwork === true,
    });
    return new PiRuntime(options, credentialStore, modelRuntime);
  }

  private getDesktopController(): Promise<DesktopController> {
    this.desktopControllerPromise ??= this.createDesktopAdapter()
      .then((adapter) => new DesktopController(adapter));
    return this.desktopControllerPromise;
  }

  private async createSessionModelRuntime(
    fixedModel?: Readonly<{ provider: string; id: string }>,
  ): Promise<SessionModelRuntime> {
    const runtime = await this.createModelRuntime({
      credentials: this.credentialStore,
      modelsPath: this.modelsPath,
      modelsStore: this.createModelsStore?.(),
      allowModelNetwork: false,
    });
    return new SessionModelRuntime(runtime, fixedModel);
  }

  async createProjectModelCatalog(
    cwd: string,
    options: CreateProjectModelCatalogOptions = {},
  ): Promise<CreatedProjectModelCatalog> {
    const owner = await this.createSessionModelRuntime();
    this.sessionRegistries.add(owner);
    try {
      const settings = this.createSettings(cwd);
      const services = await this.servicesFactory({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: owner.runtime,
        settingsManager: settings,
        resourceLoaderReloadOptions: {
          resolveProjectTrust: () => this.resolveProjectTrust(
            cwd,
            settings,
            options.extensionUI,
          ),
        },
      });
      if (services.modelRuntime !== owner.runtime) {
        throw new Error("Pi project services were created with a different ModelRuntime");
      }
      this.throwServiceDiagnostics(services.diagnostics);
      const startupProviderErrors = owner.takeStartupProviderErrors();
      if (startupProviderErrors.length > 0) {
        throw new AggregateError(
          startupProviderErrors,
          `Extension provider registration failed: ${startupProviderErrors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }
    } catch (error) {
      owner.deactivate();
      this.sessionRegistries.delete(owner);
      throw error;
    }

    let disposePromise: Promise<void> | undefined;
    return {
      modelRuntime: owner.runtime,
      modelRegistry: owner.registry,
      dynamicProviderNames: () => owner.names(),
      dispose: () => {
        disposePromise ??= Promise.resolve().then(() => {
          owner.deactivate();
          this.sessionRegistries.delete(owner);
        });
        return disposePromise;
      },
    };
  }

  private createComputerUseBinding(
    options: ComputerUseSessionOptions,
    supportsVision: () => boolean,
  ): {
    tool: ToolDefinition;
    resolver: ComputerProviderImageResolver;
    lifecycle: ComputerUseSessionLifecycle;
  } {
    let controller: DesktopController | undefined;
    let leaseOwner: object | undefined;
    let pendingImage: { owner: object; sourceToolCallId: string } | undefined;
    // A frame outlives PNG delivery only until the assistant's exact tool
    // batch starts. If preflight rejects that batch, the next provider
    // decision must clear it before it can reuse stale coordinates.
    let authorizedFrameOwner: object | undefined;

    const clearObservation = (): void => {
      const owner = pendingImage?.owner ?? authorizedFrameOwner ?? leaseOwner;
      pendingImage = undefined;
      authorizedFrameOwner = undefined;
      if (owner !== undefined) controller?.clearObservation(owner);
    };
    const resolver: ComputerProviderImageResolver = {
      get: () => {
        const pending = pendingImage;
        if (!pending || !controller) {
          // This is the boundary after a rejected/preflighted computer call:
          // no new PNG is entering this decision, so an unexecuted old frame
          // cannot survive to a later assistant decision.
          if (authorizedFrameOwner !== undefined) clearObservation();
          return undefined;
        }
        const evidence = controller.prepareProviderEvidence(
          pending.owner,
          pending.sourceToolCallId,
        );
        if (!evidence) return undefined;
        return {
          sourceToolCallId: evidence.sourceToolCallId,
          images: evidence.images.map((image) => ({
            label: image.kind === "current"
              ? "[computer observation current]"
              : image.kind === "before"
                ? "[computer observation before action batch]"
                : image.kind === "after"
                  ? "[computer observation after action batch]"
                  : "[computer observation before action batch; after unavailable]",
            image: {
              type: "image" as const,
              data: Buffer.from(image.png).toString("base64"),
              mimeType: image.mimeType,
            },
          })),
        };
      },
      presented: (sourceToolCallId) => {
        const pending = pendingImage;
        if (
          !pending
          || pending.sourceToolCallId !== sourceToolCallId
          || !controller?.markProviderEvidencePresented(
            pending.owner,
            sourceToolCallId,
          )
        ) {
          throw new Error("Computer image was not available for provider delivery");
        }
      },
    };
    const lifecycle: ComputerUseSessionLifecycle = {
      completeAssistantDecision: (toolCallIds) => {
        const pending = pendingImage;
        const decisionOwner = pending?.owner ?? authorizedFrameOwner ?? leaseOwner;
        pendingImage = undefined;
        if (decisionOwner !== undefined) controller?.beginAssistantDecision(decisionOwner);
        if (!pending || !controller) {
          // A later successful assistant decision closes a frame whose first
          // call was rejected before it reached this custom tool.
          clearObservation();
          return;
        }
        if (controller.authorizeFrame(pending.owner, toolCallIds)) {
          authorizedFrameOwner = pending.owner;
        } else {
          controller.clearObservation(pending.owner);
        }
      },
      clearObservation,
      release: async () => {
        const owner = leaseOwner;
        clearObservation();
        leaseOwner = undefined;
        if (owner !== undefined) await controller?.release(owner);
      },
    };
    const supportedComputerKeys = Object.keys(SUPPORTED_DESKTOP_KEYS).join(", ");
    const actionParameters = Type.Object({
      kind: Type.String(),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      fromX: Type.Optional(Type.Number()),
      fromY: Type.Optional(Type.Number()),
      toX: Type.Optional(Type.Number()),
      toY: Type.Optional(Type.Number()),
      button: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String())),
      holdMs: Type.Optional(Type.Number()),
      durationMs: Type.Optional(Type.Number()),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
      ms: Type.Optional(Type.Number()),
    }, { additionalProperties: false });
    const tool = defineTool({
      name: "computer",
      label: "Computer",
      description: [
        "Observe the current primary Windows display and send one sequential local foreground batch of at most 8 actions.",
        "Kinds: click{x,y,button?}; move{x,y}; mouseHold{x,y,button?,holdMs?}; drag{fromX,fromY,toX,toY,button?,durationMs?}; type{text}; keypress{keys,holdMs?}; scroll{x,y,deltaX?,deltaY?}; wait{ms}.",
        `button is left or right. keypress keys (1-4) are: ${supportedComputerKeys}.`,
        `Limits: type ${MAX_COMPUTER_TYPE_BYTES} UTF-8 bytes; holdMs <= ${MAX_COMPUTER_HOLD_MS}; durationMs <= ${MAX_COMPUTER_DRAG_DURATION_MS}; wait ms <= ${MAX_COMPUTER_WAIT_MS}; abs scroll delta <= ${MAX_COMPUTER_SCROLL_DELTA} with at least one nonzero scroll delta; settleMs 0-${MAX_COMPUTER_SETTLE_MS}.`,
        "Coordinate actions use only current from an initial single image, or after from paired/after-only evidence. before and historical_before are comparison-only and never authorize coordinates. observe:true captures current (no actions) or post-action evidence after a short settle; an action observation can attach before and after images and therefore costs about twice the visual tokens. observe:false returns no image. sent means Windows accepted host dispatch, not that the app succeeded.",
        "If the result is foreground_mismatch, dispatch was blocked: re-observe before retrying coordinate input.",
      ].join(" "),
      promptSnippet:
        "Use computer({ actions: [], observe: true }) before coordinate actions. Only use current-provider-image coordinates. Re-observe after UI-changing actions; do not infer application success from sent.",
      promptGuidelines: [
        "Use only the listed flat action fields; unsupported fields, keys, buttons, or out-of-range durations are rejected before desktop input.",
        "Call observe first before coordinate actions. Use current only for an initial single image, and after only for paired/after-only evidence; before and historical_before never authorize coordinates.",
        "observe:true captures provider-only evidence (default post-action settle is 150ms); an action pair carries two images and about twice the visual-token cost. observe:false does not capture. Actions are sequential; sent is host dispatch, not UI/business success.",
        "A foreground_mismatch means no input was sent; re-observe before any coordinate retry.",
      ],
      parameters: Type.Object({
        actions: Type.Array(actionParameters, { maxItems: 8 }),
        observe: Type.Boolean(),
        settleMs: Type.Optional(Type.Number()),
      }, { additionalProperties: false }),
      execute: async (toolCallId, input, signal) => {
        const owner = options.getOwner();
        if (owner === undefined) {
          throw new Error("Computer use requires the exact active conversation run");
        }
        if (!supportsVision()) {
          throw new Error("Computer use requires a model that supports image input");
        }
        if (signal === undefined) {
          throw new Error("Computer use requires the run abort signal");
        }
        controller ??= await this.getDesktopController();
        // Record the exact candidate before execute so abort/reload cleanup can
        // wait for a native primitive that has already acquired its lease.
        leaseOwner = owner;
        let result: ComputerToolResult;
        try {
          result = await controller.execute({
            owner,
            toolCallId,
            input,
            signal,
            visionSupported: true,
          });
        } catch (error) {
          // Schema, extension, and host preflight failures happen before a
          // controller primitive/capture attempt. Keep this decision's frame
          // for an exact sibling; resolver.get retires it at the next provider
          // conversion boundary if nothing was admitted.
          throw error;
        }
        const evidence = controller.prepareProviderEvidence(owner, toolCallId);
        if (evidence) {
          // Includes a completed pair/current/after-only observation and the
          // deliberately non-authorizing historical-before after_missing case.
          pendingImage = { owner, sourceToolCallId: toolCallId };
          authorizedFrameOwner = undefined;
        } else if (
          result.details.outcome === "completed"
          || result.details.outcome === "interrupted"
        ) {
          // Do not clear an unconsumed authorized frame here. A pre-admission
          // abort has no desktop side effect and retains it for its sibling;
          // the next conversion boundary still retires it if unused.
          pendingImage = undefined;
        }
        return {
          content: result.content.map((part) => ({ ...part })),
          details: result.details,
        };
      },
    });
    return { tool, resolver, lifecycle };
  }

  async createSession(cwd: string, options: CreatePiSessionOptions = {}): Promise<CreatedPiSession> {
    const fixedModelReference = options.model
      ? { provider: options.model.provider, id: options.model.id }
      : undefined;
    const compactionModelReference = options.compactionModel
      ? {
          provider: options.compactionModel.provider,
          id: options.compactionModel.id,
        }
      : undefined;
    const roleSystemPrompt = options.roleSystemPrompt;
    let workbenchCustomTools = options.workbenchCustomTools;
    const readOnlyToolProjection = options.toolMode === "read_only";
    const allowedToolNames = readOnlyToolProjection
      ? [...READ_ONLY_TOOL_NAME_CEILING]
      : undefined;
    const owner = await this.createSessionModelRuntime(fixedModelReference);
    this.sessionRegistries.add(owner);
    let settings: SettingsManager;
    let resolvedTransport: ReturnType<SettingsManager["getTransport"]>;
    let created: CreateAgentSessionResult;
    let createdSession: AgentSession | undefined;
    let computerProviderImage: ComputerProviderImageResolver | undefined;
    let computerUseLifecycle: ComputerUseSessionLifecycle | undefined;
    if (options.computerUse && options.toolMode === "full_access") {
      const binding = this.createComputerUseBinding(
        options.computerUse,
        () => createdSession?.model?.input.includes("image") === true,
      );
      computerProviderImage = binding.resolver;
      computerUseLifecycle = binding.lifecycle;
      workbenchCustomTools = [
        ...(workbenchCustomTools ?? []),
        binding.tool,
      ];
    }
    let toolProjectionAdapter: ToolProjectionAdapter | undefined;
    let extensionSessionManagerAdapter: SessionBoundaryAdapter | undefined;
    let fixedModelAdapter: SessionBoundaryAdapter | undefined;
    let steeringCaptureAdapter: SteeringCaptureAdapter | undefined;
    let contextBudgetController: AgentContextBudgetController | undefined;
    let turnBoundaryController: AgentTurnBoundaryController | undefined;
    let compactionRequestOverride: DefaultCompactionRequestOverride | undefined;
    let serviceTierOverride: ServiceTierOverride | undefined;
    let compactionBoundaryAdapter: CompactionBoundaryAdapter | undefined;
    let pendingExtensionErrors: ExtensionError[];
    const disposePreTeardownAdapters = (): void => {
      const failures: unknown[] = [];
      try {
        contextBudgetController?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        turnBoundaryController?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        compactionRequestOverride?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        serviceTierOverride?.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        compactionBoundaryAdapter?.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose pre-teardown adapters");
      }
    };
    const disposeSessionBoundaryAdapters = (): void => {
      const failures: unknown[] = [];
      for (const adapter of [
        fixedModelAdapter,
        extensionSessionManagerAdapter,
        steeringCaptureAdapter,
      ]) {
        try {
          adapter?.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose session boundary adapters");
      }
    };
    try {
      settings = this.createSettings(cwd);
      const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);
      compactionBoundaryAdapter = installCompactionBoundary(sessionManager);
      const services = await this.servicesFactory({
        cwd,
        agentDir: getAgentDir(),
        modelRuntime: owner.runtime,
        settingsManager: settings,
        resourceLoaderOptions: roleSystemPrompt
          ? {
              appendSystemPromptOverride: (base) => [
                ...base,
                roleSystemPrompt,
              ],
            }
          : undefined,
        resourceLoaderReloadOptions: {
          resolveProjectTrust: () => this.resolveProjectTrust(
            cwd,
            settings,
            options.extensionUI,
          ),
        },
      });
      this.throwServiceDiagnostics(services.diagnostics);
      settings = services.settingsManager;
      if (readOnlyToolProjection) {
        workbenchCustomTools = [
          createReadOnlyBashTool(cwd, settings.getShellPath()),
          ...(workbenchCustomTools?.filter((tool) => tool.name !== "bash") ?? []),
        ];
      }
      const fixedModel = fixedModelReference
        ? this.resolveFixedModel(owner.registry, fixedModelReference)
        : undefined;
      if (fixedModel) applyCodexAutoTransportPolicy(settings, fixedModel);
      resolvedTransport = settings.getTransport();
      created = await this.sessionFromServicesFactory({
        services,
        sessionManager,
        model: fixedModel,
        thinkingLevel: options.thinkingLevel,
        customTools: workbenchCustomTools,
        tools: allowedToolNames,
      });
      createdSession = created.session;
      extensionSessionManagerAdapter = installExtensionSessionManagerFacade(
        createdSession,
        sessionManager,
      );
      if (fixedModelReference) {
        fixedModelAdapter = installFixedModelBoundary(
          createdSession,
          fixedModelReference,
        );
      }
      steeringCaptureAdapter = installSteeringCaptureBoundary(createdSession);
      // 消息直通：busy 时浏览器 prompt 进 SDK steering 队列，排队消息必须一次
      // 全部注入（one-at-a-time 会让每条消息各占一个完整模型轮次，用户连发多条
      // 时 agent 逐条执行、无法整体理解意图）。inbox 消息同队列也批量注入。
      // 不用 setSteeringMode()：它会 markModified 并把 all 写进用户 settings.json。
      // Agent.steeringMode 公开 setter 直接改 PendingMessageQueue.mode（drain 时实时读取）。
      createdSession.agent.steeringMode = "all";
      installToolResultCompression(createdSession);
      if (options.getLoopList || computerProviderImage) {
        // This host converter runs after the SDK extension transform and keeps
        // transient hints inside the existing final input instead of creating a new turn.
        contextBudgetController = installAgentContextBudget(
          createdSession,
          options.getLoopList ?? (() => ({ items: [], armed: false })),
          options.getCompactionThresholdPercent,
          options.getEditBudgetRemainingFiles,
          options.getLoopListElapsedMinutes,
          computerProviderImage,
        );
      }
      if (readOnlyToolProjection) {
        toolProjectionAdapter = installReadOnlyToolProjection(createdSession);
      }
      const projectedToolNames = readOnlyToolProjection
        ? createdSession.getAllTools()
          .filter((tool) => isReadOnlyToolIdentity(
            tool.name,
            tool.sourceInfo.source,
          ))
          .map((tool) => tool.name)
        : [
            ...new Set([
              ...createdSession.getActiveToolNames(),
              "grep",
              "find",
              "ls",
              ...(workbenchCustomTools?.map((tool) => tool.name) ?? []),
            ]),
          ];
      createdSession.setActiveToolsByName(projectedToolNames);
      owner.bindSession(createdSession);
      if (
        fixedModelReference
        && (
          createdSession.model?.provider !== fixedModelReference.provider
          || createdSession.model.id !== fixedModelReference.id
        )
      ) {
        throw new Error(
          `Pi session did not retain its fixed model ${fixedModelReference.provider}/${fixedModelReference.id}`,
        );
      }
      if (
        options.thinkingLevel !== undefined
        && createdSession.thinkingLevel !== options.thinkingLevel
      ) {
        throw new Error(
          `Pi session did not retain its requested thinking level ${options.thinkingLevel}`,
        );
      }
      const activeToolNames = new Set(createdSession.getActiveToolNames());
      if (readOnlyToolProjection) {
        const toolInfoByName = new Map(
          createdSession.getAllTools().map((tool) => [tool.name, tool]),
        );
        const unsafeActiveTool = [...activeToolNames].find((toolName) => {
          const tool = toolInfoByName.get(toolName);
          return !tool || !isReadOnlyToolIdentity(
            tool.name,
            tool.sourceInfo.source,
          );
        });
        if (unsafeActiveTool) {
          throw new Error(
            `Pi session exposed unsafe read-only tool "${unsafeActiveTool}"`,
          );
        }
      }
      const expectedWorkbenchTools = readOnlyToolProjection
        ? workbenchCustomTools?.filter((tool) => isReadOnlyToolIdentity(
          tool.name,
          "sdk",
        ))
        : workbenchCustomTools;
      const inactiveWorkbenchTool = expectedWorkbenchTools?.find(
        (tool) => !activeToolNames.has(tool.name),
      );
      if (inactiveWorkbenchTool) {
        throw new Error(
          `Pi session did not activate workbench tool "${inactiveWorkbenchTool.name}"`,
        );
      }
      if (options.toolCallGate) {
        this.installToolCallGate(createdSession, options.toolCallGate);
      }
      if (options.toolCallCompleted) {
        this.installToolCallCompletion(createdSession, options.toolCallCompleted);
      }
      if (options.turnBoundaryCheck) {
        turnBoundaryController = installAgentTurnBoundaryCheck(
          createdSession,
          options.turnBoundaryCheck,
        );
      }
      if (options.getServiceTier) {
        serviceTierOverride = installServiceTierOverride(
          owner.runtime,
          options.getServiceTier,
        );
      }
      compactionRequestOverride = installDefaultCompactionRequestOverride(
        createdSession,
        owner.runtime,
        compactionModelReference,
        resolvedTransport,
        options.compactionAttemptObserver,
      );

      const startupProviderErrors = owner.takeStartupProviderErrors();
      if (startupProviderErrors.length > 0) {
        throw new AggregateError(
          startupProviderErrors,
          `Extension provider registration failed: ${startupProviderErrors
            .map((error) => error.message)
            .join("; ")}`,
        );
      }
      pendingExtensionErrors = created.extensionsResult.errors.map((error) => ({
        extensionPath: error.path,
        event: "load",
        error: error.error,
      }));
    } catch (error) {
      owner.deactivate();
      const failures: unknown[] = [error];
      try {
        disposePreTeardownAdapters();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      if (createdSession) {
        let teardownSucceeded = false;
        try {
          await this.teardownAgentSession(createdSession, false);
          teardownSucceeded = true;
        } catch (teardownError) {
          failures.push(teardownError);
        }
        try {
          disposeSessionBoundaryAdapters();
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
        if (teardownSucceeded) {
          try {
            toolProjectionAdapter?.dispose();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
      }
      this.sessionRegistries.delete(owner);
      if (failures.length > 1) {
        throw new AggregateError(failures, "Failed to initialize Pi session");
      }
      throw error;
    }
    const { session } = created;

    let extensionErrorHandler: ((error: ExtensionError) => void) | undefined;
    let activationAttempted = false;
    const dispose = this.createSessionDisposer(
      session,
      owner,
      () => activationAttempted,
      disposePreTeardownAdapters,
      disposeSessionBoundaryAdapters,
      () => toolProjectionAdapter?.dispose(),
      async () => {
        await computerUseLifecycle?.release();
      },
    );
    let activationPromise: Promise<void> | undefined;

    return {
      session,
      settings,
      modelRuntime: owner.runtime,
      modelRegistry: owner.registry,
      releaseTurnBoundaryPause: () => {
        turnBoundaryController?.releaseQueuePause();
      },
      captureSteeringMessage: (operation) => {
        if (!steeringCaptureAdapter) {
          throw new Error("Steering identity boundary is unavailable");
        }
        return steeringCaptureAdapter.capture(operation);
      },
      activateExtensions: () => {
        activationAttempted = true;
        const commandContextActions: ExtensionCommandContextActions = {
          waitForIdle: () => session.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => {
            throw new Error("Extension reload is not supported by this workbench");
          },
        };
        const uiContext: ExtensionUIContext | undefined = options.extensionUI
          ? {
              ...session.extensionRunner.getUIContext(),
              ...options.extensionUI,
            }
          : undefined;
        activationPromise ??= session.bindExtensions({
          uiContext,
          mode: uiContext ? "rpc" : "print",
          commandContextActions,
          abortHandler: options.extensionAbort,
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
      ...(computerUseLifecycle === undefined ? {} : { computerUse: computerUseLifecycle }),
      dispose,
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
      // Consume the intent before the external storage mutation so it cannot
      // be accidentally committed twice, including after a thrown write.
      this.credentialRevisions.set(intent.provider, intent.revision + 1);
      await change();
      return true;
    });
  }

  updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    return this.configurationQueue.run(async () => {
      let result!: T;
      let changeFailed = false;
      let changeError: unknown;
      try {
        result = await change();
      } catch (error) {
        changeFailed = true;
        changeError = error;
      }
      clearCredentialCommandCache();
      const refreshErrors = await this.refreshAll({ allowNetwork: false });
      this.notify();
      this.throwConfigurationErrors(changeFailed, changeError, refreshErrors);
      return result;
    });
  }

  refreshConfiguration(
    options: Pick<ModelsRefreshOptions, "allowNetwork" | "force" | "signal"> = {},
  ): Promise<void> {
    return this.configurationQueue.run(async () => {
      clearCredentialCommandCache();
      const refreshErrors = await this.refreshAll({
        ...options,
        allowNetwork: options.allowNetwork === true,
      });
      this.notify();
      this.throwConfigurationErrors(false, undefined, refreshErrors);
    });
  }

  private async refreshAll(options: ModelsRefreshOptions): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (refresh: () => Promise<void>): Promise<void> => {
      try {
        await refresh();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(async () => {
      const result = await this.modelRuntime.refresh(options);
      throwRefreshResultErrors(result);
    });
    for (const owner of this.sessionRegistries) {
      await attempt(async () => owner.refresh({ ...options, allowNetwork: false }));
    }
    return errors;
  }

  private throwConfigurationErrors(
    changeFailed: boolean,
    changeError: unknown,
    refreshErrors: readonly unknown[],
  ): void {
    if (changeFailed && refreshErrors.length > 0) {
      throw new AggregateError([changeError, ...refreshErrors], "Configuration update failed");
    }
    if (changeFailed) throw changeError;
    if (refreshErrors.length === 1) throw refreshErrors[0];
    if (refreshErrors.length > 1) {
      throw new AggregateError(refreshErrors, "Failed to refresh one or more model runtimes");
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private throwServiceDiagnostics(
    diagnostics: readonly { type: "info" | "warning" | "error"; message: string }[],
  ): void {
    const errors = diagnostics
      .filter((diagnostic) => diagnostic.type === "error")
      .map((diagnostic) => new Error(diagnostic.message));
    if (errors.length > 0) {
      throw new AggregateError(errors, "Pi session services reported errors");
    }
  }

  private resolveFixedModel(
    registry: ModelRegistry,
    reference: Readonly<{ provider: string; id: string }>,
  ) {
    const model = registry.find(reference.provider, reference.id);
    if (!model) {
      throw new Error(
        `Fixed model ${reference.provider}/${reference.id} is not available in this session`,
      );
    }
    if (!registry.hasConfiguredAuth(model)) {
      throw new Error(
        `Fixed model ${reference.provider}/${reference.id} has no configured authentication`,
      );
    }
    return model;
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
        return { block: true, reason: "Tool execution guard is unavailable" };
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

  private installToolCallCompletion(
    session: AgentSession,
    completed: ToolCallCompleted,
  ): void {
    const earlierHook = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      const input = (): ToolCallCompletedInput => ({
        toolCallId: String(context.toolCall.id),
        toolName: String(context.toolCall.name),
        toolSource: session.getAllTools().find((tool) => (
          tool.name === context.toolCall.name
        ))?.sourceInfo.source ?? "unknown",
        args: context.args,
        ...(signal === undefined ? {} : { signal }),
        isError: context.isError,
        details: context.result.details,
      });

      let earlierPatch: Awaited<ReturnType<NonNullable<typeof earlierHook>>>;
      try {
        earlierPatch = await earlierHook?.(context, signal);
      } catch (error) {
        // The builtin already executed. Give the host a chance to account for
        // the observed side effect, while preserving the extension failure as
        // the authoritative tool error.
        try {
          await completed(input());
        } catch {
          // Completion accounting is observational here and must not replace
          // the extension error that already controls SDK settlement.
        }
        throw error;
      }

      const completionPatch = await completed({
        ...input(),
        details: earlierPatch?.details ?? context.result.details,
      });
      if (completionPatch?.details === undefined) return earlierPatch;
      return { ...earlierPatch, details: completionPatch.details };
    };
  }

  private async resolveProjectTrust(
    cwd: string,
    settings: SettingsManager,
    ui: PortableExtensionUI | undefined,
  ): Promise<boolean> {
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const saved = this.projectTrustStore.get(cwd);
    if (saved !== null) {
      if (!saved) {
        ui?.notify("项目资源未受信任，已跳过项目设置、skills 和 extensions。", "warning");
      }
      return saved;
    }

    switch (settings.getDefaultProjectTrust()) {
      case "always": return true;
      case "never":
        ui?.notify("项目资源未受信任，已跳过项目设置、skills 和 extensions。", "warning");
        return false;
      case "ask": break;
    }
    if (!ui) return false;

    const selected = await ui.select(
      `是否信任项目资源？\n${cwd}`,
      [
        TRUST_PROJECT_AND_REMEMBER,
        TRUST_PROJECT_ONCE,
        DECLINE_PROJECT_AND_REMEMBER,
        DECLINE_PROJECT_ONCE,
      ],
    );
    if (selected === TRUST_PROJECT_AND_REMEMBER) {
      this.projectTrustStore.set(cwd, true);
      return true;
    }
    if (selected === TRUST_PROJECT_ONCE) return true;
    if (selected === DECLINE_PROJECT_AND_REMEMBER) {
      this.projectTrustStore.set(cwd, false);
    }
    ui.notify("项目资源未受信任，已跳过项目设置、skills 和 extensions。", "warning");
    return false;
  }

  private createSessionDisposer(
    session: AgentSession,
    owner: SessionModelRuntime,
    shouldEmitShutdown: () => boolean,
    beforeTeardown?: () => void,
    afterTeardownAttempt?: () => void,
    afterSuccessfulTeardown?: () => void,
    releaseComputerUse?: () => Promise<void>,
  ): () => Promise<void> {
    let disposePromise: Promise<void> | undefined;
    return () => {
      disposePromise ??= (async () => {
        owner.deactivate();
        this.sessionRegistries.delete(owner);
        const failures: unknown[] = [];
        try {
          await releaseComputerUse?.();
        } catch (error) {
          failures.push(error);
        }
        try {
          beforeTeardown?.();
        } catch (error) {
          failures.push(error);
        }
        let teardownSucceeded = false;
        try {
          await this.teardownAgentSession(session, shouldEmitShutdown());
          teardownSucceeded = true;
        } catch (error) {
          failures.push(error);
        }
        try {
          afterTeardownAttempt?.();
        } catch (error) {
          failures.push(error);
        }
        if (teardownSucceeded) {
          try {
            afterSuccessfulTeardown?.();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to dispose Pi session");
        }
      })();
      return disposePromise;
    };
  }

  private async teardownAgentSession(session: AgentSession, emitShutdown: boolean): Promise<void> {
    const failures: unknown[] = [];
    let stopListening: (() => void) | undefined;
    try {
      stopListening = session.extensionRunner.onError((error) => {
        failures.push(new Error(
          `Extension error in ${error.event} (${error.extensionPath}): ${error.error}`,
        ));
      });
    } catch (error) {
      failures.push(error);
    }
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
      try {
        stopListening?.();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to tear down AgentSession");
    }
  }
}
