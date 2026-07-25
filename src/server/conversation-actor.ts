import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  type ConversationActivity,
  type ConversationHistoryItem,
  type ConversationHistoryMessage,
  type ConversationHistoryMessagePart,
  type ConversationHistoryTool,
  type ConversationRoleSnapshot,
  type SessionEvent,
  type TokenUsage,
  type ToolMode,
} from "../shared/protocol.js";
import type { AgentTurnBoundaryCheck } from "./agent-turn-boundary.js";
import {
  projectConversationItemSlots,
  snapshotConversationItems,
} from "./conversation-history.js";
import {
  aggregateReservedConversationEntries,
  appendReservedCustomEntry,
  createCompactionThresholdEntry,
  createCompactionResumeEntry,
  createConversationMetaEntry,
  createConversationMessageEntry,
  createConversationRoleChangeEntry,
  createRunSettlementEntry,
  RUN_SETTLEMENT_CUSTOM_TYPE,
  type ConversationMeta,
  type ConversationMessageEntry,
  type RunSettlement,
} from "./conversation-meta.js";
import {
  type CreatedPiSession,
  type CreatePiSessionOptions,
  type PiRuntimeLike,
  type ToolCallGateInput,
} from "./pi-runtime.js";
import {
  type ConversationDeletionLease,
  type ConversationLease,
  type ProjectStore,
} from "./project-store.js";
import {
  ProjectRunCoordinator,
  type ProjectRunLease,
} from "./project-run-coordinator.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { SessionEventProjector, snapshotWireValue } from "./session-events.js";
import {
  defaultToolPolicy,
  type ToolPolicy,
  type ToolPolicyDecision,
} from "./tool-policy.js";

export type ConversationRunOrigin =
  | "browser"
  | "inbox"
  | "conversation"
  | "pending_prompt";

export interface ConversationActorState {
  conversationId: string;
  profile: ConversationMeta;
  activity: ConversationActivity;
  compacting: boolean;
  fatalError?: string;
  disposed: boolean;
}

export type ConversationActorEvent =
  | {
      type: "session_event";
      conversationId: string;
      runId: string;
      projectionSeq: number;
      event: SessionEvent;
    }
  | {
      type: "activity";
      conversationId: string;
      activity: ConversationActivity;
    }
  | {
      type: "compaction";
      conversationId: string;
      compacting: boolean;
    }
  | {
      type: "context_usage";
      conversationId: string;
    }
  | {
      type: "completion";
      conversationId: string;
      origin: ConversationRunOrigin;
      settlement: RunSettlement;
      pendingPromptUserDelivered: boolean;
    }
  | {
      type: "error";
      conversationId: string;
      runId?: string;
      message: string;
      fatal?: boolean;
    };

export type ConversationActorListener = (
  event: ConversationActorEvent,
) => void;

export interface ConversationActorCompletion {
  settlement: RunSettlement;
  origin: ConversationRunOrigin;
  /** True only after Pi emitted the durable user message for a pending prompt. */
  pendingPromptUserDelivered: boolean;
}

export interface ConversationActorOpenOptions {
  conversationId: string;
  profile: ConversationMeta;
  project: Pick<
    ProjectStore,
    "cwd" | "toolMode" | "refreshConversations" | "truncateConversation"
  >;
  sessionManager: SessionManager;
  conversationLease: ConversationLease;
  runtime: PiRuntimeLike;
  projectRuns?: ProjectRunCoordinator;
  toolPolicy?: ToolPolicy;
  createSessionOptions?: Omit<
    CreatePiSessionOptions,
    "sessionManager" | "toolCallGate" | "extensionAbort"
  >;
  persistSettlement?: (
    settlement: RunSettlement,
    sessionManager: SessionManager,
  ) => Promise<void> | void;
  onCompletion?: (
    completion: ConversationActorCompletion,
  ) => Promise<void> | void;
  onExtensionError?: (error: ExtensionError) => void;
  cancelRunScope?: (runId: string) => void;
  now?: () => Date;
}

export interface StartConversationPrompt {
  runId: string;
  text: string;
  origin: ConversationRunOrigin;
}

export interface StartConversationMessages {
  runId: string;
  messages: Array<Omit<ConversationMessageEntry, "customType">>;
  recovered: boolean;
}

export interface ResumeConversationMessages {
  runId: string;
}

export interface ConversationWaitingTarget {
  conversationId: string;
  runId: string;
}

const RUN_OWNERSHIP = Symbol("ConversationActor.runOwnership");
// Avoid retrying every tool boundary without disabling protection for a long run.
const COMPACTION_RETRY_GROWTH_PERCENT = 5;

/**
 * An opaque capability for the currently executing run. A stale capability can
 * observe completion, but it cannot mutate a later run or revive a settled one.
 */
