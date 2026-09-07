import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";

export const MAX_COMPUTER_ACTIONS = 8;
export const MAX_COMPUTER_TYPE_BYTES = 4_096;
export const MAX_COMPUTER_WAIT_MS = 5_000;
export const MAX_COMPUTER_HOLD_MS = 5_000;
export const MAX_COMPUTER_DRAG_DURATION_MS = 5_000;
export const MAX_COMPUTER_SETTLE_MS = 2_000;
/** A short post-action sampling delay; initial observations remain immediate. */
export const DEFAULT_COMPUTER_SETTLE_MS = 150;
/** Bounds one whole capture/action batch, not merely one wait primitive. */
export const MAX_COMPUTER_CALL_MS = 15_000;
export const MAX_COMPUTER_SCROLL_DELTA = 10_000;
export const MAX_DESKTOP_PNG_BYTES = 16 * 1024 * 1024;
/** A comparison retains no more raw PNG bytes than the prior single-image limit. */
export const MAX_COMPUTER_PAIR_PNG_BYTES = MAX_DESKTOP_PNG_BYTES;

const MAX_CAPTURE_DIMENSION = 32_768;
const MAX_CAPTURE_PIXELS = 32 * 1024 * 1024;
/** Bounds one synchronous SendInput call while allowing timers/abort between text chunks. */
const MAX_TYPE_CODE_UNITS_PER_NATIVE_BATCH = 128;
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

/** The screen area represented by one PNG; primary remains the compatibility default. */
export type DesktopCaptureScope = "primary_display" | "foreground_window";

/** Opaque, process-local foreground binding; never projected outside the desktop boundary. */
export interface DesktopForegroundIdentity {
  hwnd: string;
  processId: number;
}

export interface DesktopForegroundWindowBinding {
  /** Includes the opaque HWND/PID identity only inside the desktop boundary. */
  foreground: DesktopForegroundIdentity;
  /** Physical GetWindowRect geometry before primary-display clipping. */
  rawBounds: DesktopBounds;
  /** The physical rectangle whose pixels are in the captured PNG. */
  captureBounds: DesktopBounds;
  /** The complete primary display used for SendInput absolute normalization. */
  inputBounds: DesktopBounds;
}

export interface DesktopCapture {
  /** A complete PNG. The controller copies and bounds it before retaining it. */
  png: Uint8Array;
  width: number;
  height: number;
  scope: DesktopCaptureScope;
  /** Physical rectangle whose pixels are in the PNG. */
  captureBounds: DesktopBounds;
  /** Complete primary display used only for SendInput absolute normalization. */
  inputBounds: DesktopBounds;
  /** Stable immediately before and after capture; validates later input target context. */
  foreground: DesktopForegroundIdentity;
  /** Present only for a foreground-window crop; never projected to a provider. */
  foregroundWindow?: DesktopForegroundWindowBinding;
}

export interface DesktopPoint {
  x: number;
  y: number;
  inputBounds: DesktopBounds;
}

export interface DesktopClick {
  point: DesktopPoint;
  button: "left" | "right";
}

export interface DesktopMove {
  point: DesktopPoint;
}

export interface DesktopScroll {
  point: DesktopPoint;
  deltaX: number;
  deltaY: number;
}

export interface DesktopMouseHold {
  point: DesktopPoint;
  button: "left" | "right";
  holdMs: number;
}

export interface DesktopDrag {
  from: DesktopPoint;
  to: DesktopPoint;
  button: "left" | "right";
  /** Fixed time from confirmed down to the endpoint move; no smooth path is promised. */
  durationMs: number;
}

/**
 * The public action status remains sent/unknown. This richer internal result
 * is reserved for the exceptional case where an adapter cannot confirm it
 * released a key or button that may have been pressed.
 */
export interface DesktopPressedStateUncertain {
  status: "unknown";
  pressedState: "uncertain";
}

/** `unknown` without pressedState uncertainty is clean enough to release the lease. */
export type DesktopPrimitiveDispatch = "sent" | "unknown" | DesktopPressedStateUncertain;

/**
 * The only platform boundary used by DesktopController. Fakes can implement it
 * without loading Koffi or touching the local desktop.
 */
