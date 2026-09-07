import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ConversationHistoryItem,
  ConversationHistoryMessage,
  ConversationHistoryMessagePart,
  ConversationHistoryTool,
  ConversationMessageCard,
  ConversationWindowCoverage,
  TokenUsage,
} from "../shared/protocol.js";
import {
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMessageEntry,
} from "./conversation-meta.js";
import { projectDefaultCompactionProvenance } from "./compaction-provenance.js";
import { toWireValue } from "./session-events.js";

export const MAX_HISTORY_SNAPSHOT_BYTES = 750_000;
export const MAX_AGENT_PEEK_BYTES = 256 * 1024;
export const MAX_AGENT_PEEK_ITEMS = 20;
const MAX_HISTORY_TEXT_BYTES = 80_000;
const MAX_HISTORY_TOOL_VALUE_BYTES = 8_000;
// The work-process timeline is intentionally bounded to the newest entries.
// The UI renders this suffix newest-first, so older activity never displaces
// the currently useful work from the history snapshot.
const MAX_HISTORY_PARTS_PER_MESSAGE = 16;
const MAX_HISTORY_ID_BYTES = 500;
const OMITTED_TOOL_VALUE = "[历史工具数据过大，已省略]";

export interface ReadonlySessionBranchSource {
  getBranch(): readonly Readonly<SessionEntry>[];
}

export interface ReadonlySessionEntriesSource
  extends ReadonlySessionBranchSource {
  getEntries(): readonly Readonly<SessionEntry>[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    if (block?.type === "text" && typeof block.text === "string") return block.text;
    if (block?.type === "image") return "[图片]";
    return "";
  }).filter(Boolean).join("\n");
}

function appendParagraph(current: string, next: string): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

function projectUsage(value: unknown): TokenUsage | undefined {
  const usageRecord = record(value);
  if (!usageRecord) return;
  const usage: Record<string, unknown> = usageRecord;
  function finiteUsage(key: string): number {
    const item = usage[key];
    return typeof item === "number" && Number.isFinite(item) ? item : 0;
  }
  const input = finiteUsage("input");
  const output = finiteUsage("output");
  const cacheRead = finiteUsage("cacheRead");
  const cacheWrite = finiteUsage("cacheWrite");
  const total = finiteUsage("totalTokens") || input + output + cacheRead + cacheWrite;
  if (total <= 0) return;
  return { input, output, cacheRead, cacheWrite, total };
}

function addUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return current;
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + next.cacheWrite,
    total: (current?.total ?? 0) + next.total,
  };
}

function clipUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 3) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: `${value.slice(0, low)}…`, truncated: true };
}

function compactToolValue(value: unknown): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value, truncated: false };
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_HISTORY_TOOL_VALUE_BYTES) {
      return { value, truncated: false };
    }
  } catch {
    // The live projector already normalizes tool values; remain defensive.
  }
  return { value: OMITTED_TOOL_VALUE, truncated: true };
}

function editBudgetFact(value: unknown): unknown {
  return record(record(value)?.details)?.piwebEditBudget;
}

function omittedToolResult(value: unknown): unknown {
  const budget = editBudgetFact(value);
  if (budget === undefined) return OMITTED_TOOL_VALUE;
  const retained = {
    content: OMITTED_TOOL_VALUE,
    details: { piwebEditBudget: budget },
  };
  try {
    if (
      Buffer.byteLength(JSON.stringify(retained), "utf8")
      <= MAX_HISTORY_TOOL_VALUE_BYTES
    ) {
      return retained;
    }
  } catch {
    // Malformed historical details must not bypass the snapshot bound.
  }
  return OMITTED_TOOL_VALUE;
}

function compactToolResult(value: unknown): { value: unknown; truncated: boolean } {
  const compacted = compactToolValue(value);
  return compacted.truncated
    ? { value: omittedToolResult(value), truncated: true }
    : compacted;
}

