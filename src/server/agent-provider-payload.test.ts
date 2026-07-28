import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  installAgentProviderPayloadHandler,
  type ProviderPayloadModel,
} from "./agent-provider-payload.js";

const MODEL: ProviderPayloadModel = {
  provider: "openai-codex",
  api: "openai-codex-responses",
  id: "gpt-5.6-sol",
};

function fakeSession(onPayload?: (
  payload: unknown,
  model: ProviderPayloadModel,
) => unknown | Promise<unknown>) {
  return {
    agent: { onPayload },
  } as unknown as AgentSession;
}

describe("installAgentProviderPayloadHandler", () => {
  it("measures the final UTF-8 payload after extension transforms", async () => {
    const extensionPayload = {
      input: "扩展后的请求",
      arguments: "\"quoted\"",
    };
    const extensionHook = vi.fn(async () => extensionPayload);
    const session = fakeSession(extensionHook);
    let observedBytes: number | undefined;
    const controller = installAgentProviderPayloadHandler(session, (input) => {
      observedBytes = input.serializedPayloadBytes;
      return undefined;
    });

    await expect(session.agent.onPayload?.({ input: "before" }, MODEL as never))
      .resolves.toEqual(extensionPayload);
    expect(extensionHook).toHaveBeenCalledOnce();
    expect(observedBytes).toBe(Buffer.byteLength(
      JSON.stringify(extensionPayload),
      "utf8",
    ));

    controller.dispose();
    expect(session.agent.onPayload).toBe(extensionHook);
  });

  it("preserves null as an extension replacement payload", async () => {
    const session = fakeSession(() => null);
    installAgentProviderPayloadHandler(session, () => undefined);

    await expect(session.agent.onPayload?.({ secret: "original" }, MODEL as never))
      .resolves.toBeNull();
  });

  it("returns a stable snapshot after measuring stateful JSON", async () => {
    let serializations = 0;
    const session = fakeSession(() => ({
      toJSON: () => ({
        input: "x".repeat(++serializations === 1 ? 1 : 1_000_000),
      }),
    }));
    installAgentProviderPayloadHandler(session, () => undefined);

    const stablePayload = await session.agent.onPayload?.({}, MODEL as never);
    expect(serializations).toBe(1);
    expect(JSON.stringify(stablePayload)).toBe('{"input":"x"}');
    expect(serializations).toBe(1);
  });

  it("does not inspect or snapshot another provider's payload", async () => {
    const transformedPayload = { input: "unchanged identity" };
    const handler = vi.fn();
    const session = fakeSession(() => transformedPayload);
    installAgentProviderPayloadHandler(session, handler);

    await expect(session.agent.onPayload?.({}, {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude",
    } as never)).resolves.toBe(transformedPayload);
    expect(handler).not.toHaveBeenCalled();
  });

  it("blocks before returning a provider payload", async () => {
    const session = fakeSession();
    installAgentProviderPayloadHandler(session, () => ({
      block: true,
      reason: "context_length_exceeded: request is unsafe",
    }));

    await expect(session.agent.onPayload?.({}, MODEL as never))
      .rejects.toThrow("context_length_exceeded: request is unsafe");
  });

  it("removes its wrapper when the Agent originally had no own hook", () => {
    const session = { agent: {} } as unknown as AgentSession;
    expect(Object.hasOwn(session.agent, "onPayload")).toBe(false);
    const controller = installAgentProviderPayloadHandler(
      session,
      () => undefined,
    );

    expect(Object.hasOwn(session.agent, "onPayload")).toBe(true);
    controller.dispose();
    expect(Object.hasOwn(session.agent, "onPayload")).toBe(false);
  });

  it("does not overwrite a later hook replacement during disposal", () => {
    const session = fakeSession(() => ({ original: true }));
    const controller = installAgentProviderPayloadHandler(
      session,
      () => undefined,
    );
    const replacement = vi.fn(() => ({ replacement: true }));
    session.agent.onPayload = replacement;

    controller.dispose();
    expect(session.agent.onPayload).toBe(replacement);
  });

  it("reports an unmeasurable transformed payload to the host check", async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const session = fakeSession(() => cyclic);
    let observedBytes = 0;
    installAgentProviderPayloadHandler(session, (input) => {
      observedBytes = input.serializedPayloadBytes ?? -1;
      return undefined;
    });

    await session.agent.onPayload?.({}, MODEL as never);
    expect(observedBytes).toBe(-1);
  });
});
