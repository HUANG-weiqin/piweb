import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MAX_PROJECT_ACTIVITY_SUMMARIES,
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  type ConversationHistoryItem,
  type ConversationImage,
  type ConversationRoleSnapshot,
  type ConversationSummary,
  type ConversationWindowCoverage,
  type ProjectActivitySummary,
  type PromptImage,
  type ServiceTier,
  type ThinkingLevel,
  type ToolMode,
} from "../shared/protocol.js";
import {
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createConversationMessageEntry,
  createMessageDeliveryReceiptEntry,
  createMetaOperationEntry,
  createRunSettlementEntry,
  normalizeConversationMessageSummary,
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMessageEntry,
  type ConversationMeta,
  type ConversationOrchestration,
  type ConversationReferenceSnapshot,
  type MessageDeliveryReceipt,
  type MetaOperation,
  type RunSettlement,
} from "./conversation-meta.js";
import {
  ConversationActor,
  type ConversationActorCompletion,
  type ConversationActorEvent,
  type ConversationWaitAttempt,
  type ConversationWaitAttemptTerminalCause,
  type ConversationWaitingTarget,
  type ThinkingLevelChangeResult,
} from "./conversation-actor.js";
import {
  projectAgentConversationPeek,
  projectConversationItemSlots,
  projectConversationItemsSnapshot,
  snapshotConversationItems,
} from "./conversation-history.js";

import {
  createMetaTools,
  type MetaToolService,
  type MetaToolSessionScope,
} from "./meta-tools.js";
import { createNotebookTools } from "./notebook-tools.js";
import { LspError } from "./lsp/contracts.js";
import { resolveLspServer } from "./lsp/definition.js";
import { createLspTools } from "./lsp/tools.js";
import { WorkspaceLsp } from "./lsp/workspace.js";
import type {
  CreatedProjectModelCatalog,
  CreatePiSessionOptions,
  PiRuntimeLike,
} from "./pi-runtime.js";
import type { PortableExtensionUI } from "./extension-ui.js";
import {
  inboxEnvelopePayloadFingerprint,
  ProjectInbox,
  type InboxEnvelope,
  type InboxEnvelopeInput,
} from "./project-inbox.js";
import {
  ProjectStoreRegistry,
  type ConversationDeletionLease,
  type ProjectStore,
  type ProjectStoreHandle,
} from "./project-store.js";
import {
  conversationDisplayTitle,
  projectConversationPeers,
} from "./project-snapshot.js";
import {
  RoleCatalog,
  type RoleCatalogModelRegistry,
} from "./role-catalog.js";
import {
  MAX_ROLE_SYSTEM_PROMPT_BYTES,
  RoleUpdateConflictError,
} from "./role-store.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { createReadonlySessionEntriesAdapter } from "./session-file.js";
import {
  defaultToolPolicy,
  type ToolPolicy,
} from "./tool-policy.js";

const MAX_BATCH_MESSAGES = 8;
const MAX_COMPLETION_CACHE = 256;
export const WAIT_POLL_DELAY_MS = 240_000;

export const MAX_PEER_SESSIONS_PER_RUN = 32;
export const MAX_DELEGATION_DEPTH = 3;
export const MAX_LIVE_DELEGATION_DESCENDANTS = 32;
const START_SESSION_ADMISSION_FAILURE_PREFIX =
  "start_session inbox admission failed: ";
const INBOX_LIFECYCLE_GUIDANCE = [
  "生命周期提醒：你负责管理自己创建的会话生命周期；会话不会被系统自动终止或删除。",
  "收到结果后，请自行决定继续工作、等待运行、终止活动运行或删除空闲会话。",
].join("\n");

export type ProjectSessionCoordinatorEvent =
  | ConversationActorEvent
  | { type: "project_changed" };

export type ProjectSessionCoordinatorListener = (
  event: ProjectSessionCoordinatorEvent,
) => void;

export interface ProjectActivityCatalogSnapshot {
  projects: readonly ProjectActivitySummary[];
  truncated: boolean;
}

export interface ReloadConversationTarget {
  cwd: string;
  conversationId: string;
  /** False when opening the project is enough for durable inbox recovery. */
  continueTask: boolean;
  continuationRunId?: string;
  adoptedRunId?: string;
}

export type ReloadResumeDisposition =
  | { cwd: string; conversationId: string; disposition: "adopted"; runId: string }
  | { cwd: string; conversationId: string; disposition: "completed" }
  | { cwd: string; conversationId: string; disposition: "retry" };

export interface ReloadTargetCompletion {
  requestId: string;
  cwd: string;
  conversationId: string;
  runId: string;
}

interface ReloadReservation {
  requestId: string;
  cwd: string;
  conversationId: string;
  disposition?: ReloadResumeDisposition;
}

interface ReloadAdoption {
  requestId: string;
  runId: string;
  notifying: boolean;
  onCompleted(completion: ReloadTargetCompletion): Promise<void>;
}

export type ProjectActivityListener = (
  snapshot: ProjectActivityCatalogSnapshot,
) => void;

interface CachedProjectActivity {
  summary: ProjectActivitySummary;
  revision: number;
}

interface WaiterBase {
  reject(error: Error): void;
}

interface SessionMessageWaitResult {
  outcome: "message";
  conversationId: string;
  /** Present when the message carries a source run (the sender's active run). */
  runId?: string;
  messageId: string;
  sentAt: string;
}

/**
 * User guidance was accepted into the waiting run's SDK steering queue and
 * ended the wait. Its body remains owned by the queued raw user message, so
 * the tool result only reports the wake-up kind.
 */
interface SessionGuidanceWaitResult {
  outcome: "guidance";
}

interface SessionCheckpointWaitResult {
  outcome: "checkpoint";
}

interface SessionTargetUnreachableResult {
  outcome: "target_unreachable";
  conversationId: string;
  runId: string;
}

type SessionWaitResult =
  | (RunSettlement & { conversationId: string })
  | SessionMessageWaitResult
  | SessionGuidanceWaitResult
  | SessionCheckpointWaitResult
  | SessionTargetUnreachableResult;

interface CompletionWaiter extends WaiterBase {
  kind: "completion";
  resolve(settlement: RunSettlement): void;
}


type DeletionLeasePreflight =
  | { kind: "actor"; actor: ConversationActor }
  | { kind: "cold"; lease: ConversationDeletionLease };

interface ProjectContext {
  readonly key: string;
  readonly project: ProjectStore;
  readonly projectHandle: ProjectStoreHandle;
  readonly inbox: ProjectInbox;
  readonly actors: Map<string, ConversationActor>;
  readonly actorOpenings: Map<string, Promise<ConversationActor>>;
  readonly actorUnsubscribes: Map<string, () => void>;
  readonly profiles: Map<string, ConversationMeta>;
  readonly attention: Set<string>;
  readonly deleting: Set<string>;
  readonly listeners: Set<ProjectSessionCoordinatorListener>;
  readonly completionWaiters: Map<string, Set<CompletionWaiter>>;
  readonly completions: Map<string, RunSettlement>;
  readonly processingBatches: Map<string, InboxEnvelope[]>;
  readonly failedBatchRetries: Set<string>;
  readonly reloadAdoptions: Map<string, ReloadAdoption>;
  readonly extensionUIRouters: Map<string, ConversationExtensionUIRouter>;
  readonly lifecycle: SerialTaskQueue;
  readonly backgroundTasks: Set<Promise<void>>;
  readonly recentUpdates: Set<Promise<void>>;
  readonly unsubscribeProject: () => void;
  modelCatalog?: CreatedProjectModelCatalog;
  modelCatalogOpening?: Promise<CreatedProjectModelCatalog>;
  /** Exists only after positive project execution trust; survives actor rebuild/focus changes. */
  lsp?: WorkspaceLsp;
  closing: boolean;
}

export class ProjectSessionHandle {
  private released = false;

  constructor(readonly context: ProjectContext) {}

  get project(): ProjectStore {
    return this.context.project;
  }

  get isReleased(): boolean {
    return this.released;
  }

  release(): void {
    this.released = true;
  }
}

export interface ConversationPresentation {
  cwd: string;
  toolMode: ToolMode;
  role?: ConversationRoleSnapshot;
  items: ConversationHistoryItem[];
  window: ConversationWindowCoverage;
}

export interface CreateUserConversationInput {
  roleId: string;
  title?: string;
  extensionUI?: PortableExtensionUI;
  signal?: AbortSignal;
}

export interface StartPeerSessionInput {
  roleId: string;
  task: string;
  title?: string;
  idempotencyKey: string;
}

function contextKey(cwd: string): string {
  return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}

function reloadReservationKey(cwd: string, conversationId: string): string {
  return `${contextKey(cwd)}\u0000${conversationId}`;
}

function compareProjectActivity(
  left: ProjectActivitySummary,
  right: ProjectActivitySummary,
): number {
  return right.busyConversationCount - left.busyConversationCount
    || right.attentionConversationCount - left.attentionConversationCount
    || left.cwd.localeCompare(right.cwd);
}

function isLowerProjectActivityPriority(
  left: CachedProjectActivity,
  right: CachedProjectActivity,
): boolean {
  if (
    left.summary.busyConversationCount
    !== right.summary.busyConversationCount
  ) {
    return left.summary.busyConversationCount
      < right.summary.busyConversationCount;
  }
  if (
    left.summary.attentionConversationCount
    !== right.summary.attentionConversationCount
  ) {
    return left.summary.attentionConversationCount
      < right.summary.attentionConversationCount;
  }
  return left.revision < right.revision;
}

function completionKey(conversationId: string, runId: string): string {
  return `${conversationId.length}:${conversationId}:${runId}`;
}

function deterministicUuid(namespace: string, value: string): string {
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

function normalizedTitle(title: string | undefined, fallback: string): string {
  const value = (title ?? fallback)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!value) return "新会话";
  return [...value]
    .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS)
    .join("");
}

function assertRoleSystemPromptBytes(value: string, field: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_ROLE_SYSTEM_PROMPT_BYTES) {
    throw new Error(
      `${field} exceeds ${MAX_ROLE_SYSTEM_PROMPT_BYTES} UTF-8 bytes`,
    );
  }
}

function roleRevisionEditorTitle(
  roleName: string,
  revision: number,
  reason: string,
): string {
  const normalizedReason = reason.replace(/[\r\n]+/g, " ").trim();
  const truncatedReason = [...normalizedReason].slice(0, 160).join("");
  return `审核角色提示词：${roleName}（修订 ${revision}）${
    truncatedReason ? `：${truncatedReason}` : ""
  }`;
}

function cloneSettlement(settlement: RunSettlement): RunSettlement {
  return { ...settlement };
}

function cloneProfile(profile: ConversationMeta): ConversationMeta {
  return structuredClone(profile);
}

interface MetaSessionCreationProjection {
  createdBy: ConversationMeta["createdBy"];
  createdByMe: boolean;
}

