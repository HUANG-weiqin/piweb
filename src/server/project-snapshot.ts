import type { ConversationSummary } from "../shared/protocol.js";

export const MAX_PROJECT_CONVERSATIONS = 200;
const MAX_CONVERSATION_NAME_CHARS = 120;
const MAX_CONVERSATION_PREVIEW_CHARS = 500;

function clip(value: string, maxLength: number): { value: string; truncated: boolean } {
  if (value.length <= maxLength) return { value, truncated: false };
  return {
    value: `${value.slice(0, Math.max(0, maxLength - 1))}…`,
    truncated: true,
  };
}

/**
 * Keeps the low-frequency project index comfortably below the wire frame
 * budget. The durable store remains complete; this is only a bounded browser
 * projection until pagination is added.
 */
export function projectConversationIndex(
  conversations: readonly ConversationSummary[],
  activeConversationId?: string,
): { conversations: ConversationSummary[]; truncated: boolean } {
  let truncated = conversations.length > MAX_PROJECT_CONVERSATIONS;
  const selected = conversations.slice(0, MAX_PROJECT_CONVERSATIONS);
  if (
    activeConversationId !== undefined
    && !selected.some(({ id }) => id === activeConversationId)
  ) {
    const active = conversations.find(({ id }) => id === activeConversationId);
    if (active !== undefined) {
      selected[selected.length - 1] = active;
      truncated = true;
    }
  }

  const projected: ConversationSummary[] = [];
  for (const conversation of selected) {
    const preview = clip(conversation.preview, MAX_CONVERSATION_PREVIEW_CHARS);
    const name = conversation.name === undefined
      ? undefined
      : clip(conversation.name, MAX_CONVERSATION_NAME_CHARS);
    if (preview.truncated || name?.truncated === true) truncated = true;
    projected.push({
      ...conversation,
      ...(name === undefined ? {} : { name: name.value }),
      preview: preview.value,
    });
  }
  return { conversations: projected, truncated };
}