export interface ConversationRunOwnership {
  readonly conversationId: string;
  readonly runId: string;
  readonly origin: ConversationRunOrigin;
  readonly recovered: boolean;
  readonly [RUN_OWNERSHIP]: symbol;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingCustomSteer {
  readonly message: ConversationMessageEntry;
  readonly delivery: Deferred<void>;
}

interface PendingGuidance {
  readonly delivery: Deferred<void>;
}

interface RunTicket {
  readonly id: string;
  readonly origin: ConversationRunOrigin;
  readonly ownership: ConversationRunOwnership;
  readonly projector: SessionEventProjector;
  readonly completion: Deferred<RunSettlement>;
  readonly guidanceDeliveries: PendingGuidance[];
  readonly customSteerDeliveries: PendingCustomSteer[];
  /** The first raw user message belongs to startPrompt(), never guidance. */
  expectsInitialPromptRawUserMessage: boolean;
  pendingPromptUserDelivered: boolean;
  customSteerFlush?: Promise<void>;
  phase: "queued" | "running" | "waiting" | "cancelling";
  waitingFor?: ConversationWaitingTarget;
  waitingEpoch?: symbol;
  toolMode: ToolMode;
  extensionErrorMessage?: string;
  sawSdkCompactionAttempt: boolean;
  compactionErrorReported: boolean;
  compactionRetryAtPercent?: number;
  sdkCompactionSucceeded: boolean;
  turnBoundaryCompactionRequested: boolean;
  abortPromise?: Promise<void>;
  projectRunLease?: ProjectRunLease;
  finishPromise?: Promise<RunSettlement>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cloneActivity(activity: ConversationActivity): ConversationActivity {
  switch (activity.kind) {
    case "idle":
      return { kind: "idle" };
    case "queued":
    case "running":
    case "cancelling":
      return { kind: activity.kind, runId: activity.runId };
    case "waiting":
      return {
        kind: "waiting",
        runId: activity.runId,
        targetConversationId: activity.targetConversationId,
        targetRunId: activity.targetRunId,
      };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type SteerDeliveryClassification =
  | "rejected_before_sdk_acceptance"
  | "uncertain_after_sdk_acceptance";

/**
 * A steering command is only known durable after Pi appends the corresponding
 * raw user message. Callers with a durable dispatch sidecar must not retry an
 * SDK-accepted steer whose later delivery proof failed.
 */
export class ConversationSteerDeliveryError extends Error {
  constructor(
    readonly classification: SteerDeliveryClassification,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = "ConversationSteerDeliveryError";
  }
}

export function isConversationSteerDeliveryError(
  error: unknown,
): error is ConversationSteerDeliveryError {
  return error instanceof ConversationSteerDeliveryError;
}

function rawUserMessageIsPersisted(
  entries: readonly unknown[],
  message: unknown,
): boolean {
  return entries.some((entry) => (
    typeof entry === "object"
    && entry !== null
    && "type" in entry
    && entry.type === "message"
    && "message" in entry
    && entry.message === message
  ));
}

function isCancelling(ticket: RunTicket): boolean {
  return ticket.phase === "cancelling";
}

interface LiveConversationProjection {
  runId: string;
  baseItemIdentities: Set<string>;
  baseAssistantEntryCounts: Map<string, number>;
  currentAssistantId?: string;
  items: ConversationHistoryItem[];
}

function runMessageId(runId: string, role: "user" | "assistant"): string {
  return role === "user" ? `run-${runId}-user` : `assistant:run-${runId}-assistant`;
}

function appendHistoryPart(
  parts: ConversationHistoryMessagePart[] | undefined,
  part: ConversationHistoryMessagePart,
): ConversationHistoryMessagePart[] {
  if (part.kind !== "tool" && part.length <= 0) return parts ?? [];
  const current = parts ?? [];
  const last = current[current.length - 1];
  if (
    part.kind !== "tool"
    && last?.kind === part.kind
    && last.offset + last.length === part.offset
  ) {
    return [
      ...current.slice(0, -1),
      { kind: part.kind, offset: last.offset, length: last.length + part.length },
    ];
  }
  return [...current, part];
}

function addUsage(
  current: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + next.cacheWrite,
    total: (current?.total ?? 0) + next.total,
  };
}

function messageIdentity(message: ConversationHistoryMessage): string {
  return message.runId
    ? `${message.role}:${message.runId}:${message.id}`
    : `${message.role}:${message.id}`;
}

function conversationItemIdentity(item: ConversationHistoryItem): string {
  if (item.kind === "message") return `message:${messageIdentity(item)}`;
  if (item.kind === "session_message") return `card:${item.cardId}`;
  return `${item.kind}:${item.id}`;
}

/**
 * Owns exactly one persistent Pi conversation independently of any WebSocket.
 *
 * The actor is the sole writer for its SessionManager. Browser attachments are
 * observers; detaching one never cancels the run or releases the writer lease.
 */
export class ConversationActor {
  readonly conversationId: string;
  readonly sessionManager: SessionManager;

  private readonly project: ConversationActorOpenOptions["project"];
  private readonly conversationLease: ConversationLease;
  private readonly runtime: PiRuntimeLike;
  private readonly projectRuns: ProjectRunCoordinator;
  private readonly toolPolicy: ToolPolicy;
  private createSessionOptions:
    ConversationActorOpenOptions["createSessionOptions"];
  private readonly persistSettlementCallback:
    NonNullable<ConversationActorOpenOptions["persistSettlement"]>;
  private readonly onCompletion?: ConversationActorOpenOptions["onCompletion"];
  private readonly onExtensionError?: ConversationActorOpenOptions["onExtensionError"];
  private readonly cancelRunScope?: ConversationActorOpenOptions["cancelRunScope"];
  private readonly now: () => Date;
  private readonly operations = new SerialTaskQueue();
  private readonly listeners = new Set<ConversationActorListener>();
  private readonly usedRunIds = new Set<string>();
  private profileSnapshot: ConversationMeta;
  private compactionThresholdPercent: number;
  private projectionSeq = 0;
  private liveProjection?: LiveConversationProjection;

  private created?: CreatedPiSession;
  private unsubscribeSession?: () => void;
  private activeRun?: RunTicket;
  private opening = true;
  private compacting = false;
  private hostCompactionInProgress = false;
  private truncating = false;
  private switchingRole = false;
  private disposing = false;
  private disposed = false;
  private fatalError?: Error;
  private manualCompaction?: Promise<void>;
  private disposePromise?: Promise<ConversationDeletionLease | undefined>;

  private constructor(options: ConversationActorOpenOptions) {
    this.conversationId = options.conversationId;
    this.sessionManager = options.sessionManager;
    this.project = options.project;
    this.conversationLease = options.conversationLease;
    this.runtime = options.runtime;
    this.projectRuns = options.projectRuns ?? new ProjectRunCoordinator();
    this.toolPolicy = options.toolPolicy ?? defaultToolPolicy;
    this.createSessionOptions = options.createSessionOptions;
    this.onCompletion = options.onCompletion;
    this.onExtensionError = options.onExtensionError;
    this.cancelRunScope = options.cancelRunScope;
    this.now = options.now ?? (() => new Date());
    this.profileSnapshot = createConversationMetaEntry(options.profile).data;
    const reserved = aggregateReservedConversationEntries(
      this.sessionManager.getEntries(),
    );
    this.compactionThresholdPercent =
      reserved.compactionThreshold?.percent
      ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT;
    for (const settlement of reserved.runSettlements) {
      this.usedRunIds.add(settlement.runId);
    }
    this.persistSettlementCallback = options.persistSettlement
      ?? ((settlement, sessionManager) => {
        sessionManager.appendCustomEntry(
          RUN_SETTLEMENT_CUSTOM_TYPE,
          settlement,
        );
      });
  }

  static async open(
    options: ConversationActorOpenOptions,
  ): Promise<ConversationActor> {
    if (options.sessionManager.getSessionId() !== options.conversationId) {
      options.conversationLease.release();
      throw new Error(
        `Conversation identity mismatch: expected ${options.conversationId}, got ${options.sessionManager.getSessionId()}`,
      );
    }

    let actor: ConversationActor | undefined;
    try {
      const openingActor = new ConversationActor(options);
      actor = openingActor;
      const pendingErrors = await openingActor.startRuntimeSession(
        openingActor.createSessionOptions,
      );
      openingActor.opening = false;
      for (const error of pendingErrors) {
        openingActor.handleExtensionError(error);
      }
      return openingActor;
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        options.conversationLease.release();
      } catch (leaseError) {
        failures.push(leaseError);
      }
      if (actor) actor.disposed = true;
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Failed to open and clean up conversation actor",
        );
      }
      throw error;
    }
  }

  get profile(): ConversationMeta {
    return structuredClone(this.profileSnapshot);
  }

  get session(): AgentSession {
    return this.requireCreated().session;
  }

  get settings(): SettingsManager {
    return this.requireCreated().settings;
  }

  get modelRegistry(): ModelRegistry {
    return this.requireCreated().modelRegistry;
  }

  getCompactionThresholdPercent(): number {
    return this.compactionThresholdPercent;
  }

  isCompacting(): boolean {
    return this.compacting;
  }

  setCompactionThresholdPercent(percent: number): void {
    const entry = createCompactionThresholdEntry({
      percent,
      updatedAt: this.now().toISOString(),
    });
    appendReservedCustomEntry(this.sessionManager, entry);
    this.compactionThresholdPercent = entry.data.percent;
  }

