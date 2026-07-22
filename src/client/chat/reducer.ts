import type {
  ConversationCompactionMarker,
  ConversationHistoryItem,
  ConversationHistoryMessage,
  ConversationMessageCard,
  SessionEvent,
  TokenUsage,
} from "../../shared/protocol";

export interface ToolItem {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "pending" | "running" | "done" | "error";
}

export type ChatMessagePart =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool"; toolId: string };

/**
 * Compatibility shape consumed by the existing Message component.
 * New transcript code should use ChatItem and branch on `kind`.
 */
export interface ChatMessage {
  id: string;
  runId: string;
  role: "user" | "assistant" | "error";
  text: string;
  thinking: string;
  tools: ToolItem[];
  parts?: ChatMessagePart[];
  usage?: TokenUsage;
}

export function orderedMessageParts(message: ChatMessage): ChatMessagePart[] {
  if (message.parts !== undefined) return message.parts;
  // Compatibility only: snapshots written before ordered parts used this UI order.
  return [
    ...(message.thinking
      ? [{ kind: "thinking" as const, text: message.thinking }]
      : []),
    ...message.tools.map((tool) => ({
      kind: "tool" as const,
      toolId: tool.id,
    })),
    ...(message.text ? [{ kind: "text" as const, text: message.text }] : []),
  ];
}

export type ChatMessageItem = { kind: "message" } & ChatMessage;
export type ChatItem =
  | ChatMessageItem
  | ConversationCompactionMarker
  | ConversationMessageCard;

export interface ChatFocus {
  sessionId: string;
  conversationId: string;
  focusId: string;
}

export interface ChatState {
  /**
   * Last server-owned transcript projection sequence observed for this focus.
   * Undefined means no authoritative snapshot has hydrated the focus yet.
   */
  lastProjectionSeq?: number;
  projectionGap?: boolean;
  /**
   * The ordered transcript. Cards and ordinary messages share this one
   * projection so a card update cannot jump to the end of the conversation.
   *
   * Optional only until the existing Chat component finishes migrating from
   * its message-only test fixtures. Reducer-produced states always set it.
   */
  items?: ChatItem[];
  /**
   * Temporary compatibility projection for existing message-only consumers.
   * It is always derived from `items`.
   */
  messages: ChatMessage[];
  sessionTokens: number;
  focus?: ChatFocus;
}

export const initialChatState: ChatState = {
  items: [],
  messages: [],
  sessionTokens: 0,
};

type OptionalFocus = Partial<ChatFocus>;

export type ChatAction =
  | ({ type: "focus_changed" } & ChatFocus)
  | ({
      type: "hydrate";
      items: ConversationHistoryItem[];
      projectionSeq?: number;
    } & ChatFocus)
  // Compatibility for the old App while focus-aware wiring lands.
  | {
      type: "hydrate";
      messages: ConversationHistoryMessage[];
      projectionSeq?: number;
    }
  | ({
      type: "conversation_item";
      item: ConversationHistoryItem;
      projectionSeq?: number;
    } & ChatFocus)
  | ({ type: "prompt_accepted"; runId: string; text: string } & OptionalFocus)
  | ({
      type: "session";
      runId: string;
      event: SessionEvent;
      projectionSeq?: number;
    } & OptionalFocus)
  | ({ type: "error"; runId: string; message: string } & OptionalFocus)
  | { type: "reset" };

const id = () => crypto.randomUUID();

function isMessage(item: ChatItem): item is ChatMessageItem {
  return item.kind === "message";
}

function isEmptyAssistantPlaceholder(
  item: ChatItem,
  runId: string,
): item is ChatMessageItem {
  return isMessage(item)
    && item.role === "assistant"
    && item.runId === runId
    && !item.text
    && !item.thinking
    && item.tools.length === 0
    && (item.parts?.length ?? 0) === 0
    && item.usage === undefined;
}

function messagesFrom(items: ChatItem[]): ChatMessage[] {
  return items.filter(isMessage);
}

function itemsFrom(state: ChatState): ChatItem[] {
  if (state.items) return state.items;
  return state.messages.map((message) => ({ kind: "message", ...message }));
}

