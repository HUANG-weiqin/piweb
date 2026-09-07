import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";

export const MAX_COMPUTER_ACTIONS = 8;
export const MAX_COMPUTER_TYPE_BYTES = 4_096;
export const MAX_COMPUTER_WAIT_MS = 5_000;
/** Bounds one whole capture/action batch, not merely one wait primitive. */
export const MAX_COMPUTER_CALL_MS = 15_000;
export const MAX_COMPUTER_SCROLL_DELTA = 10_000;
export const MAX_DESKTOP_PNG_BYTES = 16 * 1024 * 1024;

const MAX_CAPTURE_DIMENSION = 32_768;
const MAX_CAPTURE_PIXELS = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const SUPPORTED_DESKTOP_KEYS: Readonly<Record<string, number>> = Object.freeze({
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CTRL: 0x11,
  ALT: 0x12,
  PAUSE: 0x13,
  CAPSLOCK: 0x14,
  ESC: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  INSERT: 0x2d,
  DELETE: 0x2e,
  META: 0x5b,
  "0": 0x30,
  "1": 0x31,
  "2": 0x32,
  "3": 0x33,
  "4": 0x34,
  "5": 0x35,
  "6": 0x36,
  "7": 0x37,
  "8": 0x38,
  "9": 0x39,
  A: 0x41,
  B: 0x42,
  C: 0x43,
  D: 0x44,
  E: 0x45,
  F: 0x46,
  G: 0x47,
  H: 0x48,
  I: 0x49,
  J: 0x4a,
  K: 0x4b,
  L: 0x4c,
  M: 0x4d,
  N: 0x4e,
  O: 0x4f,
  P: 0x50,
  Q: 0x51,
  R: 0x52,
  S: 0x53,
  T: 0x54,
  U: 0x55,
  V: 0x56,
  W: 0x57,
  X: 0x58,
  Y: 0x59,
  Z: 0x5a,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
});

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopCapture {
  /** A complete PNG. The controller copies and bounds it before retaining it. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Physical input-coordinate bounds for the captured primary display. */
  bounds: DesktopBounds;
}

export interface DesktopPoint {
  x: number;
  y: number;
  bounds: DesktopBounds;
}

export interface DesktopClick {
  point: DesktopPoint;
  button: "left" | "right";
}

export interface DesktopScroll {
  point: DesktopPoint;
  deltaX: number;
  deltaY: number;
}

/** `unknown` means Windows did not confirm that the complete primitive was sent. */
export type DesktopPrimitiveDispatch = "sent" | "unknown";

/**
 * The only platform boundary used by DesktopController. Fakes can implement it
 * without loading Koffi or touching the local desktop.
 */
export interface WindowsDesktopAdapter {
  capture(signal: AbortSignal): Promise<DesktopCapture>;
  click(input: DesktopClick, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  type(text: string, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  keypress(keys: readonly string[], signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  scroll(input: DesktopScroll, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  wait(ms: number, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  dispose?(): Promise<void> | void;
}

export interface DesktopProviderImage {
  sourceToolCallId: string;
  mimeType: "image/png";
  /** A caller-owned copy. Mutating it cannot alter the retained observation. */
  png: Uint8Array;
  width: number;
  height: number;
}

export interface DesktopControllerRequest {
  owner: object;
  toolCallId: string;
  input: unknown;
  signal: AbortSignal;
  visionSupported: boolean;
}

export type ComputerActionStatus = "sent" | "unknown" | "not_started";

export interface ComputerActionResult {
  index: number;
  kind: ComputerActionKind;
  status: ComputerActionStatus;
}

export interface ComputerResultDetails {
  outcome: "completed" | "interrupted" | "desktop_busy" | "rejected";
  actions: readonly ComputerActionResult[];
  observation?:
    | { status: "captured"; width: number; height: number }
    | { status: "unavailable" };
  reason?: "vision_required" | "controller_disposed" | "aborted" | "timed_out";
}

export interface ComputerToolResult {
  content: readonly { type: "text"; text: string }[];
  details: ComputerResultDetails;
}

export type ComputerActionKind = "click" | "type" | "keypress" | "scroll" | "wait";

type ValidatedAction =
  | { kind: "click"; x: number; y: number; button: "left" | "right" }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: readonly string[] }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "wait"; ms: number };

interface ValidatedInput {
  actions: readonly ValidatedAction[];
  observe: boolean;
}

interface Frame {
  width: number;
  height: number;
  bounds: DesktopBounds;
}

interface PendingImage {
  state: "pending_image";
  owner: object;
  sourceToolCallId: string;
  /** True only after the converter appended this image to a provider request. */
  presented: boolean;
  png: Buffer;
  frame: Frame;
}

interface AuthorizedFrame {
  state: "authorized_frame";
  owner: object;
  toolCallIds: ReadonlySet<string>;
  frame: Frame;
}

type ObservationState = PendingImage | AuthorizedFrame;

interface ActiveOperation {
  owner: object;
  settled: Promise<void>;
  settle(): void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) throw new Error(`${label} has an unsupported field`);
  }
}

function assertIntegerInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error("type text must contain valid UTF-16");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("type text must contain valid UTF-16");
    }
  }
}

function normalizeKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("keypress keys must be strings");
  const normalized = value.length === 1 ? value.toUpperCase() : value;
  if (!Object.hasOwn(SUPPORTED_DESKTOP_KEYS, normalized)) {
    throw new Error("keypress key is not supported");
  }
  return normalized;
}

function normalizeAction(value: unknown): ValidatedAction {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new Error("computer action must be a flat object with a kind");
  }

  switch (value.kind) {
    case "click": {
      assertOnlyFields(value, ["kind", "x", "y", "button"], "click");
      const button = value.button ?? "left";
      if (button !== "left" && button !== "right") {
        throw new Error("click button must be left or right");
      }
      return {
        kind: "click",
        x: assertIntegerInRange(value.x, "click x", 0, MAX_CAPTURE_DIMENSION - 1),
        y: assertIntegerInRange(value.y, "click y", 0, MAX_CAPTURE_DIMENSION - 1),
        button,
      };
    }
    case "type": {
      assertOnlyFields(value, ["kind", "text"], "type");
      if (typeof value.text !== "string") throw new Error("type text must be a string");
      if (Buffer.byteLength(value.text, "utf8") > MAX_COMPUTER_TYPE_BYTES) {
        throw new Error(`type text exceeds ${MAX_COMPUTER_TYPE_BYTES} UTF-8 bytes`);
      }
      assertWellFormedUtf16(value.text);
      return { kind: "type", text: value.text };
    }
    case "keypress": {
      assertOnlyFields(value, ["kind", "keys"], "keypress");
      if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4) {
        throw new Error("keypress keys must contain 1 to 4 supported keys");
      }
      const keys = value.keys.map(normalizeKey);
      return { kind: "keypress", keys: Object.freeze(keys) };
    }
    case "scroll": {
      assertOnlyFields(value, ["kind", "x", "y", "deltaX", "deltaY"], "scroll");
      const deltaX = value.deltaX === undefined
        ? 0
        : assertIntegerInRange(
          value.deltaX,
          "scroll deltaX",
          -MAX_COMPUTER_SCROLL_DELTA,
          MAX_COMPUTER_SCROLL_DELTA,
        );
      const deltaY = value.deltaY === undefined
        ? 0
        : assertIntegerInRange(
          value.deltaY,
          "scroll deltaY",
          -MAX_COMPUTER_SCROLL_DELTA,
          MAX_COMPUTER_SCROLL_DELTA,
        );
      if (deltaX === 0 && deltaY === 0) {
        throw new Error("scroll must have a nonzero delta");
      }
      return {
        kind: "scroll",
        x: assertIntegerInRange(value.x, "scroll x", 0, MAX_CAPTURE_DIMENSION - 1),
        y: assertIntegerInRange(value.y, "scroll y", 0, MAX_CAPTURE_DIMENSION - 1),
        deltaX,
        deltaY,
      };
    }
    case "wait":
      assertOnlyFields(value, ["kind", "ms"], "wait");
      return {
        kind: "wait",
        ms: assertIntegerInRange(value.ms, "wait ms", 0, MAX_COMPUTER_WAIT_MS),
      };
    default:
      throw new Error("computer action kind is not supported");
  }
}

function normalizeInput(value: unknown): ValidatedInput {
  if (!isPlainRecord(value)) throw new Error("computer input must be a flat object");
  assertOnlyFields(value, ["actions", "observe"], "computer input");
  if (!Array.isArray(value.actions) || typeof value.observe !== "boolean") {
    throw new Error("computer input requires actions and observe");
  }
  if (value.actions.length > MAX_COMPUTER_ACTIONS) {
    throw new Error(`computer actions exceed ${MAX_COMPUTER_ACTIONS}`);
  }
  if (value.actions.length === 0 && value.observe === false) {
    throw new Error("computer requires an action or observe=true");
  }
  const actions: ValidatedAction[] = [];
  for (let index = 0; index < value.actions.length; index += 1) {
    if (!Object.hasOwn(value.actions, index)) {
      throw new Error("computer actions cannot be sparse");
    }
    actions.push(normalizeAction(value.actions[index]));
  }
  return { actions: Object.freeze(actions), observe: value.observe };
}

function hasCoordinateAction(action: ValidatedAction): action is Extract<
  ValidatedAction,
  { x: number; y: number }
> {
  return action.kind === "click" || action.kind === "scroll";
}