function compactHistoryMessage(
  message: ConversationHistoryMessage,
): { message: ConversationHistoryMessage; truncated: boolean } {
  const id = clipUtf8(message.id, MAX_HISTORY_ID_BYTES);
  const text = clipUtf8(message.text, MAX_HISTORY_TEXT_BYTES);
  const thinking = clipUtf8(message.thinking, MAX_HISTORY_TEXT_BYTES);
  const selectedParts = message.parts.slice(-MAX_HISTORY_PARTS_PER_MESSAGE);
  const visibleToolIds = new Set(
    selectedParts
      .filter((part) => part.kind === "tool")
      .map((part) => part.toolCallId),
  );
  const retainedToolIds = new Set(visibleToolIds);
  const latestBudgetTool = [...message.tools].reverse().find(
    (tool) => tool.toolName === "request_edit_budget"
      || tool.toolName === "edit"
      || tool.toolName === "write",
  );
  if (latestBudgetTool) retainedToolIds.add(latestBudgetTool.toolCallId);
  const selectedTools = message.tools.filter(
    (tool) => retainedToolIds.has(tool.toolCallId),
  );
  let truncated = id.truncated
    || text.truncated
    || thinking.truncated
    || selectedTools.length !== message.tools.length
    || selectedParts.length !== message.parts.length;
  const compactedToolIds = new Map<string, string>();
  const tools = selectedTools.map((tool) => {
    const toolCallId = clipUtf8(tool.toolCallId, MAX_HISTORY_ID_BYTES);
    const toolName = clipUtf8(tool.toolName, MAX_HISTORY_ID_BYTES);
    const args = compactToolValue(tool.args);
    const result = compactToolResult(tool.result);
    const toolTruncated = toolCallId.truncated
      || toolName.truncated
      || args.truncated
      || result.truncated;
    if (toolTruncated) truncated = true;
    compactedToolIds.set(tool.toolCallId, toolCallId.value);
    return {
      toolCallId: toolCallId.value,
      toolName: toolName.value,
      ...(tool.args === undefined ? {} : { args: args.value }),
      ...(tool.result === undefined ? {} : { result: result.value }),
      status: tool.status,
    };
  });
  const compactedParts = selectedParts.flatMap((part): ConversationHistoryMessagePart[] => {
    if (part.kind === "tool") {
      const toolCallId = compactedToolIds.get(part.toolCallId);
      if (toolCallId === undefined) {
        truncated = true;
        return [];
      }
      return [{ kind: "tool", toolCallId }];
    }
    const aggregateLength = part.kind === "text"
      ? text.value.length
      : thinking.value.length;
    if (part.offset >= aggregateLength) {
      truncated = true;
      return [];
    }
    const length = Math.min(part.length, aggregateLength - part.offset);
    if (length <= 0) {
      truncated = true;
      return [];
    }
    if (length !== part.length) truncated = true;
    return [{ kind: part.kind, offset: part.offset, length }];
  });
  return {
    message: {
      ...message,
      id: id.value,
      text: text.value,
      thinking: thinking.value,
      tools,
      parts: compactedParts,
      usage: message.usage ? { ...message.usage } : undefined,
    },
    truncated,
  };
}

interface ConversationHistoryMessageSlot {
  message: ConversationHistoryMessage;
  anchorEntryId: string;
  sourceMessages: Array<{ entryId: string; message: unknown }>;
}

export interface ConversationHistoryItemSlot {
  item: ConversationHistoryItem;
  /** Exact physical Pi messages represented by this durable semantic slot. */
  sourceMessages?: ReadonlyArray<{ entryId: string; message: unknown }>;
}

/**
 * Projects the selected Pi session branch into replayable timeline segments.
 * Aggregate fields remain available for copy/token views, while `parts` records
 * the original assistant text/thinking/tool order without duplicating strings.
 */
