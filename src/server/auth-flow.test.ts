import { describe, expect, it, vi } from "vitest";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
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

function requestFrom(emit: ReturnType<typeof vi.fn>): { requestId: string; request: unknown } {
  const event = emit.mock.calls.at(-1)?.[0];
  if (!event || event.type !== "auth_request") throw new Error("auth request was not emitted");
  return event;
}

describe("AuthFlowBroker", () => {
  it("maps every prompt kind and correlates responses", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const prompts: AuthPrompt[] = [
      { type: "text", message: "Code?", placeholder: "text" },
      { type: "secret", message: "Token?", placeholder: "secret" },
      { type: "manual_code", message: "Callback?", placeholder: "manual" },
      { type: "select", message: "Account?", options: [
        { id: "one", label: "One", description: "first" },
      ] },
    ];
    const expected = [
      { kind: "prompt", message: "Code?", placeholder: "text", secret: false },
      { kind: "prompt", message: "Token?", placeholder: "secret", secret: true },
      { kind: "manual", message: "Callback?", placeholder: "manual" },
      { kind: "select", message: "Account?", options: [{ id: "one", label: "One" }] },
    ];

    for (const [index, prompt] of prompts.entries()) {
      const pending = broker.interaction.prompt(prompt);
      const request = requestFrom(emit);
      expect(request.request).toEqual(expected[index]);
      broker.respond({
        requestId: request.requestId,
        ...(prompt.type === "select" ? { selectedId: "one" } : { value: `value-${index}` }),
      });
      await expect(pending).resolves.toBe(prompt.type === "select" ? "one" : `value-${index}`);
    }
  });

  it("maps auth events, including safe info links, without HTML", () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const events: AuthEvent[] = [
      { type: "auth_url", url: "https://example.com/auth", instructions: "Open it" },
      { type: "device_code", userCode: "ABCD", verificationUri: "https://example.com/device", intervalSeconds: 5, expiresInSeconds: 60 },
      { type: "progress", message: "Waiting" },
      { type: "info", message: "Use this", links: [{ label: "Docs", url: "https://example.com/docs" }] },
    ];

    for (const event of events) broker.interaction.notify(event);

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "auth_request",
        authFlowId: AUTH_FLOW_ID,
        requestId: expect.any(String),
        request: { kind: "auth", url: "https://example.com/auth", instructions: "Open it" },
      },
      {
        type: "auth_request",
        authFlowId: AUTH_FLOW_ID,
        requestId: expect.any(String),
        request: { kind: "device", userCode: "ABCD", verificationUri: "https://example.com/device", expiresInSeconds: 60 },
      },
      { type: "auth_progress", authFlowId: AUTH_FLOW_ID, message: "Waiting" },
      {
        type: "auth_progress",
        authFlowId: AUTH_FLOW_ID,
        message: "Use this\nDocs: https://example.com/docs",
      },
    ]);
  });

  it("rejects invalid selections and selectedId spoofing", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const select = broker.interaction.prompt({
      type: "select",
      message: "Account?",
      options: [{ id: "valid", label: "Valid" }],
    });
    const selectRequest = requestFrom(emit);
    broker.respond({ requestId: selectRequest.requestId, selectedId: "forged" });
    await expect(select).rejects.toThrow("Invalid authentication selection");

    const text = broker.interaction.prompt({ type: "text", message: "Code?" });
    const textRequest = requestFrom(emit);
    broker.respond({ requestId: textRequest.requestId, selectedId: "forged" });
    await expect(text).rejects.toThrow("Invalid authentication response");
  });

  it("accepts a response emitted synchronously with the request", async () => {
    let broker!: AuthFlowBroker;
    broker = new AuthFlowBroker(AUTH_FLOW_ID, (event) => {
      if (event.type !== "auth_request") return;
      broker.respond({ requestId: event.requestId, value: "synchronous" });
    });

    await expect(within(
      broker.interaction.prompt({ type: "text", message: "Code?" }),
      100,
    )).resolves.toBe("synchronous");
  });

  it("rejects and removes a pending request when emit fails", async () => {
    let requestId: string | undefined;
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, (event) => {
      if (event.type === "auth_request") requestId = event.requestId;
      throw new Error("auth request emit failed");
    });

    await expect(broker.interaction.prompt({ type: "text", message: "Code?" })).rejects.toThrow(
      "auth request emit failed",
    );
    expect(requestId).toBeDefined();
    expect((broker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  it("rejects a pending prompt when its own signal aborts", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const controller = new AbortController();
    const pending = broker.interaction.prompt({
      type: "secret",
      message: "Token?",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect((broker as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    broker.respond({ requestId: requestFrom(emit).requestId, value: "late" });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("cancels all pending requests and suppresses late provider activity", async () => {
    const emit = vi.fn();
    const broker = new AuthFlowBroker(AUTH_FLOW_ID, emit);
    const pending = broker.interaction.prompt({ type: "text", message: "Code?" });
    broker.cancel();
    broker.interaction.notify({ type: "progress", message: "late" });
    broker.interaction.notify({ type: "auth_url", url: "https://example.com/late" });
    const latePrompt = broker.interaction.prompt({ type: "text", message: "late prompt" });

    await expect(pending).rejects.toThrow("cancelled");
    await expect(latePrompt).rejects.toThrow("cancelled");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
