import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ServiceTier } from "../shared/protocol.js";
import { installCompactionThinkingOverride } from "./compaction-thinking.js";
import {
  installServiceTierOverride,
  modelServiceTiers,
} from "./service-tier.js";

function fakeSession(streamFunction: ReturnType<typeof vi.fn>): {
  session: AgentSession;
  emit(event: { type: "compaction_start"; reason: "manual" }): void;
} {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  return {
    session: {
      agent: { streamFunction },
      subscribe(listener: (event: AgentSessionEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as AgentSession,
    emit(event) {
      for (const listener of listeners) {
        listener(event as AgentSessionEvent);
      }
    },
  };
}

describe("service tier compatibility boundary", () => {
  it("projects only bounded, unique supported capabilities", () => {
    expect(modelServiceTiers({ provider: "p", id: "m" })).toBeUndefined();
    expect(modelServiceTiers({ serviceTiers: [] })).toEqual([]);
    expect(modelServiceTiers({
      serviceTiers: ["auto", "priority"],
    })).toEqual(["auto", "priority"]);

    for (const serviceTiers of [
      "priority",
      ["priority", "priority"],
      ["unknown"],
      ["auto", "default", "flex", "scale", "priority", "auto"],
    ]) {
      expect(() => modelServiceTiers({ serviceTiers })).toThrow(
        "invalid serviceTiers capability",
      );
    }
  });

  it("omits null and injects a validated live tier without changing other options", () => {
    const original = vi.fn();
    const { session } = fakeSession(original);
    let selected: ServiceTier | null = null;
    const override = installServiceTierOverride(session, () => selected);
    const options = { temperature: 0.25 };
    const model = {
      provider: "p",
      id: "m",
      serviceTiers: ["priority"],
    };

    session.agent.streamFunction(model as never, [] as never, options);
    expect(original).toHaveBeenLastCalledWith(model, [], options);

    selected = "priority";
    session.agent.streamFunction(model as never, [] as never, options);
    expect(original).toHaveBeenLastCalledWith(model, [], {
      temperature: 0.25,
      serviceTier: "priority",
    });

    selected = "flex";
    expect(() => session.agent.streamFunction(
      model as never,
      [] as never,
      options,
    )).toThrow('does not support service tier "flex"');
    expect(original).toHaveBeenCalledTimes(2);

    override.dispose();
    expect(session.agent.streamFunction).toBe(original);
  });

  it("composes with compaction thinking after manual auth identity", async () => {
    const original = vi.fn();
    const { session, emit } = fakeSession(original);
    const serviceTierOverride = installServiceTierOverride(
      session,
      () => "priority",
    );
    const compactionThinkingOverride = installCompactionThinkingOverride(
      session,
      "auto",
    );

    emit({ type: "compaction_start", reason: "manual" });
    expect(session.agent.streamFunction).toBe(original);

    await Promise.resolve();
    const model = {
      provider: "p",
      id: "m",
      reasoning: true,
      serviceTiers: ["priority"],
    };
    session.agent.streamFunction(
      model as never,
      [] as never,
      { reasoning: "max" },
    );
    expect(original).toHaveBeenCalledWith(model, [], {
      reasoning: "minimal",
      serviceTier: "priority",
    });

    compactionThinkingOverride.dispose();
    serviceTierOverride.dispose();
    expect(session.agent.streamFunction).toBe(original);
  });

  it("does not reinstall after disposal during manual compaction", async () => {
    const original = vi.fn();
    const { session, emit } = fakeSession(original);
    const override = installServiceTierOverride(session, () => "priority");

    emit({ type: "compaction_start", reason: "manual" });
    expect(session.agent.streamFunction).toBe(original);
    override.dispose();
    await Promise.resolve();

    expect(session.agent.streamFunction).toBe(original);
  });
});
