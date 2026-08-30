import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ServiceTier } from "../shared/protocol.js";
import { installCompactionThinkingOverride } from "./compaction-thinking.js";
import {
  installServiceTierOverride,
  modelServiceTiers,
} from "./service-tier.js";

type FakeModelRuntime = Pick<ModelRuntime, "stream" | "streamSimple">;

function fakeModelRuntime() {
  const stream = vi.fn(() => ({ source: "official-low-level-stream" }));
  const streamSimple = vi.fn(() => ({ source: "official-simple-stream" }));
  return {
    modelRuntime: { stream, streamSimple } as unknown as FakeModelRuntime,
    stream,
    streamSimple,
  };
}

function fakeSession(
  modelRuntime: FakeModelRuntime,
  decoratedOptions: Partial<ModelsSimpleStreamOptions> = {},
): {
  session: AgentSession;
  upstream: ReturnType<typeof vi.fn>;
  emit(event: { type: "compaction_start"; reason: "manual" }): void;
} {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const upstream = vi.fn((model, context, options) => (
    modelRuntime.streamSimple(model, context, {
      ...options,
      ...decoratedOptions,
    })
  ));
  return {
    session: {
      agent: { streamFunction: upstream },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as AgentSession,
    upstream,
    emit(event) {
      for (const listener of listeners) {
        listener(event as AgentSessionEvent);
      }
    },
  };
}

function codexModel(overrides: Record<string, unknown> = {}) {
  return {
    provider: "extension-codex",
    id: "future-codex-model",
    api: "openai-codex-responses",
    name: "Future Codex model",
    reasoning: true,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 8_192,
    cost: {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    },
    ...overrides,
  };
}

const context = {
  systemPrompt: "",
  messages: [],
  tools: [],
};

describe("service tier compatibility boundary", () => {
  it("projects priority from the API route rather than provider or model metadata", () => {
    expect(modelServiceTiers(codexModel({
      provider: "another-provider",
      id: "future-model",
    }))).toEqual(["priority"]);
    expect(modelServiceTiers({
      provider: "openai-codex",
      id: "known-model",
      api: "another-api",
      serviceTiers: ["priority"],
    })).toBeUndefined();
  });

  it("preserves the SDK request wrapper and dispatches priority through Pi's low-level route", async () => {
    const { modelRuntime, stream, streamSimple } = fakeModelRuntime();
    const transformHeaders = vi.fn(async (headers: Record<string, string>) => ({
      ...headers,
      "x-extension": "enabled",
    }));
    const { session, upstream } = fakeSession(modelRuntime, {
      timeoutMs: 321,
      websocketConnectTimeoutMs: 222,
      maxRetries: 4,
      maxRetryDelayMs: 987,
      transformHeaders,
    });
    let selected: ServiceTier | null = null;
    const override = installServiceTierOverride(
      modelRuntime,
      () => selected,
    );
    const options = { temperature: 0.25, reasoning: "high" as const };
    const model = codexModel();

    expect(session.agent.streamFunction(
      model as never,
      context as never,
      options,
    )).toEqual({ source: "official-simple-stream" });
    expect(upstream).toHaveBeenLastCalledWith(model, context, options);
    expect(streamSimple).toHaveBeenLastCalledWith(
      model,
      context,
      expect.objectContaining({
        temperature: 0.25,
        timeoutMs: 321,
        transformHeaders,
      }),
    );
    expect(stream).not.toHaveBeenCalled();

    selected = "priority";
    expect(session.agent.streamFunction(
      model as never,
      context as never,
      options,
    )).toEqual({ source: "official-low-level-stream" });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith(model, context, expect.objectContaining({
      temperature: 0.25,
      maxTokens: 8_192,
      reasoningEffort: "high",
      serviceTier: "priority",
      timeoutMs: 321,
      websocketConnectTimeoutMs: 222,
      maxRetries: 4,
      maxRetryDelayMs: 987,
      transformHeaders,
    }));
    const lowLevelOptions = stream.mock.calls[0]?.[2];
    expect(await lowLevelOptions?.transformHeaders?.({ "x-auth": "token" }))
      .toEqual({ "x-auth": "token", "x-extension": "enabled" });

    selected = "flex";
    expect(() => session.agent.streamFunction(
      model as never,
      context as never,
      options,
    )).toThrow('does not support service tier "flex"');
    expect(stream).toHaveBeenCalledTimes(1);

    override.dispose();
    expect(modelRuntime.streamSimple).toBe(streamSimple);
    expect(session.agent.streamFunction).toBe(upstream);
  });

  it("fails closed after SDK decoration when a selected tier reaches another route", () => {
    const { modelRuntime, stream, streamSimple } = fakeModelRuntime();
    const { session, upstream } = fakeSession(modelRuntime, { timeoutMs: 321 });
    const override = installServiceTierOverride(
      modelRuntime,
      () => "priority",
    );

    expect(() => session.agent.streamFunction(
      codexModel({ api: "openai-responses" }) as never,
      context as never,
      {},
    )).toThrow('does not support service tier "priority"');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(streamSimple).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();

    override.dispose();
  });

  it("composes with compaction thinking without changing manual auth identity", async () => {
    const { modelRuntime, stream, streamSimple } = fakeModelRuntime();
    const { session, upstream, emit } = fakeSession(modelRuntime);
    const serviceTierOverride = installServiceTierOverride(
      modelRuntime,
      () => "priority",
    );
    const compactionThinkingOverride = installCompactionThinkingOverride(
      session,
      "auto",
    );

    expect(session.agent.streamFunction).toBe(upstream);
    emit({ type: "compaction_start", reason: "manual" });
    expect(session.agent.streamFunction).toBe(upstream);

    await Promise.resolve();
    const model = codexModel();
    session.agent.streamFunction(
      model as never,
      context as never,
      { reasoning: "max" },
    );
    expect(stream).toHaveBeenCalledWith(model, context, expect.objectContaining({
      reasoningEffort: "minimal",
      serviceTier: "priority",
    }));

    compactionThinkingOverride.dispose();
    serviceTierOverride.dispose();
    expect(session.agent.streamFunction).toBe(upstream);
    expect(modelRuntime.streamSimple).toBe(streamSimple);
  });

  it("does not clobber a later runtime wrapper during disposal", () => {
    const { modelRuntime } = fakeModelRuntime();
    const override = installServiceTierOverride(
      modelRuntime,
      () => "priority",
    );
    const laterWrapper = vi.fn() as unknown as ModelRuntime["streamSimple"];
    modelRuntime.streamSimple = laterWrapper;

    override.dispose();

    expect(modelRuntime.streamSimple).toBe(laterWrapper);
  });
});
