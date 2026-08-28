import { describe, expect, it } from "vitest";
import { resolveContextUsage } from "./session-usage.js";

describe("resolveContextUsage", () => {
  it("uses measured SDK usage when available", () => {
    expect(resolveContextUsage({
      contextWindow: 1000,
      nativeUsage: { tokens: 123, contextWindow: 1000 },
    })).toEqual({
      tokens: 123,
      contextWindow: 1000,
      percent: 12.3,
      source: "measured",
    });
  });

  it("estimates messages only when the SDK has no context reading", () => {
    const usage = resolveContextUsage({
      contextWindow: null,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    expect(usage.source).toBe("estimated");
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.contextWindow).toBeNull();
  });

  it("preserves an explicit SDK unknown after compaction", () => {
    expect(resolveContextUsage({
      contextWindow: 1000,
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "pre-compaction response" }],
        usage: { totalTokens: 900 },
      }],
      nativeUsage: { tokens: null, contextWindow: 1000 },
    })).toEqual({
      tokens: null,
      contextWindow: 1000,
      percent: null,
      source: "unknown",
    });
  });
});
