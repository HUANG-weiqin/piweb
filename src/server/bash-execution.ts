import { randomUUID } from "node:crypto";
import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ConversationBashTask } from "../shared/protocol.js";

export interface BashExecutionOwner {
  readonly conversationId: string;
  readonly runId: string;
}

export class BashCleanupUnconfirmedError extends Error {
  constructor() {
    super("Bash cleanup is unconfirmed; automatic execution and safe reload are stopped");
    this.name = "BashCleanupUnconfirmedError";
  }
}

export type BashExecutionStopReason =
  | "manual"
  | "timeout"
  | "output_limit"
  | "run_end"
  | "abort"
  | "reload"
  | "dispose";

export interface BashExecutionSummary {
  executionId: string;
  taskId: string;
  state: "in_progress" | "stopping" | "finished";
  exitCode?: number | null;
  stopReason?: BashExecutionStopReason;
  error?: string;
  outputFile?: string;
  partial?: boolean;
}

export interface BashExecutionActivity {
  running: number;
  stopping: number;
  cleanupUnknown: boolean;
}

export type BashTaskCompletion = ConversationBashTask & { outputTail: string };

export interface BashExecutionLifecycle {
  requestStop(owner: BashExecutionOwner, reason: BashExecutionStopReason): void;
  close(
    owner: BashExecutionOwner,
    reason: BashExecutionStopReason,
  ): Promise<{ executions: BashExecutionSummary[]; cleanupUnknown: boolean }>;
  dispose(): Promise<{ executions: BashExecutionSummary[]; cleanupUnknown: boolean }>;
  activity(owner: BashExecutionOwner): BashExecutionActivity;
  promoteForeground(owner: BashExecutionOwner): number;
}

export interface BashExecutionBinding {
  tools: ToolDefinition<any, any, any>[];
  lifecycle: BashExecutionLifecycle;
}

interface BudgetReservation {
  readonly conversationKey: string;
  retired: boolean;
  released: boolean;
}

/** Runtime-shared budget for real, not-yet-settled executions. */
export class BashExecutionBudget {
  private readonly reservations = new Set<BudgetReservation>();

  reserve(conversationKey: string): {
    retire(): void;
    release(): void;
  } {
    if (this.reservations.size >= MAX_RUNTIME_EXECUTIONS) {
      throw new Error("The runtime Bash execution limit has been reached");
    }
    for (const reservation of this.reservations) {
      if (reservation.conversationKey === conversationKey && reservation.retired) {
        throw new Error("A previous Bash execution for this conversation is still stopping");
      }
    }

    const reservation: BudgetReservation = {
      conversationKey,
      retired: false,
      released: false,
    };
    this.reservations.add(reservation);
    return {
      retire: () => {
        if (!reservation.released) reservation.retired = true;
      },
      release: () => {
        if (reservation.released) return;
        reservation.released = true;
        this.reservations.delete(reservation);
      },
    };
  }
}

const MAX_RUNTIME_EXECUTIONS = 32;
const MAX_RUN_EXECUTIONS = 4;
const MAX_BACKGROUND_EXECUTIONS = 4;
const MAX_TASK_RECORDS = 64;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024;
const MAX_SUMMARY_FIELD_BYTES = 256;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TIMEOUT_MS = 600_000;
const STOP_WAIT_MS = 1000;
const CLOSE_WAIT_MS = 2000;

const bashParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS, description: "Timeout in milliseconds (foreground default 120000; maximum 600000). Background tasks have no timeout unless one is given." })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return a task_id immediately instead of waiting for completion" })),
}, { additionalProperties: false });

const outputParameters = Type.Object({
  task_id: Type.Optional(Type.String({ minLength: 1 })),
  block: Type.Optional(Type.Boolean()),
  timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OUTPUT_TIMEOUT_MS, description: "Maximum wait in milliseconds (default 30000)" })),
}, { additionalProperties: false });

const stopParameters = Type.Object({
  task_id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

type BashInput = Static<typeof bashParameters>;
type OutputInput = Static<typeof outputParameters>;
type StopInput = Static<typeof stopParameters>;
type NativeResult = AgentToolResult<unknown>;
type NativeError = { error: Error };
type ExecutionOutcome = { result: NativeResult } | NativeError;
type ToolUpdate = Parameters<NonNullable<AgentToolUpdateCallback<unknown>>>[0];

interface ExecutionScope {
  readonly owner: BashExecutionOwner;
  readonly executions: Map<string, ExecutionRecord>;
  readonly published: Set<string>;
  admissionClosed: boolean;
  cleanupUnknown: boolean;
  closeCallers: number;
}

interface ExecutionRecord {
  readonly executionId: string;
  readonly owner: BashExecutionOwner;
  scope?: ExecutionScope;
  backgroundRegistry?: BashBackgroundTaskRegistry;
  readonly controller: AbortController;
  readonly budgetReservation: ReturnType<BashExecutionBudget["reserve"]>;
  readonly command: string;
  readonly startedAt: bigint;
  settled: Promise<void>;
  settlement?: ExecutionOutcome;
  exitCode?: number | null;
  stopReason?: BashExecutionStopReason;
  error?: string;
  partial: boolean;
  updatesForwarded: boolean;
  latestUpdate?: ToolUpdate;
  outputFile?: string;
  outputBytes: number;
  outputTail: Buffer;
  observed: boolean;
  notified: boolean;
  /** Active bash_output/bash_stop waits that may return this task's final result. */
  observers: number;
  /** Completion held while an observer may still return the final result itself. */
  deferredCompletion?: BashTaskCompletion;
  published: boolean;
  promoted: boolean;
  foregroundWaiting: boolean;
  resolveForegroundHandoff?: () => void;
  notifyChange: () => void;
}

function assertInput<T>(schema: unknown, input: unknown, name: string): asserts input is T {
  if (!Check(schema as never, input)) throw new Error(`Invalid ${name} input`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safeErrorText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const message = value instanceof Error ? value.message : String(value);
  return boundedUtf8(message, MAX_SUMMARY_FIELD_BYTES);
}

function boundedUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end > 0; end--) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // A byte boundary can split one UTF-8 code point; move to its start.
    }
  }
  return "";
}