function validateFrame(value: DesktopCapture): Frame {
  if (
    !Number.isInteger(value.width)
    || value.width < 1
    || value.width > MAX_CAPTURE_DIMENSION
    || !Number.isInteger(value.height)
    || value.height < 1
    || value.height > MAX_CAPTURE_DIMENSION
    || value.width * value.height > MAX_CAPTURE_PIXELS
  ) {
    throw new Error("Desktop capture has invalid dimensions");
  }
  const { bounds } = value;
  if (
    !isPlainRecord(bounds)
    || !Number.isInteger(bounds.x)
    || !Number.isInteger(bounds.y)
    || !Number.isInteger(bounds.width)
    || bounds.width < 1
    || bounds.width > MAX_CAPTURE_DIMENSION
    || !Number.isInteger(bounds.height)
    || bounds.height < 1
    || bounds.height > MAX_CAPTURE_DIMENSION
  ) {
    throw new Error("Desktop capture has invalid bounds");
  }
  return Object.freeze({
    width: value.width,
    height: value.height,
    bounds: Object.freeze({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }),
  });
}

function validatePng(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < PNG_SIGNATURE.length) {
    throw new Error("Desktop capture is not a PNG");
  }
  if (value.byteLength > MAX_DESKTOP_PNG_BYTES) {
    throw new Error(`Desktop capture exceeds ${MAX_DESKTOP_PNG_BYTES} bytes`);
  }
  const png = Buffer.from(value);
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Desktop capture is not a PNG");
  }
  return png;
}

function mapPoint(frame: Frame, x: number, y: number): DesktopPoint {
  if (x >= frame.width || y >= frame.height) {
    throw new Error("Coordinate is outside the current observation");
  }
  const mapAxis = (
    coordinate: number,
    sourceLength: number,
    destinationStart: number,
    destinationLength: number,
  ): number => {
    if (sourceLength === 1 || destinationLength === 1) return destinationStart;
    return destinationStart + Math.round(
      (coordinate * (destinationLength - 1)) / (sourceLength - 1),
    );
  };
  return Object.freeze({
    x: mapAxis(x, frame.width, frame.bounds.x, frame.bounds.width),
    y: mapAxis(y, frame.height, frame.bounds.y, frame.bounds.height),
    bounds: frame.bounds,
  });
}

function actionResults(actions: readonly ValidatedAction[]): ComputerActionResult[] {
  return actions.map((action, index) => ({
    index,
    kind: action.kind,
    status: "not_started",
  }));
}

function makeResult(details: ComputerResultDetails): ComputerToolResult {
  const frozenActions = Object.freeze(details.actions.map((action) => Object.freeze({ ...action })));
  const frozenObservation = details.observation && Object.freeze({ ...details.observation });
  const frozenDetails = Object.freeze({
    ...details,
    actions: frozenActions,
    ...(frozenObservation === undefined ? {} : { observation: frozenObservation }),
  }) as ComputerResultDetails;
  return Object.freeze({
    content: Object.freeze([Object.freeze({
      type: "text" as const,
      text: JSON.stringify(frozenDetails),
    })]),
    details: frozenDetails,
  });
}

function combineAbortSignals(
  first: AbortSignal,
  second: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", abort);
      second.removeEventListener("abort", abort);
    },
  };
}

type InterruptibleAttempt<T> =
  | { state: "settled"; value: T }
  | { state: "failed" }
  | { state: "aborted" };

/**
 * Returns promptly on abort but deliberately leaves the underlying native
 * promise running. The caller owns retaining its desktop lease until it
 * settles, so an uncooperative adapter can never overlap a later owner.
 */
function awaitUntilAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<InterruptibleAttempt<T>> {
  if (signal.aborted) return Promise.resolve({ state: "aborted" });
  return new Promise((resolve) => {
    let done = false;
    const finish = (attempt: InterruptibleAttempt<T>): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      resolve(attempt);
    };
    const onAbort = () => finish({ state: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish({ state: "settled", value }),
      () => finish({ state: "failed" }),
    );
    if (signal.aborted) onAbort();
  });
}

function createActiveOperation(owner: object): ActiveOperation {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { owner, settled, settle };
}

/**
 * Process-wide desktop lease and run-scoped transient image/frame state.
 * Owners are compared only by object identity; caller-generated string IDs are
 * deliberately never used as lease keys.
 */
