import type {
  ConversationHistoryMessage,
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

export interface ChatMessage {
  id: string;
  runId: string;
  role: "user" | "assistant" | "error";
  text: string;
  thinking: string;
  tools: ToolItem[];
  usage?: TokenUsage;
}

export interface ChatState {
  messages: ChatMessage[];
  sessionTokens: number;
}

export const initialChatState: ChatState = { messages: [], sessionTokens: 0 };

export type ChatAction =
  | { type: "prompt_accepted"; runId: string; text: string }
  | { type: "session"; runId: string; event: SessionEvent }
  | { type: "error"; runId: string; message: string }
  | { type: "hydrate"; messages: ConversationHistoryMessage[] }
  | { type: "reset" };

const id = () => crypto.randomUUID();

function ensureAssistant(
  messages: ChatMessage[],
  runId: string,
): { messages: ChatMessage[]; index: number } {
  const existingIndex = messages.findIndex((message) => (
    message.role === "assistant" && message.runId === runId
  ));
  if (existingIndex >= 0) return { messages, index: existingIndex };

  const assistant: ChatMessage = {
    id: id(),
    runId,
    role: "assistant",
    text: "",
    thinking: "",
    tools: [],
  };
  const userIndex = messages.findIndex((message) => (
    message.role === "user" && message.runId === runId
  ));
  const index = userIndex >= 0 ? userIndex + 1 : messages.length;
  return {
    messages: [...messages.slice(0, index), assistant, ...messages.slice(index)],
    index,
  };
}

function updateAssistant(
  messages: ChatMessage[],
  runId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const target = ensureAssistant(messages, runId);
  const assistant = update(target.messages[target.index]!);
  return [
    ...target.messages.slice(0, target.index),
    assistant,
    ...target.messages.slice(target.index + 1),
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
  if (action.type === "hydrate") {
    return {
      messages: action.messages.map((message) => ({
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
      })),
      sessionTokens: action.messages.reduce(
        (total, message) => total + (message.usage?.total ?? 0),
        0,
      ),
    };
  }
  if (action.type === "prompt_accepted") {
    if (state.messages.some((message) => (
      message.role === "user" && message.runId === action.runId
    ))) return state;
    return {
    messages: [...state.messages, {
      id: id(),
      runId: action.runId,
      role: "user",
      text: action.text,
      thinking: "",
      tools: [],
    }],
    sessionTokens: state.sessionTokens,
    };
  }
  if (action.type === "error") return {
    messages: [...state.messages, {
      id: id(),
      runId: action.runId,
      role: "error",
      text: action.message,
      thinking: "",
      tools: [],
    }],
    sessionTokens: state.sessionTokens,
  };

  const event = action.event;
  if (event.type === "run_started") {
    return { ...state, messages: ensureAssistant(state.messages, action.runId).messages };
  }
  if (event.type === "run_queued" || event.type === "run_finished") return state;

  if (event.type === "text_delta" || event.type === "text_replaced" || event.type === "thinking_delta") {
    return {
      ...state,
      messages: updateAssistant(state.messages, action.runId, (assistant) => {
        if (event.type === "text_delta") {
          return { ...assistant, text: assistant.text + event.delta };
        }
        if (event.type === "text_replaced") {
          return { ...assistant, text: event.text };
        }
        return { ...assistant, thinking: assistant.thinking + event.delta };
      }),
    };
  }

  if (event.type === "tool_started") {
    const tool: ToolItem = {
      id: String(event.toolCallId),
      name: String(event.toolName),
      args: event.args,
      // Pi emits tool_execution_start before host policy validation.
      status: "pending",
    };
    return {
      ...state,
      messages: updateAssistant(state.messages, action.runId, (assistant) => ({
        ...assistant,
        tools: [...assistant.tools, tool],
      })),
    };
  }

  if (event.type === "tool_prepared") {
    return {
      ...state,
      messages: updateAssistant(state.messages, action.runId, (assistant) => ({
        ...assistant,
        tools: assistant.tools.map((tool) => (
          tool.id === String(event.toolCallId)
            ? { ...tool, args: event.args, status: "pending" }
            : tool
        )),
      })),
    };
  }

  if (event.type === "tool_updated" || event.type === "tool_finished") {
    let status: ToolItem["status"] = "running";
    if (event.type === "tool_finished") status = event.isError ? "error" : "done";
    return {
      ...state,
      messages: updateAssistant(state.messages, action.runId, (assistant) => ({
        ...assistant,
        tools: assistant.tools.map((tool) => {
          if (tool.id !== String(event.toolCallId)) return tool;
          return { ...tool, result: event.result, status };
        }),
      })),
    };
  }

  if (event.type === "usage") {
    return {
      ...state,
      messages: updateAssistant(state.messages, action.runId, (assistant) => ({
        ...assistant,
        usage: addUsage(assistant.usage, event.usage),
      })),
      sessionTokens: state.sessionTokens + event.usage.total,
    };
  }

  return state;
}