function boundedUtf8Tail(bytes: Buffer, maxBytes: number): string {
  let text = bytes.toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    const firstCodePoint = text.codePointAt(0);
    text = text.slice(firstCodePoint !== undefined && firstCodePoint > 0xffff ? 2 : 1);
  }
  return text;
}

function cloneDetails(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi Bash returned non-object details");
  }
  return structuredClone(value) as Record<string, unknown>;
}

function withExecutionDetails<T extends { details?: unknown }>(
  value: T,
  summary: BashExecutionSummary,
): T & { details: Record<string, unknown> } {
  return {
    ...value,
    details: { ...cloneDetails(value.details), piwebBash: summary },
  };
}

function updateSnapshot(update: ToolUpdate): ToolUpdate {
  return structuredClone(update);
}

function updateText(update: ToolUpdate | undefined): string {
  if (!update) return "";
  return update.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function statusText(summary: BashExecutionSummary): string {
  const identifier = `task_id: ${summary.taskId}`;
  const reason = summary.stopReason ? `; stop requested: ${summary.stopReason}` : "";
  return `Bash task ${identifier} is ${summary.state}${reason}. It has not produced a final result.`;
}

function summaryFor(record: ExecutionRecord): BashExecutionSummary {
  const summary: BashExecutionSummary = {
    executionId: record.executionId,
    taskId: record.executionId,
    state: record.settlement ? "finished" : record.stopReason ? "stopping" : "in_progress",
  };
  if (record.exitCode !== undefined) summary.exitCode = record.exitCode;
  if (record.stopReason !== undefined) summary.stopReason = record.stopReason;
  if (record.error !== undefined) summary.error = boundedUtf8(record.error, MAX_SUMMARY_FIELD_BYTES);
  if (record.outputFile !== undefined) summary.outputFile = record.outputFile;
  if (record.partial) summary.partial = true;
  return summary;
}

function nonterminalResult(record: ExecutionRecord): NativeResult {
  const summary = summaryFor(record);
  const status = statusText(summary);
  const previewLabel = "\nLatest output preview (non-consuming):\n";
  const previewBudget = Math.max(
    0,
    MAX_PREVIEW_BYTES - Buffer.byteLength(status) - Buffer.byteLength(previewLabel),
  );
  const preview = boundedUtf8(updateText(record.latestUpdate), previewBudget);
  const text = preview ? `${status}${previewLabel}${preview}` : status;
  const nativeDetails = record.latestUpdate?.details;
  return {
    content: [{ type: "text", text }],
    details: { ...cloneDetails(nativeDetails), piwebBash: summary },
  } as NativeResult;
}

function nativeOutputText(result: NativeResult): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function executionFailure(record: ExecutionRecord, diagnostic: string, nativeText: string): Error {
  const parts = [diagnostic];
  if (nativeText) parts.push(nativeText);
  if (record.outputFile && !nativeText.includes(record.outputFile)) {
    parts.push(`Full output: ${record.outputFile}`);
  }
  return new Error(parts.join("\n\n"));
}

function settledResult(record: ExecutionRecord): NativeResult {
  const outcome = record.settlement;
  if (!outcome) throw new Error("Bash execution is not finished");
  const partial = record.partial || record.stopReason === "output_limit";
  if (partial) {
    const nativeText = "error" in outcome ? outcome.error.message : nativeOutputText(outcome.result);
    throw executionFailure(
      record,
      "Bash output exceeded the 16 MiB capture limit. This is partial output and must not be treated as a successful command result.",
      nativeText,
    );
  }
  if ("error" in outcome) throw outcome.error;
  if (record.exitCode === undefined || record.exitCode === null) {
    throw executionFailure(
      record,
      "Bash execution finished without a known exit code; success is unproven.",
      nativeOutputText(outcome.result),
    );
  }
  if (record.exitCode !== 0) {
    throw executionFailure(
      record,
      `Command exited with code ${record.exitCode}.`,
      nativeOutputText(outcome.result),
    );
  }
  return record.published
    ? withExecutionDetails(structuredClone(outcome.result), summaryFor(record)) as NativeResult
    : outcome.result;
}

function executionText(summaries: BashExecutionSummary[], ownerScope: "run" | "conversation"): string {
  if (summaries.length === 0) return `No background Bash tasks have been published for this ${ownerScope}.`;
  const fullText = summaries.map(({ executionId: _executionId, taskId, ...summary }) =>
    JSON.stringify({ task_id: taskId, ...summary }),
  ).join("\n");
  const marker = "\n[Text listing truncated; structured execution rows are complete.]";
  const textLimit = 48 * 1024;
  if (Buffer.byteLength(fullText) <= textLimit) return fullText;
  return `${boundedUtf8(fullText, textLimit - Buffer.byteLength(marker))}${marker}`;
}

function waitForRecord(
  record: ExecutionRecord,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (record.settlement || waitMs === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, waitMs);
    signal?.addEventListener("abort", finish, { once: true });
    void record.settled.then(finish);
  });
}

