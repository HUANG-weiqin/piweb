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

export interface BashExecutionLifecycle {
  requestStop(owner: BashExecutionOwner, reason: BashExecutionStopReason): void;
  close(
    owner: BashExecutionOwner,
    reason: BashExecutionStopReason,
  ): Promise<{ executions: BashExecutionSummary[]; cleanupUnknown: boolean }>;
  dispose(): Promise<{ executions: BashExecutionSummary[]; cleanupUnknown: boolean }>;
  activity(owner: BashExecutionOwner): BashExecutionActivity;
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
const MAX_PUBLISHED_HANDLES = 64;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 1024;
const MAX_SUMMARY_FIELD_BYTES = 256;
const MAX_POLL_WAIT_MS = 5000;
const DEFAULT_WAIT_MS = 1000;
const STOP_WAIT_MS = 1000;
const CLOSE_WAIT_MS = 2000;
const MAX_TIMEOUT_MS = 2_147_483_647;

const bashParameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  yieldMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
}, { additionalProperties: false });

const pollParameters = Type.Object({
  executionId: Type.Optional(Type.String({ minLength: 1 })),
  waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
}, { additionalProperties: false });

const stopParameters = Type.Object({
  executionId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

type BashInput = Static<typeof bashParameters>;
type PollInput = Static<typeof pollParameters>;
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
  readonly scope: ExecutionScope;
  readonly controller: AbortController;
  readonly budgetReservation: ReturnType<BashExecutionBudget["reserve"]>;
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
  published: boolean;
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
  const reason = summary.stopReason ? `; stop requested: ${summary.stopReason}` : "";
  return `Bash execution ${summary.executionId} is ${summary.state}${reason}. It has not produced a final result.`;
}

function summaryFor(record: ExecutionRecord): BashExecutionSummary {
  const summary: BashExecutionSummary = {
    executionId: record.executionId,
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
    ? withExecutionDetails(outcome.result, summaryFor(record)) as NativeResult
    : outcome.result;
}

function executionText(summaries: BashExecutionSummary[]): string {
  if (summaries.length === 0) return "No Bash executions have been published for this run.";
  const fullText = summaries.map((summary) => JSON.stringify(summary)).join("\n");
  const marker = "\n[Text listing truncated; structured execution rows are complete.]";
  const textLimit = 48 * 1024;
  if (Buffer.byteLength(fullText) <= textLimit) return fullText;
  return `${boundedUtf8(fullText, textLimit - Buffer.byteLength(marker))}${marker}`;
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > MAX_TIMEOUT_MS) {
    throw new Error("Invalid timeout: must be a finite positive number of seconds within the supported limit");
  }
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

  const requestStopRecord = (record: ExecutionRecord, reason: BashExecutionStopReason) => {
    if (record.settlement || record.stopReason) return;
    record.stopReason = reason;
    record.controller.abort();
    notify(record.owner);
  };

  const finishRecord = (record: ExecutionRecord, outcome: ExecutionOutcome) => {
    if (record.settlement) return;
    record.settlement = outcome;
    if ("error" in outcome) record.error = safeErrorText(outcome.error);
    else {
      const details = outcome.result.details;
      if (details && typeof details === "object" && !Array.isArray(details)) {
        const fullOutputPath = (details as Record<string, unknown>).fullOutputPath;
        if (typeof fullOutputPath === "string") record.outputFile = fullOutputPath;
      }
    }
    record.budgetReservation.release();
    if (record.scope.cleanupUnknown && activeRecords(record.scope).length === 0) {
      record.scope.cleanupUnknown = false;
    }
    notify(record.owner);
    removeClosedScopeIfSettled(record.scope);
  };

  const recordSummaryRows = (scope: ExecutionScope): BashExecutionSummary[] =>
    [...scope.published]
      .map((executionId) => scope.executions.get(executionId))
      .filter((record): record is ExecutionRecord => record !== undefined)
      .map(summaryFor);

  const publish = (record: ExecutionRecord) => {
    if (record.published) return;
    record.published = true;
    record.scope.published.add(record.executionId);
  };

  const launch = (
    owner: BashExecutionOwner,
    scope: ExecutionScope,
    input: BashInput,
    toolCallId: string,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    context: Parameters<ToolDefinition["execute"]>[4],
  ): ExecutionRecord => {
    const activeCount = activeRecords(scope).length;
    if (activeCount >= MAX_RUN_EXECUTIONS) {
      throw new Error(`This run already has ${MAX_RUN_EXECUTIONS} unsettled Bash executions`);
    }
    const unpublishedActive = activeRecords(scope).filter((record) => !record.published).length;
    if (scope.published.size + unpublishedActive >= MAX_PUBLISHED_HANDLES) {
      throw new Error(`This run has reached the ${MAX_PUBLISHED_HANDLES} Bash handle limit`);
    }
    if (scope.admissionClosed || disposed) throw new Error("Bash execution admission is closed for this run");
    validateTimeout(input.timeout);

    const budgetReservation = options.budget.reserve(options.conversationKey);
    const record = {
      executionId: randomUUID(),
      owner,
      scope,
      controller: new AbortController(),
      budgetReservation,
      settled: Promise.resolve(),
      partial: false,
      updatesForwarded: true,
      outputBytes: 0,
      published: false,
    } satisfies Omit<ExecutionRecord, "settlement" | "exitCode" | "stopReason" | "error" | "latestUpdate" | "outputFile"> & Partial<Pick<ExecutionRecord, "settlement" | "exitCode" | "stopReason" | "error" | "latestUpdate" | "outputFile">> as ExecutionRecord;

    scope.executions.set(record.executionId, record);
    notify(owner);

    const operations: BashOperations = {
      exec: async (command, cwd, executionOptions) => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        if (executionOptions.timeout !== undefined) {
          timeoutHandle = setTimeout(() => {
            requestStopRecord(record, "timeout");
          }, executionOptions.timeout * 1000);
        }
        const onData = (data: Buffer) => {
          if (record.settlement || record.partial) return;
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
        if (typeof fullOutputPath === "string") record.outputFile = fullOutputPath;
      }
      if (record.updatesForwarded) onUpdate?.(structuredClone(clone));
    };

    let execution: Promise<NativeResult>;
    try {
      const baseTool = options.createBaseTool(operations);
      execution = Promise.resolve(baseTool.execute(
        toolCallId,
        { command: input.command, ...(input.timeout === undefined ? {} : { timeout: input.timeout }) } as never,
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

  const waitAndReturn = async (
    record: ExecutionRecord,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<NativeResult> => {
    await waitForRecord(record, waitMs, signal);
    if (record.settlement) {
      if (!record.published) {
        record.scope.executions.delete(record.executionId);
        removeClosedScopeIfSettled(record.scope);
      }
      return settledResult(record);
    }
    record.updatesForwarded = false;
    publish(record);
    return nonterminalResult(record);
  };

  const findPublishedRecord = (owner: BashExecutionOwner, executionId: string): ExecutionRecord => {
    const scope = scopes.get(owner);
    const record = scope?.executions.get(executionId);
    if (!record || !scope?.published.has(executionId)) {
      throw new Error("Bash execution handle is not available in this run");
    }
    return record;
  };

  const bashTemplate = options.createBaseTool(options.operations);
  const bashTool = defineTool({
    name: bashTemplate.name,
    label: bashTemplate.label,
    description: `${bashTemplate.description} Long-running commands return an execution handle; use bash_poll to inspect or bash_stop to request termination. A returned handle is not a completed result.`,
    promptSnippet: bashTemplate.promptSnippet,
    promptGuidelines: bashTemplate.promptGuidelines,
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
      const yieldMs = rawInput.yieldMs ?? DEFAULT_WAIT_MS;
      return waitAndReturn(record, yieldMs, signal);
    },
  });

  const pollTool = defineTool({
    name: "bash_poll",
    label: "Bash poll",
    description: "Inspect or wait briefly for a Bash execution published by this exact run. Without executionId, list this run's bounded execution handles. Polling never consumes output or changes command ownership.",
    promptSnippet: "Use bash_poll to inspect a running Bash handle; it does not consume output.",
    promptGuidelines: ["Finished commands still require an explicit successful exit code; a poll response alone is not proof of success."],
    parameters: pollParameters,
    async execute(_toolCallId, rawInput, signal) {
      assertInput<PollInput>(pollParameters, rawInput, "bash_poll");
      const owner = currentOwner();
      if (rawInput.executionId === undefined) {
        if (rawInput.waitMs !== undefined && rawInput.waitMs !== 0) {
          throw new Error("bash_poll without executionId does not accept a wait");
        }
        const scope = scopes.get(owner);
        const rows = scope ? recordSummaryRows(scope) : [];
        return {
          content: [{ type: "text", text: executionText(rows) }],
          details: { piwebBash: { executions: rows } },
        };
      }
      const record = findPublishedRecord(owner, rawInput.executionId);
      return waitAndReturn(record, rawInput.waitMs ?? DEFAULT_WAIT_MS, signal);
    },
  });

  const stopTool = defineTool({
    name: "bash_stop",
    label: "Bash stop",
    description: "Idempotently request termination of one Bash execution published by this exact run, then wait briefly for the native executor. A stopping response is not a completion result.",
    promptSnippet: "Use bash_stop to request termination of one running Bash handle.",
    promptGuidelines: ["A stopping response means termination is unconfirmed; use bash_poll to wait for the final native result."],
    parameters: stopParameters,
    async execute(_toolCallId, rawInput, signal) {
      assertInput<StopInput>(stopParameters, rawInput, "bash_stop");
      const owner = currentOwner();
      const record = findPublishedRecord(owner, rawInput.executionId);
      requestStopRecord(record, "manual");
      return waitAndReturn(record, STOP_WAIT_MS, signal);
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

  const lifecycle: BashExecutionLifecycle = {
    requestStop,
    close,
    dispose,
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

  return { tools: [bashTool, pollTool, stopTool], lifecycle };
}
