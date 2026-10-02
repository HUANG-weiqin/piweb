import {
  CURRENT_SESSION_VERSION,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { LoopList } from "../shared/protocol.js";
import {
  aggregateReservedConversationEntries,
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMeta,
  type MessageDeliveryReceipt,
  type MetaOperation,
  type RunSettlement,
} from "./conversation-meta.js";

const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "usage",
  "compaction",
  "branch_summary",
  "context_edit",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const ASSISTANT_STOP_REASONS = new Set([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
]);
const USER_CONTENT_TYPES = new Set(["text", "image"]);
const ASSISTANT_CONTENT_TYPES = new Set(["text", "thinking", "toolCall"]);

type UnknownRecord = Record<string, unknown>;

export interface PiSessionFileInspection {
  conversationId: string;
  conversationMeta?: ConversationMeta;
  cards: ConversationCard[];
  deliveredMessageIds: string[];
  messageDeliveryReceipts: MessageDeliveryReceipt[];
  runSettlements: RunSettlement[];
  metaOperations: MetaOperation[];
  loopList?: LoopList & { updatedAt: string };
  lastActivityAt: string;
}

export type ReadonlySessionEntry = Readonly<SessionEntry>;

export interface PiSessionFilePresentationInspection
  extends PiSessionFileInspection {
  /** Newly parsed and validated physical entries. */
  entries: readonly ReadonlySessionEntry[];
}

export interface ReadonlySessionEntriesAdapter {
  getEntries(): readonly ReadonlySessionEntry[];
  getBranch(): readonly ReadonlySessionEntry[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requireString(
  record: UnknownRecord,
  field: string,
  allowEmpty = false,
): string {
  const value = record[field];
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
  ) {
    throw new Error(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function requireBoolean(record: UnknownRecord, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requireFiniteNumber(record: UnknownRecord, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function assertOptionalString(record: UnknownRecord, field: string): void {
  if (record[field] !== undefined && typeof record[field] !== "string") {
    throw new Error(`${field} must be a string when present`);
  }
}

function assertOptionalBoolean(record: UnknownRecord, field: string): void {
  if (record[field] !== undefined && typeof record[field] !== "boolean") {
    throw new Error(`${field} must be a boolean when present`);
  }
}

function assertOptionalFiniteNumber(
  record: UnknownRecord,
  field: string,
): void {
  if (
    record[field] !== undefined
    && (
      typeof record[field] !== "number"
      || !Number.isFinite(record[field])
    )
  ) {
    throw new Error(`${field} must be a finite number when present`);
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function assertAllowedFields(
  record: UnknownRecord,
  allowedFields: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is unsupported`);
  }
}

function assertContentBlocks(
  value: unknown,
  field: string,
  allowedTypes: ReadonlySet<string>,
): void {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const blockField = `${field}[${index}]`;
    const block = requireRecord(value[index], blockField);
    const type = requireString(block, "type");
    if (!allowedTypes.has(type)) {
      throw new Error(`${blockField} has unsupported type ${type}`);
    }
    if (type === "text") {
      assertAllowedFields(block, ["type", "text", "textSignature"], blockField);
      requireString(block, "text", true);
      assertOptionalString(block, "textSignature");
    } else if (type === "image") {
      assertAllowedFields(block, ["type", "data", "mimeType"], blockField);
      requireString(block, "data", true);
      requireString(block, "mimeType");
    } else if (type === "thinking") {
      assertAllowedFields(
        block,
        ["type", "thinking", "thinkingSignature", "redacted"],
        blockField,
      );
      requireString(block, "thinking", true);
      assertOptionalString(block, "thinkingSignature");
      assertOptionalBoolean(block, "redacted");
    } else {
      assertAllowedFields(
        block,
        ["type", "id", "name", "arguments", "thoughtSignature", "namespace"],
        blockField,
      );
      requireString(block, "id");
      requireString(block, "name");
      requireRecord(block.arguments, `${blockField}.arguments`);
      assertOptionalString(block, "thoughtSignature");
      assertOptionalString(block, "namespace");
    }
  }
}

function assertUserLikeContent(value: unknown, field: string): void {
  if (typeof value === "string") return;
  assertContentBlocks(value, field, USER_CONTENT_TYPES);
}

function assertUsage(value: unknown, field: string): void {
  const usage = requireRecord(value, field);
  assertAllowedFields(
    usage,
    [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cacheWrite1h",
      "reasoning",
      "totalTokens",
      "cost",
    ],
    field,
  );
  for (const name of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ]) {
    requireFiniteNumber(usage, name);
  }
  assertOptionalFiniteNumber(usage, "cacheWrite1h");
  assertOptionalFiniteNumber(usage, "reasoning");
  const cost = requireRecord(usage.cost, `${field}.cost`);
  assertAllowedFields(
    cost,
    ["input", "output", "cacheRead", "cacheWrite", "total"],
    `${field}.cost`,
  );
  for (const name of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    requireFiniteNumber(cost, name);
  }
}

function assertOptionalUsage(record: UnknownRecord, field: string): void {
  if (record[field] !== undefined) assertUsage(record[field], field);
}

function assertTool(value: unknown, field: string): void {
  const tool = requireRecord(value, field);
  assertAllowedFields(
    tool,
    ["name", "description", "parameters", "constrainedSampling"],
    field,
  );
  requireString(tool, "name");
  requireString(tool, "description", true);
  requireRecord(tool.parameters, `${field}.parameters`);

  const sampling = tool.constrainedSampling;
  if (sampling === undefined || sampling === false) return;
  const samplingRecord = requireRecord(sampling, `${field}.constrainedSampling`);
  const samplingType = requireString(samplingRecord, "type");
  if (samplingType === "json_schema") {
    assertAllowedFields(
      samplingRecord,
      ["type", "strict"],
      `${field}.constrainedSampling`,
    );
    const strict = requireString(samplingRecord, "strict");
    if (strict !== "prefer" && strict !== "require") {
      throw new Error(`${field}.constrainedSampling.strict is unsupported`);
    }
    return;
  }
  if (samplingType === "grammar") {
    assertAllowedFields(
      samplingRecord,
      ["type", "variants"],
      `${field}.constrainedSampling`,
    );
    const variants = requireRecord(
      samplingRecord.variants,
      `${field}.constrainedSampling.variants`,
    );
    assertAllowedFields(
      variants,
      ["openai_lark", "openai_regex"],
      `${field}.constrainedSampling.variants`,
    );
    for (const variant of Object.keys(variants)) {
      requireString(variants, variant, true);
    }
    return;
  }
  throw new Error(`${field}.constrainedSampling.type is unsupported: ${samplingType}`);
}

function assertSystemMessage(value: unknown, field: string): void {
  const message = requireRecord(value, field);
  assertAllowedFields(
    message,
    ["role", "content", "sections", "toolsAdded", "toolsRemoved", "timestamp"],
    field,
  );
  if (requireString(message, "role") !== "system") {
    throw new Error(`${field}.role must be system`);
  }
  if (typeof message.content !== "string") {
    assertContentBlocks(message.content, `${field}.content`, new Set(["text"]));
  }
  requireFiniteNumber(message, "timestamp");
  if (message.sections !== undefined) {
    const sections = requireRecord(message.sections, `${field}.sections`);
    for (const [name, content] of Object.entries(sections)) {
      if (content !== null && typeof content !== "string") {
        throw new Error(`${field}.sections.${name} must be a string or null`);
      }
    }
  }
  if (message.toolsAdded !== undefined) {
    if (!Array.isArray(message.toolsAdded)) {
      throw new Error(`${field}.toolsAdded must be an array`);
    }
    message.toolsAdded.forEach((tool, index) => {
      assertTool(tool, `${field}.toolsAdded[${index}]`);
    });
  }
  if (message.toolsRemoved !== undefined) {
    if (!Array.isArray(message.toolsRemoved)) {
      throw new Error(`${field}.toolsRemoved must be an array`);
    }
    message.toolsRemoved.forEach((value, index) => {
      const tool = requireRecord(value, `${field}.toolsRemoved[${index}]`);
      assertAllowedFields(tool, ["name"], `${field}.toolsRemoved[${index}]`);
      requireString(tool, "name");
    });
  }
}

function assertDiagnostic(value: unknown, field: string): void {
  const diagnostic = requireRecord(value, field);
  assertAllowedFields(
    diagnostic,
    ["type", "timestamp", "error", "details"],
    field,
  );
  requireString(diagnostic, "type");
  requireFiniteNumber(diagnostic, "timestamp");
  if (diagnostic.error !== undefined) {
    const error = requireRecord(diagnostic.error, `${field}.error`);
    assertAllowedFields(
      error,
      ["name", "message", "stack", "code"],
      `${field}.error`,
    );
    assertOptionalString(error, "name");
    requireString(error, "message", true);
    assertOptionalString(error, "stack");
    if (
      error.code !== undefined
      && typeof error.code !== "string"
      && typeof error.code !== "number"
    ) {
      throw new Error(`${field}.error.code must be a string or number`);
    }
  }
  if (diagnostic.details !== undefined) {
    requireRecord(diagnostic.details, `${field}.details`);
  }
}

function assertNestedCalls(value: unknown, field: string): void {
  const nested = requireRecord(value, field);
  assertAllowedFields(nested, ["calls", "complete"], field);
  requireBoolean(nested, "complete");
  if (!Array.isArray(nested.calls)) {
    throw new Error(`${field}.calls must be an array`);
  }
  nested.calls.forEach((value, index) => {
    const callField = `${field}.calls[${index}]`;
    const call = requireRecord(value, callField);
    assertAllowedFields(
      call,
      ["id", "name", "arguments", "argumentsBytes", "status", "durationMs", "error"],
      callField,
    );
    requireString(call, "id");
    requireString(call, "name");
    if (call.arguments !== undefined) {
      requireRecord(call.arguments, `${callField}.arguments`);
    }
    assertOptionalFiniteNumber(call, "argumentsBytes");
    const status = requireString(call, "status");
    if (status !== "ok" && status !== "error" && status !== "unfinished") {
      throw new Error(`${callField}.status is unsupported: ${status}`);
    }
    assertOptionalFiniteNumber(call, "durationMs");
    assertOptionalString(call, "error");
  });
}

function assertMessage(value: unknown): void {
  const message = requireRecord(value, "message");
  const role = requireString(message, "role");
  assertOptionalFiniteNumber(message, "timestamp");

  if (role === "system") {
    assertSystemMessage(message, "message");
    return;
  }
  if (role === "user") {
    assertAllowedFields(message, ["role", "content", "timestamp"], "message");
    assertUserLikeContent(message.content, "message.content");
    return;
  }
  if (role === "assistant") {
    assertAllowedFields(
      message,
      [
        "role",
        "content",
        "api",
        "provider",
        "model",
        "responseModel",
        "responseId",
        "providerThinkingLevel",
        "thinkingLevel",
        "diagnostics",
        "usage",
        "stopReason",
        "deferred",
        "errorMessage",
        "rawStopReason",
        "endTurn",
        "timestamp",
      ],
      "message",
    );
    assertContentBlocks(
      message.content,
      "message.content",
      ASSISTANT_CONTENT_TYPES,
    );
    requireString(message, "api");
    requireString(message, "provider");
    requireString(message, "model");
    assertUsage(message.usage, "message.usage");
    const stopReason = requireString(message, "stopReason");
    if (!ASSISTANT_STOP_REASONS.has(stopReason)) {
      throw new Error(`message.stopReason is unsupported: ${stopReason}`);
    }
    assertOptionalString(message, "responseModel");
    assertOptionalString(message, "responseId");
    assertOptionalString(message, "providerThinkingLevel");
    assertOptionalString(message, "thinkingLevel");
    assertOptionalString(message, "errorMessage");
    assertOptionalString(message, "rawStopReason");
    assertOptionalBoolean(message, "endTurn");
    if (message.diagnostics !== undefined) {
      if (!Array.isArray(message.diagnostics)) {
        throw new Error("message.diagnostics must be an array");
      }
      message.diagnostics.forEach((diagnostic, index) => {
        assertDiagnostic(diagnostic, `message.diagnostics[${index}]`);
      });
    }
    if (message.deferred !== undefined) {
      const deferred = requireRecord(message.deferred, "message.deferred");
      assertAllowedFields(
        deferred,
        ["provider", "modelId", "api", "id", "expiresAt", "pollAfterMs", "data"],
        "message.deferred",
      );
      for (const field of ["provider", "modelId", "api", "id"]) {
        requireString(deferred, field);
      }
      assertOptionalFiniteNumber(deferred, "expiresAt");
      assertOptionalFiniteNumber(deferred, "pollAfterMs");
    }
    return;
  }
  if (role === "toolResult") {
    assertAllowedFields(
      message,
      ["role", "toolCallId", "toolName", "content", "details", "usage", "nestedCalls", "isError", "timestamp", "addedToolNames"],
      "message",
    );
    requireString(message, "toolCallId");
    requireString(message, "toolName");
    assertContentBlocks(
      message.content,
      "message.content",
      USER_CONTENT_TYPES,
    );
    requireBoolean(message, "isError");
    if (message.addedToolNames !== undefined) {
      assertStringArray(message.addedToolNames, "message.addedToolNames");
    }
    assertOptionalUsage(message, "usage");
    if (message.nestedCalls !== undefined) {
      assertNestedCalls(message.nestedCalls, "message.nestedCalls");
    }
    return;
  }
  if (role === "bashExecution") {
    assertAllowedFields(
      message,
      ["role", "command", "output", "exitCode", "cancelled", "truncated", "fullOutputPath", "excludeFromContext", "timestamp"],
      "message",
    );
    requireString(message, "command", true);
    requireString(message, "output", true);
    assertOptionalFiniteNumber(message, "exitCode");
    requireBoolean(message, "cancelled");
    requireBoolean(message, "truncated");
    assertOptionalString(message, "fullOutputPath");
    assertOptionalBoolean(message, "excludeFromContext");
    return;
  }
  if (role === "custom") {
    assertAllowedFields(
      message,
      ["role", "customType", "content", "display", "details", "timestamp"],
      "message",
    );
    requireString(message, "customType");
    assertUserLikeContent(message.content, "message.content");
    requireBoolean(message, "display");
    return;
  }
  throw new Error(`message.role is unsupported: ${role}`);
}

function isAncestor(
  targetId: string,
  parentId: string | null,
  parentsById: ReadonlyMap<string, string | null>,
): boolean {
  let ancestorId = parentId;
  while (ancestorId !== null) {
    if (ancestorId === targetId) return true;
    ancestorId = parentsById.get(ancestorId) ?? null;
  }
  return false;
}

function assertEntryFields(entry: UnknownRecord, fields: readonly string[]): void {
  assertAllowedFields(
    entry,
    ["type", "id", "parentId", "timestamp", ...fields],
    "entry",
  );
}

function assertKnownEntry(
  value: unknown,
  parentsById: Map<string, string | null>,
  entriesById: Map<string, UnknownRecord>,
): void {
  const entry = requireRecord(value, "entry");
  const type = requireString(entry, "type");
  if (!ENTRY_TYPES.has(type)) {
    throw new Error(`entry.type is unsupported: ${type}`);
  }

  const id = requireString(entry, "id");
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("entry.id is invalid");
  if (parentsById.has(id)) throw new Error(`entry.id is duplicated: ${id}`);

  const parentId = entry.parentId;
  if (
    parentId !== null
    && (
      typeof parentId !== "string"
      || !SESSION_ID_PATTERN.test(parentId)
      || !parentsById.has(parentId)
    )
  ) {
    throw new Error(`entry.parentId does not reference an earlier entry: ${String(parentId)}`);
  }
  if (!isCanonicalIsoDate(entry.timestamp)) {
    throw new Error("entry.timestamp must be a canonical ISO timestamp");
  }

  if (type === "message") {
    assertEntryFields(entry, ["message"]);
    assertMessage(entry.message);
  } else if (type === "thinking_level_change") {
    assertEntryFields(entry, ["thinkingLevel"]);
    requireString(entry, "thinkingLevel");
  } else if (type === "model_change") {
    assertEntryFields(entry, ["provider", "modelId"]);
    requireString(entry, "provider");
    requireString(entry, "modelId");
  } else if (type === "usage") {
    assertEntryFields(entry, ["kind", "provider", "model", "usage", "note"]);
    requireString(entry, "kind");
    requireString(entry, "provider");
    requireString(entry, "model");
    assertUsage(entry.usage, "entry.usage");
    assertOptionalString(entry, "note");
  } else if (type === "compaction") {
    assertEntryFields(entry, ["summary", "firstKeptEntryId", "tokensBefore", "details", "usage", "fromHook", "systemMessage"]);
    requireString(entry, "summary", true);
    const firstKeptEntryId = requireString(entry, "firstKeptEntryId");
    if (
      firstKeptEntryId !== id
      && !isAncestor(firstKeptEntryId, parentId, parentsById)
    ) {
      throw new Error(
        "firstKeptEntryId is not an ancestor of the compacted branch",
      );
    }
    if (requireFiniteNumber(entry, "tokensBefore") < 0) {
      throw new Error("tokensBefore must be non-negative");
    }
    assertOptionalBoolean(entry, "fromHook");
    assertOptionalUsage(entry, "usage");
    if (entry.systemMessage !== undefined) {
      assertSystemMessage(entry.systemMessage, "entry.systemMessage");
    }
  } else if (type === "branch_summary") {
    assertEntryFields(entry, ["fromId", "summary", "details", "usage", "fromHook"]);
    const fromId = requireString(entry, "fromId");
    if (
      !parentsById.has(fromId)
      && !(fromId === "root" && parentId === null)
    ) {
      throw new Error("fromId does not reference an earlier entry");
    }
    requireString(entry, "summary", true);
    assertOptionalBoolean(entry, "fromHook");
    assertOptionalUsage(entry, "usage");
  } else if (type === "context_edit") {
    assertEntryFields(entry, ["targetId", "replacement"]);
    const targetId = requireString(entry, "targetId");
    const target = entriesById.get(targetId);
    if (target === undefined || !isAncestor(targetId, parentId, parentsById)) {
      throw new Error("context_edit.targetId must be on the active ancestor path");
    }
    let targetRole: "user" | "assistant" | "toolResult" | "custom";
    if (target.type === "custom_message") {
      targetRole = "custom";
    } else if (target.type === "message" && isRecord(target.message)) {
      const role = target.message.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") {
        throw new Error("context_edit.targetId does not reference an editable message");
      }
      targetRole = role;
    } else {
      throw new Error("context_edit.targetId does not reference an editable message");
    }
    if (entry.replacement !== null) {
      const replacement = requireRecord(entry.replacement, "entry.replacement");
      assertAllowedFields(replacement, ["content"], "entry.replacement");
      if (!("content" in replacement)) {
        throw new Error("entry.replacement.content is required");
      }
      if (targetRole === "assistant") {
        assertContentBlocks(replacement.content, "entry.replacement.content", ASSISTANT_CONTENT_TYPES);
      } else if (targetRole === "toolResult") {
        assertContentBlocks(replacement.content, "entry.replacement.content", USER_CONTENT_TYPES);
      } else {
        assertUserLikeContent(replacement.content, "entry.replacement.content");
      }
    }
  } else if (type === "custom") {
    assertEntryFields(entry, ["customType", "data"]);
    requireString(entry, "customType");
  } else if (type === "custom_message") {
    assertEntryFields(entry, ["customType", "content", "details", "display"]);
    requireString(entry, "customType");
    assertUserLikeContent(entry.content, "content");
    requireBoolean(entry, "display");
  } else if (type === "label") {
    assertEntryFields(entry, ["targetId", "label"]);
    const targetId = requireString(entry, "targetId");
    if (!parentsById.has(targetId)) {
      throw new Error("targetId does not reference an earlier entry");
    }
    assertOptionalString(entry, "label");
  } else {
    assertEntryFields(entry, ["name"]);
    assertOptionalString(entry, "name");
  }

  parentsById.set(id, parentId);
  entriesById.set(id, entry);
}

function assertFiniteJsonNumbers(
  value: unknown,
  sessionPath: string,
  line: number,
): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(
          `Session file has a non-finite JSON number on line ${line}: ${sessionPath}`,
        );
      }
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push(item);
    }
  }
}

function inspectPiSessionFileInternal(
  raw: string,
  sessionPath: string,
  expectedConversationId: string | undefined,
  includeEntries: false,
): PiSessionFileInspection;
function inspectPiSessionFileInternal(
  raw: string,
  sessionPath: string,
  expectedConversationId: string | undefined,
  includeEntries: true,
): PiSessionFilePresentationInspection;
function inspectPiSessionFileInternal(
  raw: string,
  sessionPath: string,
  expectedConversationId: string | undefined,
  includeEntries: boolean,
): PiSessionFileInspection | PiSessionFilePresentationInspection {
  if (raw.trim().length === 0) {
    throw new Error(`Session file is empty: ${sessionPath}`);
  }
  if (!raw.endsWith("\n")) {
    throw new Error(`Session file must end with a newline: ${sessionPath}`);
  }

  const values: unknown[] = [];
  const lineNumbers: number[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      if (index === 0) {
        throw new Error(`Session file has an invalid header: ${sessionPath}`);
      }
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Session file has invalid JSON on line ${index + 1}: ${sessionPath}`,
        { cause: error },
      );
    }
    assertFiniteJsonNumbers(value, sessionPath, index + 1);
    values.push(value);
    lineNumbers.push(index + 1);
  }

  const header = values[0];
  if (!isRecord(header) || header.type !== "session") {
    throw new Error(`Session file has an invalid header: ${sessionPath}`);
  }
  assertAllowedFields(
    header,
    ["type", "version", "id", "timestamp", "cwd", "parentSession"],
    "session header",
  );
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new Error(
      `Session file has an unsupported header version: ${sessionPath}`,
    );
  }
  if (
    typeof header.id !== "string"
    || !SESSION_ID_PATTERN.test(header.id)
  ) {
    throw new Error(`Session file has an invalid header identity: ${sessionPath}`);
  }
  if (
    expectedConversationId !== undefined
    && header.id !== expectedConversationId
  ) {
    throw new Error(
      `Session file identity does not match conversation ${expectedConversationId}: ${sessionPath}`,
    );
  }
  if (!isCanonicalIsoDate(header.timestamp)) {
    throw new Error(
      `Session file has an invalid header timestamp: ${sessionPath}`,
    );
  }
  if (header.cwd !== undefined && typeof header.cwd !== "string") {
    throw new Error(`Session file has an invalid header cwd: ${sessionPath}`);
  }
  if (
    header.parentSession !== undefined
    && (
      typeof header.parentSession !== "string"
      || header.parentSession.length === 0
    )
  ) {
    throw new Error(
      `Session file has an invalid parent session: ${sessionPath}`,
    );
  }

  const parentsById = new Map<string, string | null>();
  const entriesById = new Map<string, UnknownRecord>();
  for (let index = 1; index < values.length; index += 1) {
    try {
      assertKnownEntry(values[index], parentsById, entriesById);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Session file has an invalid session entry on line ${lineNumbers[index]}: ${detail}: ${sessionPath}`,
        { cause: error },
      );
    }
  }

  let reserved;
  try {
    const loopListByEntryId = new Map<
      string,
      (LoopList & { updatedAt: string }) | undefined
    >();
    const continuationsByEntryId = new Map<
      string,
      ReadonlyMap<string, number>
    >();
    const noContinuations: ReadonlyMap<string, number> = new Map();
    for (let index = 1; index < values.length; index += 1) {
      const rawEntry = values[index] as UnknownRecord;
      const parentId = rawEntry.parentId as string | null;
      let loopList = parentId === null
        ? undefined
        : loopListByEntryId.get(parentId);
      let continuations = parentId === null
        ? noContinuations
        : continuationsByEntryId.get(parentId)!;
      const entry = parseReservedConversationEntry(rawEntry);
      if (
        entry?.kind === "conversation_card"
        && entry.entry.data.fromSnapshot.conversationId !== header.id
      ) {
        throw new Error(
          "Piweb conversation card source must be the current conversation",
        );
      }
      if (
        entry?.kind === "conversation_message"
        && entry.entry.details.toSnapshot.conversationId !== header.id
      ) {
        throw new Error(
          "Piweb conversation message target must be the current conversation",
        );
      }
      if (
        entry?.kind === "message_delivery_receipt"
        && entry.entry.data.toConversationId !== header.id
      ) {
        throw new Error(
          "Piweb message delivery receipt target must be the current conversation",
        );
      }
      if (entry?.kind === "loop_list") {
        loopList = entry.entry.data;
      }
      if (entry?.kind === "loop_list_continue") {
        const { items, runId, continuation } = entry.entry.details;
        if (loopList === undefined) {
          throw new Error(
            "Piweb LoopList continuation requires an ancestor LoopList",
          );
        }
        if (JSON.stringify(items) !== JSON.stringify(loopList.items)) {
          throw new Error(
            "Piweb LoopList continuation item snapshot must match the latest ancestor LoopList",
          );
        }
        if (
          !loopList.armed
          || !loopList.items.some((item) => item.status !== "completed")
        ) {
          throw new Error(
            "Piweb LoopList continuation requires an armed ancestor LoopList with unfinished work",
          );
        }
        const expectedContinuation = (continuations.get(runId) ?? 0) + 1;
        if (continuation !== expectedContinuation) {
          throw new Error(
            `Piweb LoopList continuation must be ${expectedContinuation} for runId ${runId} on its branch`,
          );
        }
        continuations = new Map(continuations).set(runId, continuation);
      }
      const entryId = rawEntry.id as string;
      loopListByEntryId.set(entryId, loopList);
      continuationsByEntryId.set(entryId, continuations);
    }
    // The session header is not a reserved custom entry, so passing the owned
    // parsed array avoids allocating an entries copy on metadata-only reads.
    reserved = aggregateReservedConversationEntries(values);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Session file has an invalid piweb reserved entry: ${detail}: ${sessionPath}`,
      { cause: error },
    );
  }

  let lastActivityAt = header.timestamp;
  for (let index = 1; index < values.length; index += 1) {
    const entry = values[index] as UnknownRecord;
    const entryTimestamp = entry.timestamp as string;
    if (Date.parse(entryTimestamp) > Date.parse(lastActivityAt)) {
      lastActivityAt = entryTimestamp;
    }
  }

  const inspection: PiSessionFileInspection = {
    conversationId: header.id,
    ...reserved,
    lastActivityAt,
  };
  if (!includeEntries) return inspection;
  return {
    ...inspection,
    entries: values.slice(1) as ReadonlySessionEntry[],
  };
}

export function inspectPiSessionFile(
  raw: string,
  sessionPath: string,
  expectedConversationId?: string,
): PiSessionFileInspection {
  return inspectPiSessionFileInternal(
    raw,
    sessionPath,
    expectedConversationId,
    false,
  );
}

export function inspectPiSessionFilePresentation(
  raw: string,
  sessionPath: string,
  expectedConversationId?: string,
): PiSessionFilePresentationInspection {
  return inspectPiSessionFileInternal(
    raw,
    sessionPath,
    expectedConversationId,
    true,
  );
}

/**
 * Adapts validated physical entries to the read methods used by the canonical
 * history projector. The active branch follows the final physical leaf through
 * parentId links; no writable SessionManager is created.
 */
export function createReadonlySessionEntriesAdapter(
  sourceEntries: readonly ReadonlySessionEntry[],
): ReadonlySessionEntriesAdapter {
  const entries = [...sourceEntries];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const reverseBranch: ReadonlySessionEntry[] = [];
  let entry = entries.at(-1);
  while (entry !== undefined) {
    reverseBranch.push(entry);
    entry = entry.parentId === null
      ? undefined
      : entriesById.get(entry.parentId);
  }
  const branch = reverseBranch.reverse();
  return {
    getEntries: () => [...entries],
    getBranch: () => [...branch],
  };
}

export function validatePiSessionFile(
  raw: string,
  sessionPath: string,
  expectedConversationId?: string,
): string {
  return inspectPiSessionFile(
    raw,
    sessionPath,
    expectedConversationId,
  ).conversationId;
}