function unsettledRecords(records: Iterable<ExecutionRecord>): ExecutionRecord[] {
  return [...records].filter((record) => !record.settlement);
}

function requestStopRecord(record: ExecutionRecord, reason: BashExecutionStopReason): void {
  if (record.settlement || record.stopReason) return;
  record.stopReason = reason;
  record.controller.abort();
  record.notifyChange();
}

function taskCompletion(record: ExecutionRecord): BashTaskCompletion {
  // Registry records are never in run_end/abort scopes; their stop reasons match the shared DTO.
  const outcome = record.settlement;
  const partial = record.partial || record.stopReason === "output_limit";
  const killed = record.stopReason !== undefined;
  const completed = !killed
    && !partial
    && outcome !== undefined
    && "result" in outcome
    && record.exitCode === 0;
  const completion: BashTaskCompletion = {
    taskId: record.executionId,
    command: record.command,
    status: killed ? "killed" : completed ? "completed" : "failed",
    exitCode: record.exitCode ?? null,
    durationMs: Math.max(0, Number((process.hrtime.bigint() - record.startedAt) / 1_000_000n)),
    outputTail: boundedUtf8Tail(record.outputTail, MAX_PREVIEW_BYTES),
  };
  if (record.stopReason !== undefined) completion.stopReason = record.stopReason as BashTaskCompletion["stopReason"];
  if (partial) completion.partial = true;
  if (record.outputFile !== undefined) completion.outputFile = record.outputFile;
  return completion;
}

export class BashBackgroundTaskRegistry {
  private readonly records = new Map<string, ExecutionRecord>();
  private admissionClosed = false;
  private cleanupUnknown = false;
  private readonly onChange?: () => void;
  private readonly onCompleted: (task: BashTaskCompletion) => void;
  private readonly onObserved: (taskId: string) => void;

  constructor(options: {
    onChange?: () => void;
    onCompleted: (task: BashTaskCompletion) => void;
    onObserved: (taskId: string) => void;
  }) {
    this.onChange = options.onChange;
    this.onCompleted = options.onCompleted;
    this.onObserved = options.onObserved;
  }

  private changed(): void {
    try {
      this.onChange?.();
    } catch {
      // Activity observers are projections and must not affect execution ownership.
    }
  }

  private activeRecords(): ExecutionRecord[] {
    return unsettledRecords(this.records.values());
  }

  private releaseOldestEligible(): boolean {
    for (const [taskId, record] of this.records) {
      if (record.settlement && (record.observed || record.notified)) {
        this.records.delete(taskId);
        return true;
      }
    }
    return false;
  }

  /** Internal binding admission check; task records are registered synchronously before native start. */
  assertCanStart(): void {
    if (this.admissionClosed) throw new Error("Background Bash task admission is closed for this conversation");
    if (this.activeRecords().length >= MAX_BACKGROUND_EXECUTIONS) {
      throw new Error(`This conversation already has ${MAX_BACKGROUND_EXECUTIONS} unsettled background Bash tasks`);
    }
  }

  private store(record: ExecutionRecord): void {
    record.notifyChange = () => this.changed();
    this.records.set(record.executionId, record);
    this.changed();
  }

  /** Internal binding registration; completed unobserved/unnotified records are never silently evicted. */
  register(record: ExecutionRecord): void {
    if (this.admissionClosed) throw new Error("Background Bash task admission is closed for this conversation");
    if (this.activeRecords().length >= MAX_BACKGROUND_EXECUTIONS) {
      throw new Error(`This conversation already has ${MAX_BACKGROUND_EXECUTIONS} unsettled background Bash tasks`);
    }
    if (this.records.size >= MAX_TASK_RECORDS && !this.releaseOldestEligible()) {
      throw new Error(`This conversation has reached the ${MAX_TASK_RECORDS} Bash task record limit`);
    }
    this.store(record);
  }

