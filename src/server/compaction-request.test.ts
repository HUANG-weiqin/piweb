import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it, vi } from "vitest";
import { MAX_MODEL_REFERENCE_BYTES } from "../shared/protocol.js";
import {
  COMPACTION_PROVENANCE_NAMESPACE,
  mergeDefaultCompactionProvenance,
} from "./compaction-provenance.js";
import { COMPACTION_SERVICE_TIER_SUPPRESSION } from "./service-tier.js";
import { installDefaultCompactionRequestOverride } from "./compaction-request.js";

type PrivateSession = AgentSession & {
  _runDefaultCompaction(...args: unknown[]): Promise<unknown>;
};

type DefaultImplementation = (
  receiver: PrivateSession,
  args: unknown[],
) => Promise<unknown>;

const context = normalizeContext({ systemPrompt: "", messages: [], tools: [] });

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
    customInstructions: unknown,
    signal: unknown,
    reason: unknown,
  ): Promise<unknown> {
    return implementation(this as PrivateSession, [
      preparation,
      requestModel,
      customInstructions,
      signal,
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
    "focus summary",
    new AbortController().signal,
    "manual",
  ];
}

function defaultResult(args: unknown[], details: unknown = { readFiles: ["README.md"] }) {
  return {
    summary: "summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 100,
    details,
    requestModel: args[1],
  };
}

describe("installDefaultCompactionRequestOverride", () => {
  it.each(["manual", "threshold"] as const)(
    "rewrites only the model in Pi 1's five-argument default call",
    async (reason) => {
    let receiver: unknown;
    let received: unknown[] | undefined;
    const fixture = fakeSession(async (current, args) => {
      receiver = current;
      received = args;
      current.agent.streamFunction(
        args[1] as never,
        context,
        { reasoning: "max", transport: "auto", maxRetries: 4, timeoutMs: 321 },
      );
      return defaultResult(args);
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
    args[4] = reason;

    await expect(fixture.invoke(...args)).resolves.toMatchObject({
      summary: "summary",
      details: expect.objectContaining({
        readFiles: ["README.md"],
        [COMPACTION_PROVENANCE_NAMESPACE]: expect.objectContaining({
          generator: "default",
          policy: "explicit",
        }),
      }),
    });

    expect(receiver).toBe(fixture.session);
    expect(received).toEqual([
      args[0],
      compactionModel,
      args[2],
      args[3],
      args[4],
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
      current.agent.streamFunction(args[1] as never, context, { reasoning: "max" });
      return defaultResult(args);
    });
    const getModel = vi.fn();
    const override = installDefaultCompactionRequestOverride(fixture.session, { getModel });
    const args = defaultArgs();

    await expect(fixture.invoke(...args)).resolves.toMatchObject({
      summary: "summary",
      details: expect.objectContaining({
        [COMPACTION_PROVENANCE_NAMESPACE]: expect.objectContaining({
          policy: "follow_primary",
        }),
      }),
    });

    expect(received).toEqual(args);
    expect(getModel).not.toHaveBeenCalled();
    expect(fixture.originalStream).toHaveBeenCalledWith(
      args[1],
      expect.anything(),
      { reasoning: "minimal" },
    );
    override.dispose();
  });

  it("keeps the wrapper installed until Pi reads streamFunction after async auth", async () => {
    const auth = deferred<void>();
    const startedStream = deferred<void>();
    const result = deferred<ReturnType<typeof defaultResult>>();
    let streamFromDefault: AgentSession["agent"]["streamFunction"] | undefined;
    const fixture = fakeSession(async (current) => {
      await auth.promise;
      streamFromDefault = current.agent.streamFunction;
      startedStream.resolve();
      streamFromDefault(
        model({ provider: "compact-provider", id: "compact-model" }) as never,
        context,
        { reasoning: "high" },
      );
      return result.promise;
    });
    const compactionModel = model({
      provider: "compact-provider",
      id: "compact-model",
      contextWindow: 120_000,
    });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => compactionModel,
    }, { provider: "compact-provider", id: "compact-model" });

    const operation = fixture.invoke(...defaultArgs());
    expect(fixture.session.agent.streamFunction).not.toBe(fixture.originalStream);
    auth.resolve();
    await startedStream.promise;
    expect(streamFromDefault).not.toBe(fixture.originalStream);
    expect(fixture.originalStream).toHaveBeenCalledTimes(1);
    expect(fixture.session.agent.streamFunction).not.toBe(fixture.originalStream);

    result.resolve(defaultResult(defaultArgs()));
    await expect(operation).resolves.toMatchObject({ summary: "summary" });
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);
    override.dispose();
  });

  it("resolves the explicit model freshly for each default attempt", async () => {
    const receivedModels: unknown[] = [];
    const fixture = fakeSession(async (current, args) => {
      receivedModels.push(args[1]);
      current.agent.streamFunction(args[1] as never, context, {});
      return defaultResult(args);
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
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      return defaultResult(args);
    });
    const reference = { provider: "compact-provider", id: "initial-model" };
    const target = model({ id: "initial-model", contextWindow: 120_000 });
    const getModel = vi.fn(() => target);
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel },
      reference,
    );
    reference.id = "mutated-model";

    await expect(fixture.invoke(...defaultArgs())).resolves.toMatchObject({
      requestModel: target,
    });

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
    const events: unknown[] = [];
    const fixture = fakeSession(async (_current, args) => {
      original(args);
      return "summary";
    });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => target,
    }, { provider: "compact-provider", id: "compact-model" }, "auto", (event) => {
      events.push(event);
    });

    await expect(fixture.invoke(...defaultArgs())).rejects.toThrow();

    expect(original).not.toHaveBeenCalled();
    expect(fixture.originalStream).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    override.dispose();
  });

  it("guards overlapping default attempts", async () => {
    const first = deferred<ReturnType<typeof defaultResult>>();
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      return first.promise;
    });
    const override = installDefaultCompactionRequestOverride(fixture.session, {
      getModel: () => model({ contextWindow: 120_000 }),
    }, { provider: "compact-provider", id: "compact-model" });

    const operation = fixture.invoke(...defaultArgs());
    await expect(fixture.invoke(...defaultArgs())).rejects.toThrow(
      "must not overlap",
    );
    first.resolve(defaultResult(defaultArgs()));
    await expect(operation).resolves.toMatchObject({ summary: "summary" });
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
    args[3] = controller.signal;

    const operation = fixture.invoke(...args);
    controller.abort();
    pending.reject(failure);
    await expect(operation).rejects.toBe(failure);
    expect(fixture.session.agent.streamFunction).toBe(fixture.originalStream);

    override.dispose();
    expect(Object.hasOwn(fixture.session, "_runDefaultCompaction")).toBe(false);
    expect(fixture.session._runDefaultCompaction).toBe(fixture.original);
  });

  it("uses one exact live attempt for repeated streams and records explicit B=A provenance", async () => {
    const primary = model();
    const events: unknown[] = [];
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      current.agent.streamFunction(args[1] as never, context, {});
      return defaultResult(args, undefined);
    });
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel: () => primary },
      { provider: primary.provider, id: primary.id },
      "auto",
      (event) => events.push(event),
    );

    const result = await fixture.invoke(...defaultArgs(primary));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "started",
      attempt: {
        generator: "default",
        policy: "explicit",
        requestTarget: { provider: primary.provider, id: primary.id },
      },
    });
    expect(events[1]).toEqual({
      type: "ended",
      id: (events[0] as { attempt: { id: string } }).attempt.id,
    });
    expect((result as { details: Record<string, unknown> }).details).toMatchObject({
      [COMPACTION_PROVENANCE_NAMESPACE]: expect.objectContaining({
        generator: "default",
        policy: "explicit",
        requestTarget: { provider: primary.provider, id: primary.id },
      }),
    });
    override.dispose();
  });

  it("does not let observer failures alter a successful provider result", async () => {
    const observer = vi.fn(() => {
      throw new Error("observer failed");
    });
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      return defaultResult(args);
    });
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel: () => model() },
      undefined,
      "auto",
      observer,
    );

    await expect(fixture.invoke(...defaultArgs())).resolves.toMatchObject({
      summary: "summary",
      details: expect.objectContaining({
        [COMPACTION_PROVENANCE_NAMESPACE]: expect.anything(),
      }),
    });
    expect(fixture.originalStream).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledTimes(2);
    override.dispose();
  });

  it.each([
    ["blank provider", { provider: " \t" }],
    ["oversized id", { id: "m".repeat(MAX_MODEL_REFERENCE_BYTES + 1) }],
    [
      "oversized multibyte provider",
      { provider: "模".repeat(Math.floor(MAX_MODEL_REFERENCE_BYTES / 3) + 1) },
    ],
  ])("rejects an invalid %s before provider dispatch", async (_label, overrides) => {
    const events: unknown[] = [];
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      return defaultResult(args);
    });
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel: () => model() },
      undefined,
      "auto",
      (event) => events.push(event),
    );

    await expect(fixture.invoke(...defaultArgs(model(overrides))))
      .rejects.toThrow("invalid model identity");
    expect(fixture.originalStream).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    override.dispose();
  });

  it("fails closed if a split request changes the provider or model identity", async () => {
    const events: unknown[] = [];
    const fixture = fakeSession(async (current, args) => {
      current.agent.streamFunction(args[1] as never, context, {});
      current.agent.streamFunction(model({ id: "other-model" }) as never, context, {});
      return defaultResult(args);
    });
    const override = installDefaultCompactionRequestOverride(
      fixture.session,
      { getModel: () => model() },
      undefined,
      "auto",
      (event) => events.push(event),
    );

    await expect(fixture.invoke(...defaultArgs())).rejects.toThrow("changed model identity");
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "started",
      "ended",
    ]);
    override.dispose();
  });

  it.each(["provider failure", "abort"])(
    "ends a started attempt without publishing a result after %s",
    async (kind) => {
      const failure = new Error(kind);
      const events: unknown[] = [];
      const fixture = fakeSession(async (current, args) => {
        current.agent.streamFunction(args[1] as never, context, {});
        throw failure;
      });
      const override = installDefaultCompactionRequestOverride(
        fixture.session,
        { getModel: () => model() },
        undefined,
        "auto",
        (event) => events.push(event),
      );

      await expect(fixture.invoke(...defaultArgs())).rejects.toBe(failure);
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({
        type: "ended",
        id: (events[0] as { attempt: { id: string } }).attempt.id,
      });
      override.dispose();
    },
  );

  it("preserves Pi details and rejects non-plain or colliding provenance details", () => {
    const attempt = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      generator: "default" as const,
      policy: "follow_primary" as const,
      requestTarget: { provider: "provider", id: "model" },
    };

    expect(mergeDefaultCompactionProvenance(undefined, attempt)).toEqual({
      [COMPACTION_PROVENANCE_NAMESPACE]: expect.objectContaining({ attemptId: attempt.id }),
    });
    expect(mergeDefaultCompactionProvenance({ readFiles: ["README.md"] }, attempt))
      .toMatchObject({ readFiles: ["README.md"] });
    expect(() => mergeDefaultCompactionProvenance(undefined, {
      ...attempt,
      requestTarget: { provider: " ", id: "model" },
    })).toThrow("provenance is invalid");
    for (const details of [null, [], new Date(), {
      [COMPACTION_PROVENANCE_NAMESPACE]: {},
    }]) {
      expect(() => mergeDefaultCompactionProvenance(details, attempt)).toThrow();
    }
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
