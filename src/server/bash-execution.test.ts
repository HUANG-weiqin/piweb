import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BashCleanupUnconfirmedError,
  BashExecutionBudget,
  createBashExecutionBinding,
  type BashExecutionOwner,
} from "./bash-execution.js";

const cwd = process.cwd();
const testContext = {
  cwd,
  model: undefined,
  thinkingLevel: undefined,
  sessionManager: {
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
} as never;
const nativeBase = (operations: BashOperations) => createBashToolDefinition(cwd, { operations });

type FakeBaseInput = { command: string; timeout?: number };

function simpleBase(operations: BashOperations): ToolDefinition<any, any, any> {
  return {
    name: "bash",
    label: "bash",
    description: "Test Bash",
    parameters: Type.Object({
      command: Type.String(),
      timeout: Type.Optional(Type.Number()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, rawInput: FakeBaseInput, signal, onUpdate) {
      const output: Buffer[] = [];
      const result = await operations.exec(rawInput.command, cwd, {
        onData: (data) => {
          output.push(Buffer.from(data));
          onUpdate?.({
            content: [{ type: "text", text: Buffer.concat(output).toString("utf8") }],
            details: { source: "fake-pi" },
          });
        },
        signal,
        timeout: rawInput.timeout,
        env: process.env,
      });
      if (result.exitCode === null) throw new Error("unknown exit code");
      if (result.exitCode !== 0) throw new Error(`Command exited with code ${result.exitCode}`);
      return {
        content: [{ type: "text", text: Buffer.concat(output).toString("utf8") || "(no output)" }],
        details: { source: "fake-pi" },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeFixture(
  exec: BashOperations["exec"],
  options: {
    owner?: BashExecutionOwner;
    conversationKey?: string;
    budget?: BashExecutionBudget;
    base?: (operations: BashOperations) => ToolDefinition<any, any, any>;
    onChange?: (owner: BashExecutionOwner) => void;
  } = {},
) {
  const owner = options.owner ?? Object.freeze({ conversationId: "conversation-a", runId: "run-a" });
  let currentOwner: BashExecutionOwner | undefined = owner;
  const operations: BashOperations = { exec };
  const budget = options.budget ?? new BashExecutionBudget();
  const binding = createBashExecutionBinding({
    getOwner: () => currentOwner,
    conversationKey: options.conversationKey ?? `cwd\0${owner.conversationId}`,
    budget,
    operations,
    createBaseTool: options.base ?? nativeBase,
    onChange: options.onChange,
  });
  const tool = (name: string) => {
    const found = binding.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing tool: ${name}`);
    return found;
  };
  return {
    binding,
    budget,
    owner,
    setOwner(next: BashExecutionOwner | undefined) { currentOwner = next; },
    tool,
  };
}

let callCounter = 0;
function invoke(
  tool: ToolDefinition<any, any, any>,
  input: unknown,
  signal?: AbortSignal,
  onUpdate?: (update: unknown) => void,
) {
  return tool.execute(
    `bash-call-${++callCounter}`,
    input as never,
    signal,
    onUpdate as never,
    testContext,
  );
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function bashDetails(result: { details?: unknown }): Record<string, unknown> {
  return (result.details as Record<string, unknown> | undefined) ?? {};
}

describe("run-scoped Bash execution", () => {
  afterEach(() => vi.useRealTimers());

  it("starts a background task, keeps later Pi updates private, and output-wait cancellation does not stop execution", async () => {
    const result = deferred<{ exitCode: number | null }>();
    let emit!: (data: Buffer) => void;
    let executionSignal: AbortSignal | undefined;
    const updates: unknown[] = [];
    const fixture = makeFixture(
      async (_command, _cwd, options) => {
        executionSignal = options.signal;
        emit = options.onData;
        options.onData(Buffer.from("first"));
        return result.promise;
      },
      {
        base: (operations) => ({
          ...simpleBase(operations),
          async execute(_id, input: FakeBaseInput, signal, onUpdate) {
            onUpdate?.({ content: [], details: undefined });
            return operations.exec(input.command, cwd, {
              onData: (data) => onUpdate?.({
                content: [{ type: "text", text: data.toString("utf8") }],
                details: { fullOutputPath: "native-output.txt" },
              }),
              signal,
              timeout: input.timeout,
              env: process.env,
            }).then(() => ({ content: [{ type: "text", text: "final" }], details: { fullOutputPath: "native-output.txt" } }));
          },
        }),
      },
    );

    const handle = await invoke(fixture.tool("bash"), { command: "hold", run_in_background: true }, undefined, (update) => updates.push(update));
    const handleInfo = bashDetails(handle).piwebBash as { executionId: string; taskId: string; state: string };
    expect(handleInfo.state).toBe("in_progress");
    expect(resultText(handle)).toContain(`task_id: ${handleInfo.taskId}`);
    const updatesAtStart = updates.length;

    emit(Buffer.from(`late-output${"x".repeat(4096)}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toHaveLength(updatesAtStart);
    expect(executionSignal?.aborted).toBe(false);

    const pollAbort = new AbortController();
    const poll = invoke(fixture.tool("bash_output"), { task_id: handleInfo.taskId, timeout: 5000 }, pollAbort.signal);
    pollAbort.abort();
    const snapshot = await poll;
    expect(resultText(snapshot)).toContain("late-output");
    expect(Buffer.byteLength(resultText(snapshot), "utf8")).toBeLessThanOrEqual(1024);
    expect(executionSignal?.aborted).toBe(false);

    result.resolve({ exitCode: 0 });
    const final = await invoke(fixture.tool("bash_output"), { task_id: handleInfo.taskId, timeout: 1000 });
    expect(resultText(final)).toBe("final");
    expect(bashDetails(final).fullOutputPath).toBe("native-output.txt");
    expect((bashDetails(final).piwebBash as { exitCode: number }).exitCode).toBe(0);
  });

  it.each([
    { exitCode: 2, error: /Command exited with code 2/ },
    { exitCode: null, error: /without a known exit code/ },
  ])("keeps native failures explicit for exitCode $exitCode", async ({ exitCode, error }) => {
    const fixture = makeFixture(async () => ({ exitCode }));
    await expect(invoke(fixture.tool("bash"), { command: "fail" })).rejects.toThrow(error);
  });

  it("exports the typed cleanup-unconfirmed signal and keeps Pi output references on unknown exits", async () => {
    const cleanupError = new BashCleanupUnconfirmedError();
    expect(cleanupError.name).toBe("BashCleanupUnconfirmedError");
    expect(cleanupError.message).toBe("Bash cleanup is unconfirmed; automatic execution and safe reload are stopped");

    const fixture = makeFixture(async (_command, _cwd, options) => {
      options.onData(Buffer.alloc(64 * 1024, 0x78));
      return { exitCode: null };
    });
    await expect(invoke(fixture.tool("bash"), { command: "unknown-exit" }))
      .rejects.toThrow(/without a known exit code.*Full output:/s);
  });

  it("preserves a stop/exit race as the observed native result", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    let executionSignal: AbortSignal | undefined;
    const fixture = makeFixture(async (_command, _cwd, options) => {
      executionSignal = options.signal;
      return completion.promise;
    });
    const handle = await invoke(fixture.tool("bash"), { command: "race", run_in_background: true });
    const taskId = (bashDetails(handle).piwebBash as { taskId: string }).taskId;
    const stopping = invoke(fixture.tool("bash_stop"), { task_id: taskId });
    expect(executionSignal?.aborted).toBe(true);
    completion.resolve({ exitCode: 0 });
    const final = await stopping;
    expect((bashDetails(final).piwebBash as { state: string; stopReason: string; exitCode: number })).toMatchObject({
      state: "finished",
      stopReason: "manual",
      exitCode: 0,
    });
  });

  it("keeps the hard timeout deadline through a nonblocking snapshot and reports Pi's native timeout error", async () => {
    vi.useFakeTimers();
    let executionSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fixture = makeFixture((_command, _cwd, options) => new Promise((resolve) => {
      executionSignal = options.signal;
      markStarted();
      options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
    }));
    const handle = await invoke(fixture.tool("bash"), { command: "timed", timeout: 60, run_in_background: true });
    const taskId = (bashDetails(handle).piwebBash as { taskId: string }).taskId;
    await started;

    await vi.advanceTimersByTimeAsync(55);
    const poll = await invoke(fixture.tool("bash_output"), { task_id: taskId, block: false });
    expect(resultText(poll)).toContain("in_progress");
    expect(executionSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5);
    expect(executionSignal?.aborted).toBe(true);
    const rowsResult = await invoke(fixture.tool("bash_output"), {});
    const executions = (bashDetails(rowsResult).piwebBash as { tasks: Array<{ stopReason?: string; state: string }> }).tasks;
    expect(executions[0]).toMatchObject({ state: "finished", stopReason: "timeout" });
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskId, block: false }))
      .rejects.toThrow(/Command timed out after 0\.06 seconds/);
  });

  it("rejects foreign or expired task_ids and discards fast foreground records", async () => {
    const pending = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => pending.promise);
    const handle = await invoke(fixture.tool("bash"), { command: "hold", run_in_background: true });
    const taskId = (bashDetails(handle).piwebBash as { taskId: string }).taskId;
    fixture.setOwner(Object.freeze({ conversationId: "conversation-a", runId: "run-a" }));
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskId, block: false })).rejects.toThrow(/not available in this run/);

    const closing = fixture.binding.lifecycle.close(fixture.owner, "run_end");
    pending.resolve({ exitCode: 0 });
    await closing;

    const fast = makeFixture(async () => ({ exitCode: 0 }));
    for (let index = 0; index < 65; index++) {
      const native = await invoke(fast.tool("bash"), { command: "fast" });
      expect(bashDetails(native).piwebBash).toBeUndefined();
    }
    await expect(invoke(fast.tool("bash_output"), { task_id: "expired-handle", block: false })).rejects.toThrow(/not available in this run/);
  });

  it("enforces four unsettled executions per run and refuses to drop unobserved task records at 64", async () => {
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    let launchCount = 0;
    const fixture = makeFixture(async () => {
      launchCount++;
      if (launchCount > 4) return { exitCode: 0 };
      const next = deferred<{ exitCode: number | null }>();
      pending.push(next);
      return next.promise;
    }, { base: simpleBase });
    const taskIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `hold-${index}`, run_in_background: true });
      taskIds.push((bashDetails(handle).piwebBash as { taskId: string }).taskId);
    }
    await expect(invoke(fixture.tool("bash"), { command: "fifth", run_in_background: true })).rejects.toThrow(/4 unsettled/);
    expect(pending).toHaveLength(4);
    pending.forEach((item) => item.resolve({ exitCode: 0 }));
    await Promise.all(pending.map((item) => item.promise));
    for (let index = 0; index < 8; index++) await Promise.resolve();

    for (let index = 4; index < 64; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `task-${index}`, run_in_background: true });
      taskIds.push((bashDetails(handle).piwebBash as { taskId: string }).taskId);
    }
    expect(taskIds).toHaveLength(64);
    const listing = await invoke(fixture.tool("bash_output"), {});
    const rows = (bashDetails(listing).piwebBash as { tasks: unknown[] }).tasks;
    expect(rows).toHaveLength(64);
    expect(resultText(listing)).toContain(`"task_id":"${taskIds[0]}"`);
    await expect(invoke(fixture.tool("bash"), { command: "overflow", run_in_background: true }))
      .rejects.toThrow(/64 Bash task record limit/);
    expect(launchCount).toBe(64);

    const firstTaskId = taskIds[0]!;
    await invoke(fixture.tool("bash_output"), { task_id: firstTaskId });
    const replacement = await invoke(fixture.tool("bash"), { command: "replace-observed", run_in_background: true });
    const replacementTaskId = (bashDetails(replacement).piwebBash as { taskId: string }).taskId;
    const afterEviction = await invoke(fixture.tool("bash_output"), {});
    const remainingTasks = (bashDetails(afterEviction).piwebBash as { tasks: Array<{ taskId: string }> }).tasks;
    expect(remainingTasks).toHaveLength(64);
    expect(remainingTasks.some((task) => task.taskId === replacementTaskId)).toBe(true);
    await expect(invoke(fixture.tool("bash_output"), { task_id: firstTaskId, block: false }))
      .rejects.toThrow(/not available in this run/);
    expect(launchCount).toBe(65);
  });

  it("bounds raw output before Pi forwarding and marks the resulting final record partial", async () => {
    const forwardedBytes: number[] = [];
    const floodBase = (operations: BashOperations): ToolDefinition<any, any, any> => ({
      ...simpleBase(operations),
      async execute(_toolCallId, input: FakeBaseInput, signal) {
        let received = 0;
        try {
          const result = await operations.exec(input.command, cwd, {
            onData: (data) => { received += data.byteLength; },
            signal,
            timeout: input.timeout,
            env: process.env,
          });
          return { content: [{ type: "text", text: `exit ${result.exitCode}` }], details: {} };
        } finally {
          forwardedBytes.push(received);
        }
      },
    });
    const fixture = makeFixture(async (_command, _cwd, options) => {
      options.onData(Buffer.alloc(16 * 1024 * 1024 + 32, 0x78));
      if (options.signal?.aborted) throw new Error("aborted");
      return { exitCode: 0 };
    }, { base: floodBase });
    const handle = await invoke(fixture.tool("bash"), { command: "flood", run_in_background: true });
    const taskId = (bashDetails(handle).piwebBash as { taskId: string }).taskId;
    const listing = await invoke(fixture.tool("bash_output"), {});
    const executions = (bashDetails(listing).piwebBash as { tasks: Array<{ partial?: boolean; stopReason?: string }> }).tasks;
    expect(forwardedBytes).toEqual([16 * 1024 * 1024]);
    expect(executions[0]).toMatchObject({ partial: true, stopReason: "output_limit" });
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskId, block: false })).rejects.toThrow(/partial output.*must not be treated/);
  });

  it("keeps close-timeout quota until late settlement and blocks same-conversation replacement", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ exitCode: number | null }>();
    const oldChanges: BashExecutionOwner[] = [];
    const budget = new BashExecutionBudget();
    const old = makeFixture(async () => pending.promise, {
      budget,
      onChange: (owner) => oldChanges.push(owner),
      base: simpleBase,
    });
    const handle = await invoke(old.tool("bash"), { command: "unkillable", run_in_background: true });
    const close = old.binding.lifecycle.close(old.owner, "run_end");
    await vi.advanceTimersByTimeAsync(2000);
    const report = await close;
    expect(report.cleanupUnknown).toBe(true);
    expect(report.executions[0]?.state).toBe("stopping");
    expect(old.binding.lifecycle.activity(old.owner)).toEqual({ running: 0, stopping: 1, cleanupUnknown: true });

    const replacementOwner = Object.freeze({ conversationId: old.owner.conversationId, runId: "replacement-run" });
    const replacement = makeFixture(async () => ({ exitCode: 0 }), {
      owner: replacementOwner,
      budget,
      conversationKey: `cwd\0${replacementOwner.conversationId}`,
      base: simpleBase,
    });
    await expect(invoke(replacement.tool("bash"), { command: "blocked" })).rejects.toThrow(/previous Bash execution/);

    pending.resolve({ exitCode: 0 });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(old.binding.lifecycle.activity(old.owner)).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
    expect(oldChanges.every((owner) => owner === old.owner)).toBe(true);
    const replacementResult = await invoke(replacement.tool("bash"), { command: "allowed" });
    expect(resultText(replacementResult)).toContain("(no output)");
    expect(oldChanges.every((owner) => owner === old.owner)).toBe(true);
    expect(bashDetails(handle).piwebBash).toBeDefined();
  });

  it("cancels a foreground tool wait promptly while bounded close retains an unresponsive native execution", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ exitCode: number | null }>();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let emitLateOutput!: (data: Buffer) => void;
    const updates: unknown[] = [];
    const budget = new BashExecutionBudget();
    const old = makeFixture(async (_command, _cwd, options) => {
      emitLateOutput = options.onData;
      markStarted();
      return pending.promise;
    }, { budget, base: simpleBase });
    const sdkAbort = new AbortController();
    const foreground = invoke(old.tool("bash"), { command: "ignores-abort" }, sdkAbort.signal, (update) => updates.push(update));
    const foregroundOutcome = foreground.then(() => "returned", () => "cancelled");
    await started;
    sdkAbort.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(await foregroundOutcome).toBe("cancelled");
    const updatesAtCancellation = updates.length;
    emitLateOutput(Buffer.from("late foreground output"));
    expect(updates).toHaveLength(updatesAtCancellation);
    expect(old.binding.lifecycle.activity(old.owner)).toEqual({ running: 1, stopping: 0, cleanupUnknown: false });
    const listing = await invoke(old.tool("bash_output"), {});
    expect((bashDetails(listing).piwebBash as { tasks: unknown[] }).tasks).toHaveLength(0);

    const close = old.binding.lifecycle.close(old.owner, "abort");
    await vi.advanceTimersByTimeAsync(2000);
    const report = await close;
    expect(report.cleanupUnknown).toBe(true);
    expect(old.binding.lifecycle.activity(old.owner)).toEqual({ running: 0, stopping: 1, cleanupUnknown: true });

    const replacementOwner = Object.freeze({ conversationId: old.owner.conversationId, runId: "after-abort" });
    const replacement = makeFixture(async () => ({ exitCode: 0 }), {
      owner: replacementOwner,
      budget,
      conversationKey: `cwd\0${replacementOwner.conversationId}`,
      base: simpleBase,
    });
    await expect(invoke(replacement.tool("bash"), { command: "blocked" })).rejects.toThrow(/previous Bash execution/);

    pending.resolve({ exitCode: 0 });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    const result = await invoke(replacement.tool("bash"), { command: "released" });
    expect(resultText(result)).toContain("(no output)");
  });

  it("rejects a pre-aborted SDK call before admitting or starting native work", async () => {
    let calls = 0;
    const fixture = makeFixture(async () => {
      calls++;
      return { exitCode: 0 };
    });
    const signal = new AbortController();
    signal.abort();
    await expect(invoke(fixture.tool("bash"), { command: "must-not-start" }, signal.signal))
      .rejects.toThrow(/cancelled before admission/);
    await expect(invoke(fixture.tool("bash"), { command: "legacy-yield", yieldMs: 1 }))
      .rejects.toThrow(/Invalid bash input/);
    await expect(invoke(fixture.tool("bash"), { command: "bad-timeout", timeout: 0 }))
      .rejects.toThrow(/Invalid bash input/);
    await expect(invoke(fixture.tool("bash"), { command: "fractional-timeout", timeout: 1.5 }))
      .rejects.toThrow(/Invalid bash input/);
    await expect(invoke(fixture.tool("bash"), { command: "excessive-timeout", timeout: 600001 }))
      .rejects.toThrow(/Invalid bash input/);
    expect(calls).toBe(0);
  });

  it("enforces the runtime-shared limit of 32 unsettled executions", async () => {
    const budget = new BashExecutionBudget();
    const fixtures = [] as ReturnType<typeof makeFixture>[];
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    for (let conversation = 0; conversation < 8; conversation++) {
      const owner = Object.freeze({ conversationId: `conversation-${conversation}`, runId: `run-${conversation}` });
      const fixture = makeFixture(async () => {
        const next = deferred<{ exitCode: number | null }>();
        pending.push(next);
        return next.promise;
      }, { owner, conversationKey: `cwd\\0${owner.conversationId}`, budget, base: simpleBase });
      fixtures.push(fixture);
      for (let index = 0; index < 4; index++) {
        await invoke(fixture.tool("bash"), { command: `hold-${index}`, run_in_background: true });
      }
    }
    const overflowOwner = Object.freeze({ conversationId: "conversation-overflow", runId: "run-overflow" });
    const overflow = makeFixture(async () => ({ exitCode: 0 }), {
      owner: overflowOwner,
      conversationKey: `cwd\\0${overflowOwner.conversationId}`,
      budget,
    });
    await expect(invoke(overflow.tool("bash"), { command: "overflow", run_in_background: true }))
      .rejects.toThrow(/runtime Bash execution limit/);
    expect(pending).toHaveLength(32);

    const closing = fixtures.map((fixture) => fixture.binding.lifecycle.close(fixture.owner, "run_end"));
    pending.forEach((execution) => execution.resolve({ exitCode: 0 }));
    await Promise.all(closing);
  });

  it("waits in the foreground and passes the default millisecond timeout as Pi seconds", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => { started = resolve; });
    let nativeTimeout: number | undefined;
    const fixture = makeFixture(async (_command, _cwd, options) => {
      nativeTimeout = options.timeout;
      started();
      return completion.promise;
    });

    const pending = invoke(fixture.tool("bash"), { command: "foreground" });
    let finished = false;
    void pending.finally(() => { finished = true; });
    await operationStarted;
    try {
      expect(nativeTimeout).toBe(120);
      expect(finished).toBe(false);
    } finally {
      completion.resolve({ exitCode: 0 });
    }
    const result = await pending;
    expect(resultText(result)).toBe("(no output)");
    expect(bashDetails(result).piwebBash).toBeUndefined();

    let maximumTimeout: number | undefined;
    const maximum = makeFixture(async (_command, _cwd, options) => {
      maximumTimeout = options.timeout;
      return { exitCode: 0 };
    });
    await invoke(maximum.tool("bash"), { command: "maximum", timeout: 600000 });
    expect(maximumTimeout).toBe(600);
  });

  it("publishes an explicit background task_id and exposes bash_output", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => completion.promise);
    const bash = fixture.tool("bash");
    expect(bash.description).toContain("default 120000; maximum 600000");
    expect(bash.description).not.toMatch(/timeout in seconds/i);
    const started = await invoke(bash, { command: "background", run_in_background: true });
    const details = bashDetails(started).piwebBash as { taskId: string; executionId: string };
    expect(details.taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(details.taskId).toBe(details.executionId);
    expect(resultText(started)).toContain(`task_id: ${details.taskId}`);
    expect(resultText(started)).not.toMatch(/notification|notify|wake/i);
    expect(fixture.binding.tools.some((tool) => tool.name === "bash_poll")).toBe(false);

    const snapshot = await invoke(fixture.tool("bash_output"), { task_id: details.taskId, block: false });
    expect((bashDetails(snapshot).piwebBash as { taskId: string; state: string }).taskId).toBe(details.taskId);
    expect((bashDetails(snapshot).piwebBash as { state: string }).state).toBe("in_progress");
    await expect(invoke(fixture.tool("bash_output"), { block: true })).rejects.toThrow(/immediate task listing/);
    await expect(invoke(fixture.tool("bash_output"), { timeout: 1 })).rejects.toThrow(/immediate task listing/);
    completion.resolve({ exitCode: 0 });
    const final = await invoke(fixture.tool("bash_output"), { task_id: details.taskId });
    expect(resultText(final)).toBe("(no output)");
    const stopped = await invoke(fixture.tool("bash_stop"), { task_id: details.taskId });
    expect(resultText(stopped)).toBe("(no output)");
  });

  it("bash_output blocks for 30000ms by default and accepts a 600000ms maximum timeout", async () => {
    vi.useFakeTimers();
    const completion = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => completion.promise);
    const started = await invoke(fixture.tool("bash"), { command: "waiting", run_in_background: true });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;
    const pending = invoke(fixture.tool("bash_output"), { task_id: taskId });
    let settled = false;
    void pending.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(29999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const snapshot = await pending;
      expect(resultText(snapshot)).toContain("in_progress");
      await expect(invoke(fixture.tool("bash_output"), { task_id: taskId, timeout: 600001 }))
        .rejects.toThrow(/Invalid bash_output input/);
      completion.resolve({ exitCode: 0 });
      const final = await invoke(fixture.tool("bash_output"), { task_id: taskId, timeout: 600000 });
      expect(resultText(final)).toBe("(no output)");
    } finally {
      completion.resolve({ exitCode: 0 });
    }
  });

  it("runs a short command through the native Pi Bash formatter", async () => {
    const fixture = makeFixture(createLocalBashOperations().exec);
    const result = await invoke(fixture.tool("bash"), {
      command: "printf 'piweb-native-format'",
    });
    expect(resultText(result)).toContain("piweb-native-format");
    expect(bashDetails(result).piwebBash).toBeUndefined();
  });
});
