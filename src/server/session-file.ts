import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { LoopList } from "../shared/protocol.js";
import {
  aggregateReservedConversationEntries,
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMeta,
  type MetaOperation,
  type PendingPromptBatch,
  type PendingPromptDelivery,
  type RunSettlement,
} from "./conversation-meta.js";

const SESSION_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ENTRY_TYPES = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const ASSISTANT_STOP_REASONS = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);
const USER_CONTENT_TYPES = new Set(["text", "image"]);
const ASSISTANT_CONTENT_TYPES = new Set(["text", "thinking", "toolCall"]);

type UnknownRecord = Record<string, unknown>;

export interface PiSessionFileInspection {
  conversationId: string;
  conversationMeta?: ConversationMeta;
  cards: ConversationCard[];
  deliveredMessageIds: string[];
  runSettlements: RunSettlement[];
  pendingPromptDeliveries: PendingPromptDelivery[];
  pendingPromptBatches: PendingPromptBatch[];
  metaOperations: MetaOperation[];
  loopList?: LoopList & { updatedAt: string };
  lastActivityAt: string;
}

export type ReadonlySessionEntry = Readonly<SessionEntry>;

export interface PiSessionFilePresentationInspection
  extends PiSessionFileInspection {
  /** Newly parsed, migrated, and validated physical entries. */
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

function assertContentBlocks(
  value: unknown,
  field: string,
  allowedTypes: ReadonlySet<string>,
): void {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const block = requireRecord(value[index], `${field}[${index}]`);
    const type = requireString(block, "type");
    if (!allowedTypes.has(type)) {
      throw new Error(`${field}[${index}] has unsupported type ${type}`);
    }
    if (type === "text") {
      requireString(block, "text", true);
      assertOptionalString(block, "textSignature");
    } else if (type === "image") {
      requireString(block, "data", true);
      requireString(block, "mimeType");
    } else if (type === "thinking") {
      requireString(block, "thinking", true);
      assertOptionalString(block, "thinkingSignature");
      assertOptionalBoolean(block, "redacted");
    } else {
      requireString(block, "id");
      requireString(block, "name");
      requireRecord(block.arguments, "arguments");
      assertOptionalString(block, "thoughtSignature");
    }
  }
}

function assertUserLikeContent(value: unknown, field: string): void {
  if (typeof value === "string") return;
  assertContentBlocks(value, field, USER_CONTENT_TYPES);
}

function assertUsage(value: unknown): void {
  const usage = requireRecord(value, "message.usage");
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ]) {
    requireFiniteNumber(usage, field);
  }
  assertOptionalFiniteNumber(usage, "cacheWrite1h");
  assertOptionalFiniteNumber(usage, "reasoning");
  const cost = requireRecord(usage.cost, "message.usage.cost");
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ]) {
    requireFiniteNumber(cost, field);
  }
}

function assertMessage(value: unknown): void {
  const message = requireRecord(value, "message");
  const role = requireString(message, "role");
  assertOptionalFiniteNumber(message, "timestamp");

  if (role === "user") {
    assertUserLikeContent(message.content, "message.content");
    return;
  }
  if (role === "assistant") {
    assertContentBlocks(
      message.content,
      "message.content",
      ASSISTANT_CONTENT_TYPES,
    );
    requireString(message, "api");
    requireString(message, "provider");
    requireString(message, "model");
    assertUsage(message.usage);
    const stopReason = requireString(message, "stopReason");
    if (!ASSISTANT_STOP_REASONS.has(stopReason)) {
      throw new Error(`message.stopReason is unsupported: ${stopReason}`);
    }
    assertOptionalString(message, "responseModel");
    assertOptionalString(message, "responseId");
    assertOptionalString(message, "errorMessage");
    return;
  }
  if (role === "toolResult") {
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
    return;
  }
  if (role === "bashExecution") {
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
    requireString(message, "customType");
    assertUserLikeContent(message.content, "message.content");
    requireBoolean(message, "display");
    return;
  }
  throw new Error(`message.role is unsupported: ${role}`);
}

function assertKnownEntry(
  value: unknown,
  parentsById: Map<string, string | null>,
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
    assertMessage(entry.message);
  } else if (type === "thinking_level_change") {
    requireString(entry, "thinkingLevel");
  } else if (type === "model_change") {
    requireString(entry, "provider");
    requireString(entry, "modelId");
  } else if (type === "compaction") {
    requireString(entry, "summary", true);
    const firstKeptEntryId = requireString(entry, "firstKeptEntryId");
    let ancestorId = parentId;
    while (
      ancestorId !== null
      && ancestorId !== firstKeptEntryId
    ) {
      ancestorId = parentsById.get(ancestorId) ?? null;
    }
    if (ancestorId !== firstKeptEntryId) {
      throw new Error(
        "firstKeptEntryId is not an ancestor of the compacted branch",
      );
    }
    if (requireFiniteNumber(entry, "tokensBefore") < 0) {
      throw new Error("tokensBefore must be non-negative");
    }
    assertOptionalBoolean(entry, "fromHook");
  } else if (type === "branch_summary") {
    const fromId = requireString(entry, "fromId");
    if (
      !parentsById.has(fromId)
      && !(fromId === "root" && parentId === null)
    ) {
      throw new Error("fromId does not reference an earlier entry");
    }
    requireString(entry, "summary", true);
    assertOptionalBoolean(entry, "fromHook");
  } else if (type === "custom") {
    requireString(entry, "customType");
  } else if (type === "custom_message") {
    requireString(entry, "customType");
    assertUserLikeContent(entry.content, "content");
    requireBoolean(entry, "display");
  } else if (type === "label") {
    const targetId = requireString(entry, "targetId");
    if (!parentsById.has(targetId)) {
      throw new Error("targetId does not reference an earlier entry");
    }
    assertOptionalString(entry, "label");
  } else {
    assertOptionalString(entry, "name");
  }

  parentsById.set(id, parentId);
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
  if (
    header.version !== undefined
    && (
      !Number.isInteger(header.version)
      || (header.version as number) < 1
      || (header.version as number) > CURRENT_SESSION_VERSION
    )
  ) {
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

  try {
    migrateSessionEntries(values as FileEntry[]);
  } catch (error) {
    throw new Error(
      `Session file has an invalid session entry: ${sessionPath}`,
      { cause: error },
    );
  }

  const parentsById = new Map<string, string | null>();
  for (let index = 1; index < values.length; index += 1) {
    try {
      assertKnownEntry(values[index], parentsById);
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
    for (let index = 1; index < values.length; index += 1) {
      const entry = parseReservedConversationEntry(values[index]);
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
        entry?.kind === "pending_prompt_batch"
        && entry.entry.data.conversationId !== header.id
      ) {
        throw new Error(
          "Piweb pending prompt batch conversation must be the current conversation",
        );
      }
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
  return inspectPiSessionFileInternal(
    raw,
    sessionPath,
    expectedConversationId,
    false,
  ).conversationId;
}
