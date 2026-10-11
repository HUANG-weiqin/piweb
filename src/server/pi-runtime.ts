import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  createCodemodeExtension,
  createLocalBashOperations,
  createMcpExtension,
  createToolSearchExtension,
  defineTool,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRegistry,
  ModelRuntime,
  ProjectTrustStore,
  resizeImage,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type CreateAgentSessionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContextActions,
  type ExtensionError,
  type ExtensionFactory,
  type ExtensionHandler,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  contentText,
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
  type BashBackgroundTaskRegistry,
  BashExecutionBudget,
  BashCleanupUnconfirmedError,
  createBashExecutionBinding,
  type BashExecutionLifecycle,
  type BashExecutionOwner,
} from "./bash-execution.js";
import {
  isReadOnlyToolIdentity,
  READ_ONLY_TOOL_NAME_CEILING,
} from "./tool-policy.js";

const MAX_PROVIDER_COMPUTER_IMAGE_DIMENSION = 2_000;
/** Pi's image normalizer measures this limit in encoded base64 characters. */
const MAX_PROVIDER_COMPUTER_IMAGE_CHARACTERS = 4.5 * 1024 * 1024;

type AgentMessage = Extract<
  Parameters<AgentSession["agent"]["steer"]>[0],
  { role: "user" }
>;

interface ToolProjectionAdapter {
  dispose(): void;
}

interface RuntimePromptMutationAdapter {
  allowToolTopologyChanges(): void;
  rejectToolTopologyChanges(): void;
  dispose(): void;
}

interface NativeMcpSectionCapture {
  recorded: boolean;
  present: boolean;
  value?: unknown;
}

interface NativeExtensionBoundary {
  readonly mcpSection: AsyncLocalStorage<NativeMcpSectionCapture>;
  isChangingTools(): boolean;
  withToolChange<T>(change: () => T): T;
}

function createNativeExtensionBoundary(): NativeExtensionBoundary {
  let toolChangeDepth = 0;
  return {
    mcpSection: new AsyncLocalStorage<NativeMcpSectionCapture>(),
    isChangingTools: () => toolChangeDepth > 0,
    withToolChange<T>(change: () => T): T {
      toolChangeDepth++;
      try {
        return change();
      } finally {
        toolChangeDepth--;
      }
    },
  };
}

function scopedNativeExtension(
  factory: ExtensionFactory,
  boundary: NativeExtensionBoundary,
  captureMcpSection = false,
): ExtensionFactory {
  return (pi) => {
    const scoped = Object.create(pi) as ExtensionAPI;
    scoped.registerTool = (tool) => boundary.withToolChange(() => pi.registerTool(tool));
    scoped.setActiveTools = (toolNames) => boundary.withToolChange(() => pi.setActiveTools(toolNames));
    if (captureMcpSection) {
      scoped.on = ((event: string, handler: unknown) => {
        if (event !== "before_agent_start") {
          return Reflect.apply(pi.on, pi, [event, handler]) as () => void;
        }
        const beforeStart = handler as ExtensionHandler<
          BeforeAgentStartEvent,
          BeforeAgentStartEventResult
        >;
        return pi.on("before_agent_start", async (input, ctx) => {
          const result = await beforeStart(input, ctx);
          const capture = boundary.mcpSection.getStore();
          if (capture) {
            capture.recorded = true;
            capture.present = Object.hasOwn(input.systemPromptOptions.sections, "mcp_servers");
            capture.value = input.systemPromptOptions.sections.mcp_servers;
          }
          return result;
        });
      }) as ExtensionAPI["on"];
    }
    return factory(scoped);
  };
}

const RUNTIME_PROMPT_MUTATION_ERROR = "Runtime system prompt changes are not supported";

