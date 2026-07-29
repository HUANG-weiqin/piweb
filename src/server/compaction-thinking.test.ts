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
    const override = installCompactionThinkingOverride(fixture.session, "auto");

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

  it.each([
    ["sse", "websocket"],
    ["websocket", "sse"],
    ["websocket-cached", "sse"],
  ] as const)(
    "forces configured %s transport for Codex compaction",
    (transport, inputTransport) => {
      const fixture = fakeSession();
      const override = installCompactionThinkingOverride(fixture.session, transport);

      fixture.emit({ type: "compaction_start", reason: "threshold" });
      fixture.session.agent.streamFn(
        {
          provider: "openai-codex",
          api: "openai-codex-responses",
          reasoning: true,
        } as never,
        {} as never,
        { reasoning: "max", transport: inputTransport },
      );

      expect(fixture.originalStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { reasoning: "minimal", transport },
      );
      override.dispose();
    },
  );

  it("preserves a non-Codex compaction transport", () => {
    const fixture = fakeSession();
    const override = installCompactionThinkingOverride(fixture.session, "sse");

    fixture.emit({ type: "compaction_start", reason: "threshold" });
    fixture.session.agent.streamFn(
      { provider: "openai", api: "openai-responses", reasoning: true } as never,
      {} as never,
      { reasoning: "max", transport: "websocket" },
    );

    expect(fixture.originalStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { reasoning: "minimal", transport: "websocket" },
    );
    override.dispose();
  });

  it("preserves manual auth identity before overriding a non-reasoning model", async () => {
    const fixture = fakeSession();
    const override = installCompactionThinkingOverride(fixture.session, "auto");

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
    const override = installCompactionThinkingOverride(fixture.session, "auto");

    fixture.emit({ type: "compaction_start", reason: "manual" });
    override.dispose();
    await Promise.resolve();

    expect(fixture.session.agent.streamFn).toBe(fixture.originalStream);
  });
});
