import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsDesktopAdapter,
  createWindowsDesktopCaptureAdapterForTest,
  createWindowsDesktopInputAdapterForTest,
  DesktopController,
  MAX_COMPUTER_CALL_MS,
  type DesktopCapture,
  type DesktopCaptureScope,
  type DesktopClick,
  type DesktopForegroundIdentity,
  type DesktopForegroundWindowBinding,
  type DesktopPrimitiveDispatch,
  type DesktopProviderEvidence,
  type DesktopScroll,
  type WindowsDesktopAdapter,
  type WindowsDesktopCaptureTestNative,
} from "./computer-use.js";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const PRIMARY_BOUNDS = { x: 0, y: 0, width: 100, height: 50 };

function foregroundWindowBinding(
  overrides: Partial<DesktopForegroundWindowBinding> = {},
): DesktopForegroundWindowBinding {
  return {
    foreground: { hwnd: "100", processId: 100 },
    rawBounds: { x: 20, y: 10, width: 40, height: 20 },
    captureBounds: { x: 20, y: 10, width: 40, height: 20 },
    inputBounds: PRIMARY_BOUNDS,
    ...overrides,
  };
}

function capture(overrides: Partial<DesktopCapture> = {}): DesktopCapture {
  const width = overrides.width ?? 100;
  const height = overrides.height ?? 50;
  const bounds = { x: 0, y: 0, width, height };
  return {
    png: PNG,
    width,
    height,
    scope: "primary_display",
    captureBounds: bounds,
    inputBounds: bounds,
    foreground: { hwnd: "100", processId: 100 },
    ...overrides,
  };
}

