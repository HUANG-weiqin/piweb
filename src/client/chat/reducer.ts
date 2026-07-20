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
  usage?: TokenUsage;
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
  | ({ type: "hydrate"; items: ConversationHistoryItem[] } & ChatFocus)
  // Compatibility for the old App while focus-aware wiring lands.
  | { type: "hydrate"; messages: ConversationHistoryMessage[] }
  | ({ type: "conversation_item"; item: ConversationHistoryItem } & ChatFocus)
  | ({ type: "prompt_accepted"; runId: string; text: string } & OptionalFocus)
  | ({ type: "session"; runId: string; event: SessionEvent } & OptionalFocus)
  | ({ type: "error"; runId: string; message: string } & OptionalFocus)
  | { type: "reset" };

const id = () => crypto.randomUUID();

function isMessage(item: ChatItem): item is ChatMessageItem {
  return item.kind === "message";
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
): ChatMessageItem {
  return {
    kind: "message",
    id: message.id,
    runId: `history:${message.id}`,
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
  return items.reduce<ChatItem[]>(
    (current, item) => upsertItem(current, historyItemToChatItem(item)),
    [],
  );
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
      };
    }

    if (state.focus) return state;
    const items = action.messages.map(historyMessageToItem);
    return withItems(state, items, tokenTotal(items));
  }

  if (action.type === "conversation_item") {
    if (!matchesCurrentFocus(state, action)) return state;
    const items = upsertItem(itemsFrom(state), historyItemToChatItem(action.item));
    return withItems(state, items, tokenTotal(items));
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
    }]);
  }

  const event = action.event;
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
    }]);
  }
  if (event.type === "assistant_message_started") {
    const items = itemsFrom(state);
    if (items.some((item) => item.id === event.projectionId)) return state;
    const last = items.at(-1);
    if (
      last
      && isMessage(last)
      && last.role === "assistant"
      && last.runId === action.runId
      && !last.text
      && !last.thinking
      && last.tools.length === 0
    ) {
      return state;
    }
    return withItems(state, [...items, {
      kind: "message",
      id: event.projectionId,
      runId: action.runId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
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
        return { ...assistant, text: assistant.text + event.delta };
      }
      if (event.type === "text_replaced") {
        return { ...assistant, text: event.text };
      }
      return { ...assistant, thinking: assistant.thinking + event.delta };
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