  /** Internal atomic admission for a foreground record crossing into this registry. */
  tryPromote(record: ExecutionRecord): boolean {
    if (this.admissionClosed || this.activeRecords().length >= MAX_BACKGROUND_EXECUTIONS) return false;
    if (this.records.size >= MAX_TASK_RECORDS && !this.releaseOldestEligible()) return false;
    record.scope = undefined;
    record.backgroundRegistry = this;
    record.published = true;
    this.store(record);
    return true;
  }

  /** Internal task lookup shared by every runtime binding for this conversation. */
  find(taskId: string): ExecutionRecord | undefined {
    return this.records.get(taskId);
  }

  /** Internal task listing shared by every runtime binding for this conversation. */
  summaries(): BashExecutionSummary[] {
    return [...this.records.values()].map(summaryFor);
  }

  private complete(task: BashTaskCompletion): void {
    try {
      this.onCompleted(task);
    } catch {
      // Actor owns notification error reporting; callback failure must not strand native resources.
    }
  }

  /** Internal completion hook; invocation is exactly once because native settlement is guarded. */
  settled(record: ExecutionRecord): void {
    if (this.records.get(record.executionId) !== record) return;
    const completion = taskCompletion(record);
    // A waiting observer returns this final result itself before any notification
    // is handed to the SDK; notify only if that observer ends without it.
    if (record.observers > 0) record.deferredCompletion = completion;
    else this.complete(completion);
    if (this.cleanupUnknown && this.activeRecords().length === 0) this.cleanupUnknown = false;
    this.changed();
  }

  /** Internal wait bookkeeping for bash_output/bash_stop. */
  observationStarted(record: ExecutionRecord): void {
    record.observers++;
  }

  /** Releases a deferred completion when the last observer ended without observing it. */
  observationEnded(record: ExecutionRecord): void {
    record.observers = Math.max(0, record.observers - 1);
    const completion = record.deferredCompletion;
    if (record.observers > 0 || completion === undefined) return;
    record.deferredCompletion = undefined;
    if (!record.observed) this.complete(completion);
  }

  /** Internal observation hook; bash_output/bash_stop call this after a final result/error is returned. */
  observed(record: ExecutionRecord): void {
    if (record.observed) return;
    record.observed = true;
    try {
      this.onObserved(record.executionId);
    } catch {
      // Observation bookkeeping must not replace the final native result/error.
    }
  }

  activity(): BashExecutionActivity {
    let running = 0;
    let stopping = 0;
    for (const record of this.activeRecords()) {
      if (record.stopReason) stopping++;
      else running++;
    }
    return { running, stopping, cleanupUnknown: this.cleanupUnknown };
  }

  markNotified(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const record = this.records.get(taskId);
      if (record?.settlement) record.notified = true;
    }
  }

  requestStop(reason: "reload" | "dispose"): void {
    this.admissionClosed = true;
    for (const record of this.activeRecords()) {
      record.budgetReservation.retire();
      requestStopRecord(record, reason);
    }
    this.changed();
  }

  async close(
    reason: "reload" | "dispose",
  ): Promise<{ executions: BashExecutionSummary[]; cleanupUnknown: boolean }> {
    this.requestStop(reason);
    const pending = this.activeRecords();
    if (pending.length > 0) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(pending.map((record) => record.settled)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, CLOSE_WAIT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    }
    this.cleanupUnknown = this.activeRecords().length > 0;
    this.changed();
    return { executions: this.summaries(), cleanupUnknown: this.cleanupUnknown };
  }
}

function invokeObserver(observer: ((owner: BashExecutionOwner) => void) | undefined, owner: BashExecutionOwner): void {
  if (!observer) return;
  try {
    observer(owner);
  } catch {
    // Activity observers are projections and must not affect execution ownership.
  }
}

