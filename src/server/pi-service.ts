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
  AcknowledgedCommandOperation,
  ClientCommand,
  ConversationActivity,
  ConversationHistoryItem,
  ConversationSummary,
  FocusAttachedOperation,
  PublicState,
  ServerEvent,
  SessionEvent,
  SessionMessageEndpoint,
  ThinkingLevel,
  ToolMode,
} from "../shared/protocol.js";
import { mostRestrictiveToolMode } from "../shared/tool-mode.js";
import { AuthFlowBroker } from "./auth-flow.js";
import { projectConversationHistorySnapshot } from "./conversation-history.js";
import type { ConversationActor } from "./conversation-actor.js";
import { validateCwd } from "./cwd.js";
import { ExtensionUIBroker } from "./extension-ui.js";
import { createGitTools } from "./git-inspect.js";
import {
  type CreatedPiSession,
  type CredentialChangeIntent,
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
import {
  ProjectSessionCoordinator,
  type ProjectSessionCoordinatorEvent,
  type ProjectSessionHandle,
} from "./project-session-coordinator.js";
import {
  conversationDisplayTitle,
  projectConversationIndex,
} from "./project-snapshot.js";
import type { RoleCatalog } from "./role-catalog.js";
import { MODEL_REFRESH_TIMEOUT_MS } from "./model-refresh.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { SessionEventProjector, snapshotWireValue } from "./session-events.js";
import { resolveContextUsage } from "./session-usage.js";
import {
  defaultToolPolicy,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "./tool-policy.js";

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
  focusId: string;
  conversationLease: ConversationLease;
  lifecycleAbort: AbortController;
  dispose: () => Promise<void>;
  unsubscribe: () => void;
  unsubscribeProject: () => void;
  disposePromise?: Promise<void>;
}

interface ManualModelRefresh {
  controller: AbortController;
  completion: Promise<never>;
  cancel(reason: string): void;
  cancelled?: string;
  underlying?: Promise<void>;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface RunTicket {
  id: string;
  sessionId: string;
  generation: number;
  conversationId: string;
  focusId: string;
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

export interface PiConnectionCoordination {
  coordinator: ProjectSessionCoordinator;
  roles: RoleCatalog;
}

export type PiConnectionCoordinationProvider =
  () => Promise<PiConnectionCoordination>;

interface CoordinatedProjectView {
  sessionId: string;
  generation: number;
  extensionScope: number;
  extensionAbort: AbortController;
  coordinator: ProjectSessionCoordinator;
  handle: ProjectSessionHandle;
  unsubscribeProject: () => void;
  unsubscribeExtensionUI: () => void;
  actor?: ConversationActor;
  conversationId?: string;
  focusId?: string;
  readonly seenMessageCounts: Map<string, number>;
  readonly unreadConversationIds: Set<string>;
  projectSnapshotInitialized: boolean;
}

interface ProjectSnapshotRefresh {
  readonly view: CoordinatedProjectView;
  trailing: boolean;
}

type ConnectionCommand = Exclude<ClientCommand, { type: "browse_directory" }>;
type LegacySetToolModeCommand = {
  type: "set_tool_mode";
  sessionId: string;
  mode: ToolMode;
};
type QueuedCommand = Exclude<ConnectionCommand, {
  type:
    | "abort"
    | "auth_response"
    | "cancel_auth"
    | "close_session"
    | "extension_ui_response"
    | "initialize"
    | "prompt"
    | "refresh_view"
    | "steer";
}>;
type ConversationTarget = NonNullable<
  Extract<ClientCommand, { type: "initialize" }>["conversation"]
>;

function assertNever(value: never): never {
  const type = (value as { type?: unknown }).type;
  throw new Error(`Unhandled command type: ${String(type)}`);
}


function queuedCommandScope(command: QueuedCommand): "session" | "epoch" | "global" {
  if ((command as { type: string }).type === "set_tool_mode") return "session";
  switch (command.type) {
    case "select_model":
    case "set_thinking":
    case "set_compaction_threshold":
    case "compact_context":
    case "switch_conversation_role":
    case "rename_conversation":
    case "delete_conversation":
    case "truncate_conversation":
    case "focus_conversation":
    case "create_conversation":
    case "create_role":
    case "update_role":
    case "delete_role":
    case "set_api_key":
      return "session";
    case "login_oauth":
      return "epoch";
    case "refresh_models":
      return "session";
    case "logout":
      return "global";
    default:
      return assertNever(command);
  }
}

function isCancelling(ticket: RunTicket): boolean {
  return ticket.phase === "cancelling";
}

export const MAX_PROJECT_SNAPSHOT_BYTES = 750_000;

type ProjectSnapshotEvent = Extract<
  ServerEvent,
  { type: "project_snapshot" }
>;

function boundedProjectSnapshotEvent(input: {
  sessionId: string;
  projectId: string;
  conversationId?: string;
  conversations: readonly ConversationSummary[];
}): ProjectSnapshotEvent {
  const index = projectConversationIndex(
    input.conversations,
    input.conversationId,
  );
  const event: ProjectSnapshotEvent = {
    type: "project_snapshot",
    sessionId: input.sessionId,
    projectId: input.projectId,
    ...(input.conversationId === undefined
      ? {}
      : { conversationId: input.conversationId }),
    conversations: [...index.conversations],
    truncated: index.truncated,
  };
  while (
    event.conversations.length > 0
    && Buffer.byteLength(JSON.stringify(event), "utf8")
      > MAX_PROJECT_SNAPSHOT_BYTES
  ) {
    event.conversations.pop();
    event.truncated = true;
  }
  if (
    Buffer.byteLength(JSON.stringify(event), "utf8")
      > MAX_PROJECT_SNAPSHOT_BYTES
  ) {
    throw new Error("Project snapshot envelope exceeds its wire budget");
  }
  return event;
}

function projectConversationPeers(
  items: readonly ConversationHistoryItem[],
  conversations: readonly ConversationSummary[],
): ConversationHistoryItem[] {
  const summaries = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const enrichTitle = (
    endpoint: SessionMessageEndpoint,
  ): SessionMessageEndpoint => {
    const explicitTitle = endpoint.title === undefined
      ? undefined
      : conversationDisplayTitle({ name: endpoint.title, preview: "" });
    if (explicitTitle !== undefined) {
      return explicitTitle === endpoint.title
        ? endpoint
        : { ...endpoint, title: explicitTitle };
    }
    const summary = summaries.get(endpoint.conversationId);
    if (!summary) return endpoint;
    const title = conversationDisplayTitle(summary);
    return title === undefined ? endpoint : { ...endpoint, title };
  };
  return items.map((item) => {
    if (item.kind !== "session_message") return item;
    const from = enrichTitle(item.from);
    const to = enrichTitle(item.to);
    const peer = item.direction === "incoming" ? from : to;
    return {
      ...item,
      from,
      to,
      peerExists: summaries.has(peer.conversationId),
    };
  });
}

export class PiConnection {
  private readonly operations = new SerialTaskQueue();
  private readonly unsubscribeRuntime: () => void;
  private readonly extensionUI: ExtensionUIBroker;
  private coordinationReady?: Promise<PiConnectionCoordination>;
  private unsubscribeRoles?: () => void;
  private unsubscribeProjectActivity?: () => void;
  private coordinatedView?: CoordinatedProjectView;
  private projectSnapshotRefresh?: ProjectSnapshotRefresh;
  private extensionScope = 0;
  private readonly focusedItemFingerprints = new Map<string, string>();
  private active?: ActiveSession;
  private activeRun?: RunTicket;
  private authFlow?: AuthFlowBroker;
  private requestedSessionId?: string;
  private readonly usedSessionIds = new Set<string>();
  private readonly runIdsBySession = new Map<string, Set<string>>();
  private readonly usedCommandIds = new Set<string>();
  private readonly usedAuthFlowIds = new Set<string>();
  private readonly pendingAuthFlowIds = new Set<string>();
  private readonly cancelledAuthFlowIds = new Set<string>();
  private readonly credentialIntents = new WeakMap<object, CredentialChangeIntent>();
  private generation = 0;
  private initializationAbort?: AbortController;
  private coordinatedTransitionAbort?: AbortController;
  private manualRefresh?: ManualModelRefresh;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly runtime: PiRuntimeLike,
    private readonly toolPolicy: ToolPolicy = defaultToolPolicy,
    private readonly projects: ProjectStoreRegistry = new ProjectStoreRegistry(),
    private readonly projectRuns: ProjectRunCoordinator = new ProjectRunCoordinator(),
    private readonly coordinationProvider?: PiConnectionCoordinationProvider,
  ) {
    this.extensionUI = new ExtensionUIBroker(emit);
    this.unsubscribeRuntime = runtime.subscribe(() => {
      if (this.coordinationProvider) {
        this.publishCoordinatedState();
        this.publishRoleCatalog();
      } else {
        this.publishState();
      }
    });
  }

  get sessionId(): string | undefined {
    return this.coordinatedView?.sessionId ?? this.active?.id;
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
    const lifecycleAbort = new AbortController();
    const abortLifecycle = () => lifecycleAbort.abort();
    signal.addEventListener("abort", abortLifecycle, { once: true });
    if (signal.aborted) lifecycleAbort.abort();
    let selected: SelectedConversation | undefined;
    let created: CreatedPiSession | undefined;
    let ownershipTransferred = false;
    try {
      // Initialize carries a safety ceiling, not permission to expand a
      // durable project setting. A lost acknowledgement therefore cannot
      // silently restore write permission on reconnect.
      const initialMode = mostRestrictiveToolMode(project.toolMode, seedToolMode);
      if (initialMode !== project.toolMode) {
        await this.projectRuns.transitionToolMode(project, initialMode);
      }
      if (this.disposed || generation !== this.generation || signal.aborted) return;
      selected = await this.selectConversation(project, target, signal);
      if (this.disposed || generation !== this.generation || signal.aborted) return;
      created = await this.runtime.createSession(project.cwd, {
        sessionManager: selected.sessionManager,
        toolMode: initialMode,
        workbenchCustomTools: initialMode === "read_only"
          ? createGitTools(project.cwd)
          : [],
        extensionUI: this.extensionUI.context({
          sessionId,
          generation,
          signal: lifecycleAbort.signal,
        }),
        extensionAbort: () => this.abortFromExtension(sessionId, generation),
        toolCallGate: (input) => this.authorizeToolCall(
          sessionId,
          generation,
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
        focusId: randomUUID(),
        conversationLease: selected.lease,
        lifecycleAbort,
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
        focusId: this.active.focusId,
        messages: history.messages,
        window: history.window,
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
      signal.removeEventListener("abort", abortLifecycle);
      if (!ownershipTransferred) {
        lifecycleAbort.abort();
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

  handle(command: ConnectionCommand): Promise<void> {
    if (this.coordinationProvider) {
      return this.handleCoordinated(command);
    }
    if (command.type === "abort") return this.abort(command.sessionId, command.runId);
    if (command.type === "extension_ui_response") {
      this.extensionUI.respond(command);
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
    if (command.type === "refresh_view") {
      this.refreshLegacyView(command);
      return Promise.resolve();
    }
    if (command.type === "steer") {
      return Promise.reject(
        new Error("steer requires persistent project coordination"),
      );
    }
    if (command.type === "initialize") {
      if (this.usedSessionIds.has(command.sessionId)) {
        return Promise.reject(new Error("Session ID was already used on this connection"));
      }
      this.cancelManualRefresh("Model refresh cancelled by connection lifecycle");
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
            (command as typeof command & { toolMode?: ToolMode }).toolMode
              ?? "full_access",
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
    if (command.type === "refresh_models" && this.manualRefresh) {
      return Promise.reject(new Error("A model refresh is already pending"));
    }
    if (
      command.type === "select_model"
      || command.type === "set_api_key"
      || command.type === "refresh_models"
      || command.type === "delete_conversation"
    ) {
      if (this.usedCommandIds.has(command.commandId)) {
        return Promise.reject(new Error("Command ID was already used on this connection"));
      }
      this.usedCommandIds.add(command.commandId);
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
    this.admitCredentialIntent(command, generation, false);
    const manualRefresh = command.type === "refresh_models"
      ? this.startManualRefresh()
      : undefined;
    const scope = queuedCommandScope(command);
    const operation = this.operations.run(async () => {
      try {
        this.assertOpen();
        if (scope !== "global" && generation !== this.generation) return;
        if (scope === "session") {
          if (!("sessionId" in command) || !this.isActiveSession(command.sessionId, generation)) return;
        }
        if (command.type === "login_oauth" && this.cancelledAuthFlowIds.has(command.authFlowId)) {
          return;
        }
        if (manualRefresh?.cancelled || manualRefresh?.timedOut) return;
        await this.execute(command, manualRefresh);
        if (
          command.type === "select_model"
          || command.type === "set_api_key"
          || command.type === "refresh_models"
          || command.type === "delete_conversation"
        ) {
          this.emit({
            type: "command_complete",
            operation: command.type,
            commandId: command.commandId,
            sessionId: command.sessionId,
          });
        }
      } finally {
        if (command.type === "login_oauth") {
          this.pendingAuthFlowIds.delete(command.authFlowId);
          this.cancelledAuthFlowIds.delete(command.authFlowId);
        }
        this.credentialIntents.delete(command);
      }
    });
    return manualRefresh
      ? this.observeManualRefresh(operation, manualRefresh)
      : operation;
  }

  private handleCoordinated(command: ConnectionCommand): Promise<void> {
    if (command.type === "extension_ui_response") {
      this.extensionUI.respond(command);
      return Promise.resolve();
    }
    if (command.type === "auth_response") {
      if (this.authFlow?.id === command.authFlowId) {
        this.authFlow.respond(command);
      }
      return Promise.resolve();
    }
    if (command.type === "cancel_auth") {
      this.cancelAuth(command.authFlowId);
      return Promise.resolve();
    }
    if (command.type === "close_session") {
      return this.closeCoordinatedSession(command.sessionId);
    }
    if (command.type === "refresh_view") {
      this.refreshCoordinatedView(command);
      return Promise.resolve();
    }
    if (command.type === "abort") {
      try {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        return this.requireCoordination().then(({ coordinator }) =>
          coordinator.abort(
            view.handle,
            command.conversationId,
            command.runId,
          )
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "prompt") {
      try {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        const runIds = this.runIdsBySession.get(command.sessionId);
        if (!runIds) {
          return Promise.reject(new Error("Session was not initialized"));
        }
        if (runIds.has(command.runId)) {
          return Promise.reject(
            new Error("Run ID was already used in this session"),
          );
        }
        runIds.add(command.runId);
        return this.requireCoordination().then(({ coordinator }) =>
          coordinator.prompt(
            view.handle,
            command.conversationId,
            command.runId,
            command.text,
            command.promptId,
          )
        ).then(() => undefined);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "steer") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          return Promise.reject(
            new Error("Command ID was already used on this connection"),
          );
        }
        this.usedCommandIds.add(command.commandId);
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        return this.requireCoordination().then(({ coordinator }) =>
          coordinator.steer(
            view.handle,
            command.conversationId,
            command.runId,
            command.text,
          )
        ).then(() => {
          this.emitCommandComplete(command);
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "compact_context") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          return Promise.reject(
            new Error("Command ID was already used on this connection"),
          );
        }
        this.usedCommandIds.add(command.commandId);
        const generation = this.generation;
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        return this.requireCoordination().then(({ coordinator }) =>
          coordinator.compactContext(
            view.handle,
            command.conversationId,
          )
        ).then(() => {
          if (!this.isCoordinatedSession(command.sessionId, generation)) return;
          const current = this.coordinatedView;
          if (
            current === view
            && current.conversationId === command.conversationId
          ) {
            this.publishCoordinatedState();
            this.publishFocusedConversationSnapshot();
          }
          this.emitCommandComplete(command);
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "switch_conversation_role") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          return Promise.reject(
            new Error("Command ID was already used on this connection"),
          );
        }
        this.usedCommandIds.add(command.commandId);
        const generation = this.generation;
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        return this.requireCoordination().then(({ coordinator }) =>
          coordinator.switchConversationRole(
            view.handle,
            command.conversationId,
            command.roleId,
          )
        ).then(() => {
          if (!this.isCoordinatedSession(command.sessionId, generation)) return;
          const current = this.coordinatedView;
          if (
            current === view
            && current.conversationId === command.conversationId
          ) {
            this.publishCoordinatedState();
            this.publishProjectSnapshotCoordinated();
            this.publishFocusedConversationSnapshot();
          }
          this.emitCommandComplete(command);
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "initialize") {
      return this.beginCoordinatedInitialization(command);
    }

    if (command.type === "refresh_models" && this.manualRefresh) {
      return Promise.reject(new Error("A model refresh is already pending"));
    }
    const commandId = "commandId" in command
      ? command.commandId
      : undefined;
    if (commandId !== undefined) {
      if (this.usedCommandIds.has(commandId)) {
        return Promise.reject(
          new Error("Command ID was already used on this connection"),
        );
      }
      this.usedCommandIds.add(commandId);
    }
    const manualRefresh = command.type === "refresh_models"
      ? this.startManualRefresh()
      : undefined;
    if (command.type === "login_oauth") {
      if (this.usedAuthFlowIds.has(command.authFlowId)) {
        return Promise.reject(
          new Error("Auth flow ID was already used on this connection"),
        );
      }
      this.cancelAuth();
      this.usedAuthFlowIds.add(command.authFlowId);
      this.pendingAuthFlowIds.add(command.authFlowId);
    }

    const generation = this.generation;
    this.admitCredentialIntent(command, generation, true);
    let transitionAbort: AbortController | undefined;
    if (
      command.type === "focus_conversation"
      || command.type === "create_conversation"
    ) {
      this.cancelCoordinatedTransition();
      transitionAbort = new AbortController();
      this.coordinatedTransitionAbort = transitionAbort;
    }
    const operation = this.operations.run(async () => {
      try {
        this.assertOpen();
        if (transitionAbort?.signal.aborted) return;
        if (
          "sessionId" in command
          && !this.isCoordinatedSession(command.sessionId, generation)
        ) {
          throw new Error("Session was not initialized");
        }
        if (
          command.type === "login_oauth"
          && this.cancelledAuthFlowIds.has(command.authFlowId)
        ) {
          return;
        }
        if (manualRefresh?.cancelled || manualRefresh?.timedOut) return;
        await this.executeCoordinated(command, transitionAbort, manualRefresh);
      } finally {
        if (this.coordinatedTransitionAbort === transitionAbort) {
          this.coordinatedTransitionAbort = undefined;
        }
        if (command.type === "login_oauth") {
          this.pendingAuthFlowIds.delete(command.authFlowId);
          this.cancelledAuthFlowIds.delete(command.authFlowId);
        }
        this.credentialIntents.delete(command);
      }
    });
    return manualRefresh
      ? this.observeManualRefresh(operation, manualRefresh)
      : operation;
  }

  private beginCoordinatedInitialization(
    command: Extract<ClientCommand, { type: "initialize" }>,
  ): Promise<void> {
    if (this.usedSessionIds.has(command.sessionId)) {
      return Promise.reject(
        new Error("Session ID was already used on this connection"),
      );
    }
    if (command.commandId !== undefined) {
      if (this.usedCommandIds.has(command.commandId)) {
        return Promise.reject(
          new Error("Command ID was already used on this connection"),
        );
      }
      this.usedCommandIds.add(command.commandId);
    }

    this.cancelManualRefresh("Model refresh cancelled by connection lifecycle");
    this.cancelCoordinatedTransition();
    this.coordinatedView?.extensionAbort.abort();
    this.initializationAbort?.abort();
    const initializationAbort = new AbortController();
    this.initializationAbort = initializationAbort;
    this.usedSessionIds.add(command.sessionId);
    this.runIdsBySession.set(command.sessionId, new Set());
    const generation = ++this.generation;
    this.requestedSessionId = command.sessionId;
    this.cancelAuth();

    return this.operations.run(async () => {
      this.assertOpen();
      if (generation !== this.generation) return;
      await this.detachCoordinatedView();
      try {
        await this.initializeCoordinated(
          command,
          generation,
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
        this.requestedSessionId = undefined;
        await this.detachCoordinatedView();
        throw error;
      } finally {
        if (this.initializationAbort === initializationAbort) {
          this.initializationAbort = undefined;
        }
      }
    });
  }

  private async initializeCoordinated(
    command: Extract<ClientCommand, { type: "initialize" }>,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const cwd = await validateCwd(command.cwd);
    this.throwIfAborted(signal);
    const { coordinator } = await this.requireCoordination();
    this.throwIfAborted(signal);
    const handle = await coordinator.acquireProject(cwd, "read_only");
    let transferred = false;
    let extensionScope: number | undefined;
    const extensionAbort = new AbortController();
    const abortExtensions = () => extensionAbort.abort();
    signal.addEventListener("abort", abortExtensions, { once: true });
    if (signal.aborted) extensionAbort.abort();
    let unsubscribeProject: (() => void) | undefined;
    let unsubscribeRecentSeed: (() => void) | undefined;
    let unsubscribeExtensionUI: (() => void) | undefined;
    let createdConversationId: string | undefined;
    let initialRecentConversations: ConversationSummary[] | undefined;
    let recentSeedInvalidated = false;
    try {
      this.throwIfAborted(signal);

      const target = command.conversation ?? { kind: "recent" as const };
      extensionScope = ++this.extensionScope;
      const extensionUI = this.extensionUI.context({
        sessionId: command.sessionId,
        generation: extensionScope,
        signal: extensionAbort.signal,
      });
      await coordinator.ensureProjectModelCatalog(handle, extensionUI);
      this.throwIfAborted(signal);
      let actor: ConversationActor | undefined;
      if (target.kind === "open") {
        unsubscribeExtensionUI = coordinator.attachExtensionUI(
          handle,
          target.conversationId,
          extensionUI,
        );
        actor = await coordinator.openConversation(
          handle,
          target.conversationId,
        );
      } else if (target.kind === "new") {
        if (!target.roleId) {
          throw new Error(
            "A role must be selected before creating a conversation",
          );
        }
        actor = await coordinator.createUserConversation(handle, {
          roleId: target.roleId,
          extensionUI,
          signal: extensionAbort.signal,
        });
        createdConversationId = actor.conversationId;
        unsubscribeExtensionUI = coordinator.attachExtensionUI(
          handle,
          actor.conversationId,
          extensionUI,
        );
      } else {
        // Subscribe before the one fresh integrity scan: promise settlement is
        // itself a handoff boundary where an actor mutation could otherwise be
        // missed. A mutation during the scan may cause one harmless refresh.
        unsubscribeRecentSeed = coordinator.subscribe(handle, (event) => {
          if (event.type !== "project_changed") recentSeedInvalidated = true;
        });
        const recentSeed = await coordinator.listSessions(handle);
        const knownIds = new Set(recentSeed.map(({ id }) => id));
        const conversationId = handle.project.lastConversationId
          && knownIds.has(handle.project.lastConversationId)
          ? handle.project.lastConversationId
          : recentSeed[0]?.id;
        if (conversationId !== undefined) {
          unsubscribeExtensionUI = coordinator.attachExtensionUI(
            handle,
            conversationId,
            extensionUI,
          );
          actor = await coordinator.openConversation(handle, conversationId);
        }
        initialRecentConversations =
          coordinator.projectSessionsFromCurrentIndex(handle);
      }
      this.throwIfAborted(signal);
      if (
        this.disposed
        || generation !== this.generation
        || this.requestedSessionId !== command.sessionId
      ) {
        return;
      }

      const view: CoordinatedProjectView = {
        sessionId: command.sessionId,
        generation,
        extensionScope,
        extensionAbort,
        coordinator,
        handle,
        unsubscribeProject: () => undefined,
        unsubscribeExtensionUI: unsubscribeExtensionUI ?? (() => undefined),
        seenMessageCounts: new Map(),
        unreadConversationIds: new Set(),
        projectSnapshotInitialized: false,
        ...(actor === undefined
          ? {}
          : {
              actor,
              conversationId: actor.conversationId,
              focusId: randomUUID(),
            }),
      };
      unsubscribeProject = coordinator.subscribe(handle, (event) => {
        this.onCoordinatedProjectEvent(view, event);
      });
      view.unsubscribeProject = unsubscribeProject;
      this.coordinatedView = view;
      transferred = true;
      unsubscribeRecentSeed?.();
      unsubscribeRecentSeed = undefined;
      if (command.commandId !== undefined) {
        this.emitFocusAttached(
          view,
          "initialize",
          command.commandId,
        );
      }
      this.publishCoordinatedState();
      if (initialRecentConversations !== undefined && !recentSeedInvalidated) {
        this.emitProjectSnapshot(view, initialRecentConversations);
      } else {
        this.publishProjectSnapshotCoordinated();
      }
      this.publishRoleCatalog();
      this.publishFocusedConversationSnapshot();
    } finally {
      signal.removeEventListener("abort", abortExtensions);
      unsubscribeRecentSeed?.();
      if (!transferred) {
        extensionAbort.abort();
        unsubscribeExtensionUI?.();
        unsubscribeProject?.();
        if (extensionScope !== undefined) {
          this.extensionUI.cancelScope(command.sessionId, extensionScope);
        }
        let cleanupError: unknown;
        if (createdConversationId) {
          try {
            await coordinator.deleteConversation(
              handle,
              createdConversationId,
            );
          } catch (error) {
            cleanupError = error;
          }
        }
        handle.release();
        if (cleanupError !== undefined) throw cleanupError;
      }
    }
  }

  private async executeCoordinated(
    command: Exclude<
      ConnectionCommand,
      | { type: "abort" }
      | { type: "auth_response" }
      | { type: "cancel_auth" }
      | { type: "close_session" }
      | { type: "compact_context" }
      | { type: "extension_ui_response" }
      | { type: "initialize" }
      | { type: "prompt" }
      | { type: "refresh_view" }
      | { type: "steer" }
      | { type: "switch_conversation_role" }
    >,
    transitionAbort?: AbortController,
    manualRefresh?: ManualModelRefresh,
  ): Promise<void> {
    if ((command as { type: string }).type === "set_tool_mode") {
      const legacy = command as unknown as LegacySetToolModeCommand;
      const view = this.requireCoordinatedView(legacy.sessionId);
      await this.projectRuns.transitionToolMode(
        view.handle.project,
        legacy.mode,
      );
      this.publishCoordinatedState();
      this.publishProjectSnapshotCoordinated();
      return;
    }
    switch (command.type) {
      case "focus_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        const extensionScope = ++this.extensionScope;
        const extensionAbort = transitionAbort ?? new AbortController();
        let detachExtensionUI: (() => void) | undefined;
        let transferred = false;
        try {
          detachExtensionUI = coordinator.attachExtensionUI(
            view.handle,
            command.conversationId,
            this.extensionUI.context({
              sessionId: view.sessionId,
              generation: extensionScope,
              signal: extensionAbort.signal,
            }),
          );
          const actor = await coordinator.openConversation(
            view.handle,
            command.conversationId,
            { updateRecent: false },
          );
          if (
            extensionAbort.signal.aborted
            || this.coordinatedView !== view
          ) return;
          this.attachCoordinatedFocus(
            view,
            actor,
            "focus_conversation",
            command.commandId,
            detachExtensionUI,
            extensionScope,
            extensionAbort,
          );
          transferred = true;
        } catch (error) {
          if (
            extensionAbort.signal.aborted
            && error instanceof Error
            && error.name === "AbortError"
          ) return;
          throw error;
        } finally {
          if (!transferred) {
            detachExtensionUI?.();
            this.extensionUI.cancelScope(view.sessionId, extensionScope);
          }
        }
        return;
      }
      case "create_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        const extensionScope = ++this.extensionScope;
        const extensionAbort = transitionAbort ?? new AbortController();
        const extensionUI = this.extensionUI.context({
          sessionId: view.sessionId,
          generation: extensionScope,
          signal: extensionAbort.signal,
        });
        let detachExtensionUI: (() => void) | undefined;
        let createdConversationId: string | undefined;
        let transferred = false;
        try {
          const actor = await coordinator.createUserConversation(view.handle, {
            roleId: command.roleId,
            ...(command.title === undefined ? {} : { title: command.title }),
            extensionUI,
            signal: extensionAbort.signal,
          });
          createdConversationId = actor.conversationId;
          if (
            extensionAbort.signal.aborted
            || this.coordinatedView !== view
          ) return;
          detachExtensionUI = coordinator.attachExtensionUI(
            view.handle,
            actor.conversationId,
            extensionUI,
          );
          this.attachCoordinatedFocus(
            view,
            actor,
            "create_conversation",
            command.commandId,
            detachExtensionUI,
            extensionScope,
            extensionAbort,
          );
          transferred = true;
        } catch (error) {
          if (
            extensionAbort.signal.aborted
            && error instanceof Error
            && error.name === "AbortError"
          ) return;
          throw error;
        } finally {
          if (!transferred) {
            detachExtensionUI?.();
            this.extensionUI.cancelScope(view.sessionId, extensionScope);
            if (createdConversationId) {
              await coordinator.deleteConversation(
                view.handle,
                createdConversationId,
              );
            }
          }
        }
        return;
      }
      case "select_model":
        throw new Error(
          "Conversation model is fixed by its role and cannot be changed",
        );
      case "set_thinking":
        await this.setCoordinatedThinking(command.level);
        return;
      case "set_compaction_threshold": {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        const { coordinator } = await this.requireCoordination();
        coordinator.setCompactionThreshold(
          view.handle,
          command.conversationId,
          command.percent,
        );
        this.emitCommandComplete(command);
        return;
      }
      case "rename_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        await coordinator.renameConversation(
          view.handle,
          command.conversationId,
          command.name,
        );
        this.publishCoordinatedState();
        this.publishProjectSnapshotCoordinated();
        return;
      }
      case "delete_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        await coordinator.deleteConversation(
          view.handle,
          command.conversationId,
        );
        if (view.conversationId === command.conversationId) {
          this.extensionUI.cancelScope(
            view.sessionId,
            view.extensionScope,
          );
          view.unsubscribeExtensionUI();
          view.unsubscribeExtensionUI = () => undefined;
          view.actor = undefined;
          view.conversationId = undefined;
          view.focusId = undefined;
          this.focusedItemFingerprints.clear();
          this.publishCoordinatedState();
        }
        this.publishProjectSnapshotCoordinated();
        this.emitCommandComplete(command);
        return;
      }
      case "truncate_conversation": {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        const { coordinator } = await this.requireCoordination();
        const entryId = command.messageId.startsWith("assistant:")
          ? command.messageId.slice("assistant:".length)
          : command.messageId;
        await coordinator.truncateConversation(
          view.handle,
          command.conversationId,
          entryId,
        );
        this.publishCoordinatedState();
        this.publishProjectSnapshotCoordinated();
        this.publishFocusedConversationSnapshot();
        this.emitCommandComplete(command);
        return;
      }
      case "create_role": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator, roles } = await this.requireCoordination();
        await roles.createRole(
          command.role,
          view.actor?.modelRegistry
            ?? coordinator.modelRegistryForProject(view.handle),
        );
        this.publishRoleCatalog();
        this.emitCommandComplete(command);
        return;
      }
      case "update_role": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator, roles } = await this.requireCoordination();
        await roles.updateRole(
          command.roleId,
          command.expectedRevision,
          command.expectedSystemPrompt,
          command.role,
          view.actor?.modelRegistry
            ?? coordinator.modelRegistryForProject(view.handle),
        );
        this.publishRoleCatalog();
        this.emitCommandComplete(command);
        return;
      }
      case "delete_role": {
        const { roles } = await this.requireCoordination();
        await roles.deleteRole(
          command.roleId,
          command.expectedRevision,
        );
        this.publishRoleCatalog();
        this.emitCommandComplete(command);
        return;
      }
      case "set_api_key":
        await this.setApiKey(
          command.provider,
          command.key,
          this.takeCredentialIntent(command),
        );
        this.emitCommandComplete(command);
        return;
      case "login_oauth":
        await this.loginOAuth(
          command.provider,
          command.authFlowId,
          this.takeCredentialIntent(command),
        );
        return;
      case "logout":
        await this.logout(command.provider, this.takeCredentialIntent(command));
        return;
      case "refresh_models":
        await this.refreshModels(manualRefresh);
        this.emitCommandComplete(command);
        return;
      default:
        return assertNever(command);
    }
  }

  private requireCoordination(): Promise<PiConnectionCoordination> {
    this.assertOpen();
    if (!this.coordinationProvider) {
      return Promise.reject(
        new Error("Project session coordination is unavailable"),
      );
    }
    this.coordinationReady ??= this.coordinationProvider().then(
      (coordination) => {
        if (this.disposed) {
          throw new Error("Connection is closed");
        }
        this.unsubscribeRoles ??= coordination.roles.subscribe(() => {
          this.publishRoleCatalog();
        });
        this.unsubscribeProjectActivity ??=
          coordination.coordinator.subscribeProjectActivity((snapshot) => {
            if (this.disposed) return;
            this.emit({
              type: "project_activity_snapshot",
              projects: [...snapshot.projects],
              truncated: snapshot.truncated,
            });
          });
        return coordination;
      },
    );
    return this.coordinationReady;
  }

  private attachCoordinatedFocus(
    view: CoordinatedProjectView,
    actor: ConversationActor,
    operation: "focus_conversation" | "create_conversation",
    commandId: string,
    unsubscribeExtensionUI: () => void,
    extensionScope: number,
    extensionAbort: AbortController,
  ): void {
    if (this.coordinatedView !== view) {
      throw new Error("Project observation changed before focus attached");
    }
    view.extensionAbort.abort();
    this.extensionUI.cancelScope(view.sessionId, view.extensionScope);
    view.unsubscribeExtensionUI();
    view.unsubscribeExtensionUI = unsubscribeExtensionUI;
    view.extensionScope = extensionScope;
    view.extensionAbort = extensionAbort;
    view.actor = actor;
    view.conversationId = actor.conversationId;
    view.focusId = randomUUID();
    view.unreadConversationIds.delete(actor.conversationId);
    this.focusedItemFingerprints.clear();
    this.emitFocusAttached(view, operation, commandId);
    this.publishCoordinatedState();
    this.publishFocusedConversationSnapshot();
    if (operation === "focus_conversation") {
      const attachedFocusId = view.focusId;
      if (attachedFocusId === undefined) {
        throw new Error("Focus identity was not assigned before recent update");
      }
      void view.coordinator.markConversationRecentInBackground(view.handle, actor)
        .catch((error) => {
          if (
            !this.isCurrentCoordinatedView(view)
            || view.actor !== actor
            || view.conversationId !== actor.conversationId
            || view.focusId !== attachedFocusId
          ) return;
          this.emitError(
            "session",
            `会话已切换，但最近会话位置未保存：${this.errorMessage(error)}`,
            view.sessionId,
          );
        });
    }
    this.publishProjectSnapshotCoordinated();
    this.publishRoleCatalog();
  }

  private emitFocusAttached(
    view: CoordinatedProjectView,
    operation: FocusAttachedOperation,
    commandId: string,
  ): void {
    if (this.coordinatedView !== view || this.disposed) return;
    this.emit({
      type: "focus_attached",
      operation,
      commandId,
      sessionId: view.sessionId,
      projectId: view.handle.project.id,
      ...(view.conversationId === undefined || view.focusId === undefined
        ? {}
        : {
            conversationId: view.conversationId,
            focusId: view.focusId,
          }),
    });
  }

  private emitCommandComplete(
    command: Extract<ClientCommand, { type: AcknowledgedCommandOperation }>,
  ): void {
    this.emit({
      type: "command_complete",
      operation: command.type,
      commandId: command.commandId,
      sessionId: command.sessionId,
    });
  }

  private onCoordinatedProjectEvent(
    view: CoordinatedProjectView,
    event: ProjectSessionCoordinatorEvent,
  ): void {
    if (this.coordinatedView !== view || this.disposed) return;
    if (event.type === "project_changed") {
      if (view.actor?.getState().disposed === true) {
        const deleted = view.conversationId !== undefined
          && !view.handle.project.listConversations().some(
            ({ id }) => id === view.conversationId,
          );
        if (deleted) {
          const conversationId = view.conversationId;
          const focusId = view.focusId;
          if (conversationId !== undefined && focusId !== undefined) {
            this.extensionUI.cancelScope(
              view.sessionId,
              view.extensionScope,
            );
            view.unsubscribeExtensionUI();
            view.unsubscribeExtensionUI = () => undefined;
            view.actor = undefined;
            view.conversationId = undefined;
            view.focusId = undefined;
            this.focusedItemFingerprints.clear();
            this.emit({
              type: "focus_invalidated",
              sessionId: view.sessionId,
              projectId: view.handle.project.id,
              conversationId,
              focusId,
              reason: "deleted",
            });
            this.publishCoordinatedState();
          }
        }
      } else {
        this.publishCoordinatedState();
        this.publishFocusedConversationItems();
      }
      this.publishProjectSnapshotCoordinated();
      return;
    }

    if (event.type === "prompt_admitted" || event.type === "prompt_delivered") {
      if (event.conversationId === view.conversationId && view.focusId !== undefined) {
        if (event.type === "prompt_admitted") {
          this.emit({
            type: "prompt_admitted",
            sessionId: view.sessionId,
            conversationId: event.conversationId,
            focusId: view.focusId,
            promptId: event.promptId,
            text: event.text,
          });
        } else {
          this.emit({
            type: "prompt_delivered",
            sessionId: view.sessionId,
            conversationId: event.conversationId,
            focusId: view.focusId,
            promptId: event.promptId,
            runId: event.runId,
          });
        }
      }
      return;
    }

    if (event.type === "completion") {
      this.emit({
        type: "conversation_run_settled",
        sessionId: view.sessionId,
        projectId: view.handle.project.id,
        conversationId: event.conversationId,
        runId: event.settlement.runId,
        outcome: event.settlement.outcome,
        createdBy: structuredClone(event.createdBy),
      });
    }

    const focused = event.conversationId === view.conversationId
      && view.focusId !== undefined;
    if (
      !focused
      && (event.type === "completion" || event.type === "error")
    ) {
      view.unreadConversationIds.add(event.conversationId);
    }
    if (
      event.type === "session_event"
      && focused
      && view.focusId !== undefined
    ) {
      this.emit({
        type: "session_event",
        sessionId: view.sessionId,
        conversationId: event.conversationId,
        focusId: view.focusId,
        runId: event.runId,
        projectionSeq: event.projectionSeq,
        event: event.event,
      });
    } else if (event.type === "error" && focused) {
      this.emit({
        type: "error",
        scope: "session",
        sessionId: view.sessionId,
        conversationId: event.conversationId,
        focusId: view.focusId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        message: event.message,
      });
    }
    if (
      event.type === "activity"
      || event.type === "completion"
      || event.type === "error"
    ) {
      this.publishProjectSnapshotCoordinated();
    }
    if (focused && event.type !== "session_event") {
      this.publishCoordinatedState();
    }
    if (focused && event.type === "completion") {
      this.publishFocusedConversationSnapshot();
    }
  }

  private publishCoordinatedState(): void {
    const view = this.coordinatedView;
    if (
      this.disposed
      || !view
      || view.sessionId !== this.requestedSessionId
      || view.generation !== this.generation
    ) {
      return;
    }
    this.emit({ type: "state", state: this.coordinatedState(view) });
  }

  private coordinatedState(view: CoordinatedProjectView): PublicState {
    const actor = view.actor;
    const activity = actor?.getActivity() ?? { kind: "idle" as const };
    const registry = actor?.modelRegistry
      ?? view.coordinator.modelRegistryForProject(view.handle);
    const available = registry.getAvailable();
    const oauthProviders = this.visibleOAuthProviders();
    const base: PublicState = {
      sessionId: view.sessionId,
      projectId: view.handle.project.id,
      cwd: view.handle.project.cwd,
      busy: activity.kind !== "idle",
      ...(actor === undefined
        ? {}
        : {
            conversationId: actor.conversationId,
            focusId: view.focusId,
            conversationName:
              actor.sessionManager.getSessionName() ?? undefined,
            selectedModel: actor.session.model
              && registry.hasConfiguredAuth(actor.session.model)
              ? {
                  provider: actor.session.model.provider,
                  id: actor.session.model.id,
                }
              : undefined,
            compacting: actor.isCompacting(),
          }),
      ...(activity.kind === "idle"
        ? {}
        : {
            activeRun: this.publicActiveRun(activity),
          }),
      thinkingLevel: (
        actor?.session.thinkingLevel ?? "off"
      ) as ThinkingLevel,
      toolMode: actor?.profile.role.toolMode ?? "read_only",
      availableThinkingLevels: (
        actor?.session.getAvailableThinkingLevels() ?? ["off"]
      ) as ThinkingLevel[],
      providers: buildPublicProviders({
        models: registry.getAll(),
        registeredProviderIds: registry.getRegisteredProviderIds(),
        availableKeys: new Set(
          available.map((model) => `${model.provider}/${model.id}`),
        ),
        oauthProviders,
        displayName: (provider) =>
          registry.getProviderDisplayName(provider),
        authStatus: (provider) =>
          registry.getProviderAuthStatus(provider),
      }),
      registryError: registry.getError(),
    };
    if (!actor) return base;

    const stats = actor.session.getSessionStats();
    const contextUsage = resolveContextUsage({
      contextWindow: actor.session.model?.contextWindow ?? null,
      messages: actor.session.messages,
      nativeUsage: stats.contextUsage,
    });
    return {
      ...base,
      sessionTokenUsage: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
      },
      contextUsage,
      compactionThresholdPercent: actor.getCompactionThresholdPercent(),
    };
  }

  private publicActiveRun(
    activity: Exclude<ConversationActivity, { kind: "idle" }>,
  ): NonNullable<PublicState["activeRun"]> {
    if (activity.kind !== "waiting") {
      return {
        id: activity.runId,
        phase: activity.kind,
      };
    }
    return {
      id: activity.runId,
      phase: "waiting",
      waitingFor: {
        conversationId: activity.targetConversationId,
        runId: activity.targetRunId,
      },
    };
  }

  private publishProjectSnapshotCoordinated(): void {
    const view = this.coordinatedView;
    if (
      this.disposed
      || !view
      || view.sessionId !== this.requestedSessionId
      || view.generation !== this.generation
    ) {
      return;
    }
    const existing = this.projectSnapshotRefresh;
    if (existing?.view === view) {
      existing.trailing = true;
      return;
    }
    const refresh: ProjectSnapshotRefresh = { view, trailing: false };
    this.projectSnapshotRefresh = refresh;
    void this.runProjectSnapshotRefresh(refresh);
  }

  private async runProjectSnapshotRefresh(
    refresh: ProjectSnapshotRefresh,
  ): Promise<void> {
    const view = refresh.view;
    let latestError: unknown;
    let latestFailed = false;
    try {
      do {
        refresh.trailing = false;
        latestFailed = false;
        try {
          const conversations = await view.coordinator.listSessions(
            view.handle,
          );
          if (!this.isCurrentCoordinatedView(view)) return;
          if (refresh.trailing) continue;
          this.emitProjectSnapshot(view, conversations);
        } catch (error) {
          latestError = error;
          latestFailed = true;
        }
      } while (
        refresh.trailing
        && this.isCurrentCoordinatedView(view)
      );
      if (latestFailed && this.isCurrentCoordinatedView(view)) {
        this.emitError("session", latestError, view.sessionId);
      }
    } finally {
      if (this.projectSnapshotRefresh === refresh) {
        this.projectSnapshotRefresh = undefined;
      }
    }
  }

  private emitProjectSnapshot(
    view: CoordinatedProjectView,
    conversations: ConversationSummary[],
  ): void {
    const liveConversationIds = new Set(
      conversations.map(({ id }) => id),
    );
    for (const conversation of conversations) {
      const previousCount = view.seenMessageCounts.get(conversation.id);
      if (conversation.id === view.conversationId) {
        view.unreadConversationIds.delete(conversation.id);
      } else if (
        previousCount !== undefined
          ? conversation.messageCount > previousCount
          : view.projectSnapshotInitialized && conversation.messageCount > 0
      ) {
        view.unreadConversationIds.add(conversation.id);
      }
      view.seenMessageCounts.set(
        conversation.id,
        conversation.messageCount,
      );
    }
    for (const conversationId of view.seenMessageCounts.keys()) {
      if (liveConversationIds.has(conversationId)) continue;
      view.seenMessageCounts.delete(conversationId);
      view.unreadConversationIds.delete(conversationId);
    }
    view.projectSnapshotInitialized = true;
    this.emit(boundedProjectSnapshotEvent({
      sessionId: view.sessionId,
      projectId: view.handle.project.id,
      conversations: conversations.map((conversation) => ({
        ...conversation,
        unread: view.unreadConversationIds.has(conversation.id),
      })),
      ...(view.conversationId === undefined
        ? {}
        : { conversationId: view.conversationId }),
    }));
  }

  private publishRoleCatalog(): void {
    const view = this.coordinatedView;
    if (!view || !this.isCurrentCoordinatedView(view)) return;
    void this.requireCoordination().then(({ coordinator }) => {
      if (!this.isCurrentCoordinatedView(view)) return;
      this.emit({
        type: "role_catalog_snapshot",
        sessionId: view.sessionId,
        projectId: view.handle.project.id,
        roles: coordinator.listRoles(
          view.actor?.modelRegistry
            ?? coordinator.modelRegistryForProject(view.handle),
        ),
      });
    }).catch((error) => {
      if (this.isCurrentCoordinatedView(view)) {
        this.emitError("settings", error, view.sessionId);
      }
    });
  }

  private publishFocusedConversationSnapshot(): void {
    const view = this.coordinatedView;
    const actor = view?.actor;
    if (
      this.disposed
      || !view
      || !actor
      || view.conversationId !== actor.conversationId
      || view.focusId === undefined
    ) {
      return;
    }
    try {
      const projection = actor.projectConversationItems((items) => (
        projectConversationPeers(
          items,
          view.handle.project.listConversations(),
        )
      ));
      const items = projection.items;
      this.focusedItemFingerprints.clear();
      for (const item of items) {
        this.focusedItemFingerprints.set(item.id, JSON.stringify(item));
      }
      this.emit({
        type: "conversation_snapshot",
        sessionId: view.sessionId,
        conversationId: actor.conversationId,
        focusId: view.focusId,
        role: actor.profile.role,
        projectionSeq: projection.projectionSeq,
        items,
        pendingPrompts: actor.pendingPromptAdmissions().map((admission) => ({
          promptId: admission.promptId,
          text: admission.text,
        })),
        window: projection.window,
      });
    } catch (error) {
      this.emitError("session", error, view.sessionId);
    }
  }

  private publishFocusedConversationItems(): void {
    const view = this.coordinatedView;
    const actor = view?.actor;
    if (
      this.disposed
      || !view
      || !actor
      || view.conversationId !== actor.conversationId
      || view.focusId === undefined
    ) {
      return;
    }
    try {
      const projection = actor.projectConversationItems((items) => (
        projectConversationPeers(
          items,
          view.handle.project.listConversations(),
        )
      ));
      const items = projection.items;
      const currentIds = new Set(items.map((item) => item.id));
      const omittedPreviousItem = [...this.focusedItemFingerprints.keys()]
        .some((id) => !currentIds.has(id));
      if (omittedPreviousItem) {
        // An item upsert cannot remove a newly-evicted window member. Rehydrate
        // the exact bounded window instead of leaving stale client history.
        this.publishFocusedConversationSnapshot();
        return;
      }
      for (const item of items) {
        if (item.kind !== "session_message") continue;
        const fingerprint = JSON.stringify(item);
        if (this.focusedItemFingerprints.get(item.id) === fingerprint) {
          continue;
        }
        this.focusedItemFingerprints.set(item.id, fingerprint);
        this.emit({
          type: "conversation_item",
          sessionId: view.sessionId,
          conversationId: actor.conversationId,
          focusId: view.focusId,
          projectionSeq: projection.projectionSeq,
          item,
        });
      }
    } catch (error) {
      this.emitError("session", error, view.sessionId);
    }
  }

  private async setCoordinatedThinking(
    level: ThinkingLevel,
  ): Promise<void> {
    const view = this.requireCoordinatedView();
    const actor = view.actor;
    if (!actor) throw new Error("Choose a conversation first");
    const previousLevel = actor.session.thinkingLevel;
    let partialFailure: unknown;
    try {
      actor.session.setThinkingLevel(level);
    } catch (error) {
      if (actor.session.thinkingLevel === previousLevel) throw error;
      partialFailure = error;
    }
    const failures = await this.flushActorSettings(actor);
    this.publishCoordinatedState();
    for (const failure of failures) {
      this.emitError("settings", failure, view.sessionId);
    }
    if (partialFailure) {
      this.emitError(
        "settings",
        `思考级别已用于当前会话，但会话记录或默认设置可能未保存：${
          this.errorMessage(partialFailure)
        }`,
        view.sessionId,
      );
    }
  }

  private async flushActorSettings(
    actor: ConversationActor,
  ): Promise<unknown[]> {
    let failure: unknown;
    try {
      await actor.settings.flush();
    } catch (error) {
      failure = error;
    }
    const failures: unknown[] = [];
    const reported = new Set<unknown>();
    for (const item of actor.settings.drainErrors()) {
      reported.add(item.error);
      failures.push(item.error);
    }
    if (failure && !reported.has(failure)) failures.push(failure);
    return failures;
  }

  private requireCoordinatedView(
    sessionId?: string,
  ): CoordinatedProjectView {
    const view = this.coordinatedView;
    if (
      !view
      || view.generation !== this.generation
      || view.sessionId !== this.requestedSessionId
      || (sessionId !== undefined && view.sessionId !== sessionId)
    ) {
      throw new Error("Session was not initialized");
    }
    return view;
  }

  private isCurrentCoordinatedView(view: CoordinatedProjectView): boolean {
    return !this.disposed
      && this.coordinatedView === view
      && view.sessionId === this.requestedSessionId
      && view.generation === this.generation;
  }

  private refreshCoordinatedView(
    command: Extract<ClientCommand, { type: "refresh_view" }>,
  ): void {
    const view = this.coordinatedView;
    if (
      !view
      || !this.isCurrentCoordinatedView(view)
      || view.sessionId !== command.sessionId
      || view.handle.project.id !== command.projectId
      || view.conversationId !== command.conversationId
      || view.focusId !== command.focusId
    ) {
      return;
    }
    this.publishCoordinatedState();
    this.publishRoleCatalog();
    this.publishProjectSnapshotCoordinated();
    if (view.actor && !view.actor.isCompacting()) {
      this.publishFocusedConversationSnapshot();
    }
  }

  private refreshLegacyView(
    command: Extract<ClientCommand, { type: "refresh_view" }>,
  ): void {
    const active = this.active;
    if (
      !active
      || active.id !== this.requestedSessionId
      || active.generation !== this.generation
      || active.id !== command.sessionId
      || active.project.id !== command.projectId
      || active.conversationId !== command.conversationId
      || active.focusId !== command.focusId
    ) {
      return;
    }
    this.publishState();
    this.publishProjectSnapshot();
    if (this.activeRun) return;
    const history = projectConversationHistorySnapshot(active.sessionManager);
    this.emit({
      type: "conversation_snapshot",
      sessionId: active.id,
      conversationId: active.conversationId,
      focusId: active.focusId,
      messages: history.messages,
      window: history.window,
    });
  }

  private requireCoordinatedFocus(
    sessionId: string,
    conversationId: string,
    focusId: string,
  ): CoordinatedProjectView {
    const view = this.requireCoordinatedView(sessionId);
    if (
      !view.actor
      || view.conversationId !== conversationId
      || view.focusId !== focusId
    ) {
      throw new Error("Conversation focus is stale or no longer attached");
    }
    return view;
  }

  private isCoordinatedSession(
    sessionId: string,
    generation: number,
  ): boolean {
    const view = this.coordinatedView;
    return !this.disposed
      && this.requestedSessionId === sessionId
      && this.generation === generation
      && view?.sessionId === sessionId
      && view.generation === generation;
  }

  private closeCoordinatedSession(sessionId: string): Promise<void> {
    if (this.requestedSessionId !== sessionId) return Promise.resolve();
    this.cancelManualRefresh("Model refresh cancelled by connection lifecycle");
    this.generation++;
    this.requestedSessionId = undefined;
    this.cancelCoordinatedTransition();
    this.coordinatedView?.extensionAbort.abort();
    this.initializationAbort?.abort();
    this.initializationAbort = undefined;
    this.cancelAuth();
    return this.operations.run(() => this.detachCoordinatedView());
  }

  private async detachCoordinatedView(): Promise<void> {
    const view = this.coordinatedView;
    if (!view) return;
    this.coordinatedView = undefined;
    this.focusedItemFingerprints.clear();
    const failures: unknown[] = [];
    view.extensionAbort.abort();
    this.extensionUI.cancelScope(view.sessionId, view.extensionScope);
    try {
      view.unsubscribeExtensionUI();
    } catch (error) {
      failures.push(error);
    }
    try {
      view.unsubscribeProject();
    } catch (error) {
      failures.push(error);
    }
    try {
      view.handle.release();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to detach project observation",
      );
    }
  }

  private async execute(
    command: QueuedCommand,
    manualRefresh?: ManualModelRefresh,
  ): Promise<void> {
    if ((command as { type: string }).type === "set_tool_mode") {
      const legacy = command as unknown as LegacySetToolModeCommand;
      await this.projectRuns.transitionToolMode(
        this.requireActive().project,
        legacy.mode,
      );
      this.publishState();
      return;
    }
    switch (command.type) {
      case "select_model": return this.selectModel(command.provider, command.modelId);
      case "set_thinking": return this.setThinking(command.level);
      case "set_compaction_threshold":
        throw new Error(
          "set_compaction_threshold requires persistent project coordination",
        );
      case "compact_context":
        throw new Error(
          "compact_context requires persistent project coordination",
        );
      case "switch_conversation_role":
        throw new Error(
          "switch_conversation_role requires persistent project coordination",
        );
      case "rename_conversation":
        return this.renameConversation(command.conversationId, command.name);
      case "delete_conversation":
        return this.deleteConversation(command.conversationId);
      case "truncate_conversation":
        throw new Error(
          "truncate_conversation requires persistent project coordination",
        );
      case "focus_conversation":
      case "create_conversation":
      case "create_role":
      case "update_role":
      case "delete_role":
        throw new Error(`${command.type} is unavailable until project coordination is initialized`);
      case "set_api_key": return this.setApiKey(
        command.provider,
        command.key,
        this.takeCredentialIntent(command),
      );
      case "login_oauth": return this.loginOAuth(
        command.provider,
        command.authFlowId,
        this.takeCredentialIntent(command),
      );
      case "logout": return this.logout(
        command.provider,
        this.takeCredentialIntent(command),
      );
      case "refresh_models": return this.refreshModels(manualRefresh);
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
      conversationId:
        command.conversationId ?? this.active?.conversationId ?? "",
      focusId: command.focusId ?? this.active?.focusId ?? "",
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
      if (this.isExtensionCommand(active.session, command.text)) {
        this.finishRun(ticket, "failed");
        throw new Error(
          "Extension slash commands are not supported until their detached Agent turns can be owned safely",
        );
      }
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
    const active = this.requireActive();
    const model = active.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    const partialFailures: unknown[] = [];
    try {
      await active.session.setModel(model);
    } catch (error) {
      if (active.session.model !== model) throw error;
      partialFailures.push(error);
    }
    const settingsFailures = await this.flushSettings();
    this.publishState();
    for (const failure of settingsFailures) {
      this.emitError("settings", failure, active.id);
    }
    if (partialFailures.length > 0) {
      const details = partialFailures.map((error) => this.errorMessage(error)).join("; ");
      this.emitError(
        "settings",
        `模型已用于当前会话，但会话记录或默认设置可能未保存：${details}`,
        active.id,
      );
    }
  }

  private async setThinking(level: ThinkingLevel): Promise<void> {
    const active = this.requireActive();
    const previousLevel = active.session.thinkingLevel;
    let partialFailure: unknown;
    try {
      active.session.setThinkingLevel(level);
    } catch (error) {
      if (active.session.thinkingLevel === previousLevel) throw error;
      partialFailure = error;
    }
    const settingsFailures = await this.flushSettings();
    this.publishState();
    for (const failure of settingsFailures) {
      this.emitError("settings", failure, active.id);
    }
    if (partialFailure) {
      this.emitError(
        "settings",
        `思考级别已用于当前会话，但会话记录或默认设置可能未保存：${this.errorMessage(partialFailure)}`,
        active.id,
      );
    }
  }

  private async renameConversation(conversationId: string, name: string): Promise<void> {
    const active = this.requireActive();
    if (active.conversationId !== conversationId) {
      throw new Error("Conversation is not active");
    }
    const normalizedName = name.replace(/[\r\n]+/g, " ").trim();
    const partialFailures: unknown[] = [];
    try {
      active.session.setSessionName(name);
    } catch (error) {
      if (active.sessionManager.getSessionName() !== normalizedName) throw error;
      partialFailures.push(error);
    }
    try {
      await active.project.refreshConversations();
    } catch (error) {
      partialFailures.push(error);
    }
    this.publishState();
    if (partialFailures.length > 0) {
      const details = partialFailures.map((error) => this.errorMessage(error)).join("; ");
      this.emitError(
        "settings",
        `对话名称已用于当前会话，但可能未保存到项目历史：${details}`,
        active.id,
      );
    }
  }

  private async deleteConversation(conversationId: string): Promise<void> {
    const active = this.requireActive();
    if (active.conversationId === conversationId) {
      throw new Error("Cannot delete the active conversation");
    }
    const lease = this.projects.acquireConversation(active.cwd, conversationId);
    try {
      await active.project.deleteConversation(conversationId);
    } finally {
      lease.release();
    }
  }

  private async setApiKey(
    provider: string,
    key: string,
    intent: CredentialChangeIntent | undefined,
  ): Promise<void> {
    this.assertKnownProvider(provider);
    if (!intent) throw new Error("Credential change was not admitted");
    const applied = await this.commitCredentialChange(intent, async () => {
      await this.runtime.credentialStore.modify(provider, async () => ({
        type: "api_key",
        key,
      }));
    });
    if (!applied) throw new Error("API key change was superseded by a newer credential change");
  }

  private async loginOAuth(
    provider: string,
    authFlowId: string,
    intent: CredentialChangeIntent | undefined,
  ): Promise<void> {
    const oauth = this.runtime.modelRuntime.getProvider(provider)?.auth.oauth;
    if (!oauth) throw new Error(`OAuth provider not found: ${provider}`);
    if (!intent) throw new Error("Credential change was not admitted");
    this.authFlow?.cancel();
    const flow = new AuthFlowBroker(authFlowId, this.emit);
    this.authFlow = flow;
    const signal = flow.signal;
    try {
      let credential;
      try {
        credential = await oauth.login(flow.interaction);
      } catch (error) {
        if (signal.aborted) return;
        throw new Error("OAuth login failed", { cause: error });
      }
      if (signal.aborted) return;
      let applied: boolean;
      try {
        applied = await this.commitCredentialChange(intent, async () => {
          if (signal.aborted) throw new Error("Authentication cancelled");
          await this.runtime.credentialStore.modify(
            provider,
            async () => credential,
            { signal },
          );
        });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (signal.aborted) return;
      if (!applied) {
        throw new Error("OAuth credential change was superseded by a newer credential change");
      }
      this.emit({ type: "auth_complete", authFlowId, provider });
    } finally {
      if (this.authFlow === flow) this.authFlow = undefined;
    }
  }

  private async logout(
    provider: string,
    intent: CredentialChangeIntent | undefined,
  ): Promise<void> {
    this.assertKnownProvider(provider, true);
    if (!intent) throw new Error("Credential change was not admitted");
    const applied = await this.commitCredentialChange(intent, async () => {
      await this.runtime.credentialStore.delete(provider);
    });
    if (!applied) throw new Error("Logout was superseded by a newer credential change");
  }

  private startManualRefresh(): ManualModelRefresh {
    const controller = new AbortController();
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<never>((_, reject) => {
      rejectCompletion = reject;
    });
    let refresh!: ManualModelRefresh;
    const timer = setTimeout(() => {
      refresh.timedOut = true;
      controller.abort();
      rejectCompletion(new Error("Model refresh timed out; please retry"));
    }, MODEL_REFRESH_TIMEOUT_MS);
    timer.unref?.();
    refresh = {
      controller,
      completion,
      timer,
      timedOut: false,
      cancel: (reason: string) => {
        if (refresh.cancelled || refresh.timedOut) return;
        refresh.cancelled = reason;
        controller.abort();
        rejectCompletion(new Error(reason));
      },
    };
    this.manualRefresh = refresh;
    return refresh;
  }

  private observeManualRefresh(
    operation: Promise<void>,
    refresh: ManualModelRefresh,
  ): Promise<void> {
    const releaseWhenDrained = () => {
      void (refresh.underlying ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
          if (this.manualRefresh === refresh) this.manualRefresh = undefined;
        });
    };
    void operation.then(releaseWhenDrained, releaseWhenDrained);
    return Promise.race([operation, refresh.completion]).finally(() => {
      clearTimeout(refresh.timer);
    });
  }

  private async refreshModels(refresh?: ManualModelRefresh): Promise<void> {
    if (process.env.PI_OFFLINE !== undefined) {
      throw new Error("Model refresh is unavailable while offline");
    }
    if (!refresh) throw new Error("Model refresh was not admitted");
    if (refresh.timedOut) throw new Error("Model refresh timed out; please retry");
    if (refresh.cancelled) throw new Error(refresh.cancelled);
    try {
      const underlying = this.runtime.refreshConfiguration({
        allowNetwork: true,
        force: true,
        signal: refresh.controller.signal,
      });
      refresh.underlying = underlying;
      // The caller may settle on timeout/cancellation while SDK refresh keeps
      // running. Always observe its eventual rejection.
      void underlying.catch(() => undefined);
      await Promise.race([underlying, refresh.completion]);
    } catch (error) {
      if (refresh.timedOut) throw new Error("Model refresh timed out; please retry");
      if (refresh.cancelled) throw new Error(refresh.cancelled);
      throw error;
    }
  }

  private cancelManualRefresh(reason: string): void {
    this.manualRefresh?.cancel(reason);
  }

  private async commitCredentialChange(
    intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    return this.runtime.commitCredentialChange(intent, change);
  }

  private admitCredentialIntent(
    command: ConnectionCommand,
    generation: number,
    coordinated: boolean,
  ): void {
    if (this.disposed) return;
    let provider: string | undefined;
    let includeOAuth = false;
    switch (command.type) {
      case "set_api_key":
        if (
          !(
            coordinated
              ? this.isCoordinatedSession(command.sessionId, generation)
              : this.isActiveSession(command.sessionId, generation)
          )
        ) return;
        provider = command.provider;
        break;
      case "login_oauth":
        provider = command.provider;
        includeOAuth = true;
        break;
      case "logout":
        provider = command.provider;
        includeOAuth = true;
        break;
      default:
        return;
    }
    if (!this.isKnownProvider(provider, includeOAuth)) return;
    this.credentialIntents.set(command, this.runtime.beginCredentialChange(provider));
  }

  private takeCredentialIntent(command: object): CredentialChangeIntent | undefined {
    const intent = this.credentialIntents.get(command);
    this.credentialIntents.delete(command);
    return intent;
  }

  private isKnownProvider(provider: string, includeOAuth = false): boolean {
    const active = this.active;
    const view = this.coordinatedView;
    const actor = view?.actor;
    const registry =
      actor?.modelRegistry
      ?? active?.modelRegistry
      ?? (
        view
          ? view.coordinator.modelRegistryForProject(view.handle)
          : this.runtime.modelRegistry
      );
    const modelProvider = registry.getAll().some((model) => model.provider === provider)
      || actor?.dynamicProviderNames().has(provider) === true
      || active?.dynamicProviderNames().has(provider) === true;
    const oauthProvider = includeOAuth && this.isVisibleOAuthProvider(provider);
    return modelProvider || oauthProvider;
  }

  private assertKnownProvider(provider: string, includeOAuth = false): void {
    if (!this.isKnownProvider(provider, includeOAuth)) {
      throw new Error(`Provider not found: ${provider}`);
    }
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
    const oauthProviders = this.visibleOAuthProviders();
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
      focusId: active.focusId,
      conversationName: active.sessionManager.getSessionName() ?? undefined,
      cwd: active.cwd,
      busy: Boolean(activeRun),
      activeRun: activeRun ? {
        id: activeRun.id,
        phase: activeRun.phase,
      } : undefined,
      selectedModel: session.model && registry.hasConfiguredAuth(session.model)
        ? { provider: session.model.provider, id: session.model.id }
        : undefined,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      toolMode: active.project.toolMode,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      providers: buildPublicProviders({
        models: registry.getAll(),
        registeredProviderIds: registry.getRegisteredProviderIds(),
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
    this.emit(boundedProjectSnapshotEvent({
      sessionId: active.id,
      projectId: active.project.id,
      conversationId: active.conversationId,
      conversations: active.project.listConversations(),
    }));
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

  private async flushSettings(): Promise<unknown[]> {
    let failure: unknown;
    try {
      await this.requireSettings().flush();
    } catch (error) {
      failure = error;
    }
    const failures: unknown[] = [];
    const reported = new Set<unknown>();
    for (const item of this.active?.settings.drainErrors() ?? []) {
      reported.add(item.error);
      failures.push(item.error);
    }
    if (failure && !reported.has(failure)) failures.push(failure);
    return failures;
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
    if (
      !run
      || run.sessionId !== sessionId
      || run.generation !== generation
      || run.phase === "queued"
    ) {
      if (event.type === "agent_start") {
        const active = this.active;
        if (active?.id === sessionId && active.generation === generation) {
          void active.session.abort().catch((error) => {
            this.emitError("session", error, sessionId);
          });
          this.emitError(
            "session",
            "An extension started an Agent turn outside the workbench run lifecycle; it was stopped",
            sessionId,
          );
        }
      }
      return;
    }

    for (const projected of run.projector.project(event)) {
      this.emit({
        type: "session_event",
        sessionId,
        conversationId: run.conversationId,
        focusId: run.focusId,
        runId: run.id,
        event: projected,
      });
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

  private visibleOAuthProviders(): Map<string, string> {
    return new Map(
      this.runtime.modelRuntime.getProviders()
        .flatMap((provider) => provider.auth.oauth
          ? [[provider.id, provider.auth.oauth.name] as const]
          : []),
    );
  }

  private isVisibleOAuthProvider(provider: string): boolean {
    return this.visibleOAuthProviders().has(provider);
  }

  private async authorizeToolCall(
    sessionId: string,
    generation: number,
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
    let preparedArgs: unknown;
    try {
      preparedArgs = snapshotWireValue(input.args).value;
    } catch {
      preparedArgs = undefined;
    }
    this.emitRun(ticket, {
      type: "tool_prepared",
      toolCallId: input.toolCallId,
      ...(preparedArgs === undefined ? {} : { args: preparedArgs }),
    });

    let policy: ToolPolicyDecision;
    try {
      policy = await this.toolPolicy({
        mode: this.projectRuns.isRestrictionPending(active.cwd)
          ? "read_only"
          : mostRestrictiveToolMode(
              ticket.toolMode ?? "read_only",
              active.project.toolMode,
            ),
        toolName: input.toolName,
        toolSource: input.toolSource,
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

    if (policy.action === "deny") {
      return { block: true, reason: policy.reason };
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
      conversationId: ticket.conversationId,
      focusId: ticket.focusId,
      runId: ticket.id,
      event,
    });
  }

  private finishRun(
    ticket: RunTicket,
    outcome: Extract<SessionEvent, { type: "run_finished" }>["outcome"],
  ): void {
    if (this.activeRun !== ticket) return;
    this.extensionUI.cancelScope(ticket.sessionId, ticket.generation);
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

  private abortFromExtension(sessionId: string, generation: number): void {
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.sessionId !== sessionId
      || ticket.generation !== generation
    ) {
      return;
    }
    void this.cancelRun(ticket).catch((error) => {
      this.emitError("session", error, sessionId);
    });
  }

  private isExtensionCommand(session: AgentSession, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1
      ? text.slice(1)
      : text.slice(1, spaceIndex);
    return session.extensionRunner.getCommand(commandName) !== undefined;
  }

  private cancelRun(ticket: RunTicket): Promise<void> {
    if (this.activeRun !== ticket) return Promise.resolve();
    this.extensionUI.cancelScope(ticket.sessionId, ticket.generation);
    if (ticket.phase === "queued") {
      ticket.phase = "cancelling";
      this.finishRun(ticket, "aborted");
      return Promise.resolve();
    }
    if (ticket.phase === "cancelling") return ticket.abortPromise ?? Promise.resolve();

    ticket.phase = "cancelling";
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

    this.cancelManualRefresh("Model refresh cancelled by connection lifecycle");
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
      bundle.lifecycleAbort.abort();
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
    this.cancelManualRefresh("Model refresh cancelled by connection lifecycle");
    if (this.coordinationProvider) {
      return this.disposeCoordinated();
    }
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation++;
    this.requestedSessionId = undefined;
    this.initializationAbort?.abort();
    this.initializationAbort = undefined;
    this.unsubscribeRuntime();
    this.cancelAuth();
    this.extensionUI.cancelAll();
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

  private disposeCoordinated(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.generation++;
    this.requestedSessionId = undefined;
    this.cancelCoordinatedTransition();
    this.coordinatedView?.extensionAbort.abort();
    this.initializationAbort?.abort();
    this.initializationAbort = undefined;
    this.unsubscribeRuntime();
    this.unsubscribeRoles?.();
    this.unsubscribeRoles = undefined;
    this.unsubscribeProjectActivity?.();
    this.unsubscribeProjectActivity = undefined;
    this.cancelAuth();
    this.extensionUI.cancelAll();
    this.disposePromise = this.operations.run(() =>
      this.detachCoordinatedView()
    );
    return this.disposePromise;
  }

  private cancelCoordinatedTransition(): void {
    this.coordinatedTransitionAbort?.abort();
    this.coordinatedTransitionAbort = undefined;
  }
}