function projectConversationHistorySlots(
  sessionManager: ReadonlySessionBranchSource,
): ConversationHistoryMessageSlot[] {
  const branch = sessionManager.getBranch();
  const messages: ConversationHistoryMessageSlot[] = [];
  let assistant: ConversationHistoryMessageSlot | undefined;
  let unsettledMessageStart = 0;
  const settledRunIds = new Set<string>();
  const seenCardIds = new Set<string>();

  const requireAssistant = (entryId: string): ConversationHistoryMessageSlot => {
    if (assistant === undefined) {
      assistant = {
        anchorEntryId: entryId,
        sourceMessages: [],
        message: {
          id: `assistant:${entryId}`,
          role: "assistant",
          text: "",
          thinking: "",
          tools: [],
          parts: [],
        },
      };
      messages.push(assistant);
    }
    return assistant;
  };

  for (const entry of branch) {
    if (entry.type === "compaction") {
      assistant = undefined;
      continue;
    }
    const reserved = parseReservedConversationEntry(entry);
    if (reserved?.kind === "run_settlement") {
      const runId = reserved.entry.data.runId;
      if (settledRunIds.has(runId)) continue;
      settledRunIds.add(runId);
      // Settlement is the durable run boundary. Backfill every message since
      // the previous boundary, including user guidance delivered mid-run.
      for (let index = unsettledMessageStart; index < messages.length; index += 1) {
        messages[index]!.message.runId = runId;
      }
      unsettledMessageStart = messages.length;
      assistant = undefined;
      continue;
    }
    if (reserved?.kind === "conversation_meta") {
      // Initial metadata establishes a durable conversation boundary.
      unsettledMessageStart = messages.length;
      assistant = undefined;
      continue;
    }
    if (reserved?.kind === "conversation_message") {
      assistant = undefined;
      seenCardIds.add(reserved.entry.details.cardId);
      continue;
    }
    if (reserved?.kind === "conversation_card") {
      const cardId = reserved.entry.data.cardId;
      if (!seenCardIds.has(cardId)) assistant = undefined;
      seenCardIds.add(cardId);
      continue;
    }
    if (entry.type === "custom" || entry.type === "custom_message") {
      continue;
    }
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (!message) continue;

    if (message.role === "user") {
      assistant = undefined;
      const text = contentText(message.content);
      messages.push({
        anchorEntryId: entry.id,
        sourceMessages: [{ entryId: entry.id, message: entry.message }],
        message: {
          id: entry.id,
          role: "user",
          text,
          thinking: "",
          tools: [],
          parts: text
            ? [{ kind: "text", offset: 0, length: text.length }]
            : [],
        },
      });
      continue;
    }

    if (message.role === "assistant") {
      const targetSlot = requireAssistant(entry.id);
      targetSlot.sourceMessages.push({ entryId: entry.id, message: entry.message });
      const target = targetSlot.message;
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          const block = record(item);
          if (
            block?.type === "text"
            && typeof block.text === "string"
            && block.text.length > 0
          ) {
            const offset = target.text
              ? target.text.length + 2
              : 0;
            target.text = appendParagraph(target.text, block.text);
            target.parts.push({
              kind: "text",
              offset,
              length: block.text.length,
            });
          } else if (
            block?.type === "thinking"
            && typeof block.thinking === "string"
            && block.thinking.length > 0
          ) {
            const offset = target.thinking
              ? target.thinking.length + 2
              : 0;
            target.thinking = appendParagraph(target.thinking, block.thinking);
            target.parts.push({
              kind: "thinking",
              offset,
              length: block.thinking.length,
            });
          } else if (
            block?.type === "toolCall"
            && typeof block.id === "string"
            && typeof block.name === "string"
          ) {
            target.tools.push({
              toolCallId: block.id,
              toolName: block.name,
              args: toWireValue(block.arguments),
              // A tool call without its result is still in flight (for example,
              // wait_for_session while the peer run is settling). Do not render
              // an unfinished call as a failure in a restored snapshot.
              status: "pending",
            });
            target.parts.push({ kind: "tool", toolCallId: block.id });
          }
        }
      }
      target.usage = addUsage(target.usage, projectUsage(message.usage));
      if (
        message.stopReason === "error"
        && typeof message.errorMessage === "string"
      ) {
        const offset = target.text ? target.text.length + 2 : 0;
        const failureText = `运行失败：${message.errorMessage}`;
        target.text = appendParagraph(target.text, `运行失败：${message.errorMessage}`);
        target.parts.push({
          kind: "text",
          offset,
          length: failureText.length,
        });
      } else if (message.stopReason === "aborted") {
        const offset = target.text ? target.text.length + 2 : 0;
        target.text = appendParagraph(target.text, "运行已中止。");
        target.parts.push({ kind: "text", offset, length: 6 });
      }
      continue;
    }

    if (
      message.role === "toolResult"
      && typeof message.toolCallId === "string"
    ) {
      let target = [...messages].reverse().find((item) =>
        item.message.role === "assistant"
        && item.message.tools.some((tool) => tool.toolCallId === message.toolCallId)
      )?.message;
      target ??= requireAssistant(entry.id).message;
      let tool = target.tools.find((item) => item.toolCallId === message.toolCallId);
      if (!tool) {
        tool = {
          toolCallId: message.toolCallId,
          toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
          status: "error",
        };
        target.tools.push(tool);
        target.parts.push({
          kind: "tool",
          toolCallId: message.toolCallId,
        });
      }
      tool.result = toWireValue({
        content: message.content,
        details: message.details,
      });
      tool.status = message.isError === true ? "error" : "done";
    }
  }

  return messages.map((slot) => ({
    ...slot,
    message: {
      ...slot.message,
      tools: slot.message.tools.map((tool): ConversationHistoryTool => ({ ...tool })),
      parts: slot.message.parts.map((part) => ({ ...part })),
      usage: slot.message.usage ? { ...slot.message.usage } : undefined,
    },
    sourceMessages: [...slot.sourceMessages],
  }));
}

