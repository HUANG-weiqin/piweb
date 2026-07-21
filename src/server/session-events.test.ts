import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  SessionEventProjector,
  snapshotWireValue,
  toWireValue,
} from "./session-events.js";
import { CONVERSATION_MESSAGE_CUSTOM_TYPE } from "./conversation-meta.js";

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
    expect(projector.finalText).toBe("final");
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

  it("splits assistant output around delivered steering messages", () => {
    const projector = new SessionEventProjector({
      suppressNextUserMessage: true,
    });
    projector.project(nativeEvent({ type: "agent_start" }));

    expect(projector.project(nativeEvent({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "initial" }] },
    }))).toEqual([]);
    expect(projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }))).toEqual([{
      type: "assistant_message_started",
      projectionId: expect.any(String),
    }]);
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "before guidance" }],
      },
    }));

    expect(projector.project(nativeEvent({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "change direction" }],
      },
    }))).toEqual([{
      type: "user_message",
      projectionId: expect.any(String),
      text: "change direction",
    }]);
    expect(projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }))).toEqual([{
      type: "assistant_message_started",
      projectionId: expect.any(String),
    }]);
    expect(projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after guidance" }],
      },
    }))).toContainEqual({
      type: "text_replaced",
      text: "after guidance",
    });
    expect(projector.finalText).toBe(
      "before guidance\n\nafter guidance",
    );
  });

  it("splits live assistant output around a delivered session message", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "before peer message" }],
      },
    }));

    expect(projector.project(nativeEvent({
      type: "message_start",
      message: {
        role: "custom",
        customType: CONVERSATION_MESSAGE_CUSTOM_TYPE,
        content: "hidden lifecycle guidance",
      },
    }))).toEqual([]);
    expect(projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }))).toEqual([{
      type: "assistant_message_started",
      projectionId: expect.any(String),
    }]);
    expect(projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after peer message" }],
      },
    }))).toContainEqual({
      type: "text_replaced",
      text: "after peer message",
    });
  });

  it("starts every physical assistant segment so timeline boundaries stay observable", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first physical message" }],
      },
    }));

    expect(projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }))).toEqual([{
      type: "assistant_message_started",
      projectionId: expect.any(String),
    }]);
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