export class DesktopController {
  private leaseOwner: object | undefined;
  private releaseOwner: object | undefined;
  private activeOperation: ActiveOperation | undefined;
  private observation: ObservationState | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly adapter: WindowsDesktopAdapter) {}

  /**
   * Returns a fresh PNG copy for one provider decision. It relies on the exact
   * source tool-call correlation, not AgentMessage object identity, so it is
   * safe across SDK structured clones and retries.
   */
  prepareProviderImage(
    owner: object,
    sourceToolCallId: string,
  ): DesktopProviderImage | undefined {
    const observation = this.observation;
    if (
      observation?.state !== "pending_image"
      || observation.owner !== owner
      || observation.sourceToolCallId !== sourceToolCallId
    ) {
      return undefined;
    }
    return Object.freeze({
      sourceToolCallId: observation.sourceToolCallId,
      mimeType: "image/png" as const,
      png: Uint8Array.from(observation.png),
      width: observation.frame.width,
      height: observation.frame.height,
    });
  }

  /**
   * The LLM converter calls this only after it appended the matching image to
   * its LLM-only tool result. It leaves the PNG available for provider retry.
   */
  markProviderImagePresented(owner: object, sourceToolCallId: string): boolean {
    const observation = this.observation;
    if (
      observation?.state !== "pending_image"
      || observation.owner !== owner
      || observation.sourceToolCallId !== sourceToolCallId
    ) {
      return false;
    }
    observation.presented = true;
    return true;
  }

  /**
   * Called only after the provider produced a successful assistant message.
   * It requires converter presentation proof, drops PNG bytes, and grants its
   * coordinate frame to exactly that message's computer tool-call IDs. An
   * empty list drops an unused image.
   */
  authorizeFrame(owner: object, computerToolCallIds: readonly string[]): boolean {
    const toolCallIds = new Set<string>();
    for (const toolCallId of computerToolCallIds) {
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new Error("computer tool-call IDs must be nonempty strings");
      }
      toolCallIds.add(toolCallId);
    }

    const observation = this.observation;
    if (
      observation?.state !== "pending_image"
      || observation.owner !== owner
      || !observation.presented
    ) {
      return false;
    }
    if (toolCallIds.size === 0) {
      this.observation = undefined;
      return false;
    }
    this.observation = {
      state: "authorized_frame",
      owner,
      toolCallIds,
      frame: observation.frame,
    };
    return true;
  }

  clearObservation(owner: object): void {
    if (this.observation?.owner === owner) this.observation = undefined;
  }

  async release(owner: object): Promise<void> {
    if (this.leaseOwner !== owner) return;
    this.releaseOwner = owner;
    while (this.activeOperation?.owner === owner) {
      await this.activeOperation.settled;
    }
    if (this.leaseOwner === owner) {
      this.clearObservation(owner);
      this.leaseOwner = undefined;
    }
    if (this.releaseOwner === owner) this.releaseOwner = undefined;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      const owner = this.leaseOwner;
      if (owner !== undefined) await this.release(owner);
      else if (this.activeOperation) await this.activeOperation.settled;
      this.observation = undefined;
      await this.adapter.dispose?.();
    })();
    return this.disposePromise;
  }

  async execute(request: DesktopControllerRequest): Promise<ComputerToolResult> {
    if (request.owner === null || typeof request.owner !== "object") {
      throw new Error("computer owner must be an object");
    }
    if (typeof request.toolCallId !== "string" || request.toolCallId.length === 0) {
      throw new Error("computer toolCallId must be a nonempty string");
    }
    if (!request.signal || typeof request.signal.aborted !== "boolean") {
      throw new Error("computer requires an AbortSignal");
    }

    const input = normalizeInput(request.input);
    const results = actionResults(input.actions);
    if (!request.visionSupported) {
      return makeResult({
        outcome: "rejected",
        reason: "vision_required",
        actions: results,
      });
    }
    if (request.signal.aborted) {
      return makeResult({ outcome: "interrupted", reason: "aborted", actions: results });
    }

    const coordinateActions = input.actions.filter(hasCoordinateAction);
    let coordinateFrame: Frame | undefined;
    if (coordinateActions.length > 0) {
      const observation = this.observation;
      if (
        observation?.state !== "authorized_frame"
        || observation.owner !== request.owner
        || !observation.toolCallIds.has(request.toolCallId)
      ) {
        throw new Error("Coordinate actions require an authorized current observation");
      }
      coordinateFrame = observation.frame;
      for (const action of coordinateActions) {
        mapPoint(coordinateFrame, action.x, action.y);
      }
    }

    if (this.disposed) {
      return makeResult({
        outcome: "rejected",
        reason: "controller_disposed",
        actions: results,
      });
    }
    const operation = this.beginOperation(request.owner);
    if (!operation) {
      return makeResult({ outcome: "desktop_busy", actions: results });
    }
    const deadline = new AbortController();
    const deadlineAt = performance.now() + MAX_COMPUTER_CALL_MS;
    let timedOut = false;
    const expireDeadline = (): boolean => {
      if (!timedOut && performance.now() < deadlineAt) return false;
      timedOut = true;
      deadline.abort();
      return true;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, MAX_COMPUTER_CALL_MS);
    const combined = combineAbortSignals(request.signal, deadline.signal);
    const effectiveRequest = { ...request, signal: combined.signal };
    const interruptionReason = (): "aborted" | "timed_out" =>
      timedOut ? "timed_out" : "aborted";

    let operationDeferred = false;
    const finishAfterQuiescence = (pending: Promise<unknown>): void => {
      if (operationDeferred) return;
      operationDeferred = true;
      void pending.then(
        () => this.finishOperation(operation),
        () => this.finishOperation(operation),
      );
    };

    try {
      if (input.actions.length === 0) {
        this.clearObservation(request.owner);
        return await this.captureResult(
          effectiveRequest,
          results,
          interruptionReason,
          expireDeadline,
          finishAfterQuiescence,
        );
      }

      // A batch is now admitted. Even a wait or later failure makes the old
      // picture stale, so clear globally before its first primitive attempt.
      this.clearObservation(request.owner);
      for (let index = 0; index < input.actions.length; index += 1) {
        if (expireDeadline() || effectiveRequest.signal.aborted) {
          return makeResult({
            outcome: "interrupted",
            reason: interruptionReason(),
            actions: results,
            observation: { status: "unavailable" },
          });
        }

        const action = input.actions[index]!;
        const pendingDispatch = this.dispatch(
          action,
          coordinateFrame,
          effectiveRequest.signal,
        );
        const attempt = await awaitUntilAbort(pendingDispatch, effectiveRequest.signal);
        if (attempt.state === "aborted") {
          finishAfterQuiescence(pendingDispatch);
          results[index]!.status = "unknown";
          return makeResult({
            outcome: "interrupted",
            reason: interruptionReason(),
            actions: results,
            observation: { status: "unavailable" },
          });
        }

        // A native/encoding call can block the event loop past the timer. Do
        // this on both success and failure paths before reporting its result.
        const deadlineExpired = expireDeadline();
        if (attempt.state === "failed" || attempt.value !== "sent") {
          results[index]!.status = "unknown";
          return makeResult({
            outcome: "interrupted",
            reason: deadlineExpired || effectiveRequest.signal.aborted
              ? interruptionReason()
              : undefined,
            actions: results,
            observation: { status: "unavailable" },
          });
        }
        results[index]!.status = "sent";
        if (deadlineExpired || effectiveRequest.signal.aborted) {
          return makeResult({
            outcome: "interrupted",
            reason: interruptionReason(),
            actions: results,
            observation: { status: "unavailable" },
          });
        }
      }

      if (!input.observe) {
        return makeResult({
          outcome: "completed",
          actions: results,
          observation: { status: "unavailable" },
        });
      }
      return await this.captureResult(
        effectiveRequest,
        results,
        interruptionReason,
        expireDeadline,
        finishAfterQuiescence,
      );
    } finally {
      clearTimeout(timeout);
      combined.dispose();
      if (!operationDeferred) this.finishOperation(operation);
    }
  }

  private beginOperation(owner: object): ActiveOperation | undefined {
    if (this.disposed || this.releaseOwner === owner) return undefined;
    if (this.leaseOwner === undefined) this.leaseOwner = owner;
    if (this.leaseOwner !== owner || this.activeOperation !== undefined) return undefined;
    const operation = createActiveOperation(owner);
    this.activeOperation = operation;
    return operation;
  }

  private finishOperation(operation: ActiveOperation): void {
    if (this.activeOperation === operation) this.activeOperation = undefined;
    operation.settle();
  }

  private async dispatch(
    action: ValidatedAction,
    coordinateFrame: Frame | undefined,
    signal: AbortSignal,
  ): Promise<DesktopPrimitiveDispatch> {
    switch (action.kind) {
      case "click":
        return this.adapter.click({
          point: mapPoint(coordinateFrame!, action.x, action.y),
          button: action.button,
        }, signal);
      case "type":
        return this.adapter.type(action.text, signal);
      case "keypress":
        return this.adapter.keypress(action.keys, signal);
      case "scroll":
        return this.adapter.scroll({
          point: mapPoint(coordinateFrame!, action.x, action.y),
          deltaX: action.deltaX,
          deltaY: action.deltaY,
        }, signal);
      case "wait":
        return this.adapter.wait(action.ms, signal);
    }
  }

  private async captureResult(
    request: DesktopControllerRequest,
    results: ComputerActionResult[],
    interruptionReason: () => "aborted" | "timed_out",
    expireDeadline: () => boolean,
    finishAfterQuiescence: (pending: Promise<unknown>) => void,
  ): Promise<ComputerToolResult> {
    try {
      if (expireDeadline() || request.signal.aborted) {
        throw new Error(interruptionReason());
      }
      const pendingCapture = this.adapter.capture(request.signal);
      const attempt = await awaitUntilAbort(pendingCapture, request.signal);
      if (attempt.state === "aborted") {
        finishAfterQuiescence(pendingCapture);
        this.clearObservation(request.owner);
        return makeResult({
          outcome: "interrupted",
          reason: interruptionReason(),
          actions: results,
          observation: { status: "unavailable" },
        });
      }
      const deadlineExpired = expireDeadline();
      if (attempt.state === "failed") {
        this.clearObservation(request.owner);
        return makeResult({
          outcome: "interrupted",
          reason: deadlineExpired || request.signal.aborted
            ? interruptionReason()
            : undefined,
          actions: results,
          observation: { status: "unavailable" },
        });
      }
      if (deadlineExpired || request.signal.aborted) {
        throw new Error(interruptionReason());
      }
      const frame = validateFrame(attempt.value);
      const png = validatePng(attempt.value.png);
      this.observation = {
        state: "pending_image",
        owner: request.owner,
        sourceToolCallId: request.toolCallId,
        presented: false,
        png,
        frame,
      };
      return makeResult({
        outcome: "completed",
        actions: results,
        observation: { status: "captured", width: frame.width, height: frame.height },
      });
    } catch {
      const deadlineExpired = expireDeadline();
      this.clearObservation(request.owner);
      return makeResult({
        outcome: "interrupted",
        reason: deadlineExpired || request.signal.aborted
          ? interruptionReason()
          : undefined,
        actions: results,
        observation: { status: "unavailable" },
      });
    }
  }
}

