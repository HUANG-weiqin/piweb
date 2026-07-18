import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ClientCommand,
  PublicState,
  ServerEvent,
  SessionEvent,
  ThinkingLevel,
  ToolMode,
} from "../shared/protocol.js";
import { AuthFlowBroker } from "./auth-flow.js";
import { projectConversationHistorySnapshot } from "./conversation-history.js";
import { validateCwd } from "./cwd.js";
import {
  PiRuntime,
  type CreatedPiSession,
  type PiRuntimeLike,
  type ToolCallGateInput,
} from "./pi-runtime.js";
import { buildPublicProviders } from "./pi-state.js";
import {
  ProjectStoreRegistry,
  type ConversationLease,
  type ProjectStore,
  type ProjectStoreHandle,
} from "./project-store.js";
import {
  ProjectRunCoordinator,
  type ProjectRunLease,
} from "./project-run-coordinator.js";
import { projectConversationIndex } from "./project-snapshot.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { SessionEventProjector, snapshotWireValue } from "./session-events.js";
import { resolveContextUsage } from "./session-usage.js";
import {
  defaultToolPolicy,
  ToolApprovalBroker,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "./tool-approval.js";

interface ActiveSession {
  id: string;
  generation: number;
  cwd: string;
  session: AgentSession;
  sessionManager: SessionManager;
  settings: SettingsManager;
  modelRegistry: ModelRegistry;
  dynamicProviderNames: () => ReadonlySet<string>;
  project: ProjectStore;
  projectHandle: ProjectStoreHandle;
  conversationId: string;
  conversationLease: ConversationLease;
  dispose: () => Promise<void>;
  unsubscribe: () => void;
  unsubscribeProject: () => void;
  disposePromise?: Promise<void>;
}

interface RunTicket {
  id: string;
  sessionId: string;
  generation: number;
  phase: "queued" | "running" | "cancelling";
  toolMode?: ToolMode;
  projector: SessionEventProjector;
  extensionErrorMessage?: string;
  abortPromise?: Promise<void>;
  projectRunLease?: ProjectRunLease;
}

interface SelectedConversation {
  conversationId: string;
  sessionManager: SessionManager;
  lease: ConversationLease;
}

type QueuedCommand = Exclude<ClientCommand, {
  type:
    | "abort"
    | "auth_response"
    | "cancel_auth"
    | "close_session"
    | "initialize"
    | "prompt"
    | "tool_approval_response";
}>;
type ConversationTarget = NonNullable<
  Extract<ClientCommand, { type: "initialize" }>["conversation"]
>;

function assertNever(value: never): never {
  const type = (value as { type?: unknown }).type;
  throw new Error(`Unhandled command type: ${String(type)}`);
}

function queuedCommandScope(command: QueuedCommand): "session" | "epoch" | "global" {
  switch (command.type) {
    case "select_model":
    case "set_thinking":
    case "set_tool_mode":
    case "rename_conversation":
      return "session";
    case "login_oauth":
      return "epoch";
    case "set_api_key":
    case "logout":
    case "refresh_models":
      return "global";
    default:
      return assertNever(command);
  }
}

function isCancelling(ticket: RunTicket): boolean {
  return ticket.phase === "cancelling";
}

export class PiConnection {
  private readonly operations = new SerialTaskQueue();
  private readonly unsubscribeRuntime: () => void;
  private readonly toolApprovals: ToolApprovalBroker;
  private active?: ActiveSession;
  private activeRun?: RunTicket;
  private authFlow?: AuthFlowBroker;
  private requestedSessionId?: string;
  private readonly usedSessionIds = new Set<string>();
  private readonly runIdsBySession = new Map<string, Set<string>>();
  private readonly usedAuthFlowIds = new Set<string>();
  private readonly pendingAuthFlowIds = new Set<string>();
  private readonly cancelledAuthFlowIds = new Set<string>();
  private generation = 0;
  private initializationAbort?: AbortController;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly runtime: PiRuntimeLike = new PiRuntime(),
    private readonly toolPolicy: ToolPolicy = defaultToolPolicy,
    private readonly projects: ProjectStoreRegistry = new ProjectStoreRegistry(),
    private readonly projectRuns: ProjectRunCoordinator = new ProjectRunCoordinator(),
  ) {
    this.toolApprovals = new ToolApprovalBroker(() => this.publishState());
    this.unsubscribeRuntime = runtime.subscribe(() => this.publishState());
  }

  get sessionId(): string | undefined {
    return this.active?.id;
  }

  private async initialize(
    inputCwd: string,
    sessionId: string,
    generation: number,
    seedToolMode: ToolMode,
    target: ConversationTarget,
    signal: AbortSignal,
  ): Promise<void> {
    const validatedCwd = await validateCwd(inputCwd);
    if (this.disposed || generation !== this.generation || signal.aborted) return;

    const previous = this.active;
    if (previous) {
      this.active = undefined;
      await this.disposeBundle(previous);
      if (this.disposed || generation !== this.generation || signal.aborted) return;
    }

    const projectHandle = await this.projects.acquireProject(
      validatedCwd,
      seedToolMode,
    );
    const project = projectHandle.store;
    let selected: SelectedConversation | undefined;
    let created: CreatedPiSession | undefined;
    let ownershipTransferred = false;
    try {
      // Initialize carries a safety ceiling, not permission to expand a
      // durable project setting. A lost acknowledgement therefore cannot
      // silently restore write permission on reconnect.
      if (seedToolMode === "read_only" && project.toolMode !== "read_only") {
        await this.projectRuns.transitionToolMode(project, "read_only");
      }
      if (this.disposed || generation !== this.generation || signal.aborted) return;
      selected = await this.selectConversation(project, target, signal);
      if (this.disposed || generation !== this.generation || signal.aborted) return;
      created = await this.runtime.createSession(project.cwd, {
        sessionManager: selected.sessionManager,
        toolCallGate: (input) => this.authorizeToolCall(
          sessionId,
          generation,
          project.cwd,
          input,
        ),
      });
      if (this.disposed || generation !== this.generation || signal.aborted) {
        await created.dispose();
        created = undefined;
        return;
      }

      await created.activateExtensions();
      if (this.disposed || generation !== this.generation || signal.aborted) {
        await created.dispose();
        created = undefined;
        return;
      }

      const unsubscribe = created.session.subscribe((event) => {
        this.onSessionEvent(sessionId, generation, event);
      });
      const unsubscribeProject = project.subscribe(() => {
        this.publishState();
        this.publishProjectSnapshot();
      });
      this.active = {
        id: sessionId,
        generation,
        cwd: project.cwd,
        session: created.session,
        sessionManager: selected.sessionManager,
        settings: created.settings,
        modelRegistry: created.modelRegistry,
        dynamicProviderNames: created.dynamicProviderNames,
        project,
        projectHandle,
        conversationId: selected.conversationId,
        conversationLease: selected.lease,
        dispose: created.dispose,
        unsubscribe,
        unsubscribeProject,
      };
      ownershipTransferred = true;
      const pendingExtensionErrors = created.activateExtensionErrors((error) => {
        this.onExtensionError(sessionId, generation, error);
      });

      this.publishState();
      this.publishProjectSnapshot();
      const history = projectConversationHistorySnapshot(selected.sessionManager);
      this.emit({
        type: "conversation_snapshot",
        sessionId,
        conversationId: selected.conversationId,
        messages: history.messages,
        truncated: history.truncated,
      });
      for (const error of pendingExtensionErrors) {
        this.emitExtensionError(sessionId, error);
      }
    } catch (error) {
      if (!ownershipTransferred && created) {
        try {
          await created.dispose();
        } catch (disposeError) {
          throw new AggregateError(
            [error, disposeError],
            "Failed to initialize and dispose Pi session",
          );
        }
      }
      throw error;
    } finally {
      if (!ownershipTransferred) {
        selected?.lease.release();
        projectHandle.release();
      }
    }
  }

  private async selectConversation(
    project: ProjectStore,
    target: ConversationTarget,
    signal: AbortSignal,
  ): Promise<SelectedConversation> {
    const conversations = await project.refreshConversations();
    this.throwIfAborted(signal);
    let conversationId: string | undefined;
    if (target.kind === "open") {
      conversationId = target.conversationId;
    } else if (target.kind === "recent") {
      const knownIds = new Set(conversations.map(({ id }) => id));
      conversationId = project.lastConversationId
        && knownIds.has(project.lastConversationId)
        ? project.lastConversationId
        : conversations[0]?.id;
    }

    if (conversationId !== undefined) {
      const lease = await this.projects.acquireConversationWhenAvailable(
        project.cwd,
        conversationId,
        { signal },
      );
      try {
        this.throwIfAborted(signal);
        return {
          conversationId,
          sessionManager: await project.openConversation(conversationId),
          lease,
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    }

    this.throwIfAborted(signal);
    conversationId = randomUUID();
    const lease = this.projects.acquireConversation(project.cwd, conversationId);
    try {
      this.throwIfAborted(signal);
      return {
        conversationId,
        sessionManager: await project.createConversation(conversationId),
        lease,
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  handle(command: ClientCommand): Promise<void> {
    if (command.type === "abort") return this.abort(command.sessionId, command.runId);
    if (command.type === "tool_approval_response") {
      this.toolApprovals.respond(command);
      return Promise.resolve();
    }
    if (command.type === "auth_response") {
      if (this.authFlow?.id === command.authFlowId) this.authFlow.respond(command);
      return Promise.resolve();
    }
    if (command.type === "cancel_auth") {
      this.cancelAuth(command.authFlowId);
      return Promise.resolve();
    }
    if (command.type === "close_session") return this.closeSession(command.sessionId);
    if (command.type === "initialize") {
      if (this.usedSessionIds.has(command.sessionId)) {
        return Promise.reject(new Error("Session ID was already used on this connection"));
      }
      this.initializationAbort?.abort();
      const initializationAbort = new AbortController();
      this.initializationAbort = initializationAbort;
      this.usedSessionIds.add(command.sessionId);
      this.runIdsBySession.set(command.sessionId, new Set());
      const generation = ++this.generation;
      this.requestedSessionId = command.sessionId;
      this.cancelAuth();
      const previousRun = this.activeRun;
      const cancel = previousRun
        ? this.cancelRun(previousRun).catch((error) => {
            this.emitError("session", error, previousRun.sessionId);
          })
        : Promise.resolve();
      return this.operations.run(async () => {
        await cancel;
        this.assertOpen();
        if (generation !== this.generation) return;
        try {
          await this.initialize(
            command.cwd,
            command.sessionId,
            generation,
            command.toolMode ?? "workspace_write",
            command.conversation ?? { kind: "recent" },
            initializationAbort.signal,
          );
        } catch (error) {
          if (
            initializationAbort.signal.aborted
            || generation !== this.generation
            || this.disposed
          ) {
            return;
          }
          const failed = this.active;
          this.active = undefined;
          this.requestedSessionId = undefined;
          if (failed) await this.disposeBundle(failed);
          throw error;
        } finally {
          if (this.initializationAbort === initializationAbort) {
            this.initializationAbort = undefined;
          }
        }
      });
    }
    if (command.type === "prompt") return this.queuePrompt(command);
    if (command.type === "login_oauth") {
      if (this.usedAuthFlowIds.has(command.authFlowId)) {
        return Promise.reject(new Error("Auth flow ID was already used on this connection"));
      }
      this.cancelAuth();
      this.usedAuthFlowIds.add(command.authFlowId);
      this.pendingAuthFlowIds.add(command.authFlowId);
    }

    const generation = this.generation;
    const scope = queuedCommandScope(command);
    return this.operations.run(async () => {
      try {
        this.assertOpen();
        if (scope !== "global" && generation !== this.generation) return;
        if (scope === "session") {
          if (!("sessionId" in command) || !this.isActiveSession(command.sessionId, generation)) return;
        }
        if (command.type === "login_oauth" && this.cancelledAuthFlowIds.has(command.authFlowId)) {
          return;
        }
        await this.execute(command);
      } finally {
        if (command.type === "login_oauth") {
          this.pendingAuthFlowIds.delete(command.authFlowId);
          this.cancelledAuthFlowIds.delete(command.authFlowId);
        }
      }
    });
  }

  private async execute(command: QueuedCommand): Promise<void> {
    switch (command.type) {
      case "select_model": return this.selectModel(command.provider, command.modelId);
      case "set_thinking": return this.setThinking(command.level);
      case "set_tool_mode": return this.setToolMode(command.mode);
      case "rename_conversation":
        return this.renameConversation(command.conversationId, command.name);
      case "set_api_key": return this.setApiKey(command.provider, command.key);
      case "login_oauth": return this.loginOAuth(command.provider, command.authFlowId);
      case "logout": return this.logout(command.provider);
      case "refresh_models": return this.refreshModels();
      default: return assertNever(command);
    }
  }

  private queuePrompt(command: Extract<ClientCommand, { type: "prompt" }>): Promise<void> {
    const generation = this.generation;
    if (this.disposed) return Promise.reject(new Error("Connection is closed"));
    if (this.requestedSessionId !== command.sessionId) {
      return this.usedSessionIds.has(command.sessionId)
        ? Promise.resolve()
        : Promise.reject(new Error("Session was not initialized"));
    }
    const runIds = this.runIdsBySession.get(command.sessionId);
    if (!runIds) return Promise.reject(new Error("Session was not initialized"));
    if (runIds.has(command.runId)) {
      return Promise.reject(new Error("Run ID was already used in this session"));
    }
    if (this.activeRun) return Promise.reject(new Error("Agent is already running"));
    runIds.add(command.runId);

    const ticket: RunTicket = {
      id: command.runId,
      sessionId: command.sessionId,
      generation,
      phase: "queued",
      toolMode: this.active?.id === command.sessionId
        && this.active.generation === generation
        ? this.active.project.toolMode
        : undefined,
      projector: new SessionEventProjector(),
    };
    this.activeRun = ticket;
    this.emitRun(ticket, { type: "run_queued" });
    this.publishState();

    return this.operations.run(async () => {
      if (this.activeRun !== ticket) return;
      if (!this.isActiveSession(ticket.sessionId, ticket.generation)) {
        this.finishRun(ticket, "aborted");
        return;
      }

      const active = this.requireActive();
      ticket.toolMode ??= active.project.toolMode;
      const projectRunLease = this.projectRuns.registerRun(
        active.cwd,
        () => this.cancelRun(ticket),
      );
      if (!projectRunLease) {
        this.finishRun(ticket, "aborted");
        return;
      }
      ticket.projectRunLease = projectRunLease;
      ticket.phase = "running";
      this.emitRun(ticket, { type: "run_started" });
      this.publishState();

      try {
        await this.requireSession().prompt(command.text, {
          preflightResult: (accepted) => {
            if (accepted && isCancelling(ticket)) {
              throw new Error("Run cancelled before agent start");
            }
          },
        });
        const failure = ticket.extensionErrorMessage ?? ticket.projector.errorMessage;
        if (failure) throw new Error(failure);
        this.finishRun(ticket, isCancelling(ticket) || ticket.projector.aborted ? "aborted" : "completed");
      } catch (error) {
        const cancelled = isCancelling(ticket) || this.activeRun !== ticket;
        this.finishRun(ticket, cancelled ? "aborted" : "failed");
        if (!cancelled) throw error;
      }
    });
  }

  private async selectModel(provider: string, modelId: string): Promise<void> {
    const model = this.requireActive().modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.requireSession().setModel(model);
    await this.flushSettings();
    this.publishState();
  }

  private async setThinking(level: ThinkingLevel): Promise<void> {
    this.requireSession().setThinkingLevel(level);
    await this.flushSettings();
    this.publishState();
  }

  private async setToolMode(mode: ToolMode): Promise<void> {
    await this.projectRuns.transitionToolMode(this.requireActive().project, mode);
    this.publishState();
  }

  private async renameConversation(conversationId: string, name: string): Promise<void> {
    const active = this.requireActive();
    if (active.conversationId !== conversationId) {
      throw new Error("Conversation is not active");
    }
    active.session.setSessionName(name);
    await active.project.refreshConversations();
    this.publishState();
  }

  private async setApiKey(provider: string, key: string): Promise<void> {
    this.assertKnownProvider(provider);
    await this.updateConfiguration(() => {
      this.runtime.authStorage.set(provider, { type: "api_key", key });
    });
  }

  private async loginOAuth(provider: string, authFlowId: string): Promise<void> {
    if (!this.isVisibleOAuthProvider(provider)) throw new Error(`OAuth provider not found: ${provider}`);
    this.authFlow?.cancel();
    const flow = new AuthFlowBroker(authFlowId, this.emit);
    this.authFlow = flow;
    const signal = flow.callbacks.signal;
    try {
      await this.updateConfiguration(() => this.runtime.authStorage.login(provider, flow.callbacks));
      if (signal?.aborted) return;
      this.emit({ type: "auth_complete", authFlowId, provider });
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      if (this.authFlow === flow) this.authFlow = undefined;
    }
  }

  private async logout(provider: string): Promise<void> {
    this.assertKnownProvider(provider, true);
    await this.updateConfiguration(() => {
      this.runtime.authStorage.logout(provider);
    });
  }

  private async refreshModels(): Promise<void> {
    try {
      await this.runtime.refreshConfiguration();
    } finally {
      this.reportNativeErrors();
    }
  }

  private async updateConfiguration<T>(change: () => Promise<T> | T): Promise<T> {
    try {
      return await this.runtime.updateConfiguration(change);
    } finally {
      this.reportNativeErrors();
    }
  }

  private assertKnownProvider(provider: string, includeOAuth = false): void {
    const active = this.active;
    const registry = active?.modelRegistry ?? this.runtime.modelRegistry;
    const modelProvider = registry.getAll().some((model) => model.provider === provider)
      || active?.dynamicProviderNames().has(provider) === true;
    const oauthProvider = includeOAuth && this.isVisibleOAuthProvider(provider);
    if (!modelProvider && !oauthProvider) throw new Error(`Provider not found: ${provider}`);
  }

  private state(): PublicState {
    const active = this.requireActive();
    const { session } = active;
    const activeRun = this.activeRun?.sessionId === active.id
      && this.activeRun.generation === active.generation
      ? this.activeRun
      : undefined;
    const registry = active.modelRegistry;
    const available = registry.getAvailable();
    const oauthProviders = new Map(this.runtime.authStorage.getOAuthProviders()
      .map((provider) => [provider.id, provider.name]));
    const stats = session.getSessionStats();
    const contextUsage = resolveContextUsage({
      contextWindow: session.model?.contextWindow ?? null,
      messages: session.messages,
      nativeUsage: stats.contextUsage,
    });
    return {
      sessionId: active.id,
      projectId: active.project.id,
      conversationId: active.conversationId,
      conversationName: active.sessionManager.getSessionName() ?? undefined,
      cwd: active.cwd,
      busy: Boolean(activeRun),
      activeRun: activeRun ? {
        id: activeRun.id,
        phase: activeRun.phase,
        pendingApprovals: this.toolApprovals.requestsFor(active.id, activeRun.id),
      } : undefined,
      selectedModel: session.model && registry.hasConfiguredAuth(session.model)
        ? { provider: session.model.provider, id: session.model.id }
        : undefined,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      toolMode: active.project.toolMode,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      providers: buildPublicProviders({
        models: registry.getAll(),
        availableKeys: new Set(available.map((model) => `${model.provider}/${model.id}`)),
        oauthProviders,
        displayName: (provider) => registry.getProviderDisplayName(provider),
        authStatus: (provider) => registry.getProviderAuthStatus(provider),
      }),
      registryError: registry.getError(),
      sessionTokenUsage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
      },
      contextUsage,
    };
  }

  private publishState(): void {
    const active = this.active;
    if (
      !this.disposed
      && active
      && active.id === this.requestedSessionId
      && active.generation === this.generation
    ) {
      this.emit({ type: "state", state: this.state() });
    }
  }

  private publishProjectSnapshot(): void {
    const active = this.active;
    if (
      this.disposed
      || !active
      || active.id !== this.requestedSessionId
      || active.generation !== this.generation
    ) {
      return;
    }
    const index = projectConversationIndex(
      active.project.listConversations(),
      active.conversationId,
    );
    this.emit({
      type: "project_snapshot",
      sessionId: active.id,
      projectId: active.project.id,
      conversationId: active.conversationId,
      conversations: index.conversations,
      truncated: index.truncated,
    });
  }

  private requireSession(): AgentSession {
    return this.requireActive().session;
  }

  private requireSettings(): SettingsManager {
    return this.requireActive().settings;
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new Error("Choose a working directory first");
    return this.active;
  }

  private async flushSettings(): Promise<void> {
    try {
      await this.requireSettings().flush();
    } finally {
      this.reportNativeErrors();
    }
  }

  private reportNativeErrors(): void {
    for (const error of this.runtime.authStorage.drainErrors()) {
      this.emitError("auth", error);
    }
    for (const item of this.active?.settings.drainErrors() ?? []) {
      this.emitError("settings", item.error, this.active?.id);
    }
  }

  private isActiveSession(sessionId: string, generation: number): boolean {
    return !this.disposed
      && this.requestedSessionId === sessionId
      && this.generation === generation
      && this.active?.id === sessionId
      && this.active.generation === generation;
  }

  private onSessionEvent(sessionId: string, generation: number, event: AgentSessionEvent): void {
    if (!this.isActiveSession(sessionId, generation)) return;
    const run = this.activeRun;
    if (!run || run.sessionId !== sessionId || run.generation !== generation) return;

    for (const projected of run.projector.project(event)) {
      this.emit({ type: "session_event", sessionId, runId: run.id, event: projected });
    }
    if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "agent_end" || event.type === "message_end") {
      this.publishState();
    }
  }

  private onExtensionError(sessionId: string, generation: number, error: ExtensionError): void {
    if (
      this.disposed
      || this.requestedSessionId !== sessionId
      || this.generation !== generation
    ) return;

    const run = this.activeRun;
    const message = this.formatExtensionError(error);
    if (
      run
      && run.sessionId === sessionId
      && run.generation === generation
      && run.phase !== "queued"
    ) {
      run.extensionErrorMessage ??= message;
      return;
    }
    this.emitError("session", message, sessionId);
  }

  private emitExtensionError(sessionId: string, error: ExtensionError): void {
    this.emitError("session", this.formatExtensionError(error), sessionId);
  }

  private formatExtensionError(error: ExtensionError): string {
    return `Extension error in ${error.event} (${error.extensionPath}): ${error.error}`;
  }

  private isVisibleOAuthProvider(provider: string): boolean {
    return this.runtime.authStorage.getOAuthProviders().some((item) => item.id === provider);
  }

  private async authorizeToolCall(
    sessionId: string,
    generation: number,
    cwd: string,
    input: ToolCallGateInput,
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.phase !== "running"
      || ticket.sessionId !== sessionId
      || ticket.generation !== generation
      || !this.isActiveSession(sessionId, generation)
    ) {
      return { block: true, reason: "No active run owns this tool call" };
    }
    const active = this.requireActive();
    let argsSnapshot: ReturnType<typeof snapshotWireValue>;
    try {
      argsSnapshot = snapshotWireValue(input.args);
    } catch {
      return {
        block: true,
        reason: "Tool arguments could not be displayed exactly; execution was blocked",
      };
    }
    const argumentsChanged = (): boolean => {
      try {
        return snapshotWireValue(input.args).serialized !== argsSnapshot.serialized;
      } catch {
        return true;
      }
    };
    this.emitRun(ticket, {
      type: "tool_prepared",
      toolCallId: input.toolCallId,
      args: argsSnapshot.value,
    });

    let policy: ToolPolicyDecision;
    try {
      policy = await this.toolPolicy({
        cwd,
        mode: ticket.toolMode !== "workspace_write"
          || active.project.toolMode === "read_only"
          || this.projectRuns.isRestrictionPending(cwd)
          ? "read_only"
          : "workspace_write",
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolSource: input.toolSource,
        args: argsSnapshot.value,
      });
    } catch (error) {
      this.emitError("session", `Tool policy failed: ${this.errorMessage(error)}`, sessionId);
      return { block: true, reason: "Tool policy failed; execution was blocked" };
    }
    if (
      input.signal?.aborted
      || this.activeRun !== ticket
      || ticket.phase !== "running"
      || !this.isActiveSession(sessionId, generation)
    ) {
      return { block: true, reason: "Run cancelled before tool execution" };
    }

    if (policy.action === "allow") {
      return argumentsChanged()
        ? { block: true, reason: "Tool arguments changed after authorization; execution was blocked" }
        : undefined;
    }
    if (policy.action === "deny") {
      return { block: true, reason: policy.reason };
    }
    if (policy.action !== "ask") {
      return { block: true, reason: "Tool policy returned an invalid decision" };
    }
    if (argumentsChanged()) {
      return {
        block: true,
        reason: "Tool arguments changed before approval; execution was blocked",
      };
    }

    let decision: "allow" | "deny";
    try {
      decision = await this.toolApprovals.request({
        sessionId,
        runId: ticket.id,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: argsSnapshot.value,
        reason: policy.reason,
        signal: input.signal,
      });
    } catch (error) {
      this.emitError("session", `Tool approval failed: ${this.errorMessage(error)}`, sessionId);
      return { block: true, reason: "Tool approval failed; execution was blocked" };
    }
    if (
      decision !== "allow"
      || input.signal?.aborted
      || this.activeRun !== ticket
      || ticket.phase !== "running"
      || !this.isActiveSession(sessionId, generation)
    ) {
      const cancelled = input.signal?.aborted
        || this.activeRun !== ticket
        || ticket.phase !== "running";
      return {
        block: true,
        reason: cancelled
          ? "Run cancelled before tool execution"
          : "User denied tool execution",
      };
    }
    if (argumentsChanged()) {
      return {
        block: true,
        reason: "Tool arguments changed after approval; execution was blocked",
      };
    }
    return undefined;
  }

  private emitError(scope: "auth" | "session" | "settings", error: unknown, sessionId?: string): void {
    this.emit({
      type: "error",
      scope,
      sessionId,
      message: this.errorMessage(error),
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const error = new Error("Session initialization was cancelled");
    error.name = "AbortError";
    throw error;
  }

  private emitRun(ticket: RunTicket, event: SessionEvent): void {
    if (this.disposed) return;
    this.emit({
      type: "session_event",
      sessionId: ticket.sessionId,
      runId: ticket.id,
      event,
    });
  }

  private finishRun(
    ticket: RunTicket,
    outcome: Extract<SessionEvent, { type: "run_finished" }>["outcome"],
  ): void {
    if (this.activeRun !== ticket) return;
    this.toolApprovals.cancelRun(ticket.sessionId, ticket.id);
    this.activeRun = undefined;
    ticket.projectRunLease?.release();
    ticket.projectRunLease = undefined;
    this.emitRun(ticket, { type: "run_finished", outcome });
    this.publishState();
    const active = this.active;
    if (
      active
      && active.id === ticket.sessionId
      && active.generation === ticket.generation
    ) {
      void active.project.refreshConversations().catch((error) => {
        this.emitError("session", error, ticket.sessionId);
      });
    }
  }

  private abort(sessionId: string, runId: string): Promise<void> {
    const ticket = this.activeRun;
    if (!ticket || ticket.sessionId !== sessionId || ticket.id !== runId) return Promise.resolve();
    return this.cancelRun(ticket);
  }

  private cancelRun(ticket: RunTicket): Promise<void> {
    if (this.activeRun !== ticket) return Promise.resolve();
    if (ticket.phase === "queued") {
      ticket.phase = "cancelling";
      this.toolApprovals.cancelRun(ticket.sessionId, ticket.id);
      this.finishRun(ticket, "aborted");
      return Promise.resolve();
    }
    if (ticket.phase === "cancelling") return ticket.abortPromise ?? Promise.resolve();

    ticket.phase = "cancelling";
    this.toolApprovals.cancelRun(ticket.sessionId, ticket.id);
    this.publishState();
    const active = this.active;
    if (!active || active.id !== ticket.sessionId || active.generation !== ticket.generation) {
      this.finishRun(ticket, "aborted");
      return Promise.resolve();
    }
    ticket.abortPromise = Promise.resolve().then(() => active.session.abort());
    return ticket.abortPromise;
  }

  private cancelAuth(authFlowId?: string): void {
    if (authFlowId) {
      if (this.pendingAuthFlowIds.has(authFlowId)) this.cancelledAuthFlowIds.add(authFlowId);
      if (this.authFlow?.id !== authFlowId) return;
    } else {
      for (const pendingId of this.pendingAuthFlowIds) {
        this.cancelledAuthFlowIds.add(pendingId);
      }
    }
    this.authFlow?.cancel();
    this.authFlow = undefined;
  }

  private closeSession(sessionId: string): Promise<void> {
    if (this.requestedSessionId !== sessionId) return Promise.resolve();

    this.generation++;
    this.requestedSessionId = undefined;
    this.initializationAbort?.abort();
    this.initializationAbort = undefined;
    this.cancelAuth();
    const ticket = this.activeRun;
    const cancel = ticket
      ? this.cancelRun(ticket).catch((error) => this.emitError("session", error, ticket.sessionId))
      : Promise.resolve();

    return this.operations.run(async () => {
      await cancel;
      const active = this.active;
      this.active = undefined;
      if (active) await this.disposeBundle(active);
    });
  }

  private disposeBundle(bundle: ActiveSession): Promise<void> {
    if (bundle.disposePromise) return bundle.disposePromise;
    bundle.disposePromise = (async () => {
      const failures: unknown[] = [];
      try {
        bundle.unsubscribe();
      } catch (error) {
        failures.push(error);
      }
      try {
        bundle.unsubscribeProject();
      } catch (error) {
        failures.push(error);
      }
      try {
        await bundle.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        bundle.conversationLease.release();
      } catch (error) {
        failures.push(error);
      }
      try {
        bundle.projectHandle.release();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose Pi session bundle");
      }
    })();
    return bundle.disposePromise;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Connection is closed");
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation++;
    this.requestedSessionId = undefined;
    this.initializationAbort?.abort();
    this.initializationAbort = undefined;
    this.unsubscribeRuntime();
    this.cancelAuth();
    this.toolApprovals.cancelAll();
    const ticket = this.activeRun;
    const cancel = ticket ? this.cancelRun(ticket).catch(() => undefined) : Promise.resolve();
    this.disposePromise = this.operations.run(async () => {
      await cancel;
      const active = this.active;
      this.active = undefined;
      if (active) await this.disposeBundle(active);
    });
    return this.disposePromise;
  }
}