export function projectConversationHistory(
  sessionManager: ReadonlySessionBranchSource,
): ConversationHistoryMessage[] {
  return projectConversationHistorySlots(sessionManager)
    .map((slot) => slot.message);
}

function projectOutgoingCard(
  card: ConversationCard,
  sentAt: string,
): ConversationMessageCard {
  return {
    kind: "session_message",
    id: `session-message:${card.cardId}`,
    cardId: card.cardId,
    direction: "outgoing",
    state: card.state,
    body: card.body,
    from: card.fromSnapshot,
    to: card.toSnapshot,
    sentAt,
    updatedAt: card.updatedAt,
    ...(card.messageId === undefined
      ? {}
      : { messageId: card.messageId }),
    ...(card.delegationId === undefined
      ? {}
      : { delegationId: card.delegationId }),
    ...(card.runId === undefined ? {} : { runId: card.runId }),
    ...(card.result === undefined ? {} : { result: card.result }),
  };
}

function projectIncomingCard(
  entry: ConversationMessageEntry,
): ConversationMessageCard {
  const message = entry.details;
  return {
    kind: "session_message",
    id: `session-message:${message.cardId}`,
    cardId: message.cardId,
    direction: "incoming",
    state: "delivered",
    body: message.body,
    from: message.fromSnapshot,
    to: message.toSnapshot,
    sentAt: message.sentAt,
    updatedAt: message.sentAt,
    messageId: message.messageId,
    ...(message.delegationId === undefined
      ? {}
      : { delegationId: message.delegationId }),
  };
}

/**
 * Projects the active conversational branch together with host-owned message
 * cards. Reserved records are scanned from every physical entry because card
 * state and delivery identity remain durable even when Pi changes branches.
 */
