import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionError,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ConversationActivity,
  SessionEvent,
  ToolMode,
} from "../shared/protocol.js";
import { mostRestrictiveToolMode } from "../shared/tool-mode.js";
import {
  aggregateReservedConversationEntries,
  createConversationMetaEntry,
  createConversationMessageEntry,
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
  | "conversation";

export interface ConversationActorState {
  conversationId: string;
  profile: ConversationMeta;
  activity: ConversationActivity;
  fatalError?: string;
  disposed: boolean;
}

export type ConversationActorEvent =
  | {
      type: "session_event";
      conversationId: string;
      runId: string;
      event: SessionEvent;
    }
  | {
      type: "activity";
      conversationId: string;
      activity: ConversationActivity;
    }
  | {
      type: "completion";
      conversationId: string;
      origin: ConversationRunOrigin;
      settlement: RunSettlement;
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
}

export interface ConversationActorOpenOptions {
  conversationId: string;
  profile: ConversationMeta;
  project: Pick<ProjectStore, "cwd" | "toolMode" | "refreshConversations">;
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
}

export interface ResumeConversationMessages {
  runId: string;
}

export interface ConversationWaitingTarget {
  conversationId: string;
  runId: string;
}

const RUN_OWNERSHIP = Symbol("ConversationActor.runOwnership");

/**
 * An opaque capability for the currently executing run. A stale capability can
 * observe completion, but it cannot mutate a later run or revive a settled one.
 */
export interface ConversationRunOwnership {
  readonly conversationId: string;
  readonly runId: string;
  readonly origin: ConversationRunOrigin;
  readonly [RUN_OWNERSHIP]: symbol;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface RunTicket {
  readonly id: string;
  readonly origin: ConversationRunOrigin;
  readonly ownership: ConversationRunOwnership;
  readonly projector: SessionEventProjector;
  readonly completion: Deferred<RunSettlement>;
  phase: "queued" | "running" | "waiting" | "cancelling";
  waitingFor?: ConversationWaitingTarget;
  waitingEpoch?: symbol;
  toolMode: ToolMode;
  extensionErrorMessage?: string;
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

function isCancelling(ticket: RunTicket): boolean {
  return ticket.phase === "cancelling";
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
  private readonly createSessionOptions:
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
  private readonly profileSnapshot: ConversationMeta;

  private created?: CreatedPiSession;
  private unsubscribeSession?: () => void;
  private activeRun?: RunTicket;
  private opening = true;
  private disposing = false;
  private disposed = false;
  private fatalError?: Error;
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
    for (
      const settlement of aggregateReservedConversationEntries(
        this.sessionManager.getEntries(),
      ).runSettlements
    ) {
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
    let created: CreatedPiSession | undefined;
    try {
      const openingActor = new ConversationActor(options);
      actor = openingActor;
      created = await openingActor.runtime.createSession(
        openingActor.project.cwd,
        {
          ...openingActor.createSessionOptions,
          sessionManager: openingActor.sessionManager,
          toolCallGate: (input) => openingActor.authorizeToolCall(input),
          extensionAbort: () => {
            void openingActor.abortCurrentRun().catch((error) => {
              openingActor.emitError(error);
            });
          },
        },
      );
      openingActor.created = created;
      await created.activateExtensions();
      openingActor.unsubscribeSession = created.session.subscribe((event) => {
        openingActor.onSessionEvent(event);
      });
      const pendingErrors = created.activateExtensionErrors((error) => {
        openingActor.handleExtensionError(error);
      });
      openingActor.opening = false;
      for (const error of pendingErrors) {
        openingActor.handleExtensionError(error);
      }
      return openingActor;
    } catch (error) {
      const failures: unknown[] = [error];
      if (created) {
        try {
          await created.dispose();
        } catch (disposeError) {
          failures.push(disposeError);
        }
      }
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
      ...(this.fatalError === undefined
        ? {}
        : { fatalError: this.fatalError.message }),
      disposed: this.disposed,
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

  private startRun(
    input: {
      runId: string;
      origin: ConversationRunOrigin;
    },
    execute: (ticket: RunTicket) => Promise<void>,
  ): Promise<RunSettlement> {
    this.assertUsable();
    if (this.activeRun) throw new Error("Agent is already running");
    if (this.usedRunIds.has(input.runId)) {
      throw new Error("Run ID was already used in this conversation actor");
    }
    this.usedRunIds.add(input.runId);
    const ownership: ConversationRunOwnership = Object.freeze({
      conversationId: this.conversationId,
      runId: input.runId,
      origin: input.origin,
      [RUN_OWNERSHIP]: Symbol(input.runId),
    });
    const ticket: RunTicket = {
      id: input.runId,
      origin: input.origin,
      ownership,
      projector: new SessionEventProjector(),
      completion: deferred<RunSettlement>(),
      phase: "queued",
      toolMode: this.project.toolMode,
    };
    this.activeRun = ticket;
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
    if (ticket.phase === "cancelling") {
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
    ticket.phase = "running";
    this.emitSessionEvent(ticket, { type: "run_started" });
    this.emitActivity();

    let outcome: RunSettlement["outcome"] = "completed";
    let failure: unknown;
    try {
      await execute(ticket);
      const projectedFailure =
        ticket.extensionErrorMessage ?? ticket.projector.errorMessage;
      if (projectedFailure) throw new Error(projectedFailure);
      if (isCancelling(ticket) || ticket.projector.aborted) {
        outcome = "aborted";
      }
    } catch (error) {
      if (isCancelling(ticket) || this.activeRun !== ticket) {
        outcome = "aborted";
      } else {
        outcome = "failed";
        failure = error;
      }
    }

    if (failure !== undefined) this.emitError(failure, ticket.id);
    await this.settleRun(ticket, outcome);
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
    ticket.abortPromise = Promise.resolve().then(() => this.session.abort());
    return ticket.abortPromise;
  }

  private abortCurrentRun(): Promise<void> {
    const ticket = this.activeRun;
    return ticket ? this.cancelRun(ticket) : Promise.resolve();
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    const ticket = this.activeRun;
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
        mode: this.projectRuns.isRestrictionPending(this.project.cwd)
          ? "read_only"
          : mostRestrictiveToolMode(
              ticket.toolMode,
              this.project.toolMode,
            ),
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

  private emitSessionEvent(ticket: RunTicket, event: SessionEvent): void {
    this.emit({
      type: "session_event",
      conversationId: this.conversationId,
      runId: ticket.id,
      event,
    });
  }

  private emitActivity(): void {
    this.emit({
      type: "activity",
      conversationId: this.conversationId,
      activity: cloneActivity(this.getActivity()),
    });
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
}