interface MutablePromptToolSession {
  _refreshToolRegistry(...args: unknown[]): unknown;
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

/**
 * Pi rebuilds its base system prompt whenever the active tool set changes.
 * Startup establishes the initial set; only scoped native MCP/tool-search calls
 * may later update it. Per-turn prompt changes remain blocked except for the
 * native MCP server-list section.
 */
function installRuntimePromptMutationBoundary(
  session: AgentSession,
  nativeBoundary: NativeExtensionBoundary,
): RuntimePromptMutationAdapter {
  const mutableSession = session as unknown as MutablePromptToolSession;
  const nativeSetActiveTools = session.setActiveToolsByName;
  const nativeRefreshTools = mutableSession._refreshToolRegistry;
  const runner = session.extensionRunner;
  const nativeEmitBeforeAgentStart = runner.emitBeforeAgentStart;
  let toolTopologyFrozen = true;
  let disposed = false;

  const rejectMutation = (): never => {
    throw new Error(RUNTIME_PROMPT_MUTATION_ERROR);
  };
  const guardedSetActiveTools: AgentSession["setActiveToolsByName"] = (toolNames) => {
    if (toolTopologyFrozen && !nativeBoundary.isChangingTools()) rejectMutation();
    nativeSetActiveTools.call(session, toolNames);
  };
  const guardedRefreshTools: MutablePromptToolSession["_refreshToolRegistry"] = (...args) => {
    if (toolTopologyFrozen && !nativeBoundary.isChangingTools()) rejectMutation();
    return nativeRefreshTools.call(session, ...args);
  };
  const guardedEmitBeforeAgentStart: typeof runner.emitBeforeAgentStart = async (...args) => {
    // Only Pi's own MCP handler may change its reserved prompt section.
    // All other fields and all other extensions remain behind the same gate.
    const expectedOptions = structuredClone(args[2]);
    const capture: NativeMcpSectionCapture = { recorded: false, present: false };
    return nativeBoundary.mcpSection.run(capture, async () => {
      const result = await nativeEmitBeforeAgentStart.call(runner, ...args);
      if (capture.recorded) {
        const sections = expectedOptions.sections ??= {};
        const value = capture.value;
        if (capture.present) {
          if (typeof value !== "string" || value.length > 4_096) {
            throw new Error(RUNTIME_PROMPT_MUTATION_ERROR);
          }
          sections.mcp_servers = value;
        } else {
          delete sections.mcp_servers;
        }
      }
      if (!isDeepStrictEqual(result.systemPromptOptions, expectedOptions)) {
        rejectMutation();
      }
      return result;
    });
  };

  session.setActiveToolsByName = guardedSetActiveTools;
  mutableSession._refreshToolRegistry = guardedRefreshTools;
  runner.emitBeforeAgentStart = guardedEmitBeforeAgentStart;

  return {
    allowToolTopologyChanges(): void {
      if (!disposed) toolTopologyFrozen = false;
    },
    rejectToolTopologyChanges(): void {
      if (!disposed) toolTopologyFrozen = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      toolTopologyFrozen = false;
      if (session.setActiveToolsByName === guardedSetActiveTools) {
        session.setActiveToolsByName = nativeSetActiveTools;
      }
      if (mutableSession._refreshToolRegistry === guardedRefreshTools) {
        mutableSession._refreshToolRegistry = nativeRefreshTools;
      }
      if (runner.emitBeforeAgentStart === guardedEmitBeforeAgentStart) {
        runner.emitBeforeAgentStart = nativeEmitBeforeAgentStart;
      }
    },
  };
}

type ExtensionReadonlySessionManager = ExtensionContext["sessionManager"];

interface SessionBoundaryAdapter {
  dispose(): void;
}

function installSessionCacheWarmingOff(
  settingsManager: SettingsManager,
): SessionBoundaryAdapter {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    settingsManager,
    "getCacheWarmingMode",
  );
  const getCacheWarmingMode = () => "off" as const;
  Object.defineProperty(settingsManager, "getCacheWarmingMode", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: getCacheWarmingMode,
  });
  let installed = true;
  return {
    dispose(): void {
      if (!installed) return;
      installed = false;
      if (settingsManager.getCacheWarmingMode !== getCacheWarmingMode) return;
      if (originalDescriptor) {
        Object.defineProperty(
          settingsManager,
          "getCacheWarmingMode",
          originalDescriptor,
        );
      } else {
        delete (settingsManager as Partial<SettingsManager>).getCacheWarmingMode;
      }
    },
  };
}