interface NativeFunction {
  (...args: unknown[]): unknown;
}

interface NativeLibrary {
  func(signature: string): NativeFunction;
}

interface KoffiApi {
  load(filename: string): NativeLibrary;
  struct(name: string, fields: Record<string, unknown>): unknown;
  union(name: string, fields: Record<string, unknown>): unknown;
  sizeof(type: unknown): number;
  view(pointer: unknown, length: number): Uint8Array;
}

interface WindowsFunctions {
  setThreadDpiAwarenessContext: NativeFunction;
  monitorFromPoint: NativeFunction;
  getMonitorInfo: NativeFunction;
  getDc: NativeFunction;
  releaseDc: NativeFunction;
  createCompatibleDc: NativeFunction;
  deleteDc: NativeFunction;
  createDibSection: NativeFunction;
  selectObject: NativeFunction;
  deleteObject: NativeFunction;
  bitBlt: NativeFunction;
  sendInput: NativeFunction;
}

interface NativeMouseInput {
  dx: number;
  dy: number;
  mouseData: number;
  dwFlags: number;
  time: number;
  dwExtraInfo: number;
}

interface NativeKeyboardInput {
  wVk: number;
  wScan: number;
  dwFlags: number;
  time: number;
  dwExtraInfo: number;
}

interface NativeInput {
  type: number;
  u: { mi: NativeMouseInput } | { ki: NativeKeyboardInput };
}

