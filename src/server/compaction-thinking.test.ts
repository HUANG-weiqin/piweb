import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installCompactionThinkingOverride } from "./compaction-thinking.js";

function fakeSession() {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const originalStream = vi.fn(() => undefined) as unknown as AgentSession["agent"]["streamFn"];
  const unsubscribe = vi.fn();
  const session = {
    agent: { streamFn: originalStream },
    subscribe(next: (event: AgentSessionEvent) => void) {
      listener = next;
      return unsubscribe;
    },
  } as unknown as AgentSession;
  return {
    session,
    originalStream,
    unsubscribe,
    emit(event: unknown) {
      listener?.(event as AgentSessionEvent);
    },
  };
}

describe("installCompactionThinkingOverride", () => {
  it("uses the nearest supported minimal level only during compaction", () => {
    const fixture = fakeSession();
    const override = installCompactionThinkingOverride(fixture.session);

    fixture.emit({ type: "compaction_start", reason: "threshold" });
    fixture.session.agent.streamFn(
      {
        reasoning: true,
        thinkingLevelMap: { minimal: null },
      } as never,
      {} as never,
      { reasoning: "max" },
    );

    expect(fixture.originalStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { reasoning: "low" },
    );
    expect(fixture.session.agent.streamFn).not.toBe(fixture.originalStream);

    fixture.emit({ type: "compaction_end", reason: "threshold" });
    expect(fixture.session.agent.streamFn).toBe(fixture.originalStream);
    override.dispose();
  });

  it("guards the final Codex payload used by compaction streams", async () => {
    const fixture = fakeSession();
    let observedBytes: number | undefined;
    const override = installCompactionThinkingOverride(
      fixture.session,
      (input) => {
        observedBytes = input.serializedPayloadBytes;
        return { block: true, reason: "context_length_exceeded: compaction guard" };
      },
    );
    const model = {
      provider: "openai-codex",
      api: "openai-codex-responses",
      id: "gpt-5.6-sol",
      reasoning: true,
    } as never;

    fixture.emit({ type: "compaction_start", reason: "overflow" });
    fixture.session.agent.streamFn(model, {} as never, {});
    const forwardedOptions = (
      fixture.originalStream as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[2];

    await expect(forwardedOptions?.onPayload?.(
      { summaryInput: "压缩上下文" },
      model,
    )).rejects.toThrow("context_length_exceeded: compaction guard");
    expect(observedBytes).toBe(Buffer.byteLength(
      JSON.stringify({ summaryInput: "压缩上下文" }),
      "utf8",
    ));

    override.dispose();
  });

  it("preserves manual auth identity before overriding a non-reasoning model", async () => {
    const fixture = fakeSession();
    const override = installCompactionThinkingOverride(fixture.session);

    fixture.emit({ type: "compaction_start", reason: "manual" });
    expect(fixture.session.agent.streamFn).toBe(fixture.originalStream);

    await Promise.resolve();
    fixture.session.agent.streamFn(
      { reasoning: false } as never,
      {} as never,
      { reasoning: "max" },
    );
    expect(fixture.originalStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { reasoning: undefined },
    );

    override.dispose();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.session.agent.streamFn).toBe(fixture.originalStream);
  });

  it("does not install a deferred manual override after disposal", async () => {
    const fixture = fakeSession();
    const override = installCompactionThinkingOverride(fixture.session);

    fixture.emit({ type: "compaction_start", reason: "manual" });
    override.dispose();
    await Promise.resolve();

    expect(fixture.session.agent.streamFn).toBe(fixture.originalStream);
  });
});