interface SteeringCaptureAdapter extends SessionBoundaryAdapter {
  withdraw(message: AgentMessage): boolean;
  capture<T>(
    onMessage: (message: AgentMessage) => void,
    operation: () => Promise<T>,
  ): Promise<T>;
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
    buildSessionProjection: () => cloneSessionManagerResult(
      sessionManager.buildSessionProjection(),
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
  // Pi 1.0.0 has no public single-message withdrawal API. Only this core
  // queue still owns retractable messages; drain replaces its messages array.
  const privateAgent = session.agent as unknown as {
    steeringQueue: { messages: AgentMessage[] };
  };
  const privateSession = session as unknown as {
    _steeringMessages: string[];
    _emitQueueUpdate(): void;
  };
  const assertWithdrawalShape = (): void => {
    if (
      !Array.isArray(privateAgent.steeringQueue?.messages)
      || !Array.isArray(privateSession._steeringMessages)
      || !privateSession._steeringMessages.every((text) => typeof text === "string")
      || typeof privateSession._emitQueueUpdate !== "function"
    ) {
      throw new Error("Unsupported Pi 1.0.0 steering withdrawal boundary");
    }
  };
  assertWithdrawalShape();
  const nativeSteer = session.agent.steer;
  const captures = new AsyncLocalStorage<{
    active: boolean;
    count: number;
    onMessage: (message: AgentMessage) => void;
  }>();
  const observedSteer: typeof session.agent.steer = (message) => {
    const capture = captures.getStore();
    if (capture?.active && message.role === "user") {
      if (capture.count !== 0) {
        throw new Error("Pi input must enqueue exactly one steering identity");
      }
      capture.count += 1;
      capture.onMessage(message);
    }
    return nativeSteer.call(session.agent, message);
  };
  session.agent.steer = observedSteer;
  if (session.agent.steer !== observedSteer) {
    throw new Error("Pi Agent cannot accept a steering identity boundary");
  }

  return {
    withdraw(message): boolean {
      assertWithdrawalShape();
      const messages = privateAgent.steeringQueue.messages;
      const index = messages.indexOf(message);
      if (index < 0) return false;
      if (messages.lastIndexOf(message) !== index) {
        throw new Error("Pi steering identity occupies more than one queue slot");
      }
      const mirrorIndex = message.role === "user"
        ? privateSession._steeringMessages.indexOf(contentText(message.content, ""))
        : -1;
      messages.splice(index, 1);
      if (mirrorIndex >= 0) privateSession._steeringMessages.splice(mirrorIndex, 1);
      try {
        privateSession._emitQueueUpdate();
      } catch (error) {
        // The synchronous queue mutation has committed. Observer failure must
        // not make the actor retain an admission that can no longer deliver.
        console.error("Pi steering withdrawal committed; queue_update observer failed", error);
      }
      return true;
    },
    async capture<T>(
      onMessage: (message: AgentMessage) => void,
      operation: () => Promise<T>,
    ): Promise<T> {
      const capture = { active: true, count: 0, onMessage };
      return captures.run(capture, async () => {
        try {
          const result = await operation();
          if (capture.count !== 1) {
            throw new Error("Pi input did not enqueue exactly one steering identity");
          }
          return result;
        } finally {
          capture.active = false;
        }
      });
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

export interface ComputerUseSessionOptions {
  /** Returns the exact currently running conversation capability, if any. */
  getOwner(): object | undefined;
}

export interface ComputerUseSessionLifecycle {
  /** Grants the latest durable observation frame only to this decision's computer calls. */
  completeAssistantDecision(toolCallIds: readonly string[]): void;
  /** Drops transient coordinate authority without releasing the process desktop lease. */
  clearObservation(): void;
  /** Drops transient state and releases the exact run's lease after quiescence. */
  release(): Promise<void>;
}

export interface BashExecutionSessionOptions {
  readonly conversationId: string;
  getOwner(): BashExecutionOwner | undefined;
  onChange?(owner: BashExecutionOwner): void;
}

export interface CreatePiSessionOptions {
  toolCallGate?: ToolCallGate;
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
  getLoopListElapsedMinutes?: () => LoopListElapsedMinutes | undefined;
  getServiceTier?: () => ServiceTier | null;
  /** Present only for a full-access actor that owns an exact active run. */
  computerUse?: ComputerUseSessionOptions;
  /** Actor-owned run execution owner; standalone SDK sessions retain native Bash. */
  bashExecutions?: BashExecutionSessionOptions;
  /** Conversation-owned background executions shared across runtime replacements. */
  backgroundTasks?: BashBackgroundTaskRegistry;
}

export interface CreatedPiSession {
  session: AgentSession;
  settings: SettingsManager;
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  releaseTurnBoundaryPause?(): void;
  observedContextLeafId?(): string | null | undefined;
  withdrawSteeringMessage(message: AgentMessage): boolean;
  captureSteeringMessage<T>(
    onMessage: (message: AgentMessage) => void,
    operation: () => Promise<T>,
  ): Promise<T>;
  activateExtensions(): Promise<void>;
  activateExtensionErrors(handler: (error: ExtensionError) => void): readonly ExtensionError[];
  dynamicProviderNames(): ReadonlySet<string>;
  computerUse?: ComputerUseSessionLifecycle;
  bashExecutions?: BashExecutionLifecycle;
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
  /**
   * True when creating a Pi session or project catalog for `cwd` now would
   * ask the user whether to trust project resources: none is saved and the
   * global default policy is "ask".
   */
  projectTrustNeedsDecision(cwd: string): boolean;
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
  private readonly bashExecutionBudget = new BashExecutionBudget();
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
      .then((adapter) => new DesktopController(adapter, {
        requireProviderPresentation: true,
      }));
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

  private async normalizeComputerUseResult(
    controller: DesktopController,
    owner: object,
    toolCallId: string,
    result: ComputerToolResult,
  ): Promise<ComputerToolResult> {
    const imageIndex = result.content.findIndex((part) => part.type === "image");
    if (imageIndex < 0) return result;

    const image = result.content[imageIndex];
    const observation = result.details.observation;
    if (image.type !== "image" || observation?.status !== "captured") {
      controller.clearObservation(owner);
      throw new Error("Computer capture produced an inconsistent image result");
    }
    if (
      observation.width <= MAX_PROVIDER_COMPUTER_IMAGE_DIMENSION
      && observation.height <= MAX_PROVIDER_COMPUTER_IMAGE_DIMENSION
      && image.data.length < MAX_PROVIDER_COMPUTER_IMAGE_CHARACTERS
    ) {
      return result;
    }

    let normalized: Awaited<ReturnType<typeof resizeImage>>;
    try {
      normalized = await resizeImage(
        Buffer.from(image.data, "base64"),
        image.mimeType,
        {
          maxWidth: MAX_PROVIDER_COMPUTER_IMAGE_DIMENSION,
          maxHeight: MAX_PROVIDER_COMPUTER_IMAGE_DIMENSION,
          maxBytes: MAX_PROVIDER_COMPUTER_IMAGE_CHARACTERS,
        },
      );
    } catch {
      controller.clearObservation(owner);
      throw new Error("Computer observation could not be normalized for image delivery");
    }
    if (
      normalized === null
      || normalized.originalWidth !== observation.width
      || normalized.originalHeight !== observation.height
      || normalized.data.length >= MAX_PROVIDER_COMPUTER_IMAGE_CHARACTERS
      || (
        normalized.mimeType !== "image/png"
        && normalized.mimeType !== "image/jpeg"
      )
    ) {
      controller.clearObservation(owner);
      throw new Error("Computer observation could not be normalized for image delivery");
    }

    const labelIndex = imageIndex - 1;
    const label = result.content[labelIndex];
    if (label?.type !== "text" || !/size=\d+x\d+ px\]$/.test(label.text)) {
      controller.clearObservation(owner);
      throw new Error("Computer capture produced an inconsistent observation label");
    }
    const normalizedMimeType = normalized.mimeType;
    const normalizedLabel = label.text.replace(
      /size=\d+x\d+ px\]$/,
      `size=${normalized.width}x${normalized.height} px]`,
    );
    const details = Object.freeze({
      ...result.details,
      observation: Object.freeze({
        ...observation,
        width: normalized.width,
        height: normalized.height,
      }),
    });
    const detailsText = JSON.stringify(details);
    if (!controller.resizePendingFrame(
      owner,
      toolCallId,
      normalized.width,
      normalized.height,
      {
        detailsText,
        label: normalizedLabel,
        mimeType: normalizedMimeType,
        data: normalized.data,
      },
    )) {
      controller.clearObservation(owner);
      throw new Error("Computer observation frame expired during image normalization");
    }
    const content = result.content.map((part) => ({ ...part }));
    content[0] = { type: "text", text: detailsText };
    content[labelIndex] = { type: "text", text: normalizedLabel };
    content[imageIndex] = {
      type: "image",
      data: normalized.data,
      mimeType: normalizedMimeType,
    };
    return Object.freeze({
      content: Object.freeze(content.map((part) => Object.freeze(part))),
      details,
    });
  }

  private installComputerUseResultBoundary(
    session: AgentSession,
    lifecycle: ComputerUseSessionLifecycle,
  ): void {
    const previousAfterToolCall = session.agent.afterToolCall;
    session.agent.afterToolCall = async (context, signal) => {
      if (context.toolCall.name !== "computer") {
        return previousAfterToolCall?.(context, signal);
      }

      const expectedContent = context.result.content.map((part) => ({ ...part }));
      const hasCapturedImage = expectedContent.some((part) => part.type === "image");
      try {
        const patch = await previousAfterToolCall?.(context, signal);
        if (!hasCapturedImage) return patch;

        const effectiveContent = patch?.content ?? context.result.content;
        const unchanged = effectiveContent.length === expectedContent.length
          && expectedContent.every((expected, index) => {
            const effective = effectiveContent[index];
            if (expected.type === "text") {
              return effective?.type === "text" && expected.text === effective.text;
            }
            return effective?.type === "image"
              && expected.mimeType === effective.mimeType
              && expected.data === effective.data;
          });
        if (!unchanged) {
          throw new Error("Computer observation content was modified after capture");
        }
        return patch;
      } catch (error) {
        lifecycle.clearObservation();
        throw error;
      }
    };
  }

  private createComputerUseBinding(
    options: ComputerUseSessionOptions,
    supportsVision: () => boolean,
    blocksImages: () => boolean,
  ): {
    tool: ToolDefinition;
    lifecycle: ComputerUseSessionLifecycle;
    installPresentationBoundary(session: AgentSession): SessionBoundaryAdapter;
  } {
    let controller: DesktopController | undefined;
    let leaseOwner: object | undefined;

    const clearObservation = (): void => {
      if (leaseOwner !== undefined) controller?.clearObservation(leaseOwner);
    };
    const installPresentationBoundary = (session: AgentSession): SessionBoundaryAdapter => {
      const agent = session.agent;
      const original = agent.convertToLlm;
      if (typeof original !== "function") {
        throw new Error("Pi Agent does not expose convertToLlm");
      }
      const hadOwnConverter = Object.hasOwn(agent, "convertToLlm");
      const convertToLlm: typeof original = async function (
        this: AgentSession["agent"],
        messages: Parameters<typeof original>[0],
      ) {
        const converted = await original.call(this, messages);
        const owner = leaseOwner;
        const desktop = controller;
        if (owner === undefined || desktop === undefined) return converted;
        const sourceToolCallId = desktop.pendingFrameSourceToolCallId(owner);
        if (sourceToolCallId === undefined) return converted;

        const matchingResults = converted.filter((message) => (
          message.role === "toolResult" && message.toolCallId === sourceToolCallId
        ));
        let presented: {
          detailsText: string;
          label: string;
          mimeType: string;
          data: string;
        } | undefined;
        if (matchingResults.length === 1) {
          const content = matchingResults[0]!.content;
          if (Array.isArray(content)) {
            for (let index = 0; index + 2 < content.length; index += 1) {
              const details = content[index];
              const label = content[index + 1];
              const image = content[index + 2];
              if (
                details?.type !== "text"
                || label?.type !== "text"
                || image?.type !== "image"
              ) {
                continue;
              }
              if (presented !== undefined) {
                presented = undefined;
                break;
              }
              presented = {
                detailsText: details.text,
                label: label.text,
                mimeType: image.mimeType,
                data: image.data,
              };
            }
          }
        }
        desktop.recordFramePresentation(owner, sourceToolCallId, presented);
        return converted;
      };
      agent.convertToLlm = convertToLlm;
      return {
        dispose(): void {
          if (agent.convertToLlm !== convertToLlm) return;
          if (hadOwnConverter) agent.convertToLlm = original;
          else delete (agent as { convertToLlm?: typeof original }).convertToLlm;
        },
      };
    };
    const lifecycle: ComputerUseSessionLifecycle = {
      completeAssistantDecision: (toolCallIds) => {
        const owner = leaseOwner;
        if (owner === undefined || controller === undefined) return;
        controller.beginAssistantDecision(owner);
        if (blocksImages() || !controller.authorizeFrame(owner, toolCallIds)) {
          controller.clearObservation(owner);
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
        "Observe the current primary Windows display, or foregroundWindow:true's current foreground-window intersection with that primary display, and send one sequential local foreground batch of at most 8 actions.",
        "Kinds: click{x,y,button?}; move{x,y}; mouseHold{x,y,button?,holdMs?}; drag{fromX,fromY,toX,toY,button?,durationMs?}; type{text}; keypress{keys,holdMs?}; scroll{x,y,deltaX?,deltaY?}; wait{ms}.",
        `button is left or right. keypress keys (1-4) are: ${supportedComputerKeys}.`,
        `Limits: type ${MAX_COMPUTER_TYPE_BYTES} UTF-8 bytes; holdMs <= ${MAX_COMPUTER_HOLD_MS}; durationMs <= ${MAX_COMPUTER_DRAG_DURATION_MS}; wait ms <= ${MAX_COMPUTER_WAIT_MS}; abs scroll delta <= ${MAX_COMPUTER_SCROLL_DELTA} with at least one nonzero scroll delta; settleMs 0-${MAX_COMPUTER_SETTLE_MS}.`,
        "Coordinate actions use only the current/after image returned by the immediately preceding computer result; earlier history images never authorize coordinates. foregroundWindow defaults false and is valid only with observe:true; it crops the observation to the then-current foreground window's primary-display intersection, not a window selector. observe:true captures current (no actions) or one post-action image after a short settle. Each captured image is stored in its tool result and replayed until compaction; observe:false returns no image. sent means Windows accepted host dispatch, not that the app succeeded.",
        "If the result is foreground_mismatch, prior sent statuses may have run; the first not_started action and all remaining actions were not dispatched. Inspect per-action statuses, then re-observe before retrying coordinate input.",
      ].join(" "),
      promptSnippet:
        "Use computer({ actions: [], observe: true, foregroundWindow: true }) for a smaller foreground-window observation when it intersects the primary display; otherwise omit foregroundWindow. Only use coordinates from the latest computer result's current/after image. Re-observe after UI-changing actions; do not infer application success from sent.",
      promptGuidelines: [
        "Use only the listed flat action fields; unsupported fields, keys, buttons, or out-of-range durations are rejected before desktop input.",
        "Call observe first before coordinate actions. Only the current/after image from the immediately preceding computer result authorizes coordinates for the next assistant decision. Coordinates are image-local pixels: (0,0) is that image's top-left, including a foreground-window crop; never use desktop-global coordinates.",
        "foregroundWindow?: boolean defaults false and requires observe:true. It captures only the current foreground window's intersection with the primary display; a post-action capture uses the then-current foreground window. observe:true stores one durable image in the tool result (default post-action settle is 150ms), so later provider requests replay identical image content until compaction. observe:false does not capture. Actions are sequential; sent is host dispatch, not UI/business success.",
        "A foreground_mismatch may follow prior sent actions; its first not_started action and all remaining actions were not dispatched. Inspect per-action statuses, then re-observe before any coordinate retry.",
      ],
      parameters: Type.Object({
        actions: Type.Array(actionParameters, { maxItems: 8 }),
        observe: Type.Boolean(),
        foregroundWindow: Type.Optional(Type.Boolean()),
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
        if (blocksImages()) {
          clearObservation();
          throw new Error("Computer use requires image delivery to be enabled");
        }
        if (signal === undefined) {
          throw new Error("Computer use requires the run abort signal");
        }
        controller ??= await this.getDesktopController();
        // Record the exact candidate before execute so abort/reload cleanup can
        // wait for a native primitive that has already acquired its lease.
        leaseOwner = owner;
        const captured: ComputerToolResult = await controller.execute({
          owner,
          toolCallId,
          input,
          signal,
          visionSupported: true,
        });
        const result = await this.normalizeComputerUseResult(
          controller,
          owner,
          toolCallId,
          captured,
        );
        return {
          content: result.content.map((part) => ({ ...part })),
          details: result.details,
        };
      },
    });
    return { tool, lifecycle, installPresentationBoundary };
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
    const nativeBoundary = createNativeExtensionBoundary();
    const nativeExtensions = options.toolMode === "full_access" ? [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      {
        name: "tool-search",
        factory: scopedNativeExtension(createToolSearchExtension(), nativeBoundary),
        builtin: true,
        replaceable: true,
      },
      {
        name: "mcp",
        factory: scopedNativeExtension(createMcpExtension(), nativeBoundary, true),
        builtin: true,
        replaceable: true,
      },
    ] : [];
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
    let computerUseLifecycle: ComputerUseSessionLifecycle | undefined;
    let bashExecutionLifecycle: BashExecutionLifecycle | undefined;
    const disposeBashExecutions = async (): Promise<void> => {
      const cleanup = await bashExecutionLifecycle?.dispose();
      if (cleanup?.cleanupUnknown) {
        throw new BashCleanupUnconfirmedError();
      }
    };
    let installComputerPresentationBoundary:
      | ((session: AgentSession) => SessionBoundaryAdapter)
      | undefined;
    if (options.computerUse && options.toolMode === "full_access") {
      const binding = this.createComputerUseBinding(
        options.computerUse,
        () => createdSession?.model?.input.includes("image") === true,
        () => settings.getBlockImages(),
      );
      computerUseLifecycle = binding.lifecycle;
      installComputerPresentationBoundary = binding.installPresentationBoundary;
      workbenchCustomTools = [
        ...(workbenchCustomTools ?? []),
        binding.tool,
      ];
    }
    let toolProjectionAdapter: ToolProjectionAdapter | undefined;
    let runtimePromptMutationAdapter: RuntimePromptMutationAdapter | undefined;
    let extensionSessionManagerAdapter: SessionBoundaryAdapter | undefined;
    let fixedModelAdapter: SessionBoundaryAdapter | undefined;
    let cacheWarmingAdapter: SessionBoundaryAdapter | undefined;
    let steeringCaptureAdapter: SteeringCaptureAdapter | undefined;
    let contextBudgetController: AgentContextBudgetController | undefined;
    let computerPresentationAdapter: SessionBoundaryAdapter | undefined;
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
        computerPresentationAdapter?.dispose();
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
        runtimePromptMutationAdapter,
        fixedModelAdapter,
        extensionSessionManagerAdapter,
        cacheWarmingAdapter,
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
        resourceLoaderOptions: {
          extensionFactories: nativeExtensions,
          ...(roleSystemPrompt ? {
            appendSystemPromptOverride: (base: string[]) => [...base, roleSystemPrompt],
          } : {}),
        },
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
      cacheWarmingAdapter = installSessionCacheWarmingOff(settings);
      if (options.bashExecutions) {
        const shellPath = settings.getShellPath();
        const commandPrefix = settings.getShellCommandPrefix();
        const binding = createBashExecutionBinding({
          ...options.bashExecutions,
          conversationKey: `${cwd}\0${options.bashExecutions.conversationId}`,
          budget: this.bashExecutionBudget,
          operations: createLocalBashOperations({ shellPath }),
          backgroundTasks: options.backgroundTasks,
          createBaseTool: (operations) => readOnlyToolProjection
            ? createReadOnlyBashTool(cwd, shellPath, operations)
            : createBashToolDefinition(cwd, { shellPath, commandPrefix, operations }),
        });
        bashExecutionLifecycle = binding.lifecycle;
        const bashNames = new Set(binding.tools.map((tool) => tool.name));
        workbenchCustomTools = [
          ...binding.tools,
          ...(workbenchCustomTools?.filter((tool) => !bashNames.has(tool.name)) ?? []),
        ];
      } else if (readOnlyToolProjection) {
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
      if (computerUseLifecycle) {
        this.installComputerUseResultBoundary(createdSession, computerUseLifecycle);
        computerPresentationAdapter = installComputerPresentationBoundary?.(createdSession);
      }
      if (options.getLoopList) {
        contextBudgetController = installAgentContextBudget(
          createdSession,
          options.getLoopList,
          options.getCompactionThresholdPercent,
          options.getLoopListElapsedMinutes,
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
              ...(options.toolMode === "full_access" ? ["codemode"] : []),
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
      runtimePromptMutationAdapter = installRuntimePromptMutationBoundary(createdSession, nativeBoundary);
      if (options.toolCallGate) {
        this.installToolCallGate(createdSession, options.toolCallGate);
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
        await disposeBashExecutions();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
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
        if (teardownSucceeded) {
          try {
            toolProjectionAdapter?.dispose();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
      }
      try {
        disposeSessionBoundaryAdapters();
      } catch (cleanupError) {
        failures.push(cleanupError);
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
        const failures: unknown[] = [];
        try {
          await disposeBashExecutions();
        } catch (error) {
          failures.push(error);
        }
        try {
          await computerUseLifecycle?.release();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Failed to release session-owned tools");
        }
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
      observedContextLeafId: () => turnBoundaryController?.observedLeafId(),
      withdrawSteeringMessage: (message) => {
        if (!steeringCaptureAdapter) {
          throw new Error("Pi steering identity boundary is not available");
        }
        return steeringCaptureAdapter.withdraw(message);
      },
      captureSteeringMessage: (onMessage, operation) => {
        if (!steeringCaptureAdapter) {
          throw new Error("Steering identity boundary is unavailable");
        }
        return steeringCaptureAdapter.capture(onMessage, operation);
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
        activationPromise ??= (async () => {
          runtimePromptMutationAdapter?.allowToolTopologyChanges();
          try {
            await session.bindExtensions({
              uiContext,
              mode: uiContext ? "rpc" : "print",
              commandContextActions,
              abortHandler: options.extensionAbort,
              onError: (error) => {
                if (extensionErrorHandler) extensionErrorHandler(error);
                else pendingExtensionErrors.push(error);
              },
            });
          } finally {
            runtimePromptMutationAdapter?.rejectToolTopologyChanges();
          }
        })().catch(async (error) => {
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
      ...(bashExecutionLifecycle === undefined ? {} : { bashExecutions: bashExecutionLifecycle }),
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
    const runner = session.extensionRunner;
    const nativeHasHandlers = runner.hasHandlers;
    const nativeEmitToolCall = runner.emitToolCall;
    const nativeCreateToolContext = runner.createToolContext;
    const nestedToolScope = new AsyncLocalStorage<{
      callerToolCallId: string;
      rootSignal: AbortSignal;
      executionSignal: AbortSignal;
    }>();
    const extensionHook = session.agent.beforeToolCall;
    const authorize = (
      toolCallId: string,
      toolName: string,
      args: unknown,
      signal: AbortSignal,
    ) => {
      try {
        freezeStableJsonValue(args);
      } catch {
        return {
          block: true,
          reason: "Tool arguments must be stable plain JSON data",
        };
      }
      return gate({
        toolCallId,
        toolName,
        toolSource: session.getAllTools().find((tool) => tool.name === toolName)
          ?.sourceInfo.source ?? "unknown",
        args,
        signal,
      });
    };
    session.agent.toolExecution = "sequential";
    // Pi's nested ctx.executeTool() calls AgentSession._beforeToolCall directly,
    // bypassing agent.beforeToolCall. Keep the originating run signal across
    // codemode's independently cancellable child calls, and make the SDK's
    // execution signal abort when either parent or child is cancelled.
    runner.createToolContext = (toolCallId, parentSignal) => {
      const context = nativeCreateToolContext.call(runner, toolCallId, parentSignal);
      const inherited = nestedToolScope.getStore();
      const rootSignal = inherited?.rootSignal ?? parentSignal;
      const validParent = !inherited || inherited.executionSignal === parentSignal;
      const executeTool: typeof context.executeTool = (name, args, options = {}) => {
        if (
          !validParent || !rootSignal || rootSignal !== session.agent.signal ||
          rootSignal.aborted || !parentSignal || parentSignal.aborted ||
          options.signal?.aborted
        ) {
          return Promise.resolve({
            toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
            result: {
              content: [{ type: "text", text: "No active run owns this nested tool call" }],
              details: {},
            },
            isError: true,
          });
        }
        const childSignal = options.signal ?? parentSignal;
        const executionSignal = childSignal === parentSignal
          ? parentSignal
          : AbortSignal.any([parentSignal, childSignal]);
        return nestedToolScope.run(
          { callerToolCallId: toolCallId, rootSignal, executionSignal },
          () => context.executeTool(name, args, { ...options, signal: executionSignal }),
        );
      };
      const descriptors = Object.getOwnPropertyDescriptors(context);
      if (!descriptors.executeTool || !("value" in descriptors.executeTool)) {
        throw new Error("Pi nested tool context is unavailable");
      }
      descriptors.executeTool.value = executeTool;
      return Object.defineProperties(
        Object.create(Object.getPrototypeOf(context)) as typeof context,
        descriptors,
      );
    };
    runner.hasHandlers = (eventType) => eventType === "tool_call" ||
      nativeHasHandlers.call(runner, eventType);
    runner.emitToolCall = async (event) => {
      const scope = nestedToolScope.getStore();
      if (!scope) {
        if (event.parentToolCallId !== undefined) {
          return { block: true, reason: "Tool execution guard is unavailable" };
        }
        return nativeEmitToolCall.call(runner, event);
      }
      if (
        (event.parentToolCallId !== undefined &&
          event.parentToolCallId !== scope.callerToolCallId) ||
        scope.rootSignal !== session.agent.signal
      ) {
        return { block: true, reason: "Tool execution guard is unavailable" };
      }
      if (scope.rootSignal.aborted || scope.executionSignal.aborted) {
        return { block: true, reason: "Run cancelled before tool execution" };
      }
      const extensionResult = await nativeEmitToolCall.call(runner, event);
      if (
        scope.rootSignal !== session.agent.signal ||
        scope.rootSignal.aborted ||
        scope.executionSignal.aborted
      ) {
        return { block: true, reason: "Run cancelled before tool execution" };
      }
      if (extensionResult?.block) return extensionResult;
      const decision = await authorize(
        event.toolCallId, event.toolName, event.input, scope.executionSignal,
      );
      if (
        scope.rootSignal !== session.agent.signal ||
        scope.rootSignal.aborted ||
        scope.executionSignal.aborted
      ) {
        return { block: true, reason: "Run cancelled before tool execution" };
      }
      return decision;
    };
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
      return authorize(
        String(context.toolCall.id),
        String(context.toolCall.name),
        context.args,
        signal,
      );
    };
  }

  projectTrustNeedsDecision(cwd: string): boolean {
    return hasTrustRequiringProjectResources(cwd)
      && this.decidedProjectTrust(cwd, this.createSettings(cwd)) === undefined;
  }

  /** The saved decision or the default policy; undefined means Pi must ask. */
  private decidedProjectTrust(
    cwd: string,
    settings: SettingsManager,
  ): boolean | undefined {
    const saved = this.projectTrustStore.get(cwd);
    if (saved !== null) return saved;
    // Pi deliberately reads this policy from global settings, never project settings.
    switch (settings.getDefaultProjectTrust()) {
      case "always": return true;
      case "never": return false;
      case "ask": return undefined;
    }
  }

  private async resolveProjectTrust(
    cwd: string,
    settings: SettingsManager,
    ui: PortableExtensionUI | undefined,
  ): Promise<boolean> {
    if (!hasTrustRequiringProjectResources(cwd)) return true;
    const deniedMessage = "项目资源未受信任，已跳过项目设置、skills 和 extensions。";
    const decided = this.decidedProjectTrust(cwd, settings);
    if (decided !== undefined) {
      if (!decided) ui?.notify(deniedMessage, "warning");
      return decided;
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
    ui.notify(deniedMessage, "warning");
    return false;
  }

  private createSessionDisposer(
    session: AgentSession,
    owner: SessionModelRuntime,
    shouldEmitShutdown: () => boolean,
    beforeTeardown?: () => void,
    afterTeardownAttempt?: () => void,
    afterSuccessfulTeardown?: () => void,
    releaseSessionTools?: () => Promise<void>,
  ): () => Promise<void> {
    let disposePromise: Promise<void> | undefined;
    return () => {
      disposePromise ??= (async () => {
        owner.deactivate();
        this.sessionRegistries.delete(owner);
        const failures: unknown[] = [];
        try {
          await releaseSessionTools?.();
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