function withItems(
  state: ChatState,
  items: ChatItem[],
  sessionTokens = state.sessionTokens,
): ChatState {
  return {
    ...state,
    items,
    messages: messagesFrom(items),
    sessionTokens,
  };
}

function sameFocus(left: ChatFocus | undefined, right: ChatFocus): boolean {
  return left?.sessionId === right.sessionId
    && left.conversationId === right.conversationId
    && left.focusId === right.focusId;
}

function hasCompleteFocus(action: OptionalFocus): action is ChatFocus {
  return typeof action.sessionId === "string"
    && typeof action.conversationId === "string"
    && typeof action.focusId === "string";
}

/**
 * Legacy unscoped events are accepted only before a focus-aware App attaches.
 * Once a focus exists, every live mutation must carry the complete identity.
 */
function matchesCurrentFocus(state: ChatState, action: OptionalFocus): boolean {
  const hasAnyFocusPart = action.sessionId !== undefined
    || action.conversationId !== undefined
    || action.focusId !== undefined;
  if (!hasAnyFocusPart) return state.focus === undefined;
  return hasCompleteFocus(action) && sameFocus(state.focus, action);
}

function historyMessageToItem(
  message: ConversationHistoryMessage,
  runId = message.runId ?? `history:${message.id}`,
): ChatMessageItem {
  const parts = message.parts?.flatMap((part): ChatMessagePart[] => {
    if (part.kind === "tool") {
      return message.tools.some((tool) => tool.toolCallId === part.toolCallId)
        ? [{ kind: "tool", toolId: part.toolCallId }]
        : [];
    }
    const aggregate = part.kind === "text" ? message.text : message.thinking;
    const text = aggregate.slice(part.offset, part.offset + part.length);
    return text ? [{ kind: part.kind, text }] : [];
  });
  return {
    kind: "message",
    id: message.id,
    runId,
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    tools: message.tools.map((tool) => ({
      id: tool.toolCallId,
      name: tool.toolName,
      args: tool.args,
      result: tool.result,
      status: tool.status,
    })),
    ...(parts === undefined ? {} : { parts }),
    usage: message.usage,
  };
}

function historyItemToChatItem(item: ConversationHistoryItem): ChatItem {
  if (item.kind !== "message") return item;
  return historyMessageToItem(item);
}

function itemIdentity(item: ChatItem): string {
  if (item.kind === "session_message") return `card:${item.cardId}`;
  return `${item.kind}:${item.id}`;
}

function upsertItem(items: ChatItem[], next: ChatItem): ChatItem[] {
  const identity = itemIdentity(next);
  const existingIndex = items.findIndex((item) => itemIdentity(item) === identity);
  if (existingIndex < 0) return [...items, next];
  return [
    ...items.slice(0, existingIndex),
    next,
    ...items.slice(existingIndex + 1),
  ];
}

function normalizeHistory(items: ConversationHistoryItem[]): ChatItem[] {
  let normalized: ChatItem[] = [];
  let historyRunId: string | undefined;
  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      historyRunId = item.runId ?? `history:${item.id}`;
    }
    const next = item.kind === "message"
      ? historyMessageToItem(item, item.runId ?? historyRunId)
      : item;
    normalized = upsertItem(normalized, next);
  }
  return normalized;
}

function tokenTotal(items: ChatItem[]): number {
  return items.reduce(
    (total, item) => total + (isMessage(item) ? (item.usage?.total ?? 0) : 0),
    0,
  );
}

function ensureAssistant(
  items: ChatItem[],
  runId: string,
): { items: ChatItem[]; index: number } {
  let existingIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item
      && isMessage(item)
      && item.role === "assistant"
      && item.runId === runId
    ) {
      existingIndex = index;
      break;
    }
  }
  if (existingIndex >= 0) return { items, index: existingIndex };

  const assistant: ChatMessageItem = {
    kind: "message",
    id: id(),
    runId,
    role: "assistant",
    text: "",
    thinking: "",
    tools: [],
    parts: [],
  };
  const userIndex = items.findIndex((item) => (
    isMessage(item) && item.role === "user" && item.runId === runId
  ));
  const index = userIndex >= 0 ? userIndex + 1 : items.length;
  return {
    items: [...items.slice(0, index), assistant, ...items.slice(index)],
    index,
  };
}

