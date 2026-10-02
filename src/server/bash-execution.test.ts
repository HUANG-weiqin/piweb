import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BashBackgroundTaskRegistry,
  BashCleanupUnconfirmedError,
  BashExecutionBudget,
  createBashExecutionBinding,
  type BashExecutionOwner,
  type BashTaskCompletion,
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
    backgroundTasks?: BashBackgroundTaskRegistry;
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
    backgroundTasks: options.backgroundTasks,
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
    { exitCode: null, error: /terminated without an exit code/ },
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
      .rejects.toThrow(/Full output:.*terminated without an exit code/s);
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

  it.each(["run_end", "abort"] as const)("keeps registry-owned tasks after %s and across binding replacement", async (closeReason) => {
    const completion = deferred<{ exitCode: number | null }>();
    const completions: BashTaskCompletion[] = [];
    const observed: string[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: (taskId) => observed.push(taskId),
    });
    const budget = new BashExecutionBudget();
    const owner = Object.freeze({ conversationId: "conversation-a", runId: `old-${closeReason}` });
    let executionSignal: AbortSignal | undefined;
    let replacementCalls = 0;
    const old = makeFixture(async (command, _cwd, options) => {
      executionSignal = options.signal;
      options.onData(Buffer.from(`${"你".repeat(400)}:${command}:old`));
      return completion.promise;
    }, { owner, budget, backgroundTasks: registry, base: simpleBase });
    const command = "你".repeat(100);
    const started = await invoke(old.tool("bash"), {
      command,
      run_in_background: true,
    });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;

    await old.binding.lifecycle.close(owner, closeReason);
    await old.binding.lifecycle.dispose();
    expect(executionSignal?.aborted).toBe(false);

    const nextOwner = Object.freeze({ conversationId: owner.conversationId, runId: "new-run" });
    const next = makeFixture(async () => {
      replacementCalls++;
      return { exitCode: 0 };
    }, {
      owner: nextOwner,
      budget,
      conversationKey: `cwd\0${owner.conversationId}`,
      backgroundTasks: registry,
      base: simpleBase,
    });
    const snapshot = await invoke(next.tool("bash_output"), { task_id: taskId, block: false });
    expect((bashDetails(snapshot).piwebBash as { state: string }).state).toBe("in_progress");

    completion.resolve({ exitCode: 0 });
    // Let the task settle unobserved so its completion is reported before the read.
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const firstResult = await invoke(next.tool("bash_output"), { task_id: taskId, timeout: 1000 });
    const nativeText = resultText(firstResult);
    expect(nativeText).toContain(`${"你".repeat(400)}:${command}:old`);
    expect(replacementCalls).toBe(0);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      taskId,
      command: "你".repeat(85),
      status: "completed",
      exitCode: 0,
    });
    expect(Buffer.byteLength(completions[0]!.outputTail, "utf8")).toBeLessThanOrEqual(1024);
    expect(completions[0]!.outputTail.endsWith(":old")).toBe(true);
    expect(Number.isInteger(completions[0]!.durationMs)).toBe(true);
    expect(completions[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(observed).toEqual([taskId]);

    (firstResult.content[0] as { text?: string }).text = "extension mutation";
    const secondResult = await invoke(next.tool("bash_output"), { task_id: taskId, block: false });
    expect(resultText(secondResult)).toBe(nativeText);
    expect(observed).toEqual([taskId]);
    expect(registry.activity()).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
  });

  it("moves a foreground native wait into the conversation registry when guidance is accepted", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    const completed: BashTaskCompletion[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completed.push(task),
      onObserved: () => {},
    });
    const taggedBase = (prefix: string, factories: { count: number }) =>
      (operations: BashOperations): ToolDefinition<any, any, any> => {
        factories.count++;
        return {
          ...simpleBase(operations),
          async execute(_toolCallId, input: FakeBaseInput, signal, onUpdate) {
            const output: Buffer[] = [];
            await operations.exec(input.command, cwd, {
              onData: (data) => {
                output.push(Buffer.from(data));
                onUpdate?.({
                  content: [{ type: "text", text: Buffer.concat(output).toString("utf8") }],
                  details: { source: prefix },
                });
              },
              signal,
              timeout: input.timeout,
              env: process.env,
            });
            return { content: [{ type: "text", text: `${prefix}:${input.command}:${Buffer.concat(output).toString("utf8")}` }], details: { source: prefix } };
          },
        };
      };
    const oldBaseFactories = { count: 0 };
    const nextBaseFactories = { count: 0 };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let nativeStarts = 0;
    let command = "";
    let nativeCwd = "";
    let nativeTimeout: number | undefined;
    let executionSignal: AbortSignal | undefined;
    let emitOutput!: (data: Buffer) => void;
    const updates: unknown[] = [];
    const old = makeFixture(async (receivedCommand, receivedCwd, options) => {
      nativeStarts++;
      command = receivedCommand;
      nativeCwd = receivedCwd;
      nativeTimeout = options.timeout;
      executionSignal = options.signal;
      emitOutput = options.onData;
      markStarted();
      return completion.promise;
    }, { backgroundTasks: registry, base: taggedBase("old-prefix", oldBaseFactories) });
    const foreground = invoke(old.tool("bash"), { command: "long-foreground", timeout: 300_000 }, undefined, (update) => updates.push(update));
    try {
      await started;
      expect(old.binding.lifecycle.promoteForeground(Object.freeze({
        conversationId: old.owner.conversationId,
        runId: old.owner.runId,
      }))).toBe(0);
      emitOutput(Buffer.from("early output"));
      expect(updates).toHaveLength(1);
      expect(old.binding.lifecycle.promoteForeground(old.owner)).toBe(1);
      emitOutput(Buffer.from("late output"));
      expect(updates).toHaveLength(1);

      const handoff = await foreground;
      const handoffText = resultText(handoff);
      expect(handoffText).toContain("moved to background because a new message was accepted");
      expect(handoffText).toContain("completion notification");
      expect(handoffText).toContain("do not poll");
      const taskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;
      expect(registry.summaries()).toMatchObject([{ taskId, state: "in_progress" }]);

      await old.binding.lifecycle.close(old.owner, "run_end");
      expect(executionSignal?.aborted).toBe(false);
      expect(nativeStarts).toBe(1);
      expect(command).toBe("long-foreground");
      expect(nativeCwd).toBe(cwd);
      expect(nativeTimeout).toBe(300);
      expect(oldBaseFactories.count).toBe(2);

      let replacementStarts = 0;
      const nextOwner = Object.freeze({ conversationId: old.owner.conversationId, runId: "replacement-run" });
      const next = makeFixture(async () => {
        replacementStarts++;
        return { exitCode: 0 };
      }, {
        owner: nextOwner,
        backgroundTasks: registry,
        base: taggedBase("new-prefix", nextBaseFactories),
      });
      completion.resolve({ exitCode: 0 });
      await vi.waitFor(() => expect(completed).toHaveLength(1));
      const final = await invoke(next.tool("bash_output"), { task_id: taskId });
      expect(resultText(final)).toContain("old-prefix:long-foreground");
      expect(resultText(final)).not.toContain("new-prefix");
      expect(replacementStarts).toBe(0);
      expect(nextBaseFactories.count).toBe(1);
      expect(completed).toMatchObject([{ taskId, status: "completed", exitCode: 0 }]);
    } finally {
      completion.resolve({ exitCode: 0 });
      await foreground.catch(() => {});
      await registry.close("dispose");
    }
  });

  it("returns zero without a conversation registry and leaves the foreground result unchanged", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fixture = makeFixture(async () => {
      markStarted();
      return completion.promise;
    }, { base: simpleBase });
    const foreground = invoke(fixture.tool("bash"), { command: "standalone-foreground" });
    try {
      await started;
      expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(0);
      completion.resolve({ exitCode: 0 });
      const result = await foreground;
      expect(resultText(result)).toContain("(no output)");
      expect(bashDetails(result).piwebBash).toBeUndefined();
    } finally {
      completion.resolve({ exitCode: 0 });
      await foreground.catch(() => {});
    }
  });

  it.each(["promotion-first", "settlement-first"] as const)(
    "does not double-publish when foreground settlement races promotion (%s)",
    async (order) => {
      const completion = deferred<{ exitCode: number | null }>();
      const completed: BashTaskCompletion[] = [];
      let markCompleted!: () => void;
      const completedSignal = new Promise<void>((resolve) => { markCompleted = resolve; });
      const registry = new BashBackgroundTaskRegistry({
        onCompleted: (task) => {
          completed.push(task);
          markCompleted();
        },
        onObserved: () => {},
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const fixture = makeFixture(async () => {
        markStarted();
        return completion.promise;
      }, { backgroundTasks: registry, base: simpleBase });
      const foreground = invoke(fixture.tool("bash"), { command: `race-${order}` });
      try {
        await started;
        if (order === "settlement-first") {
          completion.resolve({ exitCode: 0 });
          await completion.promise;
          for (let turn = 0; turn < 12; turn++) await Promise.resolve();
          expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(0);
          const nativeResult = await foreground;
          expect(resultText(nativeResult)).toContain("(no output)");
          expect(bashDetails(nativeResult).piwebBash).toBeUndefined();
          expect(registry.summaries()).toEqual([]);
          expect(completed).toEqual([]);
        } else {
          completion.resolve({ exitCode: 0 });
          expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(1);
          const handoff = await foreground;
          const taskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;
          await completedSignal;
          expect(completed).toMatchObject([{ taskId, status: "completed", exitCode: 0 }]);
          expect(resultText(await invoke(fixture.tool("bash_output"), { task_id: taskId })))
            .toContain("(no output)");
          expect(completed).toHaveLength(1);
        }
      } finally {
        completion.resolve({ exitCode: 0 });
        await foreground.catch(() => {});
        await registry.close("dispose");
      }
    },
  );

  it("uses registry-backed bash_stop and bash_output for a promoted task", async () => {
    vi.useFakeTimers();
    const completion = deferred<{ exitCode: number | null }>();
    const completed: BashTaskCompletion[] = [];
    const observed: string[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completed.push(task),
      onObserved: (taskId) => observed.push(taskId),
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let executionSignal: AbortSignal | undefined;
    const fixture = makeFixture(async (_command, _cwd, options) => {
      executionSignal = options.signal;
      markStarted();
      return completion.promise;
    }, { backgroundTasks: registry, base: simpleBase });
    const foreground = invoke(fixture.tool("bash"), { command: "promote-then-stop" });
    try {
      await started;
      expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(1);
      const handoff = await foreground;
      const taskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;
      const stopping = invoke(fixture.tool("bash_stop"), { task_id: taskId });
      await vi.advanceTimersByTimeAsync(1000);
      const stopped = await stopping;
      expect((bashDetails(stopped).piwebBash as { state: string }).state).toBe("stopping");
      expect(executionSignal?.aborted).toBe(true);

      completion.resolve({ exitCode: 0 });
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      const final = await invoke(fixture.tool("bash_output"), { task_id: taskId });
      expect(resultText(final)).toContain("(no output)");
      expect(completed).toMatchObject([{ taskId, status: "killed", stopReason: "manual", exitCode: 0 }]);
      expect(observed).toEqual([taskId]);
    } finally {
      completion.resolve({ exitCode: 0 });
      await foreground.catch(() => {});
      await registry.close("dispose");
    }
  });

  it("keeps the original native timeout deadline after foreground promotion", async () => {
    vi.useFakeTimers();
    const completion = deferred<{ exitCode: number | null }>();
    const completed: BashTaskCompletion[] = [];
    let markCompleted!: () => void;
    const nativeCompleted = new Promise<void>((resolve) => { markCompleted = resolve; });
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => {
        completed.push(task);
        markCompleted();
      },
      onObserved: () => {},
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let executionSignal: AbortSignal | undefined;
    let nativeTimeout: number | undefined;
    let nativeStarts = 0;
    const fixture = makeFixture(async (_command, _cwd, options) => {
      nativeStarts++;
      executionSignal = options.signal;
      nativeTimeout = options.timeout;
      markStarted();
      return completion.promise;
    }, { backgroundTasks: registry, base: simpleBase });
    const foreground = invoke(fixture.tool("bash"), { command: "deadline", timeout: 10_000 });
    try {
      await started;
      expect(nativeTimeout).toBe(10);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(executionSignal?.aborted).toBe(false);
      expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(1);
      const handoff = await foreground;
      const taskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;

      await vi.advanceTimersByTimeAsync(3_999);
      expect(executionSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(executionSignal?.aborted).toBe(true);
      expect(registry.activity()).toEqual({ running: 0, stopping: 1, cleanupUnknown: false });
      expect(nativeStarts).toBe(1);

      completion.resolve({ exitCode: 0 });
      await nativeCompleted;
      expect(completed).toMatchObject([{ taskId, status: "killed", stopReason: "timeout", exitCode: 0 }]);
      await expect(invoke(fixture.tool("bash_output"), { task_id: taskId }))
        .rejects.toThrow(/timeout:10/);
    } finally {
      completion.resolve({ exitCode: 0 });
      await foreground.catch(() => {});
      await registry.close("dispose");
    }
  });

  it("leaves foreground waiting when background slots and record retention are both full", async () => {
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    const registry = new BashBackgroundTaskRegistry({ onCompleted: () => {}, onObserved: () => {} });
    const fixture = makeFixture(async (command) => {
      if (command.startsWith("history-")) return { exitCode: 0 };
      const next = deferred<{ exitCode: number | null }>();
      pending.push(next);
      return next.promise;
    }, { backgroundTasks: registry, base: simpleBase });
    const taskIds: string[] = [];
    for (let index = 0; index < 60; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `history-${index}`, run_in_background: true });
      taskIds.push((bashDetails(handle).piwebBash as { taskId: string }).taskId);
      for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    }
    for (let index = 0; index < 4; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `running-${index}`, run_in_background: true });
      taskIds.push((bashDetails(handle).piwebBash as { taskId: string }).taskId);
    }
    const foreground = invoke(fixture.tool("bash"), { command: "wait-for-capacity" });
    for (let turn = 0; turn < 8 && pending.length < 5; turn++) await Promise.resolve();
    expect(pending).toHaveLength(5);
    let foregroundSettled = false;
    void foreground.then(() => { foregroundSettled = true; }, () => { foregroundSettled = true; });

    try {
      expect(registry.summaries()).toHaveLength(64);
      expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(0);
      await Promise.resolve();
      expect(foregroundSettled).toBe(false);

      pending[0]!.resolve({ exitCode: 0 });
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      await invoke(fixture.tool("bash_output"), { task_id: taskIds[60] });
      expect(registry.summaries()).toHaveLength(64);
      expect(fixture.binding.lifecycle.promoteForeground(fixture.owner)).toBe(1);
      const handoff = await foreground;
      const promotedTaskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;
      expect(registry.summaries()).toHaveLength(64);
      expect(registry.summaries().some((summary) => summary.taskId === taskIds[60])).toBe(false);
      expect(registry.summaries().some((summary) => summary.taskId === promotedTaskId)).toBe(true);
    } finally {
      pending.forEach((execution) => execution.resolve({ exitCode: 0 }));
      await Promise.all(pending.map((execution) => execution.promise));
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      await registry.close("dispose");
      await foreground.catch(() => {});
    }
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

  it("keeps four conversation background slots separate from four foreground slots per run", async () => {
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    let markEightStarted!: () => void;
    const eightStarted = new Promise<void>((resolve) => { markEightStarted = resolve; });
    const registry = new BashBackgroundTaskRegistry({ onCompleted: () => {}, onObserved: () => {} });
    const fixture = makeFixture(async () => {
      const next = deferred<{ exitCode: number | null }>();
      pending.push(next);
      if (pending.length === 8) markEightStarted();
      return next.promise;
    }, { backgroundTasks: registry, base: simpleBase });

    const foreground = Array.from({ length: 4 }, (_, index) =>
      invoke(fixture.tool("bash"), { command: `foreground-${index}` }));
    for (let index = 0; index < 20 && pending.length < 4; index++) await Promise.resolve();
    expect(pending).toHaveLength(4);
    for (let index = 0; index < 4; index++) {
      await invoke(fixture.tool("bash"), { command: `background-${index}`, run_in_background: true });
    }
    await eightStarted;
    expect(registry.activity()).toEqual({ running: 4, stopping: 0, cleanupUnknown: false });
    await expect(invoke(fixture.tool("bash"), { command: "fifth-background", run_in_background: true }))
      .rejects.toThrow(/4 unsettled background Bash tasks/);
    await expect(invoke(fixture.tool("bash"), { command: "fifth-foreground" }))
      .rejects.toThrow(/4 unsettled Bash executions/);

    pending.forEach((execution) => execution.resolve({ exitCode: 0 }));
    await Promise.all(foreground);
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(registry.activity()).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
  });

  it("evicts only observed or SDK-notified conversation task records in FIFO order", async () => {
    const registry = new BashBackgroundTaskRegistry({ onCompleted: () => {}, onObserved: () => {} });
    const fixture = makeFixture(async () => ({ exitCode: 0 }), {
      backgroundTasks: registry,
      base: simpleBase,
    });
    const taskIds: string[] = [];
    for (let index = 0; index < 64; index++) {
      const started = await invoke(fixture.tool("bash"), {
        command: `task-${index}`,
        run_in_background: true,
      });
      taskIds.push((bashDetails(started).piwebBash as { taskId: string }).taskId);
      for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    }
    expect(registry.summaries()).toHaveLength(64);
    await expect(invoke(fixture.tool("bash"), { command: "overflow", run_in_background: true }))
      .rejects.toThrow(/64 Bash task record limit/);

    await invoke(fixture.tool("bash_output"), { task_id: taskIds[0] });
    registry.markNotified([taskIds[1]!]);
    const observedReplacement = await invoke(fixture.tool("bash"), { command: "observed-eviction", run_in_background: true });
    const observedReplacementId = (bashDetails(observedReplacement).piwebBash as { taskId: string }).taskId;
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(registry.summaries()).toHaveLength(64);
    expect(registry.summaries().some((summary) => summary.taskId === observedReplacementId)).toBe(true);
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskIds[0], block: false }))
      .rejects.toThrow(/not available in this conversation/);

    const notifiedReplacement = await invoke(fixture.tool("bash"), { command: "notified-eviction", run_in_background: true });
    const notifiedReplacementId = (bashDetails(notifiedReplacement).piwebBash as { taskId: string }).taskId;
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(registry.summaries().some((summary) => summary.taskId === notifiedReplacementId)).toBe(true);
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskIds[1], block: false }))
      .rejects.toThrow(/not available in this conversation/);
  });

  it("retains registry cleanup_unknown and runtime quota until an unresponsive native task settles", async () => {
    vi.useFakeTimers();
    const completion = deferred<{ exitCode: number | null }>();
    const completed: BashTaskCompletion[] = [];
    const budget = new BashExecutionBudget();
    const owner = Object.freeze({ conversationId: "conversation-a", runId: "closing-run" });
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => {
        completed.push(task);
        throw new Error("notification callback failed");
      },
      onObserved: () => {},
    });
    let executionSignal: AbortSignal | undefined;
    let markForegroundStarted!: () => void;
    const foregroundStarted = new Promise<void>((resolve) => { markForegroundStarted = resolve; });
    const foregroundCompletion = deferred<{ exitCode: number | null }>();
    const original = makeFixture(async (command, _cwd, options) => {
      if (command === "ignore-abort") {
        executionSignal = options.signal;
        return completion.promise;
      }
      markForegroundStarted();
      return foregroundCompletion.promise;
    }, { owner, budget, backgroundTasks: registry, base: simpleBase });
    const handle = await invoke(original.tool("bash"), { command: "ignore-abort", run_in_background: true });
    expect(bashDetails(handle).piwebBash).toBeDefined();
    const foreground = invoke(original.tool("bash"), { command: "foreground-wait" });
    await foregroundStarted;

    const closing = registry.close("reload");
    expect(executionSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    const report = await closing;
    expect(report.cleanupUnknown).toBe(true);
    expect(registry.activity()).toEqual({ running: 0, stopping: 1, cleanupUnknown: true });
    expect(report.executions[0]).toMatchObject({ state: "stopping", stopReason: "reload" });
    let foregroundSettled = false;
    void foreground.then(() => { foregroundSettled = true; }, () => { foregroundSettled = true; });
    expect(original.binding.lifecycle.promoteForeground(owner)).toBe(0);
    await Promise.resolve();
    expect(foregroundSettled).toBe(false);

    const replacementOwner = Object.freeze({ conversationId: owner.conversationId, runId: "after-reload" });
    const replacement = makeFixture(async () => ({ exitCode: 0 }), {
      owner: replacementOwner,
      budget,
      conversationKey: `cwd\0${owner.conversationId}`,
      base: simpleBase,
    });
    await expect(invoke(replacement.tool("bash"), { command: "must-wait" }))
      .rejects.toThrow(/previous Bash execution/);

    completion.resolve({ exitCode: 0 });
    const afterLateSettlement = await registry.close("reload");
    expect(afterLateSettlement.cleanupUnknown).toBe(false);
    expect(registry.activity()).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "killed", stopReason: "reload", exitCode: 0 });
    foregroundCompletion.resolve({ exitCode: 0 });
    expect(resultText(await foreground)).toContain("(no output)");
    await original.binding.lifecycle.close(owner, "run_end");
    const result = await invoke(replacement.tool("bash"), { command: "budget-released" });
    expect(resultText(result)).toContain("(no output)");
  });

  it("omits oversized native outputFile metadata without fabricating a truncated path", async () => {
    const longPath = `C:\\${"p".repeat(300)}`;
    const completions: BashTaskCompletion[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: () => {},
    });
    const fixture = makeFixture(async () => ({ exitCode: 0 }), {
      backgroundTasks: registry,
      base: (operations) => ({
        ...simpleBase(operations),
        async execute(_toolCallId, input: FakeBaseInput, signal) {
          await operations.exec(input.command, cwd, {
            onData: () => {},
            signal,
            timeout: input.timeout,
            env: process.env,
          });
          return { content: [{ type: "text", text: "native result" }], details: { fullOutputPath: longPath } };
        },
      }),
    });
    const started = await invoke(fixture.tool("bash"), { command: "large-output-file", run_in_background: true });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    const final = await invoke(fixture.tool("bash_output"), { task_id: taskId });
    const summary = bashDetails(final).piwebBash as { outputFile?: string };
    expect(completions).toMatchObject([{ taskId, status: "completed" }]);
    expect(completions[0]?.outputFile).toBeUndefined();
    expect(summary.outputFile).toBeUndefined();
    expect(bashDetails(final).fullOutputPath).toBe(longPath);
  });

  it("classifies post-exit formatter failures as failed and observes a final result once", async () => {
    const completions: BashTaskCompletion[] = [];
    const observed: string[] = [];
    let markCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { markCompleted = resolve; });
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => {
        completions.push(task);
        markCompleted();
      },
      onObserved: (taskId) => {
        observed.push(taskId);
        throw new Error("observation callback failed");
      },
    });
    const fixture = makeFixture(async () => ({ exitCode: 0 }), {
      backgroundTasks: registry,
      base: (operations) => ({
        ...simpleBase(operations),
        async execute(_toolCallId, input: FakeBaseInput, signal) {
          await operations.exec(input.command, cwd, {
            onData: () => {},
            signal,
            timeout: input.timeout,
            env: process.env,
          });
          throw new Error("native formatter failed after exit");
        },
      }),
    });
    const started = await invoke(fixture.tool("bash"), { command: "formatted-failure", run_in_background: true });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;
    await completed;
    expect(completions).toMatchObject([{
      taskId,
      status: "failed",
      exitCode: 0,
    }]);

    await expect(invoke(fixture.tool("bash_stop"), { task_id: taskId })).rejects.toThrow(/native formatter failed/);
    expect(observed).toEqual([taskId]);
    await expect(invoke(fixture.tool("bash_output"), { task_id: taskId })).rejects.toThrow(/native formatter failed/);
    expect(observed).toEqual([taskId]);
  });

  it("runs background tasks without a default timeout but honors an explicit one", async () => {
    const timeouts: Array<number | undefined> = [];
    const fixture = makeFixture(async (_command, _cwd, options) => {
      timeouts.push(options.timeout);
      return { exitCode: 0 };
    }, { base: simpleBase });
    await invoke(fixture.tool("bash"), { command: "unbounded", run_in_background: true });
    await invoke(fixture.tool("bash"), { command: "bounded", run_in_background: true, timeout: 600_000 });
    await invoke(fixture.tool("bash"), { command: "foreground" });
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(timeouts).toEqual([undefined, 600, 120]);
  });

  it("does not report a completion that a waiting bash_output returns itself", async () => {
    const completions: BashTaskCompletion[] = [];
    const observed: string[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: (taskId) => observed.push(taskId),
    });
    const completion = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => completion.promise, { backgroundTasks: registry, base: simpleBase });
    const started = await invoke(fixture.tool("bash"), { command: "awaited", run_in_background: true });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;

    const waiting = invoke(fixture.tool("bash_output"), { task_id: taskId });
    completion.resolve({ exitCode: 0 });
    expect(resultText(await waiting)).toBe("(no output)");
    expect(observed).toEqual([taskId]);
    expect(completions).toEqual([]);
  });

  it("reports a completion after a waiting bash_output times out first", async () => {
    vi.useFakeTimers();
    const completions: BashTaskCompletion[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: () => {},
    });
    const completion = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => completion.promise, { backgroundTasks: registry, base: simpleBase });
    const started = await invoke(fixture.tool("bash"), { command: "slow", run_in_background: true });
    const taskId = (bashDetails(started).piwebBash as { taskId: string }).taskId;

    const waiting = invoke(fixture.tool("bash_output"), { task_id: taskId, timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(resultText(await waiting)).toContain("in_progress");
    completion.resolve({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(completions).toMatchObject([{ taskId, status: "completed" }]);
  });

  it("does not notify a stop whose final result bash_stop returned, but notifies one still stopping", async () => {
    vi.useFakeTimers();
    const completions: BashTaskCompletion[] = [];
    const registry = new BashBackgroundTaskRegistry({
      onCompleted: (task) => completions.push(task),
      onObserved: () => {},
    });
    const lateExit = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture((command, _cwd, options) => {
      if (command === "late") return lateExit.promise;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
      });
    }, { backgroundTasks: registry, base: simpleBase });

    const prompt = await invoke(fixture.tool("bash"), { command: "prompt", run_in_background: true });
    const promptId = (bashDetails(prompt).piwebBash as { taskId: string }).taskId;
    const promptStop = expect(invoke(fixture.tool("bash_stop"), { task_id: promptId })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    await promptStop;
    expect(completions).toEqual([]);

    const late = await invoke(fixture.tool("bash"), { command: "late", run_in_background: true });
    const lateId = (bashDetails(late).piwebBash as { taskId: string }).taskId;
    const lateStop = invoke(fixture.tool("bash_stop"), { task_id: lateId });
    await vi.advanceTimersByTimeAsync(1000);
    expect((bashDetails(await lateStop).piwebBash as { state: string }).state).toBe("stopping");
    lateExit.resolve({ exitCode: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(completions).toMatchObject([{ taskId: lateId, status: "killed", stopReason: "manual" }]);
  });

  it("enforces the runtime-shared limit of 32 unsettled executions", async () => {
    const budget = new BashExecutionBudget();
    const registries: BashBackgroundTaskRegistry[] = [];
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    let promotionFixture: ReturnType<typeof makeFixture> | undefined;
    for (let conversation = 0; conversation < 8; conversation++) {
      const owner = Object.freeze({ conversationId: `conversation-${conversation}`, runId: `run-${conversation}` });
      const registry = new BashBackgroundTaskRegistry({ onCompleted: () => {}, onObserved: () => {} });
      const fixture = makeFixture(async () => {
        const next = deferred<{ exitCode: number | null }>();
        pending.push(next);
        return next.promise;
      }, {
        owner,
        conversationKey: `cwd\\0${owner.conversationId}`,
        budget,
        backgroundTasks: registry,
        base: simpleBase,
      });
      registries.push(registry);
      if (conversation === 7) promotionFixture = fixture;
      const backgroundCount = conversation === 7 ? 3 : 4;
      for (let index = 0; index < backgroundCount; index++) {
        await invoke(fixture.tool("bash"), { command: `hold-${index}`, run_in_background: true });
      }
    }
    expect(pending).toHaveLength(31);
    const foreground = invoke(promotionFixture!.tool("bash"), { command: "promoted-hold" });
    for (let turn = 0; turn < 8 && pending.length < 32; turn++) await Promise.resolve();
    expect(pending).toHaveLength(32);
    expect(promotionFixture!.binding.lifecycle.promoteForeground(promotionFixture!.owner)).toBe(1);
    const handoff = await foreground;
    const promotedTaskId = (bashDetails(handoff).piwebBash as { taskId: string }).taskId;
    expect(registries[7]!.summaries().some((summary) =>
      summary.taskId === promotedTaskId && summary.state === "in_progress"))
      .toBe(true);

    const overflowOwner = Object.freeze({ conversationId: "conversation-overflow", runId: "run-overflow" });
    const overflow = makeFixture(async () => ({ exitCode: 0 }), {
      owner: overflowOwner,
      conversationKey: `cwd\\0${overflowOwner.conversationId}`,
      budget,
      backgroundTasks: new BashBackgroundTaskRegistry({ onCompleted: () => {}, onObserved: () => {} }),
    });
    await expect(invoke(overflow.tool("bash"), { command: "overflow", run_in_background: true }))
      .rejects.toThrow(/runtime Bash execution limit/);
    expect(pending).toHaveLength(32);

    pending.forEach((execution) => execution.resolve({ exitCode: 0 }));
    await Promise.all(pending.map((execution) => execution.promise));
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    await Promise.all(registries.map((registry) => registry.close("dispose")));
  });

  it("kills a foreground command exactly at the 120000ms default timeout", async () => {
    vi.useFakeTimers();
    let executionSignal: AbortSignal | undefined;
    let nativeTimeout: number | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fixture = makeFixture((_command, _cwd, options) => new Promise((resolve) => {
      executionSignal = options.signal;
      nativeTimeout = options.timeout;
      markStarted();
      options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
    }), { base: simpleBase });
    const pending = invoke(fixture.tool("bash"), { command: "default-timeout" });
    const rejected = expect(pending).rejects.toThrow(/timeout:120/);
    await started;
    expect(nativeTimeout).toBe(120);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(executionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(executionSignal?.aborted).toBe(true);
    await rejected;
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
