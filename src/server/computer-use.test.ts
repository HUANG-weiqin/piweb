import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsDesktopAdapter,
  DesktopController,
  MAX_COMPUTER_CALL_MS,
  type DesktopCapture,
  type DesktopClick,
  type DesktopPrimitiveDispatch,
  type DesktopScroll,
  type WindowsDesktopAdapter,
} from "./computer-use.js";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function capture(overrides: Partial<DesktopCapture> = {}): DesktopCapture {
  return {
    png: PNG,
    width: 100,
    height: 50,
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    ...overrides,
  };
}

function request(
  owner: object,
  toolCallId: string,
  input: unknown,
  signal = new AbortController().signal,
  visionSupported = true,
) {
  return { owner, toolCallId, input, signal, visionSupported };
}

class FakeDesktopAdapter implements WindowsDesktopAdapter {
  readonly calls: string[] = [];
  readonly clicks: DesktopClick[] = [];
  readonly scrolls: DesktopScroll[] = [];
  readonly typed: string[] = [];
  readonly keypresses: string[][] = [];
  readonly waits: number[] = [];
  captures: Array<DesktopCapture | Error> = [capture()];
  clickResult: DesktopPrimitiveDispatch = "sent";
  typeResult: DesktopPrimitiveDispatch = "sent";
  keypressResult: DesktopPrimitiveDispatch = "sent";
  scrollResult: DesktopPrimitiveDispatch = "sent";
  waitResult: DesktopPrimitiveDispatch = "sent";
  onClick: (() => Promise<void> | void) | undefined;
  onWait: ((signal: AbortSignal) => Promise<DesktopPrimitiveDispatch>) | undefined;
  disposed = false;

  async capture(_signal: AbortSignal): Promise<DesktopCapture> {
    this.calls.push("capture");
    const next = this.captures.shift() ?? capture();
    if (next instanceof Error) throw next;
    return next;
  }

  async click(input: DesktopClick, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("click");
    this.clicks.push(input);
    await this.onClick?.();
    return this.clickResult;
  }

  async type(text: string, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("type");
    this.typed.push(text);
    return this.typeResult;
  }

  async keypress(keys: readonly string[], _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("keypress");
    this.keypresses.push([...keys]);
    return this.keypressResult;
  }

  async scroll(input: DesktopScroll, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("scroll");
    this.scrolls.push(input);
    return this.scrollResult;
  }

  async wait(ms: number, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("wait");
    this.waits.push(ms);
    return this.onWait ? this.onWait(signal) : this.waitResult;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopController", () => {
  it("rejects every invalid flat input before acquiring a lease or touching the adapter", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const invalidOwner = {};
    const invalids: unknown[] = [
      { actions: [], observe: false },
      { actions: Array.from({ length: 9 }, () => ({ kind: "wait", ms: 0 })), observe: false },
      { actions: [{ kind: "click", x: 1, y: 1, extra: true }], observe: false },
      { actions: [{ kind: "type", text: "x".repeat(4_097) }], observe: false },
      { actions: [{ kind: "keypress", keys: ["CTRL", "NOT_A_KEY"] }], observe: false },
      { actions: [{ kind: "scroll", x: 1, y: 1, deltaY: 0 }], observe: false },
      { actions: [{ kind: "wait", ms: 5_001 }], observe: false },
    ];

    for (const input of invalids) {
      await expect(controller.execute(request(invalidOwner, "invalid", input))).rejects.toThrow();
    }
    expect(adapter.calls).toEqual([]);

    const validOwner = {};
    await expect(controller.execute(request(validOwner, "observe", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    expect(adapter.calls).toEqual(["capture"]);
  });

  it("fails vision admission before lease acquisition or a desktop side effect", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);

    const rejected = await controller.execute(request({}, "without-vision", {
      actions: [],
      observe: true,
    }, new AbortController().signal, false));
    expect(rejected.details).toMatchObject({
      outcome: "rejected",
      reason: "vision_required",
      actions: [],
    });
    expect(adapter.calls).toEqual([]);

    await expect(controller.execute(request({}, "with-vision", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    expect(adapter.calls).toEqual(["capture"]);
  });

  it("keeps image delivery correlated by source call ID, then grants only the completed assistant tool calls a frame", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const owner = {};
    const sourceToolCallId = ["observe", "source"].join("-");

    const observed = await controller.execute(request(owner, sourceToolCallId, {
      actions: [],
      observe: true,
    }));
    expect(controller.authorizeFrame(owner, ["premature-click"])).toBe(false);
    const firstImage = controller.prepareProviderImage(owner, sourceToolCallId);
    expect(firstImage).toMatchObject({
      sourceToolCallId,
      mimeType: "image/png",
      width: 100,
      height: 50,
    });
    expect(controller.prepareProviderImage({}, sourceToolCallId)).toBeUndefined();
    expect(controller.prepareProviderImage(owner, "other-source")).toBeUndefined();
    firstImage!.png[0] = 0;
    expect(controller.prepareProviderImage(owner, sourceToolCallId)!.png[0]).toBe(137);

    expect(controller.authorizeFrame(owner, ["click-call"])).toBe(false);
    expect(controller.markProviderImagePresented(owner, sourceToolCallId)).toBe(true);
    expect(controller.authorizeFrame(owner, ["click-call"])).toBe(true);
    expect(controller.prepareProviderImage(owner, sourceToolCallId)).toBeUndefined();
    await expect(controller.execute(request(owner, "wrong-call", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).rejects.toThrow("authorized current observation");

    const clicked = await controller.execute(request(owner, "click-call", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }));
    expect(clicked.details).toMatchObject({
      outcome: "completed",
      actions: [{ index: 0, kind: "click", status: "sent" }],
      observation: { status: "unavailable" },
    });
    expect(adapter.calls).toEqual(["capture", "click"]);

    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain("iVBOR");
    expect(serialized).not.toContain("png");
    expect(observed.content).toEqual([{
      type: "text",
      text: JSON.stringify(observed.details),
    }]);
  });

  it("invalidates an authorized frame before its first primitive and never reuses it", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "observe", { actions: [], observe: true }));
    controller.prepareProviderImage(owner, "observe");
    controller.markProviderImagePresented(owner, "observe");
    expect(controller.authorizeFrame(owner, ["first", "second"])).toBe(true);

    let nestedOutcome: "error" | "result" | undefined;
    adapter.onClick = async () => {
      try {
        await controller.execute(request(owner, "second", {
          actions: [{ kind: "click", x: 2, y: 2 }],
          observe: false,
        }));
        nestedOutcome = "result";
      } catch {
        nestedOutcome = "error";
      }
    };
    await controller.execute(request(owner, "first", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }));

    expect(nestedOutcome).toBe("error");
    await expect(controller.execute(request(owner, "second", {
      actions: [{ kind: "click", x: 2, y: 2 }],
      observe: false,
    }))).rejects.toThrow("authorized current observation");
  });