function sessionCreationProjection(
  profile: ConversationMeta,
  sourceConversationId: string,
): MetaSessionCreationProjection {
  return {
    createdBy: structuredClone(profile.createdBy),
    createdByMe:
      profile.createdBy.kind === "conversation"
      && profile.createdBy.conversationId === sourceConversationId,
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    return Promise.reject(abortError("Operation was aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      finish(() => reject(abortError("Operation was aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function startRequestFingerprint(input: StartPeerSessionInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.roleId,
    input.task,
    input.title ?? null,
  ])).digest("hex");
}

interface RoutedDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

interface PendingExtensionUIRoute {
  defaultValue: unknown;
  invoke(delegate: PortableExtensionUI): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  invoked: boolean;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

class ConversationExtensionUIRouter {
  private readonly delegates = new Map<symbol, PortableExtensionUI>();
  private readonly pending = new Set<PendingExtensionUIRoute>();
  private closed = false;

  readonly ui: PortableExtensionUI = {
    select: (title, options, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.select(title, options, routedOptions),
    ),
    confirm: (title, message, dialogOptions) => this.route(
      false,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.confirm(title, message, routedOptions),
    ),
    input: (title, placeholder, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.input(title, placeholder, routedOptions),
    ),
    editor: (title, prefill, dialogOptions) => this.route(
      undefined,
      dialogOptions,
      (delegate, routedOptions) =>
        delegate.editor(title, prefill, routedOptions),
    ),
    notify: (message, level) => {
      if (this.closed) return;
      const delegate = this.current();
      if (!delegate) {
        this.onUnavailable();
        return;
      }
      delegate.notify(message, level);
    },
  };

  constructor(private readonly onUnavailable: () => void) {}

  attach(delegate: PortableExtensionUI): () => void {
    if (this.closed) return () => undefined;
    const token = Symbol("conversation-extension-ui");
    this.delegates.set(token, delegate);
    this.flush(delegate);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.delegates.delete(token);
    };
  }

  clear(): void {
    this.closed = true;
    this.delegates.clear();
    for (const request of [...this.pending]) {
      this.settle(request, request.defaultValue);
    }
  }

  private current(): PortableExtensionUI | undefined {
    return [...this.delegates.values()].at(-1);
  }

  private route<Result>(
    defaultValue: Result,
    options: RoutedDialogOptions | undefined,
    invoke: (
      delegate: PortableExtensionUI,
      options: RoutedDialogOptions | undefined,
    ) => Promise<Result>,
  ): Promise<Result> {
    if (this.closed) return Promise.resolve(defaultValue);
    if (
      options?.signal?.aborted
      || (
        options?.timeout !== undefined
        && Number.isFinite(options.timeout)
        && options.timeout <= 0
      )
    ) {
      return Promise.resolve(defaultValue);
    }
    return new Promise<Result>((resolve, reject) => {
      const startedAt = Date.now();
      const request: PendingExtensionUIRoute = {
        defaultValue,
        invoke: (nextDelegate) => {
          const remaining = options?.timeout === undefined
            ? undefined
            : Math.max(0, options.timeout - (Date.now() - startedAt));
          return invoke(nextDelegate, {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(remaining === undefined ? {} : { timeout: remaining }),
          });
        },
        resolve: (value) => resolve(value as Result),
        reject,
        invoked: false,
        ...(options?.signal === undefined
          ? {}
          : { signal: options.signal }),
      };
      if (request.signal) {
        request.abortListener = () => {
          this.settle(request, request.defaultValue);
        };
        request.signal.addEventListener(
          "abort",
          request.abortListener,
          { once: true },
        );
      }
      if (
        options?.timeout !== undefined
        && Number.isFinite(options.timeout)
        && options.timeout > 0
      ) {
        request.timer = setTimeout(
          () => this.settle(request, request.defaultValue),
          Math.min(options.timeout, 2_147_483_647),
        );
      }
      this.pending.add(request);
      if (request.signal?.aborted) {
        this.settle(request, request.defaultValue);
        return;
      }
      const delegate = this.current();
      if (delegate) {
        this.invoke(request, delegate);
      } else {
        this.onUnavailable();
      }
    });
  }

  private flush(delegate: PortableExtensionUI): void {
    for (const request of [...this.pending]) {
      this.invoke(request, delegate);
    }
  }

  private invoke(
    request: PendingExtensionUIRoute,
    delegate: PortableExtensionUI,
  ): void {
    if (!this.pending.has(request) || request.invoked) return;
    request.invoked = true;
    let operation: Promise<unknown>;
    try {
      operation = request.invoke(delegate);
    } catch (error) {
      this.fail(request, error);
      return;
    }
    void operation.then(
      (value) => this.settle(request, value),
      (error) => this.fail(request, error),
    );
  }

  private settle(request: PendingExtensionUIRoute, value: unknown): void {
    if (!this.pending.has(request)) return;
    this.remove(request);
    request.resolve(value);
  }

  private fail(request: PendingExtensionUIRoute, error: unknown): void {
    if (!this.pending.has(request)) return;
    this.remove(request);
    request.reject(error);
  }

  private remove(request: PendingExtensionUIRoute): void {
    this.pending.delete(request);
    if (request.timer) clearTimeout(request.timer);
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
  }
}

export class ProjectSessionCoordinator {
  private readonly contexts = new Map<string, ProjectContext>();
  private readonly contextOpenings = new Map<string, Promise<ProjectContext>>();
  private readonly projectAcquisitions = new Set<Promise<ProjectSessionHandle>>();
  private readonly projectAcquisitionCwds =
    new Map<Promise<ProjectSessionHandle>, string>();
  private readonly projectActivityListeners = new Set<ProjectActivityListener>();
  private readonly projectActivitySummaries =
    new Map<string, ProjectActivitySummary>();
  private readonly projectActivityCatalog =
    new Map<string, CachedProjectActivity>();
  private readonly reloadReservations = new Map<string, ReloadReservation>();
  private projectActivityRevision = 0;
  private closing = false;
  private disposed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly runtime: PiRuntimeLike,
    private readonly roles: RoleCatalog,
    private readonly projects: ProjectStoreRegistry = new ProjectStoreRegistry(),
    private readonly toolPolicy: ToolPolicy = defaultToolPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acquireProject(cwd: string): Promise<ProjectSessionHandle> {
    this.assertOpen();
    const acquisition = this.acquireProjectInternal(cwd);
    this.projectAcquisitions.add(acquisition);
    this.projectAcquisitionCwds.set(acquisition, cwd);
    try {
      return await acquisition;
    } finally {
      this.projectAcquisitions.delete(acquisition);
      this.projectAcquisitionCwds.delete(acquisition);
    }
  }

  private async acquireProjectInternal(
    cwd: string,
  ): Promise<ProjectSessionHandle> {
    const acquired = await this.projects.acquireProject(cwd);
    if (this.disposed) {
      acquired.release();
      this.assertOpen();
    }
    const key = contextKey(acquired.store.cwd);
    const existing = this.contexts.get(key);
    if (existing) {
      acquired.release();
      this.assertOpen();
      if (existing.closing) {
        throw new Error("Project context is closing");
      }
      this.publishProjectActivityIfChanged(existing, true);
      return new ProjectSessionHandle(existing);
    }

    const pending = this.contextOpenings.get(key);
    if (pending) {
      acquired.release();
      const context = await pending;
      this.assertOpen();
      if (context.closing) throw new Error("Project context is closing");
      this.publishProjectActivityIfChanged(context, true);
      return new ProjectSessionHandle(context);
    }

    const opening = this.openProjectContext(key, acquired);
    this.contextOpenings.set(key, opening);
    try {
      const context = await opening;
      this.assertOpen();
      if (context.closing) throw new Error("Project context is closing");
      return new ProjectSessionHandle(context);
    } finally {
      if (this.contextOpenings.get(key) === opening) {
        this.contextOpenings.delete(key);
      }
    }
  }

  private async openProjectContext(
    key: string,
    projectHandle: ProjectStoreHandle,
  ): Promise<ProjectContext> {
    const project = projectHandle.store;
    let unsubscribeProject: (() => void) | undefined;
    try {
      const inbox = await ProjectInbox.open(join(project.stateDir, "inbox"));
      const contextDraft = {
        key,
        project,
        projectHandle,
        inbox,
        actors: new Map(),
        actorOpenings: new Map(),
        actorUnsubscribes: new Map(),
        profiles: new Map(),
        attention: new Set(),
        deleting: new Set(),
        listeners: new Set(),
        completionWaiters: new Map(),
        completions: new Map(),
        processingBatches: new Map(),
        failedBatchRetries: new Set(),
        reloadAdoptions: new Map(),
        extensionUIRouters: new Map(),
        lifecycle: new SerialTaskQueue(),
        backgroundTasks: new Set(),
        recentUpdates: new Set(),
        unsubscribeProject: () => undefined,
        closing: false,
      } satisfies ProjectContext;
      unsubscribeProject = project.subscribe(() => {
        this.emit(contextDraft, { type: "project_changed" });
      });
      const context: ProjectContext = {
        ...contextDraft,
        unsubscribeProject,
      };
      // Context acquisition is observation-only for the project catalog. A
      // complete transcript audit belongs to background recovery; exact actor
      // activation obtains its own target proof after it has a writer lease.
      for (const conversationId of await inbox.listDeletedTargets()) {
        context.deleting.add(conversationId);
      }
      this.assertOpen();
      this.contexts.set(key, context);
      this.publishProjectActivityIfChanged(context);
      this.trackBackground(
        context,
        this.runLifecycle(context, () => this.recoverProject(context)),
      );
      this.trackBackground(context, this.scrubProjectCatalog(context));
      return context;
    } catch (error) {
      unsubscribeProject?.();
      projectHandle.release();
      throw error;
    }
  }

  subscribe(
    handle: ProjectSessionHandle,
    listener: ProjectSessionCoordinatorListener,
  ): () => void {
    const context = this.requireContext(handle);
    context.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      context.listeners.delete(listener);
    };
  }

  subscribeProjectActivity(listener: ProjectActivityListener): () => void {
    this.assertOpen();
    this.projectActivityListeners.add(listener);
    this.notifyProjectActivityListener(
      listener,
      this.projectActivitySnapshot(),
    );
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.projectActivityListeners.delete(listener);
    };
  }

  projectActivitySnapshot(): ProjectActivityCatalogSnapshot {
    this.assertOpen();
    const projects = [...this.projectActivityCatalog.values()]
      .map(({ summary }) => ({ ...summary }))
      .sort(compareProjectActivity);
    return {
      projects,
      truncated:
        this.projectActivitySummaries.size > this.projectActivityCatalog.size,
    };
  }

  listRoles(modelRegistry?: RoleCatalogModelRegistry) {
    return this.roles.listRoles(modelRegistry);
  }

  async ensureProjectModelCatalog(
    handle: ProjectSessionHandle,
    extensionUI?: PortableExtensionUI,
    signal?: AbortSignal,
  ) {
    const context = this.requireContext(handle);
    this.throwIfAborted(signal);
    if (context.modelCatalog) return context.modelCatalog.modelRegistry;

    let opening = context.modelCatalogOpening;
    if (!opening) {
      const createCatalog = this.runtime.createProjectModelCatalog;
      const ownedOpening = (async () => {
        const catalog = await createCatalog.call(
          this.runtime,
          context.project.cwd,
          {
            ...(extensionUI === undefined ? {} : { extensionUI }),
          },
        );
        if (context.closing || this.disposed) {
          await catalog.dispose();
          throw new Error(
            "Project context closed while its model catalog was opening",
          );
        }
        context.modelCatalog = catalog;
        return catalog;
      })();
      opening = ownedOpening;
      context.modelCatalogOpening = ownedOpening;
      const clearOpening = () => {
        if (context.modelCatalogOpening === ownedOpening) {
          context.modelCatalogOpening = undefined;
        }
      };
      void ownedOpening.then(clearOpening, clearOpening);
    }

    const catalog = await raceWithAbort(opening, signal);
    this.throwIfAborted(signal);
    if (context.closing || this.disposed) {
      throw new Error("Project context is closing");
    }
    return catalog.modelRegistry;
  }

  modelRegistryForProject(handle: ProjectSessionHandle) {
    const context = this.requireContext(handle);
    for (const actor of context.actors.values()) {
      if (!actor.getState().disposed) return actor.modelRegistry;
    }
    return context.modelCatalog?.modelRegistry ?? this.runtime.modelRegistry;
  }

  async listSessions(
    handle: ProjectSessionHandle,
    signal?: AbortSignal,
  ): Promise<ConversationSummary[]> {
    const context = this.requireContext(handle);
    this.throwIfAborted(signal);
    const summaries = await raceWithAbort(
      context.project.refreshConversations(),
      signal,
    );
    this.throwIfAborted(signal);
    await raceWithAbort(
      this.hydrateConversationProfiles(context),
      signal,
    );
    this.throwIfAborted(signal);
    return this.projectConversationSummaries(context, summaries);
  }

  /**
   * Projects the last successful project index without scanning the session
   * directory. This is not a fresh integrity proof and must not be used for
   * open/delete decisions.
   */
  projectSessionsFromCurrentIndex(
    handle: ProjectSessionHandle,
  ): ConversationSummary[] {
    const context = this.requireContext(handle);
    return context.project.listConversations().map((summary) => {
      const actor = context.actors.get(summary.id);
      const profile = actor?.profile ?? context.profiles.get(summary.id);
      if (profile === undefined) {
        return {
          ...summary,
          rootConversationId: summary.id,
          activity: actor?.getActivity() ?? { kind: "idle" },
          attention: context.attention.has(summary.id),
        };
      }
      return this.projectConversationSummaries(context, [summary])[0]!;
    });
  }

  private projectConversationSummaries(
    context: ProjectContext,
    summaries: readonly ConversationSummary[],
  ): ConversationSummary[] {
    return summaries.map((summary) => {
      const actor = context.actors.get(summary.id);
      const profile = actor?.profile ?? context.profiles.get(summary.id);
      if (profile === undefined) {
        throw new Error(`Conversation ${summary.id} profile metadata is missing`);
      }
      const activity = actor?.getActivity() ?? { kind: "idle" };
      const rootConversationId = this.resolveOrchestration(
        context,
        summary.id,
        profile,
      ).rootConversationId;
      return {
        ...summary,
        rootConversationId,
        role: {
          id: profile.role.id,
          revision: profile.role.revision,
          name: profile.role.name,
          description: profile.role.description,
          model: { ...profile.role.model },
          compactionModel: profile.role.compactionModel === null
            ? null
            : { ...profile.role.compactionModel },
          defaultThinkingLevel: profile.role.defaultThinkingLevel,
          defaultServiceTier: profile.role.defaultServiceTier,
          toolMode: profile.role.toolMode,
          canManageSessions: profile.role.canManageSessions,
        },
        createdBy: structuredClone(profile.createdBy),
        activity,
        attention: context.attention.has(summary.id),
      };
    });
  }

  async prepareConversationPresentation(
    handle: ProjectSessionHandle,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ConversationPresentation | undefined> {
    const context = this.requireContext(handle);
    this.throwIfAborted(signal);
    if (context.deleting.has(conversationId)) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    if (
      context.actors.has(conversationId)
      || context.actorOpenings.has(conversationId)
    ) {
      return undefined;
    }

    const inspection = await raceWithAbort(
      context.project.inspectConversationPresentation(conversationId),
      signal,
    );
    this.throwIfAborted(signal);
    this.requireContext(handle);
    if (context.deleting.has(conversationId)) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    if (
      context.actors.has(conversationId)
      || context.actorOpenings.has(conversationId)
    ) {
      return undefined;
    }

    const profile = inspection.conversationMeta;
    if (profile === undefined) return undefined;

    try {
      const adapter = createReadonlySessionEntriesAdapter(inspection.entries);
      const durableItems = projectConversationItemSlots(adapter)
        .map(({ item }) => item);
      const snapshot = snapshotConversationItems(projectConversationPeers(
        durableItems,
        context.project.listConversations(),
      ));
      return {
        cwd: context.project.cwd,
        toolMode: profile.role.toolMode,
        role: profile.role,
        items: snapshot.items,
        window: snapshot.window,
      };
    } catch {
      // Preview is a best-effort display optimization after the exact file has
      // passed its integrity proof. Actor activation remains authoritative.
      return undefined;
    }
  }

  canPublishConversationPresentation(
    handle: ProjectSessionHandle,
    conversationId: string,
  ): boolean {
    let context: ProjectContext;
    try {
      context = this.requireContext(handle);
    } catch {
      return false;
    }
    return (
      !context.deleting.has(conversationId)
      && !context.actors.has(conversationId)
      && !context.actorOpenings.has(conversationId)
    );
  }

  async openConversation(
    handle: ProjectSessionHandle,
    conversationId: string,
    options: { updateRecent?: boolean; signal?: AbortSignal } = {},
  ): Promise<ConversationActor> {
    const context = this.requireContext(handle);
    this.throwIfAborted(options.signal);
    const actor = await raceWithAbort(
      this.getOrOpenActor(context, conversationId),
      options.signal,
    );
    this.throwIfAborted(options.signal);
    if (context.deleting.has(conversationId) || actor.getState().disposed) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    if (options.updateRecent !== false) {
      const recentUpdate = this.markConversationRecent(context, conversationId);
      if (options.signal === undefined) {
        this.acknowledgeConversationFocus(context, conversationId);
        await recentUpdate;
      } else {
        await raceWithAbort(recentUpdate, options.signal);
        this.throwIfAborted(options.signal);
        this.acknowledgeConversationFocus(context, conversationId);
      }
    }
    return actor;
  }

  markConversationRecentInBackground(
    handle: ProjectSessionHandle,
    actor: ConversationActor,
  ): Promise<void> {
    let context: ProjectContext;
    try {
      context = this.requireContext(handle);
    } catch (error) {
      return Promise.reject(error);
    }
    if (context.actors.get(actor.conversationId) !== actor) {
      return Promise.reject(
        new Error(`Conversation is not active: ${actor.conversationId}`),
      );
    }
    if (context.deleting.has(actor.conversationId) || actor.getState().disposed) {
      return Promise.reject(
        new Error(`Conversation is being deleted: ${actor.conversationId}`),
      );
    }
    this.acknowledgeConversationFocus(context, actor.conversationId);
    return this.trackBackground(
      context,
      this.markConversationRecent(context, actor.conversationId),
    );
  }

  async switchConversationRole(
    handle: ProjectSessionHandle,
    conversationId: string,
    roleId: string,
  ): Promise<ConversationActor> {
    const context = this.requireContext(handle);
    return this.runLifecycle(context, async () => {
      const actor = this.requireActor(context, conversationId);
      const role = this.resolveAvailableConversationRole(
        roleId,
        actor.modelRegistry,
      );
      const profile = {
        ...actor.profile,
        role,
      };
      await actor.switchRole(
        role,
        this.createActorSessionOptions(context, conversationId, profile),
      );
      context.profiles.set(conversationId, cloneProfile(actor.profile));
      this.emit(context, { type: "project_changed" });
      return actor;
    });
  }

  async createUserConversation(
    handle: ProjectSessionHandle,
    input: CreateUserConversationInput,
  ): Promise<ConversationActor> {
    const context = this.requireContext(handle);
    return this.runLifecycle(context, async () => {
      this.throwIfAborted(input.signal);
      const conversationId = randomUUID();
      const role = this.resolveAvailableConversationRole(
        input.roleId,
        this.modelRegistryForProject(handle),
      );
      const detachExtensionUI = input.extensionUI
        ? this.extensionUIRouter(context, conversationId)
            .attach(input.extensionUI)
        : undefined;
      const profile: ConversationMeta = {
        role,
        lifecycle: { kind: "normal" },
        createdBy: { kind: "user" },
        orchestration: {
          rootConversationId: conversationId,
          depth: 0,
        },
      };
      let actor: ConversationActor | undefined;
      try {
        actor = await this.createConversationActor(
          context,
          conversationId,
          profile,
          input.title,
        );
        this.throwIfAborted(input.signal);
        await context.project.setLastConversation(actor.conversationId);
        this.throwIfAborted(input.signal);
        return actor;
      } catch (error) {
        if (actor && input.signal?.aborted) {
          try {
            await this.deleteConversationInternal(
              context,
              conversationId,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Failed to discard an aborted conversation creation",
            );
          }
        }
        throw error;
      } finally {
        detachExtensionUI?.();
      }
    });
  }

  attachExtensionUI(
    handle: ProjectSessionHandle,
    conversationId: string,
    extensionUI: PortableExtensionUI,
  ): () => void {
    const context = this.requireContext(handle);
    if (context.deleting.has(conversationId)) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    return this.extensionUIRouter(context, conversationId).attach(extensionUI);
  }

  async startPeerSession(
    handle: ProjectSessionHandle,
    sourceConversationId: string,
    input: StartPeerSessionInput,
    signal?: AbortSignal,
  ): Promise<{ conversationId: string; runId: string }> {
    const context = this.requireContext(handle);
    return this.runLifecycle(context, async () => {
      this.throwIfAborted(signal);
      const source = this.requireActor(context, sourceConversationId);
      const conversationId = deterministicUuid(
        "piweb.start.conversation",
        input.idempotencyKey,
      );
      const runId = deterministicUuid("piweb.start.run", input.idempotencyKey);
      const delegationId = deterministicUuid(
        "piweb.start.delegation",
        input.idempotencyKey,
      );
      const messageId = deterministicUuid(
        "piweb.start.message",
        input.idempotencyKey,
      );
      const cardId = deterministicUuid(
        "piweb.start.card",
        input.idempotencyKey,
      );
      const requestFingerprint = startRequestFingerprint(input);

      // Snapshot source cards once before any writes — used for per-run budget.
      const sourceAggregate = aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      );
      let existingCard = sourceAggregate.cards.find(
        (card) => card.cardId === cardId,
      );
      let recoveredEnvelope = existingCard
        ? await context.inbox.get(messageId)
        : undefined;
      const sourceRunId = recoveredEnvelope?.fromRunId
        ?? existingCard?.orchestration?.sourceRunId
        ?? source.currentRunOwnership()?.runId;
      if (sourceRunId === undefined) {
        throw new Error(
          "start_session requires an exact active or recovered source run",
        );
      }
      if (existingCard) {
        if (
          existingCard.kind !== "delegation_task"
          || existingCard.body !== input.task
          || existingCard.delegationId !== delegationId
          || existingCard.toSnapshot.conversationId !== conversationId
          || existingCard.requestFingerprint !== requestFingerprint
        ) {
          throw new Error(
            "start_session idempotency key conflicts with an earlier request",
          );
        }
        if (
          existingCard.state === "failed"
          && existingCard.result?.startsWith(
            START_SESSION_ADMISSION_FAILURE_PREFIX,
          )
        ) {
          throw new Error(existingCard.result);
        }
        if (existingCard.state !== "sending") {
          return { conversationId, runId };
        }
      }

      const targetTitle = normalizedTitle(input.title, input.task);
      const requestedRole = existingCard?.requestedRole
        ?? this.resolveAvailableConversationRole(
          input.roleId,
          source.modelRegistry,
        );
      if (requestedRole.id !== input.roleId) {
        throw new Error(
          "start_session idempotency key conflicts with an earlier request",
        );
      }

      // Hydrate once before any orchestration resolution or budget checks.
      await this.hydrateConversationProfiles(context);
      this.throwIfAborted(signal);

      // Determine child orchestration — prefer card snapshot on recovery.
      let childOrchestration = existingCard?.orchestration;
      if (!childOrchestration) {
        const sourceOrch = this.resolveOrchestration(
          context,
          sourceConversationId,
          source.profile,
        );
        childOrchestration = {
          rootConversationId: sourceOrch.rootConversationId,
          depth: sourceOrch.depth + 1,
          sourceRunId,
        };
      }

      // Determine whether a new target needs to be created.
      let target = context.actors.get(conversationId);
      const targetExistsOnDisk = target !== undefined
        || context.project.listConversations()
          .some(({ id }) => id === conversationId);
      const needsTargetCreation = !target && !targetExistsOnDisk;

      // Budget checks apply when this intent will consume a slot:
      //   - new start (no existing card)
      //   - sending recovery where the target was never created
      // If the target already exists, the slot was already consumed.
      if (
        !existingCard
        || (existingCard.state === "sending" && needsTargetCreation)
      ) {
        // Depth check.
        if (childOrchestration.depth > MAX_DELEGATION_DEPTH) {
          throw new Error(
            `Delegation depth ${childOrchestration.depth} exceeds maximum ${MAX_DELEGATION_DEPTH}`,
          );
        }

        // Per-run budget from append-only source delegation cards.
        const sourceRunId = childOrchestration.sourceRunId;
        if (sourceRunId) {
          const runCardCount = sourceAggregate.cards.filter(
            (card) => card.kind === "delegation_task"
              && card.orchestration?.sourceRunId === sourceRunId,
          ).length;
          const totalCount = !existingCard
            ? runCardCount + 1
            : runCardCount;
          if (totalCount > MAX_PEER_SESSIONS_PER_RUN) {
            throw new Error(
              `Peer session limit ${MAX_PEER_SESSIONS_PER_RUN} reached for this run`,
            );
          }
        }

        // Live descendant cap (only when new target is about to be created).
        if (needsTargetCreation) {
          const liveDescendants = this.countLiveDelegationDescendants(
            context,
            childOrchestration.rootConversationId,
          );
          this.throwIfAborted(signal);
          if (liveDescendants >= MAX_LIVE_DELEGATION_DESCENDANTS) {
            throw new Error(
              `Live descendant session limit ${MAX_LIVE_DELEGATION_DESCENDANTS} reached`,
            );
          }
        }
      }

      // Write sending card for new intents only.
      if (!existingCard) {
        const sentAt = this.now().toISOString();
        existingCard = {
          cardId,
          kind: "delegation_task",
          body: input.task,
          fromSnapshot: this.endpoint(context, source),
          toSnapshot: {
            conversationId,
            title: targetTitle,
            role: {
              id: requestedRole.id,
              name: requestedRole.name,
            },
          },
          state: "sending",
          messageId,
          delegationId,
          requestFingerprint,
          requestedRole,
          orchestration: { ...childOrchestration },
          updatedAt: sentAt,
        };
        this.appendCard(source, existingCard);
      }

      let createdTarget = false;
      if (!target) {
        if (targetExistsOnDisk) {
          target = await this.getOrOpenActor(context, conversationId);
        } else {
          const profile: ConversationMeta = {
            role: requestedRole,
            lifecycle: { kind: "normal" },
            createdBy: {
              kind: "conversation",
              conversationId: sourceConversationId,
            },
            orchestration: { ...childOrchestration },
          };
          target = await this.createConversationActor(
            context,
            conversationId,
            profile,
            targetTitle,
          );
          createdTarget = true;
        }
      }
      if (JSON.stringify(target.profile.role) !== JSON.stringify(requestedRole)) {
        throw new Error(
          "start_session idempotency key conflicts with an existing conversation",
        );
      }
      if (
        existingCard?.orchestration
        && JSON.stringify(target.profile.orchestration)
          !== JSON.stringify(existingCard.orchestration)
      ) {
        throw new Error(
          "start_session idempotency key conflicts with existing orchestration",
        );
      }

      let queued: {
        status: "created" | "existing" | "delivered";
        envelope: InboxEnvelope;
      };
      try {
        queued = await this.enqueueEnvelope(context, source, target, {
          messageId,
          cardId,
          sentAt: recoveredEnvelope?.sentAt ?? existingCard.updatedAt,
          kind: "delegation_task",
          body: input.task,
          delegationId,
          requestFingerprint,
          fromRunId: sourceRunId,
          requestedRole,
          orchestration: existingCard.orchestration,
          processingRunId: runId,
        });
      } catch (error) {
        let committedEnvelope: InboxEnvelope | undefined;
        try {
          committedEnvelope = await context.inbox.get(messageId);
        } catch (inspectionError) {
          throw new AggregateError(
            [error, inspectionError],
            "Failed to determine whether start_session inbox admission committed",
          );
        }
        if (committedEnvelope !== undefined) throw error;

        const cleanupErrors: unknown[] = [];
        const detail = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1_000);
        try {
          this.appendCard(source, {
            ...existingCard,
            state: "failed",
            result: `${START_SESSION_ADMISSION_FAILURE_PREFIX}${detail}`,
            updatedAt: this.now().toISOString(),
          });
        } catch (cardError) {
          cleanupErrors.push(cardError);
        }
        if (createdTarget) {
          try {
            await this.deleteConversationInternal(
              context,
              target.conversationId,
            );
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "Failed to roll back rejected start_session inbox admission",
          );
        }
        throw error;
      }
      const activity = target.getActivity();
      if (activity.kind === "idle" && queued.status !== "delivered") {
        const settled = this.findSettlement(context, target, runId);
        if (!settled) {
          await this.dispatchBatch(
            context,
            target,
            [queued.envelope],
            runId,
          );
        }
      }
      return { conversationId, runId };
    });
  }

  async prompt(
    handle: ProjectSessionHandle,
    conversationId: string,
    runId: string,
    text: string,
    promptId?: string,
    images?: readonly PromptImage[],
  ): Promise<RunSettlement | { outcome: "admitted" }> {
    const context = this.requireContext(handle);
    const admitted = await this.runLifecycle(context, async () => {
      if (context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      const actor = this.requireActor(context, conversationId);
      // busy：消息与 run 状态无关，进 SDK steering 队列，当前工具序列结束即注入。
      if (actor.getActivity().kind !== "idle") {
        if (promptId === undefined) {
          throw new Error(
            "promptId is required while the agent is busy",
          );
        }
        return actor.admitBrowserPrompt({ promptId, runId, text, images });
      }
      const pump = await this.pumpTarget(context, conversationId);
      if (pump === "blocked_by_deletion" || context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      const pendingInbox = await context.inbox.list({
        toConversationId: conversationId,
      });
      if (
        pump === "started"
        || pendingInbox.length > 0
      ) {
        throw new Error(
          "Durable conversation work was admitted before this browser prompt",
        );
      }
      return {
        completion: actor.startPrompt({
          runId,
          text,
          images,
          origin: "browser",
        }),
      };
    });
    if ("completion" in admitted) return admitted.completion;
    return admitted;
  }

  steer(
    handle: ProjectSessionHandle,
    conversationId: string,
    runId: string,
    text: string,
    images?: readonly PromptImage[],
  ): Promise<void> {
    const context = this.requireContext(handle);
    if (context.deleting.has(conversationId)) {
      return Promise.reject(
        new Error(`Conversation is being deleted: ${conversationId}`),
      );
    }
    return this.requireActor(context, conversationId).steer(runId, text, images);
  }

  async setCompactionThreshold(
    handle: ProjectSessionHandle,
    conversationId: string,
    percent: number,
  ): Promise<void> {
    const context = this.requireContext(handle);
    await this.runLifecycle(context, () => {
      if (context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      this.requireActor(context, conversationId)
        .setCompactionThresholdPercent(percent);
      this.emit(context, { type: "project_changed" });
    });
  }

  async setThinkingLevel(
    handle: ProjectSessionHandle,
    conversationId: string,
    level: ThinkingLevel,
  ): Promise<ThinkingLevelChangeResult> {
    const context = this.requireContext(handle);
    return this.runLifecycle(context, () => {
      if (context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      return this.requireActor(context, conversationId).setThinkingLevel(level);
    });
  }

  async setServiceTier(
    handle: ProjectSessionHandle,
    conversationId: string,
    tier: ServiceTier | null,
  ): Promise<void> {
    const context = this.requireContext(handle);
    await this.runLifecycle(context, () => {
      if (context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      this.requireActor(context, conversationId).setServiceTier(tier);
      this.emit(context, { type: "project_changed" });
    });
  }

  readPersistedImage(
    handle: ProjectSessionHandle,
    conversationId: string,
    messageId: string,
    imageOrdinal: number,
  ): Promise<ConversationImage> {
    const context = this.requireContext(handle);
    return this.runLifecycle(context, () => {
      if (context.deleting.has(conversationId)) {
        throw new Error(`Conversation is being deleted: ${conversationId}`);
      }
      return this.requireActor(context, conversationId).readPersistedImage(
        messageId,
        imageOrdinal,
      );
    });
  }

  async compactContext(
    handle: ProjectSessionHandle,
    conversationId: string,
  ): Promise<void> {
    const context = this.requireContext(handle);
    if (context.deleting.has(conversationId)) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    const actor = this.requireActor(context, conversationId);
    try {
      await actor.compactContext();
    } finally {
      this.emit(context, { type: "project_changed" });
      await this.runLifecycle(context, () =>
        this.retryBlockedDeletions(context)
      );
    }
  }

  abort(
    handle: ProjectSessionHandle,
    conversationId: string,
    runId: string,
  ): Promise<void> {
    const context = this.requireContext(handle);
    return this.requireActor(context, conversationId).abort(runId);
  }

  async renameConversation(
    handle: ProjectSessionHandle,
    conversationId: string,
    title: string,
  ): Promise<void> {
    const context = this.requireContext(handle);
    await this.runLifecycle(context, async () => {
      const actor = await this.getOrOpenActor(context, conversationId);
      actor.session.setSessionName(normalizedTitle(title, "新会话"));
      await context.project.refreshConversations();
    });
  }

  async truncateConversation(
    handle: ProjectSessionHandle,
    conversationId: string,
    entryId: string,
  ): Promise<void> {
    const context = this.requireContext(handle);
    await this.runLifecycle(context, async () => {
      if (this.isReloadProtected(context, conversationId)) {
        throw new Error(
          "Cannot rewind while reload completion acknowledgement is pending",
        );
      }
      const actor = await this.getOrOpenActor(context, conversationId);
      if (actor.getActivity().kind !== "idle") {
        throw new Error(
          "Cannot rewind a busy conversation; abort and wait first",
        );
      }
      const pending = await context.inbox.list({
        toConversationId: conversationId,
      });
      if (pending.length > 0) {
        throw new Error(
          "Cannot rewind while this conversation has pending cross-session messages",
        );
      }
      const aggregate = aggregateReservedConversationEntries(
        actor.sessionManager.getEntries(),
      );
      const settledRunIds = new Set(
        aggregate.runSettlements.map(({ runId }) => runId),
      );
      if (aggregate.messageDeliveryReceipts.some(
        ({ targetRunId }) => !settledRunIds.has(targetRunId),
      )) {
        throw new Error(
          "Cannot rewind while this conversation has an unsettled cross-session delivery",
        );
      }
      await actor.truncateFromMessage(entryId);
      context.profiles.set(conversationId, cloneProfile(actor.profile));
      this.emit(context, { type: "project_changed" });
    });
  }

  async deleteConversation(
    handle: ProjectSessionHandle,
    conversationId: string,
  ): Promise<boolean> {
    const context = this.requireContext(handle);
    if (!this.reserveDeletion(context, conversationId)) return false;
    return this.runLifecycle(context, () =>
      this.deleteConversationInternal(
        context,
        conversationId,
        true,
      )
    );
  }

  conversationHistory(
    handle: ProjectSessionHandle,
    conversationId: string,
  ) {
    const context = this.requireContext(handle);
    const actor = this.requireActor(context, conversationId);
    return projectConversationItemsSnapshot(actor.sessionManager);
  }

  /**
   * Freezes normal admission and stops active Pi loops at completed turn
   * boundaries. The external supervisor owns the returned, process-replacement
   * recovery list; no reload state is added to project persistence.
   */
  async prepareReload(
    force: boolean,
    onAdmissionFrozen: () => void,
  ): Promise<ReloadConversationTarget[]> {
    if (this.closing || this.disposed) {
      throw new Error("Project session coordinator is closing");
    }
    this.closing = true;
    this.disposed = true;
    const lifecycleClosures = new Map<ProjectContext, Promise<void>>();
    for (const context of this.contexts.values()) {
      context.closing = true;
      lifecycleClosures.set(context, context.lifecycle.close());
      this.rejectContextWaiters(
        context,
        new Error("Session wait was interrupted by server reload"),
      );
    }

    const pendingProjectCwds = [...this.projectAcquisitionCwds.values()];
    const targets = new Map<string, ReloadConversationTarget>();
    const addTargetId = (
      cwd: string,
      conversationId: string,
      continueTask: boolean,
    ) => {
      const key = `${cwd}\u0000${conversationId}`;
      const existing = targets.get(key);
      targets.set(key, {
        cwd,
        conversationId,
        continueTask: existing?.continueTask === true || continueTask,
      });
    };
    const addTarget = (
      context: ProjectContext,
      actor: ConversationActor,
      continueTask: boolean,
    ) => addTargetId(
      context.project.cwd,
      actor.conversationId,
      continueTask,
    );
    const inspectDurableProject = async (
      project: ProjectStore,
      inbox: ProjectInbox,
    ): Promise<void> => {
      for (const summary of await project.refreshConversations()) {
        try {
          const inspection = await project.inspectConversation(summary.id);
          const settledRunIds = new Set(
            inspection.runSettlements.map(({ runId }) => runId),
          );
          if (inspection.messageDeliveryReceipts.some(
            ({ targetRunId }) => !settledRunIds.has(targetRunId),
          )) {
            addTargetId(project.cwd, summary.id, false);
          }
        } catch {
          addTargetId(project.cwd, summary.id, false);
        }
      }
      for (const envelope of await inbox.list()) {
        addTargetId(project.cwd, envelope.toConversationId, false);
      }
    };
    const inspectDurableProjects = async (): Promise<void> => {
      const inspected = new Set<string>();
      for (const context of this.contexts.values()) {
        await inspectDurableProject(context.project, context.inbox);
        inspected.add(contextKey(context.project.cwd));
      }
      for (const cwd of pendingProjectCwds) {
        const projectHandle = await this.projects.acquireProject(cwd);
        try {
          const project = projectHandle.store;
          const key = contextKey(project.cwd);
          if (inspected.has(key)) continue;
          const inbox = await ProjectInbox.open(join(project.stateDir, "inbox"));
          await inspectDurableProject(project, inbox);
          inspected.add(key);
        } finally {
          projectHandle.release();
        }
      }
    };

    if (force) {
      for (const context of this.contexts.values()) {
        for (const actor of context.actors.values()) {
          const candidate = actor.activeRunForReload();
          if (candidate) {
            addTarget(context, actor, candidate.origin === "browser");
          }
        }
      }
      onAdmissionFrozen();
      await Promise.allSettled([...this.projectAcquisitions]);
      this.projectAcquisitions.clear();
      await Promise.allSettled([...this.contextOpenings.values()]);
      this.contextOpenings.clear();
      await inspectDurableProjects();
      return [...targets.values()];
    }

    const stops = new Map<ConversationActor, Promise<void>>();
    const latchActor = async (
      context: ProjectContext,
      actor: ConversationActor,
    ): Promise<void> => {
      if (stops.has(actor)) return;
      const candidate = actor.activeRunForReload();
      if (!candidate) return;
      let preserveSettlement = false;
      if (candidate.origin === "inbox") {
        try {
          const envelopes = await context.inbox.list({
            toConversationId: actor.conversationId,
          });
          const aggregate = aggregateReservedConversationEntries(
            actor.sessionManager.getEntries(),
          );
          const settledRunIds = new Set(
            aggregate.runSettlements.map(({ runId }) => runId),
          );
          preserveSettlement = envelopes.some((envelope) =>
            envelope.state === "processing"
            && envelope.processingRunId === candidate.runId
          ) || aggregate.messageDeliveryReceipts.some((receipt) =>
            receipt.targetRunId === candidate.runId
            && !settledRunIds.has(candidate.runId)
          );
        } catch (error) {
          preserveSettlement = true;
          console.warn(
            `Could not inspect durable inbox recovery for ${actor.conversationId}; preserving its exact run for reload:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const stop = actor.stopForReload(preserveSettlement);
      void stop.catch(() => undefined);
      stops.set(actor, stop);
      addTarget(context, actor, candidate.origin === "browser");
    };

    // The caller only acknowledges `npm run reload` after every run which
    // already existed at admission freeze has a stop latch. Otherwise the
    // invoking Bash result could cross one more provider boundary first.
    await Promise.all(
      [...this.contexts.values()].flatMap((context) =>
        [...context.actors.values()].map((actor) => latchActor(context, actor))
      ),
    );
    onAdmissionFrozen();

    await Promise.allSettled([...this.projectAcquisitions]);
    this.projectAcquisitions.clear();
    await Promise.allSettled([...this.contextOpenings.values()]);
    this.contextOpenings.clear();
    const lifecycleResults = await Promise.allSettled(
      [...this.contexts].map(async ([, context]) => {
        await (lifecycleClosures.get(context) ?? context.lifecycle.close());
        await this.drainRecentUpdates(context);
      }),
    );
    for (const result of lifecycleResults) {
      if (result.status === "rejected") {
        console.warn(
          "A project lifecycle could not finish draining for reload; captured recovery targets are retained:",
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }

    const stopResults = await Promise.allSettled(
      [...this.contexts.values()].flatMap((context) =>
        [...context.actors.values()].map(async (actor) => {
          await latchActor(context, actor);
          await (stops.get(actor) ?? actor.stopForReload(false));
        })
      ),
    );
    for (const result of stopResults) {
      if (result.status === "rejected") {
        console.warn(
          "A conversation could not reach its reload boundary; its recovery target was retained:",
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }

    // A run can enter settlement between the initial snapshot and the latch.
    // Since closing suppresses normal inbox completion handling, durable disk
    // facts (including actor-absent and inspection-failed targets) are the
    // final recovery authority.
    await inspectDurableProjects();
    return [...targets.values()];
  }

  async resumeAfterReload(
    requestId: string,
    targets: readonly ReloadConversationTarget[],
    onTargetCompleted: (completion: ReloadTargetCompletion) => Promise<void>,
  ): Promise<ReloadResumeDisposition[]> {
    const dispositions: ReloadResumeDisposition[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const key = reloadReservationKey(target.cwd, target.conversationId);
      const existing = this.reloadReservations.get(key);
      if (existing && existing.requestId !== requestId) {
        throw new Error("Reload reservation conflicts with another request");
      }
      if (!existing) {
        this.reloadReservations.set(key, {
          requestId,
          cwd: target.cwd,
          conversationId: target.conversationId,
        });
      }
    }
    for (const target of targets) {
      const key = `${target.cwd}\u0000${target.conversationId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let handle: ProjectSessionHandle | undefined;
      let attemptContext: ProjectContext | undefined;
      try {
        if (target.continueTask && target.continuationRunId === undefined) {
          throw new Error("Reload continuation requires continuationRunId");
        }
        handle = await this.acquireProject(target.cwd);
        const context = this.requireContext(handle);
        attemptContext = context;
        const disposition = await this.runLifecycle<ReloadResumeDisposition>(
          context,
          async () => {
            const actor = await this.getOrOpenActor(
              context,
              target.conversationId,
            );
            const markerAdoptedRunId = target.continueTask
              ? actor.reloadContinuationAdoptedRunId({
                  requestId,
                  continuationRunId: target.continuationRunId!,
                })
              : undefined;
            if (
              target.adoptedRunId !== undefined
              && markerAdoptedRunId !== undefined
              && target.adoptedRunId !== markerAdoptedRunId
            ) {
              throw new Error(
                "Reload manifest adoption conflicts with its continuation marker",
              );
            }
            const adoptedRunId = target.adoptedRunId ?? markerAdoptedRunId;
            const aggregate = aggregateReservedConversationEntries(
              actor.sessionManager.getEntries(),
            );
            const settledRunId = target.continueTask
              ? adoptedRunId ?? target.continuationRunId
              : adoptedRunId;
            const settled = settledRunId === undefined
              ? undefined
              : aggregate.runSettlements.find(
                  ({ runId }) => runId === settledRunId,
                );
            if (settled) {
              context.completions.set(
                completionKey(target.conversationId, settledRunId!),
                cloneSettlement(settled),
              );
              if (target.continueTask) {
                this.registerReloadAdoption(
                  context,
                  target.conversationId,
                  requestId,
                  settledRunId!,
                  onTargetCompleted,
                );
              }
              if (actor.getActivity().kind === "idle") {
                await this.pumpTarget(context, target.conversationId);
              }
              const drained = !await this.reloadTargetHasPendingWork(
                context,
                target.conversationId,
              );
              if (
                !target.continueTask
                && adoptedRunId === undefined
                && drained
              ) {
                return {
                  cwd: target.cwd,
                  conversationId: target.conversationId,
                  disposition: "completed",
                };
              }
              this.registerReloadAdoption(
                context,
                target.conversationId,
                requestId,
                settledRunId!,
                onTargetCompleted,
              );
              await this.maybeCompleteReloadAdoption(
                context,
                target.conversationId,
              );
              return {
                cwd: target.cwd,
                conversationId: target.conversationId,
                disposition: "adopted",
                runId: settledRunId!,
              };
            }

            if (actor.getActivity().kind === "idle") {
              await this.pumpTarget(context, target.conversationId);
            }
            let active = actor.activeRunForReload();
            if (
              adoptedRunId !== undefined
              && active?.runId !== adoptedRunId
            ) {
              if (active) {
                return {
                  cwd: target.cwd,
                  conversationId: target.conversationId,
                  disposition: "retry",
                };
              }
              this.registerReloadAdoption(
                context,
                target.conversationId,
                requestId,
                adoptedRunId,
                onTargetCompleted,
              );
              if (!target.continueTask) {
                void actor.resumeMessages({
                  runId: adoptedRunId,
                }).catch(() => undefined);
              } else if (adoptedRunId === target.continuationRunId) {
                void actor.startReloadContinuation({
                  requestId,
                  continuationRunId: target.continuationRunId!,
                }).catch(() => undefined);
              } else {
                void actor.resumeMessages({
                  runId: adoptedRunId,
                }).catch(() => undefined);
                await actor.queueReloadContinuation({
                  requestId,
                  continuationRunId: target.continuationRunId!,
                  runId: adoptedRunId,
                });
              }
              active = actor.activeRunForReload();
            }

            if (active) {
              if (!target.continueTask && active.origin !== "inbox") {
                return {
                  cwd: target.cwd,
                  conversationId: target.conversationId,
                  disposition: "retry",
                };
              }
              if (target.continueTask) {
                if (active.origin === "inbox") {
                  await actor.queueReloadContinuation({
                    requestId,
                    continuationRunId: target.continuationRunId!,
                    runId: active.runId,
                  });
                } else if (active.runId === target.continuationRunId) {
                  void actor.startReloadContinuation({
                    requestId,
                    continuationRunId: target.continuationRunId!,
                  }).catch(() => undefined);
                } else {
                  return {
                    cwd: target.cwd,
                    conversationId: target.conversationId,
                    disposition: "retry",
                  };
                }
              }
              this.registerReloadAdoption(
                context,
                target.conversationId,
                requestId,
                active.runId,
                onTargetCompleted,
              );
              return {
                cwd: target.cwd,
                conversationId: target.conversationId,
                disposition: "adopted",
                runId: active.runId,
              };
            }

            if (!target.continueTask) {
              const pending = await context.inbox.list({
                toConversationId: target.conversationId,
              });
              return {
                cwd: target.cwd,
                conversationId: target.conversationId,
                disposition: pending.length === 0 ? "completed" : "retry",
              };
            }
            const continuationRunId = target.continuationRunId!;
            this.registerReloadAdoption(
              context,
              target.conversationId,
              requestId,
              continuationRunId,
              onTargetCompleted,
            );
            void actor.startReloadContinuation({
              requestId,
              continuationRunId,
            }).catch(() => undefined);
            return {
              cwd: target.cwd,
              conversationId: target.conversationId,
              disposition: "adopted",
              runId: continuationRunId,
            };
          },
        );
        dispositions.push(disposition);
        this.recordReloadDisposition(requestId, disposition);
      } catch (error) {
        const reservation = this.reloadReservations.get(reloadReservationKey(
          target.cwd,
          target.conversationId,
        ));
        const provisionalAdoption = attemptContext?.reloadAdoptions.get(
          target.conversationId,
        );
        if (
          reservation?.requestId === requestId
          && reservation.disposition === undefined
          && provisionalAdoption?.requestId === requestId
        ) {
          attemptContext!.reloadAdoptions.delete(target.conversationId);
        }
        console.warn(
          `Failed to resume reloaded conversation ${target.conversationId}:`,
          error instanceof Error ? error.message : String(error),
        );
        const disposition: ReloadResumeDisposition = {
          cwd: target.cwd,
          conversationId: target.conversationId,
          disposition: "retry",
        };
        dispositions.push(disposition);
        this.recordReloadDisposition(requestId, disposition);
      } finally {
        handle?.release();
      }
    }
    return dispositions;
  }

  async acknowledgeReloadDispositions(
    requestId: string,
    dispositions: readonly ReloadResumeDisposition[],
  ): Promise<void> {
    const receivedByKey = new Map(dispositions.map((disposition) => [
      reloadReservationKey(disposition.cwd, disposition.conversationId),
      disposition,
    ]));
    if (receivedByKey.size !== dispositions.length) {
      throw new Error("Reload disposition acknowledgement contains duplicates");
    }
    for (const received of dispositions) {
      const reservation = this.reloadReservations.get(reloadReservationKey(
        received.cwd,
        received.conversationId,
      ));
      if (
        !reservation
        || reservation.requestId !== requestId
        || reservation.disposition === undefined
        || JSON.stringify(received) !== JSON.stringify(reservation.disposition)
      ) {
        throw new Error("Reload disposition acknowledgement identity conflicts");
      }
    }

    for (const disposition of dispositions) {
      if (disposition.disposition === "adopted") continue;
      this.reloadReservations.delete(reloadReservationKey(
        disposition.cwd,
        disposition.conversationId,
      ));
    }
  }

  private recordReloadDisposition(
    requestId: string,
    disposition: ReloadResumeDisposition,
  ): void {
    const reservation = this.reloadReservations.get(reloadReservationKey(
      disposition.cwd,
      disposition.conversationId,
    ));
    if (!reservation || reservation.requestId !== requestId) {
      throw new Error("Reload disposition has no matching reservation");
    }
    if (
      reservation.disposition
      && JSON.stringify(reservation.disposition) !== JSON.stringify(disposition)
    ) {
      throw new Error("Reload disposition conflicts with its reservation");
    }
    reservation.disposition = disposition;
  }

  private isReloadProtected(
    context: ProjectContext,
    conversationId: string,
  ): boolean {
    return context.reloadAdoptions.has(conversationId)
      || this.reloadReservations.has(reloadReservationKey(
        context.project.cwd,
        conversationId,
      ));
  }

  private registerReloadAdoption(
    context: ProjectContext,
    conversationId: string,
    requestId: string,
    runId: string,
    onCompleted: (completion: ReloadTargetCompletion) => Promise<void>,
  ): void {
    const existing = context.reloadAdoptions.get(conversationId);
    if (existing) {
      if (existing.requestId !== requestId || existing.runId !== runId) {
        throw new Error("Reload adoption identity conflicts with active ownership");
      }
      return;
    }
    const reservation = this.reloadReservations.get(reloadReservationKey(
      context.project.cwd,
      conversationId,
    ));
    if (!reservation || reservation.requestId !== requestId) {
      throw new Error("Reload adoption has no matching startup reservation");
    }
    context.reloadAdoptions.set(conversationId, {
      requestId,
      runId,
      notifying: false,
      onCompleted,
    });
  }

  private rejectContextWaiters(context: ProjectContext, error: Error): void {
    const waiters = new Set(
      [...context.completionWaiters.values()].flatMap((entries) => [...entries]),
    );
    context.completionWaiters.clear();
    for (const waiter of waiters) waiter.reject(error);
    for (const actor of context.actors.values()) {
      const attempt = actor.getCurrentWaitAttempt();
      if (attempt) actor.cancelWaitAttempt(attempt.ownership, attempt.handle);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.disposed = true;
    const lifecycleClosures = new Map<ProjectContext, Promise<void>>();
    for (const context of this.contexts.values()) {
      context.closing = true;
      context.lsp?.closeAdmission();
      lifecycleClosures.set(context, context.lifecycle.close());
    }
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      await Promise.allSettled([...this.projectAcquisitions]);
      this.projectAcquisitions.clear();
      await Promise.allSettled([...this.contextOpenings.values()]);
      this.contextOpenings.clear();
      for (const context of this.contexts.values()) {
        for (const router of context.extensionUIRouters.values()) {
          router.clear();
        }
        this.rejectContextWaiters(
          context,
          new Error("Project session coordinator is closed"),
        );
        await (
          lifecycleClosures.get(context)
          ?? context.lifecycle.close()
        );
        await this.drainRecentUpdates(context);
        if (context.modelCatalogOpening) {
          await Promise.allSettled([context.modelCatalogOpening]);
        }
        if (context.modelCatalog) {
          try {
            await context.modelCatalog.dispose();
          } catch (error) {
            failures.push(error);
          }
          context.modelCatalog = undefined;
        }
        await Promise.allSettled([...context.actorOpenings.values()]);
        for (const actor of context.actors.values()) {
          try {
            await actor.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        await Promise.allSettled([...context.actorOpenings.values()]);
        try {
          await context.lsp?.dispose();
        } catch (error) {
          failures.push(error);
        }
        context.lsp = undefined;
        await this.drainBackground(context);
        await context.project.drainPendingObservations();
        context.extensionUIRouters.clear();
        try {
          context.unsubscribeProject();
        } catch (error) {
          failures.push(error);
        }
        context.projectHandle.release();
        context.listeners.clear();
      }
      this.contexts.clear();
      this.projectActivityListeners.clear();
      this.projectActivitySummaries.clear();
      this.projectActivityCatalog.clear();
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Failed to close project session coordinator",
        );
      }
    })();
    return this.closePromise;
  }

  private createConversationActor(
    context: ProjectContext,
    conversationId: string,
    profile: ConversationMeta,
    title?: string,
  ): Promise<ConversationActor> {
    if (context.closing || this.disposed) {
      return Promise.reject(new Error("Project context is closing"));
    }
    if (context.deleting.has(conversationId)) {
      return Promise.reject(
        new Error(`Conversation is being deleted: ${conversationId}`),
      );
    }
    const existing = context.actors.get(conversationId);
    if (existing) {
      return Promise.reject(
        new Error(`Conversation is already active: ${conversationId}`),
      );
    }
    const opening = context.actorOpenings.get(conversationId);
    if (opening) return opening;
    const creation = this.createOwnedConversationActor(
      context,
      conversationId,
      profile,
      title,
    );
    context.actorOpenings.set(conversationId, creation);
    void creation.finally(() => {
      if (context.actorOpenings.get(conversationId) === creation) {
        context.actorOpenings.delete(conversationId);
      }
    }).catch(() => undefined);
    return creation;
  }

  private async createOwnedConversationActor(
    context: ProjectContext,
    conversationId: string,
    profile: ConversationMeta,
    title?: string,
  ): Promise<ConversationActor> {
    const lease = this.projects.acquireConversation(
      context.project.cwd,
      conversationId,
    );
    let manager;
    let actor: ConversationActor | undefined;
    try {
      manager = await context.project.createConversation(
        conversationId,
        profile,
        { updateRecent: profile.createdBy.kind === "user" },
      );
      actor = await this.openOwnedActor(
        context,
        conversationId,
        manager,
        lease,
        profile,
      );
      if (title) actor.session.setSessionName(title);
      await context.project.refreshConversations();
      return actor;
    } catch (error) {
      let deletion;
      try {
        if (actor) {
          context.actorUnsubscribes.get(conversationId)?.();
          context.actorUnsubscribes.delete(conversationId);
          context.actors.delete(conversationId);
          context.profiles.delete(conversationId);
          deletion = await actor.dispose({
            transferLeaseForDeletion: true,
          });
        } else {
          lease.release();
          const cleanup = this.projects.acquireConversation(
            context.project.cwd,
            conversationId,
          );
          deletion = cleanup.upgradeToDeletion();
        }
        await context.project.deleteConversation(conversationId);
      } catch {
        // Preserve the original creation failure.
      } finally {
        deletion?.release();
      }
      throw error;
    }
  }

  private getOrOpenActor(
    context: ProjectContext,
    conversationId: string,
  ): Promise<ConversationActor> {
    if (context.closing || this.disposed) {
      return Promise.reject(new Error("Project context is closing"));
    }
    if (context.deleting.has(conversationId)) {
      return Promise.reject(
        new Error(`Conversation is being deleted: ${conversationId}`),
      );
    }
    const existing = context.actors.get(conversationId);
    if (existing) return Promise.resolve(existing);
    const opening = context.actorOpenings.get(conversationId);
    if (opening) return opening;

    const promise = (async () => {
      const lease = await this.projects.acquireConversationWhenAvailable(
        context.project.cwd,
        conversationId,
      );
      try {
        const manager = await context.project.openConversation(
          conversationId,
          { updateRecent: false },
        );
        const profile = this.loadProfile(manager);
        return await this.openOwnedActor(
          context,
          conversationId,
          manager,
          lease,
          profile,
        );
      } catch (error) {
        lease.release();
        throw error;
      }
    })();
    context.actorOpenings.set(conversationId, promise);
    void promise.finally(() => {
      if (context.actorOpenings.get(conversationId) === promise) {
        context.actorOpenings.delete(conversationId);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async openOwnedActor(
    context: ProjectContext,
    conversationId: string,
    manager: Awaited<ReturnType<ProjectStore["openConversation"]>>,
    lease: ReturnType<ProjectStoreRegistry["acquireConversation"]>,
    profile: ConversationMeta,
  ): Promise<ConversationActor> {
    let actor!: ConversationActor;
    actor = await ConversationActor.open({
      conversationId,
      profile,
      project: context.project,
      sessionManager: manager,
      conversationLease: lease,
      runtime: this.runtime,
      toolPolicy: this.toolPolicy,
      createSessionOptions: this.createActorSessionOptions(
        context,
        conversationId,
        profile,
      ),
      createSessionOptionsForProfile: (retainedProfile) =>
        this.createActorSessionOptions(
          context,
          conversationId,
          retainedProfile,
        ),
      persistSettlement: (settlement, sessionManager) => {
        appendReservedCustomEntry(
          sessionManager,
          createRunSettlementEntry(settlement),
        );
      },
      onCompletion: (completion) => {
        this.onActorCompletion(context, actor, completion);
      },
    });
    if (
      context.closing
      || this.disposed
      || context.deleting.has(conversationId)
    ) {
      await actor.dispose();
      throw new Error(
        context.deleting.has(conversationId)
          ? `Conversation is being deleted: ${conversationId}`
          : "Project context closed while conversation was opening",
      );
    }
    context.actors.set(conversationId, actor);
    context.profiles.set(conversationId, cloneProfile(profile));
    const unsubscribe = actor.subscribe((event) => {
      if (
        event.type === "session_event"
        && (
          event.event.type === "run_started"
          || event.event.type === "user_message"
          || event.event.type === "usage"
        )
        && !context.closing
      ) {
        this.trackBackground(
          context,
          this.runLifecycle(context, async () => {
            await this.reconcileInbox(context, conversationId);
          }),
        );
      }
      if (
        event.type === "compaction"
        && !event.compacting
        && !context.closing
      ) {
        this.trackBackground(
          context,
          this.runLifecycle(context, () => this.maybeCompleteReloadAdoption(
            context,
            conversationId,
          )),
        );
      }
      if (event.type === "error") {
        context.attention.add(conversationId);
        if (event.fatal && !context.closing) {
          const failure = new Error(event.message);
          this.trackBackground(
            context,
            this.runLifecycle(context, async () => {
              if (event.runId !== undefined) {
                this.rejectRunWaiters(
                  context,
                  conversationId,
                  event.runId,
                  failure,
                );
              }
              await this.retryBlockedDeletions(context);
            }),
          );
        }
      }
      this.emit(context, event);
    });
    context.actorUnsubscribes.set(conversationId, unsubscribe);
    this.emit(context, { type: "project_changed" });
    this.trackBackground(
      context,
      this.runLifecycle(context, async () => {
        await this.pumpTarget(context, conversationId);
      }),
    );
    return actor;
  }

  private createActorSessionOptions(
    context: ProjectContext,
    conversationId: string,
    profile: ConversationMeta,
  ): CreatePiSessionOptions {
    return {
      model: { ...profile.role.model },
      ...(profile.role.compactionModel === null
        ? {}
        : { compactionModel: { ...profile.role.compactionModel } }),
      thinkingLevel: profile.role.defaultThinkingLevel,
      roleSystemPrompt: profile.role.systemPrompt,
      toolMode: profile.role.toolMode,
      extensionUI: this.extensionUIRouter(context, conversationId).ui,
      workbenchCustomTools: [
        ...createNotebookTools(context.project.stateDir, conversationId),
        ...createLspTools(context.project.cwd, {
          query: async (input, signal) => {
            if (context.closing) throw new LspError("unavailable", "LSP workspace is closing");
            if (!context.lsp) {
              // Dialogs belong to the caller; shared initialization does not. A cancelled
              // dialog neither grants trust nor poisons another actor's own decision.
              const trusted = await this.runtime.ensureProjectAnalysisTrust?.(
                context.project.cwd,
                this.extensionUIRouter(context, conversationId).ui,
                signal,
              );
              if (signal.aborted) throw new LspError("cancelled", "LSP trust request cancelled");
              if (context.closing) throw new LspError("unavailable", "LSP workspace is closing");
              if (!trusted) throw new LspError("untrusted", "Project execution trust is required for local language servers");
              context.lsp ??= new WorkspaceLsp(context.project.cwd, {
                resolveServer: (file) => resolveLspServer(context.project.cwd, file),
              });
            }
            return context.lsp.query(input, signal);
          },
        }),
        ...createMetaTools(
          conversationId,
          this.metaService(context),
          profile.role.canManageSessions,
        ),
      ],
    };
  }

  private rejectRunWaiters(
    context: ProjectContext,
    conversationId: string,
    runId: string,
    error: Error,
  ): void {
    this.completeWaitAttemptsForTarget(context, conversationId, runId);
    const key = completionKey(conversationId, runId);
    const waiters = context.completionWaiters.get(key);
    if (!waiters) return;
    context.completionWaiters.delete(key);
    for (const waiter of waiters) waiter.reject(error);
  }

  private recordCompletion(
    context: ProjectContext,
    conversationId: string,
    settlement: RunSettlement,
  ): void {
    const key = completionKey(conversationId, settlement.runId);
    if (!context.completions.has(key)) {
      context.completions.set(key, cloneSettlement(settlement));
      while (context.completions.size > MAX_COMPLETION_CACHE) {
        const oldest = context.completions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        context.completions.delete(oldest);
      }
    }
    this.completeWaitAttemptsForTarget(
      context, conversationId, settlement.runId, settlement,
    );
    const waiters = context.completionWaiters.get(key);
    if (!waiters) return;
    context.completionWaiters.delete(key);
    for (const waiter of waiters) waiter.resolve(cloneSettlement(settlement));
  }

  private completeWaitAttemptsForTarget(
    context: ProjectContext,
    conversationId: string,
    runId: string,
    _settlement?: RunSettlement,
  ): void {
    for (const source of context.actors.values()) {
      const attempt = source.getCurrentWaitAttempt();
      if (!attempt || !attempt.targets.some((target) => (
        target.conversationId === conversationId && target.runId === runId
      ))) continue;
      source.completeWaitAttempt(attempt.ownership, attempt.handle);
    }
  }

  private async waitForSessionTargetsLocal(
    context: ProjectContext,
    sourceConversationId: string,
    targets: readonly ConversationWaitingTarget[],
    signal?: AbortSignal,
  ): Promise<SessionWaitResult> {
    if (targets.some((target) => target.conversationId === sourceConversationId)) {
      throw new Error("An Agent cannot wait for its own current run");
    }
    this.throwIfAborted(signal);
    const source = this.requireActor(context, sourceConversationId);
    const ownership = source.currentRunOwnership();
    if (!ownership) throw new Error("No running source turn owns this wait");
    const assertOwnership = () => {
      this.throwIfAborted(signal);
      if (source.currentRunOwnership() !== ownership) {
        throw new Error("The source run no longer owns this wait");
      }
    };
    let acceptedMessage: InboxEnvelope | undefined;
    const isEnvelope = (
      candidate: SessionWaitResult | InboxEnvelope,
    ): candidate is InboxEnvelope => "version" in candidate;
    const immediate = async (
      includePendingGuidance = true,
      includeEnvelopeReplies = true,
    ): Promise<SessionWaitResult | InboxEnvelope | undefined> => {
      assertOwnership();
      if (includePendingGuidance && source.claimPendingGuidanceForWait(ownership)) {
        this.emit(context, { type: "project_changed" });
        return { outcome: "guidance" };
      }
      if (includeEnvelopeReplies) {
        const accepted = await this.findClaimedPendingWaitReply(
          context,
          source,
          ownership.runId,
        );
        assertOwnership();
        if (accepted && source.claimAcceptedCustomMessageForWait(
          ownership,
          accepted.messageId,
        )) {
          await context.inbox.updateState(accepted.messageId, {
            state: "processing",
            processingRunId: ownership.runId,
            ...(accepted.processingDelivery === undefined
              ? {}
              : { processingDelivery: accepted.processingDelivery }),
            waitedByRunId: ownership.runId,
          });
          assertOwnership();
          source.retireAcceptedCustomMessageForWait(ownership, accepted.messageId);
          acceptedMessage = accepted;
          return accepted;
        }
        const reply = await this.findCommittedWaitReply(
          context, sourceConversationId, targets, ownership.runId,
        );
        assertOwnership();
        if (reply) return reply;
      }
      const settlements: Array<{ target: ConversationWaitingTarget; settlement: RunSettlement }> = [];
      for (const target of targets) {
        const actor = context.actors.get(target.conversationId);
        const settlement = actor
          ? this.findSettlement(context, actor, target.runId)
          : context.completions.get(completionKey(target.conversationId, target.runId));
        if (settlement) {
          settlements.push({ target, settlement: cloneSettlement(settlement) });
        }
      }
      if (settlements.length > 0) {
        const first = settlements.sort((left, right) =>
          targets.indexOf(left.target) - targets.indexOf(right.target)
        )[0]!;
        return {
          conversationId: first.target.conversationId,
          ...cloneSettlement(first.settlement),
        };
      }
      for (const target of targets) {
        const actor = context.actors.get(target.conversationId);
        if (actor?.getState().fatalError !== undefined) {
          return { outcome: "target_unreachable", ...target };
        }
        const activity = actor?.getActivity();
        if (activity?.kind !== undefined && activity.kind !== "idle"
          && activity.runId === target.runId) continue;
        if (context.actorOpenings.has(target.conversationId)
          || context.processingBatches.has(
            completionKey(target.conversationId, target.runId),
          )
          || context.reloadAdoptions.get(target.conversationId)?.runId === target.runId) continue;
        const inspection = await context.project.inspectConversation(target.conversationId);
        assertOwnership();
        const durable = inspection.runSettlements.find((entry) => entry.runId === target.runId);
        if (durable) {
          return {
            conversationId: target.conversationId,
            ...cloneSettlement(durable),
          };
        }
        if (!inspection.conversationMeta) return { outcome: "target_unreachable", ...target };
        const opened = await raceWithAbort(
          this.getOrOpenActor(context, target.conversationId),
          signal,
        );
        assertOwnership();
        const openedSettlement = this.findSettlement(context, opened, target.runId);
        if (openedSettlement) {
          return {
            conversationId: target.conversationId,
            ...cloneSettlement(openedSettlement),
          };
        }
        const openedActivity = opened.getActivity();
        if (openedActivity.kind === "idle" || openedActivity.runId !== target.runId) {
          return { outcome: "target_unreachable", ...target };
        }
      }
      return undefined;
    };
    const first = await this.runLifecycle(context, immediate);
    assertOwnership();
    if (first && !isEnvelope(first)) return first;
    if (
      first
      && isEnvelope(first)
      && acceptedMessage?.messageId === first.messageId
    ) {
      return this.sessionMessageWaitResult(
        first,
        first.fromRunId,
      );
    }
    let handle!: ConversationWaitAttempt;
    let terminalCause: ConversationWaitAttemptTerminalCause | undefined;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      let racedResult: SessionWaitResult | undefined;
      await this.runLifecycle(context, async () => {
        assertOwnership();
        const raced = await immediate();
        assertOwnership();
        if (raced && !isEnvelope(raced)) {
          racedResult = raced;
          return;
        }
        handle = source.installWaitAttempt(ownership, {
          targets,
          onTerminal: (cause) => {
            terminalCause = cause;
            resolveTerminal();
          },
        });
        source.onWaitingSteerAdmitted(ownership, handle, () => {
          this.emit(context, { type: "project_changed" });
          return true;
        });
        if (signal) {
          abortListener = () => {
            source.cancelWaitAttempt(ownership, handle, { kind: "abort" });
          };
          signal.addEventListener("abort", abortListener, { once: true });
          if (signal.aborted) abortListener();
        }
        if (raced) {
          if (acceptedMessage?.messageId === raced.messageId) {
            if (source.claimWaitAttemptDelivery(ownership, handle)) {
              source.completeWaitAttempt(ownership, handle, "delivering", {
                kind: "message",
                messageId: raced.messageId,
              });
            }
          } else {
            await this.deliverEnvelopeToWaitingRun(context, source, raced, raced.fromRunId!);
          }
          assertOwnership();
        }
        if (source.getWaitAttempt(ownership, handle)?.status === "open") {
          timer = setTimeout(() => {
            void this.runLifecycle(context, async () => {
              if (source.getWaitAttempt(ownership, handle)?.status !== "open") return;
              const result = await immediate(false);
              assertOwnership();
              if (source.getWaitAttempt(ownership, handle)?.status !== "open") return;
              if (result && !isEnvelope(result)) {
                if (source.completeWaitAttempt(ownership, handle, "open", {
                  kind: "settlement",
                })) {
                  racedResult = result;
                }
                return;
              }
              if (result && isEnvelope(result)) {
                if (acceptedMessage?.messageId === result.messageId) {
                  if (source.claimWaitAttemptDelivery(ownership, handle)) {
                    source.completeWaitAttempt(ownership, handle, "delivering", {
                      kind: "message",
                      messageId: result.messageId,
                    });
                  }
                } else {
                  await this.deliverEnvelopeToWaitingRun(
                    context,
                    source,
                    result,
                    result.fromRunId!,
                  );
                  assertOwnership();
                }
                return;
              }
              source.completeWaitAttempt(ownership, handle, "open", {
                kind: "poll",
              });
            }).catch((error: unknown) => {
              source.cancelWaitAttempt(ownership, handle, { kind: "error", error });
            });
          }, WAIT_POLL_DELAY_MS);
          timer.unref?.();
        }
      });
      if (racedResult) return racedResult;
      await terminal;
      timer && clearTimeout(timer);
      if (racedResult) return racedResult;
      if (!terminalCause) {
        throw new Error("A wait attempt ended without a terminal cause");
      }
      switch (terminalCause.kind) {
        case "abort":
          throw abortError("Session wait was aborted");
        case "error":
          throw terminalCause.error;
        case "guidance":
          return { outcome: "guidance" };
        case "poll":
          return { outcome: "checkpoint" };
        case "message": {
          const message = await context.inbox.get(terminalCause.messageId);
          assertOwnership();
          if (!message) {
            throw new Error("Waiting message disappeared before it could be returned");
          }
          return this.sessionMessageWaitResult(
            message,
            message.fromRunId,
          );
        }
        case "settlement":
        case "cancelled": {
          const result = await this.runLifecycle(
            context,
            () => immediate(false, false),
          );
          assertOwnership();
          if (result && !isEnvelope(result)) return result;
          throw new Error("A wait attempt ended without an observable terminal result");
        }
      }
      throw new Error("Unknown wait terminal cause");
    } finally {
      timer && clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      if (handle) source.cancelWaitAttempt(ownership, handle);
    }
  }


  private sessionMessageWaitResult(
    envelope: InboxEnvelope,
    sourceRunId?: string,
  ): SessionMessageWaitResult {
    const messageRunId = envelope.fromRunId ?? sourceRunId;
    return {
      outcome: "message",
      conversationId: envelope.fromConversationId,
      ...(messageRunId === undefined ? {} : { runId: messageRunId }),
      messageId: envelope.messageId,
      sentAt: envelope.sentAt,
    };
  }

  private async findClaimedPendingWaitReply(
    context: ProjectContext,
    source: ConversationActor,
    runId: string,
  ): Promise<InboxEnvelope | undefined> {
    const pending = await context.inbox.list({
      toConversationId: source.conversationId,
    });
    const delivered = new Set(
      aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).deliveredMessageIds,
    );
    const ownership = source.currentRunOwnership(runId);
    if (!ownership) return undefined;
    for (const envelope of pending) {
      if (delivered.has(envelope.messageId)) continue;
      if (envelope.waitedByRunId === runId) continue;
      if (
        envelope.state === "processing"
        && envelope.processingRunId === runId
        && source.hasAcceptedCustomMessageForWait(ownership, envelope.messageId)
      ) return envelope;
      return undefined;
    }
    return undefined;
  }

  private async findCommittedWaitReply(
    context: ProjectContext,
    sourceConversationId: string,
    targets: readonly ConversationWaitingTarget[],
    sourceRunId: string,
  ): Promise<InboxEnvelope | undefined> {
    const targetKeys = new Set(targets.map((target) =>
      completionKey(target.conversationId, target.runId)
    ));
    const pending = await context.inbox.list({ toConversationId: sourceConversationId });
    return pending.find((envelope) =>
      envelope.fromRunId !== undefined
      && targetKeys.has(completionKey(
        envelope.fromConversationId,
        envelope.fromRunId,
      ))
      && envelope.waitedByRunId !== sourceRunId
    );
  }

  private findSettlement(
    context: ProjectContext,
    target: ConversationActor,
    runId: string,
  ): RunSettlement | undefined {
    const cached = context.completions.get(
      completionKey(target.conversationId, runId),
    );
    if (cached) return cloneSettlement(cached);
    const aggregate = aggregateReservedConversationEntries(
      target.sessionManager.getEntries(),
    );
    const durable = aggregate.runSettlements.find(
      (settlement) => settlement.runId === runId,
    );
    return durable ? cloneSettlement(durable) : undefined;
  }

  private observeSettlement(
    context: ProjectContext,
    target: ConversationActor,
    runId: string,
  ): Promise<RunSettlement> {
    const existing = this.findSettlement(context, target, runId);
    if (existing) return Promise.resolve(existing);
    return new Promise<RunSettlement>((resolve, reject) => {
      const key = completionKey(target.conversationId, runId);
      const waiter: CompletionWaiter = {
        kind: "completion",
        resolve,
        reject,
      };
      let waiters = context.completionWaiters.get(key);
      if (!waiters) {
        waiters = new Set();
        context.completionWaiters.set(key, waiters);
      }
      waiters.add(waiter);
      try {
        const raced = this.findSettlement(context, target, runId);
        if (!raced) return;
        waiters.delete(waiter);
        if (waiters.size === 0) context.completionWaiters.delete(key);
        resolve(raced);
      } catch (error) {
        waiters.delete(waiter);
        if (waiters.size === 0) context.completionWaiters.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async retryBlockedDeletions(
    context: ProjectContext,
  ): Promise<void> {
    await this.retryDurableDeletions(context);
  }

  private async retryDurableDeletions(
    context: ProjectContext,
  ): Promise<void> {
    for (const conversationId of await context.inbox.listDeletedTargets()) {
      if (context.closing) return;
      if (!context.deleting.has(conversationId)) {
        context.deleting.add(conversationId);
      }
      try {
        await this.deleteConversationInternal(
          context,
          conversationId,
          true,
          undefined,
          true,
        );
      } catch {
        context.attention.add(conversationId);
      }
    }
  }

  private loadProfile(
    manager: Awaited<ReturnType<ProjectStore["openConversation"]>>,
  ): ConversationMeta {
    const profile = aggregateReservedConversationEntries(
      manager.getBranch(),
    ).conversationMeta;
    if (profile === undefined) {
      throw new Error("Conversation profile metadata is missing");
    }
    return cloneProfile(profile);
  }

  private metaService(context: ProjectContext): MetaToolService {
    const roleForSource = (sourceConversationId: string, roleId: string) => {
      const source = this.requireActor(context, sourceConversationId);
      const role = this.roles.listRoles(source.modelRegistry)
        .find(({ id }) => id === roleId);
      if (!role) throw new Error(`Role not found: ${roleId}`);
      return { source, role };
    };

    return {
      listRoles: async (sourceConversationId) =>
        this.roles.listRoles(
          this.requireActor(context, sourceConversationId).modelRegistry,
        ).map((role) => ({
          id: role.id,
          revision: role.revision,
          name: role.name,
          description: role.description,
          model: role.model,
          compactionModel: role.compactionModel,
          available: role.available,
          ...(role.unavailableReason
            ? { unavailableReason: role.unavailableReason }
            : {}),
        })),
      readRole: async (sourceConversationId, input) => {
        const { role } = roleForSource(sourceConversationId, input.roleId);
        return {
          id: role.id,
          revision: role.revision,
          name: role.name,
          description: role.description,
          systemPrompt: role.systemPrompt,
          model: role.model,
          compactionModel: role.compactionModel,
          defaultThinkingLevel: role.defaultThinkingLevel,
          defaultServiceTier: role.defaultServiceTier,
          toolMode: role.toolMode,
          canManageSessions: role.canManageSessions,
          available: role.available,
          ...(role.unavailableReason
            ? { unavailableReason: role.unavailableReason }
            : {}),
        };
      },
      proposeRoleRevision: async (
        sourceConversationId,
        input,
        signal,
      ) => {
        const { source, role } = roleForSource(
          sourceConversationId,
          input.roleId,
        );
        assertRoleSystemPromptBytes(input.newSystemPrompt, "newSystemPrompt");
        if (role.systemPrompt === input.newSystemPrompt) {
          return {
            outcome: "already_current" as const,
            roleId: role.id,
            revision: role.revision,
          };
        }
        if (role.revision !== input.expectedRevision) {
          return {
            outcome: "stale" as const,
            roleId: role.id,
            expectedRevision: input.expectedRevision,
            revision: role.revision,
          };
        }
        if (signal?.aborted) return { outcome: "cancelled" as const };

        const finalPrompt = await this.extensionUIRouter(
          context,
          sourceConversationId,
        ).ui.editor(
          roleRevisionEditorTitle(role.name, role.revision, input.reason),
          input.newSystemPrompt,
          { signal },
        );
        if (signal?.aborted || typeof finalPrompt !== "string") {
          return { outcome: "cancelled" as const };
        }
        assertRoleSystemPromptBytes(finalPrompt, "finalSystemPrompt");
        const current = roleForSource(sourceConversationId, input.roleId).role;
        if (
          current.revision !== role.revision
          || current.systemPrompt !== role.systemPrompt
        ) {
          return {
            outcome: "stale" as const,
            roleId: current.id,
            expectedRevision: input.expectedRevision,
            revision: current.revision,
          };
        }
        if (signal?.aborted) return { outcome: "cancelled" as const };
        if (finalPrompt === role.systemPrompt) {
          return {
            outcome: "unchanged" as const,
            roleId: role.id,
            previousRevision: role.revision,
            revision: role.revision,
            userEdited: finalPrompt !== input.newSystemPrompt,
          };
        }

        try {
          const updated = await this.roles.updateRole(
            role.id,
            input.expectedRevision,
            role.systemPrompt,
            {
              name: role.name,
              description: role.description,
              systemPrompt: finalPrompt,
              model: role.model === null ? null : { ...role.model },
              compactionModel: role.compactionModel === null
                ? null
                : { ...role.compactionModel },
              defaultThinkingLevel: role.defaultThinkingLevel,
              defaultServiceTier: role.defaultServiceTier,
              toolMode: role.toolMode,
              canManageSessions: role.canManageSessions,
            },
            source.modelRegistry,
            signal,
          );
          return {
            outcome: "applied" as const,
            roleId: updated.id,
            previousRevision: role.revision,
            revision: updated.revision,
            userEdited: finalPrompt !== input.newSystemPrompt,
          };
        } catch (error) {
          if (
            signal?.aborted
            && error instanceof Error
            && error.name === "AbortError"
          ) {
            return { outcome: "cancelled" as const };
          }
          if (!(error instanceof RoleUpdateConflictError)) throw error;
          let current: ReturnType<typeof roleForSource>["role"];
          try {
            current = roleForSource(sourceConversationId, input.roleId).role;
          } catch {
            throw error;
          }
          if (
            current.revision !== role.revision
            || current.systemPrompt !== role.systemPrompt
          ) {
            return {
              outcome: "stale" as const,
              roleId: current.id,
              expectedRevision: input.expectedRevision,
              revision: current.revision,
            };
          }
          throw error;
        }
      },
      listSessions: async (sourceConversationId, input) => {
        const sessions = await this.listSessionsForMeta(
          context,
          sourceConversationId,
          input.limit,
          input.cursor,
          input.scope,
        );
        return sessions;
      },
      currentSession: async (sourceConversationId) =>
        this.describeSession(context, sourceConversationId, sourceConversationId),
      peekSession: async (_sourceConversationId, input) => ({
        conversationId: input.conversationId,
        ...await this.runLifecycle(context, () => {
          if (context.deleting.has(input.conversationId)) {
            throw new Error(
              `Conversation is being deleted: ${input.conversationId}`,
            );
          }
          return this.peekSession(
            context,
            input.conversationId,
            input.limit,
          );
        }),
      }),
      startSession: (
        sourceConversationId,
        input,
        signal,
      ) => this.startPeerSession(
        new ProjectSessionHandle(context),
        sourceConversationId,
        input,
        signal,
      ),
      sendSessionMessage: (
        sourceConversationId,
        input,
        signal,
      ) => this.sendSessionMessage(
        context,
        sourceConversationId,
        input.conversationId,
        input.summary,
        input.message,
        input.idempotencyKey,
        signal,
      ),
      waitForSession: (
        sourceConversationId,
        input,
        signal,
      ) => this.waitForSessionTargetsLocal(
        context,
        sourceConversationId,
        input.targets,
        signal,
      ),
      abortSession: async (sourceConversationId, input) => {
        if (sourceConversationId === input.conversationId) {
          throw new Error("An Agent cannot abort its own current run");
        }
        return this.runLifecycle(context, async () => {
          const source = this.requireActor(context, sourceConversationId);
          const operationId = deterministicUuid(
            "piweb.abort.operation",
            input.idempotencyKey,
          );
          const existing = aggregateReservedConversationEntries(
            source.sessionManager.getEntries(),
          ).metaOperations.find(
            (operation) => operation.operationId === operationId,
          );
          if (
            existing
            && (
              existing.kind !== "abort_session"
              || existing.targetConversationId !== input.conversationId
              || existing.runId !== input.runId
            )
          ) {
            throw new Error(
              "abort_session idempotency key conflicts with an earlier request",
            );
          }
          if (existing?.kind === "abort_session") {
            if (existing.state === "completed") {
              return { ...existing.result };
            }
            if (existing.result.aborted) {
              const target = context.actors.get(input.conversationId);
              const activity = target?.getActivity();
              if (
                target
                && activity
                && activity.kind !== "idle"
                && activity.runId === input.runId
              ) {
                await target.abort(input.runId);
              }
            }
            appendReservedCustomEntry(
              source.sessionManager,
              createMetaOperationEntry({
                ...existing,
                state: "completed",
                updatedAt: this.now().toISOString(),
              }),
            );
            return { ...existing.result };
          }

          const target = await this.getOrOpenActor(
            context,
            input.conversationId,
          );
          const activity = target.getActivity();
          const result = (
            activity.kind !== "idle"
            && activity.runId === input.runId
          )
            ? { aborted: true as const }
            : {
                aborted: false as const,
                reason: "run_not_active" as const,
              };
          const startedAt = this.now().toISOString();
          appendReservedCustomEntry(
            source.sessionManager,
            createMetaOperationEntry({
              operationId,
              kind: "abort_session",
              targetConversationId: input.conversationId,
              runId: input.runId,
              result,
              state: "started",
              updatedAt: startedAt,
            }),
          );
          if (result.aborted) await target.abort(input.runId);
          appendReservedCustomEntry(
            source.sessionManager,
            createMetaOperationEntry({
              operationId,
              kind: "abort_session",
              targetConversationId: input.conversationId,
              runId: input.runId,
              result,
              state: "completed",
              updatedAt: this.now().toISOString(),
            }),
          );
          return { ...result };
        });
      },
      deleteSession: async (sourceConversationId, input) => {
        if (sourceConversationId === input.conversationId) {
          throw new Error("An Agent cannot delete its own session");
        }
        if (!this.reserveDeletion(context, input.conversationId)) {
          throw new Error(
            `Conversation is being deleted: ${input.conversationId}`,
          );
        }
        let deletionOwnsReservation = false;
        return this.runLifecycle(context, async () => {
          const source = this.requireActor(context, sourceConversationId);
          const operationId = deterministicUuid(
            "piweb.delete.operation",
            input.idempotencyKey,
          );
          const existing = aggregateReservedConversationEntries(
            source.sessionManager.getEntries(),
          ).metaOperations.find(
            (operation) => operation.operationId === operationId,
          );
          if (
            existing
            && (
              existing.kind !== "delete_session"
              || existing.targetConversationId !== input.conversationId
            )
          ) {
            throw new Error(
              "delete_session idempotency key conflicts with an earlier request",
            );
          }
          if (
            existing?.kind === "delete_session"
            && existing.state === "completed"
          ) {
            return { deleted: existing.deleted };
          }

          const targetExists = context.actors.has(input.conversationId)
            || context.project.listConversations().some(
              ({ id }) => id === input.conversationId,
            );
          if (targetExists) {
            await this.hydrateConversationProfiles(context);
            if (
              this.collectCascadeDeletionIds(context, input.conversationId)
                .includes(sourceConversationId)
            ) {
              throw new Error("An Agent cannot delete its own session");
            }
          }
          if (!existing) {
            appendReservedCustomEntry(
              source.sessionManager,
              createMetaOperationEntry({
                operationId,
                kind: "delete_session",
                targetConversationId: input.conversationId,
                state: "started",
                updatedAt: this.now().toISOString(),
              }),
            );
          }
          const resumedAfterDeletion = existing !== undefined && !targetExists;
          deletionOwnsReservation = !resumedAfterDeletion;
          const deleted = resumedAfterDeletion
            ? true
            : await this.deleteConversationInternal(
                context,
                input.conversationId,
                true,
                sourceConversationId,
              );
          appendReservedCustomEntry(
            source.sessionManager,
            createMetaOperationEntry({
              operationId,
              kind: "delete_session",
              targetConversationId: input.conversationId,
              state: "completed",
              deleted,
              updatedAt: this.now().toISOString(),
            }),
          );
          return { deleted };
        }).finally(() => {
          if (!deletionOwnsReservation) {
            context.deleting.delete(input.conversationId);
          }
        });
      },
    };
  }

  /**
   * Synchronous count of live delegation descendants sharing the given
   * rootConversationId. Caller must have run hydrateConversationProfiles()
   * first so profiles are loaded for all project conversations.
   */
  private countLiveDelegationDescendants(
    context: ProjectContext,
    rootConversationId: string,
  ): number {
    const summaries = context.project.listConversations();
    let count = 0;
    for (const summary of summaries) {
      if (summary.id === rootConversationId) continue;
      const profile = context.actors.get(summary.id)?.profile
        ?? context.profiles.get(summary.id);
      if (!profile) {
        throw new Error(`Conversation ${summary.id} profile metadata is missing`);
      }
      try {
        const resolved = this.resolveOrchestration(
          context,
          summary.id,
          profile,
        );
        if (resolved.rootConversationId === rootConversationId) count++;
      } catch {
        // Unknown lineage may belong to any root, so conservatively reserve
        // one slot instead of either blocking unrelated roots or failing open.
        count++;
      }
    }
    return count;
  }

  /**
   * Ensure profiles for all project conversations are loaded into
   * context.profiles. Never opens an AgentSession or changes the
   * project's recent-conversation pointer.
   */
  private async hydrateConversationProfiles(
    context: ProjectContext,
  ): Promise<void> {
    const summaries = context.project.listConversations();
    const missingIds = summaries
      .filter(({ id }) => (
        !context.actors.has(id)
        && !context.profiles.has(id)
      ))
      .map(({ id }) => id);
    if (missingIds.length > 0) {
      const inspections = await context.project.inspectConversations(
        missingIds,
      );
      for (const [conversationId, inspection] of inspections) {
        if (inspection.conversationMeta === undefined) {
          throw new Error(
            `Conversation ${conversationId} profile metadata is missing`,
          );
        }
        context.profiles.set(
          conversationId,
          cloneProfile(inspection.conversationMeta),
        );
      }
    }
  }

  /**
   * Synchronously resolve orchestration rootConversationId and depth for a
   * given conversation. Caller must have run hydrateConversationProfiles()
   * first so context.profiles is populated for all project conversations.
   * Never does its own disk I/O.
   *
   * Returns { rootConversationId, depth } or throws on cycle/inconsistency/
   * missing parent (implicit lineage only).
   */
  private resolveOrchestration(
    context: ProjectContext,
    conversationId: string,
    profile: ConversationMeta | undefined,
    visited?: Set<string>,
  ): { rootConversationId: string; depth: number } {
    const chain = visited ?? new Set<string>();
    if (chain.has(conversationId)) {
      throw new Error(
        `Orchestration parent cycle detected at ${conversationId}`,
      );
    }
    chain.add(conversationId);

    const knownIds = new Set(
      context.project.listConversations().map((s) => s.id),
    );

    // Resolve profile: passed in, from live actor, or from cached profiles.
    const resolvedProfile = profile
      ?? context.actors.get(conversationId)?.profile
      ?? context.profiles.get(conversationId);

    if (!resolvedProfile) {
      throw new Error(
        knownIds.has(conversationId)
          ? `Conversation ${conversationId} profile metadata is missing`
          : `Conversation ${conversationId} not found`,
      );
    }

    const { createdBy, orchestration } = resolvedProfile;

    if (orchestration) {
      // Explicit host-written orchestration snapshot.
      if (createdBy.kind === "user") {
        if (
          orchestration.rootConversationId !== conversationId
          || orchestration.depth !== 0
        ) {
          throw new Error(
            `User conversation ${conversationId} has inconsistent orchestration: ` +
            `expected root=self depth=0, got root=${orchestration.rootConversationId} depth=${orchestration.depth}`,
          );
        }
        return { rootConversationId: conversationId, depth: 0 };
      }

      // createdBy.kind === "conversation"
      const parentId = createdBy.conversationId;
      const parentProfile = context.actors.get(parentId)?.profile
        ?? context.profiles.get(parentId);
      const parentExists = parentProfile !== undefined
        || knownIds.has(parentId);

      if (parentExists) {
        const parent = this.resolveOrchestration(
          context, parentId, parentProfile, chain,
        );
        if (parent.rootConversationId !== orchestration.rootConversationId) {
          throw new Error(
            `Orchestration root mismatch: parent root ${parent.rootConversationId} ` +
            `vs child root ${orchestration.rootConversationId}`,
          );
        }
        if (parent.depth + 1 !== orchestration.depth) {
          throw new Error(
            `Orchestration depth mismatch: parent depth ${parent.depth} ` +
            `implies child depth ${parent.depth + 1} but got ${orchestration.depth}`,
          );
        }
      }
      // If parent is gone from disk entirely, the explicit snapshot is trusted.
      return {
        rootConversationId: orchestration.rootConversationId,
        depth: orchestration.depth,
      };
    }

    // No explicit orchestration — derive from createdBy.
    if (createdBy.kind === "user") {
      return { rootConversationId: conversationId, depth: 0 };
    }

    // createdBy.kind === "conversation", no orchestration.
    const parentId = createdBy.conversationId;
    const parentProfile = context.actors.get(parentId)?.profile
      ?? context.profiles.get(parentId);

    if (!parentProfile) {
      throw new Error(
        knownIds.has(parentId)
          ? `Conversation ${parentId} profile metadata is missing`
          : `Cannot resolve orchestration for ${conversationId}: ` +
            `parent ${parentId} not found and no explicit orchestration`,
      );
    }

    const parent = this.resolveOrchestration(
      context, parentId, parentProfile, chain,
    );
    return {
      rootConversationId: parent.rootConversationId,
      depth: parent.depth + 1,
    };
  }

  private async listSessionsForMeta(
    context: ProjectContext,
    sourceConversationId: string,
    limit: number,
    cursor?: string,
    scope: MetaToolSessionScope = "all",
  ) {
    const summaries = await this.listSessions(new ProjectSessionHandle(context));
    const candidates = summaries.map((summary) => {
      const profile =
        context.actors.get(summary.id)?.profile
        ?? context.profiles.get(summary.id);
      if (profile === undefined) {
        throw new Error(`Conversation ${summary.id} profile metadata is missing`);
      }
      return {
        summary,
        creation: sessionCreationProjection(profile, sourceConversationId),
      };
    });
    const scoped = scope === "created_by_me"
      ? candidates.filter(({ creation }) => creation.createdByMe)
      : candidates;
    let offset = 0;
    if (cursor) {
      const parsed = Number.parseInt(
        Buffer.from(cursor, "base64url").toString("utf8"),
        10,
      );
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("Invalid session cursor");
      }
      offset = parsed;
    }
    const selected = scoped.slice(offset, offset + limit);
    return {
      sessions: selected.map(({ summary, creation }) => ({
        conversationId: summary.id,
        title: conversationDisplayTitle(summary) ?? "未命名会话",
        role: summary.role,
        activity: summary.activity,
        lastActiveAt: summary.updatedAt,
        attention: summary.attention ?? false,
        self: summary.id === sourceConversationId,
        ...creation,
      })),
      nextCursor: offset + selected.length < scoped.length
        ? Buffer.from(String(offset + selected.length), "utf8")
            .toString("base64url")
        : undefined,
    };
  }

  private async describeSession(
    context: ProjectContext,
    conversationId: string,
    sourceConversationId: string,
  ) {
    const summaries = await this.listSessions(new ProjectSessionHandle(context));
    const summary = summaries.find(({ id }) => id === conversationId);
    if (!summary) throw new Error(`Conversation not found: ${conversationId}`);
    const profile =
      context.actors.get(summary.id)?.profile
      ?? context.profiles.get(summary.id);
    if (profile === undefined) {
      throw new Error(`Conversation ${summary.id} profile metadata is missing`);
    }
    return {
      conversationId,
      title: conversationDisplayTitle(summary) ?? "未命名会话",
      role: summary.role,
      activity: summary.activity,
      lastActiveAt: summary.updatedAt,
      self: conversationId === sourceConversationId,
      ...sessionCreationProjection(profile, sourceConversationId),
    };
  }

  private async peekSession(
    context: ProjectContext,
    conversationId: string,
    limit: number,
  ): Promise<ReturnType<typeof projectAgentConversationPeek>> {
    const active = context.actors.get(conversationId);
    if (active) {
      return projectAgentConversationPeek(active.sessionManager, limit);
    }
    const opening = context.actorOpenings.get(conversationId);
    if (opening) {
      const actor = await opening;
      return projectAgentConversationPeek(actor.sessionManager, limit);
    }

    const lease = await this.projects.acquireConversationWhenAvailable(
      context.project.cwd,
      conversationId,
    );
    try {
      const manager = await context.project.openConversation(
        conversationId,
        { updateRecent: false },
      );
      return projectAgentConversationPeek(manager, limit);
    } finally {
      lease.release();
    }
  }

  private async sendSessionMessage(
    context: ProjectContext,
    sourceConversationId: string,
    targetConversationId: string,
    summary: string,
    message: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.runLifecycle(context, async () => {
      const normalizedSummary = normalizeConversationMessageSummary(summary);
      this.throwIfAborted(signal);
      if (sourceConversationId === targetConversationId) {
        throw new Error("Use the current conversation directly instead of messaging itself");
      }
      const source = this.requireActor(context, sourceConversationId);
      const messageId = deterministicUuid("piweb.message", idempotencyKey);
      const cardId = deterministicUuid("piweb.card", idempotencyKey);
      const existingCard = aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find((card) => card.cardId === cardId);
      const recoveredEnvelope = existingCard
        ? await context.inbox.get(messageId)
        : undefined;
      if (
        existingCard
        && (
          existingCard.kind !== "message"
          || existingCard.summary !== normalizedSummary
          || existingCard.body !== message
          || existingCard.toSnapshot.conversationId !== targetConversationId
        )
      ) {
        throw new Error(
          "send_session_message idempotency key conflicts with an earlier request",
        );
      }
      if (existingCard && existingCard.state !== "sending") {
        if (recoveredEnvelope?.state === "processing") {
          return {
            status: "processing",
            messageId,
            conversationId: targetConversationId,
            runId: recoveredEnvelope.processingRunId,
          };
        }
        return {
          status: recoveredEnvelope ? "queued" : existingCard.state,
          messageId,
          conversationId: targetConversationId,
          ...(existingCard.runId === undefined
            ? {}
            : { runId: existingCard.runId }),
        };
      }
      const target = await this.getOrOpenActor(context, targetConversationId);
      this.throwIfAborted(signal);
      const deliveryReceipt = aggregateReservedConversationEntries(
        target.sessionManager.getEntries(),
      ).messageDeliveryReceipts.find(
        ({ messageId: candidate }) => candidate === messageId,
      );
      const sourceRun = source.currentRunOwnership();
      const fromRunId = recoveredEnvelope?.fromRunId
        ?? deliveryReceipt?.sourceRunId
        ?? sourceRun?.runId;
      if (fromRunId === undefined) {
        throw new Error(
          "send_session_message requires an exact active or recovered source run",
        );
      }
      const queued = await this.enqueueEnvelope(context, source, target, {
        messageId,
        cardId,
        sentAt: recoveredEnvelope?.sentAt
          ?? existingCard?.updatedAt
          ?? this.now().toISOString(),
        kind: "message",
        summary: normalizedSummary,
        body: message,
        fromRunId,
      });
      const envelope = queued.envelope;
      if (queued.status === "delivered") {
        const deliveredCard = aggregateReservedConversationEntries(
          source.sessionManager.getEntries(),
        ).cards.find(({ cardId: candidate }) => candidate === cardId);
        return {
          status: deliveredCard?.state ?? "delivered",
          messageId: envelope.messageId,
          conversationId: targetConversationId,
          ...(deliveredCard?.runId === undefined
            ? {}
            : { runId: deliveredCard.runId }),
        };
      }
      if (
        queued.status === "existing"
        && envelope.state === "processing"
      ) {
        return {
          status: "processing",
          messageId: envelope.messageId,
          conversationId: targetConversationId,
          runId: envelope.processingRunId,
        };
      }
      if (
        await this.deliverEnvelopeToWaitingRun(
          context,
          target,
          envelope,
          fromRunId,
        )
      ) {
        const activity = target.getActivity();
        return {
          status: "delivered_to_wait",
          messageId: envelope.messageId,
          conversationId: targetConversationId,
          ...(activity.kind === "idle" ? {} : { runId: activity.runId }),
        };
      }
      await this.steerActiveTarget(context, target);
      if (target.getActivity().kind === "idle") {
        await this.pumpTarget(context, targetConversationId);
      }
      const stored = await context.inbox.get(envelope.messageId);
      if (stored?.state === "processing") {
        return {
          status: "processing",
          messageId: envelope.messageId,
          conversationId: targetConversationId,
          runId: stored.processingRunId,
        };
      }
      const latestCard = aggregateReservedConversationEntries(
        source.sessionManager.getEntries(),
      ).cards.find(({ cardId: candidate }) => candidate === cardId);
      if (!stored && latestCard && latestCard.state !== "queued") {
        return {
          status: latestCard.state,
          messageId: envelope.messageId,
          conversationId: targetConversationId,
          ...(latestCard.runId === undefined
            ? {}
            : { runId: latestCard.runId }),
        };
      }
      const activity = target.getActivity();
      this.emit(context, { type: "project_changed" });
      return {
        status: "queued",
        messageId: envelope.messageId,
        conversationId: targetConversationId,
        ...(activity.kind === "idle"
          ? {}
          : { activeRunId: activity.runId }),
      };
    });
  }

  private async deliverEnvelopeToWaitingRun(
    context: ProjectContext,
    target: ConversationActor,
    envelope: InboxEnvelope,
    _sourceRunId: string,
  ): Promise<boolean> {
    const attempt = target.getCurrentWaitAttempt();
    if (attempt && target.claimWaitAttemptDelivery(attempt.ownership, attempt.handle)) {
      try {
        const alreadyAccepted = target.hasAcceptedCustomMessageForWait(
          attempt.ownership,
          envelope.messageId,
        );
        const steered = alreadyAccepted
          ? true
          : await this.steerActiveTarget(context, target, {
              throughMessageId: envelope.messageId,
            });
        if (!steered) {
          const error = new Error("The waiting run rejected the peer message");
          target.completeWaitAttempt(attempt.ownership, attempt.handle, "delivering", {
            kind: "error",
            error,
          });
          throw error;
        }
        if (!alreadyAccepted && !target.hasAcceptedCustomMessageForWait(
          attempt.ownership,
          envelope.messageId,
        )) {
          const error = new Error("The waiting run did not accept the peer message");
          target.completeWaitAttempt(attempt.ownership, attempt.handle, "delivering", {
            kind: "error",
            error,
          });
          throw error;
        }
        if (
          target.getWaitAttempt(attempt.ownership, attempt.handle)?.status !== "delivering"
          || !target.claimAcceptedCustomMessageForWait(
            attempt.ownership,
            envelope.messageId,
          )
        ) {
          target.cancelWaitAttempt(attempt.ownership, attempt.handle);
          return false;
        }
        await context.inbox.updateState(envelope.messageId, {
          state: "processing",
          processingRunId: attempt.ownership.runId,
          ...(envelope.processingDelivery === undefined
            ? {}
            : { processingDelivery: envelope.processingDelivery }),
          waitedByRunId: attempt.ownership.runId,
        });
        target.retireAcceptedCustomMessageForWait(
          attempt.ownership,
          envelope.messageId,
        );
        return target.completeWaitAttempt(
          attempt.ownership,
          attempt.handle,
          "delivering",
          { kind: "message", messageId: envelope.messageId },
        );
      } catch (error) {
        target.completeWaitAttempt(attempt.ownership, attempt.handle, "delivering", {
          kind: "error",
          error,
        });
        throw error;
      }
    }
    return false;
  }

  /**
   * Claims target messages in durable FIFO order and queues custom steering for
   * the exact active run. Ordinary sends claim one bounded batch without
   * waiting for Pi streaming. An exact wait reply drains its bounded predecessor
   * chain first, then waits only for SDK queue acceptance so the blocked tool can
   * return without allowing that reply to overtake earlier messages.
   */
  private async steerActiveTarget(
    context: ProjectContext,
    target: ConversationActor,
    options: {
      throughMessageId?: string;
      beforeThroughDelivery?: (envelope: InboxEnvelope) => Promise<void>;
    } = {},
  ): Promise<boolean> {
    if (!await this.reconcileInbox(context, target.conversationId)) return false;
    await this.reconcileReceiptLedger(context, target.conversationId);
    const activity = target.getActivity();
    if (activity.kind === "idle" || activity.kind === "cancelling") {
      return false;
    }

    const runId = activity.runId;
    const key = completionKey(target.conversationId, runId);
    const pending = await context.inbox.list({
      toConversationId: target.conversationId,
    });
    let claimed = pending.filter((envelope) => (
      envelope.state === "processing"
      && envelope.processingRunId === runId
    )).length;

    for (const envelope of pending) {
      if (envelope.state === "processing") {
        // A preceding batch belongs to another run and must settle or recover
        // before a later message can overtake it.
        if (envelope.processingRunId !== runId) return false;
        if (envelope.messageId === options.throughMessageId) {
          await options.beforeThroughDelivery?.(envelope);
          return true;
        }
        continue;
      }
      if (
        options.throughMessageId === undefined
        && claimed >= MAX_BATCH_MESSAGES
      ) {
        return false;
      }

      const processingEnvelope = await context.inbox.updateState(
        envelope.messageId,
        {
          state: "processing",
          processingRunId: runId,
          processingDelivery: "steer",
        },
      );
      const batch = context.processingBatches.get(key) ?? [];
      if (!batch.some(({ messageId }) => messageId === envelope.messageId)) {
        context.processingBatches.set(key, [...batch, processingEnvelope]);
      }
      try {
        if (envelope.messageId === options.throughMessageId) {
          await options.beforeThroughDelivery?.(processingEnvelope);
        }
        const delivery = target.steerCustomMessage(
          runId,
          this.createDeliveredMessageEntry(target, processingEnvelope),
        );
        if (options.throughMessageId === undefined) {
          // The durable claim is the send acknowledgement. Waiting for Pi's
          // transient queue here would deadlock lifecycle shutdown during
          // pre-stream work such as compaction or provider setup.
          this.recoverRejectedSteer(
            context,
            target.conversationId,
            runId,
            processingEnvelope,
            delivery,
          );
          void delivery.then(() => {
            if (context.closing) return;
            this.trackBackground(
              context,
              this.runLifecycle(context, async () => {
                await this.deliverEnvelopeToWaitingRun(
                  context,
                  target,
                  processingEnvelope,
                  runId,
                );
                await this.reconcileInbox(context, target.conversationId);
              }),
            );
          }, () => undefined);
        } else {
          await delivery;
        }
        claimed++;
        if (envelope.messageId === options.throughMessageId) return true;
      } catch (error) {
        // A run can end between claiming the sidecar and the SDK accepting its
        // steering queue. Do not treat in-memory delivery as durable; leave it
        // available for the next run unless Pi already wrote its marker.
        await this.reconcileInbox(context, target.conversationId);
        if (await context.inbox.get(envelope.messageId) === undefined) {
          claimed++;
          if (envelope.messageId === options.throughMessageId) return true;
          continue;
        }
        const batchAfterFailure = (context.processingBatches.get(key) ?? [])
          .filter(({ messageId }) => messageId !== envelope.messageId);
        if (batchAfterFailure.length === 0) {
          context.processingBatches.delete(key);
        } else {
          context.processingBatches.set(key, batchAfterFailure);
        }
        await context.inbox.updateState(envelope.messageId, { state: "queued" });
        // In through mode any failed delivery — the through envelope itself or
        // any FIFO predecessor — must fail closed: rethrow so the caller
        // (deliverEnvelopeToWaitingRun) rejects the waiter and the send, and
        // the through envelope stays queued instead of being claimed into the
        // waiting run by an ordinary fallback while no waiter resolution
        // exists.
        if (options.throughMessageId !== undefined) throw error;
        return false;
      }
    }
    return false;
  }

  private recoverRejectedSteer(
    context: ProjectContext,
    targetConversationId: string,
    runId: string,
    envelope: InboxEnvelope,
    delivery: Promise<void>,
  ): void {
    void delivery.catch((error) => {
      if (context.closing) return;
      const recovery = this.runLifecycle(context, async () => {
        const stored = await context.inbox.get(envelope.messageId);
        if (
          stored?.state !== "processing"
          || stored.processingRunId !== runId
          || stored.processingDelivery !== "steer"
        ) {
          return;
        }
        const key = completionKey(targetConversationId, runId);
        const batch = context.processingBatches.get(key) ?? [];
        if (!batch.some(({ messageId }) => messageId === stored.messageId)) {
          context.processingBatches.set(key, [...batch, stored]);
        }
        const actor = context.actors.get(targetConversationId);
        const settlement = actor
          ? this.findSettlement(context, actor, runId)
          : undefined;
        if (settlement) {
          await this.finishBatch(
            context,
            targetConversationId,
            runId,
            settlement,
          );
          if (!actor?.getState().fatalError) {
            if (actor?.getActivity().kind === "idle") {
              await this.pumpTarget(context, targetConversationId);
            }
            return;
          }
        }
        await this.recoverFailedBatch(
          context,
          targetConversationId,
          runId,
          error,
        );
      });
      this.trackBackground(context, recovery);
    });
  }

  private async enqueueEnvelope(
    context: ProjectContext,
    source: ConversationActor,
    target: ConversationActor,
    input: Pick<
      InboxEnvelopeInput,
      | "messageId"
      | "cardId"
      | "sentAt"
      | "kind"
      | "summary"
      | "body"
      | "delegationId"
    > & {
      fromRunId: string;
      processingRunId?: string;
      requestFingerprint?: string;
      requestedRole?: ConversationMeta["role"];
      orchestration?: ConversationOrchestration;
    },
  ): Promise<{
    status: "created" | "existing" | "delivered";
    envelope: InboxEnvelope;
  }> {
    const preexistingEnvelope = await context.inbox.get(input.messageId);
    if (!await this.reconcileInbox(context, target.conversationId)) {
      throw new Error(
        `Inbox target requires attention before admitting new work: ${target.conversationId}`,
      );
    }
    const existingCard = aggregateReservedConversationEntries(
      source.sessionManager.getEntries(),
    ).cards.find(({ cardId }) => cardId === input.cardId);
    const fromSnapshot = existingCard?.fromSnapshot
      ?? this.endpoint(context, source);
    const toSnapshot = existingCard?.toSnapshot
      ?? this.endpoint(context, target);
    const receipt = aggregateReservedConversationEntries(
      target.sessionManager.getEntries(),
    ).messageDeliveryReceipts.find(
      ({ messageId }) => messageId === input.messageId,
    );
    if (receipt) {
      const deliveredEnvelope: InboxEnvelope = preexistingEnvelope
        ? {
            ...preexistingEnvelope,
            state: "processing",
            processingRunId: preexistingEnvelope.state === "processing"
              ? preexistingEnvelope.processingRunId
              : receipt.targetRunId,
          }
        : {
        version: 1,
        messageId: input.messageId,
        cardId: input.cardId,
        fromConversationId: source.conversationId,
        toConversationId: target.conversationId,
        sentAt: receipt.sentAt,
        kind: input.kind,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        body: input.body,
        ...(input.delegationId === undefined
          ? {}
          : { delegationId: input.delegationId }),
        ...(input.requestFingerprint === undefined
          ? {}
          : { requestFingerprint: input.requestFingerprint }),
        fromRunId: input.fromRunId,
        fromSnapshot,
        toSnapshot,
        state: "processing",
        processingRunId: receipt.targetRunId,
      };
      this.assertReceiptMatchesEnvelope(receipt, deliveredEnvelope);
      return {
        status: "delivered",
        envelope: deliveredEnvelope,
      };
    }
    if (
      preexistingEnvelope
      && await context.inbox.get(input.messageId) === undefined
    ) {
      throw new Error(
        `Inbox envelope disappeared without a receipt: ${input.messageId}`,
      );
    }
    const baseCard: ConversationCard = existingCard ?? {
        cardId: input.cardId,
        kind: input.kind,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        body: input.body,
        fromSnapshot,
        toSnapshot,
        state: "sending",
        messageId: input.messageId,
        ...(input.delegationId === undefined
          ? {}
          : { delegationId: input.delegationId }),
        ...(input.requestFingerprint === undefined
          ? {}
          : { requestFingerprint: input.requestFingerprint }),
        ...(input.requestedRole === undefined
          ? {}
          : { requestedRole: input.requestedRole }),
        ...(input.orchestration === undefined
          ? {}
          : { orchestration: input.orchestration }),
        updatedAt: input.sentAt,
      };
    this.appendCard(source, baseCard);
    const result = await context.inbox.put({
      messageId: input.messageId,
      cardId: input.cardId,
      fromConversationId: source.conversationId,
      toConversationId: target.conversationId,
      sentAt: input.sentAt,
      kind: input.kind,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      body: input.body,
      ...(input.delegationId === undefined
        ? {}
        : { delegationId: input.delegationId }),
      ...(input.requestFingerprint === undefined
        ? {}
        : { requestFingerprint: input.requestFingerprint }),
      fromRunId: input.fromRunId,
      fromSnapshot,
      toSnapshot,
    }, input.processingRunId === undefined
      ? undefined
      : {
          initialState: {
            state: "processing",
            processingRunId: input.processingRunId,
          },
        });
    const envelope = result.envelope;
    this.appendCard(source, {
      ...baseCard,
      state: "queued",
      updatedAt: this.now().toISOString(),
    });
    this.emit(context, { type: "project_changed" });
    return {
      status: result.status,
      envelope,
    };
  }

  private endpoint(
    context: ProjectContext,
    actor: ConversationActor,
  ): ConversationReferenceSnapshot {
    const summary = context.project.listConversations()
      .find(({ id }) => id === actor.conversationId);
    const title = summary === undefined
      ? undefined
      : conversationDisplayTitle(summary);
    return {
      conversationId: actor.conversationId,
      ...(title ? { title } : {}),
      role: {
        id: actor.profile.role.id,
        name: actor.profile.role.name,
      },
    };
  }

  private appendCard(actor: ConversationActor, card: ConversationCard): void {
    appendReservedCustomEntry(
      actor.sessionManager,
      createConversationCardEntry(card),
    );
  }

  private createDeliveredMessageEntry(
    target: ConversationActor,
    envelope: InboxEnvelope,
  ): ConversationMessageEntry {
    const replyGuidance = [
      "",
      `如需回复，请调用 send_session_message 并使用 conversationId ${envelope.fromConversationId}。`,
    ];
    const content = [
      `来自会话：${envelope.fromSnapshot.title ?? "未命名会话"}`,
      `来源角色：${envelope.fromSnapshot.role.name}`,
      `来源句柄：${envelope.fromConversationId}`,
      "",
      envelope.body,
      ...(target.profile.role.canManageSessions
        ? [
            ...replyGuidance,
            "",
            INBOX_LIFECYCLE_GUIDANCE,
          ]
        : []),
    ].join("\n");
    return createConversationMessageEntry({
      content,
      display: true,
      details: {
        messageId: envelope.messageId,
        cardId: envelope.cardId,
        sentAt: envelope.sentAt,
        kind: envelope.kind,
        ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
        body: envelope.body,
        fromSnapshot: envelope.fromSnapshot,
        toSnapshot: envelope.toSnapshot,
        ...(envelope.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: envelope.replyToMessageId }),
        ...(envelope.delegationId === undefined
          ? {}
          : { delegationId: envelope.delegationId }),
      },
    });
  }

  private appendSourceCardState(
    context: ProjectContext,
    envelope: InboxEnvelope,
    state: ConversationCard["state"],
    runId?: string,
    result?: string,
  ): void {
    const source = context.actors.get(envelope.fromConversationId);
    if (!source) return;
    const existing = aggregateReservedConversationEntries(
      source.sessionManager.getEntries(),
    ).cards.find(({ cardId }) => cardId === envelope.cardId);
    if (!existing) return;
    if (
      existing.state === state
      && existing.runId === runId
      && existing.result === result
    ) {
      return;
    }
    this.appendCard(source, {
      ...existing,
      state,
      ...(runId === undefined ? {} : { runId }),
      ...(result === undefined ? {} : { result }),
      updatedAt: this.now().toISOString(),
    });
  }

  private async appendTerminalSourceCardState(
    context: ProjectContext,
    envelope: InboxEnvelope,
    state: "completed" | "failed" | "aborted",
    runId?: string,
    result?: string,
  ): Promise<void> {
    const append = (manager: ConversationActor["sessionManager"]) => {
      const existing = aggregateReservedConversationEntries(
        manager.getEntries(),
      ).cards.find(({ cardId }) => cardId === envelope.cardId);
      if (!existing) return;
      if (
        existing.state === state
        && existing.runId === runId
        && existing.result === result
      ) {
        return;
      }
      appendReservedCustomEntry(
        manager,
        createConversationCardEntry({
          ...existing,
          state,
          ...(runId === undefined ? {} : { runId }),
          ...(result === undefined ? {} : { result }),
          updatedAt: this.now().toISOString(),
        }),
      );
    };

    await this.withStoredConversationManager(
      context,
      envelope.fromConversationId,
      append,
    );
  }

  private removeEnvelopeFromProcessingBatches(
    context: ProjectContext,
    messageId: string,
  ): void {
    for (const [key, batch] of context.processingBatches) {
      const remaining = batch.filter((envelope) =>
        envelope.messageId !== messageId
      );
      if (remaining.length === batch.length) continue;
      if (remaining.length === 0) {
        context.processingBatches.delete(key);
      } else {
        context.processingBatches.set(key, remaining);
      }
    }
  }

  private assertReceiptMatchesEnvelope(
    receipt: MessageDeliveryReceipt,
    envelope: InboxEnvelope,
  ): void {
    if (
      envelope.state !== "processing"
      || envelope.processingRunId === undefined
      || envelope.fromRunId === undefined
      || receipt.messageId !== envelope.messageId
      || receipt.cardId !== envelope.cardId
      || receipt.fromConversationId !== envelope.fromConversationId
      || receipt.toConversationId !== envelope.toConversationId
      || receipt.sourceRunId !== envelope.fromRunId
      || receipt.targetRunId !== envelope.processingRunId
      || receipt.kind !== envelope.kind
      || receipt.sentAt !== envelope.sentAt
      || receipt.payloadFingerprint !== inboxEnvelopePayloadFingerprint(envelope)
    ) {
      throw new Error(
        `Inbox delivery identity conflicts with receipt ${envelope.messageId}`,
      );
    }
  }

  private findEnvelopeMarker(
    manager: ConversationActor["sessionManager"],
    envelope: InboxEnvelope,
  ): ConversationMessageEntry | undefined {
    const markers = manager.getEntries()
      .map((entry) => parseReservedConversationEntry(entry))
      .filter((entry) =>
        entry?.kind === "conversation_message"
        && entry.entry.details.messageId === envelope.messageId
      );
    if (markers.length > 1) {
      throw new Error(
        `Multiple inbox delivery markers found for ${envelope.messageId}`,
      );
    }
    const marker = markers[0]?.kind === "conversation_message"
      ? markers[0].entry
      : undefined;
    if (!marker) return undefined;
    const expectedDetails = createConversationMessageEntry({
      content: "marker identity",
      display: true,
      details: {
        messageId: envelope.messageId,
        cardId: envelope.cardId,
        sentAt: envelope.sentAt,
        kind: envelope.kind,
        ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
        body: envelope.body,
        fromSnapshot: envelope.fromSnapshot,
        toSnapshot: envelope.toSnapshot,
        ...(envelope.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: envelope.replyToMessageId }),
        ...(envelope.delegationId === undefined
          ? {}
          : { delegationId: envelope.delegationId }),
      },
    }).details;
    if (JSON.stringify(marker.details) !== JSON.stringify(expectedDetails)) {
      throw new Error(
        `Inbox marker identity conflicts with sidecar ${envelope.messageId}`,
      );
    }
    return marker;
  }

  private async projectReceiptSourceCard(
    context: ProjectContext,
    receipt: MessageDeliveryReceipt,
    settlement?: RunSettlement,
  ): Promise<void> {
    const project = (manager: ConversationActor["sessionManager"]): void => {
      const existing = aggregateReservedConversationEntries(
        manager.getEntries(),
      ).cards.find(({ cardId }) => cardId === receipt.cardId);
      if (!existing) return;
      if (
        existing.messageId !== receipt.messageId
        || existing.kind !== receipt.kind
        || existing.fromSnapshot.conversationId !== receipt.fromConversationId
        || existing.toSnapshot.conversationId !== receipt.toConversationId
        || (
          existing.runId !== undefined
          && existing.runId !== receipt.targetRunId
        )
      ) {
        throw new Error(
          `Source card identity conflicts with receipt ${receipt.messageId}`,
        );
      }
      if (
        receipt.kind !== "delegation_task"
        && (
          existing.state === "completed"
          || existing.state === "failed"
          || existing.state === "aborted"
        )
      ) {
        return;
      }
      const taskSettlement = receipt.kind === "delegation_task"
        && settlement?.runId === receipt.targetRunId
        ? settlement
        : undefined;
      const state: ConversationCard["state"] = taskSettlement
        ? taskSettlement.outcome === "completed"
          ? "completed"
          : taskSettlement.outcome
        : receipt.kind === "delegation_task"
        ? "running"
        : "delivered";
      const result = taskSettlement
        ? taskSettlement.finalText ?? undefined
        : undefined;
      if (
        existing.state === state
        && existing.runId === receipt.targetRunId
        && existing.result === result
      ) {
        return;
      }
      const { result: _oldResult, ...base } = existing;
      appendReservedCustomEntry(
        manager,
        createConversationCardEntry({
          ...base,
          state,
          runId: receipt.targetRunId,
          ...(result === undefined ? {} : { result }),
          updatedAt: this.now().toISOString(),
        }),
      );
    };

    await this.withStoredConversationManager(
      context,
      receipt.fromConversationId,
      project,
    );
  }

  private async projectReceiptSourceCardBestEffort(
    context: ProjectContext,
    receipt: MessageDeliveryReceipt,
    settlement?: RunSettlement,
  ): Promise<void> {
    try {
      await this.projectReceiptSourceCard(context, receipt, settlement);
    } catch (error) {
      context.attention.add(receipt.fromConversationId);
      context.attention.add(receipt.toConversationId);
      this.emit(context, {
        type: "error",
        conversationId: receipt.fromConversationId,
        runId: receipt.targetRunId,
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
    }
  }

  private async reconcileReceiptLedger(
    context: ProjectContext,
    targetConversationId: string,
  ): Promise<string[]> {
    let receipts: MessageDeliveryReceipt[] = [];
    let settlements: RunSettlement[] = [];
    await this.withConversationManager(
      context,
      targetConversationId,
      async (manager) => {
        const aggregate = aggregateReservedConversationEntries(
          manager.getEntries(),
        );
        receipts = aggregate.messageDeliveryReceipts;
        settlements = aggregate.runSettlements;
      },
    );
    const settlementByRun = new Map(
      settlements.map((settlement) => [settlement.runId, settlement]),
    );
    for (const receipt of receipts) {
      await this.projectReceiptSourceCardBestEffort(
        context,
        receipt,
        settlementByRun.get(receipt.targetRunId),
      );
    }
    return [...new Set(receipts
      .filter((receipt) => !settlementByRun.has(receipt.targetRunId))
      .map((receipt) => receipt.targetRunId))];
  }

  private async reconcileInbox(
    context: ProjectContext,
    targetConversationId?: string,
  ): Promise<boolean> {
    let blocked = false;
    const envelopes = await context.inbox.list(
      targetConversationId === undefined ? undefined : { toConversationId: targetConversationId },
    );
    for (const envelope of envelopes) {
      if (envelope.fromRunId === undefined) {
        blocked = true;
        context.attention.add(envelope.toConversationId);
        context.attention.add(envelope.fromConversationId);
        this.emit(context, {
          type: "error",
          conversationId: envelope.toConversationId,
          runId: envelope.processingRunId,
          message: `Inbox sidecar lacks exact source run identity for ${envelope.messageId}`,
          fatal: false,
        });
        continue;
      }
      if (envelope.state !== "processing") continue;
      try {
        let receipt: MessageDeliveryReceipt | undefined;
        let settlement: RunSettlement | undefined;
        await this.withConversationManager(
          context,
          envelope.toConversationId,
          async (manager) => {
            const aggregate = aggregateReservedConversationEntries(
              manager.getEntries(),
            );
            receipt = aggregate.messageDeliveryReceipts.find(
              ({ messageId }) => messageId === envelope.messageId,
            );
            settlement = envelope.processingRunId === undefined
              ? undefined
              : aggregate.runSettlements.find(
                  ({ runId }) => runId === envelope.processingRunId,
                );
            if (receipt) {
              this.assertReceiptMatchesEnvelope(receipt, envelope);
              return;
            }
            if (!this.findEnvelopeMarker(manager, envelope)) return;
            if (
              envelope.processingRunId === undefined
              || envelope.fromRunId === undefined
            ) {
              throw new Error(
                `Inbox sidecar lacks exact run identity for ${envelope.messageId}`,
              );
            }
            receipt = {
              messageId: envelope.messageId,
              cardId: envelope.cardId,
              fromConversationId: envelope.fromConversationId,
              toConversationId: envelope.toConversationId,
              sourceRunId: envelope.fromRunId,
              targetRunId: envelope.processingRunId,
              kind: envelope.kind,
              sentAt: envelope.sentAt,
              payloadFingerprint: inboxEnvelopePayloadFingerprint(envelope),
              deliveredAt: this.now().toISOString(),
            };
            appendReservedCustomEntry(
              manager,
              createMessageDeliveryReceiptEntry(receipt),
            );
          },
        );
        if (!receipt) {
          if (settlement) {
            await context.inbox.updateState(envelope.messageId, {
              state: "queued",
            });
            this.removeEnvelopeFromProcessingBatches(
              context,
              envelope.messageId,
            );
          }
          continue;
        }
        await context.inbox.delete(envelope.messageId);
        this.removeEnvelopeFromProcessingBatches(context, envelope.messageId);
        await this.projectReceiptSourceCardBestEffort(
          context,
          receipt,
          settlement,
        );
      } catch (error) {
        blocked = true;
        context.attention.add(envelope.toConversationId);
        context.attention.add(envelope.fromConversationId);
        this.emit(context, {
          type: "error",
          conversationId: envelope.toConversationId,
          runId: envelope.processingRunId,
          message: error instanceof Error ? error.message : String(error),
          fatal: false,
        });
      }
    }
    return !blocked;
  }

  private async dispatchBatch(
    context: ProjectContext,
    target: ConversationActor,
    envelopes: InboxEnvelope[],
    runId: string,
  ): Promise<"started" | "not_started"> {
    if (target.getActivity().kind !== "idle") {
      throw new Error(`Conversation is already running: ${target.conversationId}`);
    }
    const recoveredBatch = envelopes.some((envelope) => (
      envelope.state === "processing"
      && envelope.processingRunId === runId
    ));
    const newlyClaimedMessageIds: string[] = [];
    let startAttempted = false;
    let completion: Promise<RunSettlement>;
    try {
      for (const envelope of envelopes) {
        if (
          envelope.state !== "processing"
          || envelope.processingRunId !== runId
        ) {
          await context.inbox.updateState(envelope.messageId, {
            state: "processing",
            processingRunId: runId,
          });
          newlyClaimedMessageIds.push(envelope.messageId);
        }
      }
      const processing = envelopes.map((envelope) => ({
        ...envelope,
        state: "processing" as const,
        processingRunId: runId,
      }));
      context.processingBatches.set(
        completionKey(target.conversationId, runId),
        processing,
      );
      startAttempted = true;
      completion = target.startMessages({
        runId,
        recovered: recoveredBatch,
        messages: processing.map((envelope) => {
          const message = this.createDeliveredMessageEntry(
            target,
            envelope,
          );
          return {
            content: message.content,
            display: message.display,
            details: message.details,
          };
        }),
      });
      for (const envelope of processing) {
        try {
          this.appendSourceCardState(
            context,
            envelope,
            "running",
            runId,
          );
        } catch (error) {
          context.attention.add(envelope.fromConversationId);
          this.emit(context, {
            type: "error",
            conversationId: envelope.fromConversationId,
            runId,
            message: error instanceof Error ? error.message : String(error),
            fatal: false,
          });
        }
      }
    } catch (error) {
      if (!startAttempted) {
        try {
          for (const messageId of newlyClaimedMessageIds.reverse()) {
            const stored = await context.inbox.get(messageId);
            if (
              stored?.state === "processing"
              && stored.processingRunId === runId
            ) {
              await context.inbox.updateState(messageId, { state: "queued" });
            }
          }
          context.processingBatches.delete(
            completionKey(target.conversationId, runId),
          );
          if (!context.closing) {
            this.trackBackground(context, this.runLifecycle(context, async () => {
              await this.pumpTarget(context, target.conversationId);
            }));
          }
        } catch (rollbackError) {
          if (!context.closing) {
            this.trackBackground(context, this.runLifecycle(context, () =>
              this.recoverFailedBatch(
                context,
                target.conversationId,
                runId,
                rollbackError,
              )
            ));
          }
        }
        return "not_started";
      }
      // Once startMessages is attempted, keep the exact processing identity
      // and replace the actor before one bounded retry. Rolling transport back
      // across that ambiguous boundary could inject a duplicate message.
      if (!context.closing) {
        this.trackBackground(context, this.runLifecycle(context, () =>
          this.recoverFailedBatch(
            context,
            target.conversationId,
            runId,
            error,
          )
        ));
      }
      return "not_started";
    }
    this.trackBackground(
      context,
      this.runLifecycle(context, async () => {
        await this.reconcileInbox(context, target.conversationId);
      }),
    );
    this.trackBackground(context, completion.then(
      () => undefined,
      (error) => this.runLifecycle(context, () => this.recoverFailedBatch(
        context,
        target.conversationId,
        runId,
        error,
      )),
    ));
    return "started";
  }

  private async finishBatch(
    context: ProjectContext,
    targetConversationId: string,
    runId: string,
    _settlement: RunSettlement,
  ): Promise<void> {
    const key = completionKey(targetConversationId, runId);
    const initialEnvelopes = context.processingBatches.get(key) ?? [];
    const finish = async (retrying: boolean): Promise<void> => {
      try {
        if (!await this.reconcileInbox(context, targetConversationId)) return;
        await this.reconcileReceiptLedger(context, targetConversationId);
        for (const envelope of initialEnvelopes) {
          const stored = await context.inbox.get(envelope.messageId);
          if (
            stored?.state === "processing"
            && stored.processingRunId === runId
          ) {
            await context.inbox.updateState(stored.messageId, {
              state: "queued",
            });
          }
          this.removeEnvelopeFromProcessingBatches(
            context,
            envelope.messageId,
          );
        }
      } catch (error) {
        if (!retrying) {
          await finish(true);
          return;
        }
        throw error;
      }
      context.processingBatches.delete(key);
      context.failedBatchRetries.delete(key);
      this.emit(context, { type: "project_changed" });
    };
    await finish(false);
  }

  private async recoverFailedBatch(
    context: ProjectContext,
    targetConversationId: string,
    runId: string,
    error: unknown,
    continuingAfterDeletionReservation = false,
  ): Promise<void> {
    const key = completionKey(targetConversationId, runId);
    const deletionCommittedOrGone = async () => {
      const durableDeletionTargets = new Set(
        await context.inbox.listDeletedTargets(),
      );
      const targetExists = context.actors.has(targetConversationId)
        || context.project.listConversations().some(
          ({ id }) => id === targetConversationId,
        );
      return durableDeletionTargets.has(targetConversationId) || !targetExists;
    };
    const finishAsDeleted = () => {
      context.processingBatches.delete(key);
      context.failedBatchRetries.delete(key);
      context.attention.delete(targetConversationId);
    };
    const requeueAfterDeletionReservation = () => {
      if (context.closing) return;
      this.trackBackground(
        context,
        this.runLifecycle(context, () =>
          this.recoverFailedBatch(
            context,
            targetConversationId,
            runId,
            error,
            true,
          )
        ),
      );
    };

    if (await deletionCommittedOrGone()) {
      finishAsDeleted();
      return;
    }
    const retryAlreadyConsumed = context.failedBatchRetries.has(key);
    if (context.deleting.has(targetConversationId)) {
      if (continuingAfterDeletionReservation || !retryAlreadyConsumed) {
        requeueAfterDeletionReservation();
      } else {
        context.processingBatches.delete(key);
      }
      return;
    }
    if (retryAlreadyConsumed && !continuingAfterDeletionReservation) {
      context.processingBatches.delete(key);
      return;
    }
    if (!retryAlreadyConsumed) {
      context.attention.add(targetConversationId);
      this.emit(context, {
        type: "error",
        conversationId: targetConversationId,
        runId,
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
      context.failedBatchRetries.add(key);
    }
    if (context.closing) return;

    try {
      const failedActor = context.actors.get(targetConversationId);
      if (failedActor) {
        context.actorUnsubscribes.get(targetConversationId)?.();
        context.actorUnsubscribes.delete(targetConversationId);
        await failedActor.dispose();
        if (context.actors.get(targetConversationId) === failedActor) {
          context.actors.delete(targetConversationId);
        }
      }
      await this.getOrOpenActor(context, targetConversationId);
      const pumpResult = await this.pumpTarget(context, targetConversationId);
      if (pumpResult === "blocked_by_deletion") {
        requeueAfterDeletionReservation();
      }
    } catch (recoveryError) {
      if (await deletionCommittedOrGone()) {
        finishAsDeleted();
        return;
      }
      if (context.deleting.has(targetConversationId)) {
        requeueAfterDeletionReservation();
        return;
      }
      throw recoveryError;
    }
  }

  private onActorCompletion(
    context: ProjectContext,
    actor: ConversationActor,
    completion: ConversationActorCompletion,
  ): void {
    this.recordCompletion(
      context,
      actor.conversationId,
      completion.settlement,
    );
    if (context.closing) return;
    this.trackBackground(context, this.runLifecycle(context, async () => {
      await this.finishBatch(
        context,
        actor.conversationId,
        completion.settlement.runId,
        completion.settlement,
      );
      if (context.actors.get(actor.conversationId) === actor) {
        await this.pumpTarget(context, actor.conversationId);
      }
      await this.retryBlockedDeletions(context);
      await this.maybeCompleteReloadAdoption(
        context,
        actor.conversationId,
      );
    }).catch((error) => {
      this.rejectRunWaiters(
        context,
        actor.conversationId,
        completion.settlement.runId,
        error instanceof Error ? error : new Error(String(error)),
      );
      context.attention.add(actor.conversationId);
      this.emit(context, {
        type: "error",
        conversationId: actor.conversationId,
        runId: completion.settlement.runId,
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
    }));
  }


  private async reloadTargetHasPendingWork(
    context: ProjectContext,
    conversationId: string,
  ): Promise<boolean> {
    const actor = context.actors.get(conversationId);
    if (
      actor
      && (actor.getActivity().kind !== "idle" || actor.isCompacting())
    ) return true;
    const batchPrefix = `${conversationId.length}:${conversationId}:`;
    if ([...context.processingBatches.keys()].some((key) =>
      key.startsWith(batchPrefix)
    )) {
      return true;
    }
    try {
      if ((await context.inbox.list({
        toConversationId: conversationId,
      })).length > 0) {
        return true;
      }
      return await this.withConversationManager(
        context,
        conversationId,
        (manager) => {
          const aggregate = aggregateReservedConversationEntries(
            manager.getEntries(),
          );
          const settledRunIds = new Set(
            aggregate.runSettlements.map(({ runId }) => runId),
          );
          return aggregate.messageDeliveryReceipts.some(
            ({ targetRunId }) => !settledRunIds.has(targetRunId),
          );
        },
      );
    } catch {
      return true;
    }
  }

  private async maybeCompleteReloadAdoption(
    context: ProjectContext,
    conversationId: string,
  ): Promise<void> {
    const adoption = context.reloadAdoptions.get(conversationId);
    if (!adoption || adoption.notifying) return;
    let settlement = context.completions.get(
      completionKey(conversationId, adoption.runId),
    );
    if (!settlement) {
      try {
        settlement = await this.withConversationManager(
          context,
          conversationId,
          (manager) => aggregateReservedConversationEntries(
            manager.getEntries(),
          ).runSettlements.find(({ runId }) => runId === adoption.runId),
        );
      } catch {
        return;
      }
    }
    if (
      !settlement
      || await this.reloadTargetHasPendingWork(context, conversationId)
    ) return;
    adoption.notifying = true;
    void adoption.onCompleted({
      requestId: adoption.requestId,
      cwd: context.project.cwd,
      conversationId,
      runId: adoption.runId,
    }).then(
      () => {
        if (context.reloadAdoptions.get(conversationId) !== adoption) return;
        context.reloadAdoptions.delete(conversationId);
        this.reloadReservations.delete(reloadReservationKey(
          context.project.cwd,
          conversationId,
        ));
      },
      (error: unknown) => {
        context.attention.add(conversationId);
        this.emit(context, {
          type: "error",
          conversationId,
          runId: adoption.runId,
          message: error instanceof Error ? error.message : String(error),
          fatal: false,
        });
      },
    );
  }

  private async scrubProjectCatalog(context: ProjectContext): Promise<void> {
    while (!context.closing) {
      const advanced = await context.project.scrubOneCatalogObservation();
      if (!advanced) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async recoverProject(context: ProjectContext): Promise<void> {
    if (context.closing) return;
    let summaries = await context.project.refreshConversations();
    const existingIds = new Set(summaries.map(({ id }) => id));
    await context.inbox.pruneCompletedTargetTombstones(existingIds);
    for (const conversationId of await context.inbox.listDeletedTargets()) {
      if (context.closing) return;
      if (!existingIds.has(conversationId)) {
        await context.inbox.clearTargetTombstone(conversationId);
        context.deleting.delete(conversationId);
        continue;
      }
      try {
        await this.deleteConversationInternal(
          context,
          conversationId,
          true,
          undefined,
          true,
        );
      } catch {
        context.attention.add(conversationId);
      }
    }
    const blockedTargets = new Set(
      await context.inbox.listDeletedTargets(),
    );
    const pending = await context.inbox.list();
    summaries = await context.project.refreshConversations();
    const startedAbortOperations: Array<{
      sourceConversationId: string;
      operation: Extract<
        MetaOperation,
        { kind: "abort_session"; state: "started" }
      >;
    }> = [];
    const actorIds = new Set(
      pending
        .filter(({ toConversationId }) =>
          !blockedTargets.has(toConversationId)
        )
        .map(({ toConversationId }) => toConversationId),
    );
    for (const summary of summaries) {
      if (context.closing) return;
      if (blockedTargets.has(summary.id)) {
        context.attention.add(summary.id);
        continue;
      }
      try {
        const inspection = await context.project.inspectConversation(
          summary.id,
        );
        for (const operation of inspection.metaOperations) {
          if (
            operation.kind === "abort_session"
            && operation.state === "started"
            && operation.result.aborted
          ) {
            startedAbortOperations.push({
              sourceConversationId: summary.id,
              operation,
            });
          }
        }
        const settledRunIds = new Set(
          inspection.runSettlements.map(({ runId }) => runId),
        );
        if (inspection.messageDeliveryReceipts.some((receipt) =>
          !settledRunIds.has(receipt.targetRunId)
          || receipt.kind === "delegation_task"
        )) {
          actorIds.add(summary.id);
        }
        const profile = inspection.conversationMeta;
        if (!profile) {
          throw new Error(`Conversation ${summary.id} profile metadata is missing`);
        }
        context.profiles.set(summary.id, cloneProfile(profile));
      } catch {
        context.attention.add(summary.id);
      }
    }

    for (const recovery of startedAbortOperations) {
      if (context.closing) return;
      try {
        await this.recoverStartedAbortOperation(context, recovery);
      } catch {
        context.attention.add(recovery.sourceConversationId);
        context.attention.add(
          recovery.operation.targetConversationId,
        );
      }
    }

    for (const envelope of pending) {
      if (context.closing) return;
      if (blockedTargets.has(envelope.toConversationId)) continue;
      try {
        const project = (manager: ConversationActor["sessionManager"]) => {
          const card = aggregateReservedConversationEntries(
            manager.getEntries(),
          ).cards.find(({ cardId }) => cardId === envelope.cardId);
          if (card?.state !== "sending") return;
          appendReservedCustomEntry(
            manager,
            createConversationCardEntry({
              ...card,
              state: envelope.state === "processing" ? "running" : "queued",
              messageId: envelope.messageId,
              ...(envelope.delegationId === undefined
                ? {}
                : { delegationId: envelope.delegationId }),
              ...(envelope.requestFingerprint === undefined
                ? {}
                : { requestFingerprint: envelope.requestFingerprint }),
              ...(envelope.processingRunId === undefined
                ? {}
                : { runId: envelope.processingRunId }),
              updatedAt: this.now().toISOString(),
            }),
          );
        };
        await this.withStoredConversationManager(
          context,
          envelope.fromConversationId,
          project,
        );
      } catch {
        // A deleted source must not prevent the durable target delivery.
      }
    }

    await this.reconcileInbox(context);
    for (const actorId of actorIds) {
      if (context.closing) return;
      try {
        await this.getOrOpenActor(context, actorId);
        await this.pumpTarget(context, actorId);
      } catch {
        context.attention.add(actorId);
      }
    }
    await this.retryBlockedDeletions(context);
    this.emit(context, { type: "project_changed" });
  }

  private async recoverStartedAbortOperation(
    context: ProjectContext,
    recovery: {
      sourceConversationId: string;
      operation: Extract<
        MetaOperation,
        { kind: "abort_session"; state: "started" }
      >;
    },
  ): Promise<void> {
    const { sourceConversationId, operation } = recovery;
    const targetExists = context.project.listConversations().some(
      ({ id }) => id === operation.targetConversationId,
    );
    if (targetExists) {
      let recoveredSettlement: RunSettlement | undefined;
      await this.withConversationManager(
        context,
        operation.targetConversationId,
        async (manager) => {
          recoveredSettlement = aggregateReservedConversationEntries(
            manager.getEntries(),
          ).runSettlements.find(
            ({ runId }) => runId === operation.runId,
          );
        },
      );
      const targetActor = context.actors.get(
        operation.targetConversationId,
      );
      const targetActivity = targetActor?.getActivity();
      if (
        !recoveredSettlement
        && targetActor
        && targetActivity
        && targetActivity.kind !== "idle"
        && targetActivity.runId === operation.runId
      ) {
        const completion = this.observeSettlement(
          context,
          targetActor,
          operation.runId,
        );
        await targetActor.abort(operation.runId);
        recoveredSettlement = await completion;
      }
      const interrupted = (await context.inbox.list({
        toConversationId: operation.targetConversationId,
      })).filter(
        (envelope) =>
          envelope.state === "processing"
          && envelope.processingRunId === operation.runId,
      );
      if (!recoveredSettlement && interrupted.length > 0) {
        recoveredSettlement = createRunSettlementEntry({
          runId: operation.runId,
          outcome: "aborted",
          finalText: null,
          settledAt: this.now().toISOString(),
        }).data;
        await this.withConversationManager(
          context,
          operation.targetConversationId,
          async (manager) => {
            appendReservedCustomEntry(
              manager,
              createRunSettlementEntry(recoveredSettlement!),
            );
          },
        );
        this.recordCompletion(
          context,
          operation.targetConversationId,
          recoveredSettlement,
        );
      }
      if (recoveredSettlement && interrupted.length > 0) {
        context.processingBatches.set(
          completionKey(
            operation.targetConversationId,
            operation.runId,
          ),
          interrupted,
        );
        await this.finishBatch(
          context,
          operation.targetConversationId,
          operation.runId,
          recoveredSettlement,
        );
      }
    }

    await this.withConversationManager(
      context,
      sourceConversationId,
      async (manager) => {
        const existing = aggregateReservedConversationEntries(
          manager.getEntries(),
        ).metaOperations.find(
          ({ operationId }) => operationId === operation.operationId,
        );
        if (
          existing?.kind === "abort_session"
          && existing.state === "started"
        ) {
          appendReservedCustomEntry(
            manager,
            createMetaOperationEntry({
              ...existing,
              state: "completed",
              updatedAt: this.now().toISOString(),
            }),
          );
        }
      },
    );
  }

  private async withStoredConversationManager<T>(
    context: ProjectContext,
    conversationId: string,
    work: (
      manager: ConversationActor["sessionManager"],
    ) => Promise<T> | T,
  ): Promise<T | undefined> {
    const active = context.actors.get(conversationId);
    if (active) return await work(active.sessionManager);
    const opening = context.actorOpenings.get(conversationId);
    if (opening) return await work((await opening).sessionManager);
    if (!context.project.listConversations().some(
      ({ id }) => id === conversationId
    )) {
      return undefined;
    }

    let lease: ReturnType<ProjectStoreRegistry["acquireConversation"]>;
    try {
      lease = this.projects.acquireConversation(
        context.project.cwd,
        conversationId,
      );
    } catch (error) {
      const racedActive = context.actors.get(conversationId);
      if (racedActive) return await work(racedActive.sessionManager);
      const racedOpening = context.actorOpenings.get(conversationId);
      if (racedOpening) {
        return await work((await racedOpening).sessionManager);
      }
      throw error;
    }
    try {
      const manager = await context.project.openConversation(
        conversationId,
        { updateRecent: false },
      );
      return await work(manager);
    } finally {
      lease.release();
    }
  }

  private async withConversationManager<T>(
    context: ProjectContext,
    conversationId: string,
    work: (
      manager: ConversationActor["sessionManager"],
    ) => Promise<T> | T,
  ): Promise<T> {
    const active = context.actors.get(conversationId);
    if (active) return work(active.sessionManager);
    let actor: ConversationActor;
    try {
      actor = await this.getOrOpenActor(context, conversationId);
    } catch (openError) {
      if (
        context.closing
        || this.disposed
        || context.deleting.has(conversationId)
      ) {
        throw openError;
      }
      const lease = await this.projects.acquireConversationWhenAvailable(
        context.project.cwd,
        conversationId,
      );
      try {
        const manager = await context.project.openConversation(
          conversationId,
          { updateRecent: false },
        );
        return await work(manager);
      } finally {
        lease.release();
      }
    }
    return await work(actor.sessionManager);
  }

  private async pumpTarget(
    context: ProjectContext,
    conversationId: string,
  ): Promise<"blocked_by_deletion" | "no_work" | "settled" | "started"> {
    if (context.closing) return "no_work";
    if (context.deleting.has(conversationId)) return "blocked_by_deletion";
    const actor = context.actors.get(conversationId);
    if (!actor) return "no_work";
    if (!await this.reconcileInbox(context, conversationId)) return "no_work";
    const receiptRunIds = await this.reconcileReceiptLedger(
      context,
      conversationId,
    );
    if (receiptRunIds.length > 1) {
      context.attention.add(conversationId);
      throw new Error(
        `Multiple unsettled inbox receipt runs found for ${conversationId}`,
      );
    }
    if (actor.getActivity().kind !== "idle") return "no_work";
    if (receiptRunIds.length === 1) {
      const runId = receiptRunIds[0]!;
      const completion = actor.resumeMessages({ runId });
      this.trackBackground(context, completion.then(
        () => undefined,
        (error) => this.runLifecycle(context, () => this.recoverFailedBatch(
          context,
          conversationId,
          runId,
          error,
        )),
      ));
      return "started";
    }
    const pending = await context.inbox.list({
      toConversationId: conversationId,
    });
    if (context.closing) return "no_work";
    if (context.deleting.has(conversationId)) return "blocked_by_deletion";
    if (pending.length === 0) return "no_work";

    const aggregate = aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    );
    const first = pending[0]!;
    let runId: string;
    if (first.state === "processing") {
      runId = first.processingRunId!;
    } else {
      runId = randomUUID();
    }
    const batch = pending
      .filter((envelope) => first.state === "processing"
        ? (
            envelope.state === "processing"
            && envelope.processingRunId === runId
          )
        : envelope.state === "queued")
      .slice(0, MAX_BATCH_MESSAGES);
    const settled = aggregate.runSettlements.find(
      (settlement) => settlement.runId === runId,
    );
    if (settled) {
      context.attention.add(conversationId);
      throw new Error(
        `Queued inbox work conflicts with settled run ${runId}`,
      );
    }
    const dispatch = await this.dispatchBatch(
      context,
      actor,
      batch,
      runId,
    );
    return dispatch === "started" ? "started" : "no_work";
  }

  private collectCascadeDeletionIds(
    context: ProjectContext,
    conversationId: string,
  ): string[] {
    const knownIds = new Set([
      ...context.project.listConversations().map(({ id }) => id),
      ...context.actors.keys(),
    ]);
    this.validateConversationLineageGraph(context, knownIds);
    return [...knownIds]
      .filter((candidateId) =>
        candidateId === conversationId
        || this.isCascadeDescendant(
          context,
          candidateId,
          conversationId,
          knownIds,
        )
      )
      .sort((left, right) => {
        const depth = this.cascadeDeletionDepth(
          context,
          right,
          conversationId,
          knownIds,
        ) - this.cascadeDeletionDepth(
          context,
          left,
          conversationId,
          knownIds,
        );
        return depth === 0 ? left.localeCompare(right) : depth;
      });
  }

  private validateConversationLineageGraph(
    context: ProjectContext,
    conversationIds: ReadonlySet<string>,
  ): void {
    for (const candidateId of conversationIds) {
      const profile = context.actors.get(candidateId)?.profile
        ?? context.profiles.get(candidateId);
      if (profile === undefined) {
        throw new Error(`Conversation ${candidateId} profile metadata is missing`);
      }
      this.resolveOrchestration(context, candidateId, profile);
    }
  }

  private isCascadeDescendant(
    context: ProjectContext,
    conversationId: string,
    ancestorConversationId: string,
    knownIds: ReadonlySet<string>,
    visited: Set<string> = new Set(),
  ): boolean {
    if (conversationId === ancestorConversationId) return true;
    if (visited.has(conversationId)) {
      throw new Error(
        `Orchestration parent cycle detected at ${conversationId}`,
      );
    }
    visited.add(conversationId);

    const profile = context.actors.get(conversationId)?.profile
      ?? context.profiles.get(conversationId);
    if (profile === undefined) {
      throw new Error(`Conversation ${conversationId} profile metadata is missing`);
    }
    if (profile.createdBy.kind !== "conversation") return false;

    const parentId = profile.createdBy.conversationId;
    if (parentId === ancestorConversationId) return true;
    if (knownIds.has(parentId)) {
      return this.isCascadeDescendant(
        context,
        parentId,
        ancestorConversationId,
        knownIds,
        visited,
      );
    }

    return profile.orchestration?.rootConversationId === ancestorConversationId;
  }

  private cascadeDeletionDepth(
    context: ProjectContext,
    conversationId: string,
    rootConversationId: string,
    knownIds: ReadonlySet<string>,
    visited: Set<string> = new Set(),
  ): number {
    if (conversationId === rootConversationId) return 0;
    if (visited.has(conversationId)) return 0;
    visited.add(conversationId);

    const profile = context.actors.get(conversationId)?.profile
      ?? context.profiles.get(conversationId);
    if (profile === undefined) {
      throw new Error(`Conversation ${conversationId} profile metadata is missing`);
    }
    if (profile.createdBy.kind === "conversation") {
      const parentId = profile.createdBy.conversationId;
      if (parentId === rootConversationId) return 1;
      if (
        knownIds.has(parentId)
        && this.isCascadeDescendant(
          context,
          parentId,
          rootConversationId,
          knownIds,
        )
      ) {
        return 1 + this.cascadeDeletionDepth(
          context,
          parentId,
          rootConversationId,
          knownIds,
          visited,
        );
      }
    }
    if (profile.orchestration?.rootConversationId === rootConversationId) {
      return profile.orchestration.depth;
    }
    return 1;
  }

  private async deleteConversationInternal(
    context: ProjectContext,
    conversationId: string,
    deletionReserved = false,
    protectedConversationId?: string,
    reservedByDurableTombstone = false,
  ): Promise<boolean> {
    const ownedReservationIds = new Set<string>();
    const durableFenceIds = new Set<string>();
    const deletionPreflights = new Map<string, DeletionLeasePreflight>();
    if (deletionReserved) {
      if (!context.deleting.has(conversationId)) {
        throw new Error(
          `Conversation deletion reservation was lost: ${conversationId}`,
        );
      }
      if (!reservedByDurableTombstone) {
        ownedReservationIds.add(conversationId);
      }
    } else if (!this.reserveDeletion(context, conversationId)) {
      return false;
    } else {
      ownedReservationIds.add(conversationId);
    }

    const known = context.project.listConversations()
      .some(({ id }) => id === conversationId);
    if (!known && !context.actors.has(conversationId)) {
      try {
        await context.inbox.clearTargetTombstone(conversationId);
        return false;
      } finally {
        context.deleting.delete(conversationId);
      }
    }

    const preexistingDurableFenceIds = reservedByDurableTombstone
      ? new Set(await context.inbox.listDeletedTargets())
      : new Set<string>();
    for (const durableId of preexistingDurableFenceIds) {
      durableFenceIds.add(durableId);
    }

    let cascadeIds = [conversationId];
    const startedDeletionIds = new Set<string>();
    try {
      await this.hydrateConversationProfiles(context);
      cascadeIds = this.collectCascadeDeletionIds(context, conversationId);
      if (
        protectedConversationId !== undefined
        && cascadeIds.includes(protectedConversationId)
      ) {
        throw new Error("An Agent cannot delete its own session");
      }
      const reloadProtectedConversationId = cascadeIds.find((cascadeId) =>
        this.isReloadProtected(context, cascadeId)
      );
      if (reloadProtectedConversationId !== undefined) {
        throw new Error(
          "Cannot delete while reload completion acknowledgement is pending",
        );
      }
      for (const cascadeId of cascadeIds) {
        if (cascadeId === conversationId) continue;
        if (!this.reserveDeletion(context, cascadeId)) {
          if (preexistingDurableFenceIds.has(cascadeId)) continue;
          throw new Error(`Conversation is being deleted: ${cascadeId}`);
        }
        ownedReservationIds.add(cascadeId);
      }
      const openingConversationId = cascadeIds.find((cascadeId) =>
        context.actorOpenings.has(cascadeId)
      );
      if (openingConversationId !== undefined) {
        throw new Error(
          "Cannot delete a conversation while it is opening; wait first",
        );
      }
      const busyConversationId = cascadeIds.find((cascadeId) => {
        const actor = context.actors.get(cascadeId);
        return actor !== undefined
          && (actor.getActivity().kind !== "idle" || actor.isCompacting());
      });
      if (busyConversationId !== undefined) {
        throw new Error(
          "Cannot delete a busy conversation or one that is compacting; wait first",
        );
      }

      for (const cascadeId of cascadeIds) {
        const actor = context.actors.get(cascadeId);
        if (actor !== undefined) {
          deletionPreflights.set(cascadeId, { kind: "actor", actor });
          continue;
        }
        const writer = this.projects.acquireConversation(
          context.project.cwd,
          cascadeId,
        );
        try {
          deletionPreflights.set(cascadeId, {
            kind: "cold",
            lease: writer.upgradeToDeletion(),
          });
        } catch (error) {
          writer.release();
          throw error;
        }
      }

      for (const source of context.actors.values()) {
        const attempt = source.getCurrentWaitAttempt();
        if (attempt?.targets.some((target) => cascadeIds.includes(
          target.conversationId,
        ))) {
          source.completeWaitAttempt(attempt.ownership, attempt.handle);
        }
      }

      const deletedAt = this.now().toISOString();
      await context.inbox.markTargetDeleted(conversationId, deletedAt);
      durableFenceIds.add(conversationId);
      for (const cascadeId of cascadeIds) {
        if (cascadeId === conversationId) continue;
        await context.inbox.markTargetDeleted(cascadeId, deletedAt);
        durableFenceIds.add(cascadeId);
      }

      for (const cascadeId of cascadeIds) {
        startedDeletionIds.add(cascadeId);
        await this.deleteSingleConversationInternal(
          context,
          cascadeId,
          deletionPreflights,
        );
      }
      await this.retryBlockedDeletions(context);
      return true;
    } catch (error) {
      for (const reservedId of ownedReservationIds) {
        if (
          !startedDeletionIds.has(reservedId)
          && !durableFenceIds.has(reservedId)
        ) {
          context.deleting.delete(reservedId);
        }
      }
      throw error;
    } finally {
      for (const preflight of deletionPreflights.values()) {
        if (preflight.kind === "cold") preflight.lease.release();
      }
    }
  }

  private async deleteSingleConversationInternal(
    context: ProjectContext,
    conversationId: string,
    deletionPreflights: Map<string, DeletionLeasePreflight>,
  ): Promise<boolean> {
    const known = context.project.listConversations()
      .some(({ id }) => id === conversationId);
    if (!known && !context.actors.has(conversationId)) {
      try {
        await context.inbox.clearTargetTombstone(conversationId);
        return false;
      } finally {
        context.deleting.delete(conversationId);
      }
    }
    const actor = context.actors.get(conversationId);
    if (
      actor
      && (
        actor.getActivity().kind !== "idle"
        || actor.isCompacting()
      )
    ) {
      throw new Error(
        "Cannot delete a busy conversation or one that is compacting; wait first",
      );
    }
    const preflight = deletionPreflights.get(conversationId);
    if (preflight === undefined) {
      throw new Error(
        `Conversation deletion lease preflight was lost: ${conversationId}`,
      );
    }
    let coldDeletionLease: ConversationDeletionLease | undefined;
    if (actor !== undefined) {
      if (preflight.kind !== "actor" || preflight.actor !== actor) {
        throw new Error(
          `Conversation deletion lease preflight changed: ${conversationId}`,
        );
      }
    } else {
      if (preflight.kind !== "cold") {
        throw new Error(
          `Conversation deletion lease preflight changed: ${conversationId}`,
        );
      }
      coldDeletionLease = preflight.lease;
    }
    let deletionLease: ConversationDeletionLease | undefined;
    let durableDeletionIntent = false;
    try {
      await context.inbox.markTargetDeleted(
        conversationId,
        this.now().toISOString(),
      );
      durableDeletionIntent = true;
      const pending = await context.inbox.list({
        toConversationId: conversationId,
      });
      for (const envelope of pending) {
        await this.appendTerminalSourceCardState(
          context,
          envelope,
          "failed",
          envelope.processingRunId,
          "目标会话已删除，消息未被处理。",
        );
        await context.inbox.delete(envelope.messageId);
      }
      if (actor) {
        context.actorUnsubscribes.get(conversationId)?.();
        context.actorUnsubscribes.delete(conversationId);
        deletionLease = await actor.dispose({
          transferLeaseForDeletion: true,
        });
        deletionPreflights.delete(conversationId);
        context.actors.delete(conversationId);
      } else {
        deletionLease = coldDeletionLease;
        deletionPreflights.delete(conversationId);
      }
      if (!deletionLease) {
        throw new Error("Conversation deletion lease was not transferred");
      }
      await context.inbox.tombstoneTarget(conversationId);
      await context.project.deleteConversation(conversationId);
      await context.inbox.clearTargetTombstone(conversationId);
      durableDeletionIntent = false;
      context.extensionUIRouters.get(conversationId)?.clear();
      context.extensionUIRouters.delete(conversationId);
      context.profiles.delete(conversationId);
      context.attention.delete(conversationId);

      this.emit(context, { type: "project_changed" });
      return true;
    } finally {
      deletionLease?.release();
      if (!durableDeletionIntent) {
        context.deleting.delete(conversationId);
      }
    }
  }

  private reserveDeletion(
    context: ProjectContext,
    conversationId: string,
  ): boolean {
    if (
      context.deleting.has(conversationId)
      || this.isReloadProtected(context, conversationId)
    ) return false;
    context.deleting.add(conversationId);
    return true;
  }

  private extensionUIRouter(
    context: ProjectContext,
    conversationId: string,
  ): ConversationExtensionUIRouter {
    let router = context.extensionUIRouters.get(conversationId);
    if (router) return router;
    router = new ConversationExtensionUIRouter(() => {
      context.attention.add(conversationId);
      this.emit(context, { type: "project_changed" });
    });
    context.extensionUIRouters.set(conversationId, router);
    return router;
  }

  private requireActor(
    context: ProjectContext,
    conversationId: string,
  ): ConversationActor {
    const actor = context.actors.get(conversationId);
    if (!actor) throw new Error(`Conversation is not active: ${conversationId}`);
    return actor;
  }

  private resolveAvailableConversationRole(
    roleId: string,
    modelRegistry: RoleCatalogModelRegistry,
  ): ConversationRoleSnapshot {
    const template = this.roles.listRoles(modelRegistry)
      .find(({ id }) => id === roleId);
    if (!template) throw new Error(`Role not found: ${roleId}`);
    if (!template.available) {
      throw new Error(
        template.unavailableReason ?? `Role is unavailable: ${roleId}`,
      );
    }
    return this.roles.getConversationRole(roleId);
  }

  private requireContext(handle: ProjectSessionHandle): ProjectContext {
    this.assertOpen();
    const context = handle.context;
    if (
      handle.isReleased
      || context.closing
      || this.contexts.get(context.key) !== context
    ) {
      throw new Error("Project session handle is closed");
    }
    return context;
  }

  private runLifecycle<T>(
    context: ProjectContext,
    task: () => Promise<T> | T,
  ): Promise<T> {
    return context.lifecycle.run(() => {
      if (context.closing || this.disposed) {
        throw new Error("Project context is closing");
      }
      return task();
    });
  }

  private acknowledgeConversationFocus(
    context: ProjectContext,
    conversationId: string,
  ): void {
    if (context.attention.delete(conversationId)) {
      this.emit(context, { type: "project_changed" });
    }
  }

  private markConversationRecent(
    context: ProjectContext,
    conversationId: string,
  ): Promise<void> {
    if (context.closing || this.disposed) {
      return Promise.reject(new Error("Project context is closing"));
    }
    let recentUpdate: Promise<void>;
    try {
      recentUpdate = context.project.setLastConversation(conversationId);
    } catch (error) {
      return Promise.reject(error);
    }
    context.recentUpdates.add(recentUpdate);
    void recentUpdate.finally(() => {
      context.recentUpdates.delete(recentUpdate);
    }).catch(() => undefined);
    return recentUpdate;
  }

  private trackBackground(
    context: ProjectContext,
    task: Promise<void>,
  ): Promise<void> {
    const tracked = task.catch((error) => {
      if (!context.closing) {
        this.emit(context, { type: "project_changed" });
      }
      throw error;
    });
    context.backgroundTasks.add(tracked);
    void tracked.finally(() => {
      context.backgroundTasks.delete(tracked);
    }).catch(() => undefined);
    return tracked;
  }

  private async drainRecentUpdates(context: ProjectContext): Promise<void> {
    while (context.recentUpdates.size > 0) {
      await Promise.allSettled([...context.recentUpdates]);
    }
  }

  private async drainBackground(context: ProjectContext): Promise<void> {
    while (context.backgroundTasks.size > 0) {
      await Promise.allSettled([...context.backgroundTasks]);
    }
  }

  private emit(
    context: ProjectContext,
    event: ProjectSessionCoordinatorEvent,
  ): void {
    if (this.disposed) return;
    if (event.type !== "session_event") {
      this.publishProjectActivityIfChanged(context);
    }
    for (const listener of [...context.listeners]) {
      try {
        listener(event);
      } catch {
        // Observers cannot roll back actor or durable project state.
      }
    }
  }

  private projectActivitySummary(
    context: ProjectContext,
  ): ProjectActivitySummary {
    let busyConversationCount = 0;
    for (const actor of context.actors.values()) {
      if (
        actor.isCompacting()
        || actor.getActivity().kind !== "idle"
      ) {
        busyConversationCount++;
      }
    }
    return {
      projectId: context.project.id,
      cwd: context.project.cwd,
      busyConversationCount,
      attentionConversationCount: context.attention.size,
    };
  }

  private publishProjectActivityIfChanged(
    context: ProjectContext,
    touchCatalog = false,
  ): void {
    if (
      this.disposed
      || this.contexts.get(context.key) !== context
    ) return;
    const summary = this.projectActivitySummary(context);
    if (!this.updateProjectActivitySummary(
      context.key,
      summary,
      touchCatalog,
    )) return;
    if (this.projectActivityListeners.size === 0) return;
    const snapshot = this.projectActivitySnapshot();
    for (const listener of [...this.projectActivityListeners]) {
      this.notifyProjectActivityListener(listener, snapshot);
    }
  }

  private updateProjectActivitySummary(
    key: string,
    summary: ProjectActivitySummary,
    touchCatalog = false,
  ): boolean {
    const previous = this.projectActivitySummaries.get(key);
    if (
      previous?.busyConversationCount === summary.busyConversationCount
      && previous.attentionConversationCount
        === summary.attentionConversationCount
      && (!touchCatalog || this.projectActivityCatalog.has(key))
    ) return false;
    this.projectActivitySummaries.set(key, summary);
    const cached = {
      summary,
      revision: ++this.projectActivityRevision,
    } satisfies CachedProjectActivity;
    this.projectActivityCatalog.set(key, cached);
    if (
      this.projectActivityCatalog.size <= MAX_PROJECT_ACTIVITY_SUMMARIES
    ) return true;

    let lowestKey: string | undefined;
    let lowest: CachedProjectActivity | undefined;
    for (const [candidateKey, candidate] of this.projectActivityCatalog) {
      if (candidateKey === key) continue;
      if (!lowest || isLowerProjectActivityPriority(candidate, lowest)) {
        lowestKey = candidateKey;
        lowest = candidate;
      }
    }
    if (lowestKey !== undefined) this.projectActivityCatalog.delete(lowestKey);
    return true;
  }

  private notifyProjectActivityListener(
    listener: ProjectActivityListener,
    snapshot: ProjectActivityCatalogSnapshot,
  ): void {
    try {
      listener(snapshot);
    } catch {
      // Observers cannot roll back actor or durable project state.
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError("Operation was aborted");
  }

  private assertOpen(): void {
    if (this.closing || this.disposed) {
      throw new Error("Project session coordinator is closed");
    }
  }
}
