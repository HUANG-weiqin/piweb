import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ConversationHistoryItem,
  ConversationHistoryMessage,
  ConversationHistoryMessagePart,
  ConversationHistoryTool,
  ConversationMessageCard,
  TokenUsage,
} from "../shared/protocol.js";
import {
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMessageEntry,
} from "./conversation-meta.js";
import {
  parsePendingPromptBatchGuidance,
  pendingPromptBatchDisplayText,
} from "./pending-prompt-batch-guidance.js";
import { toWireValue } from "./session-events.js";

export const MAX_HISTORY_SNAPSHOT_BYTES = 750_000;
export const MAX_AGENT_PEEK_BYTES = 256 * 1024;
export const MAX_AGENT_PEEK_ITEMS = 20;
const MAX_HISTORY_TEXT_BYTES = 80_000;
const MAX_HISTORY_TOOL_VALUE_BYTES = 8_000;
const MAX_HISTORY_TOOLS_PER_MESSAGE = 20;
const MAX_HISTORY_PARTS_PER_MESSAGE = 200;
const MAX_HISTORY_ID_BYTES = 500;
const OMITTED_TOOL_VALUE = "[历史工具数据过大，已省略]";

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

function fallbackHistoryParts(
  text: string,
  thinking: string,
  tools: ConversationHistoryTool[],
): ConversationHistoryMessagePart[] {
  const parts: ConversationHistoryMessagePart[] = [];
  if (thinking) {
    parts.push({ kind: "thinking", offset: 0, length: thinking.length });
  }
  for (const tool of tools) {
    parts.push({ kind: "tool", toolCallId: tool.toolCallId });
  }
  if (text) parts.push({ kind: "text", offset: 0, length: text.length });
  return parts;
}