  it("enforces one total deadline across a cancellable wait and preserves the lease until it settles", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeDesktopAdapter();
      const controller = new DesktopController(adapter);
      const owner = {};
      adapter.onWait = (signal) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("unknown"), { once: true });
      });

      const running = controller.execute(request(owner, "timed-wait", {
        actions: [
          { kind: "wait", ms: 5_000 },
          { kind: "type", text: "must not run" },
        ],
        observe: false,
      }));
      await vi.advanceTimersByTimeAsync(MAX_COMPUTER_CALL_MS);

      await expect(running).resolves.toMatchObject({
        details: {
          outcome: "interrupted",
          reason: "timed_out",
          actions: [
            { index: 0, kind: "wait", status: "unknown" },
            { index: 1, kind: "type", status: "not_started" },
          ],
        },
      });
      expect(adapter.calls).toEqual(["wait"]);
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "desktop_busy" } });
      await controller.release(owner);
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at the deadline for an uncooperative primitive but transfers the lease only after quiescence", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeDesktopAdapter();
      const controller = new DesktopController(adapter);
      const owner = {};
      let settleWait!: (value: DesktopPrimitiveDispatch) => void;
      adapter.onWait = async () => new Promise<DesktopPrimitiveDispatch>((resolve) => {
        settleWait = resolve;
      });

      const timed = controller.execute(request(owner, "uncooperative-wait", {
        actions: [
          { kind: "wait", ms: 0 },
          { kind: "type", text: "must not run" },
        ],
        observe: false,
      }));
      await vi.advanceTimersByTimeAsync(MAX_COMPUTER_CALL_MS);
      await expect(timed).resolves.toMatchObject({
        details: {
          outcome: "interrupted",
          reason: "timed_out",
          actions: [
            { index: 0, kind: "wait", status: "unknown" },
            { index: 1, kind: "type", status: "not_started" },
          ],
        },
      });

      let released = false;
      const release = controller.release(owner).then(() => { released = true; });
      await Promise.resolve();
      expect(released).toBe(false);
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "desktop_busy" } });

      settleWait("sent");
      await release;
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at the deadline for an uncooperative capture but retains the lease until it quiesces", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeDesktopAdapter();
      const controller = new DesktopController(adapter);
      const owner = {};
      const nativeCapture = deferred<DesktopCapture>();
      // Deliberately ignores the controller's AbortSignal.
      adapter.capture = () => nativeCapture.promise;

      const timed = controller.execute(request(owner, "uncooperative-capture", {
        actions: [],
        observe: true,
      }));
      await vi.advanceTimersByTimeAsync(MAX_COMPUTER_CALL_MS);
      await expect(timed).resolves.toMatchObject({
        details: {
          outcome: "interrupted",
          reason: "timed_out",
          actions: [],
          observation: { status: "unavailable" },
        },
      });

      let released = false;
      const release = controller.release(owner).then(() => { released = true; });
      await Promise.resolve();
      expect(released).toBe(false);
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "desktop_busy" } });

      nativeCapture.resolve(capture());
      await release;
      await expect(controller.execute(request({}, "new-owner", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects an elapsed deadline after an event-loop-blocking primitive before its timer can run", async () => {
    const now = vi.spyOn(performance, "now");
    let elapsed = 0;
    now.mockImplementation(() => elapsed);
    try {
      const adapter = new FakeDesktopAdapter();
      const controller = new DesktopController(adapter);
      adapter.onWait = async () => {
        // Models a synchronous native call that prevents the timeout callback
        // from running, but consumes the complete call budget.
        elapsed = MAX_COMPUTER_CALL_MS + 1;
        return "sent";
      };

      await expect(controller.execute(request({}, "blocked-native", {
        actions: [
          { kind: "wait", ms: 0 },
          { kind: "type", text: "must not run" },
        ],
        observe: false,
      }))).resolves.toMatchObject({
        details: {
          outcome: "interrupted",
          reason: "timed_out",
          actions: [
            { index: 0, kind: "wait", status: "sent" },
            { index: 1, kind: "type", status: "not_started" },
          ],
        },
      });
      expect(adapter.calls).toEqual(["wait"]);
    } finally {
      now.mockRestore();
    }
  });

  it("labels sync primitive and capture failures timed_out when they consumed the deadline", async () => {
    const now = vi.spyOn(performance, "now");
    let elapsed = 0;
    now.mockImplementation(() => elapsed);
    try {
      const primitiveAdapter = new FakeDesktopAdapter();
      primitiveAdapter.onWait = async () => {
        elapsed = MAX_COMPUTER_CALL_MS + 1;
        throw new Error("native wait failed");
      };
      await expect(new DesktopController(primitiveAdapter).execute(request({}, "blocked-failure", {
        actions: [{ kind: "wait", ms: 0 }],
        observe: false,
      }))).resolves.toMatchObject({
        details: {
          outcome: "interrupted",
          reason: "timed_out",
          actions: [{ index: 0, status: "unknown" }],
        },
      });

      elapsed = 0;
      const captureAdapter = new FakeDesktopAdapter();
      captureAdapter.capture = async () => {
        elapsed = MAX_COMPUTER_CALL_MS + 1;
        throw new Error("native capture failed");
      };
      await expect(new DesktopController(captureAdapter).execute(request({}, "blocked-capture", {
        actions: [],
        observe: true,
      }))).resolves.toMatchObject({
        details: { outcome: "interrupted", reason: "timed_out" },
      });
    } finally {
      now.mockRestore();
    }
  });

  it("maps screenshot pixels to physical bounds without clamping and executes a batch in order", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture({
      bounds: { x: 10, y: 20, width: 200, height: 100 },
    })];
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "observe", { actions: [], observe: true }));
    controller.prepareProviderImage(owner, "observe");
    controller.markProviderImagePresented(owner, "observe");
    controller.authorizeFrame(owner, ["batch"]);
    await expect(controller.execute(request(owner, "batch", {
      actions: [{ kind: "click", x: 100, y: 0 }],
      observe: false,
    }))).rejects.toThrow("outside the current observation");
    expect(adapter.calls).toEqual(["capture"]);

    const batch = await controller.execute(request(owner, "batch", {
      actions: [
        { kind: "click", x: 99, y: 49, button: "right" },
        { kind: "type", text: "hello" },
        { kind: "keypress", keys: ["CTRL", "l"] },
        { kind: "scroll", x: 0, y: 0, deltaX: -120, deltaY: 240 },
        { kind: "wait", ms: 0 },
      ],
      observe: false,
    }));
    expect(batch.details).toMatchObject({
      outcome: "completed",
      actions: [
        { status: "sent" },
        { status: "sent" },
        { status: "sent" },
        { status: "sent" },
        { status: "sent" },
      ],
    });
    expect(adapter.calls).toEqual([
      "capture",
      "click",
      "type",
      "keypress",
      "scroll",
      "wait",
    ]);
    expect(adapter.clicks[0]).toMatchObject({
      button: "right",
      point: { x: 209, y: 119, bounds: { x: 10, y: 20, width: 200, height: 100 } },
    });
    expect(adapter.scrolls[0]).toMatchObject({
      point: { x: 10, y: 20 },
      deltaX: -120,
      deltaY: 240,
    });
    expect(adapter.keypresses).toEqual([["CTRL", "L"]]);
  });

  it("reports sent, unknown, and not_started actions truthfully for aborts and partial dispatch", async () => {
    const abortAdapter = new FakeDesktopAdapter();
    const abortController = new DesktopController(abortAdapter);
    const owner = {};
    const signalController = new AbortController();
    await abortController.execute(request(owner, "observe", { actions: [], observe: true }));
    abortController.prepareProviderImage(owner, "observe");
    abortController.markProviderImagePresented(owner, "observe");
    abortController.authorizeFrame(owner, ["abort-batch"]);
    abortAdapter.onClick = () => signalController.abort();

    const aborted = await abortController.execute(request(owner, "abort-batch", {
      actions: [
        { kind: "click", x: 1, y: 1 },
        { kind: "type", text: "after" },
      ],
      observe: false,
    }, signalController.signal));
    expect(aborted.details).toMatchObject({
      outcome: "interrupted",
      actions: [
        // The run aborted before the adapter's promise settled, so the host
        // cannot honestly confirm the click even though the adapter later
        // returns its normal default value.
        { index: 0, status: "unknown" },
        { index: 1, status: "not_started" },
      ],
      observation: { status: "unavailable" },
    });

    const partialAdapter = new FakeDesktopAdapter();
    partialAdapter.typeResult = "unknown";
    const partialController = new DesktopController(partialAdapter);
    const partial = await partialController.execute(request({}, "partial", {
      actions: [
        { kind: "type", text: "possibly sent" },
        { kind: "keypress", keys: ["ENTER"] },
      ],
      observe: false,
    }));
    expect(partial.details).toMatchObject({
      outcome: "interrupted",
      actions: [
        { index: 0, kind: "type", status: "unknown" },
        { index: 1, kind: "keypress", status: "not_started" },
      ],
    });
    expect(partialAdapter.calls).toEqual(["type"]);
  });

  it("replaces old image state on every capture attempt and never keeps a failed capture", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture(), new Error("capture failed"), capture({ width: 101 })];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "first", { actions: [], observe: true }));
    expect(controller.prepareProviderImage(owner, "first")).toBeDefined();

    const failed = await controller.execute(request(owner, "second", { actions: [], observe: true }));
    expect(failed.details).toMatchObject({
      outcome: "interrupted",
      observation: { status: "unavailable" },
    });
    expect(controller.prepareProviderImage(owner, "first")).toBeUndefined();
    expect(controller.prepareProviderImage(owner, "second")).toBeUndefined();

    await controller.execute(request(owner, "third", { actions: [], observe: true }));
    expect(controller.prepareProviderImage(owner, "first")).toBeUndefined();
    expect(controller.prepareProviderImage(owner, "third")).toMatchObject({ width: 101 });
  });

  it("uses exact owner identity, releases only after an active operation settles, and disposes safely", async () => {
    const adapter = new FakeDesktopAdapter();
    const wait = deferred<DesktopPrimitiveDispatch>();
    adapter.onWait = () => wait.promise;
    const controller = new DesktopController(adapter);
    const firstOwner = { same: "value" };
    const secondOwner = { same: "value" };

    const active = controller.execute(request(firstOwner, "wait", {
      actions: [{ kind: "wait", ms: 1 }],
      observe: false,
    }));
    expect(adapter.calls).toEqual(["wait"]);
    const release = controller.release(firstOwner);
    const whileReleasing = await controller.execute(request(secondOwner, "blocked", {
      actions: [],
      observe: true,
    }));
    expect(whileReleasing.details.outcome).toBe("desktop_busy");
    await controller.release({ same: "value" });
    expect((await controller.execute(request(secondOwner, "still-blocked", {
      actions: [],
      observe: true,
    }))).details.outcome).toBe("desktop_busy");

    wait.resolve("sent");
    await active;
    await release;
    await expect(controller.execute(request(secondOwner, "after-release", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });

    await controller.dispose();
    expect(adapter.disposed).toBe(true);
    expect((await controller.execute(request({}, "after-dispose", {
      actions: [],
      observe: true,
    }))).details).toMatchObject({
      outcome: "rejected",
      reason: "controller_disposed",
    });
  });
});

if (process.platform !== "win32") {
  describe("createWindowsDesktopAdapter", () => {
    it("fails closed without loading a desktop ABI on non-Windows platforms", async () => {
      await expect(createWindowsDesktopAdapter()).rejects.toThrow("only available on win32");
    });
  });
}
