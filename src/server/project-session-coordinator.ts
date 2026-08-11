import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_PROJECT_ACTIVITY_SUMMARIES,
  type ConversationSummary,
  type ProjectActivitySummary,
  type ToolMode,
} from "../shared/protocol.js";
import {
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createConversationCardEntry,
  createConversationMetaEntry,
  createConversationMessageEntry,
  createMetaOperationEntry,
  createRunSettlementEntry,
  createTemporaryReturnReceiptEntry,
  MAX_CONVERSATION_BODY_BYTES,
  type ConversationCard,
  type ConversationMessageEntry,
  type ConversationMeta,
  type ConversationOrchestration,
  type ConversationReferenceSnapshot,
  type MetaOperation,
  type RunSettlement,
  type TemporaryReturnReceipt,
} from "./conversation-meta.js";
import {
  ConversationActor,
  type ConversationActorCompletion,
  type ConversationActorEvent,
  type ConversationRunOwnership,
} from "./conversation-actor.js";
import {
  projectAgentConversationPeek,
  projectConversationItemsSnapshot,
} from "./conversation-history.js";
import { createGitTools } from "./git-inspect.js";

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

function isLegacyQueuedPrompt(value: unknown): value is {
  promptId: string;
  conversationId: string;
  text: string;
  createdAt: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1
    && record.state === "queued"
    && typeof record.promptId === "string"
    && typeof record.conversationId === "string"
    && typeof record.text === "string"
    && typeof record.createdAt === "string"
  );
}

import {
  createMetaTools,
  type MetaToolService,
  type MetaToolSessionScope,
} from "./meta-tools.js";
import { createNotebookTools } from "./notebook-tools.js";
import type {
  CreatedProjectModelCatalog,
  CreatePiSessionOptions,
  PiRuntimeLike,
} from "./pi-runtime.js";
import type { PortableExtensionUI } from "./extension-ui.js";
import {
  ProjectInbox,
  type InboxEnvelope,
  type InboxEnvelopeInput,
} from "./project-inbox.js";
import {
  ProjectStoreRegistry,
  type ProjectStore,
  type ProjectStoreHandle,
} from "./project-store.js";
import { conversationDisplayTitle } from "./project-snapshot.js";
import { ProjectRunCoordinator } from "./project-run-coordinator.js";
import {
  RoleCatalog,
  type RoleCatalogModelRegistry,
} from "./role-catalog.js";
import { MAX_ROLE_SYSTEM_PROMPT_BYTES } from "./role-store.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import {
  defaultToolPolicy,
  type ToolPolicy,
} from "./tool-policy.js";

const MAX_BATCH_MESSAGES = 8;
const MAX_COMPLETION_CACHE = 256;

export const MAX_PEER_SESSIONS_PER_RUN = 16;
export const MAX_DELEGATION_DEPTH = 3;
export const MAX_LIVE_DELEGATION_DESCENDANTS = 16;
const START_SESSION_ADMISSION_FAILURE_PREFIX =
  "start_session inbox admission failed: ";
const INBOX_LIFECYCLE_GUIDANCE = [
  "生命周期提醒：你负责管理自己创建的会话生命周期；普通会话不会被系统自动终止或删除。",
  "收到结果后，请自行决定继续工作、等待运行、终止活动运行或删除空闲会话。临时会话仅在成功回传后自动删除，失败时会保留。",
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

export type ProjectActivityListener = (
  snapshot: ProjectActivityCatalogSnapshot,
) => void;

interface CachedProjectActivity {
  summary: ProjectActivitySummary;
  revision: number;
}

interface WaiterBase {
  reject(error: Error): void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface SessionMessageWaitResult {
  outcome: "message";
  conversationId: string;
  runId: string;
  messageId: string;
  sentAt: string;
}

interface CompletionWaiter extends WaiterBase {
  kind: "completion";
  resolve(settlement: RunSettlement): void;
}

interface SessionWaiter extends WaiterBase {
  kind: "session";
  waitingConversationId: string;
  targetConversationId: string;
  targetRunId: string;
  resolve(result: RunSettlement | SessionMessageWaitResult): void;
}

type ProjectWaiter = CompletionWaiter | SessionWaiter;

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
  readonly waiters: Map<string, Set<ProjectWaiter>>;
  readonly completions: Map<string, RunSettlement>;
  readonly processingBatches: Map<string, InboxEnvelope[]>;
  readonly failedBatchRetries: Set<string>;
  readonly failedDispatchRetries: Set<string>;
  readonly extensionUIRouters: Map<string, ConversationExtensionUIRouter>;
  readonly lifecycle: SerialTaskQueue;
  readonly backgroundTasks: Set<Promise<void>>;
  readonly recentUpdates: Set<Promise<void>>;
  readonly unsubscribeProject: () => void;
  modelCatalog?: CreatedProjectModelCatalog;
  modelCatalogOpening?: Promise<CreatedProjectModelCatalog>;
  references: number;
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
    if (this.released) return;
    this.released = true;
    this.context.references = Math.max(0, this.context.references - 1);
  }
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
  temporary: boolean;
  idempotencyKey: string;
}