  compactContext(): Promise<void> {
    this.assertUsable();
    if (this.activeRun) {
      return Promise.reject(
        new Error("Cannot compact a busy conversation; abort and wait first"),
      );
    }
    if (this.compacting) {
      return Promise.reject(new Error("Conversation is already compacting"));
    }
    if (this.truncating || this.switchingRole) {
      return Promise.reject(
        new Error("Conversation cannot compact during another operation"),
      );
    }
    this.updateCompacting(true);
    const operation = this.operations.run(async () => {
      try {
        this.assertUsable();
        if (this.activeRun) {
          throw new Error(
            "Cannot compact a busy conversation; abort and wait first",
          );
        }
        await this.compactSession(true);
      } finally {
        this.updateCompacting(false);
      }
    });
    this.manualCompaction = operation;
    const clearOperation = () => {
      if (this.manualCompaction === operation) {
        this.manualCompaction = undefined;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  switchRole(
    role: ConversationRoleSnapshot,
    createSessionOptions:
      ConversationActorOpenOptions["createSessionOptions"],
  ): Promise<void> {
    this.assertUsable();
    if (this.activeRun) {
      return Promise.reject(
        new Error("Cannot switch the role of a busy conversation"),
      );
    }
    if (this.compacting) {
      return Promise.reject(
        new Error("Cannot switch the role while compacting"),
      );
    }
    if (this.switchingRole) {
      return Promise.reject(
        new Error("Conversation role switch is already running"),
      );
    }
    this.switchingRole = true;
    return this.operations.run(async () => {
      const previousProfile = this.profileSnapshot;
      const previousOptions = this.createSessionOptions;
      const nextProfile = createConversationMetaEntry({
        ...previousProfile,
        role,
      }).data;
      let persisted = false;
      try {
        this.assertUsable();
        if (this.activeRun) {
          throw new Error("Cannot switch the role of a busy conversation");
        }
        if (
          JSON.stringify(previousProfile.role)
          === JSON.stringify(nextProfile.role)
        ) {
          return;
        }

        await this.stopRuntimeSession();
        appendReservedCustomEntry(
          this.sessionManager,
          createConversationRoleChangeEntry({
            role: nextProfile.role,
            changedAt: this.now().toISOString(),
          }),
        );
        persisted = true;
        this.profileSnapshot = nextProfile;
        this.createSessionOptions = createSessionOptions;
        const pendingErrors = await this.startRuntimeSession(
          createSessionOptions,
        );
        for (const error of pendingErrors) this.handleExtensionError(error);
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          if (this.created) await this.stopRuntimeSession();
          if (persisted) {
            appendReservedCustomEntry(
              this.sessionManager,
              createConversationRoleChangeEntry({
                role: previousProfile.role,
                changedAt: this.now().toISOString(),
              }),
            );
          }
          this.profileSnapshot = previousProfile;
          this.createSessionOptions = previousOptions;
          const pendingErrors = await this.startRuntimeSession(
            previousOptions,
          );
          for (const pendingError of pendingErrors) {
            this.handleExtensionError(pendingError);
          }
        } catch (rollbackError) {
          failures.push(rollbackError);
          this.fatalError = new AggregateError(
            failures,
            "Failed to switch conversation role and restore its previous runtime",
          );
          this.emitError(this.fatalError, undefined, true);
        }
        if (failures.length > 1) throw this.fatalError;
        throw error;
      } finally {
        this.switchingRole = false;
      }
    });
  }

  truncateFromMessage(entryId: string): Promise<void> {
    this.assertUsable();
    if (this.activeRun) {
      return Promise.reject(
        new Error("Cannot rewind a busy conversation; abort and wait first"),
      );
    }
    if (this.compacting) {
      return Promise.reject(new Error("Cannot rewind while compacting"));
    }
    if (this.truncating) {
      return Promise.reject(new Error("Conversation rewind is already running"));
    }
    this.truncating = true;
    return this.operations.run(async () => {
      let persisted = false;
      try {
        this.assertUsable();
        if (this.activeRun) {
          throw new Error(
            "Cannot rewind a busy conversation; abort and wait first",
          );
        }
        const sessionFile = await this.project.truncateConversation(
          this.conversationId,
          entryId,
        );
        persisted = true;
        this.sessionManager.setSessionFile(sessionFile);
        const reserved = aggregateReservedConversationEntries(
          this.sessionManager.getEntries(),
        );
        this.compactionThresholdPercent =
          reserved.compactionThreshold?.percent
          ?? DEFAULT_COMPACTION_THRESHOLD_PERCENT;
        this.usedRunIds.clear();
        for (const settlement of reserved.runSettlements) {
          this.usedRunIds.add(settlement.runId);
        }
        this.session.agent.state.messages =
          this.sessionManager.buildSessionContext().messages;
      } catch (error) {
        if (!persisted) throw error;
        this.fatalError = error instanceof Error
          ? error
          : new Error(String(error));
        this.emitError(this.fatalError, undefined, true);
        throw this.fatalError;
      } finally {
        this.truncating = false;
      }
    });
  }

  dynamicProviderNames(): ReadonlySet<string> {
    return this.requireCreated().dynamicProviderNames();
  }

  getActivity(): ConversationActivity {
    const ticket = this.activeRun;
    if (!ticket) return { kind: "idle" };
    switch (ticket.phase) {
      case "queued":
      case "running":
      case "cancelling":
        return { kind: ticket.phase, runId: ticket.id };
      case "waiting":
        if (!ticket.waitingFor) {
          throw new Error("Waiting run is missing its target");
        }
        return {
          kind: "waiting",
          runId: ticket.id,
          targetConversationId: ticket.waitingFor.conversationId,
          targetRunId: ticket.waitingFor.runId,
        };
    }
  }

  getState(): ConversationActorState {
    return {
      conversationId: this.conversationId,
      profile: this.profile,
      activity: this.getActivity(),
      compacting: this.compacting,
      ...(this.fatalError === undefined
        ? {}
        : { fatalError: this.fatalError.message }),
      disposed: this.disposed,
    };
  }

  projectConversationItems(historyItems: ConversationHistoryItem[]): {
    items: ConversationHistoryItem[];
    projectionSeq: number;
    truncated?: boolean;
  } {
    const live = this.liveProjection;
    if (!live) return { items: historyItems, projectionSeq: this.projectionSeq };

    const liveItems = live.items.map((item) => structuredClone(item));
    let liveCursor = 0;
    const merged: ConversationHistoryItem[] = [];
    const currentSlots = projectConversationItemSlots(this.sessionManager);
    let lastCompactionSlotIndex = -1;
    for (let index = 0; index < currentSlots.length; index += 1) {
      if (currentSlots[index]?.item.kind === "compaction") {
        lastCompactionSlotIndex = index;
      }
    }

    const consumeLiveMessages = (
      role: "user" | "assistant",
      count: number,
      append: boolean,
    ) => {
      let consumed = 0;
      while (consumed < count) {
        const liveItem = liveItems[liveCursor];
        if (liveItem?.kind !== "message" || liveItem.role !== role) break;
        if (append) merged.push(liveItem);
        liveCursor += 1;
        consumed += 1;
      }
    };

    for (const [slotIndex, slot] of currentSlots.entries()) {
      const item = slot.item;
      const identity = conversationItemIdentity(item);
      const isBaseItem = live.baseItemIdentities.has(identity);
      if (isBaseItem) {
        merged.push(item);
        if (item.kind === "message" && item.role === "assistant") {
          const baseCount = live.baseAssistantEntryCounts.get(identity) ?? 0;
          const currentCount = slot.assistantEntryCount ?? baseCount;
          consumeLiveMessages("assistant", Math.max(0, currentCount - baseCount), false);
        }
        continue;
      }

      if (item.kind === "message") {
        const count = item.role === "assistant"
          ? Math.max(1, slot.assistantEntryCount ?? 1)
          : 1;
        const preserveDurableItem = slotIndex < lastCompactionSlotIndex;
        consumeLiveMessages(item.role, count, !preserveDurableItem);
        if (preserveDurableItem) merged.push(item);
      } else {
        merged.push(item);
      }
    }

    merged.push(...liveItems.slice(liveCursor));

    const snapshot = snapshotConversationItems(merged);
    return {
      items: snapshot.items,
      projectionSeq: this.projectionSeq,
      truncated: snapshot.truncated,
    };
  }

  subscribe(listener: ConversationActorListener): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * Installs the unique run ticket and publishes run_queued synchronously.
   * The returned promise resolves only with the exact durable settlement.
   */
  startPrompt(input: StartConversationPrompt): Promise<RunSettlement> {
    if (input.text.trim().length === 0) {
      throw new Error("Prompt text must not be empty");
    }
    if (this.isExtensionCommand(input.text)) {
      throw new Error(
        "Extension slash commands are not supported until their detached Agent turns can be owned safely",
      );
    }
    return this.startRun(
      {
        runId: input.runId,
        origin: input.origin,
        recovered: false,
        promptText: input.origin === "browser" ? input.text : undefined,
        expectsInitialPromptRawUserMessage: true,
      },
      (ticket) => this.session.prompt(input.text, {
        preflightResult: (accepted) => {
          if (accepted && isCancelling(ticket)) {
            throw new Error("Run cancelled before agent start");
          }
        },
      }),
    );
  }

  startMessages(input: StartConversationMessages): Promise<RunSettlement> {
    if (input.messages.length === 0) {
      throw new Error("At least one session message is required");
    }
    const messages = input.messages.map((message) =>
      createConversationMessageEntry(message)
    );
    return this.startRun(
      {
        runId: input.runId,
        origin: "inbox",
        recovered: input.recovered,
        expectsInitialPromptRawUserMessage: false,
      },
      async () => {
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index]!;
          await this.session.sendCustomMessage({
            customType: message.customType,
            content: message.content,
            display: message.display,
            details: message.details,
          }, {
            triggerTurn: index === messages.length - 1,
          });
        }
      },
    );
  }

