import { describe, expect, it, vi } from "vitest";
import { AuthFlowBroker } from "./auth-flow.js";

const AUTH_FLOW_ID = "597eb8f8-2aa8-444a-ac04-681a3c483fac";

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  it("accepts a response emitted synchronously with the request", async () => {
    let broker!: AuthFlowBroker;
    broker = new AuthFlowBroker(AUTH_FLOW_ID, (event) => {
      if (event.type !== "auth_request") return;
      broker.respond({ requestId: event.requestId, value: "synchronous" });
    });

    await expect(within(
      broker.callbacks.onPrompt({ message: "Code?" }),
      100,
    )).resolves.toBe("synchronous");
  });

  it("rejects and removes a pending request when emit fails", async () => {
    let requestId: string | undefined;
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, (event) => {
      if (event.type === "auth_request") requestId = event.requestId;
      throw new Error("auth request emit failed");
    });

    await expect(broker.callbacks.onPrompt({ message: "Code?" })).rejects.toThrow(
      "auth request emit failed",
    );
    expect(requestId).toBeDefined();
    expect((broker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
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
