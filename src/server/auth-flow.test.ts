import { describe, expect, it, vi } from "vitest";
import { AuthFlowBroker } from "./auth-flow.js";

const AUTH_FLOW_ID = "597eb8f8-2aa8-444a-ac04-681a3c483fac";

describe("AuthFlowBroker", () => {
  it("correlates prompt responses", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const pending = broker.callbacks.onPrompt({ message: "Code?" });
    const requestId = emit.mock.calls[0][0].requestId;
    expect(emit.mock.calls[0][0].authFlowId).toBe(AUTH_FLOW_ID);
    broker.respond({ requestId, value: "123" });
    await expect(pending).resolves.toBe("123");
  });

  it("cancels pending requests", async () => {
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, () => undefined);
    const pending = broker.callbacks.onManualCodeInput?.();
    broker.cancel();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("suppresses provider callbacks that arrive after cancellation", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);

    broker.cancel();
    broker.callbacks.onProgress?.("late");
    broker.callbacks.onAuth?.({ url: "https://example.com" });
    const pending = broker.callbacks.onPrompt({ message: "late prompt" });

    await expect(pending).rejects.toThrow("cancelled");
    expect(emit).not.toHaveBeenCalled();
  });
});
