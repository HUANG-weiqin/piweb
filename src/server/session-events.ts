import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEvent, TokenUsage } from "../shared/protocol.js";
import { CONVERSATION_MESSAGE_CUSTOM_TYPE } from "./conversation-meta.js";

const MAX_WIRE_VALUE_BYTES = 200_000;
const TRUNCATED_PREVIEW_CHARS = 50_000;
const MAX_WIRE_NODES = 10_000;
const MAX_COLLECTION_ITEMS = 2_000;
const MAX_WIRE_DEPTH = 32;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function projectUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value);
  if (!usage) return;

  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const nativeTotal = finiteNumber(usage.totalTokens);
  const total = nativeTotal || input + output + cacheRead + cacheWrite;
  if (total <= 0) return;

  return { input, output, cacheRead, cacheWrite, total };
}

function projectAssistantText(message: unknown): string {
  const value = record(message);
  if (value?.role !== "assistant" || !Array.isArray(value.content)) return "";

  return value.content
    .map((item) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function projectUserText(message: unknown): string {
  const value = record(message);
  if (value?.role !== "user") return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map((item) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .join("");
}

function joinMessageText(completed: string, current: string): string {
  if (!completed) return current;
  if (!current) return completed;
  return `${completed}\n\n${current}`;
}

/**
 * Converts extension-controlled tool payloads into bounded JSON-safe data.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[Unserializable]";
  }
}

function addExactBytes(budget: { bytes: number }, value: string | number): void {
  budget.bytes += typeof value === "number" ? value : Buffer.byteLength(value, "utf8");
  if (budget.bytes > MAX_WIRE_VALUE_BYTES) {
    throw new Error("Wire value exceeds the exact snapshot size limit");
  }
}

function measureExactWireValue(
  value: unknown,
  visiting: WeakSet<object>,
  budget: { bytes: number; nodes: number },
  depth: number,
): void {
  if (value === null) {
    addExactBytes(budget, 4);
    return;
  }
  if (typeof value === "string") {
    addExactBytes(budget, JSON.stringify(value));
    return;
  }
  if (typeof value === "boolean") {
    addExactBytes(budget, value ? 4 : 5);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Wire value contains a lossy number");
    }
    addExactBytes(budget, JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Wire value contains non-JSON data");
  }
  if (nodeTypes.isProxy(value)) throw new Error("Wire value contains a proxy");
  if (depth >= MAX_WIRE_DEPTH || budget.nodes-- <= 0) {
    throw new Error("Wire value exceeds the exact snapshot complexity limit");
  }
  if (visiting.has(value)) throw new Error("Wire value contains a cycle");

  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("Wire value contains a non-plain array");
      }
      if (value.length > MAX_WIRE_VALUE_BYTES) {
        throw new Error("Wire value exceeds the exact snapshot size limit");
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1
        || keys.some((key) => typeof key !== "string")
        || !keys.includes("length")
      ) {
        throw new Error("Wire value contains a non-JSON array");
      }

      addExactBytes(budget, 2 + Math.max(0, value.length - 1));
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("Wire value contains a non-JSON array entry");
        }
        measureExactWireValue(descriptor.value, visiting, budget, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Wire value contains a non-plain object");
    }
    const keys = Reflect.ownKeys(value);
    addExactBytes(budget, 2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("Wire value contains a symbol property");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("Wire value contains an accessor or hidden property");
      }
      addExactBytes(budget, JSON.stringify(key));
      addExactBytes(budget, 1);
      measureExactWireValue(descriptor.value, visiting, budget, depth + 1);
    }
  } finally {
    visiting.delete(value);
  }
}

function freezeWireValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeWireValue(child);
  Object.freeze(value);
}

/**
 * Captures the exact JSON value shown for authorization. Unlike toWireValue,
 * this never substitutes, truncates, or previews data.
 */
export function snapshotWireValue(value: unknown): {
  value: unknown;
  serialized: string;
} {
  const budget = { bytes: 0, nodes: MAX_WIRE_NODES };
  measureExactWireValue(value, new WeakSet<object>(), budget, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Wire value is not JSON-serializable");
  if (Buffer.byteLength(serialized, "utf8") > MAX_WIRE_VALUE_BYTES) {
    throw new Error("Wire value exceeds the exact snapshot size limit");
  }

  const snapshot = JSON.parse(serialized) as unknown;
  freezeWireValue(snapshot);
  return { value: snapshot, serialized };
}

function sanitizeWireValue(
  value: unknown,
  seen: WeakSet<object>,
  budget: { nodes: number; truncated: boolean },
  depth: number,
): unknown {
  if (value === undefined || value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return safeString(value);
  }
  if (typeof value === "string") {
    if (value.length <= MAX_WIRE_VALUE_BYTES) return value;
    budget.truncated = true;
    return value.slice(0, TRUNCATED_PREVIEW_CHARS);
  }
  if (depth >= MAX_WIRE_DEPTH || budget.nodes-- <= 0) {
    budget.truncated = true;
    return "[Truncated]";
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const length = Math.min(value.length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < length; index++) {
      output.push(sanitizeWireValue(value[index], seen, budget, depth + 1));
    }
    if (length < value.length) budget.truncated = true;
    return output;
  }

  const output: Record<string, unknown> = {};
  let count = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count++ >= MAX_COLLECTION_ITEMS) {
        budget.truncated = true;
        break;
      }
      try {
        output[key] = sanitizeWireValue(
          (value as Record<string, unknown>)[key],
          seen,
          budget,
          depth + 1,
        );
      } catch {
        output[key] = "[Uninspectable]";
      }
    }
  } catch {
    return safeString(value);
  }
  return output;
}

export function toWireValue(value: unknown): unknown {
  if (value === undefined) return;

  const budget = { nodes: MAX_WIRE_NODES, truncated: false };
  const sanitized = sanitizeWireValue(value, new WeakSet<object>(), budget, 0);
  let json: string;
  try {
    json = JSON.stringify(sanitized);
  } catch {
    return safeString(value);
  }

  if (budget.truncated || Buffer.byteLength(json, "utf8") > MAX_WIRE_VALUE_BYTES) {
    return {
      truncated: true,
      preview: json.slice(0, TRUNCATED_PREVIEW_CHARS),
    };
  }

  return JSON.parse(json) as unknown;
}

/**
 * Stateful adapter from Pi's event model to the workbench wire contract.
 * A run may contain multiple assistant segments separated by user steering;
 * final messages calibrate the current segment while finalText spans the run.
 */
export class SessionEventProjector {
  private runCompletedText = "";
  private segmentCompletedText = "";
  private currentMessageText = "";
  private finalErrorMessage?: string;
  private finalAborted = false;
  private suppressNextUserMessage: boolean;

  constructor(options: { suppressNextUserMessage?: boolean } = {}) {
    this.suppressNextUserMessage = options.suppressNextUserMessage === true;
  }

  get errorMessage(): string | undefined {
    return this.finalErrorMessage;
  }

  get aborted(): boolean {
    return this.finalAborted;
  }

  get finalText(): string | null {
    return this.runCompletedText.length === 0 ? null : this.runCompletedText;
  }

  project(event: AgentSessionEvent): SessionEvent[] {
    if (event.type === "agent_start") {
      this.runCompletedText = "";
      this.segmentCompletedText = "";
      this.currentMessageText = "";
      this.finalErrorMessage = undefined;
      this.finalAborted = false;
      return [];
    }

    if (event.type === "agent_settled") {
      return [];
    }

    if (
      event.type === "message_start"
      && event.message.role === "custom"
      && event.message.customType === CONVERSATION_MESSAGE_CUSTOM_TYPE
    ) {
      this.segmentCompletedText = "";
      this.currentMessageText = "";
      return [];
    }

    if (event.type === "message_start" && event.message.role === "user") {
      if (this.suppressNextUserMessage) {
        this.suppressNextUserMessage = false;
        return [];
      }
      const text = projectUserText(event.message);
      this.segmentCompletedText = "";
      this.currentMessageText = "";
      return text
        ? [{ type: "user_message", projectionId: randomUUID(), text }]
        : [];
    }

    if (event.type === "message_start" && event.message.role === "assistant") {
      this.segmentCompletedText = "";
      this.currentMessageText = "";
      return [{
        type: "assistant_message_started",
        projectionId: randomUUID(),
      }];
    }

    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "thinking_delta") {
        return [{ type: "thinking_delta", delta: String(delta.delta ?? "") }];
      }
      if (delta.type !== "text_delta") return [];

      const prefix = this.segmentCompletedText && !this.currentMessageText
        ? "\n\n"
        : "";
      const text = String(delta.delta ?? "");
      this.currentMessageText += text;
      return [{ type: "text_delta", delta: prefix + text }];
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const projected: SessionEvent[] = [];
      const message = record(event.message);
      this.finalErrorMessage = message?.stopReason === "error"
        ? (typeof message.errorMessage === "string" && message.errorMessage) || "Agent run failed"
        : undefined;
      this.finalAborted = message?.stopReason === "aborted";
      const finalMessageText = projectAssistantText(event.message);
      const streamedSegmentText = joinMessageText(
        this.segmentCompletedText,
        this.currentMessageText,
      );
      const finalSegmentText = joinMessageText(
        this.segmentCompletedText,
        finalMessageText,
      );

      if (finalSegmentText !== streamedSegmentText) {
        projected.push({ type: "text_replaced", text: finalSegmentText });
      }
      this.segmentCompletedText = finalSegmentText;
      this.runCompletedText = joinMessageText(
        this.runCompletedText,
        finalMessageText,
      );
      this.currentMessageText = "";

      const usage = projectUsage(event.message.usage);
      if (usage) projected.push({ type: "usage", usage });
      return projected;
    }

    if (event.type === "tool_execution_start") {
      return [{
        type: "tool_started",
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        args: toWireValue(event.args),
      }];
    }

    if (event.type === "tool_execution_update") {
      return [{
        type: "tool_updated",
        toolCallId: String(event.toolCallId),
        result: toWireValue(event.partialResult),
      }];
    }

    if (event.type === "tool_execution_end") {
      return [{
        type: "tool_finished",
        toolCallId: String(event.toolCallId),
        result: toWireValue(event.result),
        isError: event.isError,
      }];
    }

    return [];
  }
}
