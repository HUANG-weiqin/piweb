import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ToolItem {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "running" | "done" | "error";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
  thinking: string;
  tools: ToolItem[];
}

export interface ChatState {
  messages: ChatMessage[];
  busy: boolean;
}

export const initialChatState: ChatState = { messages: [], busy: false };

export type ChatAction =
  | { type: "sent"; text: string }
  | { type: "pi"; event: AgentSessionEvent }
  | { type: "error"; message: string }
  | { type: "reset" };

const id = () => crypto.randomUUID();

function lastMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1];
}

function ensureAssistant(messages: ChatMessage[]): ChatMessage[] {
  if (lastMessage(messages)?.role === "assistant") return messages;
  return [...messages, { id: id(), role: "assistant", text: "", thinking: "", tools: [] }];
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return initialChatState;
  if (action.type === "sent") return {
    busy: true,
    messages: [...state.messages, { id: id(), role: "user", text: action.text, thinking: "", tools: [] }],
  };
  if (action.type === "error") return {
    busy: false,
    messages: [...state.messages, { id: id(), role: "error", text: action.message, thinking: "", tools: [] }],
  };

  const event = action.event;
  if (event.type === "agent_start") return { ...state, busy: true, messages: ensureAssistant(state.messages) };
  if (event.type === "agent_settled") return { ...state, busy: false };

  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent;
    if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta") return state;
    const messages = ensureAssistant(state.messages);
    const last = lastMessage(messages)!;
    const updated = delta.type === "text_delta"
      ? { ...last, text: last.text + String(delta.delta ?? "") }
      : { ...last, thinking: last.thinking + String(delta.delta ?? "") };
    return { ...state, messages: [...messages.slice(0, -1), updated] };
  }

  if (event.type === "tool_execution_start") {
    const messages = ensureAssistant(state.messages);
    const last = lastMessage(messages)!;
    const tool: ToolItem = { id: String(event.toolCallId), name: String(event.toolName), args: event.args, status: "running" };
    return { ...state, messages: [...messages.slice(0, -1), { ...last, tools: [...last.tools, tool] }] };
  }

  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const messages = ensureAssistant(state.messages);
    const last = lastMessage(messages)!;
    let status: ToolItem["status"] = "running";
    if (event.type === "tool_execution_end") status = event.isError ? "error" : "done";
    const tools = last.tools.map((tool) => {
      if (tool.id !== String(event.toolCallId)) return tool;
      const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
      return { ...tool, result, status };
    });
    return { ...state, messages: [...messages.slice(0, -1), { ...last, tools }] };
  }

  return state;
}