function contextKey(cwd: string): string {
  return process.platform === "win32" ? cwd.toLowerCase() : cwd;
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

function dispatchRetryKey(
  conversationId: string,
  envelopes: readonly InboxEnvelope[],
): string {
  const first = envelopes[0];
  if (!first) throw new Error("Cannot dispatch an empty inbox batch");
  return `${conversationId.length}:${conversationId}:${first.messageId}`;
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
  return [...value].slice(0, 80).join("");
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
  createdBy: ConversationMeta["createdBy"] | { kind: "unknown" };
  createdByMe: boolean;
}

function sessionCreationProjection(
  profile: ConversationMeta | undefined,
  sourceConversationId: string,
): MetaSessionCreationProjection {
  if (!profile) {
    return {
      createdBy: { kind: "unknown" as const },
      createdByMe: false,
    };
  }
  return {
    createdBy: structuredClone(profile.createdBy),
    createdByMe:
      profile.createdBy.kind === "conversation"
      && profile.createdBy.conversationId === sourceConversationId,
  };
}

function temporarySettlementIsReturnable(
  settlement: RunSettlement,
): settlement is RunSettlement & { finalText: string } {
  return settlement.outcome === "completed"
    && settlement.finalText !== null
    && settlement.finalText.trim().length > 0
    && Buffer.byteLength(settlement.finalText, "utf8")
      <= MAX_CONVERSATION_BODY_BYTES;
}

function reportTemporarySettlementThroughReceipt(
  settlement: RunSettlement,
  receipt: TemporaryReturnReceipt,
  reportedAt: () => string,
): RunSettlement {
  if (receipt.state === "claimed") {
    return createRunSettlementEntry({
      ...settlement,
      reportedAt: reportedAt(),
      returnMessageId: receipt.messageId,
    }).data;
  }
  const existing = receipt.settlement;
  if (
    existing.runId !== settlement.runId
    || existing.outcome !== settlement.outcome
    || existing.finalText !== settlement.finalText
    || existing.settledAt !== settlement.settledAt
    || existing.returnMessageId !== receipt.messageId
  ) {
    throw new Error(
      "Settled temporary return receipt conflicts with pending settlement",
    );
  }
  return existing;
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
    input.temporary,
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
  private readonly projectActivityListeners = new Set<ProjectActivityListener>();
  private readonly projectActivitySummaries =
    new Map<string, ProjectActivitySummary>();
  private readonly projectActivityCatalog =
    new Map<string, CachedProjectActivity>();
  private projectActivityRevision = 0;
  private closing = false;
  private disposed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly runtime: PiRuntimeLike,
    private readonly roles: RoleCatalog,
    private readonly projects: ProjectStoreRegistry = new ProjectStoreRegistry(),
    private readonly projectRuns: ProjectRunCoordinator = new ProjectRunCoordinator(),
    private readonly toolPolicy: ToolPolicy = defaultToolPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async acquireProject(
    cwd: string,
    seedToolMode: ToolMode,
  ): Promise<ProjectSessionHandle> {
    this.assertOpen();
    const acquisition = this.acquireProjectInternal(cwd, seedToolMode);
    this.projectAcquisitions.add(acquisition);
    try {
      return await acquisition;
    } finally {
      this.projectAcquisitions.delete(acquisition);
    }
  }

  private async acquireProjectInternal(
    cwd: string,
    seedToolMode: ToolMode,
  ): Promise<ProjectSessionHandle> {
    const acquired = await this.projects.acquireProject(cwd, seedToolMode);
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
      existing.references++;
      this.publishProjectActivityIfChanged(existing, true);
      return new ProjectSessionHandle(existing);
    }

    const pending = this.contextOpenings.get(key);
    if (pending) {
      acquired.release();
      const context = await pending;
      this.assertOpen();
      if (context.closing) throw new Error("Project context is closing");
      context.references++;
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
        waiters: new Map(),
        completions: new Map(),
        processingBatches: new Map(),
        failedBatchRetries: new Set(),
        failedDispatchRetries: new Set(),
        extensionUIRouters: new Map(),
        lifecycle: new SerialTaskQueue(),
        backgroundTasks: new Set(),
        recentUpdates: new Set(),
        unsubscribeProject: () => undefined,
        references: 1,
        closing: false,
      } satisfies ProjectContext;
      unsubscribeProject = project.subscribe(() => {
        this.emit(contextDraft, { type: "project_changed" });
      });
      const context: ProjectContext = {
        ...contextDraft,
        unsubscribeProject,
      };
      const conversations = await project.refreshConversations();
      await inbox.pruneCompletedTargetTombstones(
        new Set(conversations.map(({ id }) => id)),
      );
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
  ) {
    const context = this.requireContext(handle);
    if (context.modelCatalog) return context.modelCatalog.modelRegistry;

    const pending = context.modelCatalogOpening;
    if (pending) {
      const catalog = await pending;
      if (context.closing || this.disposed) {
        throw new Error("Project context is closing");
      }
      return catalog.modelRegistry;
    }

    const createCatalog = this.runtime.createProjectModelCatalog;
    const opening = (async () => {
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
    context.modelCatalogOpening = opening;
    try {
      const catalog = await opening;
      if (context.closing || this.disposed) {
        throw new Error("Project context is closing");
      }
      return catalog.modelRegistry;
    } finally {
      if (context.modelCatalogOpening === opening) {
        context.modelCatalogOpening = undefined;
      }
    }
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
  ): Promise<ConversationSummary[]> {
    const context = this.requireContext(handle);
    const summaries = await context.project.refreshConversations();
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
    return this.projectConversationSummaries(
      context,
      context.project.listConversations(),
    );
  }

  private projectConversationSummaries(
    context: ProjectContext,
    summaries: readonly ConversationSummary[],
  ): ConversationSummary[] {
    return summaries.map((summary) => {
      const actor = context.actors.get(summary.id);
      const profile = actor?.profile ?? context.profiles.get(summary.id);
      const activity = actor?.getActivity() ?? { kind: "idle" };
      return {
        ...summary,
        ...(profile === undefined
          ? {}
          : {
              role: {
                id: profile.role.id,
                revision: profile.role.revision,
                name: profile.role.name,
                description: profile.role.description,
                model: { ...profile.role.model },
                defaultThinkingLevel:
                  profile.role.defaultThinkingLevel,
                toolMode: profile.role.toolMode,
                canManageSessions: profile.role.canManageSessions,
              },
              temporary: profile.lifecycle.kind === "temporary",
              createdBy: structuredClone(profile.createdBy),
            }),
        activity,
        attention: context.attention.has(summary.id),
      };
    });
  }

  async openConversation(
    handle: ProjectSessionHandle,
    conversationId: string,
    options: { updateRecent?: boolean } = {},
  ): Promise<ConversationActor> {
    const context = this.requireContext(handle);
    const actor = await this.getOrOpenActor(context, conversationId);
    if (context.deleting.has(conversationId) || actor.getState().disposed) {
      throw new Error(`Conversation is being deleted: ${conversationId}`);
    }
    if (options.updateRecent !== false) {
      this.acknowledgeConversationFocus(context, conversationId);
      await this.markConversationRecent(context, conversationId);
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
      const template = this.roles.listRoles(actor.modelRegistry)
        .find(({ id }) => id === roleId);
      if (!template) throw new Error(`Role not found: ${roleId}`);
      if (!template.available) {
        throw new Error(
          template.unavailableReason ?? `Role is unavailable: ${roleId}`,
        );
      }
      const role = this.roles.getConversationRole(roleId);
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
      const detachExtensionUI = input.extensionUI
        ? this.extensionUIRouter(context, conversationId)
            .attach(input.extensionUI)
        : undefined;
      const profile: ConversationMeta = {
        role: this.roles.getConversationRole(input.roleId),
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
              false,
              false,
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
  ): Promise<{ conversationId: string; runId: string; temporary: boolean }> {
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
      const returnMessageId = deterministicUuid(
        "piweb.start.return",
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
          return {
            conversationId,
            runId,
            temporary: input.temporary,
          };
        }
      }

      const targetTitle = normalizedTitle(input.title, input.task);
      const requestedRole = existingCard?.requestedRole
        ?? this.roles.getConversationRole(input.roleId);
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
        const sourceRunOwnership = source.currentRunOwnership();
        childOrchestration = {
          rootConversationId: sourceOrch.rootConversationId,
          depth: sourceOrch.depth + 1,
          ...(sourceRunOwnership
            ? { sourceRunId: sourceRunOwnership.runId }
            : {}),
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
          const activeSourceRun = source.currentRunOwnership(sourceRunId);
          const legacyRecoveredCount = activeSourceRun?.recovered
            ? sourceAggregate.cards.filter(
                (card) => card.kind === "delegation_task"
                  && card.orchestration === undefined,
              ).length
            : 0;
          const existingCount = runCardCount + legacyRecoveredCount;
          const totalCount = !existingCard
            ? existingCount + 1
            : existingCount;
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
            lifecycle: input.temporary
              ? {
                  kind: "temporary",
                  callerConversationId: sourceConversationId,
                  delegationId,
                  returnMessageId,
                  initialRunId: runId,
                }
              : { kind: "normal" },
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
      const lifecycle = target.profile.lifecycle;
      const lifecycleMatches = input.temporary
        ? (
            lifecycle.kind === "temporary"
            && lifecycle.callerConversationId === sourceConversationId
            && lifecycle.delegationId === delegationId
            && lifecycle.initialRunId === runId
          )
        : lifecycle.kind === "normal";
      if (
        JSON.stringify(target.profile.role) !== JSON.stringify(requestedRole)
        || !lifecycleMatches
      ) {
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

      let queued: { envelope: InboxEnvelope };
      try {
        queued = await this.enqueueEnvelope(context, source, target, {
          messageId,
          cardId,
          sentAt: recoveredEnvelope?.sentAt ?? existingCard.updatedAt,
          kind: "delegation_task",
          body: input.task,
          delegationId,
          requestFingerprint,
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
      if (activity.kind === "idle") {
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
      return {
        conversationId,
        runId,
        temporary: input.temporary,
      };
    });
  }

  async prompt(
    handle: ProjectSessionHandle,
    conversationId: string,
    runId: string,
    text: string,
    promptId?: string,
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
        return actor.admitBrowserPrompt({ promptId, runId, text });
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
  ): Promise<void> {
    const context = this.requireContext(handle);
    if (context.deleting.has(conversationId)) {
      return Promise.reject(
        new Error(`Conversation is being deleted: ${conversationId}`),
      );
    }
    return this.requireActor(context, conversationId).steer(runId, text);
  }

  setCompactionThreshold(
    handle: ProjectSessionHandle,
    conversationId: string,
    percent: number,
  ): void {
    const context = this.requireContext(handle);
    this.requireActor(context, conversationId)
      .setCompactionThresholdPercent(percent);
    this.emit(context, { type: "project_changed" });
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
      await actor.truncateFromMessage(entryId);
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
        false,
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.disposed = true;
    const lifecycleClosures = new Map<ProjectContext, Promise<void>>();
    for (const context of this.contexts.values()) {
      context.closing = true;
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
        for (const waiters of context.waiters.values()) {
          for (const waiter of waiters) {
            this.detachWaiter(waiter);
            waiter.reject(new Error("Project session coordinator is closed"));
          }
        }
        context.waiters.clear();
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
        await this.drainBackground(context);
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
        const profile = this.loadOrMigrateProfile(manager);
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
      projectRuns: this.projectRuns,
      toolPolicy: this.toolPolicy,
      createSessionOptions: this.createActorSessionOptions(
        context,
        conversationId,
        profile,
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
    this.trackBackground(context, this.recoverTemporary(context, actor));
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
      thinkingLevel: profile.role.defaultThinkingLevel,
      roleSystemPrompt: profile.role.systemPrompt,
      toolMode: profile.role.toolMode,
      extensionUI: this.extensionUIRouter(context, conversationId).ui,
      workbenchCustomTools: [
        ...(profile.role.toolMode === "read_only"
          ? createGitTools(context.project.cwd)
          : []),
        ...createNotebookTools(context.project.stateDir, conversationId),
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
    const key = completionKey(conversationId, runId);
    const waiters = context.waiters.get(key);
    if (!waiters) return;
    context.waiters.delete(key);
    for (const waiter of waiters) {
      this.detachWaiter(waiter);
      waiter.reject(error);
    }
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
        const oldest = context.completions.keys().next().value as
          | string
          | undefined;
        if (oldest === undefined) break;
        context.completions.delete(oldest);
      }
    }
    const waiters = context.waiters.get(key);
    if (!waiters) return;
    const actor = context.actors.get(conversationId);
    const lifecycle = actor?.profile.lifecycle
      ?? context.profiles.get(conversationId)?.lifecycle;
    for (const waiter of [...waiters]) {
      if (
        waiter.kind === "session"
        && lifecycle?.kind === "temporary"
        && lifecycle.initialRunId === settlement.runId
        && lifecycle.callerConversationId === waiter.waitingConversationId
      ) {
        // The temporary result body has one model-input owner: its durable
        // incoming message. Keep the caller wait until that envelope is
        // committed and resolve it with metadata instead of duplicating the
        // final text in the tool result.
        continue;
      }
      waiters.delete(waiter);
      this.detachWaiter(waiter);
      waiter.resolve(cloneSettlement(settlement));
    }
    if (waiters.size === 0) context.waiters.delete(key);
  }

  private temporaryReturnReceipt(
    context: ProjectContext,
    callerConversationId: string,
    temporaryConversationId: string,
    initialRunId: string,
  ): TemporaryReturnReceipt | undefined {
    const caller = context.actors.get(callerConversationId);
    if (!caller) return undefined;
    return aggregateReservedConversationEntries(
      caller.sessionManager.getEntries(),
    ).temporaryReturnReceipts.find((receipt) =>
      receipt.temporaryConversationId === temporaryConversationId
      && receipt.initialRunId === initialRunId
    );
  }

  private async withTemporaryReturnReceiptManager<T>(
    context: ProjectContext,
    callerConversationId: string,
    work: (manager: ConversationActor["sessionManager"]) => Promise<T> | T,
  ): Promise<T> {
    const active = context.actors.get(callerConversationId);
    if (active) return work(active.sessionManager);
    const opening = context.actorOpenings.get(callerConversationId);
    if (opening) return work((await opening).sessionManager);
    const lease = await this.projects.acquireConversationWhenAvailable(
      context.project.cwd,
      callerConversationId,
    );
    try {
      const manager = await context.project.openConversation(
        callerConversationId,
        { updateRecent: false },
      );
      return await work(manager);
    } finally {
      lease.release();
    }
  }

  private async durableTemporaryReturnReceipt(
    context: ProjectContext,
    callerConversationId: string,
    temporaryConversationId: string,
    initialRunId: string,
  ): Promise<TemporaryReturnReceipt | undefined> {
    let receipt: TemporaryReturnReceipt | undefined;
    await this.withTemporaryReturnReceiptManager(
      context,
      callerConversationId,
      (manager) => {
        receipt = aggregateReservedConversationEntries(
          manager.getEntries(),
        ).temporaryReturnReceipts.find((candidate) =>
          candidate.temporaryConversationId === temporaryConversationId
          && candidate.initialRunId === initialRunId
        );
      },
    );
    if (receipt) return receipt;

    const assignedEnvelope = (await context.inbox.list({
      toConversationId: callerConversationId,
    })).find((envelope) =>
      envelope.kind === "message"
      && envelope.fromConversationId === temporaryConversationId
      && envelope.fromRunId === initialRunId
      && envelope.temporaryReturnAssignment?.initialRunId === initialRunId
    );
    if (!assignedEnvelope?.temporaryReturnAssignment) return undefined;
    const source = context.actors.get(temporaryConversationId);
    const lifecycle = source?.profile.lifecycle;
    if (
      !source
      || lifecycle?.kind !== "temporary"
      || lifecycle.initialRunId !== initialRunId
      || lifecycle.callerConversationId !== callerConversationId
    ) {
      throw new Error("Temporary return assignment conflicts with lifecycle");
    }
    const assignment = assignedEnvelope.temporaryReturnAssignment;
    await this.withTemporaryReturnReceiptManager(
      context,
      callerConversationId,
      (manager) => {
        const aggregate = aggregateReservedConversationEntries(
          manager.getEntries(),
        );
        receipt = aggregate.temporaryReturnReceipts.find((candidate) =>
          candidate.temporaryConversationId === temporaryConversationId
          && candidate.initialRunId === initialRunId
        );
        if (receipt) return;
        const claimed = createTemporaryReturnReceiptEntry({
          temporaryConversationId,
          initialRunId,
          messageId: assignedEnvelope.messageId,
          callerRunId: assignment.callerRunId,
          claimedAt: assignment.assignedAt,
          state: "claimed",
        });
        appendReservedCustomEntry(manager, claimed);
        receipt = claimed.data;
      },
    );
    return receipt;
  }

  private async settleTemporaryReturnReceipt(
    context: ProjectContext,
    callerConversationId: string,
    temporaryConversationId: string,
    initialRunId: string,
    settlement: RunSettlement,
  ): Promise<void> {
    await this.withTemporaryReturnReceiptManager(
      context,
      callerConversationId,
      (manager) => {
        const receipt = aggregateReservedConversationEntries(
          manager.getEntries(),
        ).temporaryReturnReceipts.find((candidate) =>
          candidate.temporaryConversationId === temporaryConversationId
          && candidate.initialRunId === initialRunId
        );
        if (!receipt) {
          throw new Error("Missing temporary return receipt for settlement");
        }
        if (receipt.messageId !== settlement.returnMessageId) {
          throw new Error("Temporary return receipt conflicts with settlement");
        }
        if (receipt.state === "settled") {
          if (JSON.stringify(receipt.settlement) !== JSON.stringify(settlement)) {
            throw new Error("Conflicting settled temporary return receipt");
          }
          return;
        }
        appendReservedCustomEntry(
          manager,
          createTemporaryReturnReceiptEntry({
            ...receipt,
            state: "settled",
            settlement,
          }),
        );
      },
    );
  }

  private resolveDeferredTemporaryReturnWaiters(
    context: ProjectContext,
    callerConversationId: string,
    temporaryConversationId: string,
    initialRunId: string,
    settlement: RunSettlement,
  ): void {
    const key = completionKey(temporaryConversationId, initialRunId);
    const waiters = context.waiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (
        waiter.kind !== "session"
        || waiter.waitingConversationId !== callerConversationId
        || waiter.targetConversationId !== temporaryConversationId
        || waiter.targetRunId !== initialRunId
      ) {
        continue;
      }
      waiters.delete(waiter);
      this.detachWaiter(waiter);
      waiter.resolve(cloneSettlement(settlement));
    }
    if (waiters.size === 0) context.waiters.delete(key);
  }

  private async waitForSession(
    context: ProjectContext,
    sourceConversationId: string,
    targetConversationId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<RunSettlement | SessionMessageWaitResult> {
    if (sourceConversationId === targetConversationId) {
      throw new Error("An Agent cannot wait for its own current run");
    }
    this.throwIfAborted(signal);
    const source = this.requireActor(context, sourceConversationId);
    const ownership = source.currentRunOwnership();
    if (!ownership) {
      throw new Error("No running source turn owns this wait");
    }
    const preliminary = await this.runLifecycle(context, async () => {
      const committedReplyCandidate = await this.findCommittedWaitReply(
        context,
        sourceConversationId,
        targetConversationId,
        runId,
        ownership.runId,
      );
      const temporaryReceipt = this.temporaryReturnReceipt(
        context,
        sourceConversationId,
        targetConversationId,
        runId,
      );
      const committedReply = committedReplyCandidate
        && !(
          temporaryReceipt !== undefined
          && committedReplyCandidate.messageId === temporaryReceipt.messageId
          && committedReplyCandidate.waitedByRunId !== undefined
        )
        ? committedReplyCandidate
        : undefined;
      const cached = context.completions.get(
        completionKey(targetConversationId, runId),
      );
      return {
        committedReply,
        settledReceipt: temporaryReceipt?.state === "settled"
          ? cloneSettlement(temporaryReceipt.settlement)
          : undefined,
        cached: cached ? cloneSettlement(cached) : undefined,
        waitsForTemporaryReturn: this.waitsForTemporaryReturn(
          context,
          sourceConversationId,
          targetConversationId,
          runId,
          cached,
        ),
      };
    });
    this.throwIfAborted(signal);
    if (preliminary.committedReply || preliminary.waitsForTemporaryReturn) {
      return this.waitForSessionEvent(
        context,
        source,
        ownership,
        targetConversationId,
        runId,
        signal,
      );
    }
    if (preliminary.settledReceipt) return preliminary.settledReceipt;
    if (preliminary.cached) return preliminary.cached;
    const activeTarget = context.actors.get(targetConversationId);
    if (activeTarget) {
      const activeSettlement = this.findSettlement(
        context,
        activeTarget,
        runId,
      );
      if (
        activeSettlement
        && !this.waitsForTemporaryReturn(
          context,
          sourceConversationId,
          targetConversationId,
          runId,
          activeSettlement,
        )
      ) {
        return activeSettlement;
      }
    } else {
      const inspection = await context.project.inspectConversation(
        targetConversationId,
      );
      this.throwIfAborted(signal);
      const durable = inspection.runSettlements.find(
        (settlement) => settlement.runId === runId,
      );
      const inspectedLifecycle = inspection.conversationMeta?.lifecycle;
      const waitsForInspectedTemporaryReturn =
        inspectedLifecycle?.kind === "temporary"
        && inspectedLifecycle.initialRunId === runId
        && inspectedLifecycle.callerConversationId === sourceConversationId
        && durable?.reportedAt === undefined;
      if (durable && !waitsForInspectedTemporaryReturn) {
        return cloneSettlement(durable);
      }
    }
    const target = await raceWithAbort(
      this.getOrOpenActor(context, targetConversationId),
      signal,
    );
    this.throwIfAborted(signal);
    const existing = this.findSettlement(context, target, runId);
    if (
      existing
      && !this.waitsForTemporaryReturn(
        context,
        sourceConversationId,
        targetConversationId,
        runId,
        existing,
      )
    ) {
      return existing;
    }
    return this.waitForSessionEvent(
      context,
      source,
      ownership,
      targetConversationId,
      runId,
      signal,
      target,
    );
  }

  private waitForSessionEvent(
    context: ProjectContext,
    source: ConversationActor,
    ownership: ConversationRunOwnership,
    targetConversationId: string,
    runId: string,
    signal?: AbortSignal,
    target?: ConversationActor,
  ): Promise<RunSettlement | SessionMessageWaitResult> {
    const sourceConversationId = source.conversationId;
    return source.withWaiting(
      ownership,
      { conversationId: targetConversationId, runId },
      async () => {
        let resolveCompletion!: (
          result: RunSettlement | SessionMessageWaitResult,
        ) => void;
        let rejectCompletion!: (error: Error) => void;
        const completion = new Promise<
          RunSettlement | SessionMessageWaitResult
        >((resolve, reject) => {
          resolveCompletion = resolve;
          rejectCompletion = reject;
        });
        // The abort listener can reject while durable waiter registration is
        // still awaiting project lifecycle work. Observe that interval now;
        // callers still receive the same rejection from `completion` below.
        void completion.catch(() => undefined);
        const key = completionKey(targetConversationId, runId);
        let registeredWaiter: SessionWaiter | undefined;
        try {
          await this.runLifecycle(context, async () => {
            const waiter: SessionWaiter = {
              kind: "session",
              resolve: resolveCompletion,
              reject: rejectCompletion,
              waitingConversationId: sourceConversationId,
              targetConversationId,
              targetRunId: runId,
              ...(signal === undefined ? {} : { signal }),
            };
            registeredWaiter = waiter;
            const fatalTarget = context.actors.get(targetConversationId)
              ?.getState().fatalError;
            if (fatalTarget !== undefined) {
              throw new Error(
                `Target conversation is fatal: ${fatalTarget}`,
              );
            }
            if (signal) {
              waiter.abortListener = () => {
                const waiting = context.waiters.get(key);
                waiting?.delete(waiter);
                if (waiting?.size === 0) context.waiters.delete(key);
                this.detachWaiter(waiter);
                rejectCompletion(abortError("Session wait was aborted"));
              };
              signal.addEventListener("abort", waiter.abortListener, {
                once: true,
              });
              if (signal.aborted) {
                waiter.abortListener();
                return;
              }
            }
            if (this.hasWaitPath(
              context,
              targetConversationId,
              sourceConversationId,
            )) {
              throw new Error(
                `Waiting for ${targetConversationId} would create a conversation wait cycle`,
              );
            }
            let waiters = context.waiters.get(key);
            if (!waiters) {
              waiters = new Set();
              context.waiters.set(key, waiters);
            }
            waiters.add(waiter);

            const committedReply = await this.findCommittedWaitReply(
              context,
              sourceConversationId,
              targetConversationId,
              runId,
              ownership.runId,
            );
            if (committedReply) {
              await this.deliverEnvelopeToWaitingRun(
                context,
                source,
                committedReply,
                runId,
              );
              return;
            }

            const raced = target
              ? this.findSettlement(context, target, runId)
              : context.completions.get(key);
            if (
              raced
              && !this.waitsForTemporaryReturn(
                context,
                sourceConversationId,
                targetConversationId,
                runId,
                raced,
              )
            ) {
              waiters.delete(waiter);
              if (waiters.size === 0) context.waiters.delete(key);
              this.detachWaiter(waiter);
              resolveCompletion(cloneSettlement(raced));
            }
          });
        } catch (error) {
          if (registeredWaiter) {
            const waiters = context.waiters.get(key);
            waiters?.delete(registeredWaiter);
            if (waiters?.size === 0) context.waiters.delete(key);
            this.detachWaiter(registeredWaiter);
          }
          rejectCompletion(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        return completion;
      },
    );
  }

  private async findCommittedWaitReply(
    context: ProjectContext,
    sourceConversationId: string,
    targetConversationId: string,
    targetRunId: string,
    sourceRunId: string,
  ): Promise<InboxEnvelope | undefined> {
    const pending = await context.inbox.list({
      toConversationId: sourceConversationId,
    });
    return pending.find((envelope) =>
      envelope.fromConversationId === targetConversationId
      && envelope.fromRunId === targetRunId
      && envelope.waitedByRunId !== sourceRunId
    );
  }

  private waitsForTemporaryReturn(
    context: ProjectContext,
    sourceConversationId: string,
    targetConversationId: string,
    runId: string,
    settlement?: RunSettlement,
  ): boolean {
    const actor = context.actors.get(targetConversationId);
    const lifecycle = actor?.profile.lifecycle
      ?? context.profiles.get(targetConversationId)?.lifecycle;
    return lifecycle?.kind === "temporary"
      && lifecycle.initialRunId === runId
      && lifecycle.callerConversationId === sourceConversationId
      && settlement !== undefined
      && settlement.reportedAt === undefined
      && !(
        temporarySettlementIsReturnable(settlement)
        && this.temporaryReturnReceipt(
          context,
          sourceConversationId,
          targetConversationId,
          runId,
        )?.state === "settled"
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
      let waiters = context.waiters.get(key);
      if (!waiters) {
        waiters = new Set();
        context.waiters.set(key, waiters);
      }
      waiters.add(waiter);
      try {
        const raced = this.findSettlement(context, target, runId);
        if (!raced) return;
        waiters.delete(waiter);
        if (waiters.size === 0) context.waiters.delete(key);
        resolve(raced);
      } catch (error) {
        waiters.delete(waiter);
        if (waiters.size === 0) context.waiters.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleTemporaryCompletion(
    context: ProjectContext,
    actor: ConversationActor,
    settlement: RunSettlement,
  ): Promise<void> {
    const lifecycle = actor.profile.lifecycle;
    if (
      lifecycle.kind !== "temporary"
      || settlement.runId !== lifecycle.initialRunId
    ) {
      return;
    }
    if (settlement.reportedAt !== undefined) {
      if (temporarySettlementIsReturnable(settlement)) {
        const receipt = await this.durableTemporaryReturnReceipt(
          context,
          lifecycle.callerConversationId,
          actor.conversationId,
          settlement.runId,
        );
        if (receipt) {
          if (settlement.returnMessageId !== receipt.messageId) {
            throw new Error("Reported temporary settlement conflicts with receipt");
          }
          await this.settleTemporaryReturnReceipt(
            context,
            lifecycle.callerConversationId,
            actor.conversationId,
            settlement.runId,
            settlement,
          );
          this.resolveDeferredTemporaryReturnWaiters(
            context,
            lifecycle.callerConversationId,
            actor.conversationId,
            settlement.runId,
            settlement,
          );
        }
        await this.deleteConversationInternal(
          context,
          actor.conversationId,
          false,
        );
      } else {
        context.attention.add(actor.conversationId);
        this.emit(context, { type: "project_changed" });
      }
      return;
    }

    const successful = temporarySettlementIsReturnable(settlement);
    const receipt = successful
      ? await this.durableTemporaryReturnReceipt(
          context,
          lifecycle.callerConversationId,
          actor.conversationId,
          settlement.runId,
        )
      : undefined;
    if (receipt) {
      const reported = reportTemporarySettlementThroughReceipt(
        settlement,
        receipt,
        () => this.now().toISOString(),
      );
      await this.settleTemporaryReturnReceipt(
        context,
        lifecycle.callerConversationId,
        actor.conversationId,
        settlement.runId,
        reported,
      );
      this.resolveDeferredTemporaryReturnWaiters(
        context,
        lifecycle.callerConversationId,
        actor.conversationId,
        settlement.runId,
        reported,
      );
      appendReservedCustomEntry(
        actor.sessionManager,
        createRunSettlementEntry(reported),
      );
      context.completions.set(
        completionKey(actor.conversationId, reported.runId),
        cloneSettlement(reported),
      );
      await this.deleteConversationInternal(
        context,
        actor.conversationId,
        false,
      );
      return;
    }
    const oversized = settlement.outcome === "completed"
      && settlement.finalText !== null
      && settlement.finalText.trim().length > 0
      && !successful;
    const caller = await this.getOrOpenActor(
      context,
      lifecycle.callerConversationId,
    );
    const recoveredReturn = await context.inbox.get(
      lifecycle.returnMessageId,
    );
    const returned = await this.enqueueEnvelope(context, actor, caller, {
      messageId: lifecycle.returnMessageId,
      cardId: deterministicUuid(
        "piweb.return.card",
        lifecycle.returnMessageId,
      ),
      sentAt: recoveredReturn?.sentAt ?? this.now().toISOString(),
      kind: successful
        ? "delegation_result"
        : "delegation_failure",
      body: successful
        ? settlement.finalText!
        : oversized
          ? `临时会话已经完成，但最终回复超过 ${
              MAX_CONVERSATION_BODY_BYTES
            } 字节的自动回传上限；会话已保留，请打开查看。`
          : `临时会话未成功完成：${settlement.outcome}${
              settlement.finalText === null ? "，且没有 Agent 回复" : ""
            }`,
      delegationId: lifecycle.delegationId,
      fromRunId: recoveredReturn
        ? recoveredReturn.fromRunId
        : settlement.runId,
    });
    const reported = createRunSettlementEntry({
      ...settlement,
      reportedAt: this.now().toISOString(),
      returnMessageId: lifecycle.returnMessageId,
    }).data;
    appendReservedCustomEntry(
      actor.sessionManager,
      createRunSettlementEntry(reported),
    );
    context.completions.set(
      completionKey(actor.conversationId, reported.runId),
      cloneSettlement(reported),
    );
    const deliveredToWait = await this.deliverEnvelopeToWaitingRun(
      context,
      caller,
      returned.envelope,
      settlement.runId,
    );
    if (!deliveredToWait) await this.steerActiveTarget(context, caller);
    if (caller.getActivity().kind === "idle") {
      await this.pumpTarget(context, caller.conversationId);
    }
    if (successful) {
      await this.deleteConversationInternal(
        context,
        actor.conversationId,
        false,
      );
    } else {
      context.attention.add(actor.conversationId);
      this.emit(context, { type: "project_changed" });
    }
  }

  private async retryBlockedDeletions(
    context: ProjectContext,
  ): Promise<void> {
    await this.retryReturnableTemporaryDeletions(context);
    await this.retryDurableDeletions(context);
  }

  private async retryReturnableTemporaryDeletions(
    context: ProjectContext,
  ): Promise<void> {
    for (const actor of [...context.actors.values()]) {
      if (actor.getState().disposed) continue;
      const lifecycle = actor.profile.lifecycle;
      if (lifecycle.kind !== "temporary") continue;
      const settlement = aggregateReservedConversationEntries(
        actor.sessionManager.getEntries(),
      ).runSettlements.find(({ runId }) =>
        runId === lifecycle.initialRunId
      );
      if (
        !settlement
        || settlement.reportedAt === undefined
        || !temporarySettlementIsReturnable(settlement)
      ) {
        continue;
      }
      try {
        await this.deleteConversationInternal(
          context,
          actor.conversationId,
          false,
        );
      } catch {
        context.attention.add(actor.conversationId);
        this.emit(context, { type: "project_changed" });
      }
    }
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
          true,
          undefined,
          true,
        );
      } catch {
        context.attention.add(conversationId);
      }
    }
  }

  private async recoverTemporary(
    context: ProjectContext,
    actor: ConversationActor,
  ): Promise<void> {
    if (context.closing) return;
    const lifecycle = actor.profile.lifecycle;
    if (lifecycle.kind !== "temporary") return;
    const settlement = aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    ).runSettlements.find(({ runId }) => runId === lifecycle.initialRunId);
    if (!settlement) return;
    await this.runLifecycle(context, () =>
      this.handleTemporaryCompletion(context, actor, settlement)
    );
  }

  private loadOrMigrateProfile(
    manager: Awaited<ReturnType<ProjectStore["openConversation"]>>,
  ): ConversationMeta {
    const aggregate = aggregateReservedConversationEntries(
      manager.getEntries(),
    );
    if (aggregate.conversationMeta) {
      return cloneProfile(aggregate.conversationMeta);
    }

    const legacyModel = manager.buildSessionContext().model;
    const fallbackModel = this.roles.listRoles()
      .find((role) => role.model !== null)?.model ?? null;
    const model = legacyModel === null
      ? fallbackModel
      : {
          provider: legacyModel.provider,
          id: legacyModel.modelId,
        };
    if (model === null) {
      throw new Error(
        "The legacy conversation has no model and no role model is available",
      );
    }
    const profile: ConversationMeta = {
      role: {
        id: "default",
        revision: 1,
        name: "旧会话",
        description: "从旧版本迁移的会话",
        systemPrompt: "",
        model: { ...model },
        defaultThinkingLevel: "off",
        toolMode: "read_only",
        canManageSessions: false,
      },
      lifecycle: { kind: "normal" },
      createdBy: { kind: "user" },
    };
    appendReservedCustomEntry(
      manager,
      createConversationMetaEntry(profile),
    );
    return profile;
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
          defaultThinkingLevel: role.defaultThinkingLevel,
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

        const updated = await this.roles.updateRole(
          role.id,
          input.expectedRevision,
          role.systemPrompt,
          {
            name: role.name,
            description: role.description,
            systemPrompt: finalPrompt,
            model: role.model === null ? null : { ...role.model },
            defaultThinkingLevel: role.defaultThinkingLevel,
            toolMode: role.toolMode,
            canManageSessions: role.canManageSessions,
          },
          source.modelRegistry,
        );
        return {
          outcome: "applied" as const,
          roleId: updated.id,
          previousRevision: role.revision,
          revision: updated.revision,
          userEdited: finalPrompt !== input.newSystemPrompt,
        };
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
        input.message,
        input.idempotencyKey,
        signal,
      ),
      waitForSession: (
        sourceConversationId,
        input,
        signal,
      ) => {
        if (!input.runId) {
          throw new Error("wait_for_session requires an exact runId");
        }
        return this.waitForSession(
          context,
          sourceConversationId,
          input.conversationId,
          input.runId,
          signal,
        );
      },
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
                false,
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
      if (!profile) continue;
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
        if (inspection.conversationMeta) {
          context.profiles.set(
            conversationId,
            cloneProfile(inspection.conversationMeta),
          );
        }
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
      // Conversation exists on disk but has no conversationMeta — pre-feature
      // legacy file with no createdBy information. Treat as user root.
      if (!knownIds.has(conversationId)) {
        throw new Error(`Conversation ${conversationId} not found`);
      }
      return { rootConversationId: conversationId, depth: 0 };
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

    // Parent exists on disk but has no profile — treat as pre-feature user root.
    if (!parentProfile) {
      if (!knownIds.has(parentId)) {
        throw new Error(
          `Cannot resolve orchestration for ${conversationId}: ` +
          `parent ${parentId} not found and no explicit orchestration`,
        );
      }
      // Parent file exists with no conversationMeta — treat as user root.
      return { rootConversationId: parentId, depth: 1 };
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
    await this.hydrateConversationProfiles(context);
    const candidates = summaries.map((summary) => {
      const profile =
        context.actors.get(summary.id)?.profile
        ?? context.profiles.get(summary.id);
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
        temporary: summary.temporary ?? false,
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
    return {
      conversationId,
      title: conversationDisplayTitle(summary) ?? "未命名会话",
      role: summary.role,
      activity: summary.activity,
      lastActiveAt: summary.updatedAt,
      temporary: summary.temporary ?? false,
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
    message: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.runLifecycle(context, async () => {
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
      const sourceRun = source.currentRunOwnership();
      const temporaryReturnAssignment = recoveredEnvelope
        ?.temporaryReturnAssignment ?? (
          sourceRun
            ? this.createTemporaryReturnAssignment(
                context,
                source,
                target,
                sourceRun.runId,
              )
            : undefined
        );
      const queued = await this.enqueueEnvelope(context, source, target, {
        messageId,
        cardId,
        sentAt: recoveredEnvelope?.sentAt ?? this.now().toISOString(),
        kind: "message",
        body: message,
        fromRunId: recoveredEnvelope
          ? recoveredEnvelope.fromRunId
          : sourceRun?.runId,
        ...(temporaryReturnAssignment === undefined
          ? {}
          : { temporaryReturnAssignment }),
      });
      const envelope = queued.envelope;
      this.materializeTemporaryReturnReceipt(context, target, envelope);
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
        sourceRun
        && await this.deliverEnvelopeToWaitingRun(
          context,
          target,
          envelope,
          sourceRun.runId,
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
    sourceRunId: string,
  ): Promise<boolean> {
    const key = completionKey(envelope.fromConversationId, sourceRunId);
    const waiters = context.waiters.get(key);
    const waiter = [...(waiters ?? [])].find(
      (candidate): candidate is SessionWaiter =>
        candidate.kind === "session"
        && candidate.waitingConversationId === target.conversationId
        && candidate.targetConversationId === envelope.fromConversationId
        && candidate.targetRunId === sourceRunId,
    );
    if (!waiter || !waiters) return false;

    const initialActivity = target.getActivity();
    if (
      initialActivity.kind !== "waiting"
      || initialActivity.targetConversationId !== envelope.fromConversationId
      || initialActivity.targetRunId !== sourceRunId
    ) {
      return false;
    }
    let steered: boolean;
    try {
      steered = await this.steerActiveTarget(context, target, {
        throughMessageId: envelope.messageId,
        beforeThroughDelivery: async (claimed) => {
          if (
            claimed.state !== "processing"
            || claimed.processingRunId !== initialActivity.runId
          ) {
            throw new Error(
              "The exact wait reply lost its durable processing claim",
            );
          }
          await context.inbox.updateState(claimed.messageId, {
            state: "processing",
            processingRunId: initialActivity.runId,
            ...(claimed.processingDelivery === undefined
              ? {}
              : { processingDelivery: claimed.processingDelivery }),
            waitedByRunId: initialActivity.runId,
          });
        },
      });
    } catch (error) {
      if (waiters.has(waiter)) {
        waiters.delete(waiter);
        if (waiters.size === 0) context.waiters.delete(key);
        this.detachWaiter(waiter);
        waiter.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      throw error;
    }
    if (!steered || !waiters.has(waiter)) return false;

    waiters.delete(waiter);
    if (waiters.size === 0) context.waiters.delete(key);
    this.detachWaiter(waiter);
    try {
      this.appendSourceCardState(context, envelope, "delivered");
      const result: SessionMessageWaitResult = {
        outcome: "message",
        conversationId: envelope.fromConversationId,
        runId: sourceRunId,
        messageId: envelope.messageId,
        sentAt: envelope.sentAt,
      };
      waiter.resolve(result);
      this.emit(context, { type: "project_changed" });
      return true;
    } catch (error) {
      waiter.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private createTemporaryReturnAssignment(
    context: ProjectContext,
    source: ConversationActor,
    caller: ConversationActor,
    sourceRunId: string,
  ): NonNullable<InboxEnvelope["temporaryReturnAssignment"]> | undefined {
    const lifecycle = source.profile.lifecycle;
    const activity = caller.getActivity();
    if (
      lifecycle.kind !== "temporary"
      || lifecycle.initialRunId !== sourceRunId
      || lifecycle.callerConversationId !== caller.conversationId
      || activity.kind !== "waiting"
      || activity.targetConversationId !== source.conversationId
      || activity.targetRunId !== sourceRunId
    ) {
      return undefined;
    }
    const waiters = context.waiters.get(
      completionKey(source.conversationId, sourceRunId),
    );
    const exactWaiter = [...(waiters ?? [])].some((waiter) =>
      waiter.kind === "session"
      && waiter.waitingConversationId === caller.conversationId
      && waiter.targetConversationId === source.conversationId
      && waiter.targetRunId === sourceRunId
    );
    return exactWaiter
      ? {
          initialRunId: sourceRunId,
          callerRunId: activity.runId,
          assignedAt: this.now().toISOString(),
        }
      : undefined;
  }

  private materializeTemporaryReturnReceipt(
    context: ProjectContext,
    caller: ConversationActor,
    envelope: InboxEnvelope,
  ): void {
    const assignment = envelope.temporaryReturnAssignment;
    if (!assignment) return;
    const source = context.actors.get(envelope.fromConversationId);
    const lifecycle = source?.profile.lifecycle;
    if (
      !source
      || lifecycle?.kind !== "temporary"
      || lifecycle.initialRunId !== assignment.initialRunId
      || lifecycle.callerConversationId !== caller.conversationId
      || envelope.kind !== "message"
      || envelope.fromRunId !== assignment.initialRunId
    ) {
      throw new Error("Temporary return assignment conflicts with lifecycle");
    }
    const existing = this.temporaryReturnReceipt(
      context,
      caller.conversationId,
      source.conversationId,
      assignment.initialRunId,
    );
    if (existing) return;
    appendReservedCustomEntry(
      caller.sessionManager,
      createTemporaryReturnReceiptEntry({
        temporaryConversationId: source.conversationId,
        initialRunId: assignment.initialRunId,
        messageId: envelope.messageId,
        callerRunId: assignment.callerRunId,
        claimedAt: assignment.assignedAt,
        state: "claimed",
      }),
    );
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
    const activity = target.getActivity();
    if (activity.kind === "idle" || activity.kind === "cancelling") {
      return false;
    }

    const runId = activity.runId;
    const key = completionKey(target.conversationId, runId);
    const pending = await context.inbox.list({
      toConversationId: target.conversationId,
    });
    const delivered = new Set(
      aggregateReservedConversationEntries(
        target.sessionManager.getEntries(),
      ).deliveredMessageIds,
    );
    let claimed = pending.filter((envelope) => (
      envelope.state === "processing"
      && envelope.processingRunId === runId
      && !delivered.has(envelope.messageId)
    )).length;

    for (const envelope of pending) {
      if (delivered.has(envelope.messageId)) {
        if (envelope.messageId === options.throughMessageId) {
          await options.beforeThroughDelivery?.(envelope);
          return true;
        }
        continue;
      }
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
        } else {
          await delivery;
        }
        claimed++;
        if (envelope.messageId === options.throughMessageId) return true;
      } catch (error) {
        // A run can end between claiming the sidecar and the SDK accepting its
        // steering queue. Do not treat in-memory delivery as durable; leave it
        // available for the next run unless Pi already wrote its marker.
        const markers = new Set(
          aggregateReservedConversationEntries(
            target.sessionManager.getEntries(),
          ).deliveredMessageIds,
        );
        if (markers.has(envelope.messageId)) {
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
        if (envelope.messageId === options.throughMessageId) throw error;
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
      | "body"
      | "delegationId"
      | "fromRunId"
      | "temporaryReturnAssignment"
    > & {
      processingRunId?: string;
      requestFingerprint?: string;
      requestedRole?: ConversationMeta["role"];
      orchestration?: ConversationOrchestration;
    },
  ): Promise<{
    status: "created" | "existing";
    envelope: InboxEnvelope;
  }> {
    const fromSnapshot = this.endpoint(context, source);
    const toSnapshot = this.endpoint(context, target);
    const existingCard = aggregateReservedConversationEntries(
      source.sessionManager.getEntries(),
    ).cards.find(({ cardId }) => cardId === input.cardId);
    const baseCard: ConversationCard = existingCard ?? {
        cardId: input.cardId,
        kind: input.kind,
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
      body: input.body,
      ...(input.delegationId === undefined
        ? {}
        : { delegationId: input.delegationId }),
      ...(input.requestFingerprint === undefined
        ? {}
        : { requestFingerprint: input.requestFingerprint }),
      ...(input.fromRunId === undefined
        ? {}
        : { fromRunId: input.fromRunId }),
      ...(input.temporaryReturnAssignment === undefined
        ? {}
        : {
            temporaryReturnAssignment: {
              ...input.temporaryReturnAssignment,
            },
          }),
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
    const temporaryInitialDelegation =
      target.profile.lifecycle.kind === "temporary"
      && envelope.kind === "delegation_task"
      && envelope.delegationId === target.profile.lifecycle.delegationId;
    const replyGuidance = temporaryInitialDelegation
      ? [
          "",
          `临时初始任务提示：完成任务时请直接将最终答复作为 assistant final；宿主会自动回传给调用者。仅在需要提前唤醒调用者时，才调用 send_session_message 并使用 conversationId ${envelope.fromConversationId}；若该消息成功 resolve 调用者对 initial run 的精确 wait，它会替代自动成功回传。`,
        ]
      : [
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
    if (
      existing?.state === state
      && existing.runId === runId
      && existing.result === result
    ) {
      return;
    }
    this.appendCard(source, {
      ...(existing ?? {
        cardId: envelope.cardId,
        kind: envelope.kind,
        body: envelope.body,
        fromSnapshot: envelope.fromSnapshot,
        toSnapshot: envelope.toSnapshot,
        messageId: envelope.messageId,
        ...(envelope.delegationId === undefined
          ? {}
          : { delegationId: envelope.delegationId }),
      }),
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
      if (
        existing?.state === state
        && existing.runId === runId
        && existing.result === result
      ) {
        return;
      }
      appendReservedCustomEntry(
        manager,
        createConversationCardEntry({
          ...(existing ?? {
            cardId: envelope.cardId,
            kind: envelope.kind,
            body: envelope.body,
            fromSnapshot: envelope.fromSnapshot,
            toSnapshot: envelope.toSnapshot,
            messageId: envelope.messageId,
            ...(envelope.delegationId === undefined
              ? {}
              : { delegationId: envelope.delegationId }),
          }),
          state,
          ...(runId === undefined ? {} : { runId }),
          ...(result === undefined ? {} : { result }),
          updatedAt: this.now().toISOString(),
        }),
      );
    };

    const activeSource = context.actors.get(envelope.fromConversationId);
    if (activeSource) {
      append(activeSource.sessionManager);
      return;
    }
    const sourceExists = (await context.project.refreshConversations())
      .some(({ id }) => id === envelope.fromConversationId);
    if (!sourceExists) return;

    const lease = await this.projects.acquireConversationWhenAvailable(
      context.project.cwd,
      envelope.fromConversationId,
    );
    try {
      const manager = await context.project.openConversation(
        envelope.fromConversationId,
        { updateRecent: false },
      );
      append(manager);
    } finally {
      lease.release();
    }
  }

  private async dispatchBatch(
    context: ProjectContext,
    target: ConversationActor,
    envelopes: InboxEnvelope[],
    runId: string,
    deliveredMessageIds: ReadonlySet<string> = new Set(),
  ): Promise<"started" | "not_started"> {
    if (target.getActivity().kind !== "idle") {
      throw new Error(`Conversation is already running: ${target.conversationId}`);
    }
    const recoveredBatch = envelopes.some((envelope) => (
      envelope.state === "processing"
      && envelope.processingRunId === runId
    ));
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
      const undelivered = processing.filter(
        ({ messageId }) => !deliveredMessageIds.has(messageId),
      );
      completion = undelivered.length === 0
        ? target.resumeMessages({ runId })
        : target.startMessages({
            runId,
            recovered: recoveredBatch,
            messages: undelivered.map((envelope) => {
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
        this.appendSourceCardState(
          context,
          envelope,
          "running",
          runId,
        );
      }
    } catch (error) {
      context.processingBatches.delete(
        completionKey(target.conversationId, runId),
      );
      for (const envelope of envelopes) {
        await context.inbox.updateState(
          envelope.messageId,
          envelope.state === "processing"
            ? {
                state: "processing",
                processingRunId: envelope.processingRunId!,
                ...(envelope.processingDelivery === undefined
                  ? {}
                  : { processingDelivery: envelope.processingDelivery }),
                ...(envelope.waitedByRunId === undefined
                  ? {}
                  : { waitedByRunId: envelope.waitedByRunId }),
              }
            : { state: "queued" },
        );
      }
      const retryKey = dispatchRetryKey(
        target.conversationId,
        envelopes,
      );
      context.attention.add(target.conversationId);
      this.emit(context, {
        type: "error",
        conversationId: target.conversationId,
        runId,
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
      if (
        !context.closing
        && !context.failedDispatchRetries.has(retryKey)
      ) {
        context.failedDispatchRetries.add(retryKey);
        this.trackBackground(
          context,
          this.runLifecycle(context, async () => {
            await this.pumpTarget(context, target.conversationId);
          }),
        );
      }
      return "not_started";
    }
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
    settlement: RunSettlement,
  ): Promise<void> {
    const key = completionKey(targetConversationId, runId);
    const initialEnvelopes = context.processingBatches.get(key) ?? [];
    const target = context.actors.get(targetConversationId);
    const deliveredMessageIds = new Set(
      target
        ? aggregateReservedConversationEntries(
            target.sessionManager.getEntries(),
          ).deliveredMessageIds
        : [],
    );
    const finishRemaining = async (retrying: boolean): Promise<void> => {
      const remaining = [...(context.processingBatches.get(key) ?? [])];
      while (remaining.length > 0) {
        const envelope = remaining[0]!;
        try {
          const delivered = deliveredMessageIds.has(envelope.messageId);
          if (!delivered && envelope.processingDelivery === "steer") {
            // The SDK queue is transient. If abort/settlement won before Pi
            // persisted the custom message marker, return this claimed steering
            // envelope to FIFO delivery instead of claiming receipt.
            await context.inbox.updateState(envelope.messageId, {
              state: "queued",
            });
          } else if (delivered || envelope.state !== "queued") {
            const state = settlement.outcome === "completed"
              ? "completed"
              : settlement.outcome;
            await this.appendTerminalSourceCardState(
              context,
              envelope,
              state,
              runId,
              settlement.finalText ?? undefined,
            );
            await context.inbox.delete(envelope.messageId);
          }
        } catch (error) {
          // Keep the failed envelope and every later envelope recoverable in
          // this process. A terminal card append may already have committed;
          // its aggregation makes the one bounded retry safe before deletion.
          context.processingBatches.set(key, remaining);
          if (!retrying) {
            await finishRemaining(true);
            return;
          }
          throw error;
        }
        remaining.shift();
        if (remaining.length === 0) {
          context.processingBatches.delete(key);
        } else {
          context.processingBatches.set(key, remaining);
        }
      }
      context.failedBatchRetries.delete(key);
      if (initialEnvelopes.length > 0) {
        context.failedDispatchRetries.delete(
          dispatchRetryKey(targetConversationId, initialEnvelopes),
        );
      }
      this.emit(context, { type: "project_changed" });
    };
    await finishRemaining(false);
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
      await this.handleTemporaryCompletion(
        context,
        actor,
        completion.settlement,
      );
      if (context.actors.get(actor.conversationId) === actor) {
        await this.pumpTarget(context, actor.conversationId);
      }
      await this.retryBlockedDeletions(context);
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


  private async recoverProject(context: ProjectContext): Promise<void> {
    if (context.closing) return;
    const legacyPromptQueue = await this.readLegacyPendingPromptQueue(context);
    let summaries = await context.project.refreshConversations();
    const existingIds = new Set(summaries.map(({ id }) => id));
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
    for (const item of legacyPromptQueue) {
      if (context.closing) return;
      actorIds.add(item.conversationId);
    }
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
        const profile = inspection.conversationMeta;
        if (!profile) continue;
        context.profiles.set(summary.id, cloneProfile(profile));
        const lifecycle = profile.lifecycle;
        if (
          lifecycle.kind === "temporary"
          && inspection.runSettlements.some(
            ({ runId }) => runId === lifecycle.initialRunId,
          )
        ) {
          actorIds.add(summary.id);
        }
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
        const source = await this.getOrOpenActor(
          context,
          envelope.fromConversationId,
        );
        const card = aggregateReservedConversationEntries(
          source.sessionManager.getEntries(),
        ).cards.find(({ cardId }) => cardId === envelope.cardId);
        if (!card || card.state === "sending") {
          this.appendCard(source, {
            ...(card ?? {
              cardId: envelope.cardId,
              kind: envelope.kind,
              body: envelope.body,
              fromSnapshot: envelope.fromSnapshot,
              toSnapshot: envelope.toSnapshot,
            }),
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
          });
        }
      } catch {
        // A deleted source must not prevent the durable target delivery.
      }
    }

    for (const actorId of actorIds) {
      if (context.closing) return;
      try {
        await this.getOrOpenActor(context, actorId);
      } catch {
        context.attention.add(actorId);
      }
    }
    if (legacyPromptQueue.length > 0) {
      await this.redeliverLegacyPromptQueue(context, legacyPromptQueue);
    }
    this.emit(context, { type: "project_changed" });
  }


  /**
   * 一次性迁移：读取旧版 .piweb/pending-prompts 队列文件中仍处于 queued 的
   * 消息，按 createdAt FIFO 排序后返回；会话 id 收集到 actorIds 以便打开 actor。
   * dispatching/attention/损坏/超限记录直接丢弃（A' 不保留重启恢复语义）。
   */
  private async readLegacyPendingPromptQueue(
    context: ProjectContext,
  ): Promise<Array<{
    promptId: string;
    conversationId: string;
    text: string;
  }>> {
    const directory = join(context.project.stateDir, "pending-prompts");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const queued: Array<{
      promptId: string;
      conversationId: string;
      text: string;
      createdAt: string;
    }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const path = join(directory, name);
        const fileStats = await stat(path);
        if (!fileStats.isFile() || fileStats.size > 1024 * 1024) continue;
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isLegacyQueuedPrompt(parsed)) continue;
        queued.push(parsed);
      } catch {
        // 损坏或无法解析的旧记录直接丢弃。
      }
    }
    queued.sort((first, second) => {
      const byCreatedAt =
        Date.parse(first.createdAt) - Date.parse(second.createdAt);
      if (byCreatedAt !== 0) return byCreatedAt;
      return first.promptId.localeCompare(second.promptId);
    });
    return queued;
  }

  /**
   * 尽力而为投递迁移队列：actor 已打开的会话直接 admit（busy 进 steer
   * 队列、idle 起新 run）；投递失败或会话不可用则丢弃该条。全部尝试后
   * 删除旧队列目录；中途关闭则保留目录待下次重试（admit 按 promptId 幂等）。
   */
  private async redeliverLegacyPromptQueue(
    context: ProjectContext,
    queue: Array<{
      promptId: string;
      conversationId: string;
      text: string;
    }>,
  ): Promise<void> {
    for (const item of queue) {
      if (context.closing) return;
      const actor = context.actors.get(item.conversationId);
      if (!actor) continue;
      try {
        await actor.admitBrowserPrompt({
          promptId: item.promptId,
          runId: randomUUID(),
          text: item.text,
        });
      } catch (error) {
        // 一次性迁移：无法投递的旧记录丢弃，不进入 A' 的新投递路径。
        console.warn(
          `[prompt-streamlining] dropped legacy pending prompt ${item.promptId}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (context.closing) return;
    await rm(join(context.project.stateDir, "pending-prompts"), {
      recursive: true,
      force: true,
    });
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
        const target = context.actors.get(
          operation.targetConversationId,
        );
        if (target) {
          await this.handleTemporaryCompletion(
            context,
            target,
            recoveredSettlement,
          );
        }
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
    if (!actor || actor.getActivity().kind !== "idle") return "no_work";
    const pending = await context.inbox.list({
      toConversationId: conversationId,
    });
    if (context.closing) return "no_work";
    if (context.deleting.has(conversationId)) return "blocked_by_deletion";
    if (pending.length === 0) {
      return "no_work";
    }

    const aggregate = aggregateReservedConversationEntries(
      actor.sessionManager.getEntries(),
    );
    const delivered = new Set(aggregate.deliveredMessageIds);
    const first = pending[0]!;
    let runId: string;
    if (first.state === "processing") {
      runId = first.processingRunId!;
    } else if (
      actor.profile.lifecycle.kind === "temporary"
      && first.kind === "delegation_task"
      && first.delegationId === actor.profile.lifecycle.delegationId
    ) {
      runId = actor.profile.lifecycle.initialRunId;
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
      context.processingBatches.set(
        completionKey(conversationId, runId),
        batch,
      );
      await this.finishBatch(
        context,
        conversationId,
        runId,
        settled,
      );
      await this.pumpTarget(context, conversationId);
      return "settled";
    }
    const dispatch = await this.dispatchBatch(
      context,
      actor,
      batch,
      runId,
      delivered,
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
      if (profile) {
        this.resolveOrchestration(context, candidateId, profile);
      }
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
    if (!profile || profile.createdBy.kind !== "conversation") {
      return false;
    }

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
    if (!profile) return 1;
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
    allowTemporaryActor = false,
    deletionReserved = false,
    protectedConversationId?: string,
    reservedByDurableTombstone = false,
  ): Promise<boolean> {
    const ownedReservationIds = new Set<string>();
    const durableFenceIds = new Set<string>();
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
      for (const cascadeId of cascadeIds) {
        if (cascadeId === conversationId) continue;
        if (!this.reserveDeletion(context, cascadeId)) {
          if (preexistingDurableFenceIds.has(cascadeId)) continue;
          throw new Error(`Conversation is being deleted: ${cascadeId}`);
        }
        ownedReservationIds.add(cascadeId);
      }
      const busyConversationId = cascadeIds.find((cascadeId) => {
        const actor = context.actors.get(cascadeId);
        return actor !== undefined
          && (actor.getActivity().kind !== "idle" || actor.isCompacting())
          && !(cascadeId === conversationId && allowTemporaryActor);
      });
      if (busyConversationId !== undefined) {
        throw new Error(
          "Cannot delete a busy conversation or one that is compacting; wait first",
        );
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
          cascadeId === conversationId && allowTemporaryActor,
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
    }
  }

  private async deleteSingleConversationInternal(
    context: ProjectContext,
    conversationId: string,
    allowTemporaryActor: boolean,
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
      && !allowTemporaryActor
    ) {
      throw new Error(
        "Cannot delete a busy conversation or one that is compacting; wait first",
      );
    }
    let deletionLease;
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
        context.actors.delete(conversationId);
      } else {
        const writer = this.projects.acquireConversation(
          context.project.cwd,
          conversationId,
        );
        deletionLease = writer.upgradeToDeletion();
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
    if (context.deleting.has(conversationId)) return false;
    context.deleting.add(conversationId);
    return true;
  }

  private hasWaitPath(
    context: ProjectContext,
    fromConversationId: string,
    toConversationId: string,
  ): boolean {
    const pending = [fromConversationId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === toConversationId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const waiters of context.waiters.values()) {
        for (const waiter of waiters) {
          if (
            waiter.kind === "session"
            && waiter.waitingConversationId === current
          ) {
            pending.push(waiter.targetConversationId);
          }
        }
      }
    }
    return false;
  }

  private detachWaiter(waiter: ProjectWaiter): void {
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
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
