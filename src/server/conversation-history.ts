import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ConversationHistoryItem,
  ConversationHistoryMessage,
  ConversationHistoryTool,
  ConversationMessageCard,
  TokenUsage,
} from "../shared/protocol.js";
import {
  parseReservedConversationEntry,
  type ConversationCard,
  type ConversationMessageEntry,
} from "./conversation-meta.js";
import { toWireValue } from "./session-events.js";

export const MAX_HISTORY_SNAPSHOT_BYTES = 750_000;
export const MAX_AGENT_PEEK_BYTES = 256 * 1024;
export const MAX_AGENT_PEEK_ITEMS = 20;
const MAX_HISTORY_TEXT_BYTES = 80_000;
const MAX_HISTORY_TOOL_VALUE_BYTES = 8_000;
const MAX_HISTORY_TOOLS_PER_MESSAGE = 20;
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
    return {
      toolCallId: toolCallId.value,
      toolName: toolName.value,
      ...(tool.args === undefined ? {} : { args: args.value }),
      ...(tool.result === undefined ? {} : { result: result.value }),
      status: tool.status,
    };
  });
  return {
    message: {
      ...message,
      id: id.value,
      text: text.value,
      thinking: thinking.value,
      tools,
      usage: message.usage ? { ...message.usage } : undefined,
    },
    truncated,
  };
}

/**
 * Projects the selected Pi session branch into the same coarse bubbles used by
 * the live workbench: one user bubble followed by one aggregate assistant
 * bubble for all model/tool turns until the next user message.
 */
export function projectConversationHistory(
  sessionManager: Pick<SessionManager, "getBranch">,
): ConversationHistoryMessage[] {
  const messages: ConversationHistoryMessage[] = [];
  let assistant: ConversationHistoryMessage | undefined;

  const requireAssistant = (entryId: string): ConversationHistoryMessage => {
    assistant ??= {
      id: `assistant:${entryId}`,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
    };
    if (!messages.includes(assistant)) messages.push(assistant);
    return assistant;
  };

  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (!message) continue;

    if (message.role === "user") {
      assistant = undefined;
      messages.push({
        id: entry.id,
        role: "user",
        text: contentText(message.content),
        thinking: "",
        tools: [],
      });
      continue;
    }

    if (message.role === "assistant") {
      const target = requireAssistant(entry.id);
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          const block = record(item);
          if (block?.type === "text" && typeof block.text === "string") {
            target.text = appendParagraph(target.text, block.text);
          } else if (block?.type === "thinking" && typeof block.thinking === "string") {
            target.thinking = appendParagraph(target.thinking, block.thinking);
          } else if (
            block?.type === "toolCall"
            && typeof block.id === "string"
            && typeof block.name === "string"
          ) {
            target.tools.push({
              toolCallId: block.id,
              toolName: block.name,
              args: toWireValue(block.arguments),
              status: "error",
            });
          }
        }
      }
      target.usage = addUsage(target.usage, projectUsage(message.usage));
      if (
        message.stopReason === "error"
        && typeof message.errorMessage === "string"
      ) {
        target.text = appendParagraph(target.text, `运行失败：${message.errorMessage}`);
      } else if (message.stopReason === "aborted") {
        target.text = appendParagraph(target.text, "运行已中止。");
      }
      continue;
    }

    if (
      message.role === "toolResult"
      && typeof message.toolCallId === "string"
    ) {
      const target = requireAssistant(entry.id);
      let tool = target.tools.find((item) => item.toolCallId === message.toolCallId);
      if (!tool) {
        tool = {
          toolCallId: message.toolCallId,
          toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
          status: "error",
        };
        target.tools.push(tool);
      }
      tool.result = toWireValue({
        content: message.content,
        details: message.details,
      });
      tool.status = message.isError === true ? "error" : "done";
    }
  }

  return messages.map((message) => ({
    ...message,
    tools: message.tools.map((tool): ConversationHistoryTool => ({ ...tool })),
    usage: message.usage ? { ...message.usage } : undefined,
  }));
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
export function projectConversationItems(
  sessionManager: Pick<SessionManager, "getBranch" | "getEntries">,
): ConversationHistoryItem[] {
  const physicalEntries = sessionManager.getEntries();
  const physicalIndexById = new Map(
    physicalEntries.map((entry, index) => [entry.id, index]),
  );
  const positionedItems: Array<{
    item: ConversationHistoryItem;
    physicalIndex: number;
  }> = projectConversationHistory(sessionManager).map((message) => {
    const anchorId = message.role === "assistant"
      ? message.id.slice("assistant:".length)
      : message.id;
    return {
      item: {
        kind: "message",
        ...message,
      },
      physicalIndex:
        physicalIndexById.get(anchorId) ?? Number.MAX_SAFE_INTEGER,
    };
  });
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
      || reserved.kind === "run_settlement"
      || reserved.kind === "meta_operation"
      || reserved.kind === "compaction_threshold"
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
      positionedItems.push({ item, physicalIndex });
      continue;
    }

    const positioned = positionedItems[existing.positionedIndex]!;
    positioned.item = reserved.kind === "conversation_card"
      ? projectOutgoingCard(
          reserved.entry.data,
          (positioned.item as ConversationMessageCard).sentAt,
        )
      : projectIncomingCard(reserved.entry);
  }

  return positionedItems
    .sort((left, right) => left.physicalIndex - right.physicalIndex)
    .map(({ item }) => item);
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
): AgentConversationPeekItem {
  if (item.kind === "message") {
    return {
      kind: "message",
      role: item.role,
      text: item.text,
    };
  }
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
    .map(({ item, truncated }) => ({
      item: agentPeekItem(item),
      truncated,
    }));
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
  const projected = projectConversationItems(sessionManager)
    .map(compactConversationItem);
  const turns: Array<typeof projected> = [];
  for (const item of projected) {
    if (
      (
        item.item.kind === "message"
        && item.item.role === "user"
      )
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
