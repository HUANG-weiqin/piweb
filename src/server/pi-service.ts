import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { MAX_TRANSITION_DIAGNOSTIC_PHASE_MS } from "../shared/protocol.js";
import type {
  AcknowledgedCommandOperation,
  ClientCommand,
  ConversationActivity,
  ConversationHistoryItem,
  ConversationSummary,
  PeerPresenceResolution,
  FocusAttachedOperation,
  PublicState,
  ProjectSnapshotCoverage,
  ServerEvent,
  ThinkingLevel,
  TransitionDiagnosticOperation,
  TransitionDiagnostics,
} from "../shared/protocol.js";
import { AuthFlowBroker } from "./auth-flow.js";
import type { ConversationActor } from "./conversation-actor.js";
import { validateCwd } from "./cwd.js";
import { ExtensionUIBroker, type PortableExtensionUI } from "./extension-ui.js";
import {
  type CredentialChangeIntent,
  type PiRuntimeLike,
} from "./pi-runtime.js";
import { buildPublicProviders } from "./pi-state.js";
import {
  ProjectSessionCoordinator,
  type ConversationPresentation,
  type ProjectSessionCoordinatorEvent,
  type ProjectSessionHandle,
} from "./project-session-coordinator.js";
import { SessionDirectoryChangedError } from "./project-store.js";
import {
  projectConversationIndex,
  projectConversationPeers,
} from "./project-snapshot.js";
import type { RoleCatalog } from "./role-catalog.js";
import { ManualModelRefreshGate } from "./manual-model-refresh.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { resolveContextUsage } from "./session-usage.js";
import { readLocalImage } from "./local-image.js";
import { readLocalFile } from "./local-file.js";
import { readWorkspaceChanges } from "./workspace-changes.js";

export interface PiConnectionCoordination {
  coordinator: ProjectSessionCoordinator;
  roles: RoleCatalog;
}

export type PiConnectionCoordinationProvider =
  () => Promise<PiConnectionCoordination>;

interface CoordinatedProjectView {
  sessionId: string;
  generation: number;
  /**
   * False for a connection that declared `extensionUi: "none"`: it is never an
   * extension dialog delegate, never lets Pi ask about trust on its behalf,
   * and never moves the recent conversation or clears attention.
   */
  readonly interactive: boolean;
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
  peerPresenceEpoch: number;
  peerPresenceRefresh?: PeerPresenceRefresh;
  peerPresenceTrailing?: PeerPresenceRefresh;
}

interface ProjectSnapshotRefresh {
  readonly view: CoordinatedProjectView;
  trailing: boolean;
}

interface PeerPresenceRefresh {
  readonly actor: ConversationActor;
  readonly focusId: string;
  readonly epoch: number;
  readonly conversationIds: readonly string[];
}

type ConnectionCommand = Exclude<
  ClientCommand,
  {
    type:
      | "browse_directory"
      | "inspect_workspace_sessions"
      | "repair_workspace_sessions"
      | "set_color_scheme"
      | "save_custom_provider"
      | "refresh_custom_providers"
      | "delete_custom_provider"
      | "probe_custom_provider_models";
  }
>;
const UNDECIDED_TRUST_MESSAGE =
  "此项目的资源信任还没有决定。本连接不接收扩展对话框，不能回答信任询问。"
  + "请在浏览器中打开此项目或该会话并回答信任询问；选择“记住”后，本连接也能打开新的会话。";

/**
 * Project catalog UI for a connection without extension UI. Every dialog
 * fails, so Pi can never settle trust through it (a cancelled answer would
 * mean "decline once" for the shared catalog).
 */
const REFUSING_EXTENSION_UI: PortableExtensionUI = {
  select: () => Promise.reject(new Error(UNDECIDED_TRUST_MESSAGE)),
  confirm: () => Promise.reject(new Error(UNDECIDED_TRUST_MESSAGE)),
  input: () => Promise.reject(new Error(UNDECIDED_TRUST_MESSAGE)),
  editor: () => Promise.reject(new Error(UNDECIDED_TRUST_MESSAGE)),
  notify: () => undefined,
};

function assertNever(value: never): never {
  const type = (value as { type?: unknown }).type;
  throw new Error(`Unhandled command type: ${String(type)}`);
}


export const MAX_PROJECT_SNAPSHOT_BYTES = 750_000;

type ProjectSnapshotEvent = Extract<
  ServerEvent,
  { type: "project_snapshot" }
>;
type ConversationSnapshotEvent = Extract<
  ServerEvent,
  { type: "conversation_snapshot" }
>;
type TransitionPhase = Exclude<
  keyof TransitionDiagnostics,
  "version" | "commandId" | "operation"
>;

class TransitionDiagnosticsRecorder {
  private readonly durations: Record<TransitionPhase, number> = {
    validationMs: 0,
    contextOrCatalogMs: 0,
    presentationOrTargetReadMs: 0,
    actorActivationOrLeaseMs: 0,
    snapshotProjectionMs: 0,
  };

  constructor(
    private readonly commandId: string,
    private readonly operation: TransitionDiagnosticOperation,
    private readonly now: () => number,
  ) {}

  async measure<T>(phase: TransitionPhase, work: () => Promise<T>): Promise<T> {
    const startedAt = this.readNow();
    try {
      return await work();
    } finally {
      this.record(phase, startedAt);
    }
  }

  measureSync<T>(phase: TransitionPhase, work: () => T): T {
    const startedAt = this.readNow();
    try {
      return work();
    } finally {
      this.record(phase, startedAt);
    }
  }

