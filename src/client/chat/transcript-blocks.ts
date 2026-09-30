import type {
  ConversationBashTaskNotification,
  ConversationCompactionMarker,
  ConversationMessageCard,
  TokenUsage,
} from "../../shared/protocol";
import {
  orderedMessageParts,
  type ChatItem,
  type ChatMessage,
} from "./reducer";

export type TranscriptBlock =
  | {
      kind: "message";
      message: ChatMessage;
    }
  | ConversationCompactionMarker
  | ConversationMessageCard
  | ConversationBashTaskNotification;

function appendParagraph(current: string, next: string): string {
  if (!next) return current;
  return current ? `${current}\n\n${next}` : next;
}

function mergeUsage(
  left: TokenUsage | undefined,
  right: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  };
}

function mergeAssistantMessages(
  left: ChatMessage,
  right: ChatMessage,
): ChatMessage {
  return {
    ...left,
    runId: right.runId,
    text: appendParagraph(left.text, right.text),
    thinking: appendParagraph(left.thinking, right.thinking),
    tools: [...left.tools, ...right.tools],
    parts: [
      ...orderedMessageParts(left),
      ...orderedMessageParts(right),
    ],
    usage: mergeUsage(left.usage, right.usage),
  };
}

export function projectTranscriptBlocks(items: ChatItem[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    if (item.kind === "message") {
      const previous = blocks.at(-1);
      if (
        item.role === "assistant"
        && previous?.kind === "message"
        && previous.message.role === "assistant"
        && previous.message.runId === item.runId
      ) {
        previous.message = mergeAssistantMessages(previous.message, item);
        continue;
      }
      blocks.push({ kind: "message", message: item });
    } else {
      blocks.push(item);
    }
  }
  return blocks;
}