const MONITOR_DEFAULTTOPRIMARY = 1;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

function asKoffiApi(value: unknown): KoffiApi {
  const candidate = isPlainRecord(value) && typeof value.load === "function"
    ? value
    : isPlainRecord(value)
      && isPlainRecord(value.default)
      && typeof value.default.load === "function"
      ? value.default
      : undefined;
  if (candidate === undefined) throw new Error("Koffi ABI is unavailable");
  return candidate as unknown as KoffiApi;
}

function isNullHandle(value: unknown): boolean {
  return value === null || value === undefined || value === 0;
}

function assertHandle(value: unknown, label: string): unknown {
  if (isNullHandle(value)) throw new Error(`${label} failed`);
  return value;
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function encodePngFromBgra(width: number, height: number, bgra: Buffer): Buffer {
  const rowBytes = width * 4;
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * rowBytes;
    const destinationOffset = row * (rowBytes + 1);
    scanlines[destinationOffset] = 0;
    for (let column = 0; column < width; column += 1) {
      const source = sourceOffset + column * 4;
      const destination = destinationOffset + 1 + column * 4;
      scanlines[destination] = bgra[source + 2]!;
      scanlines[destination + 1] = bgra[source + 1]!;
      scanlines[destination + 2] = bgra[source]!;
      scanlines[destination + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (png.byteLength > MAX_DESKTOP_PNG_BYTES) {
    throw new Error(`Desktop capture exceeds ${MAX_DESKTOP_PNG_BYTES} bytes`);
  }
  return png;
}

function abortError(): Error {
  const error = new Error("Desktop operation aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Koffi-backed primary-display adapter. Koffi is dynamically imported and its
 * Windows DLLs are loaded only by createWindowsDesktopAdapter().
 */
class KoffiWindowsDesktopAdapter implements WindowsDesktopAdapter {
  constructor(
    private readonly native: WindowsFunctions,
    private readonly monitorInfoSize: number,
    private readonly bitmapInfoHeaderSize: number,
    private readonly inputSize: number,
    private readonly view: (pointer: unknown, length: number) => Uint8Array,
  ) {}

  async capture(signal: AbortSignal): Promise<DesktopCapture> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      let screenDc: unknown;
      let memoryDc: unknown;
      let bitmap: unknown;
      let previousObject: unknown;
      let selected = false;
      try {
        const monitor = assertHandle(
          this.native.monitorFromPoint({ x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY),
          "MonitorFromPoint",
        );
        const monitorInfo: Record<string, unknown> = { cbSize: this.monitorInfoSize };
        if (this.native.getMonitorInfo(monitor, monitorInfo) === 0) {
          throw new Error("GetMonitorInfoW failed");
        }
        const bounds = this.monitorBounds(monitorInfo.rcMonitor);
        const width = bounds.width;
        const height = bounds.height;
        if (
          width > MAX_CAPTURE_DIMENSION
          || height > MAX_CAPTURE_DIMENSION
          || width * height > MAX_CAPTURE_PIXELS
        ) {
          throw new Error("Primary display exceeds capture bounds");
        }

        screenDc = assertHandle(this.native.getDc(null), "GetDC");
        memoryDc = assertHandle(this.native.createCompatibleDc(screenDc), "CreateCompatibleDC");
        const bits: unknown[] = [null];
        bitmap = assertHandle(this.native.createDibSection(screenDc, {
          bmiHeader: {
            biSize: this.bitmapInfoHeaderSize,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: width * height * 4,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
          },
          bmiColors: { rgbBlue: 0, rgbGreen: 0, rgbRed: 0, rgbReserved: 0 },
        }, DIB_RGB_COLORS, bits, null, 0), "CreateDIBSection");
        previousObject = assertHandle(this.native.selectObject(memoryDc, bitmap), "SelectObject");
        selected = true;
        if (
          this.native.bitBlt(
            memoryDc,
            0,
            0,
            width,
            height,
            screenDc,
            bounds.x,
            bounds.y,
            SRCCOPY,
          ) === 0
        ) {
          throw new Error("BitBlt failed");
        }
        if (signal.aborted) throw abortError();
        const bgra = Buffer.from(this.view(assertHandle(bits[0], "CreateDIBSection bits"), width * height * 4));
        return {
          png: encodePngFromBgra(width, height, bgra),
          width,
          height,
          bounds,
        };
      } finally {
        if (selected && memoryDc !== undefined && previousObject !== undefined) {
          try {
            this.native.selectObject(memoryDc, previousObject);
          } catch {
            // Cleanup must continue for the remaining GDI handles.
          }
        }
        if (bitmap !== undefined) {
          try {
            this.native.deleteObject(bitmap);
          } catch {
            // Cleanup must continue for the remaining GDI handles.
          }
        }
        if (memoryDc !== undefined) {
          try {
            this.native.deleteDc(memoryDc);
          } catch {
            // Cleanup must continue for the screen DC.
          }
        }
        if (screenDc !== undefined) {
          try {
            this.native.releaseDc(null, screenDc);
          } catch {
            // There is no remaining resource to release.
          }
        }
      }
    });
  }

  async click(input: DesktopClick, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      const flags = input.button === "left"
        ? [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]
        : [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP];
      return this.send([
        this.mouseInput(input.point, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
        this.mouseInput(input.point, flags[0]!, 0),
        this.mouseInput(input.point, flags[1]!, 0),
      ]);
    });
  }

  async type(text: string, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      const inputs: NativeInput[] = [];
      for (let index = 0; index < text.length; index += 1) {
        const codeUnit = text.charCodeAt(index);
        inputs.push(this.unicodeInput(codeUnit, false), this.unicodeInput(codeUnit, true));
      }
      return inputs.length === 0 ? "sent" : this.send(inputs);
    });
  }

  async keypress(keys: readonly string[], signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      const inputs = keys.map((key) => this.keyboardInput(SUPPORTED_DESKTOP_KEYS[key]!, false));
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        inputs.push(this.keyboardInput(SUPPORTED_DESKTOP_KEYS[keys[index]!]!, true));
      }
      return this.send(inputs);
    });
  }

  async scroll(input: DesktopScroll, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      const inputs = [
        this.mouseInput(input.point, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
      ];
      if (input.deltaY !== 0) {
        inputs.push(this.mouseInput(input.point, MOUSEEVENTF_WHEEL, input.deltaY));
      }
      if (input.deltaX !== 0) {
        inputs.push(this.mouseInput(input.point, MOUSEEVENTF_HWHEEL, input.deltaX));
      }
      return this.send(inputs);
    });
  }

  async wait(ms: number, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      function done(): void {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return "sent";
  }

  private withPhysicalDpi<T>(operation: () => T): T {
    const previous = assertHandle(
      this.native.setThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
      "SetThreadDpiAwarenessContext",
    );
    try {
      return operation();
    } finally {
      if (this.native.setThreadDpiAwarenessContext(previous) === 0) {
        throw new Error("SetThreadDpiAwarenessContext restore failed");
      }
    }
  }

  private monitorBounds(value: unknown): DesktopBounds {
    if (!isPlainRecord(value)) throw new Error("GetMonitorInfoW returned invalid bounds");
    const left = value.left;
    const top = value.top;
    const right = value.right;
    const bottom = value.bottom;
    if (
      typeof left !== "number"
      || typeof top !== "number"
      || typeof right !== "number"
      || typeof bottom !== "number"
      || !Number.isInteger(left)
      || !Number.isInteger(top)
      || !Number.isInteger(right)
      || !Number.isInteger(bottom)
      || right <= left
      || bottom <= top
    ) {
      throw new Error("GetMonitorInfoW returned invalid bounds");
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  private mouseInput(point: DesktopPoint, flags: number, mouseData: number): NativeInput {
    return {
      type: INPUT_MOUSE,
      u: {
        mi: {
          dx: this.absoluteCoordinate(point.x, point.bounds.x, point.bounds.width),
          dy: this.absoluteCoordinate(point.y, point.bounds.y, point.bounds.height),
          mouseData: mouseData >>> 0,
          dwFlags: flags,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
  }

  private keyboardInput(key: number, up: boolean): NativeInput {
    return {
      type: INPUT_KEYBOARD,
      u: {
        ki: {
          wVk: key,
          wScan: 0,
          dwFlags: up ? KEYEVENTF_KEYUP : 0,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
  }

  private unicodeInput(codeUnit: number, up: boolean): NativeInput {
    return {
      type: INPUT_KEYBOARD,
      u: {
        ki: {
          wVk: 0,
          wScan: codeUnit,
          dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0),
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
  }

  private absoluteCoordinate(value: number, start: number, length: number): number {
    if (length <= 1) return 0;
    return Math.round(((value - start) * 65_535) / (length - 1));
  }

  private send(inputs: readonly NativeInput[]): DesktopPrimitiveDispatch {
    const sent = this.native.sendInput(inputs.length, inputs, this.inputSize);
    return sent === inputs.length ? "sent" : "unknown";
  }
}

export async function createWindowsDesktopAdapter(): Promise<WindowsDesktopAdapter> {
  if (process.platform !== "win32") {
    throw new Error("Windows desktop control is only available on win32");
  }
  try {
    const moduleName = "koffi";
    const koffi = asKoffiApi(await import(moduleName));
    koffi.struct("POINT", {
      x: "int32_t",
      y: "int32_t",
    });
    const rect = koffi.struct("RECT", {
      left: "int32_t",
      top: "int32_t",
      right: "int32_t",
      bottom: "int32_t",
    });
    const monitorInfo = koffi.struct("MONITORINFO", {
      cbSize: "uint32_t",
      rcMonitor: rect,
      rcWork: rect,
      dwFlags: "uint32_t",
    });
    const bitmapInfoHeader = koffi.struct("BITMAPINFOHEADER", {
      biSize: "uint32_t",
      biWidth: "int32_t",
      biHeight: "int32_t",
      biPlanes: "uint16_t",
      biBitCount: "uint16_t",
      biCompression: "uint32_t",
      biSizeImage: "uint32_t",
      biXPelsPerMeter: "int32_t",
      biYPelsPerMeter: "int32_t",
      biClrUsed: "uint32_t",
      biClrImportant: "uint32_t",
    });
    const rgbQuad = koffi.struct("RGBQUAD", {
      rgbBlue: "uint8_t",
      rgbGreen: "uint8_t",
      rgbRed: "uint8_t",
      rgbReserved: "uint8_t",
    });
    koffi.struct("BITMAPINFO", {
      bmiHeader: bitmapInfoHeader,
      bmiColors: rgbQuad,
    });
    const mouseInput = koffi.struct("MOUSEINPUT", {
      dx: "int32_t",
      dy: "int32_t",
      mouseData: "uint32_t",
      dwFlags: "uint32_t",
      time: "uint32_t",
      dwExtraInfo: "uintptr_t",
    });
    const keyboardInput = koffi.struct("KEYBDINPUT", {
      wVk: "uint16_t",
      wScan: "uint16_t",
      dwFlags: "uint32_t",
      time: "uint32_t",
      dwExtraInfo: "uintptr_t",
    });
    const inputUnion = koffi.union("INPUT_UNION", {
      mi: mouseInput,
      ki: keyboardInput,
    });
    const input = koffi.struct("INPUT", {
      type: "uint32_t",
      u: inputUnion,
    });
    const inputSize = koffi.sizeof(input);
    if (!Number.isInteger(inputSize) || inputSize <= 0) {
      throw new Error("Koffi INPUT ABI is unavailable");
    }

    const user32 = koffi.load("user32.dll");
    const gdi32 = koffi.load("gdi32.dll");
    const native: WindowsFunctions = {
      setThreadDpiAwarenessContext: user32.func(
        "intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t value)",
      ),
      monitorFromPoint: user32.func(
        "void * __stdcall MonitorFromPoint(POINT point, uint32_t flags)",
      ),
      getMonitorInfo: user32.func(
        "uint32_t __stdcall GetMonitorInfoW(void *monitor, _Inout_ MONITORINFO *info)",
      ),
      getDc: user32.func("void * __stdcall GetDC(void *hWnd)"),
      releaseDc: user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)"),
      createCompatibleDc: gdi32.func("void * __stdcall CreateCompatibleDC(void *hDC)"),
      deleteDc: gdi32.func("int __stdcall DeleteDC(void *hDC)"),
      createDibSection: gdi32.func(
        "void * __stdcall CreateDIBSection(void *hdc, BITMAPINFO *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)",
      ),
      selectObject: gdi32.func("void * __stdcall SelectObject(void *hDC, void *h)"),
      deleteObject: gdi32.func("int __stdcall DeleteObject(void *ho)"),
      bitBlt: gdi32.func(
        "int __stdcall BitBlt(void *hdcDest, int xDest, int yDest, int w, int h, void *hdcSrc, int xSrc, int ySrc, uint32_t rop)",
      ),
      sendInput: user32.func(
        "uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int inputSize)",
      ),
    };
    return new KoffiWindowsDesktopAdapter(
      native,
      koffi.sizeof(monitorInfo),
      koffi.sizeof(bitmapInfoHeader),
      inputSize,
      koffi.view.bind(koffi),
    );
  } catch {
    throw new Error("Windows desktop ABI is unavailable");
  }
}