function foregroundWindowCapture(overrides: Partial<DesktopCapture> = {}): DesktopCapture {
  const binding = overrides.foregroundWindow ?? foregroundWindowBinding();
  return {
    ...capture(),
    scope: "foreground_window",
    width: binding.captureBounds.width,
    height: binding.captureBounds.height,
    captureBounds: binding.captureBounds,
    inputBounds: binding.inputBounds,
    foreground: binding.foreground,
    foregroundWindow: binding,
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
  readonly keypressHoldMs: number[] = [];
  readonly moves: unknown[] = [];
  readonly mouseHolds: unknown[] = [];
  readonly drags: unknown[] = [];
  readonly waits: number[] = [];
  readonly captureScopes: DesktopCaptureScope[] = [];
  captures: Array<DesktopCapture | Error> = [capture()];
  foregroundResult: DesktopForegroundIdentity | Error = { hwnd: "100", processId: 100 };
  foregroundWindowResults: Array<DesktopForegroundWindowBinding | Error> = [foregroundWindowBinding()];
  foregroundChecks = 0;
  foregroundWindowChecks = 0;
  clickResult: DesktopPrimitiveDispatch = "sent";
  typeResult: DesktopPrimitiveDispatch = "sent";
  keypressResult: DesktopPrimitiveDispatch = "sent";
  scrollResult: DesktopPrimitiveDispatch = "sent";
  moveResult: DesktopPrimitiveDispatch = "sent";
  mouseHoldResult: DesktopPrimitiveDispatch = "sent";
  dragResult: DesktopPrimitiveDispatch = "sent";
  waitResult: DesktopPrimitiveDispatch = "sent";
  onClick: (() => Promise<void> | void) | undefined;
  onKeypress: ((
    keys: readonly string[],
    holdMs: number,
    signal: AbortSignal,
  ) => Promise<DesktopPrimitiveDispatch>) | undefined;
  onWait: ((signal: AbortSignal) => Promise<DesktopPrimitiveDispatch>) | undefined;
  disposed = false;

  async capture(scope: DesktopCaptureScope, _signal: AbortSignal): Promise<DesktopCapture> {
    this.calls.push("capture");
    this.captureScopes.push(scope);
    const next = this.captures.shift() ?? capture();
    if (next instanceof Error) throw next;
    return next;
  }

  async getForegroundIdentity(_signal: AbortSignal): Promise<DesktopForegroundIdentity> {
    this.foregroundChecks += 1;
    if (this.foregroundResult instanceof Error) throw this.foregroundResult;
    return this.foregroundResult;
  }

  async getForegroundWindowBinding(_signal: AbortSignal): Promise<DesktopForegroundWindowBinding> {
    this.foregroundWindowChecks += 1;
    const next = this.foregroundWindowResults.shift() ?? foregroundWindowBinding();
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

  async move(input: unknown, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("move");
    this.moves.push(input);
    return this.moveResult;
  }

  async mouseHold(input: unknown, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("mouseHold");
    this.mouseHolds.push(input);
    return this.mouseHoldResult;
  }

  async drag(input: unknown, _signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("drag");
    this.drags.push(input);
    return this.dragResult;
  }

  async keypress(
    keys: readonly string[],
    signal: AbortSignal,
    holdMs = 0,
  ): Promise<DesktopPrimitiveDispatch> {
    this.calls.push("keypress");
    this.keypresses.push([...keys]);
    this.keypressHoldMs.push(holdMs);
    return this.onKeypress
      ? this.onKeypress(keys, holdMs, signal)
      : this.keypressResult;
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

interface NativeInputCall {
  count: number;
  flags: number[];
  keyboardVks: Array<number | undefined>;
}

function scriptedInputNative(
  sendResults: Array<number | Error> = [],
  dpiResults: Array<number | Error> = [],
): {
  native: {
    setThreadDpiAwarenessContext(...args: unknown[]): unknown;
    sendInput(...args: unknown[]): unknown;
  };
  calls: NativeInputCall[];
} {
  const calls: NativeInputCall[] = [];
  return {
    native: {
      setThreadDpiAwarenessContext: () => {
        const next = dpiResults.shift();
        if (next instanceof Error) throw next;
        return next ?? 1;
      },
      sendInput: (count: unknown, inputs: unknown) => {
        if (typeof count !== "number" || !Array.isArray(inputs)) {
          throw new Error("test native received invalid SendInput arguments");
        }
        calls.push({
          count,
          flags: inputs.map((input) => {
            const record = input as { u?: { mi?: { dwFlags?: unknown }; ki?: { dwFlags?: unknown } } };
            const flags = record.u?.mi?.dwFlags ?? record.u?.ki?.dwFlags;
            if (typeof flags !== "number") throw new Error("test native received invalid INPUT");
            return flags;
          }),
          keyboardVks: inputs.map((input) => {
            const record = input as { u?: { ki?: { wVk?: unknown } } };
            const wVk = record.u?.ki?.wVk;
            return typeof wVk === "number" ? wVk : undefined;
          }),
        });
        const next = sendResults.shift();
        if (next instanceof Error) throw next;
        return next ?? count;
      },
    },
    calls,
  };
}

interface NativeCaptureCall {
  bitBlts: Array<{ width: number; height: number; sourceX: number; sourceY: number }>;
  selectObjectCalls: number;
  deleteObjectCalls: number;
  deleteDcCalls: number;
  releaseDcCalls: number;
  getWindowRectCalls: number;
  isIconicCalls: number;
}

function scriptedCaptureNative(options: {
  primaryBounds?: readonly { left: number; top: number; right: number; bottom: number }[];
  foregroundHandles?: readonly number[];
  windowRects?: readonly { left: number; top: number; right: number; bottom: number }[];
  iconicResults?: readonly number[];
} = {}): { native: WindowsDesktopCaptureTestNative; calls: NativeCaptureCall } {
  const primaryBounds = [...(options.primaryBounds ?? [
    { left: 0, top: 0, right: 100, bottom: 50 },
  ])];
  const foregroundHandles = [...(options.foregroundHandles ?? [100, 100])];
  const windowRects = [...(options.windowRects ?? [{ left: 20, top: 10, right: 60, bottom: 30 }])];
  const iconicResults = [...(options.iconicResults ?? [0, 0])];
  const primaryFallback = primaryBounds.at(-1)!;
  const foregroundFallback = foregroundHandles.at(-1)!;
  const rectFallback = windowRects.at(-1)!;
  const iconicFallback = iconicResults.at(-1)!;
  const calls: NativeCaptureCall = {
    bitBlts: [],
    selectObjectCalls: 0,
    deleteObjectCalls: 0,
    deleteDcCalls: 0,
    releaseDcCalls: 0,
    getWindowRectCalls: 0,
    isIconicCalls: 0,
  };
  const next = <T>(values: T[], fallback: T): T => values.shift() ?? fallback;
  const native: WindowsDesktopCaptureTestNative = {
    setThreadDpiAwarenessContext: () => 1,
    sendInput: () => 0,
    getForegroundWindow: () => next(foregroundHandles, foregroundFallback),
    getWindowThreadProcessId: (hwnd: unknown, output: unknown) => {
      if (!Array.isArray(output) || typeof hwnd !== "number") throw new Error("invalid process ID output");
      output[0] = hwnd;
      return 1;
    },
    isIconic: () => {
      calls.isIconicCalls += 1;
      return next(iconicResults, iconicFallback);
    },
    getWindowRect: (_hwnd: unknown, rectangle: unknown) => {
      calls.getWindowRectCalls += 1;
      if (rectangle === null || typeof rectangle !== "object") throw new Error("invalid window rect");
      Object.assign(rectangle, next(windowRects, rectFallback));
      return 1;
    },
    monitorFromPoint: () => 1,
    getMonitorInfo: (_monitor: unknown, info: unknown) => {
      if (info === null || typeof info !== "object") throw new Error("invalid monitor info");
      Object.assign(info, { rcMonitor: next(primaryBounds, primaryFallback) });
      return 1;
    },
    getDc: () => 2,
    releaseDc: () => {
      calls.releaseDcCalls += 1;
      return 1;
    },
    createCompatibleDc: () => 3,
    deleteDc: () => {
      calls.deleteDcCalls += 1;
      return 1;
    },
    createDibSection: (_dc: unknown, _info: unknown, _colors: unknown, bits: unknown) => {
      if (!Array.isArray(bits)) throw new Error("invalid DIB bits output");
      bits[0] = 4;
      return 4;
    },
    selectObject: () => {
      calls.selectObjectCalls += 1;
      return 5;
    },
    deleteObject: () => {
      calls.deleteObjectCalls += 1;
      return 1;
    },
    bitBlt: (
      _destinationDc: unknown,
      _destinationX: unknown,
      _destinationY: unknown,
      width: unknown,
      height: unknown,
      _sourceDc: unknown,
      sourceX: unknown,
      sourceY: unknown,
    ) => {
      if (
        typeof width !== "number"
        || typeof height !== "number"
        || typeof sourceX !== "number"
        || typeof sourceY !== "number"
      ) {
        throw new Error("invalid BitBlt arguments");
      }
      calls.bitBlts.push({ width, height, sourceX, sourceY });
      return 1;
    },
  };
  return { native, calls };
}

const NATIVE_POINT = {
  x: 4,
  y: 5,
  inputBounds: PRIMARY_BOUNDS,
};

function providerEvidence(
  controller: DesktopController,
  owner: object,
  toolCallId: string,
): DesktopProviderEvidence | undefined {
  return controller.prepareProviderEvidence(owner, toolCallId);
}

function markProviderEvidencePresented(
  controller: DesktopController,
  owner: object,
  toolCallId: string,
): boolean {
  return controller.markProviderEvidencePresented(owner, toolCallId);
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

    expect(nestedOutcome).toBe("result");
    await expect(controller.execute(request(owner, "second", {
      actions: [{ kind: "click", x: 2, y: 2 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "decision_consumed" },
    });
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

      elapsed = 0;
      const foregroundAdapter = new FakeDesktopAdapter();
      const foregroundController = new DesktopController(foregroundAdapter);
      const foregroundOwner = {};
      await foregroundController.execute(request(foregroundOwner, "foreground-before", {
        actions: [],
        observe: true,
      }));
      markProviderEvidencePresented(foregroundController, foregroundOwner, "foreground-before");
      expect(foregroundController.authorizeFrame(foregroundOwner, ["foreground-failure"])).toBe(true);
      foregroundAdapter.getForegroundIdentity = async () => {
        elapsed = MAX_COMPUTER_CALL_MS + 1;
        throw new Error("foreground read failed after blocking");
      };
      await expect(foregroundController.execute(request(foregroundOwner, "foreground-failure", {
        actions: [{ kind: "click", x: 1, y: 1 }],
        observe: false,
      }))).resolves.toMatchObject({
        details: { outcome: "interrupted", reason: "timed_out" },
      });
      expect(foregroundAdapter.clicks).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("maps screenshot pixels to physical bounds without clamping and executes a batch in order", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture({
      width: 200,
      height: 100,
      captureBounds: { x: 10, y: 20, width: 200, height: 100 },
      inputBounds: { x: 10, y: 20, width: 200, height: 100 },
    })];
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "observe", { actions: [], observe: true }));
    controller.prepareProviderImage(owner, "observe");
    controller.markProviderImagePresented(owner, "observe");
    controller.authorizeFrame(owner, ["batch"]);
    await expect(controller.execute(request(owner, "batch", {
      actions: [{ kind: "click", x: 200, y: 0 }],
      observe: false,
    }))).rejects.toThrow("outside the current observation");
    expect(adapter.calls).toEqual(["capture"]);

    const batch = await controller.execute(request(owner, "batch", {
      actions: [
        { kind: "click", x: 199, y: 99, button: "right" },
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
      point: { x: 209, y: 119, inputBounds: { x: 10, y: 20, width: 200, height: 100 } },
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

    controller.beginAssistantDecision(owner);
    const failed = await controller.execute(request(owner, "second", { actions: [], observe: true }));
    expect(failed.details).toMatchObject({
      outcome: "interrupted",
      observation: { status: "unavailable" },
    });
    expect(controller.prepareProviderImage(owner, "first")).toBeUndefined();
    expect(controller.prepareProviderImage(owner, "second")).toBeUndefined();

    controller.beginAssistantDecision(owner);
    await controller.execute(request(owner, "third", { actions: [], observe: true }));
    expect(controller.prepareProviderImage(owner, "first")).toBeUndefined();
    expect(controller.prepareProviderImage(owner, "third")).toMatchObject({ width: 101 });
  });

  it("rejects a capture whose image dimensions do not equal its physical crop", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture({
      width: 101,
      captureBounds: { x: 0, y: 0, width: 100, height: 50 },
      inputBounds: { x: 0, y: 0, width: 100, height: 50 },
    })];
    const result = await new DesktopController(adapter).execute(request({}, "mismatched-crop", {
      actions: [],
      observe: true,
    }));
    expect(result.details).toMatchObject({
      outcome: "interrupted",
      observation: { status: "unavailable" },
    });
  });

  it("keeps initial current evidence separate from A/B pair evidence and grants only B coordinates", async () => {
    const adapter = new FakeDesktopAdapter();
    const before = Uint8Array.from([...PNG, 1]);
    const after = Uint8Array.from([...PNG, 2]);
    adapter.captures = [
      capture({
        png: before,
        width: 10,
        height: 10,
        captureBounds: { x: 0, y: 0, width: 10, height: 10 },
        inputBounds: { x: 0, y: 0, width: 10, height: 10 },
      }),
      capture({
        png: after,
        width: 20,
        height: 20,
        captureBounds: { x: 0, y: 0, width: 20, height: 20 },
        inputBounds: { x: 0, y: 0, width: 20, height: 20 },
      }),
      capture({
        png: Uint8Array.from([...PNG, 3]),
        width: 30,
        height: 30,
        captureBounds: { x: 0, y: 0, width: 30, height: 30 },
        inputBounds: { x: 0, y: 0, width: 30, height: 30 },
      }),
    ];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "initial", { actions: [], observe: true }));
    expect(providerEvidence(controller, owner, "initial")?.images.map(({ kind }) => kind))
      .toEqual(["current"]);
    expect(markProviderEvidencePresented(controller, owner, "initial")).toBe(true);
    expect(controller.authorizeFrame(owner, ["batch"])).toBe(true);

    const paired = await controller.execute(request(owner, "batch", {
      actions: [{ kind: "click", x: 9, y: 9 }],
      observe: true,
    }));
    expect(paired.details).toMatchObject({
      outcome: "completed",
      observation: {
        status: "captured",
        comparison: "paired",
        before: { status: "captured", width: 10, height: 10 },
        after: { status: "captured", width: 20, height: 20 },
      },
    });
    const pair = providerEvidence(controller, owner, "batch");
    expect(pair?.images.map(({ kind }) => kind)).toEqual(["before", "after"]);
    expect(pair?.images.map(({ png }) => [...png])).toEqual([[...before], [...after]]);
    expect(markProviderEvidencePresented(controller, owner, "batch")).toBe(true);
    expect(controller.authorizeFrame(owner, ["b-to-c"])).toBe(true);

    const bToC = await controller.execute(request(owner, "b-to-c", {
      actions: [{ kind: "click", x: 19, y: 19 }],
      observe: true,
      settleMs: 0,
    }));
    expect(bToC.details).toMatchObject({
      outcome: "completed",
      observation: {
        comparison: "paired",
        before: { width: 20, height: 20 },
        after: { width: 30, height: 30 },
      },
    });
    expect(adapter.clicks.at(-1)?.point).toMatchObject({ x: 19, y: 19 });
    const bToCPair = providerEvidence(controller, owner, "b-to-c");
    expect(bToCPair?.images.map(({ kind }) => kind)).toEqual(["before", "after"]);
    expect(bToCPair?.images.map(({ png }) => [...png])).toEqual([[...after], [...PNG, 3]]);
  });

  it("uses explicit after_only and historical-before after_missing evidence without coordinate resurrection", async () => {
    const afterOnlyAdapter = new FakeDesktopAdapter();
    afterOnlyAdapter.captures = [capture({ width: 12, height: 12 })];
    const afterOnly = new DesktopController(afterOnlyAdapter);
    const afterOnlyOwner = {};

    const afterOnlyResult = await afterOnly.execute(request(afterOnlyOwner, "keyboard", {
      actions: [{ kind: "type", text: "plain text remains compatible" }],
      observe: true,
    }));
    expect(afterOnlyResult.details).toMatchObject({
      outcome: "completed",
      observation: {
        status: "captured",
        comparison: "after_only",
        after: { status: "captured", width: 12, height: 12 },
      },
    });
    expect(providerEvidence(afterOnly, afterOnlyOwner, "keyboard")?.images.map(({ kind }) => kind))
      .toEqual(["after"]);
    expect(markProviderEvidencePresented(afterOnly, afterOnlyOwner, "keyboard")).toBe(true);
    expect(afterOnly.authorizeFrame(afterOnlyOwner, ["after-coordinate"])).toBe(true);
    await expect(afterOnly.execute(request(afterOnlyOwner, "after-coordinate", {
      actions: [{ kind: "click", x: 11, y: 11 }],
      observe: false,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });

    const missingAdapter = new FakeDesktopAdapter();
    missingAdapter.captures = [capture({ width: 10, height: 10 }), new Error("after unavailable")];
    const missing = new DesktopController(missingAdapter);
    const missingOwner = {};
    await missing.execute(request(missingOwner, "before", { actions: [], observe: true }));
    markProviderEvidencePresented(missing, missingOwner, "before");
    expect(missing.authorizeFrame(missingOwner, ["failed-after"])).toBe(true);

    const afterMissing = await missing.execute(request(missingOwner, "failed-after", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: true,
    }));
    expect(afterMissing.details).toMatchObject({
      outcome: "interrupted",
      observation: {
        status: "unavailable",
        comparison: "after_missing",
        before: { status: "captured", width: 10, height: 10 },
        after: { status: "unavailable" },
      },
    });
    expect(providerEvidence(missing, missingOwner, "failed-after")?.images.map(({ kind }) => kind))
      .toEqual(["historical_before"]);
    expect(markProviderEvidencePresented(missing, missingOwner, "failed-after")).toBe(true);
    expect(missing.authorizeFrame(missingOwner, ["must-not-authorize"])).toBe(false);
    await expect(missing.execute(request(missingOwner, "must-not-authorize", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "decision_consumed" },
    });
  });

  it("keeps a locally preflight-rejected sibling frame but spends it on the first controller-admitted batch", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "observe", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "observe");
    expect(controller.authorizeFrame(owner, ["bad-preflight", "admitted", "sibling"])).toBe(true);

    await expect(controller.execute(request(owner, "bad-preflight", {
      actions: [{ kind: "click", x: "not-a-coordinate", y: 1 }],
      observe: false,
    }))).rejects.toThrow("integer");
    await expect(controller.execute(request(owner, "admitted", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    await expect(controller.execute(request(owner, "sibling", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "decision_consumed" },
    });
  });

  it("spends a decision after one admitted batch, preserving its pair and rearming only at the next boundary", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture(), capture()];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "initial", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "initial");
    expect(controller.authorizeFrame(owner, ["paired", "type-sibling"])).toBe(true);
    await controller.execute(request(owner, "paired", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: true,
    }));
    expect(providerEvidence(controller, owner, "paired")?.images.map(({ kind }) => kind))
      .toEqual(["before", "after"]);
    await expect(controller.execute(request(owner, "type-sibling", {
      actions: [{ kind: "type", text: "must not run" }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "decision_consumed" },
    });
    expect(adapter.typed).toEqual([]);
    expect(providerEvidence(controller, owner, "paired")?.images.map(({ kind }) => kind))
      .toEqual(["before", "after"]);

    controller.beginAssistantDecision(owner);
    await controller.execute(request(owner, "first-no-observe", {
      actions: [{ kind: "wait", ms: 0 }],
      observe: false,
    }));
    await expect(controller.execute(request(owner, "wait-sibling", {
      actions: [{ kind: "type", text: "still blocked" }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "decision_consumed" },
    });
    expect(adapter.typed).toEqual([]);

    controller.beginAssistantDecision(owner);
    await expect(controller.execute(request(owner, "next-decision", {
      actions: [{ kind: "type", text: "now allowed" }],
      observe: false,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    expect(adapter.typed).toEqual(["now allowed"]);
  });

  it("rechecks an authorized frame's opaque foreground before input and binds the after frame anew", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [
      capture({ foreground: { hwnd: "100", processId: 100 } }),
      capture({ foreground: { hwnd: "200", processId: 200 } }),
    ];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "initial", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "initial");
    expect(controller.authorizeFrame(owner, ["mismatch", "paired"])).toBe(true);
    adapter.foregroundResult = { hwnd: "101", processId: 101 };
    await expect(controller.execute(request(owner, "mismatch", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "foreground_mismatch" },
    });
    expect(adapter.clicks).toEqual([]);

    // The mismatch retires that stale decision. A fresh observed frame starts
    // a new decision and its after image binds the new foreground identity.
    controller.beginAssistantDecision(owner);
    await controller.execute(request(owner, "fresh", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "fresh");
    expect(controller.authorizeFrame(owner, ["new-window"])).toBe(true);
    adapter.foregroundResult = { hwnd: "200", processId: 200 };
    const result = await controller.execute(request(owner, "new-window", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: true,
      settleMs: 0,
    }));
    expect(result.details).toMatchObject({ outcome: "completed" });
    expect(adapter.clicks).toHaveLength(1);
    expect(adapter.foregroundChecks).toBe(2);
    expect(JSON.stringify(result.details)).not.toContain("200");
    expect(JSON.stringify(providerEvidence(controller, owner, "new-window"))).not.toContain("200");
  });

  it("maps a foreground-window crop locally while preserving primary-display input normalization", async () => {
    const binding = foregroundWindowBinding();
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [foregroundWindowCapture({ foregroundWindow: binding })];
    adapter.foregroundWindowResults = [binding, binding];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "window-observe", {
      actions: [],
      observe: true,
      foregroundWindow: true,
    }));
    expect(adapter.captureScopes).toEqual(["foreground_window"]);
    expect(providerEvidence(controller, owner, "window-observe")?.images).toMatchObject([
      { kind: "current", scope: "foreground_window", width: 40, height: 20 },
    ]);
    markProviderEvidencePresented(controller, owner, "window-observe");
    expect(controller.authorizeFrame(owner, ["window-clicks"])).toBe(true);

    await expect(controller.execute(request(owner, "window-clicks", {
      actions: [
        { kind: "click", x: 0, y: 0 },
        { kind: "click", x: 39, y: 19 },
      ],
      observe: false,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
    expect(adapter.clicks).toEqual([
      {
        point: { x: 20, y: 10, inputBounds: PRIMARY_BOUNDS },
        button: "left",
      },
      {
        point: { x: 59, y: 29, inputBounds: PRIMARY_BOUNDS },
        button: "left",
      },
    ]);
    expect(adapter.foregroundChecks).toBe(1);
    expect(adapter.foregroundWindowChecks).toBe(2);
  });

  it("keeps the first-primitive identity check and rechecks every window coordinate dispatch", async () => {
    const binding = foregroundWindowBinding();
    const changed = foregroundWindowBinding({
      rawBounds: { x: 20, y: 10, width: 41, height: 20 },
      captureBounds: { x: 20, y: 10, width: 41, height: 20 },
    });
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [foregroundWindowCapture({ foregroundWindow: binding })];
    adapter.foregroundWindowResults = [binding, changed];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "window-observe", {
      actions: [],
      observe: true,
      foregroundWindow: true,
    }));
    markProviderEvidencePresented(controller, owner, "window-observe");
    expect(controller.authorizeFrame(owner, ["window-batch"])).toBe(true);

    await expect(controller.execute(request(owner, "window-batch", {
      actions: [
        { kind: "wait", ms: 0 },
        { kind: "click", x: 1, y: 1 },
        { kind: "click", x: 2, y: 2 },
      ],
      observe: false,
    }))).resolves.toMatchObject({
      details: {
        outcome: "interrupted",
        reason: "foreground_mismatch",
        actions: [
          { index: 0, status: "sent" },
          { index: 1, status: "sent" },
          { index: 2, status: "not_started" },
        ],
      },
    });
    expect(adapter.foregroundChecks).toBe(1);
    expect(adapter.foregroundWindowChecks).toBe(2);
    expect(adapter.clicks).toHaveLength(1);
  });

  it("blocks a first foreground-window coordinate when primary input topology drifted", async () => {
    const binding = foregroundWindowBinding();
    const topologyDrifted = foregroundWindowBinding({
      inputBounds: { x: 0, y: 0, width: 101, height: 50 },
    });
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [foregroundWindowCapture({ foregroundWindow: binding })];
    adapter.foregroundWindowResults = [topologyDrifted];
    const controller = new DesktopController(adapter);
    const owner = {};

    await controller.execute(request(owner, "window-observe", {
      actions: [],
      observe: true,
      foregroundWindow: true,
    }));
    markProviderEvidencePresented(controller, owner, "window-observe");
    expect(controller.authorizeFrame(owner, ["window-first-coordinate"])).toBe(true);

    await expect(controller.execute(request(owner, "window-first-coordinate", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: {
        outcome: "rejected",
        reason: "foreground_mismatch",
        actions: [{ index: 0, status: "not_started" }],
      },
    });
    expect(adapter.foregroundChecks).toBe(1);
    expect(adapter.foregroundWindowChecks).toBe(1);
    expect(adapter.clicks).toEqual([]);
  });

  it("rejects foregroundWindow without observe before consuming an authorized sibling frame", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "observe", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "observe");
    expect(controller.authorizeFrame(owner, ["invalid-scope", "sibling"])).toBe(true);

    await expect(controller.execute(request(owner, "invalid-scope", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
      foregroundWindow: true,
    }))).rejects.toThrow("foregroundWindow requires observe=true");
    await expect(controller.execute(request(owner, "sibling", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
  });

  it("fails closed with zero dispatch when foreground identity is malformed", async () => {
    const adapter = new FakeDesktopAdapter();
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "initial", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "initial");
    expect(controller.authorizeFrame(owner, ["invalid-foreground"])).toBe(true);
    adapter.getForegroundIdentity = async () => ({ hwnd: "", processId: 0 } as DesktopForegroundIdentity);

    await expect(controller.execute(request(owner, "invalid-foreground", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "foreground_mismatch" },
    });
    expect(adapter.clicks).toEqual([]);
  });

  it("bounds retained A/B evidence instead of silently degrading an oversized pair", async () => {
    const largePng = (): Uint8Array => {
      const value = Buffer.alloc(9 * 1024 * 1024);
      Buffer.from(PNG).copy(value);
      return value;
    };
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [
      capture({ png: largePng(), width: 10, height: 10 }),
      capture({ png: largePng(), width: 10, height: 10 }),
    ];
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "before", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "before");
    expect(controller.authorizeFrame(owner, ["oversized"])).toBe(true);

    const result = await controller.execute(request(owner, "oversized", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: true,
    }));
    expect(result.details).toMatchObject({
      outcome: "interrupted",
      reason: "pair_too_large",
      observation: { status: "unavailable", comparison: "pair_too_large" },
    });
    expect(providerEvidence(controller, owner, "oversized")).toBeUndefined();
  });

  it("runs the default 150ms settle after sent actions and routes call-scoped move, hold, and drag primitives", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture(), capture()];
    const controller = new DesktopController(adapter);
    const owner = {};
    await controller.execute(request(owner, "before", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "before");
    expect(controller.authorizeFrame(owner, ["expanded"])).toBe(true);

    const result = await controller.execute(request(owner, "expanded", {
      actions: [
        { kind: "move", x: 1, y: 2 },
        { kind: "mouseHold", x: 3, y: 4, button: "right", holdMs: 5 },
        {
          kind: "drag",
          fromX: 5,
          fromY: 6,
          toX: 7,
          toY: 8,
          button: "left",
          durationMs: 9,
        },
        { kind: "keypress", keys: ["SPACE"], holdMs: 10 },
      ],
      observe: true,
    }));
    expect(result.details).toMatchObject({ outcome: "completed" });
    expect(adapter.calls).toEqual([
      "capture",
      "move",
      "mouseHold",
      "drag",
      "keypress",
      "wait",
      "capture",
    ]);
    expect(adapter.keypressHoldMs).toEqual([10]);
    // FakeDesktopAdapter records the requested delay without sleeping, so the
    // default sampling contract is covered without a real-time test wait.
    expect(adapter.waits).toEqual([150]);
    expect(adapter.moves).toHaveLength(1);
    expect(adapter.mouseHolds).toHaveLength(1);
    expect(adapter.drags).toHaveLength(1);
  });

  it("keeps sent actions sent across settle abort, but makes their after evidence historical only", async () => {
    const adapter = new FakeDesktopAdapter();
    adapter.captures = [capture()];
    const controller = new DesktopController(adapter);
    const owner = {};
    const signal = new AbortController();
    await controller.execute(request(owner, "before", { actions: [], observe: true }));
    markProviderEvidencePresented(controller, owner, "before");
    expect(controller.authorizeFrame(owner, ["settle-abort"])).toBe(true);
    adapter.onWait = async () => {
      signal.abort();
      return "sent";
    };

    const result = await controller.execute(request(owner, "settle-abort", {
      actions: [{ kind: "click", x: 1, y: 1 }],
      observe: true,
      settleMs: 1,
    }, signal.signal));
    expect(result.details).toMatchObject({
      outcome: "interrupted",
      reason: "aborted",
      actions: [{ index: 0, status: "sent" }],
      observation: { status: "unavailable", comparison: "after_missing" },
    });
    expect(providerEvidence(controller, owner, "settle-abort")?.images.map(({ kind }) => kind))
      .toEqual(["historical_before"]);
  });

  it("permanently fails closed only when a possibly pressed state remains uncertain", async () => {
    const uncertain = {
      status: "unknown",
      pressedState: "uncertain",
    } as unknown as DesktopPrimitiveDispatch;
    const uncertainAdapter = new FakeDesktopAdapter();
    uncertainAdapter.keypressResult = uncertain;
    const uncertainController = new DesktopController(uncertainAdapter);
    const owner = {};

    await expect(uncertainController.execute(request(owner, "uncertain", {
      actions: [{ kind: "keypress", keys: ["SPACE"], holdMs: 1 }],
      observe: false,
    }))).resolves.toMatchObject({
      details: { outcome: "interrupted", actions: [{ status: "unknown" }] },
    });
    await uncertainController.release(owner);
    await expect(uncertainController.execute(request({}, "other-run", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "pressed_state_uncertain" },
    });

    const cleanUnknownAdapter = new FakeDesktopAdapter();
    cleanUnknownAdapter.keypressResult = "unknown";
    const cleanUnknownController = new DesktopController(cleanUnknownAdapter);
    const cleanOwner = {};
    await cleanUnknownController.execute(request(cleanOwner, "clean-unknown", {
      actions: [{ kind: "keypress", keys: ["SPACE"] }],
      observe: false,
    }));
    await cleanUnknownController.release(cleanOwner);
    await expect(cleanUnknownController.execute(request({}, "new-owner", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({ details: { outcome: "completed" } });
  });

  it("does not transfer an aborted held-input lease until cleanup settles and reports whether it taints", async () => {
    const uncertain = {
      status: "unknown",
      pressedState: "uncertain",
    } as unknown as DesktopPrimitiveDispatch;
    const adapter = new FakeDesktopAdapter();
    const cleanup = deferred<DesktopPrimitiveDispatch>();
    adapter.onKeypress = async () => cleanup.promise;
    const controller = new DesktopController(adapter);
    const owner = {};
    const abort = new AbortController();

    const running = controller.execute(request(owner, "held", {
      actions: [{ kind: "keypress", keys: ["SPACE"], holdMs: 10 }],
      observe: false,
    }, abort.signal));
    await Promise.resolve();
    expect(adapter.calls).toEqual(["keypress"]);
    abort.abort();
    await expect(running).resolves.toMatchObject({
      details: { outcome: "interrupted", actions: [{ status: "unknown" }] },
    });

    let released = false;
    const release = controller.release(owner).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    cleanup.resolve(uncertain);
    await release;
    await expect(controller.execute(request({}, "other-run", {
      actions: [],
      observe: true,
    }))).resolves.toMatchObject({
      details: { outcome: "rejected", reason: "pressed_state_uncertain" },
    });
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

describe("KoffiWindowsDesktopAdapter capture seam", () => {
  it("keeps the unchanged primary-display capture source and size", async () => {
    const scripted = scriptedCaptureNative();
    const adapter = createWindowsDesktopCaptureAdapterForTest(scripted.native);

    const result = await adapter.capture("primary_display", new AbortController().signal);
    expect(result).toMatchObject({
      scope: "primary_display",
      width: 100,
      height: 50,
      captureBounds: PRIMARY_BOUNDS,
      inputBounds: PRIMARY_BOUNDS,
    });
    expect(result.foregroundWindow).toBeUndefined();
    expect(scripted.calls.bitBlts).toEqual([{ width: 100, height: 50, sourceX: 0, sourceY: 0 }]);
    expect(scripted.calls.getWindowRectCalls).toBe(0);
    expect(scripted.calls.isIconicCalls).toBe(0);
  });

  it("clips a negative foreground window to the primary display before BitBlt", async () => {
    const rectangle = { left: -10, top: 5, right: 20, bottom: 25 };
    const scripted = scriptedCaptureNative({ windowRects: [rectangle, rectangle] });
    const adapter = createWindowsDesktopCaptureAdapterForTest(scripted.native);

    const result = await adapter.capture("foreground_window", new AbortController().signal);
    expect(result).toMatchObject({
      scope: "foreground_window",
      width: 20,
      height: 20,
      captureBounds: { x: 0, y: 5, width: 20, height: 20 },
      inputBounds: PRIMARY_BOUNDS,
      foregroundWindow: {
        rawBounds: { x: -10, y: 5, width: 30, height: 20 },
        captureBounds: { x: 0, y: 5, width: 20, height: 20 },
      },
    });
    expect(scripted.calls.bitBlts).toEqual([{ width: 20, height: 20, sourceX: 0, sourceY: 5 }]);
  });

  it("fails closed without BitBlt for minimized or primary-disjoint foreground windows", async () => {
    const minimized = scriptedCaptureNative({ iconicResults: [1] });
    await expect(createWindowsDesktopCaptureAdapterForTest(minimized.native).capture(
      "foreground_window",
      new AbortController().signal,
    )).rejects.toThrow();
    expect(minimized.calls.bitBlts).toEqual([]);

    const outside = scriptedCaptureNative({
      windowRects: [{ left: -40, top: 5, right: -10, bottom: 25 }],
    });
    await expect(createWindowsDesktopCaptureAdapterForTest(outside.native).capture(
      "foreground_window",
      new AbortController().signal,
    )).rejects.toThrow();
    expect(outside.calls.bitBlts).toEqual([]);
  });

  it("rejects capture-time geometry, identity, or primary topology drift after releasing every GDI handle", async () => {
    const first = { left: 20, top: 10, right: 60, bottom: 30 };
    const shifted = { left: 21, top: 10, right: 61, bottom: 30 };
    const geometry = scriptedCaptureNative({ windowRects: [first, shifted] });
    await expect(createWindowsDesktopCaptureAdapterForTest(geometry.native).capture(
      "foreground_window",
      new AbortController().signal,
    )).rejects.toThrow();
    expect(geometry.calls.bitBlts).toHaveLength(1);
    expect(geometry.calls).toMatchObject({
      selectObjectCalls: 2,
      deleteObjectCalls: 1,
      deleteDcCalls: 1,
      releaseDcCalls: 1,
    });

    const identity = scriptedCaptureNative({ foregroundHandles: [100, 101] });
    await expect(createWindowsDesktopCaptureAdapterForTest(identity.native).capture(
      "foreground_window",
      new AbortController().signal,
    )).rejects.toThrow();
    expect(identity.calls.bitBlts).toHaveLength(1);
    expect(identity.calls).toMatchObject({
      selectObjectCalls: 2,
      deleteObjectCalls: 1,
      deleteDcCalls: 1,
      releaseDcCalls: 1,
    });

    const topology = scriptedCaptureNative({
      primaryBounds: [
        { left: 0, top: 0, right: 100, bottom: 50 },
        { left: 0, top: 0, right: 101, bottom: 50 },
      ],
    });
    await expect(createWindowsDesktopCaptureAdapterForTest(topology.native).capture(
      "foreground_window",
      new AbortController().signal,
    )).rejects.toThrow();
    expect(topology.calls.bitBlts).toEqual([{ width: 40, height: 20, sourceX: 20, sourceY: 10 }]);
    expect(topology.calls).toMatchObject({
      selectObjectCalls: 2,
      deleteObjectCalls: 1,
      deleteDcCalls: 1,
      releaseDcCalls: 1,
    });
  });
});

describe("KoffiWindowsDesktopAdapter input seam", () => {
  it("executes click, held keypress, mouse hold, and drag as owned down/up sequences", async () => {
    const scripted = scriptedInputNative();
    const adapter = createWindowsDesktopInputAdapterForTest(scripted.native);
    const signal = new AbortController().signal;

    await expect(adapter.click({ point: NATIVE_POINT, button: "left" }, signal)).resolves.toBe("sent");
    await expect(adapter.mouseHold({
      point: NATIVE_POINT,
      button: "right",
      holdMs: 0,
    }, signal)).resolves.toBe("sent");
    await expect(adapter.drag({
      from: NATIVE_POINT,
      to: { ...NATIVE_POINT, x: 9, y: 10 },
      button: "left",
      durationMs: 0,
    }, signal)).resolves.toBe("sent");

    vi.useFakeTimers();
    try {
      const keypress = adapter.keypress(["CTRL", "A"], signal, 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(keypress).resolves.toBe("sent");
    } finally {
      vi.useRealTimers();
    }

    expect(scripted.calls.map(({ flags }) => flags)).toEqual([
      [0x8001, 0x0002], [0x0004], // click move/down, then up
      [0x8001, 0x0008], [0x0010], // right mouse hold, then up
      [0x8001, 0x0002], [0x8001], [0x0004], // drag start, move, up
      [0x0000, 0x0000], [0x0002, 0x0002], // key down order, reverse up order
    ]);
    expect(scripted.calls.slice(-2).map(({ keyboardVks }) => keyboardVks))
      .toEqual([[0x11, 0x41], [0x41, 0x11]]);
  });

  it("releases a held input after abort and distinguishes clean unknown prefixes from uncertain ones", async () => {
    vi.useFakeTimers();
    try {
      const held = scriptedInputNative();
      const heldAdapter = createWindowsDesktopInputAdapterForTest(held.native);
      const abort = new AbortController();
      const running = heldAdapter.mouseHold({
        point: NATIVE_POINT,
        button: "left",
        holdMs: 100,
      }, abort.signal);
      await Promise.resolve();
      abort.abort();
      await expect(running).resolves.toBe("unknown");
      expect(held.calls.map(({ flags }) => flags)).toEqual([[0x8001, 0x0002], [0x0004]]);
    } finally {
      vi.useRealTimers();
    }

    const noDispatch = scriptedInputNative([0, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(noDispatch.native).click({
      point: NATIVE_POINT,
      button: "left",
    }, new AbortController().signal)).resolves.toBe("unknown");

    // click start is [move, down]; one inserted input is only the move.
    const moveOnly = scriptedInputNative([1, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(moveOnly.native).click({
      point: NATIVE_POINT,
      button: "left",
    }, new AbortController().signal)).resolves.toBe("unknown");

    const upFailure = scriptedInputNative([2, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(upFailure.native).click({
      point: NATIVE_POINT,
      button: "left",
    }, new AbortController().signal)).resolves.toMatchObject({
      status: "unknown",
      pressedState: "uncertain",
    });

    const partialKeypress = scriptedInputNative([1, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(partialKeypress.native).keypress(
      ["CTRL", "A"],
      new AbortController().signal,
    )).resolves.toMatchObject({ status: "unknown", pressedState: "uncertain" });
  });

  it("handles native throws and DPI setup/restore failures without confusing a confirmed up", async () => {
    const throwAfterAttempt = scriptedInputNative([new Error("SendInput reported after dispatch"), 1]);
    await expect(createWindowsDesktopInputAdapterForTest(throwAfterAttempt.native).keypress(
      ["SPACE"],
      new AbortController().signal,
    )).resolves.toBe("unknown");
    expect(throwAfterAttempt.calls).toHaveLength(2);

    const setupFailure = scriptedInputNative([], [0, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(setupFailure.native).click({
      point: NATIVE_POINT,
      button: "left",
    }, new AbortController().signal)).resolves.toBe("unknown");
    expect(setupFailure.calls).toEqual([]);

    // Both ups reached SendInput, but only restoring the DPI context failed.
    const restoreFailure = scriptedInputNative([], [1, 0, 1, 0]);
    await expect(createWindowsDesktopInputAdapterForTest(restoreFailure.native).click({
      point: NATIVE_POINT,
      button: "left",
    }, new AbortController().signal)).resolves.toBe("unknown");
    expect(restoreFailure.calls.map(({ count }) => count)).toEqual([2, 1]);
  });

  it("bounds Unicode typing into native batches and observes abort before a later batch", async () => {
    vi.useFakeTimers();
    try {
      const complete = scriptedInputNative();
      const completeAdapter = createWindowsDesktopInputAdapterForTest(complete.native);
      const completeRun = completeAdapter.type("x".repeat(257), new AbortController().signal);
      await vi.runAllTimersAsync();
      await expect(completeRun).resolves.toBe("sent");
      expect(complete.calls.map(({ count }) => count)).toEqual([256, 256, 2]);

      const interrupted = scriptedInputNative();
      const interruptedAdapter = createWindowsDesktopInputAdapterForTest(interrupted.native);
      const abort = new AbortController();
      const interruptedRun = interruptedAdapter.type("x".repeat(257), abort.signal);
      await Promise.resolve();
      abort.abort();
      await expect(interruptedRun).resolves.toBe("unknown");
      expect(interrupted.calls.map(({ count }) => count)).toEqual([256]);

      // A two-input Unicode pair stopped after its down needs a best-effort up;
      // a confirmed up is clean unknown, while an unconfirmed up taints.
      const oddClean = scriptedInputNative([1, 1]);
      await expect(createWindowsDesktopInputAdapterForTest(oddClean.native).type(
        "a",
        new AbortController().signal,
      )).resolves.toBe("unknown");
      expect(oddClean.calls.map(({ count }) => count)).toEqual([2, 1]);

      const oddUncertain = scriptedInputNative([1, 0]);
      await expect(createWindowsDesktopInputAdapterForTest(oddUncertain.native).type(
        "a",
        new AbortController().signal,
      )).resolves.toMatchObject({ status: "unknown", pressedState: "uncertain" });

      // Two completed events are one full pair: no residual Unicode key and
      // no cleanup dispatch even though the remaining batch is unknown.
      const evenClean = scriptedInputNative([2]);
      await expect(createWindowsDesktopInputAdapterForTest(evenClean.native).type(
        "ab",
        new AbortController().signal,
      )).resolves.toBe("unknown");
      expect(evenClean.calls.map(({ count }) => count)).toEqual([4]);
    } finally {
      vi.useRealTimers();
    }
  });
});

if (process.platform !== "win32") {
  describe("createWindowsDesktopAdapter", () => {
    it("fails closed without loading a desktop ABI on non-Windows platforms", async () => {
      await expect(createWindowsDesktopAdapter()).rejects.toThrow("only available on win32");
    });
  });
}