export interface WindowsDesktopAdapter {
  capture(scope: DesktopCaptureScope, signal: AbortSignal): Promise<DesktopCapture>;
  getForegroundIdentity(signal: AbortSignal): Promise<DesktopForegroundIdentity>;
  getForegroundWindowBinding(signal: AbortSignal): Promise<DesktopForegroundWindowBinding>;
  click(input: DesktopClick, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  type(text: string, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  keypress(
    keys: readonly string[],
    signal: AbortSignal,
    holdMs?: number,
  ): Promise<DesktopPrimitiveDispatch>;
  move(input: DesktopMove, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  mouseHold(input: DesktopMouseHold, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  drag(input: DesktopDrag, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  scroll(input: DesktopScroll, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  wait(ms: number, signal: AbortSignal): Promise<DesktopPrimitiveDispatch>;
  dispose?(): Promise<void> | void;
}

export type DesktopProviderEvidenceKind =
  | "current"
  | "before"
  | "after"
  | "historical_before";

export interface DesktopProviderImage {
  sourceToolCallId: string;
  kind: DesktopProviderEvidenceKind;
  mimeType: "image/png";
  /** A caller-owned copy. Mutating it cannot alter retained evidence. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Safe provider-only description; no window identity or physical geometry. */
  scope: DesktopCaptureScope;
}

export interface DesktopProviderEvidence {
  sourceToolCallId: string;
  /** One image for current/after-only/historical-before, two for a pair. */
  images: readonly DesktopProviderImage[];
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

export type ComputerCapturedObservation = {
  status: "captured";
  width: number;
  height: number;
};

export type ComputerUnavailableObservation = { status: "unavailable" };

export type ComputerObservation =
  | (ComputerCapturedObservation & {
      before?: ComputerCapturedObservation;
      after?: ComputerCapturedObservation;
      comparison?: "paired" | "after_only";
    })
  | (ComputerUnavailableObservation & {
      before?: ComputerCapturedObservation;
      after?: ComputerUnavailableObservation;
      comparison?: "after_missing" | "pair_too_large";
    });

export interface ComputerResultDetails {
  outcome: "completed" | "interrupted" | "desktop_busy" | "rejected";
  actions: readonly ComputerActionResult[];
  observation?: ComputerObservation;
  reason?:
    | "vision_required"
    | "controller_disposed"
    | "pressed_state_uncertain"
    | "decision_consumed"
    | "pair_too_large"
    | "foreground_mismatch"
    | "aborted"
    | "timed_out";
}

export interface ComputerToolResult {
  content: readonly { type: "text"; text: string }[];
  details: ComputerResultDetails;
}

export type ComputerActionKind =
  | "click"
  | "move"
  | "mouseHold"
  | "drag"
  | "type"
  | "keypress"
  | "scroll"
  | "wait";

type ValidatedAction =
  | { kind: "click"; x: number; y: number; button: "left" | "right" }
  | { kind: "move"; x: number; y: number }
  | { kind: "mouseHold"; x: number; y: number; button: "left" | "right"; holdMs: number }
  | {
      kind: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      button: "left" | "right";
      durationMs: number;
    }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: readonly string[]; holdMs: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "wait"; ms: number };

interface ValidatedInput {
  actions: readonly ValidatedAction[];
  observe: boolean;
  foregroundWindow: boolean;
  settleMs: number;
}

interface Frame {
  width: number;
  height: number;
  scope: DesktopCaptureScope;
  captureBounds: DesktopBounds;
  inputBounds: DesktopBounds;
  foreground: DesktopForegroundIdentity;
  foregroundWindow?: DesktopForegroundWindowBinding;
}

interface RetainedImage {
  png: Buffer;
  frame: Frame;
}

interface PendingEvidence {
  state: "pending_evidence";
  owner: object;
  sourceToolCallId: string;
  /** True only after the converter appended every evidence part to a provider request. */
  presented: boolean;
  images: readonly { kind: DesktopProviderEvidenceKind; image: RetainedImage }[];
  /** Only current/after evidence can become a future coordinate frame. */
  coordinateImage?: RetainedImage;
}

interface AuthorizedFrame extends RetainedImage {
  state: "authorized_frame";
  owner: object;
  toolCallIds: ReadonlySet<string>;
}

type ObservationState = PendingEvidence | AuthorizedFrame;

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

function normalizeButton(value: unknown, label: string): "left" | "right" {
  const button = value ?? "left";
  if (button !== "left" && button !== "right") {
    throw new Error(`${label} button must be left or right`);
  }
  return button;
}

function normalizeAction(value: unknown): ValidatedAction {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw new Error("computer action must be a flat object with a kind");
  }

  switch (value.kind) {
    case "click":
      assertOnlyFields(value, ["kind", "x", "y", "button"], "click");
      return {
        kind: "click",
        x: assertIntegerInRange(value.x, "click x", 0, MAX_CAPTURE_DIMENSION - 1),
        y: assertIntegerInRange(value.y, "click y", 0, MAX_CAPTURE_DIMENSION - 1),
        button: normalizeButton(value.button, "click"),
      };
    case "move":
      assertOnlyFields(value, ["kind", "x", "y"], "move");
      return {
        kind: "move",
        x: assertIntegerInRange(value.x, "move x", 0, MAX_CAPTURE_DIMENSION - 1),
        y: assertIntegerInRange(value.y, "move y", 0, MAX_CAPTURE_DIMENSION - 1),
      };
    case "mouseHold":
      assertOnlyFields(value, ["kind", "x", "y", "button", "holdMs"], "mouseHold");
      return {
        kind: "mouseHold",
        x: assertIntegerInRange(value.x, "mouseHold x", 0, MAX_CAPTURE_DIMENSION - 1),
        y: assertIntegerInRange(value.y, "mouseHold y", 0, MAX_CAPTURE_DIMENSION - 1),
        button: normalizeButton(value.button, "mouseHold"),
        holdMs: value.holdMs === undefined
          ? 0
          : assertIntegerInRange(value.holdMs, "mouseHold holdMs", 0, MAX_COMPUTER_HOLD_MS),
      };
    case "drag":
      assertOnlyFields(
        value,
        ["kind", "fromX", "fromY", "toX", "toY", "button", "durationMs"],
        "drag",
      );
      return {
        kind: "drag",
        fromX: assertIntegerInRange(value.fromX, "drag fromX", 0, MAX_CAPTURE_DIMENSION - 1),
        fromY: assertIntegerInRange(value.fromY, "drag fromY", 0, MAX_CAPTURE_DIMENSION - 1),
        toX: assertIntegerInRange(value.toX, "drag toX", 0, MAX_CAPTURE_DIMENSION - 1),
        toY: assertIntegerInRange(value.toY, "drag toY", 0, MAX_CAPTURE_DIMENSION - 1),
        button: normalizeButton(value.button, "drag"),
        durationMs: value.durationMs === undefined
          ? 0
          : assertIntegerInRange(
            value.durationMs,
            "drag durationMs",
            0,
            MAX_COMPUTER_DRAG_DURATION_MS,
          ),
      };
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
      assertOnlyFields(value, ["kind", "keys", "holdMs"], "keypress");
      if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 4) {
        throw new Error("keypress keys must contain 1 to 4 supported keys");
      }
      const keys = value.keys.map(normalizeKey);
      return {
        kind: "keypress",
        keys: Object.freeze(keys),
        holdMs: value.holdMs === undefined
          ? 0
          : assertIntegerInRange(value.holdMs, "keypress holdMs", 0, MAX_COMPUTER_HOLD_MS),
      };
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
  assertOnlyFields(value, ["actions", "observe", "foregroundWindow", "settleMs"], "computer input");
  if (!Array.isArray(value.actions) || typeof value.observe !== "boolean") {
    throw new Error("computer input requires actions and observe");
  }
  if (value.foregroundWindow !== undefined && typeof value.foregroundWindow !== "boolean") {
    throw new Error("computer foregroundWindow must be a boolean");
  }
  const foregroundWindow = value.foregroundWindow ?? false;
  if (foregroundWindow && !value.observe) {
    throw new Error("computer foregroundWindow requires observe=true");
  }
  if (value.actions.length > MAX_COMPUTER_ACTIONS) {
    throw new Error(`computer actions exceed ${MAX_COMPUTER_ACTIONS}`);
  }
  if (value.actions.length === 0 && value.observe === false) {
    throw new Error("computer requires an action or observe=true");
  }
  const settleMs = value.settleMs === undefined
    ? value.observe && value.actions.length > 0
      ? DEFAULT_COMPUTER_SETTLE_MS
      : 0
    : assertIntegerInRange(value.settleMs, "computer settleMs", 0, MAX_COMPUTER_SETTLE_MS);
  if ((!value.observe || value.actions.length === 0) && settleMs !== 0) {
    throw new Error("computer settleMs requires actions and observe=true");
  }
  const actions: ValidatedAction[] = [];
  for (let index = 0; index < value.actions.length; index += 1) {
    if (!Object.hasOwn(value.actions, index)) {
      throw new Error("computer actions cannot be sparse");
    }
    actions.push(normalizeAction(value.actions[index]));
  }
  return {
    actions: Object.freeze(actions),
    observe: value.observe,
    foregroundWindow,
    settleMs,
  };
}

function hasCoordinateAction(action: ValidatedAction): boolean {
  return action.kind === "click"
    || action.kind === "move"
    || action.kind === "mouseHold"
    || action.kind === "drag"
    || action.kind === "scroll";
}

function validateActionCoordinates(frame: Frame, action: ValidatedAction): void {
  switch (action.kind) {
    case "click":
    case "move":
    case "mouseHold":
    case "scroll":
      mapPoint(frame, action.x, action.y);
      return;
    case "drag":
      mapPoint(frame, action.fromX, action.fromY);
      mapPoint(frame, action.toX, action.toY);
      return;
    default:
      return;
  }
}

function actionCanLeavePressedState(action: ValidatedAction): boolean {
  return action.kind === "click"
    || action.kind === "mouseHold"
    || action.kind === "drag"
    || action.kind === "type"
    || action.kind === "keypress";
}

function dispatchStatus(value: DesktopPrimitiveDispatch): "sent" | "unknown" {
  return typeof value === "string" ? value : value.status;
}

function hasPressedStateUncertainty(value: DesktopPrimitiveDispatch): boolean {
  return typeof value !== "string" && value.pressedState === "uncertain";
}

function validateForegroundIdentity(value: unknown): DesktopForegroundIdentity {
  if (!isPlainRecord(value) || typeof value.hwnd !== "string" || value.hwnd.length === 0) {
    throw new Error("Desktop capture has invalid foreground identity");
  }
  const processId = value.processId;
  if (!Number.isInteger(processId) || typeof processId !== "number" || processId < 1 || processId > 0xffff_ffff) {
    throw new Error("Desktop capture has invalid foreground identity");
  }
  return Object.freeze({ hwnd: value.hwnd, processId });
}

function sameForeground(
  first: DesktopForegroundIdentity,
  second: DesktopForegroundIdentity,
): boolean {
  return first.hwnd === second.hwnd && first.processId === second.processId;
}

function sameBounds(first: DesktopBounds, second: DesktopBounds): boolean {
  return first.x === second.x
    && first.y === second.y
    && first.width === second.width
    && first.height === second.height;
}

function intersectBounds(first: DesktopBounds, second: DesktopBounds): DesktopBounds | undefined {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
}

function validateBounds(
  value: unknown,
  label: string,
  maximumDimension: number | undefined,
): DesktopBounds {
  if (
    !isPlainRecord(value)
    || typeof value.x !== "number"
    || !Number.isSafeInteger(value.x)
    || typeof value.y !== "number"
    || !Number.isSafeInteger(value.y)
    || typeof value.width !== "number"
    || !Number.isSafeInteger(value.width)
    || value.width < 1
    || (maximumDimension !== undefined && value.width > maximumDimension)
    || typeof value.height !== "number"
    || !Number.isSafeInteger(value.height)
    || value.height < 1
    || (maximumDimension !== undefined && value.height > maximumDimension)
  ) {
    throw new Error(`Desktop capture has invalid ${label}`);
  }
  return Object.freeze({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  });
}

function validateForegroundWindowBinding(value: unknown): DesktopForegroundWindowBinding {
  if (!isPlainRecord(value)) throw new Error("Desktop capture has invalid foreground-window binding");
  const foreground = validateForegroundIdentity(value.foreground);
  const rawBounds = validateBounds(value.rawBounds, "foreground-window raw bounds", undefined);
  const captureBounds = validateBounds(
    value.captureBounds,
    "foreground-window capture bounds",
    MAX_CAPTURE_DIMENSION,
  );
  const inputBounds = validateBounds(
    value.inputBounds,
    "foreground-window input bounds",
    MAX_CAPTURE_DIMENSION,
  );
  const expectedCaptureBounds = intersectBounds(rawBounds, inputBounds);
  if (expectedCaptureBounds === undefined || !sameBounds(captureBounds, expectedCaptureBounds)) {
    throw new Error("Desktop capture has invalid foreground-window crop");
  }
  return Object.freeze({ foreground, rawBounds, captureBounds, inputBounds });
}

function sameForegroundWindowBinding(
  frame: Frame,
  current: DesktopForegroundWindowBinding,
): boolean {
  const expected = frame.foregroundWindow;
  return expected !== undefined
    && sameForeground(frame.foreground, current.foreground)
    && sameForeground(expected.foreground, current.foreground)
    && sameBounds(expected.rawBounds, current.rawBounds)
    && sameBounds(expected.captureBounds, current.captureBounds)
    && sameBounds(expected.inputBounds, current.inputBounds)
    && sameBounds(frame.captureBounds, current.captureBounds)
    && sameBounds(frame.inputBounds, current.inputBounds);
}

function validateFrame(value: DesktopCapture, expectedScope: DesktopCaptureScope): Frame {
  if (
    !Number.isInteger(value.width)
    || value.width < 1
    || value.width > MAX_CAPTURE_DIMENSION
    || !Number.isInteger(value.height)
    || value.height < 1
    || value.height > MAX_CAPTURE_DIMENSION
    || value.width * value.height > MAX_CAPTURE_PIXELS
    || value.scope !== expectedScope
  ) {
    throw new Error("Desktop capture has invalid dimensions or scope");
  }
  const captureBounds = validateBounds(value.captureBounds, "capture bounds", MAX_CAPTURE_DIMENSION);
  const inputBounds = validateBounds(value.inputBounds, "input bounds", MAX_CAPTURE_DIMENSION);
  if (value.width !== captureBounds.width || value.height !== captureBounds.height) {
    throw new Error("Desktop capture dimensions do not match capture bounds");
  }
  const foreground = validateForegroundIdentity(value.foreground);
  if (expectedScope === "primary_display") {
    if (value.foregroundWindow !== undefined || !sameBounds(captureBounds, inputBounds)) {
      throw new Error("Desktop primary capture has invalid bounds");
    }
    return Object.freeze({
      width: value.width,
      height: value.height,
      scope: expectedScope,
      captureBounds,
      inputBounds,
      foreground,
    });
  }
  const foregroundWindow = validateForegroundWindowBinding(value.foregroundWindow);
  if (
    !sameForeground(foreground, foregroundWindow.foreground)
    || !sameBounds(captureBounds, foregroundWindow.captureBounds)
    || !sameBounds(inputBounds, foregroundWindow.inputBounds)
  ) {
    throw new Error("Desktop foreground-window capture binding is inconsistent");
  }
  return Object.freeze({
    width: value.width,
    height: value.height,
    scope: expectedScope,
    captureBounds,
    inputBounds,
    foreground,
    foregroundWindow,
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
    x: mapAxis(x, frame.width, frame.captureBounds.x, frame.captureBounds.width),
    y: mapAxis(y, frame.height, frame.captureBounds.y, frame.captureBounds.height),
    inputBounds: frame.inputBounds,
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
  /** One controller-admitted batch exhausts all sibling calls in that decision. */
  private readonly spentDecisionOwners = new WeakSet<object>();
  /** Set only when a compound input cannot confirm a final key/button up. */
  private pressedStateUncertain = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly adapter: WindowsDesktopAdapter) {}

  /**
   * Returns fresh provider-only evidence for one exact converted tool result.
   * The stored bytes stay retained for a converter retry until presentation
   * succeeds; no AgentMessage or persisted tool result is mutated.
   */
  prepareProviderEvidence(
    owner: object,
    sourceToolCallId: string,
  ): DesktopProviderEvidence | undefined {
    const observation = this.observation;
    if (
      observation?.state !== "pending_evidence"
      || observation.owner !== owner
      || observation.sourceToolCallId !== sourceToolCallId
    ) {
      return undefined;
    }
    return Object.freeze({
      sourceToolCallId,
      images: Object.freeze(observation.images.map(({ kind, image }) => Object.freeze({
        sourceToolCallId,
        kind,
        mimeType: "image/png" as const,
        png: Uint8Array.from(image.png),
        width: image.frame.width,
        height: image.frame.height,
        scope: image.frame.scope,
      }))),
    });
  }

  /** Compatibility wrapper for the earlier single-image resolver contract. */
  prepareProviderImage(
    owner: object,
    sourceToolCallId: string,
  ): DesktopProviderImage | undefined {
    return this.prepareProviderEvidence(owner, sourceToolCallId)?.images[0];
  }

  /** The converter calls this only after all evidence parts were appended. */
  markProviderEvidencePresented(owner: object, sourceToolCallId: string): boolean {
    const observation = this.observation;
    if (
      observation?.state !== "pending_evidence"
      || observation.owner !== owner
      || observation.sourceToolCallId !== sourceToolCallId
    ) {
      return false;
    }
    observation.presented = true;
    return true;
  }

  /** Compatibility wrapper for the earlier single-image resolver contract. */
  markProviderImagePresented(owner: object, sourceToolCallId: string): boolean {
    return this.markProviderEvidencePresented(owner, sourceToolCallId);
  }

  /**
   * Called only after a provider assistant decision. Historical before-only
   * evidence deliberately authorizes nothing; current/after evidence grants
   * coordinates only to the listed sibling computer calls.
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
      observation?.state !== "pending_evidence"
      || observation.owner !== owner
      || !observation.presented
    ) {
      return false;
    }
    const coordinateImage = observation.coordinateImage;
    if (toolCallIds.size === 0 || coordinateImage === undefined) {
      this.observation = undefined;
      return false;
    }
    // A successfully projected image necessarily belongs to the next
    // assistant decision, so it re-arms that owner's single admitted batch.
    this.spentDecisionOwners.delete(owner);
    this.observation = {
      state: "authorized_frame",
      owner,
      toolCallIds,
      png: coordinateImage.png,
      frame: coordinateImage.frame,
    };
    return true;
  }

  clearObservation(owner: object): void {
    if (this.observation?.owner === owner) this.observation = undefined;
  }

  /** Host-only boundary between assistant decisions; never called by a tool execution. */
  beginAssistantDecision(owner: object): void {
    this.spentDecisionOwners.delete(owner);
  }

  async release(owner: object): Promise<void> {
    if (this.leaseOwner !== owner) return;
    this.releaseOwner = owner;
    while (this.activeOperation?.owner === owner) {
      await this.activeOperation.settled;
    }
    if (this.leaseOwner === owner) {
      this.clearObservation(owner);
      this.spentDecisionOwners.delete(owner);
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

    // All schema work precedes lease acquisition or capability consumption.
    const input = normalizeInput(request.input);
    const results = actionResults(input.actions);
    if (!request.visionSupported) {
      return makeResult({ outcome: "rejected", reason: "vision_required", actions: results });
    }
    if (request.signal.aborted) {
      return makeResult({ outcome: "interrupted", reason: "aborted", actions: results });
    }
    if (this.pressedStateUncertain) {
      return makeResult({
        outcome: "rejected",
        reason: "pressed_state_uncertain",
        actions: results,
      });
    }
    if (this.spentDecisionOwners.has(request.owner)) {
      return makeResult({
        outcome: "rejected",
        reason: "decision_consumed",
        actions: results,
      });
    }

    const coordinateActions = input.actions.filter(hasCoordinateAction);
    const authorized = this.getAuthorizedFrame(request.owner, request.toolCallId);
    let coordinateFrame: Frame | undefined;
    if (coordinateActions.length > 0) {
      if (authorized === undefined) {
        throw new Error("Coordinate actions require an authorized current observation");
      }
      coordinateFrame = authorized.frame;
      for (const action of coordinateActions) {
        validateActionCoordinates(coordinateFrame, action);
      }
    }
    // Any actual action from this decision may produce an after comparison
    // against the image the decision saw, even if the action itself has no
    // coordinates (for example type or keypress).
    const before = input.observe && input.actions.length > 0 && authorized !== undefined
      ? this.copyRetainedImage(authorized)
      : undefined;

    if (this.disposed) {
      return makeResult({
        outcome: "rejected",
        reason: "controller_disposed",
        actions: results,
      });
    }
    const operation = this.beginOperation(request.owner);
    if (!operation) return makeResult({ outcome: "desktop_busy", actions: results });

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
    const finishAfterQuiescence = (
      pending: Promise<unknown>,
      action?: ValidatedAction,
    ): void => {
      if (operationDeferred) return;
      operationDeferred = true;
      void pending.then(
        (value) => {
          if (action && this.dispatchLeavesPressedStateUncertain(action, value)) {
            this.pressedStateUncertain = true;
          }
          this.finishOperation(operation);
        },
        () => {
          if (action && actionCanLeavePressedState(action)) this.pressedStateUncertain = true;
          this.finishOperation(operation);
        },
      );
    };
    const verifyForegroundIdentity = async (frame: Frame): Promise<"match" | "mismatch" | "aborted"> => {
      const pending = Promise.resolve().then(() => this.adapter.getForegroundIdentity(effectiveRequest.signal));
      const attempt = await awaitUntilAbort(pending, effectiveRequest.signal);
      if (attempt.state === "aborted") {
        finishAfterQuiescence(pending);
        return "aborted";
      }
      // A synchronous FFI failure can return only after the timer callback was
      // starved. Monotonic expiry remains the truthful result in that case.
      if (expireDeadline() || effectiveRequest.signal.aborted) return "aborted";
      if (attempt.state === "failed") return "mismatch";
      try {
        return sameForeground(frame.foreground, validateForegroundIdentity(attempt.value))
          ? "match"
          : "mismatch";
      } catch {
        return "mismatch";
      }
    };
    const verifyForegroundWindow = async (frame: Frame): Promise<"match" | "mismatch" | "aborted"> => {
      const pending = Promise.resolve().then(() => this.adapter.getForegroundWindowBinding(effectiveRequest.signal));
      const attempt = await awaitUntilAbort(pending, effectiveRequest.signal);
      if (attempt.state === "aborted") {
        finishAfterQuiescence(pending);
        return "aborted";
      }
      if (expireDeadline() || effectiveRequest.signal.aborted) return "aborted";
      if (attempt.state === "failed") return "mismatch";
      try {
        return sameForegroundWindowBinding(frame, validateForegroundWindowBinding(attempt.value))
          ? "match"
          : "mismatch";
      } catch {
        return "mismatch";
      }
    };

    try {
      if (input.actions.length === 0) {
        if (expireDeadline() || effectiveRequest.signal.aborted) {
          return makeResult({
            outcome: "interrupted",
            reason: interruptionReason(),
            actions: results,
          });
        }
        // The capture attempt itself is the admitted primitive that retires
        // any older frame. Preflight cancellation above leaves it reusable.
        this.spentDecisionOwners.add(request.owner);
        this.clearObservation(request.owner);
        return await this.captureResult(
          effectiveRequest,
          results,
          undefined,
          "current",
          input.foregroundWindow ? "foreground_window" : "primary_display",
          input.settleMs,
          interruptionReason,
          expireDeadline,
          finishAfterQuiescence,
        );
      }

      let admitted = false;
      for (let index = 0; index < input.actions.length; index += 1) {
        if (expireDeadline() || effectiveRequest.signal.aborted) {
          return this.interruptedResult(
            effectiveRequest,
            results,
            admitted ? before : undefined,
            interruptionReason(),
          );
        }
        const action = input.actions[index]!;
        // Preserve the existing foreground identity check immediately before
        // the first actual primitive, including non-coordinate actions.
        if (!admitted && authorized !== undefined) {
          const foreground = await verifyForegroundIdentity(authorized.frame);
          if (foreground === "aborted") {
            return makeResult({
              outcome: "interrupted",
              reason: interruptionReason(),
              actions: results,
            });
          }
          if (foreground !== "match") {
            this.spentDecisionOwners.add(request.owner);
            this.clearObservation(request.owner);
            return makeResult({
              outcome: "rejected",
              reason: "foreground_mismatch",
              actions: results,
            });
          }
        }
        // A window crop maps local image pixels through mutable screen geometry.
        // Re-read its full binding immediately before every coordinate dispatch,
        // including a later click after wait/type or an earlier coordinate action.
        if (hasCoordinateAction(action) && coordinateFrame?.foregroundWindow !== undefined) {
          const foreground = await verifyForegroundWindow(coordinateFrame);
          if (foreground === "aborted") {
            return admitted
              ? this.interruptedResult(effectiveRequest, results, before, interruptionReason())
              : makeResult({
                  outcome: "interrupted",
                  reason: interruptionReason(),
                  actions: results,
                });
          }
          if (foreground !== "match") {
            this.spentDecisionOwners.add(request.owner);
            this.clearObservation(request.owner);
            return admitted
              ? this.interruptedResult(effectiveRequest, results, before, "foreground_mismatch")
              : makeResult({
                  outcome: "rejected",
                  reason: "foreground_mismatch",
                  actions: results,
                });
          }
        }
        // A successfully validated call consumes its capability only at the
        // first concrete adapter attempt, never on schema/host rejection.
        if (!admitted) {
          admitted = true;
          this.spentDecisionOwners.add(request.owner);
          this.clearObservation(request.owner);
        }
        const pendingDispatch = this.dispatch(action, coordinateFrame, effectiveRequest.signal);
        const attempt = await awaitUntilAbort(pendingDispatch, effectiveRequest.signal);
        if (attempt.state === "aborted") {
          finishAfterQuiescence(pendingDispatch, action);
          results[index]!.status = "unknown";
          return this.interruptedResult(
            effectiveRequest,
            results,
            before,
            interruptionReason(),
          );
        }

        // Native calls can block the event loop past the timer. Check both
        // success and failure paths before exposing their state.
        const deadlineExpired = expireDeadline();
        if (attempt.state === "failed") {
          if (actionCanLeavePressedState(action)) this.pressedStateUncertain = true;
          results[index]!.status = "unknown";
          return this.interruptedResult(
            effectiveRequest,
            results,
            before,
            deadlineExpired || effectiveRequest.signal.aborted ? interruptionReason() : undefined,
          );
        }
        const status = dispatchStatus(attempt.value);
        if (hasPressedStateUncertainty(attempt.value)) this.pressedStateUncertain = true;
        if (status !== "sent") {
          results[index]!.status = "unknown";
          return this.interruptedResult(
            effectiveRequest,
            results,
            before,
            deadlineExpired || effectiveRequest.signal.aborted ? interruptionReason() : undefined,
          );
        }
        results[index]!.status = "sent";
        if (deadlineExpired || effectiveRequest.signal.aborted) {
          return this.interruptedResult(effectiveRequest, results, before, interruptionReason());
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
        before,
        "after",
        input.foregroundWindow ? "foreground_window" : "primary_display",
        input.settleMs,
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
    if (this.disposed || this.pressedStateUncertain || this.releaseOwner === owner) return undefined;
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

  private getAuthorizedFrame(owner: object, toolCallId: string): AuthorizedFrame | undefined {
    const observation = this.observation;
    return observation?.state === "authorized_frame"
      && observation.owner === owner
      && observation.toolCallIds.has(toolCallId)
      ? observation
      : undefined;
  }

  private copyRetainedImage(image: RetainedImage): RetainedImage {
    return { png: image.png, frame: image.frame };
  }

  private installEvidence(
    owner: object,
    sourceToolCallId: string,
    images: readonly { kind: DesktopProviderEvidenceKind; image: RetainedImage }[],
    coordinateImage?: RetainedImage,
  ): void {
    if (images.length < 1 || images.length > 2) {
      throw new Error("computer evidence must contain one or two images");
    }
    this.observation = {
      state: "pending_evidence",
      owner,
      sourceToolCallId,
      presented: false,
      images: Object.freeze(images.map(({ kind, image }) => Object.freeze({
        kind,
        image: this.copyRetainedImage(image),
      }))),
      ...(coordinateImage === undefined ? {} : { coordinateImage: this.copyRetainedImage(coordinateImage) }),
    };
  }

  private capturedObservation(image: RetainedImage): ComputerCapturedObservation {
    return Object.freeze({
      status: "captured" as const,
      width: image.frame.width,
      height: image.frame.height,
    });
  }

  private interruptedResult(
    request: DesktopControllerRequest,
    results: ComputerActionResult[],
    before: RetainedImage | undefined,
    reason: "aborted" | "timed_out" | "foreground_mismatch" | undefined,
  ): ComputerToolResult {
    if (before === undefined) {
      this.clearObservation(request.owner);
      return makeResult({
        outcome: "interrupted",
        reason,
        actions: results,
        observation: { status: "unavailable" },
      });
    }
    this.installEvidence(request.owner, request.toolCallId, [{
      kind: "historical_before",
      image: before,
    }]);
    return makeResult({
      outcome: "interrupted",
      reason,
      actions: results,
      observation: {
        status: "unavailable",
        before: this.capturedObservation(before),
        after: { status: "unavailable" },
        comparison: "after_missing",
      },
    });
  }

  private dispatchLeavesPressedStateUncertain(
    action: ValidatedAction,
    value: unknown,
  ): boolean {
    return actionCanLeavePressedState(action)
      && isPlainRecord(value)
      && value.status === "unknown"
      && value.pressedState === "uncertain";
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
      case "move":
        return this.adapter.move({
          point: mapPoint(coordinateFrame!, action.x, action.y),
        }, signal);
      case "mouseHold":
        return this.adapter.mouseHold({
          point: mapPoint(coordinateFrame!, action.x, action.y),
          button: action.button,
          holdMs: action.holdMs,
        }, signal);
      case "drag":
        return this.adapter.drag({
          from: mapPoint(coordinateFrame!, action.fromX, action.fromY),
          to: mapPoint(coordinateFrame!, action.toX, action.toY),
          button: action.button,
          durationMs: action.durationMs,
        }, signal);
      case "type":
        return this.adapter.type(action.text, signal);
      case "keypress":
        return this.adapter.keypress(action.keys, signal, action.holdMs);
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
    before: RetainedImage | undefined,
    mode: "current" | "after",
    scope: DesktopCaptureScope,
    settleMs: number,
    interruptionReason: () => "aborted" | "timed_out",
    expireDeadline: () => boolean,
    finishAfterQuiescence: (pending: Promise<unknown>) => void,
  ): Promise<ComputerToolResult> {
    const interrupted = (reason: "aborted" | "timed_out" | undefined): ComputerToolResult =>
      this.interruptedResult(request, results, mode === "after" ? before : undefined, reason);
    try {
      if (expireDeadline() || request.signal.aborted) return interrupted(interruptionReason());
      if (settleMs > 0) {
        const pendingSettle = this.adapter.wait(settleMs, request.signal);
        const settleAttempt = await awaitUntilAbort(pendingSettle, request.signal);
        if (settleAttempt.state === "aborted") {
          finishAfterQuiescence(pendingSettle);
          return interrupted(interruptionReason());
        }
        const settleDeadlineExpired = expireDeadline();
        if (
          settleAttempt.state === "failed"
          || (settleAttempt.state === "settled" && dispatchStatus(settleAttempt.value) !== "sent")
        ) {
          return interrupted(
            settleDeadlineExpired || request.signal.aborted ? interruptionReason() : undefined,
          );
        }
        if (settleDeadlineExpired || request.signal.aborted) return interrupted(interruptionReason());
      }

      const pendingCapture = this.adapter.capture(scope, request.signal);
      const attempt = await awaitUntilAbort(pendingCapture, request.signal);
      if (attempt.state === "aborted") {
        finishAfterQuiescence(pendingCapture);
        return interrupted(interruptionReason());
      }
      const deadlineExpired = expireDeadline();
      if (attempt.state === "failed") {
        return interrupted(deadlineExpired || request.signal.aborted ? interruptionReason() : undefined);
      }
      if (deadlineExpired || request.signal.aborted) return interrupted(interruptionReason());

      const after: RetainedImage = {
        frame: validateFrame(attempt.value, scope),
        png: validatePng(attempt.value.png),
      };
      if (before !== undefined && before.png.byteLength + after.png.byteLength > MAX_COMPUTER_PAIR_PNG_BYTES) {
        this.clearObservation(request.owner);
        return makeResult({
          outcome: "interrupted",
          reason: "pair_too_large",
          actions: results,
          observation: { status: "unavailable", comparison: "pair_too_large" },
        });
      }

      if (before !== undefined) {
        this.installEvidence(request.owner, request.toolCallId, [
          { kind: "before", image: before },
          { kind: "after", image: after },
        ], after);
        return makeResult({
          outcome: "completed",
          actions: results,
          observation: {
            ...this.capturedObservation(after),
            before: this.capturedObservation(before),
            after: this.capturedObservation(after),
            comparison: "paired",
          },
        });
      }

      const kind: DesktopProviderEvidenceKind = mode === "current" ? "current" : "after";
      this.installEvidence(request.owner, request.toolCallId, [{ kind, image: after }], after);
      return makeResult({
        outcome: "completed",
        actions: results,
        observation: mode === "current"
          ? this.capturedObservation(after)
          : {
              ...this.capturedObservation(after),
              after: this.capturedObservation(after),
              comparison: "after_only",
            },
      });
    } catch {
      const deadlineExpired = expireDeadline();
      return interrupted(deadlineExpired || request.signal.aborted ? interruptionReason() : undefined);
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
  getForegroundWindow: NativeFunction;
  getWindowThreadProcessId: NativeFunction;
  isIconic: NativeFunction;
  getWindowRect: NativeFunction;
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
  return value === null || value === undefined || value === 0 || value === 0n;
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

interface DesktopCaptureBinding {
  foreground: DesktopForegroundIdentity;
  captureBounds: DesktopBounds;
  inputBounds: DesktopBounds;
  foregroundWindow?: DesktopForegroundWindowBinding;
}

function sameCaptureBinding(first: DesktopCaptureBinding, second: DesktopCaptureBinding): boolean {
  if (
    !sameForeground(first.foreground, second.foreground)
    || !sameBounds(first.captureBounds, second.captureBounds)
    || !sameBounds(first.inputBounds, second.inputBounds)
  ) {
    return false;
  }
  if (first.foregroundWindow === undefined || second.foregroundWindow === undefined) {
    return first.foregroundWindow === second.foregroundWindow;
  }
  return sameForeground(first.foregroundWindow.foreground, second.foregroundWindow.foreground)
    && sameBounds(first.foregroundWindow.rawBounds, second.foregroundWindow.rawBounds)
    && sameBounds(first.foregroundWindow.captureBounds, second.foregroundWindow.captureBounds)
    && sameBounds(first.foregroundWindow.inputBounds, second.foregroundWindow.inputBounds);
}

/**
 * Koffi-backed primary-display/foreground-crop adapter. Koffi is dynamically
 * imported and its Windows DLLs are loaded only by createWindowsDesktopAdapter().
 */
class KoffiWindowsDesktopAdapter implements WindowsDesktopAdapter {
  constructor(
    private readonly native: WindowsFunctions,
    private readonly monitorInfoSize: number,
    private readonly bitmapInfoHeaderSize: number,
    private readonly inputSize: number,
    private readonly view: (pointer: unknown, length: number) => Uint8Array,
  ) {}

  async capture(scope: DesktopCaptureScope, signal: AbortSignal): Promise<DesktopCapture> {
    return this.withPhysicalDpi(() => {
      if (signal.aborted) throw abortError();
      const bindingBefore = this.readCaptureBinding(scope);
      let screenDc: unknown;
      let memoryDc: unknown;
      let bitmap: unknown;
      let previousObject: unknown;
      let selected = false;
      try {
        const bounds = bindingBefore.captureBounds;
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
        const bindingAfter = this.readCaptureBinding(scope);
        if (!sameCaptureBinding(bindingBefore, bindingAfter)) {
          throw new Error("Foreground or capture geometry changed during desktop capture");
        }
        const bgra = Buffer.from(this.view(assertHandle(bits[0], "CreateDIBSection bits"), width * height * 4));
        return {
          png: encodePngFromBgra(width, height, bgra),
          width,
          height,
          scope,
          captureBounds: bindingAfter.captureBounds,
          inputBounds: bindingAfter.inputBounds,
          foreground: bindingAfter.foreground,
          ...(bindingAfter.foregroundWindow === undefined
            ? {}
            : { foregroundWindow: bindingAfter.foregroundWindow }),
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

  async getForegroundIdentity(signal: AbortSignal): Promise<DesktopForegroundIdentity> {
    if (signal.aborted) throw abortError();
    return this.readForegroundIdentity();
  }

  async getForegroundWindowBinding(signal: AbortSignal): Promise<DesktopForegroundWindowBinding> {
    if (signal.aborted) throw abortError();
    return this.withPhysicalDpi(() => this.readForegroundWindowBinding());
  }

  async click(input: DesktopClick, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    const [down, up] = this.mouseButtonFlags(input.button);
    let complete = false;
    let mayHavePressed = false;
    let released!: ReturnType<KoffiWindowsDesktopAdapter["bestEffortRelease"]>;
    try {
      const started = this.attemptInputWithPhysicalDpi([
        this.mouseInput(input.point, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
        this.mouseInput(input.point, down, 0),
      ]);
      complete = started.status === "sent";
      // Start is [move, down], so count=1 cannot leave a button down.
      mayHavePressed = this.mayHavePressed(started, 1);
    } catch {
      // Unexpected post-attempt errors remain conservative.
      mayHavePressed = true;
    } finally {
      released = this.bestEffortRelease([this.mouseInput(input.point, up, 0)]);
    }
    return this.completeAfterRelease(complete, released, mayHavePressed);
  }

  async move(input: DesktopMove, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    return this.sendWithPhysicalDpi([
      this.mouseInput(input.point, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
    ]);
  }

  async mouseHold(input: DesktopMouseHold, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    const [down, up] = this.mouseButtonFlags(input.button);
    let complete = false;
    let mayHavePressed = false;
    let released!: ReturnType<KoffiWindowsDesktopAdapter["bestEffortRelease"]>;
    try {
      const started = this.attemptInputWithPhysicalDpi([
        this.mouseInput(input.point, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
        this.mouseInput(input.point, down, 0),
      ]);
      complete = started.status === "sent";
      // Start is [move, down], so count=1 cannot leave a button down.
      mayHavePressed = this.mayHavePressed(started, 1);
      if (complete && input.holdMs > 0) {
        try {
          await this.wait(input.holdMs, signal);
        } catch {
          complete = false;
        }
      }
    } catch {
      mayHavePressed = true;
    } finally {
      released = this.bestEffortRelease([this.mouseInput(input.point, up, 0)]);
    }
    return this.completeAfterRelease(complete, released, mayHavePressed);
  }

  async drag(input: DesktopDrag, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    const [down, up] = this.mouseButtonFlags(input.button);
    let complete = false;
    let mayHavePressed = false;
    let released!: ReturnType<KoffiWindowsDesktopAdapter["bestEffortRelease"]>;
    try {
      const started = this.attemptInputWithPhysicalDpi([
        this.mouseInput(input.from, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
        this.mouseInput(input.from, down, 0),
      ]);
      complete = started.status === "sent";
      // Start is [move, down], so count=1 cannot leave a button down.
      mayHavePressed = this.mayHavePressed(started, 1);
      if (complete && input.durationMs > 0) {
        try {
          await this.wait(input.durationMs, signal);
        } catch {
          complete = false;
        }
      }
      if (complete && !signal.aborted) {
        complete = this.sendWithPhysicalDpi([
          this.mouseInput(input.to, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0),
        ]) === "sent";
      } else {
        complete = false;
      }
    } catch {
      mayHavePressed = true;
    } finally {
      released = this.bestEffortRelease([this.mouseInput(input.to, up, 0)]);
    }
    return this.completeAfterRelease(complete, released, mayHavePressed);
  }

  async type(text: string, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    for (let offset = 0; offset < text.length; offset += MAX_TYPE_CODE_UNITS_PER_NATIVE_BATCH) {
      if (signal.aborted) return "unknown";
      const end = Math.min(text.length, offset + MAX_TYPE_CODE_UNITS_PER_NATIVE_BATCH);
      const codeUnits: number[] = [];
      const inputs: NativeInput[] = [];
      for (let index = offset; index < end; index += 1) {
        const codeUnit = text.charCodeAt(index);
        codeUnits.push(codeUnit);
        // A chunk contains complete Unicode down/up pairs. If SendInput stops
        // on an odd prefix, exactly one Unicode key may still be down.
        inputs.push(this.unicodeInput(codeUnit, false), this.unicodeInput(codeUnit, true));
      }
      const started = this.attemptInputWithPhysicalDpi(inputs);
      if (started.status !== "sent") {
        const mayHavePressed = started.sentCount === undefined
          ? started.sendAttempted
          : started.sentCount % 2 === 1;
        if (!mayHavePressed) return "unknown";
        const released = this.bestEffortRelease(
          [...codeUnits].reverse().map((codeUnit) => this.unicodeInput(codeUnit, true)),
        );
        return this.completeAfterRelease(false, released, true);
      }
      // A macrotask checkpoint lets the controller deadline/abort timer run
      // between bounded native dispatches instead of after thousands of FFI calls.
      if (end < text.length) {
        try {
          await this.wait(0, signal);
        } catch {
          return "unknown";
        }
      }
    }
    return "sent";
  }

  async keypress(
    keys: readonly string[],
    signal: AbortSignal,
    holdMs = 0,
  ): Promise<DesktopPrimitiveDispatch> {
    if (signal.aborted) throw abortError();
    const down = keys.map((key) => this.keyboardInput(SUPPORTED_DESKTOP_KEYS[key]!, false));
    const up = [...keys].reverse().map((key) => this.keyboardInput(SUPPORTED_DESKTOP_KEYS[key]!, true));
    let complete = false;
    let mayHavePressed = false;
    let released!: ReturnType<KoffiWindowsDesktopAdapter["bestEffortRelease"]>;
    try {
      const started = this.attemptInputWithPhysicalDpi(down);
      complete = started.status === "sent";
      mayHavePressed = this.mayHavePressed(started, 0);
      if (complete && holdMs > 0) {
        try {
          await this.wait(holdMs, signal);
        } catch {
          complete = false;
        }
      }
    } catch {
      mayHavePressed = true;
    } finally {
      released = this.bestEffortRelease(up);
    }
    return this.completeAfterRelease(complete, released, mayHavePressed);
  }

  async scroll(input: DesktopScroll, signal: AbortSignal): Promise<DesktopPrimitiveDispatch> {
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
    return this.sendWithPhysicalDpi(inputs);
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

  private readCaptureBinding(scope: DesktopCaptureScope): DesktopCaptureBinding {
    const inputBounds = this.readPrimaryBounds();
    if (scope === "primary_display") {
      const foreground = this.readForegroundIdentity();
      return Object.freeze({ foreground, captureBounds: inputBounds, inputBounds });
    }
    const foregroundWindow = this.readForegroundWindowBinding(inputBounds);
    return Object.freeze({
      foreground: foregroundWindow.foreground,
      captureBounds: foregroundWindow.captureBounds,
      inputBounds: foregroundWindow.inputBounds,
      foregroundWindow,
    });
  }

  private readPrimaryBounds(): DesktopBounds {
    const monitor = assertHandle(
      this.native.monitorFromPoint({ x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY),
      "MonitorFromPoint",
    );
    const monitorInfo: Record<string, unknown> = { cbSize: this.monitorInfoSize };
    if (this.native.getMonitorInfo(monitor, monitorInfo) === 0) {
      throw new Error("GetMonitorInfoW failed");
    }
    return Object.freeze(this.monitorBounds(monitorInfo.rcMonitor));
  }

  private readForegroundWindowBinding(
    inputBounds = this.readPrimaryBounds(),
  ): DesktopForegroundWindowBinding {
    const target = this.readForeground();
    const iconic = this.native.isIconic(target.hwnd);
    if (typeof iconic !== "number" || !Number.isInteger(iconic)) {
      throw new Error("IsIconic returned invalid result");
    }
    if (iconic !== 0) throw new Error("Foreground window is minimized");
    const rectangle: Record<string, unknown> = { left: 0, top: 0, right: 0, bottom: 0 };
    if (this.native.getWindowRect(target.hwnd, rectangle) === 0) {
      throw new Error("GetWindowRect failed");
    }
    const rawBounds = this.monitorBounds(rectangle);
    const captureBounds = intersectBounds(rawBounds, inputBounds);
    if (captureBounds === undefined) throw new Error("Foreground window is outside the primary display");
    return Object.freeze({
      foreground: target.identity,
      rawBounds: Object.freeze(rawBounds),
      captureBounds: Object.freeze(captureBounds),
      inputBounds,
    });
  }

  private readForegroundIdentity(): DesktopForegroundIdentity {
    return this.readForeground().identity;
  }

  private readForeground(): { hwnd: unknown; identity: DesktopForegroundIdentity } {
    const hwnd = assertHandle(this.native.getForegroundWindow(), "GetForegroundWindow");
    if (
      (typeof hwnd !== "number" || !Number.isInteger(hwnd))
      && typeof hwnd !== "bigint"
    ) {
      throw new Error("GetForegroundWindow returned invalid handle");
    }
    const processId: unknown[] = [0];
    if (this.native.getWindowThreadProcessId(hwnd, processId) === 0) {
      throw new Error("GetWindowThreadProcessId failed");
    }
    const pid = processId[0];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
      throw new Error("GetWindowThreadProcessId returned invalid process ID");
    }
    return Object.freeze({ hwnd, identity: Object.freeze({ hwnd: hwnd.toString(), processId: pid }) });
  }

  private mouseButtonFlags(button: "left" | "right"): readonly [number, number] {
    return button === "left"
      ? [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]
      : [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP];
  }

  private sendWithPhysicalDpi(inputs: readonly NativeInput[]): "sent" | "unknown" {
    const attempt = this.inspectSendWithPhysicalDpi(inputs);
    if ("error" in attempt) throw attempt.error;
    // A failed DPI restore does not undo a known SendInput result, but it makes
    // the enclosing primitive incomplete rather than falsely reporting sent.
    return attempt.restoreFailed ? "unknown" : attempt.result.status;
  }

  /**
   * Unlike ordinary move/scroll, a down sequence needs the exact inserted
   * prefix. A DPI setup failure before SendInput has no possible press; a
   * thrown SendInput is conservative because Windows may have accepted input.
   */
  private attemptInputWithPhysicalDpi(inputs: readonly NativeInput[]): {
    status: "sent" | "unknown";
    sentCount: number | undefined;
    sendAttempted: boolean;
  } {
    const attempt = this.inspectSendWithPhysicalDpi(inputs);
    if ("error" in attempt) {
      return { status: "unknown", sentCount: undefined, sendAttempted: attempt.sendAttempted };
    }
    return {
      status: attempt.restoreFailed ? "unknown" : attempt.result.status,
      sentCount: attempt.result.count,
      sendAttempted: true,
    };
  }

  private mayHavePressed(
    attempt: ReturnType<KoffiWindowsDesktopAdapter["attemptInputWithPhysicalDpi"]>,
    firstPressedInputIndex: number,
  ): boolean {
    if (!attempt.sendAttempted) return false;
    // An invalid/throwing native result has no reliable prefix; SendInput may
    // have reached the named down input before reporting the error.
    return attempt.sentCount === undefined || attempt.sentCount > firstPressedInputIndex;
  }

  private inspectSendWithPhysicalDpi(inputs: readonly NativeInput[]):
    | { result: { status: "sent" | "unknown"; count: number | undefined }; restoreFailed: boolean }
    | { error: unknown; sendAttempted: boolean } {
    let previous: unknown;
    try {
      previous = assertHandle(
        this.native.setThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
        "SetThreadDpiAwarenessContext",
      );
    } catch (error) {
      return { error, sendAttempted: false };
    }

    let operationFailed = false;
    let operationError: unknown;
    let result!: { status: "sent" | "unknown"; count: number | undefined };
    try {
      result = this.send(inputs);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let restoreFailed = false;
    try {
      if (this.native.setThreadDpiAwarenessContext(previous) === 0) restoreFailed = true;
    } catch {
      restoreFailed = true;
    }
    if (operationFailed) return { error: operationError, sendAttempted: true };
    return { result, restoreFailed };
  }

  /**
   * A cleanup failure is qualitatively different from an ordinary unknown
   * dispatch: Windows may still have a key or button down, so the controller
   * must permanently retain the desktop lease rather than hand it to a run.
   */
  private bestEffortRelease(inputs: readonly NativeInput[]): {
    confirmed: boolean;
    status: "sent" | "unknown";
  } {
    const attempt = this.inspectSendWithPhysicalDpi(inputs);
    if ("error" in attempt) return { confirmed: false, status: "unknown" };
    return {
      confirmed: attempt.result.status === "sent",
      status: attempt.result.status === "sent" && !attempt.restoreFailed ? "sent" : "unknown",
    };
  }

  private completeAfterRelease(
    complete: boolean,
    released: ReturnType<KoffiWindowsDesktopAdapter["bestEffortRelease"]>,
    mayHavePressed: boolean,
  ): DesktopPrimitiveDispatch {
    if (!released.confirmed && mayHavePressed) {
      return { status: "unknown", pressedState: "uncertain" };
    }
    return complete && released.status === "sent" ? "sent" : "unknown";
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
          dx: this.absoluteCoordinate(point.x, point.inputBounds.x, point.inputBounds.width),
          dy: this.absoluteCoordinate(point.y, point.inputBounds.y, point.inputBounds.height),
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

  private send(inputs: readonly NativeInput[]): {
    status: "sent" | "unknown";
    count: number | undefined;
  } {
    const rawCount = this.native.sendInput(inputs.length, inputs, this.inputSize);
    const count = typeof rawCount === "number"
      && Number.isInteger(rawCount)
      && rawCount >= 0
      && rawCount <= inputs.length
      ? rawCount
      : undefined;
    return {
      status: count === inputs.length ? "sent" : "unknown",
      count,
    };
  }
}

/**
 * Internal test seam: exercises the real compound-input adapter against a
 * scripted native boundary without importing Koffi or touching the desktop.
 */
export interface WindowsDesktopInputTestNative {
  setThreadDpiAwarenessContext(...args: unknown[]): unknown;
  sendInput(...args: unknown[]): unknown;
}

export function createWindowsDesktopInputAdapterForTest(
  native: WindowsDesktopInputTestNative,
): WindowsDesktopAdapter {
  return new KoffiWindowsDesktopAdapter(
    native as unknown as WindowsFunctions,
    0,
    0,
    1,
    () => {
      throw new Error("capture is unavailable in the input adapter test seam");
    },
  );
}

/** Internal test seam for capture geometry and GDI cleanup; never loads Koffi. */
export interface WindowsDesktopCaptureTestNative extends WindowsDesktopInputTestNative {
  getForegroundWindow(...args: unknown[]): unknown;
  getWindowThreadProcessId(...args: unknown[]): unknown;
  isIconic(...args: unknown[]): unknown;
  getWindowRect(...args: unknown[]): unknown;
  monitorFromPoint(...args: unknown[]): unknown;
  getMonitorInfo(...args: unknown[]): unknown;
  getDc(...args: unknown[]): unknown;
  releaseDc(...args: unknown[]): unknown;
  createCompatibleDc(...args: unknown[]): unknown;
  deleteDc(...args: unknown[]): unknown;
  createDibSection(...args: unknown[]): unknown;
  selectObject(...args: unknown[]): unknown;
  deleteObject(...args: unknown[]): unknown;
  bitBlt(...args: unknown[]): unknown;
}

export function createWindowsDesktopCaptureAdapterForTest(
  native: WindowsDesktopCaptureTestNative,
  view: (pointer: unknown, length: number) => Uint8Array = (_pointer, length) => new Uint8Array(length),
): WindowsDesktopAdapter {
  return new KoffiWindowsDesktopAdapter(
    native as unknown as WindowsFunctions,
    1,
    1,
    1,
    view,
  );
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
      getForegroundWindow: user32.func(
        "intptr_t __stdcall GetForegroundWindow()",
      ),
      getWindowThreadProcessId: user32.func(
        "uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *processId)",
      ),
      isIconic: user32.func("int __stdcall IsIconic(intptr_t hWnd)"),
      getWindowRect: user32.func(
        "int __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *rect)",
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
