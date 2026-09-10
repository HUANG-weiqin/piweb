import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../shared/protocol.js";
import { ExtensionUIBroker } from "./extension-ui.js";

const SESSION_A = "0dd23f7c-80c8-4713-b7a7-33c00177a101";
const SESSION_B = "e15c861c-e18f-4290-bc22-8932f3caaf4e";
const REQUEST_A = "a81ab25f-041e-4559-b890-04c0eeb476e4";
const REQUEST_B = "668034c9-2181-4ea5-bbb0-6a5ef8cc9ff1";

afterEach(() => {
  vi.useRealTimers();
});

describe("ExtensionUIBroker", () => {
  it("correlates a dialog exactly and validates select values against its snapshot", async () => {
    const events: ServerEvent[] = [];
    const ids = [REQUEST_A];
    const broker = new ExtensionUIBroker(
      (event) => events.push(event),
      () => ids.shift() ?? REQUEST_A,
    );
    const options = ["alpha", "beta"];
    const result = broker.context({
      sessionId: SESSION_A,
      generation: 1,
    }).select("Choose", options);
    options.push("injected");

    expect(events[0]).toEqual({
      type: "extension_ui_request",
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      request: {
        kind: "select",
        title: "Choose",
        options: ["alpha", "beta"],
      },
    });
    expect(broker.respond({
      sessionId: SESSION_B,
      requestId: REQUEST_A,
      response: { kind: "select", value: "alpha" },
    })).toBe(false);
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "input", value: "alpha" },
    })).toBe(false);
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "select", value: "injected" },
    })).toBe(false);

    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "select", value: "beta" },
    })).toBe(true);
    await expect(result).resolves.toBe("beta");
    expect(events[1]).toEqual({
      type: "extension_ui_closed",
      sessionId: SESSION_A,
      requestId: REQUEST_A,
    });
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "select", value: "alpha" },
    })).toBe(false);
  });

  it("settles with Pi defaults on timeout, signal abort, and scope cancellation", async () => {
    vi.useFakeTimers();
    const events: ServerEvent[] = [];
    const ids = [REQUEST_A, REQUEST_B];
    const broker = new ExtensionUIBroker(
      (event) => events.push(event),
      () => ids.shift() ?? crypto.randomUUID(),
    );
    const lifecycle = new AbortController();
    const ui = broker.context({
      sessionId: SESSION_A,
      generation: 7,
      signal: lifecycle.signal,
    });

    const confirmation = ui.confirm("Confirm", "Continue?", { timeout: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(confirmation).resolves.toBe(false);

    const input = ui.input("Input");
    lifecycle.abort();
    await expect(input).resolves.toBeUndefined();

    expect(events.filter(({ type }) => type === "extension_ui_request")).toHaveLength(2);
    expect(events.filter(({ type }) => type === "extension_ui_closed")).toHaveLength(2);
  });

  it("settles an editor on dialog-signal abort and rejects a late response", async () => {
    const events: ServerEvent[] = [];
    const broker = new ExtensionUIBroker(
      (event) => events.push(event),
      () => REQUEST_A,
    );
    const controller = new AbortController();
    const editor = broker.context({
      sessionId: SESSION_A,
      generation: 3,
    }).editor("Edit", "draft", { signal: controller.signal });

    expect(events[0]).toMatchObject({
      type: "extension_ui_request",
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      request: { kind: "editor", title: "Edit", prefill: "draft" },
    });
    controller.abort();

    await expect(editor).resolves.toBeUndefined();
    expect(events[1]).toEqual({
      type: "extension_ui_closed",
      sessionId: SESSION_A,
      requestId: REQUEST_A,
    });
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "editor", value: "late" },
    })).toBe(false);
  });

  it("cancels one generation without settling another and forwards notifications", async () => {
    const events: ServerEvent[] = [];
    const ids = [REQUEST_A, REQUEST_B];
    const broker = new ExtensionUIBroker(
      (event) => events.push(event),
      () => ids.shift() ?? crypto.randomUUID(),
    );
    const oldResult = broker.context({
      sessionId: SESSION_A,
      generation: 1,
    }).editor("Old", "draft");
    const currentResult = broker.context({
      sessionId: SESSION_A,
      generation: 2,
    }).input("Current");

    broker.cancelScope(SESSION_A, 1);
    await expect(oldResult).resolves.toBeUndefined();
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_B,
      response: { kind: "input", value: "" },
    })).toBe(true);
    await expect(currentResult).resolves.toBe("");

    broker.context({
      sessionId: SESSION_A,
      generation: 2,
    }).notify("ready", "warning");
    expect(events.at(-1)).toEqual({
      type: "extension_ui_notification",
      sessionId: SESSION_A,
      level: "warning",
      message: "ready",
    });
  });

  it("drains every dialog when close observations throw", async () => {
    const ids = [REQUEST_A, REQUEST_B];
    const closedRequestIds: string[] = [];
    const broker = new ExtensionUIBroker(
      (event) => {
        if (event.type !== "extension_ui_closed") return;
        closedRequestIds.push(event.requestId);
        throw new Error("close projection failed");
      },
      () => ids.shift() ?? crypto.randomUUID(),
    );
    const ui = broker.context({
      sessionId: SESSION_A,
      generation: 1,
    });
    const input = ui.input("Input");
    const confirmation = ui.confirm("Confirm", "Continue?");

    expect(() => broker.cancelAll()).not.toThrow();
    await expect(input).resolves.toBeUndefined();
    await expect(confirmation).resolves.toBe(false);
    expect(closedRequestIds).toEqual([REQUEST_A, REQUEST_B]);
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_A,
      response: { kind: "input", value: "late" },
    })).toBe(false);
    expect(broker.respond({
      sessionId: SESSION_A,
      requestId: REQUEST_B,
      response: { kind: "confirm", confirmed: true },
    })).toBe(false);
  });

  it("bounds one-time request identities for the lifetime of a connection", async () => {
    let sequence = 0;
    const broker = new ExtensionUIBroker(
      () => undefined,
      () => `00000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    );
    const ui = broker.context({
      sessionId: SESSION_A,
      generation: 1,
    });

    for (let index = 0; index < 4_096; index++) {
      const result = ui.input("bounded");
      expect(broker.respond({
        sessionId: SESSION_A,
        requestId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        response: { kind: "cancel" },
      })).toBe(true);
      await expect(result).resolves.toBeUndefined();
    }

    expect(() => ui.input("one too many")).toThrow(
      "Extension UI request limit exceeded",
    );
  });

  it("rejects oversized dialog content instead of silently truncating it", async () => {
    const events: ServerEvent[] = [];
    const broker = new ExtensionUIBroker((event) => events.push(event));

    await expect(broker.context({
      sessionId: SESSION_A,
      generation: 1,
    }).confirm("x".repeat(501), "message")).rejects.toThrow(
      "not representable",
    );
    expect(events).toEqual([]);
  });
});
