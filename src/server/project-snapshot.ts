import {
  MAX_PROJECT_CONVERSATIONS,
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS,
  type ConversationHistoryItem,
  type ConversationSummary,
  type SessionMessageEndpoint,
} from "../shared/protocol.js";

export { MAX_PROJECT_CONVERSATIONS };

export function projectConversationPeers(
  items: readonly ConversationHistoryItem[],
  conversations: readonly ConversationSummary[],
): ConversationHistoryItem[] {
  const summaries = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const enrichTitle = (
    endpoint: SessionMessageEndpoint,
  ): SessionMessageEndpoint => {
    const explicitTitle = endpoint.title === undefined
      ? undefined
      : conversationDisplayTitle({ name: endpoint.title, preview: "" });
    if (explicitTitle !== undefined) {
      return explicitTitle === endpoint.title
        ? endpoint
        : { ...endpoint, title: explicitTitle };
    }
    const summary = summaries.get(endpoint.conversationId);
    if (!summary) return endpoint;
    const title = conversationDisplayTitle(summary);
    return title === undefined ? endpoint : { ...endpoint, title };
  };
  return items.map((item) => {
    if (item.kind !== "session_message") return item;
    const from = enrichTitle(item.from);
    const to = enrichTitle(item.to);
    const peer = item.direction === "incoming" ? from : to;
    return {
      ...item,
      from,
      to,
      peerExists: summaries.has(peer.conversationId),
    };
  });
}

export function conversationDisplayTitle(
  conversation: Pick<ConversationSummary, "name" | "preview">,
): string | undefined {
  const title = conversation.name?.trim() || conversation.preview.trim();
  if (!title) return undefined;
  const characters = [...title];
  if (characters.length <= MAX_PROJECT_CONVERSATION_NAME_CHARACTERS) {
    return title;
  }
  return `${characters
    .slice(0, MAX_PROJECT_CONVERSATION_NAME_CHARACTERS - 1)
    .join("")}…`;
}

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
  const selected = [...conversations]
    .sort((left, right) => {
      const currentDifference =
        Number(right.id === activeConversationId)
        - Number(left.id === activeConversationId);
      if (currentDifference !== 0) return currentDifference;
      const activeDifference =
        Number((right.activity?.kind ?? "idle") !== "idle")
        - Number((left.activity?.kind ?? "idle") !== "idle");
      if (activeDifference !== 0) return activeDifference;
      const attentionDifference =
        Number(right.attention === true)
        - Number(left.attention === true);
      if (attentionDifference !== 0) return attentionDifference;
      const unreadDifference =
        Number(right.unread === true)
        - Number(left.unread === true);
      if (unreadDifference !== 0) return unreadDifference;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    })
    .slice(0, MAX_PROJECT_CONVERSATIONS);

  const projected: ConversationSummary[] = [];
  for (const conversation of selected) {
    const preview = clip(
      conversation.preview,
      MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS,
    );
    const name = conversation.name === undefined
      ? undefined
      : clip(
          conversation.name,
          MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
        );
    if (preview.truncated || name?.truncated === true) truncated = true;
    projected.push({
      ...conversation,
      ...(name === undefined ? {} : { name: name.value }),
      preview: preview.value,
    });
  }
  return { conversations: projected, truncated };
}