function compactHistoryMessage(
  message: ConversationHistoryMessage,
): { message: ConversationHistoryMessage; truncated: boolean } {
  const id = clipUtf8(message.id, MAX_HISTORY_ID_BYTES);
  const text = clipUtf8(message.text, MAX_HISTORY_TEXT_BYTES);
  const thinking = clipUtf8(message.thinking, MAX_HISTORY_TEXT_BYTES);
  const selectedTools = message.tools.slice(0, MAX_HISTORY_TOOLS_PER_MESSAGE);
  let truncated = id.truncated
    || text.truncated
    || thinking.truncated
    || selectedTools.length !== message.tools.length;
  const compactedToolIds = new Map<string, string>();
  const tools = selectedTools.map((tool) => {
    const toolCallId = clipUtf8(tool.toolCallId, MAX_HISTORY_ID_BYTES);
    const toolName = clipUtf8(tool.toolName, MAX_HISTORY_ID_BYTES);
    const args = compactToolValue(tool.args);
    const result = compactToolValue(tool.result);
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
  const selectedParts = message.parts?.slice(0, MAX_HISTORY_PARTS_PER_MESSAGE);
  let partsLostOrder = selectedParts !== undefined
    && selectedParts.length !== message.parts?.length;
  if (partsLostOrder) {
    truncated = true;
  }
  const compactedParts = selectedParts?.flatMap((part): ConversationHistoryMessagePart[] => {
    if (part.kind === "tool") {
      const toolCallId = compactedToolIds.get(part.toolCallId);
      if (toolCallId === undefined) {
        truncated = true;
        partsLostOrder = true;
        return [];
      }
      return [{ kind: "tool", toolCallId }];
    }
    const aggregateLength = part.kind === "text"
      ? text.value.length
      : thinking.value.length;
    if (part.offset >= aggregateLength) {
      truncated = true;
      partsLostOrder = true;
      return [];
    }
    const length = Math.min(part.length, aggregateLength - part.offset);
    if (length <= 0) {
      truncated = true;
      partsLostOrder = true;
      return [];
    }
    if (length !== part.length) {
      truncated = true;
      partsLostOrder = true;
    }
    return [{ kind: part.kind, offset: part.offset, length }];
  });
  let parts = compactedParts;
  if (message.parts === undefined) {
    parts = undefined;
  } else if (partsLostOrder) {
    parts = fallbackHistoryParts(text.value, thinking.value, tools);
  }
  return {
    message: {
      ...message,
      id: id.value,
      text: text.value,
      thinking: thinking.value,
      tools,
      ...(parts === undefined ? {} : { parts }),
      usage: message.usage ? { ...message.usage } : undefined,
    },
    truncated,
  };
}

interface ConversationHistoryMessageSlot {
  message: ConversationHistoryMessage;
  anchorEntryId: string;
  assistantEntryCount: number;
}

export interface ConversationHistoryItemSlot {
  item: ConversationHistoryItem;
  assistantEntryCount?: number;
}

function finalizeHistoryMessage(
  message: ConversationHistoryMessage,
): ConversationHistoryMessage {
  return {
    ...message,
    parts: message.parts?.length ? message.parts : undefined,
  };
}

/**
 * Projects the selected Pi session branch into replayable timeline segments.
 * Aggregate fields remain available for copy/token views, while `parts` records
 * the original assistant text/thinking/tool order without duplicating strings.
 */
function projectConversationHistorySlots(
  sessionManager: Pick<SessionManager, "getBranch">,
): ConversationHistoryMessageSlot[] {
  const branch = sessionManager.getBranch();
  const startedPendingPromptBatches = new Map<string, number>();
  const messages: ConversationHistoryMessageSlot[] = [];
  let assistant: ConversationHistoryMessageSlot | undefined;
  const seenCardIds = new Set<string>();

  const requireAssistant = (entryId: string): ConversationHistoryMessageSlot => {
    assistant ??= {
      anchorEntryId: entryId,
      assistantEntryCount: 0,
      message: {
        id: `assistant:${entryId}`,
        role: "assistant",
        text: "",
        thinking: "",
        tools: [],
        parts: [],
      },
    };
    if (!messages.includes(assistant)) messages.push(assistant);
    return assistant;
  };

  for (const entry of branch) {
    if (entry.type === "compaction") {
      assistant = undefined;
      continue;
    }
    const reserved = parseReservedConversationEntry(entry);
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
    if (reserved?.kind === "pending_prompt_batch") {
      const batch = reserved.entry.data;
      if (batch.state === "started") {
        startedPendingPromptBatches.set(batch.batchId, batch.items.length);
      } else if (batch.state !== "prepared") {
        startedPendingPromptBatches.delete(batch.batchId);
      }
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
      const rawText = contentText(message.content);
      const guidance = parsePendingPromptBatchGuidance(rawText);
      const expectedItemCount = guidance === undefined
        ? undefined
        : startedPendingPromptBatches.get(guidance.batchId);
      const text = guidance !== undefined
        && expectedItemCount === guidance.texts.length
        ? pendingPromptBatchDisplayText(guidance.texts)
        : rawText;
      if (guidance !== undefined && expectedItemCount === guidance.texts.length) {
        startedPendingPromptBatches.delete(guidance.batchId);
      }
      messages.push({
        anchorEntryId: entry.id,
        assistantEntryCount: 0,
        message: {
          id: entry.id,
          role: "user",
          text,
          thinking: "",
          tools: [],
        },
      });
      continue;
    }

    if (message.role === "assistant") {
      const targetSlot = requireAssistant(entry.id);
      targetSlot.assistantEntryCount += 1;
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
            target.parts?.push({
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
            target.parts?.push({
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
            target.parts?.push({ kind: "tool", toolCallId: block.id });
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
        target.parts?.push({
          kind: "text",
          offset,
          length: failureText.length,
        });
      } else if (message.stopReason === "aborted") {
        const offset = target.text ? target.text.length + 2 : 0;
        target.text = appendParagraph(target.text, "运行已中止。");
        target.parts?.push({ kind: "text", offset, length: 6 });
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
        target.parts?.push({
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
    message: finalizeHistoryMessage({
      ...slot.message,
      tools: slot.message.tools.map((tool): ConversationHistoryTool => ({ ...tool })),
      parts: slot.message.parts?.map((part) => ({ ...part })),
      usage: slot.message.usage ? { ...slot.message.usage } : undefined,
    }),
  }));
}

export function projectConversationHistory(
  sessionManager: Pick<SessionManager, "getBranch">,
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
  sessionManager: Pick<SessionManager, "getBranch" | "getEntries">,
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
        ...(message.role === "assistant"
          ? { assistantEntryCount: messageSlot.assistantEntryCount }
          : {}),
      },
      physicalIndex:
        physicalIndexById.get(messageSlot.anchorEntryId) ?? Number.MAX_SAFE_INTEGER,
    };
  });
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "compaction") continue;
    positionedItems.push({
      slot: {
        item: {
          kind: "compaction",
          id: entry.id,
          timestamp: entry.timestamp,
          tokensBefore: entry.tokensBefore,
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
      || reserved.kind === "pending_prompt_delivery"
      || reserved.kind === "pending_prompt_batch"
      || reserved.kind === "temporary_return_receipt"
      || reserved.kind === "meta_operation"
      || reserved.kind === "compaction_threshold"
      || reserved.kind === "compaction_resume"
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
  sessionManager: Pick<SessionManager, "getBranch" | "getEntries">,
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
    return { item: { ...item }, truncated: false };
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

function historyMessageFromItem(
  item: ConversationHistoryItem,
): ConversationHistoryMessage | undefined {
  if (item.kind !== "message") return;
  const { kind: _kind, ...message } = item;
  return message;
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

/**
 * Produces the bounded, user-visible tail exposed to peer Agents. It deliberately
 * omits thinking, tool/auth payloads, usage, and host-only reserved records.
 */
export function projectAgentConversationPeek(
  sessionManager: Pick<SessionManager, "getBranch" | "getEntries">,
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
      return visibleItem === undefined
        ? []
        : [{ item: visibleItem, truncated }];
    });
  const candidates = limit === 0 ? [] : projected.slice(-limit);
  const selected: AgentConversationPeekItem[] = [];
  let compacted = false;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    const nextItems = [candidate.item, ...selected];
    const nextSnapshot = {
      items: nextItems,
      // "false" is one serialized byte longer than "true", so it is the
      // conservative bound regardless of the final truncation state.
      truncated: false,
    };
    if (
      Buffer.byteLength(JSON.stringify(nextSnapshot), "utf8")
      > MAX_AGENT_PEEK_BYTES
    ) {
      compacted = true;
      break;
    }
    selected.unshift(candidate.item);
    compacted ||= candidate.truncated;
  }

  const truncated =
    compacted
    || selected.length !== projected.length;
  return { items: selected, truncated };
}

export function snapshotConversationItems(
  sourceItems: ConversationHistoryItem[],
): {
  messages: ConversationHistoryMessage[];
  items: ConversationHistoryItem[];
  truncated: boolean;
} {
  const projected = sourceItems.map(compactConversationItem);
  const turns: Array<typeof projected> = [];
  for (const item of projected) {
    if (
      (
        item.item.kind === "message"
        && item.item.role === "user"
      )
      || item.item.kind === "compaction"
      || turns.length === 0
    ) {
      turns.push([item]);
    } else {
      turns.at(-1)!.push(item);
    }
  }

  const selectedTurns: ConversationHistoryItem[][] = [];
  let bytes = 2;
  let truncated = projected.some((item) => item.truncated);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!.map(({ item }) => item);
    const turnBytes = turn.reduce(
      (total, item, itemIndex) => (
        total
        + Buffer.byteLength(JSON.stringify(item), "utf8")
        + (itemIndex > 0 ? 1 : 0)
      ),
      0,
    );
    const nextBytes =
      bytes + turnBytes + (selectedTurns.length > 0 ? 1 : 0);
    if (nextBytes > MAX_HISTORY_SNAPSHOT_BYTES) {
      truncated = true;
      break;
    }
    selectedTurns.push(turn);
    bytes = nextBytes;
  }

  const items = selectedTurns.reverse().flat();
  if (items.length !== projected.length) truncated = true;
  return {
    messages: items
      .map(historyMessageFromItem)
      .filter(
        (message): message is ConversationHistoryMessage =>
          message !== undefined,
      ),
    items,
    truncated,
  };
}

/**
 * Produces a bounded mixed-item snapshot while retaining the legacy messages
 * projection for callers that have not adopted cards yet.
 */
export function projectConversationItemsSnapshot(
  sessionManager: Pick<SessionManager, "getBranch" | "getEntries">,
): {
  messages: ConversationHistoryMessage[];
  items: ConversationHistoryItem[];
  truncated: boolean;
} {
  return snapshotConversationItems(projectConversationItems(sessionManager));
}

/**
 * Produces a bounded recent-history frame. Full history remains in the Pi JSONL
 * file; the browser projection is deliberately capped until pagination lands.
 */
export function projectConversationHistorySnapshot(
  sessionManager: Pick<SessionManager, "getBranch">,
): { messages: ConversationHistoryMessage[]; truncated: boolean } {
  const projected = projectConversationHistory(sessionManager)
    .map(compactHistoryMessage);
  const turns: Array<typeof projected> = [];
  for (const item of projected) {
    if (item.message.role === "user" || turns.length === 0) {
      turns.push([item]);
    } else {
      turns.at(-1)!.push(item);
    }
  }

  const selectedTurns: ConversationHistoryMessage[][] = [];
  let bytes = 2;
  let truncated = projected.some((item) => item.truncated);

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!.map(({ message }) => message);
    const turnBytes = turn.reduce(
      (total, message, messageIndex) => (
        total
        + Buffer.byteLength(JSON.stringify(message), "utf8")
        + (messageIndex > 0 ? 1 : 0)
      ),
      0,
    );
    const nextBytes = bytes + turnBytes + (selectedTurns.length > 0 ? 1 : 0);
    if (nextBytes > MAX_HISTORY_SNAPSHOT_BYTES) {
      truncated = true;
      break;
    }
    selectedTurns.push(turn);
    bytes = nextBytes;
  }
  const selected = selectedTurns.reverse().flat();
  if (selected.length !== projected.length) truncated = true;
  return { messages: selected, truncated };
}