export function createBashExecutionBinding(options: {
  getOwner: () => BashExecutionOwner | undefined;
  conversationKey: string;
  budget: BashExecutionBudget;
  operations: BashOperations;
  createBaseTool: (operations: BashOperations) => ToolDefinition<any, any, any>;
  onChange?: (owner: BashExecutionOwner) => void;
  backgroundTasks?: BashBackgroundTaskRegistry;
}): BashExecutionBinding {
  const scopes = new Map<BashExecutionOwner, ExecutionScope>();
  const closedOwners = new WeakSet<BashExecutionOwner>();
  let disposed = false;

  const getScope = (owner: BashExecutionOwner): ExecutionScope => {
    let scope = scopes.get(owner);
    if (!scope) {
      scope = {
        owner,
        executions: new Map(),
        published: new Set(),
        admissionClosed: closedOwners.has(owner),
        cleanupUnknown: false,
        closeCallers: 0,
      };
      scopes.set(owner, scope);
    }
    return scope;
  };

  const notify = (owner: BashExecutionOwner) => invokeObserver(options.onChange, owner);

  const activeRecords = (scope: ExecutionScope) =>
    [...scope.executions.values()].filter((record) => !record.settlement);

  const removeClosedScopeIfSettled = (scope: ExecutionScope) => {
    if (scope.admissionClosed && scope.closeCallers === 0 && activeRecords(scope).length === 0) {
      scope.published.clear();
      scope.executions.clear();
      scopes.delete(scope.owner);
    }
  };

  const currentOwner = (): BashExecutionOwner => {
    const owner = options.getOwner();
    if (owner === undefined) throw new Error("Bash requires an active run owner");
    return owner;
  };

  const finishRecord = (record: ExecutionRecord, outcome: ExecutionOutcome) => {
    if (record.settlement) return;
    record.settlement = outcome;
    if ("error" in outcome) record.error = safeErrorText(outcome.error);
    else {
      const details = outcome.result.details;
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const fullOutputPath = (details as Record<string, unknown>).fullOutputPath;
        if (typeof fullOutputPath === "string" && Buffer.byteLength(fullOutputPath, "utf8") <= MAX_SUMMARY_FIELD_BYTES) {
          record.outputFile = fullOutputPath;
        }
      }
    }
    record.budgetReservation.release();
    if (record.backgroundRegistry) {
      record.backgroundRegistry.settled(record);
    } else if (record.scope) {
      if (record.scope.cleanupUnknown && activeRecords(record.scope).length === 0) {
        record.scope.cleanupUnknown = false;
      }
      record.notifyChange();
      removeClosedScopeIfSettled(record.scope);
    }
  };

  const recordSummaryRows = (scope: ExecutionScope): BashExecutionSummary[] =>
    [...scope.published]
      .map((executionId) => scope.executions.get(executionId))
      .filter((record): record is ExecutionRecord => record !== undefined)
      .map(summaryFor);

  const releaseOldestObservedTask = (scope: ExecutionScope): boolean => {
    for (const executionId of scope.published) {
      const record = scope.executions.get(executionId);
      if (record?.settlement && record.observed) {
        scope.published.delete(executionId);
        scope.executions.delete(executionId);
        return true;
      }
    }
    return false;
  };

  const launch = (
    owner: BashExecutionOwner,
    scope: ExecutionScope,
    input: BashInput,
    toolCallId: string,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    context: Parameters<ToolDefinition["execute"]>[4],
  ): ExecutionRecord => {
    const background = input.run_in_background === true;
    const backgroundRegistry = background ? options.backgroundTasks : undefined;
    const activeCount = activeRecords(scope).length;
    if (!backgroundRegistry && activeCount >= MAX_RUN_EXECUTIONS) {
      throw new Error(`This run already has ${MAX_RUN_EXECUTIONS} unsettled Bash executions`);
    }
    if (backgroundRegistry) backgroundRegistry.assertCanStart();
    if (scope.admissionClosed || disposed) throw new Error("Bash execution admission is closed for this run");
    // Foreground calls get a default deadline; background tasks run until they exit or are stopped.
    const timeoutMs = input.timeout ?? (background ? undefined : DEFAULT_TIMEOUT_MS);
    const timeoutSeconds = timeoutMs === undefined ? undefined : timeoutMs / 1000;

    const budgetReservation = options.budget.reserve(options.conversationKey);
    if (!backgroundRegistry && background && scope.published.size >= MAX_TASK_RECORDS && !releaseOldestObservedTask(scope)) {
      budgetReservation.release();
      throw new Error(`This run has reached the ${MAX_TASK_RECORDS} Bash task record limit`);
    }
    const record = {
      executionId: randomUUID(),
      owner,
      ...(backgroundRegistry === undefined ? { scope } : { backgroundRegistry }),
      controller: new AbortController(),
      budgetReservation,
      command: boundedUtf8(input.command, MAX_SUMMARY_FIELD_BYTES),
      startedAt: process.hrtime.bigint(),
      settled: Promise.resolve(),
      partial: false,
      updatesForwarded: !background,
      outputBytes: 0,
      outputTail: Buffer.alloc(0),
      observed: false,
      notified: false,
      observers: 0,
      published: background,
      promoted: false,
      foregroundWaiting: false,
      notifyChange: () => notify(owner),
    } satisfies Omit<ExecutionRecord, "settlement" | "exitCode" | "stopReason" | "error" | "latestUpdate" | "outputFile"> & Partial<Pick<ExecutionRecord, "settlement" | "exitCode" | "stopReason" | "error" | "latestUpdate" | "outputFile">> as ExecutionRecord;

    if (backgroundRegistry) {
      try {
        backgroundRegistry.register(record);
      } catch (error) {
        budgetReservation.release();
        throw error;
      }
    } else {
      scope.executions.set(record.executionId, record);
      if (record.published) scope.published.add(record.executionId);
      notify(owner);
    }

    const operations: BashOperations = {
      exec: async (command, cwd, executionOptions) => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (executionOptions.timeout !== undefined) {
          timeoutHandle = setTimeout(() => {
            requestStopRecord(record, "timeout");
          }, executionOptions.timeout * 1000);
        }
        const onData = (data: Buffer) => {
          if (record.settlement) return;
          const suffix = data.byteLength > MAX_PREVIEW_BYTES
            ? data.subarray(data.byteLength - MAX_PREVIEW_BYTES)
            : data;
          const combinedTail = Buffer.concat([record.outputTail, suffix]);
          record.outputTail = combinedTail.subarray(Math.max(0, combinedTail.byteLength - MAX_PREVIEW_BYTES));
          if (record.partial) return;
          const available = MAX_OUTPUT_BYTES - record.outputBytes;
          const acceptedBytes = Math.min(data.byteLength, available);
          if (acceptedBytes > 0) {
            record.outputBytes += acceptedBytes;
            executionOptions.onData(acceptedBytes === data.byteLength ? data : data.subarray(0, acceptedBytes));
          }
          if (data.byteLength > acceptedBytes) {
            record.partial = true;
            requestStopRecord(record, "output_limit");
          }
        };
        try {
          const result = await options.operations.exec(command, cwd, {
            ...executionOptions,
            onData,
            signal: record.controller.signal,
          });
          record.exitCode = result.exitCode;
          if (record.stopReason === "output_limit") throw new Error("aborted");
          if (record.stopReason === "timeout") throw new Error(`timeout:${executionOptions.timeout ?? "unknown"}`);
          return result;
        } catch (error) {
          if (record.stopReason === "output_limit") throw new Error("aborted");
          if (record.stopReason === "timeout") {
            throw new Error(`timeout:${executionOptions.timeout ?? "unknown"}`);
          }
          throw error;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
      },
    };

    const privateUpdate: AgentToolUpdateCallback<unknown> = (update) => {
      const clone = updateSnapshot(update as ToolUpdate);
      record.latestUpdate = clone;
      const details = clone.details;
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const fullOutputPath = (details as Record<string, unknown>).fullOutputPath;
        if (typeof fullOutputPath === "string" && Buffer.byteLength(fullOutputPath, "utf8") <= MAX_SUMMARY_FIELD_BYTES) {
          record.outputFile = fullOutputPath;
        }
      }
      if (record.updatesForwarded) onUpdate?.(structuredClone(clone));
    };

    let execution: Promise<NativeResult>;
    try {
      const baseTool = options.createBaseTool(operations);
      execution = Promise.resolve(baseTool.execute(
        toolCallId,
        { command: input.command, ...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }) } as never,
        record.controller.signal,
        privateUpdate,
        context,
      ));
    } catch (error) {
      execution = Promise.reject(error);
    }
    record.settled = execution.then(
      (result) => finishRecord(record, { result }),
      (error) => finishRecord(record, { error: asError(error) }),
    );
    return record;
  };

  const waitForForegroundSettlement = (
    record: ExecutionRecord,
    signal: AbortSignal | undefined,
  ): Promise<"settled" | "promoted"> => {
    if (record.promoted) return Promise.resolve("promoted");
    if (record.settlement) return Promise.resolve("settled");
    if (signal?.aborted) {
      record.updatesForwarded = false;
      return Promise.reject(new Error("Bash foreground wait was cancelled"));
    }
    record.foregroundWaiting = true;
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        record.foregroundWaiting = false;
        signal?.removeEventListener("abort", cancel);
        if (record.resolveForegroundHandoff === promoted) record.resolveForegroundHandoff = undefined;
      };
      const finish = (outcome: "settled" | "promoted") => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(outcome);
      };
      const cancel = () => {
        if (record.promoted) {
          finish("promoted");
          return;
        }
        record.updatesForwarded = false;
        cleanup();
        if (record.settlement) finish("settled");
        else reject(new Error("Bash foreground wait was cancelled"));
      };
      const promoted = () => finish("promoted");
      record.resolveForegroundHandoff = promoted;
      signal?.addEventListener("abort", cancel, { once: true });
      void record.settled.then(() => finish("settled"));
      if (record.promoted) finish("promoted");
    });
  };

  const runForeground = async (record: ExecutionRecord, signal: AbortSignal | undefined): Promise<NativeResult> => {
    const outcome = await waitForForegroundSettlement(record, signal);
    if (outcome === "promoted" || record.promoted) return backgroundResult(record);
    try {
      return settledResult(record);
    } finally {
      const scope = record.scope;
      if (scope) {
        scope.executions.delete(record.executionId);
        removeClosedScopeIfSettled(scope);
      }
    }
  };

  const observeTask = async (
    record: ExecutionRecord,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<NativeResult> => {
    const registry = record.backgroundRegistry;
    registry?.observationStarted(record);
    try {
      await waitForRecord(record, waitMs, signal);
      if (!record.settlement) return nonterminalResult(record);
      if (registry) registry.observed(record);
      else record.observed = true;
      return settledResult(record);
    } finally {
      registry?.observationEnded(record);
    }
  };

  const findTaskRecord = (owner: BashExecutionOwner, taskId: string): ExecutionRecord => {
    const backgroundRecord = options.backgroundTasks?.find(taskId);
    if (backgroundRecord) return backgroundRecord;
    const scope = scopes.get(owner);
    const record = scope?.executions.get(taskId);
    if (!scope || !record || !scope.published.has(taskId)) {
      throw new Error(`Bash task_id is not available in this ${options.backgroundTasks ? "conversation" : "run"}`);
    }
    return record;
  };

  const backgroundResult = (record: ExecutionRecord): NativeResult => {
    const taskId = record.executionId;
    const summary = summaryFor(record);
    return {
      content: [{
        type: "text",
        text: record.promoted
          ? `Foreground Bash task moved to background because a new message was accepted. task_id: ${taskId}\nA completion notification will be sent; do not poll. Use bash_output({task_id: "${taskId}"}) only when you need the final result.`
          : options.backgroundTasks
            ? `Background Bash task started. task_id: ${taskId}\nThis task belongs to the current conversation and continues across runs. You will receive a completion notification; do not poll. Use bash_output({task_id: "${taskId}"}) to retrieve its result.`
            : `Background Bash task started. task_id: ${taskId}\nUse bash_output({task_id: "${taskId}"}) to wait for or retrieve its result. This task is scoped to the current run.`,
      }],
      details: { piwebBash: summary },
    } as NativeResult;
  };

  const bashTemplate = options.createBaseTool(options.operations);
  const bashTool = defineTool({
    name: bashTemplate.name,
    label: bashTemplate.label,
    description: options.backgroundTasks
      ? "Run a shell command in the current working directory and return native stdout/stderr output and truncation details. The timeout is an integer number of milliseconds (foreground default 120000; maximum 600000). Foreground commands wait for at most 10 minutes. Use run_in_background for long-running or parallel work; background tasks have no timeout unless one is given, belong to this conversation, survive run end/abort/runtime replacement, and produce one completion notification. Do not poll; use bash_output only when you need the final result."
      : "Run a shell command in the current working directory and return native stdout/stderr output and truncation details. The timeout is an integer number of milliseconds (foreground default 120000; maximum 600000). Foreground commands wait until completion. Use run_in_background for parallel work or to avoid blocking; background tasks have no timeout unless one is given, are scoped to the current run, and may be stopped when it ends. Use bash_output to wait for or retrieve their results.",
    promptSnippet: bashTemplate.promptSnippet,
    promptGuidelines: [
      ...(bashTemplate.promptGuidelines ?? []),
      options.backgroundTasks
        ? "Bash timeout is an integer number of milliseconds (foreground default 120000, maximum 600000; background tasks have no default timeout). Foreground calls block; run_in_background creates a conversation-scoped task that completes with a notification, so do not poll."
        : "Bash timeout is an integer number of milliseconds (foreground default 120000, maximum 600000; background tasks have no default timeout). Use run_in_background for parallel work or to avoid blocking. Background tasks are run-scoped; use bash_output to wait for or retrieve their results.",
    ],
    constrainedSampling: bashTemplate.constrainedSampling,
    renderShell: bashTemplate.renderShell,
    renderCall: bashTemplate.renderCall as ToolDefinition<typeof bashParameters>["renderCall"],
    renderResult: bashTemplate.renderResult as ToolDefinition<typeof bashParameters>["renderResult"],
    executionMode: bashTemplate.executionMode,
    parameters: bashParameters,
    async execute(toolCallId, rawInput, signal, onUpdate, context) {
      assertInput<BashInput>(bashParameters, rawInput, "bash");
      if (signal?.aborted) throw new Error("Bash execution was cancelled before admission");
      const owner = currentOwner();
      const scope = getScope(owner);
      const record = launch(owner, scope, rawInput, toolCallId, onUpdate, context);
      return record.published ? backgroundResult(record) : runForeground(record, signal);
    },
  });

  const outputTool = defineTool({
    name: "bash_output",
    label: "Bash output",
    description: options.backgroundTasks
      ? "Wait for or inspect a conversation-scoped background Bash task by task_id. block defaults to true and waits up to 30000 ms (maximum 600000 ms); block:false returns immediately. Without task_id, list this conversation's bounded task records."
      : "Wait for or inspect a run-scoped background Bash task by task_id. block defaults to true and waits up to 30000 ms (maximum 600000 ms); block:false returns immediately. Without task_id, list this run's bounded task records.",
    promptSnippet: options.backgroundTasks
      ? "Completed conversation tasks notify automatically; do not poll. Use bash_output({task_id}) when you need the final result; omit task_id to list conversation tasks."
      : "Use bash_output({task_id}) to wait once for a background result; use block:false for a nonblocking snapshot or omit task_id to list run tasks.",
    promptGuidelines: ["A finished task is not necessarily successful; require a known exitCode of zero and a complete result."],
    parameters: outputParameters,
    async execute(_toolCallId, rawInput, signal) {
      assertInput<OutputInput>(outputParameters, rawInput, "bash_output");
      const owner = currentOwner();
      if (rawInput.task_id === undefined) {
        if (rawInput.block === true || (rawInput.timeout !== undefined && rawInput.timeout > 0)) {
          throw new Error("bash_output without task_id only supports an immediate task listing");
        }
        const scope = scopes.get(owner);
        const rows = options.backgroundTasks?.summaries() ?? (scope ? recordSummaryRows(scope) : []);
        return {
          content: [{ type: "text", text: executionText(rows, options.backgroundTasks ? "conversation" : "run") }],
          details: { piwebBash: { tasks: rows } },
        };
      }
      const record = findTaskRecord(owner, rawInput.task_id);
      const block = rawInput.block ?? true;
      const timeout = rawInput.timeout ?? DEFAULT_OUTPUT_TIMEOUT_MS;
      return observeTask(record, block ? timeout : 0, signal);
    },
  });

  const stopTool = defineTool({
    name: "bash_stop",
    label: "Bash stop",
    description: "Idempotently request termination of one background Bash task by task_id, then wait briefly for the native executor. A stopping response is not a completion result.",
    promptSnippet: "Use bash_stop({task_id}) to request termination of one running background task.",
    promptGuidelines: ["A stopping response means termination is unconfirmed; use bash_output({task_id}) to wait for the final result."],
    parameters: stopParameters,
    async execute(_toolCallId, rawInput, signal) {
      assertInput<StopInput>(stopParameters, rawInput, "bash_stop");
      const owner = currentOwner();
      const record = findTaskRecord(owner, rawInput.task_id);
      requestStopRecord(record, "manual");
      return observeTask(record, STOP_WAIT_MS, signal);
    },
  });

  const requestStop = (owner: BashExecutionOwner, reason: BashExecutionStopReason) => {
    closedOwners.add(owner);
    const scope = scopes.get(owner);
    if (!scope) return;
    scope.admissionClosed = true;
    for (const record of activeRecords(scope)) {
      record.budgetReservation.retire();
      requestStopRecord(record, reason);
    }
  };

  const waitForScopes = async (closingScopes: ExecutionScope[]) => {
    const pending = closingScopes.flatMap(activeRecords);
    if (pending.length === 0) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(pending.map((record) => record.settled)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLOSE_WAIT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  };

  const close = async (owner: BashExecutionOwner, reason: BashExecutionStopReason) => {
    closedOwners.add(owner);
    const scope = getScope(owner);
    scope.closeCallers++;
    requestStop(owner, reason);
    await waitForScopes([scope]);
    const cleanupUnknown = activeRecords(scope).length > 0;
    if (cleanupUnknown && !scope.cleanupUnknown) {
      scope.cleanupUnknown = true;
      notify(owner);
    }
    const executions = recordSummaryRows(scope);
    scope.closeCallers--;
    removeClosedScopeIfSettled(scope);
    return { executions, cleanupUnknown };
  };

  const dispose = async () => {
    if (!disposed) disposed = true;
    const closingScopes = [...scopes.values()];
    for (const scope of closingScopes) {
      closedOwners.add(scope.owner);
      scope.closeCallers++;
      requestStop(scope.owner, "dispose");
    }
    await waitForScopes(closingScopes);
    const cleanupUnknownScopes = closingScopes.filter((scope) => activeRecords(scope).length > 0);
    for (const scope of cleanupUnknownScopes) {
      if (!scope.cleanupUnknown) {
        scope.cleanupUnknown = true;
        notify(scope.owner);
      }
    }
    const executions = closingScopes.flatMap(recordSummaryRows);
    const cleanupUnknown = cleanupUnknownScopes.length > 0;
    for (const scope of closingScopes) {
      scope.closeCallers--;
      removeClosedScopeIfSettled(scope);
    }
    return { executions, cleanupUnknown };
  };

  const promoteForeground = (owner: BashExecutionOwner): number => {
    const registry = options.backgroundTasks;
    const scope = scopes.get(owner);
    if (!registry || !scope || scope.admissionClosed || disposed) return 0;

    let promotedCount = 0;
    for (const record of [...scope.executions.values()]) {
      if (record.scope !== scope
        || record.backgroundRegistry !== undefined
        || record.published
        || record.promoted
        || record.settlement
        || !record.foregroundWaiting) continue;

      const wasForwardingUpdates = record.updatesForwarded;
      scope.executions.delete(record.executionId);
      record.promoted = true;
      record.updatesForwarded = false;
      record.foregroundWaiting = false;
      if (!registry.tryPromote(record)) {
        record.promoted = false;
        record.updatesForwarded = wasForwardingUpdates;
        record.foregroundWaiting = true;
        scope.executions.set(record.executionId, record);
        continue;
      }
      record.resolveForegroundHandoff?.();
      promotedCount++;
    }
    return promotedCount;
  };

  const lifecycle: BashExecutionLifecycle = {
    requestStop,
    close,
    dispose,
    promoteForeground,
    activity(owner) {
      const scope = scopes.get(owner);
      if (!scope) return { running: 0, stopping: 0, cleanupUnknown: false };
      let running = 0;
      let stopping = 0;
      for (const record of activeRecords(scope)) {
        if (record.stopReason) stopping++;
        else running++;
      }
      if (running + stopping > MAX_RUN_EXECUTIONS) {
        throw new Error("Bash execution activity exceeded its run-owned quota");
      }
      return { running, stopping, cleanupUnknown: scope.cleanupUnknown };
    },
  };

  return { tools: [bashTool, outputTool, stopTool], lifecycle };
}