function updateAssistant(
  items: ChatItem[],
  runId: string,
  update: (message: ChatMessageItem) => ChatMessageItem,
): ChatItem[] {
  const target = ensureAssistant(items, runId);
  const current = target.items[target.index];
  if (!current || !isMessage(current)) return target.items;
  const assistant = update(current);
  return [
    ...target.items.slice(0, target.index),
    assistant,
    ...target.items.slice(target.index + 1),
  ];
}

function addUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + next.cacheWrite,
    total: (current?.total ?? 0) + next.total,
  };
}

function appendPart(
  parts: ChatMessagePart[] | undefined,
  part: ChatMessagePart,
): ChatMessagePart[] {
  const current = parts ?? [];
  if (part.kind !== "tool" && !part.text) return current;
  const last = current[current.length - 1];
  if (
    part.kind !== "tool"
    && last?.kind === part.kind
  ) {
    return [
      ...current.slice(0, -1),
      { kind: part.kind, text: last.text + part.text },
    ];
  }
  return [...current, part];
}

function replaceTextParts(
  parts: ChatMessagePart[] | undefined,
  text: string,
): ChatMessagePart[] {
  const current = parts ?? [];
  const firstTextIndex = current.findIndex((part) => part.kind === "text");
  if (firstTextIndex < 0) {
    return text ? [...current, { kind: "text", text }] : current;
  }
  let replaced = false;
  return current.flatMap((part): ChatMessagePart[] => {
    if (part.kind !== "text") return [part];
    if (replaced) return [];
    replaced = true;
    return text ? [{ kind: "text", text }] : [];
  });
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return initialChatState;

  if (action.type === "focus_changed") {
    if (sameFocus(state.focus, action)) return state;
    return {
      ...state,
      focus: {
        sessionId: action.sessionId,
        conversationId: action.conversationId,
        focusId: action.focusId,
      },
      items: [],
      messages: [],
      sessionTokens: 0,
      lastProjectionSeq: undefined,
      projectionGap: false,
    };
  }

  if (action.type === "hydrate") {
    if ("items" in action) {
      if (state.focus && !sameFocus(state.focus, action)) return state;
      const items = normalizeHistory(action.items);
      return {
        ...withItems(state, items, tokenTotal(items)),
        focus: {
          sessionId: action.sessionId,
          conversationId: action.conversationId,
          focusId: action.focusId,
        },
        lastProjectionSeq: action.projectionSeq,
        projectionGap: false,
      };
    }

    if (state.focus) return state;
    const items = normalizeHistory(action.messages.map((message) => ({
      kind: "message",
      ...message,
    })));
    return {
      ...withItems(state, items, tokenTotal(items)),
      lastProjectionSeq: action.projectionSeq,
      projectionGap: false,
    };
  }

  if (action.type === "conversation_item") {
    if (!matchesCurrentFocus(state, action)) return state;
    if (state.projectionGap) return state;
    if (state.lastProjectionSeq !== undefined) {
      if (action.projectionSeq !== state.lastProjectionSeq) {
        return { ...state, projectionGap: true };
      }
    } else if (action.projectionSeq !== undefined) {
      return { ...state, projectionGap: true };
    }
    const items = upsertItem(itemsFrom(state), historyItemToChatItem(action.item));
    return {
      ...withItems(state, items, tokenTotal(items)),
      projectionGap: false,
    };
  }

  if (!matchesCurrentFocus(state, action)) return state;

  if (action.type === "prompt_accepted") {
    const items = itemsFrom(state);
    if (items.some((item) => (
      isMessage(item) && item.role === "user" && item.runId === action.runId
    ))) return state;
    return withItems(state, [...items, {
      kind: "message",
      id: id(),
      runId: action.runId,
      role: "user",
      text: action.text,
      thinking: "",
      tools: [],
      parts: [],
    }]);
  }

  if (action.type === "error") {
    return withItems(state, [...itemsFrom(state), {
      kind: "message",
      id: id(),
      runId: action.runId,
      role: "error",
      text: action.message,
      thinking: "",
      tools: [],
      parts: [],
    }]);
  }

  const event = action.event;
  if (state.projectionGap) return state;
  if (state.lastProjectionSeq !== undefined && action.projectionSeq === undefined) {
    return { ...state, projectionGap: true };
  }
  if (action.projectionSeq !== undefined) {
    if (
      state.lastProjectionSeq === undefined
      || action.projectionSeq !== state.lastProjectionSeq + 1
    ) {
      return { ...state, projectionGap: true };
    }
    state = {
      ...state,
      lastProjectionSeq: action.projectionSeq,
      projectionGap: false,
    };
  }
  if (event.type === "run_started") {
    return withItems(state, ensureAssistant(itemsFrom(state), action.runId).items);
  }
  if (event.type === "user_message") {
    const items = itemsFrom(state);
    if (items.some((item) => item.id === event.projectionId)) return state;
    return withItems(state, [...items, {
      kind: "message",
      id: event.projectionId,
      runId: action.runId,
      role: "user",
      text: event.text,
      thinking: "",
      tools: [],
      parts: [],
    }]);
  }
  if (event.type === "assistant_message_started") {
    const items = itemsFrom(state);
    if (items.some((item) => item.id === event.projectionId)) return state;
    const placeholderIndex = items.findIndex((item) => (
      isEmptyAssistantPlaceholder(item, action.runId)
    ));
    if (placeholderIndex === items.length - 1) return state;
    const currentItems = placeholderIndex < 0
      ? items
      : [
          ...items.slice(0, placeholderIndex),
          ...items.slice(placeholderIndex + 1),
        ];
    return withItems(state, [...currentItems, {
      kind: "message",
      id: event.projectionId,
      runId: action.runId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      parts: [],
    }]);
  }
  if (event.type === "run_queued" || event.type === "run_finished") return state;

  if (
    event.type === "text_delta"
    || event.type === "text_replaced"
    || event.type === "thinking_delta"
  ) {
    const items = updateAssistant(itemsFrom(state), action.runId, (assistant) => {
      if (event.type === "text_delta") {
        return {
          ...assistant,
          text: assistant.text + event.delta,
          parts: appendPart(assistant.parts, {
            kind: "text",
            text: event.delta,
          }),
        };
      }
      if (event.type === "text_replaced") {
        return {
          ...assistant,
          text: event.text,
          parts: replaceTextParts(assistant.parts, event.text),
        };
      }
      return {
        ...assistant,
        thinking: assistant.thinking + event.delta,
        parts: appendPart(assistant.parts, {
          kind: "thinking",
          text: event.delta,
        }),
      };
    });
    return withItems(state, items);
  }

  if (event.type === "tool_started") {
    const tool: ToolItem = {
      id: String(event.toolCallId),
      name: String(event.toolName),
      args: event.args,
      // Pi emits tool_execution_start before host policy validation.
      status: "pending",
    };
    return withItems(
      state,
      updateAssistant(itemsFrom(state), action.runId, (assistant) => ({
        ...assistant,
        tools: [...assistant.tools, tool],
        parts: appendPart(assistant.parts, {
          kind: "tool",
          toolId: tool.id,
        }),
      })),
    );
  }

  if (event.type === "tool_prepared") {
    return withItems(
      state,
      updateAssistant(itemsFrom(state), action.runId, (assistant) => ({
        ...assistant,
        tools: assistant.tools.map((tool) => (
          tool.id === String(event.toolCallId)
            ? { ...tool, args: event.args, status: "pending" }
            : tool
        )),
      })),
    );
  }

  if (event.type === "tool_updated" || event.type === "tool_finished") {
    let status: ToolItem["status"] = "running";
    if (event.type === "tool_finished") status = event.isError ? "error" : "done";
    return withItems(
      state,
      updateAssistant(itemsFrom(state), action.runId, (assistant) => ({
        ...assistant,
        tools: assistant.tools.map((tool) => {
          if (tool.id !== String(event.toolCallId)) return tool;
          return { ...tool, result: event.result, status };
        }),
      })),
    );
  }

  if (event.type === "usage") {
    const items = updateAssistant(itemsFrom(state), action.runId, (assistant) => ({
      ...assistant,
      usage: addUsage(assistant.usage, event.usage),
    }));
    return withItems(state, items, state.sessionTokens + event.usage.total);
  }

  return state;
}
