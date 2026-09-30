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

  it("yields a live handle, keeps Pi updates private after return, and poll cancellation does not stop execution", async () => {
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

    const handle = await invoke(fixture.tool("bash"), { command: "hold", yieldMs: 0 }, undefined, (update) => updates.push(update));
    const handleInfo = bashDetails(handle).piwebBash as { executionId: string; state: string };
    expect(handleInfo.state).toBe("in_progress");
    expect(resultText(handle)).toContain("not produced a final result");
    const updatesAtYield = updates.length;

    emit(Buffer.from(`late-output${"x".repeat(4096)}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toHaveLength(updatesAtYield);
    expect(executionSignal?.aborted).toBe(false);

    const pollAbort = new AbortController();
    const poll = invoke(fixture.tool("bash_poll"), { executionId: handleInfo.executionId, waitMs: 5000 }, pollAbort.signal);
    pollAbort.abort();
    const snapshot = await poll;
    expect(resultText(snapshot)).toContain("late-output");
    expect(Buffer.byteLength(resultText(snapshot), "utf8")).toBeLessThanOrEqual(1024);
    expect(executionSignal?.aborted).toBe(false);

    result.resolve({ exitCode: 0 });
    const final = await invoke(fixture.tool("bash_poll"), { executionId: handleInfo.executionId, waitMs: 1000 });
    expect(resultText(final)).toBe("final");
    expect(bashDetails(final).fullOutputPath).toBe("native-output.txt");
    expect((bashDetails(final).piwebBash as { exitCode: number }).exitCode).toBe(0);
  });

  it.each([
    { exitCode: 2, error: /Command exited with code 2/ },
    { exitCode: null, error: /without a known exit code/ },
  ])("keeps native failures explicit for exitCode $exitCode", async ({ exitCode, error }) => {
    const fixture = makeFixture(async () => ({ exitCode }));
    await expect(invoke(fixture.tool("bash"), { command: "fail", yieldMs: 5000 })).rejects.toThrow(error);
  });

  it("exports the typed cleanup-unconfirmed signal and keeps Pi output references on unknown exits", async () => {
    const cleanupError = new BashCleanupUnconfirmedError();
    expect(cleanupError.name).toBe("BashCleanupUnconfirmedError");
    expect(cleanupError.message).toBe("Bash cleanup is unconfirmed; automatic execution and safe reload are stopped");

    const fixture = makeFixture(async (_command, _cwd, options) => {
      options.onData(Buffer.alloc(64 * 1024, 0x78));
      return { exitCode: null };
    });
    await expect(invoke(fixture.tool("bash"), { command: "unknown-exit", yieldMs: 5000 }))
      .rejects.toThrow(/without a known exit code.*Full output:/s);
  });

  it("preserves a stop/exit race as the observed native result", async () => {
    const completion = deferred<{ exitCode: number | null }>();
    let executionSignal: AbortSignal | undefined;
    const fixture = makeFixture(async (_command, _cwd, options) => {
      executionSignal = options.signal;
      return completion.promise;
    });
    const handle = await invoke(fixture.tool("bash"), { command: "race", yieldMs: 0 });
    const executionId = (bashDetails(handle).piwebBash as { executionId: string }).executionId;
    const stopping = invoke(fixture.tool("bash_stop"), { executionId });
    expect(executionSignal?.aborted).toBe(true);
    completion.resolve({ exitCode: 0 });
    const final = await stopping;
    expect((bashDetails(final).piwebBash as { state: string; stopReason: string; exitCode: number })).toMatchObject({
      state: "finished",
      stopReason: "manual",
      exitCode: 0,
    });
  });

  it("does not reset timeout while polling and reports the native timeout error", async () => {
    vi.useFakeTimers();
    let executionSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fixture = makeFixture((_command, _cwd, options) => new Promise((resolve) => {
      executionSignal = options.signal;
      markStarted();
      options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
    }));
    const handle = await invoke(fixture.tool("bash"), { command: "timed", timeout: 0.06, yieldMs: 0 });
    const executionId = (bashDetails(handle).piwebBash as { executionId: string }).executionId;
    await started;

    await vi.advanceTimersByTimeAsync(55);
    const poll = await invoke(fixture.tool("bash_poll"), { executionId, waitMs: 0 });
    expect(resultText(poll)).toContain("in_progress");
    expect(executionSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5);
    expect(executionSignal?.aborted).toBe(true);
    const rowsResult = await invoke(fixture.tool("bash_poll"), {});
    const executions = (bashDetails(rowsResult).piwebBash as { executions: Array<{ stopReason?: string; state: string }> }).executions;
    expect(executions[0]).toMatchObject({ state: "finished", stopReason: "timeout" });
    await expect(invoke(fixture.tool("bash_poll"), { executionId, waitMs: 0 }))
      .rejects.toThrow(/Command timed out after 0\.06 seconds/);
  });

  it("rejects foreign or expired handles and discards fast unyielded records", async () => {
    const pending = deferred<{ exitCode: number | null }>();
    const fixture = makeFixture(async () => pending.promise);
    const handle = await invoke(fixture.tool("bash"), { command: "hold", yieldMs: 0 });
    const executionId = (bashDetails(handle).piwebBash as { executionId: string }).executionId;
    fixture.setOwner(Object.freeze({ conversationId: "conversation-a", runId: "run-a" }));
    await expect(invoke(fixture.tool("bash_poll"), { executionId, waitMs: 0 })).rejects.toThrow(/not available in this run/);

    const closing = fixture.binding.lifecycle.close(fixture.owner, "run_end");
    pending.resolve({ exitCode: 0 });
    await closing;

    const fast = makeFixture(async () => ({ exitCode: 0 }));
    for (let index = 0; index < 65; index++) {
      const native = await invoke(fast.tool("bash"), { command: "fast", yieldMs: 5000 });
      expect(bashDetails(native).piwebBash).toBeUndefined();
    }
    await expect(invoke(fast.tool("bash_poll"), { executionId: "expired-handle", waitMs: 0 })).rejects.toThrow(/not available in this run/);
  });

  it("enforces four unsettled executions per run and retains all 64 published handles", async () => {
    const pending: Array<ReturnType<typeof deferred<{ exitCode: number | null }>>> = [];
    const fixture = makeFixture(async () => {
      const next = deferred<{ exitCode: number | null }>();
      pending.push(next);
      return next.promise;
    }, { base: simpleBase });
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `hold-${index}`, yieldMs: 0 });
      ids.push((bashDetails(handle).piwebBash as { executionId: string }).executionId);
    }
    await expect(invoke(fixture.tool("bash"), { command: "fifth", yieldMs: 0 })).rejects.toThrow(/4 unsettled/);
    expect(pending).toHaveLength(4);
    pending.forEach((item) => item.resolve({ exitCode: 0 }));
    for (const executionId of ids) {
      await invoke(fixture.tool("bash_poll"), { executionId, waitMs: 1000 });
    }

    for (let index = 4; index < 64; index++) {
      const handle = await invoke(fixture.tool("bash"), { command: `handle-${index}`, yieldMs: 0 });
      const executionId = (bashDetails(handle).piwebBash as { executionId: string }).executionId;
      ids.push(executionId);
      pending.at(-1)?.resolve({ exitCode: 0 });
      await invoke(fixture.tool("bash_poll"), { executionId, waitMs: 1000 });
    }
    expect(ids).toHaveLength(64);
    const listing = await invoke(fixture.tool("bash_poll"), {});
    const rows = (bashDetails(listing).piwebBash as { executions: unknown[] }).executions;
    expect(rows).toHaveLength(64);
    await expect(invoke(fixture.tool("bash"), { command: "overflow", yieldMs: 0 })).rejects.toThrow(/64 Bash handle limit/);
    expect(pending).toHaveLength(64);
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
    const handle = await invoke(fixture.tool("bash"), { command: "flood", yieldMs: 0 });
    const executionId = (bashDetails(handle).piwebBash as { executionId: string }).executionId;
    const listing = await invoke(fixture.tool("bash_poll"), {});
    const executions = (bashDetails(listing).piwebBash as { executions: Array<{ partial?: boolean; stopReason?: string }> }).executions;
    expect(forwardedBytes).toEqual([16 * 1024 * 1024]);
    expect(executions[0]).toMatchObject({ partial: true, stopReason: "output_limit" });
    await expect(invoke(fixture.tool("bash_poll"), { executionId, waitMs: 0 })).rejects.toThrow(/partial output.*must not be treated/);
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
    const handle = await invoke(old.tool("bash"), { command: "unkillable", yieldMs: 0 });
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
    await expect(invoke(replacement.tool("bash"), { command: "blocked", yieldMs: 0 })).rejects.toThrow(/previous Bash execution/);

    pending.resolve({ exitCode: 0 });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    expect(old.binding.lifecycle.activity(old.owner)).toEqual({ running: 0, stopping: 0, cleanupUnknown: false });
    expect(oldChanges.every((owner) => owner === old.owner)).toBe(true);
    const replacementResult = await invoke(replacement.tool("bash"), { command: "allowed", yieldMs: 1000 });
    expect(resultText(replacementResult)).toContain("(no output)");
    expect(oldChanges.every((owner) => owner === old.owner)).toBe(true);
    expect(bashDetails(handle).piwebBash).toBeDefined();
  });

  it("rejects a pre-aborted SDK call before admitting or starting native work", async () => {
    let calls = 0;
    const fixture = makeFixture(async () => {
      calls++;
      return { exitCode: 0 };
    });
    const signal = new AbortController();
    signal.abort();
    await expect(invoke(fixture.tool("bash"), { command: "must-not-start", yieldMs: 0 }, signal.signal))
      .rejects.toThrow(/cancelled before admission/);
    await expect(invoke(fixture.tool("bash"), { command: "bad-yield", yieldMs: 5001 }))
      .rejects.toThrow(/Invalid bash input/);
    await expect(invoke(fixture.tool("bash"), { command: "bad-timeout", timeout: 0, yieldMs: 0 }))
      .rejects.toThrow(/Invalid timeout/);
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
        await invoke(fixture.tool("bash"), { command: `hold-${index}`, yieldMs: 0 });
      }
    }
    const overflowOwner = Object.freeze({ conversationId: "conversation-overflow", runId: "run-overflow" });
    const overflow = makeFixture(async () => ({ exitCode: 0 }), {
      owner: overflowOwner,
      conversationKey: `cwd\\0${overflowOwner.conversationId}`,
      budget,
    });
    await expect(invoke(overflow.tool("bash"), { command: "overflow", yieldMs: 0 }))
      .rejects.toThrow(/runtime Bash execution limit/);
    expect(pending).toHaveLength(32);

    const closing = fixtures.map((fixture) => fixture.binding.lifecycle.close(fixture.owner, "run_end"));
    pending.forEach((execution) => execution.resolve({ exitCode: 0 }));
    await Promise.all(closing);
  });

  it("runs a short command through the native Pi Bash formatter", async () => {
    const fixture = makeFixture(createLocalBashOperations().exec);
    const result = await invoke(fixture.tool("bash"), {
      command: "printf 'piweb-native-format'",
      yieldMs: 5000,
    });
    expect(resultText(result)).toContain("piweb-native-format");
    expect(bashDetails(result).piwebBash).toBeUndefined();
  });
});
