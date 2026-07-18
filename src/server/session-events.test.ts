import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  SessionEventProjector,
  snapshotWireValue,
  toWireValue,
} from "./session-events.js";

function nativeEvent(event: unknown): AgentSessionEvent {
  return event as AgentSessionEvent;
}

describe("SessionEventProjector", () => {
  it("recovers final-only assistant text and projects usage", () => {
    const projector = new SessionEventProjector();

    expect(projector.project(nativeEvent({ type: "agent_start" }))).toEqual([]);
    expect(projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final-only response" }],
        usage: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 10,
        },
      },
    }))).toEqual([
      { type: "text_replaced", text: "final-only response" },
      {
        type: "usage",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    ]);
  });

  it("calibrates streamed text from the final assistant message", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    }));

    expect(projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        usage: { totalTokens: 1 },
      },
    }))[0]).toEqual({ type: "text_replaced", text: "final" });
  });

  it("tracks only the final assistant error after SDK retries", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "temporary failure",
      },
    }));
    expect(projector.errorMessage).toBe("temporary failure");

    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
      },
    }));
    expect(projector.errorMessage).toBeUndefined();
  });
});

describe("toWireValue", () => {
  it("makes circular and bigint tool payloads JSON-safe", () => {
    const payload: Record<string, unknown> = { count: 3n };
    payload.self = payload;

    const projected = toWireValue(payload);

    expect(projected).toEqual({ count: "3", self: "[Circular]" });
    expect(() => JSON.stringify(projected)).not.toThrow();
  });

  it("bounds large tool payloads", () => {
    const projected = toWireValue({ output: "x".repeat(250_000) });
    expect(projected).toMatchObject({ truncated: true });
  });

  it("bounds collection traversal before serializing extension payloads", () => {
    const projected = toWireValue(Array.from({ length: 10_000 }, (_, index) => index));
    expect(projected).toMatchObject({ truncated: true });
  });

  it("does not throw when an extension value cannot be inspected or stringified", () => {
    const value = new Proxy({
      [Symbol.toPrimitive]: () => {
        throw new Error("cannot stringify");
      },
    }, {
      ownKeys: () => {
        throw new Error("cannot inspect");
      },
    });

    expect(() => toWireValue(value)).not.toThrow();
    expect(toWireValue(value)).toBe("[Unserializable]");
  });
});

describe("snapshotWireValue", () => {
  it("captures a detached, exact JSON-safe value", () => {
    const args = {
      command: "npm test",
      options: ["--run", 1, true, null],
    };

    const snapshot = snapshotWireValue(args);
    args.command = "changed after capture";

    expect(snapshot.value).toEqual({
      command: "npm test",
      options: ["--run", 1, true, null],
    });
    expect(snapshot.serialized).toBe(JSON.stringify(snapshot.value));
  });

  it("rejects values that cannot be represented losslessly as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => snapshotWireValue({ count: 3n })).toThrow();
    expect(() => snapshotWireValue(circular)).toThrow();
    expect(() => snapshotWireValue({ command: "x".repeat(200_001) })).toThrow();
  });
});
