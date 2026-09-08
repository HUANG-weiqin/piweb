import { describe, expect, it, vi } from "vitest";
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

  it("projects streamed text with an ephemeral Pi-base output estimate", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
    };
    expect(projector.project(nativeEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "reply",
        partial,
      },
    }))).toEqual([
      { type: "text_delta", delta: "reply" },
      { type: "output_estimate", estimatedOutputTokens: 2 },
    ]);
  });

  it("caps Pi-base output estimates at one projection per 250ms", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-06T16:00:00.000Z"));
      const projector = new SessionEventProjector();
      projector.project(nativeEvent({ type: "agent_start" }));
      const first = {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      };
      expect(projector.project(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "first", partial: first },
      }))).toHaveLength(2);

      vi.advanceTimersByTime(249);
      const second = {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      };
      expect(projector.project(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "second", partial: second },
      }))).toEqual([{ type: "text_delta", delta: "second" }]);

      vi.advanceTimersByTime(1);
      const third = {
        role: "assistant",
        content: [{ type: "text", text: "third" }],
      };
      expect(projector.project(nativeEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "third", partial: third },
      }))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calibrates streamed text from the final assistant message", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    };
    projector.project(nativeEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial", partial },
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

  it("projects image-only user messages without exposing image data", () => {
    const projector = new SessionEventProjector();
    expect(projector.project(nativeEvent({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "secret-base64" }],
      },
    }))).toEqual([{
      type: "user_message",
      projectionId: expect.any(String),
      text: "[图片]",
    }]);
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

  it("preserves completed text across a host-requested physical continuation", () => {
    const projector = new SessionEventProjector();
    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "before compaction" }],
      },
    }));

    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "after compaction" }],
      },
    }));

    expect(projector.finalText).toBe(
      "before compaction\n\nafter compaction",
    );
  });

  it("rolls back only the failed physical segment before an SDK retry", () => {
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
        content: [{ type: "text", text: "completed tool turn" }],
        stopReason: "toolUse",
      },
    }));
    projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "temporary provider error" }],
        stopReason: "error",
        errorMessage: "retryable",
      },
    }));

    projector.project(nativeEvent({ type: "agent_start" }));
    projector.project(nativeEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }));
    projector.project(nativeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
      },
    }));

    expect(projector.finalText).toBe(
      "completed tool turn\n\nrecovered",
    );
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

  it("retains the current edit budget when a large tool result is bounded", () => {
    const projected = toWireValue({
      content: [{ type: "text", text: "x".repeat(250_000) }],
      details: {
        ...Object.fromEntries(Array.from(
          { length: 2_000 },
          (_, index) => [`extension-${index}`, index],
        )),
        piwebEditBudget: {
          countedNewFile: true,
          grantedFiles: 2,
          chargedFiles: 2,
          touchedFiles: 1,
          remainingFiles: 1,
          blockedAttempts: 0,
        },
      },
    });

    expect(projected).toMatchObject({
      truncated: true,
      details: {
        piwebEditBudget: {
          countedNewFile: true,
          grantedFiles: 2,
          chargedFiles: 2,
          touchedFiles: 1,
          remainingFiles: 1,
          blockedAttempts: 0,
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(projected), "utf8"))
      .toBeLessThan(200_000);
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

  it("does not throw when a proxy array rejects inspection", () => {
    const value = new Proxy([], {
      get: () => {
        throw new Error("cannot inspect array");
      },
    });

    expect(() => toWireValue(value)).not.toThrow();
    expect(toWireValue(value)).toBe("[Unserializable]");
  });

  it("bounds a proxy fallback that stringifies to a huge value", () => {
    const value = new Proxy([], {
      get: (_target, key) => {
        if (key === Symbol.toPrimitive) return () => "x".repeat(250_000);
        throw new Error("cannot inspect array");
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

    expect(snapshot).toEqual({
      command: "npm test",
      options: ["--run", 1, true, null],
    });
  });

  it("rejects values that cannot be represented losslessly as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => snapshotWireValue({ count: 3n })).toThrow();
    expect(() => snapshotWireValue(circular)).toThrow();
    expect(() => snapshotWireValue({ command: "x".repeat(200_001) })).toThrow();
  });
});
