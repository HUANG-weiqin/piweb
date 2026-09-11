import {
  MAX_PROJECT_CONVERSATIONS,
  MAX_PROJECT_CONVERSATION_NAME_CHARACTERS,
  MAX_PROJECT_CONVERSATION_PREVIEW_CHARACTERS,
  type ConversationHistoryItem,
  type ConversationSummary,
  type PeerPresenceResolution,
  type SessionMessageEndpoint,
} from "../shared/protocol.js";


export function projectConversationPeers(
  items: readonly ConversationHistoryItem[],
  conversations: readonly ConversationSummary[],
  peerPresenceByConversationId?: ReadonlyMap<string, PeerPresenceResolution>,
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
      peerPresence: peerPresenceByConversationId?.get(peer.conversationId)
        ?? "unknown",
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
  const characters = [...value];
  if (characters.length <= maxLength) return { value, truncated: false };
  return {
    value: `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`,
    truncated: true,
  };
}

function compareConversationPriority(
  left: ConversationSummary,
  right: ConversationSummary,
  currentConversationId?: string,
): number {
  const currentDifference =
    Number(right.id === currentConversationId)
    - Number(left.id === currentConversationId);
  if (currentDifference !== 0) return currentDifference;
  const activeDifference =
    Number((right.activity?.kind ?? "idle") !== "idle")
    - Number((left.activity?.kind ?? "idle") !== "idle");
  if (activeDifference !== 0) return activeDifference;
  const compactingDifference =
    Number(right.compacting) - Number(left.compacting);
  if (compactingDifference !== 0) return compactingDifference;
  const attentionDifference =
    Number(right.attention === true)
    - Number(left.attention === true);
  if (attentionDifference !== 0) return attentionDifference;
  const unreadDifference =
    Number(right.unread === true)
    - Number(left.unread === true);
  if (unreadDifference !== 0) return unreadDifference;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

interface ConversationGroup {
  rootConversationId: string;
  conversations: ConversationSummary[];
  current: boolean;
  active: boolean;
  compacting: boolean;
  attention: boolean;
  unread: boolean;
  updatedAt: number;
}

function selectOversizedGroup(
  group: ConversationGroup,
  limit: number,
  currentConversationId?: string,
): ConversationSummary[] {
  const retainedIds = new Set<string>();
  const retain = (conversation: ConversationSummary | undefined) => {
    if (conversation !== undefined && retainedIds.size < limit) {
      retainedIds.add(conversation.id);
    }
  };
  retain(group.conversations.find(
    ({ id }) => id === group.rootConversationId,
  ));
  retain(group.conversations.find(
    ({ id }) => id === currentConversationId,
  ));
  for (const conversation of group.conversations) retain(conversation);
  return group.conversations.filter(({ id }) => retainedIds.has(id));
}

/**
 * Keeps the low-frequency project index comfortably below the wire frame
 * budget. The durable store remains complete; this is only a bounded browser
 * projection until pagination is added.
 */
export function projectConversationIndex(
  conversations: readonly ConversationSummary[],
  currentConversationId?: string,
): { conversations: ConversationSummary[]; truncated: boolean } {
  const groupsByRoot = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations) {
    const rootConversationId = conversation.rootConversationId
      ?? conversation.id;
    const group = groupsByRoot.get(rootConversationId);
    if (group === undefined) {
      groupsByRoot.set(rootConversationId, [conversation]);
    } else {
      group.push(conversation);
    }
  }

  const groups: ConversationGroup[] = [...groupsByRoot].map(
    ([rootConversationId, members]) => {
      const ordered = members.sort((left, right) =>
        compareConversationPriority(left, right, currentConversationId)
      );
      return {
        rootConversationId,
        conversations: ordered,
        current: ordered.some(({ id }) => id === currentConversationId),
        active: ordered.some(
          ({ activity }) => (activity?.kind ?? "idle") !== "idle",
        ),
        compacting: ordered.some(({ compacting }) => compacting),
        attention: ordered.some(({ attention }) => attention === true),
        unread: ordered.some(({ unread }) => unread === true),
        updatedAt: Math.max(...ordered.map(({ updatedAt }) =>
          Date.parse(updatedAt)
        )),
      };
    },
  ).sort((left, right) => {
    const currentDifference = Number(right.current) - Number(left.current);
    if (currentDifference !== 0) return currentDifference;
    const activeDifference = Number(right.active) - Number(left.active);
    if (activeDifference !== 0) return activeDifference;
    const compactingDifference =
      Number(right.compacting) - Number(left.compacting);
    if (compactingDifference !== 0) return compactingDifference;
    const attentionDifference =
      Number(right.attention) - Number(left.attention);
    if (attentionDifference !== 0) return attentionDifference;
    const unreadDifference = Number(right.unread) - Number(left.unread);
    if (unreadDifference !== 0) return unreadDifference;
    return right.updatedAt - left.updatedAt;
  });

  const selected: ConversationSummary[] = [];
  let truncated = false;
  for (const group of groups) {
    const remaining = MAX_PROJECT_CONVERSATIONS - selected.length;
    if (group.conversations.length <= remaining) {
      selected.push(...group.conversations);
      continue;
    }
    truncated = true;
    if (
      remaining > 0
      && group.conversations.length > MAX_PROJECT_CONVERSATIONS
    ) {
      selected.push(...selectOversizedGroup(
        group,
        remaining,
        currentConversationId,
      ));
    }
  }

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
