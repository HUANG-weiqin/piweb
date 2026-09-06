import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { COMPACTION_SERVICE_TIER_SUPPRESSION } from "./service-tier.js";
import { installDefaultCompactionRequestOverride } from "./compaction-request.js";

type PrivateSession = AgentSession & {
  _runDefaultCompaction(...args: unknown[]): Promise<unknown>;
};

type DefaultImplementation = (
  receiver: PrivateSession,
  args: unknown[],
) => Promise<unknown>;

function model(overrides: Record<string, unknown> = {}) {
  return {
    provider: "main-provider",
    id: "main-model",
    api: "openai-responses",
    reasoning: true,
    contextWindow: 100_000,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeSession(implementation: DefaultImplementation) {
  function original(
    preparation: unknown,
    requestModel: unknown,
    apiKey: unknown,
    headers: unknown,
    customInstructions: unknown,
    signal: unknown,
    env: unknown,
    reason: unknown,
  ): Promise<unknown> {
    return implementation(this as PrivateSession, [
      preparation,
      requestModel,
      apiKey,
      headers,
      customInstructions,
      signal,
      env,
      reason,
    ]);
  }
  const originalStream = (
    vi.fn(() => ({ source: "session-decorator" }))
  ) as unknown as AgentSession["agent"]["streamFunction"];
  const session = Object.create({
    _runDefaultCompaction: original,
  }) as PrivateSession;
  (session as unknown as {
    agent: Pick<AgentSession["agent"], "streamFunction">;
  }).agent = { streamFunction: originalStream };
  return {
    session,
    original,
    originalStream,
    invoke(...args: unknown[]) {
      return session._runDefaultCompaction(...args);
    },
  };
}

function defaultArgs(requestModel = model()): unknown[] {
  return [
    { preparation: true },
    requestModel,
    "main-api-key",
    { "X-Main": "secret" },
    "focus summary",
    new AbortController().signal,
    { MAIN_ENV: "secret" },
    "manual",
  ];
}

describe("installDefaultCompactionRequestOverride", () => {
  it.each(["manual", "threshold"] as const)(
    "rewrites the %s private default call with its receiver and all eight positions intact",
    async (reason) => {
    let receiver: unknown;
    let received: unknown[] | undefined;
    const fixture = fakeSession(async (current, args) => {
      receiver = current;
      received = args;
      current.agent.streamFunction(
        args[1] as never,
        {} as never,
        { reasoning: "max", transport: "auto", maxRetries: 4, timeoutMs: 321 },
      );
      return "summary";
    });
    const compactionModel = model({
      provider: "openai-codex",
      id: "compact-model",
      api: "openai-codex-responses",
      contextWindow: 120_000,
    });
    const getModel = vi.fn(() => compactionModel);
    const override = installDefaultCompactionRequestOverride(fixture.session, { getModel }, {
      provider: "compact-provider",
      id: "compact-model",
    });
    const args = defaultArgs();
    args[7] = reason;

    await expect(fixture.invoke(...args)).resolves.toBe("summary");

    expect(receiver).toBe(fixture.session);
    expect(received).toEqual([
      args[0],
      compactionModel,
      undefined,
      undefined,
      args[4],
      args[5],
      undefined,
      args[7],
    ]);
    expect(getModel).toHaveBeenCalledExactlyOnceWith("compact-provider", "compact-model");
    const streamOptions = (fixture.originalStream as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[2] as Record<PropertyKey, unknown>;
    expect(streamOptions).toMatchObject({
      reasoning: "minimal",
      transport: "sse",
      maxRetries: 4,
      timeoutMs: 321,
    });
    expect(Object.getOwnPropertyDescriptor(
      streamOptions,
      COMPACTION_SERVICE_TIER_SUPPRESSION,
    )).toMatchObject({ enumerable: true, value: true });
    override.dispose();
    },
  );

  it("follows the main request when no explicit compaction model is passed", async () => {
    let received: unknown[] | undefined;
    const fixture = fakeSession(async (current, args) => {
      received = args;
      current.agent.streamFunction(args[1] as never, {} as never, { reasoning: "max" });
      return "summary";
    });
    const getModel = vi.fn();
    const override = installDefaultCompactionRequestOverride(fixture.session, { getModel });
    const args = defaultArgs();

    await expect(fixture.invoke(...args)).resolves.toBe("summary");

    expect(received).toEqual(args);
    expect(getModel).not.toHaveBeenCalled();
    expect(fixture.originalStream).toHaveBeenCalledWith(
      args[1],
      expect.anything(),
      { reasoning: "minimal" },
    );
    override.dispose();
  });

  it("keeps the captured compaction stream for split summaries while restoring the agent synchronously", async () => {
    const result = deferred<string>();
    let streamFromDefault: AgentSession["agent"]["streamFunction"] | undefined;
    const fixture = fakeSession(async (current) => {
      streamFromDefault = current.agent.streamFunction;
      return result.promise;
    });
    const compactionModel = model({ contextWindow: 120_000 });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => compactionModel,
    }, { provider: "compact-provider", id: "compact-model" });

    const operation = fixture.invoke(...defaultArgs());
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);
    streamFromDefault?.(compactionModel as never, {} as never, { reasoning: "high" });
    streamFromDefault?.(compactionModel as never, {} as never, { reasoning: "max" });
    expect(fixture.originalStream).toHaveBeenCalledTimes(2);
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);

    result.resolve("summary");
    await expect(operation).resolves.toBe("summary");
    override.dispose();
  });

  it("resolves the explicit model freshly for each default attempt", async () => {
    const receivedModels: unknown[] = [];
    const fixture = fakeSession(async (_current, args) => {
      receivedModels.push(args[1]);
      return "summary";
    });
    const first = model({ id: "compact-model", contextWindow: 120_000 });
    const second = model({ id: "compact-model", contextWindow: 140_000 });
    const getModel = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const override = installDefaultCompactionRequestOverride(fixture.session, { getModel }, {
      provider: "compact-provider",
      id: "compact-model",
    });

    await fixture.invoke(...defaultArgs());
    await fixture.invoke(...defaultArgs());

    expect(receivedModels).toEqual([first, second]);
    expect(getModel).toHaveBeenCalledTimes(2);
    override.dispose();
  });

  it("captures the explicit model identity at installation", async () => {
    const fixture = fakeSession(async (_current, args) => args[1]);
    const reference = { provider: "compact-provider", id: "initial-model" };
    const target = model({ id: "initial-model", contextWindow: 120_000 });
    const getModel = vi.fn(() => target);
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel },
      reference,
    );
    reference.id = "mutated-model";

    await expect(fixture.invoke(...defaultArgs())).resolves.toBe(target);

    expect(getModel).toHaveBeenCalledExactlyOnceWith(
      "compact-provider",
      "initial-model",
    );
    override.dispose();
  });

  it.each([
    ["is unavailable", undefined],
    ["has an invalid context window", model({ contextWindow: Number.NaN })],
    ["is smaller", model({ contextWindow: 99_999 })],
  ])("fails before Pi or a provider when the compaction model %s", async (_label, target) => {
    const original = vi.fn();
    const fixture = fakeSession(async (_current, args) => {
      original(args);
      return "summary";
    });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => target,
    }, { provider: "compact-provider", id: "compact-model" });

    await expect(fixture.invoke(...defaultArgs())).rejects.toThrow();

    expect(original).not.toHaveBeenCalled();
    expect(fixture.originalStream).not.toHaveBeenCalled();
    override.dispose();
  });

  it("guards overlapping default attempts", async () => {
    const first = deferred<string>();
    const fixture = fakeSession(async () => first.promise);
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => model({ contextWindow: 120_000 }),
    }, { provider: "compact-provider", id: "compact-model" });

    const operation = fixture.invoke(...defaultArgs());
    await expect(fixture.invoke(...defaultArgs())).rejects.toThrow(
      "must not overlap",
    );
    first.resolve("summary");
    await expect(operation).resolves.toBe("summary");
    override.dispose();
  });

  it("restores the agent stream after Pi throws synchronously", async () => {
    const failure = new Error("sync failure");
    const fixture = fakeSession(() => {
      throw failure;
    });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => model({ contextWindow: 120_000 }),
    }, { provider: "compact-provider", id: "compact-model" });

    await expect(fixture.invoke(...defaultArgs())).rejects.toBe(failure);
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);
    override.dispose();
  });

  it("restores the exact own private-method descriptor", () => {
    const fixture = fakeSession(async () => "summary");
    Object.defineProperty(fixture.session, "_runDefaultCompaction", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: fixture.original,
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      fixture.session,
      "_runDefaultCompaction",
    );
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => model(),
    });

    override.dispose();

    expect(Object.getOwnPropertyDescriptor(
      fixture.session,
      "_runDefaultCompaction",
    )).toEqual(originalDescriptor);
  });

  it("restores inherited state after abort and disposal", async () => {
    const failure = new Error("aborted");
    const pending = deferred<string>();
    const fixture = fakeSession(async () => pending.promise);
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => model({ contextWindow: 120_000 }),
    }, { provider: "compact-provider", id: "compact-model" });
    const controller = new AbortController();
    const args = defaultArgs();
    args[5] = controller.signal;

    const operation = fixture.invoke(...args);
    controller.abort();
    pending.reject(failure);
    await expect(operation).rejects.toBe(failure);
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);

    override.dispose();
    expect(Object.hasOwn(fixture.session, "_runDefaultCompaction")).toBe(false);
    expect(fixture.session._runDefaultCompaction).toBe(fixture.original);
  });

  it("fails closed when Pi's private default-compaction shape changes", () => {
    const session = {
      agent: { streamFunction: vi.fn() },
      _runDefaultCompaction: async () => undefined,
    } as unknown as AgentSession;

    expect(() => installDefaultCompactionRequestOverride(session, {
      getModel: () => model(),
    })).toThrow("Unsupported Pi default compaction implementation");
  });
});
