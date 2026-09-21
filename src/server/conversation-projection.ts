import type {
  ConversationHistoryItem,
  ConversationHistoryMessage,
  ConversationHistoryMessagePart,
  ConversationHistoryTool,
  ConversationWindowCoverage,
  SessionEvent,
  TokenUsage,
} from "../shared/protocol.js";
import {
  projectConversationItemSlots,
  snapshotConversationItems,
  type ReadonlySessionEntriesSource,
} from "./conversation-history.js";

interface LiveConversationProjection {
  runId: string;
  currentAssistantId?: string;
  initialUserItemId?: string;
  /** Raw SDK message identity, never text/role-derived matching. */
  rawMessagesByItemId: Map<string, unknown>;
  items: ConversationHistoryItem[];
}

function runMessageId(runId: string, role: "user" | "assistant"): string {
  return role === "user" ? `run-${runId}-user` : `assistant:run-${runId}-assistant`;
}

function appendHistoryPart(
  parts: ConversationHistoryMessagePart[],
  part: ConversationHistoryMessagePart,
): ConversationHistoryMessagePart[] {
  if (part.kind !== "tool" && part.length <= 0) return parts;
  const current = parts;
  const last = current[current.length - 1];
  if (
    part.kind !== "tool"
    && last?.kind === part.kind
    && last.offset + last.length === part.offset
  ) {
    return [
      ...current.slice(0, -1),
      { kind: part.kind, offset: last.offset, length: last.length + part.length },
    ];
  }
  return [...current, part];
}

function addUsage(
  current: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheWrite: (current?.cacheWrite ?? 0) + next.cacheWrite,
    total: (current?.total ?? 0) + next.total,
  };
}

/**
 * Projects durable SessionManager history and the actor's open run suffix.
 * The actor owns SDK subscription, run lifecycle, and wire emission.
 */
export class ConversationProjection {
  private projectionSeq = 0;
  private liveProjection?: LiveConversationProjection;

  projectConversationItems(
    sessionManager: ReadonlySessionEntriesSource,
    hasActiveRun: boolean,
    enrich?: (items: ConversationHistoryItem[]) => ConversationHistoryItem[],
  ): {
    items: ConversationHistoryItem[];
    projectionSeq: number;
    window: ConversationWindowCoverage;
  } {
    const slots = projectConversationItemSlots(sessionManager);
    const durableItems = slots.map(({ item }) => structuredClone(item));
    const durableIndexByRawMessage = new Map<unknown, number>();
    for (const [index, slot] of slots.entries()) {
      for (const source of slot.sourceMessages ?? []) {
        durableIndexByRawMessage.set(source.message, index);
      }
    }

    const live = hasActiveRun ? this.liveProjection : undefined;
    if (live) {
      let sawUnmatchedLiveItem = false;
      for (const liveItem of live.items) {
        if (liveItem.kind !== "message") continue;
        const rawMessage = live.rawMessagesByItemId.get(liveItem.id);
        const durableIndex = rawMessage === undefined
          ? undefined
          : durableIndexByRawMessage.get(rawMessage);
        if (durableIndex === undefined) {
          sawUnmatchedLiveItem = true;
          durableItems.push(structuredClone(liveItem));
          continue;
        }
        if (sawUnmatchedLiveItem) {
          throw new Error("A durable live message appeared after the live suffix");
        }
        const durableItem = durableItems[durableIndex];
        if (durableItem?.kind !== "message") continue;
        const ownedDurable = { ...durableItem, runId: live.runId };
        if (ownedDurable.role !== "assistant" || liveItem.role !== "assistant") {
          durableItems[durableIndex] = ownedDurable;
          continue;
        }
        const liveTools = new Map(
          liveItem.tools.map((tool) => [tool.toolCallId, tool]),
        );
        durableItems[durableIndex] = {
          ...ownedDurable,
          tools: ownedDurable.tools.map((tool) => {
            const patch = liveTools.get(tool.toolCallId);
            if (patch === undefined || tool.status !== "pending") return tool;
            return {
              ...tool,
              status: patch.status,
              ...(patch.result === undefined ? {} : { result: patch.result }),
            };
          }),
        };
      }
    }

    const snapshot = snapshotConversationItems(
      enrich ? enrich(durableItems) : durableItems,
    );
    return {
      items: snapshot.items,
      projectionSeq: this.projectionSeq,
      window: snapshot.window,
    };
  }

  begin(runId: string, promptText: string | undefined): void {
    const live = this.resetLiveProjection(runId);
    const items = live.items;
    if (promptText !== undefined) {
      const id = runMessageId(runId, "user");
      live.initialUserItemId = id;
      items.push({
        kind: "message",
        id,
        runId,
        role: "user",
        text: promptText,
        thinking: "",
        tools: [],
        parts: promptText
          ? [{ kind: "text", offset: 0, length: promptText.length }]
          : [],
      });
    }
  }

  clear(runId: string): void {
    if (this.liveProjection?.runId === runId) this.liveProjection = undefined;
  }

  rebindFinalAssistant(runId: string, rawMessage: unknown): void {
    if (this.liveProjection?.runId !== runId) return;
    const assistant = this.ensureLiveAssistant(runId);
    this.liveProjection.rawMessagesByItemId.set(assistant.id, rawMessage);
  }

  rebindInitialUser(runId: string, rawMessage: unknown): void {
    const live = this.liveProjection;
    if (live?.runId !== runId || live.initialUserItemId === undefined) return;
    live.rawMessagesByItemId.set(live.initialUserItemId, rawMessage);
  }

  applySessionEvent(
    runId: string,
    event: SessionEvent,
    rawMessage?: unknown,
  ): number {
    this.applyLiveSessionEvent(runId, event, rawMessage);
    return ++this.projectionSeq;
  }