  finish(hasSnapshot: boolean): TransitionDiagnostics {
    return {
      version: 1,
      commandId: this.commandId,
      operation: this.operation,
      validationMs: this.duration("validationMs"),
      contextOrCatalogMs: this.duration("contextOrCatalogMs"),
      presentationOrTargetReadMs: this.duration("presentationOrTargetReadMs"),
      actorActivationOrLeaseMs: this.duration("actorActivationOrLeaseMs"),
      snapshotProjectionMs: hasSnapshot
        ? this.duration("snapshotProjectionMs")
        : null,
    };
  }

  private record(phase: TransitionPhase, startedAt: number | undefined): void {
    const finishedAt = this.readNow();
    const elapsed = startedAt === undefined || finishedAt === undefined
      ? 0
      : Math.max(0, finishedAt - startedAt);
    this.durations[phase] = Math.min(
      MAX_TRANSITION_DIAGNOSTIC_PHASE_MS,
      this.durations[phase] + elapsed,
    );
  }

  private duration(phase: TransitionPhase): number {
    return Math.round(this.durations[phase]);
  }

  private readNow(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

function boundedProjectSnapshotEvent(input: {
  sessionId: string;
  projectId: string;
  conversationId?: string;
  conversations: readonly ConversationSummary[];
  coverage: ProjectSnapshotCoverage;
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
    coverage: input.coverage,
  };
  const eventBytes = () => Buffer.byteLength(JSON.stringify(event), "utf8");
  while (
    event.conversations.length > 0
    && eventBytes() > MAX_PROJECT_SNAPSHOT_BYTES
  ) {
    const last = event.conversations.at(-1)!;
    const lastRootConversationId = last.rootConversationId ?? last.id;
    const hasEarlierGroup = event.conversations.some((conversation) =>
      (conversation.rootConversationId ?? conversation.id)
        !== lastRootConversationId
    );
    if (!hasEarlierGroup) break;
    event.conversations = event.conversations.filter((conversation) =>
      (conversation.rootConversationId ?? conversation.id)
        !== lastRootConversationId
    );
    event.truncated = true;
  }

  if (
    event.conversations.length > 0
    && eventBytes() > MAX_PROJECT_SNAPSHOT_BYTES
  ) {
    const groupRootConversationId =
      event.conversations[0]!.rootConversationId
      ?? event.conversations[0]!.id;
    const protectedConversationIds = new Set<string>();
    if (event.conversations.some(
      ({ id }) => id === groupRootConversationId,
    )) {
      protectedConversationIds.add(groupRootConversationId);
    }
    if (
      input.conversationId !== undefined
      && event.conversations.some(({ id }) => id === input.conversationId)
    ) {
      protectedConversationIds.add(input.conversationId);
    }
    while (eventBytes() > MAX_PROJECT_SNAPSHOT_BYTES) {
      let removalIndex = event.conversations.length - 1;
      while (
        removalIndex >= 0
        && protectedConversationIds.has(
          event.conversations[removalIndex]!.id,
        )
      ) {
        removalIndex--;
      }
      if (removalIndex < 0) break;
      event.conversations.splice(removalIndex, 1);
      event.truncated = true;
    }
  }
  if (eventBytes() > MAX_PROJECT_SNAPSHOT_BYTES) {
    throw new Error("Project snapshot envelope exceeds its wire budget");
  }
  return event;
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
  private authFlow?: AuthFlowBroker;
  private requestedSessionId?: string;
  private readonly usedSessionIds = new Set<string>();
  private readonly runIdsBySession = new Map<string, Set<string>>();
  private readonly usedCommandIds: Set<string>;
  private readonly usedAuthFlowIds = new Set<string>();
  private readonly pendingAuthFlowIds = new Set<string>();
  private readonly cancelledAuthFlowIds = new Set<string>();
  private readonly credentialIntents = new WeakMap<object, CredentialChangeIntent>();
  private generation = 0;
  private initializationAbort?: AbortController;
  private workspaceChangesRead?: AbortController;
  private coordinatedTransitionAbort?: AbortController;
  private readonly manualModelRefresh: ManualModelRefreshGate;
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly runtime: PiRuntimeLike,
    private readonly coordinationProvider: PiConnectionCoordinationProvider,
    private readonly monotonicNow: () => number = () => performance.now(),
    usedCommandIds: Set<string> = new Set(),
  ) {
    this.usedCommandIds = usedCommandIds;
    this.manualModelRefresh = new ManualModelRefreshGate(runtime);
    this.extensionUI = new ExtensionUIBroker(emit);
    this.unsubscribeRuntime = runtime.subscribe(() => {
      this.publishCoordinatedState();
      this.publishRoleCatalog();
    });
  }

  get sessionId(): string | undefined {
    return this.coordinatedView?.sessionId;
  }

  handle(command: ConnectionCommand): Promise<void> {
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
    if (command.type === "refresh_workspace_changes") {
      // A project observation must not wait behind an Agent turn or bind to focus.
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          throw new Error("Command ID was already used on this connection");
        }
        this.usedCommandIds.add(command.commandId);
        const view = this.requireCoordinatedView(command.sessionId);
        if (view.handle.project.id !== command.projectId) {
          throw new Error("Workspace changes project is no longer current");
        }
        if (this.workspaceChangesRead) {
          throw new Error("A workspace changes read is already in progress");
        }
        const controller = new AbortController();
        this.workspaceChangesRead = controller;
        return readWorkspaceChanges(view.handle.project.cwd, controller.signal).then((snapshot) => {
          if (!this.isCurrentCoordinatedView(view) || controller.signal.aborted) return;
          this.emit({
            type: "workspace_changes", sessionId: command.sessionId,
            projectId: command.projectId, commandId: command.commandId, snapshot,
          });
        }).finally(() => {
          if (this.workspaceChangesRead === controller) this.workspaceChangesRead = undefined;
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "abort") {
      try {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        const activity = view.actor!.getActivity();
        if (activity.kind === "idle" || activity.runId !== command.runId) {
          return Promise.resolve();
        }
        this.extensionUI.cancelScope(view.sessionId, view.extensionScope);
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
            command.images,
          )
        ).then(() => undefined);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "withdraw_prompt") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          throw new Error("Command ID was already used on this connection");
        }
        this.usedCommandIds.add(command.commandId);
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        // Keep focus validation and native queue removal in one synchronous
        // control turn; neither the running actor nor lifecycle queue may delay it.
        view.coordinator.withdrawPrompt(
          view.handle,
          command.conversationId,
          command.runId,
          command.promptId,
        );
        this.emitCommandComplete(command);
        return Promise.resolve();
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
            command.images,
          )
        ).then(() => {
          this.emitCommandComplete(command);
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "open_local_file") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          return Promise.reject(new Error("Command ID was already used on this connection"));
        }
        this.usedCommandIds.add(command.commandId);
        const generation = this.generation;
        const view = this.requireCoordinatedFocus(
          command.sessionId, command.conversationId, command.focusId,
        );
        return readLocalFile(view.handle.project.cwd, command.path).then((file) => {
          if (!this.isCoordinatedSession(command.sessionId, generation)) return;
          if (
            this.coordinatedView !== view
            || view.conversationId !== command.conversationId
            || view.focusId !== command.focusId
          ) return;
          this.emit({
            type: "local_file",
            sessionId: command.sessionId,
            conversationId: command.conversationId,
            focusId: command.focusId,
            commandId: command.commandId,
            path: command.path,
            ...file,
          });
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "open_local_image") {
      try {
        if (this.usedCommandIds.has(command.commandId)) {
          return Promise.reject(new Error("Command ID was already used on this connection"));
        }
        this.usedCommandIds.add(command.commandId);
        const generation = this.generation;
        const view = this.requireCoordinatedFocus(
          command.sessionId, command.conversationId, command.focusId,
        );
        return readLocalImage(view.handle.project.cwd, command.path).then((image) => {
          if (!this.isCoordinatedSession(command.sessionId, generation)) return;
          if (
            this.coordinatedView !== view
            || view.conversationId !== command.conversationId
            || view.focusId !== command.focusId
          ) return;
          this.emit({
            type: "local_image",
            sessionId: command.sessionId,
            conversationId: command.conversationId,
            focusId: command.focusId,
            commandId: command.commandId,
            path: command.path,
            ...image,
          });
        });
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (command.type === "open_image") {
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
          coordinator.readPersistedImage(
            view.handle,
            command.conversationId,
            command.messageId,
            command.imageOrdinal,
          )
        ).then((image) => {
          if (!this.isCoordinatedSession(command.sessionId, generation)) return;
          const current = this.coordinatedView;
          if (
            current !== view
            || current.conversationId !== command.conversationId
            || current.focusId !== command.focusId
          ) return;
          this.emit({
            type: "conversation_image",
            sessionId: command.sessionId,
            conversationId: command.conversationId,
            focusId: command.focusId,
            commandId: command.commandId,
            messageId: command.messageId,
            imageOrdinal: command.imageOrdinal,
            ...image,
          });
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

    const generation = this.generation;
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
    // A stale request must not reserve the one detached-refresh slot and
    // thereby make the currently focused session appear refresh-busy. Its
    // command identity is nevertheless consumed before this rejection.
    if (
      command.type === "refresh_models"
      && !this.isCoordinatedSession(command.sessionId, generation)
    ) {
      return Promise.reject(new Error("Session was not initialized"));
    }
    if (command.type === "refresh_models") {
      return this.manualModelRefresh.start({
        enqueue: (operation) => this.operations.run(operation),
        validateLaunch: () => {
          this.assertOpen();
          if (!this.isCoordinatedSession(command.sessionId, generation)) {
            throw new Error("Session was not initialized");
          }
        },
        isCurrent: () => this.isCoordinatedSession(command.sessionId, generation),
        emitCommandComplete: () => this.emitCommandComplete(command),
      });
    }
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

    this.admitCredentialIntent(command, generation);
    let transitionAbort: AbortController | undefined;
    if (
      command.type === "focus_conversation"
      || command.type === "create_conversation"
      || command.type === "fork_conversation"
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
        if (
          command.type !== "focus_conversation"
          && command.type !== "create_conversation"
          && command.type !== "fork_conversation"
        ) {
          await this.manualModelRefresh.waitBarrier();
        }
        await this.executeCoordinated(command, transitionAbort);
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
    return operation;
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

    this.manualModelRefresh.cancel("Model refresh cancelled by connection lifecycle");
    this.workspaceChangesRead?.abort();
    this.workspaceChangesRead = undefined;
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
    const diagnostics = command.commandId === undefined
      ? undefined
      : new TransitionDiagnosticsRecorder(
          command.commandId,
          "initialize",
          this.monotonicNow,
        );

    return this.operations.run(async () => {
      this.assertOpen();
      if (generation !== this.generation) return;
      await this.detachCoordinatedView();
      try {
        await this.initializeCoordinated(
          command,
          generation,
          initializationAbort.signal,
          diagnostics,
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
    diagnostics?: TransitionDiagnosticsRecorder,
  ): Promise<void> {
    const cwd = await this.measureTransitionPhase(
      diagnostics,
      "validationMs",
      () => validateCwd(command.cwd),
    );
    this.throwIfAborted(signal);
    const { coordinator } = await this.measureTransitionPhase(
      diagnostics,
      "contextOrCatalogMs",
      () => this.requireCoordination(),
    );
    this.throwIfAborted(signal);
    const handle = await this.measureTransitionPhase(
      diagnostics,
      "contextOrCatalogMs",
      () => coordinator.acquireProject(cwd),
    );
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
    const interactive = command.extensionUi !== "none";
    try {
      this.throwIfAborted(signal);

      const target = command.conversation;
      let targetConversationId = target.kind === "open"
        ? target.conversationId
        : undefined;
      if (target.kind === "recent") {
        // Subscribe before directory discovery: promise settlement is a
        // handoff boundary where an actor mutation could otherwise be missed.
        // Display observations never replace the target's exact open proof.
        unsubscribeRecentSeed = coordinator.subscribe(handle, (event) => {
          if (event.type !== "project_changed") recentSeedInvalidated = true;
        });
        const recentSeed = await this.measureTransitionPhase(
          diagnostics,
          "presentationOrTargetReadMs",
          () => coordinator.listSessionsForDisplay(handle, signal),
        );
        // A connection without extension UI only observes the project.
        if (interactive) {
          const knownIds = new Set(recentSeed.map(({ id }) => id));
          targetConversationId = handle.project.lastConversationId
            && knownIds.has(handle.project.lastConversationId)
            ? handle.project.lastConversationId
            : recentSeed[0]?.id;
        }
      }

      if (
        command.commandId !== undefined
        && targetConversationId !== undefined
      ) {
        const presentation = await this.measureTransitionPhase(
          diagnostics,
          "presentationOrTargetReadMs",
          () => coordinator.prepareConversationPresentation(
            handle,
            targetConversationId,
            signal,
          ),
        );
        this.throwIfAborted(signal);
        if (
          presentation !== undefined
          && !this.disposed
          && generation === this.generation
          && this.requestedSessionId === command.sessionId
          && coordinator.canPublishConversationPresentation(
            handle,
            targetConversationId,
          )
        ) {
          this.emitConversationPreview(
            command.sessionId,
            command.commandId,
            handle,
            targetConversationId,
            presentation,
          );
        }
      }

      extensionScope = ++this.extensionScope;
      const extensionUI = interactive
        ? this.extensionUI.context({
            sessionId: command.sessionId,
            generation: extensionScope,
            signal: extensionAbort.signal,
          })
        : undefined;
      if (!extensionUI) {
        this.assertNoTrustQuestion(coordinator, handle, "catalog");
      }
      await this.measureTransitionPhase(
        diagnostics,
        "contextOrCatalogMs",
        () => coordinator.ensureProjectModelCatalog(
          handle,
          extensionUI ?? REFUSING_EXTENSION_UI,
          signal,
        ),
      );
      this.throwIfAborted(signal);
      let actor: ConversationActor | undefined;
      if (target.kind === "new") {
        const roleId = target.roleId;
        if (!roleId) {
          throw new Error(
            "A role must be selected before creating a conversation",
          );
        }
        if (!extensionUI) this.assertNoTrustQuestion(coordinator, handle, {});
        actor = await this.measureTransitionPhase(
          diagnostics,
          "actorActivationOrLeaseMs",
          () => coordinator.createUserConversation(handle, {
            roleId,
            signal: extensionAbort.signal,
            ...(extensionUI
              ? { extensionUI }
              : { updateRecent: false }),
          }),
        );
        createdConversationId = actor.conversationId;
        if (extensionUI) {
          unsubscribeExtensionUI = coordinator.attachExtensionUI(
            handle,
            actor.conversationId,
            extensionUI,
          );
        }
      } else if (targetConversationId !== undefined) {
        if (extensionUI) {
          unsubscribeExtensionUI = coordinator.attachExtensionUI(
            handle,
            targetConversationId,
            extensionUI,
          );
        } else {
          this.assertNoTrustQuestion(coordinator, handle, {
            conversationId: targetConversationId,
          });
        }
        actor = await this.measureTransitionPhase(
          diagnostics,
          "actorActivationOrLeaseMs",
          () => coordinator.openConversation(
            handle,
            targetConversationId,
            extensionUI ? { signal } : { signal, updateRecent: false },
          ),
        );
      }
      if (target.kind === "recent") {
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
        interactive,
        extensionScope,
        extensionAbort,
        coordinator,
        handle,
        unsubscribeProject: () => undefined,
        unsubscribeExtensionUI: unsubscribeExtensionUI ?? (() => undefined),
        seenMessageCounts: new Map(),
        unreadConversationIds: new Set(),
        projectSnapshotInitialized: false,
        peerPresenceEpoch: 0,
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
      const emptyTransitionDiagnostics = diagnostics !== undefined
        && actor === undefined
        ? diagnostics.finish(false)
        : undefined;
      if (command.commandId !== undefined) {
        this.emitFocusAttached(
          view,
          "initialize",
          command.commandId,
          emptyTransitionDiagnostics,
        );
      }
      this.publishCoordinatedState();
      if (initialRecentConversations !== undefined && !recentSeedInvalidated) {
        this.emitProjectSnapshot(view, initialRecentConversations, "unknown");
      } else {
        this.publishProjectSnapshotCoordinated();
      }
      this.publishRoleCatalog();
      this.publishFocusedConversationSnapshot(
        actor === undefined ? undefined : diagnostics,
      );
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
      | { type: "open_image" }
      | { type: "open_local_image" }
      | { type: "open_local_file" }
      | { type: "prompt" }
      | { type: "refresh_models" }
      | { type: "refresh_view" }
      | { type: "refresh_workspace_changes" }
      | { type: "steer" }
      | { type: "withdraw_prompt" }
      | { type: "switch_conversation_role" }
    >,
    transitionAbort?: AbortController,
  ): Promise<void> {
    switch (command.type) {
      case "focus_conversation": {
        const diagnostics = new TransitionDiagnosticsRecorder(
          command.commandId,
          "focus_conversation",
          this.monotonicNow,
        );
        const view = diagnostics.measureSync(
          "validationMs",
          () => this.requireCoordinatedView(command.sessionId),
        );
        const { coordinator } = await diagnostics.measure(
          "contextOrCatalogMs",
          () => this.requireCoordination(),
        );
        const extensionAbort = transitionAbort ?? new AbortController();
        let extensionScope: number | undefined;
        let detachExtensionUI: (() => void) | undefined;
        let transferred = false;
        try {
          const presentation = await diagnostics.measure(
            "presentationOrTargetReadMs",
            () => coordinator.prepareConversationPresentation(
              view.handle,
              command.conversationId,
              extensionAbort.signal,
            ),
          );
          if (
            extensionAbort.signal.aborted
            || this.coordinatedView !== view
          ) return;
          if (
            presentation !== undefined
            && coordinator.canPublishConversationPresentation(
              view.handle,
              command.conversationId,
            )
          ) {
            this.emitConversationPreview(
              view.sessionId,
              command.commandId,
              view.handle,
              command.conversationId,
              presentation,
            );
          }

          extensionScope = ++this.extensionScope;
          if (view.interactive) {
            detachExtensionUI = coordinator.attachExtensionUI(
              view.handle,
              command.conversationId,
              this.extensionUI.context({
                sessionId: view.sessionId,
                generation: extensionScope,
                signal: extensionAbort.signal,
              }),
            );
          } else {
            this.assertNoTrustQuestion(coordinator, view.handle, {
              conversationId: command.conversationId,
            });
          }
          const actor = await diagnostics.measure(
            "actorActivationOrLeaseMs",
            () => coordinator.openConversation(
              view.handle,
              command.conversationId,
              {
                updateRecent: false,
                signal: extensionAbort.signal,
              },
            ),
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
            detachExtensionUI ?? (() => undefined),
            extensionScope,
            extensionAbort,
            diagnostics,
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
            if (extensionScope !== undefined) {
              this.extensionUI.cancelScope(view.sessionId, extensionScope);
            }
          }
        }
        return;
      }
      case "create_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        const extensionScope = ++this.extensionScope;
        const extensionAbort = transitionAbort ?? new AbortController();
        const extensionUI = view.interactive
          ? this.extensionUI.context({
              sessionId: view.sessionId,
              generation: extensionScope,
              signal: extensionAbort.signal,
            })
          : undefined;
        let detachExtensionUI: (() => void) | undefined;
        let createdConversationId: string | undefined;
        let transferred = false;
        try {
          if (!extensionUI) {
            this.assertNoTrustQuestion(coordinator, view.handle, {});
          }
          const actor = await coordinator.createUserConversation(view.handle, {
            roleId: command.roleId,
            ...(command.title === undefined ? {} : { title: command.title }),
            signal: extensionAbort.signal,
            ...(extensionUI
              ? { extensionUI }
              : { updateRecent: false }),
          });
          createdConversationId = actor.conversationId;
          if (
            extensionAbort.signal.aborted
            || this.coordinatedView !== view
          ) return;
          if (extensionUI) {
            detachExtensionUI = coordinator.attachExtensionUI(
              view.handle,
              actor.conversationId,
              extensionUI,
            );
          }
          this.attachCoordinatedFocus(
            view,
            actor,
            "create_conversation",
            command.commandId,
            detachExtensionUI ?? (() => undefined),
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
      case "fork_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        const extensionScope = ++this.extensionScope;
        const extensionAbort = transitionAbort ?? new AbortController();
        const extensionUI = view.interactive
          ? this.extensionUI.context({
              sessionId: view.sessionId,
              generation: extensionScope,
              signal: extensionAbort.signal,
            })
          : undefined;
        let detachExtensionUI: (() => void) | undefined;
        let createdConversationId: string | undefined;
        let transferred = false;
        try {
          if (!extensionUI) {
            this.assertNoTrustQuestion(coordinator, view.handle, {});
          }
          const actor = await coordinator.forkCurrentLeafConversation(
            view.handle,
            command.conversationId,
            extensionUI
              ? { signal: extensionAbort.signal }
              : { signal: extensionAbort.signal, updateRecent: false },
          );
          createdConversationId = actor.conversationId;
          if (
            extensionAbort.signal.aborted
            || this.coordinatedView !== view
          ) return;
          if (extensionUI) {
            detachExtensionUI = coordinator.attachExtensionUI(
              view.handle,
              actor.conversationId,
              extensionUI,
            );
          }
          this.attachCoordinatedFocus(
            view,
            actor,
            "fork_conversation",
            command.commandId,
            detachExtensionUI ?? (() => undefined),
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
        await coordinator.setCompactionThreshold(
          view.handle,
          command.conversationId,
          command.percent,
        );
        this.emitCommandComplete(command);
        return;
      }
      case "set_service_tier": {
        const view = this.requireCoordinatedFocus(
          command.sessionId,
          command.conversationId,
          command.focusId,
        );
        const { coordinator } = await this.requireCoordination();
        await coordinator.setServiceTier(
          view.handle,
          command.conversationId,
          command.serviceTier,
        );
        this.emitCommandComplete(command);
        return;
      }
      case "rename_conversation": {
        const view = this.requireCoordinatedView(command.sessionId);
        const { coordinator } = await this.requireCoordination();
        const result = await coordinator.renameConversation(
          view.handle,
          command.conversationId,
          command.name,
        );
        this.publishCoordinatedState();
        this.publishProjectSnapshotCoordinated();
        if (result.outcome === "persistence_unknown") {
          this.emit({
            type: "error",
            scope: "settings",
            operation: "rename_conversation",
            sessionId: view.sessionId,
            commandId: command.commandId,
            message: `对话名称已用于当前会话，但可能未保存到项目历史：${
              this.errorMessage(result.error)
            }`,
          });
          return;
        }
        this.emitCommandComplete(command);
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
        if (!this.isCurrentCoordinatedView(view)) return;
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
      default:
        return assertNever(command);
    }
  }

  private requireCoordination(): Promise<PiConnectionCoordination> {
    this.assertOpen();
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

  private measureTransitionPhase<T>(
    diagnostics: TransitionDiagnosticsRecorder | undefined,
    phase: TransitionPhase,
    work: () => Promise<T>,
  ): Promise<T> {
    return diagnostics === undefined
      ? work()
      : diagnostics.measure(phase, work);
  }

  /**
   * A connection without extension UI must not make Pi ask about trust: the
   * question would reach no one it could show it to, and a new conversation
   * is not yet listed for the user to answer it.
   */
  private assertNoTrustQuestion(
    coordinator: ProjectSessionCoordinator,
    handle: ProjectSessionHandle,
    target: Parameters<ProjectSessionCoordinator["needsProjectTrustQuestion"]>[1],
  ): void {
    if (coordinator.needsProjectTrustQuestion(handle, target)) {
      throw new Error(UNDECIDED_TRUST_MESSAGE);
    }
  }

  private attachCoordinatedFocus(
    view: CoordinatedProjectView,
    actor: ConversationActor,
    operation: "focus_conversation" | "create_conversation" | "fork_conversation",
    commandId: string,
    unsubscribeExtensionUI: () => void,
    extensionScope: number,
    extensionAbort: AbortController,
    diagnostics?: TransitionDiagnosticsRecorder,
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
    this.publishFocusedConversationSnapshot(diagnostics);
    // Recent marking also acknowledges attention, which only the user may do.
    if (operation === "focus_conversation" && view.interactive) {
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

  private emitConversationPreview(
    sessionId: string,
    commandId: string,
    handle: ProjectSessionHandle,
    conversationId: string,
    presentation: ConversationPresentation,
  ): void {
    this.emit({
      type: "conversation_preview",
      sessionId,
      commandId,
      projectId: handle.project.id,
      conversationId,
      cwd: presentation.cwd,
      toolMode: presentation.toolMode,
      ...(presentation.role === undefined
        ? {}
        : { role: presentation.role }),
      items: presentation.items,
      window: presentation.window,
    });
  }

  private emitFocusAttached(
    view: CoordinatedProjectView,
    operation: FocusAttachedOperation,
    commandId: string,
    transitionDiagnostics?: TransitionDiagnostics,
  ): void {
    if (this.coordinatedView !== view || this.disposed) return;
    this.emit({
      type: "focus_attached",
      operation,
      commandId,
      sessionId: view.sessionId,
      projectId: view.handle.project.id,
      ...(transitionDiagnostics === undefined
        ? {}
        : { transitionDiagnostics }),
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
    if (!this.isCurrentCoordinatedView(view)) return;
    if (event.type === "project_summary_changed") {
      const refresh = this.projectSnapshotRefresh;
      if (refresh?.view === view) refresh.trailing = true;
      this.emitProjectSnapshot(
        view,
        view.coordinator.projectSessionsFromCurrentIndex(view.handle),
        "unknown",
      );
      return;
    }
    if (event.type === "project_changed") {
      if (event.catalogInvalidated) {
        this.emitProjectSnapshot(
          view,
          view.coordinator.projectSessionsFromCurrentIndex(view.handle),
          "unknown",
        );
      }
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

    if (
      event.type === "prompt_admitted"
      || event.type === "prompt_delivered"
      || event.type === "prompt_withdrawn"
    ) {
      if (event.conversationId === view.conversationId && view.focusId !== undefined) {
        if (event.type === "prompt_admitted") {
          this.emit({
            type: "prompt_admitted",
            sessionId: view.sessionId,
            conversationId: event.conversationId,
            focusId: view.focusId,
            promptId: event.promptId,
            runId: event.runId,
            text: event.text,
          });
        } else if (event.type === "prompt_withdrawn") {
          this.emit({
            type: "prompt_withdrawn",
            sessionId: view.sessionId,
            conversationId: event.conversationId,
            focusId: view.focusId,
            promptId: event.promptId,
            runId: event.runId,
            reason: event.reason,
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

    if (event.type === "bash_activity") {
      if (event.conversationId === view.conversationId && view.focusId !== undefined) {
        this.emit({
          type: "bash_activity",
          sessionId: view.sessionId,
          conversationId: event.conversationId,
          focusId: view.focusId,
          activity: event.activity,
        });
      }
      return;
    }

    if (event.type === "image_message_persisted" || event.type === "history_changed") {
      if (event.conversationId === view.conversationId && view.focusId !== undefined) {
        this.publishFocusedConversationSnapshot();
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
      event.type === "loop_list"
      && focused
      && view.focusId !== undefined
    ) {
      this.emit({
        type: "loop_list_update",
        sessionId: view.sessionId,
        conversationId: event.conversationId,
        focusId: view.focusId,
        loopList: event.loopList,
      });
    } else if (
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
      || view.actor?.isRuntimeReady() === false
    ) {
      return;
    }
    this.emit({ type: "state", state: this.coordinatedState(view) });
  }

  private coordinatedState(view: CoordinatedProjectView): PublicState {
    const actor = view.actor;
    const activity = actor?.getActivity() ?? { kind: "idle" as const };
    const compactionAttempt = actor?.getCompactionAttempt();
    const registry = actor?.modelRegistry
      ?? view.coordinator.modelRegistryForProject(view.handle);
    const available = registry.getAvailable();
    const oauthProviders = this.visibleOAuthProviders();
    const base: PublicState = {
      sessionId: view.sessionId,
      projectId: view.handle.project.id,
      cwd: view.handle.project.cwd,
      busy: activity.kind !== "idle",
      selectedServiceTier: actor?.getServiceTier() ?? null,
      ...(actor === undefined
        ? {}
        : {
            conversationId: actor.conversationId,
            focusId: view.focusId,
            conversationName: actor.isSessionPersistenceQuarantined()
              ? undefined
              : actor.sessionManager.getSessionName() ?? undefined,
            selectedModel: actor.session.model
              && registry.hasConfiguredAuth(actor.session.model)
              ? {
                  provider: actor.session.model.provider,
                  id: actor.session.model.id,
                }
              : undefined,
            compacting: actor.isCompacting(),
            ...(compactionAttempt === undefined
              ? {}
              : { compactionAttempt }),
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
        apiKeyAvailable: (provider) =>
          registry.getProvider(provider)?.auth.apiKey !== undefined,
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
    return { id: activity.runId, phase: activity.kind };
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
          const conversations = await view.coordinator.listSessionsForDisplay(
            view.handle,
          );
          if (!this.isCurrentCoordinatedView(view)) return;
          if (refresh.trailing) continue;
          this.emitProjectSnapshot(view, conversations, "complete");
        } catch (error) {
          latestError = error;
          latestFailed = true;
        }
      } while (
        refresh.trailing
        && this.isCurrentCoordinatedView(view)
      );
      if (latestFailed && this.isCurrentCoordinatedView(view)) {
        if (latestError instanceof SessionDirectoryChangedError) {
          // A concurrent writer only invalidated this proof attempt. Project
          // the last successful index as non-authoritative instead of
          // reporting a project failure the operator cannot act on.
          this.emitProjectSnapshot(
            view,
            view.coordinator.projectSessionsFromCurrentIndex(view.handle),
            "unknown",
          );
        } else {
          this.emitError("session", latestError, view.sessionId);
        }
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
    coverage: ProjectSnapshotCoverage,
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
      coverage,
      ...(view.conversationId === undefined
        ? {}
        : { conversationId: view.conversationId }),
    }));
  }

  private publishRoleCatalog(): void {
    const view = this.coordinatedView;
    if (!view || !this.isCurrentCoordinatedView(view)) return;
    void this.requireCoordination().then(({ coordinator }) => {
      if (
        !this.isCurrentCoordinatedView(view)
        || view.actor?.isRuntimeReady() === false
      ) return;
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

  private publishFocusedConversationSnapshot(
    diagnostics?: TransitionDiagnosticsRecorder,
  ): void {
    const view = this.coordinatedView;
    const actor = view?.actor;
    const focusId = view?.focusId;
    if (
      this.disposed
      || !view
      || !actor
      || view.conversationId !== actor.conversationId
      || focusId === undefined
    ) {
      return;
    }
    try {
      const build = (): ConversationSnapshotEvent => {
        const projection = actor.projectConversationItems((items) => (
          projectConversationPeers(
            items,
            view.handle.project.listConversations(),
          )
        ));
        const items = projection.items;
        const completedOutputRate = actor.getCompletedOutputRate();
        this.focusedItemFingerprints.clear();
        for (const item of items) {
          this.focusedItemFingerprints.set(item.id, JSON.stringify(item));
        }
        return {
          type: "conversation_snapshot",
          sessionId: view.sessionId,
          conversationId: actor.conversationId,
          focusId,
          role: actor.profile.role,
          projectionSeq: projection.projectionSeq,
          items,
          ...(completedOutputRate === undefined
            ? {}
            : { completedOutputRate }),
          pendingPrompts: actor.pendingPromptAdmissions().map((admission) => ({
            promptId: admission.promptId,
            text: admission.text,
          })),
          loopList: actor.getLoopList(),
          bashActivity: actor.getBashActivity(),
          window: projection.window,
        };
      };
      const event = diagnostics === undefined
        ? build()
        : diagnostics.measureSync("snapshotProjectionMs", build);
      if (diagnostics !== undefined) {
        event.transitionDiagnostics = diagnostics.finish(true);
      }
      this.emit(event);
      this.scheduleFocusedPeerPresence(
        view,
        actor,
        focusId,
        event.items ?? [],
      );
    } catch (error) {
      this.emitError("session", error, view.sessionId);
    }
  }

  private publishFocusedConversationItems(
    peerPresenceByConversationId?: ReadonlyMap<
      string,
      PeerPresenceResolution
    >,
  ): void {
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
          peerPresenceByConversationId,
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
      this.scheduleFocusedPeerPresence(
        view,
        actor,
        view.focusId,
        items,
        peerPresenceByConversationId,
      );
    } catch (error) {
      this.emitError("session", error, view.sessionId);
    }
  }

  private scheduleFocusedPeerPresence(
    view: CoordinatedProjectView,
    actor: ConversationActor,
    focusId: string,
    items: readonly ConversationHistoryItem[],
    peerPresenceByConversationId?: ReadonlyMap<
      string,
      PeerPresenceResolution
    >,
  ): void {
    const peerConversationIds = [...new Set(items.flatMap((item) => {
      if (item.kind !== "session_message") return [];
      return [item.direction === "incoming"
        ? item.from.conversationId
        : item.to.conversationId];
    }))];
    if (
      peerPresenceByConversationId !== undefined
      && peerConversationIds.every((id) => peerPresenceByConversationId.has(id))
    ) {
      return;
    }

    const request: PeerPresenceRefresh = {
      actor,
      focusId,
      epoch: ++view.peerPresenceEpoch,
      conversationIds: peerConversationIds,
    };
    if (request.conversationIds.length === 0) {
      view.peerPresenceTrailing = undefined;
      return;
    }
    if (view.peerPresenceRefresh !== undefined) {
      view.peerPresenceTrailing = request;
      return;
    }
    this.runFocusedPeerPresence(view, request);
  }

  private runFocusedPeerPresence(
    view: CoordinatedProjectView,
    request: PeerPresenceRefresh,
  ): void {
    view.peerPresenceRefresh = request;
    void view.coordinator.resolveConversationPeerPresence(
      view.handle,
      request.actor,
      request.conversationIds,
    ).then(
      (peerPresence) => {
        if (!this.isCurrentFocusedPeerView(
          view,
          request.actor,
          request.focusId,
          request.epoch,
        )) return;
        this.publishFocusedConversationItems(peerPresence);
      },
      () => undefined,
    ).finally(() => {
      if (view.peerPresenceRefresh !== request) return;
      view.peerPresenceRefresh = undefined;
      const trailing = view.peerPresenceTrailing;
      view.peerPresenceTrailing = undefined;
      if (
        trailing === undefined
        || !this.isCurrentFocusedPeerView(
          view,
          trailing.actor,
          trailing.focusId,
          trailing.epoch,
        )
      ) return;
      this.runFocusedPeerPresence(view, trailing);
    });
  }

  private isCurrentFocusedPeerView(
    view: CoordinatedProjectView,
    actor: ConversationActor,
    focusId: string,
    epoch: number,
  ): boolean {
    return this.isCurrentCoordinatedView(view)
      && view.coordinator.isConversationActive(view.handle, actor)
      && view.peerPresenceEpoch === epoch
      && view.actor === actor
      && view.conversationId === actor.conversationId
      && view.focusId === focusId;
  }

  private async setCoordinatedThinking(
    level: ThinkingLevel,
  ): Promise<void> {
    const view = this.requireCoordinatedView();
    const actor = view.actor;
    if (!actor) throw new Error("Choose a conversation first");
    const { coordinator } = await this.requireCoordination();
    const result = await coordinator.setThinkingLevel(
      view.handle,
      actor.conversationId,
      level,
    );
    this.publishCoordinatedState();
    for (const failure of result.settingsFailures) {
      this.emitError("settings", failure, view.sessionId);
    }
    if (result.partialFailure !== undefined) {
      this.emitError(
        "settings",
        `思考级别已用于当前会话，但会话记录或默认设置可能未保存：${
          this.errorMessage(result.partialFailure)
        }`,
        view.sessionId,
      );
    }
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
      || view.actor?.isRuntimeReady() === false
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
    this.manualModelRefresh.cancel("Model refresh cancelled by connection lifecycle");
    this.workspaceChangesRead?.abort();
    this.workspaceChangesRead = undefined;
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

  private async commitCredentialChange(
    intent: CredentialChangeIntent,
    change: () => Promise<void> | void,
  ): Promise<boolean> {
    return this.runtime.commitCredentialChange(intent, change);
  }

  private admitCredentialIntent(
    command: ConnectionCommand,
    generation: number,
  ): void {
    if (this.disposed) return;
    let provider: string | undefined;
    let includeOAuth = false;
    switch (command.type) {
      case "set_api_key":
        if (!this.isCoordinatedSession(command.sessionId, generation)) return;
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
    const view = this.coordinatedView;
    const actor = view?.actor;
    const registry = actor?.modelRegistry
      ?? (view
        ? view.coordinator.modelRegistryForProject(view.handle)
        : this.runtime.modelRegistry);
    const modelProvider = registry.getAll().some((model) => model.provider === provider)
      || actor?.dynamicProviderNames().has(provider) === true;
    const oauthProvider = includeOAuth && this.isVisibleOAuthProvider(provider);
    return modelProvider || oauthProvider;
  }

  private assertKnownProvider(provider: string, includeOAuth = false): void {
    if (!this.isKnownProvider(provider, includeOAuth)) {
      throw new Error(`Provider not found: ${provider}`);
    }
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

  private assertOpen(): void {
    if (this.disposed) throw new Error("Connection is closed");
  }

  dispose(): Promise<void> {
    this.manualModelRefresh.cancel("Model refresh cancelled by connection lifecycle");
    this.workspaceChangesRead?.abort();
    this.workspaceChangesRead = undefined;
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
