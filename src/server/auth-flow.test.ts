import { describe, expect, it, vi } from "vitest";
import { AuthFlowBroker } from "./auth-flow.js";

describe("AuthFlowBroker", () => {
  it("correlates prompt responses", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(emit);
    const pending = broker.callbacks.onPrompt({ message: "Code?" });
    const requestId = emit.mock.calls[0][0].requestId;
    broker.respond({ requestId, value: "123" });
    await expect(pending).resolves.toBe("123");
  });

  it("cancels pending requests", async () => {
    const broker = new AuthFlowBroker(() => undefined);
    const pending = broker.callbacks.onManualCodeInput?.();
    broker.cancel();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