  private resetLiveProjection(runId: string): LiveConversationProjection {
    const live: LiveConversationProjection = {
      runId,
      rawMessagesByItemId: new Map(),
      items: [],
    };
    this.liveProjection = live;
    return live;
  }

  private requireLiveProjection(runId: string): LiveConversationProjection {
    if (!this.liveProjection || this.liveProjection.runId !== runId) {
      return this.resetLiveProjection(runId);
    }
    return this.liveProjection;
  }

  private ensureLiveAssistant(runId: string): ConversationHistoryMessage {
    const live = this.requireLiveProjection(runId);
    const current = live.currentAssistantId === undefined
      ? undefined
      : live.items.find((item) => (
        item.kind === "message" && item.id === live.currentAssistantId
      ));
    if (current?.kind === "message") return current;

    const assistant: ConversationHistoryMessage & { kind: "message" } = {
      kind: "message",
      id: runMessageId(runId, "assistant"),
      runId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      parts: [],
    };
    live.currentAssistantId = assistant.id;
    live.items.push(assistant);
    return assistant;
  }

  private appendLiveUser(
    runId: string,
    projectionId: string,
    text: string,
    rawMessage?: unknown,
  ): void {
    const live = this.requireLiveProjection(runId);
    if (live.items.some((item) => item.kind === "message" && item.id === projectionId)) {
      if (rawMessage !== undefined) live.rawMessagesByItemId.set(projectionId, rawMessage);
      return;
    }
    live.items.push({
      kind: "message",
      id: projectionId,
      runId,
      role: "user",
      text,
      thinking: "",
      tools: [],
      parts: text ? [{ kind: "text", offset: 0, length: text.length }] : [],
    });
    if (rawMessage !== undefined) live.rawMessagesByItemId.set(projectionId, rawMessage);
  }

  private applyLiveSessionEvent(
    runId: string,
    event: SessionEvent,
    rawMessage?: unknown,
  ): void {
    if (event.type === "user_message") {
      this.appendLiveUser(runId, event.projectionId, event.text, rawMessage);
      return;
    }
    if (event.type === "assistant_message_started") {
      const live = this.requireLiveProjection(runId);
      const existingIndex = live.items.findIndex((item) => (
        item.kind === "message" && item.id === event.projectionId
      ));
      if (existingIndex >= 0) {
        live.currentAssistantId = event.projectionId;
        if (rawMessage !== undefined) {
          live.rawMessagesByItemId.set(event.projectionId, rawMessage);
        }
        return;
      }
      const emptyAssistantIndex = live.items.findIndex((item) => (
        item.kind === "message"
        && item.role === "assistant"
        && item.runId === runId
        && !item.text
        && !item.thinking
        && item.tools.length === 0
      ));
      if (emptyAssistantIndex >= 0) {
        const [removed] = live.items.splice(emptyAssistantIndex, 1);
        if (removed?.kind === "message") {
          live.rawMessagesByItemId.delete(removed.id);
        }
      }
      live.currentAssistantId = event.projectionId;
      live.items.push({
        kind: "message",
        id: event.projectionId,
        runId,
        role: "assistant",
        text: "",
        thinking: "",
        tools: [],
        parts: [],
      });
      if (rawMessage !== undefined) {
        live.rawMessagesByItemId.set(event.projectionId, rawMessage);
      }
      return;
    }
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      if (!event.delta) return;
      const assistant = this.ensureLiveAssistant(runId);
      if (event.type === "text_delta") {
        const offset = assistant.text.length;
        assistant.text += event.delta;
        assistant.parts = appendHistoryPart(assistant.parts, {
          kind: "text",
          offset,
          length: event.delta.length,
        });
      } else {
        const offset = assistant.thinking.length;
        assistant.thinking += event.delta;
        assistant.parts = appendHistoryPart(assistant.parts, {
          kind: "thinking",
          offset,
          length: event.delta.length,
        });
      }
      return;
    }
    if (event.type === "text_replaced") {
      const assistant = this.ensureLiveAssistant(runId);
      assistant.text = event.text;
      assistant.parts = [
        ...assistant.parts.filter((part) => part.kind !== "text"),
        ...(event.text ? [{ kind: "text" as const, offset: 0, length: event.text.length }] : []),
      ];
      return;
    }
    if (event.type === "tool_started") {
      const assistant = this.ensureLiveAssistant(runId);
      const tool: ConversationHistoryTool = {
        toolCallId: String(event.toolCallId),
        toolName: String(event.toolName),
        args: event.args,
        status: "pending",
      };
      assistant.tools = [...assistant.tools, tool];
      assistant.parts = appendHistoryPart(assistant.parts, {
        kind: "tool",
        toolCallId: tool.toolCallId,
      });
      return;
    }
    if (event.type === "tool_prepared") {
      const assistant = this.ensureLiveAssistant(runId);
      assistant.tools = assistant.tools.map((tool) => (
        tool.toolCallId === String(event.toolCallId)
          ? { ...tool, args: event.args, status: "pending" }
          : tool
      ));
      return;
    }
    if (event.type === "tool_updated" || event.type === "tool_finished") {
      const assistant = this.ensureLiveAssistant(runId);
      const status = event.type === "tool_finished"
        ? (event.isError ? "error" : "done")
        : "running";
      assistant.tools = assistant.tools.map((tool) => (
        tool.toolCallId === String(event.toolCallId)
          ? { ...tool, result: event.result, status }
          : tool
      ));
      return;
    }
    if (event.type === "usage") {
      const assistant = this.ensureLiveAssistant(runId);
      assistant.usage = addUsage(assistant.usage, event.usage);
    }
  }
}
