import {
  getModel,
  isContextOverflow,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { describe, expect, it } from "vitest";
import {
  codexPayloadPressureError,
  CODEX_REQUEST_SAFETY_BYTES,
  measureSerializedContextBytes,
} from "./provider-context-pressure.js";

const CODEX_MODEL = {
  provider: "openai-codex",
  api: "openai-codex-responses",
};

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function testCodexToken(): string {
  const claims = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: "piweb-test-account",
    },
  };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("Codex provider payload pressure", () => {
  it("uses an overflow-compatible error at the exact byte boundary", () => {
    expect(codexPayloadPressureError(
      CODEX_MODEL,
      CODEX_REQUEST_SAFETY_BYTES - 1,
    )).toBeUndefined();

    const errorMessage = codexPayloadPressureError(
      CODEX_MODEL,
      CODEX_REQUEST_SAFETY_BYTES,
    );
    expect(errorMessage).toContain("context_length_exceeded");
    expect(isContextOverflow({
      ...assistantMessage([]),
      stopReason: "error",
      errorMessage,
    }, 372_000)).toBe(true);
  });

  it("fails closed only for unmeasurable Codex Responses payloads", () => {
    expect(codexPayloadPressureError(CODEX_MODEL, undefined))
      .toContain("unmeasurable size");
    expect(codexPayloadPressureError({
      provider: "anthropic",
      api: "anthropic-messages",
    }, undefined)).toBeUndefined();
  });

  it("measures the actual Codex body after tool arguments are encoded", async () => {
    const model = getModel("openai-codex", "gpt-5.4");
    expect(model).toBeDefined();
    const context: Context = {
      systemPrompt: "test",
      messages: [assistantMessage([{
        type: "toolCall",
        id: "call_1",
        name: "test_tool",
        arguments: { payload: "\"".repeat(300_000) },
      }])],
      tools: [],
    };
    const rawContextBytes = measureSerializedContextBytes(context);
    let finalPayloadBytes: number | undefined;

    const stream = streamSimple(model!, context, {
      apiKey: testCodexToken(),
      onPayload: (payload) => {
        finalPayloadBytes = measureSerializedContextBytes(payload);
        throw new Error("captured before transport");
      },
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("captured before transport");
    expect(rawContextBytes).toBeLessThan(CODEX_REQUEST_SAFETY_BYTES);
    expect(finalPayloadBytes).toBeGreaterThan(CODEX_REQUEST_SAFETY_BYTES);
    expect(finalPayloadBytes).toBeGreaterThan(rawContextBytes! * 1.9);
  });
});
