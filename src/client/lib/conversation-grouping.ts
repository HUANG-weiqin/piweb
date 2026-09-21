import {
  type ConversationActivity,
  type ConversationSummary,
} from "../../shared/protocol";

export interface ConversationGroup {
  root: ConversationSummary;
  members: ConversationSummary[];
}

type GroupedConversationEntry =
  | { kind: "group"; group: ConversationGroup }
  | { kind: "conversation"; conversation: ConversationSummary };

interface ConversationGrouping {
  entries: GroupedConversationEntry[];
  rootByConversationId: Map<string, string>;
}

function activityRank(activity: ConversationActivity | undefined): number {
  switch (activity?.kind) {
    case "running": return 0;
    case "queued": return 1;
    case "cancelling": return 2;
    case "waiting": return 3;
    default: return 4;
  }
}

export function isConversationActive(
  conversation: ConversationSummary,
  busyConversationId?: string,
): boolean {
  return conversation.id === busyConversationId
    || activityRank(conversation.activity) < 4;
}

export function groupConversations(
  conversations: ConversationSummary[],
  busyConversationId?: string,
): ConversationGrouping {
  const summariesById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const descendantsByRoot = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations) {
    const rootConversationId = conversation.rootConversationId;
    if (
      rootConversationId === undefined
      || rootConversationId === conversation.id
      || !summariesById.has(rootConversationId)
    ) {
      continue;
    }
    const descendants = descendantsByRoot.get(rootConversationId);
    if (descendants === undefined) {
      descendantsByRoot.set(rootConversationId, [conversation]);
    } else {
      descendants.push(conversation);
    }
  }

  const rootByConversationId = new Map<string, string>();
  const groups: ConversationGroup[] = [];
  for (const [rootConversationId, descendants] of descendantsByRoot) {
    const root = summariesById.get(rootConversationId);
    if (root === undefined) continue;
    const members = descendants
      .map((conversation) => ({ conversation }))
      .sort((left, right) => {
        const attentionDifference =
          Number(Boolean(right.conversation.attention))
          - Number(Boolean(left.conversation.attention));
        if (attentionDifference !== 0) return attentionDifference;
        const activeDifference =
          Number(isConversationActive(right.conversation, busyConversationId))
          - Number(isConversationActive(left.conversation, busyConversationId));
        if (activeDifference !== 0) return activeDifference;
        const activityDifference =
          activityRank(left.conversation.activity)
          - activityRank(right.conversation.activity);
        if (activityDifference !== 0) return activityDifference;
        const unreadDifference =
          Number(Boolean(right.conversation.unread))
          - Number(Boolean(left.conversation.unread));
        if (unreadDifference !== 0) return unreadDifference;
        const updatedDifference =
          Date.parse(right.conversation.updatedAt)
          - Date.parse(left.conversation.updatedAt);
        return Number.isFinite(updatedDifference) && updatedDifference !== 0
          ? updatedDifference
          : left.conversation.id.localeCompare(right.conversation.id);
      })
      .map(({ conversation }) => conversation);
    rootByConversationId.set(root.id, root.id);
    for (const member of members) {
      rootByConversationId.set(member.id, root.id);
    }
    groups.push({ root, members });
  }

  const entries: GroupedConversationEntry[] = [
    ...groups.map((group) => ({ kind: "group" as const, group })),
    ...conversations
      .filter(({ id }) => !rootByConversationId.has(id))
      .map((conversation) => ({
        kind: "conversation" as const,
        conversation,
      })),
  ];
  entries.sort((left, right) => {
    const leftRoot = left.kind === "group" ? left.group.root : left.conversation;
    const rightRoot = right.kind === "group" ? right.group.root : right.conversation;
    const createdDifference = Date.parse(rightRoot.createdAt)
      - Date.parse(leftRoot.createdAt);
    if (createdDifference !== 0) return createdDifference;
    if (leftRoot.id === rightRoot.id) return 0;
    return leftRoot.id < rightRoot.id ? -1 : 1;
  });
  return { entries, rootByConversationId };
}

export function conversationDisplayOrdinal(
  conversations: ConversationSummary[],
  conversationId: string,
): number | undefined {
  const grouped = groupConversations(conversations);
  const rootConversationId = grouped.rootByConversationId.get(conversationId)
    ?? conversationId;
  const index = grouped.entries.findIndex((entry) => entry.kind === "group"
    ? entry.group.root.id === rootConversationId
    : entry.conversation.id === rootConversationId
  );
  return index < 0 ? undefined : index + 1;
}