  steer(runId: string, text: string): Promise<void> {
    try {
      this.assertUsable();
    } catch (error) {
      return Promise.reject(new ConversationSteerDeliveryError(
        "rejected_before_sdk_acceptance",
        error,
      ));
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return Promise.reject(new ConversationSteerDeliveryError(
        "rejected_before_sdk_acceptance",
        new Error("Steering text must not be empty"),
      ));
    }
    if (this.isExtensionCommand(trimmed)) {
      return Promise.reject(new ConversationSteerDeliveryError(
        "rejected_before_sdk_acceptance",
        new Error("Extension slash commands cannot steer an active Agent run"),
      ));
    }
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.id !== runId
      || (ticket.phase !== "running" && ticket.phase !== "waiting")
    ) {
      return Promise.reject(new ConversationSteerDeliveryError(
        "rejected_before_sdk_acceptance",
        new Error("The target run is not currently able to accept guidance"),
      ));
    }

    const delivery = deferred<void>();
    // The SDK may synchronously throw after the waiter is registered. Observe
    // its rejection immediately; the returned command promise still receives
    // the same error after the exact waiter is removed.
    void delivery.promise.catch(() => undefined);
    const pendingGuidance: PendingGuidance = { delivery };
    ticket.guidanceDeliveries.push(pendingGuidance);
    const removePendingGuidance = () => {
      const index = ticket.guidanceDeliveries.indexOf(pendingGuidance);
      if (index >= 0) ticket.guidanceDeliveries.splice(index, 1);
    };
    let sdkAccepted = false;