export function projectConversationItemSlots(
  sessionManager: ReadonlySessionEntriesSource,
): ConversationHistoryItemSlot[] {
  const physicalEntries = sessionManager.getEntries();
  const physicalIndexById = new Map(
    physicalEntries.map((entry, index) => [entry.id, index]),
  );
  const positionedItems: Array<{
    slot: ConversationHistoryItemSlot;
    physicalIndex: number;
  }> = projectConversationHistorySlots(sessionManager).map((messageSlot) => {
    const message = messageSlot.message;
    return {
      slot: {
        item: {
          kind: "message",
          ...message,
        },
        sourceMessages: messageSlot.sourceMessages,
      },
      physicalIndex:
        physicalIndexById.get(messageSlot.anchorEntryId) ?? Number.MAX_SAFE_INTEGER,
    };
  });
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "compaction") continue;
    const provenance = entry.fromHook === true
      ? { generator: "custom" as const }
      : projectDefaultCompactionProvenance(entry.details);
    positionedItems.push({
      slot: {
        item: {
          kind: "compaction",
          id: entry.id,
          timestamp: entry.timestamp,
          tokensBefore: entry.tokensBefore,
          ...(provenance === undefined ? {} : { provenance }),
        },
      },
      physicalIndex:
        physicalIndexById.get(entry.id) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  const cardsById = new Map<string, {
    positionedIndex: number;
    direction: ConversationMessageCard["direction"];
  }>();

  for (
    let physicalIndex = 0;
    physicalIndex < physicalEntries.length;
    physicalIndex += 1
  ) {
    const reserved = parseReservedConversationEntry(
      physicalEntries[physicalIndex],
    );
    if (reserved === undefined) continue;
    if (
      reserved.kind === "conversation_meta"
      || reserved.kind === "conversation_role_change"
      || reserved.kind === "run_settlement"
      || reserved.kind === "edit_budget"
      || reserved.kind === "wait_poll"
      || reserved.kind === "message_delivery_receipt"
      || reserved.kind === "meta_operation"
      || reserved.kind === "compaction_threshold"
      || reserved.kind === "service_tier"
      || reserved.kind === "compaction_resume"
      || reserved.kind === "loop_list"
      || reserved.kind === "loop_list_continue"
    ) {
      continue;
    }

    const cardId = reserved.kind === "conversation_card"
      ? reserved.entry.data.cardId
      : reserved.entry.details.cardId;
    const direction = reserved.kind === "conversation_card"
      ? "outgoing"
      : "incoming";
    const existing = cardsById.get(cardId);
    if (existing !== undefined && existing.direction !== direction) {
      throw new Error(
        `Piweb conversation card ${cardId} changes direction`,
      );
    }

    if (existing === undefined) {
      const item = reserved.kind === "conversation_card"
        ? projectOutgoingCard(
            reserved.entry.data,
            reserved.entry.data.updatedAt,
          )
        : projectIncomingCard(reserved.entry);
      cardsById.set(cardId, {
        positionedIndex: positionedItems.length,
        direction,
      });
      positionedItems.push({ slot: { item }, physicalIndex });
      continue;
    }

    const positioned = positionedItems[existing.positionedIndex]!;
    positioned.slot.item = reserved.kind === "conversation_card"
      ? projectOutgoingCard(
          reserved.entry.data,
          (positioned.slot.item as ConversationMessageCard).sentAt,
        )
      : projectIncomingCard(reserved.entry);
  }

  return positionedItems
    .sort((left, right) => left.physicalIndex - right.physicalIndex)
    .map(({ slot }) => slot);
}

export function projectConversationItems(
  sessionManager: ReadonlySessionEntriesSource,
): ConversationHistoryItem[] {
  return projectConversationItemSlots(sessionManager).map((slot) => slot.item);
}

function compactConversationItem(
  item: ConversationHistoryItem,
): { item: ConversationHistoryItem; truncated: boolean } {
  if (item.kind === "message") {
    const { kind: _kind, ...message } = item;
    const compacted = compactHistoryMessage(message);
    return {
      item: {
        kind: "message",
        ...compacted.message,
      },
      truncated: compacted.truncated,
    };
  }
  if (item.kind === "compaction") {
    const id = clipUtf8(item.id, MAX_HISTORY_ID_BYTES);
    return {
      item: { ...item, id: id.value },
      truncated: id.truncated,
    };
  }

  const body = clipUtf8(item.body, MAX_HISTORY_TEXT_BYTES);
  const result = item.result === undefined
    ? undefined
    : clipUtf8(item.result, MAX_HISTORY_TEXT_BYTES);
  return {
    item: {
      ...item,
      body: body.value,
      ...(result === undefined ? {} : { result: result.value }),
    },
    truncated: body.truncated || result?.truncated === true,
  };
}

export type AgentConversationPeekItem =
  | {
      kind: "message";
      role: "user" | "assistant";
      text: string;
    }
  | ConversationMessageCard;

function agentPeekItem(
  item: ConversationHistoryItem,
): AgentConversationPeekItem | undefined {
  if (item.kind === "message") {
    return {
      kind: "message",
      role: item.role,
      text: item.text,
    };
  }
  if (item.kind === "compaction") return;
  return { ...item };
}

function fitAgentPeekItem(
  source: AgentConversationPeekItem,
): { item: AgentConversationPeekItem; truncated: boolean; bytes: number } {
  let item = source;
  let bytes = jsonBytes({ items: [item], truncated: false });
  let truncated = false;
  while (bytes > MAX_AGENT_PEEK_BYTES) {
    truncated = true;
    if (item.kind === "message") {
      if (!item.text) break;
      item = { ...item, text: shortenPrefix(item.text) };
    } else {
      const field = jsonBytes(item.body) >= jsonBytes(item.result ?? "")
        ? "body"
        : "result";
      const value = field === "body" ? item.body : item.result ?? "";
      if (!value) break;
      item = field === "body"
        ? { ...item, body: shortenPrefix(value) }
        : { ...item, result: shortenPrefix(value) };
    }
    bytes = jsonBytes({ items: [item], truncated: false });
  }
  if (bytes > MAX_AGENT_PEEK_BYTES) {
    throw new Error("Agent conversation peek item cannot fit the snapshot budget");
  }
  return { item, truncated, bytes: jsonBytes(item) };
}

/**
 * Produces the bounded, user-visible tail exposed to peer Agents. It deliberately
 * omits thinking, tool/auth payloads, usage, and host-only reserved records.
 */
export function projectAgentConversationPeek(
  sessionManager: ReadonlySessionEntriesSource,
  requestedLimit = MAX_AGENT_PEEK_ITEMS,
): {
  items: AgentConversationPeekItem[];
  truncated: boolean;
} {
  const finiteLimit = Number.isFinite(requestedLimit)
    ? Math.floor(requestedLimit)
    : MAX_AGENT_PEEK_ITEMS;
  const limit = Math.max(
    0,
    Math.min(finiteLimit, MAX_AGENT_PEEK_ITEMS),
  );
  const projected = projectConversationItems(sessionManager)
    .map(compactConversationItem)
    .flatMap(({ item, truncated }) => {
      const visibleItem = agentPeekItem(item);
      if (visibleItem === undefined) return [];
      const fitted = fitAgentPeekItem(visibleItem);
      return [{
        ...fitted,
        truncated: truncated || fitted.truncated,
      }];
    });
  const candidates = limit === 0 ? [] : projected.slice(-limit);
  const reverseSelected: AgentConversationPeekItem[] = [];
  let selectedBytes = jsonBytes({ items: [], truncated: false });
  let compacted = false;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const separatorBytes = reverseSelected.length > 0 ? 1 : 0;
    if (selectedBytes + separatorBytes + candidate.bytes > MAX_AGENT_PEEK_BYTES) {
      compacted = true;
      break;
    }
    reverseSelected.push(candidate.item);
    selectedBytes += separatorBytes + candidate.bytes;
    compacted ||= candidate.truncated;
  }

  const selected = reverseSelected.reverse();
  const truncated = compacted || selected.length !== projected.length;
  return { items: selected, truncated };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function shortenPrefix(value: string): string {
  if (value.length <= 1) return "";
  return `${value.slice(0, Math.floor(value.length / 2))}…`;
}

function minimalConversationItem(
  item: ConversationHistoryItem,
): ConversationHistoryItem {
  if (item.kind === "message") {
    return {
      ...item,
      text: "",
      thinking: "",
      tools: [],
      parts: [],
    };
  }
  if (item.kind === "compaction") return { ...item };
  return {
    ...item,
    body: "",
    ...(item.result === undefined ? {} : { result: "" }),
  };
}

/**
 * The per-field limits are byte limits on the raw strings, while JSON can make
 * legal control characters six times larger. Make the final item itself fit
 * its page slot using the exact serialized representation.
 */
function fitConversationItem(
  source: ConversationHistoryItem,
  maxBytes: number,
): { item: ConversationHistoryItem; truncated: boolean } {
  const compacted = compactConversationItem(source);
  let item = compacted.item;
  if (jsonBytes(item) <= maxBytes) return compacted;

  let truncated = true;
  if (item.kind === "message") {
    item = {
      ...item,
      tools: item.tools.map((tool) => ({
        ...tool,
        ...(tool.args === undefined ? {} : { args: OMITTED_TOOL_VALUE }),
        ...(tool.result === undefined
          ? {}
          : { result: omittedToolResult(tool.result) }),
      })),
    };
  }

  while (jsonBytes(item) > maxBytes) {
    if (item.kind === "message") {
      const field = jsonBytes(item.text) >= jsonBytes(item.thinking)
        ? "text"
        : "thinking";
      const value = item[field];
      if (!value) break;
      const shortened = shortenPrefix(value);
      const text = field === "text" ? shortened : item.text;
      const thinking = field === "thinking" ? shortened : item.thinking;
      item = {
        ...item,
        [field]: shortened,
        parts: item.parts.flatMap((part): ConversationHistoryMessagePart[] => {
          if (part.kind === "tool") return [part];
          const aggregateLength = part.kind === "text"
            ? text.length
            : thinking.length;
          if (part.offset >= aggregateLength) return [];
          return [{
            kind: part.kind,
            offset: part.offset,
            length: Math.min(part.length, aggregateLength - part.offset),
          }];
        }),
      };
      continue;
    }
    if (item.kind === "session_message") {
      const field = jsonBytes(item.body) >= jsonBytes(item.result ?? "")
        ? "body"
        : "result";
      const value = field === "body" ? item.body : item.result ?? "";
      if (!value) break;
      item = field === "body"
        ? { ...item, body: shortenPrefix(value) }
        : { ...item, result: shortenPrefix(value) };
      continue;
    }
    break;
  }

  if (jsonBytes(item) <= maxBytes) return { item, truncated };
  const minimal = minimalConversationItem(item);
  if (jsonBytes(minimal) > maxBytes) {
    throw new Error("Conversation history item cannot fit the snapshot budget");
  }
  return { item: minimal, truncated: true };
}

function startsNewTurn(item: ConversationHistoryItem, hasTurns: boolean): boolean {
  return (
    !hasTurns
    || item.kind === "compaction"
    || (item.kind === "message" && item.role === "user")
  );
}

export function snapshotConversationItems(
  sourceItems: ConversationHistoryItem[],
): {
  items: ConversationHistoryItem[];
  window: ConversationWindowCoverage;
} {
  const projected = sourceItems.map((item, sourceIndex) => {
    const fitted = fitConversationItem(item, MAX_HISTORY_SNAPSHOT_BYTES - 2);
    return { ...fitted, sourceIndex, bytes: jsonBytes(fitted.item) };
  });
  const turns: Array<{ items: typeof projected; bytes: number }> = [];
  for (const item of projected) {
    if (startsNewTurn(item.item, turns.length > 0)) {
      turns.push({ items: [item], bytes: item.bytes });
    } else {
      const turn = turns.at(-1)!;
      turn.items.push(item);
      turn.bytes += item.bytes + 1;
    }
  }

  const selectedTurns: Array<typeof projected> = [];
  let selectedItemCount = 0;
  let selectedBytes = 2;
  let startsMidTurn = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const turnBytesWithSeparator = turn.bytes + (selectedItemCount > 0 ? 1 : 0);
    if (selectedBytes + turnBytesWithSeparator <= MAX_HISTORY_SNAPSHOT_BYTES) {
      selectedTurns.push(turn.items);
      selectedItemCount += turn.items.length;
      selectedBytes += turnBytesWithSeparator;
      continue;
    }
    if (selectedItemCount === 0) {
      // The newest turn cannot be kept whole. Retain its contiguous ordered
      // suffix; never skip a large item to include an older one.
      const reverseSuffix: typeof projected = [];
      for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const candidate = turn.items[itemIndex]!;
        const candidateBytes = candidate.bytes + (reverseSuffix.length > 0 ? 1 : 0);
        if (selectedBytes + candidateBytes > MAX_HISTORY_SNAPSHOT_BYTES) break;
        reverseSuffix.push(candidate);
        selectedBytes += candidateBytes;
      }
      startsMidTurn = reverseSuffix.length < turn.items.length;
      selectedTurns.push(reverseSuffix.reverse());
      selectedItemCount = reverseSuffix.length;
    }
    break;
  }

  const selected = selectedTurns.reverse().flat();
  const items = selected.map(({ item }) => item);
  const window: ConversationWindowCoverage = {
    omittedBefore: selected[0]?.sourceIndex !== undefined && selected[0].sourceIndex > 0,
    startsMidTurn,
    contentTruncated: selected.some((item) => item.truncated),
  };
  return { items, window };
}

/** Produces the bounded mixed-item browser snapshot. */
export function projectConversationItemsSnapshot(
  sessionManager: ReadonlySessionEntriesSource,
): {
  items: ConversationHistoryItem[];
  window: ConversationWindowCoverage;
} {
  return snapshotConversationItems(projectConversationItems(sessionManager));
}