    // AgentSession.steer queues synchronously before its promise resolves. Do
    // not route this through the actor operation queue: that queue is occupied
    // by the active run until settlement. The command itself settles only when
    // the SDK later emits the queued user message into this exact run.
    let queued: Promise<void>;
    try {
      queued = this.session.steer(trimmed);
    } catch (error) {
      removePendingGuidance();
      delivery.reject(error);
      return Promise.reject(new ConversationSteerDeliveryError(
        "rejected_before_sdk_acceptance",
        error,
      ));
    }
    return Promise.resolve(queued).then(
      () => {
        sdkAccepted = true;
        return delivery.promise;
      },
      (error) => {
        removePendingGuidance();
        delivery.reject(error);
        throw new ConversationSteerDeliveryError(
          "rejected_before_sdk_acceptance",
          error,
        );
      },
    ).catch((error: unknown) => {
      removePendingGuidance();
      if (isConversationSteerDeliveryError(error)) throw error;
      throw new ConversationSteerDeliveryError(
        sdkAccepted
          ? "uncertain_after_sdk_acceptance"
          : "rejected_before_sdk_acceptance",
        error,
      );
    });
  }

  /**
   * Queues a durable peer message into the exact active run as a custom
   * steering message. Unlike text guidance, this retains the message card's
   * source identity and is persisted by Pi when the steering queue is consumed.
   */
  steerCustomMessage(
    runId: string,
    message: ConversationMessageEntry,
  ): Promise<void> {
    this.assertUsable();
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.id !== runId
      || ticket.phase === "cancelling"
    ) {
      return Promise.reject(
        new Error("The target run is not currently able to accept a session message"),
      );
    }

    const delivery = deferred<void>();
    ticket.customSteerDeliveries.push({ message, delivery });
    this.flushCustomSteers(ticket);
    return delivery.promise;
  }

  /**
   * Restarts the exact inbox run after its durable custom messages were
   * appended but the process stopped before a settlement was recorded.
   * The hidden trigger adds no second delivery marker; the original messages
   * remain the only source payload in the model context.
   */
  resumeMessages(input: ResumeConversationMessages): Promise<RunSettlement> {
    return this.startRun(
      {
        runId: input.runId,
        origin: "inbox",
        recovered: true,
        expectsInitialPromptRawUserMessage: false,
      },
      () => this.session.sendCustomMessage({
        customType: "workbench.inbox_resume.v1",
        content:
          "恢复此前未结算的跨会话任务。请处理上下文中最后一批来自其他会话的消息。",
        display: false,
        details: { runId: input.runId },
      }, {
        triggerTurn: true,
      }),
    );
  }

  private flushCustomSteers(ticket: RunTicket): void {
    if (ticket.customSteerFlush) return;
    const flush = (async () => {
      try {
        // AgentSession only queues custom steering while its Pi run is live.
        // A ticket may be installed before SDK preflight reaches agent_start;
        // leave the durable envelope claimed and flush it from that event.
        if (!this.session.isStreaming) return;
        while (
          this.activeRun === ticket
          && ticket.phase !== "cancelling"
          && ticket.customSteerDeliveries.length > 0
        ) {
          const next = ticket.customSteerDeliveries[0]!;
          await this.session.sendCustomMessage({
            customType: next.message.customType,
            content: next.message.content,
            display: next.message.display,
            details: next.message.details,
          }, {
            triggerTurn: false,
            deliverAs: "steer",
          });
          if (ticket.customSteerDeliveries[0] === next) {
            ticket.customSteerDeliveries.shift();
            next.delivery.resolve();
          }
        }
      } catch (error) {
        this.rejectCustomSteers(ticket, error);
      }
    })();
    ticket.customSteerFlush = flush;
    void flush.then(() => {
      if (ticket.customSteerFlush !== flush) return;
      ticket.customSteerFlush = undefined;
      if (
        this.activeRun === ticket
        && ticket.phase !== "cancelling"
        && this.session.isStreaming
        && ticket.customSteerDeliveries.length > 0
      ) {
        this.flushCustomSteers(ticket);
      }
    });
  }

  private rejectCustomSteers(ticket: RunTicket, error: unknown): void {
    ticket.customSteerFlush = undefined;
    for (const pending of ticket.customSteerDeliveries.splice(0)) {
      pending.delivery.reject(error);
    }
  }

  private startRun(
    input: {
      runId: string;
      origin: ConversationRunOrigin;
      recovered: boolean;
      promptText?: string;
      expectsInitialPromptRawUserMessage: boolean;
    },
    execute: (ticket: RunTicket) => Promise<void>,
  ): Promise<RunSettlement> {
    this.assertUsable();
    if (this.truncating) {
      throw new Error("Conversation is being rewound");
    }
    if (this.switchingRole) {
      throw new Error("Conversation role is being switched");
    }
    if (this.compacting) {
      throw new Error("Conversation is compacting");
    }
    if (this.activeRun) throw new Error("Agent is already running");
    if (this.usedRunIds.has(input.runId)) {
      throw new Error("Run ID was already used in this conversation actor");
    }
    this.usedRunIds.add(input.runId);
    const ownership: ConversationRunOwnership = Object.freeze({
      conversationId: this.conversationId,
      runId: input.runId,
      origin: input.origin,
      recovered: input.recovered,
      [RUN_OWNERSHIP]: Symbol(input.runId),
    });
    const ticket: RunTicket = {
      id: input.runId,
      origin: input.origin,
      ownership,
      projector: new SessionEventProjector({
        suppressNextUserMessage: input.origin === "browser",
      }),
      completion: deferred<RunSettlement>(),
      guidanceDeliveries: [],
      customSteerDeliveries: [],
      expectsInitialPromptRawUserMessage:
        input.expectsInitialPromptRawUserMessage,
      pendingPromptUserDelivered: false,
      phase: "queued",
      toolMode: this.profileSnapshot.role.toolMode,
      sawSdkCompactionAttempt: false,
      compactionErrorReported: false,
      sdkCompactionSucceeded: false,
      turnBoundaryCompactionRequested: false,
    };
    this.activeRun = ticket;
    this.beginLiveProjection(ticket, input.promptText);
    this.emitSessionEvent(ticket, { type: "run_queued" });
    this.emitActivity();

    void this.operations.run(async () => {
      await this.executeRun(ticket, execute);
    }).catch((error) => {
      this.failRunInfrastructure(ticket, error);
    });
    return ticket.completion.promise;
  }

  currentRunOwnership(runId?: string): ConversationRunOwnership | undefined {
    const ticket = this.activeRun;
    if (
      !ticket
      || (runId !== undefined && ticket.id !== runId)
      || ticket.phase === "queued"
      || ticket.phase === "cancelling"
    ) {
      return;
    }
    return ticket.ownership;
  }

  enterWaiting(
    ownership: ConversationRunOwnership,
    target: ConversationWaitingTarget,
  ): () => void {
    // SAFETY: one run has one visible waiting target because gated tool
    // execution is sequential. Parallel blocking tools would require a
    // multi-wait activity model instead of overwriting this single phase.
    const ticket = this.requireOwnedRunningTicket(ownership);
    const waitingEpoch = Symbol(`${target.conversationId}:${target.runId}`);
    ticket.phase = "waiting";
    ticket.waitingFor = { ...target };
    ticket.waitingEpoch = waitingEpoch;
    this.emitActivity();

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      if (
        this.activeRun !== ticket
        || ticket.ownership !== ownership
        || ticket.phase !== "waiting"
        || ticket.waitingEpoch !== waitingEpoch
      ) {
        return;
      }
      ticket.phase = "running";
      ticket.waitingFor = undefined;
      ticket.waitingEpoch = undefined;
      this.emitActivity();
    };
  }

  async withWaiting<T>(
    ownership: ConversationRunOwnership,
    target: ConversationWaitingTarget,
    work: () => Promise<T> | T,
  ): Promise<T> {
    const restore = this.enterWaiting(ownership, target);
    try {
      return await work();
    } finally {
      restore();
    }
  }

  abort(runId: string): Promise<void> {
    const ticket = this.activeRun;
    if (!ticket || ticket.id !== runId) return Promise.resolve();
    return this.cancelRun(ticket);
  }

  /**
   * Disposes the AgentSession and either releases the writer lease or upgrades
   * it in place for exact deletion. The first dispose call owns the choice.
   */
  dispose(
    options: { transferLeaseForDeletion?: boolean } = {},
  ): Promise<ConversationDeletionLease | undefined> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    const transferLeaseForDeletion =
      options.transferLeaseForDeletion === true;
    const ticket = this.activeRun;

    this.disposePromise = (async () => {
      const failures: unknown[] = [];
      if (ticket) {
        try {
          await this.cancelRun(ticket);
        } catch (error) {
          failures.push(error);
        }
        try {
          await ticket.completion.promise;
        } catch (error) {
          failures.push(error);
        }
      }
      const manualCompaction = this.manualCompaction;
      if (manualCompaction) {
        try {
          this.session.abortCompaction();
        } catch (error) {
          failures.push(error);
        }
        await manualCompaction.catch(() => undefined);
      }

      try {
        this.unsubscribeSession?.();
      } catch (error) {
        failures.push(error);
      }
      this.unsubscribeSession = undefined;

      try {
        await this.created?.dispose();
      } catch (error) {
        failures.push(error);
      }
      this.created = undefined;

      const leftover = this.activeRun;
      if (leftover?.projectRunLease) {
        try {
          leftover.projectRunLease.release();
        } catch (error) {
          failures.push(error);
        }
        leftover.projectRunLease = undefined;
      }
      this.activeRun = undefined;

      let deletionLease: ConversationDeletionLease | undefined;
      try {
        if (transferLeaseForDeletion) {
          deletionLease = this.conversationLease.upgradeToDeletion();
        } else {
          this.conversationLease.release();
        }
      } catch (error) {
        failures.push(error);
      }

      this.disposed = true;
      this.disposing = false;
      this.listeners.clear();

      if (failures.length > 0) {
        try {
          deletionLease?.release();
        } catch (error) {
          failures.push(error);
        }
        throw new AggregateError(
          failures,
          "Failed to dispose conversation actor",
        );
      }
      return deletionLease;
    })();
    return this.disposePromise;
  }

  private async executeRun(
    ticket: RunTicket,
    execute: (ticket: RunTicket) => Promise<void>,
  ): Promise<void> {
    if (this.activeRun !== ticket) return;
    if (isCancelling(ticket)) {
      await this.settleRun(ticket, "aborted");
      return;
    }
    const projectRunLease = this.projectRuns.registerRun(
      this.project.cwd,
      () => this.cancelRun(ticket),
    );
    if (!projectRunLease) {
      await this.settleRun(ticket, "aborted");
      return;
    }
    ticket.projectRunLease = projectRunLease;
    await this.compactAtThreshold(ticket);
    if (this.activeRun !== ticket) return;
    if (ticket.phase === "cancelling") {
      await this.settleRun(ticket, "aborted");
      return;
    }
    ticket.phase = "running";
    this.emitSessionEvent(ticket, { type: "run_started" });
    this.emitActivity();

    let outcome: RunSettlement["outcome"] = "completed";
    let failure: unknown;
    try {
      await execute(ticket);
      this.releaseTurnBoundaryPause();
      while (
        ticket.turnBoundaryCompactionRequested
        && this.activeRun === ticket
        && !isCancelling(ticket)
      ) {
        ticket.turnBoundaryCompactionRequested = false;
        const projectedFailure =
          ticket.extensionErrorMessage ?? ticket.projector.errorMessage;
        if (projectedFailure) throw new Error(projectedFailure);

        await this.compactRequestedTurnBoundary(ticket);
        if (this.activeRun !== ticket || isCancelling(ticket)) break;

        const resume = createCompactionResumeEntry({
          content:
            "The workbench paused between tool turns for context management. Continue the unfinished task from the retained context without waiting for another user message.",
          display: false,
          details: { runId: ticket.id },
        });
        await this.session.sendCustomMessage({
          customType: resume.customType,
          content: resume.content,
          display: resume.display,
          details: resume.details,
        }, {
          triggerTurn: true,
        });
      }
      const projectedFailure =
        ticket.extensionErrorMessage ?? ticket.projector.errorMessage;
      if (projectedFailure) throw new Error(projectedFailure);
      if (isCancelling(ticket) || ticket.projector.aborted) {
        outcome = "aborted";
      } else {
        await this.compactAtThreshold(ticket);
        if (isCancelling(ticket)) outcome = "aborted";
      }
    } catch (error) {
      if (isCancelling(ticket) || this.activeRun !== ticket) {
        outcome = "aborted";
      } else {
        outcome = "failed";
        failure = error;
      }
    } finally {
      this.releaseTurnBoundaryPause();
    }

    if (failure !== undefined) this.emitError(failure, ticket.id);
    await this.settleRun(ticket, outcome);
  }

  private async compactAtThreshold(ticket: RunTicket): Promise<void> {
    if (ticket.sawSdkCompactionAttempt) return;
    const usage = this.session.getContextUsage?.();
    this.emitContextUsage();
    if (
      usage?.percent === null
      || usage?.percent === undefined
      || usage.percent < this.compactionThresholdPercent
      || !this.isCompactionAttemptDue(ticket, usage.percent)
    ) return;
    await this.attemptHostCompaction(ticket);
  }

  private async compactRequestedTurnBoundary(ticket: RunTicket): Promise<void> {
    if (ticket.sawSdkCompactionAttempt) {
      if (ticket.sdkCompactionSucceeded) {
        ticket.sawSdkCompactionAttempt = false;
        ticket.sdkCompactionSucceeded = false;
      }
      return;
    }
    const percent = this.session.getContextUsage?.()?.percent;
    if (!this.isCompactionAttemptDue(ticket, percent)) return;
    await this.attemptHostCompaction(ticket);
  }

  private async attemptHostCompaction(ticket: RunTicket): Promise<void> {
    ticket.compactionErrorReported = false;
    try {
      await this.compactSession();
      this.recordCompactionSuccess(ticket);
    } catch (error) {
      if (isCancelling(ticket)) return;
      this.recordCompactionFailure(ticket);
      if (!ticket.compactionErrorReported) {
        ticket.compactionErrorReported = true;
        this.emitError(error, ticket.id);
      }
    }
  }

  private isCompactionAttemptDue(
    ticket: RunTicket,
    percent: number | null | undefined,
  ): boolean {
    const retryAt = ticket.compactionRetryAtPercent;
    return retryAt === undefined
      || (percent !== null && percent !== undefined && percent >= retryAt);
  }

  private recordCompactionFailure(ticket: RunTicket): void {
    const percent = this.session.getContextUsage?.()?.percent;
    const failedAt = percent ?? this.compactionThresholdPercent;
    ticket.compactionRetryAtPercent = Math.max(
      ticket.compactionRetryAtPercent ?? 0,
      failedAt + COMPACTION_RETRY_GROWTH_PERCENT,
    );
  }

  private recordCompactionSuccess(ticket: RunTicket): void {
    ticket.compactionErrorReported = false;
    ticket.compactionRetryAtPercent = undefined;
  }

  private async compactSession(reserved = false): Promise<void> {
    if (this.compacting && !reserved) {
      throw new Error("Conversation is already compacting");
    }
    if (!reserved) this.updateCompacting(true);
    this.hostCompactionInProgress = true;
    try {
      await this.session.compact();
    } finally {
      this.hostCompactionInProgress = false;
      if (!reserved) this.updateCompacting(false);
    }
  }

  private updateCompacting(compacting: boolean): void {
    if (this.compacting === compacting) return;
    this.compacting = compacting;
    this.emitCompaction();
  }

  private settleRun(
    ticket: RunTicket,
    outcome: RunSettlement["outcome"],
  ): Promise<RunSettlement> {
    ticket.finishPromise ??= this.finishRun(ticket, outcome);
    return ticket.finishPromise;
  }

  private async finishRun(
    ticket: RunTicket,
    outcome: RunSettlement["outcome"],
  ): Promise<RunSettlement> {
    if (this.activeRun !== ticket) {
      return ticket.completion.promise;
    }
    const settlement = createRunSettlementEntry({
      runId: ticket.id,
      outcome,
      finalText: ticket.projector.finalText,
      settledAt: this.now().toISOString(),
    }).data;

    // Ordering is intentional: durable truth precedes the permission lease,
    // browser terminal projection, and coordinator lifecycle reactions.
    await this.persistSettlementCallback(settlement, this.sessionManager);
    for (const guidance of ticket.guidanceDeliveries.splice(0)) {
      guidance.delivery.reject(
        new Error("Run ended before queued guidance was delivered"),
      );
    }
    this.rejectCustomSteers(
      ticket,
      new Error("Run ended before queued session messages were delivered"),
    );
    ticket.projectRunLease?.release();
    ticket.projectRunLease = undefined;
    this.cancelScope(ticket.id);
    this.activeRun = undefined;
    this.emitSessionEvent(ticket, {
      type: "run_finished",
      outcome,
    });
    if (!this.activeRun) this.emitActivity();
    const completion = {
      settlement,
      origin: ticket.origin,
      pendingPromptUserDelivered: ticket.pendingPromptUserDelivered,
    } satisfies ConversationActorCompletion;
    this.emit({
      type: "completion",
      conversationId: this.conversationId,
      ...completion,
    });
    try {
      const callback = this.onCompletion?.(completion);
      void Promise.resolve(callback).catch((error) => {
        this.emitError(error, ticket.id);
      });
    } catch (error) {
      this.emitError(error, ticket.id);
    }
    ticket.completion.resolve(settlement);
    void this.project.refreshConversations().catch((error) => {
      this.emitError(error, ticket.id);
    });
    return settlement;
  }

  private failRunInfrastructure(ticket: RunTicket, error: unknown): void {
    if (ticket.projectRunLease) {
      try {
        ticket.projectRunLease.release();
      } catch {
        // The original persistence/lifecycle failure remains authoritative.
      }
      ticket.projectRunLease = undefined;
    }
    if (this.activeRun === ticket) this.activeRun = undefined;
    if (this.liveProjection?.runId === ticket.id) this.liveProjection = undefined;
    for (const guidance of ticket.guidanceDeliveries.splice(0)) {
      guidance.delivery.reject(error);
    }
    this.rejectCustomSteers(ticket, error);
    this.fatalError = error instanceof Error
      ? error
      : new Error(String(error));
    this.cancelScope(ticket.id);
    this.emitError(this.fatalError, ticket.id, true);
    this.emitActivity();
    ticket.completion.reject(this.fatalError);
  }

  private cancelRun(ticket: RunTicket): Promise<void> {
    if (this.activeRun !== ticket) return Promise.resolve();
    this.cancelScope(ticket.id);
    if (this.compacting) {
      try {
        this.session.abortCompaction();
      } catch (error) {
        this.emitError(error, ticket.id);
      }
    }
    if (ticket.phase === "queued") {
      ticket.phase = "cancelling";
      this.emitActivity();
      return this.settleRun(ticket, "aborted").then(() => undefined);
    }
    if (ticket.phase === "cancelling") {
      return ticket.abortPromise ?? Promise.resolve();
    }

    ticket.phase = "cancelling";
    ticket.waitingFor = undefined;
    ticket.waitingEpoch = undefined;
    this.emitActivity();
    ticket.abortPromise = Promise.resolve().then(() => {
      this.session.clearQueue();
      return this.session.abort();
    });
    return ticket.abortPromise;
  }

  private abortCurrentRun(): Promise<void> {
    const ticket = this.activeRun;
    return ticket ? this.cancelRun(ticket) : Promise.resolve();
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    const ticket = this.activeRun;
    if (ticket && event.type === "agent_start") {
      this.flushCustomSteers(ticket);
    }
    if (
      ticket
      && event.type === "agent_start"
      && ticket.turnBoundaryCompactionRequested
    ) {
      // Pi may still continue through an internal recovery path after the
      // graceful stop. That physical continuation belongs to this workbench
      // run and replaces the host-injected resume message.
      this.releaseTurnBoundaryPause();
      ticket.turnBoundaryCompactionRequested = false;
      if (ticket.sdkCompactionSucceeded) {
        ticket.sawSdkCompactionAttempt = false;
        ticket.sdkCompactionSucceeded = false;
      }
    }
    if (event.type === "compaction_start") {
      if (ticket && !this.hostCompactionInProgress) {
        ticket.sawSdkCompactionAttempt = true;
        ticket.sdkCompactionSucceeded = false;
        ticket.compactionErrorReported = false;
      }
      this.updateCompacting(true);
    } else if (event.type === "compaction_end") {
      this.updateCompacting(false);
      const sdkOwned = ticket && !this.hostCompactionInProgress;
      if (sdkOwned && event.result !== undefined && !event.aborted) {
        ticket.sdkCompactionSucceeded = true;
        this.recordCompactionSuccess(ticket);
        if (!ticket.turnBoundaryCompactionRequested) {
          ticket.sawSdkCompactionAttempt = false;
          ticket.sdkCompactionSucceeded = false;
        }
      } else if (sdkOwned && !event.willRetry) {
        ticket.sawSdkCompactionAttempt = false;
        if (!isCancelling(ticket)) this.recordCompactionFailure(ticket);
      }
      if (
        ticket
        && event.errorMessage
        && !event.aborted
        && !event.willRetry
        && !ticket.compactionErrorReported
      ) {
        ticket.compactionErrorReported = true;
        this.emitError(event.errorMessage, ticket.id);
      }
    }
    if (
      !ticket
      || ticket.phase === "queued"
    ) {
      if (event.type === "agent_start") {
        void this.session.abort().catch((error) => {
          this.emitError(error);
        });
        this.emitError(
          "An extension started an Agent turn outside the workbench run lifecycle; it was stopped",
        );
      }
      return;
    }

    if (
      event.type === "message_end"
      && event.message.role === "user"
      && (
        ticket.expectsInitialPromptRawUserMessage
        || ticket.guidanceDeliveries.length > 0
      )
    ) {
      const rawMessage = event.message;
      // Raw user ends are ordered by Pi. Claim the first one before the
      // asynchronous persistence proof so a late initial prompt can never be
      // mistaken for the first queued guidance delivery.
      const isInitialPrompt = ticket.expectsInitialPromptRawUserMessage;
      if (isInitialPrompt) ticket.expectsInitialPromptRawUserMessage = false;
      queueMicrotask(() => {
        if (!rawUserMessageIsPersisted(
          this.sessionManager.getEntries(),
          rawMessage,
        )) {
          const error = new Error(
            "Pi did not durably append the raw user message before delivery acknowledgement",
          );
          if (!isInitialPrompt) {
            ticket.guidanceDeliveries.shift()?.delivery.reject(error);
          }
          this.emitError(error, ticket.id);
          return;
        }
        if (isInitialPrompt) {
          if (ticket.origin === "pending_prompt") {
            ticket.pendingPromptUserDelivered = true;
          }
          return;
        }
        // Subsequent raw user-message ends are FIFO with AgentSession.steer()
        // calls. Promise continuations run after this microtask, after Pi's
        // synchronous SessionManager append has been proved by object identity.
        ticket.guidanceDeliveries.shift()?.delivery.resolve();
      });
    }

    for (const projected of ticket.projector.project(event)) {
      this.emitSessionEvent(ticket, projected);
    }
  }

  private handleExtensionError(error: ExtensionError): void {
    try {
      this.onExtensionError?.(error);
    } catch (callbackError) {
      this.emitError(callbackError);
    }
    const ticket = this.activeRun;
    const message =
      `Extension error in ${error.event} (${error.extensionPath}): ${error.error}`;
    if (ticket && ticket.phase !== "queued") {
      ticket.extensionErrorMessage ??= message;
      return;
    }
    this.emitError(message);
  }

  private async authorizeToolCall(
    input: ToolCallGateInput,
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
    const ticket = this.activeRun;
    if (!ticket || ticket.phase !== "running") {
      return {
        block: true,
        reason: "No active run owns this tool call",
      };
    }

    let preparedArgs: unknown;
    try {
      preparedArgs = snapshotWireValue(input.args).value;
    } catch {
      preparedArgs = undefined;
    }
    this.emitSessionEvent(ticket, {
      type: "tool_prepared",
      toolCallId: input.toolCallId,
      ...(preparedArgs === undefined ? {} : { args: preparedArgs }),
    });

    let policy: ToolPolicyDecision;
    try {
      policy = await this.toolPolicy({
        mode: ticket.toolMode,
        toolName: input.toolName,
        toolSource: input.toolSource,
      });
    } catch (error) {
      this.emitError(
        `Tool policy failed: ${errorMessage(error)}`,
        ticket.id,
      );
      return {
        block: true,
        reason: "Tool policy failed; execution was blocked",
      };
    }

    if (
      input.signal?.aborted
      || this.activeRun !== ticket
      || ticket.phase !== "running"
    ) {
      return {
        block: true,
        reason: "Run cancelled before tool execution",
      };
    }
    if (policy.action === "deny") {
      return { block: true, reason: policy.reason };
    }
    return undefined;
  }

  private checkTurnBoundary(input: AgentTurnBoundaryCheck): boolean {
    this.emitContextUsage();
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.phase === "queued"
      || isCancelling(ticket)
      || !input.hasToolResults
      || ticket.sawSdkCompactionAttempt
    ) {
      return false;
    }
    const percent = input.contextUsage?.percent;
    if (
      percent === null
      || percent === undefined
      || percent < this.compactionThresholdPercent
      || !this.isCompactionAttemptDue(ticket, percent)
    ) {
      return false;
    }
    ticket.turnBoundaryCompactionRequested = true;
    return true;
  }

  private requireOwnedRunningTicket(
    ownership: ConversationRunOwnership,
  ): RunTicket {
    const ticket = this.activeRun;
    if (
      !ticket
      || ticket.ownership !== ownership
      || ownership[RUN_OWNERSHIP] !== ticket.ownership[RUN_OWNERSHIP]
      || ticket.phase !== "running"
    ) {
      throw new Error("Run ownership is stale or is not currently running");
    }
    return ticket;
  }

  private isExtensionCommand(text: string): boolean {
    if (!text.startsWith("/")) return false;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1
      ? text.slice(1)
      : text.slice(1, spaceIndex);
    return this.session.extensionRunner.getCommand(commandName) !== undefined;
  }

  private resetLiveProjection(ticket: RunTicket): LiveConversationProjection {
    const baseSlots = projectConversationItemSlots(this.sessionManager);
    const baseItemIdentities = new Set(
      baseSlots.map((slot) => conversationItemIdentity(slot.item)),
    );
    const baseAssistantEntryCounts = new Map(
      baseSlots.flatMap((slot) => {
        if (slot.item.kind !== "message" || slot.item.role !== "assistant") {
          return [];
        }
        return [[
          conversationItemIdentity(slot.item),
          slot.assistantEntryCount ?? 0,
        ] as const];
      }),
    );
    const live: LiveConversationProjection = {
      runId: ticket.id,
      baseItemIdentities,
      baseAssistantEntryCounts,
      items: [],
    };
    this.liveProjection = live;
    return live;
  }

  private requireLiveProjection(ticket: RunTicket): LiveConversationProjection {
    if (!this.liveProjection || this.liveProjection.runId !== ticket.id) {
      return this.resetLiveProjection(ticket);
    }
    return this.liveProjection;
  }

  private beginLiveProjection(ticket: RunTicket, promptText: string | undefined): void {
    const live = this.resetLiveProjection(ticket);
    const items = live.items;
    if (promptText !== undefined) {
      items.push({
        kind: "message",
        id: runMessageId(ticket.id, "user"),
        runId: ticket.id,
        role: "user",
        text: promptText,
        thinking: "",
        tools: [],
        parts: promptText
          ? [{ kind: "text", offset: 0, length: promptText.length }]
          : [],
      });
    }
  }

  private ensureLiveAssistant(ticket: RunTicket): ConversationHistoryMessage {
    const live = this.requireLiveProjection(ticket);
    const current = live.currentAssistantId === undefined
      ? undefined
      : live.items.find((item) => (
        item.kind === "message" && item.id === live.currentAssistantId
      ));
    if (current?.kind === "message") return current;

    const assistant: ConversationHistoryMessage & { kind: "message" } = {
      kind: "message",
      id: runMessageId(ticket.id, "assistant"),
      runId: ticket.id,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      parts: [],
    };
    live.currentAssistantId = assistant.id;
    live.items.push(assistant);
    return assistant;
  }

  private appendLiveUser(ticket: RunTicket, projectionId: string, text: string): void {
    const live = this.requireLiveProjection(ticket);
    if (live.items.some((item) => item.kind === "message" && item.id === projectionId)) {
      return;
    }
    live.items.push({
      kind: "message",
      id: projectionId,
      runId: ticket.id,
      role: "user",
      text,
      thinking: "",
      tools: [],
      parts: text ? [{ kind: "text", offset: 0, length: text.length }] : [],
    });
  }

  private applyLiveSessionEvent(ticket: RunTicket, event: SessionEvent): void {
    if (event.type === "user_message") {
      this.appendLiveUser(ticket, event.projectionId, event.text);
      return;
    }
    if (event.type === "assistant_message_started") {
      const live = this.requireLiveProjection(ticket);
      const existingIndex = live.items.findIndex((item) => (
        item.kind === "message" && item.id === event.projectionId
      ));
      if (existingIndex >= 0) {
        live.currentAssistantId = event.projectionId;
        return;
      }
      const emptyAssistantIndex = live.items.findIndex((item) => (
        item.kind === "message"
        && item.role === "assistant"
        && item.runId === ticket.id
        && !item.text
        && !item.thinking
        && item.tools.length === 0
      ));
      if (emptyAssistantIndex >= 0) {
        live.items.splice(emptyAssistantIndex, 1);
      }
      live.currentAssistantId = event.projectionId;
      live.items.push({
        kind: "message",
        id: event.projectionId,
        runId: ticket.id,
        role: "assistant",
        text: "",
        thinking: "",
        tools: [],
        parts: [],
      });
      return;
    }
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      if (!event.delta) return;
      const assistant = this.ensureLiveAssistant(ticket);
      if (event.type === "text_delta") {
        const offset = assistant.text.length;
        assistant.text += event.delta;
        assistant.parts = appendHistoryPart(assistant.parts, {
          kind: "text",
          offset,
          length: event.delta.length,
        });
      } else {
        const offset = assistant.thinking.length;
        assistant.thinking += event.delta;
        assistant.parts = appendHistoryPart(assistant.parts, {
          kind: "thinking",
          offset,
          length: event.delta.length,
        });
      }
      return;
    }
    if (event.type === "text_replaced") {
      const assistant = this.ensureLiveAssistant(ticket);
      assistant.text = event.text;
      assistant.parts = [
        ...(assistant.parts ?? []).filter((part) => part.kind !== "text"),
        ...(event.text ? [{ kind: "text" as const, offset: 0, length: event.text.length }] : []),
      ];
      return;
    }
    if (event.type === "tool_started") {
      const assistant = this.ensureLiveAssistant(ticket);
      const tool: ConversationHistoryTool = {
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        args: event.args,
        status: "pending",
      };
      assistant.tools = [...assistant.tools, tool];
      assistant.parts = appendHistoryPart(assistant.parts, {
        kind: "tool",
        toolCallId: tool.toolCallId,
      });
      return;
    }
    if (event.type === "tool_prepared") {
      const assistant = this.ensureLiveAssistant(ticket);
      assistant.tools = assistant.tools.map((tool) => (
        tool.toolCallId === String(event.toolCallId)
          ? { ...tool, args: event.args, status: "pending" }
          : tool
      ));
      return;
    }
    if (event.type === "tool_updated" || event.type === "tool_finished") {
      const assistant = this.ensureLiveAssistant(ticket);
      const status = event.type === "tool_finished"
        ? (event.isError ? "error" : "done")
        : "running";
      assistant.tools = assistant.tools.map((tool) => (
        tool.toolCallId === String(event.toolCallId)
          ? { ...tool, result: event.result, status }
          : tool
      ));
      return;
    }
    if (event.type === "usage") {
      const assistant = this.ensureLiveAssistant(ticket);
      assistant.usage = addUsage(assistant.usage, event.usage);
    }
  }

  private emitSessionEvent(ticket: RunTicket, event: SessionEvent): void {
    this.applyLiveSessionEvent(ticket, event);
    const projectionSeq = ++this.projectionSeq;
    this.emit({
      type: "session_event",
      conversationId: this.conversationId,
      runId: ticket.id,
      projectionSeq,
      event,
    });
    if (event.type === "run_finished" && this.liveProjection?.runId === ticket.id) {
      this.liveProjection = undefined;
    }
  }

  private emitActivity(): void {
    this.emit({
      type: "activity",
      conversationId: this.conversationId,
      activity: cloneActivity(this.getActivity()),
    });
  }

  private emitCompaction(): void {
    this.emit({
      type: "compaction",
      conversationId: this.conversationId,
      compacting: this.compacting,
    });
  }

  private emitContextUsage(): void {
    this.emit({
      type: "context_usage",
      conversationId: this.conversationId,
    });
  }

  private releaseTurnBoundaryPause(): void {
    this.created?.releaseTurnBoundaryPause?.();
  }

  private emitError(
    error: unknown,
    runId?: string,
    fatal = false,
  ): void {
    this.emit({
      type: "error",
      conversationId: this.conversationId,
      ...(runId === undefined ? {} : { runId }),
      message: errorMessage(error),
      ...(fatal ? { fatal: true } : {}),
    });
  }

  private cancelScope(runId: string): void {
    try {
      this.cancelRunScope?.(runId);
    } catch (error) {
      this.emitError(error, runId);
    }
  }

  private emit(event: ConversationActorEvent): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // An observer is a projection only and cannot roll back actor state.
      }
    }
  }

  private assertUsable(): void {
    if (this.opening) throw new Error("Conversation actor is still opening");
    if (this.disposed || this.disposing) {
      throw new Error("Conversation actor is closed");
    }
    if (this.fatalError) {
      throw new Error(
        `Conversation actor is faulted: ${this.fatalError.message}`,
      );
    }
  }

  private requireCreated(): CreatedPiSession {
    if (!this.created) throw new Error("Conversation actor is closed");
    return this.created;
  }

  private async startRuntimeSession(
    createSessionOptions:
      ConversationActorOpenOptions["createSessionOptions"],
  ): Promise<readonly ExtensionError[]> {
    let created: CreatedPiSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      created = await this.runtime.createSession(
        this.project.cwd,
        {
          ...createSessionOptions,
          sessionManager: this.sessionManager,
          toolCallGate: (input) => this.authorizeToolCall(input),
          extensionAbort: () => {
            void this.abortCurrentRun().catch((error) => {
              this.emitError(error);
            });
          },
          turnBoundaryCheck: (input) => this.checkTurnBoundary(input),
        },
      );
      this.created = created;
      await created.activateExtensions();
      unsubscribe = created.session.subscribe((event) => {
        this.onSessionEvent(event);
      });
      this.unsubscribeSession = unsubscribe;
      return created.activateExtensionErrors((error) => {
        this.handleExtensionError(error);
      });
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        unsubscribe?.();
      } catch (unsubscribeError) {
        failures.push(unsubscribeError);
      }
      this.unsubscribeSession = undefined;
      this.created = undefined;
      if (created) {
        try {
          await created.dispose();
        } catch (disposeError) {
          failures.push(disposeError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Failed to create and clean up conversation runtime",
        );
      }
      throw error;
    }
  }

  private async stopRuntimeSession(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.unsubscribeSession?.();
    } catch (error) {
      failures.push(error);
    }
    this.unsubscribeSession = undefined;
    const created = this.created;
    this.created = undefined;
    try {
      await created?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to stop conversation runtime",
      );
    }
  }
}
